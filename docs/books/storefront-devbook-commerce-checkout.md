---
id: storefront-devbook-commerce-checkout
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Commerce & checkout — managed checkout, cart theming & subscriptions
---
# Commerce & checkout — managed checkout, cart theming & subscriptions

**Task:** wire up commerce correctly — understand what's platform-owned vs yours, brand the managed cart drawer, offer subscriptions, and set `capabilities.json` — without ever building checkout mechanics yourself.

> Runnable examples: **[storefront-devkit](https://github.com/tokenoftrust/storefront-devkit)** — `schemas/capabilities.schema.json`, `snippets/checkout/`, `recipes/add-subscription-option/`.

## The boundary (read first)
Checkout is the integrity boundary of the whole platform. **Cart, checkout, totals, tax, and payment are platform-owned.** You never build them as tenant content. What you *do* own: whether commerce is on, how the cart drawer looks, and what purchase options a product offers (as data).

## Commerce vs marketing tenants
`.tot/config.json` `siteType` decides the model: `commerce` (catalog + managed cart/checkout) vs `marketing` (no cart; capabilities.json disables checkout). capabilities.json requests OPTIONAL surface changes and may never weaken the compliance floor (ageVerification/exciseTax cannot be false for a regulated tenant).

## Brand the managed cart drawer
The drawer inherits theme.json tokens; provide a scoped `cartDrawerCss` override referencing theme tokens (not hex). Don't rebuild the drawer.

## Offer subscriptions (the platform-safe way)
Subscriptions are expressed as product data (`purchase_options`); managed checkout renders the selector and handles billing/skips/cancellation. You never build a subscribe button or billing flow. Example purchase_options with one_time + subscription kinds, frequency intervals (60d/2w/1m/1y/.5m). Use merchant/brand language ("Subscribe","Autopilot"). Education-only explainer blocks exist; keep figures illustrative unless a real live offer.

## Common pitfalls
- Disabling the compliance floor via capabilities.json (rejected).
- Building custom cart/subscribe/checkout in a widget or HTML (out of contract).
- Turning off cartCheckout on a store that sells.
- Over-styling the drawer.

## Verify
`tot dev` → add-to-cart opens branded managed drawer; a product with purchase_options shows the one-time/subscribe selector. `tot validate` confirms the compliance floor. On a regulated tenant confirm the age gate + excise cue still appear at checkout.

---

## Under the hood — signed checkout & membership mechanics

The guidance above is the tenant-authoring contract. This section is the developer-facing map of the *shipped mechanics* that enforce it — the signing engine, the pricing/eligibility engine, and the hide-at-launch switches. All of it lives in the renderer-safe, dependency-free the public runtime's `checkout` and `membership` modules (edge-safe: identical behavior under `astro dev` on Node 20 and inside the Cloudflare Worker). 

> **Republish reminder:** this devbook is the published face of that code. Change the signing/pricing mechanics and this doc is stale — republish it.

### 1. Signed merchant checkout (F11) — fail-closed
Managed checkout runs in one of two modes (`ManagedCheckoutConfig.mode`): `signed` (preview/live — cart validation ON, every field HMAC-signed) or `unsigned-demo` (local/preview demo store with validation OFF, so a developer runs the full cart with zero secrets). The signing reference is `HMAC-SHA256(productcode + fieldname + fieldvalue, storeSecret)`, computed with WebCrypto; the rendered field name becomes `fieldname||hash` (editable fields like quantity hash the `--OPEN--` sentinel and emit `fieldname||hash||open`).

Production is **hardened to fail closed**: `resolveCartSigning` requires `FOXY_CART_SECRET` — if it's missing (an empty-string secret is treated as unset), **no cart is built and the buy form is safely disabled** rather than emitting a tamperable unsigned cart. `buildVariantCartPayload` also throws in `signed` mode when no secret is supplied. The signed payload binds product code, price, variant option values, quantity, **and the selected purchase option** (`Purchase option` + subscription params are emitted and signed), so a shopper can't swap the option or keep a subscription's discounted price after signing. Tamper rejection is tested across price / variant / quantity / purchase-option / smuggled-field mutations.

### 2. Membership & subscription pricing engine (F10)
`membership.ts` is a pure pricing/eligibility engine. `priceForPurchaseOption(listPrice, option, { member, program })` returns the effective price, the list price to strike through (`compareAt`), and which discounts applied. It composes two levers — the **member discount** (`MembershipTierRule.priceAdjustment` off list) and the option's own **subscription discount** (`purchaseOptionPrice`) — under a tenant-configurable **stacking policy**:

| `stacking` | Member + subscription behavior |
| --- | --- |
| `best_of` (default) | Shopper pays the lower of member-only / subscription-only. Never double-discounts. |
| `stack` | Member discount applied on top of the subscription price. |
| `member_only` | Member discount wins on subscription options (member price still applies to one-time). |
| `subscription_only` | Subscription discount wins on subscription options (member price still applies to one-time). |

Adjustments are validated on the same floor as checkout (no negative/over-100% percent, no amount larger than the price). `visiblePurchaseOptions` + `isAutopilotEnabled` gate what actually renders. Eligibility resolves through one seam: Phase-1 storefronts have no shopper-login source, so `resolveMemberContext` returns anonymous (non-member) and member pricing simply doesn't render — the mechanics stay unit-tested regardless; production threads a real `MembershipSignal` from the shopper's account claim. Account management (skip / pause / resume / cancel / reschedule / quantity / swap / address) is a **provider-handoff contract** (`buildManageEntries`) — the storefront renders deep-link entry points and never executes the action in-repo.

### 3. Hide-at-launch is first-class
The mechanics can ship real, tested, and fully wired with **nothing selling**. Two additive, optional `TenantConfig.commerce` blocks control it, and they travel with the tenant repo per environment:
- `commerce.autopilot.enabled: false` → `visiblePurchaseOptions` drops **every** subscription purchase option on the PDP; a one-time option is always preserved (synthesizing a default if the product only authored subscriptions), so the product stays buyable. Absent → subscriptions visible wherever a product authors them (framework/dev default).
- `commerce.membership` is **opt-in** — member pricing renders only when `enabled: true` with at least one tier *and* an eligible member resolves.

The recorded readiness state for an example regulated tenant ships both **OFF** (marketing-education only): a production tenant runs the full mechanics with Autopilot and membership hidden until it flips the flags at Phase-2 managed checkout.

### 4. Member-eligibility-aware signed pricing (F11b)
The signed cart signs the member-**effective** price, not list. `buildMemberSignedCartPayload` computes the price server-side via `priceForPurchaseOption` for the shopper's resolved eligibility, then HMAC-signs it keyed per (variant, purchaseOption, memberContext) through `buildVariantCartPayload`'s `signedPrice`. Consequences:
- A member price replayed against a non-member's page (which carries the list-price signature) **fails HMAC verification** — and vice-versa. The client never re-derives what it pays; it can only submit what the server signed for its resolved context. `assertEffectivePrice` additionally refuses any signed price above list (an effective price is always a discount off list).
- The signer **refuses to sign a subscription option when `autopilotEnabled === false`** (fail-closed hide-at-launch): if a subscription option reaches the signer with Autopilot off, the visibility filter was bypassed, so `buildVariantCartPayload` throws rather than mint a valid payload — a crafted form-post can't resurrect a hidden Autopilot plan.
