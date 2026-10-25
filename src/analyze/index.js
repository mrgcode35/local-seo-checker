/**
 * Local SEO analysis of one HTML page. Pure: no network, no DOM — the caller
 * fetches the page (see server/fetch.js) and passes everything in.
 */
import { parse } from 'node-html-parser';
import { LOCAL_TYPES } from './local-types.js';
import { score, grade } from '../score.js';

const DAY_RE = /\b(mon|tue|wed|thu|fri|sat|sun)(day|sday|nesday|rsday|urday)?\b/i;
const TIME_RE = /\b\d{1,2}(:\d{2})?\s?(am|pm|a\.m\.|p\.m\.)|\b([01]?\d|2[0-3]):[0-5]\d\b/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{8,}\d)/g;
const STREET_RE = /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl|highway|hwy|parkway|pkwy|suite|unit)\b\.?/i;
const MAP_RE = /(google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl|g\.page\/)/i;

/**
 * @param {object} p
 * @param {string} p.html
 * @param {string} p.url        URL the visitor entered
 * @param {string} p.finalUrl   URL after redirects
 * @param {number} p.status
 * @param {Record<string,string>} p.headers  response headers (lower-case keys)
 * @param {number} p.redirects
 * @param {number} p.timeMs     total fetch time
 * @param {number} p.bytes      size of the HTML in bytes
 * @param {{found:boolean, sitemaps?:string[]}} [p.robots]
 * @param {{found:boolean, url?:string}} [p.sitemap]
 * @param {{name?:string, city?:string, service?:string}} [p.inputs]
 */
