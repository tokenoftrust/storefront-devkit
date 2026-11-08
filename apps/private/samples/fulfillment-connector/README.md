# Fulfillment connector — reference sample

A runnable, dependency-free reference implementation of the
[fulfillment connector](../../webhooks-and-api.md#fulfillment-connector) side of the Private Apps
contract, written against the published files in [`../../contract/`](../../contract/) and nothing
else. It is a sample to read, run and copy from. It is not a library, not a ToT-hosted service, and
not part of the platform. Node 20 or later, Node built-ins only (`node:crypto`, `node:http`,
`node:test`).

## What it does

1. **Receives** `fulfillment.assignment.created` / `.updated` deliveries and, in the order the guide
   gives, reads the raw body, recomputes `Content-Digest` (RFC 9530), verifies the RFC 9421
   `Signature-Input` / `Signature` against the public key the gateway authorization metadata
   publishes for the declared `keyid`, validates the CloudEvents envelope and the six-key `data`,
   and deduplicates on the CloudEvents `id`. A tampered body, a bad or stale signature, an unknown
   key or an unsupported algorithm is refused with a non-2xx status.
2. **Reconciles** with `GET /fulfillment/assignments`. The delivery is a notification only: the
   connector acts on what the reconciliation read says is assigned, and the same read runs on a
   timer as the recovery path for late or lost deliveries.
3. **Reads the recipient** of the assigned order only (`GET /fulfillment/orders/{orderId}/recipient`)
   and hands it, in memory, to one label call.
4. **Buys the label** through a simulated external label provider built into the sample
   ([`src/label-provider.js`](./src/label-provider.js)). Storefront never buys labels; your provider
   does, and the connector reports the result.
5. **Reports evidence** with `POST /fulfillment/orders/{orderId}/shipment-evidence`: `label-outcome`
   first, then `handoff` once the carrier has accepted the parcel. Every post carries a stable
   `Idempotency-Key` derived from the order id and the canonical evidence body, so a retry re-sends
   identical bytes under the identical key and a different fact always gets a different key.

An `unknown` label outcome is reported as such and then reconciled with the provider under the same
`purchaseId`; the connector never buys a second label. Refusals are handled by their stable `code`
(`assignment-ended`, `assignment-held`, `not-assigned`, consent codes and so on), never by text.

## Contact data

The ship-to recipient exists in one local variable for the duration of one label call. It is never
logged, persisted, placed in evidence, or returned. The logger additionally drops any field named
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

The same flags work on `server.js`. The local simulator ([`sim/local-gateway.js`](./sim/local-gateway.js))
is a test double built from the published contract and seeded with its synthetic examples; it is not
a description of how the platform is built.

## Host it

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
  by `purchaseId`, a `lookup` that reconciles an `unknown` without buying again, ship-to used for
  the call only.
- Persist the seen event ids and the per-assignment state (opaque ids and states only) instead of
  holding them in memory.
- Wait for the carrier's real acceptance scan before reporting `handoff`; the simulator accepts at
  once.
- Keep the defaults that make verification strict: covered components `@method`, `@target-uri` and
  `content-digest`; a 300-second signature age limit; one bounded key refresh on an unknown `keyid`.

## Files

| Path | Purpose |
|---|---|
| `server.js` | Production entry point: `node:http` listener plus the reconciliation timer. |
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
