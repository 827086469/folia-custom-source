// src/extensions/customSource/lx/crypto.ts
//
// `lx.utils.crypto` and `lx.utils.zlib` for the WebView host. Same signatures as the desktop host in
// `custom-source/lxHost.cjs`, which delegates to node:crypto and node:zlib. Here the same work is
// done by crypto-js for the hashes and AES (both must stay synchronous: a script like
// `const sign = lx.utils.crypto.md5(data)` expects a value, not a promise) and by fflate for zlib,
// which Folia already bundles.
//
// RSA is the one primitive with no suitable browser library in this project. What scripts use it for
// is NetEase's weapi: raw RSA over a zero-padded 128 byte block, which is one modular exponentiation
// and no padding scheme at all. That is small enough to do directly with BigInt, so it is.

import CryptoJS from 'crypto-js';
import { unzlibSync, zlibSync } from 'fflate';

const toWordArray = (bytes: Uint8Array) => CryptoJS.lib.WordArray.create(bytes);

const fromWordArray = (wordArray: { sigBytes: number; words: number[] }): Uint8Array => {
    const out = new Uint8Array(wordArray.sigBytes);
    for (let index = 0; index < wordArray.sigBytes; index += 1) {
        out[index] = (wordArray.words[index >>> 2] >>> (24 - (index % 4) * 8)) & 0xff;
    }
    return out;
};

const hex = (wordArray: { toString(encoder?: unknown): string }) => wordArray.toString(CryptoJS.enc.Hex);

export const md5 = (value: unknown): string => hex(CryptoJS.MD5(value));
export const sha1 = (value: unknown): string => hex(CryptoJS.SHA1(value));
export const sha256 = (value: unknown): string => hex(CryptoJS.SHA256(value));

export const randomBytes = (size: number): Uint8Array => {
    const out = new Uint8Array(Math.max(0, Math.trunc(size) || 0));
    if (out.length && typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(out);
        return out;
    }
    for (let index = 0; index < out.length; index += 1) out[index] = Math.floor(Math.random() * 256);
    return out;
};

const ZERO_IV = new Uint8Array(16);

/**
 * AES with PKCS#7 padding, which is what `createCipheriv('aes-128-cbc', ...)` does by default and
 * what every weapi implementation assumes. `mode` is a node style string ('aes-128-cbc',
 * 'aes-128-ecb'); the key length decides the variant, so the number in the name is not read.
 */
export const aesEncrypt = (
    buffer: Uint8Array,
    mode: string,
    key: Uint8Array,
    iv?: Uint8Array,
): Uint8Array => {
    const isEcb = /ecb/i.test(String(mode));
    const encrypted = CryptoJS.AES.encrypt(toWordArray(buffer), toWordArray(key), {
        mode: isEcb ? CryptoJS.mode.ECB : CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
        ...(isEcb ? {} : { iv: toWordArray(iv && iv.length === 16 ? iv : ZERO_IV) }),
    });
    return fromWordArray(encrypted.ciphertext);
};

// --- RSA_NO_PADDING ---------------------------------------------------------
//
// Just enough DER to reach the two integers of a public key.

interface DerNode {
    tag: number;
    valueStart: number;
    valueEnd: number;
    next: number;
}

const readDer = (bytes: Uint8Array, offset: number): DerNode => {
    const tag = bytes[offset];
    let cursor = offset + 1;
    let length = bytes[cursor];
    cursor += 1;
    if (length & 0x80) {
        const count = length & 0x7f;
        length = 0;
        for (let index = 0; index < count; index += 1) length = (length << 8) | bytes[cursor + index];
        cursor += count;
    }
    return { tag, valueStart: cursor, valueEnd: cursor + length, next: cursor + length };
};

const derChildren = (bytes: Uint8Array, node: DerNode): DerNode[] => {
    const children: DerNode[] = [];
    let cursor = node.valueStart;
    while (cursor < node.valueEnd) {
        const child = readDer(bytes, cursor);
        if (child.next <= cursor) break;
        children.push(child);
        cursor = child.next;
    }
    return children;
};

const toBigInt = (bytes: Uint8Array, start: number, end: number): bigint => {
    let value = 0n;
    for (let index = start; index < end; index += 1) value = (value << 8n) | BigInt(bytes[index]);
    return value;
};

const fromPem = (key: string): { modulus: bigint; exponent: bigint; size: number } => {
    const body = String(key)
        .replace(/-----(BEGIN|END)[^-]+-----/g, '')
        .replace(/\s+/g, '');
    const binary = atob(body);
    const der = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) der[index] = binary.charCodeAt(index);

    const top = readDer(der, 0);
    let children = derChildren(der, top);
    // SubjectPublicKeyInfo wraps the key in a SEQUENCE inside a BIT STRING, with the algorithm beside
    // it; a bare `BEGIN RSA PUBLIC KEY` is the inner SEQUENCE on its own.
    if (children[0]?.tag === 0x30) {
        const bitString = children.find(child => child.tag === 0x03);
        if (!bitString) throw new Error('RSA 公钥里没有 BIT STRING');
        // The first byte of a BIT STRING counts unused trailing bits; the key starts after it.
        const inner = readDer(der, bitString.valueStart + 1);
        children = derChildren(der, inner);
    }
    const modulusNode = children.find(child => child.tag === 0x02);
    const exponentNode = children.filter(child => child.tag === 0x02)[1];
    if (!modulusNode || !exponentNode) throw new Error('RSA 公钥解析失败');

    const modulus = toBigInt(der, modulusNode.valueStart, modulusNode.valueEnd);
    const exponent = toBigInt(der, exponentNode.valueStart, exponentNode.valueEnd);
    return { modulus, exponent, size: modulusNode.valueEnd - modulusNode.valueStart
        - (der[modulusNode.valueStart] === 0 ? 1 : 0) };
};

const modPow = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
    let result = 1n;
    let factor = base % modulus;
    let power = exponent;
    while (power > 0n) {
        if (power & 1n) result = (result * factor) % modulus;
        factor = (factor * factor) % modulus;
        power >>= 1n;
    }
    return result;
};

/** c = m^e mod n over a zero-padded modulus-sized block, exactly like node's RSA_NO_PADDING. */
export const rsaEncrypt = (buffer: Uint8Array, key: string): Uint8Array => {
    const { modulus, exponent, size } = fromPem(key);
    const blockSize = Math.ceil(size);
    const input = toBigInt(buffer, 0, buffer.length);
    const encrypted = modPow(input, exponent, modulus);
    const out = new Uint8Array(blockSize);
    let value = encrypted;
    for (let index = blockSize - 1; index >= 0; index -= 1) {
        out[index] = Number(value & 0xffn);
        value >>= 8n;
    }
    return out;
};

// --- zlib ------------------------------------------------------------------

/** Same contract as the desktop host: a promise, because that is how scripts await it. */
export const zlib = {
    inflate: (buffer: Uint8Array): Promise<Uint8Array> => new Promise((resolve, reject) => {
        try {
            resolve(unzlibSync(buffer));
        } catch (error) {
            reject(new Error((error as Error)?.message || 'inflate failed'));
        }
    }),
    deflate: (data: Uint8Array): Promise<Uint8Array> => new Promise((resolve, reject) => {
        try {
            resolve(zlibSync(data));
        } catch (error) {
            reject(new Error((error as Error)?.message || 'deflate failed'));
        }
    }),
};
