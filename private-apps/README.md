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

A private app is **your service, hosted anywhere, in any language**, connected to **one merchant
tenant** through a language-neutral contract — OpenAPI + JSON Schema + AsyncAPI + CloudEvents + JWT
(OAuth2 client-credentials) + HTTP Message Signatures. **No ToT package is required**, and app code
**never runs in the shared platform Worker**. The compliance floor (age/identity, tax, jurisdiction,
warnings, CSP, go-live, signed-cart, checkout totals) is **unreachable** — no scope, endpoint, or
event in the contract can touch it.

## Public documentation authority

For public documentation and LLM use, this GitHub repository is the authority. Navigate by
repository-relative paths: [`../apps/`](../apps/) is the app front door and this
`private-apps/README.md` is the stable current guide. The detailed, publicly releasable contract
corpus will be added to this repository in a separate cutover; until then, do not invent missing
endpoints, scopes, lifecycle behavior, or a public-app surface.

`recipe://storefront-private-apps-devbook` on the ToT MCP is a pointer and index to this public
material. It is useful for discovery, but it is not the source of truth and does not override this
repository.

## Current guidance

- **The CLI** — `tot app scaffold <name>` creates a runnable, language-neutral skeleton
  (`tot-app.json`, `fixtures/`, `server.js`, Dockerfile); `tot app dev` (`validate` / `emit` /
  `verify` / `mint`) is the local harness that signs fixture CloudEvents exactly like the real
  gateway so your verification code exercises the real path.
- **No published npm library** — this devkit intentionally does not distribute an npm library or
  platform runtime. Implement against the documented standards and use the CLI's fixtures to test
  your service. This keeps the public developer deliverable language-neutral and source-free.

## Quickstart

1. **Author `tot-app.json`** — declare `id`, `owner`, `installMode`, and the fewest **scopes** you
   need (from the 8-scope V1 catalog). Validate against `tot-app.schema.json`.
2. **Get it installed** — installation is operator-run in V1 (no self-service). Send your validated
   manifest to your ToT contact; ask for an install with `env: test` on the preview gateway.
   Capture the client id + secret shown **once**.
3. **Exchange credentials for a short-lived JWT** (`POST /oauth/token`, client-credentials).
4. **Call scoped APIs** (`/api/apps/v1/...`) and **verify + dedupe** signed webhook deliveries.
5. **Scaffold + iterate locally** with `tot app scaffold` / `tot app dev emit <topic>`.

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
