// src/extensions/customSource/mobile/store.ts
//
// Where the scripts live on a phone, and the only place that touches the filesystem. The desktop host
// uses `<userData>/custom-sources`; here it is the app's private data directory, which needs no
// permission prompt and is removed with the app. The settings page prints `dirLabel`, so the path is
// there for anyone who wants to push a script over `adb` instead of tapping 从文件安装.

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { LxScriptStore } from '../lx/scriptHost';

const ROOT = 'custom-sources';
const CONFIG_PATH = `${ROOT}/config.json`;

const isMissing = (error: unknown): boolean => {
    const message = String((error as { message?: unknown })?.message ?? error ?? '');
    return /does not exist|ENOENT|not found/i.test(message);
};

export const createMobileScriptStore = (): LxScriptStore => {
    const filePath = (name: string) => `${ROOT}/${name}`;

    return {
        dirLabel: `应用数据/custom-sources（${ROOT}）`,

        async listFiles() {
            try {
                const result = await Filesystem.readdir({ path: ROOT, directory: Directory.Data });
                return result.files.map(entry => entry.name);
            } catch (error) {
                if (isMissing(error)) {
                    // First run: nothing installed yet. Creating it now means the settings page's
                    // 打开目录 note and the next install both have somewhere to go.
                    try {
                        await Filesystem.mkdir({ path: ROOT, directory: Directory.Data, recursive: true });
                    } catch {
                        // Already there, or unavailable until the first write; either way harmless.
                    }
                    return [];
                }
                throw error;
            }
        },

        async readFile(name) {
            const result = await Filesystem.readFile({
                path: filePath(name),
                directory: Directory.Data,
                encoding: Encoding.UTF8,
            });
            return typeof result.data === 'string' ? result.data : await result.data.text();
        },

        async writeFile(name, text) {
            await Filesystem.writeFile({
                path: filePath(name),
                data: text,
                directory: Directory.Data,
                encoding: Encoding.UTF8,
                recursive: true,
            });
        },

        async removeFile(name) {
            await Filesystem.deleteFile({ path: filePath(name), directory: Directory.Data });
        },

        async readDisabled() {
            try {
                const result = await Filesystem.readFile({
                    path: CONFIG_PATH,
                    directory: Directory.Data,
                    encoding: Encoding.UTF8,
                });
                const text = typeof result.data === 'string' ? result.data : await result.data.text();
                const parsed = JSON.parse(text) as { disabled?: unknown };
                return Array.isArray(parsed?.disabled) ? parsed.disabled.map(String) : [];
            } catch {
                return [];
            }
        },

        async writeDisabled(disabled) {
            try {
                await Filesystem.writeFile({
                    path: CONFIG_PATH,
                    data: `${JSON.stringify({ disabled }, null, 2)}\n`,
                    directory: Directory.Data,
                    encoding: Encoding.UTF8,
                    recursive: true,
                });
            } catch (error) {
                console.warn('[CustomSource] 写入配置失败', error);
            }
        },
    };
};
