// The css and readability gates weigh CSS authored into ported pages. A tenant whose pages are
// structured JSON has none, so scoring it reports the tenant's SHAPE as a quality failure.
//
// Measured 2026-09-21 on a production store: both gates reported FAIL with `pagesInspected: 0`
// and 0 inline-style markers across the content JSON — nothing was wrong with the site, the gates
// had nothing to weigh. The audit's own comment already named the ambiguity ("a consumer can tell
// 'measured and clean' from 'found nothing to measure'") but the verdict still said FAIL.
//
// The safety property is the important half: not-applicable must require POSITIVE evidence of the
// JSON shape, because "no HTML pages" is ALSO what a raw-HTML tenant looks like when its pages have
// gone missing — which these gates should still catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { authoredCssGatesNotApplicable } from "./style-concept-audit.mjs";

test("a JSON-content tenant is not applicable", () => {
  assert.equal(
    authoredCssGatesNotApplicable({ tenantDirResolved: true, htmlPageCount: 0, jsonPageCount: 8 }),
    true,
  );
});

test("SAFETY: a raw-HTML tenant whose pages vanished is NOT excused", () => {
  // No HTML and no JSON: the tree exists but holds neither shape. That is a regression, not a
  // different tenant shape, and excusing it would silently retire the gate for the case it exists
  // to catch.
  assert.equal(
    authoredCssGatesNotApplicable({ tenantDirResolved: true, htmlPageCount: 0, jsonPageCount: 0 }),
    false,
  );
});

test("a raw-HTML tenant is always in scope", () => {
  assert.equal(
    authoredCssGatesNotApplicable({ tenantDirResolved: true, htmlPageCount: 7, jsonPageCount: 0 }),
    false,
  );
});

test("a tenant carrying BOTH shapes stays in scope", () => {
  // Mixed content means there IS authored HTML to weigh; the JSON alongside it does not excuse it.
  assert.equal(
    authoredCssGatesNotApplicable({ tenantDirResolved: true, htmlPageCount: 3, jsonPageCount: 5 }),
    false,
  );
});

test("no content tree at all is never not-applicable", () => {
  // That is the unprepared-checkout case. It must not read as "this gate does not apply" — the
  // Step 8 preflight refuses it upstream, and if it ever gets here it should fail, not pass.
  assert.equal(
    authoredCssGatesNotApplicable({ tenantDirResolved: false, htmlPageCount: 0, jsonPageCount: 0 }),
    false,
  );
  assert.equal(
    authoredCssGatesNotApplicable({ tenantDirResolved: false, htmlPageCount: 0, jsonPageCount: 9 }),
    false,
  );
});
