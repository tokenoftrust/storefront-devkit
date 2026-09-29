---
id: storefront-devbook-widgets-extension
genre: devbook
scope: [storefront]
audience: [developer]
visibility: authenticated
source: storefront
title: Widgets & extension — sandboxed interactivity, then the escalation ladder
---
# Widgets & extension — sandboxed interactivity, then the escalation ladder
Task: add interactivity the platform-safe way with sandboxed widgets (scripts.json), and know when/how to escalate. > storefront-devkit widgets/loyalty-signup/ + private-apps/.
## Tenant widgets (scripts.json) — register a bundle, never inline scripts/raw HTML. Sandboxed by default: opaque-origin iframe, NO access to page DOM/cookies/age gate/checkout. Example scripts[] {src,slot,strategy,isolation}. Slots: product.aside, home.section, global.footer. Strategies: defer, on-idle, on-interaction (prefer on-idle/on-interaction). Isolation: sandbox (default) vs inline (warned same-origin; regulated MUST use sandbox). Good uses: loyalty/email capture, configurators, quizzes, locators, embeds. Keep bundle self-contained.
### What a widget must never do — cart/checkout/subscription mechanics are NOT widget territory (use managed checkout + purchase_options). Can't read parent cookies/DOM, hide compliance UI, or mutate checkout — sandbox enforces.
### Structured content widgets are first-class — you often don't need a script bundle (F4). The framework now ships DATA-driven content widgets for the common patterns tenants used to reach for a widget or raw HTML to build: trust strip, tier cards + comparison table, callouts, prose sections with a table of contents, needs-review callout, and rich text. A tenant authors these as structured `sections` JSON (see the Pages & merchandising devbook) — no sandboxed bundle, no HTML/CSS fragment. Accessibility lives IN the framework component (semantic headings, ARIA roles, tap-target sizing), and a trust strip renders real-or-absent (fabricated review/trust proof is dropped — see the reviews contract). So the ladder's rung 1 now has a lower step BELOW it: for standard content/merchandising interactivity, use a framework structured content widget (pure data); reserve a sandboxed `scripts.json` bundle for genuinely custom front-end interactivity the block/widget palette doesn't cover.
## The escalation ladder: 1. Sandboxed widget (front-end interactivity). 2. Private app (backend integration: your own service, OAuth2/JWT, scoped /api/apps/v1 reads, signed CloudEvents webhooks, platform-managed widget launches; recipe://storefront-private-apps-devbook; apps CANNOT reach the compliance floor). 3. Single-tenant extraction (own your exit — a product conversation with ToT).
### Two kinds of widget — tenant scripts.json widget (you register) vs private-app widget launch (platform-managed placement via installed app; currently a contract seam).
## Common pitfalls: inline scripts/onclick/javascript: URLs (blocked regulated); inline isolation on regulated (not allowed); building backend behavior as a widget (→ private app); XSS in your bundle (use textContent not innerHTML); eager widgets that block paint.
## Verify: `tot dev` widget renders in slot + can't touch rest of page; age gate + checkout untouched; tot validate; private app → recipe://storefront-private-apps-devbook.
