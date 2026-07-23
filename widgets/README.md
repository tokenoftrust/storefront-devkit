# Widgets

Sandboxed widget examples. The rule: interactivity is added by **registering a bundle in
`scripts.json`**, never by inline scripts or raw HTML. Sandboxed widgets run in an opaque-origin
iframe with no access to the page, cookies, age gate, or checkout — so they can enhance without
weakening compliance.

- [`loyalty-signup/`](./loyalty-signup/) — email capture beside product controls (`product.aside`).

Reach for a widget for configurators, quizzes, embeds, and marketing capture. Do **not** build
cart/checkout/subscription mechanics as widgets — those are platform-owned (see
[`../recipes/add-subscription-option`](../recipes/add-subscription-option/)). Regulated tenants:
`sandbox` isolation only.
