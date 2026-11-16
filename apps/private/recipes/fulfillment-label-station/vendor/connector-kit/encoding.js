// Byte helpers built on Web Crypto, TextEncoder and atob/btoa only, so the kit
// runs unchanged on Node 20+ and on fetch-based edge runtimes.

const encoder = new TextEncoder();

/** UTF-8 bytes of a string. */
export function utf8(text) {
  return encoder.encode(text);
}

/**
 * The exact bytes of a request body. Accepts Uint8Array (and its Node
 * subclass), ArrayBuffer, an ArrayBuffer view, or a string (encoded as UTF-8).
 */
export function toBytes(body) {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === 'string') return utf8(body);
  throw new TypeError('body must be a Uint8Array, ArrayBuffer or string');
}

export function base64Encode(bytes) {
  let binary = '';
  const view = toBytes(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64Decode(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64UrlEncode(input) {
  return base64Encode(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(bytes)));
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compare two byte arrays without an early exit on the first difference. */
export function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
