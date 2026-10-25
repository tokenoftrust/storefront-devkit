/**
 * The `.tot/config.json` keys the platform reads, and what happens to everything else.
 * Shared by `tot validate` (src/validate.mjs), the monorepo/dev-loop validator
 * (scripts/tenant/validate.mjs), the hosted reconcile, and the publication validator
 * (scripts/publish/validate-bundle.mjs), so every surface says the same thing.
 *
 * An unknown key is the store owner's to decide about: it is reported as a WARNING the
 * owner must approve before publication, naming the nearest key the platform does read
 * and what will not render because of it. A wrong-shaped value of a known key (a
 * `siteType` that is not a site type, a `compliance` that is not an object) stays an
 * error: there is no reading of it the platform could act on.
 *
 * Mirrors packages/public-runtime/src/declared-tenant-config.mjs (this package ships
 * to npm on its own); test/declared-config-parity.test.mjs pins the two together.
 * Dependency-free: the storefront runner copies this file as-is, and the devkit page checks carry
 * a byte-identical copy (docs/devkit-staging/tools/lib/declared-config.mjs, pinned by
 * test/declared-config-devkit-copy.test.mjs) so their gates read a store's declaration the same way.
 */

export const TOT_CONFIG_KEYS = [
  "$schema", "tenant", "scope", "mappings", "hostPlatform", "sample", "seed",
  "displayName", "siteType", "compliance", "capabilities", "features", "embeds", "seo", "currency", "shipping",
];
// Keys other tooling has written that the platform does NOT read, with the key it does.
const RENAMED_CONFIG_KEYS = { appDomain: "scope", tenantId: "tenant" };
export const COMPLIANCE_KEYS = [
  "ruleProfile", "minAge", "nicotineWarning", "shippingRestriction", "pactAct",
  "adultSignature", "prop65", "purchaseLimit", "stateEligibility", "exciseTax",
];
export const FEATURE_KEYS = [
  "catalog", "productSearch", "savedItems", "quickView", "productBadges", "newsletter", "commerceSitemap", "productJsonLd", "ageGate",
];
export const SITE_TYPES = ["commerce", "marketing"];

/** The currency a store sells in when `.tot/config.json` declares none. */
export const DEFAULT_CURRENCY = "USD";

/** ISO 4217 codes a store may declare as its `currency`. */
export const CURRENCY_CODES = Object.freeze(
  ("AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP " +
    "CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR " +
    "ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN " +
    "MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD " +
    "SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG").split(" "),
);

/**
 * The ONE place a store's currency is resolved. A declared ISO 4217 code wins; anything
 * else (absent, wrong shape, lowercase, unknown code) is USD. Every surface that prices,
 * signs or formats an amount takes the currency from here, never from a literal. Only the
 * store owner's `.tot/config.json` can change it: a shopper's request never reaches this.
 *
 * @param {unknown} declared
 * @returns {string}
 */
export function resolveStoreCurrency(declared) {
  return typeof declared === "string" && CURRENCY_CODES.includes(declared) ? declared : DEFAULT_CURRENCY;
}

/**
 * What is wrong with a declared `currency`, one sentence; `[]` when it is valid.
 *
 * @param {unknown} currency
 * @returns {string[]}
 */
export function currencyDeclarationProblems(currency) {
  return typeof currency === "string" && CURRENCY_CODES.includes(currency)
    ? []
    : [`\`currency\` is ${JSON.stringify(currency)} — must be an uppercase ISO 4217 code such as "USD" or "CAD"`];
}


/** Every `seo` key (mirrors packages/public-runtime/src/declared-tenant-config.mjs). */
export const SEO_KEYS = Object.freeze(["trailingSlash", "verbatimSeoTitles", "structuredData"]);

/** Every `seo.structuredData` key. */
export const STRUCTURED_DATA_KEYS = Object.freeze(["graphs", "names", "reviews", "onlyOn"]);

/**
 * The page types a structured-data profile declares a graph for. `productGroup` is a product
 * with more than one variant; without its own graph it renders the `product` graph.
 * `collection` covers every archive: a catalog collection, the collections index, and the
 * blog index and its category/tag/author archives.
 */
export const STRUCTURED_DATA_PAGE_TYPES = Object.freeze([
  "home", "product", "productGroup", "collection", "post", "page",
]);

/**
 * The JSON-LD nodes a profile may list, as the `@type` each emits (a multi-type node joins its
 * sorted types with `+`, the key a parity snapshot records). `Person:author` is the page's
 * author; every other Organization/Person token is the site entity.
 */
export const STRUCTURED_DATA_NODE_TOKENS = Object.freeze([
  "Organization", "Person", "Organization+Person",
  "WebSite", "ImageObject",
  "WebPage", "ItemPage", "CollectionPage", "AboutPage", "ContactPage",
  "Person:author",
  "Article", "BlogPosting",
  "Product", "ProductGroup",
  "FAQPage", "BreadcrumbList", "ItemList",
]);

/** Node types whose `name` a profile may source, and the sources. */
export const STRUCTURED_DATA_NAMED_TYPES = Object.freeze(["Product", "ProductGroup", "Article", "BlogPosting"]);
export const STRUCTURED_DATA_NAME_SOURCES = Object.freeze(["documentTitle", "title"]);

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * What is wrong with a declared `seo` value, one sentence per problem; `[]` when it is valid.
 * A profile that names a node or page type the renderer does not build is refused whole: a
 * partly-applied profile emits a graph nobody declared.
 *
 * @param {unknown} seo
 * @returns {string[]}
 */
