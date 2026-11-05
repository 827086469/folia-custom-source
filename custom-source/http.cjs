// custom-source/http.cjs
//
// The `lx.request` a custom source script gets. Its whole point is that it runs in the main
// process, so the browser's cross-origin rules do not apply: a source script fetches whatever
// host its third-party API lives on, and the renderer never sees that host.
//
// The callback shape follows the documented custom source API: request(url, options, callback)
// with callback(err, resp, body), where resp carries statusCode, headers and body. Returned is the
// way to cancel the request.

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { URL } = require('node:url');

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const decodeBody = (buffer, contentEncoding) => {
  const encoding = String(contentEncoding || '').toLowerCase().trim();
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    // A body that fails to decode is handed over as it arrived rather than dropped: the script's
    // own parser is a better judge of what it can read than this layer is.
    return buffer;
  }
  return buffer;
};

const buildBody = (options, headers) => {
  if (options.form && typeof options.form === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.form)) params.append(key, String(value));
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    return params.toString();
  }
  const body = options.body;
  if (body == null) return null;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  if (!headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  return JSON.stringify(body);
};

const createLxRequest = ({ logger = console } = {}) => {
  return (url, options = {}, callback = () => {}) => {
    if (typeof callback !== 'function') return () => {};
    const requestOptions = options && typeof options === 'object' ? options : {};
    const timeoutMs = Number(requestOptions.timeout) > 0 ? Number(requestOptions.timeout) : DEFAULT_TIMEOUT_MS;

    let settled = false;
    let activeRequest = null;

    const finish = (err, resp, body) => {
      if (settled) return;
      settled = true;
      // The callback is the script's own code. If it throws, that is the script's bug - but it must
      // not become an uncaught exception in the main process, so it stops here.
      try {
        callback(err, resp, body);
      } catch (callbackError) {
        logger.warn?.('[CustomSource] 音源脚本在 request 回调中抛出异常', callbackError && callbackError.message ? callbackError.message : callbackError);
      }
    };

    const send = (targetUrl, redirectsLeft, dropBody) => {
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch (error) {
        finish(error);
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        finish(new Error(`lx.request only speaks http(s): ${parsed.protocol}`));
        return;
      }

      const headers = {};
      for (const [key, value] of Object.entries(requestOptions.headers || {})) {
        if (value != null) headers[key] = String(value);
      }
      if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = DEFAULT_USER_AGENT;

      const body = dropBody ? null : buildBody(requestOptions, headers);
      if (body != null && !headers['Content-Length'] && !headers['content-length']) {
        headers['Content-Length'] = String(Buffer.byteLength(body));
      }

      const transport = parsed.protocol === 'https:' ? https : http;
      const request = transport.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: String(requestOptions.method || 'GET').toUpperCase(),
        headers,
      }, response => {
        const statusCode = response.statusCode || 0;
        const location = response.headers.location;
        if (location && statusCode >= 300 && statusCode < 400 && redirectsLeft > 0) {
          response.resume();
          const nextUrl = new URL(location, targetUrl).href;
          // 303 means "GET this instead"; 307/308 keep the method and the body.
          send(nextUrl, redirectsLeft - 1, statusCode === 303 || statusCode === 301 || statusCode === 302);
          return;
        }

        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks);
          const decoded = decodeBody(raw, response.headers['content-encoding']);
          const text = decoded.toString('utf8');
          // LX parses JSON here rather than leaving it to the script: `resp.body` is an object when
          // the answer parses (`try { resp.body = JSON.parse(body) } catch {}`). Scripts rely on it,
          // so a body left as a string would make every one of them read undefined fields.
          let body = text;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          finish(null, {
            statusCode,
            statusMessage: response.statusMessage,
            headers: response.headers,
            bytes: decoded.length,
            raw: decoded,
            body,
          }, body);
        });
        response.on('error', error => finish(error));
      });

      activeRequest = request;
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`lx.request timed out after ${timeoutMs}ms`));
      });
      request.on('error', error => finish(error));
      if (body != null) request.write(body);
      request.end();
    };

    send(String(url), MAX_REDIRECTS, false);

    return () => {
      settled = true;
      try {
        activeRequest?.destroy();
      } catch (error) {
        logger.warn?.('[CustomSource] cancel failed', error);
      }
    };
  };
};

module.exports = { createLxRequest };
