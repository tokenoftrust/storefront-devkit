# Hosting Fast-Path: AWS Lambda (Function URL / API Gateway + EventBridge + DynamoDB)

**Topology:** Cloud Function-as-a-Service (Node.js 20/22/24 runtime on AWS Lambda)

AWS Lambda paired with a **Lambda Function URL** (or **API Gateway HTTP API v2**), **Amazon
EventBridge Scheduler**, **Amazon DynamoDB**, and **AWS Secrets Manager / KMS** provides a
serverless, multi-tenant-ready architecture on AWS.

---

## 1. Architecture on AWS

- **Inbound HTTPS (`webhooks.endpoint`):** AWS Lambda Function URL (`AuthType: NONE` — the handler
  enforces RFC 9421 HTTP Message Signature verification) or API Gateway HTTP API (payload format
  `2.0`).
- **Scheduled Reconciliation (`rate(5 minutes)`):** Amazon EventBridge Scheduler rule invoking the
  same Lambda with `{"source": "aws.scheduler", "action": "reconcile"}`.
- **Idempotency & Multi-Tenant Store:** Amazon DynamoDB table keyed by `pk = "TENANT#<tenantid>"`
  and `sk = "EVENT#<event.id>"` with DynamoDB TTL enabled on `expiresAt`.
- **Key Management (`private_key_jwt`):** Store your private JWK in **AWS Secrets Manager** (or sign
  assertions directly via **AWS KMS** asymmetric signing keys `RSASSA_PKCS1_V1_5_SHA_256` /
  `ECDSA_SHA_256` so the private key never leaves KMS).

---

## 2. Critical AWS Lambda Gotcha: Preserving the Raw Body Bytes

API Gateway HTTP API v2 and Lambda Function URLs pass the HTTP body as a string in `event.body` and
set `event.isBase64Encoded = true` when binary or certain content types are used. **Never** use a
middleware that parses and re-stringifies `event.body` before verifying `Content-Digest` (RFC 9530):

```js
// index.mjs — AWS Lambda handler (Node.js 20+)
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.DEDUPE_TABLE_NAME;

export const handler = async (awsEvent) => {
  // 1. Handle EventBridge 5-minute scheduled reconciliation trigger
  if (awsEvent.source === "aws.scheduler" || awsEvent.action === "reconcile") {
    await reconcileAllTenantInstalls();
    return { statusCode: 200, body: JSON.stringify({ reconciled: true }) };
  }

  const method = awsEvent.requestContext?.http?.method || "POST";
  const rawPath = awsEvent.rawPath || "/";

  // Optional: serve public JWKS for clientAuth.method = "private_key_jwt"
  if (method === "GET" && rawPath === "/.well-known/jwks.json") {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: [JSON.parse(process.env.TOT_PUBLIC_KEY_JWK)] }),
    };
  }

  // 2. Reconstruct exact raw body bytes BEFORE JSON parsing
  const rawBuffer = awsEvent.isBase64Encoded
    ? Buffer.from(awsEvent.body || "", "base64")
    : Buffer.from(awsEvent.body || "", "utf8");

  // 3. Reconstruct exact public @target-uri signed by Storefront
  const headers = awsEvent.headers || {};
  const proto = headers["x-forwarded-proto"] || "https";
  const host = headers["x-forwarded-host"] || headers["host"];
  const query = awsEvent.rawQueryString ? `?${awsEvent.rawQueryString}` : "";
  const targetUri = process.env.WEBHOOK_PUBLIC_URL || `${proto}://${host}${rawPath}${query}`;

  let cloudEvent;
  try {
    cloudEvent = JSON.parse(rawBuffer.toString("utf8"));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "invalid_json" }) };
  }

  const tenantId = cloudEvent.tenantid;
  const installId = cloudEvent.appinstallid;
  if (!tenantId || !installId || !cloudEvent.id) {
    return { statusCode: 400, body: JSON.stringify({ error: "missing_cloudevent_context" }) };
  }

  // 4. Verify RFC 9530 Content-Digest + RFC 9421 Signature
  const verified = await verifyTotWebhook({
    method,
    targetUri,
    headers,
    rawBytes: rawBuffer,
    tenantId,
  });
  if (!verified.ok) {
    return { statusCode: 401, body: JSON.stringify({ error: verified.code }) };
  }

  // 5. Atomic deduplication in DynamoDB (ConditionExpression prevents duplicate processing)
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86400;
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: { S: `TENANT#${tenantId}` },
          sk: { S: `EVENT#${cloudEvent.id}` },
          installId: { S: installId },
          expiresAt: { N: String(expiresAt) },
        },
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }),
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return { statusCode: 200, body: JSON.stringify({ ok: true, deduplicated: true }) };
    }
    throw err;
  }

  // 6. Route to tenant-specific WMS / 3PL / shipping handler
  await handleStorefrontEvent(cloudEvent, { tenantId, installId });

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true }),
  };
};
```

---

## 3. Production Checklist on AWS

- **Header casing:** API Gateway HTTP API v2 lowercases all incoming header keys
  (`content-digest`, `signature-input`, `signature`). Always read headers case-insensitively.
- **Timeout & ACK ordering:** Return `200 OK` within 10 seconds. If your downstream ERP/WMS takes
  longer to process a batch, verify the signature, write the event to **Amazon SQS** (or
  EventBridge), and return `202 Accepted` immediately.
- **CloudWatch Logs redaction:** Never log the `shipTo` object from
  `GET /api/apps/v1/fulfillment/orders/{orderId}/recipient` to CloudWatch.