export function seoDeclarationProblems(seo) {
  if (!isPlainObject(seo)) return ["`seo` must be an object"];
  const problems = [];
  const source = /** @type {Record<string, unknown>} */ (seo);
  for (const key of Object.keys(source)) {
    if (!SEO_KEYS.includes(key)) problems.push(`\`seo.${key}\` is not a seo key (${SEO_KEYS.join(", ")})`);
  }
  if (source.trailingSlash !== undefined && typeof source.trailingSlash !== "boolean") {
    problems.push("`seo.trailingSlash` must be true or false");
  }
  if (source.verbatimSeoTitles !== undefined && typeof source.verbatimSeoTitles !== "boolean") {
    problems.push("`seo.verbatimSeoTitles` must be true or false");
  }
  const sd = source.structuredData;
  if (sd === undefined) return problems;
  if (!isPlainObject(sd)) return [...problems, "`seo.structuredData` must be an object"];
  const data = /** @type {Record<string, unknown>} */ (sd);
  for (const key of Object.keys(data)) {
    if (!STRUCTURED_DATA_KEYS.includes(key)) {
      problems.push(`\`seo.structuredData.${key}\` is not a structuredData key (${STRUCTURED_DATA_KEYS.join(", ")})`);
    }
  }
  if (!isPlainObject(data.graphs) || Object.keys(/** @type {object} */ (data.graphs)).length === 0) {
    problems.push("`seo.structuredData.graphs` must map at least one page type to its node list");
  } else {
    for (const [pageType, tokens] of Object.entries(/** @type {Record<string, unknown>} */ (data.graphs))) {
      const at = `seo.structuredData.graphs.${pageType}`;
      if (!STRUCTURED_DATA_PAGE_TYPES.includes(pageType)) {
        problems.push(`\`${at}\`: unknown page type (${STRUCTURED_DATA_PAGE_TYPES.join(", ")})`);
        continue;
      }
      if (!Array.isArray(tokens)) {
        problems.push(`\`${at}\` must be an array of node types (empty emits no nodes)`);
        continue;
      }
      const seen = new Set();
      for (const token of tokens) {
        if (typeof token !== "string" || !STRUCTURED_DATA_NODE_TOKENS.includes(token)) {
          problems.push(`\`${at}\`: ${JSON.stringify(token)} is not a node type the renderer builds (${STRUCTURED_DATA_NODE_TOKENS.join(", ")})`);
        } else if (seen.has(token)) {
          problems.push(`\`${at}\` lists ${token} twice`);
        }
        seen.add(token);
      }
    }
  }
  if (data.names !== undefined) {
    if (!isPlainObject(data.names)) {
      problems.push("`seo.structuredData.names` must map a node type to documentTitle or title");
    } else {
      for (const [type, from] of Object.entries(/** @type {Record<string, unknown>} */ (data.names))) {
        if (!STRUCTURED_DATA_NAMED_TYPES.includes(type)) {
          problems.push(`\`seo.structuredData.names.${type}\`: only ${STRUCTURED_DATA_NAMED_TYPES.join(", ")} take a declared name`);
        } else if (typeof from !== "string" || !STRUCTURED_DATA_NAME_SOURCES.includes(from)) {
          problems.push(`\`seo.structuredData.names.${type}\` must be one of ${STRUCTURED_DATA_NAME_SOURCES.join(", ")}`);
        }
      }
    }
  }
  if (data.reviews !== undefined && typeof data.reviews !== "boolean") {
    problems.push("`seo.structuredData.reviews` must be true or false");
  }
  if (data.onlyOn !== undefined) {
    if (!isPlainObject(data.onlyOn)) {
      problems.push("`seo.structuredData.onlyOn` must map a node type to the paths it is emitted on");
    } else {
      for (const [token, paths] of Object.entries(/** @type {Record<string, unknown>} */ (data.onlyOn))) {
        const at = `seo.structuredData.onlyOn.${token}`;
        if (!STRUCTURED_DATA_NODE_TOKENS.includes(token)) {
          problems.push(`\`${at}\`: ${JSON.stringify(token)} is not a node type the renderer builds`);
        } else if (!Array.isArray(paths) || paths.length === 0
          || !paths.every((p) => typeof p === "string" && p.startsWith("/") && !p.startsWith("//"))) {
          problems.push(`\`${at}\` must be a non-empty array of root-absolute paths such as "/faq/"`);
        }
      }
    }
  }
  return problems;
}

/** Every `shipping` key (mirrors packages/public-runtime/src/declared-tenant-config.mjs). */
export const SHIPPING_KEYS = Object.freeze(["tiers"]);

/** Every key of one `shipping.tiers` entry. */
export const SHIPPING_TIER_KEYS = Object.freeze(["atOrAbove", "rate", "label"]);

/** Largest shipping amount a declaration may state, in the cart's currency. */
export const MAX_SHIPPING_AMOUNT = 100000;

/** Most tiers one policy may declare. */
export const MAX_SHIPPING_TIERS = 10;

/** Longest shipping-line label, in characters. */
export const MAX_SHIPPING_LABEL_LENGTH = 100;

/** @param {unknown} value */
const isShippingAmount = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SHIPPING_AMOUNT
  && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

/** @param {unknown} value */
const isShippingLabel = (value) =>
  typeof value === "string" && value.trim() === value && value.length > 0
  && [...value].length <= MAX_SHIPPING_LABEL_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);

/**
 * What is wrong with a declared `shipping` value, one sentence per problem; `[]` when it is
 * valid. A policy with any problem is refused whole, so checkout never charges half of one.
 *
 * Tiers are ordered by the item subtotal they start at. The first starts at 0 and states no
 * `atOrAbove`; each later tier's `atOrAbove` is above the one before it and is inclusive, so an
 * order whose subtotal equals it pays that tier's `rate`.
 *
 * @param {unknown} shipping
 * @returns {string[]}
 */
export function shippingDeclarationProblems(shipping) {
  if (!isPlainObject(shipping)) return ["`shipping` must be an object"];
  const problems = [];
  const source = /** @type {Record<string, unknown>} */ (shipping);
  for (const key of Object.keys(source)) {
    if (!SHIPPING_KEYS.includes(key)) problems.push(`\`shipping.${key}\` is not a shipping key (${SHIPPING_KEYS.join(", ")})`);
  }
  const tiers = source.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0 || tiers.length > MAX_SHIPPING_TIERS) {
    problems.push(`\`shipping.tiers\` must be a list of 1 to ${MAX_SHIPPING_TIERS} tiers`);
    return problems;
  }
  let previous = 0;
  tiers.forEach((tier, index) => {
    const at = `shipping.tiers[${index}]`;
    if (!isPlainObject(tier)) {
      problems.push(`\`${at}\` must be an object`);
      return;
    }
    const entry = /** @type {Record<string, unknown>} */ (tier);
    for (const key of Object.keys(entry)) {
      if (!SHIPPING_TIER_KEYS.includes(key)) problems.push(`\`${at}.${key}\` is not a tier key (${SHIPPING_TIER_KEYS.join(", ")})`);
    }
    if (!isShippingAmount(entry.rate)) {
      problems.push(`\`${at}.rate\` must be an amount from 0 to ${MAX_SHIPPING_AMOUNT} with at most two decimal places`);
    }
    if (entry.label !== undefined && !isShippingLabel(entry.label)) {
      problems.push(`\`${at}.label\` must be text of 1 to ${MAX_SHIPPING_LABEL_LENGTH} characters with no surrounding spaces or line breaks`);
    }
    if (index === 0) {
      if (entry.atOrAbove !== undefined) problems.push(`\`${at}\` starts at 0, so it states no \`atOrAbove\``);
      return;
    }
    if (!(isShippingAmount(entry.atOrAbove) && /** @type {number} */ (entry.atOrAbove) > previous)) {
      problems.push(`\`${at}.atOrAbove\` must be an amount above ${previous}, where the tier before it starts, and at most ${MAX_SHIPPING_AMOUNT} with at most two decimal places`);
      return;
    }
    previous = /** @type {number} */ (entry.atOrAbove);
  });
  return problems;
}

