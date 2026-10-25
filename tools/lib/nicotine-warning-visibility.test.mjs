// The nicotine-warning visibility gate's verdict: a warning a visitor cannot see fails the page and
// names what covers it and where (fb-1791920380756-dcmfnh). The in-page probe is exercised against
// real Chrome in apps/storefront/e2e/nicotine-warning-visibility.browser.spec.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  NICOTINE_WARNING_VIEWPORTS,
  judgeNicotineWarningVisibility,
  nicotineWarningDeclaration,
} from "./nicotine-warning-visibility.mjs";

const DECLARED = nicotineWarningDeclaration({ compliance: { nicotineWarning: true } });

const seen = (where) => ({ where, x: 10, y: 10, onScreen: true, seen: true, hit: "p.container-prose", ageGate: false, covering: null });
const coveredBy = (where, hit, covering) => ({ where, x: 10, y: 10, onScreen: true, seen: false, hit, ageGate: false, covering });

const HEADER = { selector: "header.site-header", position: "fixed", zIndex: "100" };

function warning(samples, overrides = {}) {
  return {
    index: 0,
    variant: "bar",
    rect: { x: 0, y: 0, width: 390, height: 50 },
    scrollY: 0,
    display: "block",
    visibility: "visible",
    textVisibility: "visible",
    opacity: 1,
    fontSizePx: 14,
    contrast: 15.2,
    samples,
    ...overrides,
  };
}

const visible = () => warning(["centre", "text line 1 start", "text line 1 middle", "text line 1 end"].map(seen));

function runs(byName, declaration = DECLARED) {
  return declaration.viewports.map((viewport) => ({
    viewport,
    probe: { viewport, warnings: byName[viewport.name] ?? [visible()] },
  }));
}

test("a warning seen at every sample point, at every width, passes", () => {
  const verdict = judgeNicotineWarningVisibility(runs({}), DECLARED);
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.findings, []);
});

test("a store that does not declare the warning is not applicable and is not measured", () => {
  for (const config of [{}, { compliance: {} }, { compliance: { nicotineWarning: false } }, null]) {
    const declaration = nicotineWarningDeclaration(config);
    assert.deepEqual(declaration, { declared: false, viewports: [], problems: [] });
    const verdict = judgeNicotineWarningVisibility([], declaration);
    assert.deepEqual({ pass: verdict.pass, applicable: verdict.applicable }, { pass: true, applicable: false });
  }
});

test("a store that declares the warning fails a page that renders none: declared but not rendered", () => {
  const empty = DECLARED.viewports.map((viewport) => ({ viewport, probe: { viewport, warnings: [] } }));
  const verdict = judgeNicotineWarningVisibility(empty, DECLARED);
  assert.equal(verdict.applicable, true);
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.findings.map((f) => f.kind), DECLARED.viewports.map(() => "not-rendered"));
  assert.match(verdict.findings[0].detail, /declares compliance\.nicotineWarning but no nicotine warning .* renders at phone 390×844/);
});

test("declared check widths add to the defaults, never replace them, and are judged like any width", () => {
  const declaration = nicotineWarningDeclaration({ compliance: { nicotineWarning: { preset: "dark", checkWidthsPx: [800, 390, 1180] } } });
  assert.deepEqual(declaration.problems, []);
  assert.deepEqual(declaration.viewports.map((v) => v.width), [390, 768, 800, 1024, 1180, 1440]);
  for (const def of NICOTINE_WARNING_VIEWPORTS) assert.ok(declaration.viewports.includes(def), `${def.name} kept`);
  assert.deepEqual(declaration.viewports.find((v) => v.width === 800), { name: "declared", width: 800, height: 1024 });

  // Covered only at the declared 800px breakpoint, where the store's header becomes fixed.
  const covered = warning([coveredBy("centre", "header.site-header", HEADER)]);
  const verdict = judgeNicotineWarningVisibility(
    declaration.viewports.map((viewport) => ({
      viewport,
      probe: { viewport, warnings: [viewport.width === 800 ? covered : visible()] },
    })),
    declaration,
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.findings.map((f) => [f.kind, f.viewport]), [["covered", "declared 800×1024"]]);
});

