/**
 * Is the FDA nicotine warning actually SEEN — not just present in the DOM?
 *
 * The platform renders the warning with inline `!important` styling, so no tenant stylesheet can
 * hide, move, clip, fade or restyle it. What styling cannot stop is another element painting over
 * it: a header pinned with `position: fixed; top: 0` sits on top of a warning rendered at the top
 * of the page, and `display`/`visibility`/box-size checks all still read "visible". This measures
 * what a visitor sees instead: at each viewport the warning must be on screen at full opacity,
 * and the topmost element at its centre and along every line of its text must be the warning
 * itself. A covered warning names the element covering it and the viewport it was covered at.
 *
 * Whether the gate applies comes from the store's declaration, never from the page: a store that
 * declares `compliance.nicotineWarning` must show the warning on every page, so a page that
 * renders none fails ("declared but not rendered"); a store that does not declare it is not
 * judged. The store may add its own breakpoints (`checkWidthsPx`) to the widths checked; it can
 * never remove one.
 *
 * `probeNicotineWarnings` runs in the page (it takes its inputs as arguments and closes over
 * nothing); `judgeNicotineWarningVisibility` turns per-viewport probes into a gate.
 */
import { nicotineWarningCheckWidths, resolveNicotineWarning } from "./declared-config.mjs";

export const NICOTINE_WARNING_SELECTOR = '[data-compliance="nicotine-warning"]';

/** The platform age gate's host. A sample point landing on it means the gate was still open. */
export const NICOTINE_AGE_GATE_SELECTOR = "[data-tot-compliance]";

/**
 * Phone, tablet, small laptop and desktop. Headers commonly switch to `position: fixed` below a
 * tablet breakpoint, so the narrow widths are where a covered warning is found.
 */
export const NICOTINE_WARNING_VIEWPORTS = Object.freeze([
  Object.freeze({ name: "phone", width: 390, height: 844 }),
  Object.freeze({ name: "tablet", width: 768, height: 1024 }),
  Object.freeze({ name: "laptop", width: 1024, height: 768 }),
  Object.freeze({ name: "desktop", width: 1440, height: 900 }),
]);

/** The conspicuity floor the renderer enforces (packages/cli declared-config CONSPICUITY_FLOOR). */
export const NICOTINE_WARNING_FLOOR = Object.freeze({ contrast: 7, fontSizePx: 12 });

/**
 * @typedef {{ declared: boolean, viewports: Viewport[], problems: string[] }} NicotineWarningDeclaration
 */

/**
 * What the store's `.tot/config.json` asks of this gate: whether the warning is declared, the
 * viewports it is checked at (the defaults plus every declared `checkWidthsPx` width, each at the
 * height of the default viewport nearest its width), and why a declared value is unusable.
 * @param {Record<string, any> | null | undefined} config the store's parsed `.tot/config.json`
 * @returns {NicotineWarningDeclaration}
 */
export function nicotineWarningDeclaration(config) {
  const compliance = config?.compliance;
  const declaration = compliance && typeof compliance === "object" ? compliance.nicotineWarning : undefined;
  if (!resolveNicotineWarning(declaration).enabled) return { declared: false, viewports: [], problems: [] };
  const { widths, problems } = nicotineWarningCheckWidths(declaration);
  /** @type {Viewport[]} */
  const viewports = [...NICOTINE_WARNING_VIEWPORTS];
  for (const width of widths) {
    if (viewports.some((v) => v.width === width)) continue;
    const nearest = NICOTINE_WARNING_VIEWPORTS.reduce((a, b) => (Math.abs(b.width - width) < Math.abs(a.width - width) ? b : a));
    viewports.push({ name: "declared", width, height: nearest.height });
  }
  return { declared: true, viewports: viewports.sort((a, b) => a.width - b.width), problems };
}

/**
 * Measure every nicotine warning on the page. Evaluated in the browser.
 *
 * Hit-testing skips `pointer-events: none`, so a decorative overlay could cover the warning and
 * be invisible to `elementFromPoint`. The probe forces hit-testing on for the page while it
 * samples (the age gate's host keeps its own inline `pointer-events: none !important`) and
 * removes that override before returning. The override is a constructed stylesheet because a
 * storefront's CSP refuses an injected `<style>` element.
 * @param {{ selector: string, ageGateSelector: string }} input
 */
