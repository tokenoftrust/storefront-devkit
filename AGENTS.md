# AGENTS.md — how a coding agent should use this repo

You are generating changes for a **Token of Trust (ToT) Storefront** tenant. This repo gives you
runnable templates, JSON Schemas, and examples. Treat the rules below as a **hard contract**, not
style guidance. The platform enforces them; violating them fails validation or is rejected at
publish.

## Orientation (read these, in order)

1. This file — the contract + workflow.
2. [`manifest.json`](./manifest.json) — the catalog of every asset. Locate assets here; do not
   crawl directories blindly.
3. [`schemas/`](./schemas/) — the machine-checkable shape of every tenant-owned file. When shape
   is ambiguous, the schema is authoritative.
4. [`apps/`](./apps/) and [`apps/private/`](./apps/private/) when working on an app integration.
   The latter contains the canonical public schema, scopes, denylist, API/event definitions, and
   safe fixtures. [`private-apps/`](./private-apps/) remains a stable compatibility guide. The ToT
   MCP recipe `recipe://storefront-private-apps-devbook` is only a discovery index.

## The mental model

You do **not** write pages, components, routes, or server code. You supply **data, content, theme
tokens, and registered scripts**; the platform renders them with a shared, compliance-aware
component library. The safest successful change edits **data and pinned assets**, never anything
that looks like code.

## Tenant-owned files (the only files you may edit)

```text
.tot/config.json           tenant facts & metadata (siteType, compliance facts) — READ, don't fabricate
theme.json                 brand look: color / type / space / shape tokens
content/chrome.json        header, nav/mega-menu, footer, newsletter, announcement
content/home.json          homepage layout & merchandising (pinned block contract)
content/pages/*.json       platform-rendered editorial pages
content/*.html             raw HTML pages — UNREGULATED tenants only
content/pages-html/**      raw HTML pages — UNREGULATED tenants only
public/**                  assets referenced by content (images, fonts, logos)
capabilities.json          optional surface toggles — may NOT weaken the compliance floor
scripts.json               registered widget/script bundles (sandboxed by default)
```

Everything else is **platform-owned and read-only**. Editing it is discarded or rejected. If a
request needs a net-new component, route, server/checkout/compliance behavior, classify it as
**platform work or extraction** — do not smuggle it into tenant content.

## The six golden rules (non-negotiable)

1. **Edit only tenant-owned files.** Never platform code.
2. **Never fabricate compliance facts or legal copy.** Age gates, FDA/nicotine/Prop-65/PACT
   warnings, and excise notices are platform-owned wording. You only flip flags and pass small
   parameters (`minAge`, chemical names, state lists). Never remove, hide, rewrite, or paraphrase
   a required warning; never disable required `ageVerification` or `exciseTax`.
3. **For regulated tenants: no raw HTML, no inline scripts, no `on*=` handlers, no `javascript:`
   URLs.** Use blocks, editorial JSON, assets, and **sandboxed** widgets.
4. **Checkout & subscriptions are platform-owned.** Never build cart/checkout/subscription
   mechanics as widgets or HTML. Express purchase options with the documented `purchase_options`
   data shape (see `schemas/` and `recipes/add-subscription-option/`).
5. **Prefer data + tokens.** Reach for `theme.json` and `content/*` first, always.
6. **Escalate, don't smuggle.** Sandboxed widget → **private app** → single-tenant extraction.
   Private apps are a shipped, separate developer surface (your own service connected via a
   standards-based contract) — start at [`apps/`](./apps/), then use the canonical
   [`apps/private/`](./apps/private/) contract. The stable [`private-apps/`](./private-apps/) guide
   is retained for compatibility. The MCP recipe `recipe://storefront-private-apps-devbook` is an
   index. Do not rebuild backend behavior as tenant content.

## Workflow

1. **Identify tenant facts** — read `.tot/config.json` for `siteType` and `compliance`. These
   decide what's required and what's allowed.
2. **State which tenant-owned files you will edit** before editing.
3. **Make the smallest contract-valid change.** Start from a template or snippet; validate its
   shape against the matching schema in `schemas/`.
4. **Run `tot validate`** and fix any errors.
5. **Report** using this shape:

   ```text
   Changed:
   - theme.json: updated brand tokens
   - content/home.json: switched featured products to best sellers
   Compliance:
   - Age verification, warnings, checkout integrity, and excise obligations unchanged.
   Validation:
   - tot validate: passed
   ```

6. **If a request is blocked by a compliance rule, refuse that part and name the exact rule**,
   then offer a safe alternative inside theme / content / composition / assets / sandboxed widgets.

## Handling common requests

| Request | Correct move |
|---|---|
| "Rebrand / restyle" | Edit `theme.json` tokens only. Never touch components. |
| "Change what's on the homepage" | Edit `content/home.json` blocks; prefer product **sources** over hand-listed handles. |
| "Add a quiz / configurator / loyalty widget" | Register a **sandboxed** widget in `scripts.json` (see `widgets/`). |
| "Add a subscription option" | Use the `purchase_options` shape in catalog data — not a custom widget. |
| "Turn on nicotine/PACT/Prop-65/excise notices" | Set the flags/params in the tenant's `.compliance` config (see `snippets/compliance/`). |
| "Hide the age gate / turn off excise to test" | **Refuse** (rules 2). Offer a brand/copy change that keeps the floor intact. |
| "Paste this full HTML landing page" (regulated) | **Refuse raw HTML**; translate into blocks + editorial JSON + assets + sandboxed widgets. |
| "Build a custom checkout / new payment method" | **Out of contract.** Platform checkout integration or extraction. |

## Do not

- Do not set `ageVerification.enabled` or `exciseTax.enabled` to `false` for a regulated tenant.
- Do not hide compliance DOM with CSS or JS.
- Do not move checkout links outside platform-owned controls.
- Do not use `isolation: "inline"` for regulated tenants (use `sandbox`).
- Do not invent compliance facts (states, chemicals, ages) — pull them from tenant facts.
