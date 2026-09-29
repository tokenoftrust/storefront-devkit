---
id: storefront-devbook-design-tokens
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Theme and design-token contract — reference theme and how theming works
---
# Theme and design-token contract — reference theme and how theming works

The storefront is **multi-tenant**: components are theme-agnostic and read CSS custom properties;
each tenant supplies token overrides. This document captures the **reference theme** and the rationale. Tenants set values in `theme.json`
(see `devbook://storefront-devbook-brand-theme-chrome`).

## Token contract (per tenant)
Each tenant fills (or inherits sane defaults for) — emitted as CSS custom properties injected per
tenant at the edge by the middleware, so components stay brand-agnostic:

- **color:** bg, surface, text, muted, primary, primary-contrast, accent, border, success, sale
- **type:** display (family, weights), body (family, weights), mono/utility; type scale; tracking
- **space:** base unit + scale; container max-width; section rhythm
- **shape:** radius scale; border weights; shadow scale
- **brand:** logo (light/dark), favicon, OG default image, motion preference

## Reference theme — "Northwind"

**Thesis.** A Pacific-Northwest maker of considered apparel/home goods — *"overcast-day calm with
one sharp accent."* The catalog's most characteristic quality (quiet, tactile, well-made) leads;
the hero is that thesis, not a generic gradient/big-number block.

**Palette.** Spruce-ink text + deep spruce green on warm greige, with a single **burnt-amber**
spark for emphasis/sale. Deliberately avoids the AI-default looks the brief calls out: not
cream-bg + high-contrast serif + terracotta; not near-black + acid-green; not broadsheet hairline
columns.

**Type.** Inverts the cliché pairing: a geometric grotesque (**Space Grotesk**) for display and a
humanist serif (**Source Serif 4**) for body, on a real modular type scale with deliberate
tracking — not system defaults, not the same serif everyone uses.

**Motion.** Boldness is spent in exactly one signature place — the oversized split-type homepage
hero with a tasteful load reveal. Everywhere else stays quiet: restrained hover micro-interactions
on cards/gallery. `prefers-reduced-motion` is honored throughout.

**Quality floor (non-negotiable, met).** Responsive to mobile; visible keyboard focus; reduced
motion honored; real empty/error states written in the interface's voice (404, empty PLP, empty
search, draft banner).

## How theming works (seam)
1. The platform defines the token schema and the reference values.
2. A tenant's `theme.json` (deep-partial) merges over the reference defaults.
3. The platform serializes the resolved tokens to a `<style>` block of CSS custom
   properties, exposed to components as utilities.
4. Components reference `var(--color-primary)` etc. — never hard-coded brand values — so a new
   tenant gets a distinct identity from the same component library by supplying tokens only.
