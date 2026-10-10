# Page checks

Single-page quality checks for a Storefront store. Each one checks one page (or one store
checkout) and prints one compact JSON object to stdout; detail goes to an artifacts directory.

| Tool | What it checks |
|---|---|
| `validate-page.sh <page-base> <slug> [artifacts-dir]` | HTTP render, commerce boundary, SEO head, sitemap entry, secret scan, stray source refs, CSP mode. Needs `curl`, `jq`. |
| `validate-page-browser.mjs <page-base> <slug> [source-url] [artifacts-dir] --provider cloudflare\|cloudfront` | Browser gates: pixel diff against a source URL, console, mobile layout, UX, axe accessibility, Lighthouse, CSP. |
| `perf-audit.mjs <page-base> <slug>` | Dependency-free performance audit from plain fetches: image dimensions, non-composited animations, render-blocking and unminified CSS. |
| `style-concept-audit.mjs --store <checkout> [--manifest <json>]` | CSS duplication, readability, shared-chrome adoption, and the style-concept manifest against `style-concept.manifest.schema.json`. |

## Setup

```
npm install        # playwright-core, lighthouse, @axe-core/playwright for the browser gates
npm test
```

`validate-page-browser.mjs` needs Chrome or Chromium; set `CHROME_PATH` if it is not in a
standard location. To use browser dependencies installed elsewhere, set `TOT_TOOLS_DEPS_FROM` to
that package's directory.

## Pages behind the age gate

A regulated store opens every page behind the platform age gate on a fresh visit. The browser
check measures the two states separately:

- **The page.** The screenshot, axe, keyboard, mobile, UX and Lighthouse passes run with the gate
  already affirmed, so their scores describe what an affirmed visitor sees. The check learns the
  gate's own affirmation key on a first, fresh load and confirms the next load is no longer
  blocked. The top-level `ageGate` field says which state was measured, in words. If the gate
  cannot be affirmed, Lighthouse parity is reported as unmeasured (`age-gate-open`) rather than as
  a regression.
- **The gate.** `gates.ageGate` loads the page fresh with the gate open and records whether the
  gate is a single named modal dialog, keeps keyboard focus inside itself, leaves nothing behind
  it focusable, and still exposes the page's `<main>` landmark. It also records axe and Lighthouse
  accessibility for the gated state. The gate belongs to the platform, so this record is advisory:
  it never decides the page's pass or its Lighthouse parity.

The CSP pass also loads the page with the gate open, so the gate's own markup is covered by the
policy check. A page without the gate is measured exactly as served, and `gates.ageGate` is marked
not applicable.

## A store's own readiness report

Save each page's JSON into one directory, then run `tot report go-live --pages <dir>` from your
store checkout for the merchant-facing go-live readiness report.

Site-wide validation with triage, source-baseline parity and the style-concept approval method are
in the Agency Kit.
