---
id: storefront-devbook-analytics
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Analytics & measurement — GA4 and the managed adapters
---

# Analytics & measurement — GA4 and the managed adapters

**Task:** get a measurement destination (GA4, Meta Pixel, Amplitude) collecting from your store,
with a separate test property for your own environments and the real property only on live.

> Prerequisites: a running local loop ("The local dev loop"), and the measurement id(s) for the
> destination you are wiring. You get those from the destination's own console (for GA4: the
> Google Analytics property's **Measurement ID**, shaped `G-XXXXXXXXXX`) — never from this repo.

> Migrating an existing Google Tag Manager container? Do not recreate its inventory or mappings
> manually. Read `devbook://storefront-devbook-gtm-migration/full` and use Storefront Admin's
> built-in **Migrate from GTM** workflow.

---

## The one thing to understand first

Analytics on this platform is **declarative, not a tag container.** You do not paste a `gtag`
snippet, install GTM, or add a `<script>`. You select a reviewed adapter and supply a destination
id; the platform compiles that into the page, the CSP, and the consent gate.

This is deliberate, and it is what makes measurement possible on regulated stores at all. A tag
container is *merchant-mutable parent code* — anyone with container access can inject a tag after
deploy that reads age-verification state, cart contents, or customer PII, with no review. The
platform refuses that class outright on regulated surfaces. A pinned, reviewed adapter with a
fixed event map and no arbitrary code is the compliant substitute, and it is what these adapters
are.

**Consequence:** if a request starts "add this tracking snippet," the answer is not "where do I
paste it" — it is "which reviewed adapter covers this destination." If none does, that is
platform work (a new adapter is a reviewed code change), not a tenant customization.

## The adapters

| Adapter id | Destination | Id format | Consent purpose |
|---|---|---|---|
| `platform.google-measurement` | Google Analytics 4 | `G-XXXXXXXXXX` | `analytics` |
| `platform.meta-pixel` | Meta Pixel | numeric pixel id | `marketing` |
| `platform.amplitude` | Amplitude | API key | `analytics` |

Each adapter declares its own consent purpose, event types, and the exact HTTPS collection
origins it may reach. The purpose is fixed per adapter, not something you choose — Meta Pixel
depends on `marketing` consent (advertising attribution), GA4 and Amplitude on `analytics`. Those
origins are what the strict CSP is widened by — precisely, never with a wildcard.

## The four environments (this is the test-property mechanism)

Your store resolves into exactly one of four stages per request:

| Stage | When |
|---|---|
| `local` | your machine — `tot dev` |
| `staged` | the Admin **Next Release** / published-version preview |
| `candidate` | an individual candidate change under review |
| `live` | the published site |

You supply destination ids **per stage**, so your own traffic never lands in the real property:

- `live` → your production GA4 property
- `local` / `staged` / `candidate` → a **separate test property**

Rules the platform enforces, all fail-closed:

1. A **non-live stage may never reuse ANY live id.** One collision is enough: the whole integration
   resolves to nothing and no data is sent anywhere. This is the guard that stops a test build
   polluting production analytics.
2. **The current stage must have at least one id.** If you configure only `live`, then in `local`
   the adapter is simply inactive — that is correct behavior, not a failure.
3. **A stage is all-or-nothing.** If any id in a stage is malformed or duplicated, that stage sends
   nothing — not "the good ones". You will not silently get partial data.

Non-live stages *may* share test ids with each other. Only collision with a live id is refused.

Admin preview links carry the stage in a short-lived signed content pin. The per-change preview is
always `candidate`; the aggregate **Next Release** and published-version preview are always
`staged`. The same pin selects the immutable content version and analytics stage for raw marketing
pages and normal store routes, so neither the URL label nor the host can silently select `live`.

Immutable preview wrappers are transport routes, not analytics paths: both
`/<tenant>/preview/{staged|rev}/<sha>/...` and `/preview/{staged|rev}/<sha>/...` are reported as the
tenant path they render. The SHA and preview query never enter an analytics event. The platform's
fixed Contact Sales links emit only the reviewed `user_clicked_contact_sales_mktg` action after
analytics consent; tenant labels, URLs, selectors, form values, and DOM content are never payloads.

