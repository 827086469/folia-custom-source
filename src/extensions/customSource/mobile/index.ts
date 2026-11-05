// src/extensions/customSource/mobile/index.ts
//
// The Android shell's custom source host, assembled. It answers the same bridge the Electron main
// process answers (`electron/main.cjs`, the `custom-source-*` channels), so the settings page and the
// provider decoration are the same code on both builds.
//
// Two things differ on a phone and are worth knowing when reading the answers:
//   * 从文件安装 opens the system file picker (`<input type="file">`), which hands the page the file's
//     text directly. Nothing else on Android lets an app read an arbitrary .js without a storage
//     permission or a document-tree grant, and the picker needs neither.
//   * 打开目录 cannot do anything: the scripts live in the app's private data directory, which the
//     system file manager does not show. The answer says so instead of pretending.

import { Capacitor } from '@capacitor/core';
import { createLxHost, describeError, type LxHost } from '../lx/scriptHost';
import { setCustomSourceBridge } from '../bridge';
import type {
    CustomSourceBridge,
    CustomSourceInstallEnvelope,
    CustomSourceListEnvelope,
    CustomSourceResolveAnswer,
} from '../types';
import { createNativeLxRequest } from './http';
import { createMobileScriptStore } from './store';

/** A file name that cannot escape the sources directory or trip up Android's filesystem. */
const safeScriptFileName = (rawName: string, url: string): string => {
    let base = String(rawName || '').trim();
    if (!base) {
        try {
            base = new URL(String(url)).pathname.split('/').filter(Boolean).pop() || '';
        } catch {
            base = '';
        }
    }
    const cleaned = base
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/[\u0000-\u001f]/g, '')
        .replace(/^\.+/, '')
        .trim()
        .slice(0, 100) || 'custom-source';
    return cleaned.toLowerCase().endsWith('.js') ? cleaned : `${cleaned}.js`;
};

/**
 * Whether the bytes we just got are a custom source script rather than an HTML error page or a CDN
 * notice. Cheap on purpose: a real script always declares the LX API somewhere in its body.
 */
const looksLikeCustomSourceScript = (text: string): boolean => {
    const sample = String(text || '');
    if (sample.length < 200) return false;
    if (/^\s*<(!doctype|html)/i.test(sample)) return false;
    return /\blx\b/.test(sample) && (/EVENT_NAMES/.test(sample) || /\bsend\s*\(/.test(sample) || /\bon\s*\(/.test(sample));
};

const failure = (code: string, message: string) => ({ ok: false as const, error: { code, message } });

/** Downloads a script body. Goes through the native stack so a plain http host is not blocked. */
const downloadScript = async (url: string): Promise<string> => {
    const answer = await fetch(url, { redirect: 'follow' });
    if (!answer.ok) throw new Error(`下载失败：HTTP ${answer.status}`);
    return answer.text();
};

/** The system file picker, resolved to the chosen file's text. Null when it was dismissed. */
const pickScriptFile = (): Promise<{ name: string; text: string } | null> => new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    // `accept` is a hint: Android still lets the user pick anything, so the content is checked after.
    input.accept = '.js,text/javascript,application/javascript,text/plain';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    let settled = false;
    const done = (value: { name: string; text: string } | null) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(value);
    };
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) {
            done(null);
            return;
        }
        const reader = new FileReader();
        reader.onload = () => done({ name: file.name, text: String(reader.result ?? '') });
        reader.onerror = () => done(null);
        reader.readAsText(file);
    });
    // `cancel` is the modern event; a dismissed picker fires nothing on older WebViews, and a page
    // reload is the only way out of that - which is why the buttons are not disabled while it is open.
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
});

