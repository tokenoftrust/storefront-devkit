// Minimal RFC 8941 Structured Field Values parser: just enough to read the
// Dictionary-valued headers RFC 9421 (Signature-Input, Signature) and
// RFC 9530 (Content-Digest) use. Every member keeps its raw text so the
// verifier can rebuild "@signature-params" exactly as the signer serialized it.

export class StructuredFieldError extends Error {}

const KEY_START = /[a-z*]/;
const KEY_CHAR = /[a-z0-9_\-.*]/;
const TOKEN_START = /[A-Za-z*]/;
const TOKEN_CHAR = /[A-Za-z0-9!#$%&'*+\-.^_`|~:/]/;

export function parseDictionary(text) {
  const p = { s: String(text ?? ''), i: 0 };
  const out = new Map();
  skipSP(p);
  if (p.i >= p.s.length) throw new StructuredFieldError('empty dictionary');
  while (p.i < p.s.length) {
    const start = p.i;
    const key = parseKey(p);
    let member;
    if (p.s[p.i] === '=') {
      p.i++;
      member = parseItemOrInnerList(p);
    } else {
      member = { value: true, params: parseParams(p) };
    }
    member.raw = p.s.slice(start + key.length + 1, p.i);
    out.set(key, member);
    skipOWS(p);
    if (p.i >= p.s.length) break;
    if (p.s[p.i] !== ',') throw new StructuredFieldError(`unexpected "${p.s[p.i]}"`);
    p.i++;
    skipOWS(p);
    if (p.i >= p.s.length) throw new StructuredFieldError('trailing comma');
  }
  return out;
}

function parseItemOrInnerList(p) {
  if (p.s[p.i] === '(') return parseInnerList(p);
  const value = parseBareItem(p);
  return { value, params: parseParams(p) };
}

function parseInnerList(p) {
  p.i++;
  const items = [];
  for (;;) {
    skipSP(p);
    if (p.s[p.i] === ')') {
      p.i++;
      return { value: items, innerList: true, params: parseParams(p) };
    }
    if (p.i >= p.s.length) throw new StructuredFieldError('unterminated inner list');
    const value = parseBareItem(p);
    items.push({ value, params: parseParams(p) });
    if (p.s[p.i] !== ' ' && p.s[p.i] !== ')') throw new StructuredFieldError('bad inner list');
  }
}

function parseParams(p) {
  const params = new Map();
  while (p.s[p.i] === ';') {
    p.i++;
    skipSP(p);
    const key = parseKey(p);
    let value = true;
    if (p.s[p.i] === '=') {
      p.i++;
      value = parseBareItem(p);
    }
    params.set(key, value);
  }
  return params;
}

function parseKey(p) {
  if (!KEY_START.test(p.s[p.i] ?? '')) throw new StructuredFieldError('bad key');
  const start = p.i;
  while (p.i < p.s.length && KEY_CHAR.test(p.s[p.i])) p.i++;
  return p.s.slice(start, p.i);
}

function parseBareItem(p) {
  const c = p.s[p.i];
  if (c === '"') return parseString(p);
  if (c === ':') return parseBytes(p);
  if (c === '?') return parseBoolean(p);
  if (c === '-' || /[0-9]/.test(c ?? '')) return parseInteger(p);
  if (TOKEN_START.test(c ?? '')) return parseToken(p);
  throw new StructuredFieldError('bad item');
}

function parseString(p) {
  p.i++;
  let out = '';
  while (p.i < p.s.length) {
    const c = p.s[p.i++];
    if (c === '\\') {
      const n = p.s[p.i++];
      if (n !== '"' && n !== '\\') throw new StructuredFieldError('bad escape');
      out += n;
    } else if (c === '"') {
      return out;
    } else {
      const code = c.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) throw new StructuredFieldError('bad string char');
      out += c;
    }
  }
  throw new StructuredFieldError('unterminated string');
}

function parseBytes(p) {
  p.i++;
  const end = p.s.indexOf(':', p.i);
  if (end < 0) throw new StructuredFieldError('unterminated byte sequence');
  const b64 = p.s.slice(p.i, end);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new StructuredFieldError('bad base64');
  p.i = end + 1;
  return { bytes: Buffer.from(b64, 'base64') };
}

function parseBoolean(p) {
  const v = p.s[p.i + 1];
  if (v !== '0' && v !== '1') throw new StructuredFieldError('bad boolean');
  p.i += 2;
  return v === '1';
}

function parseInteger(p) {
  const m = /^-?[0-9]{1,15}/.exec(p.s.slice(p.i));
  if (!m) throw new StructuredFieldError('bad integer');
  if (p.s[p.i + m[0].length] === '.') throw new StructuredFieldError('decimals are not accepted here');
  p.i += m[0].length;
  return Number(m[0]);
}

function parseToken(p) {
  const start = p.i;
  p.i++;
  while (p.i < p.s.length && TOKEN_CHAR.test(p.s[p.i])) p.i++;
  return { token: p.s.slice(start, p.i) };
}

function skipSP(p) {
  while (p.s[p.i] === ' ') p.i++;
}

function skipOWS(p) {
  while (p.s[p.i] === ' ' || p.s[p.i] === '\t') p.i++;
}
