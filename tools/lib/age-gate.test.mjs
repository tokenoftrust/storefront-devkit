import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGE_GATE_AFFIRMATION_PREFIX,
  affirmationKeysFromLookups,
  describeAffirmation,
  gatedLighthouseUnmeasured,
  judgeAgeGate,
} from "./age-gate.mjs";
import { judgeParity } from "./lighthouse-parity.mjs";

const KEY = "tot:age-affirmed:fixture.example:21";

test("the key the gate read is the key the harness seeds", () => {
  assert.deepEqual(affirmationKeysFromLookups([KEY]), [KEY]);
  assert.ok(KEY.startsWith(AGE_GATE_AFFIRMATION_PREFIX));
});

test("a key read twice is seeded once, in lookup order", () => {
  const other = "tot:age-affirmed:other.example:18";
  assert.deepEqual(affirmationKeysFromLookups([KEY, other, KEY]), [KEY, other]);
});

test("a URI-encoded tenant segment is still a gate key", () => {
  // The gate encodes the tenant id, so a colon in it arrives as %3A and the key keeps its shape.
  const encoded = "tot:age-affirmed:acme%3Aeu:21";
  assert.deepEqual(affirmationKeysFromLookups([encoded]), [encoded]);
});

test("lookups that are not the gate's key shape are never seeded", () => {
  assert.deepEqual(affirmationKeysFromLookups([
    "tot:age-affirmed:",
    "tot:age-affirmed:fixture.example",
    "tot:age-affirmed:fixture.example:twenty-one",
    "tot:age-affirmed:a:b:21",
    "tot:cart:fixture.example:21",
    " tot:age-affirmed:fixture.example:21",
    42,
    null,
  ]), []);
});

test("a page reading a flood of gate-shaped keys is not the platform gate, so nothing is seeded", () => {
  const flood = Array.from({ length: 5 }, (_, i) => `tot:age-affirmed:t${i}.example:21`);
  assert.deepEqual(affirmationKeysFromLookups(flood), []);
  assert.equal(affirmationKeysFromLookups(flood.slice(0, 4)).length, 4);
});

test("anything but an array of lookups yields no keys", () => {
  assert.deepEqual(affirmationKeysFromLookups(undefined), []);
  assert.deepEqual(affirmationKeysFromLookups(KEY), []);
});

test("a page with no gate says every pass measured the page as served", () => {
  const described = describeAffirmation({ present: false, keys: [] });
  assert.equal(described.measuredState, "no-age-gate");
  assert.equal(described.affirmed, false);
  assert.match(described.note, /No platform age gate/);
});

test("an affirmed run says, in words, which passes measured which state", () => {
  const described = describeAffirmation({ present: true, keys: [KEY], verified: true });
  assert.equal(described.measuredState, "affirmed");
  assert.equal(described.affirmed, true);
  assert.match(described.note, /ran with the gate already affirmed/);
  assert.match(described.note, /CSP pass and the separate `ageGate` record ran with the gate open/);
});

test("a gate the harness never saw read its key leaves every pass on the GATED page", () => {
  const described = describeAffirmation({ present: true, keys: [], verified: null });
  assert.equal(described.measuredState, "gated");
  assert.equal(described.affirmed, false);
  assert.match(described.note, /did not see it read an affirmation key/);
});

test("a seed the first affirmed load proves did not take is reported as gated, not affirmed", () => {
  const described = describeAffirmation({ present: true, keys: [KEY], verified: false });
  assert.equal(described.measuredState, "gated");
  assert.equal(described.affirmed, false);
  assert.match(described.note, /still blocking the page after the affirmation was seeded/);
});

/** The gated state of the real gate component, as measured on the fixture. */
const healthy = () => ({
  present: true,
  blocking: true,
  dialog: { count: 1, name: "Are you 21 or older?", modal: true },
  focus: { presses: 7, contained: 7, escapedTo: [] },
  background: { focusable: 0, mainPresent: true, mainExposed: true },
  axe: { critical: 0, serious: 0, moderate: 0, minor: 0 },
});

test("a gate that asks, holds focus and keeps the page behind it inert passes", () => {
  const verdict = judgeAgeGate(healthy());
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.failedChecks, []);
  assert.deepEqual(verdict.findings, []);
});

test("an inert page that no longer exposes <main> fails the landmark check, owned by the platform", () => {
  const observation = healthy();
  observation.background.mainExposed = false;
  const verdict = judgeAgeGate(observation);
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.failedChecks, ["mainLandmark"]);
  assert.equal(verdict.findings[0].id, "age-gate-mainLandmark");
  assert.equal(verdict.findings[0].owner, "platform");
  assert.match(verdict.findings[0].title, /landmark-one-main/);
});

test("a page with no <main> at all is the ux gate's finding, not the age gate's", () => {
  const observation = healthy();
  observation.background = { focusable: 0, mainPresent: false, mainExposed: false };
  assert.equal(judgeAgeGate(observation).checks.mainLandmark, true);
});

test("one press that lets focus out of the gate fails containment", () => {
  const observation = healthy();
  observation.focus = { presses: 7, contained: 6, escapedTo: ["a: Shop the collection"] };
  const verdict = judgeAgeGate(observation);
  assert.deepEqual(verdict.failedChecks, ["focusContained"]);
});

