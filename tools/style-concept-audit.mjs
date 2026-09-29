#!/usr/bin/env node
/**
 * style-concept-audit.mjs — CSS duplication + readability + style-concept manifest gate.
 *
 * Usage:
 *   style-concept-audit.mjs --store <store-checkout> [--manifest <json>] [--out <json>] [--sync-hashes]
 *   style-concept-audit.mjs --tenant <id> --content-dir <dir-of-stores> --public-dir <served-public-root> [...]
 *   style-concept-audit.mjs --requirements
 *
 * stdout: compact JSON summary.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
// Two layouts.
//
// STORE (`--store <dir>`): one store checkout. Content is `<store>/content`, and a
// root-relative href `/tenants/<tenant>/X` is the store's own file `<store>/public/X`,
// because that is where the platform serves a store's public assets from. Platform-served
// sheets such as /shared/commerce-chrome.css are not in a store checkout and read as absent.
//
// DIRECTORY OF STORES (`--content-dir` + `--tenant`): content is
// `<content-dir>/<tenant>/content`, and hrefs resolve under `--public-dir`, the root the
// platform serves `/tenants/<id>/…` from.
const DEFAULT_CONTENT_DIR = "tenants";
const DEFAULT_PUBLIC_DIR = "public";
const NESTED_TEST_STORE_DIR = "e2e";
const DEFAULT_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "style-concept.manifest.schema.json",
);
const TEASER =
  "Style-concept approval and stakeholder sign-off, and site-wide validation with triage, are in the Agency Kit.";

/** @type {{ dir: string, tenant: string } | null} */
let storeLayout = null;

/** The tenant id a store checkout declares in `.tot/config.json`, else the directory name. */
function storeTenant(dir) {
  try {
    const config = JSON.parse(readFileSync(join(dir, ".tot", "config.json"), "utf8"));
    if (typeof config?.tenant === "string" && config.tenant) return config.tenant;
  } catch {
    // No readable config: the directory name is the only other identity a checkout carries.
  }
  return basename(dir);
}

/** Where a root-relative public href lives on disk, for either layout. */
function publicPathFor(publicDir, href) {
  if (storeLayout) {
    const prefix = `/tenants/${storeLayout.tenant}/`;
    if (href.startsWith(prefix)) return join(storeLayout.dir, "public", href.slice(prefix.length));
  }
  return join(publicDir, href.slice(1));
}

/** The directory holding a tenant's `content/`, for either layout. */
function tenantBaseDir(contentDir, tenant) {
  return storeLayout ? storeLayout.dir : join(contentDir, tenant);
}
const DEFAULT_INLINE_MAX = Number(process.env.SM_INLINE_CSS_MAX_BYTES ?? "4096");
const DEFAULT_DUP_MAX = Number(process.env.SM_CSS_DUPLICATE_RATIO_MAX ?? "0.25");
const DEFAULT_READABILITY_LINE_MAX = Number(process.env.SM_READABILITY_LINE_MAX ?? "160");
const DEFAULT_READABILITY_LONG_LINE_RATIO_MAX = Number(
  process.env.SM_READABILITY_LONG_LINE_RATIO_MAX ?? "0.05",
);
const DEFAULT_READABILITY_MINIFIED_LINE_RATIO_MAX = Number(
  process.env.SM_READABILITY_MINIFIED_LINE_RATIO_MAX ?? "0.01",
);
const DEFAULT_READABILITY_CSS_DENSITY_MAX = Number(
  process.env.SM_READABILITY_CSS_DENSITY_MAX ?? "3.5",
);
const DEFAULT_READABILITY_SECTION_COMMENTS_MIN = Number(
  process.env.SM_READABILITY_SECTION_COMMENTS_MIN ?? "2",
);

// The single platform-shipped chrome stylesheet. A tenant that has
// migrated onto the shared chrome LINKS this sheet and stops owning chrome CSS.
const SHARED_CHROME_HREF = "/shared/commerce-chrome.css";

// The chrome-STRUCTURAL class vocabulary the shared sheet owns — header / nav /
// mega / announcement / utility bar / merchandising tiles / compliance strip /
// age gate / footer. A tenant may NOT re-author these in its own stylesheet, nor
// inline them, once it has adopted the shared chrome ("inline chrome CSS is
// banned"). Deliberately
// EXCLUDES generic composition atoms the shared sheet also defines (.btn,
// .container, .section, .eyebrow, .sec-head, .link-more, .reveal) — those legitimately
// appear in tenant page/marketing CSS, so keying on them would false-positive. The
// commerce-chrome.contract.test.ts drift test asserts every class here still exists
// in the shipped sheet, so a rename fails mechanically instead of silently.
const CHROME_STRUCTURAL_CLASSES = [
  // announcement + top utility bar
  "announce", "announce-marquee", "announce-bar", "topbar-warning", "utility-nav", "member-cue",
  // header + primary nav + mega panels
  "site-header", "header-row", "header-search", "header-actions", "hamburger",
  "primary-nav", "primary-nav-bar", "nav-item", "mega",
  // merchandising chrome (brand / category tiles)
  "tile-grid", "tile", "cat-grid", "cat-card",
  // compliance strip + age gate
  "compliance-strip", "age-gate",
  // footer
  "site-footer", "footer-grid", "footer-brand", "footer-col", "footer-news",
  "footer-attest", "pay-badges", "trust-marks", "footer-warning", "footer-bottom",
];
// Cap the reported violation list so a fully re-authored sheet (~50 rules) stays
// legible in the JSON; the count is always exact.
const CHROME_VIOLATION_SAMPLE_MAX = 25;

const REQUIREMENTS_CONTRACT = {
  contractVersion: "v1.1",
  script: "style-concept-audit.mjs",
  flags: {
    "--requirements": "Print this detection contract and exit without requiring --tenant.",
    "--sync-hashes":
      "Before auditing, recompute manifest stylesheet sha256/bytes from disk for themes[] and styleConcept stylesheet fields.",
    "--schema":
      "Manifest schema path. Defaults to style-concept.manifest.schema.json next to this tool.",
  },
  gates: [
    {
      gate: "schema",
      sources: ["manifest JSON", "style-concept.manifest.schema.json"],
      passWhen: [
        "no --manifest was supplied, or the manifest is present",
        "the manifest validates against the canonical style-concept manifest schema",
        "baseline/versioning and ecommerce quality-bar fields use canonical names",
      ],
      emits: ["path", "errorCount", "errors"],
    },
    {
      gate: "storyboard",
      sources: ["manifest.styleConcept.storyboard", "manifest.styleGaps[]"],
      passWhen: [
        "no --manifest was supplied, or the manifest is present",
        "styleConcept.storyboard.inspirationPages records why each source page shaped the concept",
        "styleConcept.storyboard.uncoveredElementPolicy tells page workers how to handle elements not covered by the guide",
        "styleGaps[] entries, when present, have id, element, status, disposition, and owner/review notes when unresolved",
      ],
      emits: ["inspirationCount", "sourcePagesMissingInspiration", "openStyleGapCount", "problems"],
    },
    {
      gate: "theme",
      sources: ["manifest.themes[]", "store public/"],
      passWhen: [
        "no --manifest was supplied, or the manifest is present",
        "exactly one theme has role=current",
        "each current/candidate/legacy theme has id, version, path",
        "each referenced theme stylesheet exists and its raw lowercase SHA-256 hash matches the manifest",
      ],
      emits: ["currentCount", "switchableCount", "problemCount", "problems"],
    },
    {
      gate: "css",
      sources: ["content/<tenant>/home.html", "content/<tenant>/pages-html/**/*.html"],
      passWhen: [
        "at least one tenant page was inspected",
        "max inline CSS bytes per page <= SM_INLINE_CSS_MAX_BYTES (default 4096)",
        "duplicate normalized rule ratio <= SM_CSS_DUPLICATE_RATIO_MAX (default 0.25)",
        "at least one shared stylesheet is linked",
      ],
      emits: [
        "pagesInspected",
        "tenantContentDir",
        "inlineCssBytesPerPageMax",
        "duplicateRuleRatio",
        "sharedStylesheetCount",
      ],
    },
    {
      gate: "chromeConcept",
      sources: [
        "content/<tenant>/chrome.html",
        "content/<tenant>/home.html",
        "content/<tenant>/pages-html/**/*.html",
        "tenant-owned linked stylesheets (public/pages/*.css)",
        "/shared/commerce-chrome.css (adoption signal)",
      ],
      passWhen: [
        "no structural chrome CSS (header/nav/mega/announce/footer/age-gate/tiles) is inlined in a <style> block — inline chrome is always banned",
        "once the tenant links /shared/commerce-chrome.css, no tenant-owned stylesheet re-authors those structural chrome selectors (no double ownership)",
        "a tenant that has not yet adopted the shared sheet reports its re-authored chrome as the migration gap, without blocking",
      ],
      emits: ["adopted", "inlineChromeCount", "reauthoredChromeCount", "sheetsScanned"],
      strict: true,
    },
    {
      gate: "readability",
      sources: ["tenant HTML", "inline CSS", "linked tenant/shared CSS"],
      passWhen: [
        "long-line ratio <= SM_READABILITY_LONG_LINE_RATIO_MAX (default 0.05)",
        "minified-line ratio <= SM_READABILITY_MINIFIED_LINE_RATIO_MAX (default 0.01)",
        "CSS declaration density <= SM_READABILITY_CSS_DENSITY_MAX (default 3.5)",
        "large shared stylesheets have >= SM_READABILITY_SECTION_COMMENTS_MIN section comments (default 2)",
      ],
      emits: [
        "pagesInspected",
        "tenantContentDir",
        "inspectedBlocks",
        "issueCount",
        "issueSamples",
        "maxLineLength",
        "cssDeclarationDensityMax",
      ],
    },
    {
      gate: "styleConcept",
      sources: ["manifest.styleConcept", "manifest.pages[]", "store public/"],
      passWhen: [
        "no --manifest was supplied, or the manifest is present",
        "styleConcept.id is present",
        "styleConcept.stylesheet.sha256 matches the current file hash",
        "every tracked page styleConcept id/version/stylesheetHash matches the current concept",
      ],
      emits: ["id", "version", "pagesTracked", "pagesConforming", "pagesDrifted"],
    },
    {
      gate: "styleGuide",
      sources: ["manifest.styleGuideIndex", "manifest.styleGuides[]", "manifest.themes[]"],
      passWhen: [
        "preview-only style-guide index route exists",
        "index is noindex and includeInSitemap=false",
        "each recorded theme has a standalone guide route linked from the index",
        "at least one current-theme guide has status=approved",
      ],
      emits: ["indexRoute", "approvedCurrentCount", "themesMissingStandaloneGuide", "problems"],
    },
    {
      gate: "manifestConventions",
      sources: ["manifest theme/styleConcept stylesheet paths and hashes"],
      passWhen: [
        "stylesheet paths are root-relative public paths beginning /tenants/<tenant>/",
        "stylesheet hashes are raw lowercase 64-character SHA-256 hex",
        "hashes do not use a sha256: prefix",
      ],
      emits: ["problemCount", "problems", "notes"],
    },
    {
      gate: "ecommerceStyleGuide",
      sources: ["manifest.ecommerceQualityBar", "current theme CSS", "current theme descriptor JSON"],
      passWhen: [
        "ecommerce quality bar status is approved",
        "all current themes satisfy the v1.1 static quality checks below",
      ],
      emits: ["requiredVersion", "status", "problemCount", "currentThemeRecords"],
    },
    {
      gate: "tokenContrast",
      sources: ["current theme :root CSS variables", "current theme descriptor token role text"],
      passWhen: [
        "each descriptor token with text/AA/safe-as-text intent resolves to a concrete CSS color",
        "normal text-role tokens meet contrast >= 4.5:1 against their declared backgrounds",
        "large/decorative/icon/focus tokens meet contrast >= 3:1 against their declared backgrounds",
        "button/background tokens that declare white text meet white-on-token contrast >= 4.5:1",
      ],
      emits: ["problemCount", "problems", "currentThemeRecords"],
    },
    {
      gate: "guideCoverage",
      sources: ["current theme CSS", "current theme descriptor JSON", "standalone style-guide source"],
      passWhen: [
        "every declared text-role token has at least one same-origin guide sample using a CSS color selector for that token",
        "the standalone guide renders the expected ecommerce component samples: CTA hierarchy, forms, rating/stars, testimonial, trust badge, reassurance, logo strip, proof, and card surface",
      ],
      emits: ["problemCount", "problems", "currentThemeRecords"],
    },
    {
      gate: "acceptedRisks",
      sources: ["manifest.acceptedRisks[]", "ecommerceQualityBar.acceptedRisks[]"],
      passWhen: [
        "accepted risk entries are absent, or every entry has gate, rationale, by, and at fields",
      ],
      emits: ["count", "problemCount", "problems"],
    },
  ],
  ecommerceStyleGuideRequirements: [
    {
      requirement: "token-contrast",
      source: "current theme :root CSS variables + descriptor token role text",
      detects: [
        "normal text-role tokens must be >= 4.5:1 on declared backgrounds",
        "large/icon/focus/decorative tokens must be >= 3:1 on declared backgrounds",
        "background tokens that claim white text must be >= 4.5:1 against #fff",
      ],
    },
    {
      requirement: "guide-coverage",
      source: "current theme CSS + descriptor JSON + standalone guide source",
      detects: [
        "text-role tokens must have rendered text/icon samples using selectors colored by that token",
        "CTA hierarchy, forms, validation states, ratings, testimonials, trust badges, reassurance, logo strips, proof strips, and card surfaces must appear in the guide",
      ],
    },
    {
      requirement: "semantic-tokens",
      source: "current theme CSS + descriptor JSON",
      detects: [
        "--color-cta or --cta",
        "--color-cta-hover or --cta-hover",
        "--color-trust or --trust",
        "--focus-ring",
        "--color-error or --error",
        "--color-success or --success",
        "--surface-card or --surface-raised",
        "--text-muted or --muted",
      ],
    },
    {
      requirement: "full-interactive-states",
      source: "current theme CSS + descriptor JSON",
      detects: [
        ":hover",
        ":active or [aria-pressed]",
        ":focus-visible",
        ":disabled or [disabled] or [aria-disabled]",
        "loading or aria-busy or is-loading",
        "invalid/error/success/help/validation",
        "prefers-reduced-motion",
      ],
    },
    {
      requirement: "cta-hierarchy",
      source: "current theme CSS + descriptor JSON",
      detects: [
        "primary CTA via btn-green/btn-primary/--color-cta/primary cta",
        "secondary CTA via btn-navy/btn-secondary/secondary cta",
        "tertiary CTA via btn-line/btn-tertiary/outline/tertiary cta",
      ],
    },
    {
      requirement: "trust-social-proof-components",
      source: "current theme CSS + descriptor JSON",
      detects: [
        "proof or trust",
        "customer review/review card/rating/stars/g2/capterra",
        "testimonial or quote",
        "badge/security/compliance/certif",
        "guarantee/returns/refund/warranty/risk-free",
        "logo strip/as seen/press/customer logos/partner logos",
      ],
    },
    {
      requirement: "accessible-forms",
      source: "current theme CSS + descriptor JSON",
      detects: [
        "form/input/textarea/select/field",
        "label/aria-label/aria-labelledby",
        "help/hint/description/aria-describedby",
        "error/success/invalid/required/optional",
      ],
    },
    {
      requirement: "mobile-tap-targets-and-fonts",
      source: "current theme CSS",
      detects: [
        "@media (max-width...) or clamp(...) responsive rules",
        "44px or min-height/min-width >= 44px tap target evidence",
      ],
    },
    {
      requirement: "color-scheme-and-reduced-motion",
      source: "current theme CSS",
      detects: ["color-scheme", "prefers-reduced-motion"],
    },
  ],
};

