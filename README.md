# Local SEO Checker

Free, open-source tool that scores a local business web page **0–100** on about **30 local SEO
checks** and gives a plain-English fix list, worst problems first.

**Live version:** https://tools.serpnetic.cloud/local-seo-checker/

## What it checks

| Category | Checks |
|---|---|
| Basics | Page loads, HTTPS, redirects, indexable (robots meta / X-Robots-Tag), canonical, mobile viewport, `lang` |
| On-page | Title and meta description length, one H1, heading order, amount of text, image alt text |
| **Local signals** | LocalBusiness schema and its fields (name, address, phone, hours), phone on the page, click-to-call link, address on the page, **name & phone match** between schema and page, Google Maps, opening hours, contact page link |
| Relevance *(optional inputs)* | City and service in the title / H1 / text, business name on the page |
| Technical | Response time, HTML size, compression, scripts & stylesheets, robots.txt, XML sitemap, Open Graph tags, favicon |

Weights live in [`src/score.js`](src/score.js). Local signals weigh most.

**Limit:** it reads the page's HTML as delivered. Sites that build all their content with JavaScript
may score lower than they should.

## Run it

```bash
npm install
npm run dev      # service + demo page at http://localhost:8787
npm test         # unit tests (Node 20+)
```

With Docker:

```bash
docker build -t local-seo-checker .
docker run --rm -p 127.0.0.1:8787:8787 local-seo-checker
```

API: `POST /check` with JSON `{ "url": "example.com", "name": "", "city": "", "service": "" }` →
`{ ok: true, result: { score, grade, categories, checks[] } }`. `GET /health` → `ok`.
Settings are environment variables — see [`.env.example`](.env.example).

## Safety

The service fetches URLs that strangers submit, so it is locked down:

- only `http`/`https` on ports 80/443, no credentials in URLs, no internal hostnames;
- every hostname is resolved and **rejected if any address is private, loopback, link-local, CGNAT,
  multicast, reserved or cloud-metadata** (IPv4 and IPv6, incl. IPv4-mapped forms);
- the connection goes to the address that was checked (no second DNS lookup → no DNS rebinding);
- max 5 redirects (each re-checked), 10 s deadline, 3 MB body limit, HTML only;
- the fetched HTML is never sent back — only the analysis;
- per-visitor rate limit (default 10/hour, 30/day), max 3 checks at once, 10-minute result cache,
  all in memory.

Run it behind a reverse proxy and set `TRUST_PROXY=1` so the proxy's `X-Real-IP` is used for rate limits.

## Use the pieces

```js
import { analyze } from 'local-seo-checker';                 // pure analysis of HTML you already have
import { mountLocalSeoChecker } from 'local-seo-checker/ui';  // browser UI
import 'local-seo-checker/ui/style.css';

mountLocalSeoChecker(document.getElementById('tool'), { apiUrl: '/check' });
```

Theme the UI with the `--lsc-*` CSS variables on `.lsc`. The printable report has no third-party
branding, so agencies can share it with clients.

## Licence

[MIT](LICENSE) — free to use, copy and modify. Made by [Serpnetic](https://serpnetic.com).