/** The owner-facing sentence for an invalid `shipping` declaration. */
function shippingProblemMessage(problems) {
  return `\`shipping\` is not a valid shipping policy (${problems.join("; ")}). ` +
    "Checkout charges no shipping until it is fixed.";
}


/** What each compliance key puts on the page — the thing that is missing when it is. */
export const COMPLIANCE_NOTICES = {
  ruleProfile: "checkout compliance rules",
  minAge: "age gate",
  nicotineWarning: "FDA nicotine warning",
  shippingRestriction: "shipping-restriction notice",
  pactAct: "PACT Act notice",
  adultSignature: "adult-signature notice",
  prop65: "California Prop 65 warning",
  purchaseLimit: "purchase-limit notice",
  stateEligibility: "state-eligibility notice",
  exciseTax: "excise-tax notice",
};

/**
 * The compliance keys that each turn on a mandated duty in the platform's obligation
 * model (packages/public-runtime/src/compliance-obligations.ts). Dropping one between
 * the live revision and the one being published removes a mandated notice from the
 * site — a decision the owner must make explicitly.
 */
export const MANDATED_NOTICE_KEYS = [
  "minAge", "nicotineWarning", "pactAct", "adultSignature", "prop65",
  "stateEligibility", "shippingRestriction", "exciseTax",
];

const ERROR = "error";
const WARN = "warn";
/** @type {(v: unknown) => v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The platform's compliance obligations — the registry in
 * packages/public-runtime/src/compliance-obligations.ts, mirrored here because this file
 * is dependency-free: each duty's id, its compliance-authority surface, and the declared
 * `compliance.*` keys that switch it on. packages/private-controlplane/tests/
 * compliance-obligation-checks.test.ts pins this list to the registry, key for key.
 */
export const COMPLIANCE_OBLIGATIONS = Object.freeze([
  { id: "age_gate", surface: "regulated", keys: ["minAge"] },
  { id: "excise", surface: "regulated", keys: ["nicotineWarning", "exciseTax"] },
  { id: "nicotine_warning", surface: "regulated", keys: ["nicotineWarning"] },
  { id: "pact_act", surface: "regulated", keys: ["pactAct"] },
  { id: "adult_signature", surface: "regulated", keys: ["adultSignature"] },
  { id: "prop65", surface: "commerce", keys: ["prop65"] },
  { id: "jurisdiction", surface: "commerce", keys: ["stateEligibility", "shippingRestriction"] },
]);

/**
 * The obligations a declared compliance block switches on, as `resolveObligations` returns
 * them (id + surface), in registry order.
 * @param {Record<string, any> | null | undefined} compliance
 * @returns {{ id: string, surface: string }[]}
 */
export function declaredObligations(compliance) {
  return COMPLIANCE_OBLIGATIONS
    .filter((o) => o.keys.some((key) => !!compliance?.[key]))
    .map(({ id, surface }) => ({ id, surface }));
}

/** True when the declared block puts the store on the regulated surface. */
export function isRegulatedCompliance(compliance) {
  return isRegulatedObligationSet(declaredObligations(compliance));
}

/**
 * Compliance coherence — the declared-config half of the hosted preview's `age_gate`,
 * `excise` and `jurisdiction` evidence checks, so `tot validate` fails locally on
 * exactly what the reconcile fails. Mirrors
 * packages/public-runtime/src/compliance-coherence.mjs (the platform's single source);
 * test/declared-config-parity.test.mjs pins the two together.
 */
export const COHERENCE_CHECK_IDS = Object.freeze(/** @type {const} */ (["age_gate", "excise", "jurisdiction"]));

export const OBLIGATION_EVIDENCE_CHECK = Object.freeze({
  age_gate: "age_gate",
  excise: "excise",
  nicotine_warning: "excise",
  pact_act: "jurisdiction",
  adult_signature: "jurisdiction",
  jurisdiction: "jurisdiction",
  prop65: null,
});

/** @param {readonly { id: string, surface: string }[]} obligations */
export function isRegulatedObligationSet(obligations) {
  return obligations.some((o) => o.surface === "regulated");
}

/**
 * @param {readonly { id: string, surface: string }[]} obligations
 * @returns {("age_gate" | "excise" | "jurisdiction")[]}
 */
export function coherenceChecksFor(obligations) {
  const out = new Set();
  if (isRegulatedObligationSet(obligations)) {
    out.add("age_gate");
    out.add("jurisdiction");
  }
  for (const { id } of obligations) {
    if (!Object.hasOwn(OBLIGATION_EVIDENCE_CHECK, id)) {
      for (const check of COHERENCE_CHECK_IDS) out.add(check);
      continue;
    }
    const check = OBLIGATION_EVIDENCE_CHECK[/** @type {keyof typeof OBLIGATION_EVIDENCE_CHECK} */ (id)];
    if (check) out.add(check);
  }
  return COHERENCE_CHECK_IDS.filter((c) => out.has(c));
}

export function declaresJurisdictionNotice(compliance) {
  const text = compliance?.shippingRestriction;
  return compliance?.pactAct === true || (typeof text === "string" && text.trim().length > 0);
}

/** @param {unknown} declaration */
function stateEligibilityHasContent(declaration) {
  if (declaration === null || typeof declaration !== "object" || Array.isArray(declaration)) return false;
  const d = /** @type {Record<string, unknown>} */ (declaration);
  const listed = (v) => Array.isArray(v) && v.some((s) => typeof s === "string" && s.trim().length > 0);
  return listed(d.restrictedStates) || listed(d.eligibleStates) || (typeof d.note === "string" && d.note.trim().length > 0);
}

const REGULATED_KEY_FOR = Object.freeze({
  age_gate: "minAge",
  excise: "exciseTax",
  nicotine_warning: "nicotineWarning",
  pact_act: "pactAct",
  adult_signature: "adultSignature",
});

