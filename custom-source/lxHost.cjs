// custom-source/lxHost.cjs
//
// Runs LX Music style "custom source" scripts for the renderer's online providers, so a script
// written for that player can supply the playable address Folia's own providers could not get.
//
// Division of labour, and why it is this small: in LX a custom source does not search, does not
// hold an account and does not list anything - the player's built-in code does all of that, and the
// script is asked one question only, "give me the audio URL for this song". That is exactly the one
// thing Folia cannot do on its own for a restricted track, which is why this host implements the
// `musicUrl` action and nothing else. Search, lists and metadata stay with Folia's providers.
//
// A script is a plain JS module evaluated in a `vm` context. Like Folium mods, a source script is
// trusted code, not a sandbox escape problem: it is given a network stack because that is its whole
// job. What it is NOT given is `require`, `process`, or a filesystem.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const nodeZlib = require('node:zlib');

const { createLxRequest } = require('./http.cjs');

const SOURCE_LABELS = {
  kw: '酷我音乐',
  kg: '酷狗音乐',
  tx: 'QQ音乐',
  wy: '网易云音乐',
  mg: '咪咕音乐',
  local: '本地音乐',
};

// Lowest first. A script lists what it can serve; the app asks for the level it wants and takes
// the closest one at or below rather than failing outright.
const QUALITY_LADDER = ['128k', '320k', 'flac', 'flac24bit'];
const FOLIA_TO_LX_QUALITY = {
  standard: '128k',
  high: '320k',
  ultra: '320k',
  lossless: 'flac',
  hires: 'flac24bit',
};
const LX_TO_FOLIA_QUALITY = {
  '128k': 'standard',
  '320k': 'high',
  flac: 'lossless',
  flac24bit: 'hires',
};

const SCRIPT_EVAL_TIMEOUT_MS = 10_000;
/** One script's answer window. */
const RESOLVE_TIMEOUT_MS = 12_000;
/**
 * Total time the fallback chain may take. Without it, a machine with a dozen installed scripts and
 * a dead server would leave the play button spinning for minutes - each candidate gets its own
 * timeout otherwise.
 */
const RESOLVE_BUDGET_MS = 25_000;
/** How long a script may take to send `inited` - real ones ask a server for their source list first. */
const INIT_TIMEOUT_MS = 8_000;
const CONFIG_FILE = 'config.json';

const LOG_PREFIX = '[CustomSource]';

const readMetaField = (code, field) => {
  const match = new RegExp(`@${field}[ \\t]+([^\\r\\n]+)`).exec(code);
  return match ? match[1].trim() : '';
};

const parseMeta = code => ({
  name: readMetaField(code, 'name'),
  description: readMetaField(code, 'description'),
  version: readMetaField(code, 'version'),
  author: readMetaField(code, 'author'),
  homepage: readMetaField(code, 'homepage'),
});

const normalizeQualityList = value => {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item).trim()).filter(item => QUALITY_LADDER.includes(item));
};

/** The quality to ask a script for: the wanted one, else the closest below it, else the highest it has. */
const pickQuality = (available, requested) => {
  const wanted = FOLIA_TO_LX_QUALITY[String(requested)] || '320k';
  const list = available.length ? available : QUALITY_LADDER;
  if (list.includes(wanted)) return wanted;
  const wantedIndex = QUALITY_LADDER.indexOf(wanted);
  for (let index = wantedIndex - 1; index >= 0; index -= 1) {
    if (list.includes(QUALITY_LADDER[index])) return QUALITY_LADDER[index];
  }
  return list[list.length - 1] || wanted;
};

const normalizeSources = raw => {
  if (!raw || typeof raw !== 'object') return {};
  const sources = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(SOURCE_LABELS, key)) continue;
    const descriptor = value && typeof value === 'object' ? value : {};
    const actions = Array.isArray(descriptor.actions) ? descriptor.actions.map(String) : ['musicUrl'];
    sources[key] = {
      name: typeof descriptor.name === 'string' ? descriptor.name : SOURCE_LABELS[key],
      actions,
      qualitys: normalizeQualityList(descriptor.qualitys),
    };
  }
  return sources;
};

const withTimeout = (promise, timeoutMs, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  Promise.resolve(promise).then(
    value => { clearTimeout(timer); resolve(value); },
    error => { clearTimeout(timer); reject(error); },
  );
});

