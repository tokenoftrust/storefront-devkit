---
id: storefront-devbook-index
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Build a best-in-class store on Token of Trust Storefront — developer index
---

# Build a best-in-class store on Token of Trust Storefront — developer index

**Audience:** developers and agencies building high-performance, regulated-commerce
storefronts for clients on the Token of Trust (ToT) Storefront platform, working in the
**local dev loop** (`tot dev`). You do not need — and will not get — access to the platform
source code. You build entirely through a small set of **tenant-owned files** that the
platform interprets.

This is the index. Each task below links to a focused devbook (search
`scope:storefront genre:devbook`). Read this page first — it gives you the mental model that
makes every other guide make sense.

---

## The one-paragraph mental model

The Storefront platform is a **multi-tenant, edge-rendered (Cloudflare) regulated-commerce
platform**. You do **not** write pages or components. You supply **data, content, theme
tokens, and registered scripts**; the platform renders them with a shared, compliance-aware
component library. Your job is to make a store feel unmistakably like the client's brand
while the platform guarantees the regulated obligations (age/ID gate, warnings, excise,
checkout integrity) can never be broken. When a client need genuinely exceeds this surface,
you **escalate** (sandboxed widget → private app → single-tenant extraction) rather than
smuggle code into content.

## The loop (this is the whole workflow)

```
pull → edit → validate → publish --env=test → preview → promote (gated) ⇄ rollback
```

Locally you run `tot dev` (or `tot start`) and get your store at
`http://localhost:<port>/<tenant>/` with **save → live-reload**. Edit a tenant-owned file,
save, see it. When it's right, you validate, publish a private preview, review the
**evidence panel** (compliance + SEO proof, not just pixels), and — when the owner approves —
promote it live. Rollback is instant.

## The tenant-owned surface (your entire API)

These are the only files you edit. Everything else is platform-owned and read-only.

| File / path | What it controls | Devbook |
|---|---|---|
| `.tot/config.json` | Tenant facts & metadata (`siteType`, compliance facts). **Read, don't fabricate.** | index / compliance |
| `theme.json` | Brand look: color, type, spacing, shape tokens | Brand, theme & chrome |
| `content/chrome.json` | Header, nav/mega-menu, footer, announcement, newsletter | Brand, theme & chrome |
| `content/home.json` | Homepage layout & merchandising (a pinned block contract) | Pages & merchandising |
| `content/pages/*.json` | Platform-rendered editorial pages | Pages & merchandising |
| `content/blog/posts/*.json` | Blog articles — one file per article, **this is the blog** | Pages & merchandising |
| `content/blog/index.json` | Optional curated listing order (omit for newest-first) | Pages & merchandising |
| `content/blog/redirects.json` | `old-slug` → path map for retired article URLs | Performance & SEO |
| `content/blog/authors.json` | Optional author bios keyed by author slug | Pages & merchandising |
| `content/*.html`, `content/pages-html/**` | Raw HTML pages — **unregulated tenants only** | Pages & merchandising |
| `public/**` | Assets referenced by content (images, fonts, logos) | Performance & SEO |
| `capabilities.json` | Optional surface toggles — **may never weaken the compliance floor** | Commerce & checkout |
| `scripts.json` | Registered widget/script bundles (sandboxed by default) | Widgets & extension |
| `analytics.json` | Measurement destinations (GA4/Meta/Amplitude) declared per stage — reviewed platform adapters, public ids only, non-live-safe | Widgets & extension |
| `embeds.json` | Third-party embed opt-in (e.g. Pipedrive Web Forms) — a reviewed catalog slug, never a raw script or CSP origin | Third-party embeds |

**Analytics has a role boundary, not a "file a request" rule — and getting the self-serve case
wrong fails silently.** Which path applies depends on which kind of tenant you have:

- **A local dev-loop tenant** not yet in the platform's static registry — your `tot dev` store —
  can self-serve: commit `<store>/analytics.json` in your dev-loop checkout and the dev tenant resolver
  reads it directly.
- **A static-registry tenant** (a real deployed tenant) keeps its content in its own content
  repo, not the platform repo. Committing `analytics.json` into the platform repo instead lands on an
  ignored path — **silently ignored**: nothing collects, and there is no error telling you
  why. Ask your ToT contact if you're not sure which you have.

