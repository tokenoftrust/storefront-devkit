# Hosting Fast-Path: Cloudflare Workers

**Topology:** Edge Serverless Isolates (`fetch` + `scheduled` Cron Triggers + Workers KV / D1)

Cloudflare Workers is the fastest way to deploy a zero-dependency Storefront Private App. Workers
natively support Web Crypto (`crypto.subtle`) for RFC 9421 HTTP Message Signature verification and
RFC 7523 `private_key_jwt` signing, expose raw request bytes via `await request.arrayBuffer()`, and
run scheduled reconciliation passes in the same Worker via Cron Triggers.

For a complete, runnable single-tenant Worker sample, see
[`../../samples/fulfillment-connector/worker.js`](../../samples/fulfillment-connector/worker.js) and
[`../../samples/fulfillment-connector/wrangler.toml`](../../samples/fulfillment-connector/wrangler.toml).

---

## 1. Minimal `wrangler.toml`

```toml
name = "tot-private-app-connector"
main = "worker.mjs"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

# 5-minute scheduled reconciliation pass (recovers any delayed webhook delivery)
[triggers]
crons = ["*/5 * * * *"]

# Durable CloudEvent (tenantid, id) deduplication across Worker isolates
[[kv_namespaces]]
binding = "DEDUPE_KV"
id = "<your-kv-namespace-id>"
```

Store credentials as Worker secrets (never in `wrangler.toml`):

```bash
npx wrangler login
npx wrangler secret put TOT_PRIVATE_KEY_JWK      # JWK for private_key_jwt (or TOT_APP_CLIENT_SECRET for test)
npx wrangler secret put WEBHOOK_PUBLIC_URL       # e.g. https://tot-private-app-connector.<subd>.workers.dev/webhooks/tot
npx wrangler deploy
```

---

## 2. Raw-Body Webhook Verification & Multi-Tenant Routing (`worker.mjs`)

On Cloudflare Workers, always read `await request.arrayBuffer()` (or `await request.text()`) once
and verify `Content-Digest` + `Signature` **before** trusting the JSON payload:

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Optional: serve your public JWKS for clientAuth.method = "private_key_jwt"
    if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      return Response.json({ keys: [JSON.parse(env.TOT_PUBLIC_KEY_JWK)] });
    }

    if (request.method !== "POST" || url.pathname !== "/webhooks/tot") {
      return new Response("Not Found", { status: 404 });
    }

    // 1. Read exact raw bytes BEFORE parsing JSON
    const rawBytes = new Uint8Array(await request.arrayBuffer());
    const rawText = new TextDecoder().decode(rawBytes);

    let event;
    try {
      event = JSON.parse(rawText);
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    // 2. Resolve tenant & install from the CloudEvents 1.0 envelope (supports multi-tenant hosting)
    const tenantId = event.tenantid;
    const installId = event.appinstallid;
    if (!tenantId || !installId || !event.id) {
      return Response.json({ error: "missing_cloudevent_context" }, { status: 400 });
    }

    // 3. Verify RFC 9530 Content-Digest + RFC 9421 Signature against the tenant gateway's signing keys
    const verified = await verifyTotWebhook({
      method: request.method,
      targetUri: env.WEBHOOK_PUBLIC_URL || request.url,
      headers: request.headers,
      rawBytes,
      tenantId,
    });
    if (!verified.ok) {
      return Response.json({ error: verified.code }, { status: 401 });
    }

    // 4. Deduplicate across Worker isolates using KV (7-day TTL)
    const dedupeKey = `ce:${tenantId}:${event.id}`;
    if (await env.DEDUPE_KV.get(dedupeKey)) {
      return Response.json({ ok: true, deduplicated: true }, { status: 200 });
    }

    // 5. Process event for (tenantId, installId) and mark delivered
    await handleStorefrontEvent(event, { tenantId, installId, env });
    await env.DEDUPE_KV.put(dedupeKey, "1", { expirationTtl: 7 * 86400 });

    return Response.json({ ok: true }, { status: 200 });
  },

  async scheduled(_controller, env, _ctx) {
    // Poll GET /api/apps/v1/fulfillment/assignments (or /orders) for each active tenant install
    await reconcileAllTenants(env);
  },
};
```

---

## 3. Production Checklist on Cloudflare Workers

- **Never rely on in-memory `Set`/`Map` for deduplication:** Cloudflare runs many isolates and
  evicts them at will. Persist `(tenantid, event.id)` in **Workers KV**, **D1**, or a **Durable
  Object**.
- **Keep `redirect: "manual"` on outbound `fetch` calls:** `workerd` does not support
  `redirect: "error"`; use `redirect: "manual"` and refuse any `3xx` response so Bearer tokens are
  never followed across redirects.
- **Zero PII in `wrangler tail`:** Never log the `shipTo` object returned by
  `GET /api/apps/v1/fulfillment/orders/{orderId}/recipient`.
