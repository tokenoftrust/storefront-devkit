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

/** An error whose code is fixed by this sample, so the code is safe to log. */
export class ConnectorError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ConnectorError';
    this.code = code;
  }
}

/**
 * Describe a caught error without its message. A message carries whatever the
 * thrower put in it, and the label provider is handed the ship-to, so only the
 * error class and a code this sample assigned are ever logged.
 */
export function errorFields(err) {
  const errorClass = typeof err?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(err.name) ? err.name : 'Error';
  return err instanceof ConnectorError ? { errorClass, errorCode: err.code } : { errorClass };
}

/** A logger that adds `fields` to every line; callers cannot override them. */
export function withFields(logger, fields) {
  return {
    info: (msg, extra) => logger.info(msg, { ...extra, ...fields }),
    warn: (msg, extra) => logger.warn(msg, { ...extra, ...fields }),
    error: (msg, extra) => logger.error(msg, { ...extra, ...fields }),
  };
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
