// src/extensions/builtin/index.ts
//
// Registers the provider and offers the one action the settings page needs: pick a playlist file
// and import it. The picking is the same `<input type="file">` the mobile custom-source page uses -
// it is the one way to read an arbitrary file the listener chooses on both desktop and Android,
// and it needs no permission on either.

import { registerOnlineMusicProvider } from '../../services/onlineMusic/providerRegistry';
import { builtinProvider } from './provider';
import { looksLikeLxPlaylist } from './lxmc';
import { importPlaylistFile, type ImportOutcome } from './store';

export {
    clearImportedPlaylists,
    getImportedPlaylists,
    importPlaylistFile,
    loadImportedPlaylists,
    removeImportedPlaylist,
    subscribeImportedPlaylists,
} from './store';
export { BUILTIN_PROVIDER_ID, PLATFORM_LABEL, decodeBuiltinId } from './model';
export { isBuiltinSong } from './provider';
export type { ImportedPlaylist } from './lxmc';

/** Registers 内置音源. Idempotent: the registry is a map and the same object is written again. */
export const installBuiltinProvider = (): void => {
    registerOnlineMusicProvider(builtinProvider);
};

const readFile = (file: File): Promise<Uint8Array> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
});

/** The bytes of a file the listener chose, for callers that have to look at them first. */
export const readPlaylistBytes = readFile;

export { looksLikeLxPlaylist };

/** What the listener was told when the file turns out not to be one of LX's exports. */
export const NOT_LX_PLAYLIST = '这不是落雪（LX Music）导出的歌单文件，请选择 .lxmc 或它导出的 .json。';

/**
 * Imports one chosen file. The contents decide, not the name: a file that is neither gzip nor a
 * `playList` JSON is refused here with a sentence that says so, rather than failing later inside
 * JSON.parse with "Unexpected token #".
 */
export const importPlaylistFromFile = async (file: File): Promise<ImportOutcome> => {
    const bytes = await readFile(file);
    if (!looksLikeLxPlaylist(bytes)) throw new Error(NOT_LX_PLAYLIST);
    return importPlaylistFile(bytes);
};

export type ImportPickResult =
    | { status: 'imported'; outcome: ImportOutcome }
    | { status: 'canceled' }
    | { status: 'failed'; message: string };

/** Opens the system picker and imports what was chosen. */
export const pickAndImportPlaylist = (): Promise<ImportPickResult> => new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    // Deliberately no `accept`: `.lxmc` is not a registered type anywhere, and a filter that only
    // names it hides the file on some pickers (and on Android, which matches by MIME). The contents
    // are checked after the choice instead, which is the only check that can be trusted anyway.
    input.style.position = 'fixed';
    input.style.left = '-9999px';

    let settled = false;
    const done = (value: ImportPickResult) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(value);
    };

    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) {
            done({ status: 'canceled' });
            return;
        }
        importPlaylistFromFile(file).then(
            outcome => done({ status: 'imported', outcome }),
            error => {
                console.warn('[Builtin] 导入歌单失败', error);
                done({ status: 'failed', message: String((error as Error)?.message || error) });
            },
        );
    });
    input.addEventListener('cancel', () => done({ status: 'canceled' }));

    document.body.appendChild(input);
    input.click();
});
