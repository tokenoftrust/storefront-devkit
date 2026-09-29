# Shared chrome and merchandising sections are standard components

**Rule:** site chrome (announcement bar, utility nav, header, mega-menu, footer) and merchandising
sections (product cards, carousels, grids) are reusable, store-agnostic components, never hand-built or
copy-pasted per page.

A merchant's look is reproduced with theme tokens, variant props and data, not by forking a
component. That keeps every store extractable: the components live in the shared library, and the
store owns only data (`chrome.json`, page content) and tokens (theme).

## Why

If every raw page duplicates its chrome inline, editing a nav link means editing N files. Shared
chrome puts the header and footer in one place.

## The components

- **Merchandising:** price display, rating stars, product card, product carousel (optional tabs),
  product grid. Sections bind to a typed section source resolved from the catalog; presets
  (best sellers, new arrivals, on sale) are a carousel with a preset source, not bespoke components.
- **Chrome:** announcement bar (static or marquee, reduced-motion safe), utility nav, site header
  (search, account and a cart link), nav dropdown and mega-menu, site footer (columns, newsletter,
  payment chips, compliance line).

All are skinned by CSS-variable theme tokens. Preview every state and permutation in the style
guide at `/_style-guide/<store-id>/<theme>/`.

## The shared-chrome mechanism (how a page opts in)

A raw page is served one of two ways:

| Page file shape | Behavior |
| --- | --- |
| **Full document** (has `<!doctype>` or `<html>`) | Served verbatim. |
| **Body-only fragment** plus a store `content/chrome.html` | The fragment is spliced into the chrome wrapper at the `<!--PAGE_BODY-->` marker, so chrome lives in one place. |

- `content/chrome.html` is a full document whose `<body>` contains the chrome (authored from the
  standard chrome components' markup) with a `<!--PAGE_BODY-->` marker where page bodies go.
- The composed document is then nonce-stamped and base-path-prefixed as usual, so the chrome's own
  inline `<style>` and `<script>` and its root-absolute nav links are handled once. The commerce
  boundary is untouched: product and collection routes never flow through here.

**To convert an existing raw page to shared chrome:** delete the chrome from the page file (leave the
body markup only, no `<html>` or `<head>`), and add a `content/chrome.html` wrapper with the chrome and
`<!--PAGE_BODY-->`. No route or code change is needed; the fragment is detected and wrapped
automatically.
