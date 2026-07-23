# CI — pre-submit gate

Run the compliance/contract checks in your own pipeline so bad changes never reach a submit.

- [`github-actions/validate.yml`](./github-actions/validate.yml) — on every PR: validate tenant
  JSON files against the devkit schemas, then (if credentials are configured) run `tot validate`.

## Why two layers

- **Schema validation** (offline, no credentials) catches shape errors instantly — wrong keys,
  bad enums, malformed blocks. Fast feedback for every contributor.
- **`tot validate`** additionally enforces the platform contract the schema can't express:
  block-palette version, WCAG AA contrast, unsafe-HTML checks, and the **compliance floor**. Wire
  it with a scoped credential secret so PRs are gated on the real gate, not just shape.

Copy `github-actions/validate.yml` into your project's `.github/workflows/`.
