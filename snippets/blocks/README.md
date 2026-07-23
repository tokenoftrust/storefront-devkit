# Block snippets

One file per homepage block. Each file is a single block object — paste it into the `blocks[]`
array of `content/home.json`. Validate against
[`../../schemas/home.schema.json`](../../schemas/home.schema.json).

- `hero.json` — commerce hero (headline + CTA).
- `featured-products.json` — a merchandised product row bound to a source.
- `faq.json` — an FAQ section (marketing block).
- `cta-band.json` — a closing call-to-action band (marketing block).

Commerce homepage blocks: `hero`, `featured_products`, `featured_collections`, `editorial`,
`newsletter`. Marketing blocks: `marketing_hero`, `trust_bar`, `split_compare`, `steps`,
`card_grid`, `integrations`, `proof_strip`, `testimonials`, `faq`, `cta_band`. See the schema for
every field.
