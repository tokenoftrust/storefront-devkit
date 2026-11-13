# Hosting Fast-Path: Microsoft Azure (Azure Functions & Azure Container Apps)

**Topology:** Cloud Function-as-a-Service & Managed Containers on Microsoft Azure

Microsoft Azure provides two first-class hosting models for single-tenant or multi-tenant Storefront
Private Apps:
1. **Azure Functions (Node.js v4 programming model)** — combines an HTTP Trigger (`POST /webhooks/tot`
   and `GET /.well-known/jwks.json`) and a 5-minute **Timer Trigger** (`0 */5 * * * *`) in a single
   deployment unit.
2. **Azure Container Apps** — runs any containerized connector (`Dockerfile`) with scale-to-zero KEDA
   HTTP rules, revision management, and scheduled Container App Jobs.

Pair either with **Azure Key Vault** (via Managed Identity for `private_key_jwt` signing keys) and
**Azure Table Storage** or **Azure Cosmos DB** for durable `(tenantid, id)` CloudEvent deduplication.

---

## 1. Option A — Azure Functions (Node.js v4 Programming Model)

In the Azure Functions v4 model (`@azure/functions`), `request` is a standard Fetch-style interface.
Call `await request.arrayBuffer()` to read the exact unparsed wire bytes before verifying the RFC 9530
`Content-Digest` and RFC 9421 `Signature`:

```js
// src/functions/totConnector.mjs — Azure Functions Node.js v4
import { app } from "@azure/functions";
import { TableClient } from "@azure/data-tables";

const tableClient = TableClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING,
  "TotWebhookDedupe",
);

// 1. Inbound Webhook Receiver (POST /api/webhooks/tot)
app.http("totWebhook", {
  methods: ["POST"],
  authLevel: "anonymous", // Authenticated via RFC 9421 HTTP Message Signature
  route: "webhooks/tot",
  handler: async (request, context) => {
    // Read exact raw bytes before JSON parsing
    const rawBytes = new Uint8Array(await request.arrayBuffer());
    const rawText = new TextDecoder().decode(rawBytes);

    let event;
    try {
      event = JSON.parse(rawText);
    } catch {
      return { status: 400, jsonBody: { error: "invalid_json" } };
    }

    const tenantId = event.tenantid;
    const installId = event.appinstallid;
    if (!tenantId || !installId || !event.id) {
      return { status: 400, jsonBody: { error: "missing_cloudevent_context" } };
    }

    // Reconstruct public @target-uri behind Azure Front Door / Functions host
    const targetUri = process.env.WEBHOOK_PUBLIC_URL || request.url;

    const verified = await verifyTotWebhook({
      method: request.method,
      targetUri,
      headers: Object.fromEntries(request.headers.entries()),
      rawBytes,
      tenantId,
    });
    if (!verified.ok) {
      return { status: 401, jsonBody: { error: verified.code } };
    }

    // Atomic deduplication in Azure Table Storage (PartitionKey = tenantId, RowKey = event.id)
    try {
      await tableClient.createEntity({
        partitionKey: tenantId,
        rowKey: event.id,
        installId,
        receivedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (err.statusCode === 409 /* EntityAlreadyExists */) {
        return { status: 200, jsonBody: { ok: true, deduplicated: true } };
      }
      throw err;
    }

    // Route by (tenantId, installId)
    await handleStorefrontEvent(event, { tenantId, installId, context });
    return { status: 200, jsonBody: { ok: true } };
  },
});

// 2. Public JWKS Endpoint for clientAuth.method = "private_key_jwt"
app.http("totJwks", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: ".well-known/jwks.json",
  handler: async () => ({
    status: 200,
    jsonBody: { keys: [JSON.parse(process.env.TOT_PUBLIC_KEY_JWK)] },
  }),
});

// 3. 5-Minute Scheduled Reconciliation Pass (NCRONTAB 6-field format: second minute hour day month dow)
app.timer("totReconcile", {
  schedule: "0 */5 * * * *",
  handler: async (_timer, context) => {
    await reconcileAllTenantInstalls(context);
  },
});
```

---

## 2. Option B — Azure Container Apps (`az containerapp up`)

If you prefer a portable container (or already run on Kubernetes / AKS), deploy your scaffolded app
with **Azure Container Apps**:

```bash
az containerapp up \
  --name tot-private-app-connector \
  --resource-group rg-tot-connectors \
  --location eastus \
  --source . \
  --target-port 8787 \
  --ingress external \
  --env-vars WEBHOOK_PUBLIC_URL="https://tot-private-app-connector.<env>.eastus.azurecontainerapps.io/webhooks/tot"
```

Reference your `private_key_jwt` signing key from **Azure Key Vault** using a System-Assigned
Managed Identity (`az containerapp secret set --secrets tot-private-jwk=keyvaultref:<kv-uri>,identityref:system`),
and run reconciliation via an **Azure Container Apps Job** (`--trigger-type Schedule --cron-expression "*/5 * * * *"`).

---

## 3. Production Checklist on Microsoft Azure

- **NCRONTAB 6-field schedule in Azure Functions:** Azure Timer Triggers include seconds
  (`"0 */5 * * * *"` for every 5 minutes), whereas Azure Container Apps Jobs use standard 5-field
  cron (`"*/5 * * * *"`).
- **Route prefix on Azure Functions:** By default, Azure Functions prefixes HTTP routes with `/api/`
  (e.g. `https://<app>.azurewebsites.net/api/webhooks/tot`). Either include `/api/webhooks/tot` in
  `WEBHOOK_PUBLIC_URL` and `tot-app.json`, or set `"extensions": { "http": { "routePrefix": "" } }`
  in `host.json`.
- **Application Insights privacy:** Never log the `shipTo` recipient object from
  `GET /api/apps/v1/fulfillment/orders/{orderId}/recipient` into `context.log` or Application
  Insights custom dimensions.
