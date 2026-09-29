/**
 * Lighthouse gate stability — the pure decision core.
 *
 * A single Lighthouse run is not a measurement. Measured on a regulated tenant
 * 2026-09-19, ten consecutive runs of one unchanged URL returned CLS 0.820-0.828
 * six times and 0.0013-0.0024 four times, with performance 74-75 and 96-100
 * respectively. The distribution is bimodal, so the gate was deciding whether a
 * tenant may cut over on a coin flip.
 *
 * The cause is a measurement artifact, not a page defect: the big shift's impacted
 * nodes go from `old_rect [0,0,0,0]` to a real box (nothing moves, it is the first
 * layout), Chrome scores it zero via `had_recent_input`, and Lighthouse re-includes
 * it by design for shifts within 500ms of the first `viewport` event — its
 * workaround for Chromium 1094974 / 1302667, where applying device emulation sets
 * that flag spuriously.
 *
 * The gate therefore does three distinct things, in this order:
 *
 *   1. DISCARD runs the browser itself disowned. A median cannot rescue this on
 *      its own — measured, the bad mode was the MAJORITY (6 of 10 runs), so a
 *      median of three faithfully returns the artifact about 65% of the time. The
 *      fault is identifiable and one-sided, so it is removed by identity rather
 *      than averaged over.
 *   2. Take the MEDIAN of whatever honest runs remain, for ordinary run-to-run
 *      noise, which is two-sided and genuinely is a sampling problem.
 *   3. REFUSE THE VERDICT when there is nothing honest left to take a median of,
 *      or when the honest runs disagree by a whole band. Both are the harness
 *      failing to measure, so the page is reported UNMEASURED: the scores stay as
 *      evidence, and every claim they were used to make — a parity regression, a
 *      giveaway — is withdrawn.
 *
 * The representative result is deliberately a REAL run, never a synthesized
 * best-of: its artifact, findings and scores all describe one load. A result
 * assembled from several runs would report findings that never co-occurred.
 *
 * UNMEASURED is never a pass. That a page cannot currently be measured is a fact a
 * human needs, and a silent green would be worse than a bad number. What it must
 * not become is the opposite failure — a recorded regression that sends someone to
 * optimise a page already faster than the source it is said to have lost against.
 */

/** How many runs a failing profile is allowed, in total, before the gate decides. */
export const LIGHTHOUSE_STABILITY_RUNS = 3;

/**
 * Was this run's layout-shift score produced entirely by shifts CHROME ITSELF
 * discarded?
 *
 * Chrome sets `had_recent_input` on a shift it will not count, and reports its own
 * running total as `cumulative_score`. Lighthouse re-includes such a shift when it
 * lands within 500ms of the first `viewport` event — its workaround for Chromium
 * 1094974 / 1302667, where applying device emulation sets that flag spuriously. On
 * a page emulation perturbs, the workaround admits a shift no visitor experiences
 * and no field measurement will record.
 *
 * The resulting error is ONE-SIDED: it can only inflate CLS, never deflate it. That
 * is what makes it safe to DISCARD an affected run rather than average it in — and
 * it is why a median does not rescue this. Measured 2026-09-19 the bad mode was the
 * MAJORITY (6 of 10 runs), so a median of three returns the artifact ~65% of the
 * time. Averaging is the wrong tool for a one-sided fault you can identify outright.
 *
 * Deliberately narrow so a genuine shift is never discarded: EVERY significant
 * shift in the run must carry the flag. One honestly-counted shift and the run
 * stands as real.
 */
export function isChromeExcludedShiftRun(shiftEvents, minScore = 0.1) {
  const events = (shiftEvents ?? []).filter((e) => e && typeof e === "object");
  const significant = events.filter((e) => Number(e.score ?? 0) >= minScore);
  if (significant.length === 0) return false;
  return significant.every((e) => e.had_recent_input === true);
}

/**
 * Categories the gate scores, in report order. THE single source of truth — import it, never
 * retype it.
 *
 * All five Lighthouse 13 categories. This list existed and was exported, and four other places
 * still spelled the same four category names out by hand anyway: the baseline capture, the
 * validator's onlyCategories, the validator's score extraction, and the report's dimensions.
 * When Lighthouse 13 added `agentic-browsing` every one of those omitted it silently, and the
 * two halves could even disagree with each other — the validator requested the fifth category
 * and then dropped it on extraction, so it was measured and discarded in the same function.
 *
 * A hand-maintained copy of another tool's enum is a standing bug; five copies is five chances
 * to be wrong in different directions.
 */
