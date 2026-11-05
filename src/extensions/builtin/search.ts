// src/extensions/builtin/search.ts
//
// Search without a server. LX Music does this the same way: the player itself asks the platform,
// because nothing in the custom source protocol can search - a script only answers "where is this
// song's audio". Its SDK lives in `src/renderer/utils/musicSdk/{wy,tx,kg}/musicSearch.js` and goes
// straight at the platform over a transport that has no cross-origin rules.
//
// Here that transport is `fetch`, which the Android shell patches onto the native stack
// (`plugins.CapacitorHttp.enabled`), so the same direct calls work from a WebView.
//
// Three platforms answer, and they are asked together rather than in turn. One platform is not
// enough on its own: a song can be missing from any of them over licensing, and NetEase in
// particular answers a search for a Jay Chou song with covers of it rather than the recording. What
// comes back is one list, woven so that every platform reaches the first screen.
//
// The endpoints are the platforms' own, unauthenticated and unencrypted:
//   NetEase  POST music.163.com/api/cloudsearch/pc          → result.songs
//   QQ       GET  c.y.qq.com/soso/fcgi-bin/search_for_qq_cp → data.song.list
//   Kugou    GET  mobiles.kugou.com/api/v3/search/song      → data.info
// LX's current code signs NetEase requests with eapi instead; the plain endpoint it used before
// still answers, and not having to reproduce the signing is most of the work saved here.

import type { UnifiedSong } from '../../types';
import { buildBuiltinSong, PLATFORM_LABEL, type BuiltinPlatform } from './model';

const WY_ENDPOINT = 'https://music.163.com/api/cloudsearch/pc';
// `soso/fcgi-bin/client_search_cp` is what this used to call; it now answers an anonymous request
// with HTTP 500 and an empty body. This is the H5 endpoint of the same service, still unsigned.
const TX_ENDPOINT = 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp';
// `mobilecdn.kugou.com` serves this API over plain HTTP only, and a WebView refuses that from an
// https origin as mixed content. The same v3 API answers over TLS on this host.
const KG_ENDPOINT = 'https://mobiles.kugou.com/api/v3/search/song';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/126.0.0.0 Safari/537.36';

/**
 * How far into each platform's own ranking a page may reach. Every page is built from the prefix of
 * every ranking, so the 5th page asks each platform for 100 rows; past that, asking for more would
 * cost more than the answer is worth in a search box.
 */
const AGGREGATE_POOL_MAX = 100;

export interface BuiltinSearchPage {
    songs: UnifiedSong[];
    total: number;
    /** Which platforms answered, in the order their songs were woven into `songs`. */
    platforms: BuiltinPlatform[];
}

