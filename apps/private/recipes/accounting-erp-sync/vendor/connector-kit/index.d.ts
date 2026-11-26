export const KIT_VERSION: string;
export const CONTRACT_VERSION: 'private-apps@1.4';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy>;
export const RETRYABLE_STATUS: Set<number>;
export function parseRetryAfter(value: string | null | undefined, nowMs?: number): number | undefined;

export const CLIENT_ASSERTION_TYPE: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const CLIENT_AUTH_METHODS: readonly ['client_secret_basic', 'client_secret_post', 'private_key_jwt'];
export const MAX_ASSERTION_LIFETIME_SECONDS: 300;

type ClientAuthMethod = typeof CLIENT_AUTH_METHODS[number];
type Jwk = JsonWebKey & { kid?: string };

interface StoreOptions {
  origin: string;
  /** Store slug on a shared host. Omit when the slug is already in origin. */
  tenant?: string;
}

export type ConnectorAuthClientOptions = StoreOptions & {
  clientId: string;
  keyId?: string;
  refreshSkewSeconds?: number;
  assertionLifetimeSeconds?: number;
  retry?: Partial<RetryPolicy>;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  randomId?: () => string;
} & (
  | { method?: 'client_secret_basic' | 'client_secret_post'; clientSecret: string; privateKey?: never }
  | { method?: 'private_key_jwt'; clientSecret?: never; privateKey: CryptoKey | Jwk }
);

export interface AccessToken {
  accessToken: string;
  issuedAt: number;
  expiresAt: number;
  scope: string[];
}

export class ConnectorAuthClient {
  constructor(options: ConnectorAuthClientOptions);
  origin: string;
  tokenEndpoint: string;
  clientId: string;
  method: ClientAuthMethod;
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  getToken(options?: { forceRefresh?: boolean }): Promise<AccessToken>;
  invalidate(accessToken?: string): void;
  createClientAssertion(): Promise<string>;
}

export type ConnectorErrorKind = 'api' | 'auth' | 'transport';

export interface ConnectorErrorFields {
  code: string;
  status?: number;
  requestId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  holds?: string[];
  field?: string;
  index?: number;
  reasons?: string[];
  idempotencyKey?: string;
  cause?: unknown;
}

export class ConnectorError extends Error implements ConnectorErrorFields {
  constructor(fields: ConnectorErrorFields & { kind: ConnectorErrorKind });
  kind: ConnectorErrorKind;
  code: string;
  status?: number;
  requestId?: string;
  retryable: boolean;
  retryAfterMs?: number;
  holds?: string[];
  field?: string;
  index?: number;
  reasons?: string[];
  idempotencyKey?: string;
  cause?: unknown;
  toJSON(): Omit<ConnectorErrorFields, 'cause'> & { kind: ConnectorErrorKind; retryable: boolean };
}

export class ApiError extends ConnectorError {
  constructor(fields: ConnectorErrorFields);
  kind: 'api';
}

export class AuthError extends ConnectorError {
  constructor(fields: ConnectorErrorFields);
  kind: 'auth';
}

export class TransportError extends ConnectorError {
  constructor(fields: ConnectorErrorFields);
  kind: 'transport';
}

export function safeCode(value: unknown): string;

export interface ApiClientOptions extends StoreOptions {
  auth: { getAccessToken(): Promise<string>; invalidate?(token: string): void };
  retry?: Partial<RetryPolicy>;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: ConnectorError }) => void;
}

