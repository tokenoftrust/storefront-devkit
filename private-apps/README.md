# Private Apps — available now

Private apps are the current app-developer path in the Storefront Devkit. The broader
[`apps/`](../apps/) front door also reserves a future public-app path, but no public-app capability
is available or implied today.

This devkit has two current jobs:

| Track | Job | You author | Lives in |
|---|---|---|---|
| **Tenant customization** (the rest of this repo) | Build/brand a store | tenant files (`theme.json`, `content/*`, `scripts.json`) interpreted by the platform | this devkit |
| **Private apps** (this folder) | Connect *your own service* to a merchant's store | a standards-based **app** in any language | this public devkit |

If you're building or branding a storefront, stay in the other track. Come here when a client needs
a **backend integration** — pulling catalog/order/inventory data, reacting to lifecycle events,
writing app-owned records (e.g. affiliate attribution), or rendering a small UI in an approved slot.

## What a private app is

A private app is **your service, hosted anywhere, in any language**, connected to merchant tenants
through a language-neutral contract — OpenAPI + JSON Schema + AsyncAPI + CloudEvents + JWT
(OAuth2 client-credentials / `private_key_jwt`) + HTTP Message Signatures. **No ToT package is
required**, and app code **never runs in the shared platform Worker**.

While each installation record and credential is scoped to one merchant store and stage, **vendors
and agencies can run a single multi-tenant service across many merchant stores**: every inbound
CloudEvent carries `tenantid`, `appinstallid`, and `source`, and every OAuth2 token exchange mints a
tenant-scoped Bearer JWT (`tenant`, `sub = appInstallId`, `env`). See
[`../apps/private/hosting/`](../apps/private/hosting/README.md) (and its machine index
[`../apps/private/hosting/index.json`](../apps/private/hosting/index.json)) for multi-tenant
routing and deployment fast-paths on **Cloudflare Workers**, **AWS Lambda**, **Google Cloud Run**,
**Microsoft Azure Functions / Container Apps**, **Docker**, and **local preview tunnels**.

The compliance floor (age/identity, tax, jurisdiction, warnings, CSP, go-live, signed-cart, checkout
totals) is **unreachable** — no scope, endpoint, or event in the contract can touch it.

## Public documentation authority

For public documentation and LLM use, this GitHub repository is the authority. Navigate by
repository-relative paths: [`../apps/`](../apps/) is the app front door and
[`../apps/private/`](../apps/private/) is the canonical private-app contract, including schemas,
scope rules, API/event definitions, safe fixtures, and implementation guidance. This
`private-apps/README.md` remains the stable compatibility guide.

`recipe://storefront-private-apps-devbook` on the ToT MCP is a pointer and index to this public
material. It is useful for discovery, but it is not the source of truth and does not override this
repository.

## Current guidance

- **Public contract** — use [`../apps/private/`](../apps/private/) as the normative public
  material. Do not infer behavior outside its schema, scope catalog, OpenAPI, or AsyncAPI files.
- **The CLI** — `tot app scaffold <name>` creates a runnable, language-neutral skeleton
  (`tot-app.json`, `fixtures/`, `server.js`, Dockerfile); `tot app dev` (`validate` / `emit` /
  `verify` / `mint`) is the local harness that signs fixture CloudEvents exactly like the real
  gateway so your verification code exercises the real path.
- **No published npm library** — this devkit intentionally does not distribute an npm library or
  platform runtime. Implement against the documented standards and use the CLI's fixtures to test
  your service. This keeps the public developer deliverable language-neutral and source-free.

## Quickstart

1. **Author `tot-app.json`** — declare `id`, `owner`, `installMode`, and the fewest **scopes** you
   need (from the 11-scope V1 catalog in `apps/private/contract/scopes.json`). Validate against
   `tot-app.schema.json`.
2. **Self-serve in `preview` (`env: "test"`)** — seed a realistic preview catalog
   (`tot catalog seed --preset=general|regulated-vape|multi-warehouse` followed by `tot preview`), install
   your app into the `test` stage (`tot app install --tenant <tenant> --env=test --app .`),
   and generate synthetic preview orders (`POST /api/apps/admin/test-orders`) without touching live
   merchant inventory or customer data.
3. **Exchange credentials for a short-lived JWT** (`POST /oauth/token`, `client_credentials` with
   `client_secret_post` or `private_key_jwt`).
4. **Call scoped APIs** (`/api/apps/v1/...`) and **verify + dedupe** signed webhook deliveries.
5. **Stage for production Owner approval** — when your connector passes verification in `test`,
   stage a production candidate (`POST /api/apps/admin/candidates` with `clientAuth.method =
   "private_key_jwt"`) so the Merchant Owner can approve it in one click.
6. **Start from a runnable reference recipe** under [`../apps/private/`](../apps/private/):
   - [`../apps/private/examples/hello-inventory/`](../apps/private/examples/hello-inventory/) —
     locations, stock read/write, and synthetic preview orders
   - [`../apps/private/recipes/inventory-sync-wms/`](../apps/private/recipes/inventory-sync-wms/) —
     multi-location WMS sync, CAS reconciliation, and `inventory.changed` threshold transitions
   - [`../apps/private/recipes/fulfillment-label-station/`](../apps/private/recipes/fulfillment-label-station/) —
     shipping & label station connector, PACT carrier validation, and 1:N split cartons
   - [`../apps/private/recipes/dropship-multi-supplier/`](../apps/private/recipes/dropship-multi-supplier/) —
     3PL & multi-supplier location-keyed routing, partial shipments, and fulfillment exceptions
   - [`../apps/private/samples/fulfillment-connector/`](../apps/private/samples/fulfillment-connector/) —
     full HTTP and Cloudflare Worker webhook/reconciliation reference sample

## The hard line (forbidden scopes)

An app may display sourced data and its own operational UI. It may **never**: bypass age/identity,
change tax, approve jurisdiction/shipping, rewrite/hide required warnings, alter checkout totals or
signed carts, trigger go-live, or pull unrestricted PII. These map to a machine-checkable
`forbidden-scopes.json` — a manifest requesting one is rejected outright. If a client need seems to
require crossing the floor, that's a **product conversation with Token of Trust**, not something to
route around.

## How this relates to the tenant `scripts.json` widget

Two different widget mechanisms, don't confuse them:

- **Tenant `scripts.json` sandboxed widget** (the [`../widgets`](../widgets/) track) — *you* register
  a bundle as tenant customization. Good for a merchant's own small enhancements.
- **Private-app widget launch** (D5, a *seam* — not live yet) — a platform-managed widget placement
  activated by an installed app, mounted in a sandboxed iframe with a minted launch token.