export function analyze(p) {
  const headers = p.headers || {};
  const inputs = cleanInputs(p.inputs);
  const root = parse(p.html || '', {
    comment: false,
    blockTextElements: { script: true, style: true, noscript: true, pre: true, template: true },
  });

  // ── Read everything we need before stripping scripts for the text ──
  const title = text(root.querySelector('title'));
  const metas = root.querySelectorAll('meta');
  const meta = (name) => attrOf(metas.find((m) => (m.getAttribute('name') || '').toLowerCase() === name), 'content');
  const prop = (name) => attrOf(metas.find((m) => (m.getAttribute('property') || '').toLowerCase() === name), 'content');
  const links = root.querySelectorAll('link');
  const rel = (r) => links.filter((l) => (l.getAttribute('rel') || '').toLowerCase().split(/\s+/).includes(r));
  const anchors = root.querySelectorAll('a');
  const iframes = root.querySelectorAll('iframe');
  const images = root.querySelectorAll('img');
  const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const h1s = headings.filter((h) => h.tagName === 'H1');
  const scripts = root.querySelectorAll('script');
  const jsonLd = parseJsonLd(scripts.filter((s) => (s.getAttribute('type') || '').toLowerCase().includes('ld+json')));
  const business = jsonLd.find((n) => types(n).some((t) => LOCAL_TYPES.has(t)));
  const orgOnly = !business && jsonLd.some((n) => types(n).includes('Organization'));
  const externalScripts = scripts.filter((s) => s.getAttribute('src')).length;
  const stylesheets = rel('stylesheet').length;
  const htmlLang = attrOf(root.querySelector('html'), 'lang');

  const body = root.querySelector('body') || root;
  body.querySelectorAll('script, style, noscript, template, svg').forEach((e) => e.remove());
  const bodyText = squash(body.textContent);
  const words = bodyText ? bodyText.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length : 0;
  const lowerText = bodyText.toLowerCase();

  const checks = [];
  const add = (category, id, title, status, detail, fix = '') => checks.push({ category, id, title, status, detail, fix });

  // ── Basics ──
  add('basics', 'status', 'Page loads', p.status === 200 ? 'pass' : 'warn',
    `The page answered with HTTP ${p.status}.`, 'Make sure the page returns status 200 for visitors and search engines.');

  const finalHttps = safeUrl(p.finalUrl)?.protocol === 'https:';
  add('basics', 'https', 'Secure (HTTPS)', finalHttps ? 'pass' : 'fail',
    finalHttps ? 'The page is served over HTTPS.' : 'The page is not served over HTTPS.',
    'Install an SSL certificate (often free) and redirect http:// to https://.');

  add('basics', 'redirects', 'Redirects', p.redirects <= 1 ? 'pass' : 'warn',
    p.redirects ? `${p.redirects} redirect${p.redirects > 1 ? 's' : ''} before the page loaded.` : 'No redirects.',
    'Link straight to the final address so visitors and Google skip the redirect chain.');

  const robotsMeta = `${meta('robots') || ''} ${meta('googlebot') || ''} ${headers['x-robots-tag'] || ''}`.toLowerCase();
  const noindex = /noindex|none/.test(robotsMeta);
  add('basics', 'indexable', 'Allowed in Google', noindex ? 'fail' : 'pass',
    noindex ? 'The page tells search engines not to index it (noindex).' : 'Search engines are allowed to index this page.',
    'Remove "noindex" from the robots meta tag or X-Robots-Tag header if this page should rank.');

  const canonicalHref = attrOf(rel('canonical')[0], 'href');
  const canonical = canonicalHref ? safeUrl(canonicalHref, p.finalUrl) : null;
  const finalU = safeUrl(p.finalUrl);
  if (!canonical) {
    add('basics', 'canonical', 'Canonical tag', 'warn', 'No canonical tag found.',
      'Add <link rel="canonical" href="…"> pointing to this page\'s preferred address.');
  } else if (finalU && canonical.host !== finalU.host) {
    add('basics', 'canonical', 'Canonical tag', 'warn', `The canonical points to another site: ${canonical.href}`,
      'Point the canonical tag to this page unless the content really lives elsewhere.');
  } else {
    add('basics', 'canonical', 'Canonical tag', 'pass', `Canonical: ${canonical.href}`);
  }

  const viewport = (meta('viewport') || '').toLowerCase();
  add('basics', 'viewport', 'Mobile-friendly viewport', viewport.includes('width=device-width') ? 'pass' : 'fail',
    viewport ? `Viewport: ${viewport}` : 'No mobile viewport tag found.',
    'Add <meta name="viewport" content="width=device-width, initial-scale=1"> so the page fits phones.');

  add('basics', 'lang', 'Page language', htmlLang ? 'pass' : 'warn',
    htmlLang ? `Language set to "${htmlLang}".` : 'The page doesn\'t declare its language.',
    'Add a lang attribute to the <html> tag, e.g. <html lang="en">.');

  // ── On-page ──
  if (!title) {
    add('onpage', 'title', 'Page title', 'fail', 'No title tag.', 'Add a title of 30–60 characters with the service and city.');
  } else {
    const ok = title.length >= 30 && title.length <= 60;
    add('onpage', 'title', 'Page title', ok ? 'pass' : 'warn', `"${title}" (${title.length} characters)`,
      title.length < 30 ? 'Make the title more descriptive (30–60 characters), e.g. "Emergency Plumber in Springfield | Acme Plumbing".'
        : 'Shorten the title to about 60 characters so Google doesn\'t cut it off.');
  }

  const desc = meta('description');
  if (!desc) {
    add('onpage', 'meta-description', 'Meta description', 'warn', 'No meta description.',
      'Write a 70–160 character summary that says what you do, where, and why to choose you.');
  } else {
    const ok = desc.length >= 70 && desc.length <= 160;
    add('onpage', 'meta-description', 'Meta description', ok ? 'pass' : 'warn', `${desc.length} characters.`,
      desc.length < 70 ? 'Expand the description to 70–160 characters.' : 'Trim the description to about 160 characters.');
  }

  if (h1s.length === 1) add('onpage', 'h1', 'Main heading (H1)', 'pass', `"${truncate(text(h1s[0]), 90)}"`);
  else if (!h1s.length) add('onpage', 'h1', 'Main heading (H1)', 'fail', 'No H1 heading found.', 'Add one H1 that says what you do and where.');
  else add('onpage', 'h1', 'Main heading (H1)', 'warn', `${h1s.length} H1 headings found.`, 'Keep one H1 per page; use H2/H3 for the rest.');

  let skipped = null;
  let prev = 0;
  for (const h of headings) {
    const level = Number(h.tagName[1]);
    if (prev && level > prev + 1) { skipped = `H${prev} → H${level}`; break; }
    prev = level;
  }
  add('onpage', 'heading-order', 'Heading structure', skipped ? 'warn' : 'pass',
    skipped ? `Heading levels are skipped (${skipped}).` : 'Headings follow a logical order.',
    'Use headings in order (H1, then H2, then H3) so the page structure is clear.');

  add('onpage', 'word-count', 'Amount of content', words >= 300 ? 'pass' : words >= 100 ? 'warn' : 'fail',
    `About ${words} words of text.`,
    'Add useful text: services, areas served, prices or process, FAQs. Thin pages rarely rank.');

  const missingAlt = images.filter((i) => i.getAttribute('alt') === undefined || i.getAttribute('alt') === null).length;
  const altShare = images.length ? missingAlt / images.length : 0;
  add('onpage', 'image-alt', 'Image alt text', !images.length || !missingAlt ? 'pass' : altShare <= 0.2 ? 'warn' : 'fail',
    images.length ? `${missingAlt} of ${images.length} images have no alt text.` : 'No images on the page.',
    'Describe each image in its alt text, e.g. "Plumber fixing a leaking pipe in Springfield".');

  // ── Local signals ──
  const schemaPhone = str(business?.telephone);
  const schemaName = str(business?.name);
  const addr = firstObj(business?.address);
  const hasHoursSchema = Boolean(business?.openingHoursSpecification || business?.openingHours);

  if (business) {
    add('local', 'schema-present', 'LocalBusiness schema', 'pass', `Found ${types(business).join(', ')} markup.`);
  } else {
    add('local', 'schema-present', 'LocalBusiness schema', 'fail',
      orgOnly ? 'Only Organization markup found, not LocalBusiness.' : 'No LocalBusiness structured data found.',
      'Add LocalBusiness JSON-LD (free generator: tools.serpnetic.cloud/local-business-schema-generator/).');
  }

  if (business) {
    const missing = [];
    if (!schemaName) missing.push('name');
    if (!addr || !(addr.addressLocality || addr.streetAddress)) missing.push('address');
    if (!schemaPhone) missing.push('telephone');
    if (!hasHoursSchema) missing.push('opening hours');
    add('local', 'schema-fields', 'Schema details', !missing.length ? 'pass' : missing.length <= 2 ? 'warn' : 'fail',
      missing.length ? `Missing in the schema: ${missing.join(', ')}.` : 'Name, address, phone and hours are all in the schema.',
      'Fill in the missing fields in your LocalBusiness markup.');
  } else {
    add('local', 'schema-fields', 'Schema details', 'skip', 'Skipped: no LocalBusiness schema.');
  }

  const textPhones = (bodyText.match(PHONE_RE) || []).map(digits).filter((d) => d.length >= 10 && d.length <= 15);
  const telLinks = anchors.map((a) => a.getAttribute('href') || '').filter((h) => /^tel:/i.test(h.trim()));
  const telDigits = telLinks.map(digits);
  add('local', 'phone-visible', 'Phone number on the page', textPhones.length || telLinks.length ? 'pass' : 'fail',
    textPhones.length || telLinks.length ? 'A phone number is shown on the page.' : 'No phone number found on the page.',
    'Show your phone number clearly, ideally in the header and footer.');

  add('local', 'click-to-call', 'Click-to-call link', telLinks.length ? 'pass' : 'fail',
    telLinks.length ? `${telLinks.length} tap-to-call link${telLinks.length > 1 ? 's' : ''} found.` : 'The phone number isn\'t tappable on phones.',
    'Wrap the phone number in a link: <a href="tel:+15555550100">(555) 555-0100</a>.');

  const street = str(addr?.streetAddress);
  const streetShown = street && lowerText.includes(street.toLowerCase());
  const addressShown = streetShown || STREET_RE.test(bodyText);
  add('local', 'address-visible', 'Address on the page', addressShown ? 'pass' : 'warn',
    addressShown ? 'A street address appears on the page.' : 'No street address found on the page.',
    'Show your address (or, if customers don\'t visit you, the areas you serve).');

  if (business && (schemaPhone || schemaName)) {
    const problems = [];
    const sp = digits(schemaPhone).slice(-10);
    if (sp && ![...textPhones, ...telDigits].some((d) => d.slice(-10) === sp)) problems.push('the schema phone number isn\'t shown on the page');
    if (schemaName && !lowerText.includes(schemaName.toLowerCase())) problems.push('the schema business name isn\'t on the page');
    add('local', 'nap-match', 'Name & phone match', problems.length ? 'warn' : 'pass',
      problems.length ? `Mismatch: ${problems.join('; ')}.` : 'The schema name and phone match what the page shows.',
      'Use exactly the same business name and phone number in the schema, on the page and on Google Business Profile.');
  } else {
    add('local', 'nap-match', 'Name & phone match', 'skip', 'Skipped: no schema name or phone to compare.');
  }

  const hasMap = iframes.some((f) => MAP_RE.test(f.getAttribute('src') || '')) || anchors.some((a) => MAP_RE.test(a.getAttribute('href') || ''));
  add('local', 'map', 'Google Maps', hasMap ? 'pass' : 'warn',
    hasMap ? 'The page embeds or links to Google Maps.' : 'No Google Maps embed or link found.',
    'Embed your Google Maps location or link to your Google Business Profile.');

  const hoursShown = DAY_RE.test(bodyText) && TIME_RE.test(bodyText);
  add('local', 'hours-visible', 'Opening hours', hoursShown || hasHoursSchema ? 'pass' : 'warn',
    hoursShown ? 'Opening hours are shown on the page.' : hasHoursSchema ? 'Hours are in the schema but not visible on the page.' : 'No opening hours found.',
    'List your opening hours on the page (and in the schema).');

  const contact = anchors.some((a) => /contact/i.test(a.getAttribute('href') || '') || /contact/i.test(text(a)));
  add('local', 'contact-link', 'Contact page link', contact ? 'pass' : 'warn',
    contact ? 'The page links to a contact page.' : 'No link to a contact page found.',
    'Add a clear "Contact" link in the menu or footer.');

  // ── Relevance (only when the visitor told us) ──
  const lowerTitle = title.toLowerCase();
  const h1Text = h1s.map(text).join(' ').toLowerCase();
  if (inputs.city) {
    const c = inputs.city.toLowerCase();
    add('relevance', 'city-title', `"${inputs.city}" in the title`, lowerTitle.includes(c) ? 'pass' : 'fail',
      lowerTitle.includes(c) ? 'The city is in the page title.' : 'The city is not in the page title.',
      `Add "${inputs.city}" to the title, e.g. "Service in ${inputs.city} | Business".`);
    add('relevance', 'city-h1', `"${inputs.city}" in the H1`, h1Text.includes(c) ? 'pass' : 'warn',
      h1Text.includes(c) ? 'The city is in the main heading.' : 'The city is not in the main heading.',
      `Mention "${inputs.city}" in the H1.`);
    const n = count(lowerText, c);
    add('relevance', 'city-text', `"${inputs.city}" in the text`, n >= 2 ? 'pass' : n === 1 ? 'warn' : 'fail',
      `Mentioned ${n} time${n === 1 ? '' : 's'} in the text.`,
      `Talk about the areas you serve in ${inputs.city} naturally in the page text.`);
  }
  if (inputs.service) {
    const s = inputs.service.toLowerCase();
    add('relevance', 'service-title', `"${inputs.service}" in the title`, lowerTitle.includes(s) ? 'pass' : 'fail',
      lowerTitle.includes(s) ? 'The service is in the page title.' : 'The service is not in the page title.',
      `Put "${inputs.service}" near the start of the title.`);
    add('relevance', 'service-h1', `"${inputs.service}" in the H1`, h1Text.includes(s) ? 'pass' : 'warn',
      h1Text.includes(s) ? 'The service is in the main heading.' : 'The service is not in the main heading.',
      `Mention "${inputs.service}" in the H1.`);
  }
  if (inputs.name) {
    const has = lowerText.includes(inputs.name.toLowerCase()) || lowerTitle.includes(inputs.name.toLowerCase());
    add('relevance', 'name-on-page', 'Business name on the page', has ? 'pass' : 'warn',
      has ? 'The business name appears on the page.' : 'The business name was not found on the page.',
      'Show the business name exactly as it appears on Google Business Profile.');
  }

  // ── Technical ──
  add('technical', 'response-time', 'Response time', p.timeMs < 800 ? 'pass' : p.timeMs < 2000 ? 'warn' : 'fail',
    `The page took ${(p.timeMs / 1000).toFixed(2)} s to download from our server.`,
    'Speed up hosting or add caching so the page arrives in under a second.');

  const kb = Math.round((p.bytes || 0) / 1024);
  add('technical', 'html-size', 'HTML size', kb < 500 ? 'pass' : kb < 1500 ? 'warn' : 'fail', `${kb} KB of HTML.`,
    'Reduce page builder bloat and inline code to keep the HTML lean.');

  const enc = (headers['content-encoding'] || '').toLowerCase();
  add('technical', 'compression', 'Compression', /gzip|br|deflate|zstd/.test(enc) ? 'pass' : 'warn',
    enc ? `Compressed with ${enc}.` : 'The HTML is sent uncompressed.',
    'Turn on gzip or Brotli compression on the server.');

  const assets = externalScripts + stylesheets;
  add('technical', 'assets', 'Scripts & stylesheets', assets <= 20 ? 'pass' : assets <= 40 ? 'warn' : 'fail',
    `${externalScripts} external scripts and ${stylesheets} stylesheets.`,
    'Remove unused plugins and combine files to cut the number of downloads.');

  add('technical', 'robots-txt', 'robots.txt', p.robots?.found ? 'pass' : 'warn',
    p.robots?.found ? 'robots.txt is reachable.' : 'No robots.txt found.',
    'Add a robots.txt file that allows crawling and links to your sitemap.');

  add('technical', 'sitemap', 'XML sitemap', p.sitemap?.found ? 'pass' : 'warn',
    p.sitemap?.found ? `Sitemap found: ${p.sitemap.url}` : 'No XML sitemap found.',
    'Create an XML sitemap (most SEO plugins do this) and submit it in Google Search Console.');

  const ogTitle = prop('og:title');
  const ogImage = prop('og:image');
  add('technical', 'open-graph', 'Social sharing tags', ogTitle && ogImage ? 'pass' : 'warn',
    ogTitle && ogImage ? 'Open Graph title and image are set.' : 'Open Graph title or image is missing.',
    'Add og:title and og:image so links look good when shared on Facebook, LinkedIn or WhatsApp.');

  const favicon = rel('icon').length || rel('shortcut').length || rel('apple-touch-icon').length;
  add('technical', 'favicon', 'Favicon', favicon ? 'pass' : 'warn',
    favicon ? 'A favicon is set.' : 'No favicon link found.', 'Add a favicon so your brand shows in browser tabs and search results.');

  const s = score(checks);
  return {
    url: p.url,
    finalUrl: p.finalUrl,
    inputs,
    score: s.score,
    grade: grade(s.score),
    categories: s.categories,
    checks,
    checkedAt: new Date().toISOString(),
  };
}