export const LIGHTHOUSE_CATEGORIES = [
  "performance", "accessibility", "best-practices", "seo", "agentic-browsing",
];

/**
 * The categories whose score depends on cumulative-layout-shift, and therefore the only ones a
 * CLS artifact can invalidate. Performance weights CLS at 25%; agentic-browsing carries it as one
 * of its six audits. Accessibility, SEO and best-practices never read it.
 */
export const CLS_WEIGHTED_CATEGORIES = new Set(["performance", "agentic-browsing"]);

/**
 * A spread this wide across runs of the SAME url means the number is not a
 * property of the page. Chosen from the measured artifact, which moves a category
 * by ~25 points; anything at or above this is reported as unstable so a reader can
 * tell noise from a regression.
 */
export const UNSTABLE_SPREAD_POINTS = 10;

/**
 * The median index for a set of runs ordered by score. For an even count this
 * takes the LOWER middle, which keeps the gate conservative: a tenant is never
 * passed on the better half of a tie.
 */
export function medianIndex(count) {
  if (!Number.isInteger(count) || count < 1) return 0;
  return Math.floor((count - 1) / 2);
}

/**
 * Pick the run whose performance score is the median. Performance is the ranking
 * key because it is the category the artifact moves. Equal scores are ordered by
 * their original index, so the choice never drifts between invocations — note this
 * is a tiebreak WITHIN the sort, not an override of the median: three equal runs
 * still resolve to the middle element.
 */
export function pickRepresentativeRun(runs) {
  const usable = (runs ?? []).filter((run) => run && typeof run === "object");
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];
  const ordered = usable
    .map((run, index) => ({ run, index, score: Number(run.scores?.performance ?? 0) }))
    .sort((a, b) => (a.score - b.score) || (a.index - b.index));
  return ordered[medianIndex(ordered.length)].run;
}

/**
 * Per-category min/max across runs, plus whether any category moved far enough
 * that a single run could not have been trusted.
 */
export function summarizeStability(runs) {
  const usable = (runs ?? []).filter((run) => run && typeof run === "object");
  const spread = {};
  let widest = 0;
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const values = usable
      .map((run) => Number(run.scores?.[category]))
      .filter((value) => Number.isFinite(value));
    if (values.length === 0) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    spread[category] = { min, max };
    if (max - min > widest) widest = max - min;
  }
  return { runs: usable.length, spread, widestSpread: widest, unstable: widest >= UNSTABLE_SPREAD_POINTS };
}

/**
 * Should another run be taken? Only a FAILING result is re-run: a green profile is
 * already at the answer the gate wants and re-running it only costs wall-clock.
 * This keeps the common case at one run and spends the budget exactly where the
 * decision is in doubt.
 */
export function shouldRerun(result, attemptsSoFar, maxRuns = LIGHTHOUSE_STABILITY_RUNS) {
  if (!result) return false;
  if (attemptsSoFar >= maxRuns) return false;
  // A run discarded as an artifact leaves NOTHING behind, so it must be retried even though it
  // "passed" — its own pass flag is computed before the discard, and usableRuns then drops it
  // from the scored set. Measured 2026-09-21: a page whose single run carried the flag stopped
  // after one attempt with its retry budget untouched, and reported UNMEASURED. Retrying is the
  // entire purpose of the budget, and an unmeasurable page is the one case that most needs it.
  if (result.clsArtifact === true) return true;
  return result.pass !== true;
}

/**
 * Drop runs whose score was driven by a shift Chrome discarded, keeping only
 * honest measurements of the same page.
 *
 * The discard is UNCONDITIONAL: an identified artifact never survives into the
 * scored set, not even when it is the entire sample. Keeping the artifacts once
 * none is honest reads as prudence and is the opposite — it hands the gate a
 * number the same pass has just finished proving is fiction. Measured 2026-09-20,
 * two pages of one tenant whose every run carried the flag scored 75 and 76 here
 * and re-measured at 97 and 100 against a captured source baseline: the whole
 * 16-point "core regression" was the artifact.
 *
 * An empty result is therefore a real answer, and it means UNMEASURED. It is
 * foldStabilityRuns that turns it into one (never into a pass).
 */
export function usableRuns(runs) {
  return (runs ?? []).filter((run) => run && typeof run === "object" && run.clsArtifact !== true);
}