function regulatedBy(compliance, obligations) {
  const keys = new Set();
  for (const o of obligations) {
    if (o.surface !== "regulated") continue;
    const key = REGULATED_KEY_FOR[/** @type {keyof typeof REGULATED_KEY_FOR} */ (o.id)];
    if (o.id === "excise" && !compliance?.exciseTax) continue;
    if (key) keys.add(key);
  }
  return [...keys].map((k) => `\`compliance.${k}\``).join(", ") || "a regulated obligation";
}

/**
 * @param {Record<string, any> | null | undefined} compliance
 * @param {readonly { id: string, surface: string }[]} [obligations] defaults to what the block declares
 * @returns {Partial<Record<"age_gate" | "excise" | "jurisdiction", { field: string, detail: string, hint: string }>>}
 */
export function complianceCoherenceFailures(compliance, obligations = declaredObligations(compliance)) {
  /** @type {Partial<Record<"age_gate" | "excise" | "jurisdiction", { field: string, detail: string, hint: string }>>} */
  const out = {};
  const checks = coherenceChecksFor(obligations);
  const regulated = isRegulatedObligationSet(obligations);
  const minAge = typeof compliance?.minAge === "number" ? compliance.minAge : null;
  if (checks.includes("age_gate") && regulated && (minAge == null || minAge < 18)) {
    out.age_gate = {
      field: "compliance.minAge",
      detail: `Age-restricted products (${regulatedBy(compliance, obligations)}) require \`compliance.minAge\` (18 or higher) — none is set.`,
      hint: "Set `compliance.minAge` (18+) in .tot/config.json.",
    };
  }
  if (compliance?.nicotineWarning && (minAge == null || minAge < 21)) {
    out.excise = {
      field: "compliance.minAge",
      detail: "Nicotine products (`compliance.nicotineWarning`) require `compliance.minAge` of 21 or higher.",
      hint: "Set `compliance.minAge` to 21 in .tot/config.json (nicotine requires 21+, not just 18+).",
    };
  }
  if (checks.includes("jurisdiction")) {
    if (regulated && !declaresJurisdictionNotice(compliance)) {
      out.jurisdiction = {
        field: "compliance.pactAct",
        detail:
          `Regulated products (${regulatedBy(compliance, obligations)}) require a shipping/jurisdiction notice: ` +
          "set `compliance.pactAct: true` or `compliance.shippingRestriction` — neither is set.",
        hint:
          "Set `compliance.pactAct: true` for the platform's PACT Act notice, or " +
          "`compliance.shippingRestriction` to your own restriction text, in .tot/config.json.",
      };
    } else if (!regulated && !declaresJurisdictionNotice(compliance)
      && !stateEligibilityHasContent(compliance?.stateEligibility)) {
      const field = compliance?.stateEligibility ? "compliance.stateEligibility" : "compliance.shippingRestriction";
      out.jurisdiction = {
        field,
        detail:
          `\`${field}\` is declared but gives its shipping/jurisdiction notice nothing to say, so no notice renders.`,
        hint:
          "Set `compliance.shippingRestriction` to your restriction text, or give `compliance.stateEligibility` " +
          "`restrictedStates`, `eligibleStates` or a `note`, in .tot/config.json.",
      };
    }
  }
  return out;
}

/**
 * The compliance findings `tot validate` reports for a declared block: an ERROR per
 * coherence failure the hosted preview would fail (`evidence-<check>`), and a WARNING
 * when a regulated store declares no `ruleProfile` — its preview renders, but going
 * live refuses because no checkout rules resolve.
 * @param {Record<string, any>} config
 * @param {string} file
 * @returns {Finding[]}
 */
export function complianceFindings(config, file = ".tot/config.json") {
  const compliance = isObject(config?.compliance) ? config.compliance : null;
  const obligations = declaredObligations(compliance);
  const owed = new Set(obligations.map((o) => o.id));
  const out = [];
  for (const [check, failure] of Object.entries(complianceCoherenceFailures(compliance, obligations))) {
    out.push(mk(ERROR, `compliance-${check.replace("_", "-")}`, `${file} compliance`,
      `${failure.detail} The hosted preview fails its \`${check}\` check on this.`, failure.hint));
  }
  // The hosted reconcile refuses a declaration whose `capabilities` switch off the
  // compliance floor (packages/public-runtime/src/capabilities.ts capabilityFloorViolations).
  const capabilities = isObject(config?.capabilities) ? config.capabilities : {};
  if (owed.has("age_gate") && capabilities.ageVerification?.enabled === false) {
    out.push(mk(ERROR, "capability-compliance-floor", `${file} capabilities`,
      "`capabilities.ageVerification` cannot be disabled for a store with `compliance.minAge` — the hosted preview refuses this revision.",
      "Remove `capabilities.ageVerification.enabled: false` from .tot/config.json."));
  }
  if (owed.has("excise") && capabilities.exciseTax?.enabled === false) {
    out.push(mk(ERROR, "capability-compliance-floor", `${file} capabilities`,
      "`capabilities.exciseTax` cannot be disabled for a store with `compliance.nicotineWarning` or `compliance.exciseTax` — the hosted preview refuses this revision.",
      "Remove `capabilities.exciseTax.enabled: false` from .tot/config.json."));
  }
  if (isRegulatedObligationSet(obligations) && !compliance?.ruleProfile) {
    out.push(mk(WARN, "compliance-rule-profile", `${file} compliance`,
      `This store is regulated (${regulatedBy(compliance, obligations)}) but declares no ` +
        "`compliance.ruleProfile`, so no checkout rules resolve: the preview renders, but checkout blocks " +
        "and going live refuses.",
      'Declare `compliance.ruleProfile` (e.g. "vape-nicotine-us") in .tot/config.json.'));
  }
  return out;
}

/** @typedef {{level:string, rule:string, file:string, message:string, fix?:string}} Finding */
function mk(level, rule, file, message, fix) {
  return { level, rule, file, message, fix };
}

