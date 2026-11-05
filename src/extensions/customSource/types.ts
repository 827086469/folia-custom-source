// src/extensions/customSource/types.ts
//
// The shape every custom source host answers in. Two hosts exist: the desktop one in the Electron
// main process (`electron/main.cjs` → `custom-source/lxHost.cjs`) and the mobile one that runs in
// the WebView (`./mobile`). They share this contract so the settings page and the provider
// decoration do not know which one they are talking to.

export interface CustomSourceError {
    code: string;
    message: string;
}

export interface CustomSourceEnvelope<T> {
    ok: boolean;
    data?: T;
    error?: CustomSourceError;
}

export type CustomSourceListEnvelope = CustomSourceEnvelope<CustomSourceListData>;

export interface CustomSourceInstallData {
    /** The name the script was stored under. Absent when the picker was dismissed. */
    file?: string;
    canceled?: boolean;
    list: CustomSourceListData;
}

export type CustomSourceInstallEnvelope = CustomSourceEnvelope<CustomSourceInstallData>;

export interface CustomSourceResolveAnswer {
    ok: boolean;
    url?: string;
    quality?: string;
    /** Which script answered - diagnostics only, the player does not read it. */
    script?: string;
    error?: CustomSourceError;
}

export interface CustomSourceResolveRequest {
    source: string;
    musicInfo: Record<string, unknown>;
    quality: string;
}

export interface CustomSourceBridge {
    list(): Promise<CustomSourceListEnvelope>;
    reload(): Promise<CustomSourceListEnvelope>;
    setEnabled(file: string, enabled: boolean): Promise<CustomSourceListEnvelope>;
    installFromUrl(url: string, name?: string): Promise<CustomSourceInstallEnvelope>;
    installFromFile(): Promise<CustomSourceInstallEnvelope>;
    remove(file: string): Promise<CustomSourceListEnvelope>;
    /** One question only: the playable URL of a song, from whichever script claims that source. */
    resolveUrl(request: CustomSourceResolveRequest): Promise<CustomSourceResolveAnswer>;
    /** Opens the folder the scripts live in. A phone has no such place, so it answers with a note. */
    openFolder(): Promise<CustomSourceEnvelope<undefined>>;
}
