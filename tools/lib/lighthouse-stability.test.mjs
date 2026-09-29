import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIGHTHOUSE_STABILITY_RUNS,
  UNSTABLE_SPREAD_POINTS,
  medianIndex,
  pickRepresentativeRun,
  summarizeStability,
  shouldRerun,
  foldStabilityRuns,
  isChromeExcludedShiftRun,
  usableRuns,
  unmeasuredReason,
  withoutScoreVerdict,
  firstPartyNotFoundUrls,
  UNMEASURED_REASONS,
} from './lighthouse-stability.mjs';

const run = (performance, extra = {}) => ({
  profile: 'mobile',
  pass: performance >= 90,
  scores: {
    performance,
    accessibility: 100,
    'best-practices': 100,
    seo: 100,
    ...(extra.scores ?? {}),
  },
  findings: extra.findings ?? [],
  ...extra,
});

test('medianIndex takes the lower middle so an even-count tie never flatters the tenant', () => {
  assert.equal(medianIndex(1), 0);
  assert.equal(medianIndex(2), 0);
  assert.equal(medianIndex(3), 1);
  assert.equal(medianIndex(4), 1);
  assert.equal(medianIndex(5), 2);
});

test('medianIndex is defined for degenerate counts', () => {
  assert.equal(medianIndex(0), 0);
  assert.equal(medianIndex(-3), 0);
  assert.equal(medianIndex(1.5), 0);
});

test('pickRepresentativeRun returns the median run, not the best and not the worst', () => {
  // The measured bimodal shape: two artifact-hit runs and one clean one.
  assert.equal(pickRepresentativeRun([run(75), run(100), run(74)]).scores.performance, 75);
});

test('pickRepresentativeRun returns a REAL run so scores, findings and artifact agree', () => {
  const a = run(75, { findings: [{ id: 'a' }], artifact: '/tmp/a.json' });
  const b = run(100, { findings: [{ id: 'b' }], artifact: '/tmp/b.json' });
  const c = run(74, { findings: [{ id: 'c' }], artifact: '/tmp/c.json' });
  const picked = pickRepresentativeRun([a, b, c]);
  assert.equal(picked, a);
  assert.equal(picked.artifact, '/tmp/a.json');
  assert.deepEqual(picked.findings, [{ id: 'a' }]);
});

test('pickRepresentativeRun is deterministic under ties', () => {
  // All three score the same, so the median is still the middle ELEMENT — the point
  // is only that repeated calls agree, never that the first run wins.
  const runs = [
    run(75, { artifact: '/a.json' }),
    run(75, { artifact: '/b.json' }),
    run(75, { artifact: '/c.json' }),
  ];
  const picked = pickRepresentativeRun(runs);
  assert.equal(picked.artifact, '/b.json');
  assert.equal(pickRepresentativeRun(runs), picked);
});

test('pickRepresentativeRun breaks an equal-score sort by original order, not by chance', () => {
  // Two runs tie at the median score; the earlier of the two must win, so the
  // choice cannot drift between invocations on an unstable sort.
  const tiedEarly = run(80, { artifact: '/early.json' });
  const tiedLate = run(80, { artifact: '/late.json' });
  const picked = pickRepresentativeRun([run(60), tiedEarly, tiedLate, run(100)]);
  assert.equal(picked.artifact, '/early.json');
});

test('pickRepresentativeRun handles one run and no runs', () => {
  const only = run(42);
  assert.equal(pickRepresentativeRun([only]), only);
  assert.equal(pickRepresentativeRun([]), null);
  assert.equal(pickRepresentativeRun(null), null);
  assert.equal(pickRepresentativeRun([null, undefined]), null);
});

test('summarizeStability reports the per-category spread and flags the measured artifact', () => {
  const s = summarizeStability([run(75), run(100), run(74)]);
  assert.equal(s.runs, 3);
  assert.deepEqual(s.spread.performance, { min: 74, max: 100 });
  assert.equal(s.widestSpread, 26);
  assert.equal(s.unstable, true);
});

