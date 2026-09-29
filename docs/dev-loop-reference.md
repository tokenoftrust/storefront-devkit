# Developer loop reference: `tot dev`, `validate`, `preview`, `sync`

> **Audience:** anyone building a Storefront store locally.
>
> **Scope:** the private inner loop and the isolated candidate preview. Integrating candidates,
> publishing, and connecting a domain are store-bound and live in the signed-in book
> `devbook://storefront-devbook-ship-and-connect-domain`.

Work moves along one line, and each stage has exactly one meaning:

```text
your candidate --preview--> protected preview aggregate --ship--> live
   (isolated)      accept     (combined, evidence-gated)
```

- **`main`** is the accepted release history, what has shipped. Developers never push it.
- **`preview`** is the protected aggregate: the combined, evidence-checked result of every accepted
  candidate. It advances only when the combined result is green.
- **A candidate** is one developer's isolated work: its own branch, its own `candidate/<id>` ref and
  its own preview URL. Candidates never write the shared `preview` aggregate directly.

| Verb | Stage | Meaning |
| --- | --- | --- |
| `tot dev` | private | Run the store locally with save-to-reload. Only you see it; it never touches live. |
| `tot preview` | isolate | Create or update your own candidate and its preview URL. Never writes the shared aggregate or live. |
| `tot accept` | integrate | Queue a candidate into the protected `preview` aggregate. Signed-in book. |
| `tot ship` | publish | Publish the current green aggregate. Signed-in book. |

Nothing becomes live because you ran `tot dev` or `tot preview`.

## Before you start

Use a supported macOS, Linux, or WSL environment with Git and the current active-LTS Node.js. Docker
is optional; the native runner is the default. Keep the CLI current without pinning a version:

```bash
npm install --global @tokenoftrust/cli@latest
tot --version
node --version
git --version
```

Prefer the CLI's own help over any article; it reflects the version you have:

```bash
tot help
tot preview --help
```

Run the readiness check from the directory where you intend to work:

```bash
tot doctor          # context, OS, CLI, Node, Git, optional Docker, MCP endpoint, sign-in
tot doctor --fix    # attempt safe remediation; read what it will change first on a managed machine
```

## Context

The same `tot` command adapts to where it runs, walking upward from the current directory like Git:

| Detected context | Meaning | Typical commands |
| --- | --- | --- |
| Store checkout | A standalone store repo (`.tot/config.json`, `content/`, `public/`, `theme.json`) | `tot dev`, `tot validate`, `tot preview` |
| Loose directory | Not inside a recognized workspace | `tot clone` |

If a command says it must run inside a store checkout, confirm the directory rather than working
around the check with environment variables:

```bash
pwd
tot doctor
git status --short
git remote -v
```

## Identity and store authority

The CLI uses your personal sign-in. There is no shared cloud credential, DNS credential or operator
key.

```bash
tot login            # opens a browser and caches a refreshable local session
tot login --device   # headless or SSH device flow
tot whoami           # the active identity
tot grants           # which stores you may act on, each capability, and expiry
```

`tot grants` is the authority check: a successful login does not imply permission to preview or ship
every store. For intentionally separate identities, set an isolated profile before signing in:

```bash
export TOT_PROFILE=second
tot login
tot whoami
```

Unset `TOT_PROFILE` to return to the default.

## Get the store checkout

```bash
tot clone                       # list the stores your identity can access
tot clone <store>               # clone a store repository
tot clone <store> <directory>   # choose the local directory
```

The store repository on the forge is the source of truth for store content. If a clone already
exists, repair its auth through the CLI rather than pasting a token into Git config; `tot preview`
mints a fresh short-lived forge credential immediately before pushing.

## `tot dev`: the private inner loop

```bash
tot dev                          # from a store checkout
tot dev --workspace <directory>  # run a specific store checkout
tot dev --port <port>            # explicit local port
tot dev --no-open                # do not open a browser
tot dev --sample                 # run with sample data
```

The command prints the URL it selected, for a store checkout normally
`http://localhost:<port>/<store-app-domain>/`. Use that exact URL.

Edit only store-owned surfaces unless your work order says otherwise: `content/` (pages), `public/`
(assets), `theme.json` (theme), `.tot/` (configuration). Saving a file updates the local renderer in a
few seconds. This is private; it does not update the forge, the shared preview, or live.

**If save-to-reload fails:** confirm `tot dev` is still running; use the exact printed URL including
the store path; confirm the edited file is inside the checkout `tot doctor` detected; check the
terminal for a validation, port or dependency error; then update the CLI and retry. A hosted page is
not proof the local renderer works; they are different applications. Do not append `/cockpit` to the
local URL `tot dev` prints; the Developer Cockpit is a hosted page, reached at
`https://<hosted-storefront-host>/<store-app-domain>/cockpit`.

