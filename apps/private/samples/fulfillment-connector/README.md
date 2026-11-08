# Fulfillment connector — reference sample

A runnable, dependency-free reference implementation of the
[fulfillment connector](../../webhooks-and-api.md#fulfillment-connector) side of the Private Apps
contract, written against the published files in [`../../contract/`](../../contract/) and nothing
else. It is a sample to read, run and copy from. It is not a library, not a ToT-hosted service, and
not part of the platform. It runs on Node 20 or later (`node server.js`) or as its own Cloudflare
Worker (`worker.js`), with no dependencies: Node built-ins and Web Crypto only.

## What it does

1. **Receives** `fulfillment.assignment.created` / `.updated` deliveries and, in the order the guide
   gives, reads the raw body, recomputes `Content-Digest` (RFC 9530), verifies the RFC 9421
   `sig1` signature (`rsa-v1_5-sha256` over `@method`, `@target-uri`, `content-digest`) against the
   key `webhook_signing_keys` publishes for its `keyid`, exactly as
   [Signature details](../../webhooks-and-api.md#signature-details) specifies, validates the CloudEvents envelope and the six-key `data`,
   and deduplicates on the CloudEvents `id`. A tampered body, a bad or stale signature, an unknown
   key or an unsupported algorithm is refused with a non-2xx status.
2. **Reconciles** with `GET /fulfillment/assignments`. The delivery is a notification only: the
   connector acts on what the reconciliation read says is assigned, and the same read runs on a
   timer (a cron trigger on Workers) as the recovery path for late or lost deliveries.
3. **Reads the recipient** of the assigned order only (`GET /fulfillment/orders/{orderId}/recipient`)
   and hands it, in memory, to one label call.
4. **Buys the label** through a simulated external label provider built into the sample
   ([`src/label-provider.js`](./src/label-provider.js)). Storefront never buys labels; your provider
   does, and the connector reports the result.
5. **Reports evidence** with `POST /fulfillment/orders/{orderId}/shipment-evidence`: `label-outcome`
   first, then `handoff` once the carrier has accepted the parcel. Every post carries a stable
   `Idempotency-Key` derived from the order id and the canonical evidence body, so a retry re-sends
   identical bytes under the identical key and a different fact always gets a different key.

Every pass asks the provider about the `purchaseId` first (`lookup`), before it reads the
recipient, and buys only when the provider has no attempt on record. So an `unknown` label outcome
is reported once and then reconciled with the provider under the same `purchaseId` on later passes,
and the connector never buys a second label or reads the recipient again, even after a restart has
lost its memory. A `409 label-regress` on a repeated `unknown` report means the gateway already
holds it, and reconciliation continues. Refusals are handled by their stable `code`
(`assignment-ended`, `assignment-held`, `not-assigned`, consent codes and so on), never by text.

## Contact data

The ship-to recipient exists in one local variable for the duration of one label call. It is never
logged, persisted, placed in evidence, or returned. A caught error is logged by its class and a
fixed code (`label_provider_failed`), never by its message, because a provider exception could
quote the ship-to it was handed. The logger additionally drops any field named
like a recipient or credential. `test/no-contact-in-logs.test.js` captures the logger output and the
process's stdout and stderr across every flow and fails if any recipient value appears.

## Run it

```sh
npm test                 # node --test, no sockets, no network
node demo.js             # offline walkthrough against the built-in local gateway simulator
```

The demo signs the contract's synthetic `fulfillment.assignment.created` example, passes it through
the same handler the server uses, completes the label and handoff, then shows a redelivery of the
same event id being deduplicated. Simulation flags make the edge cases triggerable, alone or
together:

| Flag | Effect |
|---|---|
| `--label-outcome=unknown` | The provider answers `unknown`; the connector reports `outcome: unknown`, reconciles under the same `purchaseId`, then reports `purchased`. |
| `--force-retry` | Every evidence post is sent a second time with the same key and identical body; the connector checks that the original response is replayed. |
| `--conflicting-key-reuse` | The handoff body is first sent under the label-outcome key; the connector expects `409 idempotency-conflict`, then posts under the correct key. |

The same flags work on `server.js`. The Worker takes none: simulation is a command-line switch so a
deploy configuration can never leave it on. The local simulator ([`sim/local-gateway.js`](./sim/local-gateway.js))
is a test double built from the published contract and seeded with its synthetic examples; it is not
a description of how the platform is built.

## Host it on Cloudflare Workers

The sample deploys as its own Worker, `tot-fulfillment-connector-sample`, on your `workers.dev`
subdomain. It is separate from any storefront Worker and shares nothing with one.
[`wrangler.toml`](./wrangler.toml) holds no account id and no secrets: `wrangler` uses the account
you are logged in to, and all four settings are Worker secrets.

```sh
npx wrangler login
npx wrangler secret put TOT_APP_CLIENT_ID
npx wrangler secret put TOT_APP_CLIENT_SECRET
npx wrangler secret put TOT_STOREFRONT_BASE_URL   # https://<tenant>.tokenoftrust.store
npx wrangler secret put WEBHOOK_PUBLIC_URL        # https://tot-fulfillment-connector-sample.<subdomain>.workers.dev/webhooks/tot
npx wrangler deploy
npx wrangler tail                                 # JSON log lines; no contact is ever logged
```

Register the same `WEBHOOK_PUBLIC_URL` as `webhooks.endpoint` in [`tot-app.json`](./tot-app.json).
The Worker answers `POST` on that URL's path and `404` elsewhere. The cron trigger
(`*/5 * * * *`) runs the reconciliation pass. `nodejs_compat` is on because the code imports
`node:crypto` (hashing), `node:buffer` and `node:util`; signature verification itself is Web Crypto.

**Sample limitation: state is per isolate.** The seen-event-id set and the per-assignment state
live in the memory of the isolate that handled the request. Cloudflare runs many isolates and evicts
them at will, so a redelivery that lands on another isolate, or after eviction, is not recognized as
a duplicate, and a cron run starts with no memory of in-flight work. The gateway's Idempotency-Key
replay keeps a repeat harmless (the same fact under the same key answers with the original
response), and the reconciliation read decides what is still assigned, but the sample does not
dedupe across isolates. A production connector persists both (they carry opaque ids and states
only), for example in a Durable Object, D1 or KV.

## Host it on Node

```sh
TOT_APP_CLIENT_ID=... TOT_APP_CLIENT_SECRET=... \
TOT_STOREFRONT_BASE_URL=https://<tenant>.tokenoftrust.store \
WEBHOOK_PUBLIC_URL=https://<your-host>/webhooks/tot \
node server.js
```

| Variable | Required | Meaning |
|---|---|---|
| `TOT_APP_CLIENT_ID`, `TOT_APP_CLIENT_SECRET` | yes | Installation credentials from the approved setup flow. Server-side only. |
| `TOT_STOREFRONT_BASE_URL` | yes | The tenant's storefront origin (https). The API is `/api/apps/v1`; the token endpoint and the webhook signing keys are discovered from `/.well-known/tot-app-authorization-metadata`. |
| `WEBHOOK_PUBLIC_URL` | yes | The exact HTTPS URL registered as `webhooks.endpoint` in [`tot-app.json`](./tot-app.json). It is the signed `@target-uri`, so it must match byte for byte. |
| `PORT` | no | Local listen port, default 8787. Terminate TLS in front of it. |
| `RECONCILE_INTERVAL_SECONDS` | no | Reconciliation timer, default 300. |

Hosting needs a publicly reachable HTTPS endpoint for `WEBHOOK_PUBLIC_URL`, outbound HTTPS to the
tenant's storefront origin, and an install granted `fulfillment:process` and
`orders:read:recipient` with the merchant's processor configuration and owner consent in place
(see [`tot-app.json`](./tot-app.json)). Configuration is environment-only; nothing in this directory
is a real credential, tenant or address.

## Before production

- Replace `src/label-provider.js` with your real provider client, keeping its contract: idempotent
  by `purchaseId`, a `lookup` that answers for any earlier attempt (`null` when there was none)
  without the ship-to, so an `unknown` is reconciled without buying again, ship-to used for
  the call only.
- Persist the seen event ids and the per-assignment state (opaque ids and states only) instead of
  holding them in memory (per process on Node, per isolate on Workers).
- Wait for the carrier's real acceptance scan before reporting `handoff`; the simulator accepts at
  once.
- Keep the defaults that make verification strict: covered components `@method`, `@target-uri` and
  `content-digest`; a 300-second signature age limit; one bounded key refresh on an unknown `keyid`.

## Files

| Path | Purpose |
|---|---|
| `server.js` | Node entry point: `node:http` listener plus the reconciliation timer. |
| `worker.js`, `wrangler.toml` | Cloudflare Workers entry point: `fetch` for deliveries, `scheduled` for the reconciliation cron. |
| `demo.js` | Offline walkthrough with the simulation flags. |
| `src/http-signature.js`, `src/structured-fields.js` | Content-Digest and RFC 9421 verification. |
| `src/gateway-metadata.js` | Authorization-metadata discovery and signing-key cache. |
| `src/gateway-client.js` | Client-credentials token, the three `/fulfillment` routes, stable idempotency keys, retries. |
| `src/connector.js` | Reconcile, recipient, label, evidence. |
| `src/webhook.js` | Delivery handler and the `node:http` adapter. |
| `src/label-provider.js` | Simulated external label provider. |
| `sim/local-gateway.js` | In-memory gateway double used by the demo and tests. |
| `tot-app.json` | Manifest with exactly the two fulfillment scopes and topics. |
| `test/` | `node:test` suites. |
