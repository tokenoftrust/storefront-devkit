// JSON-lines logger. Callers pass only opaque ids, codes and states. As a
// backstop, any field named like a recipient or credential is dropped before
// the line is written, so a careless call cannot leak a ship-to value.
const BLOCKED_FIELDS = new Set([
  'recipient', 'shipto', 'address', 'name', 'company', 'line1', 'line2', 'city', 'region',
  'postalcode', 'country', 'authorization', 'token', 'accesstoken', 'clientsecret', 'secret',
]);

function scrub(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (BLOCKED_FIELDS.has(k.toLowerCase().replace(/[_-]/g, ''))) continue;
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

export function createLogger(sink = (line) => process.stdout.write(`${line}\n`)) {
  const write = (level, msg, fields = {}) =>
    sink(JSON.stringify({ time: new Date().toISOString(), level, msg, ...scrub(fields) }));
  return {
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