/** Case-insensitive edit distance. */
function distance(a, b) {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const row = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (s[i - 1] === t[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[t.length];
}

/**
 * The known key an unknown one most plausibly meant, or null when none is close.
 * @param {string} key
 * @param {readonly string[]} known
 * @returns {string | null}
 */
export function nearestKey(key, known) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = distance(key, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  const lower = key.toLowerCase();
  const near = best !== null && (bestDistance <= Math.max(2, Math.floor(best.length / 3)) ||
    best.toLowerCase().startsWith(lower) || lower.startsWith(best.toLowerCase()));
  return near ? best : null;
}

/**
 * Every key in a `.tot/config.json` the platform does not read, with the key it most
 * plausibly meant and the consequence. `path` is dotted (`compliance.nicotineWarnings`).
 * @param {Record<string, any>} config
 * @returns {{ path: string, suggestion: string | null, consequence: string }[]}
 */
export function unknownConfigKeys(config) {
  const out = [];
  for (const key of Object.keys(config)) {
    if (TOT_CONFIG_KEYS.includes(key)) continue;
    const suggestion = RENAMED_CONFIG_KEYS[/** @type {keyof typeof RENAMED_CONFIG_KEYS} */ (key)] ??
      nearestKey(key, TOT_CONFIG_KEYS);
    out.push({ path: key, suggestion, consequence: "the platform never reads it" });
  }
  /** @type {Array<[string, string[]]>} */
  const objectFields = [["compliance", COMPLIANCE_KEYS], ["features", FEATURE_KEYS]];
  for (const [field, known] of objectFields) {
    const value = config[field];
    if (!isObject(value)) continue;
    for (const key of Object.keys(value)) {
      if (known.includes(key)) continue;
      const suggestion = nearestKey(key, known);
      const notice = field === "compliance" && suggestion && !(suggestion in value)
        ? COMPLIANCE_NOTICES[/** @type {keyof typeof COMPLIANCE_NOTICES} */ (suggestion)]
        : null;
      out.push({
        path: `${field}.${key}`,
        suggestion: suggestion ? `${field}.${suggestion}` : null,
        consequence: notice
          ? `this setting does nothing — your ${notice} will NOT render`
          : "this setting does nothing",
      });
    }
  }
  return out;
}

/** The one-line, owner-facing sentence for an unknown key. */
function unknownKeyMessage({ path, suggestion, consequence }) {
  return `\`${path}\` is not a .tot/config.json key${suggestion ? ` — did you mean \`${suggestion}\`?` : ""} ` +
    `${consequence.charAt(0).toUpperCase()}${consequence.slice(1)}.`;
}

/**
 * The mandated notices the live revision declared that this one no longer does.
 * @param {Record<string, any> | null | undefined} previous the live revision's `.tot/config.json`
 * @param {Record<string, any> | null | undefined} current this revision's `.tot/config.json`
 * @returns {{ key: string, notice: string }[]}
 */
export function droppedMandatedNotices(previous, current) {
  const before = isObject(previous?.compliance) ? previous.compliance : {};
  const now = isObject(current?.compliance) ? current.compliance : {};
  return MANDATED_NOTICE_KEYS
    .filter((key) => Boolean(before[key]) && !now[key])
    .map((key) => ({ key, notice: COMPLIANCE_NOTICES[/** @type {keyof typeof COMPLIANCE_NOTICES} */ (key)] }));
}

/**
 * The FDA nicotine warning presentation this revision would put live that the live site does
 * not already show: a custom (non-preset) presentation whose resolved values differ from the
 * live revision's. Null when the warning is off, invalid, a validated preset, or unchanged.
 * @param {Record<string, any> | null | undefined} current
 * @param {Record<string, any> | null | undefined} previous
 * @returns {string | null} the exact presentation, as describeNicotineWarningPresentation states it
 */
export function unreviewedNicotineWarningPresentation(current, previous) {
  const now = resolveNicotineWarning(isObject(current?.compliance) ? current.compliance.nicotineWarning : undefined);
  if (!now.enabled || !now.custom) return null;
  const before = resolveNicotineWarning(isObject(previous?.compliance) ? previous.compliance.nicotineWarning : undefined);
  const spec = describeNicotineWarningPresentation(now.presentation);
  return before.enabled && before.custom && describeNicotineWarningPresentation(before.presentation) === spec ? null : spec;
}

/**
 * The publication validator's findings for a revision's declaration: an owner-approvable
 * `CONFIG:` finding per unknown key or invalid nicotine-warning presentation, a `COMPLIANCE:`
 * finding per mandated notice the live site shows and this revision drops, and a
 * `COMPLIANCE:` finding for a custom nicotine-warning presentation the live site does not
 * already show. All are QUALITY findings (scripts/publish/lib/finding-severity.mjs):
 * publication halts until the owner accepts them through "Accept issue & continue", which
 * records who accepted these exact findings, when, and why.
 * @param {Record<string, any> | null | undefined} current
 * @param {Record<string, any> | null | undefined} previous
 * @returns {string[]}
 */
export function declarationFindings(current, previous) {
  const out = [];
  if (isObject(current)) {
    for (const unknown of unknownConfigKeys(current)) out.push(`CONFIG: ${unknownKeyMessage(unknown)}`);
    const warning = resolveNicotineWarning(isObject(current.compliance) ? current.compliance.nicotineWarning : undefined);
    if (warning.enabled && warning.problems.length > 0) {
      out.push(`CONFIG: ${nicotineWarningProblemMessage(warning.problems)}`);
    }
    const shipping = current.shipping === undefined ? [] : shippingDeclarationProblems(current.shipping);
    if (shipping.length > 0) out.push(`CONFIG: ${shippingProblemMessage(shipping)}`);
  }
  for (const { key, notice } of droppedMandatedNotices(previous, current)) {
    out.push(
      `COMPLIANCE: the live site shows the ${notice} (\`compliance.${key}\`) and this revision no longer ` +
        `declares it — publishing removes a mandated notice from the store.`,
    );
  }
  const custom = unreviewedNicotineWarningPresentation(current, previous);
  if (custom) {
    out.push(
      `COMPLIANCE: the FDA nicotine warning uses a custom presentation outside the validated presets — ${custom}. ` +
        `Approving records that you reviewed exactly these values; changing any of them asks again.`,
    );
  }
  return out;
}

/** The owner-facing sentence for an invalid `compliance.nicotineWarning`. */
function nicotineWarningProblemMessage(problems) {
  return `\`compliance.nicotineWarning\` is not a valid presentation (${problems.join("; ")}). ` +
    `The warning renders in the default "dark" preset instead.`;
}

/**
 * The validator's report on a `.tot/config.json`: a WARNING per unknown key (owner-approved
 * before publication), an error per wrong-shaped value of a known key.
 * @param {Record<string, any>} config parsed `.tot/config.json` (an object)
 * @param {string} [file]
 * @returns {Finding[]}
 */
