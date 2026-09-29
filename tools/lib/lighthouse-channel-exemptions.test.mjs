import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CHANNEL_EXEMPT_AUDITS,
  blockedOnlyByChannelHeader,
  categoryScore,
  rescoreForChannel,
} from "./lighthouse-channel-exemptions.mjs";

// The SEO half of a REAL Lighthouse report, captured 2026-09-19 from the rendered preview
// homepage of a commerce tenant. Hand-written fixtures are where an assumption about Lighthouse's
// audit shape hides; this one carries the audit's own `details.items[].source` verbatim.
const REPORT = JSON.parse(
  readFileSync(fileURLToPath(new URL("./__fixtures__/lighthouse-preview-seo.json", import.meta.url)), "utf8"),
);

const previewRun = { servedByPreviewChannel: true };

test("the category arithmetic reproduces Lighthouse's own number", () => {
  // If this drifts, every adjusted score below is measuring something other than the composite
  // the gate compares against its floor.
  assert.equal(
    categoryScore(REPORT.categories.seo, REPORT.audits),
    Math.round(REPORT.categories.seo.score * 100),
  );
  assert.equal(categoryScore(REPORT.categories.seo, REPORT.audits), 66);
});

test("the preview channel's own noindex stops costing the tenant its SEO score", () => {
  const { scores, exemptions } = rescoreForChannel(REPORT, previewRun);
  assert.equal(scores.seo, 100, "every other SEO audit on this page passes");
  assert.equal(exemptions.length, 1);
  assert.equal(exemptions[0].id, "is-crawlable");
  assert.equal(exemptions[0].rawScore, 66);
  assert.equal(exemptions[0].adjustedScore, 100);
  assert.match(exemptions[0].reason, /Step 9/, "the exemption must say where it IS asserted");
});

test("a production run gets no relief at all", () => {
  // Off the preview channel a noindex header is the outage this audit exists to catch.
  const { scores, exemptions } = rescoreForChannel(REPORT, { servedByPreviewChannel: false });
  assert.equal(scores.seo, 66);
  assert.deepEqual(exemptions, []);
});

test("a tenant's OWN noindex is not laundered by the exemption", () => {
  // NEGATIVE CONTROL. Lighthouse reports a meta-tag source as a node object, never a string, so
  // the same failing audit with tenant-authored markup behind it must keep counting.
  const tenantNoindex = {
    ...REPORT,
    audits: {
      ...REPORT.audits,
      "is-crawlable": {
        ...REPORT.audits["is-crawlable"],
        details: { type: "table", items: [{ source: { type: "node", snippet: '<meta name="robots" content="noindex">' } }] },
      },
    },
  };
  const { scores, exemptions } = rescoreForChannel(tenantNoindex, previewRun);
  assert.equal(scores.seo, 66, "the tenant really did noindex their page — that is a real defect");
  assert.deepEqual(exemptions, []);
});

test("a tenant noindex reported as a STRING is refused just as firmly", () => {
  // The node-object case above is rejected by the type check alone, so on its own it cannot tell
  // a working source test from a broken one. These two shapes are what actually pin it: a
  // tenant-authored directive that arrives as a string, and one that merely mentions the header
  // name without being it.
  const asString = (source) => ({
    details: { type: "table", items: [{ source }] },
  });
  assert.equal(blockedOnlyByChannelHeader(asString('<meta name="robots" content="noindex">')), false);
  assert.equal(
    blockedOnlyByChannelHeader(asString('<meta name="robots" content="noindex"> <!-- like x-robots-tag -->')),
    false,
    "mentioning the header is not being the header",
  );
  assert.equal(blockedOnlyByChannelHeader(asString("x-robots-tag: noindex, nofollow")), true);
  assert.equal(blockedOnlyByChannelHeader(asString("X-Robots-Tag : noindex")), true, "header casing/spacing varies");
  assert.equal(blockedOnlyByChannelHeader({ details: { items: [] } }), false, "no evidence is not an exemption");
  assert.equal(blockedOnlyByChannelHeader({}), false);
});

test("a page blocked by BOTH the channel and its own markup keeps failing", () => {
  // The mixed case is the one a naive `.some()` would wave through.
  const both = {
    ...REPORT,
    audits: {
      ...REPORT.audits,
      "is-crawlable": {
        ...REPORT.audits["is-crawlable"],
        details: {
          type: "table",
          items: [
            { source: "x-robots-tag: noindex, nofollow" },
            { source: { type: "node", snippet: '<meta name="robots" content="noindex">' } },
          ],
        },
      },
    },
  };
  assert.equal(blockedOnlyByChannelHeader(both.audits["is-crawlable"]), false);
  assert.equal(rescoreForChannel(both, previewRun).scores.seo, 66);
});

test("a passing audit is never exempted, so the score cannot be inflated", () => {
  const crawlable = {
    ...REPORT,
    audits: { ...REPORT.audits, "is-crawlable": { ...REPORT.audits["is-crawlable"], score: 1 } },
  };
  const { exemptions } = rescoreForChannel(crawlable, previewRun);
  assert.deepEqual(exemptions, []);
});

test("an exemption never silently covers a second failing audit", () => {
  // Break something the channel does not explain. The score must stay down and that audit must
  // remain the tenant's to fix.
  const alsoBroken = {
    ...REPORT,
    audits: { ...REPORT.audits, "document-title": { ...REPORT.audits["document-title"], score: 0 } },
  };
  const { scores, exemptions } = rescoreForChannel(alsoBroken, previewRun);
  assert.equal(exemptions.length, 1, "only is-crawlable is exempt");
  assert.ok(scores.seo < 100, `a real SEO failure must still show, got ${scores.seo}`);
});

test("every exemption declares its category and a reason", () => {
  for (const entry of CHANNEL_EXEMPT_AUDITS) {
    assert.ok(entry.id && entry.category && entry.reason, `incomplete exemption: ${entry.id}`);
    assert.ok(entry.reason.length > 40, "a one-word reason is not a reason");
  }
});