const asRecord = (value: unknown): Record<string, unknown> => (
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const text = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

/** NetEase's answer, in either the old (`artists`/`album`) or the current (`ar`/`al`) spelling. */
const fromNetease = (raw: unknown): UnifiedSong | null => {
    const item = asRecord(raw);
    const nativeId = item.id;
    const name = text(item.name).trim();
    if (nativeId == null || !name) return null;

    const artists = asArray(item.ar).length ? asArray(item.ar) : asArray(item.artists);
    // `al` is an object in the current answer and an array in the older one; both are met.
    const albumRaw = item.al ?? item.album;
    const album = asRecord(Array.isArray(albumRaw) ? albumRaw[0] : albumRaw);
    const singer = artists
        .map(artist => text(asRecord(artist).name))
        .filter(Boolean)
        .join('、');

    return buildBuiltinSong({
        platform: 'wy',
        nativeId: text(nativeId),
        name,
        singer,
        albumName: text(album.name),
        albumId: album.id != null ? text(album.id) : '',
        coverUrl: text(album.picUrl).replace(/^http:/, 'https:'),
        durationMs: Number(item.dt ?? item.duration ?? 0) || 0,
        fee: item.fee != null ? Number(item.fee) : undefined,
    });
};

const QQ_COVER = 'https://y.gtimg.cn/music/photo_new/T002R500x500M000';

/**
 * QQ answers in two shapes: the desktop route nests `album` and `file`, the H5 one flattens them to
 * `albummid`/`albumname` and sends no media mid at all. Both are read here, and a missing media mid
 * falls back to the song mid, which is what it equals for the qualities a script asks for.
 */
const fromQq = (raw: unknown): UnifiedSong | null => {
    const item = asRecord(raw);
    const mid = text(item.mid || item.songmid);
    const name = text(item.name || item.songname).trim();
    if (!mid || !name) return null;

    const singer = asArray(item.singer)
        .map(artist => text(asRecord(artist).name))
        .filter(Boolean)
        .join('、');
    const album = asRecord(item.album);
    const albumMid = text(album.mid) || text(item.albummid);
    const file = asRecord(item.file);
    const interval = Number(item.interval ?? 0);

    return buildBuiltinSong({
        platform: 'tx',
        nativeId: mid,
        name,
        singer,
        albumName: text(album.name) || text(item.albumname),
        albumId: albumMid,
        coverUrl: albumMid ? `${QQ_COVER}${albumMid}.jpg` : '',
        // QQ's `interval` is in seconds; NetEase's is already milliseconds.
        durationMs: Number.isFinite(interval) && interval > 0 ? interval * 1000 : 0,
        mediaMid: text(file.media_mid) || mid,
    });
};

const KG_COVER_TEMPLATE_SIZE = '480';

/**
 * Kugou addresses a song by `hash`, and which hash decides which quality a script can fetch:
 * `320hash` for 320k, `sqhash` for lossless, `hash` for 128k alone. The best one present is what
 * travels with the song, so a script asking for 320k gets the hash that exists in 320k.
 */
const fromKugou = (raw: unknown): UnifiedSong | null => {
    const item = asRecord(raw);
    const name = text(item.songname).trim();
    const hash = text(item['320hash']) || text(item.sqhash) || text(item.hash);
    const nativeId = text(item.album_audio_id) || text(item.audio_id);
    if (!name || !hash || !nativeId) return null;

    // `union_cover` is a template - `…/stdmusic/{size}/2023….jpg` - that expects a size substituted.
    const coverTemplate = text(asRecord(item.trans_param).union_cover);
    const duration = Number(item.duration ?? 0);

    return buildBuiltinSong({
        platform: 'kg',
        nativeId,
        name,
        singer: text(item.singername),
        albumName: text(item.album_name),
        albumId: text(item.album_id),
        coverUrl: coverTemplate
            .replace('{size}', KG_COVER_TEMPLATE_SIZE)
            .replace(/^http:/, 'https:'),
        durationMs: Number.isFinite(duration) && duration > 0 ? duration * 1000 : 0,
        hash,
    });
};

const fetchJson = async (url: string, init: RequestInit): Promise<unknown> => {
    const answer = await fetch(url, init);
    if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
    const raw = await answer.text();
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error('返回的不是 JSON（可能被拦了）');
    }
};

export const searchNetease = async (query: string, limit: number, offset: number): Promise<BuiltinSearchPage> => {
    const body = new URLSearchParams({
        s: query,
        type: '1',
        limit: String(limit),
        offset: String(offset),
        total: 'true',
        csrf_token: '',
    });
    const answer = await fetchJson(WY_ENDPOINT, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: 'https://music.163.com/',
        },
        body: body.toString(),
    });
    const result = asRecord(asRecord(answer).result);
    const songs = asArray(result.songs).map(fromNetease).filter((song): song is UnifiedSong => Boolean(song));
    return { songs, total: Number(result.songCount ?? songs.length) || songs.length, platforms: ['wy'] };
};

export const searchQq = async (query: string, limit: number, offset: number): Promise<BuiltinSearchPage> => {
    const page = Math.floor(offset / Math.max(1, limit)) + 1;
    const params = new URLSearchParams({
        // The H5 route wants the whole H5 preamble; `format` and `new_json` alone answer 500.
        g_tk: '5381',
        uin: '0',
        format: 'json',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        notice: '0',
        platform: 'h5',
        needNewCode: '1',
        w: query,
        zhidaqu: '1',
        catZhida: '1',
        t: '0',
        flag_qc: '0',
        p: String(page),
        n: String(limit),
        remoteplace: 'txt.mqq.all',
    });
    const answer = await fetchJson(`${TX_ENDPOINT}?${params.toString()}`, {
        headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' },
    });
    const songBlock = asRecord(asRecord(asRecord(answer).data).song);
    const songs = asArray(songBlock.list).map(fromQq).filter((song): song is UnifiedSong => Boolean(song));
    return { songs, total: Number(songBlock.totalnum ?? songs.length) || songs.length, platforms: ['tx'] };
};

