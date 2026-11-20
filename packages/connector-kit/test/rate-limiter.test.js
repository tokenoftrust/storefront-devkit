import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import * as kit from 'storefront-connector-kit';

const START = Date.UTC(2026, 0, 1);

function fakeClock() {
  let time = START;
  let pending = [];

  return {
    now: () => time,
    sleep: (ms) => new Promise((resolve) => pending.push({ wake: time + ms, resolve })),
    async advanceBy(ms) {
      await setImmediate();
      time += ms;
      const due = pending.filter(({ wake }) => wake <= time);
      pending = pending.filter(({ wake }) => wake > time);
      for (const { resolve } of due) resolve();
      await setImmediate();
    },
  };
}

test('concurrent acquisitions consume burst capacity and refill one token at a time', async () => {
  assert.equal(typeof kit.createRateLimiter, 'function');
  const clock = fakeClock();
  const limiter = kit.createRateLimiter({ requestsPerMinute: 120, burst: 2, ...clock });
  const admittedAt = [];
  const requests = Array.from({ length: 4 }, () =>
    limiter.acquire().then(() => admittedAt.push(clock.now() - START)));

  await clock.advanceBy(0);
  assert.deepEqual(admittedAt, [0, 0]);
  await clock.advanceBy(499);
  assert.deepEqual(admittedAt, [0, 0]);
  await clock.advanceBy(1);
  assert.deepEqual(admittedAt, [0, 0, 500]);
  await clock.advanceBy(500);
  assert.deepEqual(admittedAt, [0, 0, 500, 1000]);
  await Promise.all(requests);
});

test('wrap forwards request arguments and returns the exact response without retrying', async () => {
  const clock = fakeClock();
  const limiter = kit.createRateLimiter({ requestsPerMinute: 60, ...clock });
  const response = new Response('rate limited', { status: 429, headers: { 'Retry-After': '2' } });
  const input = new Request('https://example.test/catalog');
  const init = { method: 'POST', body: 'body' };
  const calls = [];
  const wrapped = limiter.wrap(async (...args) => {
    calls.push(args);
    return response;
  });

  let returned;
  const result = wrapped(input, init).then((value) => { returned = value; });
  await clock.advanceBy(0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
  assert.equal(calls[0][0], input);
  assert.equal(calls[0][1], init);
  assert.equal(returned, response);
  await result;
  assert.equal(await response.text(), 'rate limited');
  await clock.advanceBy(2000);
  assert.equal(calls.length, 1);
});

const resets = [
  { name: 'Retry-After delta on 429', headers: { 'Retry-After': '2' } },
  { name: 'Retry-After date on 429', headers: { 'Retry-After': new Date(START + 2000).toUTCString() } },
  { name: 'X-Rate-Limit-Reset on 429', headers: { 'X-Rate-Limit-Reset': String(START / 1000 + 2) } },
  {
    name: 'later reset on a successful response that exhausts the quota',
    status: 200,
    headers: {
      'Retry-After': '1',
      'X-Rate-Limit-Remaining': '0',
      'X-Rate-Limit-Reset': String(START / 1000 + 2),
    },
  },
  {
    name: 'valid Retry-After alongside an out-of-range reset timestamp',
    headers: { 'Retry-After': '2', 'X-Rate-Limit-Reset': '9'.repeat(310) },
  },
  {
    name: 'custom parser on another status',
    status: 503,
    headers: { 'X-Cooldown': '2' },
    options: { parseResetSeconds: (response) => Number(response.headers.get('X-Cooldown')) },
  },
];

for (const { name, status = 429, headers, options } of resets) {
  test(name + ' delays subsequent wrapped requests and direct acquisitions', async () => {
    const clock = fakeClock();
    const limiter = kit.createRateLimiter({ requestsPerMinute: 60, burst: 2, ...clock });
    const limited = new Response(null, { status, headers });
    const success = new Response();
    const fetchedAt = [];
    const wrapped = limiter.wrap(async () => {
      fetchedAt.push(clock.now() - START);
      return fetchedAt.length === 1 ? limited : success;
    }, options);

    assert.equal(await wrapped('https://example.test/catalog'), limited);
    const next = wrapped('https://example.test/catalog');
    let acquiredAt;
    const direct = limiter.acquire().then(() => { acquiredAt = clock.now() - START; });
    await clock.advanceBy(1999);
    assert.deepEqual(fetchedAt, [0]);
    assert.equal(acquiredAt, undefined);
    await clock.advanceBy(1);
    assert.deepEqual(fetchedAt, [0, 2000]);
    await clock.advanceBy(1000);
    assert.equal(await next, success);
    assert.ok(acquiredAt >= 2000);
    await direct;
  });
}

test('a reset extends the wait of an acquisition already queued for a token', async () => {
  const clock = fakeClock();
  const limiter = kit.createRateLimiter({ requestsPerMinute: 60, ...clock });
  let respond;
  const wrapped = limiter.wrap(() => new Promise((resolve) => { respond = resolve; }));
  const first = wrapped('https://example.test/catalog');
  let acquiredAt;
  const next = limiter.acquire().then(() => { acquiredAt = clock.now() - START; });

  await clock.advanceBy(500);
  assert.equal(acquiredAt, undefined);
  const limited = new Response(null, { status: 429, headers: { 'Retry-After': '2' } });
  respond(limited);
  assert.equal(await first, limited);
  await clock.advanceBy(500);
  assert.equal(acquiredAt, undefined);
  await clock.advanceBy(1499);
  assert.equal(acquiredAt, undefined);
  await clock.advanceBy(1);
  assert.equal(acquiredAt, 2500);
  await next;
});
