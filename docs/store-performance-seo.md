# Store performance & SEO

How to ship a genuinely fast, well-ranked store on the platform — and which parts are yours vs. the
platform's. (This is about the *stores you build*. For getting *this repo* found, see
[`DISCOVERABILITY.md`](./DISCOVERABILITY.md).)

## What the platform gives you for free

You inherit these by building on the platform — don't hand-author them:

- **Edge SSR on Cloudflare** — pages render at the edge, close to the shopper. Fast first paint,
  good Core Web Vitals by default.
- **Structured data (JSON-LD)** — emitted for the store/products so search engines understand your
  catalog.
- **`llms.txt` + `sitemap.xml`** — generated so both AI agents and crawlers can find your content.
- **Canonical URLs and a zero-404 crawl** — no broken internal links shipping to production.
- **The preview evidence panel** — before go-live, the preview shows a compliance **and** SEO
  evidence panel (age gate · excise · jurisdiction · `llms.txt` · JSON-LD · zero-404). You *see*
  correctness, not just pixels. Advisory SEO items (e.g. sitemap warnings) are flagged but don't
  block; compliance items are hard stops.

## What you control (the levers that actually move rankings)

1. **Titles & descriptions** — set `seoTitle` / `seoDescription` on `content/home.json` and every
   `content/pages/*.json`. See [`../snippets/seo/page-seo.json`](../snippets/seo/page-seo.json).
   ~50–60 char titles, ~150–160 char descriptions, brand + primary term, written for humans.
2. **Semantic content** — compose pages from real **blocks** (hero, product sections, FAQ, …), not
   raw HTML. Blocks give the platform clean, structured, accessible markup it can optimize and
   describe in structured data. (Raw HTML is also blocked for regulated tenants.)
3. **Images** — put assets in `public/**` and reference them from content/theme. Ship appropriately
   sized images; the platform's image handling does the rest. Large unoptimized hero images are the
   most common Web-Vitals regression — size them before you commit.
4. **Real merchandising** — use product **sources** (`bestSelling`, `{ "collection": … }`) so
   sections stay populated and fresh; empty/placeholder sections read poorly to users and crawlers.
5. **Fast, few widgets** — every sandboxed widget you add is optional weight. Use `on-idle` /
   `on-interaction` strategies so widgets never delay first paint (see
   [`../widgets`](../widgets/)).

## A pre-go-live checklist

- Every page has a distinct `seoTitle` + `seoDescription`.
- Hero and above-the-fold images are sized/optimized.
- No raw HTML (required for regulated tenants; good practice for all).
- Product sections resolve to real products.
- `tot validate` passes; the preview evidence panel is green on compliance and clean on SEO
  advisories you can address.

> The platform's signature is *correctness you can see*: fast edge pages **plus** a preview that
> proves compliance + SEO before you ship. Lean on it.
