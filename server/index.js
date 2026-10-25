/**
 * Local SEO Checker service.
 *   POST /check  { url, name?, city?, service? }  → { ok, result } | { ok:false, error }
 *   GET  /health → "ok"
 * Run behind a reverse proxy in production (set TRUST_PROXY=1 so X-Real-IP is used
 * for rate limiting). `node server/index.js --demo` also serves the demo page at /.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyze } from '../src/analyze/index.js';
import { safeFetch, validateUrl, decodeHtml, FetchError } from './fetch.js';
import { RateLimiter, Gate, TtlCache } from './limits.js';

const env = process.env;
const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || '0.0.0.0';
const TRUST_PROXY = env.TRUST_PROXY === '1';
const DEMO = env.DEMO === '1' || process.argv.includes('--demo');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const limiter = new RateLimiter({ perHour: Number(env.RATE_PER_HOUR || 10), perDay: Number(env.RATE_PER_DAY || 30) });
const gate = new Gate(Number(env.MAX_CONCURRENT || 3), 20000);
const cache = new TtlCache(10 * 60e3, 500);
setInterval(() => limiter.prune(), 10 * 60e3).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real) return real.trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(json);
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new FetchError('too-large', 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new FetchError('bad-request', 'Invalid request.')); }
    });
    req.on('error', reject);
  });
}

/** robots.txt + sitemap discovery (small, best-effort; failures just mean "not found"). */
async function siteFiles(finalUrl) {
  const origin = new URL(finalUrl).origin;
  const small = { timeoutMs: 5000, maxBytes: 512 * 1024, maxRedirects: 3, accept: 'text/plain,application/xml,text/xml,*/*;q=0.5' };
  const robots = { found: false, sitemaps: [] };
  try {
    const r = await safeFetch(`${origin}/robots.txt`, small);
    const body = r.body.toString('utf8');
    if (r.status === 200 && !/<html/i.test(body.slice(0, 500))) {
      robots.found = true;
      robots.sitemaps = [...body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]).slice(0, 5);
    }
  } catch { /* not found */ }
  const candidates = [...robots.sitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`];
  for (const u of [...new Set(candidates)].slice(0, 4)) {
    try {
      const r = await safeFetch(u, small);
      if (r.status === 200 && /<(urlset|sitemapindex)\b/i.test(r.body.subarray(0, 4096).toString('utf8'))) {
        return { robots, sitemap: { found: true, url: r.finalUrl } };
      }
    } catch { /* try next */ }
  }
  return { robots, sitemap: { found: false } };
}

async function runCheck(body) {
  const url = validateUrl(body.url);
  const inputs = { name: body.name, city: body.city, service: body.service };
  const page = await safeFetch(url);
  if (page.status >= 400) throw new FetchError('http-error', `The page returned an error (HTTP ${page.status}). Check the address.`);
  const type = (page.headers['content-type'] || '').toLowerCase();
  if (type && !type.includes('html')) throw new FetchError('not-html', 'That address isn\'t a web page (it returned a file or data).');
  const html = decodeHtml(page.body, page.headers['content-type']);
  const files = await siteFiles(page.finalUrl);
  return analyze({
    html,
    url: url.href,
    finalUrl: page.finalUrl,
    status: page.status,
    headers: page.headers,
    redirects: page.redirects,
    timeMs: page.timeMs,
    bytes: page.body.length,
    robots: files.robots,
    sitemap: files.sitemap,
    inputs,
  });
}

const STATUS_FOR = { 'invalid-url': 400, blocked: 400, 'bad-request': 400, 'too-large': 413, busy: 503 };

async function handleCheck(req, res) {
  let body;
  try {
    body = await readJson(req);
    validateUrl(body.url);
  } catch (e) {
    send(res, STATUS_FOR[e.code] || 400, { ok: false, error: { code: e.code || 'bad-request', message: e.message } });
    return;
  }
  const key = JSON.stringify([String(body.url).trim().toLowerCase(), body.name || '', body.city || '', body.service || '']);
  const cached = cache.get(key);
  if (cached) { send(res, 200, { ok: true, cached: true, result: cached }); return; }

  const rate = limiter.take(clientIp(req));
  if (!rate.ok) {
    const mins = Math.ceil(rate.retryAfter / 60);
    send(res, 429, { ok: false, error: { code: 'rate-limit', retryAfter: rate.retryAfter,
      message: rate.scope === 'hour'
        ? `You've used the free checks for this hour. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`
        : 'You\'ve used today\'s free checks. Please come back tomorrow.' } },
    { 'Retry-After': String(rate.retryAfter) });
    return;
  }

  try {
    const result = await gate.run(() => runCheck(body));
    cache.set(key, result);
    send(res, 200, { ok: true, result });
  } catch (e) {
    if (e.code === 'busy') {
      send(res, 503, { ok: false, error: { code: 'busy', message: 'The checker is busy right now. Please try again in a minute.' } });
    } else if (e instanceof FetchError) {
      send(res, 422, { ok: false, error: { code: e.code, message: e.message } });
    } else {
      console.error('check failed:', e);
      send(res, 500, { ok: false, error: { code: 'internal', message: 'Something went wrong while checking that page.' } });
    }
  }
}

const DEMO_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/src/ui/tool.js': ['src/ui/tool.js', 'text/javascript; charset=utf-8'],
  '/src/ui/style.css': ['src/ui/style.css', 'text/css; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (req.method === 'POST' && pathname === '/check') return handleCheck(req, res);
  if (req.method === 'GET' && pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (DEMO && req.method === 'GET' && DEMO_FILES[pathname]) {
    const [file, type] = DEMO_FILES[pathname];
    res.writeHead(200, { 'Content-Type': type });
    res.end(await readFile(path.join(ROOT, file)));
    return;
  }
  send(res, 404, { ok: false, error: { code: 'not-found', message: 'Not found.' } });
});

server.requestTimeout = 60000;
server.listen(PORT, HOST, () => console.log(`local-seo-checker listening on ${HOST}:${PORT}${DEMO ? ' (demo at /)' : ''}`));
