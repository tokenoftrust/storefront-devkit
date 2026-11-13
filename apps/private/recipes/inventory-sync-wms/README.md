# Recipe: Multi-Location WMS Inventory Sync (`inventory-sync-wms`)

**Target systems:** Multi-location warehouse management systems (WMS), ERP stock masters, and custom multi-warehouse inventory connectors.

**Scopes required (`tot-app.json`):** `catalog:read`, `inventory:read`, `inventory:write`

This recipe demonstrates how a multi-location Warehouse Management System (WMS) synchronizes stock
locations, reconciles absolute on-hand counts with Compare-And-Swap (`expectedVersion`), records
atomic batches of WMS stock movements, and processes `inventory.changed` threshold transitions.

---

## Day-1 Cutover vs. Continuous WMS Sync

1. **Day-1 initial stock import (certified migration agencies):**
   Before cutover, migration engineers can seed baseline on-hand inventory from a merchant's legacy
   commerce or WMS CSV export using the Agency Kit CLI (`agency-kit/tools/import-stock.mjs`) or seed
   a preview store directly via:
   ```bash
   tot catalog seed --preset=multi-warehouse
   tot preview
   ```
2. **Continuous delta & cycle-count sync (Private App):**
   Once installed, the WMS connector keeps the tenant's mirror ledger current through the Private
   Apps v1.3 inventory endpoints below. All writes into `/api/apps/v1/inventory/*` are
   merchant-consented mirror-ledger observations — they never bypass checkout, tax, or compliance
   gates.

---

## Contract Surfaces Demonstrated

### 1. Multi-location registry (`GET` / `PUT /api/apps/v1/inventory/locations/{locationId}`)

Declare each warehouse, 3PL, dropship vendor, or retail store before posting stock to it:

```bash
curl -sS -X PUT "${TOT_GATEWAY_URL}/inventory/locations/wh-east-nj" \
  -H "Authorization: Bearer ${TOT_APP_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "East Coast Warehouse (NJ)",
    "kind": "warehouse",
    "isFulfillable": true,
    "status": "active"
  }'
```

- `isFulfillable: false` keeps a location writable (e.g. quarantine/QA staging) while excluding its
  balance from storefront availability.
- `status: "archived"` preserves historical ledger audit rows while removing the location from
  availability and refusing new movements.

### 2. Absolute on-hand reconciliation with CAS (`PUT /api/apps/v1/inventory/levels`)

Use `PUT /inventory/levels` (1..250 items per request) for nightly or hourly cycle-count
reconciliation. Supplying `expectedVersion` guards against concurrent writes; on a `409 version_conflict`
refusal, re-read `GET /inventory?sku=<sku>&locationId=<locationId>` and retry with the fresh version:

```bash
curl -sS -X PUT "${TOT_GATEWAY_URL}/inventory/levels" \
  -H "Authorization: Bearer ${TOT_APP_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: wms-reconcile-20261113-001" \
  -d '{
    "items": [
      {
        "sku": "VAPE-MOD-PRO-200",
        "locationId": "wh-east-nj",
        "onHand": 50,
        "observedAt": "2026-11-13T14:04:00.000Z"
      }
    ]
  }'
```

### 3. Batch WMS movements (`POST /api/apps/v1/inventory/movements`)

Record 1..250 discrete warehouse transactions atomically with `Idempotency-Key`. The connector maps
WMS transactions (`receive`, `pick`, `cycle_count`, `damage`, `transfer_in`, `transfer_out`,
`return_restock`) onto the contract's `InventoryMovementReason` enum (`received`, `picked`,
`cycle_count`, `damaged`, `transfer`, `restock`, `adjustment`). If any item in a batch fails
validation (such as `422 unknown-sku` or `409 balance-out-of-range`), the entire batch is refused
atomically and identifies the failing item's `index`.

### 4. `inventory.changed` threshold transitions (`low_stock`, `out_of_stock`, `back_in_stock`)

Every committed ledger change emits a signed `com.tokenoftrust.storefront.inventory.changed`
CloudEvent ([fixture](./fixtures/inventory.changed.cloudevent.json)) carrying `sku`, `locationId`,
`balance`, `available`, and `asOf`. The connector deduplicates on the CloudEvents `id` and evaluates
availability transitions (`steady` $\rightarrow$ `low_stock` $\rightarrow$ `out_of_stock` $\rightarrow$ `back_in_stock`).

---

## Staging a `private_key_jwt` Production Candidate

Developers with `preview-access` or `ship-on-behalf` test in `env="test"` first, then stage a
key-bound `production` candidate (`status: "pending_approval"`) for 1-click Store Owner approval:

```bash
# Stage the production candidate using the jwksUri declared in tot-app.json:
curl -sS -X POST "https://<tenant>.tokenoftrust.store/api/apps/admin/candidates" \
  -H "Authorization: Bearer ${TOT_ADMIN_TOKEN}" \
  -H "X-Tot-Tenant: <tenant>" \
  -H "X-Tot-Caller-Capability: ship-on-behalf" \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{
  "appId": "com.example.wms-inventory-sync",
  "appVersion": "1.3.0",
  "scopes": ["catalog:read", "inventory:read", "inventory:write"],
  "manifest": {
    "contractVersion": "1",
    "id": "com.example.wms-inventory-sync",
    "name": "Multi-Location WMS Inventory Sync",
    "version": "1.3.0",
    "owner": { "name": "Example WMS Integrations", "email": "wms-ops@integrations.example.com" },
    "installMode": "external",
    "scopes": ["catalog:read", "inventory:read", "inventory:write"],
    "clientAuth": {
      "method": "private_key_jwt",
      "jwksUri": "https://wms.integrations.example.com/.well-known/jwks.json"
    }
  }
}
EOF
```

The Store Owner reviews the staged candidate in `/admin#integrations` and approves it in 1 click
(`POST /api/apps/admin/candidates/decide`). No shared client secret ever exists in production.

---

## Run Offline Verification

```bash
node index.mjs --self-test
npm test
```