export interface ApiReadOptions {
  query?: Record<string, unknown>;
  traceparent?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ApiWriteOptions extends ApiReadOptions {
  idempotencyKey?: string;
}

export interface ApiRequest extends ApiWriteOptions {
  method: string;
  path: string;
  body?: unknown;
}

export interface ApiResponse<Body = unknown> {
  status: number;
  body: Body;
  headers: Headers;
  requestId?: string;
  idempotencyKey?: string;
}

export interface PaginationOptions {
  query?: Record<string, unknown>;
  limit?: number;
  updatedSince?: string | Date;
  cursor?: string;
  itemsKey?: string;
  maxPages?: number;
  signal?: AbortSignal;
}

export interface ApiPage<Item = unknown, Body = unknown> {
  items: Item[];
  nextCursor?: string;
  truncated: boolean;
  body: Body;
  requestId?: string;
}

export class ApiClient {
  constructor(options: ApiClientOptions);
  origin: string;
  url(path: string, query?: Record<string, unknown>): string;
  request<Body = unknown>(request: ApiRequest): Promise<ApiResponse<Body>>;
  get<Body = unknown>(path: string, options?: ApiReadOptions): Promise<ApiResponse<Body>>;
  delete<Body = unknown>(path: string, options?: ApiWriteOptions): Promise<ApiResponse<Body>>;
  post<Body = unknown>(path: string, body: unknown, options?: ApiWriteOptions): Promise<ApiResponse<Body>>;
  put<Body = unknown>(path: string, body: unknown, options?: ApiWriteOptions): Promise<ApiResponse<Body>>;
  patch<Body = unknown>(path: string, body: unknown, options?: ApiWriteOptions): Promise<ApiResponse<Body>>;
  pages<Item = unknown, Body = unknown>(path: string, options?: PaginationOptions): AsyncGenerator<ApiPage<Item, Body>, void, unknown>;
  items<Item = unknown>(path: string, options?: PaginationOptions): AsyncGenerator<Item, void, unknown>;
  collect<Item = unknown>(path: string, options?: PaginationOptions): Promise<{ items: Item[]; truncated: boolean; pages: number }>;
}

export function newIdempotencyKey(prefix?: string): string;
export function deriveIdempotencyKey(prefix: string, ...parts: unknown[]): Promise<string>;

export const METADATA_PATH: '/.well-known/tot-app-authorization-metadata';
export const TOKEN_PATH: '/api/apps/oauth/token';
export const API_PREFIX: '/api/apps/v1';

export interface SigningKeys {
  resolveSigningKey(keyid: string): Promise<CryptoKey | null>;
}

export interface AuthorizationMetadataOptions {
  /** Bare storefront origin, including for stores on a shared host. */
  origin: string;
  fetch?: typeof fetch;
  now?: () => number;
  minRefreshIntervalMs?: number;
}

export interface AuthorizationMetadataDocument {
  /** The unvalidated endpoint from the metadata document. */
  tokenEndpoint: unknown;
  authMethods: unknown[];
  keys: Map<string, CryptoKey>;
  expiresAt: number;
}

export class AuthorizationMetadata implements SigningKeys {
  constructor(options: AuthorizationMetadataOptions);
  origin: string;
  url: string;
  load(force?: boolean): Promise<AuthorizationMetadataDocument>;
  tokenEndpoint(): Promise<string>;
  resolveSigningKey(keyid: string): Promise<CryptoKey | null>;
}

export class StaticSigningKeys implements SigningKeys {
  constructor(jwks: { keys: readonly Jwk[] });
  resolveSigningKey(keyid: string): Promise<CryptoKey | null>;
}

export function importWebhookSigningKey(jwk: unknown): Promise<{ kid: string; key: CryptoKey } | null>;
export function normalizeOrigin(origin: string): string;

export const EVENT_TYPE_PREFIX: 'com.tokenoftrust.storefront.';
export const DEFAULT_MAX_BODY_BYTES: number;
export const WEBHOOK_REFUSALS: Readonly<{
  method_not_allowed: 405;
  body_too_large: 413;
  digest_missing: 400;
  digest_malformed: 400;
  digest_unsupported: 400;
  digest_mismatch: 400;
  signature_missing: 401;
  signature_malformed: 401;
  signature_coverage: 401;
  unsupported_alg: 401;
  signature_expired: 401;
  unknown_key: 401;
  signature_invalid: 401;
  body_not_json: 400;
  envelope_invalid: 400;
  tenant_mismatch: 403;
  replayed_event: 200;
}>;

type WebhookRefusalCode = keyof typeof WEBHOOK_REFUSALS;
type WebhookRefusal = {
  [Code in WebhookRefusalCode]: { ok: false; status: typeof WEBHOOK_REFUSALS[Code]; code: Code };
}[WebhookRefusalCode];
type RawBody = ArrayBuffer | ArrayBufferView | string;
type HeaderValue = string | readonly string[] | null | undefined;
type WebhookHeaders = Headers | Record<string, HeaderValue> | readonly (readonly [string, HeaderValue])[];

export interface WebhookEvent<Data extends object = Record<string, unknown>> {
  specversion: '1.0';
  id: string;
  source: string;
  type: `${typeof EVENT_TYPE_PREFIX}${string}`;
  time: string;
  datacontenttype: 'application/json';
  tenantid: string;
  appinstallid: string;
  dataschemaversion: '1';
  retrycount?: number;
  totrequestid?: string;
  traceparent?: string;
  data: Data;
}

export interface SeenEventStore {
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

export class MemorySeenEventStore implements SeenEventStore {
  constructor(options?: { maxEntries?: number; now?: () => number });
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

export interface WebhookReceiverOptions {
  endpoint: string;
  keys: SigningKeys;
  tenant?: string;
  appInstallId?: string;
  seenEvents?: SeenEventStore;
  maxAgeSeconds?: number;
  maxClockSkewSeconds?: number;
  replayTtlSeconds?: number;
  maxBodyBytes?: number;
  now?: () => number;
}

export interface WebhookDelivery {
  method: string;
  headers: WebhookHeaders;
  body: RawBody;
}

export interface WebhookContext {
  keyid: string;
  created: number;
}

type WebhookHandler = (event: WebhookEvent, context: WebhookContext) => unknown;

export type WebhookVerification = (WebhookContext & { ok: true; event: WebhookEvent; replayKey: string }) | WebhookRefusal;
export type WebhookReceiveResult =
  | { status: 202; body: { accepted: true; duplicate?: never }; error?: never }
  | { status: 200; body: { accepted: true; duplicate: true }; error?: never }
  | { status: 400 | 401 | 403 | 405 | 413; body: { accepted: false; code: Exclude<WebhookRefusalCode, 'replayed_event'> }; error?: never }
  | { status: 500; body: { accepted: false; code: 'handler_failed' }; error: unknown };

export class WebhookReceiver {
  constructor(options: WebhookReceiverOptions);
  endpoint: string;
  tenant?: string;
  appInstallId?: string;
  verify(delivery: WebhookDelivery): Promise<WebhookVerification>;
  release(replayKey: string): Promise<void>;
  receive(delivery: WebhookDelivery, onEvent: WebhookHandler): Promise<WebhookReceiveResult>;
  handleRequest(request: Request, onEvent: WebhookHandler): Promise<Response>;
}

export function normalizeHeaders(headers?: WebhookHeaders | null): Record<string, string>;

export const SIGNATURE_LABEL: 'sig1';
export const SIGNATURE_ALG: 'rsa-v1_5-sha256';
export const ED25519_SIGNATURE_ALG: 'ed25519';
export const SIGNATURE_ALGORITHMS: readonly ['rsa-v1_5-sha256', 'ed25519'];
export const REQUIRED_COMPONENTS: readonly ['@method', '@target-uri', 'content-digest'];

type VerificationFailure<Code> = { ok: false; code: Code; reason: string };
type SignatureRefusalCode = Extract<WebhookRefusalCode, `signature_${string}` | 'unsupported_alg' | 'unknown_key'>;
type WebhookSignatureAlgorithm = typeof SIGNATURE_ALGORITHMS[number];

export function contentDigestFor(body: RawBody): Promise<string>;
export function verifyContentDigest(
  headerValue: string | null | undefined,
  body: RawBody,
): Promise<{ ok: true } | VerificationFailure<Extract<WebhookRefusalCode, `digest_${string}`>>>;
export function verifyMessageSignature(input: {
  method: string;
  targetUri: string;
  headers: Record<string, string>;
  resolveKey: (keyid: string) => Promise<CryptoKey | null>;
  now?: number;
  maxAgeSeconds?: number;
  maxClockSkewSeconds?: number;
}): Promise<
  | (WebhookContext & { ok: true; label: typeof SIGNATURE_LABEL; alg: WebhookSignatureAlgorithm })
  | VerificationFailure<SignatureRefusalCode>
>;

export interface RateLimiterOptions {
  requestsPerMinute: number;
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RateLimiterWrapOptions {
  /** Return a delay in seconds, or undefined to use the standard headers. */
  parseResetSeconds?: (response: Response) => number | undefined;
}

export interface RateLimiter {
  acquire(): Promise<void>;
  /** Pace the fetch and return its response without retrying. */
  wrap<Args extends unknown[], Result extends Response>(
    fetchFn: (...args: Args) => Promise<Result> | Result,
    options?: RateLimiterWrapOptions,
  ): (...args: Args) => Promise<Result>;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter;

// Payload shapes from apps/private/contract/openapi.yaml and asyncapi.yaml.

export type CarrierCode =
  | 'UPS' | 'FEDEX' | 'USPS' | 'DHL' | 'ONTRAC' | 'LSO'
  | 'BETTER_TRUCKS' | 'GLS_US' | 'SPEE_DEE' | 'STAT_OVERNIGHT';
type FulfillmentStage = 'preview' | 'publication';
type AdultSignature = 'accepted' | 'refused' | 'absent';

export interface AssignmentLine {
  sku: string;
  quantity: number;
}

export interface AssignmentReadLine extends AssignmentLine {
  lineId: string;
  locationId: string;
  shipped: number;
  cancelled: number;
  remaining: number;
}

/** One reconciliation row from GET /fulfillment/assignments. */
export interface Assignment {
  assignmentId: string;
  orderId: string;
  stage: FulfillmentStage;
  eventVersion: number;
  assignedAt: string;
  purchaseId: string;
  lineItems: AssignmentLine[];
  locationId: string;
  allowedCarriers: CarrierCode[];
  adultSignatureRequired: boolean;
  lines: AssignmentReadLine[];
}

export interface FulfillmentAssignmentList {
  assignments: Assignment[];
  nextCursor?: string;
}

/** The data payload for fulfillment.assignment.created and fulfillment.assignment.updated. */
export interface FulfillmentAssignmentData {
  assignmentId: string;
  orderId: string;
  stage: FulfillmentStage;
  state: 'active' | 'held' | 'cancelled';
  eventVersion: number;
  occurredAt: string;
}

interface EvidenceBase {
  assignmentId: string;
  purchaseId: string;
  expectedVersion?: number;
}

interface PurchasedLabel {
  carrier: CarrierCode;
  service: string;
  trackingNumber: string;
  trackingUrl: string;
  adultSignature: AdultSignature;
}

export type ShipmentEvidence = EvidenceBase & (
  | ({ kind: 'label-outcome'; outcome: 'purchased' } & PurchasedLabel)
  | ({ kind: 'label-outcome'; outcome: 'unknown' | 'voided' } & Partial<PurchasedLabel>)
  | { kind: 'label-voided' }
  | { kind: 'handoff'; carrier: CarrierCode }
);

export interface AssignmentShipmentWrite {
  lines: AssignmentLine[];
  carrier: string;
  service?: string;
  trackingNumber: string;
  trackingUrl?: string;
  adultSignature?: AdultSignature;
}

export interface AssignmentExceptionWrite {
  lines: AssignmentLine[];
  code: 'vendor_rejected' | 'backordered' | 'out_of_stock' | 'damaged' | 'address_undeliverable' | 'carrier_refused' | 'other';
  note?: string;
}

export interface InventoryLocationWrite {
  name: string;
  kind: 'warehouse' | '3pl' | 'dropship_vendor' | 'retail';
  isFulfillable?: boolean;
  status?: 'active' | 'archived';
}

export interface InventoryMovementBatchWrite {
  items: {
    sku: string;
    locationId?: string;
    quantityDelta: number;
    reason: 'received' | 'picked' | 'restock' | 'cycle_count' | 'damaged' | 'transfer' | 'adjustment';
  }[];
}

/** OpenAPI InventoryLevelsWrite, sent to PUT /inventory/levels. */
export interface InventoryLevelBatchWrite {
  items: {
    sku: string;
    locationId?: string;
    onHand: number;
    observedAt: string;
  }[];
}

/** The sales-velocity snapshot within the GET /reports response. */
export interface SalesVelocityReport {
  id: string;
  generatedAt: string;
  title?: string;
  format?: 'json' | 'csv';
  downloadUrl?: string;
  window?: { days: number; from: string; to: string };
  skus?: {
    sku: string;
    soldUnits: number;
    unsoldUnits: number;
    velocityPerDay: number;
    daysOfCover: number | null;
  }[];
}

export interface ReportList {
  reports: SalesVelocityReport[];
}
