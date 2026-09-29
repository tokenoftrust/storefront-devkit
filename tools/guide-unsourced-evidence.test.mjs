// A required component can be PRESENT in the style guide and still be worthless as evidence.
//
// 2026-09-20: the ecommerce quality bar reported trust-components MET for a production store
// while the guide's trust section rendered "★★★★★ 4.9 / 5 — needs-review", "🔒 Security /
// compliance badge — needs-review" and a blockquote reading "Testimonial / customer quote
// placeholder — do not ship until sourced." A human reading the rendered guide caught it; the
// substring match could not, because the pattern really was in the file.
//
// These tests pin the detector AND the two false positives it produced on the way, because both
// would have blocked approval for reasons that were not true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { componentEvidenceIsUnsourced } from "./style-concept-audit.mjs";

test("placeholder-only evidence is unsourced", () => {
  const guide = `
    <p class="sg-h">Trust & social proof <span class="opt">(placeholder — source before use)</span></p>
    <span class="trust-badge">🔒 Security / compliance badge — needs-review</span>
  `;
  assert.equal(componentEvidenceIsUnsourced(guide, ["trust-badge"]), true);
});

test("the literal do-not-ship instruction counts as unsourced", () => {
  const guide = `<blockquote class="quote">"Testimonial placeholder — do not ship until sourced."</blockquote>`;
  assert.equal(componentEvidenceIsUnsourced(guide, ["quote"]), true);
});

test("REGRESSION: an HTML placeholder attribute is not a placeholder marker", () => {
  // The bare word "placeholder" is an ordinary form attribute. Treating it as a marker called the
  // guide's own sourced accessible-form sample unsourced — the first false positive.
  const guide = `
    <p class="sg-h">Accessible form</p>
    <input class="form-control" id="sg-email" type="email" required placeholder="you@example.com" />
  `;
  assert.equal(componentEvidenceIsUnsourced(guide, ["form-control"]), false);
});

test("REGRESSION: a neighbouring section's marker does not contaminate a sourced component", () => {
  // The second false positive: scoping by a fixed window let the trust section's "needs-review"
  // bleed onto form components ~1.5KB away. Real separation, real content in between.
  const guide = `
    <p class="sg-h">Accessible form</p>
    <input class="form-control" placeholder="you@example.com" />
    ${"<p>filler describing the accessible form pattern in detail.</p>".repeat(12)}
    <p class="sg-h">Trust & social proof (placeholder — source before use)</p>
    <span class="trust-badge">badge — needs-review</span>
  `;
  assert.equal(componentEvidenceIsUnsourced(guide, ["form-control"]), false);
  assert.equal(componentEvidenceIsUnsourced(guide, ["trust-badge"]), true);
});

test("one sourced instance makes the component real, even when another is a placeholder", () => {
  // rating/stars genuinely ships in the RatingStars and ReviewSummary sections, so the placeholder
  // rating in the trust block must not condemn it.
  const guide = `
    <p class="sg-h">Commerce atoms — RatingStars</p>
    <span class="rating">★★★★★ 4.8 from 120 reviews</span>
    <p class="sg-h">Trust & social proof (placeholder — source before use)</p>
    <span class="rating">★★★★★ 4.9 / 5 — needs-review</span>
  `;
  assert.equal(componentEvidenceIsUnsourced(guide, ["rating"]), false);
});

test("a caption on the line above marks the component below it", () => {
  // The real shape for the logo strip: the marker is in the caption, the class is on the next
  // line. Inline-only scoping missed it.
  const guide = [
    '<p class="form-help">Logo strip — "as seen in" / customer & partner logos (placeholder):</p>',
    '<div class="logo-strip">',
    '<span class="logo">LOGO</span>',
  ].join("\n");
  assert.equal(componentEvidenceIsUnsourced(guide, ["logo-strip"]), true);
});

test("a prose (placeholder) marker is distinct from the HTML placeholder attribute", () => {
  const attribute = '<input class="form-control" placeholder="you@example.com" />';
  const prose = '<p>Partner logos (placeholder):</p>\n<div class="form-control">x</div>';
  assert.equal(componentEvidenceIsUnsourced(attribute, ["form-control"]), false);
  assert.equal(componentEvidenceIsUnsourced(prose, ["form-control"]), true);
});

test("an absent component is not reported as unsourced", () => {
  // Absent and present-but-placeholder are different findings with different remedies: one needs
  // building, the other needs merchant evidence. Conflating them sends the reader the wrong way.
  assert.equal(componentEvidenceIsUnsourced("<p>nothing here</p>", ["trust-badge"]), false);
});