// ── helpers ──
function cleanInputs(i = {}) {
  const c = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 80) : '');
  return { name: c(i.name), city: c(i.city), service: c(i.service) };
}
function text(el) { return el ? squash(el.textContent) : ''; }
function squash(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function attrOf(el, a) { const v = el ? el.getAttribute(a) : ''; return v ? String(v).trim() : ''; }
function str(v) { return typeof v === 'string' ? v.trim() : Array.isArray(v) && typeof v[0] === 'string' ? v[0].trim() : ''; }
function firstObj(v) { return Array.isArray(v) ? v.find((x) => x && typeof x === 'object') : v && typeof v === 'object' ? v : null; }
function digits(s) { return String(s || '').replace(/\D/g, ''); }
function truncate(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
function count(hay, needle) { let n = 0; let i = hay.indexOf(needle); while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length); } return n; }
function safeUrl(u, base) { try { return new URL(u, base); } catch { return null; } }
function types(node) {
  const t = node?.['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x) => typeof x === 'string').map((x) => x.replace(/^https?:\/\/schema\.org\//, ''));
}

/** Flatten every JSON-LD block (arrays and @graph included) into a list of nodes. */
export function parseJsonLd(scriptEls) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      out.push(v);
      if (v['@graph']) walk(v['@graph']);
    }
  };
  for (const s of scriptEls) {
    try { walk(JSON.parse(s.rawText || s.textContent || '')); } catch { /* invalid JSON-LD is ignored */ }
  }
  return out;
}
