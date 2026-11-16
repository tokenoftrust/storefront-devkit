# connector-kit

The reviewed client half of the Storefront Private Apps contract
([`apps/private/contract/`](../../apps/private/contract/)). A connector that vendors this kit gets
four things right by default instead of rebuilding them:

| Concern | Kit piece |
|---|---|
| Installation tokens: `client_secret_basic`, `client_secret_post` or `private_key_jwt`, cached and refreshed early | `ConnectorAuthClient` |
| Webhook authenticity: `Content-Digest`, RFC 9421 `sig1`, the `created` window, keyid lookup in the published keys, replay guard | `WebhookReceiver` |
| API calls: `Idempotency-Key` on every write, reused on retry; `Retry-After` honored; bounded backoff; cursor pagination | `ApiClient` |
| One error model: a stable `code` to branch on, never remote text | `ConnectorError` and subclasses |

Zero dependencies, ESM, Web Crypto and `fetch` only. It runs unchanged on Node 20+ and on
fetch-based edge runtimes.

## Shipping model: vendored source

This kit is **source you copy**, not a package you install. It is `private: true` and is never
published to a registry.

1. Copy `packages/connector-kit/src/` into your project, for example as `vendor/connector-kit/`.
2. Import from `./vendor/connector-kit/index.js`.
3. Do not edit the copy. To upgrade, replace the directory with a newer one and read
   [`CHANGELOG.md`](../../CHANGELOG.md). `KIT_VERSION` names the copy you hold.

Recipes and the app scaffold vendor the kit the same way.

## Quick start

```js
import { ApiClient, AuthorizationMetadata, ConnectorAuthClient, WebhookReceiver } from './vendor/connector-kit/index.js';

const origin = process.env.TOT_STOREFRONT_ORIGIN; // e.g. https://acme.tokenoftrust.store

const auth = new ConnectorAuthClient({
  origin,
  clientId: process.env.TOT_CLIENT_ID,
  clientSecret: process.env.TOT_CLIENT_SECRET, // client_secret_basic by default
});
const api = new ApiClient({ origin, auth });

// Writes: the kit adds an Idempotency-Key (or pass your own) and reuses it on every retry.
await api.post('/inventory/movements', { sku: 'SKU-1', quantityDelta: -2 }, { idempotencyKey: 'inv-0001-abcdef' });

// Lists: drain every page.
const { items, truncated } = await api.collect('/catalog/products', { limit: 100, updatedSince: lastSync });

// Webhooks: verify before parsing; only verified, first-seen events reach the handler.
const receiver = new WebhookReceiver({
  endpoint: 'https://connector.example.com/webhooks/tot', // exactly as registered in tot-app.json
  keys: new AuthorizationMetadata({ origin }),
});
export default { fetch: (request) => receiver.handleRequest(request, async (event) => { /* reconcile via api */ }) };
```

## `ConnectorAuthClient`

```js
new ConnectorAuthClient({ origin, clientId, clientSecret?, privateKey?, keyId?, method?, refreshSkewSeconds = 60,
  assertionLifetimeSeconds = 60, retry?, fetch?, now?, sleep?, random?, randomId? })
```

- `method` defaults to `private_key_jwt` when `privateKey` is given, otherwise `client_secret_basic`.
  Pass `method: 'client_secret_post'` to send the secret in the form body. Exactly one method is
  used per request; mixing a secret and a key is refused at construction.
