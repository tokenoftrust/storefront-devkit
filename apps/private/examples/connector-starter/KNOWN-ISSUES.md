# Known issues (checked 2026-11-24, tot CLI 7.7.0, connector-kit 1.1.0)

- **Request bodies: follow `openapi.yaml`.** Shipments need UPPERCASE `carrier` / `service`
  (`UPS`, `GROUND`) and `adultSignature: "accepted" | "refused" | "absent"`. Exceptions use `code`
  (`backordered`, `out_of_stock`, `carrier_refused`, ...). Some older prose examples differ.
  `400 malformed` with no `field` usually means one of these.

- **tot CLI: "identity check failed (mcp_http_error)".** This is intermittent and works again after
  30-60 seconds. `npm run order` retries it for you.

- **Where the webhook signing keys are.** `/.well-known/jwks.json` holds the OAuth token-signing key
  (`app-gateway-1`) only. Webhook keys (such as `webhook-signing-1`, RSA `RS256` or Ed25519 `EdDSA` in
  `tot app conformance`) are in `webhook_signing_keys` at
  `https://storefront.tokenoftrust.store/.well-known/tot-app-authorization-metadata` on the bare host root.
  connector-kit's `AuthorizationMetadata` already reads them from there and verifies both
  `rsa-v1_5-sha256` and `ed25519` RFC 9421 `sig1` signatures.

- **Webhooks are late and can repeat.** Deliveries arrive about 1-2 minutes after the event. `order.*`
  goes to every install on the store that subscribes to it. The starters poll as a safety net and
  dedupe by event id.

- **`bind` needs a webhook endpoint first (and `--webhook-endpoint none` unbinds it).** Without an
  endpoint `bind` answers `install_not_processor`. Set the tunnel URL with
  `tot app update ... --webhook-endpoint` (quick start step 7), then run `npm run order -- <app> bind`
  (self-service; no store-owner approval needed).

- **Release answers `fulfillment: "ready"`.** Check `assignedInstallId` to confirm the order went to your install.
