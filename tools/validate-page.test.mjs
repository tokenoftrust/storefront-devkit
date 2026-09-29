// End-to-end over validate-page.sh's commerce-boundary scan: serve a page, run the real script,
// read the real JSON. The scan is shell and the issue text it feeds is JavaScript, so a pin that
// only reads the script's source proves the two agree about strings, not about counts.
//
// It counts OCCURRENCES. A rendered page arrives minified onto a single line, so a line-counting
// scan reports 1 for everything it finds — nineteen quick-view buttons as "1 leak", forty leaked
// secrets as one possible private token. Only a real render pins that.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./validate-page.sh", import.meta.url));

/** One minified line, the way a rendered page actually arrives. */
const page = (body) =>
  `<!doctype html><html lang="en"><head><link rel="canonical" href="https://x.test/"/>` +
  `<meta name="description" content="d"/>` +
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization"}</script>` +
  `</head><body>${body}</body></html>`;

/** What the platform's own <ProductCard> emits: one wired quick-view button per card. */
const quickViewCards = (n) =>
  Array.from({ length: n }, (_, i) => `<button data-quickview='{"handle":"p${i}"}'>Quick view</button>`).join("");

/**
 * A sitemap in the shape this platform really emits (the platform sitemap route):
 * the homepage with a trailing slash, content pages WITHOUT one, blog routes WITH one — pretty
 * printed across many lines, absolute locs under the tenant's canonical base.
 */
const sitemapXml = (origin, locs) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  locs.map((loc) => `  <url>\n    <loc>${origin}${loc}</loc>\n  </url>`).join("\n") +
  `\n</urlset>\n`;

/** Every loc a correctly published tenant carries, homepage included. */
const FULL_LOCS = ["/", "/collections", "/products/p1", "/about", "/shipping-returns", "/blog/"];
/** The same tenant with the homepage genuinely missing — the case a "/" slug must catch. */
const NO_HOME_LOCS = FULL_LOCS.filter((loc) => loc !== "/");

let server;
let base;
let artifacts;
/** Homepage absent from the sitemap; everything else identical. */
let noHomeServer;
let noHomeBase;
/** Canonical base carries a path prefix, the way a local/preview host serves a tenant. */
let prefixServer;
let prefixBase;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/header-proof") {
      const gateAllowed = req.headers["x-test-gate"] === "allowed";
      const cookies = req.headers.cookie ?? "";
      const previewAllowed = cookies.includes("tot_preview_version=fixture-v1")
        && cookies.includes("tot_preview=fixture-token");
      res.writeHead(gateAllowed && previewAllowed ? 200 : 403, {
        "content-type": "text/html",
      });
      res.end(page("header proof"));
      return;
    }
    if (url.pathname === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(sitemapXml(`http://localhost`, FULL_LOCS));
      return;
    }
    // The commerce-boundary invariant both modes share: unknown handles must not resolve.
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(quickViewCards(19)));
      return;
    }
    if (url.pathname === "/faked") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        page(
          `<button>Add to Cart</button><div class="mini-cart"></div>` +
            `<script type="application/ld+json">{"@type":"Product","name":"x"}</script>` +
            `<script type="application/ld+json">{"@type": "Product","name":"y"}</script>`,
        ),
      );
      return;
    }
    // A hybrid commerce tenant's live store answers these; unknown handles still 404.
    if (url.pathname === "/collections" || url.pathname === "/search" || url.pathname === "/saved") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(""));
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end(page("not found"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  // Sitemap-only fixtures: every other route 404s, which no sitemap assertion reads.
  const sitemapOnly = (body) =>
    createServer((req, res) => {
      if (new URL(req.url, "http://localhost").pathname.endsWith("/sitemap.xml")) {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(body());
        return;
      }
      res.writeHead(404, { "content-type": "text/html" });
      res.end(page("not found"));
    });

  noHomeServer = sitemapOnly(() => sitemapXml("http://localhost", NO_HOME_LOCS));
  await new Promise((resolve) => noHomeServer.listen(0, "127.0.0.1", resolve));
  noHomeBase = `http://127.0.0.1:${noHomeServer.address().port}`;

  prefixServer = sitemapOnly(() =>
    sitemapXml("http://localhost/tenant.example", FULL_LOCS),
  );
  await new Promise((resolve) => prefixServer.listen(0, "127.0.0.1", resolve));
  prefixBase = `http://127.0.0.1:${prefixServer.address().port}/tenant.example`;

  artifacts = mkdtempSync(join(tmpdir(), "validate-page-test-"));
});

after(async () => {
  for (const s of [server, noHomeServer, prefixServer]) {
    await new Promise((resolve) => s.close(resolve));
  }
  rmSync(artifacts, { recursive: true, force: true });
});

// Must stay async: the fixture server shares this event loop, so a SYNCHRONOUS child process
// would block the very requests the script under test is waiting on, and the run would hang.
const run = promisify(execFile);
async function validate(slug, mode, pageBase = base, extraEnv = {}) {
  const { stdout } = await run("/bin/bash", [SCRIPT, pageBase, slug, artifacts], {
    encoding: "utf8",
    env: { ...process.env, SM_SITE_TYPE: mode, ...extraEnv },
  });
  return JSON.parse(stdout);
}

