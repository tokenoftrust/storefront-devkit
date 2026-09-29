import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceRouteIdentity,
  findingId,
  providerOwnsAllEvidenceUrls,
  providerOwnsEvidence,
  sanitizeEvidenceText,
  sanitizeEvidenceUrl,
  serializeEvidence,
} from "./browser-evidence.mjs";

test("sanitizeEvidenceUrl removes credentials, capability query, and fragment", () => {
  const value = sanitizeEvidenceUrl("https://user:secret@example.com/preview/rev/abc/page?__preview=signed-token#state");
  assert.equal(value, "https://example.com/preview/[redacted]/[redacted]/page");
});

test("sanitizeEvidenceUrl redacts opaque path capabilities", () => {
  const jwt = `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
  assert.equal(sanitizeEvidenceUrl(`https://example.com/access/${jwt}/page`), "https://example.com/access/[redacted]/page");
  assert.equal(
    sanitizeEvidenceUrl("/preview/123e4567-e89b-42d3-a456-426614174000/page?token=secret"),
    "/preview/[redacted]/page",
  );
});

test("sanitizeEvidenceText removes relative capabilities, bearer tokens, and email addresses", () => {
  assert.equal(
    sanitizeEvidenceText("open /preview/short-capability/page?token=secret for a@example.com with Bearer abc.def"),
    "open /preview/[redacted]/page for [redacted-email] with Bearer [redacted]",
  );
});

test("route identity never places the raw slug in output labels or artifact names", () => {
  const identity = evidenceRouteIdentity("/preview/short-capability/page?token=secret");
  assert.equal(identity.evidenceSlug, "/preview/[redacted]/page");
  assert.match(identity.safeName, /^route-[a-f0-9]{12}$/);
  assert.equal(identity.safeName.includes("short-capability"), false);
});

test("provider ownership is explicit and symmetric", () => {
  assert.equal(providerOwnsEvidence("https://x/cdn-cgi/challenge", "cloudflare"), true);
  assert.equal(providerOwnsEvidence("https://d123.cloudfront.net/script.js", "cloudfront"), true);
  assert.equal(providerOwnsEvidence("https://d123.cloudfront.net/script.js", "cloudflare"), false);
  assert.equal(providerOwnsEvidence("application warning", null), false);
  assert.equal(providerOwnsAllEvidenceUrls([
    "https://d123.cloudfront.net/script.js",
    "https://d456.cloudfront.net/style.css",
  ], "cloudfront"), true);
  assert.equal(providerOwnsAllEvidenceUrls([
    "https://d123.cloudfront.net/script.js",
    "https://store.example/app.js",
  ], "cloudfront"), false);
  assert.equal(providerOwnsAllEvidenceUrls([], "cloudfront"), false);
});

test("serialized durable artifacts remove capability URLs and page PII", () => {
  const artifact = serializeEvidence({
    url: "https://example.com/preview/short-capability/page?token=secret",
    sample: "Contact owner@example.com or open /access/123e4567-e89b-42d3-a456-426614174000/page",
    artifact: "/home/example/private/output.json",
  });
  assert.equal(artifact.includes("short-capability"), false);
  assert.equal(artifact.includes("token=secret"), false);
  assert.equal(artifact.includes("owner@example.com"), false);
  assert.equal(artifact.includes("/home/example"), false);
  assert.doesNotThrow(() => JSON.parse(artifact));
  const quoted = serializeEvidence({ value: "https://example.com/a\"tail" });
  assert.deepEqual(JSON.parse(quoted), { value: "https://example.com/a\"tail" });
});

test("sanitizeEvidenceText sanitizes embedded URLs and finding ids are stable", () => {
  const text = sanitizeEvidenceText("failed https://example.com/a?token=secret and retry");
  assert.equal(text, "failed https://example.com/a and retry");
  assert.equal(findingId("warning", text), findingId("warning", text));
});