### Several destinations on one stage

A stage takes a **list** of ids, not just one, so a single event can reach a primary property and a
rollup at the same time — the shape an existing tag container usually already has. The **first id
is the primary**; order is preserved. How many a stage may hold depends on the adapter:

| Adapter | Destinations per stage |
|---|---|
| `platform.google-measurement` (GA4) | up to 4 |
| `platform.meta-pixel` | 1 |
| `platform.amplitude` | 1 |

GA4 has no multi-property hit — a measurement id is per request — so the platform sends the same
event once per id you list. That is the vendor's own behavior, made explicit: **each destination
costs one request**, which is why the limit is 4 and not unbounded.

Meta pixel and Amplitude accept exactly one id per stage. Listing a second is **refused when you
save it**, naming the stage — it is never accepted and then quietly dropped, so what the console
accepts is always what actually fires.

If a stage's ids are wrong, the error names the **exact position** — for example
`body.configuration.destinationIds.staged[1]` — so with four ids configured you learn which one is
the problem, not just that the stage is.

## Consent gates everything

Every non-essential destination is consent-gated. Configuring an analytics adapter makes its
`analytics` purpose eligible by default when the tenant has no saved consent policy. The page
publishes that consent snapshot before the adapter loads.

A tenant can save a consent policy that requires an explicit grant or disables analytics. A stored
viewer denial overrides the default immediately, and Global Privacy Control blocks analytics. An
adapter loads nothing and sends nothing whenever its purpose is ineligible.

## Declaring a destination

A destination is declared in a file your tenant owns, `<store>/analytics.json`. The platform
reads it by tenant id for **every** tenant — a `tot dev` store and a real deployed tenant alike —
and materializes it into that tenant's declarations
(the platform loader validates the file and attaches it to a registered tenant or to a dev-loop one):

```json
{
  "schemaVersion": 1,
  "destinations": [
    {
      "adapter": "platform.google-measurement",
      "ids": {
        "live": ["G-XXXXXXXXXX", "G-ROLLUPXXXX"],
        "staged": ["G-TESTID01"]
      }
    }
  ]
}
```

Each stage takes an **array** — one entry is the ordinary case, and the first entry is the primary.

It goes through the same reviewed adapter builder as every other path — fail-closed whole-file on
an unknown adapter id, a missing/invalid `live` id, an invalid per-stage id, more ids than the
adapter accepts, or a non-live stage that reuses a live id, with a structured violation naming
every offending field down to the position in the list. You only ever supply public per-stage
destination ids, never a secret. A tenant that already carries a
platform-authored integration keeps it: your declaration is added alongside, never swapped in.

### The one thing to get right: WHICH repo the file goes in

The mechanism is the same for every tenant; where the file lives is not, and getting that wrong
fails **silently** — no error, nothing collects.

**A real deployed tenant's content lives in its OWN content repo**, materialized into the
platform build at deploy time; it is never committed to the platform repo. Commit `analytics.json`
to your content repo and it materializes with the rest of your tree. Commit it into the platform
repo instead and it lands on a path the platform ignores — **ignored, with no error**.

**A `tot dev` store you're developing against** is a `<store>/` directory in your
dev-loop checkout, so its `analytics.json` is committed right there.

**How to tell which you have:** is your tenant registered with the platform as a deployed tenant? If
yes, the file belongs in your content repo. If it isn't registered, it belongs in your dev-loop checkout
next to the rest of your `<store>/` tree.

Either way it slots into the tenant-owned surface like any other file:

| File / path | What it controls | Devbook |
|---|---|---|
| `analytics.json` | Measurement destinations (GA4/Meta/Amplitude) declared per stage, one or more ids each — reviewed platform adapters, public ids only, non-live-safe | Widgets & extension |

### The Integrations console: what a developer can and cannot do

