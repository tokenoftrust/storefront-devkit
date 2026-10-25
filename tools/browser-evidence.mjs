import { createHash } from "node:crypto";

const SENSITIVE_ROUTE_KEY = /^(?:access|auth|callback|capability|invite|preview|rev|session|signature|token|verify)$/i;
const JWT_SEGMENT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID_SEGMENT = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OPAQUE_SEGMENT = /^(?:[a-f0-9]{16,}|[A-Za-z0-9_-]{32,})$/i;

function sanitizedPathname(pathname) {
  let redactNext = false;
  return pathname
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return "[redacted]";
      }
      const redact = redactNext || JWT_SEGMENT.test(decoded) || UUID_SEGMENT.test(decoded) || OPAQUE_SEGMENT.test(decoded);
      redactNext = SENSITIVE_ROUTE_KEY.test(decoded);
      return redact ? "[redacted]" : segment;
    })
    .join("/");
}

export function sanitizeEvidenceUrl(value) {
  try {
    const raw = String(value);
    const relative = raw.startsWith("/");
    const parsed = new URL(raw, "https://evidence.invalid");
    if (!relative && !/^https?:$/i.test(parsed.protocol)) return "[invalid-url]";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = sanitizedPathname(parsed.pathname);
    return relative ? parsed.pathname : parsed.toString();
  } catch {
    return "[invalid-url]";
  }
}

function sanitizeMatchedUrl(value) {
  const suffix = value.match(/[),.;!?]+$/)?.[0] ?? "";
  const body = suffix ? value.slice(0, -suffix.length) : value;
  return `${sanitizeEvidenceUrl(body)}${suffix}`;
}

export function sanitizeEvidenceText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, sanitizeMatchedUrl)
    .replace(/(^|[\s("'=])((?:\/[A-Za-z0-9._~!$&*+,;=:@%\[\]-]+)+(?:\?[^\s"'<>]*)?)/g, (_match, lead, url) => `${lead}${sanitizeMatchedUrl(url)}`)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/\b(?:token|secret|signature|sig|api[_-]?key)=([^\s&"'<>]+)/gi, (match) => `${match.split("=")[0]}=[redacted]`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\/(?:Users|home)\/[^/\s"'<>]+/g, (path) => `${path.split("/").slice(0, 2).join("/")}/[redacted]`);
}

export function sanitizeEvidenceValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return sanitizeEvidenceText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidenceValue(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const sanitized = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeEvidenceValue(item, seen)]),
    );
    seen.delete(value);
    return sanitized;
  }
  return value;
}

export function serializeEvidence(value) {
  return JSON.stringify(sanitizeEvidenceValue(value), null, 2);
}

export function findingId(prefix, value) {
  return `${prefix}-${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
}

export function evidenceRouteIdentity(slug) {
  const raw = String(slug).startsWith("/") ? String(slug) : `/${slug}`;
  return {
    evidenceSlug: sanitizeEvidenceUrl(raw),
    safeName: findingId("route", raw),
  };
}

/** Serving providers a page can be validated against; `local` is the dev loop on this machine. */
export const PROVIDERS = ["cloudflare", "cloudfront", "local"];

/** True when the page base is served on this machine — the only place `--provider local` means anything. */
export function isLoopbackBase(base) {
  try {
    const host = new URL(base).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * A CSP violation the local dev server caused, not the page: Vite serves CSS as un-nonced inline
 * `<style>` it injects at runtime, and the dev toolbar styles itself the same way. A built page
 * links that CSS as external files, so none of it exists where visitors are. Only meaningful under
 * `--provider local`; the violation's own source (`sourceFile`, else `blockedURI`) decides.
 */
export function devServerOwnsViolation(violation) {
  const source = String(violation?.sourceFile || violation?.blockedURI || "");
  let path = source;
  try {
    path = new URL(source).pathname;
  } catch {
    // A bare path, or nothing: judged as given.
  }
  return /^\/(?:@vite\/|@id\/|@fs\/|node_modules\/\.vite\/|node_modules\/astro\/)/.test(path);
}

/**
 * Which gates a route's verdict requires. A preview-only style-guide route is gated on
 * accessibility and mobile only (agency-kit/playbooks/style-concept.md, Step 2.75): it is a review
 * surface full of `href="#"` samples and several sample headers, never served to visitors, so
 * parity, console, UX, CSP and performance are reported there but advisory.
 */
export function gateRequiredOnRoute(gate, { previewOnly }) {
  if (!previewOnly) return gate !== "ecommerceStyleGuide";
  return gate === "a11y" || gate === "mobile";
}

export function providerOwnsEvidence(value, provider) {
  const text = String(value);
  if (provider === "cloudflare") return /\/cdn-cgi\/|\bcloudflare\b/i.test(text);
  if (provider === "cloudfront") return /\.cloudfront\.net\b|\bcloudfront\b|\bamazon cloudfront\b|\bx-amz-cf-/i.test(text);
  return false;
}

export function providerOwnsAllEvidenceUrls(values, provider) {
  return Array.isArray(values) && values.length > 0 && values.every((value) => providerOwnsEvidence(value, provider));
}
