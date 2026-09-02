# Chrome snippets

Patterns for `content/chrome.json` and `content/chrome-assignments.json`.

- `mega-menu.json` — a single `nav` item rendered as a multi-column mega menu. Paste into the
  `nav[]` array. Validates against the legacy
  [`../../schemas/chrome.schema.json`](../../schemas/chrome.schema.json) (v1) shape.
- `footer.json` — a full footer object (columns + newsletter + social). Paste as the `footer` key.
  Validates against the legacy v1 shape above.
- `tokenoftrust-chrome.json` — a complete, real-world `content/chrome.json` (tokenoftrust.com's own
  marketing site), validating against the current
  [`../../schemas/chrome.v2.schema.json`](../../schemas/chrome.v2.schema.json) contract: a
  `header`/`footer` split, an explicit `header.variant`, and a stable `id` on every nav item, CTA,
  and footer link. Use this as the reference shape for any new `chrome.json` — it's the one
  actively validated against the real platform contract, not the v1 examples above.
- `tokenoftrust-chrome-assignments.json` — a matching real `content/chrome-assignments.json`:
  gives two pages (`/contact/contact-sales` and its `/thank-you`) a `minimal` header while every
  other page stays on the site's default `primary` header. Validates against
  [`../../schemas/chrome-assignments.schema.json`](../../schemas/chrome-assignments.schema.json).
  Keys are the page's full path (leading slash, no trailing slash, including any parent section —
  `/contact/contact-sales`, not `/contact-sales`); only pages that need to differ from the
  `chrome.json` default belong here.

## v1 vs v2 — which schema to author against

`chrome.schema.json` (v1) is the original, simpler shape (`nav`/`headerCtas` at the top level,
`footer.tagline`/`footer.legal`, no `id` fields, no per-page override concept). It's kept in place,
unbroken, for whatever already validates against it (`templates/commerce-minimal`,
`templates/marketing-minimal`, `templates/regulated-vape`, and `footer.json`/`mega-menu.json`
above) — per this repo's own versioning rule (`CONTRIBUTING.md`: "breaking a schema → publish a
new versioned schema file and leave the prior one in place").

**`chrome.v2.schema.json` is the one that matches the platform's actual `ChromeConfig` contract
today** — a `header`/`footer` split, explicit `header.variant`/`footer.variant`, and a required
`id` on every nav item, CTA, and footer link. Author new `chrome.json` content against v2, using
`tokenoftrust-chrome.json` as the reference. The three existing v1 templates have not yet been
migrated to v2 — track that separately; don't assume they validate against the real platform
today as-is.
