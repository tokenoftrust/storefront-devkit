# Regulated compliance on Token of Trust Storefront

Regulated stores (vape and nicotine, alcohol, hemp/CBD, firearms) are held to a compliance
**floor** that the platform owns and enforces. You never write legal wording. You turn
compliance on and supply facts.

What the floor covers:

- **Age verification**: an age gate with a configured minimum age.
- **Mandated notices**: FDA nicotine warnings, California Prop 65, and other required product
  notices, rendered by the platform in approved wording.
- **Shipping and sale rules**: PACT Act handling, state eligibility, purchase limits, and
  excise display. The platform makes the actual ship/no-ship and tax decisions.

How you work with it:

- Set compliance **facts** in your store's `.tot/config.json`. Validate them against
  [`schemas/compliance.schema.json`](../schemas/compliance.schema.json).
- Start from a vertical snippet in [`snippets/compliance/`](../snippets/compliance/), or the
  [`templates/regulated-vape/`](../templates/regulated-vape/) template.
- Follow the worked recipe in [`recipes/enable-pact-compliance/`](../recipes/enable-pact-compliance/).
- `tot validate` checks your configuration before anything ships.

The full developer guide covers every widget and parameter, what you can and cannot change, and how
the floor interacts with your theme and pages. It is available to signed-in Token of Trust
developers as the devbook `storefront-devbook-compliance`, via the Token of Trust MCP.
