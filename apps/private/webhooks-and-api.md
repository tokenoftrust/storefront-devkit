# Private Apps — webhook and API guide

This guide is a concise companion to the normative
[`openapi.yaml`](./contract/openapi.yaml) and [`asyncapi.yaml`](./contract/asyncapi.yaml). If this
guide and a machine-readable specification differ, the specification wins.

## Build a private app

1. Create `tot-app.json` from the [sample manifest](./contract/examples/affiliate.tot-app.json)
   and validate it with [`tot-app.schema.json`](./contract/tot-app.schema.json).
2. Request only scopes present in [`scopes.json`](./contract/scopes.json). Never request or invent
   a scope in [`forbidden-scopes.json`](./contract/forbidden-scopes.json).
3. Host your service independently. Keep its installation credentials server-side; never place a
   credential in a browser, widget, repository, fixture, or webhook response.
4. Use OAuth2 client credentials for an installation token, then call only endpoints whose required
   scope the token contains. The installation/setup process supplies credentials; this public
   contract does not describe operator provisioning.
5. Receive subscribed CloudEvents over HTTPS, verify the signature before parsing or acting on the
   event, and deduplicate on the CloudEvents `id`.

## Pull API

The API base is `/api/apps/v1`; exact request and response shapes are in
[`openapi.yaml`](./contract/openapi.yaml). All calls use a short-lived bearer JWT and are confined
to the tenant and app installation represented by that token. Propagate `traceparent` when present;
responses include `tot-request-id` for support correlation. Writes require `Idempotency-Key` when
the OpenAPI definition says so.

| Scope | Available operation family |
|---|---|
| Token only | Read this app install (`GET /app`) and its delivery health (`GET /health`). |
| `catalog:read` | Read published catalog products. |
| `orders:read:minimal` | Read minimized order lists and details. |
| `inventory:read` | Read availability and inventory policy. |
| `reports:read` | Read aggregate report snapshots. |
| `attribution:write` | Write idempotent, app-owned attribution records only. |
| App-install ownership | List and replay this installation's webhook delivery records. |

There is deliberately no API for checkout, tax, age/identity, jurisdiction, required warnings,
go-live, signed carts, or compliance decisions.

## Receive webhooks safely

Webhook deliveries are CloudEvents 1.0 structured JSON sent by HTTPS POST. They are at-least-once:
the same `id` can recur after retry or replay, so store and deduplicate that `id` before performing
an irreversible side effect. Use the [synthetic order fixture](./contract/examples/order.created.cloudevent.json)
for local tests.

Before trusting a delivery:

1. Read the raw request body without modifying it.
2. Fetch the public signing keys from the gateway authorization metadata and cache them according
   to the response policy. These are public verification keys, never private signing material.
3. Recompute `Content-Digest` for the raw body and reject a mismatch.
4. Verify the RFC 9421 `Signature-Input` and `Signature` against the declared key and covered
   components. Reject an unknown key, unsupported algorithm, malformed signature, or failed
   verification.
5. Validate the CloudEvents envelope and event-specific payload against
   [`asyncapi.yaml`](./contract/asyncapi.yaml), then deduplicate by `id`.
6. Return a 2xx response only after the event is safely accepted; do not use the response body or
   status to approve, alter, or bypass any platform compliance decision.

The AsyncAPI definition declares the event vocabulary: install lifecycle, catalog, inventory,
order, marketing-consent, and attribution topics. Subscribe only to topics permitted by your
granted scopes. A declared topic does not imply that a public-app product or an undocumented
capability exists.

## Data minimization and failure handling

Treat values as tenant-scoped and minimized. Do not attempt to obtain raw checkout payloads,
customer identity, signed-cart data, tax internals, or compliance-decision data. Do not log raw
authorization headers or credentials. Store only what your declared purpose and retention policy
require.

On a rejected or failed webhook, return a non-2xx response so the delivery system can retry. Make
your handler idempotent, monitor the installation's public delivery-health endpoint, and use the
app-owned replay endpoint only for that installation's own deliveries. Operator workflows and
internal forwarding paths are intentionally outside this public guide.
