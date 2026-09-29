import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GIVEAWAY_CEILING,
  PARITY_TOLERANCE,
  describeParity,
  judgeDimension,
  judgeParity,
  judgeSiteParity,
} from "./lighthouse-parity.mjs";

// Real numbers, captured 2026-09-20 from a live regulated tenant and its still-reachable source.
// Invented fixtures would not have caught that the absolute floor and the parity rule disagree on
// five of these eight verdicts — which is the entire reason this module exists.
const SOURCE = {
  "/": { performance: 41, accessibility: 85, "best-practices": 73, seo: 85 },
  "/about": { performance: 68, accessibility: 93, "best-practices": 73, seo: 100 },
  "/privacy": { performance: 92, accessibility: 98, "best-practices": 73, seo: 85 },
  "/shipping-returns": { performance: 91, accessibility: 98, "best-practices": 73, seo: 92 },
  "/terms": { performance: 91, accessibility: 98, "best-practices": 73, seo: 85 },
};
const MIGRATED = {
  "/": { performance: 67, accessibility: 94, "best-practices": 100, seo: 100 },
  "/about": { performance: 100, accessibility: 94, "best-practices": 100, seo: 100 },
  "/privacy": { performance: 100, accessibility: 95, "best-practices": 100, seo: 88 },
  "/shipping-returns": { performance: 75, accessibility: 94, "best-practices": 100, seo: 100 },
  "/terms": { performance: 76, accessibility: 95, "best-practices": 100, seo: 100 },
};
const judge = (slug) => judgeParity({ scores: MIGRATED[slug], baseline: SOURCE[slug] });

test("a page that beats its source passes, however far below an absolute floor it sits", () => {
  // The homepage the 90-floor called the worst failure on the site: perf 67. Its source is 41.
  const r = judge("/");
  assert.equal(r.pass, true);
  assert.deepEqual(r.regressions, []);
  assert.equal(r.dimensions.performance.delta, 26);
  assert.equal(r.dimensions.performance.verdict, "giveaway");
});

test("taking something the merchant had is the only thing that fails", () => {
  // These two are the real defects: a fast source made slower.
  for (const slug of ["/shipping-returns", "/terms"]) {
    const r = judge(slug);
    assert.equal(r.pass, false, `${slug} must fail`);
    assert.ok(r.regressions.includes("performance"), `${slug} performance is the regression`);
  }
  assert.equal(judge("/shipping-returns").dimensions.performance.delta, -16);
  assert.equal(judge("/terms").dimensions.performance.delta, -15);
});

test("the tolerance absorbs run-to-run noise but not a real slip", () => {
  // Measured: a11y -3 on two policy pages and -4 on a third, same template. With tolerance 3 the
  // -3s are noise and the -4 is a miss — a knife edge worth knowing about rather than hiding.
  assert.equal(judgeDimension(98, 95).verdict, "parity", "-3 is within tolerance");
  assert.equal(judgeDimension(98, 94).verdict, "regression", "-4 is not");
  assert.equal(PARITY_TOLERANCE, 3);
});

test("value handed over free is catalogued, never failed", () => {
  // best-practices is +27 on every page because the platform simply builds better than the
  // source's 73. That is real delivered value and must never read as a defect...
  for (const slug of Object.keys(SOURCE)) {
    const r = judge(slug);
    assert.equal(r.dimensions["best-practices"].delta, 27);
    assert.equal(r.dimensions["best-practices"].verdict, "giveaway");
  }
  // ...but it must also not be invisible, or it gets absorbed into the base price.
  assert.ok(judge("/about").giveaways.includes("performance"), "+32 on /about is add-on headroom");
  assert.equal(judge("/about").pass, true, "a giveaway NEVER fails the gate");
});

test("the band is what the decision asked for: at least parity, ideally not far over", () => {
  assert.equal(GIVEAWAY_CEILING, 5);
  assert.equal(judgeDimension(90, 90).verdict, "parity", "exact parity is the target");
  assert.equal(judgeDimension(90, 92).verdict, "parity", "a couple of points over is ideal");
  assert.equal(judgeDimension(90, 95).verdict, "parity", "at the ceiling, still parity");
  assert.equal(judgeDimension(90, 96).verdict, "giveaway", "past it, catalogue the headroom");
  assert.equal(judgeDimension(90, 87).verdict, "parity", "at the tolerance edge, still parity");
  assert.equal(judgeDimension(90, 86).verdict, "regression");
});

test("a missing baseline FAILS, because the window to capture it closes at cutover", () => {
  // Passing here would hide that the only chance to record what the merchant had has gone.
  const r = judgeParity({ scores: MIGRATED["/"], baseline: null });
  assert.equal(r.pass, false);
  assert.equal(r.reason, "baseline-missing");
  assert.match(describeParity(r), /BEFORE cutover/);
  assert.equal(judgeParity({ scores: MIGRATED["/"], baseline: {} }).reason, "baseline-missing");
});

test("a dimension the source never scored is unmeasured, not a free pass", () => {
  const r = judgeParity({ scores: { performance: 50, seo: 90 }, baseline: { performance: 40 } });
  assert.equal(r.dimensions.seo.verdict, "unmeasured");
  assert.deepEqual(r.unmeasured, ["seo"]);
  assert.equal(r.pass, true, "an absent source score cannot be a tenant defect");
});