Either way, or to manage a destination through the console, the Integrations console's
managed-analytics workflow lets any tenant member (including a developer) draft and stage a
destination end to end; only going live (`setIntegrationInstallStatus`) or deleting an install
(`deleteIntegrationInstall`) needs a colleague with an `appAdmin`/`appOwner` role. A tracking
snippet pasted into content or a widget is the wrong answer every time. See the "Analytics &
measurement" devbook for the full walkthrough and the two-case split in full.

**A blog needs no opt-in.** There is no capability flag, collection declaration, or provider
registration for `content/blog/`. Commit `content/blog/posts/*.json` and the routes exist:
`/blog/`, `/blog/<slug>/`, `/blog/category/<c>/`, `/blog/author/<a>/`, `/blog/tag/<t>/`, and the
sitemap entries for all of them. The whole tree rides the same `content/` mapping in
`.tot/config.json` as every other content file, so `posts/*.json` are the collection — the index
and the taxonomy pages are derived from them.

`index.json` only overrides listing ORDER. It is optional, and it is not load-bearing: if it is
absent or malformed, listings fall back to newest-first by `publishedAt` and every article stays
reachable. A malformed one is still worth fixing — validation reports it as `invalid-json` and the
file is dropped from the published version — but it can never dark the blog.

## The golden rules (the boundaries validation enforces)

These are non-negotiable and machine-enforced. Internalize them — every task guide assumes them.

1. **Never edit platform code.** No components, layouts, routes, middleware, runtime. If a
   request needs net-new code/route/checkout/compliance behavior, it is **platform work or
   extraction**, not tenant content.
2. **Never fabricate compliance facts or legal copy.** Age gates, FDA/nicotine/Prop-65/PACT
   warnings, excise notices — the *wording* is platform-owned; you only flip flags and pass
   small parameters (`minAge`, chemical names, state lists). Never remove, hide, rewrite, or
   paraphrase a required warning; never disable required age verification or excise tax.
3. **No raw HTML, inline scripts, `onclick=`, or `javascript:` URLs for regulated tenants.**
   Use blocks, editorial JSON, assets, and **sandboxed** widgets.
4. **Checkout & subscriptions are platform-owned.** Never build cart/checkout/subscription
   mechanics as widgets or HTML. Use the platform's managed checkout and the documented
   `purchase_options` data shape.
5. **Prefer data + tokens over everything.** The safest successful change edits `theme.json`
   and `content/*` — never anything that looks like code.
6. **Escalate, don't smuggle.** Sandboxed widget → private app → extraction. Widening the
   shared runtime is never a tenant customization.

## The task map (each is a devbook)

1. **Set up & run the local dev loop** — invite → keys → `tot dev` → `localhost/<tenant>/`;
   the `--sample` free taste; `tot doctor`; save→reload. *(Devbook: "The local dev loop")*
2. **Brand & theme the store** — `theme.json` tokens, light/dark, aliasing a brand vocabulary,
   AA contrast. *(Devbook: "Brand, theme & chrome")*
3. **Build the site chrome** — `chrome.json`: header, nav, mega-menus, footer, newsletter,
   announcement. *(same devbook)*
4. **Compose the home page & marketing pages** — the block palette, product sources,
   editorial pages. *(Devbook: "Pages & merchandising")*
5. **Merchandise the catalog** — product sources, collections, PLP/PDP, search, carousels &
   grids. *(same devbook)*
6. **Wire commerce & checkout** — commerce vs marketing tenants, managed checkout, cart-drawer
   theming, subscriptions/`purchase_options`, `capabilities.json`. *(Devbook: "Commerce & checkout")*
7. **Handle regulated compliance** — `.compliance` config, the immutable floor, the widgets,
   what you can and cannot touch. *(Devbook: "Regulated compliance")*
8. **Hit best-in-world performance & SEO** — edge SSR, images/rehosting, `llms.txt`, JSON-LD,
   zero-404, Web Vitals, the evidence panel. *(Devbook: "Performance & SEO")*
9. **Add interactivity & extend** — sandboxed widgets/`scripts.json`; then escalation to
   private apps and extraction. *(Devbook: "Widgets & extension")*
10. **Migrate an existing store** — MCP `website_assess` → `website_scaffold` →
    `website_migrate` → `website_preview`, then refine to visual parity.
    *(Devbook: "Migrating an existing store"; Day-1 kickoff:
    `devbook://storefront-migration-shopify-day1-kickoff`)*
11. **Validate, preview & go live** — the ship procedure and the go-live gate.
    *(Runbook: "Publish & go live")*
