// @ts-check
// What the Lighthouse gate is entitled to demand of a migration, and what it must merely report.
//
// The obligation is PARITY: at least as good as the source, and no worse. An absolute floor asks a
// faithful clone to outperform the original — a floor of 90 against a source scoring 41 is an
// add-on being enforced as core, and it fails a migration for declining to do work nobody bought.
// The add-on stages are the migration add-ons a merchant can buy beyond parity.
//
// Three bands, because a migration can miss in two opposite directions and only one of them is a
// defect:
//
//   below source - tolerance   REGRESSION — core defect. We took something the merchant had.
//   within the band            PARITY — the obligation is met. This is the target.
//   above source + ceiling     GIVEAWAY — delivered, catalogued, never a failure. It is add-on
//                              value handed over for free, and the number is the quote.
//
// The ceiling exists to keep that headroom VISIBLE, never to hold a site back. A giveaway always
// passes; degrading a page to sit inside the band would be absurd and this module cannot ask for
// it. What it can do is stop the improvement from being invisible, which is how it gets absorbed
// into the base price instead of sold.

/** Points a dimension may fall below source before it is a regression. */
import { LIGHTHOUSE_CATEGORIES } from "./lighthouse-stability.mjs";

export const PARITY_TOLERANCE = 3;

/** Points above source beyond which delivered value is catalogued as a giveaway. */
export const GIVEAWAY_CEILING = 5;

/** @typedef {"regression"|"parity"|"giveaway"|"unmeasured"} ParityVerdict */

/**
 * Judge one dimension against its source score.
 *
 * The tolerance is not slack for sloppiness — Lighthouse composites move a few points run to run
 * on an unchanged page, so a strict `>= source` comparison flakes, and a flaky gate gets ignored.
 * A dimension with no source score is `unmeasured`, never a silent pass.
 *
 * @param {number|null|undefined} source
 * @param {number|null|undefined} migrated
 * @param {{tolerance?: number, ceiling?: number}} [opts]
 * @returns {{verdict: ParityVerdict, delta: number|null, source: number|null, migrated: number|null}}
 */
export function judgeDimension(source, migrated, opts = {}) {
  const tolerance = opts.tolerance ?? PARITY_TOLERANCE;
  const ceiling = opts.ceiling ?? GIVEAWAY_CEILING;
  if (typeof source !== "number" || typeof migrated !== "number") {
    return {
      verdict: "unmeasured",
      delta: null,
      source: typeof source === "number" ? source : null,
      migrated: typeof migrated === "number" ? migrated : null,
    };
  }
  const delta = migrated - source;
  if (delta < -tolerance) return { verdict: "regression", delta, source, migrated };
  if (delta > ceiling) return { verdict: "giveaway", delta, source, migrated };
  return { verdict: "parity", delta, source, migrated };
}

/**
 * Judge a page's Lighthouse categories against its captured source baseline.
 *
 * A MISSING baseline fails, and deliberately. The source is reachable only until the hostname
 * flips; afterwards "what did they have" is unanswerable forever, along with any proof the
 * migration improved anything. Failing before cutover is recoverable in minutes — capture it.
 * Passing a tenant with nothing to compare against would hide that the window had closed.
 *
 * @param {{scores?: Record<string, number>, baseline?: Record<string, number>|null,
 *          tolerance?: number, ceiling?: number, notComparable?: string}} input
 * @returns {{pass: boolean, reason: string|null, dimensions: Record<string, ReturnType<typeof judgeDimension>>,
 *            regressions: string[], giveaways: string[], unmeasured: string[]}}
 */