const CONTRAST_NORMAL_MIN = 4.5;
const CONTRAST_LARGE_ICON_MIN = 3;

function usage(message) {
  if (message) console.error(message);
  console.error(
    "usage: style-concept-audit.mjs --store <dir> [--manifest <json>] [--schema <json>] [--out <json>] [--sync-hashes]\n       style-concept-audit.mjs --tenant <id> --content-dir <dir> --public-dir <dir> [...]\n       style-concept-audit.mjs --requirements",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  const booleanFlags = new Set(["requirements", "sync-hashes", "strict"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) usage(`unknown positional arg: ${arg}`);
    const key = arg.slice(2);
    if (booleanFlags.has(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) usage(`missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  if (args.store) {
    const dir = realpathSync(args.store);
    storeLayout = { dir, tenant: args.tenant ?? storeTenant(dir) };
    args.tenant = storeLayout.tenant;
    args["content-dir"] ??= dirname(dir);
    args["public-dir"] ??= join(dir, "public");
  }
  if (!args.tenant && !args.requirements) usage("missing --store (or --tenant with --content-dir)");
  return {
    tenant: args.tenant,
    requirements: Boolean(args.requirements),
    syncHashes: Boolean(args["sync-hashes"]),
    strict: Boolean(args.strict),
    contentDir: args["content-dir"] ?? DEFAULT_CONTENT_DIR,
    publicDir: args["public-dir"] ?? DEFAULT_PUBLIC_DIR,
    schema: args.schema ?? DEFAULT_SCHEMA_PATH,
    manifest: args.manifest,
    out: args.out,
    inlineMax: Number(args["inline-max"] ?? DEFAULT_INLINE_MAX),
    duplicateMax: Number(args["duplicate-max"] ?? DEFAULT_DUP_MAX),
    readabilityLineMax: Number(args["readability-line-max"] ?? DEFAULT_READABILITY_LINE_MAX),
    readabilityLongLineRatioMax: Number(
      args["readability-long-line-ratio-max"] ?? DEFAULT_READABILITY_LONG_LINE_RATIO_MAX,
    ),
    readabilityMinifiedLineRatioMax: Number(
      args["readability-minified-line-ratio-max"] ?? DEFAULT_READABILITY_MINIFIED_LINE_RATIO_MAX,
    ),
    readabilityCssDensityMax: Number(
      args["readability-css-density-max"] ?? DEFAULT_READABILITY_CSS_DENSITY_MAX,
    ),
    readabilitySectionCommentsMin: Number(
      args["readability-section-comments-min"] ?? DEFAULT_READABILITY_SECTION_COMMENTS_MIN,
    ),
  };
}

async function walk(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requirementsContract() {
  return {
    ...REQUIREMENTS_CONTRACT,
    thresholds: {
      inlineCssBytesPerPageMax: DEFAULT_INLINE_MAX,
      duplicateRuleRatioMax: DEFAULT_DUP_MAX,
      readabilityLineMax: DEFAULT_READABILITY_LINE_MAX,
      readabilityLongLineRatioMax: DEFAULT_READABILITY_LONG_LINE_RATIO_MAX,
      readabilityMinifiedLineRatioMax: DEFAULT_READABILITY_MINIFIED_LINE_RATIO_MAX,
      readabilityCssDensityMax: DEFAULT_READABILITY_CSS_DENSITY_MAX,
      readabilitySectionCommentsMin: DEFAULT_READABILITY_SECTION_COMMENTS_MIN,
    },
  };
}

function extractStyleBlocks(html) {
  return Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)).map((match) => match[1] ?? "");
}

function extractStylesheetLinks(html, tenant) {
  return Array.from(html.matchAll(/<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi))
    .map((match) => match[0])
    .map((tag) => {
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
      return href;
    })
    .filter(Boolean)
    .filter((href) => href.startsWith(`/tenants/${tenant}/`) || href.startsWith("/assets/") || href.startsWith("http"));
}

function normalizeCssRules(css) {
  const stripped = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@media[^{]+\{/g, (match) => `${match.trim()} `);
  return stripped
    .split("}")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.includes("{"))
    .map((chunk) => `${chunk}}`)
    .map((rule) =>
      rule
        .replace(/\s+/g, " ")
        .replace(/\s*([{}:;,>+~])\s*/g, "$1")
        .replace(/;}/g, "}")
        .trim(),
    )
    .filter((rule) => rule.length > 6);
}

function stripCssComments(text) {
  return String(text ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseRootTokens(css) {
  const tokens = {};
  for (const match of stripCssComments(css).matchAll(/:root\s*\{([\s\S]*?)\}/g)) {
    const body = match[1] ?? "";
    for (const decl of body.matchAll(/(--[a-z0-9_-]+)\s*:\s*([^;]+);/gi)) {
      tokens[decl[1]] = decl[2].trim();
    }
  }
  return tokens;
}

function resolveCssValue(value, rootTokens, seen = new Set()) {
  let out = String(value ?? "").trim();
  for (let i = 0; i < 8; i += 1) {
    const next = out.replace(/var\(\s*(--[a-z0-9_-]+)\s*(?:,[^)]+)?\)/gi, (match, tokenName) => {
      if (seen.has(tokenName)) return match;
      const replacement = rootTokens[tokenName];
      if (!replacement) return match;
      seen.add(tokenName);
      return resolveCssValue(replacement, rootTokens, seen);
    });
    if (next === out) break;
    out = next.trim();
  }
  return out;
}

function parseCssColor(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw.includes("gradient") || raw === "transparent") return null;
  const named = {
    white: "#ffffff",
    black: "#000000",
  };
  const normalized = named[raw] ?? raw;
  const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
  if (hex) {
    const body = hex[1];
    const full = body.length === 3
      ? body.split("").map((char) => `${char}${char}`).join("")
      : body;
    return {
      hex: `#${full.toLowerCase()}`,
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
    };
  }
  const rgb = normalized.match(/^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/i);
  if (rgb) {
    const [r, g, b] = rgb.slice(1, 4).map((part) => Math.max(0, Math.min(255, Number(part))));
    const hexValue = [r, g, b]
      .map((part) => Math.round(part).toString(16).padStart(2, "0"))
      .join("");
    return { hex: `#${hexValue}`, r, g, b };
  }
  return null;
}

function luminancePart(value) {
  const channel = value / 255;
  return channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground, background) {
  const fgLum = 0.2126 * luminancePart(foreground.r) +
    0.7152 * luminancePart(foreground.g) +
    0.0722 * luminancePart(foreground.b);
  const bgLum = 0.2126 * luminancePart(background.r) +
    0.7152 * luminancePart(background.g) +
    0.0722 * luminancePart(background.b);
  const light = Math.max(fgLum, bgLum);
  const dark = Math.min(fgLum, bgLum);
  return Number(((light + 0.05) / (dark + 0.05)).toFixed(2));
}

function descriptorColorTokens(descriptor) {
  const tokens = descriptor?.tokens ?? {};
  return [
    ...(Array.isArray(tokens.color) ? tokens.color.map((token) => ({ ...token, group: "color" })) : []),
    ...(Array.isArray(tokens.semantic) ? tokens.semantic.map((token) => ({ ...token, group: "semantic" })) : []),
  ].filter((token) => token?.var);
}

function tokenColor(token, rootTokens) {
  const raw = rootTokens[token.var] ?? token.value;
  const resolved = resolveCssValue(raw, rootTokens);
  const color = parseCssColor(resolved);
  return { raw, resolved, color };
}

function textRoleIntent(token) {
  const role = String(token.role ?? "").toLowerCase();
  const name = `${token.name ?? ""} ${token.var ?? ""}`.toLowerCase();
  const haystack = `${name} ${role}`;
  const bgOnly = /\bbg\b|background|surface|card|raised surface|border|hairline|line\b/.test(haystack) &&
    !/heading|body text|secondary text|muted|safe as text|small text|text-safe|validation|error|success|warning|rating|aa on|focus/.test(haystack);
  const whiteTextOnBg = /white text/.test(role);
  const textLike = /safe as text|text-safe|body text|secondary text|small text|heading|headings|muted|validation|error|success|warning|link|kicker|emphasis|rating|aa on/.test(haystack);
  const visualOnly = /decorative|icon|large|focus|outline/.test(haystack) &&
    !/safe as text|small text|body text|secondary text|text-safe/.test(haystack);
  return {
    applies: whiteTextOnBg || visualOnly || (textLike && !bgOnly),
    whiteTextOnBg,
    threshold: visualOnly ? CONTRAST_LARGE_ICON_MIN : CONTRAST_NORMAL_MIN,
    role,
    kind: whiteTextOnBg ? "white-text-on-token-background" : visualOnly ? "large-or-icon" : "normal-text",
  };
}

function backgroundTargetsForRole(role, backgrounds) {
  const wanted = new Set();
  if (/cream/.test(role) || /page/.test(role)) wanted.add("cream/page");
  if (/white/.test(role) || /card/.test(role)) wanted.add("card/white");
  if (/navy|dark/.test(role)) wanted.add("navy");
  if (/safe as text|text-safe|body text|secondary text|muted|validation|error|success|warning|emphasis/.test(role)) {
    wanted.add("cream/page");
    wanted.add("card/white");
  }
  if (wanted.size === 0) {
    wanted.add("cream/page");
    wanted.add("card/white");
  }
  return backgrounds.filter((background) => wanted.has(background.name));
}

function declaredBackgrounds(tokens, rootTokens) {
  const byName = new Map();
  const add = (name, token) => {
    const value = tokenColor(token, rootTokens);
    if (value.color && !byName.has(name)) {
      byName.set(name, {
        name,
        token: token.var ?? token.name ?? name,
        value: value.color.hex,
        color: value.color,
      });
    }
  };
  for (const token of tokens) {
    const key = `${token.name ?? ""} ${token.var ?? ""}`.toLowerCase();
    if (/\bcream\b|--cream|page/.test(key)) add("cream/page", token);
    if (/\bcard\b|surface-card|--card/.test(key)) add("card/white", token);
    if (/\bnavy\b|--navy$/.test(key)) add("navy", token);
  }
  if (!byName.has("card/white")) {
    byName.set("card/white", {
      name: "card/white",
      token: "#ffffff",
      value: "#ffffff",
      color: parseCssColor("#ffffff"),
    });
  }
  return ["cream/page", "card/white", "navy"].map((name) => byName.get(name)).filter(Boolean);
}

function inspectTokenContrast(theme, asset, descriptor) {
  const rootTokens = parseRootTokens(asset?.text ?? "");
  const tokens = descriptorColorTokens(descriptor);
  const backgrounds = declaredBackgrounds(tokens, rootTokens);
  const problems = [];
  const checked = [];
  const skipped = [];

  for (const token of tokens) {
    const intent = textRoleIntent(token);
    if (!intent.applies) {
      skipped.push({ name: token.name ?? null, var: token.var, reason: "not a text/large/icon contrast role" });
      continue;
    }
    const foreground = tokenColor(token, rootTokens);
    if (!foreground.color) {
      problems.push({
        token: token.var,
        name: token.name ?? null,
        role: token.role ?? null,
        problem: `could not resolve token color from ${foreground.resolved || foreground.raw || "empty value"}`,
      });
      continue;
    }

    if (intent.whiteTextOnBg) {
      const white = parseCssColor("#ffffff");
      const ratio = contrastRatio(white, foreground.color);
      const comparison = {
        token: token.var,
        name: token.name ?? null,
        role: token.role ?? null,
        kind: intent.kind,
        foreground: "#ffffff",
        background: foreground.color.hex,
        backgroundToken: token.var,
        ratio,
        threshold: CONTRAST_NORMAL_MIN,
        pass: ratio >= CONTRAST_NORMAL_MIN,
      };
      checked.push(comparison);
      if (!comparison.pass) problems.push(comparison);
      continue;
    }

    const targets = backgroundTargetsForRole(intent.role, backgrounds).filter(
      (background) => background.token !== token.var,
    );
    for (const background of targets) {
      const ratio = contrastRatio(foreground.color, background.color);
      const comparison = {
        token: token.var,
        name: token.name ?? null,
        role: token.role ?? null,
        kind: intent.kind,
        foreground: foreground.color.hex,
        background: background.value,
        backgroundName: background.name,
        backgroundToken: background.token,
        ratio,
        threshold: intent.threshold,
        pass: ratio >= intent.threshold,
      };
      checked.push(comparison);
      if (!comparison.pass) problems.push(comparison);
    }
  }

  return {
    themeId: theme.id ?? null,
    pass: problems.length === 0,
    thresholds: {
      normalText: CONTRAST_NORMAL_MIN,
      largeOrIcon: CONTRAST_LARGE_ICON_MIN,
    },
    backgrounds: backgrounds.map((background) => ({
      name: background.name,
      token: background.token,
      value: background.value,
    })),
    checkedCount: checked.length,
    checked,
    skippedCount: skipped.length,
    skipped: skipped.slice(0, 12),
    problemCount: problems.length,
    problems,
  };
}

function parseCssRuleBlocks(css) {
  const stripped = stripCssComments(css);
  const rules = [];
  for (const match of stripped.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? "")
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean);
    const body = match[2] ?? "";
    rules.push({ selectors, body });
  }
  return rules;
}