test('summarizeStability does not flag a genuinely steady page', () => {
  const s = summarizeStability([run(97), run(99), run(98)]);
  assert.equal(s.widestSpread, 2);
  assert.equal(s.unstable, false);
});

test('summarizeStability treats the instability threshold as inclusive', () => {
  assert.equal(summarizeStability([run(80), run(80 + UNSTABLE_SPREAD_POINTS)]).unstable, true);
  assert.equal(summarizeStability([run(80), run(80 + UNSTABLE_SPREAD_POINTS - 1)]).unstable, false);
});

test('summarizeStability ignores an unreported category rather than scoring it zero', () => {
  const s = summarizeStability([
    { scores: { performance: 90 } },
    { scores: { performance: 92, seo: 70 } },
  ]);
  assert.deepEqual(s.spread.performance, { min: 90, max: 92 });
  assert.deepEqual(s.spread.seo, { min: 70, max: 70 });
  assert.equal(s.spread.accessibility, undefined);
});

test('shouldRerun never repeats a passing profile — the budget goes where the verdict is in doubt', () => {
  assert.equal(shouldRerun(run(99), 1), false);
});

test('shouldRerun repeats a failing profile up to the cap, then stops', () => {
  assert.equal(shouldRerun(run(75), 1), true);
  assert.equal(shouldRerun(run(75), 2), true);
  assert.equal(shouldRerun(run(75), LIGHTHOUSE_STABILITY_RUNS), false);
  assert.equal(shouldRerun(run(75), LIGHTHOUSE_STABILITY_RUNS + 1), false);
});

test('shouldRerun does not loop on a missing result', () => {
  assert.equal(shouldRerun(null, 1), false);
});

test('foldStabilityRuns returns the median run and records the spread', () => {
  const folded = foldStabilityRuns([run(75), run(100), run(74)]);
  assert.equal(folded.scores.performance, 75);
  assert.deepEqual(folded.stability.spread.performance, { min: 74, max: 100 });
});

test('foldStabilityRuns adds a platform-owned instability finding naming the spread', () => {
  const folded = foldStabilityRuns([run(75), run(100), run(74)]);
  const finding = folded.findings.find((f) => f.kind === 'lighthouse-unstable-across-runs');
  assert.ok(finding);
  assert.equal(finding.owner, 'platform');
  assert.match(finding.title, /26 points/);
  assert.match(finding.title, /3 honest runs/);
});

test('foldStabilityRuns keeps the representative run own findings alongside it', () => {
  const folded = foldStabilityRuns([
    run(75, { findings: [{ id: 'real-defect' }] }),
    run(100),
    run(74),
  ]);
  assert.ok(folded.findings.some((f) => f.id === 'real-defect'));
});

test('foldStabilityRuns adds nothing when the page is steady', () => {
  const folded = foldStabilityRuns([run(97), run(98), run(99)]);
  assert.equal(folded.findings.some((f) => f.kind === 'lighthouse-unstable-across-runs'), false);
});

test('foldStabilityRuns leaves a single run untouched except for its stability record', () => {
  const folded = foldStabilityRuns([run(99, { findings: [{ id: 'x' }] })]);
  assert.equal(folded.stability.runs, 1);
  assert.deepEqual(folded.findings, [{ id: 'x' }]);
});

test('foldStabilityRuns returns null when there is nothing to fold', () => {
  assert.equal(foldStabilityRuns([]), null);
});

// --- Chrome-excluded shift detection -------------------------------------------------
// The measured artifact, from a real trace: one 0.819 shift whose impacted nodes all go
// from old_rect [0,0,0,0] to a real box, carrying had_recent_input with Chrome's own
// cumulative_score at 0.
const artifactShift = { score: 0.8189877263336979, had_recent_input: true, cumulative_score: 0 };
const honestShift = { score: 0.44, had_recent_input: false };
const tinyShift = { score: 0.0009, had_recent_input: true };

