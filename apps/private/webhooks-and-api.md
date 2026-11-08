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
| `fulfillment:process` | Read this install's active fulfillment assignments; report label outcome and handoff for an assigned order. |
| `orders:read:recipient` | Read the ship-to recipient of one assigned order, consent-gated and audited. |
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

### Signature details

Discovery is `GET /.well-known/tot-app-authorization-metadata` on the storefront origin. It is
public JSON, cacheable for the `max-age` its `Cache-Control` states (300 seconds). Two fields
matter to a webhook receiver:

| Field | Meaning |
|---|---|
| `webhook_signing_keys` | A JWK Set (`{"keys": [...]}`) of the public keys that sign webhook deliveries. Each key is `kty: "RSA"`, `alg: "RS256"`, `use: "sig"`, identified by `kid`. Absent when the storefront has no webhook signing key configured. |
| `token_endpoint` | Where to exchange installation credentials for a bearer token: `POST`, `application/x-www-form-urlencoded`, `grant_type=client_credentials` with `client_id` and `client_secret` in the form body (`client_secret_post`). The response carries `access_token`, `token_type`, `expires_in` and `scope`. |

`jwks_uri` in the same document publishes the keys of the bearer tokens the gateway issues. It is
not the webhook key set; verify deliveries only against `webhook_signing_keys`.

Every delivery is a `POST` with `Content-Type: application/cloudevents+json` and three signing
headers:

| Header | Value the platform sends |
|---|---|
| `Content-Digest` | `sha-256=:<base64 of SHA-256 over the exact body bytes>:` (RFC 9530). |
| `Signature-Input` | `sig1=("@method" "@target-uri" "content-digest");created=<unix seconds>;keyid="<kid>";alg="rsa-v1_5-sha256"` |
| `Signature` | `sig1=:<base64 signature>:` |

The signature is RFC 9421 `rsa-v1_5-sha256` (RSASSA-PKCS1-v1_5 with SHA-256) under the label
`sig1`. It covers exactly `@method` (`POST`), `@target-uri` (the app's registered
`webhooks.endpoint`, character for character as registered) and `content-digest`, followed by
the `@signature-params` line. Each delivery attempt, including a retry or replay, is signed
afresh, so `created` is the time of that attempt.

A verifier MUST accept a delivery that meets all of the following, and MUST reject any other:

- `Content-Digest` carries a `sha-256` member equal to SHA-256 of the raw body. Other digest
  members may be present and are ignored. A missing `sha-256` member is a rejection.
- `Signature-Input` and `Signature` both carry a `sig1` member. Other labels are ignored.
- The `sig1` covered components include `@method`, `@target-uri` and `content-digest`. The
  signature base is rebuilt from the received `Signature-Input`, component by component, with
  `@target-uri` set to the endpoint the app registered, never to a value read from the request.
- `alg` is present and equals `rsa-v1_5-sha256`. Any other or missing `alg` is a rejection.
- `keyid` names a key in `webhook_signing_keys`. On an unknown `keyid`, refetch the metadata
  once (keys rotate), with a rate limit, before rejecting.
- `created` is recent. Choose and document a window; the reference sample accepts five minutes
  of age and one minute of clock skew.
- The signature verifies against that key over the rebuilt base.

## Fulfillment connector

A private app can act as a merchant's fulfillment processor for whole orders. The merchant
configures one install as processor and grants a separate consent; a Storefront operator then
releases an order, which assigns it to that install exclusively. The app never assigns itself.
Scopes: `fulfillment:process` and `orders:read:recipient`. Topics:
`fulfillment.assignment.created` and `fulfillment.assignment.updated`. Routes, all under
`/api/apps/v1`: `GET /fulfillment/assignments`,
`GET /fulfillment/orders/{orderId}/recipient` and
`POST /fulfillment/orders/{orderId}/shipment-evidence`. Synthetic placeholder payloads for each
are in [`contract/examples/`](./contract/examples/).

### Whole-order flow

1. **Notified.** A signed `fulfillment.assignment.created` CloudEvent arrives
   ([example](./contract/examples/fulfillment.assignment.created.cloudevent.json)). Its `data`
   has exactly six keys (assignment id, order id, stage, state, event version, time) and no
   customer identity, address or line items.
2. **Reconcile.** Read `GET /fulfillment/assignments`
   ([example](./contract/examples/fulfillment.assignments.response.json)) for the platform
   `purchaseId` and line SKUs and quantities. This is also the recovery path when a delivery is
   late or lost. Held, cancelled, released and other installs' orders are absent.
3. **Read the recipient** with `GET /fulfillment/orders/{orderId}/recipient`
   ([example](./contract/examples/fulfillment.recipient.response.json)), one order per request,
   only while the merchant owner's consent for your install and the fulfillment-shipping purpose
   is live. The response is ship-to only (no email, phone or bill-to), is never sent in a webhook
   and is `no-store`; do not log or persist it beyond your declared purpose. Reads are audited
   and rate-limited per install.