test("the description names the direction of every miss", () => {
  const regressed = describeParity(judge("/shipping-returns"));
  assert.match(regressed, /below source/);
  assert.match(regressed, /performance 91->75 \(-16\)/);
  // A giveaway must be labelled as value, never as something to fix.
  assert.match(regressed, /delivered free/);
  assert.doesNotMatch(describeParity(judge("/about")), /below source/);
  assert.match(describeParity(judgeParity({ scores: { seo: 90 }, baseline: { seo: 90 } })), /At parity/);
});

test("a baseline captured at another form factor is NOT COMPARABLE, never a regression", () => {
  // Measured 2026-09-21: a mobile-captured baseline judged desktop runs as -4 to -7 regressions
  // on four pages whose mobile scores were 99-100. Every one was an artifact of the comparison.
  const judged = judgeParity({
    scores: { performance: 85, seo: 100 },
    baseline: { performance: 90, seo: 100 },
    notComparable: "baseline-captured-mobile",
  });
  assert.equal(judged.pass, true, "an impossible comparison is not the tenant's defect");
  assert.deepEqual(judged.regressions, []);
  assert.equal(judged.reason, "not-comparable:baseline-captured-mobile");
  assert.equal(judged.dimensions.performance.verdict, "unmeasured");
});

test("NOT COMPARABLE is distinct from a MISSING baseline, which still fails", () => {
  // Conflating them would send someone to re-capture a baseline that already exists — and after
  // cutover a re-capture overwrites the only source reading that will ever exist.
  const missing = judgeParity({ scores: { performance: 85 }, baseline: null });
  assert.equal(missing.pass, false);
  assert.equal(missing.reason, "baseline-missing");
});

test("a matching form factor still judges normally", () => {
  // Negative control: the guard must not swallow real regressions.
  const judged = judgeParity({
    scores: { performance: 70 }, baseline: { performance: 90 },
  });
  assert.equal(judged.pass, false);
  assert.deepEqual(judged.regressions, ["performance"]);
});

const sitePage = (slug, profiles) => ({ slug, profiles });
const dims = (pairs) => ({
  dimensions: Object.fromEntries(Object.entries(pairs).map(([k, [s, m]]) => [k, { source: s, migrated: m }])),
});

test("individual pages may sit up to 3 below while the AGGREGATE stays at least as good", () => {
  // The band belongs to individual pages, where Lighthouse jitter actually lives. Two pages 2-3
  // points down are absorbed by a page that is ahead, and the average still clears source.
  const judged = judgeSiteParity([
    sitePage("/", { mobile: dims({ performance: [90, 96] }) }),
    sitePage("/a", { mobile: dims({ performance: [90, 88] }) }),
    sitePage("/b", { mobile: dims({ performance: [90, 87] }) }),
  ]);
  assert.equal(judged.profiles.mobile.aggregate.performance.delta, 0, "average is level");
  assert.deepEqual(judged.profiles.mobile.pageShortfalls, []);
  assert.equal(judged.pass, true);
});

test("an AGGREGATE below source fails — no tolerance there", () => {
  // Taken as a whole the site may not be worse than what the merchant already had. An average
  // that has drifted below source is not noise.
  const judged = judgeSiteParity([
    sitePage("/", { mobile: dims({ performance: [90, 90] }) }),
    sitePage("/a", { mobile: dims({ performance: [90, 88] }) }),
  ]);
  assert.equal(judged.profiles.mobile.aggregate.performance.delta, -1);
  assert.equal(judged.pass, false, "a 1-point average shortfall still fails");
  assert.deepEqual(judged.profiles.mobile.shortfalls, ["performance"]);
});

test("a single page further than 3 below fails even when the average is fine", () => {
  // The average can hide one badly-regressed page behind several healthy ones — and that is
  // exactly the page a merchant finds first.
  const judged = judgeSiteParity([
    sitePage("/", { mobile: dims({ performance: [90, 99] }) }),
    sitePage("/a", { mobile: dims({ performance: [90, 99] }) }),
    sitePage("/b", { mobile: dims({ performance: [90, 80] }) }),
  ]);
  assert.ok(judged.profiles.mobile.aggregate.performance.delta > 0, "average is ahead");
  assert.equal(judged.pass, false);
  assert.deepEqual(judged.profiles.mobile.pageShortfalls.map((p) => p.slug), ["/b"]);
});

test("the HOME PAGE must be at least as good on every dimension", () => {
  // Most visitors see it and the merchant will check it first, so "level on average" is not an
  // acceptable answer for the home page specifically.
  const judged = judgeSiteParity([
    sitePage("/", { mobile: dims({ performance: [90, 88], seo: [90, 95] }) }),
    sitePage("/a", { mobile: dims({ performance: [90, 99] }) }),
  ]);
  assert.equal(judged.pass, false, "home page below source fails even with a healthy aggregate");
  assert.deepEqual(judged.profiles.mobile.home.map((h) => h.dimension), ["performance"]);
});

test("a home page level or better passes", () => {
  // Negative control: the strict rule is "at least as good", not "strictly better".
  const judged = judgeSiteParity([
    sitePage("/", { mobile: dims({ performance: [90, 90], seo: [90, 91] }) }),
  ]);
  assert.equal(judged.pass, true);
  assert.deepEqual(judged.profiles.mobile.home, []);
});

test("phone and desktop are judged separately, never averaged together", () => {
  const judged = judgeSiteParity([
    sitePage("/", {
      mobile: dims({ performance: [90, 92] }),
      desktop: dims({ performance: [50, 85] }),
    }),
  ]);
  assert.equal(judged.profiles.mobile.aggregate.performance.delta, 2);
  assert.equal(judged.profiles.desktop.aggregate.performance.delta, 35);
});
