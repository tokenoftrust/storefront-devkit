---
id: storefront-devbook-local-dev-loop
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: The local dev loop — set up, run, and iterate
---

# The local dev loop — set up, run, and iterate

**Task:** get from an invite to a running local store you can edit with save→reload, and
know the day-to-day commands. This is the foundation for every other devbook.

> Prerequisites: an invite from the store owner/ToT (this scopes you to a specific tenant),
> Node (a current LTS), and your agent connected to the ToT MCP. You never need cloud
> credentials, AWS keys, or Docker for normal work.

---

## What the local loop is (and isn't)

- **Local dev loop** = what you run on **your machine**: the `tot` CLI boots your store at
  `http://localhost:<port>/<tenant>/` and live-reloads on save. This is where you build.
- It is **not** the hosted `/dev` panel (a per-vendor page on the deployed store). Different
  thing, different audience. When someone says "the dev loop," they mean *this* — your local
  save→reload loop.
- Nothing local is public. Content only goes live through **publish → promote** (see the
  "Publish & go live" runbook).

## Day-one flow

1. **Try it with zero setup (optional but recommended):**
   ```bash
   tot dev --sample
   ```
   This scaffolds a bundled **sample store** and runs it locally with **no login and no
   network** — a free taste of the platform. The compliance rendering (age gate + nicotine
   warning) still shows, so you can see how the regulated surfaces behave before you touch a
   real store.

   For a **real client project**, start from a devkit template instead — a clean, contract-valid
   base you edit in this same loop:
   ```bash
   # https://github.com/tokenoftrust/storefront-devkit
   cp -R storefront-devkit/templates/commerce-minimal ../my-client-store
   ```
   Templates: `commerce-minimal`, `marketing-minimal`, `regulated-vape`. Copy the devkit's
   `.vscode/settings.json` for schema autocomplete + inline validation on every tenant file.

2. **Sign in** (binds your CLI to your invited scope):
   ```bash
   tot login          # opens a browser / paste-a-code flow
   tot whoami         # confirms who you are and which tenant(s) you can act on
   ```

3. **Run your store:**
   ```bash
   tot dev            # boot the store with save→reload
   # or
   tot start          # same loop, phrased as "just start it"
   ```
   The CLI resolves the current runtime for you, boots the store, and opens
   `http://localhost:<port>/<tenant>/`. The first run does a one-time setup (cached
   afterwards), so subsequent boots are fast.

4. **Edit → save → see it.** Change a tenant-owned file (`theme.json`, `content/*.json`,
   `public/**`) and save. The browser reloads against your store automatically. That's the loop.

5. **Sanity-check the environment any time:**
   ```bash
   tot doctor         # diagnoses common setup problems and suggests fixes
   ```

## The command surface you'll actually use

| Command | What it does |
|---|---|
| `tot login` / `tot logout` | Sign in / out; `login` supports a paste-a-code path when a browser isn't available |
| `tot whoami` | Show your identity and the tenant scope you can act on |
| `tot dev` / `tot start` | Boot your store locally with save→reload |
| `tot dev --sample` | Zero-login, offline sample store — the free taste |
| `tot validate` | Check your changes against the contract before publishing (schema, palette, contrast, compliance floor) |
| `tot submit` | Push your work toward a private preview (crosses to the platform; compliance gate applies) |
| `tot checkout` | Work with a standalone tenant checkout (your isolated working tree) |
| `tot doctor` | Diagnose the local setup |
| `tot feedback` / `tot ideas` | Send feedback or feature ideas back to ToT from the CLI |

> You'll do the vast majority of building with just `tot dev`, `tot validate`, and `tot submit`.

## What "editing" means here

You are editing **tenant-owned files** only (see the index devbook for the full table):
`theme.json`, `content/chrome.json`, `content/home.json`, `content/pages/*.json`,
`public/**`, `capabilities.json`, `scripts.json`. You are **never** editing platform code —
those paths are read-only and any edit to them is discarded / rejected.

A good working response from your agent looks like:

```text
Changed:
- theme.json: updated brand tokens
- content/home.json: switched featured products to best sellers
Compliance:
- Age verification, warnings, checkout integrity, and excise obligations unchanged.
Validation:
- tot validate: passed
```

## Common pitfalls

- **Editing a platform file and wondering why it "reverts."** Platform-owned files are not
  yours; changes there don't stick. Work only in the tenant-owned surface. If you think you
  need a platform change, that's an escalation (see "Widgets & extension").
- **Expecting `/dev` to reflect your local edits instantly.** The hosted `/dev` panel is a
  separate surface; it may show lightweight activity/"live" breadcrumbs but it is **not** your
  local preview. Your preview is `localhost/<tenant>/`.
- **Assuming production is one click.** During onboarding you're typically **preview-only**;
  going live is the owner's gated decision. Build toward green evidence, not toward a deploy
  button.
- **Reaching for raw HTML because a block "doesn't exist."** For regulated tenants raw HTML is
  blocked at publish. Translate the intent into blocks/editorial JSON/assets/sandboxed widgets
  (see the relevant devbooks).

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `tot dev` won't boot / first run is slow | First run does a one-time setup + fetch; let it finish. Re-run `tot doctor`. Check your Node version is current LTS. |
| Browser opens but store is blank / 404 | Confirm you're hitting `/<tenant>/` (the store root), not `/` or `/dev`. Check `tot whoami` shows the right tenant. |
| Changes don't reload | Confirm you saved a **tenant-owned** file (not a platform file). Hard-reload once; check the terminal for a watcher error. |
| "Not authorized" / scope errors | `tot login` again; `tot whoami` to confirm scope. Your invite scopes you to specific tenants only. |
| Want to try without any of this | `tot dev --sample` — offline, no login. |

## Rules your coding agent must follow (recap)

- Edit only tenant-owned files; never platform code.
- Never fabricate compliance facts; never disable/hide required compliance UI.
- Run `tot validate` before proposing a publish, and report the result.
- If a request can't fit the tenant surface, say so and name the escalation path.
