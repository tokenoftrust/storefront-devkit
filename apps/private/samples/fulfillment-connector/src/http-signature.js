// Webhook authenticity, exactly as apps/private/webhooks-and-api.md specifies:
// a Content-Digest carrying sha-256 (RFC 9530), and one RFC 9421 signature
// labelled `sig1` covering "@method" "@target-uri" "content-digest", with
// created/keyid/alg parameters and alg `rsa-v1_5-sha256`. Verified over the
// raw body before anything parses it. Signature verification uses Web Crypto,
// so the same code runs on Node and on Cloudflare Workers.
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseDictionary, StructuredFieldError } from './structured-fields.js';

export const SIGNATURE_LABEL = 'sig1';
export const SIGNATURE_ALG = 'rsa-v1_5-sha256';
export const REQUIRED_COMPONENTS = ['@method', '@target-uri', 'content-digest'];
export const MAX_SIGNATURE_AGE_SECONDS = 300;
export const MAX_CLOCK_SKEW_SECONDS = 60;
/** Web Crypto parameters for a webhook signing key (JWK alg RS256). */
export const RSA_VERIFY_ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

function fail(code, reason) {
  return { ok: false, code, reason };
}

export function contentDigestFor(rawBody) {
  return `sha-256=:${createHash('sha256').update(rawBody).digest('base64')}:`;
}

/** Recompute the sha-256 Content-Digest for the raw body and reject a mismatch. */
export function verifyContentDigest(headerValue, rawBody) {
  if (!headerValue) return fail('digest_missing', 'Content-Digest header is required');
  let dict;
  try {
    dict = parseDictionary(headerValue);
  } catch (err) {
    return fail('digest_malformed', err.message);
  }
  const member = dict.get('sha-256');
  if (!member) return fail('digest_unsupported', 'Content-Digest must carry sha-256');
  if (!member.value?.bytes) return fail('digest_malformed', 'sha-256 is not a byte sequence');
  const expected = createHash('sha256').update(rawBody).digest();
  const got = member.value.bytes;
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return fail('digest_mismatch', 'sha-256 does not match the body');
  }
  return { ok: true };
}

function componentValue(name, { method, targetUri, headers }) {
  if (name === '@method') return method.toUpperCase();
  if (name === '@target-uri') return targetUri;
  if (name.startsWith('@')) return undefined;
  const value = headers[name];
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value.join(', ') : String(value)).trim();
}

/**
 * Verify the `sig1` signature. `resolveKey(keyid)` returns `{ key }`, a Web
 * Crypto public key imported with RSA_VERIFY_ALGORITHM, for a key published
 * in `webhook_signing_keys`, or null for an unknown keyid.
 */
export async function verifyMessageSignature({ method, targetUri, headers, resolveKey, now = Date.now() }) {
  const inputHeader = headers['signature-input'];
  const signatureHeader = headers.signature;
  if (!inputHeader || !signatureHeader) return fail('signature_missing', 'Signature-Input and Signature are required');
  let input;
  let signature;
  try {
    input = parseDictionary(inputHeader).get(SIGNATURE_LABEL);
    signature = parseDictionary(signatureHeader).get(SIGNATURE_LABEL);
  } catch (err) {
    if (err instanceof StructuredFieldError) return fail('signature_malformed', err.message);
    throw err;
  }
  if (!input || !signature) return fail('signature_missing', `no ${SIGNATURE_LABEL} signature`);
  if (!input.innerList || !signature.value?.bytes) return fail('signature_malformed', `${SIGNATURE_LABEL} is not a signature`);

  const names = [];
  for (const item of input.value) {
    if (typeof item.value !== 'string') return fail('signature_malformed', 'components must be strings');
    if (item.params.size > 0) return fail('signature_malformed', 'component parameters are not supported');
    names.push(item.value);
  }
  if (new Set(names).size !== names.length) return fail('signature_malformed', 'duplicate component');
  if (!REQUIRED_COMPONENTS.every((c) => names.includes(c))) {
    return fail('signature_coverage', `the signature must cover ${REQUIRED_COMPONENTS.join(', ')}`);
  }

  const created = input.params.get('created');
  const keyid = input.params.get('keyid');
  const alg = input.params.get('alg');
  const expires = input.params.get('expires');
  if (!Number.isInteger(created)) return fail('signature_malformed', 'created is required');
  if (typeof keyid !== 'string' || keyid === '') return fail('signature_malformed', 'keyid is required');
  if (alg !== SIGNATURE_ALG) return fail('unsupported_alg', `alg must be ${SIGNATURE_ALG}`);
  const nowSeconds = Math.floor(now / 1000);
  if (nowSeconds - created > MAX_SIGNATURE_AGE_SECONDS) return fail('signature_expired', 'created is too old');
  if (created - nowSeconds > MAX_CLOCK_SKEW_SECONDS) return fail('signature_expired', 'created is in the future');
  if (expires !== undefined && (!Number.isInteger(expires) || expires <= nowSeconds)) {
    return fail('signature_expired', 'expires has passed');
  }

  const resolved = await resolveKey(keyid);
  if (!resolved) return fail('unknown_key', 'keyid is not a published webhook signing key');

  const lines = [];
  for (const name of names) {
    const value = componentValue(name, { method, targetUri, headers });
    if (value === undefined) return fail('signature_malformed', `covered component ${name} is absent`);
    lines.push(`"${name}": ${value}`);
  }
  lines.push(`"@signature-params": ${input.raw}`);
  let verified = false;
  try {
    verified = await crypto.subtle.verify(RSA_VERIFY_ALGORITHM, resolved.key, signature.value.bytes, Buffer.from(lines.join('\n'), 'utf8'));
  } catch {
    verified = false;
  }
  if (!verified) return fail('signature_invalid', 'signature verification failed');
  return { ok: true, label: SIGNATURE_LABEL, keyid, created, alg };
}