- `client_secret_basic` form-urlencodes each half before Base64, per RFC 6749 section 2.3.1.
- `private_key_jwt` signs an RFC 7523 assertion with `RS256` (RSA key) or `ES256` (EC P-256 key):
  `iss` and `sub` are the client id, `aud` is the origin's token endpoint, `exp` is
  `assertionLifetimeSeconds` ahead (at most 300), and `jti` is fresh per request. `privateKey` is a
  private `CryptoKey` or a private JWK; `keyId` (or the JWK's `kid`) becomes the header `kid` and
  must match the public key registered for the client.
- The token endpoint is always `<origin>/api/apps/oauth/token`.

| Method | Purpose |
|---|---|
| `getAccessToken({ forceRefresh })` | A bearer token. Refreshes when less than `refreshSkewSeconds` (capped at half the lifetime) remain. Concurrent callers share one request. |
| `getToken()` | `{ accessToken, issuedAt, expiresAt, scope }` (`scope` is an array). |
| `invalidate(token?)` | Drop the cached token; with an argument, only if it is still the cached one. |
| `createClientAssertion()` | A signed assertion, for diagnostics. |

Token refusals throw `AuthError` whose `code` is the OAuth `error` (`invalid_client`,
`invalid_grant`, `invalid_request`, `unsupported_grant_type`, `temporarily_unavailable`) or
`unexpected`. `error_description` is never read. 503 and other retryable answers are retried up to
`retry.maxAttempts` (default 3), with a fresh assertion each time.

## `WebhookReceiver`

```js
new WebhookReceiver({ endpoint, keys, seenEvents?, maxAgeSeconds = 300, maxClockSkewSeconds = 60,
  replayTtlSeconds = 604800, maxBodyBytes = 1048576, now? })
```

- `endpoint` is your registered `webhooks.endpoint`, character for character. It is the signed
  `@target-uri`; the kit never reads it from the request.
- `keys` resolves a `keyid` to a public key: `new AuthorizationMetadata({ origin })` reads
  `webhook_signing_keys` from `/.well-known/tot-app-authorization-metadata`, caches it for its
  `max-age`, and refetches once (at most every 30 s) on an unknown keyid. `new StaticSigningKeys(jwks)`
  pins a key set (tests, air-gapped setups).
- `seenEvents` is the replay guard: `{ claim(key, ttlSeconds) -> Promise<boolean>, release(key) }`.
  `claim` must be atomic (a unique-key insert with an expiry). The default `MemorySeenEventStore`
  is per-process; a deployment with more than one instance or any restart needs a durable store.
  The key is `<tenantid>/<id>`.

Checks, in order: method `POST`, body size, `Content-Digest` sha-256 over the raw bytes, `sig1`
`Signature-Input`/`Signature` (covers `@method`, `@target-uri`, `content-digest`; `alg`
`rsa-v1_5-sha256`; `created` within `maxAgeSeconds` old and `maxClockSkewSeconds` ahead; `expires`
not passed), keyid lookup, signature, JSON, CloudEvents envelope (`specversion` 1.0, the required
attributes, a `com.tokenoftrust.storefront.` type, object `data`), then the replay guard.
Event-specific `data` validation is yours, against [`asyncapi.yaml`](../../apps/private/contract/asyncapi.yaml).

| Method | Result |
|---|---|
| `verify({ method, headers, body })` | `{ ok: true, event, keyid, created, replayKey }` or `{ ok: false, status, code }`. On `ok: true` the id is claimed; call `release(replayKey)` if you then fail to handle it. |
| `receive(delivery, onEvent)` | Runs `onEvent(event, { keyid, created })` after `verify`. Answers `{ status, body }`: 202 accepted, 200 replay, refusal status, or 500 with the id released when `onEvent` throws (so the retry is processed). |
| `handleRequest(request, onEvent)` | `receive` for a fetch `Request`; resolves a `Response`. |

`body` must be the exact raw bytes (`Uint8Array`, `ArrayBuffer`, or the unmodified string). Refusal
codes and statuses are in `WEBHOOK_REFUSALS`: `method_not_allowed` 405, `body_too_large` 413,
`digest_*` 400, `signature_*`/`unsupported_alg`/`unknown_key` 401, `body_not_json` and
`envelope_invalid` 400, `replayed_event` 200 (acknowledged, never handed to you).

A delivery is a notification, not an authorization: reconcile through the API before acting.

## `ApiClient`

```js
new ApiClient({ origin, auth, retry?, fetch?, sleep?, random?, now?, onRetry? })
```

`auth` is anything with `getAccessToken()` (and optionally `invalidate(token)`), usually a
`ConnectorAuthClient`. Paths are relative to `/api/apps/v1`; pass `query` separately.

| Method | Purpose |
|---|---|
| `get(path, { query, traceparent, headers, signal })` | Read. |
| `post / put / patch(path, body, { idempotencyKey, query, traceparent, headers, signal })` | Write. |
| `delete(path, { idempotencyKey, ... })` | Write. |
| `request({ method, path, query, body, idempotencyKey, traceparent, headers, signal })` | Any of the above. |
| `pages(path, { query, limit, updatedSince, cursor, itemsKey, maxPages, signal })` | Async iterator of `{ items, nextCursor, truncated, body, requestId }`, following `nextCursor` until absent. |
| `items(path, options)` | Async iterator over every item. |
| `collect(path, options)` | `{ items, truncated, pages }`. `truncated: true` means a page said the server returned less than everything; run a full backfill without `updatedSince`. |

Success resolves `{ status, body, headers, requestId, idempotencyKey? }`.

- **Idempotency.** Every `POST`, `PUT`, `PATCH` and `DELETE` carries `Idempotency-Key`: yours, or one
  generated per call. The body is serialized once and every retry sends the same bytes under the
  same key, so a lost response is safe to retry. Use `deriveIdempotencyKey(prefix, ...parts)` for a
  key that survives a restart (the same fact always yields the same key) or `newIdempotencyKey()`.
- **Retries.** 408, 429, 502, 503, 504 and network failures are retried up to `retry.maxAttempts`
  (default 5). `Retry-After` (seconds or HTTP-date) is waited exactly; otherwise backoff is full
  jitter from `retry.baseDelayMs` (250) doubling to `retry.maxDelayMs` (20 000). A `Retry-After`
  longer than `retry.maxRetryAfterMs` (120 000) is not waited in-process: the error is thrown with
  `retryAfterMs` so you can schedule the retry.
- **Auth.** One 401 invalidates the token, fetches a new one and repeats the call.
- **Redirects** are refused, never followed.

## Error model

Every failure is a `ConnectorError` with `kind`, `code`, and when known `status`, `requestId`
(`tot-request-id`), `retryable`, `retryAfterMs` and `holds`. `message` is `kind:code (status)`;
`toJSON()` returns only those fields, so an error is safe to log.

| Class | `kind` | `code` |
|---|---|---|
| `ApiError` | `api` | The response body's `code` (e.g. `scope_denied`, `idempotency-conflict`, `assignment-ended`), else `http_<status>` for an empty body, else `unexpected`. |
| `AuthError` | `auth` | The OAuth `error`, `invalid_token_response`, or `unexpected`. |
| `TransportError` | `transport` | `network`, `aborted`, `redirect_refused`, `pagination_stalled`, `metadata_unreachable`, `metadata_unavailable`, `token_endpoint_refused`. |

Branch on `code`. A code that is not shaped like one (`[a-z][a-z0-9_.:-]*`, up to 64 characters)
becomes `unexpected`, and remote `message`/`error` text is never copied.

Webhook refusals are results, not exceptions (see `WebhookReceiver`).

## Tests

`node --test packages/connector-kit/test/*.test.js` (also part of the repo's `npm run check`). The
webhook tests verify a fixed vector produced by the Storefront signer and reject a tampered body,
an expired window, an unknown keyid and a replayed event id.