test('isChromeExcludedShiftRun recognises the measured artifact', () => {
  assert.equal(isChromeExcludedShiftRun([artifactShift, tinyShift]), true);
});

test('isChromeExcludedShiftRun does NOT discard a run containing a real shift', () => {
  // One honestly-counted significant shift and the run stands, even alongside the artifact.
  assert.equal(isChromeExcludedShiftRun([artifactShift, honestShift]), false);
});

test('isChromeExcludedShiftRun ignores insignificant shifts rather than discarding on them', () => {
  // A clean run is not an "artifact run" — it simply has nothing significant to judge.
  assert.equal(isChromeExcludedShiftRun([tinyShift]), false);
  assert.equal(isChromeExcludedShiftRun([]), false);
  assert.equal(isChromeExcludedShiftRun(null), false);
});

test('usableRuns keeps only honest runs when some are artifacts', () => {
  const good = run(99);
  const bad = run(75, { clsArtifact: true });
  assert.deepEqual(usableRuns([bad, good, bad]), [good]);
});

test('usableRuns discards an artifact even when it is the ENTIRE sample', () => {
  // The discard has to consume the flag unconditionally. Handing the artifacts back
  // when none is honest is what let the gate score a number it had just rejected.
  const bad1 = run(75, { clsArtifact: true });
  const bad2 = run(74, { clsArtifact: true });
  assert.deepEqual(usableRuns([bad1, bad2]), []);
});

test('unmeasuredReason names the all-artifact sample', () => {
  assert.equal(
    unmeasuredReason({ attempted: 3, honestCount: 0, stability: { runs: 3, unstable: false } }),
    'cls-artifact',
  );
});

test('unmeasuredReason names an honest sample that disagrees with itself', () => {
  assert.equal(
    unmeasuredReason({ attempted: 3, honestCount: 3, stability: { runs: 3, unstable: true } }),
    'unstable-spread',
  );
});

test('unmeasuredReason returns null for a steady, honest sample', () => {
  assert.equal(
    unmeasuredReason({ attempted: 3, honestCount: 3, stability: { runs: 3, unstable: false } }),
    null,
  );
  // A single run cannot be unstable with itself, whatever the flag says.
  assert.equal(
    unmeasuredReason({ attempted: 1, honestCount: 1, stability: { runs: 1, unstable: true } }),
    null,
  );
});

test('unmeasuredReason prefers the identified fault over the inferred one', () => {
  assert.equal(
    unmeasuredReason({ attempted: 3, honestCount: 0, stability: { runs: 3, unstable: true } }),
    'cls-artifact',
  );
});

// --- withdrawing a verdict the scores cannot support ---------------------------------
const parityRun = (performance, extra = {}) => run(performance, {
  parity: {
    pass: false,
    reason: 'regression',
    dimensions: {
      performance: { verdict: 'regression', delta: -16, source: 91, migrated: performance },
      seo: { verdict: 'giveaway', delta: 9, source: 91, migrated: 100 },
    },
    regressions: ['performance'],
    giveaways: ['seo'],
    unmeasured: [],
    summary: 'below source: performance 91->75 (-16)',
  },
  findings: [
    { id: 'real-defect', kind: 'lighthouse-audit' },
    { id: 'lighthouse-parity-regression-performance', kind: 'lighthouse-parity-regression' },
    { id: 'lighthouse-parity-giveaway-seo', kind: 'lighthouse-parity-giveaway' },
  ],
  ...extra,
});

test('withoutScoreVerdict withdraws the regression claim the scores cannot support', () => {
  // ONLY the CLS-weighted categories lose their verdict. A discarded layout-shift run says
  // nothing about canonical tags, so voiding the SEO judgement too would discard a measurement
  // that was never in doubt — which is what made whole pages unmeasurable.
  const stripped = withoutScoreVerdict(parityRun(75), 'cls-artifact');
  assert.deepEqual(stripped.parity.regressions, []);
  assert.deepEqual(stripped.parity.giveaways, ['seo'], 'an SEO giveaway survives a CLS artifact');
  assert.deepEqual(stripped.parity.unmeasured, ['performance']);
  assert.equal(stripped.parity.dimensions.seo.verdict, 'giveaway');
  assert.equal(stripped.parity.dimensions.performance.verdict, 'unmeasured');
  assert.equal(stripped.parity.dimensions.performance.delta, null);
  assert.equal(stripped.parity.reason, 'unmeasured:cls-artifact');
});

