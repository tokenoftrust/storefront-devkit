// One JSON line per event. Recipient fields are redacted by key, so a ship-to
// address can never reach the console or a log file by accident.
const PII_KEYS = new Set(['name', 'company', 'line1', 'line2', 'city', 'region', 'postalCode', 'country', 'email', 'phone', 'shipTo', 'recipient', 'address']);
const SECRET_KEYS = /secret|token|authorization|password|apikey|api_key/i;

function scrub(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (PII_KEYS.has(k)) out[k] = '[redacted]';
    else if (SECRET_KEYS.test(k)) out[k] = '[secret]';
    else out[k] = scrub(v, depth + 1);
  }
  return out;
}

export function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...scrub(fields) }));
}

export function logError(event, err, fields = {}) {
  log(event, { ...fields, error: { code: err?.code ?? err?.name ?? 'error', status: err?.status, message: err?.code ? undefined : String(err?.message ?? err), requestId: err?.requestId } });
}
