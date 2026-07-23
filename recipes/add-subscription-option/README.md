# Recipe: Add a subscription (Autopilot) option

**Goal:** let customers subscribe-and-save on a product — without building any checkout or billing
mechanics yourself.

**The rule:** cart, checkout, and subscription processing are **platform-owned**. You express the
*offer* as data (`purchase_options`) on the product; the platform's managed checkout renders the
selector and handles billing, skips, and cancellation.

## Steps

1. On the product's catalog data, add a `purchase_options` array (see `purchase-options.json`):

   ```json
   {
     "purchase_options": [
       { "id": "one_time", "kind": "one_time", "label": "One-time purchase" },
       {
         "id": "monthly", "kind": "subscription", "label": "Subscribe monthly",
         "description": "Ships every month. Skip or cancel anytime.",
         "savingsLabel": "Save 15%",
         "priceAdjustment": { "type": "percent_off", "value": 15 },
         "frequency": "1m"
       }
     ]
   }
   ```

2. Use compact checkout intervals for `frequency`: `60d`, `2w`, `1m`, `1y`, `.5m`.

3. (Optional) Explain the program on a page with the education-only subscription blocks
   (a "how it works" explainer and a savings headline). Keep any figure illustrative unless it's a
   real, live offer — the platform surfaces an "example" affordance otherwise.

4. `tot dev` → open the product → confirm the purchase-option selector appears. `tot validate`.

## What you must NOT do

- Do not build a custom subscribe button, cart, or billing flow in a widget or raw HTML.
- Do not surface a provider-branded checkout widget in client-facing UI — use brand/merchant
  language like "Subscribe" or "Autopilot".

> This keeps subscriptions inside the platform's signed, managed checkout — the same integrity
> guarantees as one-time purchases.