export function validateDeclaredConfig(config, file = ".tot/config.json") {
  const out = [];
  for (const unknown of unknownConfigKeys(config)) {
    const nested = unknown.path.includes(".");
    out.push(mk(WARN, nested ? `config-${unknown.path.split(".")[0]}-unknown-key` : "config-unknown-key",
      nested ? `${file} ${unknown.path.split(".")[0]}` : file,
      unknownKeyMessage(unknown),
      unknown.suggestion
        ? `rename it to \`${unknown.suggestion}\`, or keep it and approve the warning when you publish`
        : "remove it, or keep it and approve the warning when you publish"));
  }
  if (config.displayName !== undefined && !(typeof config.displayName === "string" && config.displayName.trim())) {
    out.push(mk(ERROR, "config-display-name", file,
      "`displayName` must be a non-empty string — the store's name as visitors read it (page titles, og:site_name, the copyright line)"));
  }
  if (config.siteType !== undefined && !SITE_TYPES.includes(config.siteType)) {
    out.push(mk(ERROR, "config-site-type", file, `\`siteType\` is "${config.siteType}" — must be one of ${SITE_TYPES.join(", ")}`));
  }
  for (const field of ["compliance", "features"]) {
    if (config[field] !== undefined && !isObject(config[field])) {
      out.push(mk(ERROR, `config-${field}`, file, `\`${field}\` must be an object`));
    }
  }
  out.push(...complianceFindings(config, file));
  const declaration = isObject(config.compliance) ? config.compliance.nicotineWarning : undefined;
  for (const problem of nicotineWarningCheckWidths(declaration).problems) {
    out.push(mk(ERROR, "config-nicotine-warning-check-widths", `${file} compliance`,
      `\`compliance.nicotineWarning\`: ${problem}. The page browser gate cannot check the warning at the widths you meant.`,
      "list the widths where your layout changes (e.g. where your header becomes fixed), or remove `checkWidthsPx`"));
  }
  const warning = resolveNicotineWarning(declaration);
  if (warning.enabled && warning.problems.length > 0) {
    out.push(mk(ERROR, "config-nicotine-warning", `${file} compliance`, nicotineWarningProblemMessage(warning.problems),
      'use `true`, `{ "preset": "dark" }` or `{ "preset": "light" }`, or fix the style values named above'));
  } else if (warning.custom) {
    out.push(mk(WARN, "config-nicotine-warning-custom", `${file} compliance`,
      `\`compliance.nicotineWarning\` uses a custom presentation outside the validated presets — ` +
        `${describeNicotineWarningPresentation(warning.presentation)}. It renders in preview; it goes live only ` +
        `after you approve it in the go-live compliance review.`,
      'use a preset (`"dark"`, `"light"`) to skip the review, or keep it and approve it when you publish'));
  }
  if (config.capabilities !== undefined && !isObject(config.capabilities)) {
    out.push(mk(ERROR, "config-capabilities", file, "`capabilities` must be an object"));
  }
  if (config.embeds !== undefined
    && !(Array.isArray(config.embeds) && config.embeds.every((/** @type {unknown} */ s) => typeof s === "string"))) {
    out.push(mk(ERROR, "config-embeds", file, '`embeds` must be an array of embed slugs, e.g. ["youtube"]'));
  }
  if (config.currency !== undefined) {
    for (const problem of currencyDeclarationProblems(config.currency)) {
      out.push(mk(ERROR, "config-currency", file, `${problem} — the store sells in ${DEFAULT_CURRENCY} until it is fixed`));
    }
  }
  if (config.seo !== undefined) {
    for (const problem of seoDeclarationProblems(config.seo)) {
      out.push(mk(ERROR, "config-seo", `${file} seo`, `${problem} — the whole \`seo\` declaration is ignored until it is fixed`));
    }
  }
  if (config.shipping !== undefined) {
    const problems = shippingDeclarationProblems(config.shipping);
    if (problems.length > 0) {
      out.push(mk(ERROR, "config-shipping", `${file} shipping`, shippingProblemMessage(problems),
        'declare e.g. `"shipping": { "tiers": [ { "rate": 5.99 }, { "atOrAbove": 100, "rate": 0, "label": "Free shipping" } ] }`, or remove `shipping` to charge none'));
    }
  }
  return out;
}

// ── The FDA nicotine warning (21 CFR 1143.3): what compliance.nicotineWarning may declare ──
//
// The wording is fixed by law and is not configurable. The presentation is one of the
// validated presets, or a custom style built on one:
//
//   "nicotineWarning": true                                   → the "dark" preset
//   "nicotineWarning": { "preset": "light" }                  → a validated preset
//   "nicotineWarning": { "preset": "light", "style": {...} }  → a custom presentation
//   "nicotineWarning": { "checkWidthsPx": [800] }             → also checked seen at 800px wide
//
// Every presentation — preset or custom — must clear CONSPICUITY_FLOOR. A preset needs no
// review. A custom presentation is a deviation the owner approves at go-live:
// declarationFindings raises it as a COMPLIANCE finding that spells out every resolved style
// value, and the owner's "Accept issue & continue" records who approved exactly those values,
// when, and why. Any change to the styling produces a different finding, so it is reviewed again.
//
// The style keys are a closed set of colours, case, weight and size. Nothing here can position,
// hide, shrink below the floor, or dismiss the warning, and a declaration that is invalid renders
// the default preset rather than nothing. The hosted renderer (NicotineWarning.astro and the
// raw-HTML path) renders through nicotineWarningHtml, so every surface presents it identically.

export const NICOTINE_WARNING_TEXT =
  "WARNING: This product contains nicotine. Nicotine is an addictive chemical.";

/** The floor every presentation clears: WCAG AAA text contrast, a 12px minimum, semibold or heavier. */
export const CONSPICUITY_FLOOR = Object.freeze({ contrast: 7, fontSizePx: 12, fontWeight: 600 });

/** Bounds on the size a custom style may declare, so the bar cannot swallow the header. */
const MAX_FONT_SIZE_PX = 24;

export const DEFAULT_NICOTINE_WARNING_PRESET = "dark";

/**
 * The validated presets. `dark` is the platform default; `light` matches a light bar with a
 * dark border and bold normal-case text.
 * @type {Readonly<Record<string, Readonly<NicotineWarningPresentation>>>}
 */
