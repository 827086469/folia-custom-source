import type { SongResult } from '../../types';
import type { AudioQualityPreference, OnlineMusicProvider, ProviderAudioSource } from '../../types/onlineMusic';
import { getOnlineMusicProvider, registerOnlineMusicProvider } from '../../services/onlineMusic/providerRegistry';
import { getCustomSourceBridge } from './bridge';

// src/extensions/customSource/index.ts
//
// LX style custom sources, wired into the three providers they can serve.
//
// A custom source does not search, does not hold an account and lists nothing: in LX its only job
// is to answer "what is the playable address of this song", which is exactly the step Folia's own
// providers fail at when a platform restricts a track. So this extension decorates `playback` and
// nothing else - search, lists, metadata and lyrics stay with the provider. When no script is
// enabled for a platform, or a script fails, the provider answers for itself and behaviour is
// exactly what it was before.
//
// The decoration happens on the registry entry because that is the one place every caller reads a
// provider from (`omni` asks the registry on every operation), so no call site changes.

/** The source key an LX script declares, per provider that can be served by one. */
const LX_SOURCE_BY_PROVIDER: Record<string, string> = {
    netease: 'wy',
    kugou: 'kg',
    qq: 'tx',
};

type LxMusicInfo = Record<string, string | number>;

/** The providers as they were before any script was installed, so the wrapping is reversible. */
const originals = new Map<string, OnlineMusicProvider>();
/** Providers currently answering with a script in front of them. */
const wrapped = new Set<string>();

/**
 * The song in the shape LX scripts read. A script picks the fields it knows (`songmid` for NetEase
 * and QQ, `hash` for Kugou); the rest are for scripts that log or match loosely.
 *
 * Returns null when the field that script family keys on is missing - asking a script with an
 * empty id would only produce a wrong song, not an error.
 */
const buildMusicInfo = (song: SongResult, providerId: string): LxMusicInfo | null => {
    const base: LxMusicInfo = {
        name: song.name,
        singer: (song.artists || []).map(artist => artist.name).filter(Boolean).join('、'),
        albumName: song.album?.name ?? '',
        interval: Math.max(0, Math.round((song.durationMs || 0) / 1000)),
    };

    if (providerId === 'netease') {
        return { ...base, songmid: String(song.id), id: String(song.id) };
    }
    if (providerId === 'kugou') {
        return song.kgHash ? { ...base, hash: song.kgHash } : null;
    }
    if (providerId === 'qq') {
        // QQ scripts read `songmid` and, for some qualities, `strMediaMid`; Folia keeps the one mid
        // it was given, so both fields carry it.
        return song.qqMid ? { ...base, songmid: song.qqMid, strMediaMid: song.qqMid, media_mid: song.qqMid } : null;
    }
    return null;
};

const askCustomSource = async (
    lxSource: string,
    musicInfo: LxMusicInfo,
    quality: AudioQualityPreference,
): Promise<ProviderAudioSource | null> => {
    const bridge = getCustomSourceBridge();
    if (!bridge) return null;

    const result = await bridge.resolveUrl({ source: lxSource, musicInfo, quality });
    if (!result?.ok || !result.url) return null;

    return {
        url: result.url,
        fetchedAt: Date.now(),
        quality: (result.quality as AudioQualityPreference) || quality,
    };
};

const withCustomSource = (provider: OnlineMusicProvider, lxSource: string): OnlineMusicProvider => {
    const playback = provider.playback;
    if (!playback) return provider;

    return {
        ...provider,
        playback: {
            ...playback,
            async getAudioSource(song, quality) {
                const musicInfo = buildMusicInfo(song, provider.id);
                if (musicInfo) {
                    try {
                        const resolved = await askCustomSource(lxSource, musicInfo, quality);
                        if (resolved) return resolved;
                    } catch (error) {
                        // A script that throws is not a reason to lose the song: the provider still
                        // answers for itself below.
                        console.warn('[CustomSource] 自定义源取址失败，回落到内置音源:', error);
                    }
                }
                return playback.getAudioSource(song, quality);
            },
        },
    };
};

/**
 * Wraps the providers that an enabled script claims, and unwraps the ones it no longer does.
 * Safe to call again after the user installs or disables a script.
 */
export const installCustomSourceExtension = async (): Promise<void> => {
    const bridge = getCustomSourceBridge();
    if (!bridge) return;

    let served = new Set<string>();
    try {
        const envelope = await bridge.list();
        for (const script of envelope?.data?.scripts || []) {
            if (!script.enabled || script.error) continue;
            for (const key of Object.keys(script.sources || {})) served.add(key);
        }
    } catch (error) {
        console.warn('[CustomSource] 读取自定义源失败:', error);
        served = new Set();
    }

    for (const [providerId, lxSource] of Object.entries(LX_SOURCE_BY_PROVIDER)) {
        if (!originals.has(providerId)) {
            const provider = getOnlineMusicProvider(providerId);
            if (!provider) continue;
            originals.set(providerId, provider);
        }
        const original = originals.get(providerId);
        if (!original) continue;

        const shouldWrap = served.has(lxSource) && Boolean(original.playback);
        if (shouldWrap === wrapped.has(providerId)) continue;

        if (shouldWrap) {
            registerOnlineMusicProvider(withCustomSource(original, lxSource));
            wrapped.add(providerId);
        } else {
            registerOnlineMusicProvider(original);
            wrapped.delete(providerId);
        }
    }
};

/** Whether a script stands in front of `providerId` right now (diagnostics and settings copy). */
export const isCustomSourceActive = (providerId: string): boolean => wrapped.has(providerId);
