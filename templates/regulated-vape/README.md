# Template: Regulated vape store

A compliant, age-restricted commerce store. The point of this template is the
**`.tot/config.json` compliance block** — it shows how a few flags and parameters light up the
platform's compliance widgets (age gate, FDA nicotine warning, PACT Act, Prop 65, state
eligibility, excise-tax display).

## The compliance model (read this first)

- **You flip flags and pass small parameters. The platform owns the legal wording.** You cannot
  write, edit, hide, or paraphrase a mandated warning — you only turn it on and pass facts like
  `minAge`, chemical names, or state lists.
- **Each widget renders nothing when its config field is absent.** Presence is the switch.
- **Enforcement stays platform-owned.** `stateEligibility`, `purchaseLimit`, and `exciseTax`
  entries here are *display* cues; the platform makes the actual ship/no-ship and tax decisions.
- **You cannot disable the floor.** Removing the age gate or excise for a regulated tenant is
  rejected at validate/publish — by design.

## What's inside

```text
.tot/config.json        siteType: commerce + a full compliance block (edit facts to match the client)
theme.json              brand tokens (dark, high-contrast)
content/chrome.json     nav + footer (no fabricated legal text — the platform adds required notices)
content/home.json       hero → best sellers → new arrivals → newsletter
capabilities.json       cart + age verification + excise all ON (do not turn these off)
scripts.json            no widgets yet (use sandbox isolation only for this tenant)
public/                 brand assets
```

## Adapt it to your client

1. In `.tot/config.json`, set the **real** facts: `minAge`, which notices apply
   (`nicotineWarning`, `pactAct`, `prop65`, `adultSignature`), the real `stateEligibility` lists,
   and the `exciseTax` note/jurisdictions. **Do not invent these** — take them from the client's
   actual obligations.
2. Rebrand `theme.json` and add assets to `public/`.
3. Merchandise `content/home.json` with real collections/tags.
4. `tot validate` — it checks the compliance floor is intact.

## Do not

- Do not set `ageVerification.enabled` or `exciseTax.enabled` to `false`.
- Do not add raw HTML, inline scripts, or `inline`-isolation widgets to this tenant.
- Do not write warning copy into chrome/footer/editorial — the platform renders the mandated text.
