#!/usr/bin/env node
/**
 * validate-page-browser.mjs — compact browser validation gates for migrated pages.
 *
 * Usage:
 *   validate-page-browser.mjs <page-base> <slug> [source-url] [artifacts-dir] [--provider cloudflare|cloudfront] [--no-lighthouse] [--lighthouse-profile mobile|desktop|both]
 *
 * stdout: one small JSON summary.
 * disk: screenshots, axe details, Lighthouse JSON, CSP console messages.
 */
import { toolRequire } from "./lib/tool-require.mjs";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  evidenceRouteIdentity,
  findingId,
  providerOwnsAllEvidenceUrls,
  providerOwnsEvidence,
  sanitizeEvidenceText,
  sanitizeEvidenceUrl,
  serializeEvidence,
} from "./browser-evidence.mjs";
import {
  LIGHTHOUSE_CATEGORIES,
  LIGHTHOUSE_STABILITY_RUNS,
  firstPartyNotFoundUrls,
  foldStabilityRuns,
  isChromeExcludedShiftRun,
  shouldRerun,
  UNMEASURED_REASONS,
} from "./lib/lighthouse-stability.mjs";
import { rescoreForChannel } from "./lib/lighthouse-channel-exemptions.mjs";
import {
  GIVEAWAY_CEILING,
  PARITY_TOLERANCE,
  describeParity,
  judgeParity,
} from "./lib/lighthouse-parity.mjs";

const repoRequire = toolRequire;
const { chromium } = repoRequire("playwright-core");

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter(Boolean);

const DEFAULT_ARTIFACT_DIR = "/tmp/sm-browser-validate";
const PIXEL_DIFF_MAX = Number(process.env.SM_PIXEL_DIFF_MAX ?? "0.03");
const MOBILE_BODY_FONT_MIN = Number(process.env.SM_MOBILE_BODY_FONT_MIN ?? "16");
const MOBILE_TEXT_MIN = Number(process.env.SM_MOBILE_TEXT_MIN ?? "14");
const TAP_TARGET_MIN = Number(process.env.SM_TAP_TARGET_MIN ?? "44");
const PERF_LCP_MAX = Number(process.env.SM_PERF_LCP_MAX_MS ?? "2500");
const PERF_TBT_MAX = Number(process.env.SM_PERF_TBT_MAX_MS ?? "200");
const PERF_CLS_MAX = Number(process.env.SM_PERF_CLS_MAX ?? "0.1");

function usage(message) {
  if (message) console.error(message);
  console.error(
    "usage: validate-page-browser.mjs <page-base> <slug> [source-url] [artifacts-dir] [--provider cloudflare|cloudfront] [--no-lighthouse] [--lighthouse-profile mobile|desktop|both]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const positional = [];
  const flags = { noLighthouse: false, lighthouseProfile: "both", provider: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-lighthouse") {
      flags.noLighthouse = true;
      continue;
    }
    if (arg === "--lighthouse-profile") {
      flags.lighthouseProfile = argv[++i];
      continue;
    }
    if (arg === "--provider") {
      flags.provider = argv[++i];
      continue;
    }
    if (arg.startsWith("--")) usage();
    positional.push(arg);
  }
  const [pageBaseArg, slugArg, thirdArg, fourthArg] = positional;
  if (!pageBaseArg || !slugArg || positional.length > 4) usage();
  if (!["mobile", "desktop", "both"].includes(flags.lighthouseProfile)) usage();
  if (flags.provider !== "cloudflare" && flags.provider !== "cloudfront") {
    usage("--provider cloudflare|cloudfront is required");
  }

  const sourceUrl = thirdArg && /^https?:\/\//i.test(thirdArg) ? thirdArg : null;
  const artifactDir = fourthArg ?? (sourceUrl ? DEFAULT_ARTIFACT_DIR : thirdArg) ?? DEFAULT_ARTIFACT_DIR;
  const base = pageBaseArg.replace(/\/$/, "");
  const slug = slugArg.startsWith("/") ? slugArg : `/${slugArg}`;
  // Channel selector: bare urls serve LIVE, which is empty mid-migration.
  //
  // PAGES and ASSETS select the channel differently, and only the page half is covered by
  // `?__preview=`. A tenant's static assets are served version-scoped from R2 and follow the
  // `tot_preview_version` cookie instead, so a run with only the query token renders the page
  // correctly and 404s every image on it. That looks exactly like a broken migration: logo
  // absent, background unstyled, heading metrics off — measured on a live tenant where the
  // assets were in fact published and served fine to a browser carrying the cookie.
  // SM_PREVIEW_VERSION carries the snapshot the assets pointer names (the reconciled commit).
  const previewToken = process.env.SM_PREVIEW_TOKEN;
  const previewVersion = process.env.SM_PREVIEW_VERSION;
  // Source baseline for the parity gate, looked up by this page's slug. A malformed or absent
  // file leaves it null rather than throwing: the gate's own baseline-missing branch reports that
  // with the reason and the remedy, which is more useful than a stack trace mid-validation.
  if (process.env.SM_SOURCE_BASELINE) {
    try {
      const raw = JSON.parse(readFileSync(process.env.SM_SOURCE_BASELINE, "utf8"));
      const table = raw?.results ?? raw ?? {};
      // Match the slug with OR without its trailing slash. The batch runner normalises every slug
      // to a trailing slash (validate-site.mjs normalizeSlug) while a captured baseline keys its
      // routes bare, so a straight lookup misses every route except "/" — which is the one slug
      // normalisation leaves alone, and therefore the one route that appeared to work.
      //
      // Measured 2026-09-21 on a production store: 5 of 8 pages reported `baseline-missing`
      // while their baselines were present in the file. Read as a missing capture, the remedy is
      // to capture one — and doing that after cutover overwrites a real source reading with a
      // post-cutover one, destroying the only answer parity can ever have.
      const bare = slug.length > 1 && slug.endsWith("/") ? slug.slice(0, -1) : slug;
      const withSlash = slug.endsWith("/") ? slug : `${slug}/`;
      const entry = table[slug] ?? table[bare] ?? table[withSlash];
      // Per-form-factor readings when the baseline has them; the legacy single `scores` object
      // otherwise. A baseline captured before this shape existed holds one form factor, named by
      // the file-level `formFactor`, and is still judged correctly by the comparability guard.
      sourceBaselineByFormFactor = entry?.byFormFactor ?? null;
      sourceBaseline = entry?.scores ?? null;
      // The form factor the baseline was CAPTURED at. A desktop run judged against a mobile
      // capture is comparing two different measurements: different viewport, throttling and CPU
      // multiplier, so Lighthouse scores differ systematically between them. capture-source-
      // baseline.mjs already refuses a mixed-form-factor CAPTURE for exactly this reason ("the
      // parity gate would judge a mobile run against a desktop number without knowing") — the
      // symmetric guard was missing on the judging side, which is where it actually bites.
      //
      // Measured 2026-09-21 on a real tenant: a mobile-captured baseline of 90 judged a desktop
      // run of 85 as a -5 REGRESSION on four pages, while the mobile run of the same pages scored
      // 99. Every one of those regressions was an artifact of the comparison, and together they
      // were the remaining cause of the Performance gate failing.
      sourceBaselineFormFactor = typeof raw?.formFactor === "string" ? raw.formFactor : null;
    } catch {
      sourceBaseline = null;
      sourceBaselineFormFactor = null;
      sourceBaselineByFormFactor = null;
    }
  }
  const url = previewToken
    ? `${base}${slug}${slug.includes("?") ? "&" : "?"}__preview=${encodeURIComponent(previewToken)}`
    : `${base}${slug}`;
  const { evidenceSlug, safeName } = evidenceRouteIdentity(slug);
  const previewOnly = (() => {
    try {
      return new URL(url).pathname.includes("/_style-guide/");
    } catch {
      return false;
    }
  })();

  return {
    pageBaseArg,
    slugArg,
    sourceUrl,
    artifactDir,
    base,
    slug,
    evidenceSlug,
    url,
    safeName,
    previewVersion,
    noLighthouse: flags.noLighthouse,
    lighthouseProfile: flags.lighthouseProfile,
    provider: flags.provider,
    previewOnly,
  };
}

