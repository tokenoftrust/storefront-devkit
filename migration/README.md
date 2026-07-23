# Migrating an existing store

Bring a client's existing store (Shopify, WooCommerce, BigCommerce, custom) onto the platform, then
refine it to parity in the local dev loop.

## The flow (via the ToT MCP)

The platform does the heavy lifting through MCP tools you call from your agent — you don't hand-move
catalog data:

1. **Assess** — point the platform at the client's live URL to get a read on brand, structure, and
   catalog (`website_assess`).
2. **Scaffold** — generate a starting tenant (theme + chrome + home + catalog) from that assessment
   (`website_scaffold`).
3. **Migrate** — bring over catalog, collections, brand, policies, and compliance metadata
   (`website_migrate`).
4. **Preview** — get a private preview to review (`website_preview`).
5. **Refine locally** — `tot dev` and iterate on the tenant-owned files until it's at (or better
   than) parity. See [`visual-parity/`](./visual-parity/).
6. **Validate & go live** — `tot validate`, then publish/promote (owner-gated).

> Catalog and compliance metadata are moved by the platform; your job is brand, chrome, homepage
> merchandising, and compliance configuration — the tenant-owned surface this devkit is about.

## Tips

- Start with a **proof-of-concept scope** (one collection, a few products) to validate the pipeline
  before the full catalog.
- Home pages are the hardest, most bespoke part of a port — budget your iteration there (see the
  visual-parity method).
- Do a full pass early, keep the client's store live, then re-migrate incrementally at cutover to
  keep the switchover window short.
