# Hello Inventory — Starter Private App

A minimal, dependency-free starter reference app for **Storefront Private Apps 1.4**
(`apps/private/contract/openapi.yaml` 1.4.0, connector-kit 1.1.0). Copy it when you build an
inventory or WMS connector: it declares a quarantine stock location, posts atomic WMS movement
batches, reconciles absolute on-hand levels, reads the sales-velocity report, verifies signed
`inventory.changed` webhooks, and checks synthetic preview orders.

## Scopes requested (`tot-app.json`)

- `catalog:read` — read published catalog products (`GET /api/apps/v1/catalog/products`).
- `inventory:read` — read stock locations (`GET /api/apps/v1/inventory/locations`), per-location
  mirror-ledger balances (`GET /api/apps/v1/inventory`), and `inventory.changed` webhooks.
- `inventory:write` — declare stock locations (`PUT /api/apps/v1/inventory/locations/{locationId}`),
  record movement batches (`POST /api/apps/v1/inventory/movements`) and reconcile absolute levels
  (`PUT /api/apps/v1/inventory/levels`).
- `orders:read:minimal` — read minimized order lists (`GET /api/apps/v1/orders`) to verify
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

## Files

- [`tot-app.json`](./tot-app.json) — Private Apps v1 manifest (five scopes, `inventory.changed` webhook).
- [`index.mjs`](./index.mjs) — the client, the `inventory.changed` mirror, the offline gateway
  simulator, `--self-test` and `--live`.
- [`fixtures/sample-workflow.json`](./fixtures/sample-workflow.json) — quarantine location, SKUs,
  opening balances, the four-reason batch and the levels observation.
- [`test/hello-inventory.test.mjs`](./test/hello-inventory.test.mjs) — `node:test` suite.
- [`test/webhook-signer.mjs`](./test/webhook-signer.mjs) — test-only signer standing in for the
  gateway; a production app only verifies.
- [`meta.json`](./meta.json) — Devkit asset metadata for `manifest.json`.

## Vendored connector-kit

`vendor/connector-kit/` is a byte-identical copy of [`packages/connector-kit/src`](../../../../packages/connector-kit/).
`index.mjs` gets its token from `ConnectorAuthClient` (`client_secret_post`, `tenant` option) and
makes every call through `ApiClient` (`tenant` option, `Idempotency-Key`, `Retry-After`, bounded
backoff). Do not edit it. Refresh every copy with `node packages/connector-kit/scripts/vendor.mjs`;
CI runs `node packages/connector-kit/scripts/vendor.mjs --check` and refuses a copy that differs.