function compactErrorMessage(err) {
  const raw = err?.message ?? String(err);
  return sanitizeEvidenceText(raw
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\nBrowser logs:|\nCall log:|\n {2}- </, 1)[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360));
}

/**
 * The asset channel, set once per run. Assets are served version-scoped and the `?__preview=`
 * query token only moves PAGES, so without this every image on an otherwise correct page 404s
 * and the visual gates score a site no human would ever see.
 *
 * BOTH cookies are required and neither alone does anything: `tot_preview_version` selects the
 * snapshot, `tot_preview` authorizes it — the route verifies that token and refuses unless its
 * tenant claim matches the tenant in the URL, so a version id by itself can never serve another
 * tenant's assets.
 *
 * DECLARED HERE, above the call below, deliberately. `setPreviewAssetChannel` is a hoisted
 * function declaration but this is a `let`: declaring it further down left the call in the
 * binding's temporal dead zone, which threw on module load and killed the browser validator
 * outright — every page, no output, and the readiness page reported UNKNOWN across the board
 * rather than an error.
 * @type {{origin: string, versionId: string, token: string} | null}
 */
let previewAssetChannel = null;

/**
 * The source's Lighthouse scores for THIS page — the comparand the parity gate judges against.
 *
 * Declared here for the same reason as the binding above: it is read inside a hoisted function.
 * `SM_SOURCE_BASELINE` names the file captured before cutover; entries are keyed by slug. A run
 * without it judges nothing, which the gate reports as `baseline-missing` and fails, deliberately
 * — the source is reachable only until the hostname flips.
 * @type {Record<string, number> | null}
 */
let sourceBaseline = null;
let sourceBaselineFormFactor = null;
/** @type {Record<string, Record<string, number>>|null} */
let sourceBaselineByFormFactor = null;

const cli = parseArgs(process.argv.slice(2));
const { artifactDir, base, evidenceSlug, url, sourceUrl, safeName } = cli;
// Arm the asset channel before any page is opened — a page created without it 404s its images.
setPreviewAssetChannel(base, cli.previewVersion, process.env.SM_PREVIEW_TOKEN);
const evidenceBase = sanitizeEvidenceUrl(base);
const evidenceUrl = sanitizeEvidenceUrl(url);
const evidenceSourceUrl = sourceUrl ? sanitizeEvidenceUrl(sourceUrl) : null;

function printEvidence(value) {
  console.log(serializeEvidence(value));
}

function chromeExecutablePath() {
  return CHROME_PATHS.find((p) => !!p && existsSync(p));
}

async function loadModule(specifier) {
  const resolved = repoRequire.resolve(specifier);
  try {
    return repoRequire(specifier);
  } catch (err) {
    if (err?.code !== "ERR_REQUIRE_ESM") throw err;
    return import(pathToFileURL(resolved).href);
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not allocate a port"));
      });
    });
  });
}

async function launchBrowser(extra = {}) {
  const executablePath = chromeExecutablePath();
  return chromium.launch(
    executablePath
      ? { headless: true, executablePath, ...extra }
      : { headless: true, channel: "chrome", ...extra },
  );
}

function setPreviewAssetChannel(base, versionId, token) {
  if (!versionId || !token) return;
  try {
    previewAssetChannel = { origin: new URL(base).origin, versionId, token };
  } catch {
    previewAssetChannel = null;
  }
}

/** Every page in this run must carry the asset channel, or its images silently 404. */
async function newPageWithPreview(browser, opts) {
  const page = await browser.newPage(opts);
  if (previewAssetChannel) {
    const { origin, versionId, token } = previewAssetChannel;
    await page.context().addCookies([
      { name: "tot_preview_version", value: versionId, url: origin },
      { name: "tot_preview", value: token, url: origin },
    ]).catch(() => undefined);
  }
  return page;
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => undefined);
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    document.querySelectorAll(".reveal,[data-reveal]").forEach((el) => {
      el.classList.add("in");
    });
  }).catch(() => undefined);
  await page.waitForTimeout(250);
}

async function capturePage(browser, pageUrl, screenshotPath) {
  const page = await newPageWithPreview(browser,{
    viewport: { width: 1365, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  const consoleErrors = [];
  const consoleMessages = [];
  const failedResponses = [];
  page.on("console", (msg) => {
    const type = msg.type();
    const safeText = sanitizeEvidenceText(msg.text()).slice(0, 240);
    if (type === "error") consoleErrors.push(safeText);
    if (type === "error" || type === "warning") {
      consoleMessages.push({ type, text: safeText });
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push({ url: sanitizeEvidenceUrl(response.url()), status: response.status() });
  });
  page.on("requestfailed", (request) => {
    failedResponses.push({ url: sanitizeEvidenceUrl(request.url()), error: request.failure()?.errorText ?? "request failed" });
  });

  try {
    const response = await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await settle(page);
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
      animations: "disabled",
    });
    const computed = await page.evaluate(() => {
      const read = (el) => {
        if (!el) return null;
        const style = getComputedStyle(el);
        return {
          text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          color: style.color,
        };
      };
      const logo = /** @type {HTMLImageElement | null} */ (document.querySelector(".brand img, header img, img[alt*='Token of Trust'], img"));
      return {
        title: document.title,
        h1: read(document.querySelector("h1")),
        body: { backgroundColor: getComputedStyle(document.body).backgroundColor },
        logo: logo
          ? {
              complete: logo.complete,
              naturalWidth: logo.naturalWidth,
              naturalHeight: logo.naturalHeight,
              src: logo.currentSrc || logo.src || "",
            }
          : null,
      };
    });
    return {
      http: response?.status() ?? 0,
      screenshot: screenshotPath,
      computed,
      consoleErrors,
      consoleMessages,
      failedResponses,
    };
  } finally {
    await page.close();
  }
}

function px(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace("px", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function compactText(value, max = 160) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function gateMeta(gate, { required = true, applicable = true, reason = /** @type {string | null} */ (null) } = {}) {
  return {
    ...gate,
    required,
    applicable,
    ...(reason ? { reason } : {}),
  };
}

async function writeGateArtifact(artifactPath, gate) {
  await writeFile(artifactPath, serializeEvidence(gate));
  return gate;
}

function gatePassValue(gate) {
  if (!gate || gate.required === false || gate.applicable === false) return true;
  return gate.pass === true;
}

async function compareScreenshots(browser, targetPath, sourcePath) {
  if (!sourcePath) return null;
  const [targetBytes, sourceBytes] = await Promise.all([
    readFile(targetPath),
    readFile(sourcePath),
  ]);
  const comparePage = await newPageWithPreview(browser,{ viewport: { width: 64, height: 64 } });
  try {
    return await comparePage.evaluate(
      async ({ targetPng, sourcePng }) => {
        const load = (src) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
          });
        const [target, source] = await Promise.all([load(targetPng), load(sourcePng)]);
        const w = Math.min(target.naturalWidth, source.naturalWidth);
        const h = Math.min(target.naturalHeight, source.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d", { willReadFrequently: true }));
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(target, 0, 0, w, h);
        const a = ctx.getImageData(0, 0, w, h).data;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(source, 0, 0, w, h);
        const b = ctx.getImageData(0, 0, w, h).data;
        const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / 250000)));
        let compared = 0;
        let mismatched = 0;
        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const i = (y * w + x) * 4;
            const delta =
              Math.abs(a[i] - b[i]) +
              Math.abs(a[i + 1] - b[i + 1]) +
              Math.abs(a[i + 2] - b[i + 2]);
            compared += 1;
            if (delta > 48) mismatched += 1;
          }
        }
        const targetArea = target.naturalWidth * target.naturalHeight;
        const sourceArea = source.naturalWidth * source.naturalHeight;
        const dimensionDelta = Math.abs(targetArea - sourceArea) / Math.max(targetArea, sourceArea);
        return {
          ratio: Math.min(1, mismatched / Math.max(1, compared) + dimensionDelta),
          compared,
          dimensions: {
            target: [target.naturalWidth, target.naturalHeight],
            source: [source.naturalWidth, source.naturalHeight],
          },
        };
      },
      {
        targetPng: `data:image/png;base64,${targetBytes.toString("base64")}`,
        sourcePng: `data:image/png;base64,${sourceBytes.toString("base64")}`,
      },
    );
  } finally {
    await comparePage.close();
  }
}

