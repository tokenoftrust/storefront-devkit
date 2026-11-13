# Private Apps — public contract

This directory is the canonical, public, language-neutral contract for Storefront private apps.
Use it to build an independently hosted service that connects to merchant tenants through scoped
APIs and signed webhooks. While each installation record and credential is scoped to one merchant
tenant and stage (`preview`/`env="test"` vs `publication`/`env="production"`), **a single deployed
app service and `tot-app.json` manifest can serve one merchant or many merchants (multi-tenant)**
using the `tenantid` and `appinstallid` carried on every webhook and OAuth token. It contains
documentation, machine-readable specifications, starter examples under [`examples/`](./examples/),
runnable connector recipes under [`recipes/`](./recipes/), self-contained reference samples under
[`samples/`](./samples/), and extensible cloud/runtime hosting guides under
[`hosting/`](./hosting/)—no platform runtime, credentials, tenant data or operator procedures.

Private apps are available today. They are not public marketplace apps: do not infer a public
marketplace or an unapproved self-install flow on live stores from these files. Developers can
self-serve installation and end-to-end verification in the `preview` (`env="test"`) sandbox, and
stage production candidate manifests (`pending_approval`) for 1-click Merchant Owner approval.

## Read in this order

1. This file for scope and boundaries.
2. [`contract/tot-app.schema.json`](./contract/tot-app.schema.json) to author `tot-app.json`.
3. [`contract/scopes.json`](./contract/scopes.json) and
   [`contract/forbidden-scopes.json`](./contract/forbidden-scopes.json) to request the smallest
   permitted access set and understand the compliance floor.
4. [`contract/openapi.yaml`](./contract/openapi.yaml) for the pull API and
   [`contract/asyncapi.yaml`](./contract/asyncapi.yaml) for outbound webhook topics.
5. [`webhooks-and-api.md`](./webhooks-and-api.md) for the concise implementation guide and the
   safe examples in [`contract/examples/`](./contract/examples/).
6. [`hosting/`](./hosting/README.md) (and [`hosting/index.json`](./hosting/index.json)) for
   multi-tenant routing and runtime deployment fast-paths (**Cloudflare Workers**, **AWS Lambda**,
   **Google Cloud Run / Functions**, **Microsoft Azure Functions / Container Apps**, **Docker
   containers**, **pull-only scheduled jobs**, and **local preview tunnels**).

For LLMs and developers, these GitHub-relative files are authoritative. The ToT MCP recipe
`recipe://storefront-private-apps-devbook` is a discovery index to this material; it never
overrides this repository.

## Contract files

| File | Purpose |
|---|---|
| [`contract/tot-app.schema.json`](./contract/tot-app.schema.json) | JSON Schema draft 2020-12 for the app manifest. |
| [`contract/scopes.json`](./contract/scopes.json) | The V1 scope catalog and data-minimization rules. |
| [`contract/forbidden-scopes.json`](./contract/forbidden-scopes.json) | Machine-readable denylist for the non-negotiable compliance floor. |
| [`contract/openapi.yaml`](./contract/openapi.yaml) | OpenAPI 3.1 definition for `/api/apps/v1`. |
| [`contract/asyncapi.yaml`](./contract/asyncapi.yaml) | AsyncAPI 2.6 definition for signed CloudEvents webhooks. |
| [`contract/examples/affiliate.tot-app.json`](./contract/examples/affiliate.tot-app.json) | Safe sample manifest using example-owned identifiers and URLs. |
| [`contract/examples/order.created.cloudevent.json`](./contract/examples/order.created.cloudevent.json) | Safe synthetic `order.created` CloudEvent fixture. |
| [`contract/examples/fulfillment.assignment.created.cloudevent.json`](./contract/examples/fulfillment.assignment.created.cloudevent.json) | Synthetic release notification: `fulfillment.assignment.created`. |
| [`contract/examples/fulfillment.assignments.response.json`](./contract/examples/fulfillment.assignments.response.json) | Synthetic reconciliation response for `GET /fulfillment/assignments`. |
| [`contract/examples/fulfillment.recipient.response.json`](./contract/examples/fulfillment.recipient.response.json) | Synthetic placeholder recipient for `GET /fulfillment/orders/{orderId}/recipient`. |
| [`contract/examples/fulfillment.shipment-evidence.label-outcome.request.json`](./contract/examples/fulfillment.shipment-evidence.label-outcome.request.json), [`...handoff.request.json`](./contract/examples/fulfillment.shipment-evidence.handoff.request.json), [`...response.json`](./contract/examples/fulfillment.shipment-evidence.response.json) | Synthetic shipment-evidence requests and the minimized response. |
| [`contract/examples/fulfillment.refusal.response.json`](./contract/examples/fulfillment.refusal.response.json) | Synthetic refusal body carrying a stable `code`. |
| [`contract/examples/inventory.list.response.json`](./contract/examples/inventory.list.response.json) | Synthetic `GET /inventory` response with a per-location `mirror` ledger reading and `nextCursor`. |
| [`contract/examples/inventory.movement.request.json`](./contract/examples/inventory.movement.request.json), [`...response.json`](./contract/examples/inventory.movement.response.json), [`inventory.refusal.response.json`](./contract/examples/inventory.refusal.response.json) | Synthetic `POST /inventory/movements` request, `InventoryReceipt` response, and `InventoryRefusal` body. |
| [`contract/examples/inventory.changed.cloudevent.json`](./contract/examples/inventory.changed.cloudevent.json) | Synthetic `inventory.changed` CloudEvent fixture. |

## Reference examples, recipes, and samples