export function probeNicotineWarnings({ selector, ageGateSelector }) {
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return null;
    let out = el.tagName.toLowerCase();
    if (el.id) out += `#${el.id}`;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    if (cls.length) out += `.${cls.join(".")}`;
    return out;
  };
  // The element to name is the pinned chrome the hit sits in: the outermost fixed or sticky
  // ancestor (a logo positioned inside a fixed header is the header's doing), else the nearest
  // absolutely positioned one, else the hit itself.
  const coveringChrome = (el) => {
    let pinned = null;
    let absolute = null;
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const position = getComputedStyle(n).position;
      if (position === "fixed" || position === "sticky") pinned = n;
      else if (position === "absolute" && !absolute) absolute = n;
    }
    const chosen = pinned ?? absolute ?? el;
    const cs = getComputedStyle(chosen);
    return { selector: describe(chosen), position: cs.position, zIndex: cs.zIndex };
  };
  const rgb = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value || "");
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = ({ r, g, b }) => {
    const lin = (c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const backgroundOf = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  // A constructed sheet: the page's CSP refuses an injected <style> element, but not CSSOM.
  const override = new CSSStyleSheet();
  override.replaceSync("*{pointer-events:auto!important}");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, override];
  const startX = window.scrollX;
  const startY = window.scrollY;
  try {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const warnings = Array.from(document.querySelectorAll(selector)).map((el, index) => {
      const initial = el.getBoundingClientRect();
      // A warning below the first screen (the product-page block) is judged where a visitor
      // reads it: scrolled to the middle of the viewport. One already on screen is judged where
      // it is, which for the bar is the top of the page as it loads.
      if (initial.top < 0 || initial.bottom > vh) el.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = el.getBoundingClientRect();
      const textEl = el.querySelector("p") || el;
      const points = [{ where: "centre", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }];
      const range = document.createRange();
      range.selectNodeContents(textEl);
      Array.from(range.getClientRects())
        .filter((r) => r.width > 0 && r.height > 0)
        .slice(0, 4)
        .forEach((r, line) => {
          for (const [label, fx] of /** @type {Array<[string, number]>} */ ([["start", 0.05], ["middle", 0.5], ["end", 0.95]])) {
            points.push({ where: `text line ${line + 1} ${label}`, x: r.left + r.width * fx, y: r.top + r.height / 2 });
          }
        });
      const samples = points.map((p) => {
        const onScreen = p.x >= 0 && p.y >= 0 && p.x < vw && p.y < vh;
        const hit = onScreen ? document.elementFromPoint(p.x, p.y) : null;
        const ageGate = !!hit && !!hit.closest && !!hit.closest(ageGateSelector);
        return {
          where: p.where,
          x: Math.round(p.x),
          y: Math.round(p.y),
          onScreen,
          seen: !!hit && el.contains(hit),
          hit: describe(hit),
          ageGate,
          covering: hit && !el.contains(hit) && !ageGate ? coveringChrome(hit) : null,
        };
      });
      let opacity = 1;
      for (let n = /** @type {Element | null} */ (el); n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
      const textStyle = getComputedStyle(textEl);
      const color = rgb(textStyle.color);
      const background = backgroundOf(el);
      const contrast = color
        ? (Math.max(luminance(color), luminance(background)) + 0.05) / (Math.min(luminance(color), luminance(background)) + 0.05)
        : null;
      const result = {
        index,
        variant: el.querySelector("p.container-prose") ? "bar" : "block",
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
        scrollY: Math.round(window.scrollY),
        display: getComputedStyle(el).display,
        visibility: getComputedStyle(el).visibility,
        textVisibility: textStyle.visibility,
        opacity: Math.round(opacity * 1000) / 1000,
        fontSizePx: Number.parseFloat(textStyle.fontSize),
        contrast: contrast === null ? null : Math.round(contrast * 100) / 100,
        samples,
      };
      window.scrollTo(startX, startY);
      return result;
    });
    return { viewport: { width: vw, height: vh }, warnings };
  } finally {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== override);
    window.scrollTo(startX, startY);
  }
}

/**
 * The fix a covered warning needs, in the words of the compliance devbook.
 * @param {{ position: string }} covering
 */
function remedyFor(covering) {
  if (covering.position === "fixed" || covering.position === "sticky") {
    return `Offset the page below the ${covering.position} element at this width (for a header pinned to the top: ` +
      "`body { padding-top: <header height> }` inside the same media query), so the warning renders below it. " +
      "Never restyle or move the warning itself.";
  }
  return "Move the covering element off the warning, or stop it overlapping the top of the page.";
}

/**
 * @typedef {{ name: string, width: number, height: number }} Viewport
 * @typedef {{ viewport: Viewport, probe?: ReturnType<typeof probeNicotineWarnings> | null, error?: string }} ViewportRun
 */

/**
 * Judge per-viewport probes against the store's declaration. A store that does not declare the
 * warning is not applicable. A declaring store's page must render at least one warning at every
 * viewport, every viewport must have measured, every warning must be present at every viewport,
 * and each must be seen at every sample point, on screen, at full opacity, above the conspicuity
 * floor. An unusable declared value fails the gate: the widths it meant are unchecked.
 * @param {ViewportRun[]} runs
 * @param {NicotineWarningDeclaration} declaration
 */