export const NICOTINE_WARNING_PRESETS = Object.freeze({
  dark: Object.freeze({
    background: "#111111",
    text: "#ffffff",
    border: "#111111",
    textTransform: "uppercase",
    fontWeight: 600,
    fontSizePx: 12,
  }),
  light: Object.freeze({
    background: "#e6e6e6",
    text: "#000000",
    border: "#000000",
    textTransform: "none",
    fontWeight: 700,
    fontSizePx: 14,
  }),
});

/**
 * @typedef {{
 *   background: string,
 *   text: string,
 *   border: string,
 *   textTransform: "uppercase" | "none",
 *   fontWeight: number,
 *   fontSizePx: number,
 * }} NicotineWarningPresentation
 */

/** Every key a `compliance.nicotineWarning` object may declare. */
export const NICOTINE_WARNING_KEYS = Object.freeze(["preset", "style", "checkWidthsPx"]);

export const NICOTINE_WARNING_STYLE_KEYS = Object.freeze([
  "background", "text", "border", "textTransform", "fontWeight", "fontSizePx",
]);
const TEXT_TRANSFORMS = ["uppercase", "none"];
const FONT_WEIGHTS = [600, 700, 800, 900];
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#abc` / `#AABBCC` → `#aabbcc`. */
function normalizeHex(value) {
  const hex = value.slice(1).toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
}

