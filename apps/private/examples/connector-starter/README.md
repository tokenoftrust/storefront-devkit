# Connector starter: label station, dropship, inventory sync

Three small, runnable Private App connectors, one per common archetype, each talking to a **mock**
of its outside system. Start here, make one of them real, and report anything in the platform
that gets in your way.

| App | Archetype | Example systems | What it does today (against the mock) |
|---|---|---|---|
| `apps/label-station` | Label station | ShipStation | Discovers the carriers it may buy, gets a fulfillment assignment, creates the order and label, reports the label and the carrier handoff; holds, resumes or voids and cancels on `fulfillment.assignment.updated`. |
| `apps/dropship` | Multi-supplier dropship | Duoplane | Sends the assignment to a supplier as a purchase order, reports each supplier shipment, or raises an exception (backorder, refused carrier); holds, resumes or cancels the purchase order on `fulfillment.assignment.updated`. |
| `apps/inventory-sync` | Inventory / WMS sync | SkuVault | Posts warehouse movements as reason-coded batches and absolute counts into a Storefront stock location, applies `inventory.changed` in `asOf` order, and reads the sales-velocity report. |

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

**Your own test location.** `npm run order` binds and creates test orders at `STARTER_LOCATION_ID`
(default `loc-starter-<app>`), so several developers can test on the same store preview without
taking each other's orders. Give yours a unique value if someone else on the store uses the same app.

---

## Quick start (about 15 minutes)

Replace `<app>` with `label-station`, `dropship` or `inventory-sync`, and `<store>` with your store.

1. **Offline check & conformance certification**:
   - Run `npm test` (no credentials needed).
   - Conformance certification (CLI 7.7.0 or later) can run **offline against the in-process mock Storefront**
     before you have store or vendor sandbox credentials (whenever `TOT_METADATA_ORIGIN` is set without
     `apps/<app>/.env` credentials, or with `MOCK_STOREFRONT=1`), or against your test store install after steps 2-3.
     Start the app against the conformance run's signing key (`Ed25519` `alg="ed25519"` or `RS256` `alg="rsa-v1_5-sha256"`),
     with clean state, then certify it from a second terminal:
     ```bash
     MOCK_STOREFRONT=1 TOT_METADATA_ORIGIN=http://127.0.0.1:37891 WEBHOOK_PUBLIC_URL=http://127.0.0.1:8787 \
       STATE_FILE=.run/conformance-<app>.json npm run <app>
     tot app conformance --url http://127.0.0.1:8787/webhooks --archetype <app> --certify \
       --app-id com.example.<app>-starter --receipt ./conformance-<app>.json
     ```
     If you run conformance against a live store preview (without `MOCK_STOREFRONT=1`), `inventory-sync` writes its WMS
     baseline to your test location on startup; run `npm run inventory-sync -- --cleanup` afterwards on a shared store preview.
2. **Install your app on the store (test environment)**:
   ```bash
   tot app install --app apps/<app> --env test --tenant <store>
   ```
   It prints `installId`, `clientId` and a **secret, shown once**. Lost it? `tot app rotate <installId> --tenant <store>`
   prints a new one, and the old one stops working. On a shared store where another developer already
   installed `com.example.<app>`, add your own suffix to `"id"` in `apps/<app>/tot-app.json` (e.g.
   `"com.example.<app>-<yourname>"`) and re-run `tot app install` — never run `tot app update` on
   another developer's install.
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
   changes every time you restart it. When it does, redo this step, step 7, and (if you ran
   `--webhook-endpoint none` in step 9) `npm run order -- <app> bind` in step 8.
6. **Start the app** (terminal 2): `npm run <app>`
7. **Point the install at your tunnel**. `npm run doctor -- <app>` prints the exact command:
   ```bash
   tot app update <installId> --app apps/<app> --webhook-endpoint https://<tunnel>/webhooks --tenant <store>
   ```
   Run `npm run doctor -- <app>` again. Every check should PASS.
8. **Label station / dropship: send a test order or run a 1-click smoke test** (terminal 3 or browser):
   ```bash
   npm run order -- <app> bind          # after step 7 (and again after --webhook-endpoint none): binds STARTER_LOCATION_ID (no owner approval needed)
   npm run order -- <app> go            # create (2 units) + release one synthetic order
   npm run order -- <app> hold <id>     # app receives fulfillment.assignment.updated "held"
   npm run order -- <app> release <id>  # lifts the hold: app receives fulfillment.assignment.updated "active"
   npm run order -- <app> cancel <id>   # app receives fulfillment.assignment.updated "cancelled"
   ```
   Or open **`/dashboard/<store>/apps`** in your browser and click **"Run Smoke Test"** on the `test` install card (calls `POST /api/apps/admin/test-orders?tenant=<store>` with `{"action":"smoke","installId":"<installId>"}` to exercise `bind -> create -> release -> hold -> cancel` in an isolated preview location `smoke:<installId>` without disturbing the wildcard processor).
   Watch terminal 2. Within about a minute the app picks up the order and reports back.
   **Inventory sync** needs no orders: it syncs on start and every `SYNC_SECONDS`.
9. **When you're done**: stop the app and the tunnel, then
   `tot app update <installId> --app apps/<app> --webhook-endpoint none --tenant <store>` (this also unbinds the preview processor; re-run `npm run order -- <app> bind` next session after setting a new tunnel URL).
   Inventory sync: also run `npm run inventory-sync -- --cleanup` (zeroes and archives its location).

### What "working" looks like (log lines in terminal 2)

