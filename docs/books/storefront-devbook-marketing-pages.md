---
id: storefront-devbook-marketing-pages
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Marketing pages — stamp data-tot-el (chrome_unstamped) or use platform blocks
---
# Marketing pages — stamp data-tot-el (chrome_unstamped) or use platform blocks

**Task:** choose the content shape for a marketing page, and land it in the files the platform already renders. When `tot dev` logs `BROKEN chrome_unstamped` on a raw page, follow [Stamp data-tot-el](#stamp-data-tot-el). You do not add Astro pages or components.

The platform is already Astro. A tenant page is native when it is one of the two content shapes those routes already know how to serve. Both shapes publish the same way, on Cloudflare and on CloudFront. The choice is the file, not the CDN.

## The two shapes

| Shape | Files you own | What gets served |
|---|---|---|
| **Raw HTML** | `content/home.html`, `content/pages-html/<slug>.html` | That document, verbatim. A full document keeps its own header and footer. A body fragment is wrapped in the tenant chrome. |
| **Platform blocks** | `content/home.json`, `content/pages/<slug>.json`, `content/chrome.json` | The shared layout. Header and footer come from `chrome.json`. The body is the block or section list. |

Raw HTML is allowed only for an unregulated tenant. A regulated commerce tenant's raw file is ignored, and the platform-composed page is what visitors get. That is intentional: age, identity, warnings, tax, and checkout stay in the layout.

## Decide before editing

| The page | Use |
|---|---|
| A bespoke layout the block list below cannot express without dropping sections | **Raw HTML.** Stamp `data-tot-el`. Leave the markup. |
| A composed story that fits the block list, and should follow `theme.json` and shared chrome | **Blocks.** Add the JSON and remove the raw file in the same change. |
| A section several tenants need, and no block exists for it | **Platform work.** Ask for a block. Do not add a one-off page in the platform repo, and do not hide the section in a script. |
| The tenant is regulated | **Blocks or editorial JSON only.** |

Pixel fidelity is the test for a move off raw HTML. Same section order, same hero, same calls to action. A cleaner redesign is a different page.

## Worked case — `store.example.com` home

`content/home.html` in that tenant's repo is a full document: custom hero console, compare accordions, persona tabs, and a request-access modal. The block list has none of those. `marketing_hero` is a headline, subhead, a CTA row, and an optional log panel. Rebuilding this page as blocks would replace it.

The file has 32 links, buttons, and form fields, and no `data-tot-el`. Eighteen of the click targets carry `data-ev` (`nav_why`, `request_access_hero`, and so on). The click listener reads `data-tot-el` only. `data-ev` is a name the writeback may use when it proposes an id. It is not collected.

`tot dev` logs `BROKEN chrome_unstamped` for this page because the document is actionable and unstamped. That log is the missing ids. It is not a request to rewrite the page.

**Stay on raw HTML. Stamp `data-tot-el` with the procedure below.**

## Stamp data-tot-el

The dev loop serves the git file. Nothing stamps it on the way out. Until `data-tot-el` is in that file, every click on the page is invisible and `tot dev` logs `BROKEN chrome_unstamped`. `tot validate` reports the same gap as `cta-missing-id`.

`data-ev` is a name the stamp can reuse. The click collector reads `data-tot-el` only.

Who can run this: the person at the keyboard is logged into the tenant's own host as the store owner, or as a developer with a ship-on-behalf grant for that store. A preview-only login gets HTTP 403. The Admin page must show this tenant. If it shows a different tenant, stop.

The call is not a page. Pasting `/api/admin/tracking-writeback` into the address bar is a GET. That prints the proposed ids and changes nothing.

On a browser tab already logged into that host, open the developer console and run:

```js
fetch("/api/admin/tracking-writeback", { method: "POST" }).then(r => r.json()).then(console.log)
```

For `store.example.com` the host is `https://store.example.com`. For any other tenant, use the host that Admin is showing for that tenant.

Read the JSON:

| Result | What to do |
|---|---|
| `status: "submitted"` | Success. Keep `url`, `prNumber`, and `needsReviewCount`. The pull request title is "Assign data-tot-el identity to tenant body elements". Running the POST again updates that same pull request. It does not open a second one. |
| `status: "no_changes"` | Every trackable element already has `data-tot-el`. Stop. |
| HTTP 401 | Not logged in on this host. |
| HTTP 403 | Logged in, but not the owner and no ship-on-behalf grant. |
| Any other `ok: false` | Stop and report `status` and `message`. Do not retry with a different URL. |

Open `url`. The diff may only add `data-tot-el` attributes. If copy, structure, links, or scripts also change, do not accept it. The server wrote the page from the copy it is serving, which can be older than the tenant repo.

In the pull request body, ids taken from `data-ev`, `id`, or `name` are ready to accept. A section titled "Needs review" lists ids that were named from their position. Rename those in the candidate before accepting. `needsReviewCount: 0` means there are none.

Accept the candidate from Admin → Publish, or `tot accept --pr <prNumber>`. That merges it into the tenant repo. It does not publish the public site. Pull the merged file into the checkout `tot dev` is using. Reload and confirm `BROKEN chrome_unstamped` for that page is gone.

A later non-fatal `stamp_incomplete` warning means a stamped element has no `data-tot-action`. Set `data-tot-action` only on clicks that need an action name. It is not required to clear the broken log. The POST does not write `data-tot-action`. There is no automatic step from the id to the action.

## Move onto blocks — only when the page fits

Homepage blocks, in `content/home.json` under `blocks`:

`marketing_hero`, `trust_bar`, `split_compare`, `steps`, `card_grid`, `integrations`, `proof_strip`, `testimonials`, `faq`, `cta_band`.

Each block is copy, links, and a variant. Colors come from `theme.json`. A CTA is `{ "label", "href", "variant" }` with variant `primary`, `secondary`, or `ghost`.

A prose subpage (about, legal, a simple contact story) is `content/pages/<slug>.json` with `sections`, rendered inside the shared layout.

Shared header and footer are `content/chrome.json`. A raw file that is a full document does not use that chrome. Its own header is the header.

**The raw file wins.** If `content/home.html` exists, `/` is that file and `content/home.json` is unused. If `content/pages-html/<slug>.html` exists, that URL is the raw file and `content/pages/<slug>.json` is unused. Delete the raw file in the same change that adds the JSON. Leaving it "as a fallback" keeps the old page live.

`example.com` is the picture of that trap: it has a `home.json` of `marketing_hero` and the other blocks, and a `home.html`. Visitors get `home.html`.

Block buttons are not given `data-tot-el` by the renderer. Moving to blocks gives you shared chrome, theme tokens, and the layout's integration phases. It does not, by itself, make hero and band clicks collect. Do not move a page to clear `chrome_unstamped`.

Check the rendered JSON page against the raw page, section by section, before you delete the raw file.

There is no form block and no modal block. A custom request form stays in the raw document, or becomes a reviewed embed (`embeds.json`) or a sandboxed widget (`scripts.json`). Do not paste a script into a block.

## Do not

- Add a route or a component under the platform app for one tenant.
- Hand-author `data-tot-*` inside platform chrome. Chrome ids come from `chrome.json` through the renderer.
- Treat `data-ev` as analytics. Stamp `data-tot-el`.
- Ship a raw HTML file for a regulated tenant and expect it to be the live page.

## Handoff prompt

> For tenant `<id>`, read `devbook://storefront-devbook-marketing-pages/full` first. If `tot dev` logs `BROKEN chrome_unstamped` on a raw page, follow "Stamp data-tot-el" in that devbook. If the page fits the block list, add the JSON and delete the raw file in the same change. For `store.example.com` home, stay raw and stamp.