test("a keyboard check that never pressed anything proves nothing and fails", () => {
  const observation = healthy();
  observation.focus = { presses: 0, contained: 0, escapedTo: [] };
  assert.equal(judgeAgeGate(observation).checks.focusContained, false);
});

test("a focusable control behind the open gate fails background isolation", () => {
  const observation = healthy();
  observation.background.focusable = 1;
  assert.deepEqual(judgeAgeGate(observation).failedChecks, ["backgroundInert"]);
});

test("the dialog must be one, named and modal", () => {
  for (const dialog of [
    { count: 0, name: "", modal: false },
    { count: 2, name: "Are you 21 or older?", modal: true },
    { count: 1, name: "  ", modal: true },
    { count: 1, name: "Are you 21 or older?", modal: false },
  ]) {
    const observation = { ...healthy(), dialog };
    assert.deepEqual(judgeAgeGate(observation).failedChecks, ["dialog"], JSON.stringify(dialog));
  }
});

test("a gate present but not blocking on a fresh visit fails: the visitor was never asked", () => {
  const observation = { ...healthy(), blocking: false };
  assert.deepEqual(judgeAgeGate(observation).failedChecks, ["blocking"]);
});

test("serious axe violations on the gated page fail; moderate ones do not", () => {
  assert.deepEqual(
    judgeAgeGate({ ...healthy(), axe: { critical: 0, serious: 1, moderate: 0, minor: 0 } }).failedChecks,
    ["axe"],
  );
  assert.equal(judgeAgeGate({ ...healthy(), axe: { critical: 0, serious: 0, moderate: 3, minor: 0 } }).pass, true);
});

/** A Lighthouse record shaped like runLighthouse's, judged against a real source baseline. */
const lighthouseRun = (accessibility, ageGateState) => {
  const scores = { performance: 98, accessibility, "best-practices": 100, seo: 100 };
  const parity = judgeParity({
    scores,
    baseline: { performance: 98, accessibility: 97, "best-practices": 100, seo: 100 },
  });
  return {
    profile: "desktop",
    ageGateState,
    pass: parity.pass,
    scores,
    parity,
    findings: parity.regressions.map((key) => ({ id: `lighthouse-parity-regression-${key}`, kind: "lighthouse-parity-regression" })),
  };
};
const combined = (profiles) => ({ ...Object.values(profiles)[0], profiles });

test("a gated Lighthouse run never reports the gate as an accessibility regression", () => {
  // The defect this exists for: 93 gated against a source of 97 reads as a regression the
  // migration never caused.
  const gated = lighthouseRun(93, "open");
  assert.deepEqual(gated.parity.regressions, ["accessibility"], "fixture must start as a regression");
  const perf = gatedLighthouseUnmeasured(
    combined({ desktop: gated }),
    { present: true, affirmed: true },
  );
  assert.equal(perf.unmeasured, "age-gate-open");
  assert.equal(perf.pass, false, "unmeasured is not a pass");
  assert.deepEqual(perf.parity.regressions, []);
  assert.equal(perf.parity.dimensions.accessibility.verdict, "unmeasured");
  assert.deepEqual(
    [...perf.parity.unmeasured].sort(),
    ["accessibility", "best-practices", "performance", "seo"],
    "an open gate taints every category, not only the layout-shift ones",
  );
  assert.deepEqual(perf.unmeasuredProfiles, ["desktop:age-gate-open"]);
  assert.equal(perf.profiles.desktop.unmeasured, "age-gate-open");
  assert.ok(perf.findings.some((f) => f.id === "lighthouse-age-gate-open" && f.owner === "platform"));
  assert.ok(!perf.findings.some((f) => f.kind === "lighthouse-parity-regression"));
});

test("a run that could not be affirmed voids every profile even if a browser seeded", () => {
  const perf = gatedLighthouseUnmeasured(
    combined({ mobile: lighthouseRun(93, "affirmed"), desktop: lighthouseRun(93, "affirmed") }),
    { present: true, affirmed: false },
  );
  assert.deepEqual(perf.unmeasuredProfiles, ["mobile:age-gate-open", "desktop:age-gate-open"]);
});

test("only the profile whose browser stayed gated loses its verdict", () => {
  const perf = gatedLighthouseUnmeasured(
    combined({ mobile: lighthouseRun(97, "affirmed"), desktop: lighthouseRun(93, "open") }),
    { present: true, affirmed: true },
  );
  assert.equal(perf.profiles.mobile.unmeasured, undefined);
  assert.equal(perf.profiles.desktop.unmeasured, "age-gate-open");
  assert.deepEqual(perf.unmeasuredProfiles, ["desktop:age-gate-open"]);
});

test("an affirmed run, a page with no gate and a skipped run pass through untouched", () => {
  const affirmed = combined({ desktop: lighthouseRun(97, "affirmed") });
  assert.equal(gatedLighthouseUnmeasured(affirmed, { present: true, affirmed: true }), affirmed);
  const plain = combined({ desktop: lighthouseRun(97, "absent") });
  assert.equal(gatedLighthouseUnmeasured(plain, { present: false, affirmed: false }), plain);
  const skipped = { skipped: true, pass: true };
  assert.equal(gatedLighthouseUnmeasured(skipped, { present: true, affirmed: false }), skipped);
});