- Label station: `assignment.start` → `storefront.label_outcome` (200, `purchased`) → `storefront.handoff` (200, `handed_off`)
- Dropship: `assignment.start` → `provider.po_created` → `storefront.shipment` (200, `complete: true`) → `order.fulfilled.event`
- Inventory sync: `storefront.location` (200) → `reports.sales_velocity` → `storefront.levels` (baseline) → `storefront.movements` (201) → `storefront.levels` (`drift: []`) → `inventory.changed.applied`
- Hold / cancel: `assignment.updated` with `state: "held"` / `"cancelled"`; label station logs `label-station.handoff_skipped` while held

### Unhappy paths (set in `apps/<app>/.env`, then restart the app)

- Label station `MOCK_VOID_FIRST=1`: voids the first label and buys a replacement (`label-voided`).
- Dropship `MOCK_SUPPLIER_CARRIER=USPS`: Storefront refuses USPS on a PACT order (`409 carrier-prohibited`), and the app raises a `carrier_refused` exception for the merchant.
- Dropship `MOCK_BACKORDER=1`: the supplier backorders, and the app reports `backordered`.
- Any app, mid-order: stop it (Ctrl+C) and start it again. Progress is in `.run/<app>-state.json`, so it resumes without buying a second label, creating a second purchase order or re-sending movements.
- Label station `STATION_CARRIERS=FEDEX` on an order that only allows UPS: `label-station.no_station_carrier`, nothing is bought.

---

## How it fits together

```
core/config.mjs   loads apps/<app>/.env
core/tot.mjs      token + /api/apps/v1 calls + webhook keys (connector-kit, `tenant` option)
core/state.mjs    StateStore: get / set / delete / entries, file-backed (.run/<app>-state.json); swap in your database
core/server.mjs   POST /webhooks (signature verified before your code runs), GET /health
core/log.mjs      JSON logs; recipient address fields and secrets are always redacted
scripts/doctor.mjs      preflight
scripts/test-order.mjs  bind / create / release / hold / cancel synthetic orders at your location (wraps the tot CLI)
scripts/stage-candidate.mjs  stage a production candidate for owner approval (dry run unless --yes)
apps/<app>/connector.mjs   the app
apps/<app>/mock-*.mjs      the mock outside system (runs inside the app on MOCK_PORT)
```

Each app also **polls** (`GET /fulfillment/assignments`, or the warehouse system) on a timer. That
way a missed or late webhook never loses work. Webhooks can arrive a minute or more after the event,
more than once, and out of order.

## Making it real

- **Real API.** Each mock says which calls it stands in for. Write a real client from your
  provider's API docs and switch with `PROVIDER_API_URL` (and keys) in `.env`.
- **Persistence.** `core/state.mjs` keeps progress in one JSON file per app. That is enough for one
  process on one machine; for anything hosted, implement the same four methods on your database.
- **Cancellations and holds.** Handled against the mocks. Map them to your provider's real hold, void
  and cancel calls, and decide what happens to a parcel that already left.
- **Carrier and service mapping.** Label station reads `GET /fulfillment/carriers` at startup and buys
  only carriers that the store allows, the order allows and your provider offers
  (`PROVIDER_TO_STOREFRONT` maps provider codes). Check the service codes against your provider.
- **Partial shipments.** `npm run order` creates 2 units, so the dropship mock ships two cartons
  (`order.partially_fulfilled`, then `order.fulfilled`). `tot app test-order create --line <sku>:<qty>` adds lines.
- **Inventory ordering.** `inventory.changed` can arrive out of order; the inventory-sync app applies
  it only when `asOf` is newer than the last one it saw for that SKU and location.
- **Store-wide vs per-location inventory.** On `GET /inventory?locationId=<id>`, only `mirror`
  (`balance`, `asOf`) is the reading at that location. `available`, `quantity` and `policy` are the SKU's
  store-wide shopper availability across all active fulfillable locations, whatever `locationId` you pass.
  So a non-fulfillable location (like this app's) can still read `available: true` when the SKU has stock
  elsewhere: check `mirror.balance`, not `available`, to prove what one location holds. On
  `inventory.changed`, `balance` is per location and `available` is the store-wide quantity (an integer;
  zero or below means sold out). A listing filtered by `locationId` without `sku` pages the whole store
  catalog (SKUs the location doesn't hold come back without `mirror`), so read your own SKUs with `sku=`.
- **Conformance receipt.** `tot app conformance ... --certify` (quick start step 1) signs synthetic
  deliveries with an ephemeral Ed25519 (`alg="ed25519"`, `kty="OKP"`, `crv="Ed25519"`) or RS256
  (`alg="rsa-v1_5-sha256"`) key served at `http://127.0.0.1:37891/.well-known/tot-app-authorization-metadata`;
  `TOT_METADATA_ORIGIN` points the app's `AuthorizationMetadata` there, and `MOCK_STOREFRONT=1` lets
  each starter certify offline against an in-process mock Storefront while vendor sandbox credentials are
  sourced. It checks signed delivery, hold/cancel, duplicate handling and stale inventory, and writes a
  receipt you can attach to your review.
- **Hosting.** See [`../../hosting/`](../../hosting/) to run it somewhere other than your laptop.

Request bodies follow [`contract/openapi.yaml`](../../contract/openapi.yaml) 1.4.0, the source of
truth. Known rough edges: [`KNOWN-ISSUES.md`](./KNOWN-ISSUES.md).

## Stage a production candidate

When the store owner asks for it:

```bash
npm run stage-candidate -- <app> --generate-keys ./keys          # dry run: prints the tot command
npm run stage-candidate -- <app> --jwks ./keys/public-jwks.json --yes
```

This stages `apps/<app>` with `--request-consent`; the owner approves it in their dashboard. Never
commit or share the private key.

## Reporting a problem

If something in Storefront, the CLI or the docs blocks you or surprises you, report it with
`tot feedback` (or the ToT MCP `feedback_submit`). Include:

- what you ran
- what you expected
- what you got
- the `requestId` from the log line
