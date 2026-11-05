// src/extensions/customSource/lx/scriptHost.ts
//
// The LX Music "custom source" host, ported from the desktop implementation in
// `custom-source/lxHost.cjs` so the same scripts run inside the Android shell. The rules are that
// file's rules: a script answers exactly one question ("what is the playable URL of this song"), it
// is trusted code with a real network stack, and a script that fails never costs the song - the next
// one is asked, and the provider itself answers last.
//
// What changed for the WebView is only the three things a browser cannot do as a main process can,
// and each is injected rather than assumed:
//
//   * `vm` is unavailable, so a script is compiled with `new Function` and given the globals it
//     expects as parameters. Parameters are also why `'use strict'` at the top of a script is fine:
//     the `with (sandbox)` trick that is usually used for this is a syntax error in strict code.
//   * `node:fs` is unavailable, so listings and file contents come from a `LxScriptStore`.
//   * `node:http` is unavailable and the page's own `fetch` is bound by CORS, so requests go through
//     an injected `LxRequest` that runs on the native stack.
//
// crypto and zlib are real ports rather than injections - see `./crypto.ts`.

import { Buffer } from 'buffer';
import { aesEncrypt, md5, randomBytes, rsaEncrypt, sha1, sha256, zlib } from './crypto';

export const SOURCE_LABELS: Record<string, string> = {
    kw: '酷我音乐',
    kg: '酷狗音乐',
    tx: 'QQ音乐',
    wy: '网易云音乐',
    mg: '咪咕音乐',
    local: '本地音乐',
};

/** Lowest first. A script lists what it can serve; the closest level at or below is asked for. */
const QUALITY_LADDER = ['128k', '320k', 'flac', 'flac24bit'];

const FOLIA_TO_LX_QUALITY: Record<string, string> = {
    standard: '128k',
    high: '320k',
    ultra: '320k',
    lossless: 'flac',
    hires: 'flac24bit',
};

const LX_TO_FOLIA_QUALITY: Record<string, string> = {
    '128k': 'standard',
    '320k': 'high',
    flac: 'lossless',
    flac24bit: 'hires',
};

/** One script's answer window. */
const RESOLVE_TIMEOUT_MS = 12_000;
/**
 * Total time the fallback chain may take. Without it a phone with a dozen installed scripts and a
 * dead server would leave the play button spinning for minutes, each candidate waiting its own
 * timeout in turn.
 */
const RESOLVE_BUDGET_MS = 25_000;
/** How long a script may take to send `inited` - real ones ask a server for their source list first. */
const INIT_TIMEOUT_MS = 8_000;

export const LOG_PREFIX = '[CustomSource]';

const LOGGER_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

export interface LxLogger {
    log: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
}

export interface LxRequestOptions {
    method?: string;
    headers?: Record<string, string | number | undefined | null>;
    body?: unknown;
    form?: Record<string, unknown>;
    timeout?: number;
}

export interface LxResponse {
    statusCode: number;
    statusMessage?: string;
    headers: Record<string, string>;
    bytes: number;
    raw: Uint8Array;
    body: unknown;
}

export type LxRequestCallback = (error: unknown, response?: LxResponse, body?: unknown) => void;

/** `lx.request` as a script sees it: returns a cancel function. */
export type LxRequest = (url: string, options: LxRequestOptions, callback: LxRequestCallback) => () => void;

export interface LxScriptStore {
    /** Where the scripts live, printed in the settings page. */
    readonly dirLabel: string;
    /** Bare file names, sorted by the caller. */
    listFiles(): Promise<string[]>;
    readFile(name: string): Promise<string>;
    writeFile(name: string, text: string): Promise<void>;
    removeFile(name: string): Promise<void>;
    readDisabled(): Promise<string[]>;
    writeDisabled(disabled: string[]): Promise<void>;
}

export interface LxSourceDescriptor {
    name: string;
    actions: string[];
    qualitys: string[];
}

interface LxScriptMeta {
    name: string;
    description: string;
    version: string;
    author: string;
    homepage: string;
}