// ── Chrome-concept gate ─────────────────────────────────────────────────────
// Fails a tenant that re-authors or inlines the shared chrome's structural CSS
// instead of relying on the ONE platform sheet (/shared/commerce-chrome.css).
// Source-level gate (like `css`): scans the tenant's OWN chrome sources — the
// chrome partial + page HTML (inline <style>) and every tenant-owned linked
// stylesheet — for definitions of CHROME_STRUCTURAL_CLASSES.

/** Structural chrome classes a selector defines/targets (incl. BEM __ / -- variants). */
function chromeClassesInSelector(selector) {
  const classes = Array.from(String(selector).matchAll(/\.([a-z0-9_-]+)/gi)).map((m) => m[1]);
  const hits = new Set();
  for (const cls of classes) {
    for (const base of CHROME_STRUCTURAL_CLASSES) {
      if (cls === base || cls.startsWith(`${base}__`) || cls.startsWith(`${base}--`)) hits.add(cls);
    }
  }
  return Array.from(hits);
}

/** All rules in a CSS body that define a structural chrome selector. */
function scanChromeSelectors(css) {
  const out = [];
  for (const rule of parseCssRuleBlocks(css)) {
    for (const selector of rule.selectors) {
      const classes = chromeClassesInSelector(selector);
      if (classes.length) out.push({ selector: selector.replace(/\s+/g, " ").trim(), classes });
    }
  }
  return out;
}

function extractAllStylesheetHrefs(html) {
  return Array.from(html.matchAll(/<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi))
    .map((match) => /href=["']([^"']+)["']/i.exec(match[0])?.[1] ?? "")
    .filter(Boolean);
}

/** Resolve `tenants/<tenant>` even when the on-disk dir carries a TLD suffix
 *  (a caller may pass the bare scope "example" for dir "example.net"). */
async function resolveTenantDir(contentDir, tenant) {
  if (storeLayout) return existsSync(join(storeLayout.dir, "content")) ? storeLayout.dir : null;
  const direct = join(contentDir, tenant);
  if (existsSync(join(direct, "content"))) return direct;
  // Platform test tenants nest one level deeper, under `<contentDir>/e2e/<id>/`.
  const nested = join(contentDir, NESTED_TEST_STORE_DIR, tenant);
  if (existsSync(join(nested, "content"))) return nested;
  if (!existsSync(contentDir)) return null;
  const entries = await readdir(contentDir, { withFileTypes: true });
  const match = entries.find(
    (entry) => entry.isDirectory() && entry.name.startsWith(`${tenant}.`) &&
      existsSync(join(contentDir, entry.name, "content")),
  );
  return match ? join(contentDir, match.name) : null;
}

/** Map a tenant-owned link href (/tenants/<dir>/pages/mkt.css) to its source file
 *  (tenants/<dir>/public/pages/mkt.css). Returns null for shared/foreign hrefs. */
function tenantSheetPath(href, tenantDir) {
  const dirName = storeLayout ? storeLayout.tenant : basename(tenantDir);
  const prefix = `/tenants/${dirName}/`;
  if (!href.startsWith(prefix) || !href.endsWith(".css")) return null;
  return join(tenantDir, "public", href.slice(prefix.length));
}

async function inspectChromeConcept(contentDir, tenant) {
  const tenantDir = await resolveTenantDir(contentDir, tenant);
  if (!tenantDir) {
    return { present: false, tenantDir: null };
  }
  const contentRoot = join(tenantDir, "content");
  const htmlFiles = (await walk(contentRoot)).filter(
    (file) => /(^|\/)(chrome|home|pages-html\/.*)\.html$/i.test(relative(contentRoot, file)),
  );

  const hrefs = new Set();
  const inlineChrome = [];
  for (const file of htmlFiles) {
    const html = await readFile(file, "utf8");
    for (const href of extractAllStylesheetHrefs(html)) hrefs.add(href);
    const rel = relative(".", file);
    for (const block of extractStyleBlocks(html)) {
      for (const hit of scanChromeSelectors(block)) inlineChrome.push({ source: rel, ...hit });
    }
  }

  const adopted = hrefs.has(SHARED_CHROME_HREF);
  const reauthoredChrome = [];
  const sheetsScanned = [];
  for (const href of hrefs) {
    const path = tenantSheetPath(href, tenantDir);
    if (!path || !existsSync(path)) continue;
    sheetsScanned.push(href);
    const css = await readFile(path, "utf8");
    for (const hit of scanChromeSelectors(css)) reauthoredChrome.push({ sheet: href, ...hit });
  }

  return {
    present: true,
    tenantDir: relative(".", tenantDir),
    adopted,
    sharedStylesheetHref: adopted ? SHARED_CHROME_HREF : null,
    inlineChromeCount: inlineChrome.length,
    reauthoredChromeCount: reauthoredChrome.length,
    inlineChrome: inlineChrome.slice(0, CHROME_VIOLATION_SAMPLE_MAX),
    reauthoredChrome: reauthoredChrome.slice(0, CHROME_VIOLATION_SAMPLE_MAX),
    sheetsScanned: sheetsScanned.sort(),
    htmlFilesScanned: htmlFiles.length,
  };
}

/** Reported gate pass rule: inline chrome CSS is ALWAYS banned; re-authored chrome
 *  in a tenant sheet is banned once the tenant has adopted the shared sheet
 *  (double-ownership). A tenant with no resolvable content is vacuously clean. */
function chromeConceptPass(chrome) {
  if (!chrome.present) return true;
  if (chrome.inlineChromeCount > 0) return false;
  return chrome.adopted ? chrome.reauthoredChromeCount === 0 : true;
}

function tokenAliasVars(token, rootTokens) {
  const out = [token.var];
  const raw = rootTokens[token.var] ?? token.value ?? "";
  for (const match of String(raw).matchAll(/var\(\s*(--[a-z0-9_-]+)\s*(?:,[^)]+)?\)/gi)) {
    out.push(match[1]);
  }
  return Array.from(new Set(out.filter(Boolean)));
}

