---
id: storefront-devbook-compliance
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Regulated compliance — turn on the widgets, respect the floor
---

# Regulated compliance — turn on the widgets, respect the floor

**Task:** configure regulated-commerce compliance (age gate, FDA nicotine warning, PACT Act,
Prop 65, state eligibility, excise display, shipping restrictions) by setting **facts** in
`.tot/config.json` — while the platform owns and renders all the mandated legal wording.

> Runnable examples: **[storefront-devkit](https://github.com/tokenoftrust/storefront-devkit)** —
> `schemas/compliance.schema.json`, `snippets/compliance/`, `templates/regulated-vape/`,
> `recipes/enable-pact-compliance/`, and the by-vertical `industries/` guide.

---

## The model (internalize this)

- **You flip flags and pass small parameters. The platform owns the legal wording.** You cannot
  write, edit, hide, reorder, or paraphrase a mandated notice — you only turn it on and supply facts
  like `minAge`, chemical names, or state lists.
- **Presence is the switch.** Each widget renders **nothing** when its config field is absent.
- **Enforcement stays platform-owned.** `stateEligibility`, `purchaseLimit`, and `exciseTax` here
  are *display* cues; the platform makes the actual ship/no-ship and tax decisions.
- **The floor is immutable.** You cannot disable required age/identity verification or excise for a
  regulated tenant — those changes are rejected at validate/publish, by design. This is the
  platform's promise to the merchant: they're never one config change away from non-compliance.

## The compliance block (`.tot/config.json` → `compliance`)

```json
{
  "siteType": "commerce",
  "compliance": {
    "minAge": 21,
    "nicotineWarning": true,
    "pactAct": true,
    "adultSignature": true,
    "shippingRestriction": "Adult signature (21+) required on delivery. Not shipped via USPS.",
    "prop65": { "harm": "reproductive", "chemicals": ["nicotine"] },
    "stateEligibility": { "restrictedStates": ["UT", "AR", "VT"] },
    "purchaseLimit": { "text": "2 units per order", "reason": "per state law" },
    "exciseTax": { "note": "Applicable state vapor excise taxes are calculated at checkout." }
  }
}
```

### The fields

| Field | Type | Turns on |
|---|---|---|
| `minAge` | number | Age/identity gate at the stated age; its presence signals a regulated tenant |
| `nicotineWarning` | bool | FDA nicotine warning (wording fixed by law) |
| `pactAct` | bool | PACT Act notice (ENDS/vapor) |
| `adultSignature` | bool | Adult-signature-on-delivery notice |
| `shippingRestriction` | string | Display text for shipping limits (the ship/no-ship *decision* stays platform-owned) |
| `prop65` | bool or `{ harm, chemicals?, url? }` | California Prop 65 warning (platform owns skeleton/symbol/URL; you supply harm + chemicals) |
| `purchaseLimit` | `{ text, reason? }` | Quantity-limit *display* (enforcement platform-owned) |
| `stateEligibility` | `{ restrictedStates? , eligibleStates?, note? }` | Eligibility *display* (does not decide a cart) |
| `exciseTax` | `{ note, jurisdictions? }` | Excise-tax *display* cue (never computes tax) |

Full shapes: `schemas/compliance.schema.json`. Per-vertical ready blocks (vape, alcohol, hemp/CBD,
firearms): `snippets/compliance/`.

## Set real facts, not placeholders

`minAge`, restricted states, chemical names, and excise notes must reflect the client's **actual
obligations**. Never invent them — pull from the merchant's real requirements. Fabricated
compliance facts are a serious problem, not a formatting detail.

## Handling a "turn it off to test" request

When asked to hide the age gate or disable excise "just for testing," **refuse that part and name
the rule**, then offer a safe alternative:

> I can't disable age verification or excise for a regulated tenant — they're required and
> platform-enforced. I can change the gate-adjacent brand experience or landing copy, or publish a
> private preview that keeps the compliance floor intact.

Do **not**: set `ageVerification.enabled`/`exciseTax.enabled` to `false`; hide compliance DOM with
CSS/JS; move checkout links out of platform controls; author warning text yourself anywhere.

## Common pitfalls

- **Writing the warning yourself** (in chrome/footer/editorial) instead of flipping the flag. The
  platform renders the mandated text — a hand-written copy is both wrong and a compliance risk.
- **Treating `stateEligibility`/`exciseTax` as enforcement.** They're display; the platform decides
  and computes.
- **Using raw HTML/inline scripts on a regulated tenant.** Blocked at publish. Use blocks + config.
- **Forgetting `minAge`.** Its presence is what marks the tenant regulated and lights the gate.

---

## Under the hood — the flags become real enforcement

A notice that renders but does not block is decoration, not compliance. The flags above wire to a
single **fail-closed decision engine**, and go-live promotion is gated on that enforcement actually
being wired — so a regulated store can't ship with a gate that only *looks* like a gate.

> **Legal boundary.** The framework CAPTURES and ENFORCES the configured rules and captures the
> data a filing needs. It is not legal advice. The authoritative rule DATA (flavor bans, no-ship
> lists, per-order limits, excise rates) and the legal responsibility for any regulatory FILING
> (e.g. the PACT Act monthly state reports) remain the merchant's and their counsel's. Token of
> Trust **performs** PACT Act monthly state filing as a service for ecommerce stores on other
> platforms today, and offering it to storefront tenants is planned — that changes who does the
> work, not where responsibility sits. Every ruleset carries a `source` + `updatedAt` provenance
> stamp to keep that boundary explicit.

### Three fail-closed seams

Checkout completion and order creation happen in the **external managed cart** (Foxy) — there is no
single server-side "create order" hook. So enforcement bites at three real seams, all fail-closed:

1. **Decision engine** (public runtime `compliance` module) — the single authority. Pure,
   edge-safe, exhaustively unit-tested.
2. **Checkout preflight** (`POST /api/compliance/preflight`) — the storefront must clear the cart
   here before handing off to the managed cart. Server-evaluated; never trusts client-supplied
   product attributes.
3. **Evidence promote gate** (`GET /api/evidence.json`) — a regulated tenant is only PROMOTABLE
   when its enforcement wiring resolves. The compliance-critical checks upgraded from
   config-coherence ("declared 21+") to enforcement-wired ("can actually verify, has jurisdiction
   rules, has an excise path").

No resolvable ruleset, no verification provider, or an unsatisfied excise obligation ⇒ **BLOCK**
(and not promotable).

### Enforcement map (rule → where enforced → evidence signal)

| Requirement | Where enforced | Evidence signal |
|---|---|---|
| Soft 21+ affirmation (front-door UX) | `IsolatedAgeGate` island (closed shadow root + MutationObserver) | — (UX; never accepted as verification) |
| Real age/identity verification before checkout | `resolveVerificationDecision` (`compliance/verification.ts`) → preflight; fail-closed BLOCK when no provider | `age_gate` requires `verificationWired` |
| Restricted destinations (state no-ship + flavored-ENDS ban) | `evaluateCartCompliance` state rules + per-product `compliance.restricted_states` | `jurisdiction` requires `rulesetPresent` + `jurisdictionRulesPresent` |
| PACT Act adult-signature-on-delivery | `evaluateCartCompliance` → `requirements.adultSignature`; carrier path merchant-external | folded into `jurisdiction` |
| Excise tax collect/handoff | `evaluateCartCompliance` excise obligation; fail-closed BLOCK when handling `unavailable` | `excise` requires `exciseWired` |
| Per-order purchase limits | `evaluateCartCompliance` + `effectivePerOrderLimit` (state rule wins over ruleset default) | folded into `jurisdiction` |
| PACT monthly-report per-order capture | `buildPactReportRecord` (`compliance/pact-report.ts`) | `jurisdiction` requires `reportingWired` |
| Compliance UI can't be hidden | closed shadow root + MutationObserver, `data-compliance` markers, `rawHtmlPolicy` blocks regulated tenants | guarded by `customization-protection.test.ts` |

### The verification provider is operational config, not a code path

The repo owns the GATE and its safe default (BLOCK); which provider backs it is resolved from the
environment:

```
TOT_VERIFICATION_PROVIDER=tot        # live Token of Trust verification
TOT_VERIFICATION_PROVIDER=sandbox    # simulated pass, for demos/preview
# unset                              # no provider — fail closed
```

- **Unset** → a regulated tenant's verification requirement has no provider →
  `resolveVerificationDecision` returns `blocked / failedClosed` → preflight BLOCKS and evidence is
  **not promotable**. Correct: you cannot ship a regulated store whose age gate cannot verify.
- **`sandbox` / `test` / `demo`** → a 21+ affirmation stands in for a passed verification, so
  regulated checkout is exercisable end-to-end without a real provider.
- **`tot`** → preflight calls Token of Trust's live verification API
  (`lib/verification/totVerificationClient.ts`) server-side and decides only from the provider's
  own read (`verified` + `verifiedAge ≥ minAge` → satisfied; `failed` / underage → blocked;
  `pending` / `unknown` → action required). The affirmation checkbox and any client-supplied
  verification state are ignored on this path; an unreachable or failing provider call fails closed,
  the same as no provider configured. The shopper-facing redirect/poll trip lives in
  `components/islands/checkoutVerificationFlow.ts` and `CheckoutComplianceGate.tsx`.

### Data-driven rules, not a static list in code

Rule DATA lives in the platform's compliance ruleset config as `ComplianceRuleset`
literals (state `banAll` / `banFlavored` / `perOrderUnitLimit`, PACT config, excise handling,
verification requirement), grounded in the ruleset shape published by the public runtime. A jurisdiction change is a reviewed DATA edit
against the ruleset shape, not a code change. Per-SKU restrictions additionally come from the
ToT-synced `compliance.restricted_states` metafield. **Replace the starter data with the merchant's
counsel-reviewed ruleset before a real go-live.**

Rules are organized as **profiles**, and a tenant SELECTS one via `compliance.ruleProfile` (today:
`"vape-nicotine-us"`). The rule file names profiles, never tenants — so bringing a regulated
merchant online is a declaration in that merchant's own tenant config, not an edit to shared rule
data, and every tenant declaring the same profile gets identical rules.

**A regulated tenant that declares no `ruleProfile` resolves to no ruleset and FAILS CLOSED** —
checkout blocks and evidence is not promotable. `minAge` alone marks a tenant regulated; it does
not make it enforceable. If a regulated storefront blocks every cart with `ruleset_unavailable`,
a missing `ruleProfile` is the first thing to check.

### Calling the preflight

```
POST /api/compliance/preflight
{
  "lines": [{ "handle": "mango-disposable", "variantId": "v1", "quantity": 2 }],
  "destination": { "region": "MA", "country": "US" },
  "verification": { "outcome": "verified", "verifiedAge": 30 }
}
→ { "decision": { "status": "blocked", "blocks": [{ "code": "flavored_prohibited", ... }], ... } }
```

`status` is `clear` (hand off to checkout), `action_required` (a shopper step remains — verify, or
choose a ship-to state), or `blocked` (a hard prohibition or fail-closed safety default).

### Open gates / follow-ups

- **PACT report durable sink + monthly export** — the per-order record BUILDER + capture point
  ship; the durable per-state store and the filing export are a follow-up **on this storefront
  plane**. Before you stand up your own filing path, talk to us: **Token of Trust operates PACT
  Act monthly state filing as a service today** for ecommerce stores on other platforms, and
  offering it to storefront tenants is planned. Absent that arrangement, filing is
  merchant/counsel-owned.
- **Notice components driven live from the preflight decision** — engine + preflight are wired and
  tested; rendering the `StateEligibility`/`PurchaseLimit`/`PactAct`/`AdultSignature`/`Excise`
  notices from the live per-cart decision on the checkout-entry surface is remaining UI wiring
  (they render from tenant config today).
- **Full-preview e2e** — a Playwright run driving the HTTP preflight + notice rendering on a live
  preview; the enforcement functions + route handler are unit-tested end to end.

## Verify

`tot dev` on the tenant → the nicotine warning band, PACT notice, footer shipping line, and excise
cue render (none of which you authored); the age gate shows. `tot validate` confirms the floor is
intact. In the go-live preview, the **evidence panel** shows age_gate / excise / jurisdiction green
before anything can promote — that's the proof the store is compliant.

> Backed by Token of Trust: Age Verification, PACT Act Compliance, and Excise Tax
> (see https://www.tokenoftrust.example). Platform positioning: https://store.example.com.