function pixelGate(target, source, diff) {
  const targetLogoLoaded = (target.computed.logo?.naturalWidth ?? 0) > 0;
  const sourceLogoLoaded = source ? (source.computed.logo?.naturalWidth ?? 0) > 0 : null;
  const targetFont = target.computed.h1?.fontFamily ?? "";
  const sourceFont = source?.computed.h1?.fontFamily ?? "";
  const fontFamilyMatch = source ? targetFont === sourceFont : null;
  const targetFontSize = px(target.computed.h1?.fontSize);
  const sourceFontSize = px(source?.computed.h1?.fontSize);
  const fontSizeDeltaPx =
    targetFontSize !== null && sourceFontSize !== null
      ? Number(Math.abs(targetFontSize - sourceFontSize).toFixed(2))
      : null;
  const bodyBackgroundMatch = source
    ? target.computed.body.backgroundColor === source.computed.body.backgroundColor
    : null;
  const computedPass = source
    ? fontFamilyMatch &&
      (fontSizeDeltaPx ?? Infinity) <= 1 &&
      bodyBackgroundMatch &&
      targetLogoLoaded &&
      sourceLogoLoaded
    : targetLogoLoaded && Boolean(target.computed.h1);
  const diffRatio = diff ? Number(diff.ratio.toFixed(5)) : null;
  const pass =
    target.http === 200 &&
    (!source || source.http === 200) &&
    computedPass &&
    (diffRatio === null || diffRatio <= PIXEL_DIFF_MAX);

  return {
    pass,
    targetHttp: target.http,
    sourceHttp: source?.http ?? null,
    computed: {
      h1FontFamilyMatch: fontFamilyMatch,
      h1FontSizeDeltaPx: fontSizeDeltaPx,
      bodyBackgroundMatch,
      targetLogoLoaded,
      sourceLogoLoaded,
    },
    screenshot: {
      diffRatio,
      max: PIXEL_DIFF_MAX,
      dimensions: diff?.dimensions ?? null,
      target: target.screenshot,
      source: source?.screenshot ?? null,
    },
    consoleErrors: target.consoleErrors.length,
  };
}

function consoleGate(target, provider) {
  const messages = target.consoleMessages ?? [];
  const errors = messages.filter((msg) => msg.type === "error").length;
  const warnings = messages.filter((msg) => msg.type === "warning").length;
  const cspMessages = messages.filter((msg) =>
    /content security policy|violat/i.test(msg.text),
  ).length;
  const findings = messages
    .filter((msg) => msg.type === "warning")
    .map((msg) => ({
      id: findingId("console-warning", msg.text),
      owner: providerOwnsEvidence(msg.text, provider) ? "provider" : "platform",
      kind: "console-warning",
    }));
  return {
    pass: errors === 0 && cspMessages === 0 && (target.failedResponses?.length ?? 0) === 0,
    errors,
    warnings,
    cspMessages,
    failedResponses: target.failedResponses?.length ?? 0,
    failedResponseSamples: (target.failedResponses ?? []).slice(0, 10),
    findings,
    top: messages.slice(0, 5),
  };
}

async function runMobile(browser, pageUrl, perfGate, artifactPath) {
  const breakpoints = [
    { name: "mobile", width: 390, height: 844 },
    { name: "tablet", width: 768, height: 1024 },
  ];
  const checks = [];
  for (const bp of breakpoints) {
    const page = await newPageWithPreview(browser,{
      viewport: { width: bp.width, height: bp.height },
      deviceScaleFactor: bp.name === "mobile" ? 2 : 1,
      isMobile: bp.name === "mobile",
    });
    try {
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await settle(page);
      checks.push(
        await page.evaluate(({ name, textMin, tapTargetMin }) => {
          const selectorFor = (el) => {
            if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
            const classes = Array.from(el.classList ?? []).slice(0, 3).join(".");
            return classes ? `${el.tagName.toLowerCase()}.${classes}` : el.tagName.toLowerCase();
          };
          const viewport = document.querySelector('meta[name="viewport"]');
          const doc = document.documentElement;
          const body = document.body;
          const width = window.innerWidth;
          const overflowPx = Math.max(
            0,
            Math.ceil(Math.max(doc.scrollWidth, body?.scrollWidth ?? 0) - width),
          );
          const bodyFontSize = Number.parseFloat(getComputedStyle(body).fontSize || "0");
          const visibleText = Array.from(
            document.querySelectorAll("p, li, a, button, input, textarea, summary, small"),
          ).filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
          });
          const tinyText = visibleText.filter(
            (el) => Number.parseFloat(getComputedStyle(el).fontSize || "0") < textMin,
          );
          const tinyTextSamples = tinyText.slice(0, 5).map((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
              selector: selectorFor(el),
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || el.getAttribute("aria-label") || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 60),
              fontSizePx: Number(Number.parseFloat(style.fontSize || "0").toFixed(2)),
              lineHeight: style.lineHeight,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
          const targets = Array.from(document.querySelectorAll("a, button, input, textarea, select, summary"))
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
            })
            .map((el) => {
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              // WCAG 2.5.8 exempts a target that "is in a sentence or its size is otherwise
              // constrained by the line-height of NON-TARGET TEXT". Both halves matter. Inline
              // display alone is not enough: a call-to-action that happens to be `display:inline`
              // and stands alone in its container is not in a sentence, it is a control someone
              // forgot to size — exactly what this gate should still catch. So the exemption also
              // requires sibling text outside the link, which is what "in a sentence" means
              // operationally and what makes the 44px demand unreasonable (you cannot grow the
              // link without breaking the prose around it).
              const parentText = (el.parentElement?.textContent || "").replace(/\s+/g, " ").trim();
              const ownText = (el.textContent || "").replace(/\s+/g, " ").trim();
              const hasSurroundingText = parentText.length > ownText.length + 1;
              const exemptInline = style.display === "inline" && hasSurroundingText;
              // Visually-hidden-but-focusable controls (skip links, carousel slide labels) are
              // clipped to ~1px ON PURPOSE and are reached by keyboard, never by pointer. They are
              // an accessibility FEATURE; flagging them as an accessibility defect inverts it.
              const clipped =
                (style.clipPath && style.clipPath !== "none") ||
                (style.clip && style.clip !== "auto") ||
                style.position === "absolute";
              const exemptVisuallyHidden = clipped && rect.width <= 2 && rect.height <= 2;
              return {
                text: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("href") || "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 40),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                display: style.display,
                exemptInline,
                exemptVisuallyHidden,
              };
            });
          const smallTargets = targets.filter(
            (target) =>
              !target.exemptInline &&
              !target.exemptVisuallyHidden &&
              (target.width < tapTargetMin || target.height < tapTargetMin),
          );
          return {
            name,
            width,
            viewportMeta: Boolean(viewport?.getAttribute("content")),
            overflowPx,
            bodyFontSize,
            tinyText: tinyText.length,
            tinyTextSamples,
            smallTapTargets: smallTargets.length,
            smallTapTargetSamples: smallTargets.slice(0, 5),
          };
        }, { name: bp.name, textMin: MOBILE_TEXT_MIN, tapTargetMin: TAP_TARGET_MIN }),
      );
    } finally {
      await page.close();
    }
  }

  const audits = perfGate.mobileAudits ?? {};
  const auditPass = Object.values(audits).every((audit) => audit.pass !== false);
  const directPass = checks.every(
    (check) =>
      check.viewportMeta &&
      check.overflowPx <= 1 &&
      check.bodyFontSize >= MOBILE_BODY_FONT_MIN &&
      check.tinyText === 0 &&
      check.smallTapTargets === 0,
  );
  await writeFile(
    artifactPath,
    serializeEvidence({ url: pageUrl, checks, lighthouseAudits: audits }),
  );
  return {
    pass: directPass && auditPass,
    // Every condition the pass above is an AND over must appear here, or a reader is
    // handed a verdict whose cause is missing from its own evidence — `viewportMeta`
    // can fail the gate and is not derivable from any other field.
    breakpoints: checks.map((check) => ({
      name: check.name,
      viewportMeta: check.viewportMeta,
      overflowPx: check.overflowPx,
      bodyFontSize: check.bodyFontSize,
      tinyText: check.tinyText,
      tinyTextSamples: check.tinyTextSamples,
      smallTapTargets: check.smallTapTargets,
      smallTapTargetSamples: check.smallTapTargetSamples,
    })),
    thresholds: {
      bodyFontMinPx: MOBILE_BODY_FONT_MIN,
      textMinPx: MOBILE_TEXT_MIN,
      tapTargetMinPx: TAP_TARGET_MIN,
    },
    lighthouseAudits: audits,
    artifact: artifactPath,
  };
}

