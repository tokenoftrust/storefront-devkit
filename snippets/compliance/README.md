# Compliance snippets

Drop-in `compliance` blocks for `.tot/config.json`, one per regulated vertical. Each is **flags
and parameters only** — the mandated legal wording is rendered by the platform's compliance
widgets, which you cannot edit, hide, or paraphrase. A widget renders nothing when its field is
absent.

> **Set real facts, not placeholders.** `minAge`, chemical names, and state lists must reflect the
> client's actual obligations. Never invent them. Enforcement (ship/no-ship, tax calculation)
> stays platform-owned; these entries are the display/config surface.

| Snippet | Vertical | Turns on |
|---|---|---|
| `vape-nicotine.json` | Tobacco / vape / nicotine | 21+, FDA nicotine warning, PACT Act, adult signature, Prop 65, state eligibility, excise |
| `alcohol-wine-spirits.json` | Wine, spirits, alcohol | 21+, state eligibility, adult signature, excise |
| `hemp-cbd.json` | Hemp & CBD | age gate, state eligibility, purchase limit |
| `firearms-ammo.json` | Firearms & ammunition | age, state eligibility, shipping restriction (ship-to-FFL), adult signature |

Paste the object under the `compliance` key of your `.tot/config.json`. Validate against
[`../../schemas/compliance.schema.json`](../../schemas/compliance.schema.json) and run
`tot validate`. See [`../../industries`](../../industries/) for how each maps to Token of Trust
products.
