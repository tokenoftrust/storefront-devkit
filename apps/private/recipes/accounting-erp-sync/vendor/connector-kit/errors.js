// The kit's error model. Every failure carries a stable machine `code` to branch
// on. Remote prose (`message`, `error_description`) is never copied into an error.

const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_FIELD = /^[A-Za-z0-9_.\[\]:-]{1,128}$/;

/** A remote code if it is shaped like one, otherwise `unexpected`. */
export function safeCode(value) {
  return typeof value === 'string' && SAFE_CODE.exec(value)?.[0] === value ? value : 'unexpected';
}

/** A remote correlation id if it is shaped like one, otherwise undefined. */
export function safeRequestId(value) {
  return typeof value === 'string' && SAFE_REQUEST_ID.exec(value)?.[0] === value ? value : undefined;
}

export class ConnectorError extends Error {
  /**
   * @param {object} fields
   * @param {'api'|'auth'|'transport'} fields.kind
   * @param {string} fields.code Stable machine code.
   * @param {number} [fields.status] HTTP status, when a response was received.
   * @param {string} [fields.requestId] The `tot-request-id` of the response.
   * @param {boolean} [fields.retryable] Whether retrying the same request can succeed.
   * @param {number} [fields.retryAfterMs] The server's `Retry-After`, in milliseconds.
   * @param {string[]} [fields.holds] Hold codes a refusal listed.
   * @param {string} [fields.field] Field named by a refusal.
   * @param {number} [fields.index] Index named by an inventory batch refusal.
   * @param {string[]} [fields.reasons] Machine-readable conflict reasons.
   * @param {string} [fields.idempotencyKey] The key a failed write was sent under; resend under it.
   * @param {unknown} [fields.cause]
   */
  constructor({ kind, code, status, requestId, retryable = false, retryAfterMs, holds, field, index, reasons, idempotencyKey, cause }) {
    super(status === undefined ? `${kind}:${code}` : `${kind}:${code} (${status})`, cause === undefined ? undefined : { cause });
    this.name = 'ConnectorError';
    this.kind = kind;
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.holds = holds;
    if (typeof field === 'string' && SAFE_FIELD.exec(field)?.[0] === field) this.field = field;
    if (Number.isSafeInteger(index) && index >= 0) this.index = index;
    if (Array.isArray(reasons)) {
      const valid = reasons.filter((reason) => safeCode(reason) === reason);
      if (valid.length > 0 || reasons.length === 0) this.reasons = valid;
    }
    this.idempotencyKey = idempotencyKey;
  }

  /** The loggable fields. Never includes a cause, a body or a credential. */
  toJSON() {
    const out = { kind: this.kind, code: this.code };
    for (const key of ['status', 'requestId', 'retryable', 'retryAfterMs', 'holds', 'field', 'index', 'reasons', 'idempotencyKey']) {
      if (this[key] !== undefined) out[key] = this[key];
    }
    return out;
  }
}

/** A non-2xx answer from `/api/apps/v1`. `code` is the body's `code`. */
export class ApiError extends ConnectorError {
  constructor(fields) {
    super({ ...fields, kind: 'api' });
    this.name = 'ApiError';
  }
}

/** The token endpoint refused, or answered something that is not a token. `code` is the OAuth `error`. */
export class AuthError extends ConnectorError {
  constructor(fields) {
    super({ ...fields, kind: 'auth' });
    this.name = 'AuthError';
  }
}

/** No usable HTTP response: network failure, abort, or a destination the kit refuses. */
export class TransportError extends ConnectorError {
  constructor(fields) {
    super({ ...fields, kind: 'transport' });
    this.name = 'TransportError';
  }
}