test('withoutScoreVerdict carries the reason in words, so consumers never need the reason table', () => {
  const stripped = withoutScoreVerdict(parityRun(75), 'cls-artifact');
  assert.equal(stripped.unmeasured, 'cls-artifact');
  assert.equal(stripped.unmeasuredText, UNMEASURED_REASONS['cls-artifact']);
  assert.notEqual(stripped.unmeasuredText, 'cls-artifact');
});

test('withoutScoreVerdict keeps the source and migrated numbers as evidence', () => {
  const stripped = withoutScoreVerdict(parityRun(75), 'cls-artifact');
  assert.equal(stripped.parity.dimensions.performance.source, 91);
  assert.equal(stripped.parity.dimensions.performance.migrated, 75);
  assert.equal(stripped.scores.performance, 75);
});

test('withoutScoreVerdict drops the parity findings and keeps the real ones', () => {
  const stripped = withoutScoreVerdict(parityRun(75), 'cls-artifact');
  assert.deepEqual(stripped.findings.map((f) => f.id), ['real-defect']);
});

test('withoutScoreVerdict never invents a pass', () => {
  const stripped = withoutScoreVerdict(run(100, { pass: true }), 'unstable-spread');
  assert.equal(stripped.pass, false);
  assert.equal(stripped.unmeasured, 'unstable-spread');
});

test('withoutScoreVerdict survives a run that carries no parity judgement', () => {
  const stripped = withoutScoreVerdict(run(75), 'cls-artifact');
  assert.equal(stripped.parity, undefined);
  assert.equal(stripped.unmeasured, 'cls-artifact');
  assert.equal(withoutScoreVerdict(null, 'cls-artifact'), null);
});

test('foldStabilityRuns scores the honest run and discards the artifact majority', () => {
  // THE CASE A MEDIAN CANNOT FIX: the artifact is the MAJORITY, so a median of three
  // faithfully returns it. Discarding by identity is what makes this correct.
  const folded = foldStabilityRuns([
    run(75, { clsArtifact: true }),
    run(74, { clsArtifact: true }),
    run(99),
  ]);
  assert.equal(folded.scores.performance, 99);
  assert.equal(folded.stability.discardedAsArtifact, 2);
  assert.equal(folded.stability.attempted, 3);
  assert.ok(folded.findings.some((f) => f.kind === 'lighthouse-cls-artifact-discarded'));
});

test('foldStabilityRuns reports UNMEASURED rather than inventing a pass when every run is an artifact', () => {
  const folded = foldStabilityRuns([
    run(75, { clsArtifact: true }),
    run(74, { clsArtifact: true }),
  ]);
  const finding = folded.findings.find((f) => f.kind === 'lighthouse-cls-artifact-unmeasured');
  assert.ok(finding);
  assert.equal(finding.owner, 'platform');
  assert.match(finding.title, /UNMEASURED/);
  assert.equal(folded.unmeasured, 'cls-artifact');
});

test('foldStabilityRuns will not turn an all-artifact sample into a pass', () => {
  // Starts from pass:true so the assertion pins the fold, not the fixture. An artifact
  // run that happened to score well is still not a measurement of this page.
  const folded = foldStabilityRuns([
    run(100, { clsArtifact: true, pass: true }),
    run(99, { clsArtifact: true, pass: true }),
  ]);
  assert.equal(folded.pass, false);
  assert.equal(folded.unmeasured, 'cls-artifact');
});

