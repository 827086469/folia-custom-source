// src/extensions/customSource/bridge.ts
//
// One place that answers "is there a script host, and which one". The desktop build has the Electron
// main process; the Android shell has the WebView runtime that `./mobile` installs at start-up. The
// browser build has neither, and every caller treats that as "custom sources do not exist here"
// rather than as an error - which is what makes the settings page disappear instead of failing.

import type { CustomSourceBridge } from './types';

let nativeHost: CustomSourceBridge | null = null;

/** Called once by `./mobile` when the app is running inside the Android shell. */
export const setCustomSourceBridge = (bridge: CustomSourceBridge | null): void => {
    nativeHost = bridge;
};

export const getCustomSourceBridge = (): CustomSourceBridge | null => {
    if (nativeHost) return nativeHost;
    if (typeof window === 'undefined') return null;
    return (window.electron?.customSource as CustomSourceBridge | undefined) ?? null;
};

/** Whether this build can run custom source scripts at all. */
export const hasCustomSourceHost = (): boolean => getCustomSourceBridge() !== null;
