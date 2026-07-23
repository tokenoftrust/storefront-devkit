# Widget: Loyalty signup (sandboxed)

A small email-capture widget mounted beside the product purchase controls. It's the canonical
example of doing interactivity **the platform-safe way**.

## The sandbox contract (why this is safe)

- Registered in `scripts.json`, never inline.
- `isolation: "sandbox"` → the bundle runs in an **opaque-origin iframe**. It **cannot** reach the
  parent page DOM, cookies, the age gate, or the checkout controls. That's the point — a widget
  can enhance without being able to weaken compliance or hijack the page.
- The bundle is served by the platform and CSP-pinned to its published version.
- **Regulated tenants must use `sandbox`.** `inline` is a warned same-origin tier for unregulated
  enhancement only.

## Files

```text
scripts.json     the registration to merge into your tenant's scripts.json
loyalty.js       the sandboxed bundle (self-contained; talks only to its own backend)
```

## Install

1. Copy `loyalty.js` to your tenant's widget path (e.g. `public/widgets/loyalty.js`).
2. Merge the entry from this folder's `scripts.json` into your tenant `scripts.json`.
3. Point the widget's `data-endpoint` (or the constant in `loyalty.js`) at your own list backend.
4. `tot dev`, open a product page, confirm the widget appears in the product aside.
5. `tot validate`.

## Slots & strategies (reference)

- Slots: `product.aside` (beside purchase controls), `home.section` (between homepage sections),
  `global.footer` (near footer on every route).
- Strategies: `defer`, `on-idle`, `on-interaction`. Prefer `on-interaction` or `on-idle` for
  non-critical widgets so they never delay the first paint.