test('foldStabilityRuns COUNTS every artifact it discarded, including a whole sample', () => {
  // The flag must be consumed, not merely recorded: a page the gate identified as an
  // artifact cannot report zero discards.
  const folded = foldStabilityRuns([
    run(75, { clsArtifact: true }),
    run(76, { clsArtifact: true }),
    run(75, { clsArtifact: true }),
  ]);
  assert.equal(folded.stability.attempted, 3);
  assert.equal(folded.stability.discardedAsArtifact, 3);
});

test('foldStabilityRuns does not claim it scored honest runs when there were none', () => {
  const folded = foldStabilityRuns([
    run(75, { clsArtifact: true }),
    run(74, { clsArtifact: true }),
  ]);
  assert.equal(folded.findings.some((f) => f.kind === 'lighthouse-cls-artifact-discarded'), false);
});

test('foldStabilityRuns withdraws the parity regression an all-artifact sample produced', () => {
  // The measured harm: a page recorded as a 16-point CORE REGRESSION that re-measured
  // ahead of its own source. An unmeasurable page owes nobody perf work.
  const folded = foldStabilityRuns([parityRun(75), parityRun(76)].map((r) => ({ ...r, clsArtifact: true })));
  assert.deepEqual(folded.parity.regressions, []);
  // Only performance is voided: the artifact taints CLS-weighted scores, not the SEO judgement.
  assert.deepEqual(folded.parity.unmeasured, ['performance']);
  assert.equal(folded.findings.some((f) => f.kind === 'lighthouse-parity-regression'), false);
  assert.ok(folded.findings.some((f) => f.id === 'real-defect'));
});

test('foldStabilityRuns refuses to report one end of an unstable spread as a regression', () => {
  // 75..95 across honest runs of an unchanged url: the gate used to return the minimum
  // and call the gap a regression. The spread is the harness, so there is no verdict.
  const folded = foldStabilityRuns([parityRun(75), parityRun(75), parityRun(95)]);
  assert.equal(folded.stability.unstable, true);
  assert.equal(folded.unmeasured, 'unstable-spread');
  assert.deepEqual(folded.parity.regressions, []);
  assert.equal(folded.pass, false);
});

test('foldStabilityRuns leaves a steady honest sample judged on its scores', () => {
  const folded = foldStabilityRuns([parityRun(75), parityRun(76), parityRun(77)]);
  assert.equal(folded.unmeasured, undefined);
  assert.deepEqual(folded.parity.regressions, ['performance']);
  assert.ok(folded.findings.some((f) => f.kind === 'lighthouse-parity-regression'));
});

test('foldStabilityRuns leaves an all-honest sample alone', () => {
  const folded = foldStabilityRuns([run(97), run(98), run(99)]);
  assert.equal(folded.stability.discardedAsArtifact, 0);
  assert.equal(folded.findings.some((f) => f.kind === 'lighthouse-cls-artifact-discarded'), false);
  assert.equal(folded.findings.some((f) => f.kind === 'lighthouse-cls-artifact-unmeasured'), false);
});

test('foldStabilityRuns reports the spread over runs USED, not runs rejected', () => {
  const folded = foldStabilityRuns([
    run(75, { clsArtifact: true }),
    run(98),
    run(99),
  ]);
  assert.deepEqual(folded.stability.spread.performance, { min: 98, max: 99 });
});


// --- first-party asset reachability --------------------------------------------------
const sendReq = (requestId, url) => ({ name: 'ResourceSendRequest', args: { data: { requestId, url } } });
const gotResp = (requestId, statusCode) => ({ name: 'ResourceReceiveResponse', args: { data: { requestId, statusCode } } });
const HOST = 'https://storefront.example.store';

test('firstPartyNotFoundUrls catches the measured tenant-asset 404s', () => {
  const events = [
    sendReq('1', `${HOST}/tenants/acme.com/images/logo.png`), gotResp('1', 404),
    sendReq('2', `${HOST}/tenants/acme.com/images/favicon.png`), gotResp('2', 404),
  ];
  assert.deepEqual(firstPartyNotFoundUrls(events), [
    `${HOST}/tenants/acme.com/images/logo.png`,
    `${HOST}/tenants/acme.com/images/favicon.png`,
  ]);
});