test("counts occurrences, not the one line a minified page arrives on", async () => {
  const { gates } = await validate("/", "marketing");
  // The number that proves it: nineteen buttons on a single line.
  assert.equal(gates.boundary.shoppingLeakSignals.quickView, 19);
  assert.equal(gates.boundary.shoppingLeaks, 19);
});

test("the system Bash supports both absent and configured request headers", async () => {
  const withoutHeader = await validate("/header-proof", "marketing");
  const withHeader = await validate("/header-proof", "marketing", base, {
    SM_GATE_HEADER: "X-Test-Gate: allowed",
    SM_PREVIEW_TOKEN: "fixture-token",
    SM_PREVIEW_VERSION: "fixture-v1",
  });
  assert.equal(withoutHeader.http, 403);
  assert.equal(withHeader.http, 200);
});

test("a commerce tenant's own wired quick-view cards do not fail the gate", async () => {
  const { gates } = await validate("/", "commerce");
  // Still reported as evidence — the reader can see the 19 and why they did not count.
  assert.equal(gates.boundary.shoppingLeakSignals.quickView, 19);
  assert.deepEqual(gates.boundary.platformEmittedSignals, ["quickView"]);
  assert.equal(gates.boundary.shoppingLeaks, 0);
  assert.equal(gates.boundary.pass, true, "counting these would block every commerce tenant");
});

test("the same page still fails for a marketing tenant, where nothing backs those cards", async () => {
  const { gates } = await validate("/", "marketing");
  assert.deepEqual(gates.boundary.platformEmittedSignals, []);
  assert.equal(gates.boundary.pass, false);
});

// --- sitemap gate ------------------------------------------------------------------------
// Callers normalize every slug to a trailing slash (validate-site.mjs `normalizeSlug`) and the
// sitemap emits content pages without one, so a literal match on the slug found NOTHING for
// every content page while "/" matched every <loc> in the file and could never fail. Both
// halves are pinned here, against the real script and a real sitemap shape.

test("a content page listed without a trailing slash is found from a trailing-slash slug", async () => {
  const { gates } = await validate("/about/", "commerce");
  assert.equal(gates.sitemap.hasSlug, true, "the sitemap lists /about; the slug arrived as /about/");
  assert.equal(gates.sitemap.pass, true);
});

test("a multi-segment content slug is found the same way", async () => {
  const { gates } = await validate("/shipping-returns/", "commerce");
  assert.equal(gates.sitemap.hasSlug, true);
});

test("the root slug matches the homepage and nothing else", async () => {
  // The vacuity that hid this bug: "/" is a substring of every loc, so a root page could not
  // fail whatever the sitemap held. Same fixture minus the homepage must now fail.
  assert.equal((await validate("/", "commerce")).gates.sitemap.hasSlug, true);
  const missing = await validate("/", "commerce", noHomeBase);
  assert.equal(missing.gates.sitemap.hasSlug, false, "homepage absent from the sitemap must fail");
  assert.equal(missing.gates.sitemap.pass, false);
});

test("a slug sharing a prefix with a listed page is not a match", async () => {
  const { gates } = await validate("/about-us/", "commerce");
  assert.equal(gates.sitemap.hasSlug, false, "/about must not satisfy /about-us");
});

test("a path-prefixed canonical base still resolves the slug", async () => {
  // The sitemap's base is resolved per-request: the prod domain, or this path-prefixed
  // preview/local host. Matching only the bare path would break every local validation run.
  const { gates } = await validate("/about/", "commerce", prefixBase);
  assert.equal(gates.sitemap.hasSlug, true);
  assert.equal((await validate("/", "commerce", prefixBase)).gates.sitemap.hasSlug, true);
  assert.equal(
    (await validate("/about-us/", "commerce", prefixBase)).gates.sitemap.hasSlug,
    false,
    "the prefixed form must be no looser than the bare one",
  );
});

test("commerce URLs fail the gate only where they are not allowed", async () => {
  // The same sitemap, judged by the declared site type: a commerce tenant's catalog is correct
  // output, a marketing tenant's is a leak. The flag the issue text reads must say which.
  const commerce = await validate("/about/", "commerce");
  assert.equal(commerce.gates.sitemap.commerceUrls > 0, true, "fixture must carry commerce URLs");
  assert.equal(commerce.gates.sitemap.commerceUrlsAllowed, true);
  assert.equal(commerce.gates.sitemap.pass, true);

  const marketing = await validate("/about/", "marketing");
  assert.equal(marketing.gates.sitemap.commerceUrlsAllowed, false);
  assert.equal(marketing.gates.sitemap.hasSlug, true);
  assert.equal(marketing.gates.sitemap.pass, false);
});

test("faked commerce is still a blocker on a commerce tenant", async () => {
  // The negative control for the waiver: it must waive quick-view and nothing else.
  const { gates } = await validate("/faked", "commerce");
  assert.deepEqual(gates.boundary.shoppingLeakSignals, {
    productJsonLd: 2, // both `"@type":"Product"` and `"@type": "Product"`
    addToCart: 1,
    miniCart: 1,
    quickView: 0,
  });
  assert.equal(gates.boundary.shoppingLeaks, 4);
  assert.equal(gates.boundary.pass, false);
});
