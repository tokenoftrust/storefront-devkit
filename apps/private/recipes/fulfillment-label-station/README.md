# Recipe: Shipping & Label Station Connector (`fulfillment-label-station`)

**Target systems:** Shipping & label stations, multi-carrier rate/label desks, and regional/PACT Act fulfillment workflows.

**Scopes required (`tot-app.json`):** `orders:read:minimal`, `orders:read:recipient`, `orders:webhook`, `fulfillment:process`

This recipe demonstrates how an external shipping/label station connects to Storefront Private Apps
v1.3 to receive order release assignments, hydrate the consent-gated ship-to recipient, validate
carrier eligibility against `GET /fulfillment/carriers` (including PACT Act & `adultSignature`
rules across national and regional carriers), and report either **1:N split-carton shipments**
(`POST /fulfillment/assignments/{assignmentId}/shipments`) or **whole-order shipment evidence**
(`POST /fulfillment/orders/{orderId}/shipment-evidence` with `label-outcome`, `label-voided`, and `handoff`).

> **Companion sample:** For a complete HTTP server + Cloudflare Worker implementation of RFC 9421
> webhook signature verification and preview-cookie transport, see
> [`../../samples/fulfillment-connector/`](../../samples/fulfillment-connector/).

---

## Contract Surfaces Demonstrated

### 1. Assignment release notifications & reconciliation (`GET /api/apps/v1/fulfillment/assignments`)

When an order is released to your processor, the platform emits `fulfillment.assignment.created`
(6-key notification envelope, zero PII). Your connector reconciles via `GET /fulfillment/assignments`
to read `assignmentId`, `orderId`, `purchaseId`, `locationId`, `allowedCarriers`,
`adultSignatureRequired`, and `lines[]` (`sku`, `quantity`, `shipped`, `cancelled`, `remaining`).

### 2. Carrier catalog & PACT Act enforcement (`GET /api/apps/v1/fulfillment/carriers`)

Regulated stores (such as vape/nicotine tenants with PACT Act enabled) restrict which carriers can
transport parcels and require adult signature (`21+`) on delivery:

| Carrier Code (`CarrierCode`) | Station Slug / Alias | `pactEligible` | `adultSignature` | Allowed Tracking Host |
|---|---|---|---|---|
| `UPS` | `ups` | `true` | `supported` | `www.ups.com` |
| `FEDEX` | `fedex` | `true` | `supported` | `www.fedex.com` |
| `DHL` | `dhl_express` | `true` | `supported` | `www.dhl.com` |
| `ONTRAC` | `ontrac` / `lasership` | `true` | `supported` | `www.ontrac.com` |
| `GLS_US` | `gso_gls` | `true` | `supported` | `www.gls-us.com` |
| `LSO` | `lso` | `true` | `supported` | `www.lso.com` |
| `SPEE_DEE` | `spee_dee` | `true` | `supported` | `speedeedelivery.com` |
| `STAT_OVERNIGHT` | `stat_overnight` | `true` | `required` | `statovernight.com` |
| `BETTER_TRUCKS` | `better_trucks` | `true` | `supported` | `tracking.bettertrucks.com` |
| `USPS` | `usps` | **`false`** | `supported` | `tools.usps.com` |

Attempting to report a `USPS` shipment on a PACT-enabled store is refused fail-closed (`422 pact_carrier_ineligible` / `409 carrier-prohibited`), and any shipment missing `adultSignature: "accepted"` when `adultSignatureRequired: true` is refused with `409 adult-signature`.

### 3. Consent-gated recipient hydration (`GET /api/apps/v1/fulfillment/orders/{orderId}/recipient`)

Reads the decrypted ship-to address for one assigned order (`no-store`). Requires live owner consent
for `purpose: "fulfillment-shipping"`. Every admitted read is recorded in the append-only contact
audit log before decryption. Pass the recipient to your label provider in memory only — **never log
or persist recipient PII**.

### 4. Two Shipment Write-Back Paths

1. **1:N Split-Carton Shipments (`POST /api/apps/v1/fulfillment/assignments/{assignmentId}/shipments`):**
   When an assignment packs into multiple boxes or ships across multiple carriers, post each carton
   with its `lines[]` (`sku`, `quantity`), `carrier`, `service`, `trackingNumber`, `trackingUrl`, and
   `adultSignature`. Partial cartons emit `order.partially_fulfilled` (`complete: false`); the carton
   that ships the final remaining unit emits `order.fulfilled` (`complete: true`).
2. **Whole-Order Shipment Evidence (`POST /api/apps/v1/fulfillment/orders/{orderId}/shipment-evidence`):**
   For single-parcel whole-order workflows:
   - `kind: "label-outcome"` (`outcome: "purchased" | "unknown" | "voided"`, alias `label-purchased`) records the label under the assignment's `purchaseId`.
   - `kind: "label-voided"` voids a purchased label before carrier handoff, returning `label: "none"` and minting the **next attempt's `purchaseId`** so a replacement label can be bought cleanly.
   - `kind: "handoff"` (alias `handed-off`) confirms carrier scan acceptance and emits `order.fulfilled`.

---

## Self-Serve Regulated PACT Preview Verification (`env="test"`)

```bash
# 1. Inside a cloned store checkout, seed the preview store with the regulated-vape preset (enables PACT Act & adultSignature):
tot catalog seed --preset=regulated-vape
tot preview

# 2. Validate and install the connector in test mode:
tot app dev validate ./tot-app.json
tot app install --tenant <tenant> --env=test --app .

# 3. Bind as the preview processor, create a synthetic PACT order, and release it:
curl -sS -X POST "https://tot-preview.tokenoftrust.store/api/apps/admin/test-orders" \
  -H "Authorization: Bearer ${TOT_ADMIN_TOKEN}" \
  -H "X-Tot-Tenant: <tenant>" \
  -H "X-Tot-Caller-Capability: preview-access" \
  -H "Content-Type: application/json" \
  -d '{"action":"bind","installId":"<installId>"}'

curl -sS -X POST "https://tot-preview.tokenoftrust.store/api/apps/admin/test-orders" \
  -H "Authorization: Bearer ${TOT_ADMIN_TOKEN}" \
  -H "X-Tot-Tenant: <tenant>" \
  -H "X-Tot-Caller-Capability: preview-access" \
  -H "Content-Type: application/json" \
  -d '{"action":"create"}'

curl -sS -X POST "https://tot-preview.tokenoftrust.store/api/apps/admin/test-orders" \
  -H "Authorization: Bearer ${TOT_ADMIN_TOKEN}" \
  -H "X-Tot-Tenant: <tenant>" \
  -H "X-Tot-Caller-Capability: preview-access" \
  -H "Content-Type: application/json" \
  -d '{"action":"release","orderId":"<orderId>"}'
```

---

## Run Offline Verification

```bash
node index.mjs --self-test
npm test
```
