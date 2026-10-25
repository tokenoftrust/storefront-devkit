// @ts-check
// The platform age gate, as the browser harness sees it.
//
// A regulated tenant's every page opens behind the platform's age gate on a fresh visit: a
// modal dialog in a CLOSED shadow root under a `[data-tot-compliance]` host, with the page
// behind it made inert. A harness that loads each page fresh therefore scores the GATED state
// of every page — axe, keyboard, Lighthouse and the parity verdict all describe the gate and
// an inert page, not the page an affirmed visitor reads. Measured on a fixture serving the real
// gate component: Lighthouse accessibility 93 gated (`landmark-one-main` failing, because the
// inert page exposes no landmark) against 100 for the same page affirmed.
//
// So the harness splits the two states. Every scored pass runs with the gate already affirmed,
// and the gated state is recorded once, separately, as its own advisory `ageGate` record that
// never feeds the page's parity verdict.
//
// Affirmation is the gate's own: it remembers a visitor in localStorage under a key derived
// from the tenant and the minimum age, value "yes". The harness learns that key by watching the
// gate look it up on the fresh load, so nothing here restates how the key is derived or which
// tenant is being measured.

import { withoutScoreVerdict } from "./lighthouse-stability.mjs";

/** The light-DOM host the platform appends for the gate. Its contents are unreachable. */
export const AGE_GATE_HOST_SELECTOR = "[data-tot-compliance]";

/** Every affirmation key the gate reads starts with this. */
export const AGE_GATE_AFFIRMATION_PREFIX = "tot:age-affirmed:";

/** The value the gate stores, and checks for, once a visitor affirms. */
export const AGE_GATE_AFFIRMED_VALUE = "yes";

/**
 * A key the gate itself would read: the prefix, one tenant segment (URI-encoded by the gate, so
 * it never contains a colon), and the minimum age.
 */
const AFFIRMATION_KEY = /^tot:age-affirmed:[^:\s]+:\d{1,3}$/;

/** More than this many distinct keys on one page is not the gate; refuse rather than seed them. */
const MAX_AFFIRMATION_KEYS = 4;

/**
 * The affirmation keys the gate asked localStorage for during a fresh load.
 *
 * Input is every key the page looked up while the harness watched; only well-formed gate keys
 * survive, each once, in lookup order. An over-long list returns nothing: a page reading dozens
 * of keys under the prefix is not the platform gate, and seeding them would affirm something the
 * harness does not understand.
 *
 * @param {unknown} lookups
 * @returns {string[]}
 */
export function affirmationKeysFromLookups(lookups) {
  if (!Array.isArray(lookups)) return [];
  const keys = [];
  for (const key of lookups) {
    if (typeof key !== "string" || !AFFIRMATION_KEY.test(key) || keys.includes(key)) continue;
    keys.push(key);
  }
  return keys.length > MAX_AFFIRMATION_KEYS ? [] : keys;
}

/**
 * What the run measured, in plain words, so a reader never has to infer which state a score
 * describes.
 *
 * `verified` is the harness's own check on the first affirmed load: false means the gate was
 * still blocking after seeding, so the affirmation did not take.
 *
 * @param {{present: boolean, keys: string[], verified?: boolean | null}} input
 * @returns {{present: boolean, affirmed: boolean, measuredState: "no-age-gate" | "affirmed" | "gated", keys: string[], note: string}}
 */
export function describeAffirmation({ present, keys, verified = null }) {
  if (!present) {
    return {
      present: false,
      affirmed: false,
      measuredState: "no-age-gate",
      keys: [],
      note: "No platform age gate on this page; every pass measured the page as served.",
    };
  }
  if (keys.length > 0 && verified !== false) {
    return {
      present: true,
      affirmed: true,
      measuredState: "affirmed",
      keys,
      note:
        "This page opens behind the platform age gate on a fresh visit. The screenshot, axe," +
        " keyboard, mobile, UX and Lighthouse passes ran with the gate already affirmed, so their" +
        " scores describe the page an affirmed visitor sees. The CSP pass and the separate" +
        " `ageGate` record ran with the gate open.",
    };
  }
  const why = keys.length === 0
    ? "the gate was present but the harness did not see it read an affirmation key"
    : "the gate was still blocking the page after the affirmation was seeded";
  return {
    present: true,
    affirmed: false,
    measuredState: "gated",
    keys,
    note:
      `This page opens behind the platform age gate and could not be affirmed (${why}). Every` +
      " pass measured the GATED page — the dialog over an inert page — so its scores are not the" +
      " page an affirmed visitor sees and Lighthouse parity is not judged.",
  };
}

/**
 * @typedef {{
 *   present: boolean,
 *   blocking: boolean,
 *   dialog: {count: number, name: string, modal: boolean},
 *   focus: {presses: number, contained: number, escapedTo: string[]},
 *   background: {focusable: number, focusableSamples?: string[], mainPresent: boolean, mainExposed: boolean},
 *   axe: {critical: number, serious: number, moderate?: number, minor?: number},
 * }} AgeGateObservation
 */

