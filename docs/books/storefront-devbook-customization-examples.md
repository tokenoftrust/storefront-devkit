---
id: storefront-devbook-customization-examples
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Safe storefront customization — worked examples for LLMs and coding agents
---
# Safe storefront customization — worked examples for LLMs and coding agents

Companion to `devbook://storefront-devbook-customization-contract`.

Use these examples to demonstrate how an LLM or coding agent should behave when
customizing a Token of Trust storefront.

## Example 1: Brand Refresh

User request:

```text
Make the store feel more premium: darker header, sharper buttons, and a teal
accent. Keep the current product lineup.
```

Safe response:

- Edit `theme.json`.
- Do not edit Astro components.
- Do not alter compliance, checkout, taxes, or capability settings.

Sketch:

```json
{
  "colors": {
    "brand": {
      "primary": "#007f78",
      "accent": "#00a99d"
    },
    "surface": {
      "header": "#111827"
    }
  },
  "radii": {
    "button": "4px",
    "card": "6px"
  }
}
```

Expected agent note:

```text
I changed the visual tokens only. The age gate, warnings, checkout, and tax
behavior remain platform-owned and unchanged.
```

## Example 2: Merchandising Change

User request:

```text
Show best sellers on the homepage and then a row of salt nic products.
```

Safe response:

- Edit `content/home.json`.
- Use `block-palette@3`.
- Use product source shortcuts and source objects.

Sketch:

```json
{
  "contract": "block-palette@3",
  "blocks": [
    {
      "component": "featured_products",
      "title": "Best sellers",
      "source": "bestSelling",
      "limit": 4
    },
    {
      "component": "featured_products",
      "title": "Salt nic",
      "source": { "tag": "salt-nic" },
      "limit": 8
    }
  ]
}
```

Expected agent note:

```text
I used platform-rendered product sections instead of custom product code, so the
store keeps the shared performance, SEO, and compliance behavior.
```

## Example 3: Loyalty Widget

User request:

```text
Add our loyalty signup widget beside the add-to-cart controls.
```

Safe response today:

- Explain that tenant `scripts.json` registration is validated but not rendered and therefore
  cannot satisfy this request as a supported customization.
- Use the managed-app sandboxed widget path if the tenant/app lifecycle is available, or file a
  platform capability request. Do not edit Storefront components or imply `scripts.json` works.
- Do not recommend `isolation: "inline"`; it has no renderer and would not be a sandbox.

Illustrative latent schema only — **not deployable runtime configuration**:

```json
{
  "scripts": [
    {
      "src": "widgets/loyalty.js",
      "slot": "product.aside",
      "strategy": "on-interaction",
      "isolation": "sandbox"
    }
  ]
}
```

Expected agent note:

```text
I registered the widget in the product aside slot with sandbox isolation, so it
cannot reach the parent page DOM, cookies, age gate, or checkout controls.
```

## Example 4: Blocked Compliance Request

User request:

```text
Hide the age gate for returning customers and turn off excise tax while we test.
```

Safe response:

```text
I cannot make that change. This tenant is regulated, so age/identity verification
and excise-tax collection are required and cannot be disabled by customization.

I can help you change the gate-adjacent brand experience, improve the landing
copy, or publish a private preview that keeps the compliance floor intact.
```

Do not:

- Set `ageVerification.enabled` to `false`.
- Set `exciseTax.enabled` to `false`.
- Hide age-gate DOM with CSS or JavaScript.
- Move checkout links outside platform-owned controls.

## Example 5: Raw HTML Request

User request:

```text
Paste this complete HTML landing page into the regulated vape store.
```

Safe response:

```text
I cannot publish raw HTML for a regulated tenant because it bypasses the platform
layout that carries required compliance UI. I can translate the page into
supported homepage blocks, editorial JSON, assets, and sandboxed widgets.
```

Safe implementation path:

- Convert hero content to a `hero` block.
- Convert product rows to `featured_products` blocks.
- Convert static copy to JSON editorial content.
- Put images and fonts in `public/**`.
- Convert interactive embeds to sandboxed widgets.

## Example 6: Request Beyond The Contract

User request:

```text
Build a totally custom checkout flow with a new payment method.
```

Safe response:

```text
That is outside tenant customization. Checkout, signing, tax, and verification
are platform-owned. The safe paths are a platform checkout integration project
or single-tenant extraction if this merchant needs to own the runtime.
```

Do not implement checkout behavior in raw HTML, inline JavaScript, or tenant
content.
