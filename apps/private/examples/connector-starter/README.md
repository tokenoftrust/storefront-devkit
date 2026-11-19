# Connector starter: label station, dropship, inventory sync

Three small, runnable Private App connectors, one per common archetype, each talking to a **mock**
of its outside system. Start here, make one of them real, and report anything in the platform
that gets in your way.

| App | Archetype | Example systems | What it does today (against the mock) |
|---|---|---|---|
| `apps/label-station` | Label station | ShipStation | Gets a fulfillment assignment, creates the order and label, reports the label and the carrier handoff. |
| `apps/dropship` | Multi-supplier dropship | Duoplane | Sends the assignment to a supplier as a purchase order, reports each supplier shipment, or raises an exception (backorder, refused carrier). |
| `apps/inventory-sync` | Inventory / WMS sync | SkuVault | Copies warehouse on-hand counts into a Storefront stock location and receives `inventory.changed`. |

The mocks are shaped like a typical system of each kind. They are **not** any vendor's real API.

Everything runs on a store's **preview** stage with **synthetic test orders** (`env="test"` installs).
Nothing touches live orders, real shoppers or real stock. The inventory-sync app writes to its own
location marked `isFulfillable: false`, so shoppers never see those counts.

Built on [`connector-kit`](../../../../packages/connector-kit/), vendored unchanged in
`vendor/connector-kit/`. It handles tokens, retries, idempotency keys and webhook signature
checks. How this differs from the [recipes](../../recipes/): the recipes show each contract
surface against an in-process simulator. This starter runs against a real store's preview
end to end, with a setup check, a test-order helper and a webhook server.

---

## Before you start

- Node 20 or newer (`node -v`).
- The tot CLI: `npm i -g @tokenoftrust/cli`, then `tot login`. `tot whoami` must list your test store.
- **Preview access** (or `ship-on-behalf`) on a store. Your ToT sponsor grants it.
- An HTTPS tunnel to your machine for webhooks, e.g. `cloudflared` (no account needed),
  Microsoft `devtunnel` or `ngrok`.

**One store, one test processor.** A store's preview sends test orders to the last install that
ran `bind`. If two developers bind on the same store, the second one takes the test orders from
the first. Use one store each, or take turns.

---

## Quick start (about 15 minutes)

Replace `<app>` with `label-station`, `dropship` or `inventory-sync`, and `<store>` with your store.

1. **Offline check**: `npm test`. No credentials needed.
2. **Install your app on the store (test environment)**:
   ```bash
   tot app install --app apps/<app> --env test --tenant <store>
   ```
   It prints `installId`, `clientId` and a **secret, shown once**. Lost it? `tot app rotate <installId> --tenant <store>`
   prints a new one, and the old one stops working.
3. **Save the credentials**:
   ```bash
   cp apps/<app>/.env.example apps/<app>/.env
   ```
   Fill `TOT_TENANT`, `TOT_INSTALL_ID`, `TOT_CLIENT_ID`, `TOT_CLIENT_SECRET`. Never commit this file,
   paste it in chat, or hand it to an AI agent.
4. **Preflight**: `npm run doctor -- <app>`. Fix anything marked FAIL; each one prints the next step.
5. **Tunnel** (terminal 1):
   ```bash
   cloudflared tunnel --url http://localhost:8787
   ```
   Copy the `https://…` URL into `WEBHOOK_PUBLIC_URL` in `apps/<app>/.env`. A quick-tunnel URL
   changes every time you restart it. When it does, redo this step and step 7.
6. **Start the app** (terminal 2): `npm run <app>`
7. **Point the install at your tunnel**. `npm run doctor -- <app>` prints the exact command:
   ```bash
   tot app update <installId> --app apps/<app> --webhook-endpoint https://<tunnel>/webhooks --tenant <store>
   ```
   Run `npm run doctor -- <app>` again. Every check should PASS.
8. **Label station / dropship: send a test order** (terminal 3):
   ```bash
   npm run order -- <app> bind   # once, after step 7: makes this install the store's preview processor
   npm run order -- <app> go     # create + release one synthetic order
   ```
   Watch terminal 2. Within about a minute the app picks up the order and reports back.
   **Inventory sync** needs no orders: it syncs on start and every `SYNC_SECONDS`.
9. **When you're done**: stop the app and the tunnel, then
   `tot app update <installId> --app apps/<app> --webhook-endpoint none --tenant <store>`.
   Inventory sync: also run `npm run inventory-sync -- --cleanup` (zeroes and archives its location).

### What "working" looks like (log lines in terminal 2)

- Label station: `assignment.start` → `storefront.label_outcome` (200, `purchased`) → `storefront.handoff` (200, `handed_off`)
- Dropship: `assignment.start` → `provider.po_created` → `storefront.shipment` (200, `complete: true`) → `order.fulfilled.event`
- Inventory sync: `storefront.location` (200) → `storefront.levels` (200) → `inventory.changed.event`

### Unhappy paths (set in `apps/<app>/.env`, then restart the app)

- Label station `MOCK_VOID_FIRST=1`: voids the first label and buys a replacement (`label-voided`).
- Dropship `MOCK_SUPPLIER_CARRIER=USPS`: Storefront refuses USPS on a PACT order (`409 carrier-prohibited`), and the app raises a `carrier_refused` exception for the merchant.
- Dropship `MOCK_BACKORDER=1`: the supplier backorders, and the app reports `backordered`.

---

## How it fits together

```
core/config.mjs   loads apps/<app>/.env
core/tot.mjs      token + /api/apps/v1 calls + webhook keys (connector-kit)
core/server.mjs   POST /webhooks (signature verified before your code runs), GET /health
core/log.mjs      JSON logs; recipient address fields and secrets are always redacted
scripts/doctor.mjs      preflight
scripts/test-order.mjs  bind / create / release synthetic orders (wraps the tot CLI, retries transient failures)
apps/<app>/connector.mjs   the app
apps/<app>/mock-*.mjs      the mock outside system (runs inside the app on MOCK_PORT)
```

Each app also **polls** (`GET /fulfillment/assignments`, or the warehouse system) on a timer. That
way a missed or late webhook never loses work. Webhooks can arrive a minute or more after the event,
more than once, and out of order.

## Making it real

- **Real API.** Each mock says which calls it stands in for. Write a real client from your
  provider's API docs and switch with `PROVIDER_API_URL` (and keys) in `.env`.
- **Persistence.** State is in memory. A restart mid-order can repeat work. Persist progress by
  `assignmentId` / `purchaseId` so a restart resumes cleanly.
- **Cancellations and holds.** `fulfillment.assignment.updated` is only logged. Handle it.
- **Carrier and service mapping.** Label station maps only UPS and FedEx Ground. Storefront accepts
  only carriers in the assignment's `allowedCarriers`.
- **Partial shipments.** Synthetic test orders are one line, quantity 1. The dropship mock splits any
  line with quantity > 1 into two cartons; make sure your code handles that.
- **Inventory ordering.** `inventory.changed` can arrive out of order; order by `asOf`, not arrival time.
- **Hosting.** See [`../../hosting/`](../../hosting/) to run it somewhere other than your laptop.

Request bodies follow [`contract/openapi.yaml`](../../contract/openapi.yaml) 1.4.0, the source of
truth. Known rough edges: [`KNOWN-ISSUES.md`](./KNOWN-ISSUES.md).

## Reporting a problem

If something in Storefront, the CLI or the docs blocks you or surprises you, report it with
`tot feedback` (or the ToT MCP `feedback_submit`). Include:

- what you ran
- what you expected
- what you got
- the `requestId` from the log line
