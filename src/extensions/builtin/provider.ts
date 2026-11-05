// src/extensions/builtin/provider.ts
//
// The 内置音源 provider: Folia's own online source, with no account and no server behind it.
//
// It exists because the three platform adapters all answer through a local API service that only
// the desktop app can start. On a phone there is no such service, so every one of them reports
// `unavailable` and the app has nothing to search with. This provider takes over the three things
// that were being asked of that service - search, the audio URL, the lyrics - and asks the platforms
// directly, which the native network stack allows.
//
// What it does NOT do is pretend to be a platform. It has no account, no recommendations and no
// subscribed lists; the lists it serves are the ones imported from a `.lxmc` file. That is the whole
// point: an app with a catalogue you own rather than one you sign in to.

import type { SongResult, UnifiedSong } from '../../types';
import type {
    MediaId,
    OnlineMusicProvider,
    ProviderCapabilities,
    ProviderCollection,
    ProviderLyricsResult,
    ProviderPage,
    ProviderSongAvailability,
} from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { getCustomSourceBridge } from '../customSource/bridge';
import { getBuiltinLyrics } from './lyrics';
import {
    BUILTIN_PROVIDER_ID,
    PLATFORM_LABEL,
    PLATFORM_LX_SOURCE,
    decodeBuiltinId,
    toLxMusicInfo,
    type BuiltinPlatform,
} from './model';
import { searchBuiltin } from './search';
import { findImportedPlaylist, loadImportedPlaylists } from './store';

const CAPABILITIES: ProviderCapabilities = {
    search: true,
    playback: true,
    lyrics: true,
    // No account exists to sign into, so everything an account would unlock is off. `userLibrary` is
    // the exception: it only means "there are lists of the listener's own", and imported playlists
    // are exactly that - the home screen's playlist tab keys off it and would otherwise stay closed.
    auth: false,
    userLibrary: true,
    albums: false,
    artists: false,
    recommendations: false,
    mutations: false,
    wordByWordLyrics: false,
    // Imported lists are served through `catalog`, which is what the home screen reads its cards from.
    playlists: true,
};

/** `imported_…` ids belong to an imported list; anything else is not a collection of ours. */
const isImportedPlaylistId = (id: MediaId): boolean => String(id).startsWith('imported_');

export const toImportedCollection = (playlist: { id: string; name: string; songs: SongResult[]; platform?: BuiltinPlatform }): ProviderCollection => ({
    providerId: BUILTIN_PROVIDER_ID,
    id: playlist.id,
    name: playlist.name,
    type: 'playlist',
    // A list has no cover of its own in the file; the first song's artwork is what LX shows too.
    coverUrl: playlist.songs.find(song => song.album?.coverUrl)?.album?.coverUrl ?? '',
    trackCount: playlist.songs.length,
    ...(playlist.platform ? { description: `导入自 ${PLATFORM_LABEL[playlist.platform]}` } : { description: '导入的歌单' }),
});

const page = <T>(items: T[], total: number, limit: number, offset: number): ProviderPage<T> => ({
    items,
    total,
    hasMore: offset + items.length < total,
    nextOffset: offset + items.length,
});

const unsupported = (what: string): never => {
    throw new OnlineProviderError('unavailable', `内置音源没有${what}`, BUILTIN_PROVIDER_ID);
};

export const builtinProvider: OnlineMusicProvider = {
    id: BUILTIN_PROVIDER_ID,
    displayName: '内置音源',
    shortName: '内置',
    getAvailability: () => ({ configured: true }),

    capabilities: CAPABILITIES,

    // Everything this provider hands out is already in Folia's shape: it built those songs itself.
    normalizeSong: raw => raw as UnifiedSong,

    search: {
        async searchSongs(query, limit, offset) {
            const answer = await searchBuiltin(query, limit, offset);
            return page(answer.songs, answer.total, limit, offset);
        },
    },

    playback: {
        async getSongDetail(id) {
            // A row played from a persisted queue arrives as a bare id. The player only needs the id
            // to keep working; the address and the words are asked for separately.
            const parts = decodeBuiltinId(id);
            if (!parts) return null;
            return {
                id: String(id),
                name: '',
                artists: [],
                album: { id: '', name: '' },
                durationMs: 0,
                sourceRef: { kind: 'online', providerId: BUILTIN_PROVIDER_ID, mediaId: String(id) },
            };
        },

        async getAudioSource(song, quality) {
            const mediaId = song.sourceRef?.kind === 'online' ? song.sourceRef.mediaId : song.id;
            const parts = decodeBuiltinId(mediaId);
            if (!parts) throw new OnlineProviderError('invalid-response', '这首歌没有可用的平台标识', BUILTIN_PROVIDER_ID);

            const bridge = getCustomSourceBridge();
            if (!bridge) {
                throw new OnlineProviderError(
                    'unavailable',
                    '没有自定义音源宿主，内置音源无法取址',
                    BUILTIN_PROVIDER_ID,
                );
            }

            const musicInfo = toLxMusicInfo(song);
            if (!musicInfo) {
                throw new OnlineProviderError(
                    'invalid-response',
                    `缺少 ${PLATFORM_LABEL[parts.platform]} 的取址字段（可能是酷狗歌曲还没拿到 hash）`,
                    BUILTIN_PROVIDER_ID,
                );
            }

            const answer = await bridge.resolveUrl({
                source: PLATFORM_LX_SOURCE[parts.platform],
                musicInfo,
                quality,
            });
            if (!answer.ok || !answer.url) {
                throw new OnlineProviderError(
                    answer.error?.code === 'no-source' ? 'unavailable' : 'network',
                    answer.error?.message || `${PLATFORM_LABEL[parts.platform]} 取址失败`,
                    BUILTIN_PROVIDER_ID,
                );
            }

            return {
                url: answer.url,
                fetchedAt: Date.now(),
                quality: (answer.quality as typeof quality) || quality,
            };
        },
    },

    lyrics: {
        getLyrics: (song): Promise<ProviderLyricsResult> => getBuiltinLyrics(song),
    },

    catalog: {
        async getPlaylistDetail(id) {
            if (!isImportedPlaylistId(id)) return null;
            await loadImportedPlaylists();
            const playlist = findImportedPlaylist(String(id));
            return playlist ? toImportedCollection(playlist) : null;
        },

        async getPlaylistTracks(id, limit, offset) {
            if (!isImportedPlaylistId(id)) unsupported('这个歌单');
            await loadImportedPlaylists();
            const playlist = findImportedPlaylist(String(id));
            if (!playlist) {
                throw new OnlineProviderError('unavailable', '这个歌单不存在了', BUILTIN_PROVIDER_ID);
            }
            const songs = playlist.songs.slice(offset, offset + limit);
            return page(songs, playlist.songs.length, limit, offset);
        },    },
};

export const isBuiltinSong = (song: SongResult | null | undefined): boolean => (
    Boolean(song?.sourceRef?.kind === 'online' && song.sourceRef.providerId === BUILTIN_PROVIDER_ID)
);