12. **Recover a candidate** — a candidate that lost its content, a reconcile that will not
    pass, forge auth that stopped working. *(Devbook: "Recover a candidate")*
13. **Wire analytics & measurement** — GA4/Meta/Amplitude through reviewed adapters, a separate
    test property per environment, and the consent gate. *(Devbook: "Analytics & measurement")*
14. **Migrate from Google Tag Manager** — upload the existing GTM export, review the complete
    accounting and native mappings, then create a disabled managed-analytics install. *(Devbook:
    "Migrate from Google Tag Manager (GTM)")*
15. **Add a cataloged third-party embed** — opt into a reviewed provider (e.g. Pipedrive Web
    Forms) via `embeds.json`; the dev-loop lint and a publish-time backstop both catch a marker
    used without the matching opt-in. *(Devbook: "Third-party embeds")*

## The Storefront Devkit — runnable examples for every task

This devbook set is the *how-to*. The **Storefront Devkit** is the *runnable material* — fork a
starter, copy a snippet, validate against a schema:

> **https://github.com/tokenoftrust/storefront-devkit**

Every task below maps to concrete files there. Read the devbook for the *why and how*; pull the
example from the devkit.

| Task (devbook) | Start from (devkit) |
|---|---|
| Set up & run the loop | repo `README.md` quick start |
| Brand & theme | `schemas/theme.schema.json`, `snippets/theme-presets/`, `templates/*/theme.json` |
| Site chrome | `schemas/chrome.schema.json`, `snippets/chrome/`, `templates/*/content/chrome.json` |
| Home & marketing pages | `schemas/home.schema.json`, `snippets/blocks/`, `templates/*/content/home.json` |
| Merchandise the catalog | `snippets/product-sources/` |
| Commerce & checkout | `schemas/capabilities.schema.json`, `recipes/add-subscription-option/`, `snippets/checkout/` |
| Compliance | `schemas/compliance.schema.json`, `snippets/compliance/`, `templates/regulated-vape/`, `recipes/enable-pact-compliance/` |
| Performance & SEO | `snippets/seo/` + `docs/store-performance-seo.md` |
| Widgets & extension | `widgets/`, `private-apps/` |
| Migrate a store | `migration/` |
| Publish & go live | `ci/` |
| Build by industry | `industries/` |

## Troubleshooting: admin write API returns 403 "ship-on-behalf grant required"

You hit this from `/admin` or `tot`'s admin-API helpers (e.g. `/api/admin/tracking-writeback`,
`/api/changes/ship`) — commonly while an invite's `tot login --code` snippet has you showing
`capability=owner` in `tot grants` for the same tenant. **The CLI grant and this admin gate are two
different things** — `tot grants` reflects checkout/dev-loop access, never shipping authority. The
CLI's `owner` label does not satisfy this gate, even though it sounds like it should.

The fix is a one-minute action **by the tenant's real owner** (signed in as themselves, not the
internal staff "Operating as" picker), not by you: they open
`/dashboard/<appDomain>/team` → **"Delegate ship-on-behalf"** and grant your email, with an expiry.
Forward this paragraph to them if you are not the owner — there is nothing else to escalate. Full
detail (including the console-fetch equivalent, for an owner who'd rather not click through the UI):
`runbook://storefront-runbook-permissions-and-grants`.

## Your reference material while building

- **The Storefront Devkit** — https://github.com/tokenoftrust/storefront-devkit — templates,
  JSON Schemas, snippets, sandboxed widget, recipes, and by-industry guides. Copy-and-go.
- **Your store's style guide** renders your live theme tokens and the full component palette
  with sample data — the fastest way to see what a widget looks like in your brand before you
  place it. Ask your coach/agent to open it, or find it linked from your dev cockpit.
- **This devbook set** (search `scope:storefront`) is the task-by-task how-to.
- **Your coding agent** should be given the customization *contract* (the golden rules above) as
  a hard contract — drop in the devkit's `agent-kit/AGENTS.md`, which encodes exactly that.

## Where you are vs. where content ships

- **Local (`tot dev`)** is *yours* — private, offline-friendly, save→reload. Nothing you do
  locally is public.
- **Publish/promote** is the only path that makes content public, and it always passes the
  **compliance gate**. You cannot ship a store that fails the floor — by design.
- **Production go-live is the owner's call** (or their delegate's), gated on green evidence.
  During onboarding you typically work **preview-only** on a real store.
