// src/extensions/builtin/model.ts
//
// The vocabulary of the built-in provider: which upstream platform a song came from, how that is
// carried in an id, and how a platform's own JSON becomes the song shape Folia plays.
//
// The id matters more than it looks. `omni` routes a song to a provider by `sourceRef.providerId`,
// and this provider answers for every song it produced, whatever platform the song lives on. So the
// platform has to travel with the id: `builtin` + `wy:417250673` says "this provider answers, and
// the address comes from NetEase's 417250673". That is what lets one list mix NetEase, QQ and Kugou
// songs and still have each one resolve against its own platform.

import type { SongResult, UnifiedSong } from '../../types';
import type { MediaId } from '../../types/onlineMusic';

/** The upstream platforms this provider speaks. Matches the LX source keys a script declares. */
export type BuiltinPlatform = 'wy' | 'tx' | 'kg' | 'kw';

export const BUILTIN_PROVIDER_ID = 'builtin';

export const PLATFORM_LABEL: Record<BuiltinPlatform, string> = {
    wy: '网易云音乐',
    tx: 'QQ音乐',
    kg: '酷狗音乐',
    kw: '酷我音乐',
};

/**
 * Two or three characters, for the tag a search row shows beside a song this provider produced.
 * One list mixes platforms now, and the same song exists on several of them, so a row that does not
 * say where it came from leaves the listener unable to tell the copies apart.
 */
export const PLATFORM_BADGE: Record<BuiltinPlatform, string> = {
    wy: '网易',
    tx: 'QQ',
    kg: '酷狗',
    kw: '酷我',
};

/** The `source` key an LX custom source script uses for this platform. */
export const PLATFORM_LX_SOURCE: Record<BuiltinPlatform, string> = {
    wy: 'wy',
    tx: 'tx',
    kg: 'kg',
    kw: 'kw',
};

const KNOWN_PLATFORMS = new Set<string>(Object.keys(PLATFORM_LABEL));

export const isBuiltinPlatform = (value: unknown): value is BuiltinPlatform => (
    typeof value === 'string' && KNOWN_PLATFORMS.has(value)
);

/** `wy:417250673` - the platform, a colon, the platform's own id. */
export const encodeBuiltinId = (platform: BuiltinPlatform, nativeId: string | number): string => (
    `${platform}:${String(nativeId)}`
);

export interface BuiltinIdParts {
    platform: BuiltinPlatform;
    nativeId: string;
}

/** Splits `wy:417250673`; null for an id this provider did not produce. */
export const decodeBuiltinId = (id: MediaId | null | undefined): BuiltinIdParts | null => {
    if (id == null) return null;
    const text = String(id);
    const separator = text.indexOf(':');
    if (separator <= 0) return null;
    const platform = text.slice(0, separator);
    const nativeId = text.slice(separator + 1);
    if (!isBuiltinPlatform(platform) || !nativeId) return null;
    return { platform, nativeId };
};

export interface BuiltinSongInput {
    platform: BuiltinPlatform;
    nativeId: string;
    name: string;
    singer: string;
    albumName?: string;
    albumId?: string | number;
    coverUrl?: string;
    durationMs?: number;
    /** QQ's media mid: some qualities are addressed by it rather than by the song mid. */
    mediaMid?: string;
    /** Kugou's hash for the quality that will be asked for. */
    hash?: string;
    fee?: number;
}

/** `03:48` (LX's own format, and what .lxmc stores) to milliseconds. */
export const intervalToMs = (interval: unknown): number => {
    if (typeof interval === 'number' && Number.isFinite(interval)) return Math.max(0, Math.round(interval));
    const text = String(interval ?? '').trim();
    const match = /^(\d+):(\d{1,2})$/.exec(text);
    if (!match) return 0;
    return (Number(match[1]) * 60 + Number(match[2])) * 1000;
};

/**
 * The song as Folia plays it. Artists are split on the separators the platforms use so that a duet
 * lines up with the same song found through a provider that returns them separately.
 */
export const buildBuiltinSong = (input: BuiltinSongInput): UnifiedSong => {
    const mediaId = encodeBuiltinId(input.platform, input.nativeId);
    const artistNames = String(input.singer || '')
        .split(/\s*[、/&]\s*/)
        .map(name => name.trim())
        .filter(Boolean);

    return {
        id: mediaId,
        name: input.name,
        artists: (artistNames.length ? artistNames : ['']).map((name, index) => ({
            id: `${mediaId}#${index}`,
            name,
        })),
        album: {
            id: input.albumId != null && input.albumId !== '' ? String(input.albumId) : '',
            name: input.albumName || '',
            coverUrl: input.coverUrl || '',
        },
        durationMs: input.durationMs || 0,
        sourceRef: { kind: 'online', providerId: BUILTIN_PROVIDER_ID, mediaId },
        ...(input.fee != null ? { fee: input.fee } : {}),
        // Read by this provider's own playback, not by Folia's other adapters: the platform id alone
        // is not always enough to address the audio.
        ...(input.mediaMid ? { qqMid: input.mediaMid } : {}),
        ...(input.hash ? { kgHash: input.hash } : {}),
    };
};

/**
 * What a custom source script is given for this song. LX scripts key on `songmid` for NetEase and
 * QQ and on `hash` for Kugou; the rest of the fields are there for scripts that log or match.
 */
export const toLxMusicInfo = (song: SongResult): Record<string, string | number> | null => {
    const parts = decodeBuiltinId(song.sourceRef?.kind === 'online' ? song.sourceRef.mediaId : song.id);
    if (!parts) return null;
    const base: Record<string, string | number> = {
        name: song.name,
        singer: song.artists.map(artist => artist.name).filter(Boolean).join('、'),
        albumName: song.album?.name ?? '',
        interval: Math.max(0, Math.round((song.durationMs || 0) / 1000)),
    };
    if (parts.platform === 'wy' || parts.platform === 'kw') {
        return { ...base, songmid: parts.nativeId, id: parts.nativeId };
    }
    if (parts.platform === 'kg') {
        const hash = song.kgHash || parts.nativeId;
        return hash ? { ...base, hash } : null;
    }
    // QQ: the song mid is `songmid`; `strMediaMid` addresses some qualities, and scripts that read
    // it fall back to the song mid when it is absent.
    const mediaMid = song.qqMid || parts.nativeId;
    return { ...base, songmid: parts.nativeId, strMediaMid: mediaMid, media_mid: mediaMid };
};