export function judgeParity({ scores = {}, baseline, tolerance, ceiling, notComparable }) {
  // NOT COMPARABLE is not the same as NOT CAPTURED, and conflating them inverts the verdict.
  // A baseline captured at a different form factor exists — it simply does not describe this
  // run, so there is nothing to judge and nothing the tenant did wrong. Reporting it as a
  // missing baseline would fail the page and send someone to re-capture, which after cutover
  // destroys the only source reading that will ever exist. Measured 2026-09-21: a mobile
  // baseline judged desktop runs as -4 to -7 regressions on four pages whose mobile scores were
  // 99-100.
  if (notComparable) {
    return {
      pass: true,
      reason: `not-comparable:${notComparable}`,
      dimensions: Object.fromEntries(Object.keys(scores).map((k) => [k, {
        verdict: "unmeasured", delta: null, source: null, migrated: scores[k] ?? null,
      }])),
      regressions: [],
      giveaways: [],
      unmeasured: Object.keys(scores),
    };
  }
  if (!baseline || Object.keys(baseline).length === 0) {
    return {
      pass: false,
      reason: "baseline-missing",
      dimensions: {},
      regressions: [],
      giveaways: [],
      unmeasured: Object.keys(scores),
    };
  }
  /** @type {Record<string, ReturnType<typeof judgeDimension>>} */
  const dimensions = {};
  const regressions = [];
  const giveaways = [];
  const unmeasured = [];
  for (const key of Object.keys(scores)) {
    const judged = judgeDimension(baseline[key], scores[key], { tolerance, ceiling });
    dimensions[key] = judged;
    if (judged.verdict === "regression") regressions.push(key);
    else if (judged.verdict === "giveaway") giveaways.push(key);
    else if (judged.verdict === "unmeasured") unmeasured.push(key);
  }
  // Only a regression fails. A giveaway is value delivered; an unmeasured dimension is a gap in
  // the baseline, which the baseline-missing branch already covers at the page level — here it
  // means the source simply had no score for that one category, which cannot be a tenant defect.
  return {
    pass: regressions.length === 0,
    reason: regressions.length === 0 ? null : "regression",
    dimensions,
    regressions,
    giveaways,
    unmeasured,
  };
}

/**
 * One line a human can act on, naming the direction of every miss.
 * @param {ReturnType<typeof judgeParity>} result
 * @returns {string}
 */
export function describeParity(result) {
  if (result.reason === "baseline-missing") {
    return (
      "No source Lighthouse baseline recorded, so parity cannot be judged. Capture it BEFORE " +
      "cutover — once the hostname flips the original is gone and this is unanswerable forever."
    );
  }
  // Only regressions and giveaways reach here, and both carry a numeric delta by construction —
  // an `unmeasured` dimension has none and is never in either list. Narrowed rather than asserted
  // so the guarantee is checked instead of assumed.
  const fmt = (key) => {
    const d = result.dimensions[key];
    if (typeof d?.delta !== "number") return key;
    return `${key} ${d.source}->${d.migrated} (${d.delta > 0 ? "+" : ""}${d.delta})`;
  };
  const parts = [];
  if (result.regressions.length > 0) {
    parts.push(`below source: ${result.regressions.map(fmt).join(", ")}`);
  }
  if (result.giveaways.length > 0) {
    parts.push(`delivered free (add-on value, not a defect): ${result.giveaways.map(fmt).join(", ")}`);
  }
  if (parts.length === 0) return "At parity with the source on every measured dimension.";
  return parts.join("; ");
}

/** How far a SINGLE PAGE may sit below the source on a dimension before it counts against us. */
export const PAGE_TOLERANCE = 3;

/** Routes judged strictly — every dimension must be at least as good as the source. */
export const STRICT_ROUTES = new Set(["/", ""]);

/**
 * The site-wide parity verdict, judged the way a merchant would actually judge it.
 *
 * Per-page strictness was the wrong instrument. Lighthouse moves a few points between runs of
 * the same URL, so demanding every page beat its source on every dimension turned ordinary noise
 * into failures and made the gate unwinnable for reasons that had nothing to do with the
 * migration. Two rules replace it:
 *
 *   AGGREGATE — the average across the sample set must be AT LEAST AS GOOD as the source. This
 *   is the real obligation: taken as a whole the migrated site may not be slower, less
 *   accessible or less findable than what the merchant already had. Averaging is what makes that
 *   number stable enough to hold to a hard line.
 *
 *   A SINGLE PAGE may sit up to PAGE_TOLERANCE below on any dimension. Lighthouse moves a few
 *   points between runs of the same URL, so holding every page to an exact line turns ordinary
 *   jitter into failures — but a page that falls further than that is a real defect the average
 *   would otherwise hide.
 *
 *   THE HOME PAGE IS STRICT — it must be at least as good as the source on EVERY dimension. It
 *   is the page most visitors see and the one a merchant will check first, so "we came out level
 *   on average" is not an acceptable answer for it.
 *
 * Judged per form factor, never across them: a phone measurement and a desktop measurement are
 * different things and averaging them hides the divergence that matters most.
 *
 * @param {{slug: string, profiles?: Record<string, {dimensions?: Record<string, {source?: number|null, migrated?: number|null}>}>}[]} pages
 * @param {{tolerance?: number}} [opts]
 */
