# Recipe: Enable PACT Act compliance

**Goal:** a nicotine/vape store shows the FDA nicotine warning, the PACT Act notice, adult-signature
and shipping restrictions, and a vapor excise-tax cue — all mandated wording rendered by the
platform.

**You will edit:** `.tot/config.json` (the `compliance` block) only.

## Steps

1. Open `.tot/config.json`. Add or update the `compliance` block. The fastest path is to paste
   [`../../snippets/compliance/vape-nicotine.json`](../../snippets/compliance/vape-nicotine.json)
   as the value of `compliance`:

   ```json
   {
     "siteType": "commerce",
     "compliance": {
       "minAge": 21,
       "nicotineWarning": true,
       "pactAct": true,
       "adultSignature": true,
       "shippingRestriction": "Adult signature (21+) required on delivery. Not shipped via USPS.",
       "prop65": { "harm": "reproductive", "chemicals": ["nicotine"] },
       "stateEligibility": { "restrictedStates": ["UT", "AR", "VT"] },
       "exciseTax": { "note": "Applicable state vapor excise taxes are calculated at checkout." }
     }
   }
   ```

2. **Set real facts.** Replace the example `restrictedStates`, `minAge`, and excise note with the
   client's actual obligations. Never invent them.

3. Run the loop:
   ```bash
   tot dev        # confirm the notices render (nicotine warning, PACT, footer restriction)
   tot validate   # confirms the compliance floor is intact
   ```

## What you must NOT do

- Do not write the warning text yourself anywhere (chrome, footer, editorial). The platform owns
  the wording; you only flip the flag.
- Do not set `ageVerification.enabled` or `exciseTax.enabled` to `false` in `capabilities.json`.
- Do not hide any notice with CSS/JS.

## Verify

Open a product page and the footer in `tot dev`. You should see the nicotine warning band, the
PACT Act notice, the shipping-restriction line, and the excise cue — none of which you authored.
That's the platform rendering your facts.

> Backed by Token of Trust [Age Verification](https://tokenoftrust.com/product/),
> [PACT Act Compliance](https://tokenoftrust.com/product/), and
> [Excise Tax](https://tokenoftrust.com/product/).
