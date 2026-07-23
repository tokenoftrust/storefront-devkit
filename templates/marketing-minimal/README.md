# Template: Marketing (minimal)

A no-cart marketing / landing site built from the marketing block set. Use it for a brand site,
campaign landing page, or pre-launch presence.

## What's inside

```text
.tot/config.json        siteType: marketing
theme.json              brand tokens
content/chrome.json     header nav + header CTAs + footer
content/home.json       marketing_hero → trust_bar → card_grid → faq → cta_band
capabilities.json       cartCheckout disabled (no store)
public/                 logos, images, fonts
```

## Use it

```bash
cp -R templates/marketing-minimal ../my-site && cd ../my-site
tot dev
tot validate
```

## Notes

- The marketing blocks (`marketing_hero`, `trust_bar`, `split_compare`, `steps`, `card_grid`,
  `integrations`, `proof_strip`, `testimonials`, `faq`, `cta_band`) are for narrative/landing
  pages. For a store homepage that merchandises products, use the commerce blocks (`hero`,
  `featured_products`, …) — see [`../commerce-minimal`](../commerce-minimal/).
- `cartCheckout` is disabled here because there's no catalog. If this site later becomes a store,
  flip it on and switch the homepage to commerce blocks.
