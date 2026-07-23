# Product sources

Every way to populate a product section (`featured_products` / `featured_collections`). Set the
block's `source` to one of these. **Prefer sources over hand-listing product handles** — sources
stay fresh as the catalog changes, and inherit the platform's performance/SEO/compliance behavior.

`all-forms.json` documents every form:

- Shortcuts: `"featured"`, `"newest"`, `"bestSelling"`, `"onSale"`.
- By collection: `{ "collection": "devices" }`
- By tag: `{ "tag": "salt-nic" }`
- Explicit handles (only when the client names exact products): `{ "handles": ["starter-kit", "replacement-pods"] }`
- Related to a product: `{ "related": "starter-kit" }`
- Recently viewed: `{ "recentlyViewed": true }`