## `tot validate`: validate before previewing

```bash
tot validate
tot validate --workspace <directory>
tot validate --json
```

The validator checks the store contract: configuration shape, theme data, portable links, referenced
files and assets. Fix errors before previewing. `--skip-validate` is a diagnostic escape hatch, not a
way to push failures downstream.

## Git preparation and auto-commit

```bash
git status --short
git diff
git branch --show-current
```

`tot preview` may auto-commit dirty paths, but only within `content/`, `public/`, `theme.json` and
`.tot/`; it never runs `git add -A`. Edits outside those surfaces are refused rather than swept into
a content commit; resolve, move or commit them yourself. Pass `--no-commit` to preview only already
committed content (uncommitted edits can show in your local browser while being absent from the hosted
preview; compare with `git show --stat --oneline HEAD`).

## `tot preview`: create or update your candidate

```bash
tot preview \
  -m "Finish pricing and contact pages" \
  --summary "Intent: ... User-visible effect: ... Verification: ... Risk / rollback: ..."
```

`tot preview` pushes your own isolated candidate: a distinct `candidate/<id>` ref derived from your
store, identity and branch. Two developers previewing different branches never collide, and no one
force-pushes a shared ref. On success it prints your candidate preview URL, the shareable link a
reviewer opens.

It runs, in order: detect the checkout and branch, validate, auto-commit eligible dirty store paths,
push the candidate ref with a fresh short-lived forge credential, open or update the PR-backed
candidate, reconcile the exact commit, and report compliance evidence and the hosted candidate URL.
Nothing becomes live because `tot preview` succeeds.

| Command | Use |
| --- | --- |
| `tot preview` | Update the active candidate for this checkout and branch. |
| `tot preview --fork-candidate` | Rarely needed. Open a second, independently tracked candidate off the same branch. A fresh git branch already gets its own candidate; prefer `git checkout -b`. |
| `tot preview --watch` | Stay attached through the reconcile and compliance lifecycle. |
| `tot preview -m "<title>"` | The short title the reviewer sees. |
| `tot preview --summary "<text>"` | The four-field explanation: Intent, User-visible effect, Verification, Risk and rollback. |
| `tot preview --summary-file <path>` | Supply the structured summary from a file (JSON `{intent,effect,verification,risk}` or the labeled text block); `-` reads stdin. |
| `tot preview --json` | Emit the candidate result (id, PR, URL, head SHA, evidence) as one JSON object; implies no browser open. |
| `tot preview --no-commit` | Preview only committed content. |
| `tot preview --no-wait` | Push and return after an immediate status read instead of waiting for reconcile. |
| `tot preview --no-open` | Do not open the hosted preview in a browser. |
| `tot preview --skip-validate` | Skip local lint to isolate a validator problem; the remote gate can still refuse. |

If `-m` is omitted, the CLI derives a title and file summary from Git so the review record is never
blank.

**A successful push is not a successful handoff.** Confirm the exact commit reconciled, checks are
green, the candidate URL opens and shows the intended change, and the live site is unchanged. If the
push landed but the result read-back is unavailable, treat the preview as pending: rerun `tot preview`
or inspect with `tot pr view`.

### Branching is an advanced feature

Working on one thing at a time? Ignore git branches entirely. Clone, edit, `tot preview`, repeat; the
same command keeps updating your one open candidate. The CLI manages its own isolated `candidate/<id>`
ref, your local branch name never has to match it, and you never touch the shared `preview` or `main`
branches.

For a second, independent line of work, use `git checkout -b`: a fresh branch gets its own candidate
automatically. A second `tot clone` checkout is the simplest way to keep uncommitted edits to two
different things in progress at once. Multiple developers' candidates fold together through the
integration queue described in the signed-in ship book, never by a manual `git merge` of someone
else's branch.

`tot preview` acts on the active candidate for the branch currently checked out:

```bash
git branch --show-current
tot pr list
tot pr view <number-or-id>
tot pr close <number-or-id> --reason "<why this line is abandoned>"
```

A repeated `tot preview` updates the existing open candidate; if that candidate was merged or closed,
the CLI opens a fresh one automatically.

### Handoff card

```text
Store:
PR number:
Branch:
Exact commit SHA:
Candidate preview URL:
Evidence or reconcile URL:
What changed:
Routes to inspect:
Validation performed:
Known risk or conflict:
Rollback:
```

The exact SHA matters: a branch and candidate URL move after another preview, and approval of an
older SHA does not approve a newer one.

## `tot sync`: recover from a conflict

