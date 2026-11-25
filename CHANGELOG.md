# Changelog

All notable changes to the Storefront Devkit. Format loosely follows Keep a Changelog.

## Unreleased

### Changed
- Contract: `x-tot-status` is replaced by `x-tot-maturity` in `openapi.yaml`, `asyncapi.yaml` and `scopes.json`: `alpha` for implemented, `concept` for planned shapes and seams.
- Contract: `orders:read-holds` scope and `GET /orders/holds` (held orders with a closed-vocabulary reason, opaque page-scoped
  references, no order id or customer field), mirrored from the Storefront runtime that serves it.
- Scope ids `orders:read:minimal`, `customers:read:minimal` and `orders:read:recipient` are now
  `orders:read-minimal`, `customers:read-minimal` and `orders:read-recipient` (one colon: `<resource>:<action>`),
  matching the Storefront runtime vocabulary. The contract, every example, recipe and sample manifest, and the
  docs use the new ids; a manifest naming an old id is refused by the token issuer.
- `apps/private/examples/hello-inventory/` is now `apps/private/examples/inventory-fulfillment-e2e/` (app id
  `com.example.inventory-fulfillment-e2e`): it is an end-to-end test of the inventory and fulfillment APIs, not a
  starter UI. New `npm run e2e`: a captioned run on a store preview that also drives the connector-starter
  inventory-sync and dropship apps (signed `inventory.changed` webhooks, a split shipment, hold and cancel).

### Added
- `apps/private/examples/connector-starter/` — three runnable private-app connectors (label station, multi-supplier
  dropship, inventory/WMS sync) against in-process mocks of their outside systems, run end to end on a store preview
  with `env=test` installs and synthetic orders: preflight `doctor`, a `tot app test-order` helper, and a webhook
  server verifying signatures through vendored connector-kit. Tests run in `npm run check`.
- The three private-app recipes and `hello-inventory` vendor connector-kit at `vendor/connector-kit/` and make
  their calls through `ApiClient` (and `ConnectorAuthClient`, `WebhookReceiver` where the app authenticates or
  receives); `packages/connector-kit/scripts/vendor.mjs` syncs the copies and `--check` (CI:
  `ci/github-actions/connector-kit-vendor.yml`, and `npm run check`) refuses a drifted copy.
- `packages/connector-kit/` (`KIT_VERSION` 1.0.0) — vendored source kit for private-app connectors,
  copied into a project and never published: `ConnectorAuthClient` (`client_secret_basic`,
  `client_secret_post`, `private_key_jwt` with RS256/ES256 assertions; cached token with early
  refresh), `WebhookReceiver` (Content-Digest, RFC 9421 `sig1`, `created` window, keyid lookup in
  the published `webhook_signing_keys`, replay guard through an injectable seen-event store) and
  `ApiClient` (`Idempotency-Key` on every write and reused on retry, `Retry-After` honored, bounded
  backoff, cursor pagination with `updatedSince`), with one error model. Zero dependencies; Node 20+
  and fetch-based edge runtimes. Its tests run in `npm run check`.
- Private Apps contract 1.3.0 (minor, compatible) and 4 runnable reference recipes/examples:
  - Machine contracts synced to `1.3.0` (`apps/private/contract/{openapi.yaml, asyncapi.yaml,
    scopes.json, tot-app.schema.json, forbidden-scopes.json}`): 11 V1 scopes (`catalog:read`,
    `orders:read:minimal`, `orders:webhook`, `customers:read:minimal`, `inventory:read`,
    `inventory:write`, `reports:read`, `attribution:write`, `widgets:launch`,
    `fulfillment:process`, `orders:read:recipient`), multi-location inventory (`GET/PUT
    /inventory/locations/{locationId}`), compare-and-swap level reconciliation (`PUT
    /inventory/levels` with `expectedVersion`), batch movement writes with WMS reason codes (`POST
    /inventory/movements`), carrier capability discovery (`GET /fulfillment/carriers` with PACT and
    adult-signature metadata), location-keyed fulfillment assignments with 1:N split shipments
    (`POST /fulfillment/assignments/{assignmentId}/shipments`) and exception reporting (`POST
    /fulfillment/assignments/{assignmentId}/exceptions`), `order.partially_fulfilled` and
    `label-voided` recovery, `private_key_jwt` authentication, self-serve preview order generation
    (`POST /api/apps/admin/test-orders`), and production candidate staging (`POST
    /api/apps/admin/candidates`).
  - `apps/private/hosting/` (`index.json`, `README.md`, `cloudflare-workers/`, `aws-lambda/`,
    `google-cloud-run/`, `microsoft-azure-functions/`, `containers-and-tunnels/`) — extensible
    multi-tenant routing guide (`tenantid`, `appinstallid`) and runtime deployment fast-paths across
    Cloudflare Workers, AWS Lambda, Google Cloud Run & Functions, Microsoft Azure Functions &
    Container Apps, Docker containers, pull-only scheduled jobs, and local preview tunnels.
  - `apps/private/examples/hello-inventory/` — starter private app demonstrating location
    registration, stock reads, idempotent movement writes, and synthetic preview orders.
  - `apps/private/recipes/inventory-sync-wms/` — multi-location WMS connector recipe
    demonstrating location upsert, `PUT /inventory/levels` CAS
    reconciliation, batch WMS movement writes across all 7 reason codes, and `inventory.changed`
    threshold transition handling (`low_stock`, `out_of_stock`, `back_in_stock`).
  - `apps/private/recipes/fulfillment-label-station/` — shipping & PACT label station connector recipe
    demonstrating assignment webhooks/reconciliation, recipient
    hydration, PACT carrier validation (refusing USPS with `422 pact_carrier_ineligible`), 1:N split
    cartons, and `label-voided` recovery.
  - `apps/private/recipes/dropship-multi-supplier/` — 3PL & multi-supplier routing connector recipe
    demonstrating Stone 1 location-keyed processor
    coexistence, partial line shipments (`order.partially_fulfilled` → `order.fulfilled`), and
    exception reporting (`backordered`, `cannot_fulfill`, `address_undeliverable`), plus Stone 2
    multi-supplier cart auto-split planning.
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
- `block-palette@7`: hero `notice` — a short plain-text status pill above the eyebrow. An
  `editorial` block with neither `image` nor `imageSeed` renders as a single text column.
  `home.schema.json` now also describes the hero's `headlineAccent`, `featureCollection`,
  `imageAlt` and `slides`, and the editorial block's real fields (`body_html`, `image`,
  `imageAlt`, `imageSeed`, `align`, `eyebrow`, CTA).
- `theme.schema.json`: `type.headings` (`hero`/`h1`/`h2`/`h3` fixed sizes for matching a source
  site's headings), `color.hero-eyebrow`, `brand.heroVariant`, `brand.headerVariant`,
  `shape.tapTarget`, and the optional interaction/conversion colours (`focus-ring`, `disabled`,
  `disabled-contrast`, `field-border`, `star`, `cta`, `cta-hover`, `cta-contrast`, `trust`) the
  platform already accepts. `brand.motion` no longer offers `none`, which the platform refuses.
  `$schema`/`_note` meta keys validate.
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
