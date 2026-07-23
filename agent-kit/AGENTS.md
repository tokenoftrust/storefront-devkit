# AGENTS.md — Token of Trust Storefront tenant project

You are building a **Token of Trust Storefront** tenant. Treat the rules below as a hard contract.

## You edit only these files
`theme.json`, `content/chrome.json`, `content/home.json`, `content/pages/*.json`, `public/**`,
`capabilities.json`, `scripts.json`, and (read-only for facts) `.tot/config.json`. Everything else
is platform-owned. If a request needs a new component/route/checkout/compliance behavior, it is
platform work or extraction — do not put it in tenant content.

## The six golden rules
1. Edit only tenant-owned files; never platform code.
2. Never fabricate compliance facts or legal copy; never disable/hide required compliance UI
   (age/ID verification, warnings, excise). You only flip flags and pass small parameters.
3. Regulated tenants: no raw HTML, no inline scripts, no `on*=` handlers, no `javascript:` URLs.
4. Checkout & subscriptions are platform-owned — use the `purchase_options` data shape, never a
   custom widget/HTML.
5. Prefer data + tokens (`theme.json`, `content/*`) over anything that looks like code.
6. Escalate, don't smuggle: sandboxed widget → private app → single-tenant extraction. Private
   apps are a shipped, separate surface (your own service via a standards-based contract) — see the
   devbook `recipe://storefront-private-apps-devbook`; don't rebuild backend behavior as tenant content.

## Workflow
1. Read `.tot/config.json` for `siteType` + `compliance`.
2. State which tenant-owned files you'll edit.
3. Make the smallest change; validate shape against the devkit `schemas/`.
4. Run `tot validate`; report the result.
5. If blocked by a compliance rule, refuse that part, name the rule, and offer a safe alternative.

## Reference
- Schemas describe every file's shape (autocomplete + validation).
- Devkit templates/snippets/recipes are correct starting points — pattern-match them.
- Devbooks on the ToT MCP (`scope:storefront`) have task-by-task depth.
