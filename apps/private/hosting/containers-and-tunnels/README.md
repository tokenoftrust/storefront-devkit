# Hosting Fast-Path: Portable Containers (`Dockerfile`), Pull-Only Jobs & Local Preview Tunnels

**Topology:** Portable OCI Containers (Fly.io, Render, Railway, AWS App Runner/ECS, GKE, AKS),
Outbound-Only Cron Jobs, and Local `env="test"` Preview Tunnels

---

## 1. Portable Container Deployment (`Dockerfile`)

Every app created with `tot app scaffold <name>` includes a zero-dependency Node.js HTTP server
(`server.js`) and a production-ready `Dockerfile`. You can deploy this container unchanged to **Fly.io**,
**Railway**, **Render**, **AWS App Runner / ECS Fargate**, **Google Cloud Run**, **Azure Container
Apps**, **DigitalOcean App Platform**, or any **Kubernetes** cluster:

```dockerfile
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
COPY tot-app.json server.js ./
COPY lib ./lib
COPY fixtures ./fixtures
USER node
EXPOSE 8787
CMD ["node", "server.js"]
```

### Container Host Requirements

1. **TLS Termination:** Terminate HTTPS at your platform's ingress/load balancer and forward
   requests to `PORT=8787`.
2. **Exact `WEBHOOK_PUBLIC_URL`:** Set `WEBHOOK_PUBLIC_URL=https://<your-domain>/webhooks` so
   RFC 9421 `@target-uri` verification matches the public HTTPS URL declared in `tot-app.json`
   `webhooks.endpoint`.
3. **Shared Deduplication Store:** When scaling beyond 1 container instance (or across container
   redeploys), store seen `(tenantid, event.id)` keys in Redis, Postgres, or your cloud's managed KV
   store rather than in-process memory.

---

## 2. Pull-Only Scheduled Connectors (Zero Inbound Endpoints)

Not every Private App needs a public webhook endpoint!

In `tot-app.schema.json`, **`webhooks` is optional**, and **`clientAuth` supports inline public keys
(`clientAuth.jwks.keys`)** in addition to `jwksUri`. If your integration is a periodic batch job —
for example:
- Nightly or 15-minute inventory level reconciliation (`PUT /api/apps/v1/inventory/levels` or
  `POST /api/apps/v1/inventory/movements`)
- Polling `GET /api/apps/v1/orders?updatedSince=...` or `GET /api/apps/v1/reports`
- Pulling `GET /api/apps/v1/fulfillment/assignments` on a 5-minute schedule

Then **you do not need to expose any inbound HTTP port or public URL at all.** You can run your
connector as an outbound-only scheduled job on:
- **GitHub Actions** (`on: schedule: [{ cron: '*/15 * * * *' }]`)
- **Google Cloud Run Jobs** / **Azure Container Apps Jobs** / **AWS Batch / ECS Scheduled Tasks**
- **An internal warehouse/ERP cron server** behind a corporate firewall (requires only outbound
  HTTPS port 443 to `https://<tenant>.tokenoftrust.store`).

---

## 3. Local Preview Tunneling for `env="test"` (`cloudflared`, `devtunnel`, `ngrok`)

When testing your app against a live Storefront **`preview` stage** (`env="test"`), Storefront needs
a publicly reachable `https://` URL to deliver webhooks triggered by `POST /api/apps/admin/test-orders`.

Before deploying to cloud infrastructure, you can bridge a remote `preview` store directly to
`localhost:8787` on your workstation in 3 commands:

### Option A — Cloudflare Quick Tunnel (`cloudflared`)
```bash
# Terminal 1: Start your local receiver
node server.js

# Terminal 2: Open an ephemeral HTTPS tunnel to port 8787
cloudflared tunnel --url http://localhost:8787
# -> Prints https://<random-words>.trycloudflare.com

# Terminal 3: Install or update your test app on the store's preview stage with that HTTPS URL
tot app install --tenant <tenant> --env test \
  --webhook-endpoint https://<random-words>.trycloudflare.com/webhooks
```

### Option B — Microsoft Dev Tunnels (`devtunnel`)
```bash
devtunnel host -p 8787 --allow-anonymous
# -> Use the printed https://<id>-8787.<region>.devtunnels.ms/webhooks URL
```

### Option C — `ngrok`
```bash
ngrok http 8787
# -> Use the printed https://<id>.ngrok-free.app/webhooks URL
```

> **Important:** Make sure your local `server.js` verifies `@target-uri` against the public
> `https://<tunnel-host>/webhooks` URL (via `WEBHOOK_PUBLIC_URL` or `x-forwarded-proto` +
> `x-forwarded-host`), not `http://localhost:8787/webhooks`.