async function runUx(browser, pageUrl, artifactPath) {
  const page = await newPageWithPreview(browser,{ viewport: { width: 1365, height: 900 } });
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(page);
    const detail = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) =>
        (el.textContent || el.getAttribute("aria-label") || el.getAttribute("alt") || "")
          .replace(/\s+/g, " ")
          .trim();
      const images = Array.from(document.images);
      const links = Array.from(document.querySelectorAll("a")).filter(visible);
      const controls = Array.from(document.querySelectorAll("input, textarea, select")).filter(visible);
      const hasLabel = (control) => {
        if (control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`)) return true;
        if (control.closest("label")) return true;
        return Boolean(control.getAttribute("aria-label") || control.getAttribute("aria-labelledby"));
      };
      const vagueLinkPattern = /^(click here|here|learn more|more|read more|details)$/i;
      const pageUrlObj = new URL(location.href);
      const mixed = Array.from(document.querySelectorAll("[src], [href]"))
        .map((el) => el.getAttribute("src") || el.getAttribute("href") || "")
        .filter((value) => pageUrlObj.protocol === "https:" && /^http:\/\//i.test(value));
      const emptyHref = links.filter((link) => {
        const href = link.getAttribute("href") || "";
        return href === "" || href === "#";
      });
      const vagueLinks = links.filter((link) => vagueLinkPattern.test(textOf(link)));
      const missingAlt = images.filter((img) => !img.hasAttribute("alt"));
      const missingDimensions = images.filter(
        (img) => !img.hasAttribute("width") || !img.hasAttribute("height"),
      );
      return {
        lang: document.documentElement.lang || "",
        h1Count: document.querySelectorAll("h1").length,
        landmarks: {
          header: Boolean(document.querySelector("header, [role='banner']")),
          nav: Boolean(document.querySelector("nav, [role='navigation']")),
          main: Boolean(document.querySelector("main, [role='main']")),
          footer: Boolean(document.querySelector("footer, [role='contentinfo']")),
        },
        images: {
          total: images.length,
          missingAlt: missingAlt.length,
          missingDimensions: missingDimensions.length,
          missingDimensionSamples: missingDimensions
            .slice(0, 5)
            .map((img) => ({ alt: img.alt, src: img.currentSrc || img.src })),
        },
        forms: {
          controls: controls.length,
          unlabeled: controls.filter((control) => !hasLabel(control)).length,
        },
        links: {
          total: links.length,
          emptyHref: emptyHref.length,
          vague: vagueLinks.length,
          emptyHrefSamples: emptyHref.slice(0, 5).map((link) => textOf(link).slice(0, 50)),
          vagueSamples: vagueLinks.slice(0, 5).map((link) => textOf(link).slice(0, 50)),
        },
        delivery: {
          mixedContent: mixed.length,
          themeColor: Boolean(document.querySelector('meta[name="theme-color"]')),
          favicon: Boolean(
            document.querySelector('link[rel~="icon"], link[rel="shortcut icon"]'),
          ),
          webManifest: Boolean(document.querySelector('link[rel="manifest"]')),
        },
      };
    });
    const landmarkPass = detail.landmarks.main;
    const pass =
      Boolean(detail.lang) &&
      detail.h1Count === 1 &&
      landmarkPass &&
      detail.images.missingAlt === 0 &&
      detail.forms.unlabeled === 0 &&
      detail.delivery.mixedContent === 0;
    await writeFile(artifactPath, serializeEvidence({ url: pageUrl, ...detail }));
    return {
      pass,
      lang: Boolean(detail.lang),
      h1Count: detail.h1Count,
      landmarks: detail.landmarks,
      images: {
        total: detail.images.total,
        missingAlt: detail.images.missingAlt,
        missingDimensions: detail.images.missingDimensions,
      },
      forms: detail.forms,
      links: {
        emptyHref: detail.links.emptyHref,
        vague: detail.links.vague,
      },
      delivery: detail.delivery,
      artifact: artifactPath,
    };
  } finally {
    await page.close();
  }
}

async function runEcommerceStyleGuide(browser, pageUrl, perfGate, artifactPath) {
  const pathname = new URL(pageUrl).pathname;
  const applicable = pathname.includes("/_style-guide/");
  if (!applicable) {
    const result = {
      url: pageUrl,
      applicable: false,
      pass: true,
      reason: "not a style-guide route",
    };
    await writeFile(artifactPath, serializeEvidence(result));
    return result;
  }

  const page = await newPageWithPreview(browser,{ viewport: { width: 390, height: 844 }, isMobile: true });
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(page);
    const detail = await page.evaluate(({ textMin, tapTargetMin }) => {
      const selectorFor = (el) => {
        if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
        const classes = Array.from(el.classList ?? []).slice(0, 3).join(".");
        return classes ? `${el.tagName.toLowerCase()}.${classes}` : el.tagName.toLowerCase();
      };
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      let cssText = "";
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          cssText += Array.from(sheet.cssRules ?? []).map((rule) => rule.cssText).join("\n");
        } catch {
          // Cross-origin sheets are ignored; tenant/style-guide sheets should be same-origin.
        }
      }
      const bodyText = document.body.innerText.toLowerCase();
      const classText = Array.from(document.querySelectorAll("[class]"))
        .map((el) => el.getAttribute("class") || "")
        .join(" ")
        .toLowerCase();
      const haystack = `${bodyText}\n${classText}\n${cssText.toLowerCase()}`;
      const rootStyle = getComputedStyle(document.documentElement);
      const semanticTokenNames = [
        "--color-cta",
        "--color-cta-hover",
        "--color-trust",
        "--focus-ring",
        "--color-error",
        "--color-success",
        "--surface-card",
        "--text-muted",
      ];
      const semanticTokens = semanticTokenNames.map((name) => ({
        name,
        present: Boolean(rootStyle.getPropertyValue(name).trim()) || cssText.includes(name),
      }));
      const interactive = Array.from(document.querySelectorAll("a, button, input, textarea, select, summary"))
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("href") || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 60),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        });
      const smallTapTargets = interactive.filter(
        (target) => target.width < tapTargetMin || target.height < tapTargetMin,
      );
      const textNodes = Array.from(document.querySelectorAll("p, li, a, button, small, label, input, textarea, select"))
        .filter(visible);
      const tinyText = textNodes.filter(
        (el) => Number.parseFloat(getComputedStyle(el).fontSize || "0") < textMin,
      );
      const tinyTextSamples = tinyText.slice(0, 5).map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || el.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60),
          fontSizePx: Number(Number.parseFloat(style.fontSize || "0").toFixed(2)),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
      const controls = Array.from(document.querySelectorAll("input, textarea, select")).filter(visible);
      const labeledControls = controls.filter((control) => {
        if (control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`)) return true;
        if (control.closest("label")) return true;
        return Boolean(control.getAttribute("aria-label") || control.getAttribute("aria-labelledby"));
      });
      return {
        semanticTokens,
        states: {
          hover: /:hover\b/.test(cssText),
          active: /:active\b|\[aria-pressed/.test(cssText),
          focusVisible: /:focus-visible\b/.test(cssText),
          disabled: /:disabled\b|\[disabled\]|\[aria-disabled/.test(cssText),
          loading: /loading|aria-busy|is-loading/.test(haystack),
          validation: /invalid|error|success|help|validation/.test(haystack),
          reducedMotion: /prefers-reduced-motion/.test(cssText),
        },
        mobile: {
          smallTapTargets: smallTapTargets.length,
          smallTapTargetSamples: smallTapTargets.slice(0, 5),
          tinyText: tinyText.length,
          tinyTextSamples,
          bodyFontSize: Number.parseFloat(getComputedStyle(document.body).fontSize || "0"),
        },
        trustComponents: {
          proofStrip: /proof|trust/.test(haystack),
          reviewsRatings: /customer review|review card|\brating\b|\bstars?\b|\bg2\b|capterra/.test(haystack),
          testimonial: /testimonial|quote/.test(haystack),
          badge: /badge|security|compliance|certif/.test(haystack),
          reassurance: /guarantee|returns?|refund|warranty|risk-free/.test(haystack),
          logoStrip: /logo strip|as seen|press|customer logos?|partner logos?/.test(haystack),
        },
        ctaHierarchy: {
          primary: /primary|btn-green|btn-primary|color-cta/.test(haystack),
          secondary: /secondary|btn-navy|btn-secondary/.test(haystack),
          tertiary: /tertiary|outline|btn-line|btn-tertiary/.test(haystack),
        },
        accessibleForms: {
          examples: controls.length,
          labeledControls: labeledControls.length,
          hasHelpOrValidation: /help|hint|aria-describedby|required|optional|error|success|invalid/.test(haystack),
        },
        colorScheme: /color-scheme/.test(cssText),
      };
    }, { textMin: MOBILE_TEXT_MIN, tapTargetMin: TAP_TARGET_MIN });

    const perfMetrics = perfGate.metrics ?? {};
    const perfSkipped = perfGate.skipped === true;
    const lcp = perfMetrics["largest-contentful-paint"]?.numericValue ?? null;
    const tbt = perfMetrics["total-blocking-time"]?.numericValue ?? null;
    const cls = perfMetrics["cumulative-layout-shift"]?.numericValue ?? null;
    const checks = {
      semanticTokens: detail.semanticTokens.every((token) => token.present),
      fullStates: Object.values(detail.states).every(Boolean),
      mobileTargets: detail.mobile.smallTapTargets === 0 && detail.mobile.tinyText === 0 && detail.mobile.bodyFontSize >= MOBILE_BODY_FONT_MIN,
      trustComponents: Object.values(detail.trustComponents).every(Boolean),
      ctaHierarchy: Object.values(detail.ctaHierarchy).every(Boolean),
      accessibleForms: detail.accessibleForms.examples > 0 &&
        detail.accessibleForms.labeledControls === detail.accessibleForms.examples &&
        detail.accessibleForms.hasHelpOrValidation,
      colorScheme: detail.colorScheme,
      perfBudget: perfSkipped
        ? true
        : lcp !== null &&
          tbt !== null &&
          cls !== null &&
          lcp <= PERF_LCP_MAX &&
          tbt <= PERF_TBT_MAX &&
          cls <= PERF_CLS_MAX,
    };
    const failedChecks = Object.entries(checks)
      .filter(([, pass]) => !pass)
      .map(([name]) => name);
    const result = {
      url: pageUrl,
      applicable: true,
      pass: failedChecks.length === 0,
      failedChecks,
      thresholds: {
        textMinPx: MOBILE_TEXT_MIN,
        tapTargetMinPx: TAP_TARGET_MIN,
        bodyFontMinPx: MOBILE_BODY_FONT_MIN,
        lcpMaxMs: PERF_LCP_MAX,
        tbtMaxMs: PERF_TBT_MAX,
        clsMax: PERF_CLS_MAX,
      },
      checks,
      perfBudget: { lcp, tbt, cls, skipped: perfSkipped },
      detail,
      artifact: artifactPath,
    };
    await writeFile(artifactPath, serializeEvidence(result));
    return result;
  } finally {
    await page.close();
  }
}

