# Prompt recipes

Short, reusable prompts for common tasks. Paste into your agent after it has read the project
`AGENTS.md`.

### Rebrand
> Rebrand this store to match {brand}: primary {hex}, accent {hex}, {display font}/{body font}.
> Edit `theme.json` only, keep AA contrast, and run `tot validate`. Don't touch components or
> compliance.

### Merchandise the homepage
> Set the homepage to: hero → best sellers → {collection} → on sale → newsletter. Use
> `content/home.json` block-palette@3 and product **sources** (not hand-listed handles). Validate.

### Turn on compliance for {vertical}
> This is a {vape/alcohol/hemp/firearms} store. Add the matching compliance profile from the
> devkit `snippets/compliance` to `.tot/config.json`, using these real facts: minAge {n}, restricted
> states {…}. Do not write any warning text yourself. Run `tot validate`.

### Add a sandboxed widget
> Add a {loyalty/quiz/locator} widget in the {product.aside/home.section/global.footer} slot,
> `isolation: sandbox`, `strategy: on-interaction`. Register it in `scripts.json`; don't inline it.

### Add a subscription option
> Add a monthly subscribe-and-save (15% off) option to {product} using the `purchase_options`
> data shape. Do not build any checkout/billing UI.
