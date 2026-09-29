// @ts-check
// Audits that measure the PREVIEW CHANNEL rather than the migration, and what the category
// score is once they are set aside.
//
// A Step 8 run scores a page served from the preview channel, which is auth-gated and therefore
// deliberately `noindex`. Lighthouse's `is-crawlable` reads that and scores 0. It carries weight
// 4.04 of the SEO category's 12.04 — a third of the category — so a tenant whose every other SEO
// audit passes is reported at 66 against a floor of 90. Measured 2026-09-19 on the rendered
// preview homepage of a commerce tenant: composite 66 with the audit, 100 without it, and the
// audit's own evidence naming `x-robots-tag: noindex, nofollow` as the only blocking directive.
//
// That is the harness scoring itself, the same family as first-party assets 404ing during a run.
// Indexability is asserted at Step 9, against the production host, where it means something.

/**
 * Audits that cannot be compared pre-cutover, with the reason recorded on every exemption so a
 * reader never has to guess why a score moved.
 */
export const CHANNEL_EXEMPT_AUDITS = [
  {
    id: "is-crawlable",
    category: "seo",
    reason:
      "The preview channel is auth-gated and serves X-Robots-Tag: noindex by design, so this" +
      " audit measures the channel, not the migration. Indexability is asserted at Step 9" +
      " against the production host.",
  },
];

/**
 * Did the PLATFORM's channel cause this audit to fail, or did the tenant's own page?
 *
 * Lighthouse reports every blocking directive it found with its source, so this needs no
 * inference: a `x-robots-tag:` source is the header our middleware sets on preview responses,
 * while a `<meta name="robots">` source is content the tenant shipped. Only the former is the
 * harness's doing. A tenant that really did noindex their own page keeps failing — that is a
 * genuine cutover defect and the exemption must never launder it.
 *
 * A source must BE the header directive, not merely mention it: the check is anchored, so a
 * tenant's `<meta name="robots">` fails it whether Lighthouse reports that source as a node
 * object or as a string. Every item must clear it — one tenant-authored directive alongside the
 * header still means the page would not be indexable after cutover.
 *
 * @param {{details?: {items?: Array<{source?: unknown}>}}} audit
 * @returns {boolean}
 */
export function blockedOnlyByChannelHeader(audit) {
  const items = audit?.details?.items;
  if (!Array.isArray(items) || items.length === 0) return false;
  // The type check is redundant against every shape Lighthouse emits today — a node object
  // stringifies to something the anchored pattern rejects anyway — and no test pins it. It stays
  // because `source` is foreign data whose shape Lighthouse owns across versions, and the cost of
  // this check being wrong is a tenant noindex waved through.
  return items.every(
    (item) => typeof item?.source === "string" && /^\s*x-robots-tag\s*:/i.test(item.source),
  );
}

/**
 * Lighthouse's own category arithmetic: the weighted mean of every weighted audit that produced
 * a numeric score. Reproduced here (verified against a real report) so a category can be rescored
 * with an audit set aside, rather than the exemption being reported next to a number that still
 * includes it.
 *
 * @param {{auditRefs?: Array<{id: string, weight?: number}>}} category
 * @param {Record<string, {score?: number|null}>} audits
 * @param {Set<string>} [omit]
 * @returns {number|null} 0-100, or null when nothing weighted remains to score
 */
export function categoryScore(category, audits, omit = new Set()) {
  let weighted = 0;
  let total = 0;
  for (const ref of category?.auditRefs ?? []) {
    if (omit.has(ref.id)) continue;
    const weight = ref.weight ?? 0;
    const score = audits?.[ref.id]?.score;
    if (!weight || typeof score !== "number") continue;
    weighted += score * weight;
    total += weight;
  }
  return total === 0 ? null : Math.round((weighted / total) * 100);
}

/**
 * Rescore a Lighthouse result with the channel's own audits set aside.
 *
 * `servedByPreviewChannel` gates the whole thing: a run against a production host must never get
 * this relief, because there a `noindex` header is the outage the audit exists to catch. It comes
 * from the caller's declared channel, not from anything about the tenant.
 *
 * Returns the scores to report plus one exemption record per audit actually set aside — an audit
 * that passed, or that failed for a reason the channel does not explain, is left alone and keeps
 * counting.
 *
 * @param {{categories?: Record<string, any>, audits?: Record<string, any>}} lhr
 * @param {{servedByPreviewChannel: boolean}} opts
 * @returns {{scores: Record<string, number>, exemptions: Array<{id: string, category: string, reason: string, rawScore: number, adjustedScore: number}>}}
 */
export function rescoreForChannel(lhr, { servedByPreviewChannel }) {
  const categories = lhr?.categories ?? {};
  const audits = lhr?.audits ?? {};
  /** @type {Record<string, number>} */
  const scores = {};
  for (const [key, category] of Object.entries(categories)) {
    scores[key] = Math.round((category?.score ?? 0) * 100);
  }
  if (!servedByPreviewChannel) return { scores, exemptions: [] };

  const exemptions = [];
  const omitByCategory = new Map();
  for (const candidate of CHANNEL_EXEMPT_AUDITS) {
    const audit = audits[candidate.id];
    if (!audit || typeof audit.score !== "number" || audit.score >= 0.9) continue;
    if (candidate.id === "is-crawlable" && !blockedOnlyByChannelHeader(audit)) continue;
    const set = omitByCategory.get(candidate.category) ?? new Set();
    set.add(candidate.id);
    omitByCategory.set(candidate.category, set);
    exemptions.push({ ...candidate, rawScore: scores[candidate.category], adjustedScore: 0 });
  }

  for (const [categoryKey, omit] of omitByCategory) {
    const adjusted = categoryScore(categories[categoryKey], audits, omit);
    if (adjusted === null) continue;
    scores[categoryKey] = adjusted;
    for (const exemption of exemptions) {
      if (exemption.category === categoryKey) exemption.adjustedScore = adjusted;
    }
  }
  return { scores, exemptions };
}