export function judgeSiteParity(pages, opts = {}) {
  const tolerance = opts.tolerance ?? PAGE_TOLERANCE;
  const profiles = [...new Set((pages ?? []).flatMap((p) => Object.keys(p.profiles ?? {})))];
  /** @type {Record<string, {aggregate: Record<string, {source: number, migrated: number, delta: number, pages: number}>, shortfalls: string[], pageShortfalls: {slug: string, dimension: string, source: number, migrated: number, delta: number}[], home: {dimension: string, source: number, migrated: number, delta: number}[]}>} */
  const byProfile = {};
  let pass = true;

  for (const profile of profiles) {
    /** @type {Record<string, {source: number, migrated: number, delta: number, pages: number}>} */
    const aggregate = {};
    const shortfalls = [];
    /** @type {{slug: string, dimension: string, source: number, migrated: number, delta: number}[]} */
    const pageShortfalls = [];
    for (const dim of LIGHTHOUSE_CATEGORIES) {
      /** @type {{source: number, migrated: number}[]} */
      const rows = [];
      for (const page of pages ?? []) {
        const d = page.profiles?.[profile]?.dimensions?.[dim];
        if (d && typeof d.source === "number" && typeof d.migrated === "number") {
          rows.push({ source: d.source, migrated: d.migrated });
        }
      }
      if (rows.length === 0) continue;
      const avg = (/** @type {"source"|"migrated"} */ key) =>
        Math.round(rows.reduce((t, r) => t + r[key], 0) / rows.length);
      const source = avg("source");
      const migrated = avg("migrated");
      const delta = migrated - source;
      aggregate[dim] = { source, migrated, delta, pages: rows.length };
      // The aggregate is held to AT LEAST AS GOOD — no tolerance. The band belongs to individual
      // pages, where run-to-run jitter actually lives; an average that has drifted below source
      // is not noise, it is the site being worse.
      if (delta < 0) {
        shortfalls.push(dim);
        pass = false;
      }
    }

    // Any single page further than the tolerance below source on any dimension. The average can
    // hide one badly-regressed page behind seven healthy ones, which is exactly the page a
    // merchant would find first.
    for (const page of pages ?? []) {
      for (const [dim, judged] of Object.entries(page.profiles?.[profile]?.dimensions ?? {})) {
        if (typeof judged?.source !== "number" || typeof judged?.migrated !== "number") continue;
        const delta = judged.migrated - judged.source;
        if (delta < -tolerance) {
          pageShortfalls.push({ slug: page.slug, dimension: dim, source: judged.source,
            migrated: judged.migrated, delta });
          pass = false;
        }
      }
    }

    // The home page, held to "at least as good" on every dimension it measured.
    const homePage = (pages ?? []).find((p) => STRICT_ROUTES.has(String(p.slug ?? "").replace(/\/+$/, "")));
    const home = [];
    for (const [dim, judged] of Object.entries(homePage?.profiles?.[profile]?.dimensions ?? {})) {
      if (typeof judged?.source !== "number" || typeof judged?.migrated !== "number") continue;
      const delta = judged.migrated - judged.source;
      if (delta < 0) {
        home.push({ dimension: dim, source: judged.source, migrated: judged.migrated, delta });
        pass = false;
      }
    }
    byProfile[profile] = { aggregate, shortfalls, pageShortfalls, home };
  }
  return { pass, profiles: byProfile, tolerance };
}