test('firstPartyNotFoundUrls catches a 404 on a pinned content-addressed asset', () => {
  const url = `${HOST}/_a/c433dfee060983f591b5552d708317d13c3cb9ccc0511959c540cc62f7e1d199.css`;
  assert.deepEqual(firstPartyNotFoundUrls([sendReq('1', url), gotResp('1', 404)]), [url]);
});

test('firstPartyNotFoundUrls ignores a THIRD-PARTY 404, which IS the tenant problem to fix', () => {
  const events = [sendReq('1', 'https://cdn.someone-else.example/widget.js'), gotResp('1', 404)];
  assert.deepEqual(firstPartyNotFoundUrls(events), []);
});

test('firstPartyNotFoundUrls ignores healthy first-party responses', () => {
  const events = [
    sendReq('1', `${HOST}/tenants/acme.com/images/logo.png`), gotResp('1', 200),
    sendReq('2', `${HOST}/_astro/app.css`), gotResp('2', 304),
  ];
  assert.deepEqual(firstPartyNotFoundUrls(events), []);
});

test('firstPartyNotFoundUrls covers the build own asset namespaces', () => {
  const events = [
    sendReq('1', `${HOST}/_astro/page.js`), gotResp('1', 404),
    sendReq('2', `${HOST}/shared/commerce-chrome.css`), gotResp('2', 404),
  ];
  assert.equal(firstPartyNotFoundUrls(events).length, 2);
});

test('firstPartyNotFoundUrls de-duplicates a repeatedly-failing asset', () => {
  const events = [
    sendReq('1', `${HOST}/tenants/acme.com/images/logo.png`), gotResp('1', 404),
    sendReq('2', `${HOST}/tenants/acme.com/images/logo.png`), gotResp('2', 404),
  ];
  assert.equal(firstPartyNotFoundUrls(events).length, 1);
});

test('firstPartyNotFoundUrls survives a response with no matching request', () => {
  assert.deepEqual(firstPartyNotFoundUrls([gotResp('orphan', 404)]), []);
  assert.deepEqual(firstPartyNotFoundUrls([]), []);
  assert.deepEqual(firstPartyNotFoundUrls(null), []);
});

test("a discarded artifact run is retried even though it 'passed'", () => {
  // The run's own pass flag is computed BEFORE the artifact discard, so a passing-but-discarded
  // run would end the loop with an empty scored set and report UNMEASURED with the retry budget
  // untouched. Measured 2026-09-21 on a real page that stopped after one attempt.
  assert.equal(shouldRerun({ pass: true, clsArtifact: true }, 1, 3), true);
  assert.equal(shouldRerun({ pass: false, clsArtifact: true }, 1, 3), true);
});

test("an honest passing run is still not retried, and the cap still holds", () => {
  // Negative control: the whole point of the one-run common case is that a green page costs one
  // run. And a discarded run must not retry past the budget either.
  assert.equal(shouldRerun({ pass: true }, 1, 3), false);
  assert.equal(shouldRerun({ pass: true, clsArtifact: true }, 3, 3), false);
});

test('a CLS artifact never voids a judgement that does not read layout shift', () => {
  // The rule in one assertion: accessibility, SEO and best-practices are judged on audits that
  // never read cumulative-layout-shift, so a discarded CLS run leaves them standing. Voiding
  // them turned one bad metric into a page with no measurement at all.
  const stripped = withoutScoreVerdict(parityRun(75), 'cls-artifact');
  for (const clean of ['seo']) {
    assert.notEqual(stripped.parity.dimensions[clean].verdict, 'unmeasured',
      `${clean} does not read CLS and must keep its verdict`);
  }
  assert.equal(stripped.parity.dimensions.performance.verdict, 'unmeasured');
  assert.equal(stripped.pass, false, 'the run still does not pass');
});
