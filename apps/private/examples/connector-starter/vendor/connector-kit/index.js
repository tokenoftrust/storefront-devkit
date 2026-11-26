// connector-kit: the reviewed client half of the Storefront Private Apps
// contract (apps/private/contract). Vendor this directory; do not edit it in
// place. Zero dependencies, ESM, Web Crypto and fetch only.

export const KIT_VERSION = '1.1.0';
export const CONTRACT_VERSION = 'private-apps@1.4';

export { ConnectorAuthClient, CLIENT_ASSERTION_TYPE, CLIENT_AUTH_METHODS, MAX_ASSERTION_LIFETIME_SECONDS } from './auth.js';
export { WebhookReceiver, MemorySeenEventStore, WEBHOOK_REFUSALS, EVENT_TYPE_PREFIX, DEFAULT_MAX_BODY_BYTES, normalizeHeaders } from './webhook.js';
export { ApiClient, newIdempotencyKey, deriveIdempotencyKey } from './api.js';
export { AuthorizationMetadata, StaticSigningKeys, importWebhookSigningKey, normalizeOrigin, METADATA_PATH, TOKEN_PATH, API_PREFIX } from './metadata.js';
export { ConnectorError, ApiError, AuthError, TransportError, safeCode } from './errors.js';
export { DEFAULT_RETRY_POLICY, RETRYABLE_STATUS, parseRetryAfter } from './retry.js';
export { createRateLimiter } from './rate-limit.js';
export {
  contentDigestFor,
  verifyContentDigest,
  verifyMessageSignature,
  SIGNATURE_LABEL,
  SIGNATURE_ALG,
  ED25519_SIGNATURE_ALG,
  SIGNATURE_ALGORITHMS,
  REQUIRED_COMPONENTS,
} from './http-signature.js';
