// The 1 MiB delivery limit, on both entry points, without a socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLogger } from '../src/log.js';
import { MAX_BODY_BYTES, nodeRequestListener } from '../src/webhook.js';
import { createLocalGateway, SIM_BASE_URL, SIM_CLIENT_ID, SIM_CLIENT_SECRET, SIM_WEBHOOK_URL } from '../sim/local-gateway.js';
import { createWorker } from '../worker.js';

test('node:http: a streamed body over 1 MiB is answered 413 and never reaches the handler', async () => {
  let handled = false;
  const listener = nodeRequestListener(async () => {
    handled = true;
    return { status: 202, body: {} };
  }, createLogger(() => {}));
  const req = new EventEmitter();
  Object.assign(req, { method: 'POST', headers: {}, destroyed: false, destroy() { this.destroyed = true; } });
  const res = {
    status: null,
    writableEnded: false,
    headersSent: false,
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
      return this;
    },
    end() {
      this.writableEnded = true;
      return this;
    },
  };
  listener(req, res);
  req.emit('data', Buffer.alloc(MAX_BODY_BYTES));
  assert.equal(res.status, null, 'exactly 1 MiB is still allowed');
  req.emit('data', Buffer.alloc(1));
  req.emit('end');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([res.status, req.destroyed, handled], [413, true, false]);
});

const env = { TOT_APP_CLIENT_ID: SIM_CLIENT_ID, TOT_APP_CLIENT_SECRET: SIM_CLIENT_SECRET, TOT_STOREFRONT_BASE_URL: SIM_BASE_URL, WEBHOOK_PUBLIC_URL: SIM_WEBHOOK_URL };

function worker() {
  const gateway = createLocalGateway();
  return createWorker({ fetchImpl: gateway.fetch, logger: createLogger(() => {}), sleep: async () => {} });
}

test('Worker: a declared Content-Length over 1 MiB is refused 413 before the body is read', async () => {
  let read = false;
  const request = {
    url: SIM_WEBHOOK_URL,
    method: 'POST',
    headers: new Headers({ 'content-length': String(MAX_BODY_BYTES + 1) }),
    arrayBuffer: async () => {
      read = true;
      return new ArrayBuffer(0);
    },
  };
  const res = await worker().fetch(request, env, { waitUntil() {} });
  assert.equal(res.status, 413);
  assert.equal(read, false);
});

test('Worker: an actual body over 1 MiB without a Content-Length is refused 413', async () => {
  const request = new Request(SIM_WEBHOOK_URL, { method: 'POST', body: new Uint8Array(MAX_BODY_BYTES + 1) });
  assert.equal(request.headers.get('content-length'), null);
  const res = await worker().fetch(request, env, { waitUntil() {} });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, 'body_too_large');
});
