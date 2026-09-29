import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHROME_STRUCTURAL_CLASSES,
  SHARED_CHROME_HREF,
  scanChromeSelectors,
  chromeConceptPass,
  inspectChromeConcept,
} from "./style-concept-audit.mjs";

// The chrome-concept gate — fails a tenant that re-authors or inlines
// the shared chrome's structural CSS instead of linking the ONE platform sheet.
// The vocabulary's drift test against the platform's shipped sheet lives with the platform,
// which owns that sheet.

test("the structural chrome vocabulary is a non-empty list of class names", () => {
  assert.ok(CHROME_STRUCTURAL_CLASSES.length > 0);
  for (const cls of CHROME_STRUCTURAL_CLASSES) assert.match(cls, /^[a-z][a-z0-9_-]*$/);
});

test("scanChromeSelectors flags structural chrome but not generic composition atoms", () => {
  // Structural chrome + BEM children/variants are flagged.
  assert.equal(scanChromeSelectors(".site-header{}").length, 1);
  assert.equal(scanChromeSelectors(".age-gate__panel{}").length, 1);
  assert.equal(scanChromeSelectors(".announce-marquee__track span{}").length, 1);
  assert.equal(scanChromeSelectors(".primary-nav .nav-item > a{}").length, 1);
  // Generic atoms the shared sheet also owns are intentionally NOT chrome-keyed,
  // so legitimate tenant page/marketing CSS never false-positives.
  assert.equal(scanChromeSelectors(".container{}.eyebrow{}.link-more{}.btn{}.section{}.hero{}.h-btn{}").length, 0);
});

test("chromeConceptPass: inline chrome always fails; re-authored fails only once adopted", () => {
  assert.equal(chromeConceptPass({ present: false }), true, "no content = vacuously clean");
  // Not yet adopted: re-authored chrome is the migration gap, non-blocking.
  assert.equal(
    chromeConceptPass({ present: true, adopted: false, inlineChromeCount: 0, reauthoredChromeCount: 42 }),
    true,
  );
  // Inline chrome is banned regardless of adoption.
  assert.equal(
    chromeConceptPass({ present: true, adopted: false, inlineChromeCount: 1, reauthoredChromeCount: 0 }),
    false,
  );
  // Adopted the shared sheet but still re-authoring chrome = double ownership = fail.
  assert.equal(
    chromeConceptPass({ present: true, adopted: true, inlineChromeCount: 0, reauthoredChromeCount: 3 }),
    false,
  );
  // Adopted + clean = pass.
  assert.equal(
    chromeConceptPass({ present: true, adopted: true, inlineChromeCount: 0, reauthoredChromeCount: 0 }),
    true,
  );
});

/** Build a throwaway tenant tree under a temp content-dir. */
function makeTenant(contentDir, dirName, { chromeHead, mktCss, homeInline }) {
  const root = join(contentDir, dirName);
  mkdirSync(join(root, "content"), { recursive: true });
  mkdirSync(join(root, "public", "pages"), { recursive: true });
  writeFileSync(join(root, "content", "chrome.html"), `<!doctype html><head>${chromeHead}</head><body></body>`);
  writeFileSync(
    join(root, "content", "home.html"),
    `<!doctype html><head>${homeInline ? `<style>${homeInline}</style>` : ""}</head><body></body>`,
  );
  if (mktCss != null) writeFileSync(join(root, "public", "pages", "mkt.css"), mktCss);
  return root;
}

const CHROME_CSS = ".site-header{position:sticky}.primary-nav a{color:red}.age-gate__panel{padding:1rem}";
const MKT_LINK = (dir) => `<link rel="stylesheet" href="/tenants/${dir}/pages/mkt.css">`;

