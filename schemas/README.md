# Schemas

JSON Schemas for every tenant-owned file. They are the **authoritative shape** — when the docs
are ambiguous, the schema wins.

| Schema | Describes | Notes |
|---|---|---|
| `theme.schema.json` | `theme.json` | Deep-partial override of the reference theme; AA contrast checked at publish |
| `chrome.schema.json` | `content/chrome.json` | Header, nav/mega, footer, newsletter, announcement |
| `home.schema.json` | `content/home.json` | Block palette `block-palette@3` + product sources |
| `pages.schema.json` | `content/pages/*.json` | Editorial/standalone pages; same `block-palette@3` format as home |
| `scripts.schema.json` | `scripts.json` | Registered, sandboxed-by-default widget bundles |
| `capabilities.schema.json` | `capabilities.json` | Optional toggles; cannot weaken the compliance floor |
| `compliance.schema.json` | `.tot/config.json#/compliance` | Flags/params only — legal wording is platform-owned |
| `tot-config.schema.json` | `.tot/config.json` | Store id, file mappings, and declared facts (siteType, compliance, capabilities, features, embeds). Your editor flags a key the platform does not read; `tot validate` warns about it, and going live waits for the owner's approval |

## Use them

- **Editor autocomplete/validation:** copy `../.vscode/settings.json` into your project (it maps
  each schema to the matching file). Or add a `"$schema"` key at the top of a JSON file pointing
  at the raw schema URL.
- **CI validation:** the `../ci/github-actions/validate.yml` gate validates your tenant files
  against these before you submit.
- **Ground truth for agents:** point your coding agent at the relevant schema before it edits a
  file.

> These schemas describe the tenant contract, not the platform implementation. They are additive
> to `tot validate` (which also runs contract, palette, contrast, and compliance-floor checks the
> schema alone can't express). Always run `tot validate` too.
