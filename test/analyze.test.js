import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze/index.js';
import { score, grade } from '../src/score.js';

const GOOD = `<!doctype html><html lang="en"><head>
<title>Emergency Plumber in Springfield | Acme Plumbing</title>
<meta name="description" content="Acme Plumbing fixes leaks, blocked drains and water heaters across Springfield. Same-day visits, upfront prices.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://www.example.com/">
<link rel="icon" href="/favicon.png">
<meta property="og:title" content="Acme Plumbing"><meta property="og:image" content="https://www.example.com/og.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Plumber","name":"Acme Plumbing",
"telephone":"+1-555-555-0100","address":{"@type":"PostalAddress","streetAddress":"123 Main St","addressLocality":"Springfield"},
"openingHoursSpecification":[{"@type":"OpeningHoursSpecification","dayOfWeek":"Monday","opens":"08:00","closes":"17:00"}]}]}</script>
</head><body>
<header><a href="/contact/">Contact</a> <a href="tel:+15555550100">(555) 555-0100</a></header>
<h1>Emergency Plumber in Springfield</h1>
<h2>Our services</h2><p>${'Acme Plumbing serves Springfield homes with fast, friendly plumbing repairs. '.repeat(40)}</p>
<h3>Where we work</h3><p>Springfield, Chatham and Rochester.</p>
<p>Visit us at 123 Main St, Springfield. Open Monday to Friday 8am–5pm.</p>
<img src="a.jpg" alt="Plumber at work">
<iframe src="https://www.google.com/maps/embed?pb=xyz"></iframe>
</body></html>`;

const BAD = `<html><head><title>Home</title><meta name="robots" content="noindex"></head>
<body><h1>Welcome</h1><h1>Hello</h1><h4>Skip</h4><img src="x.jpg"><img src="y.jpg"><p>Short page.</p></body></html>`;

const base = {
  url: 'https://www.example.com/',
  finalUrl: 'https://www.example.com/',
  status: 200,
  headers: { 'content-encoding': 'br' },
  redirects: 0,
  timeMs: 400,
  bytes: 20000,
  robots: { found: true },
  sitemap: { found: true, url: 'https://www.example.com/sitemap.xml' },
};

const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

test('well-optimised page passes everything and scores 100', () => {
  const r = analyze({ ...base, html: GOOD, inputs: { name: 'Acme Plumbing', city: 'Springfield', service: 'Plumber' } });
  const failing = r.checks.filter((c) => c.status !== 'pass').map((c) => `${c.id}: ${c.status} ${c.detail}`);
  assert.deepEqual(failing, []);
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
  assert.equal(r.checks.length, 36);
});

test('poor page: the right checks fail', () => {
  const r = analyze({ ...base, html: BAD, finalUrl: 'http://www.example.com/', headers: {}, robots: { found: false }, sitemap: { found: false } });
  const c = byId(r);
  for (const id of ['https', 'indexable', 'viewport', 'schema-present', 'phone-visible', 'click-to-call', 'word-count', 'image-alt']) {
    assert.equal(c[id].status, 'fail', id);
  }
  for (const id of ['h1', 'heading-order', 'title', 'canonical', 'lang', 'compression', 'map', 'robots-txt', 'sitemap']) {
    assert.equal(c[id].status, 'warn', id);
  }
  assert.equal(c['schema-fields'].status, 'skip');
  assert.equal(c['nap-match'].status, 'skip');
  assert.ok(!c['city-title'], 'relevance checks only run when inputs are given');
  assert.ok(r.score < 40, `score ${r.score}`);
});

test('NAP mismatch is caught', () => {
  const html = GOOD.replace('"telephone":"+1-555-555-0100"', '"telephone":"+1-555-555-0199"');
  const c = byId(analyze({ ...base, html }));
  assert.equal(c['nap-match'].status, 'warn');
  assert.match(c['nap-match'].detail, /phone/);
});

test('relevance checks use the inputs', () => {
  const c = byId(analyze({ ...base, html: GOOD, inputs: { city: 'Chicago', service: 'Electrician' } }));
  assert.equal(c['city-title'].status, 'fail');
  assert.equal(c['city-text'].status, 'fail');
  assert.equal(c['service-title'].status, 'fail');
});

test('cross-site canonical and slow response are flagged', () => {
  const html = GOOD.replace('https://www.example.com/"', 'https://other.example.org/"');
  const c = byId(analyze({ ...base, html, timeMs: 3000, bytes: 2_000_000 }));
  assert.equal(c.canonical.status, 'warn');
  assert.equal(c['response-time'].status, 'fail');
  assert.equal(c['html-size'].status, 'fail');
});

test('invalid JSON-LD is ignored, Organization-only is reported', () => {
  const html = GOOD.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    '<script type="application/ld+json">{bad json</script><script type="application/ld+json">{"@type":"Organization","name":"X"}</script>');
  const c = byId(analyze({ ...base, html }));
  assert.equal(c['schema-present'].status, 'fail');
  assert.match(c['schema-present'].detail, /Organization/);
});

test('score ignores skipped checks and grades correctly', () => {
  assert.equal(score([{ id: 'title', category: 'onpage', status: 'pass' }, { id: 'x', category: 'onpage', status: 'skip' }]).score, 100);
  assert.equal(score([{ id: 'title', category: 'onpage', status: 'warn' }]).score, 50);
  assert.deepEqual([grade(95), grade(80), grade(65), grade(45), grade(10)], ['A', 'B', 'C', 'D', 'F']);
});
