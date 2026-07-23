# site/ — optional GitHub Pages landing

A minimal, SEO-ready landing page for the devkit. **Inert until you enable GitHub Pages.**

## Enable

1. Repo → Settings → Pages → Build from a branch → `main` / **`/site`** folder.
   (Or move this folder to `/docs`, which Pages also supports as a source.)
2. (Optional) Custom subdomain: put a domain in `site/CNAME` (e.g. `devkit.tokenoftrust.store`),
   add a matching DNS CNAME, and enable "Enforce HTTPS".
3. Update the domain in `robots.txt`, `sitemap.xml`, and the canonical/OG URLs in `index.html`
   to your final Pages/custom domain.

## What's here

- `index.html` — landing page with `<title>`, meta description, canonical, OpenGraph, JSON-LD.
- `robots.txt` — allows crawling, points at the sitemap.
- `sitemap.xml` — the page list (extend as you add pages).

See [`../docs/DISCOVERABILITY.md`](../docs/DISCOVERABILITY.md) for the full SEO checklist,
including the GitHub-native signals (topics, description, backlinks) that matter even without
Pages.
