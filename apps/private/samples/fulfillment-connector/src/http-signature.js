// Webhook authenticity: RFC 9530 Content-Digest and RFC 9421 HTTP Message
// Signatures, verified over the raw body before anything parses it.
import { createHash, timingSafeEqual, verify as cryptoVerify, constants } from 'node:crypto';
import { parseDictionary, StructuredFieldError } from './structured-fields.js';

// The receiver decides what a signature must cover. These three bind the
// signature to this endpoint, this method and (through the digest) this body.
export const REQUIRED_COMPONENTS = ['@method', '@target-uri', 'content-digest'];
export const MAX_SIGNATURE_AGE_SECONDS = 300;
export const MAX_CLOCK_SKEW_SECONDS = 60;

const DIGESTS = { 'sha-256': 'sha256', 'sha-512': 'sha512' };

export const SIGNATURE_ALGORITHMS = {
  'rsa-v1_5-sha256': {
    keyTypes: ['rsa'],
    verify: (key, data, sig) =>
      cryptoVerify('sha256', data, { key, padding: constants.RSA_PKCS1_PADDING }, sig),
  },
  'rsa-pss-sha512': {
    keyTypes: ['rsa', 'rsa-pss'],
    verify: (key, data, sig) =>
      cryptoVerify('sha512', data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 }, sig),
  },
  'ecdsa-p256-sha256': {
    keyTypes: ['ec'],
    curve: 'prime256v1',
    verify: (key, data, sig) => cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig),
  },
  'ecdsa-p384-sha384': {
    keyTypes: ['ec'],
    curve: 'secp384r1',
    verify: (key, data, sig) => cryptoVerify('sha384', data, { key, dsaEncoding: 'ieee-p1363' }, sig),
  },
  ed25519: {
    keyTypes: ['ed25519'],
    verify: (key, data, sig) => cryptoVerify(null, data, key, sig),
  },
};

function fail(code, reason) {
  return { ok: false, code, reason };
}

export function contentDigestFor(rawBody, algorithm = 'sha-256') {
  const digest = createHash(DIGESTS[algorithm]).update(rawBody).digest('base64');
  return `${algorithm}=:${digest}:`;
}

/** Step 3: recompute Content-Digest for the raw body and reject a mismatch. */
export function verifyContentDigest(headerValue, rawBody) {
  if (!headerValue) return fail('digest_missing', 'Content-Digest header is required');
  let dict;
  try {
    dict = parseDictionary(headerValue);
  } catch (err) {
    return fail('digest_malformed', err.message);
  }
  let checked = 0;
  for (const [alg, member] of dict) {
    const hash = DIGESTS[alg];
    if (!hash) continue;
    if (!member.value?.bytes) return fail('digest_malformed', `${alg} is not a byte sequence`);
    const expected = createHash(hash).update(rawBody).digest();
    const got = member.value.bytes;
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return fail('digest_mismatch', `${alg} does not match the body`);
    }
    checked++;
  }
  if (checked === 0) return fail('digest_unsupported', 'no supported digest algorithm');
  return { ok: true };
}

function componentValue(name, { method, targetUri, headers }) {
  const url = new URL(targetUri);
  switch (name) {
    case '@method':
      return method.toUpperCase();
    case '@target-uri':
      return targetUri;
    case '@authority':
      return url.host.toLowerCase();
    case '@scheme':
      return url.protocol.slice(0, -1).toLowerCase();
    case '@path':
      return url.pathname || '/';
    case '@query':
      return url.search || '?';
    case '@request-target':
      return `${url.pathname || '/'}${url.search}`;
    default: {
      if (name.startsWith('@')) return undefined;
      const value = headers[name];
      if (value === undefined) return undefined;
      return (Array.isArray(value) ? value.join(', ') : String(value)).trim();
    }
  }
}

/**
 * Step 4: verify RFC 9421 Signature-Input + Signature against the declared
 * key and covered components. `resolveKey(keyid)` returns
 * `{ key: KeyObject, alg?: string }` or null for an unknown key.
 */
