import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayClient } from '../src/gateway-client.js';
import { createLogger } from '../src/log.js';

const BASE = 'https://acme.tokenoftrust.store';
const TOKEN_URL = `${BASE}/api/apps/oauth/token`;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A scripted gateway: each evidence POST takes the next status from `evidenceStatuses`. */
function harness(evidenceStatuses) {
  const calls = { tokens: 0, evidence: [] };
  const fetchImpl = async (url, init = {}) => {
    if (url === TOKEN_URL) {
      calls.tokens++;
      return json(200, { access_token: `token-${calls.tokens}`, token_type: 'Bearer', expires_in: 300 });
    }
    calls.evidence.push({ body: init.body, key: init.headers['idempotency-key'], authorization: init.headers.authorization });
    const status = evidenceStatuses.shift() ?? 200;
    return status === 200 ? json(200, { version: 8 }) : json(status, { code: status === 401 ? 'invalid_token' : 'unavailable' });
  };
  const client = createGatewayClient({
    baseUrl: BASE,
    clientId: 'placeholder-client-id',
    clientSecret: 'placeholder-client-secret',
    metadata: { tokenEndpoint: async () => TOKEN_URL },
    fetchImpl,
    logger: createLogger(() => {}),
    sleep: async () => {},
  });
  return { calls, client };
}

const evidence = { kind: 'handoff', assignmentId: 'asg_1', purchaseId: 'pur_1', carrier: 'UPS', expectedVersion: 7 };

test('502, 503 and 504 are retried with the same bytes under the same Idempotency-Key', async () => {
  const { calls, client } = harness([502, 503, 504]);
  const result = await client.postShipmentEvidence('ord_1', evidence, 'fc-handoff-key-0001');
  assert.equal(result.ok, true);
  assert.equal(calls.evidence.length, 4);
  assert.ok(calls.evidence.every((c) => c.body === calls.evidence[0].body && c.key === 'fc-handoff-key-0001'));
  assert.equal(calls.evidence[0].body, JSON.stringify(evidence));
});

test('retries stop at maxAttempts and return the refusal', async () => {
  const { calls, client } = harness([503, 503, 503, 503, 503]);
  const result = await client.postShipmentEvidence('ord_1', evidence, 'fc-handoff-key-0001');
  assert.deepEqual([result.ok, result.status], [false, 503]);
  assert.equal(calls.evidence.length, 4);
});

test('a 401 refreshes the token exactly once and re-sends the request', async () => {
  const { calls, client } = harness([401]);
  const result = await client.postShipmentEvidence('ord_1', evidence, 'fc-handoff-key-0001');
  assert.equal(result.ok, true);
  assert.equal(calls.tokens, 2);
  assert.deepEqual(calls.evidence.map((c) => c.authorization), ['Bearer token-1', 'Bearer token-2']);
  assert.equal(calls.evidence[0].body, calls.evidence[1].body);

  const twice = harness([401, 401]);
  const refused = await twice.client.postShipmentEvidence('ord_1', evidence, 'fc-handoff-key-0001');
  assert.deepEqual([refused.ok, refused.status, refused.code], [false, 401, 'invalid_token']);
  assert.equal(twice.calls.tokens, 2, 'a second 401 does not refresh again');
});
