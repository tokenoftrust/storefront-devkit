# Agent kit

Drop-ins that make *your own* coding agent build within the Storefront contract from the first
prompt.

- [`AGENTS.md`](./AGENTS.md) — copy into the root of your client project. Most agent tools
  (Claude Code and others) read a root `AGENTS.md`/`CLAUDE.md` automatically, so the contract is in
  context before the agent edits anything.
- [`prompts/`](./prompts/) — short, reusable task prompts for common jobs.

## How to use

1. `cp agent-kit/AGENTS.md ../my-client-store/AGENTS.md`
2. Point your editor's schemas at `../schemas` (copy `.vscode/settings.json`).
3. Give your agent a task from `prompts/`, or your own — it will already know the boundaries.

The contract mirrors the repo-level [`../AGENTS.md`](../AGENTS.md); this copy is trimmed for
dropping into a tenant project.