const createMobileBridge = (host: LxHost, store: ReturnType<typeof createMobileScriptStore>): CustomSourceBridge => {
    const listAnswer = async (): Promise<CustomSourceListEnvelope> => {
        try {
            // Only the very first call waits; later ones read the already-loaded list so the UI is snappy.
            if (!host.list().loadedAt) await host.whenLoaded();
            return { ok: true, data: host.list() };
        } catch (error) {
            console.warn('[CustomSource] 读取音源列表失败', error);
            return failure('failed', describeError(error));
        }
    };

    return {
        list: listAnswer,

        async reload() {
            try {
                return { ok: true, data: await host.reload() };
            } catch (error) {
                return failure('failed', describeError(error));
            }
        },

        async setEnabled(file, enabled) {
            try {
                return { ok: true, data: await host.setEnabled(String(file), Boolean(enabled)) };
            } catch (error) {
                return failure('failed', describeError(error));
            }
        },

        async installFromUrl(url, name) {
            const trimmed = String(url || '').trim();
            if (!/^https?:\/\//i.test(trimmed)) return failure('bad-url', '请填写以 http(s):// 开头的地址');
            try {
                const text = await downloadScript(trimmed);
                if (!looksLikeCustomSourceScript(text)) {
                    return failure('not-a-script', '下载到的内容不像音源脚本（可能是网页或错误页）');
                }
                const file = safeScriptFileName(name ?? '', trimmed);
                await store.writeFile(file, text);
                await host.reload();
                return { ok: true, data: { file, list: host.list() } } as CustomSourceInstallEnvelope;
            } catch (error) {
                console.warn('[CustomSource] 从 URL 安装失败', error);
                return failure('failed', describeError(error));
            }
        },

        async installFromFile() {
            try {
                const picked = await pickScriptFile();
                if (!picked) return { ok: true, data: { canceled: true, list: host.list() } };
                if (!looksLikeCustomSourceScript(picked.text)) {
                    return failure('not-a-script', '选中的文件不像音源脚本');
                }
                const file = safeScriptFileName(picked.name, '');
                await store.writeFile(file, picked.text);
                await host.reload();
                return { ok: true, data: { file, list: host.list() } } as CustomSourceInstallEnvelope;
            } catch (error) {
                console.warn('[CustomSource] 从文件安装失败', error);
                return failure('failed', describeError(error));
            }
        },

        async remove(file) {
            const name = String(file || '').trim();
            // Only a bare .js name inside the sources dir: no separators, no traversal.
            if (!name || name !== name.replace(/[\\/]/g, '') || !name.toLowerCase().endsWith('.js')) {
                return failure('bad-name', '文件名不合法');
            }
            try {
                await store.removeFile(name);
                await host.reload();
                return { ok: true, data: host.list() };
            } catch (error) {
                console.warn('[CustomSource] 删除失败', error);
                return failure('failed', describeError(error));
            }
        },

        async resolveUrl(request): Promise<CustomSourceResolveAnswer> {
            try {
                const payload = request && typeof request === 'object' ? request : { source: '', musicInfo: {}, quality: 'high' };
                return await host.resolveUrl({
                    source: String(payload.source || ''),
                    musicInfo: (payload.musicInfo && typeof payload.musicInfo === 'object'
                        ? payload.musicInfo
                        : {}) as Record<string, string | number>,
                    quality: String(payload.quality || 'high'),
                });
            } catch (error) {
                return failure('failed', describeError(error));
            }
        },

        async openFolder() {
            return failure('unsupported', '手机端音源存放在应用私有目录，文件管理器打不开；用「从文件安装」或「从 URL 安装」添加脚本');
        },
    };
};

/**
 * Installs the mobile host, once, and only where it belongs: inside the Android shell, and only when
 * the Electron bridge is not already there. Called before `installCustomSourceExtension`, which then
 * finds a bridge and decorates the providers exactly as it does on the desktop.
 */
export const installMobileCustomSourceBridge = async (): Promise<boolean> => {
    if (typeof window === 'undefined') return false;
    if (window.electron?.customSource) return false;
    if (!Capacitor.isNativePlatform()) return false;

    const store = createMobileScriptStore();
    const host = createLxHost({ store, request: createNativeLxRequest() });
    setCustomSourceBridge(createMobileBridge(host, store));
    console.log('[CustomSource] 已启用手机端音源宿主', store.dirLabel);
    return true;
};
