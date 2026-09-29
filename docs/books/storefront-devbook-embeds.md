---
id: storefront-devbook-embeds
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Third-party embeds — CSP opt-in for Pipedrive, and the rest of the catalog
---

# Third-party embeds — CSP opt-in for Pipedrive, and the rest of the catalog

**Task:** get a third-party embed (a Pipedrive Web Form, or another cataloged provider) actually
loading on your store, instead of silently disappearing behind the strict Content-Security-Policy.

---

## The one thing to understand first

Like analytics (`devbook://storefront-devbook-analytics`), embeds on this platform are
**declarative, not a script you paste.** You never hand-write a CSP origin, and a raw `<script
src="https://some-vendor.example/…">` you add yourself will simply be blocked with no error on the
page — the strict CSP has no origin for it. You opt into a **reviewed catalog provider by slug**;
the platform (never the tenant) owns the exact origins that slug is allowed to reach.

This is the same security floor as analytics adapters, for the same reason: a store on this
platform is regulated, and an arbitrary third-party origin in the parent document is exactly the
class of risk the strict CSP exists to close off. A cataloged, reviewed provider with fixed origins
is the compliant substitute.

**Consequence:** if a request is "add this embed" or "why doesn't my form/widget show up," the
answer is not "add the origin to the CSP" — it is "which cataloged provider covers this, and has
the tenant opted in." If none does, that's a platform review (a new catalog entry), not something
fixable from tenant content alone.

## Opting in: `<store>/embeds.json`

Your tenant repo's `embeds.json` is a plain JSON array of catalog slugs:

```json
["pipedrive"]
```

That's the whole opt-in. No origins, no script tags, no CSP directives — just the provider slug.
The platform derives every CSP origin the provider needs from its own catalog entry
(the public runtime's embed catalog) and grants exactly those, nothing more.

Absent is normal for a tenant that uses none — you only add the file (or the one line) when you
actually embed something from the catalog.

## Today's catalog

| Slug | Provider | What it needs granted |
|---|---|---|
| `pipedrive` | Pipedrive Web Forms | `script-src`/`connect-src`/`frame-src` → `https://webforms.pipedrive.com` |

Need a provider that isn't here? That's a reviewed platform change (a new `EMBED_PROVIDERS` catalog
entry), not a tenant-side config edit — open a card with the exact origin(s) the provider's script
and its form/frame need, and it can be added.

## How the platform knows your page embeds it

Every catalog entry declares `markers` — substrings (a script `src`, a generated
`data-*`-attribute-carrying id) that only appear in your rendered HTML when the embed is actually
on the page. The platform greps for those, not for a config setting, so:

- A page that doesn't use the embed never carries its CSP origin — the grant is scoped to the pages
  that actually need it, not a blanket relaxation for the whole store.
- You never have to tell the platform *which page* embeds something — just that your tenant has
  opted the provider in at all.

## Two checks catch a missing opt-in before it ships silently

An embed marker present in your HTML with no matching `embeds.json` entry produces **no build
error and no page error** on its own — just a blank spot where the form should be. Two things catch
this instead of leaving you to notice it by eye:

1. **Dev-loop lint** (`tot preview`, which lints your `content/` directory)
   scans your content at author time and fails with:
   > embeds Pipedrive Web Forms but the tenant has not opted "pipedrive" into its embeds allowlist
   > — the CSP will block it. Add "pipedrive" to the tenant's embeds config.
2. **Publish-time backstop** — the same check re-runs during the static-publish materialize step, so
   an undeclared embed can't ship even if the dev-loop lint was skipped or bypassed. It refuses the
   publish with the identical "add this slug" message, naming the exact page and the origins the
   opt-in would grant.

Neither check ever grants anything on your behalf — they only detect and tell you what to add.
The grant itself always comes from your own `embeds.json`.

## Why the origin never leaks to a page that doesn't use it

Both serving planes (`devbook://storefront-devbook-analytics` — the Worker, and the CloudFront/S3
static plane a tenant like example.com serves from) apply the SAME "grant only where the
marker is present" precision at the object/page level, so a visitor on a page with no embed never
receives a wider CSP than that page needs — whichever plane happens to be serving your store.
