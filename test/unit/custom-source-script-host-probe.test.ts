// src/extensions/customSource/lx/scriptHost.ts gains an injected audio probe: an address that
// answers with a spoken notice instead of the song must fall through to the next script, and a
// probe that cannot answer must never cost the address. The desktop host has the same rule in
// custom-source/lxHost.cjs; these cases pin the mobile wiring without an Android runtime.

import { describe, expect, it } from 'vitest';
import {
    createLxHost,
    type LxAudioProbe,
    type LxScriptStore,
} from '@/extensions/customSource/lx/scriptHost';

const makeStore = (files: Record<string, string>): LxScriptStore => ({
    dirLabel: '/test-sources',
    listFiles: async () => Object.keys(files),
    readFile: async name => files[name],
    writeFile: async () => undefined,
    removeFile: async () => undefined,
    readDisabled: async () => [],
    writeDisabled: async () => undefined,
});

/** A script whose handler answers per `songmid`, exactly like the fake used for the desktop host. */
const scriptReturning = (urlMap: Record<string, string>, name: string): string => `
/*! @name ${name} @version 1.0.0 */
lx.on(lx.EVENT_NAMES.request, function (p) {
    return (${JSON.stringify(urlMap)})[p.info.musicInfo.songmid] || '';
});
lx.send(lx.EVENT_NAMES.inited, { sources: { wy: { name: 't', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } });
`;

const noRequest = () => () => undefined;
const info = (songmid: string) => ({ songmid, name: 'n', singer: 's', interval: 200 });

describe('LxHost audio probe wiring', () => {
    it('rejects an address the probe proves fake and falls through to the next script', async () => {
        const files = {
            'a-bad.js': scriptReturning({ s: 'http://example.com/notice.mp3' }, 'a-bad'),
            'b-good.js': scriptReturning({ s: 'http://example.com/song.mp3' }, 'b-good'),
        };
        const seen: string[] = [];
        const probe: LxAudioProbe = async url => {
            seen.push(url);
            return url.endsWith('notice.mp3')
                ? { ok: false, reason: '音频只有 51200 字节（不足 200 KB，疑似错误提示语音）', total: 51200 }
                : { ok: true, total: 3145728 };
        };
        const host = createLxHost({ store: makeStore(files), request: noRequest, probeAudioUrl: probe });
        await host.whenLoaded();

        const result = await host.resolveUrl({ source: 'wy', musicInfo: info('s'), quality: 'standard' });

        expect(result.ok).toBe(true);
        expect(result.url).toBe('http://example.com/song.mp3');
        expect(result.script).toBe('b-good.js');
        expect(seen).toEqual(['http://example.com/notice.mp3', 'http://example.com/song.mp3']);
    });

    it('reports the verification failure when every script fails the probe', async () => {
        const files = { 'only.js': scriptReturning({ s: 'http://example.com/notice.mp3' }, 'only') };
        const host = createLxHost({
            store: makeStore(files),
            request: noRequest,
            probeAudioUrl: async () => ({ ok: false, reason: '音频只有 51200 字节（疑似错误提示语音）' }),
        });
        await host.whenLoaded();

        const result = await host.resolveUrl({ source: 'wy', musicInfo: info('s'), quality: 'standard' });

        expect(result.ok).toBe(false);
        expect(result.error?.message).toContain('未通过验真');
    });

    it('passes the address when the probe itself fails', async () => {
        const files = { 'only.js': scriptReturning({ s: 'http://example.com/song.mp3' }, 'only') };
        const host = createLxHost({
            store: makeStore(files),
            request: noRequest,
            probeAudioUrl: async () => {
                throw new Error('network down');
            },
        });
        await host.whenLoaded();

        const result = await host.resolveUrl({ source: 'wy', musicInfo: info('s'), quality: 'standard' });

        expect(result.ok).toBe(true);
        expect(result.url).toBe('http://example.com/song.mp3');
    });

    it('keeps trusting the script when no probe is injected', async () => {
        const files = { 'only.js': scriptReturning({ s: 'http://example.com/song.mp3' }, 'only') };
        const host = createLxHost({ store: makeStore(files), request: noRequest });
        await host.whenLoaded();

        const result = await host.resolveUrl({ source: 'wy', musicInfo: info('s'), quality: 'standard' });

        expect(result.ok).toBe(true);
        expect(result.url).toBe('http://example.com/song.mp3');
    });
});
