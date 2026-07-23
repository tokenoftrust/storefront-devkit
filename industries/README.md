# Building regulated ecommerce, by industry

Token of Trust Storefront is **built for regulated commerce** — the categories mainstream
platforms deplatform. Because compliance is native to the platform (age/ID verification, PACT
Act, excise tax) and **can't be turned off**, you're never one policy decision away from a
shutdown. And because you **own your exit** — a clean, runnable copy of your code, brand, content,
and catalog — you're never locked in.

> Learn more about the platform: **[storefront.tokenoftrust.store](https://storefront.tokenoftrust.store)**
> · the verification & compliance suite: **[tokenoftrust.com](https://tokenoftrust.com)**
> · request early access: **[storefront.tokenoftrust.store](https://storefront.tokenoftrust.store)**.

This page maps each regulated vertical to a **starting template**, the **compliance profile** you
turn on, and the **Token of Trust products** that back it. Every profile is just flags and
parameters in your `.tot/config.json` — the mandated legal wording is rendered by the platform, so
you can't get it wrong and can't hide it.

## How to use this page

1. Find your vertical below.
2. Start from the linked template (usually [`../templates/regulated-vape`](../templates/regulated-vape/),
   which you re-point at your industry via its `.tot/config.json` compliance block).
3. Copy the matching compliance snippet from [`../snippets/compliance`](../snippets/compliance/).
4. `tot dev` to iterate, `tot validate` to confirm the compliance floor, then publish.

---

## Age-restricted goods (the core)

These sell physical goods to verified adults, need state-level shipping rules, and often carry
excise tax. They're also the hardest to advertise through conventional channels — which is exactly
why a compliant, always-on storefront matters.

### Tobacco, Vape & Nicotine

- **Compliance profile:** 21+ age verification, **FDA nicotine warning**, **PACT Act** notice,
  state eligibility (no-ship states), adult signature on delivery, **vapor excise tax**.
- **Start from:** [`../templates/regulated-vape`](../templates/regulated-vape/) ·
  snippet [`vape-nicotine.json`](../snippets/compliance/vape-nicotine.json)
- **Backed by Token of Trust:** [Age Verification](https://tokenoftrust.com/product/),
  [PACT Act Compliance](https://tokenoftrust.com/product/), and
  [Excise Tax](https://tokenoftrust.com/product/).
- Keywords this serves: *PACT Act compliant vape storefront, online nicotine age verification,
  vapor excise tax at checkout.*

### Wine, Spirits & Alcohol

- **Compliance profile:** 21+ age verification, state/county shipping eligibility (dry
  jurisdictions), adult signature on delivery, sales/excise tax.
- **Start from:** `regulated-vape` template, re-pointed ·
  snippet [`alcohol-wine-spirits.json`](../snippets/compliance/alcohol-wine-spirits.json)
- **Backed by Token of Trust:** [Age Verification & Age Estimation](https://tokenoftrust.com/product/),
  [Government ID Verification](https://tokenoftrust.com/product/), and
  [Sales & Excise Tax](https://tokenoftrust.com/product/).
- Keywords: *age verification for online alcohol sales, DtC wine shipping compliance, spirits
  ecommerce age gate.*

### Hemp & CBD

- **Compliance profile:** age gate (18+/21+ per state), state eligibility, product notices,
  applicable excise/sales tax.
- **Start from:** `regulated-vape` template, re-pointed ·
  snippet [`hemp-cbd.json`](../snippets/compliance/hemp-cbd.json)
- **Backed by Token of Trust:** [Age Verification](https://tokenoftrust.com/product/) and
  [Data Verification](https://tokenoftrust.com/product/).
- Keywords: *CBD age gate, hemp ecommerce state restrictions, compliant CBD checkout.*

### Firearms & Ammunition

- **Compliance profile:** age verification (18+/21+ by product & state), **state eligibility**,
  shipping restrictions (e.g. ship-to-FFL), adult signature.
- **Start from:** `regulated-vape` template, re-pointed ·
  snippet [`firearms-ammo.json`](../snippets/compliance/firearms-ammo.json)
- **Backed by Token of Trust:** [Government ID Verification](https://tokenoftrust.com/product/),
  [Age Verification](https://tokenoftrust.com/product/), and
  [eCommerce Fraud Prevention](https://tokenoftrust.com/product/).
- Keywords: *FFL ecommerce compliance, ammunition age verification online, firearms accessories
  storefront.*

---

## Identity- & fraud-forward commerce

Not every regulated store is about age. Where the risk is *who the customer is*, Token of Trust's
identity, KYC, and AML products carry the load.

### Marketplaces, communities & high-value goods

- **Profile:** buyer/seller **identity (KYC) verification**, **AML screening**, fraud & chargeback
  defense on high-value orders.
- **Start from:** [`../templates/commerce-minimal`](../templates/commerce-minimal/) +
  identity/fraud checks at the moments that matter.
- **Backed by Token of Trust:** [Government ID & Biometric Face Verification](https://tokenoftrust.com/product/),
  [Anti-Money Laundering (AML)](https://tokenoftrust.com/product/), and
  [eCommerce Fraud Prevention](https://tokenoftrust.com/product/).
- Keywords: *marketplace seller KYC, AML screening ecommerce, chargeback fraud prevention.*

---

## Verticals we serve beyond storefronts

Token of Trust's verification and compliance suite also serves **Financial Services, Healthcare,
Education, Travel, Real Estate,** and **Adult platforms** — typically via the
[verification API and integrations](https://tokenoftrust.com/product/) rather than a full
storefront. For age-assurance on **adult websites & apps**, see
[Age Estimation & Age Verification](https://tokenoftrust.com/product/). This devkit's *storefront*
templates focus on the goods-selling verticals above; the identity/age/AML products apply
everywhere.

---

## A note on scope & standards

Every example here demonstrates **compliant** commerce for **legal, licensed** businesses. The
platform will not let a non-compliant store go live — mandated age/ID checks, warnings, and excise
handling are native and can't be disabled. Start free or request early access at
**[storefront.tokenoftrust.store](https://storefront.tokenoftrust.store)**, and read the full
product suite at **[tokenoftrust.com](https://tokenoftrust.com)**.