test("inspectChromeConcept: not-yet-adopted tenant reports re-authored chrome without blocking", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "sm-chrome-"));
  try {
    makeTenant(cdir, "acme.net", { chromeHead: MKT_LINK("acme.net"), mktCss: CHROME_CSS });
    const chrome = await inspectChromeConcept(cdir, "acme"); // bare scope resolves the TLD dir
    assert.equal(chrome.present, true);
    assert.equal(chrome.adopted, false);
    assert.equal(chrome.inlineChromeCount, 0);
    assert.ok(chrome.reauthoredChromeCount >= 3);
    assert.equal(chromeConceptPass(chrome), true);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("inspectChromeConcept: adopted + re-authored mkt.css = BLOCKING fail (double ownership)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "sm-chrome-"));
  try {
    makeTenant(cdir, "acme.net", {
      chromeHead: `<link rel="stylesheet" href="${SHARED_CHROME_HREF}">${MKT_LINK("acme.net")}`,
      mktCss: CHROME_CSS,
    });
    const chrome = await inspectChromeConcept(cdir, "acme");
    assert.equal(chrome.adopted, true);
    assert.ok(chrome.reauthoredChromeCount >= 3);
    assert.equal(chromeConceptPass(chrome), false);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("inspectChromeConcept: inlined chrome CSS = BLOCKING fail even before adoption", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "sm-chrome-"));
  try {
    makeTenant(cdir, "acme.net", {
      chromeHead: MKT_LINK("acme.net"),
      mktCss: ".hero{}", // clean sheet
      homeInline: ".site-footer{background:black}", // structural chrome inlined
    });
    const chrome = await inspectChromeConcept(cdir, "acme");
    assert.ok(chrome.inlineChromeCount >= 1);
    assert.equal(chromeConceptPass(chrome), false);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("inspectChromeConcept: adopted + chrome-free tenant sheet = pass", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "sm-chrome-"));
  try {
    makeTenant(cdir, "acme.net", {
      chromeHead: `<link rel="stylesheet" href="${SHARED_CHROME_HREF}">${MKT_LINK("acme.net")}`,
      mktCss: ".hero{}.band{}.h-btn{}", // marketing atoms only, no structural chrome
    });
    const chrome = await inspectChromeConcept(cdir, "acme");
    assert.equal(chrome.adopted, true);
    assert.equal(chrome.reauthoredChromeCount, 0);
    assert.equal(chrome.inlineChromeCount, 0);
    assert.equal(chromeConceptPass(chrome), true);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

// --- css/readability input resolution -----------------------------------------
// Both gates require `pagesInspected > 0` to pass, so a tenant whose pages the
// walk fails to FIND is indistinguishable, in every emitted metric, from one
// whose pages are clean. Two things are pinned here: the walk resolves a tenant
// dir the same way the chrome gate does (platform test tenants nest under
// `e2e/`), and the gates emit the inspected count so a consumer can tell the
// two states apart.

function runAudit(contentDir, publicDir, tenant) {
  const script = fileURLToPath(new URL("./style-concept-audit.mjs", import.meta.url));
  const out = spawnSync(
    process.execPath,
    [script, "--tenant", tenant, "--content-dir", contentDir, "--public-dir", publicDir],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

function seedTenantPages(contentRoot) {
  mkdirSync(join(contentRoot, "pages-html"), { recursive: true });
  const page = '<html><head><link rel="stylesheet" href="/shared/commerce-chrome.css"></head><body><h1>Hi</h1></body></html>\n';
  writeFileSync(join(contentRoot, "home.html"), page);
  writeFileSync(join(contentRoot, "pages-html", "about.html"), page);
}

test("css/readability: a platform test tenant nested under e2e/ is inspected, not reported as zero pages", () => {
  const dir = mkdtempSync(join(tmpdir(), "style-nested-"));
  try {
    const contentDir = join(dir, "tenants");
    seedTenantPages(join(contentDir, "e2e", "nested.example.test", "content"));
    const result = runAudit(contentDir, join(dir, "public"), "nested.example.test");
    assert.equal(result.summary.pageCount, 2);
    assert.equal(result.gates.css.pagesInspected, 2);
    assert.equal(result.gates.readability.pagesInspected, 2);
    assert.match(result.gates.css.tenantContentDir, /nested\.example\.test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("css/readability: a tenant with no content tree emits pagesInspected 0 and a null dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "style-absent-"));
  try {
    const contentDir = join(dir, "tenants");
    mkdirSync(contentDir, { recursive: true });
    const result = runAudit(contentDir, join(dir, "public"), "absent.example");
    assert.equal(result.gates.css.pass, false);
    assert.equal(result.gates.css.pagesInspected, 0);
    assert.equal(result.gates.css.tenantContentDir, null);
    assert.equal(result.gates.readability.pagesInspected, 0);
    assert.equal(result.gates.readability.tenantContentDir, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- store checkout layout ------------------------------------------------------
// A developer runs this from their own store checkout: content at <store>/content, and a
// /tenants/<tenant>/X href is the store's own <store>/public/X.

function runStoreAudit(storeDir, extra = []) {
  const script = fileURLToPath(new URL("./style-concept-audit.mjs", import.meta.url));
  const out = spawnSync(process.execPath, [script, "--store", storeDir, ...extra], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return { json: JSON.parse(out.stdout), stderr: out.stderr };
}

test("--store: inspects a store checkout and resolves its own /tenants/<tenant>/ sheets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "style-store-"));
  try {
    const store = join(dir, "my-checkout");
    mkdirSync(join(store, ".tot"), { recursive: true });
    writeFileSync(join(store, ".tot", "config.json"), JSON.stringify({ tenant: "shop.example" }));
    seedTenantPages(join(store, "content"));
    mkdirSync(join(store, "public", "pages"), { recursive: true });
    writeFileSync(join(store, "public", "pages", "mkt.css"), CHROME_CSS);
    writeFileSync(join(store, "content", "chrome.html"),
      `<!doctype html><head><link rel="stylesheet" href="${SHARED_CHROME_HREF}">${MKT_LINK("shop.example")}</head></html>`);
    writeFileSync(join(store, "content", "home.html"),
      `<html><head>${MKT_LINK("shop.example")}</head><body><h1>Hi</h1></body></html>\n`);

    const { json, stderr } = runStoreAudit(store);
    assert.ok(
      json.summary.sharedStylesheets.some((sheet) => sheet.path.endsWith(join("my-checkout", "public", "pages", "mkt.css"))),
      "a /tenants/<tenant>/ href was not hashed from <store>/public",
    );
    assert.equal(json.tenant, "shop.example");
    assert.equal(json.gates.css.pagesInspected, 2);
    assert.equal(json.gates.chromeConcept.adopted, true);
    assert.ok(json.gates.chromeConcept.reauthoredChromeCount >= 3,
      "the store's own mkt.css was not resolved from <store>/public");
    assert.match(stderr, /Agency Kit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--store: without .tot/config.json the directory name is the tenant", () => {
  const dir = mkdtempSync(join(tmpdir(), "style-store-"));
  try {
    const store = join(dir, "plain.example");
    seedTenantPages(join(store, "content"));
    const { json } = runStoreAudit(store);
    assert.equal(json.tenant, "plain.example");
    assert.equal(json.gates.css.pagesInspected, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
