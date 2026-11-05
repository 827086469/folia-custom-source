// src/extensions/builtin/lxmc.ts
//
// Reads the playlist files LX Music writes. `.lxmc` is the same JSON gzipped, and both are accepted
// as they come - the extension says nothing about the contents, the first two bytes do.
//
// The shape is worth writing down because it is not documented anywhere:
//
//   { type: "playList_v2", data: { "0": Playlist, "1": Playlist, ... } }   // 整体导出
//   { type: "playListPart", data: Playlist }                              // 单个歌单
//
//   Playlist = { id, name, source?, sourceListId?, list: Song[] }
//   Song     = { id: "wy_417250673", name, singer, source, interval: "03:48", meta: {...} }
//
// `meta` is where the useful part is: `songId`, `albumName`, `albumId`, `picUrl`, and for Kugou a
// `hash` per quality. Those are exactly the fields a custom source script is asked for, which is why
// an imported list plays without searching for anything first.

import { gunzipSync } from 'fflate';
import type { UnifiedSong } from '../../types';
import { buildBuiltinSong, intervalToMs, isBuiltinPlatform, type BuiltinPlatform } from './model';

export interface ImportedPlaylist {
    /** Stable within the file; used to replace a playlist of the same name on re-import. */
    id: string;
    name: string;
    /** The platform most of the songs came from, when they agree. */
    platform?: BuiltinPlatform;
    songs: UnifiedSong[];
}

export interface LxmcParseResult {
    playlists: ImportedPlaylist[];
    /** Songs skipped because their platform is one this provider cannot address. */
    skipped: number;
}

interface LxSong {
    id?: unknown;
    name?: unknown;
    singer?: unknown;
    source?: unknown;
    interval?: unknown;
    meta?: Record<string, unknown>;
}

interface LxPlaylist {
    id?: unknown;
    name?: unknown;
    source?: unknown;
    list?: unknown;
}

const decodeText = (bytes: Uint8Array): string => {
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        return new TextDecoder('utf-8').decode(gunzipSync(bytes));
    }
    return new TextDecoder('utf-8').decode(bytes);
};

/** `wy_417250673` → { wy, 417250673 }. The separator is an underscore, not a colon. */
const splitLxId = (raw: unknown): { platform: string; nativeId: string } | null => {
    if (typeof raw !== 'string') return null;
    const separator = raw.indexOf('_');
    if (separator <= 0) return null;
    return { platform: raw.slice(0, separator), nativeId: raw.slice(separator + 1) };
};

/**
 * Kugou addresses each quality by a hash of its own. The 320k one is taken when the file has it
 * (every script can serve that level), otherwise whatever hash is there.
 */
const pickKugouHash = (meta: Record<string, unknown>): string => {
    const qualities = meta.qualitys;
    if (!Array.isArray(qualities)) {
        return typeof meta.hash === 'string' ? meta.hash : '';
    }
    const entries = qualities
        .filter((entry): entry is { type?: unknown; hash?: unknown } => Boolean(entry) && typeof entry === 'object')
        .map(entry => ({ type: String(entry.type ?? ''), hash: typeof entry.hash === 'string' ? entry.hash : '' }))
        .filter(entry => entry.hash);
    return (
        entries.find(entry => entry.type === '320k')?.hash
        || entries[entries.length - 1]?.hash
        || ''
    );
};

const toSong = (raw: LxSong): UnifiedSong | null => {
    const parsedId = splitLxId(raw.id);
    const platform = raw.source ?? parsedId?.platform;
    if (!isBuiltinPlatform(platform)) return null;

    const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
    // The platform's own id is in `meta.songId` for every writer of this format; the id suffix is
    // the same value for NetEase and Kugou but not always for QQ, so `meta` wins.
    const nativeId = meta.songId != null && meta.songId !== ''
        ? String(meta.songId)
        : (parsedId?.nativeId ?? '');
    if (!nativeId) return null;
    const name = String(raw.name ?? '').trim();
    if (!name) return null;

    return buildBuiltinSong({
        platform,
        nativeId,
        name,
        singer: String(raw.singer ?? ''),
        albumName: typeof meta.albumName === 'string' ? meta.albumName : '',
        albumId: meta.albumId != null ? String(meta.albumId) : '',
        coverUrl: typeof meta.picUrl === 'string' ? meta.picUrl : '',
        durationMs: intervalToMs(raw.interval),
        mediaMid: typeof meta.strMediaMid === 'string' ? meta.strMediaMid : undefined,
        hash: platform === 'kg' ? pickKugouHash(meta) : undefined,
    });
};

