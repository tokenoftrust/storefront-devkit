---
id: storefront-devbook-brand-theme-chrome
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Brand, theme & chrome — make the store look like the client
---
# Brand, theme & chrome — make the store look like the client
Tasks: (1) restyle via theme.json tokens, (2) build the frame via content/chrome.json. Both pure data; never touch a component.
> storefront-devkit: schemas/theme.schema.json, chrome.schema.json, snippets/theme-presets/, snippets/chrome/.
## 1. Theme (theme.json) — component library reads ONE vocabulary of design tokens; you supply values; theme.json is a deep-partial override. Shape: color{bg,surface,text,muted,primary,primary-contrast,accent,border,success,sale}, type{display,body,mono,scale,tracking,headings{hero,h1,h2,h3}}, space{base,containerMaxWidth,sectionRhythm}, shape{radius{sm,md,lg,full}}, brand{logoLight,favicon,motion}.
### Color tokens — Core: bg,surface,text,muted,primary,primary-contrast,accent,border,success,sale. Semantic/state (optional, platform-derived if omitted): surface-2,warning,error,info,accent-ink,primary-hover,accent-hover. primary=anchor (CTAs/active nav/hero fill); accent=single spark (badges/marks/large type, not body — use accent-ink for small text to pass AA).
### Heading sizes — `type.scale` drives a fluid display scale; `type.headings` pins a level to a fixed size when a port must match a source (e.g. a source H1 of 28px). Values are CSS lengths: `"28px"`, `"1.75rem"`, `"clamp(1.5rem, 4vw, 2rem)"`. `hero` sizes the home hero headline; `h1`/`h2`/`h3` size every other heading of that level — page and listing titles, block titles, and headings inside page body copy. An unset level keeps the fluid size. `{"type":{"headings":{"h1":"28px","h2":"22px"}}}`. `tot validate` refuses an unknown level or a value that is not a CSS length. Never target platform utility classes (`.display-xl`) from store CSS to resize headings; set the token.
### Home hero colours — the hero eyebrow reads `color.hero-eyebrow` (default: `muted` on a light hero, a translucent `primary-contrast` on a bold hero). Store CSS can also target the stable hook classes `.hero__eyebrow` and `.hero__notice` without `!important`.
### Aliasing a client's palette — don't teach the platform brand names; set the contract token to the brand value (primary=#C8102E etc.). The contract token IS the public API.
### Theme pitfalls — contrast fails validation (tot validate checks WCAG AA on text pairs + muted); don't paint everything primary (accents/CTAs only, keep large surfaces bg/surface); no hard-coded hex in content; fonts must load (self-host to public/**). Start from snippets/theme-presets/.

## The theme quality bar — semantic & interaction tokens (NEW — unit F6)
The token contract gained a set of **optional, bridge-defaulted** semantic/interaction aliases. Like the existing semantic tokens they are **always resolvable**: `global.css` carries a derived `@theme`-bridge default for each, so a component reads the token unconditionally and a theme sets one only to brand-tune it. A tenant reskins purely by supplying token values — every F6 token inherits a default derived from that tenant's own palette, so dropping one never ships an unresolved `var()`.
| Token | Meaning | Default |
|---|---|---|
| `--color-focus-ring` | Keyboard `:focus-visible` outline color | derived: `accent` |
| `--color-disabled` | Disabled/loading control fill | derived: `color-mix(muted 26%, surface)` |
| `--color-disabled-contrast` | Readable text/icon ON a `disabled` control | derived: `muted` |
| `--color-field-border` | Form-field outline (stronger ≥3:1 than the hairline `border`) | derived: `color-mix(border 52%, text)` |
| `--color-star` | Review/rating star fill (trust/UGC surfaces) | derived: `accent` |
| `--tap-target` | Minimum interactive tap-target size (WCAG 2.2 §2.5.8) | `44px` (via `shape.tapTarget`) |
- **No `cta-*` alias.** A CTA reads the existing core palette — `primary` (fill) / `primary-contrast` (label) / `primary-hover` (hover) — so one name governs both "brand anchor" and "primary CTA". Surfaces likewise read `surface` / `surface-2`; F6 adds no redundant surface alias.
- **Contract-test gated.** Tests now assert the serializer emits every token AND that `global.css` carries a resolvable bridge default for each — a future tenant theme that drops a token fails a test instead of shipping an unresolved `var()`.
- **Why it matters.** Focus rings, disabled/loading states, accessible form outlines, and review stars now each read a *named* token instead of a hard-coded value or a borrowed `accent` — that is the quality bar a tenant can brand-tune or safely inherit.

## 2. Chrome (content/chrome.json) — announcement + header nav (links/dropdowns/mega menus) + header CTAs + footer (columns, newsletter, social, legal). Nav item = plain link / single-column dropdown (children) / multi-column mega menu (columns); optional badge+flag; CTA variants primary|secondary|ghost.
### Chrome pitfalls — don't fabricate legal/compliance text in footer (regulated warnings are platform-rendered from compliance config; a brand line \"Products for adults 21+\" is fine, a paraphrased FDA/PACT warning is not); no broken links (zero-404 crawl flags them); don't overstuff mega menus.

## Shared page-pattern CSS (hybrid commerce tenants) (NEW — unit F5)
Hybrid tenants (a marketing site + commerce) otherwise ship the same raw-page-body patterns as ~80%-identical inline `<style>` per page. A framework sheet `public/shared/commerce-marketing.css` extracts those patterns — page hero, prose, callouts, tier grids / comparison table, faq, cta-band, and CTA helpers — as one shared, token-driven stylesheet.
- **Opt-in per tenant.** Set `TenantChrome.sharedMarketingCss: true` in chrome.json. It links the shared sheet **after** the tenant chrome sheet, so page-level variants still win.
- **Fully token-driven.** It reads the contract vocabulary (`--color-*`, type/space tokens) and carries no brand hex — the same sheet themes correctly for every tenant.
- **CSP improvement.** A linked same-origin sheet replaces per-page nonce-stamped inline `<style>`.
- **Contract-test gated**, like the token contract.
- **Adoption** per tenant = flip the flag + strip the now-redundant inline styles from that tenant's pages.

## Verify: `tot dev` → store root renders header/nav/footer/announcement from chrome.json wearing theme.json colors/type; `tot validate` (contrast+schema); open the style guide to preview the palette.
