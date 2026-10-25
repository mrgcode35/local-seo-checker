# local-seo-checker — Project Memory for Claude

**Public, open-source (MIT)** tool. Anyone can read this repo, so treat every commit as published.

- Serpnetic's planning notes live in a private repo; ask the owner before changing scope.
- The live version at https://tools.serpnetic.cloud/local-seo-checker/ uses this repo as a git
  submodule (UI) and runs `server/` in Docker on the VPS behind Nginx.

## What it does

URL (+ optional name/city/service) → server fetches the page safely → ~30 checks → 0–100 score,
per-category scores, fix list, printable white-label report.

## Layout

- `src/analyze/index.js` — pure analysis (`analyze({...})`), uses `node-html-parser`. Server-side only.
- `src/score.js` — weights per check id + scoring + grade. Tune weights here only.
- `src/ui/tool.js`, `src/ui/style.css` — browser UI, no dependencies; `--lsc-*` theming; `.lsc .lsc-…` scoping.
- `server/fetch.js` — **safe fetcher** (SSRF protection). `server/limits.js` — rate limit, gate, cache.
- `server/index.js` — HTTP service (`POST /check`, `GET /health`, `--demo` serves `index.html`).
- `test/` — analyzer, fetcher rules, limits. `npm test` must pass.

## Rules (public repo)

- **Never weaken `server/fetch.js`** (blocked ranges, port/scheme rules, checked-IP connect,
  redirect re-check, size/time caps). Add a test for any change there.
- Never return fetched HTML to the client. No logging of submitted URLs.
- No Serpnetic branding in the UI or the printable report; README credit is fine.
- No client names, real business data, secrets, hostnames or IPs. Examples use example.com / "Acme Plumbing".
- UI writes text with `textContent` only.
- Adding a check: add it in `analyze`, give it a weight in `score.js`, cover it in `test/analyze.test.js`
  (the "well-optimised page" test asserts the total check count).
