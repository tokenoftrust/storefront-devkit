# Changelog

All notable changes to the Storefront Devkit. Format loosely follows Keep a Changelog.

## Unreleased

### Added
- Private Apps contract 1.2 (minor, compatible), mirrored from Storefront
  `ba07b4eb19c54e160277c2b086e6cba7510e20c2`: new `inventory:write` scope (`scopes.json`,
  `tot-app.schema.json`, `openapi.yaml`); idempotent `POST /inventory/movements` with closed
  `InventoryMovementWrite`, `InventoryReceipt`, and `InventoryRefusal` schemas; per-location
  `mirror` ledger readings on `GET /inventory`; opaque keyset `cursor` (`nextCursor`),
  `updatedSince`, and `limit` / `pageSize` pagination plus `429` (`Retry-After`,
  `X-RateLimit-*`) and `503` rate-limit responses on `GET /catalog/products` and `GET /inventory`;
  clarified `inventory.changed` emission boundary in `asyncapi.yaml`; new synthetic examples under
  `apps/private/contract/examples/inventory.*`; and an "Inventory corrections" guide in
  `apps/private/webhooks-and-api.md` covering delta, replay, conflict, refusal semantics, a
  runnable `curl` example, and the fulfillment write-back boundary.
- `apps/private/samples/fulfillment-connector/` — the first private-app reference sample: a
  runnable, dependency-free Node connector for the fulfillment contract (Content-Digest and
  RFC 9421 webhook verification, CloudEvents dedupe, reconciliation, recipient read, a simulated
  label provider, and label-outcome and handoff evidence under stable `Idempotency-Key`s), with an
  offline demo, simulation flags for an unknown label outcome, a forced retry and a conflicting key
  reuse, and `node:test` suites including a no-contact-in-logs check. `CONTRIBUTING.md` and
  `apps/private/README.md` now admit self-contained reference samples under `apps/private/samples/`.
- The fulfillment connector sample also runs as its own Cloudflare Worker,
  `tot-fulfillment-connector-sample` on `workers.dev`: `worker.js` (a `fetch` handler for
  deliveries and a `scheduled` handler for the reconciliation cron), a `wrangler.toml` with no
  account id or secrets, credentials as Worker secrets, and tests that drive both handlers without
  a socket. The README states that its dedupe and assignment state are per isolate.
- `apps/private/webhooks-and-api.md` "Signature details": the exact webhook signature the platform
  sends (label `sig1`, alg `rsa-v1_5-sha256`, covered components `@method`, `@target-uri`,
  `content-digest`, `created`/`keyid`/`alg` parameters, a `sha-256` Content-Digest), the
  authorization-metadata fields `webhook_signing_keys` and `token_endpoint`, and what a verifier
  MUST accept and reject. The sample's verifier now accepts exactly that.
- Private Apps contract 1.1 (minor, compatible): the fulfillment connector. New scopes
  `fulfillment:process` and `orders:read:recipient`; topics `fulfillment.assignment.created` and
  `fulfillment.assignment.updated`; routes `GET /fulfillment/assignments`,
  `GET /fulfillment/orders/{orderId}/recipient` and
  `POST /fulfillment/orders/{orderId}/shipment-evidence` with closed schemas and the
  `FulfillmentRefusal` code list; both scopes and both topics added to `tot-app.schema.json`.
  New synthetic examples under `apps/private/contract/examples/` and a fulfillment section in
  `apps/private/webhooks-and-api.md`.
- The v2 chrome and chrome-assignment schemas accept `light-collapsible` and `minimal` footer
  variants. The chrome guide documents exact per-page assignments and the compliance-preserving
  minimal presentation.
- Agency Kit free tier: `tools/` (single-page checks — `validate-page.sh`,
  `validate-page-browser.mjs`, `perf-audit.mjs`, `style-concept-audit.mjs`, the style-concept
  manifest schema, Lighthouse helpers, and tests), `docs/dev-loop-reference.md`,
  `docs/shared-chrome.md`, `docs/style-concept-audit.md`, `docs/regulated-compliance.md`, and 13
  developer books under `docs/books/`.