When you'd rather manage a destination through the console than commit a file, wiring goes
through the Integrations console's managed-analytics workflow
(`/api/integrations/v1/*`). The boundary there is a role, not a blanket "developers can't touch
this" — a tenant **developer** (this devbook's audience) can do most of the pipeline alone:

**Open to any tenant member, including a developer:**
- browsing adapters and existing installs
- `createMigrationDraft` / `updateMigrationDraft` / `deleteMigrationDraft` — stage a proposed
  destination
- `createIntegrationInstall` — create an install, but only in `disabled` status
- `reviseIntegrationInstall` — revise a disabled install's configuration (it carries no status
  field, so revising one can never activate it)

The console presents these as **Create draft** and **Save draft**. Save stays disabled until a
destination value actually changes, so clicking through the normal flow cannot manufacture a
duplicate draft. The record/concurrency version is available as diagnostic detail; the numbered
**Revision** is the configuration you review and activate.

Both take the destination ids as a per-stage map of lists, the same shape `analytics.json` uses, so
the rule above ("a non-live stage may never reuse any live id") is satisfiable through the API and
the console alike:

```json
{
  "adapterId": "platform.google-measurement",
  "adapterVersion": "1.0.0",
  "configuration": {
    "destinationIds": {
      "live": ["G-XXXXXXXXXX", "G-ROLLUPXXXX"],
      "staged": ["G-TESTID01"],
      "candidate": ["G-TESTID01"]
    }
  }
}
```

`live` is required and must name at least one id. A non-live stage is optional and simply stays dark
when omitted; giving one a live id is refused, naming the offending stage and position. `local` is
not settable — the local dev loop ships no integrations, so an id there could never fire.

The catalog entry for each adapter reports its own ceiling as the `destinationIds` field's
`maxEntries`, so a console can offer a second destination only where the adapter supports one.

**Requires an owner/admin or a developer with delegated ship-on-behalf authority for this tenant:**
- `setIntegrationInstallStatus` — the "go live" decision that actually enables collection
- `deleteIntegrationInstall` — destructive removal

So as a developer you can stage a destination end to end yourself — draft it, create the install
disabled, and revise it until it's right. If you hold delegated ship-on-behalf authority, you may
also activate, suspend, or remove it. Without that grant, hand the final action to an owner/admin or
ask through your normal support/issue path ("The developer issue loop"). Include every stage's ids
when you do — a partial set means the stages you omitted stay dark.

## What every event is labelled with

You don't have to build a way to tell your storefront traffic apart from everything else in your
analytics account, and you don't have to configure one. Every event the platform sends carries
three properties, on every adapter:

| Property | Example | What it tells you |
|---|---|---|
| `tenant` | `example.com` | which store's traffic this is |
| `environment` | `live` | which publication stage it came from — `local`, `candidate`, `staged`, or `live` |
| `site_surface` | `marketing` | which surface of the store — `storefront`, `checkout`, `admin`, or `marketing` |

In Amplitude these arrive as event properties; in GA4 as event parameters (register them as custom
dimensions to use them in reports). Filter or segment on them like any other property — e.g.
marketing-site page views on the live site are `site_surface = marketing` **and**
`environment = live`.

**These are derived, not configured.** There is no field for them in `analytics.json` or the
Integrations console, and there is deliberately no way to override them: a store that could type
its own `tenant` or `environment` could mislabel its own traffic, and every report built on it
would be quietly wrong. The platform stamps them from what it already knows about the request it
is answering.

Two things that follow from that:

- **`environment` is how you keep test traffic out of your live numbers even when ids are shared.**
  Per-stage destination ids are still the right mechanism (see "The four environments"), but the
  label gives you a second, independent filter.
- **`platform` is not one of these.** In Amplitude, `platform` is a client/device field, not a
  place to record which site sent the event. If it reads blank, that is expected — use
  `site_surface` instead.

## Verifying it works

Work outward: `local` first, then `staged`, then `live`. Each stage has its own ids, so a stage that
works proves nothing about the next one — and with several ids on a stage, check EVERY property:
one receiving data does not prove the others are.

