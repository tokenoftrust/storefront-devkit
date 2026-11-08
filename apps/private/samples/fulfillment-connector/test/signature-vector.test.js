// A fixed vector, independent of sim/local-gateway.js: produced once by the
// platform signer's algorithm (rsa-v1_5-sha256, label sig1, components
// "@method" "@target-uri" "content-digest", sha-256 Content-Digest) with a
// throwaway key, and hard-coded here. Only the public key is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentDigestFor, verifyContentDigest, verifyMessageSignature } from '../src/http-signature.js';
import { importWebhookSigningKey } from '../src/gateway-metadata.js';

const VECTOR = {
  jwk: {
    kty: 'RSA',
    kid: 'vector-key-1',
    alg: 'RS256',
    use: 'sig',
    e: 'AQAB',
    n: 'vj57MdfTKKfeHWsTo0xibmtKYMCURBGHmqfBk9TnNYnJrPXsSwCIeWfpHdzUI3wBydCymaG__WCPG9OEeL9bH7SwhzyAU1MoJ-Kg9gP7qMqCQ0nOsNyZVfsSjGuF49qNJFNnajYdiNUdg_gowAOzDiYT5SESPMcdeP69MsqHfF5I5_QbXilnAAwHikOcwWrm1aJqOLRdhCU3U3I9vx4aRk7PPyIMDrpsrXQJK-D-o53r_tv2Lq6hzKwoKZNwy2QUrRPV8jh95IeBa1ott1_Y_Vc1F2K2pMfII0JvICWCDsNKMqlPAHm8lfbtHvChBAK0gFMjtAojIH4glYSUFQw7ww',
  },
  targetUri: 'https://fulfillment.example.com/webhooks/tot',
  body: '{"specversion":"1.0","id":"evt_VECTOR0001","type":"com.tokenoftrust.storefront.fulfillment.assignment.created"}',
  created: 1784660741,
  base: [
    '"@method": POST',
    '"@target-uri": https://fulfillment.example.com/webhooks/tot',
    '"content-digest": sha-256=:OyQsblFmbRO7oM0EdpcZdD404XG/HrFQj2nM4i7e7Hg=:',
    '"@signature-params": ("@method" "@target-uri" "content-digest");created=1784660741;keyid="vector-key-1";alg="rsa-v1_5-sha256"',
  ].join('\n'),
  headers: {
    'content-digest': 'sha-256=:OyQsblFmbRO7oM0EdpcZdD404XG/HrFQj2nM4i7e7Hg=:',
    'signature-input': 'sig1=("@method" "@target-uri" "content-digest");created=1784660741;keyid="vector-key-1";alg="rsa-v1_5-sha256"',
    signature:
      'sig1=:R5G2T90m1FLPyl9p7mL0ikNFyRIPPfdi4MzLRtVXGjlijS5wN7j5HUooQvALpBeUnfyk6YGBpYtJCNaezlFj38g9sjUO8CfsQteDeOMkR7UKYk8JIt0e/cnUoQFc0e93hKQIl2nv7SqYPhIzsEI3lm7zv6Wa86d4ViKlNpQYGZ4tecJqAEPKQ/uUP7bPgPyXIGVDQhb+3kpCCnEkftO+pBn391nwin9IVpRW2TuZwj0F5CEWBRtD9gkfmkMyMJ5/yjRWlHrN6KWLfKfWz203ihI2yAsnseqAWmwfdSSJeJYUH/iwsYuVYn7t1auSn1SpH8uEl9tyaZl5vcJFWQN29w==:',
  },
};

const [, published] = await importWebhookSigningKey(VECTOR.jwk);
const resolveKey = async (kid) => (kid === VECTOR.jwk.kid ? published : null);
const rawBody = Buffer.from(VECTOR.body, 'utf8');
const now = VECTOR.created * 1000;

test('the fixed vector: the digest and the signature base are what the documented algorithm produces', async () => {
  assert.equal(contentDigestFor(rawBody), VECTOR.headers['content-digest']);
  const signature = Buffer.from(VECTOR.headers.signature.slice('sig1=:'.length, -1), 'base64');
  const valid = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, published.key, signature, Buffer.from(VECTOR.base, 'utf8'));
  assert.equal(valid, true);
});

test('the fixed vector verifies through the sample verifier', async () => {
  assert.equal(verifyContentDigest(VECTOR.headers['content-digest'], rawBody).ok, true);
  const result = await verifyMessageSignature({ method: 'POST', targetUri: VECTOR.targetUri, headers: VECTOR.headers, resolveKey, now });
  assert.deepEqual(result, { ok: true, label: 'sig1', keyid: 'vector-key-1', created: VECTOR.created, alg: 'rsa-v1_5-sha256' });
});

test('the fixed vector fails on any changed input', async () => {
  const verify = (overrides) => verifyMessageSignature({ method: 'POST', targetUri: VECTOR.targetUri, headers: VECTOR.headers, resolveKey, now, ...overrides });
  assert.equal((await verify({ targetUri: `${VECTOR.targetUri}/` })).code, 'signature_invalid');
  assert.equal((await verify({ method: 'PUT' })).code, 'signature_invalid');
  const digest = contentDigestFor(Buffer.from(`${VECTOR.body} `));
  assert.equal((await verify({ headers: { ...VECTOR.headers, 'content-digest': digest } })).code, 'signature_invalid');
});
