# Discoverability & SEO for this repo

The strategic reason this repo exists on **public GitHub**: regulated verticals (vape, alcohol,
hemp/CBD, firearms) are hard to reach through paid advertising, but a public code repo is indexed
by search engines and browsed by the exact developers/agencies building in those spaces. This doc
is the checklist to make that reach real.

## First: the robots.txt truth

- **A plain GitHub repo has no useful `robots.txt`.** You don't control `github.com/robots.txt`,
  and you can't add a per-repo one that changes how Google crawls your repo page. So "add a
  robots.txt" does **nothing** for `github.com/tokenoftrust/storefront-devkit` itself.
- **`robots.txt` only matters once you publish a site you control** — i.e. **GitHub Pages** (or
  any hosted docs site). If we want genuine organic search reach, a Pages site is the lever, and
  *then* `robots.txt` + `sitemap.xml` + per-page meta become real and are included in
  [`../site/`](../site/).

## GitHub-native signals (do these regardless of Pages)

These are what actually move a repo in GitHub search and Google's index of the repo page:

1. **Repo description** (Settings → top of repo). Keyword-rich, one sentence, e.g.:
   > Runnable templates, schemas & examples for building compliant regulated ecommerce
   > storefronts (vape, alcohol, hemp/CBD, firearms) on the Token of Trust platform.
2. **Topics** (the tag chips). Add: `ecommerce`, `regulated-commerce`, `age-verification`,
   `compliance`, `pact-act`, `excise-tax`, `kyc`, `aml`, `fraud-prevention`, `storefront`,
   `astro`, `cloudflare`, `vape`, `alcohol`, `cbd`, `hemp`, `firearms`, `token-of-trust`.
3. **Homepage URL** (Settings → "Website"): set to `https://storefront.tokenoftrust.store`
   (context + an outbound link).
4. **Social preview image** (Settings → Social preview): upload a branded OG image so shared links
   render well (helps click-through, which indirectly helps ranking).
5. **README quality** (already done): the README is the indexed body — keyword-bearing H1/H2,
   the industry terms, and links to `tokenoftrust.com` / `storefront.tokenoftrust.store`.
6. **`llms.txt`** (already present): the AI/agent discovery channel — increasingly how developers
   find implementation resources.

## Backlinks (the strongest lever)

Inbound links from your own high-authority sites are the biggest ranking signal a new repo can get:

- Link **from** `tokenoftrust.com` and `storefront.tokenoftrust.store` (e.g. a "Developers /
  Devkit" nav or footer link) **to** the GitHub repo.
- Link from the MCP **devbooks** to the repo.
- The repo links back (README, `llms.txt`) — already done.

## If we enable GitHub Pages (recommended for real reach)

A Pages site turns this repo's content into an indexable site you fully control:

1. Enable Pages (Settings → Pages), source = `/site` folder on `main` (or move `site/` to `/docs`).
2. Optionally set a custom subdomain via `site/CNAME` (e.g. `devkit.tokenoftrust.store`) + a DNS
   CNAME — a branded, on-domain URL that also strengthens the association with the main sites.
3. The included [`../site/robots.txt`](../site/robots.txt) allows crawling and points at the
   sitemap; [`../site/sitemap.xml`](../site/sitemap.xml) lists the pages;
   [`../site/index.html`](../site/index.html) carries `<title>`, meta description, canonical,
   OpenGraph, and JSON-LD structured data.
4. Keep **canonical** URLs pointing at the Pages/custom domain so the repo page and the Pages site
   don't compete as duplicate content.

## What NOT to do

- Don't keyword-stuff or add manipulative link farms — Google penalizes it and it tarnishes the
  brand. Keep the industry terms genuine and useful (they already describe real capabilities).
- Don't feature verticals off-brand for ToT (see [`../industries`](../industries/) for the curated,
  reputation-safe set).