function luminance(hex) {
  const n = normalizeHex(hex);
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two hex colours. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Why a presentation is not conspicuous enough — empty when it clears the floor.
 * @param {NicotineWarningPresentation} p
 * @returns {string[]}
 */
export function conspicuityProblems(p) {
  const out = [];
  const ratio = contrastRatio(p.text, p.background);
  if (ratio < CONSPICUITY_FLOOR.contrast) {
    out.push(`text ${p.text} on background ${p.background} has contrast ${ratio.toFixed(2)}:1 — the floor is ${CONSPICUITY_FLOOR.contrast}:1`);
  }
  if (p.fontSizePx < CONSPICUITY_FLOOR.fontSizePx) {
    out.push(`font size ${p.fontSizePx}px is below the ${CONSPICUITY_FLOOR.fontSizePx}px floor`);
  }
  if (p.fontWeight < CONSPICUITY_FLOOR.fontWeight) {
    out.push(`font weight ${p.fontWeight} is below the ${CONSPICUITY_FLOOR.fontWeight} floor`);
  }
  return out;
}

/** Why one declared style value is not usable, or null. */
function styleValueProblem(key, value) {
  switch (key) {
    case "background":
    case "text":
    case "border":
      return typeof value === "string" && HEX.test(value) ? null : `\`${key}\` must be a hex colour like "#e6e6e6"`;
    case "textTransform":
      return TEXT_TRANSFORMS.includes(value) ? null : `\`textTransform\` must be one of ${TEXT_TRANSFORMS.map((t) => `"${t}"`).join(", ")}`;
    case "fontWeight":
      return FONT_WEIGHTS.includes(value) ? null : `\`fontWeight\` must be one of ${FONT_WEIGHTS.join(", ")}`;
    case "fontSizePx":
      return typeof value === "number" && Number.isFinite(value) && value >= CONSPICUITY_FLOOR.fontSizePx && value <= MAX_FONT_SIZE_PX
        ? null
        : `\`fontSizePx\` must be a number from ${CONSPICUITY_FLOOR.fontSizePx} to ${MAX_FONT_SIZE_PX}`;
    default:
      return `\`${key}\` is not a nicotine-warning style key (allowed: ${NICOTINE_WARNING_STYLE_KEYS.join(", ")})`;
  }
}

function samePresentation(a, b) {
  return NICOTINE_WARNING_STYLE_KEYS.every((k) => a[k] === b[k]);
}

/**
 * @typedef {{
 *   enabled: boolean,
 *   presentation: NicotineWarningPresentation,
 *   preset: string | null,
 *   custom: boolean,
 *   problems: string[],
 * }} ResolvedNicotineWarning
 */

/**
 * Resolve a `compliance.nicotineWarning` declaration to what renders.
 *
 * `preset` names the preset the presentation equals (null for a custom one); `custom` is
 * true when the owner must review it; `problems` lists why the declaration is invalid, in
 * which case the default preset renders. A disabled declaration (absent, `false`) resolves
 * `enabled: false`.
 * @param {unknown} declaration
 * @returns {ResolvedNicotineWarning}
 */
export function resolveNicotineWarning(declaration) {
  const fallback = NICOTINE_WARNING_PRESETS[DEFAULT_NICOTINE_WARNING_PRESET];
  const resolved = (/** @type {Partial<ResolvedNicotineWarning>} */ fields) => ({
    enabled: true,
    presentation: { ...fallback },
    preset: DEFAULT_NICOTINE_WARNING_PRESET,
    custom: false,
    problems: [],
    ...fields,
  });
  if (!declaration) return resolved({ enabled: false });
  if (declaration === true) return resolved({});
  if (!isObject(declaration)) {
    return resolved({ problems: ["must be `true` or an object like { \"preset\": \"light\" }"] });
  }
  const { preset: presetName = DEFAULT_NICOTINE_WARNING_PRESET, style, checkWidthsPx: _checkWidths, ...rest } =
    /** @type {Record<string, unknown>} */ (declaration);
  const problems = Object.keys(rest).map((k) => `\`${k}\` is not a nicotineWarning key (allowed: ${NICOTINE_WARNING_KEYS.join(", ")})`);
  const base = typeof presetName === "string" ? NICOTINE_WARNING_PRESETS[presetName] : undefined;
  if (!base) {
    problems.push(`\`preset\` must be one of ${Object.keys(NICOTINE_WARNING_PRESETS).map((p) => `"${p}"`).join(", ")}`);
  }
  if (style !== undefined && !isObject(style)) problems.push("`style` must be an object");
  const declaredStyle = isObject(style) ? /** @type {Record<string, unknown>} */ (style) : {};
  for (const [key, value] of Object.entries(declaredStyle)) {
    const problem = styleValueProblem(key, value);
    if (problem) problems.push(problem);
  }
  if (problems.length > 0 || !base) return resolved({ problems });

  /** @type {NicotineWarningPresentation} */
  const presentation = { ...base };
  for (const [key, value] of Object.entries(declaredStyle)) {
    presentation[/** @type {keyof NicotineWarningPresentation} */ (key)] =
      /** @type {never} */ (typeof value === "string" && HEX.test(value) ? normalizeHex(value) : value);
  }
  const conspicuity = conspicuityProblems(presentation);
  if (conspicuity.length > 0) return resolved({ problems: conspicuity });
  const matching = Object.keys(NICOTINE_WARNING_PRESETS).find((name) => samePresentation(NICOTINE_WARNING_PRESETS[name], presentation));
  return resolved({ presentation, preset: matching ?? null, custom: !matching });
}

/** The viewport widths a store may add to the page browser gate's nicotine-warning check. */
export const NICOTINE_WARNING_CHECK_WIDTH_BOUNDS = Object.freeze({ min: 320, max: 3840 });

/**
 * The extra viewport widths at which the page browser gate checks the nicotine warning is seen.
 *
 * The gate always checks its own phone, tablet, laptop and desktop widths; `checkWidthsPx` adds
 * the store's own breakpoints (e.g. the width where its header becomes fixed) and never removes
 * a default. A store that does not declare the warning has no widths; `true` and an object
 * without `checkWidthsPx` add none.
 *
 *   "nicotineWarning": { "preset": "dark", "checkWidthsPx": [800, 1180] }
 *
 * `problems` lists why a declared value is unusable, in which case no extra width is used.
 * @param {unknown} declaration the store's `compliance.nicotineWarning`
 * @returns {{ widths: number[], problems: string[] }}
 */
export function nicotineWarningCheckWidths(declaration) {
  if (!isObject(declaration)) return { widths: [], problems: [] };
  const value = /** @type {Record<string, unknown>} */ (declaration).checkWidthsPx;
  if (value === undefined) return { widths: [], problems: [] };
  const { min, max } = NICOTINE_WARNING_CHECK_WIDTH_BOUNDS;
  const usable = (/** @type {unknown} */ w) => Number.isInteger(w) && /** @type {number} */ (w) >= min && /** @type {number} */ (w) <= max;
  if (!Array.isArray(value) || value.length === 0 || !value.every(usable)) {
    return { widths: [], problems: [`\`checkWidthsPx\` must be a non-empty array of whole pixel widths from ${min} to ${max}, e.g. [800]`] };
  }
  return { widths: [...new Set(/** @type {number[]} */ (value))].sort((a, b) => a - b), problems: [] };
}

/**
 * The exact, human-readable statement of a custom presentation — what the owner approves.
 * Every resolved value is in it, so two presentations that differ in any value describe
 * differently.
 * @param {NicotineWarningPresentation} p
 */
export function describeNicotineWarningPresentation(p) {
  return `background ${p.background}, text ${p.text}, border ${p.border}, ` +
    `${p.textTransform === "uppercase" ? "uppercase" : "normal case"}, weight ${p.fontWeight}, ${p.fontSizePx}px`;
}

/**
 * The warning's markup — the one rendering shared by NicotineWarning.astro and the raw-HTML
 * serve path, so both present the same declaration identically. "bar" is the strip at the top
 * of every page; "block" is the reinforced box on the product page. Every interpolated value
 * is a validated hex colour, enum or number. Styling is inline (no utility classes), so the
 * markup renders the same wherever it is served, whatever stylesheet the page carries.
 *
 * Every presentation and visibility declaration is inline `!important`, which no tenant
 * stylesheet rule can override: tenant CSS cannot hide, move, clip, fade or restyle the warning,
 * and the text element re-asserts the warning's own presentation so a tenant `p { … }` rule does
 * not reach it. What inline styles cannot stop is another element painting over the warning (a
 * fixed or sticky header pinned to the top of the viewport). Raising the warning above page
 * chrome would paint it over the tenant's own open menus and drawers, so occlusion is measured
 * instead: the page browser gate (`validate-page-browser.mjs`, `nicotineWarning`) fails a page
 * whose warning is covered at a phone, tablet or desktop width, or at a width the store declares
 * in `checkWidthsPx`, and names the covering element.
 * @param {unknown} declaration the tenant's `compliance.nicotineWarning`
 * @param {"bar" | "block"} variant
 */
export function nicotineWarningHtml(declaration, variant) {
  const { presentation, preset } = resolveNicotineWarning(declaration);
  const attrs = `style="${nicotineWarningStyle(presentation, variant)}" role="note" aria-label="Health warning" ` +
    `data-compliance="nicotine-warning" data-nicotine-warning-preset="${preset ?? "custom"}"`;
  const text = NICOTINE_WARNING_TEXT_LOCK;
  return variant === "bar"
    ? `<div ${attrs}><p class="container-prose" style="margin-block:0;padding-block:0.5rem;text-align:center;${text}">${NICOTINE_WARNING_TEXT}</p></div>`
    : `<div ${attrs}><p style="margin:0;${text}">${NICOTINE_WARNING_TEXT}</p></div>`;
}

/** Declarations that keep the warning on screen, at full opacity, in its own place. */
const NICOTINE_WARNING_VISIBILITY_LOCK = [
  "display:block",
  "visibility:visible",
  "opacity:1",
  "position:relative",
  "inset:auto",
  "transform:none",
  "clip-path:none",
  "filter:none",
  "height:auto",
  "max-height:none",
  "overflow:visible",
];

/** The text element inherits the warning's presentation, whatever a tenant `p` rule says. */
const NICOTINE_WARNING_TEXT_LOCK = [
  "display:block",
  "visibility:visible",
  "opacity:1",
  "color:inherit",
  "font-size:inherit",
  "font-weight:inherit",
  "text-transform:inherit",
  "letter-spacing:inherit",
  "line-height:inherit",
].map((d) => `${d}!important`).join(";");

/**
 * Inline CSS for a presentation. `variant` "block" (the product page) never renders smaller
 * than 14px.
 * @param {NicotineWarningPresentation} p
 * @param {"bar" | "block"} variant
 */
export function nicotineWarningStyle(p, variant) {
  const size = variant === "block" ? Math.max(p.fontSizePx, 14) : p.fontSizePx;
  const frame = variant === "bar"
    ? [`border-bottom:2px solid ${p.border}`]
    : [`border:2px solid ${p.border}`, "border-radius:var(--radius-md)", "padding:0.75rem 1rem"];
  return [
    ...frame,
    `background-color:${p.background}`,
    `color:${p.text}`,
    `text-transform:${p.textTransform}`,
    `letter-spacing:${p.textTransform === "uppercase" ? "0.06em" : "normal"}`,
    `font-weight:${p.fontWeight}`,
    `font-size:${size}px`,
    "line-height:1.4",
    ...NICOTINE_WARNING_VISIBILITY_LOCK,
  ].map((d) => `${d}!important`).join(";");
}
