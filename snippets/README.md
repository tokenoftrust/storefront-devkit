# Snippets

Copy-paste fragments, one concern each. Grab one, paste it into the matching tenant file, adjust,
validate.

| Set | Paste into | Contents |
|---|---|---|
| [`blocks/`](./blocks/) | `content/home.json` `blocks[]` | One file per homepage block |
| [`chrome/`](./chrome/) | `content/chrome.json` | Mega-menu and footer patterns |
| [`compliance/`](./compliance/) | `.tot/config.json` `compliance` | Per-vertical compliance profiles |
| [`product-sources/`](./product-sources/) | a product block's `source` | Every product-source form |
| [`theme-presets/`](./theme-presets/) | `theme.json` | Ready-made palettes + type pairings |

Every snippet targets `block-palette@3` and validates against the schemas in
[`../schemas`](../schemas/). Always run `tot validate` after pasting.
