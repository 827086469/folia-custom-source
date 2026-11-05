// src/extensions/builtin/lyrics.ts
//
// Lyrics straight from the platform, for the same reason search is: the words are not part of the
// audio, so a custom source cannot supply them, and without a server there is no `/lyric/new`
// route to ask. Both endpoints below answer in plain text and need no signing.

import type { SongResult } from '../../types';
import type { ProviderLyricsResult } from '../../types/onlineMusic';
import { parseLyricsByFormat } from '../../utils/lyrics/parserCore';
import { decodeBuiltinId } from './model';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/126.0.0.0 Safari/537.36';

const asRecord = (value: unknown): Record<string, unknown> => (
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const fetchJson = async (url: string, referer: string): Promise<unknown> => {
    const answer = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer } });
    if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
    const raw = await answer.text();
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error('返回的不是 JSON');
    }
};

const EMPTY: ProviderLyricsResult = { lyrics: null, isPureMusic: false };

const build = (lrc: string, translation: string): ProviderLyricsResult => {
    if (!lrc.trim()) return EMPTY;
    // `parseLyricsByFormat` is the parser the rest of the app uses for every lyric it shows, so a
    // song that arrives here lines up, scrolls and styles exactly like one from a provider.
    const lyrics = parseLyricsByFormat('lrc', lrc, translation);
    if (!lyrics.lines.length) return EMPTY;
    return {
        lyrics,
        mainText: lrc,
        translationText: translation || null,
        isPureMusic: false,
    };
};

/** NetEase: the same three fields `/lyric/new` exposes, from the older route that needs no key. */
const neteaseLyrics = async (nativeId: string): Promise<ProviderLyricsResult> => {
    const answer = await fetchJson(
        `https://music.163.com/api/song/lyric?id=${encodeURIComponent(nativeId)}&lv=-1&kv=-1&tv=-1`,
        'https://music.163.com/',
    );
    const root = asRecord(answer);
    const lrc = text(asRecord(root.lrc).lyric);
    const translation = text(asRecord(root.tlyric).lyric);
    // `nolyric` marks an instrumental; saying so stops the matcher looking for words that are not there.
    if (!lrc.trim() && (root.nolyric === true || root.uncollected === true)) {
        return { lyrics: null, isPureMusic: true };
    }
    return build(lrc, translation);
};

/** QQ: `nobase64=1` returns the LRC as text instead of the encoded form older clients wanted. */
const qqLyrics = async (songMid: string): Promise<ProviderLyricsResult> => {
    const params = new URLSearchParams({
        songmid: songMid,
        g_tk: '5381',
        format: 'json',
        nobase64: '1',
        loginUin: '0',
        hostUin: '0',
        platform: 'yqq',
        needNewCode: '0',
    });
    const answer = await fetchJson(
        `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${params.toString()}`,
        'https://y.qq.com/',
    );
    const root = asRecord(answer);
    return build(text(root.lyric), text(root.trans));
};

export const getBuiltinLyrics = async (song: SongResult): Promise<ProviderLyricsResult> => {
    const mediaId = song.sourceRef?.kind === 'online' ? song.sourceRef.mediaId : song.id;
    const parts = decodeBuiltinId(mediaId);
    if (!parts) return EMPTY;

    try {
        if (parts.platform === 'wy' || parts.platform === 'kw') return await neteaseLyrics(parts.nativeId);
        if (parts.platform === 'tx') return await qqLyrics(parts.nativeId);
    } catch (error) {
        console.warn('[Builtin] 取歌词失败', parts.platform, error);
    }
    return EMPTY;
};
