# Changelog

All notable changes to the Storefront Devkit. Format loosely follows Keep a Changelog.

## [0.1.0] — first pass

### Added
- Repo structure, `README.md`, `AGENTS.md`, `llms.txt`, `manifest.json`, `CONTRIBUTING.md`.
- Editor config (`.vscode/settings.json`) wiring schemas to tenant files.
- JSON Schemas: `theme`, `chrome`, `home` (block-palette@3), `scripts`, `capabilities`,
  `compliance`, `tot-config`.
- Templates: `commerce-minimal`, `marketing-minimal`, `regulated-vape`.
- Snippets: blocks, chrome, compliance, product-sources, theme-presets.
- Widget example: `loyalty-signup` (sandboxed).
- Recipes: `enable-pact-compliance`, `add-subscription-option`.
- CI: GitHub Actions validate gate.
- Agent kit: drop-in `AGENTS.md` template + prompt recipes.
- Migration: visual-parity port method.
- Industries: by-vertical guide (vape/nicotine, wine & spirits, hemp/CBD, firearms, marketplaces)
  with per-vertical compliance snippets, mapping each to templates and Token of Trust products,
  and linking back to storefront.tokenoftrust.store and tokenoftrust.com.
- Licensing: `LICENSE` (Apache-2.0) + `NOTICE` clarifying the license covers only the tenant-side
  devkit and NOT the separately-licensed platform runtime, plus a trademark note. README license
  section updated.
- Discoverability: `docs/DISCOVERABILITY.md` (GitHub-native SEO signals, backlinks, the robots.txt
  truth for repos vs Pages) and an optional `site/` GitHub Pages landing (`robots.txt`,
  `sitemap.xml`, `index.html` with meta/OpenGraph/JSON-LD) — inert until Pages is enabled.
- Private-apps track: `private-apps/README.md` — the second track (app developers), linking to the
  canonical shipped material (devbook `recipe://storefront-private-apps-devbook`, the contract, the
  affiliate reference app, the `tot app` CLI) rather than duplicating it. Clarifies the boundary
  between tenant `scripts.json` widgets and private-app widget launches.