export async function verifyMessageSignature({ method, targetUri, headers, resolveKey, now = Date.now() }) {
  const inputHeader = headers['signature-input'];
  const signatureHeader = headers.signature;
  if (!inputHeader || !signatureHeader) return fail('signature_missing', 'Signature-Input and Signature are required');
  let inputs;
  let signatures;
  try {
    inputs = parseDictionary(inputHeader);
    signatures = parseDictionary(signatureHeader);
  } catch (err) {
    if (err instanceof StructuredFieldError) return fail('signature_malformed', err.message);
    throw err;
  }
  let lastFailure = fail('signature_coverage', `a signature must cover ${REQUIRED_COMPONENTS.join(', ')}`);
  for (const [label, input] of inputs) {
    const signature = signatures.get(label);
    if (!input.innerList || !signature?.value?.bytes) {
      lastFailure = fail('signature_malformed', `label ${label} is not a signature`);
      continue;
    }
    const result = await verifyOne({ label, input, signature: signature.value.bytes, method, targetUri, headers, resolveKey, now });
    if (result.ok) return result;
    lastFailure = result;
  }
  return lastFailure;
}

async function verifyOne({ label, input, signature, method, targetUri, headers, resolveKey, now }) {
  const names = [];
  for (const item of input.value) {
    if (typeof item.value !== 'string') return fail('signature_malformed', 'components must be strings');
    if (item.params.size > 0) return fail('signature_malformed', 'component parameters are not supported');
    names.push(item.value);
  }
  if (new Set(names).size !== names.length) return fail('signature_malformed', 'duplicate component');
  if (!REQUIRED_COMPONENTS.every((c) => names.includes(c))) {
    return fail('signature_coverage', `a signature must cover ${REQUIRED_COMPONENTS.join(', ')}`);
  }
  const params = input.params;
  const created = params.get('created');
  const expires = params.get('expires');
  const keyid = params.get('keyid');
  const declaredAlg = params.get('alg');
  if (!Number.isInteger(created)) return fail('signature_malformed', 'created is required');
  if (typeof keyid !== 'string' || keyid === '') return fail('signature_malformed', 'keyid is required');
  if (declaredAlg !== undefined && typeof declaredAlg !== 'string') return fail('signature_malformed', 'alg must be a string');
  const nowSeconds = Math.floor(now / 1000);
  if (nowSeconds - created > MAX_SIGNATURE_AGE_SECONDS) return fail('signature_expired', 'created is too old');
  if (created - nowSeconds > MAX_CLOCK_SKEW_SECONDS) return fail('signature_expired', 'created is in the future');
  if (expires !== undefined && (!Number.isInteger(expires) || expires <= nowSeconds)) {
    return fail('signature_expired', 'expires has passed');
  }

  const resolved = await resolveKey(keyid);
  if (!resolved) return fail('unknown_key', 'keyid is not a published signing key');
  if (declaredAlg && resolved.alg && declaredAlg !== resolved.alg) return fail('alg_mismatch', 'alg differs from the key');
  const algName = declaredAlg || resolved.alg;
  const algorithm = SIGNATURE_ALGORITHMS[algName];
  if (!algorithm) return fail('unsupported_alg', 'unsupported signature algorithm');
  const { key } = resolved;
  if (!algorithm.keyTypes.includes(key.asymmetricKeyType)) return fail('alg_mismatch', 'key type does not fit alg');
  if (algorithm.curve && key.asymmetricKeyDetails?.namedCurve !== algorithm.curve) {
    return fail('alg_mismatch', 'key curve does not fit alg');
  }

  const lines = [];
  for (const name of names) {
    const value = componentValue(name, { method, targetUri, headers });
    if (value === undefined) return fail('signature_malformed', `covered component ${name} is absent`);
    lines.push(`"${name}": ${value}`);
  }
  lines.push(`"@signature-params": ${input.raw}`);
  const base = Buffer.from(lines.join('\n'), 'utf8');
  let verified = false;
  try {
    verified = algorithm.verify(key, base, signature);
  } catch {
    verified = false;
  }
  if (!verified) return fail('signature_invalid', 'signature verification failed');
  return { ok: true, label, keyid, created, alg: algName };
}