export const searchKugou = async (query: string, limit: number, offset: number): Promise<BuiltinSearchPage> => {
    const page = Math.floor(offset / Math.max(1, limit)) + 1;
    const params = new URLSearchParams({
        format: 'json',
        keyword: query,
        page: String(page),
        pagesize: String(limit),
        showtype: '1',
    });
    const answer = await fetchJson(`${KG_ENDPOINT}?${params.toString()}`, {
        headers: { 'User-Agent': UA, Referer: 'https://www.kugou.com/' },
    });
    const data = asRecord(asRecord(answer).data);
    const songs = asArray(data.info).map(fromKugou).filter((song): song is UnifiedSong => Boolean(song));
    return { songs, total: Number(data.total ?? songs.length) || songs.length, platforms: ['kg'] };
};

interface PlatformSearcher {
    platform: BuiltinPlatform;
    run: (query: string, limit: number, offset: number) => Promise<BuiltinSearchPage>;
}

/** Merge order, and the order the badges agree with: NetEase first, then QQ, then Kugou. */
const SEARCHERS: PlatformSearcher[] = [
    { platform: 'wy', run: searchNetease },
    { platform: 'tx', run: searchQq },
    { platform: 'kg', run: searchKugou },
];

/**
 * Highest song first, then the next platform's highest, and so on. Concatenating instead would let
 * NetEase's first hundred covers push every other platform off the first page - the exact failure
 * that made a search for a Jay Chou song useless.
 */
const interleave = (lists: UnifiedSong[][]): UnifiedSong[] => {
    const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
    const merged: UnifiedSong[] = [];
    for (let index = 0; index < longest; index += 1) {
        for (const list of lists) {
            const song = list[index];
            if (song) merged.push(song);
        }
    }
    return merged;
};

/**
 * One query, answered by every platform that can. A page is a window over the combined ranking, so
 * each platform is asked for its own prefix of that window and the lists are woven before slicing -
 * page 2 is "songs 21 to 40", not "song 21 of each platform".
 */
export const searchBuiltin = async (query: string, limit: number, offset: number): Promise<BuiltinSearchPage> => {
    const trimmed = query.trim();
    if (!trimmed) return { songs: [], total: 0, platforms: [] };

    const pageSize = Math.max(1, limit);
    const windowEnd = offset + pageSize;
    const poolSize = Math.min(windowEnd, AGGREGATE_POOL_MAX);
    // Past the cap a page can no longer be filled, and saying so is what stops the list from
    // asking for pages the pool will never reach.
    const pastPool = windowEnd > AGGREGATE_POOL_MAX;

    const answers = await Promise.allSettled(SEARCHERS.map(searcher => searcher.run(trimmed, poolSize, 0)));

    const failures: string[] = [];
    const lists: UnifiedSong[][] = [];
    const platforms: BuiltinPlatform[] = [];
    let totalSum = 0;

    answers.forEach((answer, index) => {
        const searcher = SEARCHERS[index];
        if (answer.status === 'rejected') {
            const reason = answer.reason as { message?: string } | undefined;
            failures.push(`${PLATFORM_LABEL[searcher.platform]}：${reason?.message ?? String(answer.reason)}`);
            return;
        }
        if (!answer.value.songs.length) {
            failures.push(`${PLATFORM_LABEL[searcher.platform]}没有结果`);
            return;
        }
        lists.push(answer.value.songs);
        platforms.push(searcher.platform);
        totalSum += answer.value.total;
    });

    if (!lists.length) throw new Error(`搜索失败（${failures.join('；')}）`);

    const songs = interleave(lists).slice(offset, offset + pageSize);
    return {
        songs,
        total: pastPool ? offset + songs.length : Math.max(totalSum, offset + songs.length),
        platforms,
    };
};
