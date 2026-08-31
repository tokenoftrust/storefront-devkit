# Private Apps — public contract

This directory is the canonical, public, language-neutral contract for Storefront private apps.
Use it to build a service that connects to one merchant tenant through scoped APIs and signed
webhooks. It contains documentation and machine-readable specifications only—no platform runtime,
credentials, tenant data, operator procedures, or application source code.

Private apps are available today. They are not public apps: do not infer a marketplace, a
multi-tenant distribution model, a self-service installation flow, or any public-app API from
these files.

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

## Safety boundary

An app may read only granted, minimized data; receive its subscribed events; and write only to its
own attribution namespace. It may not change or bypass age/identity checks, tax, jurisdiction,
required warnings, content-security policy, go-live, signed carts, or checkout totals. The
denylist is normative: if a requested capability is not in the scope catalog—or is listed as
forbidden—do not try to recreate it through a widget, webhook response, or undocumented endpoint.

Use the language and framework appropriate to your service. The devkit intentionally publishes no
npm library or platform runtime. Keep installation credentials server-side and use the CLI fixtures
or the synthetic examples here for local tests.

## Versioning

This is contract major version 1. `contractVersion: "1"` in a manifest and
`dataschemaversion: "1"` in a CloudEvent pin that line. Additive compatible changes are minor;
removing or narrowing a field or changing a scope meaning requires a new major line. Do not fork
scope strings, event names, widget placements, or the forbidden-scope list.

## Stable links

[`../../private-apps/`](../../private-apps/) remains the historical/stable public guide and points
here for contract material. [`../`](../) remains the Apps front door.