async function keyboardGate(page) {
  const seen = [];
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || el.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40),
        href: el.getAttribute("href"),
        visible: rect.width > 0 && rect.height > 0,
      };
    });
    if (active) seen.push(active);
  }
  return {
    pass: seen.length >= 3 && seen.slice(0, 3).every((item) => item.visible),
    stops: seen.slice(0, 6).map((item) => ({
      tag: item.tag,
      text: item.text,
      href: item.href,
    })),
  };
}

async function reducedMotionGate(browser, pageUrl) {
  const page = await newPageWithPreview(browser,{
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(250);
    const hiddenRevealCount = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".reveal,[data-reveal]")).filter((el) => {
        const style = getComputedStyle(el);
        return Number.parseFloat(style.opacity || "1") < 0.5;
      }).length,
    );
    return { pass: hiddenRevealCount === 0, hiddenRevealCount };
  } finally {
    await page.close();
  }
}

function extractContrastNodes(violations) {
  return violations
    .filter((violation) => violation.id === "color-contrast")
    .flatMap((violation) =>
      violation.nodes.map((node) => {
        const checks = [...(node.any ?? []), ...(node.all ?? []), ...(node.none ?? [])];
        const check = checks.find((item) => item.data && (
          item.data.fgColor ||
          item.data.bgColor ||
          item.data.contrastRatio ||
          item.data.expectedContrastRatio
        ));
        const data = check?.data ?? {};
        return {
          target: node.target ?? [],
          html: compactText(node.html, 180),
          failureSummary: compactText(node.failureSummary, 220),
          text: compactText(node.html?.replace(/<[^>]*>/g, " "), 100),
          fg: data.fgColor ?? null,
          bg: data.bgColor ?? null,
          ratio: data.contrastRatio ?? null,
          expected: data.expectedContrastRatio ?? null,
          fontSize: data.fontSize ?? null,
          fontWeight: data.fontWeight ?? null,
          message: compactText(check?.message, 160),
        };
      }),
    );
}

async function runA11y(browser, pageUrl, artifactPath) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(page);
    const { AxeBuilder } = await loadModule("@axe-core/playwright");
    const results = await new AxeBuilder({ page }).analyze();
    const impacts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const violation of results.violations) {
      impacts[violation.impact ?? "minor"] += violation.nodes.length;
    }
    const top = results.violations.slice(0, 5).map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.length,
      nodeSamples: violation.nodes.slice(0, 3).map((node) => ({
        target: node.target ?? [],
        html: compactText(node.html, 140),
      })),
    }));
    const contrastNodes = extractContrastNodes(results.violations);
    const keyboard = await keyboardGate(page);
    const reducedMotion = await reducedMotionGate(browser, pageUrl);
    await writeFile(
      artifactPath,
      serializeEvidence({
        url: pageUrl,
        violations: results.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.length,
          help: violation.help,
          nodeSamples: violation.nodes.slice(0, 5).map((node) => ({
            target: node.target ?? [],
            html: compactText(node.html, 180),
          })),
        })),
        contrast: {
          nodes: contrastNodes.length,
          samples: contrastNodes.slice(0, 25),
        },
        incomplete: results.incomplete.length,
        keyboard,
        reducedMotion,
      }),
    );
    return {
      pass: impacts.critical === 0 && impacts.serious === 0 && keyboard.pass && reducedMotion.pass,
      impacts,
      violations: results.violations.length,
      top,
      contrast: {
        nodes: contrastNodes.length,
        samples: contrastNodes.slice(0, 10),
      },
      keyboard: { pass: keyboard.pass, stops: keyboard.stops.length },
      reducedMotion,
      artifact: artifactPath,
    };
  } finally {
    await context.close();
  }
}

