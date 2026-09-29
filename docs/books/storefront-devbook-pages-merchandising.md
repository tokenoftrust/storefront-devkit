---
id: storefront-devbook-pages-merchandising
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Pages & merchandising — home, marketing, catalog, PLP/PDP & search
---
# Pages & merchandising — home, marketing, catalog, PLP/PDP & search
Tasks: compose home + editorial/marketing pages from the block palette, merchandise the catalog with product sources. You author layout+data; the platform renders PLP/PDP/search. > storefront-devkit schemas/home.schema.json, snippets/blocks/, snippets/product-sources/.
## The home page (content/home.json) — a pinned block contract ("block-palette@3") + seoTitle/seoDescription + ordered blocks (hero, featured_products source=bestSelling/newest, newsletter). Palettes: Commerce blocks (hero, featured_products, featured_collections, editorial, newsletter); Marketing blocks (marketing_hero, trust_bar, split_compare, steps, card_grid, integrations, proof_strip, testimonials, faq, cta_band). Fields in schemas/home.schema.json; copy from snippets/blocks/. commerce siteType uses commerce blocks, marketing uses marketing set.
## Merchandising with product sources — never hand-list handles unless client names SKUs; bind to a source: featured/newest/bestSelling/onSale, {collection}, {tag}, {handles}, {related}, {recentlyViewed}. snippets/product-sources/.
## Editorial pages (content/pages/*.json) — block JSON, same as home; content/pages/about.json serves /about. Keep editorial in JSON blocks (inherits layout/perf/SEO/compliance frame). Raw HTML pages (content/*.html) are for UNREGULATED tenants only, blocked at publish for regulated.
## PLP/PDP/search — platform-rendered from your catalog (you don't author them): PLP (filters/facets/product cards); PDP (media/variants/price/purchase options); Search (header typeahead + results over edge index). They inherit perf/a11y/SEO/compliance + restyle to theme.json.

> **Image pipeline for PLP/PDP (F8).** You don't hand-manage product imagery: the catalog pipeline rehosts product images to R2/CDN, **preserving alt text and provenance**, and applies responsive sizing + LCP-priority rules so PLP cards and PDP media are fast and accessible by default. A product with **zero images renders placeholder art** and is **reported as a launch-blocking imagery gap** — imagery is never faked to fill the slot. Fix the gap (supply real images) rather than working around the placeholder.

## Common pitfalls: empty product sections; wrong palette for site type; reaching for raw HTML for a custom section (translate to blocks); hand-listing products that churn (prefer sources).
## Verify: `tot dev` home renders blocks; product rows populate from sources; /about serves editorial; search + collection pages work; tot validate checks block contract+palette.

---

## Structured content widgets (framework capability — F4)

The repeated commerce/policy/marketing page patterns you used to hand-build as HTML/CSS fragments are now **DATA-driven framework widgets**. A tenant authors a policy / about / compliance page — or a trust strip or callout — as **structured `sections` JSON**, and the platform renders it as real, accessible DOM. There is no HTML/CSS fragment to copy, and no `set:html`.

**Contracts live in the platform content library:**
- **RichText** (`richtext.ts`) — typed inline runs (text/emphasis/strong/link) rendered as **real DOM elements**, never raw HTML injection. This is the inline primitive every prose widget builds on.
- **ProseSections** (`prose.ts`) — a discriminated union of section kinds: `heading`, `paragraph`, `list`, `definitions`, `callout`, `contact`. It supports an auto **table-of-contents** and a `collectNeedsReview` walk that surfaces flagged content.
- **Callout** (`callout.ts`) — a toned callout whose `tone` maps to the correct ARIA `role`; `NeedsReviewCallout` marks content awaiting human review, and an **`auditNeedsReview` go-live guard** can block publish while unreviewed flags remain.
- **TrustStrip** (`trustStrip.ts`) — the structured trust-badge / assurance strip widget.

**Accessibility lives in the component, not the tenant's HTML.** The widgets emit real `h2`/`h3` with anchors, `dl`/`dt`/`dd` for definitions, `address` for contact blocks, `nav` with an `aria-label` for the ToC, `role=note` for callouts, external-link `rel` + an `sr-only` cue on outbound links, and honor a `--tap-target` sizing token. Authors get correct semantics for free instead of re-deriving a11y per page.

**Rendering path:** the catch-all page route (`[...slug].astro`) renders `sections` when present, and **falls back to legacy `body_html`** when a page has none — so existing HTML pages keep working while new pages move to structured sections. **Needs-review flags render only in preview/dev, never to shoppers.**

Prefer structured `sections` over a raw HTML page for any policy/about/compliance/marketing-prose content: you inherit the layout/perf/SEO/compliance frame *and* the accessibility, and the go-live guard keeps unreviewed copy from shipping.

## Reviews & trust proof — real or absent (framework capability — F9)

Reviews and ratings render **only from a real `Review[]` source**. No source ⇒ **no reviews** — the platform never fabricates, pads, or infers them. This is enforced, not aspirational.

A shared **no-fabrication detector** (in the public runtime) runs at **two seams**:
1. **Ingestion** — it drops scraped review-**widget** markup pulled from a migrated site: Judge.me / Stamped / Yotpo / Loox / Okendo badges and boilerplate like "Based on N reviews" are stripped rather than carried over as if they were your data.
2. **Go-live lint** — a launch check **fails** on fabricated review metafields or structurally-fake `Review` entries, so a tenant can't ship invented social proof.

Product **JSON-LD emits `AggregateRating` / `Review` only when backed by real data** — no real reviews means no rating markup, keeping structured data honest for search engines. **Net: no fake reviews, ratings, or trust badges can reach production, and it's test-enforced.**

When a client wants review UI, wire a real review source; if there isn't one yet, the correct outcome is an empty/absent reviews surface, not a placeholder rating.
