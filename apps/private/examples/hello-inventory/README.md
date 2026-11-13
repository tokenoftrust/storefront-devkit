# Hello Inventory — Starter Private App

A minimal, dependency-free starter reference app for **Storefront Private Apps v1.3**. Use this
example when you are building your first private app or a lightweight merchant script that declares
stock locations, reads catalog/inventory availability, posts idempotent stock adjustments/movements,
and verifies behavior against synthetic preview orders.

## Scopes requested (`tot-app.json`)

- `catalog:read` — read published catalog products (`GET /api/apps/v1/catalog/products`).
- `inventory:read` — read stock locations (`GET /api/apps/v1/inventory/locations`), per-location
  mirror-ledger balances (`GET /api/apps/v1/inventory`), and `inventory.changed` webhooks.
- `inventory:write` — declare stock locations (`PUT /api/apps/v1/inventory/locations/{locationId}`)
  and record idempotent stock movements/adjustments (`POST /api/apps/v1/inventory/movements`).
- `orders:read:minimal` — read minimized order lists (`GET /api/apps/v1/orders`) to verify
  synthetic preview orders without accessing raw customer PII.

## Contract surfaces exercised

| Step | Endpoint | Purpose |
|---|---|---|
| 1. Declare location | `PUT /api/apps/v1/inventory/locations/{locationId}` | Upserts an active `warehouse` location (`loc-main-warehouse`) for the routed stage. |
| 2. List locations | `GET /api/apps/v1/inventory/locations` | Confirms `loc-main-warehouse` and `unspecified` are active. |
| 3. Read stock | `GET /api/apps/v1/inventory?sku=...&locationId=...` | Reads availability and the `mirror` ledger balance at `loc-main-warehouse`. |
| 4. Adjust stock | `POST /api/apps/v1/inventory/movements` | Posts an idempotent delta (`quantityDelta`, `reason: "adjustment"`) with `Idempotency-Key` and replays the same key to confirm receipt stability. |
| 5. Synthetic preview order | `POST /api/apps/admin/test-orders` $\rightarrow$ `GET /api/apps/v1/orders` | Creates a synthetic order in the `preview` ledger (`action: "create"`) and reads it back through `/orders` on the preview stage. |

## Self-serve preview workflow (`env="test"`)

Developers holding `preview-access` or `ship-on-behalf` on a store can run the entire preview loop
without waiting for store-owner approval:

```bash
# 1. Seed the preview catalog with general sample products and stock:
tot catalog seed --store <tenant> --preset=general

# 2. Validate tot-app.json against the contract schema and self-serve install in test mode:
tot app validate ./tot-app.json
tot app install --store <tenant> --env=test --manifest ./tot-app.json

# 3. Create a synthetic preview order on the preview gateway:
curl -sS -X POST "https://tot-preview.tokenoftrust.store/api/apps/admin/test-orders" \
  -H "Authorization: Bearer ${TOT_ADMIN_TOKEN}" \
  -H "X-Tot-Tenant: <tenant>" \
  -H "X-Tot-Caller-Capability: preview-access" \
  -H "Content-Type: application/json" \
  -d '{"action":"create"}'
```

The stage wall guarantees isolation: tokens minted on the preview gateway carry `env: "test"` and
only reach the `preview` ledger. Attempting to use a `test` token on a live publication host answers
`403 {"error":"stage_mismatch","code":"stage_mismatch"}`.

## Run offline verification

```bash
node index.mjs --self-test
npm test
```

## Files

| File | Purpose |
|---|---|
| [`tot-app.json`](./tot-app.json) | Valid Private Apps v1 manifest requesting `catalog:read`, `inventory:read`, `inventory:write`, and `orders:read:minimal`. |
| [`index.mjs`](./index.mjs) | Runnable starter client + offline gateway simulator (`--self-test`). |
| [`fixtures/sample-workflow.json`](./fixtures/sample-workflow.json) | Synthetic location, SKU, and movement payloads. |
| [`test/hello-inventory.test.mjs`](./test/hello-inventory.test.mjs) | `node:test` verification suite. |
| [`meta.json`](./meta.json) | Devkit asset metadata for `manifest.json`. |
