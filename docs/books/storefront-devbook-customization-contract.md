---
id: storefront-devbook-customization-contract
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Storefront customization contract — what a tenant (or its coding agent) may change
---
# Storefront customization contract — what a tenant (or its coding agent) may change

This guide is written for coding agents and LLM tools generating changes for a
Token of Trust storefront. Follow it as a hard contract, not as style guidance.

## Objective

Generate tenant-owned storefront changes that make the store feel brand-specific
while preserving Token of Trust's regulated commerce obligations.

The safest successful answer changes data and pinned assets, not platform code.

## Canonical Concepts

- Astro components are platform-owned implementation details.
- Tenant customization is declarative: JSON, content, assets, and registered
  scripts interpreted by the platform.
- The current homepage contract is `block-palette@3`.
- Widget scripts are sandboxed by default.
- Compliance obligations are derived from tenant facts, not from merchant taste.

## Allowed Tenant-Owned Files

Agents may edit these surfaces when present in a tenant checkout:

```text
.tot/config.json
theme.json
content/home.json
content/chrome.json
content/pages/*.json
content/*.html
content/pages-html/**/*.html
public/**
capabilities.json
scripts.json
embeds.json
```

Rules:

- Treat `.tot/config.json` as tenant facts and metadata. Do not fabricate
  compliance facts.
- Use `theme.json` for visual design.
- Use `content/home.json` for homepage layout and merchandising.
- Use `content/pages/*.json` for platform-rendered editorial pages.
- Use `public/**` for assets referenced by content.
- Do not claim that tenant `scripts.json` registrations render. The schema/validator exists, but no
  tenant runtime renderer consumes it today. Managed-app widgets use a separate app registry and
  sandboxed frame path.
- Use `embeds.json` to opt into a catalogued third-party embed (e.g. a
  Pipedrive Web Form). See "Third-Party Embeds" below.

## Forbidden Surfaces

Do not edit platform-owned Astro source as a tenant customization. These paths belong to the
platform, not to a tenant checkout:

```text
platform components, layouts, middleware, and pages
platform libraries and configuration
the platform public runtime
the platform private control plane
```

If the user asks for a net-new component, route, server behavior, checkout
behavior, or compliance behavior, classify it as platform work or extraction.
Do not smuggle it into tenant-owned content.

## Compliance Rules

If `compliance.minAge` is present, the tenant is regulated for age or identity
verification. If `compliance.nicotineWarning` is present, the tenant has nicotine
or vape obligations.

Always enforce these rules:

- Never disable required `ageVerification`.
- Never disable required `exciseTax`.
- Never remove, rewrite, hide, or paraphrase required warnings.
- Never use raw HTML for regulated tenants.
- Never add inline scripts for regulated tenants.
- Never add JavaScript event handlers such as `onclick` inside content.
- Never use `javascript:` URLs.
- Never suggest editing compliance components, checkout signing, CSP, middleware,
  or promote gates.

If a user asks to break one of these rules, refuse that part and offer a safe
alternative inside theme, content, composition, assets, or sandboxed widgets.

## Cart And Subscription Checkout

Do not build checkout or subscription mechanics as tenant widgets, raw HTML, or
inline JavaScript. Cart and subscription checkout are platform-owned controls
that submit signed payloads to a managed checkout provider.

When catalog product data exposes purchase options, use this shape:

```json
{
  "purchase_options": [
    {
      "id": "one_time",
      "kind": "one_time",
      "label": "One-time purchase"
    },
    {
      "id": "monthly",
      "kind": "subscription",
      "label": "Subscribe monthly",
      "description": "Ships every month. Skip or cancel anytime.",
      "savingsLabel": "Save 15%",
      "priceAdjustment": { "type": "percent_off", "value": 15 },
      "frequency": "1m"
    }
  ]
}
```

Valid subscription frequencies use compact checkout intervals such as `60d`,
`2w`, `1m`, `1y`, or `.5m`. Use merchant/brand language like "Subscribe",
"Autopilot", or "managed checkout"; do not surface provider-branded checkout
widgets in client-facing UI.

## Homepage Contract

Use `content/home.json` with `block-palette@3`:

```json
{
  "contract": "block-palette@3",
  "seoTitle": "Acme Vapor",
  "seoDescription": "Premium devices and liquids for adult customers.",
  "blocks": [
    {
      "component": "hero",
      "headline": "Premium devices and liquids",
      "subhead": "Curated for adult customers.",
      "ctaLabel": "Shop new arrivals",
      "ctaHref": "/collections/new-arrivals"
    },
    {
      "component": "featured_products",
      "title": "Best sellers",
      "source": "bestSelling",
      "limit": 4
    }
  ]
}
```

Supported product source shortcuts:

```text
featured
newest
bestSelling
onSale
```

Supported product source objects:

```json
{ "collection": "devices" }
{ "tag": "salt-nic" }
{ "handles": ["starter-kit", "replacement-pods"] }
{ "related": "starter-kit" }
{ "recentlyViewed": true }
```

Prefer product sources over bespoke product lists unless the user explicitly
names handles.

## Scripts And Widgets

Use sandboxed widgets first:

```json
{
  "scripts": [
    {
      "src": "widgets/loyalty.js",
      "slot": "product.aside",
      "strategy": "on-interaction",
      "isolation": "sandbox"
    }
  ]
}
```

Supported slots:

| Slot | Use |
| --- | --- |
| `product.aside` | A widget beside product purchase controls |
| `home.section` | A widget between homepage sections |
| `global.footer` | A widget near the footer on every route |

Supported strategies:

```text
defer
on-idle
on-interaction
```

Supported isolation modes:

```text
sandbox
inline
```

Use `sandbox` unless the tenant is unregulated and the user has a genuine
same-origin enhancement need. Never use `inline` for regulated tenants.

## Capability Changes

`capabilities.json` may request optional surface changes. It may not weaken the
compliance floor.

Safe example for a marketing-only tenant:

```json
{
  "cartCheckout": { "enabled": false }
}
```

Unsafe for a regulated tenant:

```json
{
  "ageVerification": { "enabled": false },
  "exciseTax": { "enabled": false }
}
```

The unsafe example must be rejected or corrected.

## Third-Party Embeds

The storefront wraps every page in a strict Content-Security-Policy. A
third-party embed (a `<script src>` or `<iframe>` from an external host — e.g. a
Pipedrive Web Form, a Calendly scheduler) is **blocked by default**: it will not
render and there is no page error, just a blank spot. To allow one, the tenant
opts into a **catalogued** provider via `embeds.json`.

`embeds.json` is a JSON array of provider slugs from the platform-owned catalog:

```json
["pipedrive"]
```

Rules:

- Only slugs in the catalog are honored (currently: `pipedrive`). You **cannot**
  allow an arbitrary origin from tenant config — that is a deliberate security
  floor. An unknown slug is ignored (and the validator warns).
- The embed's markup still lives in your content HTML (e.g. the Pipedrive
  `<div class="pipedriveWebForms" data-pd-webforms="…">` + loader `<script>`).
  Listing the slug in `embeds.json` is what lets the CSP permit it.
- The CSP origins are added only to pages that actually contain the embed, so
  listing a slug you don't use anywhere is harmless (but pointless).
- If you embed a provider that is NOT in the catalog, `tot validate` fails with a
  blocking error: a new provider needs a platform catalog entry (an
  `EMBED_PROVIDERS` addition), which is an escalation, not a tenant edit.

To add a Pipedrive form to a contact page: put the Pipedrive embed markup in the
page HTML, then create `embeds.json` with `["pipedrive"]`. Run `tot validate` —
it should pass with no `embed-csp` findings.

## Output Discipline

When generating a change:

1. Identify tenant facts, especially `siteType` and `compliance`.
2. State which tenant-owned files you will edit.
3. Make the smallest contract-valid change.
4. Run validation when tooling is available.
5. Report any blocked request with the exact compliance rule that blocked it.

Prefer this final response shape:

```text
Changed:
- theme.json: updated brand tokens
- content/home.json: switched featured products to best sellers

Compliance:
- Age verification, warnings, checkout integrity, and excise obligations were not changed.

Validation:
- tot storefront validate: passed
```

## Escalation Paths

If the request cannot fit the tenant contract, choose one:

- Add or extend a platform-owned block contract.
- Build a sandboxed widget.
- Use single-tenant extraction when the client needs full runtime ownership.

Do not widen shared-runtime permissions as part of a tenant customization.
