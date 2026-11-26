// Webhook authenticity primitives, as apps/private/webhooks-and-api.md
// specifies: a Content-Digest carrying sha-256 (RFC 9530) and one RFC 9421
// signature labelled `sig1` covering "@method" "@target-uri" "content-digest",
// with created/keyid/alg parameters and alg `rsa-v1_5-sha256` or `ed25519`.
// Most callers use WebhookReceiver, which applies these in order; they are
// exported for callers that need a single step.
import { base64Encode, constantTimeEqual, sha256, toBytes, utf8 } from './encoding.js';
import { parseDictionary, StructuredFieldError } from './structured-fields.js';

export const SIGNATURE_LABEL = 'sig1';
export const SIGNATURE_ALG = 'rsa-v1_5-sha256';
export const ED25519_SIGNATURE_ALG = 'ed25519';
export const SIGNATURE_ALGORITHMS = Object.freeze([SIGNATURE_ALG, ED25519_SIGNATURE_ALG]);
export const REQUIRED_COMPONENTS = Object.freeze(['@method', '@target-uri', 'content-digest']);
/** Web Crypto parameters for an RSA webhook signing key (JWK alg RS256). */
export const RSA_VERIFY_ALGORITHM = Object.freeze({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' });
/** Web Crypto parameters for an Ed25519 webhook signing key (JWK crv Ed25519 / alg EdDSA). */
export const ED25519_VERIFY_ALGORITHM = Object.freeze({ name: 'Ed25519' });

function fail(code, reason) {
  return { ok: false, code, reason };
}

/** The Content-Digest header value for a body: `sha-256=:<base64>:`. */
export async function contentDigestFor(body) {
  return `sha-256=:${base64Encode(await sha256(toBytes(body)))}:`;
}

/** Recompute the sha-256 Content-Digest over the raw body and reject a mismatch. */
export async function verifyContentDigest(headerValue, body) {
  if (!headerValue) return fail('digest_missing', 'Content-Digest header is required');
  let dict;
  try {
    dict = parseDictionary(headerValue);
  } catch (err) {
    if (err instanceof StructuredFieldError) return fail('digest_malformed', err.message);
    throw err;
  }
  const member = dict.get('sha-256');
  if (!member) return fail('digest_unsupported', 'Content-Digest must carry sha-256');
  if (!member.value?.bytes) return fail('digest_malformed', 'sha-256 is not a byte sequence');
  const expected = await sha256(toBytes(body));
  if (!constantTimeEqual(member.value.bytes, expected)) return fail('digest_mismatch', 'sha-256 does not match the body');
  return { ok: true };
}

function componentValue(name, { method, targetUri, headers }) {
  if (name === '@method') return method.toUpperCase();
  if (name === '@target-uri') return targetUri;
  if (name.startsWith('@')) return undefined;
  const value = headers[name];
  return value === undefined ? undefined : value.trim();
}

/**
 * Verify the `sig1` signature over a delivery.
 *
 * @param {object} input
 * @param {string} input.method The request method.
 * @param {string} input.targetUri The endpoint the app registered, never a value read from the request.
 * @param {Record<string, string>} input.headers Lowercased header names.
 * @param {(keyid: string) => Promise<CryptoKey|null>} input.resolveKey A published webhook signing key, or null.
 * @param {number} [input.now] Milliseconds since the epoch.
 * @param {number} [input.maxAgeSeconds] Oldest acceptable `created`.
 * @param {number} [input.maxClockSkewSeconds] Furthest-future acceptable `created`.
 */
export async function verifyMessageSignature({
  method,
  targetUri,
  headers,
  resolveKey,
  now = Date.now(),
  maxAgeSeconds = 300,
  maxClockSkewSeconds = 60,
}) {
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
  if (!SIGNATURE_ALGORITHMS.includes(alg)) {
    return fail('unsupported_alg', `alg must be ${SIGNATURE_ALGORITHMS.join(' or ')}`);
  }
  const nowSeconds = Math.floor(now / 1000);
  if (nowSeconds - created > maxAgeSeconds) return fail('signature_expired', 'created is too old');
  if (created - nowSeconds > maxClockSkewSeconds) return fail('signature_expired', 'created is in the future');
  if (expires !== undefined && (!Number.isInteger(expires) || expires <= nowSeconds)) {
    return fail('signature_expired', 'expires has passed');
  }

  const key = await resolveKey(keyid);
  if (!key) return fail('unknown_key', 'keyid is not a published webhook signing key');

  const verifyAlgorithm = alg === ED25519_SIGNATURE_ALG ? ED25519_VERIFY_ALGORITHM : RSA_VERIFY_ALGORITHM;
  if (key.algorithm?.name && key.algorithm.name !== verifyAlgorithm.name) {
    return fail('signature_invalid', 'key algorithm does not match signature alg');
  }

  const lines = [];
  for (const name of names) {
    const value = componentValue(name, { method, targetUri, headers });
    if (value === undefined) return fail('signature_malformed', `covered component ${name} is absent`);
    lines.push(`"${name}": ${value}`);
  }
  lines.push(`"@signature-params": ${input.raw}`);
  let verified = false;
  try {
    verified = await crypto.subtle.verify(verifyAlgorithm, key, signature.value.bytes, utf8(lines.join('\n')));
  } catch {
    verified = false;
  }
  if (!verified) return fail('signature_invalid', 'signature verification failed');
  return { ok: true, label: SIGNATURE_LABEL, keyid, created, alg };
}