- `schemas/chrome.v2.schema.json` — brings the `chrome.json` schema current with the platform's
  actual `ChromeConfig` contract (`header`/`footer` split, explicit `header.variant`/
  `footer.variant`, a required stable `id` on every nav item, CTA, and footer link). The prior
  `chrome.schema.json` (top-level `nav`/`headerCtas`, `footer.tagline`/`legal`, no ids) had drifted
  from the real platform contract — it does not validate against `validateChromeConfig` in
  `@tot/public-runtime` today and is kept in place, unversioned-in-place, only for the templates
  and snippets already authored against it (`CONTRIBUTING.md`'s "breaking a schema → publish a new
  versioned file" rule). New `chrome.json` content should target v2.
- `schemas/chrome-assignments.schema.json` — schema for the previously-undocumented
  `content/chrome-assignments.json` (per-page `headerVariant`/`footerVariant` overrides for
  raw-HTML pages), matching `validateChromeAssignments` in `@tot/public-runtime`.
- `snippets/chrome/tokenoftrust-chrome.json` and `tokenoftrust-chrome-assignments.json` — a real,
  complete worked example (tokenoftrust.com's own chrome + a per-page header override on its
  Contact Sales + thank-you pages), validated against v2/chrome-assignments.

### Known gap (not fixed in this change)
- `templates/commerce-minimal`, `templates/marketing-minimal`, `templates/regulated-vape`, and
  `snippets/chrome/footer.json`/`mega-menu.json` are still authored against the legacy v1 schema
  and have not been migrated to v2 — they do not reflect what the real platform currently accepts
  for `content/chrome.json`. Tracked as follow-up work, not addressed here to keep this change
  scoped to the schema fix + new reference example.

### Changed
- Added `apps/` as the public app-developer front door. It directs developers to the available
  private-app contract, preserves the stable `private-apps/` path, and reserves (without claiming)
  a future public-app track.
- Clarified that the devkit is the public, source-free developer deliverable. It does not publish
  an npm library or platform runtime; private apps remain language-neutral and contract-first.
- Established this repository's GitHub-relative `apps/` and `private-apps/` material as the
  canonical public documentation for developers and LLMs. The ToT MCP recipe is a pointer/index.
- Added the source-safe private-app contract corpus under `apps/private/`: manifest schema, scope
  catalog, forbidden-scope denylist, OpenAPI/AsyncAPI definitions, synthetic fixtures, and concise
  webhook/API guidance. Kept operator material, platform source, credentials, tenant data, and npm
  package/runtime code out of the public devkit.

## [0.1.0] — first pass

### Added
- Repo structure, `README.md`, `AGENTS.md`, `llms.txt`, `manifest.json`, `CONTRIBUTING.md`.
- Editor config (`.vscode/settings.json`) wiring schemas to tenant files.
- JSON Schemas: `theme`, `chrome`, `home` (block-palette@3), `scripts`, `capabilities`,
  `compliance`, `tot-config`.
- Templates: `commerce-minimal`, `marketing-minimal`, `regulated-vape`.
- Snippets: blocks, chrome, compliance, product-sources, theme-presets.
- Widget example: `loyalty-signup` (sandboxed).
- Recipes: `enable-pact-compliance`, `add-subscription-option`.
- CI: GitHub Actions validate gate.
- Agent kit: drop-in `AGENTS.md` template + prompt recipes.
- Migration: visual-parity port method.
- Industries: by-vertical guide (vape/nicotine, wine & spirits, hemp/CBD, firearms, marketplaces)
  with per-vertical compliance snippets, mapping each to templates and Token of Trust products,
  and linking back to storefront.tokenoftrust.store and tokenoftrust.com.
- Licensing: `LICENSE` (Apache-2.0) + `NOTICE` clarifying the license covers only the tenant-side
  devkit and NOT the separately-licensed platform runtime, plus a trademark note. README license
  section updated.
- Discoverability: `docs/DISCOVERABILITY.md` (GitHub-native SEO signals, backlinks, the robots.txt
  truth for repos vs Pages) and an optional `site/` GitHub Pages landing (`robots.txt`,
  `sitemap.xml`, `index.html` with meta/OpenGraph/JSON-LD) — inert until Pages is enabled.
- Private-apps track: `private-apps/README.md` — the second track (app developers), linking to the
  canonical shipped material (devbook `recipe://storefront-private-apps-devbook`, the contract, the
  affiliate reference app, the `tot app` CLI) rather than duplicating it. Clarifies the boundary
  between tenant `scripts.json` widgets and private-app widget launches.
- Devbook-driven gap fills: `snippets/checkout/` (cart-drawer brand override; checkout stays
  platform-owned), `snippets/seo/` (per-page `seoTitle`/`seoDescription`), and
  `docs/store-performance-seo.md` (what the platform gives you free vs. the levers you control) —
  so the commerce-checkout and performance-SEO devbooks have runnable backing examples.
