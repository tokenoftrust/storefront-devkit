# Template: Commerce (minimal)

A clean commerce storefront you can rebrand in minutes. No regulated obligations — for
age-restricted goods start from [`../regulated-vape`](../regulated-vape/) instead.

## What's inside

```text
.tot/config.json        siteType: commerce (no compliance block)
theme.json              neutral modern brand tokens — change these first
content/chrome.json     header nav + footer
content/home.json       hero → best sellers → new arrivals → newsletter (block-palette@3)
content/pages/about.json  an editorial page at /about
capabilities.json       cart + checkout enabled
scripts.json            no widgets yet
public/                 drop logos, hero images, fonts here
```

## Use it

```bash
cp -R templates/commerce-minimal ../my-store && cd ../my-store
# rebrand: edit theme.json (see snippets/theme-presets for ready palettes)
# merchandise: edit content/home.json (see snippets/product-sources for options)
tot dev            # http://localhost:<port>/<tenant>/
tot validate       # before you publish
```

## Rebranding checklist

1. `theme.json` — set `color.primary`, `color.accent`, and the type families to the brand.
   Keep AA contrast (validation warns/errors otherwise).
2. `public/` — add the logo(s) and reference them from `theme.json` `brand.logoLight`/`logoDark`.
3. `content/chrome.json` — real nav + footer links.
4. `content/home.json` — point `featured_products` sources at real collections/tags.
5. `content/pages/about.json` — real copy.

## Notes

- Product sections use **sources** (`bestSelling`, `{ "collection": "…" }`) so they stay fresh
  without hand-listing products.
- This template keeps everything in platform-rendered JSON — no raw HTML — so it inherits the
  shared performance, SEO, and (if you later add it) compliance behavior.