async function runLighthouseProfile(pageUrl, artifactPath, profile, provider) {
  const port = await freePort();
  const browser = await launchBrowser({
    args: [`--remote-debugging-port=${port}`, "--disable-dev-shm-usage"],
  });
  try {
    const lighthouseModule = await loadModule("lighthouse");
    const lighthouse = lighthouseModule.default ?? lighthouseModule;
    const mobile = profile === "mobile";

    // Lighthouse drives its OWN browser, so newPageWithPreview's cookies never reach
    // it. `?__preview=` moves the PAGE only; a tenant's assets are served
    // version-scoped from R2 behind the `tot_preview_version` + `tot_preview` cookie
    // pair, so without them every first-party image 404s and the run scores a page
    // that does not exist — measured 2026-09-19, the tenant logo and favicon 404ing
    // in 8 of 8 runs while the same assets returned 200 to every Playwright pass in
    // the same session.
    //
    // Measured delivery comparison, same url, same version+token:
    //   nothing (what this did)                 -> logo + favicon 404
    //   lighthouse flags.extraHeaders cookie    -> logo + favicon 404  (headers do
    //                                              not become the browser's cookie
    //                                              jar, so subresources go bare)
    //   CDP Storage.setCookies + no storage reset -> no 404s
    //
    // disableStorageReset is REQUIRED with it: Lighthouse clears storage before the
    // run by default, which would wipe the jar we just seeded. Each profile launches
    // its own browser, so nothing leaks between runs.
    if (previewAssetChannel) {
      const { origin, versionId, token } = previewAssetChannel;
      const domain = (() => {
        try { return new URL(origin).hostname; } catch { return null; }
      })();
      if (domain) {
        const session = await browser.newBrowserCDPSession();
        await session.send("Storage.setCookies", {
          cookies: [
            { name: "tot_preview_version", value: versionId, domain, path: "/", secure: true },
            { name: "tot_preview", value: token, domain, path: "/", secure: true },
          ],
        }).catch(() => undefined);
      }
    }

    const result = await lighthouse(pageUrl, {
      port,
      logLevel: "error",
      output: "json",
      onlyCategories: LIGHTHOUSE_CATEGORIES,
      formFactor: profile,
      // Keep the seeded preview cookies; see the note above.
      disableStorageReset: Boolean(previewAssetChannel),
      screenEmulation: {
        mobile,
        width: mobile ? 390 : 1350,
        height: mobile ? 844 : 940,
        deviceScaleFactor: mobile ? 2 : 1,
        disabled: false,
      },
    });
    const categories = result.lhr.categories;
    // Set aside audits that score the PREVIEW CHANNEL rather than the migration, and rescore the
    // category without them. `is-crawlable` is the proven case: the preview is auth-gated and so
    // deliberately noindex, and that audit carries a third of the SEO category's weight. The
    // relief is gated on actually running against the preview channel, and on Lighthouse's own
    // evidence naming an `x-robots-tag` header rather than the tenant's own meta tag, so a
    // tenant that really did noindex their page still fails.
    const { scores: channelScores, exemptions: channelExemptions } = rescoreForChannel(result.lhr, {
      servedByPreviewChannel: Boolean(process.env.SM_PREVIEW_TOKEN),
    });
    // A category Lighthouse did not return is ABSENT, not zero. Defaulting to 0 would report a
    // catastrophic score the page never earned and the parity gate would read it as a total
    // regression — a confident, specific, wrong failure, which is worse than an honest gap.
    const scores = Object.fromEntries(
      LIGHTHOUSE_CATEGORIES.map((key) => {
        const scored = channelScores[key]
          ?? (categories[key]?.score == null ? null : Math.round(categories[key].score * 100));
        return [key, scored];
      }).filter(([, v]) => v != null),
    );
    const audit = (id) => {
      const item = result.lhr.audits[id];
      if (!item) return null;
      return {
        id,
        score: item.score,
        pass: item.score === null ? null : item.score >= 0.9,
        displayValue: item.displayValue,
        numericValue: item.numericValue,
      };
    };
    const mobileAudits = Object.fromEntries(
      ["viewport", "content-width", "tap-targets", "font-size"]
        .map((id) => [id, audit(id)])
        .filter(([, value]) => value),
    );
    const metrics = Object.fromEntries(
      [
        "first-contentful-paint",
        "largest-contentful-paint",
        "total-blocking-time",
        "cumulative-layout-shift",
        "speed-index",
        "unused-css-rules",
        "unused-javascript",
        "render-blocking-resources",
      ]
        .map((id) => [id, audit(id)])
        .filter(([, value]) => value),
    );
    const auditCategories = new Map();
    for (const [category, value] of Object.entries(result.lhr.categories ?? {})) {
      for (const ref of value?.auditRefs ?? []) {
        const categories = auditCategories.get(ref.id) ?? [];
        categories.push(category);
        auditCategories.set(ref.id, categories);
      }
    }
    // An exempted audit is not a tenant defect, so it must not also arrive as a finding to fix.
    // It is reported below as a platform record carrying its reason and both scores.
    const exemptIds = new Set(channelExemptions.map((exemption) => exemption.id));
    const findings = Object.values(result.lhr.audits)
      .filter((item) => item && typeof item.score === "number" && item.score < 0.9)
      .filter((item) => !exemptIds.has(item.id))
      .map((item) => {
        // Lighthouse puts an item's origin in `url` for network-shaped audits and in
        // `source.url` for code-shaped ones (deprecations, console errors). Reading only `url`
        // left those with NO evidence urls, and providerOwnsAllEvidenceUrls requires a
        // non-empty list — so an audit whose every warning came from the provider's own script
        // was attributed to US by default.
        //
        // Measured 2026-09-21: `deprecations` was the ONLY failing best-practices audit on
        // every page, and both its warnings came from
        // /cdn-cgi/challenge-platform/scripts/jsd/main.js — Cloudflare's bot-challenge script,
        // which we do not ship and cannot change. Labelled `platform`, it read as our defect
        // and would have been offered to the merchant as an add-on we cannot deliver.
        const allUrls = Array.isArray(item.details?.items)
          ? item.details.items
              .flatMap((row) => [
                row?.url,
                typeof row?.source === "string" ? row.source : row?.source?.url,
              ])
              .filter((value) => typeof value === "string")
              .map(sanitizeEvidenceUrl)
          : [];
        return {
          id: item.id,
          title: item.title,
          owner: providerOwnsAllEvidenceUrls(allUrls, provider) ? "provider" : "platform",
          categories: auditCategories.get(item.id) ?? [],
          urls: allUrls.slice(0, 10),
        };
      });
    await writeFile(artifactPath, serializeEvidence(JSON.parse(result.report)));
    const runWarnings = Array.isArray(result.lhr.runWarnings)
      ? result.lhr.runWarnings.map(sanitizeEvidenceText)
      : [];
    findings.push(...runWarnings.map((warning) => ({
      id: findingId("lighthouse-run-warning", warning),
      owner: providerOwnsEvidence(warning, provider) ? "provider" : "platform",
      kind: "lighthouse-run-warning",
      categories: [],
    })));
    // Read the browser's OWN verdict on this run's layout shifts out of the trace.
    // Lighthouse deliberately re-includes shifts Chrome discarded (see
    // lib/lighthouse-stability.mjs); when every significant shift in the run
    // carries that flag, the CLS number describes the harness, not the page.
    const traceEvents = result.artifacts?.Trace?.traceEvents
      ?? result.artifacts?.traces?.defaultPass?.traceEvents
      ?? [];
    const shiftEvents = traceEvents
      .filter((event) => event?.name === "LayoutShift" && event.args?.data)
      .map((event) => event.args.data);
    const clsArtifact = isChromeExcludedShiftRun(shiftEvents);

    // A score taken against a page whose OWN images 404 is not a score. That state
    // silently taxes exactly the categories this gate enforces — best-practices
    // penalises 4xx subresources directly — so a tenant can be failed for a defect
    // that exists only in the harness. Report it as a platform finding rather than
    // letting it read as the tenant's poor page.
    const missingTenantAssets = firstPartyNotFoundUrls(traceEvents);
    const missingAssetFindings = missingTenantAssets.length === 0 ? [] : [{
      id: "lighthouse-tenant-assets-unreachable",
      owner: "platform",
      kind: "lighthouse-tenant-assets-unreachable",
      categories: ["best-practices"],
      title:
        `${missingTenantAssets.length} first-party tenant asset(s) returned 404 during this` +
        " Lighthouse run, so the score describes a page with missing images rather than the" +
        " published one. This is a harness credential fault, not a tenant defect.",
      urls: missingTenantAssets.slice(0, 10).map(sanitizeEvidenceUrl),
    }];
    findings.push(...missingAssetFindings);

    // Record every exemption on the run itself. A score that moved because the harness set an
    // audit aside must say so, with the reason and the number it would otherwise have reported —
    // an unexplained adjustment is how a gate starts lying about its own evidence.
    findings.push(...channelExemptions.map((exemption) => ({
      id: `lighthouse-channel-exempt-${exemption.id}`,
      owner: "platform",
      kind: "lighthouse-channel-exempt",
      categories: [exemption.category],
      title:
        `${exemption.id} was excluded from the ${exemption.category} score: ${exemption.reason}` +
        ` Scored ${exemption.category} ${exemption.adjustedScore} without it;` +
        ` ${exemption.rawScore} with it.`,
      urls: [],
    })));

    // Judge against the SOURCE, not an absolute floor. A floor of 90 against a source scoring 41
    // asks a faithful clone to outperform the original, which is an add-on enforced as core — it
    // fails a migration for declining to do work nobody bought, and buries real regressions among
    // pages that already beat what the merchant had. Only a drop below source fails; delivered
    // improvement is catalogued so it stays sellable instead of being absorbed silently.
    // Contract: the migration add-on stages.
    // Only judge against a baseline captured at the SAME form factor. A mismatch is not a
    // regression and must never be reported as one — it is simply not a comparison.
    // Prefer the reading captured at THIS run's form factor. Only when the baseline has no
    // reading for it does comparability come into question.
    const forProfile = sourceBaselineByFormFactor?.[profile] ?? null;
    const comparable = Boolean(forProfile)
      || !sourceBaselineFormFactor
      || sourceBaselineFormFactor === profile;
    const parity = judgeParity({
      scores,
      baseline: forProfile ?? sourceBaseline,
      notComparable: comparable
        ? undefined
        : `no-${profile}-baseline-captured`,
    });
    findings.push(...parity.regressions.map((key) => ({
      id: `lighthouse-parity-regression-${key}`,
      owner: "platform",
      kind: "lighthouse-parity-regression",
      categories: [key],
      title:
        `${key} fell below the source: ${parity.dimensions[key].source} -> ` +
        `${parity.dimensions[key].migrated} (${parity.dimensions[key].delta}). ` +
        "The merchant had this and the migration took it.",
      urls: [],
    })));
    findings.push(...parity.giveaways.map((key) => ({
      id: `lighthouse-parity-giveaway-${key}`,
      owner: "platform",
      kind: "lighthouse-parity-giveaway",
      categories: [key],
      title:
        `${key} ${parity.dimensions[key].source} -> ${parity.dimensions[key].migrated} ` +
        `(+${parity.dimensions[key].delta}) — delivered above parity. Add-on value, not a defect.`,
      urls: [],
    })));

    return {
      profile,
      channelExemptions,
      pass: parity.pass && runWarnings.length === 0,
      parity: {
        ...parity,
        summary: describeParity(parity),
        tolerance: PARITY_TOLERANCE,
        ceiling: GIVEAWAY_CEILING,
        baseline: sourceBaseline ?? null,
      },
      scores,
      mobileAudits,
      metrics,
      runWarnings,
      runErrors: 0,
      findings,
      clsArtifact,
      missingTenantAssets,
      artifact: artifactPath,
    };
  } finally {
    await browser.close();
  }
}