Each directory under [`examples/`](./examples/), [`recipes/`](./recipes/), and
[`samples/`](./samples/) is one self-contained, runnable reference app with its own `README.md`,
`meta.json`, `tot-app.json`, and `node:test` verification suite. Every reference implementation is
built only on the published contract in this directory, uses no dependencies beyond Node's standard
library, is configured by environment variables, and carries synthetic placeholder data only. It is
code to read and copy, not a published library, not a ToT-hosted service, and never authoritative
over the contract.

| Asset | Archetype | Scopes | What it shows |
|---|---|---|---|
| [`examples/hello-inventory/`](./examples/hello-inventory/) | Starter app | `catalog:read`, `inventory:read`, `inventory:write`, `orders:read:minimal` | Location registration (`GET/PUT /inventory/locations/{locationId}`), stock reads (`GET /inventory`), idempotent movement writes (`POST /inventory/movements`), and self-serve preview order verification (`POST /api/apps/admin/test-orders`). |
| [`recipes/inventory-sync-wms/`](./recipes/inventory-sync-wms/) | Multi-Location WMS Connector | `catalog:read`, `inventory:read`, `inventory:write` | Multi-location upsert, `PUT /inventory/levels` CAS reconciliation (`expectedVersion` + `409 version_conflict` recovery), batch WMS `POST /inventory/movements` across all 7 reason codes, `inventory.changed` threshold transitions (`low_stock`, `out_of_stock`, `back_in_stock`), and `private_key_jwt` candidate staging. |
| [`recipes/fulfillment-label-station/`](./recipes/fulfillment-label-station/) | Shipping & Label Station Connector | `orders:read:minimal`, `orders:read:recipient`, `orders:webhook`, `fulfillment:process` | Assignment webhooks and reconciliation, recipient hydration (`GET /fulfillment/orders/{orderId}/recipient`), PACT & `adultSignature` carrier validation via `GET /fulfillment/carriers` (refusing USPS with `422 pact_carrier_ineligible`), 1:N split cartons (`POST /fulfillment/assignments/{assignmentId}/shipments`), and whole-order `label-voided` recovery. |
| [`recipes/dropship-multi-supplier/`](./recipes/dropship-multi-supplier/) | 3PL & Multi-Supplier Routing Connector | `orders:read:minimal`, `orders:read:recipient`, `orders:webhook`, `fulfillment:process`, `inventory:read`, `inventory:write` | **Stone 1 (Live):** Location-keyed processor coexistence `(tenant_id, stage, location_id)`, partial line shipments emitting `order.partially_fulfilled` → `order.fulfilled`, and `POST /fulfillment/assignments/{assignmentId}/exceptions` (`backordered`, `cannot_fulfill`, `address_undeliverable`). **Stone 2 (Contract Locked):** Multi-supplier cart auto-split across distinct `(appInstallId, locationId)` pairs. |
| [`samples/fulfillment-connector/`](./samples/fulfillment-connector/) | Full HTTP/Worker fulfillment sample | `fulfillment:process`, `orders:read:recipient` | End-to-end webhook verification (Content-Digest, RFC 9421), CloudEvents dedupe, reconciliation, recipient read, simulated label provider, and both `node:http` and Cloudflare Worker entrypoints. |

## Safety boundary

An app may read only granted, minimized data; receive its subscribed events; and write only to the
narrowly scoped app surfaces its install grants (`attribution:write` in its own namespace,
`inventory:write` for mirror-ledger stock corrections, location upserts, and CAS level
reconciliation, and `fulfillment:process` for assigned whole-order shipment evidence, split-carton
shipments, and assignment exceptions). It may not change or bypass age/identity checks, tax,
jurisdiction, required warnings, content-security policy, go-live, signed carts, or checkout
totals. The denylist is normative: if a requested capability is not in the scope catalog—or is
listed as forbidden—do not try to recreate it through a widget, webhook response, or undocumented
endpoint.

Use the language and framework appropriate to your service. The devkit intentionally publishes no
npm library or platform runtime; the reference examples, recipes, and samples are copyable source,
not packages. Keep installation credentials server-side and use the CLI fixtures or the synthetic
examples here for local tests.

## Versioning

This is contract major version 1 (currently **1.3.0**, with 11 V1 scopes in `scopes.json`:
`catalog:read`, `orders:read:minimal`, `orders:webhook`, `customers:read:minimal`,
`inventory:read`, `inventory:write`, `reports:read`, `attribution:write`, `widgets:launch`,
`fulfillment:process`, and `orders:read:recipient`). Version 1.3.0 adds multi-location
inventory (`GET/PUT /inventory/locations/{locationId}`), compare-and-swap level reconciliation
(`PUT /inventory/levels` with `expectedVersion`), batch movement writes with WMS reason codes,
carrier capability discovery (`GET /fulfillment/carriers` with PACT/adult-signature metadata),
location-keyed fulfillment assignments with 1:N split shipments
(`POST /fulfillment/assignments/{assignmentId}/shipments`) and exception reporting
(`POST /fulfillment/assignments/{assignmentId}/exceptions`), `order.partially_fulfilled` and
`label-voided` recovery, `private_key_jwt` authentication, and self-serve preview order testing
(`POST /api/apps/admin/test-orders`) plus production candidate staging
(`POST /api/apps/admin/candidates`). `contractVersion: "1"` in a manifest and
`dataschemaversion: "1"` in a CloudEvent pin that line. Additive compatible changes are minor;
removing or narrowing a field or changing a scope meaning requires a new major line. Do not fork
scope strings, event names, widget placements, or the forbidden-scope list.

## Stable links

[`../../private-apps/`](../../private-apps/) remains the historical/stable public guide and points
here for contract material. [`../`](../) remains the Apps front door.