4. **Report the label outcome** with `POST /fulfillment/orders/{orderId}/shipment-evidence`,
   `kind: label-outcome` ([example](./contract/examples/fulfillment.shipment-evidence.label-outcome.request.json)),
   under the platform `purchaseId`. Storefront never buys a label or contacts a carrier: your
   label provider does, and you report the result. `outcome` is `purchased`, `unknown` or
   `voided`; a purchased label requires carrier, service, tracking number, tracking URL and the
   adult-signature result.
5. **Report the handoff** with `kind: handoff`
   ([example](./contract/examples/fulfillment.shipment-evidence.handoff.request.json)) once the
   carrier has accepted the parcel. The carrier must equal the label carrier. An accepted handoff
   emits `order.fulfilled` once. The response is the minimized shipment view
   ([example](./contract/examples/fulfillment.shipment-evidence.response.json)).
6. **Follow updates.** `fulfillment.assignment.updated` reports `held`, `active` again, or
   `cancelled`. A release (processor changed or cleared, install suspended, uninstalled or
   descoped) emits no event: the next call is refused with `assignment-ended`.

Orders are fulfilled whole. There is no split shipment, rate quote, label purchase, return or
change to payment, tax, price or checkout.

### Idempotency

`Idempotency-Key` is required on shipment evidence and is scoped to your install. The same key
with the same body, assignment and order returns the original response. The same key with a
different body or assignment is refused with `409 idempotency-conflict`. Re-reporting an
identical fact under a new key is accepted and answers `200`. Label moves are limited: intent to
`purchased`, `unknown` or `voided`; `unknown` to `purchased` or `voided`; `purchased` only
repeats identical facts; nothing leaves `voided`. Reconcile an `unknown` label under the same
`purchaseId` rather than purchasing again. Deduplicate assignment events on the CloudEvents `id`.

### Refusal codes

Refusals are JSON with a stable `code` (branch on it, never on `error`), and always
`cache-control: no-store`. A refusal never carries a contact value.

| Status and code | Meaning |
|---|---|
| 401 `invalid_token` | Token missing, invalid or expired, or install not active. |
| 403 `scope_denied` | Scope absent from the install grant or token. |
| 403 `denied` | A `tenant`, `tenantId` or `stage` query parameter was sent. |
| 409 `stage-unknown` | The routed stage could not be resolved, or the order's stage differs from it. |
| 503 `unconfigured`, `unavailable` | App gateway not configured, or storage unavailable. |
| 404 `not-assigned` | No assignment of this order has ever named your install. One code for nonexistent and foreign orders. |
| 409 `assignment-held` | Your assignment is held, or the order is not releasable at its current version. |
| 409 `assignment-ended` | Your assignment was cancelled or released, or the body binds a superseded assignment. |
| 403 `consent-missing`, `consent-revoked`, `consent-expired` | Recipient read only: no live owner consent. |
| 429 `quota` | Recipient read only: hourly read quota reached. |
| 410 `contact-erased`, `contact-expired` | Recipient read only: the recipient is no longer retained. |
| 404 `contact-absent` | Recipient read only: the order has no ship-to. |
| 409 `contact-unreadable` | Recipient read only: the stored recipient cannot be read. |
| 503 `audit-unavailable`, `vault-key-unavailable` | Recipient read only: refused, nothing disclosed. Retry later. |
| 400 `malformed` | Shipment evidence only: body outside the closed schema, unknown carrier, unsafe tracking URL, or missing `Idempotency-Key`. |
| 409 `idempotency-conflict` | Shipment evidence only: key reused with another body or assignment. |
| 409 `label-regress` | Shipment evidence only: a disallowed label move. |
| 409 `conflict` | Shipment evidence only: a differing carrier, service, tracking number or adult-signature result under one purchase id, or a purchase id other than the platform's. |
| 409 `carrier-prohibited`, `carrier-mismatch` | Shipment evidence only: carrier not permitted, or handoff carrier differs from the label carrier. |
| 409 plus `holds` | Handoff only: a release hold or unmet handoff gate; `holds` lists the codes in force. |

[`openapi.yaml`](./contract/openapi.yaml) (`FulfillmentRefusal.code`) is the authority for this
list.

### Webhooks are notifications, not authorizations

A `fulfillment.assignment.*` delivery tells you something changed; it never authorizes you to
act. Every read and write re-checks that your install holds the scope and that the order's active
assignment names your install, so a late, replayed or forged notification gains nothing. Verify
the signature, deduplicate on `id`, then reconcile through the API before acting. Return a 2xx
only once the event is safely accepted, and never use a response to approve or alter a
platform decision.

## Data minimization and failure handling

Treat values as tenant-scoped and minimized. Do not attempt to obtain raw checkout payloads,
customer identity, signed-cart data, tax internals, or compliance-decision data. Do not log raw
authorization headers or credentials. Store only what your declared purpose and retention policy
require.

On a rejected or failed webhook, return a non-2xx response so the delivery system can retry. Make
your handler idempotent, monitor the installation's public delivery-health endpoint, and use the
app-owned replay endpoint only for that installation's own deliveries. Operator workflows and
internal forwarding paths are intentionally outside this public guide.