/**
 * One profile, decided on the MEDIAN of up to LIGHTHOUSE_STABILITY_RUNS runs
 * rather than on a single sample.
 *
 * A lone run is not a measurement here: ten consecutive runs of one unchanged url
 * measured 2026-09-19 split bimodally, performance 74-75 six times and 96-100 four
 * times, because Lighthouse counts a first-layout shift that Chrome itself scores
 * zero (see lib/lighthouse-stability.mjs for the mechanism). Deciding a
 * tenant's cutover on that is a coin flip.
 *
 * Only a FAILING run is repeated, so a healthy page still costs exactly one run and
 * the extra wall-clock is spent solely where the verdict is actually in doubt. Each
 * attempt writes its own artifact so the evidence of a disagreement survives.
 */
async function runLighthouseProfileStable(pageUrl, artifactPath, profile, provider) {
  const runs = [];
  for (let attempt = 1; attempt <= LIGHTHOUSE_STABILITY_RUNS; attempt += 1) {
    const path = attempt === 1
      ? artifactPath
      : artifactPath.replace(/\.json$/i, `.run${attempt}.json`);
    runs.push(await runLighthouseProfile(pageUrl, path, profile, provider));
    if (!shouldRerun(runs[runs.length - 1], attempt)) break;
  }
  return foldStabilityRuns(runs);
}

async function runLighthouse(pageUrl, artifactPath, requestedProfile, provider) {
  const profiles = requestedProfile === "both" ? ["mobile", "desktop"] : [requestedProfile];
  const results = {};
  for (const profile of profiles) {
    const path = profile === "mobile"
      ? artifactPath
      : artifactPath.replace(/\.json$/i, ".desktop.json");
    results[profile] = await runLighthouseProfileStable(pageUrl, path, profile, provider);
  }
  const primary = results.mobile ?? results.desktop;
  // A profile the harness could not measure must stay visible even when it is not the
  // primary one: the combined record is what the gate and the triage read, and an
  // unmeasured desktop folded into a measured mobile would report a number nobody took.
  const unmeasuredProfiles = Object.entries(results)
    .filter(([, result]) => typeof result?.unmeasured === "string")
    .map(([profile, result]) => `${profile}:${result.unmeasured}`);
  return {
    ...primary,
    pass: Object.values(results).every((result) => result.pass === true),
    ...(unmeasuredProfiles.length > 0
      ? (() => {
          const unmeasured = primary.unmeasured ?? unmeasuredProfiles[0].split(":")[1];
          return { unmeasured, unmeasuredText: UNMEASURED_REASONS[unmeasured] ?? unmeasured, unmeasuredProfiles };
        })()
      : {}),
    requestedProfile,
    profiles: results,
    runWarnings: Object.values(results).reduce((count, result) => count + result.runWarnings.length, 0),
    runErrors: Object.values(results).reduce((count, result) => count + result.runErrors, 0),
  };
}