export interface LxScriptRecord {
    file: string;
    meta: LxScriptMeta;
    sources: Record<string, LxSourceDescriptor>;
    handler: ((info: { type: string; musicInfo: Record<string, string | number> }) => unknown) | null;
    error: string | null;
    inited: boolean;
    settled: boolean;
    ready: Promise<void>;
    enabled: boolean;
}

export interface LxPublicScript {
    file: string;
    name: string;
    description: string;
    version: string;
    author: string;
    homepage: string;
    enabled: boolean;
    error: string | null;
    sources: Record<string, LxSourceDescriptor>;
}

export interface LxListData {
    dir: string;
    loadedAt: number;
    loading?: boolean;
    scripts: LxPublicScript[];
}

const readMetaField = (code: string, field: string): string => {
    const match = new RegExp(`@${field}[ \\t]+([^\\r\\n]+)`).exec(code);
    return match ? match[1].trim() : '';
};

const parseMeta = (code: string): LxScriptMeta => ({
    name: readMetaField(code, 'name'),
    description: readMetaField(code, 'description'),
    version: readMetaField(code, 'version'),
    author: readMetaField(code, 'author'),
    homepage: readMetaField(code, 'homepage'),
});

const normalizeQualityList = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item).trim()).filter(item => QUALITY_LADDER.includes(item));
};

/** The quality to ask a script for: the wanted one, else the closest below it, else the highest it has. */
const pickQuality = (available: string[], requested: string): string => {
    const wanted = FOLIA_TO_LX_QUALITY[String(requested)] || '320k';
    const list = available.length ? available : QUALITY_LADDER;
    if (list.includes(wanted)) return wanted;
    const wantedIndex = QUALITY_LADDER.indexOf(wanted);
    for (let index = wantedIndex - 1; index >= 0; index -= 1) {
        if (list.includes(QUALITY_LADDER[index])) return QUALITY_LADDER[index];
    }
    return list[list.length - 1] || wanted;
};

const normalizeSources = (raw: unknown): Record<string, LxSourceDescriptor> => {
    if (!raw || typeof raw !== 'object') return {};
    const sources: Record<string, LxSourceDescriptor> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!Object.prototype.hasOwnProperty.call(SOURCE_LABELS, key)) continue;
        const descriptor = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const actions = Array.isArray(descriptor.actions) ? descriptor.actions.map(String) : ['musicUrl'];
        sources[key] = {
            name: typeof descriptor.name === 'string' ? descriptor.name : SOURCE_LABELS[key],
            actions,
            qualitys: normalizeQualityList(descriptor.qualitys),
        };
    }
    return sources;
};

/**
 * Errors thrown by different realms and by nothing at all are common here - a script may reject with
 * `{}` or a bare string. Read the shape instead of trusting the prototype.
 */
export const describeError = (error: unknown): string => {
    if (!error) return '未知错误';
    if (typeof error === 'string') return error;
    if (typeof error === 'object') {
        const candidate = error as { message?: unknown; stack?: unknown };
        if (typeof candidate.message === 'string' && candidate.message.trim()) return candidate.message.trim();
        try {
            const text = JSON.stringify(error);
            if (text && text !== '{}') return text;
        } catch {
            // circular or unserialisable - fall through to the stack
        }
        if (typeof candidate.stack === 'string' && candidate.stack.trim()) return candidate.stack.trim().split('\n')[0];
        try {
            const text = String(error);
            if (text && text !== '[object Object]') return text;
        } catch {
            // give up below
        }
        return '未知错误（脚本抛出了无法读取的对象）';
    }
    return String(error);
};

/**
 * The console a script sees. Scripts are written against a browser console, so `group`, `table` and
 * friends must exist or a working source dies on its first log line.
 */
