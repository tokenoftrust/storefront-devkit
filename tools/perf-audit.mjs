#!/usr/bin/env node
/**
 * perf-audit.mjs — deterministic, dependency-free performance / best-practices gate
 * for a ported marketing page. Closes the loop on the Lighthouse-class findings the
 * mechanical + style audits do NOT surface (image dimensions, continuous
 * non-composited animations, render-blocking CSS, CSS delivery/minification).
 *
 * Why this exists: page-port.md lists "Lighthouse mobile >= 90" as a T1 gate, but
 * full Lighthouse needs a headless-Chrome dependency and is flaky in CI. This script
 * runs the deterministic subset from plain fetches (script-first, token-cheap), so
 * these findings are GENERATED and triaged on every port instead of being discovered
 * later in a manual Lighthouse run. For the full score, run Lighthouse in CI against a
 * deployed preview (see --hint); this gate is the always-on floor.
 *
 * Usage: perf-audit.mjs <base> <slug>
 *   e.g. perf-audit.mjs http://localhost:4321/shop.example /product/
 * Emits compact JSON; exit 0 if the hard gate (image dimensions) passes.
 *
 * Non-composited properties: animating these off the compositor thread causes jank.
 * Continuous (infinite) animations on them are the real offenders; hover-only
 * transitions are noted but not failed.
 */

const NON_COMPOSITED = [
  "box-shadow", "background", "background-color", "filter", "color", "border-color",
  "top", "left", "right", "bottom", "width", "height", "margin", "padding",
];

async function main() {
  const [base, slug] = process.argv.slice(2);
  if (!base || !slug) {
    console.error("usage: perf-audit.mjs <base> <slug>");
    process.exit(2);
  }
  const url = base.replace(/\/$/, "") + "/" + slug.replace(/^\/+/, "");
  const res = await fetch(url);
  const html = await res.text();

  // --- 1. Image dimensions (HARD gate) ------------------------------------
  // Every <img> should carry explicit width+height (or inline aspect-ratio) so the
  // browser reserves space -> no CLS, and Lighthouse "image elements do not have
  // explicit width and height" clears.
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imgMissing = imgs.filter((tag) => {
    const hasW = /\bwidth\s*=/.test(tag) || /aspect-ratio\s*:/.test(tag);
    const hasH = /\bheight\s*=/.test(tag) || /aspect-ratio\s*:/.test(tag);
    return !(hasW && hasH);
  });

  // --- 2. Linked stylesheets: render-blocking + delivery ------------------
  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [""])[0];
  const links = [...head.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)].map((m) => m[0]);
  const renderBlocking = links.filter((l) => !/\bmedia=["']print["']/.test(l) && !/rel=["']preload["']/.test(l));
  const hrefs = links
    .map((l) => (l.match(/href=["']([^"']+)["']/) || [])[1])
    .filter(Boolean)
    .filter((h) => h.startsWith("/") || h.startsWith(base));

  // --- 3. Fetch each tenant stylesheet: minified-on-serve + animations ----
  const cssReports = [];
  const animWarnings = [];
  for (const href of hrefs) {
    const cssUrl = href.startsWith("http") ? href : new URL(href, base).origin + href;
    let cssRes, css;
    try { cssRes = await fetch(cssUrl); css = await cssRes.text(); } catch { continue; }
    const encoding = cssRes.headers.get("content-encoding") || "";
    const lines = css.split("\n");
    const looksMinified = lines.length <= 3 || (css.length / Math.max(1, lines.length)) > 300;
    const compressedOnServe = /gzip|br|deflate/.test(encoding);
    cssReports.push({
      href,
      bytes: css.length,
      compressedOnServe,
      minifiedSource: looksMinified,
      // "delivery optimized" if compressed on the wire OR minified. Non-minified
      // source is our READABILITY policy; optimization must happen at serve time.
      deliveryOptimized: compressedOnServe || looksMinified,
    });
    // Continuous (infinite) animations touching non-composited properties.
    for (const kf of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\}\s*\}/g)) {
      const [, name, body] = kf;
      const props = NON_COMPOSITED.filter((p) => new RegExp(`(^|[;{\\s])${p}\\s*:`).test(body));
      const usedInfinite = new RegExp(`animation[^;]*\\b${name}\\b[^;]*infinite`).test(css)
        || new RegExp(`animation-name[^;]*\\b${name}\\b`).test(css);
      if (props.length && usedInfinite) animWarnings.push({ keyframes: name, nonCompositedProps: props });
    }
  }

  const imgDimensionsPass = imgMissing.length === 0;
  const out = {
    url,
    status: res.status,
    ok: imgDimensionsPass,
    gates: {
      imgDimensions: {
        pass: imgDimensionsPass,
        total: imgs.length,
        missing: imgMissing.length,
        samples: imgMissing.slice(0, 3),
      },
      nonCompositedAnimations: {
        pass: animWarnings.length === 0,
        advisory: true,
        findings: animWarnings,
      },
      renderBlockingCss: {
        advisory: true,
        count: renderBlocking.length,
        note: renderBlocking.length > 2 ? "consider inlining critical CSS / preload" : "ok",
      },
      cssDelivery: {
        advisory: true,
        stylesheets: cssReports,
        note: "deliveryOptimized false in dev is expected; enforce compression/minification at serve/build (raw tenant assets currently bypass the bundler).",
      },
    },
    hint: "For full Perf/Best-Practices/SEO scores run Lighthouse in CI against a deployed preview URL; this gate is the deterministic always-on floor.",
  };
  console.log(JSON.stringify(out, null, 2));
  console.error("Site-wide performance and parity checks across every page are in the Agency Kit.");
  process.exit(imgDimensionsPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