const describeError = error => {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  // Errors thrown inside a `vm` context belong to another realm, so `instanceof Error` is false and
  // JSON.stringify of one is usually `{}`. Read the shape instead of trusting the prototype.
  if (typeof error === 'object') {
    if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    try {
      const text = JSON.stringify(error);
      if (text && text !== '{}') return text;
    } catch {
      // circular or unserialisable - fall through to the stack
    }
    if (typeof error.stack === 'string' && error.stack.trim()) return error.stack.trim().split('\n')[0];
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
 * The console a script sees. Scripts are written against a browser console, so `group`, `table`
 * and friends must exist or a working source dies on its first log line.
 */
const createScopedConsole = name => {
  const scope = `${LOG_PREFIX}[${name || '未命名'}]`;
  const forward = level => (...args) => console[level](scope, ...args);
  return {
    log: forward('log'),
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
    debug: forward('debug'),
    trace: forward('trace'),
    dir: forward('dir'),
    table: forward('table'),
    group: forward('log'),
    groupCollapsed: forward('log'),
    groupEnd: () => {},
    count: () => {},
    countReset: () => {},
    time: () => {},
    timeEnd: () => {},
    assert: (condition, ...args) => { if (!condition) console.warn(scope, ...args); },
  };
};

/**
 * Evaluates one script and returns what it declared. Nothing here throws: a broken script becomes a
 * record with `error` set, listed in the UI so the user can see why nothing plays.
 *
 * `inited` is NOT synchronous in real scripts - 野花 and friends fetch a config document from a
 * registry first and only then send their source list. So the record carries a `ready` promise that
 * settles either when the script sends `inited` or after INIT_TIMEOUT_MS. `reload` waits on it
 * before deciding a script failed.
 */
const evaluateScript = ({ file, code, request, logger }) => {
  const meta = parseMeta(code);
  const record = {
    file,
    meta,
    sources: {},
    handler: null,
    error: null,
    inited: false,
    settled: false,
    ready: null,
  };

  let settleReady = () => {};
  record.ready = new Promise(resolve => { settleReady = resolve; });
  const settle = () => {
    if (record.settled) return;
    record.settled = true;
    if (record.initTimer) clearTimeout(record.initTimer);
    settleReady();
  };

  const EVENT_NAMES = { inited: 'inited', request: 'request', updateAlert: 'updateAlert' };

  const api = {
    // What a script may branch on. 2.x is the shape this host implements.
    version: '2.0.0',
    env: 'desktop',
    currentScriptInfo: { ...meta, rawScript: code },
    EVENT_NAMES,
    on(eventName, handler) {
      if (eventName === EVENT_NAMES.request && typeof handler === 'function') {
        record.handler = handler;
        return;
      }
      if (eventName === EVENT_NAMES.request) {
        record.error = record.error || 'request 事件的处理器不是函数';
      }
    },
    send(eventName, payload) {
      if (eventName !== EVENT_NAMES.inited) {
        // updateAlert and anything newer: acknowledged, then ignored - Folia has no source-update
        // dialog of its own yet.
        return;
      }
      record.inited = true;
      record.sources = normalizeSources(payload && payload.sources);
      settle();
    },
    request,
    utils: {
      buffer: {
        from: (...args) => Buffer.from(...args),
        bufToString: (buffer, format = 'utf8') => Buffer.from(buffer).toString(format),
      },
      crypto: {
        // Same signatures as LX: scripts hand over Buffers, not hex strings.
        aesEncrypt(buffer, mode, key, iv) {
          const cipher = nodeCrypto.createCipheriv(mode, key, iv);
          return Buffer.concat([cipher.update(buffer), cipher.final()]);
        },
        rsaEncrypt(buffer, key) {
          const padded = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
          return nodeCrypto.publicEncrypt({ key, padding: nodeCrypto.constants.RSA_NO_PADDING }, padded);
        },
        md5: value => nodeCrypto.createHash('md5').update(value).digest('hex'),
        sha1: value => nodeCrypto.createHash('sha1').update(value).digest('hex'),
        sha256: value => nodeCrypto.createHash('sha256').update(value).digest('hex'),
        randomBytes: size => nodeCrypto.randomBytes(size),
      },
      zlib: {
        inflate: buffer => new Promise((resolve, reject) => {
          nodeZlib.inflate(buffer, (error, data) => (error ? reject(new Error(error.message)) : resolve(data)));
        }),
        deflate: data => new Promise((resolve, reject) => {
          nodeZlib.deflate(data, (error, buffer) => (error ? reject(new Error(error.message)) : resolve(buffer)));
        }),
      },
    },
  };

  const sandbox = {
    console: createScopedConsole(meta.name || file),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    lx: api,
  };
  // Older scripts read `window.lx`; the documented form is `globalThis.lx`. Both point at `lx`.
  sandbox.window = sandbox;

  try {
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: file, timeout: SCRIPT_EVAL_TIMEOUT_MS });
  } catch (error) {
    record.error = `脚本执行失败：${describeError(error)}`;
    logger.warn(LOG_PREFIX, record.error, file);
  }

  if (record.error || record.inited) {
    settle();
  } else {
    // Let the script do its async start-up. An unref'd timer so a script that never finishes
    // initialising cannot hold the host process open.
    record.initTimer = setTimeout(settle, INIT_TIMEOUT_MS);
    if (typeof record.initTimer.unref === 'function') record.initTimer.unref();
  }

  return record;
};

