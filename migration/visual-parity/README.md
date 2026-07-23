# Visual-parity port method

Getting a migrated home page *right* is the hardest, most visible part of a port. This is a
screenshot-and-compare loop: render your migrated store next to the client's live original, compare
region by region, fix the gaps in tenant-owned files, and repeat until sign-off (usually 2–4 passes).

## The loop

1. **Render both** at the same widths:
   - Yours: `http://localhost:<port>/<tenant>/` (`tot dev` running).
   - Original: the client's live store.
2. **Screenshot top-to-bottom** (viewport frame + full page). Dismiss your age gate first so it
   doesn't cover the fold. `compare.mjs` in this folder is a starting template using Playwright.
3. **Compare region by region** — announcement → header/nav → hero → merchandising rows →
   editorial → footer. Classify each: *parity*, *gap* (present on original, missing/weaker on
   yours), *worse* (you have it but it reads worse), *better* (yours wins — keep it).
4. **Fix at the right level** — most gaps are **content/merchandising** (hero copy+image, promo
   tiles, curated rows) fixed in `content/home.json` + `theme.json`. Some are **out of scope** (a
   commerce affordance not configured yet) — log, don't fake.
5. **Re-render, re-screenshot, show the client** with specific questions ("match their
   product-on-flag hero, or go cleaner and feature a real collection?"). Their taste drives priority.

## Do better than the original

The goal is parity on *intent*, not pixel-cloning a dated theme. Where the original is cluttered,
slow, or inaccessible, the platform's token-driven, edge-rendered storefront should win — keep those
wins (speed, no console errors, accessibility) and tell the client about them.
