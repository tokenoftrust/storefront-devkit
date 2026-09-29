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

## A store's own readiness report

Save each page's JSON into one directory, then run `tot report go-live --pages <dir>` from your
store checkout for the merchant-facing go-live readiness report.

Site-wide validation with triage, source-baseline parity and the style-concept approval method are
in the Agency Kit.
