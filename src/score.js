/**
 * Scoring. Each check is pass (1), warn (0.5) or fail (0); "skip" doesn't count.
 * Weights live in this one table so they are easy to tune. Local signals weigh most.
 */
export const CATEGORIES = [
  ['basics', 'Basics'],
  ['onpage', 'On-page'],
  ['local', 'Local signals'],
  ['relevance', 'Relevance'],
  ['technical', 'Technical'],
];

export const WEIGHTS = {
  // basics
  'status': 3, 'https': 3, 'redirects': 1, 'indexable': 3, 'canonical': 1, 'viewport': 2, 'lang': 1,
  // on-page
  'title': 3, 'meta-description': 2, 'h1': 2, 'heading-order': 1, 'word-count': 2, 'image-alt': 1,
  // local
  'schema-present': 3, 'schema-fields': 3, 'phone-visible': 3, 'click-to-call': 2, 'address-visible': 2,
  'nap-match': 3, 'map': 2, 'hours-visible': 1, 'contact-link': 1,
  // relevance
  'city-title': 2, 'city-h1': 2, 'city-text': 2, 'service-title': 2, 'service-h1': 1, 'name-on-page': 1,
  // technical
  'response-time': 1, 'html-size': 1, 'compression': 1, 'assets': 1, 'robots-txt': 1, 'sitemap': 1,
  'open-graph': 1, 'favicon': 1,
};

const VALUE = { pass: 1, warn: 0.5, fail: 0 };

function scoreOf(checks) {
  let got = 0;
  let max = 0;
  for (const c of checks) {
    if (!(c.status in VALUE)) continue;
    const w = WEIGHTS[c.id] ?? 1;
    got += w * VALUE[c.status];
    max += w;
  }
  return max ? Math.round((100 * got) / max) : null;
}

/** Overall score plus one score per category (null when a category has no scored checks). */
export function score(checks) {
  const categories = CATEGORIES.map(([id, label]) => {
    const inCat = checks.filter((c) => c.category === id);
    return {
      id,
      label,
      score: scoreOf(inCat),
      counts: {
        pass: inCat.filter((c) => c.status === 'pass').length,
        warn: inCat.filter((c) => c.status === 'warn').length,
        fail: inCat.filter((c) => c.status === 'fail').length,
      },
    };
  });
  return { score: scoreOf(checks) ?? 0, categories };
}

export function grade(n) {
  if (n >= 90) return 'A';
  if (n >= 75) return 'B';
  if (n >= 60) return 'C';
  if (n >= 40) return 'D';
  return 'F';
}
