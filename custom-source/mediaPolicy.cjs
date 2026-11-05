// custom-source/mediaPolicy.cjs
//
// A custom source hands the app a playable URL that lives on some host we know nothing about.
// Folia's lyric visualizer reads the audio through Web Audio, and an audio element fed from a host
// without CORS headers cannot be analysed: the graph goes silent. Every other provider that issues
// its own URLs (Bodian, Qishui) solves this the same way - the URLs it just issued are remembered
// for a while, and the session's header hook adds CORS to those and only those.
//
// This is that policy, with no host allowlist of its own: what a script issues is by definition
// what the user asked for. Entries expire so a host that stops being used stops getting headers.

const ENTRY_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ENTRIES = 4096;

const normalize = value => {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
};

const createCustomSourceMediaPolicy = ({ now = Date.now } = {}) => {
  const issued = new Map();

  const register = value => {
    const url = normalize(value);
    if (!url) return;
    issued.delete(url.href);
    issued.set(url.href, now() + ENTRY_TTL_MS);
    while (issued.size > MAX_ENTRIES) issued.delete(issued.keys().next().value);
  };

  const allows = details => {
    if (!details) return false;
    if (!['media', 'xhr', 'image'].includes(details.resourceType)) return false;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(String(details.method).toUpperCase())) return false;
    const url = normalize(details.url);
    if (!url) return false;
    const expiry = issued.get(url.href);
    if (expiry === undefined) return false;
    if (expiry > now()) return true;
    issued.delete(url.href);
    return false;
  };

  // A CDN redirect is still the same song: the address it lands on has to be allowed too.
  const followRedirect = details => {
    if (!details?.redirectURL) return;
    if (allows(details)) register(details.redirectURL);
  };

  return { register, allows, followRedirect };
};

module.exports = { createCustomSourceMediaPolicy };