test("an unusable declared check width fails the gate rather than silently checking less", () => {
  for (const checkWidthsPx of [[], "800", [800.5], [100], [99999], [null]]) {
    const declaration = nicotineWarningDeclaration({ compliance: { nicotineWarning: { checkWidthsPx } } });
    assert.equal(declaration.declared, true);
    assert.deepEqual(declaration.viewports, [...NICOTINE_WARNING_VIEWPORTS], JSON.stringify(checkWidthsPx));
    const verdict = judgeNicotineWarningVisibility(runs({}, declaration), declaration);
    assert.equal(verdict.pass, false, JSON.stringify(checkWidthsPx));
    assert.deepEqual(verdict.findings.map((f) => f.kind), ["declaration"]);
    assert.match(verdict.findings[0].detail, /checkWidthsPx/);
  }
});

test("a fixed header covering the bar on phones fails, naming the header, the topmost element and the width", () => {
  const covered = warning([
    coveredBy("centre", "img.logo", HEADER),
    coveredBy("text line 1 start", "a.brand", HEADER),
    coveredBy("text line 1 middle", "img.logo", HEADER),
    seen("text line 1 end"),
  ]);
  const verdict = judgeNicotineWarningVisibility(runs({ phone: [covered] }), DECLARED);
  assert.equal(verdict.pass, false);
  const [finding, ...rest] = verdict.findings;
  assert.equal(rest.length, 0);
  assert.equal(finding.kind, "covered");
  assert.equal(finding.viewport, "phone 390×844");
  assert.match(finding.detail, /covered by header\.site-header \(position: fixed, z-index: 100\) at 3 of 4 sample points/);
  assert.match(finding.detail, /topmost element there is img\.logo, a\.brand/);
  assert.match(finding.detail, /body \{ padding-top: <header height> \}/);
});

test("every other way a warning goes unseen is its own finding", () => {
  const cases = [
    [warning([seen("centre")], { opacity: 0.4 }), "faded"],
    [warning([seen("centre")], { fontSizePx: 9 }), "shrunk"],
    [warning([seen("centre")], { contrast: 2.1 }), "low-contrast"],
    [warning([{ ...seen("centre"), onScreen: false, seen: false, hit: null }]), "off-screen"],
    [warning([{ ...seen("centre"), seen: false, ageGate: true, hit: "div" }]), "age-gate-open"],
    [warning([seen("centre")], { visibility: "hidden" }), "hidden"],
  ];
  for (const [w, kind] of cases) {
    const verdict = judgeNicotineWarningVisibility(runs({ tablet: [w] }), DECLARED);
    assert.equal(verdict.pass, false, kind);
    assert.deepEqual(verdict.findings.map((f) => f.kind), [kind]);
    assert.equal(verdict.findings[0].viewport, "tablet 768×1024");
  }
});

test("a warning absent at one width, or a width that could not be measured, fails closed", () => {
  const absent = judgeNicotineWarningVisibility(runs({ desktop: [] }), DECLARED);
  assert.equal(absent.pass, false);
  assert.deepEqual(absent.findings.map((f) => [f.kind, f.viewport]), [["not-rendered", "desktop 1440×900"]]);

  const block = { ...visible(), index: 1, variant: "block" };
  const missing = judgeNicotineWarningVisibility(runs({ phone: [visible(), block] }), DECLARED);
  assert.equal(missing.pass, false);
  assert.deepEqual(missing.findings.map((f) => f.kind), ["missing", "missing", "missing"]);

  const errored = runs({});
  errored[0] = { viewport: errored[0].viewport, error: "navigation timeout" };
  const unmeasured = judgeNicotineWarningVisibility(errored, DECLARED);
  assert.equal(unmeasured.pass, false);
  assert.deepEqual(unmeasured.findings.map((f) => f.kind), ["unmeasured"]);
});
