// src/extensions/customSource/mobile/http.ts
//
// `lx.request` for the Android shell. The desktop host answers it from the main process
// (`custom-source/http.cjs`), which is why a script can reach any music API host there. In a WebView
// the page's own fetch is bound by the same cross-origin rules as any website's, so this goes through
// CapacitorHttp instead: the request is made by the native layer and the page never sees the host.
//
// The callback contract is unchanged - request(url, options, callback) with callback(err, resp, body)
// - because that is what the scripts were written against. One detail is kept on purpose: the body is
// JSON-parsed before the callback runs, since LX does `try { resp.body = JSON.parse(body) } catch {}`
// and scripts read `resp.body.code` rather than a string.

import { CapacitorHttp } from '@capacitor/core';
import type { LxAudioProbe, LxProbeResult, LxRequest, LxRequestOptions, LxResponse } from '../lx/scriptHost';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/**
 * A playable file below this size is not the song, but a spoken notice served as audio. Same value
 * and same reasoning as the desktop probe (`custom-source/lxHost.cjs`): 30 seconds at 64 kbps is
 * already ~240 KB, while the notices are tens of KB.
 */
const MIN_SONG_BYTES = 200 * 1024;
const PROBE_TIMEOUT_MS = 8_000;

const decodeBase64 = (value: string): Uint8Array => {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
    return out;
};

const toBytes = (data: unknown): Uint8Array => {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === 'string') {
        // On Android, 'arraybuffer' answers with base64; the web fallback answers with a real
        // ArrayBuffer. Both cases end up here.
        try {
            return decodeBase64(data);
        } catch {
            return new TextEncoder().encode(data);
        }
    }
    if (data == null) return new Uint8Array(0);
    return new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data));
};

const normalizeHeaders = (raw: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value != null) out[key.toLowerCase()] = String(value);
    }
    return out;
};

const buildBody = (options: LxRequestOptions, headers: Record<string, string>): string | null => {
    if (options.form && typeof options.form === 'object') {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(options.form)) params.append(key, String(value));
        if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';
        return params.toString();
    }
    const body = options.body;
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    return JSON.stringify(body);
};

export const createNativeLxRequest = (): LxRequest => (
    url: string,
    options: LxRequestOptions = {},
    callback = () => undefined,
) => {
    if (typeof callback !== 'function') return () => undefined;
    const requestOptions = options && typeof options === 'object' ? options : {};
    const timeoutMs = Number(requestOptions.timeout) > 0 ? Number(requestOptions.timeout) : DEFAULT_TIMEOUT_MS;

    let settled = false;
    const finish = (error: unknown, response?: LxResponse, body?: unknown) => {
        if (settled) return;
        settled = true;
        // The callback is the script's own code. If it throws, that is the script's bug - but it must
        // not escape into the page's error handler and take the player down with it.
        try {
            callback(error, response, body);
        } catch (callbackError) {
            console.warn('[CustomSource] 音源脚本在 request 回调中抛出异常', describe(callbackError));
        }
    };

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(requestOptions.headers || {})) {
        if (value != null) headers[key.toLowerCase()] = String(value);
    }
    if (!headers['user-agent']) headers['user-agent'] = DEFAULT_USER_AGENT;

    const body = buildBody(requestOptions, headers);
    // Content-Length is deliberately left to the native layer: a script that computes it for a
    // multi-byte body usually gets it wrong, and OkHttp sets the right one.
    delete headers['content-length'];

    void (async () => {
        try {
            const answer = await CapacitorHttp.request({
                url: String(url),
                method: String(requestOptions.method || 'GET').toUpperCase(),
                headers,
                data: body ?? undefined,
                responseType: 'arraybuffer',
                connectTimeout: timeoutMs,
                readTimeout: timeoutMs,
            });
            const raw = toBytes(answer.data);
            const text = new TextDecoder('utf-8').decode(raw);
            let parsed: unknown = text;
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = text;
            }
            const responseHeaders = normalizeHeaders(answer.headers);
            finish(null, {
                statusCode: answer.status,
                statusMessage: '',
                headers: responseHeaders,
                bytes: raw.length,
                raw,
                body: parsed,
            }, parsed);
        } catch (error) {
            finish(error instanceof Error ? error : new Error(describe(error)));
        }
    })();

    // CapacitorHttp has no abort: the request is a promise the native layer owns. Cancelling is
    // only ever used to drop an answer nobody wants any more, which `settled` already does.
    return () => { settled = true; };
};

/**
 * The audio URL probe for the Android shell. A GET through CapacitorHttp would pull the whole
 * response body into memory (the native layer has no "headers only" mode), so this asks with HEAD
 * instead: no body is ever transferred, and `Content-Length` on a HEAD answer is the full entity
 * size, which is exactly what the probe needs.
 *
 * Only what the probe can prove counts against the address: a spoken notice (HTTP 200, audio
 * content-type, tens of KB), an HTML/JSON error page, or a 404/410. A HEAD answer the CDN refuses
 * (403/405 - some signed URLs are method-bound) or a network failure says nothing about whether
 * the song plays, so those pass and the player remains the judge.
 */
export const createNativeAudioProbe = (): LxAudioProbe => async (url: string): Promise<LxProbeResult> => {
    try {
        const answer = await CapacitorHttp.request({
            url: String(url),
            method: 'HEAD',
            headers: { 'User-Agent': DEFAULT_USER_AGENT },
            responseType: 'arraybuffer',
            connectTimeout: PROBE_TIMEOUT_MS,
            readTimeout: PROBE_TIMEOUT_MS,
        });
        const status = Number(answer.status) || 0;
        const headers = normalizeHeaders(answer.headers);
        if (status !== 200 && status !== 206) {
            if (status === 404 || status === 410) return { ok: false, reason: `HTTP ${status}` };
            // 403/405/5xx: the server refused the method, not necessarily the song.
            return { ok: true, total: null, reason: `HEAD ${status}，未验真` };
        }
        const contentType = headers['content-type'] || '';
        if (/\bjson\b|\bxml\b|\bhtml\b|text\//i.test(contentType)) {
            return { ok: false, reason: `返回的是 ${contentType || '无类型'} 而不是音频` };
        }
        const length = Number(headers['content-length']);
        const total = Number.isFinite(length) && length >= 0 ? length : null;
        if (total != null && total < MIN_SONG_BYTES) {
            return {
                ok: false,
                reason: `音频只有 ${total} 字节（不足 ${Math.floor(MIN_SONG_BYTES / 1024)} KB，疑似错误提示语音）`,
                total,
            };
        }
        return { ok: true, total };
    } catch {
        // A probe that cannot answer (timeout, network error) is not a reason to drop the address.
        return { ok: true, total: null, reason: '未验真' };
    }
};

const describe = (error: unknown): string => {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    const candidate = error as { message?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.trim()) return candidate.message.trim();
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
};
