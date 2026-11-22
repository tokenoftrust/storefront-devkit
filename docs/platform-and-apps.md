# What Storefront does and what apps do

Token of Trust Storefront is the system of record for orders and stock, with compliance built in.
It owns **records, gates and basic workflows**. Apps own **networks, tuned models and niches**.
This page is our commitment to partners about where that line sits and how it moves. Build against
it: anything listed under *App territory* or *Never* will not appear in the platform, so you can
invest in it without competing with us.

Every native feature is also an API and an event on the public app contract, so apps are never
locked out of what the platform adds. See [`apps/private/`](../apps/private/) for the contract.

## The scope test

A feature is native only if it passes this test. Everything else is app territory or never built,
even when no good app exists yet. Ask in order; the first "yes" decides.

1. Is it on the **Never** list (a separate business)? **Never**: not built.
2. Is it a record of truth or compliance evidence? **Native**: platform code.
3. Does the commerce operation itself need a third-party contract or network? **App territory.**
   A model service reached through Token of Trust's own model gateway is a platform dependency for
   this question.
4. Does it need a separately tuned commerce model, such as demand forecasting or carrier-rate
   modeling? **App territory.** An operator assistant that uses the gateway to explain native
   records, or to propose an action through a native workflow, goes on to question 5.
5. Do most merchants need it, as a workflow over native records? **Native**; otherwise **App
   territory**.

Compliance evidence is native even when a network is involved: carrier eligibility is the
platform's, the carrier account is the app's.

## The three classes

| Class | What is in it | Why |
| --- | --- | --- |
| **Native** (platform code) | The order record. Stock ledger, locations, reservations, transfers, stocktakes and low-stock alerts. Suppliers, purchase orders and receiving. Reorder suggestions from a published formula. Bundles and kits. Returns and disposition. Manual orders and edits. Split-shipment rules. Pickup at the merchant's own locations. Compliance holds, carrier eligibility, state rules, excise and the PACT close. Full export. The fulfillment contract and the shipping-rate hook. Operator assistants over native records | Records of truth and compliance gates need one owner. The basic workflows over them are what merchants resent paying apps for |
| **App territory** (partner apps or first-party apps on the public contract) | Buying labels and holding carrier accounts. Multi-carrier rate shopping. Address validation (it needs a data provider; the platform offers a provider hook). 3PL and WMS execution. Model-based demand forecasting. Marketplace sync. Accounting and ERP sync. Anything only a minority of merchants need | Each needs a third-party commercial relationship, a model someone must keep tuning, or serves a niche |
| **Never** (not even as a first-party app) | Processing payments (a payment rail does that). Running a carrier or label-aggregation business. Manufacturing BOM, MRP and work orders. EDI trading networks. Point-of-sale hardware. Warehouse slotting, wave picking and robotics. General-ledger accounting | Each is a separate business with its own margins, support load and regulation |

### What this means in practice

- **Labels** are bought through certified connector apps, with the platform's carrier rules
  enforced on top. The platform ships a typed shipping-rate hook so rate apps answer at checkout.
  Native label buying, rate shopping, forecasting models, marketplace sync and accounting sync are
  not built.
- **Reorder suggestions** use a published formula with every input shown. Model-based forecasting
  is an app.
- **A refund never restocks.** A return with a merchant-chosen disposition (restock, quarantine or
  damaged) is the only path that restocks.
- **Launch connectors** follow the apps pilot merchants already run: one shipping or label app,
  one 3PL or WMS, and one planning tool.

## The first-party-app release valve

When app territory has no good app, the platform builds the extension point, then recruits a
partner or ships a **first-party app**. A first-party app lives in this devkit, uses only the public
contract, installs and uninstalls like any other app, and gets no private endpoints.

The seed is [`apps/private/examples/inventory-fulfillment-e2e/`](../apps/private/examples/inventory-fulfillment-e2e/)
and its sibling recipes:

- [`inventory-sync-wms`](../apps/private/recipes/inventory-sync-wms/)
- [`fulfillment-label-station`](../apps/private/recipes/fulfillment-label-station/)
- [`dropship-multi-supplier`](../apps/private/recipes/dropship-multi-supplier/)

A request that falls in app territory goes to the partner-gap list and the recipe backlog, never to
the platform backlog.

## How the line moves

Moving anything across the line is a deliberate, recorded change. It needs all three of:

1. Named merchant demand.
2. Why no app serves it.
3. Which scope-test answer changed.

Without all three, the line stays where it is.

## Where to go next

- Building an app: [`apps/`](../apps/) and the canonical contract in [`apps/private/`](../apps/private/).
- Connector building blocks: [`packages/connector-kit/`](../packages/connector-kit/).
- Escalating a customization: [`AGENTS.md`](../AGENTS.md), golden rule 6 (sandboxed widget, then
  private app, then single-tenant extraction).