/**
 * Why a page's Lighthouse numbers describe the measurement rather than the page.
 * Both are properties of the HARNESS, so neither may ever be reported as a tenant
 * regression — see withoutScoreVerdict.
 */
export const UNMEASURED_REASONS = {
  "cls-artifact":
    "every Lighthouse run was driven by layout shifts Chrome itself excluded (had_recent_input)",
  "unstable-spread":
    `Lighthouse moved at least ${UNSTABLE_SPREAD_POINTS} points across repeat runs of this same url`,
};

/**
 * Is this fold's score a property of the page, or of the harness measuring it?
 *
 * Two distinct faults, one consequence. The first is identified outright (every
 * run an artifact); the second is inferred from disagreement between honest runs
 * of an unchanged url, which is the definition of a number that is not a property
 * of the thing measured.
 *
 * @returns {"cls-artifact"|"unstable-spread"|null}
 */
export function unmeasuredReason({ attempted, honestCount, stability }) {
  if (attempted > 0 && honestCount === 0) return "cls-artifact";
  if (stability?.runs > 1 && stability.unstable === true) return "unstable-spread";
  return null;
}

/**
 * Strip the SCORE-DERIVED verdict off a run whose numbers the gate has just judged
 * untrustworthy, leaving the evidence intact.
 *
 * What goes is only what the scores were used to ASSERT: that the migration took
 * something from the merchant (a parity regression) or handed something over free
 * (a giveaway). Both are claims about the page, and an untrustworthy measurement
 * cannot support either — a regression claim sends someone to optimise a page that
 * may already beat its source, and a giveaway claim invoices for value nobody has
 * evidence of. Every dimension becomes `unmeasured`, which judgeParity already
 * treats as neither pass nor defect.
 *
 * What stays is the whole measurement: scores, metrics, findings from the audits,
 * and the artifact path. A reader must still be able to see what was measured and
 * why it was rejected.
 *
 * `pass` stays FALSE. Unmeasured is not a pass — that a page cannot currently be
 * measured is a fact a human needs, and a silent green would be worse than a bad
 * number.
 */
export function withoutScoreVerdict(run, reason) {
  if (!run || typeof run !== "object") return run;
  const findings = (run.findings ?? []).filter(
    (finding) => finding?.kind !== "lighthouse-parity-regression"
      && finding?.kind !== "lighthouse-parity-giveaway",
  );
  const next = { ...run, pass: false, unmeasured: reason, unmeasuredText: UNMEASURED_REASONS[reason] ?? reason, findings };
  const parity = run.parity;
  if (parity && typeof parity === "object") {
    // STRIP ONLY WHAT THE ARTIFACT ACTUALLY TAINTS. A discarded CLS run says nothing about a
    // page's contrast, labels, canonical tags or deprecated APIs — those audits do not read
    // layout shift at all. Voiding every dimension turned one untrustworthy metric into a page
    // with NO measurement, which is what made pages permanently unmeasurable and the gate
    // unwinnable. Performance and agentic-browsing both weight cumulative-layout-shift, so they
    // are the two that lose their verdict; the rest keep the judgement they honestly earned.
    const tainted = CLS_WEIGHTED_CATEGORIES;
    const dimensions = {};
    for (const [key, judged] of Object.entries(parity.dimensions ?? {})) {
      dimensions[key] = tainted.has(key)
        ? { ...judged, verdict: "unmeasured", delta: null }
        : judged;
    }
    const stillJudged = Object.entries(dimensions).filter(([k]) => !tainted.has(k));
    next.parity = {
      ...parity,
      pass: false,
      reason: `unmeasured:${reason}`,
      dimensions,
      regressions: stillJudged.filter(([, d]) => d.verdict === "regression").map(([k]) => k),
      giveaways: stillJudged.filter(([, d]) => d.verdict === "giveaway").map(([k]) => k),
      unmeasured: Object.keys(dimensions).filter((k) => tainted.has(k)),
      summary:
        `Not judged against the source: ${UNMEASURED_REASONS[reason] ?? reason}. ` +
        "The scores below describe the measurement, not the page — do not read them as a " +
        "regression and do not capture a baseline from them.",
    };
  }
  return next;
}

/**
 * Fold N runs into the gate's verdict. Returns the representative run annotated
 * with what the repeats showed, so the artifact records the spread rather than a
 * lone number a later reader cannot calibrate.
 */