function selectorsUsingVisualToken(css, tokenVars, intent) {
  const rules = parseCssRuleBlocks(css);
  const properties = intent.kind === "normal-text"
    ? ["color"]
    : ["color", "background", "background-color", "border-color", "outline", "outline-color", "box-shadow", "fill", "stroke"];
  const propPattern = `(?:${properties.map((prop) => prop.replace("-", "\\-")).join("|")})`;
  const out = [];
  const tokenPattern = tokenVars
    .map((tokenVar) => tokenVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const visualPattern = new RegExp(`(?:^|;)\\s*${propPattern}\\s*:[^;]*var\\(\\s*(?:${tokenPattern})\\b`, "i");
  for (const rule of rules) {
    if (!visualPattern.test(rule.body)) continue;
    out.push(...rule.selectors);
  }
  return Array.from(new Set(out));
}

function selectorCoverageEvidence(selector, guideText) {
  const source = String(guideText ?? "");
  const classes = Array.from(selector.matchAll(/\.([a-z0-9_-]+)/gi)).map((match) => match[1]);
  const ids = Array.from(selector.matchAll(/#([a-z0-9_-]+)/gi)).map((match) => match[1]);
  const tag = selector
    .replace(/:[a-z-]+(?:\([^)]*\))?/gi, "")
    .trim()
    .match(/^([a-z][a-z0-9-]*)\b/i)?.[1];
  const classHits = classes.filter((name) =>
    new RegExp(`class=["'][^"']*\\b${name}\\b`, "i").test(source) || source.includes(`.${name}`),
  );
  const idHits = ids.filter((name) =>
    new RegExp(`id=["']${name}["']`, "i").test(source) || source.includes(`#${name}`),
  );
  const tagHit = tag ? new RegExp(`<${tag}\\b`, "i").test(source) : false;
  const interactiveFocusSample =
    selector.replace(/:[a-z-]+(?:\([^)]*\))?/gi, "").trim() === "" &&
    /<(a|button|input|textarea|select|summary)\b/i.test(source);
  const pass =
    (classes.length > 0 && classHits.length === classes.length) ||
    (ids.length > 0 && idHits.length === ids.length) ||
    (classes.length === 0 && ids.length === 0 && (tagHit || interactiveFocusSample));
  return {
    selector,
    pass,
    classHits,
    idHits,
    tagHit,
    interactiveFocusSample,
  };
}

/**
 * A required component can be PRESENT in the guide and still be worthless as evidence: the trust
 * and social-proof samples ship as marked placeholders — "needs-review", "placeholder", and in one
 * case the literal instruction "do not ship until sourced" — because ratings, testimonials, badges,
 * guarantees and partner logos require merchant-supplied evidence that no template can invent.
 *
 * A plain substring match counts those as covered, which is how a quality bar can report
 * trust-components PASS over content that says do not ship. Found 2026-09-20 by a human reading the
 * rendered guide, after the audit had called the same guide's six families met.
 *
 * True only when EVERY occurrence of the pattern sits in placeholder-marked context; one sourced
 * instance is enough to make the component real.
 */
function componentEvidenceIsUnsourced(guideText, patterns) {
  // Only DELIBERATE authored signals count. The bare word "placeholder" must never be one: the
  // guide's own accessible-form sample carries `placeholder="you@example.com"`, an ordinary HTML
  // attribute, and matching it called sourced form components unsourced. "TODO" is out for the
  // same reason — it appears in implementation comments about offline image paths.
  // `\(placeholder` is the PROSE form ("… partner logos (placeholder):") and is deliberately
  // distinct from the HTML attribute `placeholder="…"`, which is not a marker at all.
  const MARKERS = /needs-review|do not ship|source before use|\(placeholder/i;
  // Same LINE, not a byte window. Proximity is not evidence: a fixed window let a neighbouring
  // section's marker condemn a sourced component, and the distance at which that happens is an
  // accident of formatting. The guide marks its placeholders inline — `<span class="trust-badge">
  // ... — needs-review</span>` — so the marker and the thing it qualifies share a line.
  // The marker sits either inline with the component or on the caption line immediately above it
  // (`<p …>Logo strip — … (placeholder):</p>` then `<div class="logo-strip">`). One line of lead
  // is how captions are written; more than that is proximity guessing again.
  const lineAround = (at) => {
    const lineStart = guideText.lastIndexOf("\n", at) + 1;
    const prevStart = guideText.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1;
    const endRaw = guideText.indexOf("\n", at);
    return guideText.slice(prevStart, endRaw === -1 ? guideText.length : endRaw);
  };
  let sawAny = false;
  for (const pattern of patterns) {
    let from = 0;
    for (;;) {
      const at = guideText.indexOf(pattern, from);
      if (at === -1) break;
      sawAny = true;
      if (!MARKERS.test(lineAround(at))) return false;
      from = at + pattern.length;
    }
  }
  return sawAny;
}

/**
 * Approval blockers the audit computes itself, rather than echoing the manifest's own prose.
 *
 * Returns nothing while the bar is unapproved — an unapproved bar is already blocked and saying so
 * twice is noise. It speaks when someone marks it `approved` while required components exist only
 * as placeholders, which is the moment the record would start asserting something untrue.
 */
function unsourcedApprovalBlockers(ecommerceBar, currentThemes) {
  const unsourced = Array.from(
    new Set(currentThemes.flatMap((theme) => theme.guideCoverage?.unsourcedComponents ?? [])),
  );
  if (unsourced.length === 0) return [];
  if (String(ecommerceBar?.status ?? "").toLowerCase() !== "approved") return [];
  return [
    `The quality bar is marked approved, but ${unsourced.length} required component(s) appear in the ` +
      `style guide only as marked placeholders: ${unsourced.join(", ")}. These need merchant-supplied ` +
      `evidence — the claimsPolicy forbids fabricating ratings, testimonials, badges, guarantees or ` +
      `partner logos — so the approval asserts more than the guide shows.`,
  ];
}

/**
 * Do the authored-CSS gates (css, readability) apply to this tenant at all?
 *
 * Both weigh the hygiene of CSS authored into ported pages — inline-CSS bytes per page, duplicate
 * rules, minified or unreadable blocks. A tenant whose pages are structured JSON has none of that
 * by construction, so scoring it reports the tenant's SHAPE as a quality failure. Measured on
 * a structured-JSON store: 0 inline-style markers across its content JSON, and the gates
 * reported FAIL with `pagesInspected: 0`.
 *
 * Not-applicable requires POSITIVE evidence of the JSON shape. "No HTML pages" alone is also what a
 * raw-HTML tenant looks like when its pages have gone missing — a real regression these gates
 * should still catch — so a tree with neither shape stays a failure, and so does a tenant with no
 * content tree at all (which is the unprepared-checkout case the Step 8 preflight refuses upstream).
 */
export function authoredCssGatesNotApplicable({ tenantDirResolved, htmlPageCount, jsonPageCount }) {
  if (!tenantDirResolved) return false;
  if (htmlPageCount > 0) return false;
  return jsonPageCount > 0;
}

function descriptorTokenGroupsRendered(guideText) {
  const source = String(guideText ?? "");
  return {
    color: /tk\.color|\(tk\.color\s*\?\?/.test(source),
    semantic: /tk\.semantic|\(tk\.semantic\s*\?\?/.test(source),
  };
}

function requiredGuideComponentPatterns() {
  return [
    { name: "primary CTA", patterns: ["btn-primary", "btn-green"] },
    { name: "secondary CTA", patterns: ["btn-secondary", "btn-navy"] },
    { name: "tertiary CTA", patterns: ["btn-tertiary", "btn-line", "btn-outline"] },
    { name: "accessible form", patterns: ["form-field", "form-control", "form-label"] },
    { name: "validation states", patterns: ["field-error", "field-success", "aria-invalid"] },
    { name: "rating/stars", patterns: ["rating", "stars"] },
    { name: "testimonial/quote", patterns: ["testimonial", "quote"] },
    { name: "trust badge", patterns: ["trust-badge"] },
    { name: "reassurance", patterns: ["reassurance"] },
    { name: "logo strip", patterns: ["logo-strip"] },
    { name: "proof strip", patterns: ["proof"] },
    { name: "card/surface", patterns: ["sg-card", "review-card"] },
    { name: "warm emphasis sample", patterns: ["support-line"] },
    // Compliance notice widgets (components/compliance/) — the guide must
    // exercise each so a token regression on the regulated-commerce surface
    // fails the gate instead of by eyeball (unit compliance-notice-widgets).
    { name: "nicotine warning (FDA)", patterns: ["NicotineWarning", "nicotine-warning"] },
    { name: "PACT Act notice", patterns: ["PactActNotice", "pact-act"] },
    { name: "adult signature notice", patterns: ["AdultSignatureNotice", "adult-signature"] },
    { name: "Prop 65 warning", patterns: ["Prop65Warning", "prop65"] },
    { name: "purchase limit notice", patterns: ["PurchaseLimitNotice", "purchase-limit"] },
    // Jurisdiction display widgets (components/compliance/, unit
    // jurisdiction-widgets) — state eligibility, shipping restriction, and
    // excise-tax DISPLAY surfaces; guarded so a regression fails mechanically.
    { name: "state eligibility notice", patterns: ["StateEligibilityNotice", "state-eligibility"] },
    { name: "shipping restriction notice", patterns: ["ShippingRestrictionNotice", "shipping-restriction"] },
    { name: "excise tax notice", patterns: ["ExciseTaxNotice", "excise-tax"] },
    // Membership/pricing tier widgets (components/membership/) — the guide must
    // exercise both so an illustrative-figures regression on the education-only
    // tier surface fails the gate instead of by eyeball (unit
    // membership-tier-cards).
    { name: "tier cards", patterns: ["TierCards", "tier-cards"] },
    { name: "tier comparison table", patterns: ["TierComparisonTable", "tier-comparison-table"] },
    // Subscription/Autopilot education widgets (components/subscription/) —
    // the guide must exercise each so a regression on the education-only
    // Autopilot surface fails the gate instead of by eyeball (unit
    // subscription-education-selfservice).
    { name: "subscription how-it-works", patterns: ["HowItWorksSteps", "subscription-how-it-works"] },
    { name: "subscription savings explainer", patterns: ["SavingsExplainer", "subscription-savings-explainer"] },
    { name: "subscription manage entry", patterns: ["ManageSubscriptionEntry", "subscription-manage-entry"] },
    // Review/UGC widgets (components/commerce/) — the guide must exercise both
    // so a regression on the review-markup surface fails the gate instead of
    // by eyeball (unit reviews-ugc-widgets).
    { name: "review summary", patterns: ["ReviewSummary", "review-summary"] },
    { name: "review list", patterns: ["ReviewList", "review-list"] },
    // Interactive islands (components/islands/) — client-hydrated Preact
    // components; guarded so a regression to any of these self-contained
    // islands fails the gate instead of by eyeball (unit style-guide-full-coverage).
    { name: "age gate island", patterns: ["AgeGate"] },
    { name: "variant selector island", patterns: ["VariantSelector"] },
    { name: "quick view island", patterns: ["QuickView"] },
    { name: "search typeahead island", patterns: ["SearchTypeahead"] },
    { name: "mobile nav island", patterns: ["MobileNav"] },
    { name: "recently viewed island", patterns: ["RecentlyViewed"] },
    { name: "saved list island", patterns: ["SavedList"] },
    // PLP controls (components/plp/) — URL-addressable faceted search chrome.
    { name: "PLP facet sidebar", patterns: ["FacetSidebar"] },
    { name: "PLP active filters", patterns: ["ActiveFilters"] },
    { name: "PLP sort select", patterns: ["SortSelect"] },
    { name: "PLP pagination", patterns: ["Pagination"] },
    // Home hero (components/home/) — the homepage signature moment. Matched
    // on the import path since "Hero" alone collides with prose already in
    // the guide (the ported mkt.css .hero sample).
    { name: "home hero", patterns: ["home/Hero"] },
    // Marketing blocks (components/marketing/) — the block library a
    // marketing-siteType tenant composes pages from (distinct from the
    // ported mkt.css section above), dispatched through <MarketingBlocks>.
    // Matched on each block's `component:` discriminator string (the literal
    // component/import names don't appear in the guide's own source since
    // the dispatcher renders them indirectly).
    { name: "marketing hero block", patterns: ['component: "marketing_hero"'] },
    { name: "marketing trust bar", patterns: ['component: "trust_bar"'] },
    { name: "marketing split compare", patterns: ['component: "split_compare"'] },
    { name: "marketing steps", patterns: ['component: "steps"'] },
    { name: "marketing card grid", patterns: ['component: "card_grid"'] },
    { name: "marketing integrations", patterns: ['component: "integrations"'] },
    { name: "marketing code sample", patterns: ["@tot/sdk"] },
    { name: "marketing proof strip", patterns: ['component: "proof_strip"'] },
    { name: "marketing testimonials", patterns: ['component: "testimonials"'] },
    { name: "marketing faq", patterns: ['component: "faq"'] },
    { name: "marketing cta band", patterns: ['component: "cta_band"'] },
  ];
}

async function inspectGuideCoverage(theme, asset, descriptor, guide) {
  const sourcePath = guide?.sourcePath ?? null;
  const result = {
    themeId: theme.id ?? null,
    guideId: guide?.id ?? null,
    route: guide?.route ?? null,
    sourcePath,
    pass: false,
    /** @type {any[]} */
    tokenProblems: [],
    /** @type {any[]} */
    componentProblems: [],
    /** @type {any[]} */
    tokenCoverage: [],
    /** @type {any[]} */
    componentCoverage: [],
    // Required components whose only evidence is placeholder-marked. Present, but not real.
    /** @type {string[]} */
    unsourcedComponents: [],
    /** @type {string[]} */
    notes: [],
  };
  if (!sourcePath || !existsSync(sourcePath)) {
    result.notes.push("standalone guide sourcePath is missing or not readable");
    return result;
  }

  const guideText = await readFile(sourcePath, "utf8");
  const tokenGroupsRendered = descriptorTokenGroupsRendered(guideText);
  const rootTokens = parseRootTokens(asset?.text ?? "");
  const tokens = descriptorColorTokens(descriptor);
  const css = asset?.text ?? "";

  for (const token of tokens) {
    const intent = textRoleIntent(token);
    if (!intent.applies || intent.whiteTextOnBg) continue;
    const tokenValue = tokenColor(token, rootTokens);
    if (!tokenValue.color) continue;
    const tokenVars = tokenAliasVars(token, rootTokens);
    const selectors = selectorsUsingVisualToken(css, tokenVars, intent);
    const selectorEvidence = selectors.map((selector) => selectorCoverageEvidence(selector, guideText));
    const renderedByTokenList = Boolean(tokenGroupsRendered[token.group]);
    const renderedBySample = selectorEvidence.some((entry) => entry.pass);
    const coverage = {
      name: token.name ?? null,
      var: token.var,
      role: token.role ?? null,
      group: token.group,
      renderedByTokenList,
      selectorCount: selectors.length,
      tokenVars,
      renderedBySample,
      selectorSamples: selectorEvidence.slice(0, 6),
      pass: renderedBySample,
    };
    result.tokenCoverage.push(coverage);
    if (!coverage.pass) {
      result.tokenProblems.push({
        token: token.var,
        name: token.name ?? null,
        role: token.role ?? null,
        problem: renderedByTokenList
          ? "token appears in descriptor swatches but has no rendered text/icon sample exercising its color"
          : "token is not rendered by descriptor swatches or text/icon samples",
        selectors: selectors.slice(0, 6),
      });
    }
  }

  for (const requirement of requiredGuideComponentPatterns()) {
    const hit = requirement.patterns.some((pattern) => guideText.includes(pattern));
    const unsourced = hit && componentEvidenceIsUnsourced(guideText, requirement.patterns);
    const coverage = {
      name: requirement.name,
      patterns: requirement.patterns,
      pass: hit,
      // Present but not yet real. Kept separate from `pass` on purpose: the guide template is
      // shared, so these samples ship as placeholders for EVERY tenant and failing coverage on
      // them would make the gate unpassable rather than informative. What they must block is
      // APPROVAL — see ecommerceStyleGuide, which refuses `approved` while any remain.
      unsourced,
    };
    result.componentCoverage.push(coverage);
    if (unsourced) result.unsourcedComponents.push(requirement.name);
    if (!hit) {
      result.componentProblems.push({
        component: requirement.name,
        expectedAny: requirement.patterns,
      });
    }
  }

  result.pass = result.tokenProblems.length === 0 && result.componentProblems.length === 0;
  return result;
}

function lineReadability(text, args) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const nonBlankLines = lines.filter((line) => line.trim().length > 0);
  const lengths = lines.map((line) => line.length);
  const longLines = nonBlankLines.filter((line) => line.length > args.readabilityLineMax);
  const minifiedLines = nonBlankLines.filter((line) => {
    const trimmed = line.trim();
    const punctuation = (trimmed.match(/[{};]/g) ?? []).length;
    const whitespaceRatio = (trimmed.match(/\s/g) ?? []).length / Math.max(1, trimmed.length);
    return (
      trimmed.length > args.readabilityLineMax * 2 &&
      punctuation >= 8 &&
      whitespaceRatio < 0.18
    );
  });
  return {
    lines: lines.length,
    nonBlankLines: nonBlankLines.length,
    maxLineLength: Math.max(0, ...lengths),
    longLines: longLines.length,
    longLineRatio:
      nonBlankLines.length > 0
        ? Number((longLines.length / nonBlankLines.length).toFixed(4))
        : 0,
    minifiedLines: minifiedLines.length,
    minifiedLineRatio:
      nonBlankLines.length > 0
        ? Number((minifiedLines.length / nonBlankLines.length).toFixed(4))
        : 0,
  };
}

function cssReadability(text) {
  const nonBlankLines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
  const declarations = (text.match(/:[^;{}]+;/g) ?? []).length;
  const ruleBlocks = (text.match(/\{/g) ?? []).length;
  const sectionComments = (text.match(/\/\*\s*(?:={2,}|-{2,}|[A-Za-z][^*]{5,})\s*\*\//g) ?? [])
    .length;
  return {
    declarations,
    ruleBlocks,
    sectionComments,
    declarationsPerNonBlankLine:
      nonBlankLines > 0 ? Number((declarations / nonBlankLines).toFixed(2)) : 0,
  };
}

function readabilityItem({ label, kind, text, args, requireSections = false }) {
  const bytes = Buffer.byteLength(text);
  const line = lineReadability(text, args);
  const css = kind === "css" ? cssReadability(text) : null;
  const failures = [];
  if (line.longLineRatio > args.readabilityLongLineRatioMax) {
    failures.push("long-line-ratio");
  }
  if (line.minifiedLineRatio > args.readabilityMinifiedLineRatioMax) {
    failures.push("minified-line-shape");
  }
  if (
    css &&
    css.declarations >= 20 &&
    css.declarationsPerNonBlankLine > args.readabilityCssDensityMax
  ) {
    failures.push("dense-css-formatting");
  }
  if (
    requireSections &&
    bytes >= 2048 &&
    (css?.sectionComments ?? 0) < args.readabilitySectionCommentsMin
  ) {
    failures.push("missing-section-comments");
  }
  return {
    label,
    kind,
    bytes,
    pass: failures.length === 0,
    failures,
    ...line,
    css,
  };
}

function summarizeReadability(items) {
  const nonBlankLines = items.reduce((sum, item) => sum + item.nonBlankLines, 0);
  const longLines = items.reduce((sum, item) => sum + item.longLines, 0);
  const minifiedLines = items.reduce((sum, item) => sum + item.minifiedLines, 0);
  const cssDensities = items
    .map((item) => item.css?.declarationsPerNonBlankLine)
    .filter((value) => typeof value === "number");
  const failures = items.filter((item) => !item.pass);
  return {
    inspectedBlocks: items.length,
    maxLineLength: Math.max(0, ...items.map((item) => item.maxLineLength)),
    longLines,
    longLineRatio:
      nonBlankLines > 0 ? Number((longLines / nonBlankLines).toFixed(4)) : 0,
    minifiedLines,
    minifiedLineRatio:
      nonBlankLines > 0 ? Number((minifiedLines / nonBlankLines).toFixed(4)) : 0,
    cssDeclarationDensityMax: Math.max(0, ...cssDensities),
    sectionComments: items.reduce((sum, item) => sum + (item.css?.sectionComments ?? 0), 0),
    issueCount: failures.length,
    issueSamples: failures.slice(0, 5).map((item) => ({
      label: item.label,
      kind: item.kind,
      failures: item.failures,
      maxLineLength: item.maxLineLength,
      longLineRatio: item.longLineRatio,
      minifiedLineRatio: item.minifiedLineRatio,
      cssDeclarationDensity: item.css?.declarationsPerNonBlankLine ?? null,
      sectionComments: item.css?.sectionComments ?? null,
    })),
  };
}

function slugForFile(tenantRoot, file) {
  const rel = relative(tenantRoot, file);
  if (rel === "home.html") return "/";
  return `/${rel.replace(/^pages-html\//, "").replace(/\.html$/i, "").replace(/\/index$/i, "")}/`;
}

async function readPage(tenantRoot, file, tenant, args) {
  const html = await readFile(file, "utf8");
  const styles = extractStyleBlocks(html);
  const inlineCss = styles.join("\n");
  const rules = normalizeCssRules(inlineCss);
  const slug = slugForFile(tenantRoot, file);
  return {
    slug,
    path: file,
    bytes: Buffer.byteLength(html),
    inlineStyleBlocks: styles.length,
    inlineCssBytes: Buffer.byteLength(inlineCss),
    ruleCount: rules.length,
    rules,
    stylesheetLinks: extractStylesheetLinks(html, tenant),
    readability: {
      html: readabilityItem({ label: `${slug} html`, kind: "html", text: html, args }),
      inlineStyles: styles.map((style, index) =>
        readabilityItem({
          label: `${slug} inline-style-${index + 1}`,
          kind: "css",
          text: style,
          args,
        }),
      ),
    },
  };
}

async function hashPublicAsset(publicDir, href) {
  if (!href.startsWith("/")) return null;
  const path = publicPathFor(publicDir, href);
  if (!existsSync(path)) return null;
  const data = await readFile(path);
  const text = data.toString("utf8");
  return { path, sha256: sha256(data), bytes: data.length, text };
}

async function hashPublicHref(publicDir, href) {
  if (!href) return { found: false, href, reason: "missing path" };
  if (!href.startsWith("/")) {
    return { found: false, href, reason: "not a root-relative public path" };
  }
  const path = publicPathFor(publicDir, href);
  if (!existsSync(path)) return { found: false, href, path, reason: "file not found" };
  const data = await readFile(path);
  return { found: true, href, path, sha256: sha256(data), bytes: data.length };
}

function setIfChanged(target, key, value, label, updates) {
  if (!target || value === undefined || target[key] === value) return;
  updates.push({
    field: label,
    before: target[key] ?? null,
    after: value,
  });
  target[key] = value;
}

async function syncManifestHashes(manifestPath, publicDir) {
  if (!manifestPath) usage("--sync-hashes requires --manifest <json>");
  if (!existsSync(manifestPath)) usage(`--sync-hashes manifest not found: ${manifestPath}`);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const updates = [];
  const missing = [];
  const seenByHref = new Map();
  const hashHref = async (href) => {
    if (seenByHref.has(href)) return seenByHref.get(href);
    const result = await hashPublicHref(publicDir, href);
    seenByHref.set(href, result);
    return result;
  };

  for (const theme of manifest.themes ?? []) {
    const result = await hashHref(theme.path);
    if (!result.found) {
      missing.push({ field: `themes[${theme.id ?? "unknown"}].path`, href: theme.path ?? null, reason: result.reason });
      continue;
    }
    setIfChanged(theme, "sha256", result.sha256, `themes[${theme.id ?? "unknown"}].sha256`, updates);
    setIfChanged(theme, "bytes", result.bytes, `themes[${theme.id ?? "unknown"}].bytes`, updates);
  }

  const concept = manifest.styleConcept;
  if (concept?.stylesheet?.path) {
    const result = await hashHref(concept.stylesheet.path);
    if (!result.found) {
      missing.push({ field: "styleConcept.stylesheet.path", href: concept.stylesheet.path, reason: result.reason });
    } else {
      setIfChanged(concept.stylesheet, "sha256", result.sha256, "styleConcept.stylesheet.sha256", updates);
      setIfChanged(concept.stylesheet, "bytes", result.bytes, "styleConcept.stylesheet.bytes", updates);
    }
  }

  if (concept?.stylesheetPath || concept?.sha256) {
    const href = concept.stylesheetPath ?? concept.stylesheet?.path;
    const result = await hashHref(href);
    if (!result.found) {
      missing.push({ field: "styleConcept.stylesheetPath", href: href ?? null, reason: result.reason });
    } else {
      setIfChanged(concept, "sha256", result.sha256, "styleConcept.sha256", updates);
    }
  }

  if (updates.length > 0) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return {
    manifest: manifestPath,
    publicDir,
    updated: updates.length,
    updates,
    missing,
  };
}

async function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

function schemaTypeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  if (typeof value === "number") return "number";
  return typeof value;
}

function schemaTypeMatches(value, expected) {
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "array") return Array.isArray(value);
  if (expected === "null") return value === null;
  return typeof value === expected;
}

function schemaPointer(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported schema ref: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .reduce((node, part) => node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], root);
}

function addSchemaError(errors, path, message, value) {
  errors.push({
    path,
    message,
    actualType: schemaTypeOf(value),
    sample: typeof value === "string" ? value.slice(0, 120) : undefined,
  });
}

function validateSchemaNode(value, schema, root, path, errors) {
  if (!schema || typeof schema !== "object") return;
  if (schema.$ref) {
    const resolved = schemaPointer(root, schema.$ref);
    if (!resolved) {
      errors.push({ path, message: `schema ref not found: ${schema.$ref}` });
      return;
    }
    validateSchemaNode(value, resolved, root, path, errors);
    return;
  }

  const expectedTypes = schema.type
    ? Array.isArray(schema.type)
      ? schema.type
      : [schema.type]
    : null;
  if (expectedTypes && !expectedTypes.some((type) => schemaTypeMatches(value, type))) {
    addSchemaError(errors, path, `expected ${expectedTypes.join(" or ")}`, value);
    return;
  }

  if (schema.enum && !schema.enum.some((item) => item === value)) {
    addSchemaError(errors, path, `expected one of: ${schema.enum.join(", ")}`, value);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      addSchemaError(errors, path, `expected minLength ${schema.minLength}`, value);
    }
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) {
      addSchemaError(errors, path, `expected pattern ${schema.pattern}`, value);
    }
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
      addSchemaError(errors, path, "expected parseable date-time", value);
    }
  }

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    addSchemaError(errors, path, `expected minimum ${schema.minimum}`, value);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      addSchemaError(errors, path, `expected minItems ${schema.minItems}`, value);
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchemaNode(item, schema.items, root, `${path}[${index}]`, errors));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const field of schema.required ?? []) {
      if (!Object.hasOwn(value, field)) {
        errors.push({ path: `${path}.${field}`, message: "required field is missing" });
      }
    }
    for (const [field, fieldValue] of Object.entries(value)) {
      if (properties[field]) {
        validateSchemaNode(fieldValue, properties[field], root, `${path}.${field}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${field}`, message: "additional property is not allowed" });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateSchemaNode(
          fieldValue,
          schema.additionalProperties,
          root,
          `${path}.${field}`,
          errors,
        );
      }
    }
  }
}

