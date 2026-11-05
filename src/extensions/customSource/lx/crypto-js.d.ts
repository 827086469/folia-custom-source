// src/extensions/customSource/lx/crypto-js.d.ts
// crypto-js ships no types of its own and the project does not carry @types/crypto-js. Only the
// handful of entry points `./crypto.ts` calls need a name, so they are declared here rather than
// pulled in as a dependency the build would have to agree with.
declare module 'crypto-js' {
    interface WordArray {
        sigBytes: number;
        words: number[];
        toString(encoder?: unknown): string;
    }
    interface Hasher {
        update(data: unknown): Hasher;
        finalize(): WordArray;
    }
    interface HasherFactory {
        (data?: unknown): WordArray;
    }
    interface Encryptor {
        ciphertext: WordArray;
        toString(): string;
    }
    interface CipherFactory {
        encrypt(message: unknown, key: unknown, cfg?: Record<string, unknown>): Encryptor;
    }
    interface ModeFactory {
        createEncryptor(key: unknown, cfg: Record<string, unknown>): unknown;
    }
    const CryptoJS: {
        lib: { WordArray: { create(data: unknown): WordArray } };
        enc: { Utf8: { stringify(wordArray: WordArray): string }; Hex: unknown };
        mode: { CBC: unknown; ECB: unknown };
        pad: { Pkcs7: unknown; NoPadding: unknown };
        AES: CipherFactory;
        MD5: HasherFactory;
        SHA1: HasherFactory;
        SHA256: HasherFactory;
    };
    export default CryptoJS;
}
