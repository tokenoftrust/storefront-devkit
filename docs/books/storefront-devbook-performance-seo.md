---
id: storefront-devbook-performance-seo
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Performance & SEO — best-in-world, and what's free vs. yours
---
# Performance & SEO — best-in-world, and what's free vs. yours

Task: ship a fast, well-ranked store; know what's free vs the few levers that move the needle. > storefront-devkit snippets/seo/ + docs/store-performance-seo.md.

## What the platform gives you free (don't hand-author):

Edge SSR on Cloudflare (fast first paint, good CWV); Structured data JSON-LD for store/products; llms.txt + sitemap.xml generated; canonical URLs + zero-404 crawl; the preview evidence panel (compliance + SEO evidence: age gate·excise·jurisdiction·llms.txt·JSON-LD·zero-404 — compliance are hard stops, SEO advisory). Signature: correctness you can see.

## The levers you control:

1. Titles & descriptions (seoTitle/seoDescription on content/home.json + content/pages/*.json; ~50-60 char titles, ~150-160 desc).
2. Semantic content — compose from real BLOCKS not raw HTML (raw HTML forfeits this + blocked for regulated).
3. Images — assets in public/**, sized; oversized hero = #1 CWV regression.
4. Real merchandising via product sources.
5. Fast, few widgets (on-idle/on-interaction so widgets never delay first paint).

## Pre-go-live checklist:

distinct seoTitle+seoDescription per page; above-fold images sized; no raw HTML; product sections resolve to real products; tot validate passes + evidence panel green on compliance, clean on SEO advisories.

## Common pitfalls:

chasing perf the platform handles; giant unoptimized hero images; skipping per-page metadata; widget bloat.

## Verify:

`tot dev` check titles; go-live preview evidence panel — green compliance, clean SEO. That panel is the objective "best-in-world" bar.

---

## Under the hood — generation, budgets & the image pipeline

The "free" guarantees above aren't hand-waves — they're framework capabilities that generate from your REAL data and gate regressions before they reach production. Here's what actually runs, and where it lives.

### 1. SEO / JSON-LD / sitemap / llms.txt generation from real data (F13)

The platform's JSON-LD emitter emits structured data from the live catalog only — nothing is fabricated:

- **Canonical URLs** generate for both the production domain AND path-prefix preview deployments, so the same content resolves cleanly in either context.
- **Drafts and synthesized EMPTY collections are excluded** from sitemap.xml and JSON-LD — the crawlable surface is exactly what's real and published.
- **Product / Offer / Breadcrumb / Organization / WebSite / ItemList / Review** JSON-LD all emit from real data ONLY. Critically, **AggregateRating / Review is emitted ONLY when real review data exists** — a store with 0 reviews emits nothing (no fabricated star ratings, ever).
- **llms.txt** is generated from the live catalog, so AI crawlers see the same real inventory.

Net: the JSON-LD and llms.txt evidence in the preview panel is a reflection of your actual catalog state, not a template.

### 2. Performance budgets + RUM (F14)

A checked-in budget MANIFEST shipped with the platform makes performance a gated, reviewable contract rather than a hope:

- **Per-route targets**: web-vitals thresholds (LCP ≤ 2.5s / INP ≤ 200ms / CLS ≤ 0.1 at p75) plus JS / CSS / image-weight budgets and a third-party-script allowlist, with per-route overrides.
- **A pure lab GATE** (`evaluateManifest`) is fed three ways — a CLI `perf:budgets` assertion, native `lighthouse --budget-path`, and an LHR adapter — all using real request hostnames.
- **Dependency-free RUM** collects field Web Vitals (PerformanceObserver → `POST /api/rum/vitals`), bucketed to the same route ids the lab gate uses, so lab and field speak the same language.
- **A regression-alert contract** feeds the F16 Core-Web-Vitals monitor.

Net: perf regressions are visible before production promotion — the budget fails the gate rather than silently shipping.

### 3. Image rehosting + responsive / LCP pipeline (F8)

The catalog image pipeline (in the migration tooling) turns arbitrary source imagery into a fast, provenance-preserving asset set:

- **Rehosts source images to R2/CDN**, preserving width/height/alt and provenance (`source_url`).
- **Applies PLP/PDP responsive rules and LCP priority** — the first card is eager / high priority; the PDP gallery uses one resized Cloudflare variant.
- **REPORTS missing imagery**: products with 0 images render placeholder art and the gap is surfaced as a launch-blocking issue — never faked, never silently blank.

Net: images (the #1 CWV regression source) are sized, prioritized, and honestly reported, so the "above-fold images sized" checklist item is something the pipeline helps you meet, not just verify.