const CHECK_TITLES = {
  blocking:
    "The age gate was present but not blocking on a fresh visit, so a first-time visitor was never asked.",
  dialog:
    "The gate is not exposed as one named, modal dialog, so assistive technology cannot tell the visitor what is being asked.",
  focusContained:
    "Keyboard focus left the age gate while it was open, so a keyboard visitor can reach the page behind it.",
  backgroundInert:
    "Controls behind the open age gate are still focusable, so the page behind it is interactive.",
  mainLandmark:
    "The page's <main> landmark is not exposed while the gate is open, so assistive technology reads a page with no main content (Lighthouse landmark-one-main).",
  axe:
    "axe reports critical or serious violations on the gated page.",
};

/**
 * Judge the gated state of a page.
 *
 * Every check is about the PLATFORM's gate — a tenant cannot change it — so every finding is
 * owned by the platform. The record is advisory to the page: it is reported on its own and never
 * feeds the page's pass or its parity verdict.
 *
 * @param {AgeGateObservation} observation
 * @returns {{pass: boolean, checks: Record<string, boolean>, failedChecks: string[], findings: Array<{id: string, owner: "platform", kind: "age-gate", check: string, title: string}>}}
 */
export function judgeAgeGate(observation) {
  const { blocking, dialog, focus, background, axe } = observation;
  const checks = {
    blocking: blocking === true,
    dialog: dialog?.count === 1 && Boolean(dialog?.name?.trim()) && dialog?.modal === true,
    focusContained: (focus?.presses ?? 0) > 0 && focus.contained === focus.presses,
    backgroundInert: background?.focusable === 0,
    // A page with no <main> at all is the page's defect, caught by the `ux` gate on the affirmed
    // page; here the question is only whether the gate hides one that exists.
    mainLandmark: background?.mainPresent !== true || background?.mainExposed === true,
    axe: (axe?.critical ?? 0) === 0 && (axe?.serious ?? 0) === 0,
  };
  const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    pass: failedChecks.length === 0,
    checks,
    failedChecks,
    findings: failedChecks.map((check) => ({
      id: `age-gate-${check}`,
      owner: "platform",
      kind: "age-gate",
      check,
      title: CHECK_TITLES[/** @type {keyof typeof CHECK_TITLES} */ (check)],
    })),
  };
}

/**
 * A Lighthouse result that scored the gate instead of the page is not a measurement of the page.
 *
 * When the page has a gate and either the run could not be affirmed or a profile's own browser
 * could not be seeded, that profile's numbers describe the gate over an inert page — exactly the
 * state that reads as an accessibility "regression" against a source that had no gate in front
 * of it. Those profiles, and the combined record, lose their parity verdict (`age-gate-open`,
 * every category) and carry a platform finding saying why. The measurement itself stays, so a
 * reader can see what was rejected.
 *
 * A skipped run, a page with no gate, and a fully affirmed run pass through unchanged.
 *
 * @param {any} perf the combined record runLighthouse returns
 * @param {{present: boolean, affirmed: boolean}} affirmation
 * @returns {any}
 */
export function gatedLighthouseUnmeasured(perf, affirmation) {
  if (!perf || perf.skipped === true || !affirmation?.present) return perf;
  const profiles = perf.profiles ?? {};
  const open = Object.entries(profiles)
    .filter(([, run]) => !affirmation.affirmed || run?.ageGateState !== "affirmed")
    .map(([profile]) => profile);
  if (open.length === 0) return perf;
  const finding = {
    id: "lighthouse-age-gate-open",
    owner: "platform",
    kind: "lighthouse-age-gate-open",
    categories: [],
    title:
      `Lighthouse scored the platform age gate, not the page, on ${open.join(" and ")}: the gate` +
      " could not be affirmed for that run. Its scores describe the dialog over an inert page and" +
      " are not judged against the source. This is a harness fault, not a tenant defect.",
    urls: [],
  };
  /** @param {any} run */
  const voided = (run) => {
    const next = withoutScoreVerdict(run, "age-gate-open");
    return { ...next, findings: [...(next.findings ?? []), finding] };
  };
  const nextProfiles = Object.fromEntries(
    Object.entries(profiles).map(([profile, run]) => [profile, open.includes(profile) ? voided(run) : run]),
  );
  return {
    ...voided(perf),
    profiles: nextProfiles,
    unmeasuredProfiles: [
      ...(perf.unmeasuredProfiles ?? [])
        .filter((/** @type {string} */ entry) => !open.some((profile) => entry.startsWith(`${profile}:`))),
      ...open.map((profile) => `${profile}:age-gate-open`),
    ],
  };
}