const createScopedConsole = (name: string): Console => {
    const scope = `${LOG_PREFIX}[${name || '未命名'}]`;
    const forward = (level: (typeof LOGGER_METHODS)[number]) => (...args: unknown[]) => {
        console[level](scope, ...args);
    };
    return {
        log: forward('log'),
        info: forward('info'),
        warn: forward('warn'),
        error: forward('error'),
        debug: forward('debug'),
        trace: forward('log'),
        dir: forward('log'),
        table: forward('log'),
        group: forward('log'),
        groupCollapsed: forward('log'),
        groupEnd: () => undefined,
        count: () => undefined,
        countReset: () => undefined,
        time: () => undefined,
        timeEnd: () => undefined,
        assert: (condition?: boolean, ...args: unknown[]) => {
            if (!condition) console.warn(scope, ...args);
        },
    } as unknown as Console;
};

/**
 * The object a script reaches as `globalThis` / `window` / `self`. It inherits from the real global so
 * `fetch`, `TextEncoder`, `document` and everything else is still there, and carries our own `lx` and
 * `Buffer` as own properties so the script cannot replace them for the whole page.
 */
const createSandboxGlobal = (api: unknown, scopedConsole: Console): Record<string, unknown> => {
    const sandbox = Object.create(typeof globalThis === 'object' ? globalThis : null) as Record<string, unknown>;
    sandbox.lx = api;
    sandbox.console = scopedConsole;
    sandbox.Buffer = Buffer;
    // Bound to the real global: called as `sandbox.setTimeout(...)` an unbound copy would throw
    // "Illegal invocation" in a WebView, and several scripts do write `window.setTimeout`.
    for (const key of [
        'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
        'fetch', 'atob', 'btoa', 'requestAnimationFrame', 'cancelAnimationFrame',
        'queueMicrotask', 'structuredClone',
    ]) {
        const value = (globalThis as unknown as Record<string, unknown>)[key];
        if (typeof value === 'function') sandbox[key] = (value as (...args: unknown[]) => unknown).bind(globalThis);
    }
    // Identity properties must be defined directly on the sandbox: a plain assignment walks the
    // prototype chain, and on a real `window` (the sandbox's prototype) `window`/`globalThis`/`self`
    // are getter-only own accessors - strict-mode assignment then throws
    // "Cannot set property window of #<Window> which has only a getter" (Android WebView).
    const defineIdentity = (key: string, value: unknown) => {
        Object.defineProperty(sandbox, key, { value, writable: true, enumerable: true, configurable: true });
    };
    defineIdentity('globalThis', sandbox);
    defineIdentity('window', sandbox);
    defineIdentity('self', sandbox);
    defineIdentity('global', sandbox);
    return sandbox;
};

const createLxApi = (
    record: LxScriptRecord,
    request: LxRequest,
    settle: () => void,
) => {
    const EVENT_NAMES = { inited: 'inited', request: 'request', updateAlert: 'updateAlert' };

    return {
        // What a script may branch on. 2.x is the shape this host implements.
        version: '2.0.0',
        env: 'mobile',
        currentScriptInfo: { ...record.meta },
        EVENT_NAMES,
        on(eventName: string, handler: unknown) {
            if (eventName === EVENT_NAMES.request && typeof handler === 'function') {
                record.handler = handler as LxScriptRecord['handler'];
                return;
            }
            if (eventName === EVENT_NAMES.request) {
                record.error = record.error || 'request 事件的处理器不是函数';
            }
        },
        send(eventName: string, payload: unknown) {
            if (eventName !== EVENT_NAMES.inited) {
                // updateAlert and anything newer: acknowledged, then ignored.
                return;
            }
            record.inited = true;
            record.sources = normalizeSources((payload as { sources?: unknown } | null)?.sources);
            settle();
        },
        request,
        utils: {
            buffer: {
                from: (...args: unknown[]) => (Buffer.from as (...inner: unknown[]) => Buffer)(...args),
                bufToString: (buffer: unknown, format = 'utf8') => (
                    Buffer.from(buffer as Uint8Array).toString(format as BufferEncoding)
                ),
            },
            crypto: {
                // Same signatures as LX: scripts hand over Buffers, not hex strings.
                aesEncrypt,
                rsaEncrypt,
                md5,
                sha1,
                sha256,
                randomBytes,
            },
            zlib,
        },
    };
};

