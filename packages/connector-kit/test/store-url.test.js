import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient, AuthorizationMetadata, ConnectorAuthClient } from '../src/index.js';

const ORIGIN = 'https://storefront.example.com:8443';
const TENANT = 'sample-store';

function clients(options, fetch) {
  const auth = new ConnectorAuthClient({ ...options, clientId: 'fixture-client', clientSecret: 'fixture-secret', fetch });
  return { auth, api: new ApiClient({ ...options, auth, fetch }) };
}

for (const [name, options, base] of [
  ['a bare origin', { origin: `${ORIGIN}/` }, ORIGIN],
  ['an explicit tenant', { origin: ORIGIN, tenant: TENANT }, `${ORIGIN}/${TENANT}`],
  ['a tenant path', { origin: `${ORIGIN}/${TENANT}` }, `${ORIGIN}/${TENANT}`],
  ['a tenant path with a trailing slash', { origin: `${ORIGIN}/${TENANT}/` }, `${ORIGIN}/${TENANT}`],
  ['a local simulator', { origin: 'http://127.0.0.1:8080', tenant: TENANT }, `http://127.0.0.1:8080/${TENANT}`],
]) {
  test(`OAuth and API requests use the correct URL for ${name}`, async () => {
    const requests = [];
    const fetch = async (url, { method, headers }) => {
      requests.push({ url, method });
      if (method === 'POST') {
        return Response.json({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 600 });
      }
      assert.equal(headers.authorization, 'Bearer fixture-token');
      return Response.json({ items: [] });
    };
    const { api } = clients(options, fetch);
    assert.deepEqual((await api.get('/inventory', { query: { limit: 5 } })).body, { items: [] });
    assert.deepEqual(requests, [
      { url: `${base}/api/apps/oauth/token`, method: 'POST' },
      { url: `${base}/api/apps/v1/inventory?limit=5`, method: 'GET' },
    ]);
  });
}

test('both clients refuse invalid origins and tenant slugs before making requests', () => {
  const invalid = [
    { origin: 'storefront.example.com' },
    { origin: 'https:storefront.example.com' },
    { origin: 'ftp://storefront.example.com' },
    { origin: 'http://storefront.example.com' },
    { origin: 'https://fixture:fixture@storefront.example.com' },
    { origin: 'https://@storefront.example.com' },
    { origin: `${ORIGIN}?` },
    { origin: `${ORIGIN}#` },
    { origin: `${ORIGIN}/${TENANT}?query=1` },
    { origin: `${ORIGIN}/${TENANT}#fragment` },
    { origin: `${ORIGIN}/api/apps/v1` },
    { origin: `${ORIGIN}//${TENANT}` },
    { origin: `${ORIGIN}/${TENANT}/nested` },
    { origin: `${ORIGIN}/${TENANT}/..` },
    { origin: `${ORIGIN}/%2e` },
    { origin: `${ORIGIN}/sample%2fstore` },
    { origin: `${ORIGIN}\\${TENANT}` },
    { origin: `${ORIGIN}/${TENANT}\n` },
    { origin: `${ORIGIN}/${TENANT}`, tenant: TENANT },
    ...['', null, 42, 'store/nested', 'store\\nested', 'store%2fnested', 'store?query', 'store#fragment', 'store\n', '.', '..', '-store']
      .map((tenant) => ({ origin: ORIGIN, tenant })),
  ];
  const auth = { getAccessToken: () => assert.fail('a token should not be requested') };
  const fetch = () => assert.fail('a request should not be sent');
  for (const options of invalid) {
    const context = JSON.stringify(options);
    assert.throws(() => new ConnectorAuthClient({ ...options, clientId: 'fixture-client', clientSecret: 'fixture-secret', fetch }), TypeError, context);
    assert.throws(() => new ApiClient({ ...options, auth, fetch }), TypeError, context);
  }
});

test('authorization metadata stays on the bare host and verifies its token endpoint', async () => {
  const requests = [];
  const tokenEndpoint = `${ORIGIN}/api/apps/oauth/token`;
  const fetch = async (url) => {
    requests.push(url);
    return Response.json({ token_endpoint: tokenEndpoint });
  };
  assert.throws(() => new AuthorizationMetadata({ origin: `${ORIGIN}/${TENANT}`, fetch }), TypeError);
  const metadata = new AuthorizationMetadata({ origin: `${ORIGIN}/`, fetch });
  assert.equal(await metadata.tokenEndpoint(), tokenEndpoint);
  assert.deepEqual(requests, [`${ORIGIN}/.well-known/tot-app-authorization-metadata`]);
});
