/**
 * Safe page fetcher. Anyone on the internet can ask the server to fetch a URL, so:
 *  - only http/https on ports 80/443, no credentials in the URL, no internal hostnames;
 *  - every hostname is resolved and rejected if ANY address is private, loopback,
 *    link-local, CGNAT, multicast, reserved or cloud-metadata (IPv4 + IPv6);
 *  - the connection goes to the address we checked (no second lookup → no DNS rebinding);
 *  - max 5 redirects, each re-checked; one overall deadline; capped body size.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import zlib from 'node:zlib';

export const USER_AGENT = 'SerpneticLocalSEOChecker/1.0 (+https://tools.serpnetic.cloud/local-seo-checker/)';

export class FetchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const blocked = new net.BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['fc00::', 7],
  ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(ip, bits, 'ipv6');

/** True when the address must never be fetched. */
export function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v !== 6) return true;
  const lower = ip.toLowerCase();
  // IPv4-mapped / NAT64 / 6to4 forms carry an IPv4 address inside — check that.
  const mapped = lower.match(/^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIp(mapped[1]);
  if (/^::ffff:/.test(lower) || /^64:ff9b::/.test(lower) || /^2002:/.test(lower)) return true;
  return blocked.check(lower, 'ipv6');
}

/**
 * Normalise and validate a visitor-supplied URL. Adds https:// when missing.
 * @returns {URL}
 */
export function validateUrl(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 2048) throw new FetchError('invalid-url', 'Enter a web page address.');
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new FetchError('invalid-url', 'That doesn\'t look like a web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('invalid-url', 'Only http:// and https:// pages can be checked.');
  if (url.username || url.password) throw new FetchError('invalid-url', 'Addresses with a username or password can\'t be checked.');
  if (url.port && url.port !== '80' && url.port !== '443') throw new FetchError('invalid-url', 'Only standard web ports (80/443) can be checked.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new FetchError('blocked', 'That address is private and can\'t be checked.');
  } else if (!host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|arpa)$/.test(host)) {
    throw new FetchError('invalid-url', 'Enter a public website address, e.g. example.com.');
  }
  url.hash = '';
  return url;
}

async function resolveSafe(host) {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    if (isBlockedIp(bare)) throw new FetchError('blocked', 'That address is private and can\'t be checked.');
    return { address: bare, family: net.isIP(bare) };
  }
  let list;
  try {
    list = await dns.lookup(bare, { all: true, verbatim: true });
  } catch {
    throw new FetchError('dns', `We couldn't find the website "${bare}". Check the spelling.`);
  }
  if (!list.length) throw new FetchError('dns', `We couldn't find the website "${bare}".`);
  if (list.some((a) => isBlockedIp(a.address))) throw new FetchError('blocked', 'That website points to a private address and can\'t be checked.');
  return list[0];
}

function requestOnce(url, { deadline, maxBytes, accept }) {
  return new Promise(async (resolve, reject) => {
    let target;
    try {
      target = await resolveSafe(url.hostname);
    } catch (e) {
      reject(e);
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(new FetchError('timeout', 'The website took too long to respond.')); return; }

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: net.isIP(url.hostname) ? undefined : url.hostname,
      // Connect to the address we already checked — never look the name up again.
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [target]) : cb(null, target.address, target.family)),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en',
      },
      timeout: remaining,
    });

    const timer = setTimeout(() => req.destroy(new FetchError('timeout', 'The website took too long to respond.')), remaining);
    req.on('timeout', () => req.destroy(new FetchError('timeout', 'The website took too long to respond.')));
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e instanceof FetchError ? e : new FetchError('connect', `We couldn't connect to the website (${e.code || e.message}).`));
    });
    req.on('response', (res) => {
      const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)]));
      if (res.statusCode >= 300 && res.statusCode < 400 && headers.location) {
        res.resume();
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers, body: Buffer.alloc(0), rawBytes: 0 });
        return;
      }
      const enc = (headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      const chunks = [];
      let size = 0;
      let raw = 0;
      res.on('data', (c) => { raw += c.length; });
      stream.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new FetchError('too-large', `The page is larger than ${Math.round(maxBytes / 1048576)} MB, too big to check.`));
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers, body: Buffer.concat(chunks), rawBytes: raw }); });
      stream.on('error', () => { clearTimeout(timer); reject(new FetchError('decode', 'The website sent a page we couldn\'t read.')); });
    });
    req.end();
  });
}

/**
 * Fetch a URL safely, following up to `maxRedirects` redirects.
 * @returns {Promise<{url:string, finalUrl:string, status:number, headers:object, body:Buffer, redirects:number, timeMs:number}>}
 */
export async function safeFetch(input, { timeoutMs = 10000, maxBytes = 3 * 1048576, maxRedirects = 5, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' } = {}) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let url = input instanceof URL ? input : validateUrl(input);
  const firstUrl = url.href;
  for (let redirects = 0; ; redirects++) {
    const res = await requestOnce(url, { deadline, maxBytes, accept });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (redirects >= maxRedirects) throw new FetchError('redirects', `The page redirects more than ${maxRedirects} times.`);
      url = validateUrl(new URL(res.headers.location, url).href);
      continue;
    }
    return { url: firstUrl, finalUrl: url.href, status: res.status, headers: res.headers, body: res.body, redirects, timeMs: Date.now() - start };
  }
}

/** Decode a response body using the charset from the header or the HTML, defaulting to UTF-8. */
export function decodeHtml(body, contentType = '') {
  let charset = (contentType.match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!charset) {
    const head = body.subarray(0, 2048).toString('latin1');
    charset = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
