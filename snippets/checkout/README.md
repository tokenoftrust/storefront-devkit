# Checkout snippets

Checkout and cart are **platform-owned** — you never build cart/checkout mechanics as tenant
content. What you *can* do is **brand the managed cart drawer** so it matches your theme, and offer
**subscription purchase options** as product data.

- `cart-drawer-style.json` — an optional cart-drawer style override. The managed cart drawer already
  inherits your theme tokens (baseline); this is only for small, brand-specific tweaks, scoped under
  the drawer's own root so it can never leak into or override the rest of the page.
- For subscriptions, see [`../../recipes/add-subscription-option`](../../recipes/add-subscription-option/)
  (the `purchase_options` data shape) — not a widget, not HTML.

## What stays platform-owned (don't try to rebuild these)

- The cart drawer + hosted checkout, cart submission, totals, and tax.
- For regulated tenants, the compliance floor at checkout (age/ID, excise) — never disable it in
  `capabilities.json`.

Validate any change with `tot validate`. If a client needs checkout behavior beyond theming +
purchase options, that's a platform integration or the [private-apps](../../private-apps/) path —
not tenant content.
