# Theme presets

Ready-made `theme.json` starting points. Copy one over your `theme.json` and tune. All keep AA
contrast on their core text pairs (validation warns/errors otherwise).

- `warm-editorial.json` — light, warm, serif-display; good for apparel/home/craft brands.
- `dark-technical.json` — dark, high-contrast, geometric; good for gear/tech/regulated stores.

## Aliasing a brand's existing palette onto the contract

If a client already has a brand vocabulary (e.g. `--brand-red`, `--navy`), don't teach the
platform those names — **set the contract token to the brand's value** in `theme.json`:

```json
{ "color": { "primary": "#C8102E", "accent": "#1E3A8A", "sale": "#C8102E" } }
```

That's the whole aliasing story in the standard (token) path: the contract token *is* the public
API; point it at the brand's color. The full token vocabulary is in
[`../../schemas/theme.schema.json`](../../schemas/theme.schema.json).