async function validateManifestSchema(manifest, schemaPath) {
  if (!schemaPath || !existsSync(schemaPath)) {
    return {
      pass: false,
      path: schemaPath ?? null,
      errorCount: 1,
      errors: [{ path: "$", message: "manifest schema file not found" }],
    };
  }
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const errors = [];
  validateSchemaNode(manifest, schema, schema, "$", errors);
  return {
    pass: errors.length === 0,
    path: schemaPath,
    errorCount: errors.length,
    errors: errors.slice(0, 100),
  };
}

function hasPattern(text, patterns) {
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern),
  );
}

function inspectEcommerceThemeQuality(theme, asset, descriptor) {
  const css = asset?.text ?? "";
  const descriptorText = JSON.stringify(descriptor ?? {});
  const haystack = `${css}\n${descriptorText}`.toLowerCase();
  const semanticTokenGroups = [
    { name: "cta", patterns: ["--color-cta", "--cta"] },
    { name: "cta-hover", patterns: ["--color-cta-hover", "--cta-hover"] },
    { name: "trust", patterns: ["--color-trust", "--trust"] },
    { name: "focus-ring", patterns: ["--focus-ring"] },
    { name: "error", patterns: ["--color-error", "--error"] },
    { name: "success", patterns: ["--color-success", "--success"] },
    { name: "surface-card", patterns: ["--surface-card", "--surface-raised"] },
    { name: "text-muted", patterns: ["--text-muted", "--muted"] },
  ];
  const semanticTokens = semanticTokenGroups.map((group) => ({
    name: group.name,
    present: hasPattern(haystack, group.patterns),
  }));
  const states = {
    hover: /:hover\b/.test(css),
    active: /:active\b|\[aria-pressed/.test(css),
    focusVisible: /:focus-visible\b/.test(css),
    disabled: /:disabled\b|\[disabled\]|\[aria-disabled/.test(css),
    loading: /loading|aria-busy|is-loading/.test(haystack),
    validation: /invalid|error|success|help|validation/.test(haystack),
    reducedMotion: /prefers-reduced-motion/.test(css),
  };
  const ctaHierarchy = {
    primary: /btn-(green|primary)|--color-cta\b|primary cta/.test(haystack),
    secondary: /btn-(navy|secondary)|secondary cta/.test(haystack),
    tertiary: /btn-(line|tertiary|outline)|tertiary cta|outline/.test(haystack),
  };
  const trustComponents = {
    proofStrip: /proof|trust/.test(haystack),
    reviewsRatings: /customer review|review card|\brating\b|\bstars?\b|\bg2\b|capterra/.test(haystack),
    testimonial: /testimonial|quote/.test(haystack),
    badge: /badge|security|compliance|certif/.test(haystack),
    reassurance: /guarantee|returns?|refund|warranty|risk-free/.test(haystack),
    logoStrip: /logo strip|as seen|press|customer logos?|partner logos?/.test(haystack),
  };
  const accessibleForms = {
    fields: /\b(form|input|textarea|select|field)\b/.test(haystack),
    labels: /\b(label|aria-label|aria-labelledby)\b/.test(haystack),
    help: /help|hint|description|aria-describedby/.test(haystack),
    validation: /error|success|invalid|required|optional/.test(haystack),
  };
  const mobilePerformance = {
    responsiveRules: /@media\s*\(max-width|clamp\(/.test(css),
    tapTargetToken: /44px|min-height:\s*(4[4-9]|[5-9][0-9])px|min-width:\s*(4[4-9]|[5-9][0-9])px/.test(css),
    colorScheme: /color-scheme/.test(css),
  };

  const missing = [];
  const missingSemantic = semanticTokens.filter((token) => !token.present).map((token) => token.name);
  const missingStates = Object.entries(states).filter(([, present]) => !present).map(([name]) => name);
  const missingCtas = Object.entries(ctaHierarchy).filter(([, present]) => !present).map(([name]) => name);
  const missingTrust = Object.entries(trustComponents).filter(([, present]) => !present).map(([name]) => name);
  const missingForms = Object.entries(accessibleForms).filter(([, present]) => !present).map(([name]) => name);
  const missingMobilePerf = Object.entries(mobilePerformance).filter(([, present]) => !present).map(([name]) => name);

  if (missingSemantic.length > 0) missing.push(`semantic-tokens:${missingSemantic.join(",")}`);
  if (missingStates.length > 0) missing.push(`states:${missingStates.join(",")}`);
  if (missingCtas.length > 0) missing.push(`cta-hierarchy:${missingCtas.join(",")}`);
  if (missingTrust.length > 0) missing.push(`trust-components:${missingTrust.join(",")}`);
  if (missingForms.length > 0) missing.push(`accessible-forms:${missingForms.join(",")}`);
  if (missingMobilePerf.length > 0) missing.push(`mobile-perf:${missingMobilePerf.join(",")}`);

  return {
    themeId: theme.id ?? null,
    descriptorPath: theme.descriptor ?? null,
    pass: missing.length === 0,
    missing,
    semanticTokens,
    states,
    ctaHierarchy,
    trustComponents,
    accessibleForms,
    mobilePerformance,
  };
}

function conventionProblemsForManifest(manifest) {
  const problems = [];
  const rawHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const checkPath = (label, value) => {
    if (!value) return;
    if (!value.startsWith("/tenants/")) {
      problems.push(`${label} must be a root-relative /tenants/... public path`);
    }
  };
  const checkHash = (label, value) => {
    if (!value) return;
    if (String(value).startsWith("sha256:")) problems.push(`${label} must be raw hex, not sha256:-prefixed`);
    else if (!rawHash(value)) problems.push(`${label} must be a lowercase 64-character SHA-256 hex string`);
  };

  for (const theme of manifest.themes ?? []) {
    checkPath(`themes[${theme.id ?? "unknown"}].path`, theme.path);
    checkHash(`themes[${theme.id ?? "unknown"}].sha256`, theme.sha256);
  }
  checkPath("styleConcept.stylesheet.path", manifest.styleConcept?.stylesheet?.path);
  checkHash("styleConcept.stylesheet.sha256", manifest.styleConcept?.stylesheet?.sha256);
  checkPath("styleConcept.stylesheetPath legacy alias", manifest.styleConcept?.stylesheetPath);
  checkHash("styleConcept.sha256 legacy alias", manifest.styleConcept?.sha256);
  return problems;
}

function acceptedRisksForManifest(manifest) {
  const risks = [
    ...(Array.isArray(manifest?.acceptedRisks) ? manifest.acceptedRisks : []),
    ...(Array.isArray(manifest?.ecommerceQualityBar?.acceptedRisks)
      ? manifest.ecommerceQualityBar.acceptedRisks
      : []),
    ...(Array.isArray(manifest?.styleConcept?.ecommerceQualityBar?.acceptedRisks)
      ? manifest.styleConcept.ecommerceQualityBar.acceptedRisks
      : []),
  ];
  const problems = risks.flatMap((risk, index) => {
    const missing = ["gate", "rationale", "by", "at"].filter((field) => !risk?.[field]);
    return missing.length > 0
      ? [{ index, missing, risk }]
      : [];
  });
  return {
    pass: problems.length === 0,
    count: risks.length,
    records: risks,
    problems,
  };
}

function storyboardForManifest(manifest) {
  const concept = manifest?.styleConcept ?? {};
  const storyboard = concept.storyboard ?? null;
  const sourcePages = Array.isArray(concept.sourcePages) ? concept.sourcePages : [];
  const inspirationPages = Array.isArray(storyboard?.inspirationPages)
    ? storyboard.inspirationPages
    : [];
  const gaps = [
    ...(Array.isArray(manifest?.styleGaps) ? manifest.styleGaps : []),
    ...(Array.isArray(storyboard?.styleGaps) ? storyboard.styleGaps : []),
  ];
  const problems = [];
  const inspirationSlugs = new Set(
    inspirationPages.map((page) => page?.slug).filter(Boolean),
  );

  if (!storyboard) {
    problems.push({
      field: "styleConcept.storyboard",
      problem: "missing storyboard object with inspirationPages and uncoveredElementPolicy",
    });
  }
  if (sourcePages.length === 0) {
    problems.push({
      field: "styleConcept.sourcePages",
      problem: "missing source pages for the concept",
    });
  }
  if (inspirationPages.length === 0) {
    problems.push({
      field: "styleConcept.storyboard.inspirationPages",
      problem: "missing page-level inspiration records",
    });
  }
  for (const sourcePage of sourcePages) {
    if (!inspirationSlugs.has(sourcePage)) {
      problems.push({
        field: "styleConcept.storyboard.inspirationPages",
        problem: `source page ${sourcePage} is not explained as an inspiration page`,
      });
    }
  }
  for (const [index, page] of inspirationPages.entries()) {
    const missing = ["slug", "role", "captures"].filter((field) => {
      if (field === "captures") return !Array.isArray(page?.captures) || page.captures.length === 0;
      return !page?.[field];
    });
    if (missing.length > 0) {
      problems.push({
        field: `styleConcept.storyboard.inspirationPages[${index}]`,
        problem: `missing ${missing.join(", ")}`,
      });
    }
  }

  const policy = storyboard?.uncoveredElementPolicy;
  if (!policy) {
    problems.push({
      field: "styleConcept.storyboard.uncoveredElementPolicy",
      problem: "missing uncovered-element handling policy",
    });
  } else {
    const hasInstructions = Array.isArray(policy.instructions) && policy.instructions.length > 0;
    const hasDispositionList = Array.isArray(policy.dispositions) && policy.dispositions.length > 0;
    if (!policy.defaultAction) {
      problems.push({
        field: "styleConcept.storyboard.uncoveredElementPolicy.defaultAction",
        problem: "missing default action",
      });
    }
    if (!hasInstructions) {
      problems.push({
        field: "styleConcept.storyboard.uncoveredElementPolicy.instructions",
        problem: "missing worker instructions",
      });
    }
    if (!hasDispositionList) {
      problems.push({
        field: "styleConcept.storyboard.uncoveredElementPolicy.dispositions",
        problem: "missing allowed dispositions",
      });
    }
  }

  for (const [index, gap] of gaps.entries()) {
    const missing = ["id", "element", "status", "disposition"].filter((field) => !gap?.[field]);
    if (missing.length > 0) {
      problems.push({
        field: `styleGaps[${index}]`,
        problem: `missing ${missing.join(", ")}`,
      });
    }
    if (gap?.status !== "resolved" && !gap?.owner && !gap?.reviewBy) {
      problems.push({
        field: `styleGaps[${index}]`,
        problem: "unresolved style gap needs owner or reviewBy",
      });
    }
  }

  return {
    pass: problems.length === 0,
    inspirationCount: inspirationPages.length,
    inspirationPages: inspirationPages.map((page) => ({
      slug: page.slug ?? null,
      role: page.role ?? null,
      captures: Array.isArray(page.captures) ? page.captures : [],
    })),
    sourcePages,
    sourcePagesMissingInspiration: sourcePages.filter((slug) => !inspirationSlugs.has(slug)),
    policy: policy
      ? {
          defaultAction: policy.defaultAction ?? null,
          dispositions: policy.dispositions ?? [],
          instructionCount: policy.instructions?.length ?? 0,
        }
      : null,
    styleGapCount: gaps.length,
    openStyleGapCount: gaps.filter((gap) => gap.status && gap.status !== "resolved").length,
    problems,
  };
}

async function analyzeManifest(path, publicDir, contentDir, tenant, schemaPath) {
  if (!path || !existsSync(path)) return { present: false };
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const schema = await validateManifestSchema(manifest, schemaPath);
  const concept = manifest.styleConcept ?? null;
  const themes = Array.isArray(manifest.themes) ? manifest.themes : [];
  const conventionProblems = conventionProblemsForManifest(manifest);
  const acceptedRisks = acceptedRisksForManifest(manifest);
  const storyboard = storyboardForManifest(manifest);
  const ecommerceBar = manifest.ecommerceQualityBar ?? concept?.ecommerceQualityBar ?? null;
  const legacyStyleGuide = manifest.styleGuide ?? null;
  const styleGuides = Array.isArray(manifest.styleGuides)
    ? manifest.styleGuides
    : legacyStyleGuide
      ? [legacyStyleGuide]
      : [];
  const styleGuideIndex = manifest.styleGuideIndex ?? null;
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  let stylesheet = null;
  if (concept?.stylesheet?.path) {
    stylesheet = await hashPublicAsset(publicDir, concept.stylesheet.path);
  } else if (concept?.stylesheetPath) {
    stylesheet = await hashPublicAsset(publicDir, concept.stylesheetPath);
  }
  const themeInputs = new Map();
  const themeRecords = await Promise.all(
    themes.map(async (theme) => {
      const asset = await hashPublicAsset(publicDir, theme.path ?? "");
      const descriptorPath =
        theme.descriptor ?? join(tenantBaseDir(contentDir, tenant), "content", "themes", `${theme.id ?? ""}.json`);
      const descriptor = await readJsonIfExists(descriptorPath);
      const ecommerceQuality = inspectEcommerceThemeQuality(theme, asset, descriptor);
      const tokenContrast = inspectTokenContrast(theme, asset, descriptor);
      themeInputs.set(theme.id, { asset, descriptor });
      return {
        id: theme.id,
        version: theme.version,
        role: theme.role,
        path: theme.path ?? null,
        descriptorPath,
        descriptorFound: Boolean(descriptor),
        switchable: theme.switchable ?? null,
        switchParam: theme.switchParam ?? null,
        previewOnly: theme.previewOnly ?? null,
        stylesheetHash: theme.sha256 ?? null,
        computedStylesheetHash: asset?.sha256 ?? null,
        stylesheetBytes: asset?.bytes ?? null,
        stylesheetDrift: Boolean(theme.sha256 && asset?.sha256 && theme.sha256 !== asset.sha256),
        missingStylesheet: Boolean(theme.path && !asset),
        ecommerceQuality,
        tokenContrast,
      };
    }),
  );
  const currentThemes = themeRecords.filter((theme) => theme.role === "current");
  const themeProblems = themeRecords.filter(
    (theme) => theme.missingStylesheet || theme.stylesheetDrift || !theme.id || !theme.version,
  );
  const guideRecords = styleGuides.map((guide) => {
    const themeIds = Array.from(
      new Set([
        ...(guide.themeId ? [guide.themeId] : []),
        ...(Array.isArray(guide.themeIds) ? guide.themeIds : []),
      ]),
    );
    return {
      id: guide.id ?? guide.themeId ?? null,
      route: guide.route ?? null,
      sourcePath: guide.sourcePath ?? null,
      version: guide.version ?? null,
      status: guide.status ?? null,
      themeId: guide.themeId ?? themeIds[0] ?? null,
      themeIds,
      standalone: guide.standalone ?? null,
      indexRoute: guide.indexRoute ?? styleGuideIndex?.route ?? null,
      retainedForComparison: guide.retainedForComparison ?? null,
      previewOnly: guide.previewOnly ?? null,
      noindex: guide.noindex ?? null,
      includeInSitemap: guide.includeInSitemap ?? null,
      hasBaseline: Boolean(guide.baseline?.screenshot && guide.baseline?.sha256),
      qualityGates: guide.qualityGates ?? {},
    };
  });
  for (const theme of themeRecords) {
    const input = themeInputs.get(theme.id) ?? {};
    const guide = guideRecords.find((record) => record.themeIds.includes(theme.id));
    theme.guideCoverage = await inspectGuideCoverage(theme, input.asset, input.descriptor, guide);
  }
  const standaloneThemeIds = new Set(
    guideRecords
      .filter((guide) => guide.route && guide.standalone !== false)
      .flatMap((guide) => guide.themeIds),
  );
  const indexThemeIds = new Set(styleGuideIndex?.linksToThemeIds ?? []);
  const themeIds = themeRecords.map((theme) => theme.id).filter(Boolean);
  const themesMissingStandaloneGuide = themeIds.filter((themeId) => !standaloneThemeIds.has(themeId));
  const indexMissingThemeLinks = themeIds.filter((themeId) => !indexThemeIds.has(themeId));
  const currentThemeIds = currentThemes.map((theme) => theme.id).filter(Boolean);
  const currentThemeGuides = guideRecords.filter((guide) =>
    guide.themeIds.some((themeId) => currentThemeIds.includes(themeId)),
  );
  const approvedCurrentThemeGuides = currentThemeGuides.filter(
    (guide) => guide.status === "approved",
  );
  const guideProblems = guideRecords.filter(
    (guide) =>
      !guide.route ||
      guide.standalone === false ||
      guide.previewOnly !== true ||
      guide.includeInSitemap !== false ||
      guide.noindex === false,
  );
  const expectedHash = concept?.stylesheet?.sha256 ?? concept?.stylesheetHash ?? null;
  const drifted = pages.filter((page) => {
    const pageConcept = page.styleConcept;
    if (!concept || !pageConcept) return false;
    return (
      pageConcept.id !== concept.id ||
      pageConcept.version !== concept.version ||
      (expectedHash && pageConcept.stylesheetHash && pageConcept.stylesheetHash !== expectedHash)
    );
  });
  return {
    present: true,
    path,
    schema,
    styleConcept: concept
      ? {
          id: concept.id,
          version: concept.version,
          sourcePages: concept.sourcePages ?? concept.source?.pages ?? [],
          stylesheetPath: concept.stylesheet?.path ?? concept.stylesheetPath ?? null,
          stylesheetHash: expectedHash,
          computedStylesheetHash: stylesheet?.sha256 ?? null,
          stylesheetBytes: stylesheet?.bytes ?? null,
          stylesheetDrift: Boolean(expectedHash && stylesheet?.sha256 && stylesheet.sha256 !== expectedHash),
        }
      : null,
    themes: {
      count: themeRecords.length,
      currentCount: currentThemes.length,
      switchableCount: themeRecords.filter((theme) => theme.switchable === true).length,
      records: themeRecords,
      problems: themeProblems.map((theme) => ({
        id: theme.id ?? null,
        role: theme.role ?? null,
        path: theme.path,
        missingStylesheet: theme.missingStylesheet,
        stylesheetDrift: theme.stylesheetDrift,
      })),
    },
    manifestConventions: {
      pass: conventionProblems.length === 0,
      problems: conventionProblems,
      notes: [
        "paths must be root-relative public paths beginning /tenants/<tenant>/",
        "hashes must be raw lowercase 64-character SHA-256 hex, without sha256: prefix",
        "prefer styleConcept.stylesheet.path/sha256 over legacy stylesheetPath/sha256 aliases",
      ],
    },
    acceptedRisks,
    storyboard,
    ecommerceStyleGuide: {
      requiredVersion: ecommerceBar?.version ?? "v1.1",
      status: ecommerceBar?.status ?? null,
      claimsPolicy: ecommerceBar?.claimsPolicy ?? null,
      acceptedRisks,
      appliesToThemeIds: ecommerceBar?.appliesToThemeIds ?? currentThemes.map((theme) => theme.id).filter(Boolean),
      requirementCount: ecommerceBar?.requirements?.length ?? 0,
      currentThemeRecords: currentThemes.map((theme) => theme.ecommerceQuality),
      problems: currentThemes
        .filter((theme) => theme.ecommerceQuality?.pass !== true)
        .map((theme) => ({
          themeId: theme.id,
          missing: theme.ecommerceQuality?.missing ?? [],
        })),
      // Components present in the guide ONLY as marked placeholders. Reported for every status,
      // because a reviewer deciding whether to approve needs to see them.
      unsourcedComponents: Array.from(
        new Set(currentThemes.flatMap((theme) => theme.guideCoverage?.unsourcedComponents ?? [])),
      ),
      blockedBy: [
        ...(ecommerceBar?.blockedBy ?? []),
        // A COMPUTED blocker, not an echo of the manifest. The bar reported trust-components met
        // while the guide's trust samples read "needs-review" and "do not ship until sourced" — a
        // human reading the rendered guide caught what the substring match could not. Ratings,
        // testimonials, badges, guarantees and partner logos need merchant-supplied evidence that
        // no template can invent, and the claimsPolicy forbids inventing them, so approval must
        // not be reachable while they are placeholders.
        ...unsourcedApprovalBlockers(ecommerceBar, currentThemes),
      ],
    },
    tokenContrast: {
      currentThemeRecords: currentThemes.map((theme) => theme.tokenContrast),
      problems: currentThemes
        .filter((theme) => theme.tokenContrast?.pass !== true)
        .map((theme) => ({
          themeId: theme.id,
          problems: theme.tokenContrast?.problems ?? [],
        })),
    },
    guideCoverage: {
      currentThemeRecords: currentThemes.map((theme) => theme.guideCoverage),
      problems: currentThemes
        .filter((theme) => theme.guideCoverage?.pass !== true)
        .map((theme) => ({
          themeId: theme.id,
          tokenProblems: theme.guideCoverage?.tokenProblems ?? [],
          componentProblems: theme.guideCoverage?.componentProblems ?? [],
          notes: theme.guideCoverage?.notes ?? [],
        })),
    },
    styleGuideIndex: styleGuideIndex
      ? {
          route: styleGuideIndex.route ?? null,
          sourcePath: styleGuideIndex.sourcePath ?? null,
          previewOnly: styleGuideIndex.previewOnly ?? null,
          noindex: styleGuideIndex.noindex ?? null,
          includeInSitemap: styleGuideIndex.includeInSitemap ?? null,
          linksToThemeIds: styleGuideIndex.linksToThemeIds ?? [],
          missingThemeLinks: indexMissingThemeLinks,
        }
      : null,
    styleGuide: guideRecords[0] ?? null,
    styleGuides: {
      count: guideRecords.length,
      standaloneCount: guideRecords.filter((guide) => guide.route && guide.standalone !== false).length,
      approvedCurrentCount: approvedCurrentThemeGuides.length,
      records: guideRecords,
      problems: guideProblems.map((guide) => ({
        id: guide.id,
        route: guide.route,
        themeIds: guide.themeIds,
        standalone: guide.standalone,
        previewOnly: guide.previewOnly,
        noindex: guide.noindex,
        includeInSitemap: guide.includeInSitemap,
      })),
      themesMissingStandaloneGuide,
    },
    pagesTracked: pages.length,
    pagesConforming: pages.filter((page) => page.styleConcept?.conforms === true).length,
    pagesDrifted: drifted.map((page) => page.slug),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.requirements) {
    process.stdout.write(`${JSON.stringify(requirementsContract(), null, 2)}\n`);
    return;
  }
  const hashSync = args.syncHashes
    ? await syncManifestHashes(args.manifest, args.publicDir)
    : null;
  // Resolve through the same helper the chrome gate uses, so a platform test
  // tenant nested under `<contentDir>/e2e/<id>/` — or a dir carrying a TLD suffix
  // the caller did not pass — is inspected rather than silently reported as zero
  // pages. `tenantDirResolved` is null when no tenant content tree exists at all,
  // which the css/readability gates report as "not measured", not "measured clean".
  const tenantDirResolved = await resolveTenantDir(args.contentDir, args.tenant);
  const tenantRoot = join(tenantDirResolved ?? tenantBaseDir(args.contentDir, args.tenant), "content");
  const contentFiles = await walk(tenantRoot);
  const files = contentFiles.filter((file) => /(^|\/)(home|pages-html\/.*)\.html$/i.test(file));
  // A tenant whose pages are structured JSON (`home.json`, `pages/*.json`) rather than ported raw
  // HTML has nothing for the css/readability gates to weigh: both measure authored-CSS hygiene —
  // inline-CSS bytes per page, duplicate rules, minified/unreadable blocks — which is a raw-HTML
  // port concern. Measured on a structured-JSON store: 0 inline-style markers across its
  // content JSON. Reporting that shape as FAIL describes the tenant's SHAPE, not its quality.
  //
  // The discriminator matters. "No HTML pages" alone would also be true of a raw-HTML tenant whose
  // pages went missing — a real regression this gate should catch — so not-applicable requires
  // POSITIVE evidence of the other shape. Neither shape present stays a failure.
  const authoredCssNotApplicable = authoredCssGatesNotApplicable({
    tenantDirResolved: Boolean(tenantDirResolved),
    htmlPageCount: files.length,
    jsonPageCount: contentFiles.filter((file) => /(^|\/)(home|pages\/.*)\.json$/i.test(file)).length,
  });
  const pages = await Promise.all(files.map((file) => readPage(tenantRoot, file, args.tenant, args)));

  const ruleFrequency = new Map();
  for (const page of pages) {
    for (const rule of new Set(page.rules)) {
      ruleFrequency.set(rule, (ruleFrequency.get(rule) ?? 0) + 1);
    }
  }
  const duplicateRules = Array.from(ruleFrequency.entries()).filter(([, count]) => count > 1);
  const totalRuleOccurrences = pages.reduce((sum, page) => sum + page.ruleCount, 0);
  const duplicateOccurrences = pages.reduce(
    (sum, page) => sum + page.rules.filter((rule) => (ruleFrequency.get(rule) ?? 0) > 1).length,
    0,
  );
  const duplicateRuleRatio =
    totalRuleOccurrences > 0 ? Number((duplicateOccurrences / totalRuleOccurrences).toFixed(4)) : 0;
  const maxInlineCssBytes = Math.max(0, ...pages.map((page) => page.inlineCssBytes));
  const stylesheetLinks = Array.from(new Set(pages.flatMap((page) => page.stylesheetLinks))).sort();
  const sharedStylesheets = /** @type {any[]} */ (
    (await Promise.all(stylesheetLinks.map((href) => hashPublicAsset(args.publicDir, href)))).filter(Boolean)
  );
  const sharedStylesheetReadability = sharedStylesheets.map((sheet) =>
    readabilityItem({
      label: relative(".", sheet.path),
      kind: "css",
      text: sheet.text,
      args,
      requireSections: true,
    }),
  );
  const readabilityItems = [
    ...pages.flatMap((page) => [page.readability.html, ...page.readability.inlineStyles]),
    ...sharedStylesheetReadability,
  ];
  const readability = summarizeReadability(readabilityItems);
  const manifest = await analyzeManifest(
    args.manifest,
    args.publicDir,
    args.contentDir,
    args.tenant,
    args.schema,
  );

  const chrome = await inspectChromeConcept(args.contentDir, args.tenant);

  const result = {
    tenant: args.tenant,
    generatedAt: new Date().toISOString(),
    thresholds: {
      inlineCssBytesPerPageMax: args.inlineMax,
      duplicateRuleRatioMax: args.duplicateMax,
      readabilityLineMax: args.readabilityLineMax,
      readabilityLongLineRatioMax: args.readabilityLongLineRatioMax,
      readabilityMinifiedLineRatioMax: args.readabilityMinifiedLineRatioMax,
      readabilityCssDensityMax: args.readabilityCssDensityMax,
      readabilitySectionCommentsMin: args.readabilitySectionCommentsMin,
    },
    pages: pages
      .map((page) => ({
        slug: page.slug,
        path: page.path,
        inlineStyleBlocks: page.inlineStyleBlocks,
        inlineCssBytes: page.inlineCssBytes,
        ruleCount: page.ruleCount,
        stylesheetLinks: page.stylesheetLinks,
        readability: {
          html: {
            pass: page.readability.html.pass,
            maxLineLength: page.readability.html.maxLineLength,
            longLineRatio: page.readability.html.longLineRatio,
            minifiedLineRatio: page.readability.html.minifiedLineRatio,
          },
          inlineStyles: page.readability.inlineStyles.map((item) => ({
            pass: item.pass,
            failures: item.failures,
            maxLineLength: item.maxLineLength,
            longLineRatio: item.longLineRatio,
            minifiedLineRatio: item.minifiedLineRatio,
            cssDeclarationDensity: item.css?.declarationsPerNonBlankLine ?? null,
            sectionComments: item.css?.sectionComments ?? null,
          })),
        },
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    summary: {
      pageCount: pages.length,
      maxInlineCssBytes,
      totalRuleOccurrences,
      duplicateRules: duplicateRules.length,
      duplicateRuleRatio,
      sharedStylesheets: sharedStylesheets.map((sheet) => ({
        path: sheet.path,
        bytes: sheet.bytes,
        sha256: sheet.sha256,
      })),
      readability,
    },
    hashSync,
    manifest,
    gates: {
      schema: {
        pass:
          !args.manifest ||
          (manifest.present && manifest.schema?.pass === true),
        path: manifest.schema?.path ?? args.schema,
        errorCount: manifest.schema?.errorCount ?? 0,
        errors: manifest.schema?.errors ?? [],
      },
      storyboard: {
        pass:
          !args.manifest ||
          (manifest.present && manifest.storyboard?.pass === true),
        inspirationCount: manifest.storyboard?.inspirationCount ?? 0,
        inspirationPages: manifest.storyboard?.inspirationPages ?? [],
        sourcePages: manifest.storyboard?.sourcePages ?? [],
        sourcePagesMissingInspiration: manifest.storyboard?.sourcePagesMissingInspiration ?? [],
        policy: manifest.storyboard?.policy ?? null,
        styleGapCount: manifest.storyboard?.styleGapCount ?? 0,
        openStyleGapCount: manifest.storyboard?.openStyleGapCount ?? 0,
        problemCount: manifest.storyboard?.problems?.length ?? 0,
        problems: manifest.storyboard?.problems ?? [],
      },
      theme: {
        pass:
          !args.manifest ||
          (manifest.present &&
            manifest.themes?.currentCount === 1 &&
            manifest.themes?.problems?.length === 0),
        present: Boolean(manifest.present && (manifest.themes?.count ?? 0) > 0),
        currentCount: manifest.themes?.currentCount ?? 0,
        switchableCount: manifest.themes?.switchableCount ?? 0,
        problemCount: manifest.themes?.problems?.length ?? 0,
        problems: manifest.themes?.problems ?? [],
      },
      css: {
        pass:
          authoredCssNotApplicable ||
          (pages.length > 0 &&
            maxInlineCssBytes <= args.inlineMax &&
            duplicateRuleRatio <= args.duplicateMax &&
            sharedStylesheets.length > 0),
        notApplicable: authoredCssNotApplicable,
        notApplicableReason: authoredCssNotApplicable
          ? "Tenant content is structured JSON, not ported raw HTML — there is no authored page CSS to weigh."
          : null,
        // Emitted so a consumer can tell "measured and clean" from "found nothing
        // to measure" — every metric below reads 0 in both states.
        pagesInspected: pages.length,
        tenantContentDir: tenantDirResolved ? relative(".", tenantRoot) : null,
        inlineCssBytesPerPageMax: maxInlineCssBytes,
        duplicateRuleRatio,
        sharedStylesheetCount: sharedStylesheets.length,
      },
      chromeConcept: {
        pass: chromeConceptPass(chrome),
        present: chrome.present,
        tenantDir: chrome.tenantDir ?? null,
        adopted: chrome.adopted ?? false,
        sharedStylesheetHref: chrome.sharedStylesheetHref ?? null,
        inlineChromeCount: chrome.inlineChromeCount ?? 0,
        reauthoredChromeCount: chrome.reauthoredChromeCount ?? 0,
        inlineChrome: chrome.inlineChrome ?? [],
        reauthoredChrome: chrome.reauthoredChrome ?? [],
        sheetsScanned: chrome.sheetsScanned ?? [],
      },
      readability: {
        pass: authoredCssNotApplicable || (pages.length > 0 && readability.issueCount === 0),
        notApplicable: authoredCssNotApplicable,
        notApplicableReason: authoredCssNotApplicable
          ? "Tenant content is structured JSON, not ported raw HTML — there are no authored CSS blocks to read."
          : null,
        pagesInspected: pages.length,
        tenantContentDir: tenantDirResolved ? relative(".", tenantRoot) : null,
        inspectedBlocks: readability.inspectedBlocks,
        issueCount: readability.issueCount,
        maxLineLength: readability.maxLineLength,
        longLineRatio: readability.longLineRatio,
        minifiedLineRatio: readability.minifiedLineRatio,
        cssDeclarationDensityMax: readability.cssDeclarationDensityMax,
        sectionComments: readability.sectionComments,
        issueSamples: readability.issueSamples,
      },
      styleConcept: {
        pass:
          !args.manifest ||
          (manifest.present &&
            Boolean(manifest.styleConcept?.id) &&
            manifest.styleConcept?.stylesheetDrift !== true &&
            manifest.pagesDrifted.length === 0),
        present: manifest.present,
        id: manifest.styleConcept?.id ?? null,
        version: manifest.styleConcept?.version ?? null,
        pagesTracked: manifest.pagesTracked ?? 0,
        pagesConforming: manifest.pagesConforming ?? 0,
        pagesDrifted: manifest.pagesDrifted ?? [],
      },
      styleGuide: {
        pass:
          !args.manifest ||
          (manifest.present &&
            Boolean(manifest.styleGuideIndex?.route) &&
            manifest.styleGuideIndex?.previewOnly === true &&
            manifest.styleGuideIndex?.includeInSitemap === false &&
            manifest.styleGuideIndex?.noindex !== false &&
            manifest.styleGuides?.themesMissingStandaloneGuide?.length === 0 &&
            manifest.styleGuideIndex?.missingThemeLinks?.length === 0 &&
            manifest.styleGuides?.problems?.length === 0 &&
            manifest.styleGuides?.approvedCurrentCount >= 1),
        present: Boolean(
          manifest.present &&
            manifest.styleGuideIndex &&
            (manifest.styleGuides?.count ?? 0) > 0,
        ),
        indexRoute: manifest.styleGuideIndex?.route ?? null,
        indexPreviewOnly: manifest.styleGuideIndex?.previewOnly ?? null,
        indexNoindex: manifest.styleGuideIndex?.noindex ?? null,
        indexIncludeInSitemap: manifest.styleGuideIndex?.includeInSitemap ?? null,
        indexLinksToThemeIds: manifest.styleGuideIndex?.linksToThemeIds ?? [],
        indexMissingThemeLinks: manifest.styleGuideIndex?.missingThemeLinks ?? [],
        styleGuideCount: manifest.styleGuides?.count ?? 0,
        standaloneCount: manifest.styleGuides?.standaloneCount ?? 0,
        approvedCurrentCount: manifest.styleGuides?.approvedCurrentCount ?? 0,
        themesMissingStandaloneGuide: manifest.styleGuides?.themesMissingStandaloneGuide ?? [],
        problems: manifest.styleGuides?.problems ?? [],
        guides: manifest.styleGuides?.records ?? [],
      },
      manifestConventions: {
        pass:
          !args.manifest ||
          (manifest.present && manifest.manifestConventions?.pass === true),
        problemCount: manifest.manifestConventions?.problems?.length ?? 0,
        problems: manifest.manifestConventions?.problems ?? [],
        notes: manifest.manifestConventions?.notes ?? [],
      },
      tokenContrast: {
        pass:
          !args.manifest ||
          (manifest.present && manifest.tokenContrast?.problems?.length === 0),
        problemCount: (manifest.tokenContrast?.problems ?? []).reduce(
          (sum, item) => sum + (item.problems?.length ?? 0),
          0,
        ),
        problems: manifest.tokenContrast?.problems ?? [],
        currentThemeRecords: manifest.tokenContrast?.currentThemeRecords ?? [],
      },
      guideCoverage: {
        pass:
          !args.manifest ||
          (manifest.present && manifest.guideCoverage?.problems?.length === 0),
        problemCount: (manifest.guideCoverage?.problems ?? []).reduce(
          (sum, item) =>
            sum + (item.tokenProblems?.length ?? 0) + (item.componentProblems?.length ?? 0),
          0,
        ),
        problems: manifest.guideCoverage?.problems ?? [],
        currentThemeRecords: manifest.guideCoverage?.currentThemeRecords ?? [],
      },
      acceptedRisks: {
        pass:
          !args.manifest ||
          (manifest.present && manifest.acceptedRisks?.pass === true),
        count: manifest.acceptedRisks?.count ?? 0,
        problemCount: manifest.acceptedRisks?.problems?.length ?? 0,
        problems: manifest.acceptedRisks?.problems ?? [],
      },
      ecommerceStyleGuide: {
        pass:
          !args.manifest ||
          (manifest.present &&
            manifest.ecommerceStyleGuide?.status === "approved" &&
            manifest.ecommerceStyleGuide?.problems?.length === 0 &&
            // An approved bar over placeholder evidence is the failure this gate exists to
            // prevent: the static checks can all pass while the guide's trust samples still read
            // "needs-review" and "do not ship until sourced". Without this the gate goes green the
            // moment someone flips status, which is precisely when it should refuse.
            (manifest.ecommerceStyleGuide?.unsourcedComponents?.length ?? 0) === 0),
        requiredVersion: manifest.ecommerceStyleGuide?.requiredVersion ?? "v1.1",
        status: manifest.ecommerceStyleGuide?.status ?? null,
        claimsPolicy: manifest.ecommerceStyleGuide?.claimsPolicy ?? null,
        acceptedRiskCount: manifest.ecommerceStyleGuide?.acceptedRisks?.count ?? 0,
        requirementCount: manifest.ecommerceStyleGuide?.requirementCount ?? 0,
        problemCount: manifest.ecommerceStyleGuide?.problems?.length ?? 0,
        problems: manifest.ecommerceStyleGuide?.problems ?? [],
        blockedBy: manifest.ecommerceStyleGuide?.blockedBy ?? [],
        unsourcedComponents: manifest.ecommerceStyleGuide?.unsourcedComponents ?? [],
        currentThemeRecords: manifest.ecommerceStyleGuide?.currentThemeRecords ?? [],
      },
    },
  };

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, json);
  }
  process.stdout.write(json);
  // stderr, so the JSON on stdout stays machine-readable.
  process.stderr.write(`${TEASER}\n`);

  // --strict: exit non-zero when a REQUIRED concept-governance gate is unmet, so the
  // port flow (verify-tenant.sh / CI) CANNOT proceed past page fan-out without a
  // recorded storyboard + concept. This is the guardrail that keeps ports on the
  // rails — the gate existed before, but nothing forced it to run OR to fail.
  if (args.strict) {
    const required = ["storyboard", "chromeConcept"];
    const failed = required.filter((g) => result.gates?.[g]?.pass === false);
    if (failed.length) {
      let message = `\nstyle-concept-audit: BLOCKED — required gate(s) failed: ${failed.join(", ")}.\n`;
      if (failed.includes("storyboard")) {
        message +=
          `• storyboard: record styleConcept.storyboard (inspirationPages + uncoveredElementPolicy) + styleGaps[]\n` +
          `  in the manifest and establish the style concept and style guide\n` +
          `  BEFORE porting more pages. See the STOP gate in page-port.md/site-port.md.\n`;
      }
      if (failed.includes("chromeConcept")) {
        message +=
          `• chromeConcept: this tenant re-authors or inlines the shared chrome CSS. Retire the tenant chrome\n` +
          `  stylesheet and link ${SHARED_CHROME_HREF} instead. Offenders:\n` +
          `  inline=${result.gates.chromeConcept.inlineChromeCount}, re-authored=${result.gates.chromeConcept.reauthoredChromeCount}` +
          ` (see gates.chromeConcept in the JSON).\n`;
      }
      process.stderr.write(message);
      process.exitCode = 3;
    }
  }
}

// Run main() only when invoked as the CLI entry (validate-site.mjs spawns it as a
// subprocess, so it still runs). Guarded so tests can `import` the pure helpers +
// CHROME_STRUCTURAL_CLASSES without executing the audit.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
const isMain = invokedPath === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: {
            name: err?.name ?? "Error",
            message: (err?.message ?? String(err)).replace(/\s+/g, " ").slice(0, 360),
          },
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  });
}

export {
  CHROME_STRUCTURAL_CLASSES,
  SHARED_CHROME_HREF,
  chromeClassesInSelector,
  scanChromeSelectors,
  inspectChromeConcept,
  chromeConceptPass,
  componentEvidenceIsUnsourced,
};
