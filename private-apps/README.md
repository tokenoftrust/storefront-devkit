# Private Apps — the second track

This devkit has **two tracks**, for two different jobs:

| Track | Job | You author | Lives in |
|---|---|---|---|
| **Tenant customization** (the rest of this repo) | Build/brand a store | tenant files (`theme.json`, `content/*`, `scripts.json`) interpreted by the platform | this devkit |
| **Private apps** (this folder) | Connect *your own service* to a merchant's store | a standards-based **app** in any language | the canonical sources linked below |

If you're building or branding a storefront, stay in the other track. Come here when a client needs
a **backend integration** — pulling catalog/order/inventory data, reacting to lifecycle events,
writing app-owned records (e.g. affiliate attribution), or rendering a small UI in an approved slot.

## What a private app is

A private app is **your service, hosted anywhere, in any language**, connected to **one merchant
tenant** through a language-neutral contract — OpenAPI + JSON Schema + AsyncAPI + CloudEvents + JWT
(OAuth2 client-credentials) + HTTP Message Signatures. **No ToT SDK is required**, and app code
**never runs in the shared platform Worker**. The compliance floor (age/identity, tax, jurisdiction,
warnings, CSP, go-live, signed-cart, checkout totals) is **unreachable** — no scope, endpoint, or
event in the contract can touch it.

## Canonical resources (this track links, it does not duplicate)

The authoritative material ships with the platform. Start here:

- **The devbook** — `recipe://storefront-private-apps-devbook` on the ToT MCP. Read it end-to-end
  the first time: manifest → OAuth/JWT → RFC 9421 signature verification → webhook handling →
  widget launch (a *seam* — not live yet) → local fixture harness → telemetry → install → replay →
  suspend/uninstall → external vs ToT-hosted → guardrails.
- **The contract** (in the storefront repo, `docs/private-apps/contract/`):
  `tot-app.schema.json` (the manifest schema), `openapi.yaml`, `asyncapi.yaml`, `scopes.json`
  (the 8-scope V1 catalog), `forbidden-scopes.json` (the machine-checkable compliance denylist).
- **The reference app** — `examples/affiliate-attribution/` in the storefront repo: a complete,
  open-sourceable Node app (OAuth, webhook signature verification, CloudEvents handlers, commission
  ledger, dashboard, sandbox widget page, tests, Dockerfile, fixtures). The best worked example.
- **The CLI** — `tot app scaffold <name>` creates a runnable, language-neutral skeleton
  (`tot-app.json`, `fixtures/`, `server.js`, Dockerfile); `tot app dev` (`validate` / `emit` /
  `verify` / `mint`) is the local harness that signs fixture CloudEvents exactly like the real
  gateway so your verification code exercises the real path.
- **The devkit source** — `packages/private-apps-devkit/src/{signing,jwt,manifest}.ts` in the
  storefront repo is the one hand-authored implementation. It's `"private": true` and TS-only
  today, so two dependency-free JS consumers — `packages/cli/src/vendor/private-apps-devkit.mjs`
  (the published `@tokenoftrust/cli`) and `examples/affiliate-attribution/lib/private-apps-devkit.mjs`
  (this standalone example) — carry clearly-labeled vendored copies. They're kept honest, not
  silently drifting: a machine-enforced mirror test
  (`examples/affiliate-attribution/test/private-apps-devkit.parity.test.js`) fails if the two
  copies diverge below their headers, and a parity test in each consumer cross-verifies against
  the real TS source whenever it's resolvable. This `private-apps/` track will link straight to
  the devkit's package once it ships a plain-JS build installable outside the storefront monorepo
  (tracked as `pa-devkit-publish`) — until then it stays documentation-only, per the "links, does
  not duplicate" rule above.

## Quickstart (from the devbook)

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
