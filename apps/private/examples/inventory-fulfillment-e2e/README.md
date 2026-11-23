# Inventory & Fulfillment API E2E

An end-to-end test of the **Storefront Private Apps 1.4** inventory and fulfillment APIs
(`apps/private/contract/openapi.yaml` 1.4.0, connector-kit 1.1.0). Dependency-free, in three
layers:

- `npm test` / `--self-test` — offline, against a contract-shaped simulated gateway: quarantine
  location, atomic WMS movement batch, absolute level reconciliation, sales-velocity report, signed
  `inventory.changed` webhooks, synthetic preview orders.
- `--live` — the same inventory calls against your own test install on a store preview.
- `npm run e2e` — a captioned run on a store preview that also drives the
  [`../connector-starter/`](../connector-starter/) apps: WMS changes coming back as signed webhooks,
  a synthetic order shipped in two cartons (`order.partially_fulfilled`, then `order.fulfilled`), and
  an order held then cancelled. See [End-to-end run](#end-to-end-run-npm-run-e2e).

It is a test and reference for the API calls, not a merchant-facing app; start a connector from
[`../connector-starter/`](../connector-starter/).

## Scopes requested (`tot-app.json`)

- `catalog:read` — read published catalog products (`GET /api/apps/v1/catalog/products`).
- `inventory:read` — read stock locations (`GET /api/apps/v1/inventory/locations`), per-location
  mirror-ledger balances (`GET /api/apps/v1/inventory`), and `inventory.changed` webhooks.
- `inventory:write` — declare stock locations (`PUT /api/apps/v1/inventory/locations/{locationId}`),
  record movement batches (`POST /api/apps/v1/inventory/movements`) and reconcile absolute levels
  (`PUT /api/apps/v1/inventory/levels`).
- `orders:read-minimal` — read minimized order lists (`GET /api/apps/v1/orders`) to verify
  synthetic preview orders without raw customer PII.
- `reports:read` — read the aggregate `sales-velocity` snapshot (`GET /api/apps/v1/reports`).

## Contract surfaces exercised

1. **Quarantine location** — `PUT /inventory/locations/{locationId}` with `isFulfillable: false`.
   Stock there is writable and stays in the ledger (auditable) but never counts toward shopper
   availability. Preview test locations default to `isFulfillable: false`, so a shared preview
   store's availability is never polluted.
2. **Atomic WMS batch** — `POST /inventory/movements` with `{ "items": [...] }` (1..250 items, each
   with a `reason`: `received`, `damaged`, `cycle_count`, `adjustment`, ...). `201` answers
   `{ receiptId, asOf, items: [{ sku, locationId, quantityDelta, reason, balance }] }`. One refused
   item refuses the whole batch and names it: a `422 unknown-sku` arrives as `ApiError` with
   `index` (the item) and `field` (`sku`). The `Idempotency-Key` comes from connector-kit's
   `deriveIdempotencyKey`, so a retry after a lost answer replays the same receipt.
3. **Absolute reconciliation** — `PUT /inventory/levels` with `{ "items": [{ sku, locationId, onHand, observedAt }] }`.
   The first observation writes the drift as a `reconcile` movement (`quantityDelta` ≠ 0); the next
   observation of the same count writes `quantityDelta: 0`. A new observation needs a new
   `observedAt`: the same body under the same key is a replay of the first receipt.
4. **Availability read** — `GET /inventory?sku=...&locationId=...`: `mirror.balance` is that
   location's ledger reading and keeps the quarantined count. `available`, `quantity` and `policy` are
   the SKU's store-wide shopper availability, which quarantined stock never adds to. In `--self-test`
   the SKU has no other stock, so `available` is `false`; on a real store it can be `true` from stock
   held at fulfillable locations.
5. **Synthetic preview order** — created with `tot app test-order create`, read back with `GET /orders`.
6. **EOM velocity snapshot** — `GET /reports?windowDays=30`: per SKU `soldUnits`, `unsoldUnits`,
   `velocityPerDay`, `daysOfCover` (`null` when nothing sold).
7. **Signed `inventory.changed`** — `WebhookReceiver` + `AuthorizationMetadata` verify the
   RFC 9421 signature against the store's published keys and answer a redelivered event id with
   `200 {"accepted":true,"duplicate":true}`; the app then applies
   `data` only when its `asOf` is newer than the last one applied for that (`sku`, `locationId`),
   so a late, older delivery cannot overwrite a newer balance.

Errors: every refusal resolves `{ status, ok: false, body: { code, holds?, field?, index?, reasons? }, requestId? }`
straight from connector-kit's `ApiError`; quote `requestId` when you report a problem.

## Self-serve preview workflow (`env=test`)

Developers holding `preview-access` on a store can run the preview loop without store-owner
approval (CLI 7.5.5 or later):

```bash
# 1. Lint tot-app.json offline:
tot app validate .

# 2. Self-serve install in test mode (prints the client id and secret once):
tot app install --tenant <tenant> --env=test --app .

# 3. Bind your install, then create a synthetic preview order at your test location:
tot app test-order bind <installId> --tenant <tenant> --location loc-main-warehouse
tot app test-order create --tenant <tenant> --location loc-main-warehouse
```

Conformance certification needs a running webhook receiver, which this example does not start (its
`--self-test` verifies signed deliveries offline). Run the inventory-sync app in
[`../connector-starter/`](../connector-starter/) with `TOT_METADATA_ORIGIN=http://127.0.0.1:37891`
(so it reads the conformance run's RS256 key) and certify it:

```bash
tot app conformance --url http://127.0.0.1:8787/webhooks --archetype inventory-sync \
  --app-id com.example.inventory-sync-starter --certify --receipt ./conformance-inventory-sync.json
```

`test-order create` also takes `--line <sku>:<qty>` (repeatable), `--quantity <n>` and
`--region <state>`. Tokens minted on the preview host carry `env: "test"` and only reach the
`preview` ledger; a `test` token on a live publication host answers `403 stage_mismatch`.

## Run it

```bash
# Offline: simulated gateway, no network, no credentials.
node index.mjs --self-test
npm test

# Live: your own test install on the preview host.
export TOT_STOREFRONT_ORIGIN=https://storefront.tokenoftrust.store   # default
export TOT_TENANT=<tenant>            # e.g. the store domain
export TOT_CLIENT_ID=<client id from tot app install>
export TOT_CLIENT_SECRET=<client secret from tot app install>
# optional: TOT_SKU (defaults to the first inventory SKU), TOT_LOCATION_ID (defaults to loc-main-warehouse)
node index.mjs --live --cleanup
```

`--live` declares the location with `isFulfillable: false`, posts one four-reason batch for one
SKU, reconciles twice, reads inventory, the velocity report and orders, and logs one JSON line per
step (never a credential). `--cleanup` sets that SKU's balance at the test location back to 0 and
archives the location. Always use `--cleanup` on a shared store preview.

## End-to-end run (`npm run e2e`)

One captioned run, step by step, against a store **preview** (CLI 7.5.5 or later, signed in):

1. **Inventory API** — this example's `--live` calls with a caption per step, then cleanup.
2. **Inventory changes** — the connector-starter inventory-sync app with its mock WMS: a receive (+12)
   and a pick (-2) become reason-coded movement batches, the recount shows drift 0, and Storefront
   confirms each change with a signed `inventory.changed` webhook. Then `--cleanup`.
3. **Fulfilment with a split shipment** — the dropship app is bound to its own preview location; a
   synthetic 2-unit order goes to the mock supplier as a purchase order and ships in two cartons,
   each reported with `POST /fulfillment/assignments/{id}/shipments`.
4. **Hold and cancel** — a second order is held, then cancelled; the app holds, then cancels, the
   supplier purchase order and nothing ships.

Set up once:

```bash
# this example's own test install (prints the secret once): copy .env.example to .env and fill it
tot app install --app . --env test --tenant <store>
# a tunnel to the local webhook port, e.g.
cloudflared tunnel --url http://127.0.0.1:8787
# the connector-starter inventory-sync and dropship test installs (their apps/<app>/.env),
# with the tunnel as their webhook endpoint:
tot app update <installId> --app ../connector-starter/apps/<app> --webhook-endpoint <tunnel>/webhooks --tenant <store>
```

Then `npm run e2e` (or `npm run e2e -- --only inventory-api|inventory-sync|fulfilment|hold`,
`--pause <seconds>`, `--help`). Preview webhooks can take up to about a minute; the run shows a
counter while it waits. Afterwards set the endpoints back with `--webhook-endpoint none`.

What it does not cover: one cart split across two suppliers or locations. `tot app test-order create`
takes a single `--location`, so that case cannot be set up on a preview yet.

## Files

- [`tot-app.json`](./tot-app.json) — Private Apps v1 manifest (five scopes, `inventory.changed` webhook).
- [`index.mjs`](./index.mjs) — the client, the `inventory.changed` mirror, the offline gateway
  simulator, `--self-test` and `--live`.
- [`e2e.mjs`](./e2e.mjs) — `npm run e2e`: the captioned preview run, including the
  connector-starter inventory-sync and dropship apps.
- [`.env.example`](./.env.example) — settings for `npm run e2e`.
- [`fixtures/sample-workflow.json`](./fixtures/sample-workflow.json) — quarantine location, SKUs,
  opening balances, the four-reason batch and the levels observation.
- [`test/inventory-fulfillment-e2e.test.mjs`](./test/inventory-fulfillment-e2e.test.mjs) — `node:test` suite.
- [`test/webhook-signer.mjs`](./test/webhook-signer.mjs) — test-only signer standing in for the
  gateway; a production app only verifies.
- [`meta.json`](./meta.json) — Devkit asset metadata for `manifest.json`.

## Vendored connector-kit

`vendor/connector-kit/` is a byte-identical copy of [`packages/connector-kit/src`](../../../../packages/connector-kit/).
`index.mjs` gets its token from `ConnectorAuthClient` (`client_secret_post`, `tenant` option) and
makes every call through `ApiClient` (`tenant` option, `Idempotency-Key`, `Retry-After`, bounded
backoff). Do not edit it. Refresh every copy with `node packages/connector-kit/scripts/vendor.mjs`;
CI runs `node packages/connector-kit/scripts/vendor.mjs --check` and refuses a copy that differs.