export function foldStabilityRuns(runs) {
  const all = (runs ?? []).filter((run) => run && typeof run === "object");
  const honest = usableRuns(all);
  const discarded = all.length - honest.length;
  const allArtifact = all.length > 0 && honest.length === 0;

  // With nothing honest left there is still a page to REPORT ON, so the artifacts
  // supply the evidence — the artifact path, the metrics, the audit findings — while
  // the verdict they imply is stripped below. Scoring them is the bug; showing them
  // is how a human sees what was rejected.
  const scored = allArtifact ? all : honest;
  const representative = pickRepresentativeRun(scored);
  if (!representative) return null;

  // The spread is reported over the runs actually USED, so a reader is not shown a
  // range that includes measurements the gate already rejected.
  const stability = {
    ...summarizeStability(scored),
    attempted: all.length,
    discardedAsArtifact: discarded,
  };
  const unmeasured = unmeasuredReason({
    attempted: all.length,
    honestCount: honest.length,
    stability,
  });

  const findings = [...(representative.findings ?? [])];
  if (discarded > 0 && !allArtifact) {
    findings.push({
      id: "lighthouse-cls-artifact-discarded",
      kind: "lighthouse-cls-artifact-discarded",
      owner: "platform",
      categories: [],
      title:
        `Discarded ${discarded} of ${all.length} Lighthouse run(s) whose layout-shift score came` +
        " entirely from shifts Chrome itself excluded (had_recent_input). The gate scored the" +
        " remaining honest run(s). This is a measurement fault, not a page defect.",
    });
  }
  if (allArtifact) {
    findings.push({
      id: "lighthouse-cls-artifact-unmeasured",
      kind: "lighthouse-cls-artifact-unmeasured",
      owner: "platform",
      categories: [],
      title:
        `All ${all.length} Lighthouse run(s) were driven by shifts Chrome excluded, so this page's` +
        " layout-shift score is UNMEASURED rather than bad. Do not read it as a regression, and do" +
        " not capture a baseline from it. Re-measure before treating any number here as real.",
    });
  }
  if (unmeasured === "unstable-spread") {
    findings.push({
      id: "lighthouse-unstable-across-runs",
      kind: "lighthouse-unstable-across-runs",
      owner: "platform",
      categories: [],
      title:
        `Lighthouse moved ${stability.widestSpread} points across ${stability.runs} honest runs of` +
        " this url, so the score is UNMEASURED rather than bad. A spread this wide is a property" +
        " of the measurement, not the page; the gate will not report one end of it as a" +
        " regression. Re-measure before treating any number here as real.",
    });
  }

  if (all.length <= 1 && discarded === 0 && !unmeasured) {
    return { ...representative, stability };
  }
  const folded = { ...representative, stability, findings };
  return unmeasured ? withoutScoreVerdict(folded, unmeasured) : folded;
}


/**
 * First-party tenant assets that 404'd during a run.
 *
 * "First-party" here means the tenant's own published asset namespace
 * (`/tenants/<id>/...`) plus the build's own emitted assets — the things whose
 * absence means the HARNESS could not see the site. A third-party URL the page
 * merely references is excluded: that 404 is genuinely the tenant's to fix.
 *
 * Trace responses carry only a requestId, so the URL is joined back from the
 * matching ResourceSendRequest.
 */
export function firstPartyNotFoundUrls(traceEvents) {
  const events = (traceEvents ?? []).filter((e) => e && typeof e === "object");
  const urlByRequestId = new Map();
  for (const event of events) {
    if (event.name !== "ResourceSendRequest") continue;
    const data = event.args?.data;
    if (data?.requestId && typeof data.url === "string") urlByRequestId.set(data.requestId, data.url);
  }
  const missing = [];
  for (const event of events) {
    if (event.name !== "ResourceReceiveResponse") continue;
    const data = event.args?.data;
    if (Number(data?.statusCode) !== 404) continue;
    const url = urlByRequestId.get(data?.requestId);
    if (!url) continue;
    let pathname;
    try { pathname = new URL(url).pathname; } catch { continue; }
    // `/_a/` is the content-addressed form every materialized sub-resource is pinned to.
    const firstParty = pathname.startsWith("/tenants/")
      || pathname.startsWith("/_astro/")
      || pathname.startsWith("/shared/")
      || pathname.startsWith("/_a/");
    if (firstParty && !missing.includes(url)) missing.push(url);
  }
  return missing;
}