**1. Local.** Run the store and open it. If the tenant policy requires consent, grant it through
the store's consent mechanism. Then watch the network panel for requests to the destination's
collection endpoint — for GA4, `https://www.google-analytics.com/g/collect`. Confirm the `tid`
parameter on those requests is your **test** property, not the live one. Seeing the live id here
means the stage mapping is wrong; stop and fix it before going further.

**2. Candidate and staged.** Open the Admin link for the surface you mean to test: the individual
change link is `candidate`, while **Next Release** / version history is `staged`. Satisfy any saved
tenant consent policy on that document, then inspect the GA4 request to
`https://www.google-analytics.com/g/collect`. Its `tid` must be the TEST id configured for that
exact stage. Seeing the live id is a blocker; stop before publishing.

**3. Live.** After the site publishes, confirm collection on the real property — GA4's Realtime
report is the fastest signal. For a statically published store the analytics configuration is
baked into immutable bytes, so a configuration change needs a republish to appear live; it will
not hot-swap. CloudFront/S3 resolves the current configuration while rebuilding at publish.
Cloudflare/R2 refreshes the already-pinned staged archive after the configuration save and checks
the archive's recorded bake-input fingerprint at Publish. If that refresh failed or the archive
predates the fingerprint, Publish refuses before moving the live pointer and tells you to
**Rebuild**, then retry. After activation, Admin shows the active revision and links directly to
Publish when that republish is still required. Delivery remains unverified until you observe the
live request/receiver; activation alone is not delivery proof.

## It isn't collecting

Work down this list in order — each step rules out one condition, and they are ordered by how
often they are the cause.

1. **Consent is ineligible.** A saved tenant policy may require an explicit grant, or the viewer
   may have denied analytics or enabled Global Privacy Control. The adapter reports a distinct
   diagnostic for this (`consent_ineligible`) versus a bad configuration
   (`configuration_invalid`) — check it before touching your ids.
2. **This stage has no id.** Configuring only `live` means `local` is correctly inactive.
3. **A non-live stage reuses a live id.** The whole integration resolves to nothing — not just
   that stage, and one colliding id in a list is enough. Give the non-live stages distinct test
   properties.
4. **One id in a stage is malformed, duplicated, or over the adapter's limit.** That stage sends
   nothing at all rather than sending to the ids that were valid. Check the reported position.
4. **The id is malformed.** GA4 ids are `G-` followed by the property's alphanumeric suffix; a
   Google Tag id (`GT-…`), a Measurement Protocol secret, or a legacy Universal Analytics id
   (`UA-…`) are all rejected. Legacy UA ids are refused outright — GA4 only.
5. **Your store is regulated and not yet certified for this integration class.** Regulated
   surfaces refuse uncertified parent-tier code. The refusal is explicit and names the reason;
   if you see it, this is a platform conversation, not a configuration fix.
6. **The integrations console hangs or errors instead of listing anything.** That is a platform
   symptom, not yours — the control plane's storage may be behind the deployed code. Report it
   with `feedback_submit` rather than retrying; nothing you change in your tenant will move it.

## What you may never do

- **Never paste a `gtag`/GTM/vendor snippet into content or a widget** to work around a missing
  adapter. On a regulated tenant raw inline script is refused outright; on an unregulated one it
  bypasses the consent gate and the CSP, which is the exact failure mode the adapter model
  exists to prevent.
- **Never reuse a live property in a non-live stage.** Beyond polluting real analytics, the
  platform refuses it and you lose measurement everywhere.
- **Never treat a measurement id as a secret.** It isn't one — it ships to the browser by
  design. But an API secret (Measurement Protocol, server-side keys) *is*, and never belongs in
  tenant configuration.

## Related

- `devbook://storefront-devbook-gtm-migration/full` — import, classify, review, and install an
  existing GTM export through the built-in disabled-first migration workflow
- "The local dev loop" — running the store you will verify against
- "Regulated compliance" — why the parent-code rules exist and what the floor covers
- "The developer issue loop" — how to raise the wiring request and track it
- "Publish & go live" — the publish step that bakes live configuration in