/**
 * Compiles one script and returns what it declared. Nothing here throws: a broken script becomes a
 * record with `error` set, listed in the settings page so the user can see why nothing plays.
 *
 * `inited` is not synchronous in real scripts - they fetch a source list from a registry first and
 * only then announce themselves. So the record carries a `ready` promise that settles either when
 * the script sends `inited` or after INIT_TIMEOUT_MS.
 */
const evaluateScript = (
    file: string,
    code: string,
    request: LxRequest,
    logger: LxLogger,
): LxScriptRecord => {
    const meta = parseMeta(code);
    let settleReady: () => void = () => undefined;
    const ready = new Promise<void>(resolve => {
        settleReady = resolve;
    });
    const record: LxScriptRecord = {
        file,
        meta,
        sources: {},
        handler: null,
        error: null,
        inited: false,
        settled: false,
        ready,
        enabled: true,
    };

    let initTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
        if (record.settled) return;
        record.settled = true;
        if (initTimer) clearTimeout(initTimer);
        settleReady();
    };

    const api = createLxApi(record, request, settle);
    const sandbox = createSandboxGlobal(api, createScopedConsole(meta.name || file));

    try {
        // Parameters rather than `with`: they shadow the real globals inside the function body, and
        // unlike `with` they are legal in a strict-mode script.
        const factory = new Function(
            'lx', 'globalThis', 'window', 'self', 'global', 'console', 'Buffer',
            `'use strict';\n${code}`,
        );
        factory(api, sandbox, sandbox, sandbox, sandbox, sandbox.console, Buffer);
    } catch (error) {
        record.error = `脚本执行失败：${describeError(error)}`;
        logger.warn(LOG_PREFIX, record.error, file);
    }

    if (record.error || record.inited) {
        settle();
    } else {
        initTimer = setTimeout(settle, INIT_TIMEOUT_MS);
    }

    return record;
};

/** Turns `inited`-less records into readable errors once their start-up window has passed. */
const finalizeRecords = (records: LxScriptRecord[]): void => {
    for (const record of records) {
        if (record.error) continue;
        if (!record.handler) record.error = '脚本没有注册 request 事件';
        else if (!record.inited) record.error = `脚本在 ${INIT_TIMEOUT_MS / 1000}s 内没有发送 inited 事件`;
    }
};

const toPublicScript = (record: LxScriptRecord): LxPublicScript => ({
    file: record.file,
    name: record.meta.name || record.file,
    description: record.meta.description,
    version: record.meta.version,
    author: record.meta.author,
    homepage: record.meta.homepage,
    enabled: record.enabled,
    error: record.error,
    sources: record.sources,
});

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
    );
});

export interface LxHostOptions {
    store: LxScriptStore;
    request: LxRequest;
    /** Notified with each answering URL, for hosts that must allow the media host afterwards. */
    onAudioSource?: (url: string) => void;
    logger?: LxLogger;
}

export interface LxResolveResult {
    ok: boolean;
    url?: string;
    quality?: string;
    script?: string;
    error?: { code: string; message: string };
}