async function runCsp(browser, pageUrl, artifactPath) {
  const page = await newPageWithPreview(browser,{ viewport: { width: 1365, height: 900 } });
  const consoleViolations = [];
  let sourceMode = "none";
  let enforced = false;

  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    w.__smCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      w.__smCspViolations.push({
        effectiveDirective: event.effectiveDirective,
        violatedDirective: event.violatedDirective,
        blockedURI: event.blockedURI,
        disposition: event.disposition,
        sourceFile: event.sourceFile,
        sample: event.sample,
      });
    });
  });
  page.on("console", (msg) => {
    const text = msg.text();
    if (/content security policy|violat/i.test(text)) consoleViolations.push(sanitizeEvidenceText(text).slice(0, 300));
  });
  page.on("pageerror", (err) => {
    const text = err.message || "";
    if (/content security policy|violat/i.test(text)) consoleViolations.push(sanitizeEvidenceText(text).slice(0, 300));
  });
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const headers = await response.headers();
    if (route.request().isNavigationRequest()) {
      const policy = headers["content-security-policy"] ?? headers["content-security-policy-report-only"];
      sourceMode = headers["content-security-policy"]
        ? "enforce"
        : headers["content-security-policy-report-only"]
          ? "report-only"
          : "none";
      if (policy) {
        headers["content-security-policy"] = policy;
        delete headers["content-security-policy-report-only"];
        enforced = true;
      }
    }
    await route.fulfill({ response, headers });
  });

  try {
    const response = await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(1200);
    const eventViolations = (await page
      .evaluate(() => /** @type {any} */ (window).__smCspViolations ?? [])
      .catch(() => []))
      .map((violation) => ({
        ...violation,
        blockedURI: violation.blockedURI ? sanitizeEvidenceUrl(violation.blockedURI) : violation.blockedURI,
        sourceFile: violation.sourceFile ? sanitizeEvidenceUrl(violation.sourceFile) : violation.sourceFile,
        sample: violation.sample ? sanitizeEvidenceText(violation.sample) : violation.sample,
      }));
    const violationCount = consoleViolations.length + eventViolations.length;
    await writeFile(
      artifactPath,
      serializeEvidence({
        url: pageUrl,
        http: response?.status() ?? 0,
        sourceMode,
        enforced,
        consoleViolations,
        eventViolations,
      }),
    );
    return {
      pass: violationCount === 0 && (response?.status() ?? 0) === 200,
      mode: enforced ? `forced-enforce-from-${sourceMode}` : sourceMode,
      violations: violationCount,
      consoleViolations: consoleViolations.length,
      eventViolations: eventViolations.length,
      artifact: artifactPath,
    };
  } finally {
    // Retire the `**/*` handler registered above BEFORE closing. It awaits `route.fetch()` per
    // request, so closing while one is in flight rejects with "route.fetch: Request context
    // disposed" — which surfaces as empty stdout and a non-zero exit, i.e. a harness teardown race
    // reported as a page failure. Observed twice on a live tenant, both times passing on a plain
    // re-run of the same page.
    //
    // Playwright names `unrouteAll` as the remedy in that error text. This is DEFENSIVE, not
    // proven: the race is intermittent, so a green run after the change does not establish a fix.
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
    await page.close();
  }
}

async function main() {
  await mkdir(artifactDir, { recursive: true });
  const artifacts = {
    targetScreenshot: join(artifactDir, `${safeName}.target.png`),
    sourceScreenshot: sourceUrl ? join(artifactDir, `${safeName}.source.png`) : null,
    axe: join(artifactDir, `${safeName}.axe.json`),
    lighthouse: join(artifactDir, `${safeName}.lighthouse.json`),
    mobile: join(artifactDir, `${safeName}.mobile.json`),
    ux: join(artifactDir, `${safeName}.ux.json`),
    ecommerceStyleGuide: join(artifactDir, `${safeName}.ecommerce-style-guide.json`),
    csp: join(artifactDir, `${safeName}.csp.json`),
  };

  const browser = await launchBrowser();
  try {
    const skipLighthouse = cli.noLighthouse;
    const lighthouseSkipReason = "--no-lighthouse fast browser mode";
    const target = await capturePage(browser, url, artifacts.targetScreenshot);
    if (target.http !== 200) {
      const gates = {
        render: gateMeta(
          {
            pass: false,
            http: target.http,
            screenshot: target.screenshot,
            consoleErrors: target.consoleErrors.length,
            reason:
              "target returned non-200; browser gates skipped so an error page is not scored as content",
          },
          { required: true },
        ),
      };
      printEvidence({
        slug: evidenceSlug,
        provider: cli.provider,
        base: evidenceBase,
        url: evidenceUrl,
        sourceUrl: evidenceSourceUrl,
        artifactDir,
        mode: "browser-render-error",
        previewOnly: cli.previewOnly,
        noLighthouse: cli.noLighthouse,
        requiredGates: ["render"],
        gates,
        ok: false,
        error: {
          name: "Non200Response",
          message: `Target returned HTTP ${target.http}; downstream browser gates were skipped.`,
        },
      });
      return;
    }
    const source = sourceUrl
      ? await capturePage(browser, sourceUrl, artifacts.sourceScreenshot)
      : null;
    const diff = source
      ? await compareScreenshots(browser, artifacts.targetScreenshot, artifacts.sourceScreenshot)
      : null;
    const [a11y, csp] = await Promise.all([
      runA11y(browser, url, artifacts.axe),
      runCsp(browser, url, artifacts.csp),
    ]);
    const perf = skipLighthouse
      ? await writeGateArtifact(artifacts.lighthouse, {
          url: evidenceUrl,
          pass: true,
          skipped: true,
          required: false,
          applicable: true,
          reason: lighthouseSkipReason,
          scores: null,
          mobileAudits: {},
          metrics: {},
          artifact: artifacts.lighthouse,
        })
      : await runLighthouse(url, artifacts.lighthouse, cli.lighthouseProfile, cli.provider);
    const [mobile, ux, ecommerceStyleGuide] = await Promise.all([
      runMobile(browser, url, perf, artifacts.mobile),
      runUx(browser, url, artifacts.ux),
      runEcommerceStyleGuide(browser, url, perf, artifacts.ecommerceStyleGuide),
    ]);
    const gates = {
      pixel: gateMeta(pixelGate(target, source, diff), { required: !cli.previewOnly }),
      console: gateMeta(consoleGate(target, cli.provider), { required: true }),
      mobile: gateMeta(mobile, { required: true }),
      ux: gateMeta(ux, { required: true }),
      a11y: gateMeta(a11y, { required: true }),
      perf: gateMeta(perf, { required: !skipLighthouse, applicable: true }),
      ecommerceStyleGuide: gateMeta(ecommerceStyleGuide, {
        required: false,
        applicable: ecommerceStyleGuide.applicable !== false,
        reason: ecommerceStyleGuide.applicable === false
          ? "not a style-guide route"
          : "advisory for preview-only style-guide routes; static style audit owns approval",
      }),
      csp: gateMeta(csp, { required: true, applicable: true }),
    };
    const requiredGates = Object.entries(gates)
      .filter(([, gate]) => gate.required !== false && gate.applicable !== false)
      .map(([name]) => name);
    const ok = Object.values(gates).every(gatePassValue);
    printEvidence({
      slug: evidenceSlug,
      provider: cli.provider,
      base: evidenceBase,
      url: evidenceUrl,
      sourceUrl: evidenceSourceUrl,
      artifactDir,
      mode: cli.noLighthouse
        ? "browser-fast-no-lighthouse"
        : "full-browser",
      previewOnly: cli.previewOnly,
      noLighthouse: cli.noLighthouse,
      requiredGates,
      gates,
      ok,
    });
  } finally {
    await browser.close();
  }
}

main().then(() => {
  // stderr, so the JSON on stdout stays machine-readable.
  process.stderr.write("Site-wide validation with triage, and the source-baseline parity check, are in the Agency Kit.\n");
}, (err) => {
  printEvidence({
    slug: evidenceSlug,
    provider: cli.provider,
    base: evidenceBase,
    url: evidenceUrl,
    sourceUrl: evidenceSourceUrl,
    artifactDir,
    gates: {},
    ok: false,
    error: {
      name: err?.name ?? "Error",
      message: compactErrorMessage(err),
      script: basename(fileURLToPath(import.meta.url)),
    },
  });
  process.exitCode = 1;
});