/** LX stores its own two lists under i18n keys; these are the two names it shows for them. */
const LX_LIST_NAME: Record<string, string> = {
    list__name_default: '默认列表',
    list__name_love: '我喜欢',
};

const toPlaylist = (raw: LxPlaylist, fallbackName: string): { playlist: ImportedPlaylist; skipped: number } | null => {
    const songs: UnifiedSong[] = [];
    let skipped = 0;
    for (const entry of Array.isArray(raw.list) ? raw.list : []) {
        const song = toSong(entry as LxSong);
        if (song) songs.push(song);
        else skipped += 1;
    }
    // A list whose songs are all from a platform this provider cannot address is still imported: it
    // is a real playlist, it just says so by being empty rather than by disappearing.
    const rawName = String(raw.name ?? '').trim();
    const name = LX_LIST_NAME[rawName] || rawName || fallbackName;
    const platforms = new Set<BuiltinPlatform>();
    for (const song of songs) {
        const platform = song.sourceRef?.kind === 'online' ? String(song.sourceRef.mediaId).split(':')[0] : '';
        if (isBuiltinPlatform(platform)) platforms.add(platform);
    }
    return {
        playlist: {
            id: `imported_${name}`,
            name,
            platform: platforms.size === 1 ? [...platforms][0] : undefined,
            songs,
        },
        skipped,
    };
};

/**
 * Whether these bytes are one of LX Music's playlist exports rather than an m3u.
 *
 * The extension is not consulted: `.lxmc` is gzip (those two bytes are the give-away) and a JSON
 * export of the same shape is whatever the listener renamed it to. Everything else is left to the
 * local importer, which only ever understood m3u.
 */
export const looksLikeLxPlaylist = (bytes: Uint8Array): boolean => {
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
    // 0x7b is `{`: a plain JSON export. Anything else (an m3u starts with `#EXTM3U`) is not ours.
    if (bytes[0] !== 0x7b) return false;
    try {
        const parsed = JSON.parse(decodeText(bytes)) as { type?: unknown };
        return typeof parsed?.type === 'string' && parsed.type.startsWith('playList');
    } catch {
        return false;
    }
};

/**
 * Parses one imported file. Throws only when the bytes are neither gzip nor JSON - everything else
 * (an empty list, a song with no platform) is answered with fewer songs, never with an error.
 */
export const parseLxmc = (bytes: Uint8Array): LxmcParseResult => {
    const text = decodeText(bytes).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text) as { type?: unknown; data?: unknown } | null;
    const data = parsed?.data ?? parsed;

    const playlists: ImportedPlaylist[] = [];
    let skipped = 0;

    // 单个歌单导出: the data IS one playlist, and a playlist is the only shape that owns a `list`.
    // (LX writes the collection as a JSON array in one version and as an index-keyed object in
    // another - both were met in the wild, so a collection is read either way.)
    const isSinglePlaylist = Boolean(
        data && typeof data === 'object' && !Array.isArray(data)
        && Array.isArray((data as LxPlaylist).list),
    );

    if (isSinglePlaylist) {
        const converted = toPlaylist(data as LxPlaylist, '导入的歌单');
        if (converted) {
            playlists.push(converted.playlist);
            skipped += converted.skipped;
        }
        return { playlists, skipped };
    }

    const collection: unknown[] = Array.isArray(data)
        ? data
        : (data && typeof data === 'object' ? Object.values(data as Record<string, unknown>) : []);

    let index = 0;
    for (const value of collection) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        index += 1;
        const converted = toPlaylist(value as LxPlaylist, `导入的歌单 ${index}`);
        if (!converted) continue;
        playlists.push(converted.playlist);
        skipped += converted.skipped;
    }
    return { playlists, skipped };
};