export function judgeNicotineWarningVisibility(runs, declaration) {
  if (!declaration.declared) {
    return { pass: true, applicable: false, declared: false, findings: [], viewports: runs.map(summarizeRun) };
  }
  /** @type {Array<{ viewport: string | null, warning: number | null, variant: string | null, kind: string, detail: string, covering?: object }>} */
  const findings = declaration.problems.map((problem) => ({
    viewport: null, warning: null, variant: null, kind: "declaration",
    detail: `compliance.nicotineWarning in .tot/config.json: ${problem}; the widths it declares are not checked`,
  }));
  const counts = runs.map((run) => run.probe?.warnings?.length ?? 0);
  const expected = Math.max(1, ...counts);
  for (const run of runs) {
    const at = `${run.viewport.name} ${run.viewport.width}×${run.viewport.height}`;
    if (run.error || !run.probe) {
      findings.push({ viewport: at, warning: null, variant: null, kind: "unmeasured", detail: `could not measure the nicotine warning at ${at}: ${run.error ?? "no probe result"}` });
      continue;
    }
    if (run.probe.warnings.length === 0) {
      findings.push({
        viewport: at, warning: null, variant: null, kind: "not-rendered",
        detail: `the store declares compliance.nicotineWarning but no nicotine warning (${NICOTINE_WARNING_SELECTOR}) renders at ${at}: ` +
          "every page of a store that declares it must show it. The platform renders it on every page of a declaring store, so this page " +
          "is served from a build that predates the declaration or bypasses the platform's rendering; rebuild the preview, and report it if it persists",
      });
      continue;
    }
    if (run.probe.warnings.length < expected) {
      findings.push({
        viewport: at, warning: null, variant: null, kind: "missing",
        detail: `${expected - run.probe.warnings.length} nicotine warning(s) rendered at other widths are absent at ${at}`,
      });
    }
    for (const w of run.probe.warnings) {
      const label = `nicotine warning (${w.variant}) at ${at}`;
      const base = { viewport: at, warning: w.index, variant: w.variant };
      if (w.display === "none" || w.visibility !== "visible" || w.textVisibility !== "visible") {
        findings.push({ ...base, kind: "hidden", detail: `${label} is hidden (display ${w.display}, visibility ${w.visibility}, text visibility ${w.textVisibility})` });
        continue;
      }
      if (w.opacity < 0.999) findings.push({ ...base, kind: "faded", detail: `${label} renders at opacity ${w.opacity}; it must be fully opaque` });
      if (Number.isFinite(w.fontSizePx) && w.fontSizePx < NICOTINE_WARNING_FLOOR.fontSizePx) {
        findings.push({ ...base, kind: "shrunk", detail: `${label} text renders at ${w.fontSizePx}px, below the ${NICOTINE_WARNING_FLOOR.fontSizePx}px floor` });
      }
      if (typeof w.contrast === "number" && w.contrast < NICOTINE_WARNING_FLOOR.contrast) {
        findings.push({ ...base, kind: "low-contrast", detail: `${label} text contrast is ${w.contrast}:1, below the ${NICOTINE_WARNING_FLOOR.contrast}:1 floor` });
      }
      const offScreen = w.samples.filter((s) => !s.onScreen);
      if (offScreen.length > 0) {
        findings.push({
          ...base, kind: "off-screen",
          detail: `${label} is off screen at ${offScreen.map((s) => s.where).join(", ")} (box ${w.rect.x},${w.rect.y} ${w.rect.width}×${w.rect.height})`,
        });
      }
      const gated = w.samples.filter((s) => s.ageGate);
      if (gated.length > 0) {
        findings.push({ ...base, kind: "age-gate-open", detail: `${label} could not be judged: the age gate was still open over it` });
      }
      const covered = w.samples.filter((s) => s.onScreen && !s.seen && !s.ageGate);
      if (covered.length > 0) {
        const byChrome = new Map();
        for (const s of covered) {
          const key = s.covering?.selector ?? s.hit ?? "nothing (the point hit no element)";
          if (!byChrome.has(key)) byChrome.set(key, { covering: s.covering, hits: new Set(), where: [] });
          const entry = byChrome.get(key);
          if (s.hit) entry.hits.add(s.hit);
          entry.where.push(s.where);
        }
        for (const [selector, entry] of byChrome) {
          const c = entry.covering;
          const how = c ? ` (position: ${c.position}, z-index: ${c.zIndex})` : "";
          const via = [...entry.hits].filter((h) => h !== selector);
          findings.push({
            ...base, kind: "covered", covering: c ?? undefined,
            detail: `${label} is covered by ${selector}${how} at ${entry.where.length} of ${w.samples.length} sample points ` +
              `(${entry.where.join(", ")})${via.length ? `; the topmost element there is ${via.join(", ")}` : ""}. ` +
              (c ? remedyFor(c) : ""),
          });
        }
      }
    }
  }
  return { pass: findings.length === 0, applicable: true, declared: true, findings, viewports: runs.map(summarizeRun) };
}

/** @param {ViewportRun} run */
function summarizeRun(run) {
  return {
    viewport: run.viewport,
    ...(run.error ? { error: run.error } : {}),
    warnings: (run.probe?.warnings ?? []).map((w) => ({
      variant: w.variant,
      rect: w.rect,
      scrollY: w.scrollY,
      opacity: w.opacity,
      fontSizePx: w.fontSizePx,
      contrast: w.contrast,
      seen: w.samples.filter((s) => s.seen).length,
      samples: w.samples.length,
    })),
  };
}
