# SEO snippets

What you author for store SEO vs. what the platform gives you for free. See
[`../../docs/store-performance-seo.md`](../../docs/store-performance-seo.md) for the full picture.

- `page-seo.json` — the per-page fields you set (`seoTitle`, `seoDescription`) on `content/home.json`
  and `content/pages/*.json`.

**You control:** page titles & descriptions, semantic/well-structured content (use real blocks, not
raw HTML), and optimized images placed in `public/**`.

**The platform gives you for free:** edge SSR, JSON-LD structured data, `llms.txt`, `sitemap.xml`,
canonical URLs, and a zero-404 crawl — all surfaced in the **preview evidence panel** so you can see
correctness, not just pixels. You don't hand-author these.
