# Recipe: 3PL & Multi-Vendor Dropship Routing (`dropship-split-duoplane`)

**Target systems:** Duoplane, DSCO, Logicbroker, multi-warehouse 3PL routers, and dropship vendor portals.

**Scopes required (`tot-app.json`):** `orders:read:minimal`, `orders:read:recipient`, `orders:webhook`, `fulfillment:process`, `inventory:read`, `inventory:write`

This recipe demonstrates how a multi-vendor dropship or 3PL connector integrates with Storefront
Private Apps v1.3 across both **Stone 1 (Live)** — location-keyed processor coexistence, partial PO
line shipments, and line-level exceptions — and **Stone 2 (Contract Locked)** — multi-vendor
single-cart auto-split across distinct `(appInstallId, locationId)` processor pairs.

---

## Stone 1 (Live) vs. Stone 2 (Contract Locked)

### Stone 1 — Location-Keyed Processor Coexistence (Live Today)

1. **Per-location processor binding (`(tenant_id, stage, location_id)`):**
   Multiple fulfillment processors can coexist on a single tenant and stage, each bound to its own
   `locationId` (with `*` / `unspecified` serving as the catch-all processor). For example, an
   in-house ShipStation install can handle `wh-house-tx` while a Duoplane install handles
   `vendor-west-ca`.
2. **Assignment lines & location routing (`GET /api/apps/v1/fulfillment/assignments`):**
   Each `FulfillmentAssignment` carries `locationId`, `allowedCarriers`, `adultSignatureRequired`,
   and `lines[]` (`lineId`, `sku`, `locationId`, `quantity`, `shipped` / `fulfilledQuantity`,
   `cancelled` / `cancelledQuantity`, `remaining`).
3. **Partial line shipments (`POST /api/apps/v1/fulfillment/assignments/{assignmentId}/shipments`):**
   When a vendor ships a subset of the assigned lines (or partial quantities of a line), the
   platform records the shipment against the line's `remaining` quantity and emits
   `order.partially_fulfilled` (`complete: false`). When the final open unit ships in a subsequent
   carton, the platform transitions the order to fulfilled and emits `order.fulfilled` once
   (`complete: true`).
4. **Processor line exceptions (`POST /api/apps/v1/fulfillment/assignments/{assignmentId}/exceptions`):**
   When a dropship vendor or 3PL cannot ship a line, it reports an exception (`backordered`,
   `cannot_fulfill` / `vendor_rejected`, `out_of_stock`, `damaged`, `address_undeliverable`,
   `carrier_refused`) with `lines[]` and an optional operational `note` (never customer PII). The
   exception surfaces on the Storefront operator desk for resolution without silently mutating
   payment or tax.

### Stone 2 — Multi-Vendor Single-Cart Auto-Split (Contract Locked)

When a single customer cart contains items sourced from multiple distinct `(appInstallId, locationId)`
pairs (for example, one in-house warehouse SKU fulfilled by ShipStation and one dropship SKU
fulfilled by Duoplane), the Stone 2 routing model partitions the order at release time into
independent, versioned line assignments per `(appInstallId, locationId)` pair:

- Each processor sees and acts only on its own assigned lines (`GET /fulfillment/assignments`).
- Partial shipments from any vendor emit `order.partially_fulfilled`; `order.fulfilled` fires once
  every assignment on the order has shipped its remaining open quantity.
- Contact privacy holds identically: no customer PII appears in `fulfillment.assignment.*` webhooks
  or PO assignment lists; each processor hydrates the ship-to address through the audited,
  consent-gated `GET /fulfillment/orders/{orderId}/recipient` endpoint.

---

## Self-Serve Multi-Warehouse Preview Loop (`env="test"`)

```bash
# 1. Inside a cloned store checkout, seed the preview catalog with multi-warehouse locations and stock:
tot catalog seed --preset=multi-warehouse
tot preview

# 2. Validate and install the Duoplane routing connector in test mode:
tot app dev validate ./tot-app.json
tot app install --tenant <tenant> --env=test --app .

# 3. Bind the test install, create a synthetic preview order, and release it:
curl -sS -X POST "https://tot-preview.tokenoftrust.store/api/apps/admin/test-orders" \
  -H "Authorization: Bearer ${TOT_ADMIN_TOKEN}" \
  -H "X-Tot-Tenant: <tenant>" \
  -H "X-Tot-Caller-Capability: preview-access" \
  -H "Content-Type: application/json" \
  -d '{"action":"bind","installId":"<installId>"}'
```

---

## Run Offline Verification

```bash
node index.mjs --self-test
npm test
```
