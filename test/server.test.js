import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, validateUrl, decodeHtml, FetchError } from '../server/fetch.js';
import { RateLimiter, Gate, TtlCache } from '../server/limits.js';

test('isBlockedIp blocks private, loopback, metadata and mapped addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::', 'not-an-ip']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test('validateUrl accepts public sites and adds https://', () => {
  assert.equal(validateUrl('example.com').href, 'https://example.com/');
  assert.equal(validateUrl('http://www.example.com/page?x=1#top').href, 'http://www.example.com/page?x=1');
  assert.equal(validateUrl('https://example.com:443/').href, 'https://example.com/');
});

test('validateUrl rejects unsafe input', () => {
  const bad = ['', 'ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pass@example.com',
    'http://example.com:8080/', 'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/',
    'http://intranet/', 'http://printer.local/', 'http://db.internal/', 'x'.repeat(3000)];
  for (const u of bad) assert.throws(() => validateUrl(u), FetchError, u);
});

test('decodeHtml respects charset', () => {
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in latin1
  assert.equal(decodeHtml(latin1, 'text/html; charset=iso-8859-1'), 'café');
  assert.equal(decodeHtml(Buffer.from('café', 'utf8'), 'text/html'), 'café');
});

test('RateLimiter: 10 per hour, then a daily cap', () => {
  let t = 0;
  const rl = new RateLimiter({ perHour: 10, perDay: 30, now: () => t });
  for (let i = 0; i < 10; i++) assert.equal(rl.take('a').ok, true);
  const blocked = rl.take('a');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.scope, 'hour');
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 3600);
  assert.equal(rl.take('b').ok, true, 'other visitors are unaffected');
  t += 3600e3 + 1;
  for (let i = 0; i < 10; i++) rl.take('a');
  t += 3600e3 + 1;
  for (let i = 0; i < 10; i++) rl.take('a');
  t += 3600e3 + 1;
  const day = rl.take('a');
  assert.equal(day.ok, false);
  assert.equal(day.scope, 'day');
});

test('Gate limits concurrency and rejects when the queue waits too long', async () => {
  const gate = new Gate(1, 50);
  let release;
  const first = gate.run(() => new Promise((r) => { release = r; }));
  await assert.rejects(gate.run(async () => 'x'), (e) => e.code === 'busy');
  release('done');
  assert.equal(await first, 'done');
  assert.equal(await gate.run(async () => 'ok'), 'ok');
});

test('TtlCache expires entries', () => {
  let t = 0;
  const c = new TtlCache(1000, 2, () => t);
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  t = 1001;
  assert.equal(c.get('a'), undefined);
  c.set('x', 1); c.set('y', 2); c.set('z', 3);
  assert.equal(c.get('x'), undefined, 'oldest entry evicted when full');
});