export const createLxHost = ({ store, request, onAudioSource = () => undefined, logger = console }: LxHostOptions) => {
    const scripts: LxScriptRecord[] = [];
    let disabled: string[] = [];
    let loadedAt = 0;
    /** The in-flight (or last) load. `resolveUrl` awaits it, so a call right after start-up works. */
    let loading: Promise<LxListData> | null = null;

    const list = (): LxListData => ({
        dir: store.dirLabel,
        loadedAt,
        loading: scripts.some(item => !item.settled),
        scripts: scripts.map(toPublicScript),
    });

    const load = async (): Promise<LxListData> => {
        disabled = await store.readDisabled();
        scripts.length = 0;

        let files: string[] = [];
        try {
            files = (await store.listFiles()).filter(name => name.toLowerCase().endsWith('.js')).sort();
        } catch (error) {
            logger.warn(LOG_PREFIX, '读取音源目录失败', error);
        }

        const pending: Promise<void>[] = [];
        for (const name of files) {
            let code = '';
            try {
                code = await store.readFile(name);
            } catch (error) {
                scripts.push({
                    file: name,
                    meta: { name, description: '', version: '', author: '', homepage: '' },
                    sources: {},
                    handler: null,
                    error: `读取失败：${describeError(error)}`,
                    inited: false,
                    settled: true,
                    ready: Promise.resolve(),
                    enabled: false,
                });
                continue;
            }
            const record = evaluateScript(name, code, request, logger);
            record.enabled = !disabled.includes(name);
            scripts.push(record);
            pending.push(record.ready);
        }

        // Real scripts report their sources over the network, so this can take a second or two.
        if (pending.length) await Promise.all(pending);
        finalizeRecords(scripts);

        loadedAt = Date.now();
        logger.log(
            LOG_PREFIX,
            `已加载 ${scripts.length} 个音源脚本（可用 ${scripts.filter(item => item.enabled && !item.error).length} 个）`,
            store.dirLabel,
        );
        return list();
    };

    const reload = (): Promise<LxListData> => {
        loading = load();
        return loading;
    };

    const whenLoaded = (): Promise<LxListData> => loading || reload();

    const setEnabled = async (file: string, enabled: boolean): Promise<LxListData> => {
        const record = scripts.find(item => item.file === file);
        if (!record) return list();
        record.enabled = Boolean(enabled);
        const next = new Set(disabled);
        if (record.enabled) next.delete(file);
        else next.add(file);
        disabled = Array.from(next);
        await store.writeDisabled(disabled);
        return list();
    };

    const pickScripts = (source: string): LxScriptRecord[] => {
        const candidates: LxScriptRecord[] = [];
        for (const record of scripts) {
            if (!record.enabled || record.error || !record.handler) continue;
            const descriptor = record.sources[source];
            if (!descriptor) continue;
            if (Array.isArray(descriptor.actions) && !descriptor.actions.includes('musicUrl')) continue;
            candidates.push(record);
        }
        return candidates;
    };

    /**
     * Asks the enabled scripts that claim `source` for a playable URL, in load order, until one
     * answers. Community scripts die often and a phone usually has several installed, so trying the
     * next one is worth far more than failing on the first.
     */
    const resolveUrl = async ({
        source,
        musicInfo,
        quality,
    }: {
        source: string;
        musicInfo: Record<string, string | number>;
        quality: string;
    }): Promise<LxResolveResult> => {
        // The first call can land before the scripts have finished announcing themselves.
        if (!scripts.length || scripts.some(item => !item.settled)) await whenLoaded();
        const candidates = pickScripts(source);
        if (!candidates.length) {
            return { ok: false, error: { code: 'no-source', message: `没有启用的自定义源支持 ${source}` } };
        }

        const failures: string[] = [];
        const deadline = Date.now() + RESOLVE_BUDGET_MS;
        for (const record of candidates) {
            const remaining = deadline - Date.now();
            if (remaining <= 1500) {
                failures.push('其余音源因总时长超限未尝试');
                break;
            }
            const descriptor = record.sources[source] || { qualitys: [] as string[] };
            const lxQuality = pickQuality(descriptor.qualitys || [], quality);
            try {
                const url = await withTimeout(
                    Promise.resolve().then(() => record.handler?.({ type: lxQuality, musicInfo })),
                    Math.min(RESOLVE_TIMEOUT_MS, remaining),
                    `音源 ${record.file} 超时未返回地址`,
                );
                if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
                    failures.push(`${record.file}：返回的不是 http(s) 地址`);
                    continue;
                }
                const resolved = url.trim();
                onAudioSource(resolved);
                return {
                    ok: true,
                    url: resolved,
                    quality: LX_TO_FOLIA_QUALITY[lxQuality] || quality,
                    script: record.file,
                };
            } catch (error) {
                const message = describeError(error);
                failures.push(`${record.file}：${message}`);
                logger.warn(LOG_PREFIX, `音源 ${record.file} 取址失败：`, message);
            }
        }

        return {
            ok: false,
            error: { code: 'resolve-failed', message: failures.join('；') || '所有音源都没有返回地址' },
        };
    };

    void reload();

    return { list, reload, whenLoaded, setEnabled, resolveUrl, dirLabel: store.dirLabel };
};

export type LxHost = ReturnType<typeof createLxHost>;