/** Turns `inited`-less records into readable errors once their start-up window has passed. */
const finalizeRecords = records => {
  for (const record of records) {
    if (record.error) continue;
    if (!record.handler) record.error = '脚本没有注册 request 事件';
    else if (!record.inited) record.error = `脚本在 ${INIT_TIMEOUT_MS / 1000}s 内没有发送 inited 事件`;
  }
};

const readConfig = dir => {
  try {
    const raw = fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      disabled: Array.isArray(parsed?.disabled) ? parsed.disabled.map(String) : [],
    };
  } catch {
    return { disabled: [] };
  }
};

const writeConfig = (dir, config) => {
  try {
    fs.writeFileSync(path.join(dir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn(LOG_PREFIX, '写入配置失败', error);
  }
};

const toPublicScript = record => ({
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

const createCustomSourceHost = ({ dir, onAudioSource = () => {}, logger = console } = {}) => {
  const request = createLxRequest({ logger });
  const scripts = [];
  let config = { disabled: [] };
  let loadedAt = 0;
  /** The in-flight (or last) load. `resolveUrl` awaits it so a call right after start-up still works. */
  let loading = null;

  const ensureDir = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      logger.warn(LOG_PREFIX, '创建音源目录失败', error);
    }
  };

  const load = async () => {
    ensureDir();
    config = readConfig(dir);
    scripts.length = 0;

    let files = [];
    try {
      files = fs.readdirSync(dir).filter(name => name.toLowerCase().endsWith('.js')).sort();
    } catch (error) {
      logger.warn(LOG_PREFIX, '读取音源目录失败', error);
    }

    const pending = [];
    for (const name of files) {
      let code = '';
      try {
        code = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch (error) {
        scripts.push({
          file: name,
          meta: { name },
          sources: {},
          handler: null,
          error: `读取失败：${describeError(error)}`,
          enabled: false,
          settled: true,
          ready: Promise.resolve(),
        });
        continue;
      }
      const record = evaluateScript({ file: name, code, request, logger });
      record.enabled = !config.disabled.includes(name);
      scripts.push(record);
      pending.push(record.ready);
    }

    // Real scripts report their sources over the network, so this can take a second or two.
    if (pending.length) await Promise.all(pending);
    finalizeRecords(scripts);

    loadedAt = Date.now();
    logger.log(LOG_PREFIX, `已加载 ${scripts.length} 个音源脚本（可用 ${scripts.filter(item => item.enabled && !item.error).length} 个）`, dir);
    return list();
  };

  const reload = () => {
    loading = load();
    return loading;
  };

  const whenLoaded = () => (loading || reload());

  const list = () => ({
    dir,
    loadedAt,
    loading: scripts.length > 0 && scripts.some(item => !item.settled),
    scripts: scripts.map(toPublicScript),
  });

  const setEnabled = (file, enabled) => {
    const record = scripts.find(item => item.file === file);
    if (!record) return list();
    record.enabled = Boolean(enabled);
    const disabled = new Set(config.disabled);
    if (record.enabled) disabled.delete(file);
    else disabled.add(file);
    config = { ...config, disabled: Array.from(disabled) };
    writeConfig(dir, config);
    return list();
  };

  const pickScripts = source => {
    const candidates = [];
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
   * answers. Community scripts die often and a machine usually has several installed, so trying the
   * next one is worth far more than failing on the first.
   * `musicInfo` is built by the renderer in the shape LX scripts read (`songmid`, `hash`, ...).
   */
  const resolveUrl = async ({ source, musicInfo, quality }) => {
    // First call can land before the scripts have finished announcing themselves.
    if (!scripts.length || scripts.some(item => !item.settled)) await whenLoaded();
    const candidates = pickScripts(source);
    if (!candidates.length) {
      return { ok: false, error: { code: 'no-source', message: `没有启用的自定义源支持 ${source}` } };
    }

    const failures = [];
    const deadline = Date.now() + RESOLVE_BUDGET_MS;
    for (const record of candidates) {
      const remaining = deadline - Date.now();
      if (remaining <= 1500) {
        failures.push('其余音源因总时长超限未尝试');
        break;
      }
      const descriptor = record.sources[source] || { qualitys: [] };
      const lxQuality = pickQuality(descriptor.qualitys || [], quality);
      const info = { type: lxQuality, musicInfo };

      try {
        const url = await withTimeout(
          Promise.resolve().then(() => record.handler({ source, action: 'musicUrl', info })),
          Math.min(RESOLVE_TIMEOUT_MS, remaining),
          `音源 ${record.file} 超时未返回地址`,
        );
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
          failures.push(`${record.file}：返回的不是 http(s) 地址`);
          continue;
        }
        const resolved = url.trim();
        // The visualizer reads the audio through Web Audio, so the host this URL lives on needs CORS.
        onAudioSource(resolved);
        return { ok: true, url: resolved, quality: LX_TO_FOLIA_QUALITY[lxQuality] || quality, script: record.file };
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

  reload();

  return { list, reload, whenLoaded, setEnabled, resolveUrl, dir };
};

module.exports = { createCustomSourceHost, SOURCE_LABELS };
