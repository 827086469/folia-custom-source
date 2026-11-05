// src/extensions/builtin/store.ts
//
// Where imported playlists live. They are the listener's own data, not an account's, so they are
// kept apart from everything the providers read: one cache entry, read once at start-up.
//
// The change listener exists because three places show these lists and none of them owns them - the
// home screen's cards, the settings page and the provider's own catalog. Importing a file has to
// reach all three at once, and a listener does that without threading a refresh call through each.

import { getFromCache, saveToCache } from '../../services/db';
import type { ImportedPlaylist, LxmcParseResult } from './lxmc';
import { parseLxmc } from './lxmc';

const CACHE_KEY = 'builtin_imported_playlists';

let playlists: ImportedPlaylist[] = [];
let loaded = false;
let loading: Promise<ImportedPlaylist[]> | null = null;

const listeners = new Set<() => void>();

const announce = (): void => {
    for (const listener of listeners) {
        try {
            listener();
        } catch (error) {
            console.warn('[Builtin] 歌单变更回调抛出异常', error);
        }
    }
};

/** Calls `listener` after every change; returns the unsubscribe function. */
export const subscribeImportedPlaylists = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

export const getImportedPlaylists = (): ImportedPlaylist[] => playlists;

/** The playlists as they are, reading the cache the first time. */
export const loadImportedPlaylists = (): Promise<ImportedPlaylist[]> => {
    if (loaded) return Promise.resolve(playlists);
    if (loading) return loading;
    loading = (async () => {
        const cached = await getFromCache<ImportedPlaylist[]>(CACHE_KEY);
        playlists = Array.isArray(cached) ? cached.filter(item => item && Array.isArray(item.songs)) : [];
        loaded = true;
        loading = null;
        announce();
        return playlists;
    })();
    return loading;
};

const persist = async (next: ImportedPlaylist[]): Promise<void> => {
    playlists = next;
    loaded = true;
    await saveToCache(CACHE_KEY, next);
    announce();
};

export interface ImportOutcome extends LxmcParseResult {
    added: number;
    replaced: number;
}

/**
 * Imports one file's playlists. A playlist of the same name replaces the one already there: the file
 * is the newer copy of it, and importing last month's export must not leave two.
 */
export const importPlaylistFile = async (bytes: Uint8Array): Promise<ImportOutcome> => {
    await loadImportedPlaylists();
    const parsed = parseLxmc(bytes);
    const next = [...playlists];
    let added = 0;
    let replaced = 0;

    for (const incoming of parsed.playlists) {
        const index = next.findIndex(item => item.name === incoming.name);
        if (index >= 0) {
            next[index] = incoming;
            replaced += 1;
        } else {
            next.push(incoming);
            added += 1;
        }
    }

    await persist(next);
    return { ...parsed, added, replaced };
};

export const removeImportedPlaylist = async (id: string): Promise<void> => {
    await loadImportedPlaylists();
    await persist(playlists.filter(item => item.id !== id));
};

export const clearImportedPlaylists = async (): Promise<void> => {
    await persist([]);
};

/** One playlist by id, for the provider's catalog. */
export const findImportedPlaylist = (id: string): ImportedPlaylist | null => (
    playlists.find(item => item.id === id) ?? null
);