When another accepted change has advanced the protected `preview` and your candidate now conflicts:

```bash
tot sync
```

`tot sync` fetches `preview` and merges it into your local branch by the repository's canonical
policy. On conflict it stops safely, printing the conflicting paths and leaving the tree recoverable,
and never force-pushes `preview` or `main`. After a successful sync your prior approval is stale: run
a fresh `tot preview` and get new evidence for the new head.

## See and build every candidate for a store

```bash
tot pr list --tenant <store-app-domain>        # every open PR, built or not
tot preview build --tenant <store> --pr <N>    # materialize a specific PR's preview on demand (inert)
tot pr view <N>
tot pr close <N>
```

A `[ready]` PR has a materialized preview. A `[not built]` PR has an open forge PR but no materialized
candidate yet. Building is inert: it never touches the shared aggregate or live, and it is also how you
recover a preview that was reclaimed to save space.

## Command map

```text
tot help                       commands supported by the installed CLI
tot doctor                     check the machine and show the detected context
tot login [--device]           sign in (browser, or device flow for headless or SSH)
tot whoami                     show the active identity
tot grants                     store capabilities and expiry
tot clone [<store>]            list stores, or clone one store checkout
tot dev                        run the current store locally with save-to-reload
tot validate                   validate the store contract
tot preview [--fork-candidate] create or update your isolated candidate and preview URL
tot pr list [--tenant <t>]     list every open PR for the store (built and not built)
tot preview build --pr <N>     materialize a specific PR's preview on demand (inert)
tot pr view <N> / close <N>    inspect or close one candidate
tot sync                       fetch `preview` and merge it into your local branch
```

## Git safety rules

- `git fetch` refreshes remote information; it does not change checked-out files.
- `git status --short` should be empty before you hand off.
- Hand off exact reviewed SHAs, never an unverified moving branch tip.
- Never run `git add -A` to make an error disappear.
- Never force-push `main`, `preview`, or another developer's candidate.
- If you do not understand local changes, preserve them and ask their owner.

## Failure and recovery

| Symptom | Likely boundary | Safe next action |
| --- | --- | --- |
| `tot` not found | CLI install or shell path | Reinstall `@tokenoftrust/cli@latest`, open a new shell, run `tot --version`. |
| Doctor reports unsupported platform | Native Windows or missing runtime | Use WSL, macOS or Linux; install current active-LTS Node.js and Git. |
| Signed in but store missing | Membership or grant | `tot whoami`, `tot grants`; confirm the store and invite with the owner. |
| Clone or push auth fails | Expired forge credential or wrong remote | `tot login` again, confirm the remote belongs to the store, retry `tot preview` (it re-mints a credential). Never paste it into a ticket. |
| Local page does not reflect a save | Local runner, wrong path or wrong checkout | Confirm the printed URL, the `tot doctor` context, terminal errors, and the edited file path. |
| Preview refuses unknown dirty paths | Auto-commit safety boundary | Inspect `git status`; commit or move out-of-scope changes. Do not broaden the add. |
| Preview validation fails | Store contract | `tot validate`, fix each reported path and rule, preview again. |
| Push succeeds but reconcile stays pending | Webhook or reconcile pipeline | Keep the candidate open, capture commit and candidate ids, wait or recheck. |
| Reconcile or compliance fails | Candidate content or evidence | Fix the reported rule, rerun `tot preview` on the same branch, re-review. |
| Hosted preview looks stale | Wrong candidate or branch, or incomplete reconcile | Check `git branch --show-current`, `tot pr list`, the candidate commit, and the URL from the latest preview. |
| A PR shows `[not built]` or its preview URL 404s | Candidate not materialized | `tot preview build --pr <N>`, then open its preview URL. |

## Escalation bundle

Run and include the non-secret output of `tot --version`, `node --version`, `git --version`,
`tot doctor`, `tot whoami`, `tot grants`, `git branch --show-current`, `git status --short`,
`git remote -v` and `tot pr list`. Also include the store app domain; the command that failed and its
complete output; the candidate or PR number; the exact commit SHA; the preview and evidence links; and
the approximate time and zone. Redact credentials, authenticated clone URLs, OAuth tokens, cookies and
secret environment values; a remote URL can contain a short-lived credential, so inspect
`git remote -v` before pasting it.

## Stable invariants

- Local development is private; a candidate preview is reviewable but not live.
- The forge repository is the source of truth for store content.
- A candidate is isolated: its own branch, `candidate/<id>` ref and exact head SHA. It never writes
  the shared `preview` aggregate directly.
- `main` and the protected `preview` aggregate are never developer force-push targets.
- Failed validation leaves the current live version untouched.
- Content publishing and domain routing are separate actions.
