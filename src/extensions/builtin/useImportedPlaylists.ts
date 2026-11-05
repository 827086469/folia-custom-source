// src/extensions/builtin/useImportedPlaylists.ts
//
// The imported lists, as React sees them. One store read shared by every surface that shows them,
// so importing a file updates the home screen, the settings page and anything else at once.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ProviderCollection } from '../../types/onlineMusic';
import type { ImportedPlaylist } from './lxmc';
import { toImportedCollection } from './provider';
import { getImportedPlaylists, loadImportedPlaylists, subscribeImportedPlaylists } from './store';

const EMPTY: ImportedPlaylist[] = [];

export const useImportedPlaylists = (): ImportedPlaylist[] => {
    const playlists = useSyncExternalStore(
        subscribeImportedPlaylists,
        getImportedPlaylists,
        getImportedPlaylists,
    );
    useEffect(() => {
        // The first read comes from the cache; it is async, so the first render shows none.
        void loadImportedPlaylists();
    }, []);
    return playlists;
};

/** The same lists in the shape the home screen's cards take. */
export const useImportedCollections = (): ProviderCollection[] => {
    const playlists = useImportedPlaylists();
    return useMemo(() => playlists.map(toImportedCollection), [playlists]);
};
