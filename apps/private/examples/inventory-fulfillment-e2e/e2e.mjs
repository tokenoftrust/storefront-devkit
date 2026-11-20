#!/usr/bin/env node
// Captioned end-to-end run of the inventory and fulfillment APIs on a store PREVIEW (test installs only).
//   npm run e2e                         all four parts
//   npm run e2e -- --only <part>        inventory-api | inventory-sync | fulfilment | hold
//   npm run e2e -- --pause 6            seconds each caption stays up (default 4)
//   npm run e2e -- --help               what it needs; no network
//
// Parts:
//   inventory-api   this example's own calls (index.mjs runLive): quarantine location, 4-reason batch,
//                   level reconciliation, availability, sales-velocity report, orders, cleanup
//   inventory-sync  ../connector-starter inventory-sync with its mock WMS: receive + pick become
//                   movement batches; Storefront answers with signed inventory.changed webhooks; cleanup
//   fulfilment      ../connector-starter dropship: a synthetic 2-unit order ships in two supplier cartons
//                   (order.partially_fulfilled, then order.fulfilled)
//   hold            dropship again: held then cancelled; the supplier purchase order follows
//
// Needs (never printed):
//   ./.env or env      TOT_TENANT, TOT_CLIENT_ID, TOT_CLIENT_SECRET  this example's own test install
//                      WEBHOOK_PUBLIC_URL  a public tunnel to http://127.0.0.1:8787, registered as the
//                                          webhook endpoint of the inventory-sync and dropship installs
//                      E2E_LOCATION_ID     optional, default loc-e2e-dropship (dropship's preview location)
//                      TOT_BIN             optional, default tot (CLI 7.5.5 or later, signed in)
//   ../connector-starter/apps/{inventory-sync,dropship}/.env   those apps' test-install credentials
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTER = join(HERE, '..', 'connector-starter');
export const PARTS = ['inventory-api', 'inventory-sync', 'fulfilment', 'hold'];

/** CLI flags -> { only, pauseMs, help }. Throws on an unknown part. */
export function parseArgs(argv) {
  const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const only = at('--only') ?? null;
  if (only && !PARTS.includes(only)) throw new Error(`--only takes one of: ${PARTS.join(', ')}`);
  const pause = Number(at('--pause') ?? 4);
  if (!Number.isFinite(pause) || pause < 0) throw new Error('--pause takes a number of seconds');
  return { only, pauseMs: pause * 1000, help: argv.includes('--help') || argv.includes('-h') };
}

/** KEY=VALUE lines of ./.env under process.env-style overrides. */
export function loadEnv(path = join(HERE, '.env'), env = process.env) {
  const file = {};
  if (existsSync(path)) {
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      const eq = line.indexOf('=');
      if (!line || line.startsWith('#') || eq < 1) continue;
      file[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return { ...file, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== '')) };
}

/** Names of the settings a part needs that are missing. */
export function missingFor(parts, env) {
  const need = new Set();
  if (parts.includes('inventory-api')) ['TOT_TENANT', 'TOT_CLIENT_ID', 'TOT_CLIENT_SECRET'].forEach((k) => need.add(k));
  if (parts.some((p) => p !== 'inventory-api')) ['TOT_TENANT', 'WEBHOOK_PUBLIC_URL'].forEach((k) => need.add(k));
  return [...need].filter((k) => !env[k]);
}

// ---------- presentation ----------
const C = { b: '\x1b[1m', d: '\x1b[2m', c: '\x1b[36m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', m: '\x1b[35m', x: '\x1b[0m' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const LINE = '━'.repeat(78);
let tickerShown = false;
function clearTicker() {
  if (tickerShown) process.stdout.write('\r\x1b[2K');
  tickerShown = false;
}
const say = (s) => {
  clearTicker();
  console.log(s);
};
const ok = (s) => say(`   ${C.g}✓${C.x} ${s}`);
const info = (s) => say(`   ${C.d}·${C.x} ${s}`);
const bad = (s) => say(`   ${C.r}✗ ${s}${C.x}`);
const hook = (s) => say(`   ${C.y}⚡${C.x} ${s}`);
const j = (o) => JSON.stringify(o);
let step = 0;
function caption(title, ...lines) {
  step += 1;
  say(`\n${C.c}${LINE}${C.x}`);
  console.log(`${C.c}${C.b} ${String(step).padStart(2)}  ${title}${C.x}`);
  for (const l of lines) console.log(`${C.c}     ${l}${C.x}`);
  console.log(`${C.c}${LINE}${C.x}`);
}
const chapter = (title, sub) => say(`\n\n${C.m}${C.b}██  ${title}${C.x}${sub ? `\n${C.m}    ${sub}${C.x}` : ''}`);

async function waiting(label, promise, seconds) {
  const t0 = Date.now();
  const tick = setInterval(() => {
    process.stdout.write(`\r\x1b[2K   ${C.d}… ${label} ${Math.round((Date.now() - t0) / 1000)}s${C.x}`);
    tickerShown = true;
  }, 1000);
  try {
    return await Promise.race([promise, sleep(seconds * 1000).then(() => null)]);
  } finally {
    clearInterval(tick);
    clearTicker();
  }
}

// ---------- a connector-starter app as a child process ----------
function startApp(app, env, show) {
  const bus = new EventEmitter();
  const seen = [];
  const child = spawn(process.execPath, [`apps/${app}/connector.mjs`, ...(env.ARGS ?? [])], { cwd: STARTER, env: { ...process.env, ...env } });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      seen.push(e);
      show(e);
      bus.emit('event', e);
    });
  }
  const exited = new Promise((r) => child.on('exit', r));
  return {
    exited,
    stop: async () => {
      child.kill('SIGTERM');
      await exited;
    },
    mark: () => seen.length,
    /** First event matching pred, already seen (from index `from`) or still to come. */
    waitFor(pred, from = 0) {
      const hit = seen.slice(from).find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const f = (e) => pred(e) && (bus.off('event', f), resolve(e));
        bus.on('event', f);
      });
    },
  };
}

export async function run({ only, pauseMs }, env) {
  const parts = only ? [only] : PARTS;
  const missing = missingFor(parts, env);
  if (missing.length) throw new Error(`missing ${missing.join(', ')} (in ./.env or the environment; see npm run e2e -- --help)`);
  const { loadConfig } = await import(pathToFileURL(join(STARTER, 'core', 'config.mjs')).href);
  const TENANT = env.TOT_TENANT;
  const TUNNEL = (env.WEBHOOK_PUBLIC_URL || '').replace(/\/+$/, '');
  const LOCATION = env.E2E_LOCATION_ID || 'loc-e2e-dropship';
  const TOT_BIN = env.TOT_BIN || 'tot';
  const state = (name) => join(tmpdir(), `inventory-fulfillment-e2e-${name}.json`);

  function tot(args) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const r = spawnSync(TOT_BIN, [...args, '--tenant', TENANT, '--json'], { encoding: 'utf8' });
      if (r.error) throw new Error(`could not run ${TOT_BIN} (${r.error.code}); install @tokenoftrust/cli 7.5.5 or later`);
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      if (/mcp_http_error|mcp_unreachable/.test(out) && attempt < 4) {
        spawnSync('sleep', ['10']);
        continue;
      }
      try {
        return { status: r.status, body: JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) };
      } catch {
        return { status: r.status, body: null, text: out.trim().split('\n').slice(-2).join(' ') };
      }
    }
    return { status: 1, body: null };
  }
  function orderStep(action, ...rest) {
    const r = tot(['app', 'test-order', action, ...rest]);
    if (r.status !== 0) bad(`tot app test-order ${action}: ${r.text ?? j(r.body)}`);
    return r.body;
  }

  say(`${C.b}Storefront Private Apps · inventory & fulfillment end-to-end on the ${TENANT} PREVIEW${C.x}`);
  say(`${C.d}Test installs only. Synthetic orders, quarantine locations, cleaned up afterwards. Nothing shopper-visible.${C.x}`);

  // ================= inventory-api: this example's own calls =================
  if (parts.includes('inventory-api')) {
    chapter('Inventory API', 'Every inventory call this example makes against the store preview, one step at a time.');
    const { runLive } = await import(pathToFileURL(join(HERE, 'index.mjs')).href);
    const loc = env.TOT_LOCATION_ID || 'loc-e2e-inventory';
    const CAP = {
      location: ['Declare a quarantine stock location', `PUT /inventory/locations/${loc}  isFulfillable:false`, 'Stock here is tracked in the ledger but never offered to shoppers.'],
      movements: ['Post one atomic WMS batch with four reason codes', 'POST /inventory/movements  received +5, damaged -1, cycle_count -1, adjustment +1', 'All four apply together or none do; a retry with the same Idempotency-Key replays the receipt.'],
      'levels:first': ['Reconcile an absolute count from the warehouse', 'PUT /inventory/levels  onHand = balance - 1', 'The first observation writes the drift (-1); the next identical count writes 0.'],
      inventory: ['Read availability back', 'GET /inventory?sku=…&locationId=…', 'mirror.balance is this location\'s ledger; available/quantity are store-wide, which quarantine stock never adds to.'],
      reports: ['Read the 30-day sales-velocity snapshot', 'GET /reports?windowDays=30  (reports:read)', 'Per SKU: sold units, unsold units, velocity per day, days of cover.'],
      orders: ['List orders the app may see', 'GET /orders  (orders:read:minimal: no customer PII)'],
      'cleanup:zero': ['Clean up the preview', 'Zero the test stock and archive the location.'],
    };
    const fmt = {
      location: (e) => `location ${loc} ${e.ok ? 'active' : 'refused'} (HTTP ${e.status})`,
      'inventory:first-sku': (e) => `picked the store's first inventory SKU (HTTP ${e.status})`,
      movements: (e) => `batch accepted (HTTP ${e.status})`,
      'movements:receipt': (e) => `receipt ${e.receiptId?.slice(0, 18)}…  SKU ${e.sku}  balance ${e.balance}`,
      'levels:first': (e) => `first count accepted (HTTP ${e.status})`,
      'levels:repeat': (e) => `repeat count accepted (HTTP ${e.status})`,
      'levels:drift': (e) => `drift written: first ${e.first}, repeat ${e.repeat}`,
      inventory: (e) => `inventory read (HTTP ${e.status})`,
      'inventory:item': (e) => `ledger balance ${e.mirrorBalance} here · store-wide available ${e.available}${e.quantity !== undefined ? `, quantity ${e.quantity}` : ''}${e.policy ? `, policy ${e.policy}` : ''}`,
      reports: (e) => `report read (HTTP ${e.status})`,
      'reports:row': (e) => (e.row ? `${e.sku}: sold ${e.row.soldUnits}, unsold ${e.row.unsoldUnits}, ${e.row.velocityPerDay}/day, days of cover ${e.row.daysOfCover ?? 'n/a (nothing sold)'}` : `${e.sku}: no sales in the window`),
      orders: (e) => `orders read (HTTP ${e.status})`,
      'cleanup:zero': (e) => `test stock set to 0 (HTTP ${e.status})`,
      'cleanup:archive': (e) => `location archived (HTTP ${e.status})`,
    };
    const PAUSE_AFTER = new Set(['location', 'movements:receipt', 'levels:drift', 'inventory:item', 'reports:row', 'orders', 'cleanup:archive']);
    await runLive({
      cleanup: true,
      env: { ...env, TOT_LOCATION_ID: loc },
      log: (e) => {
        const k = e.event.replace('inventory-fulfillment-e2e:live:', '');
        if (CAP[k]) caption(...CAP[k]);
        if (e.ok === false) bad(`${k}: HTTP ${e.status} ${j(e.refusal)}`);
        else ok((fmt[k] ?? ((x) => j(x)))(e));
        if (PAUSE_AFTER.has(k)) sleepSync(pauseMs);
      },
    });
  }

  // ================= inventory-sync: WMS -> Storefront -> signed webhooks =================
  if (parts.includes('inventory-sync')) {
    chapter('Inventory changes end to end', 'The inventory-sync starter connects a warehouse system (mocked here) to Storefront, and Storefront confirms with signed webhooks.');
    rmSync(state('inventory-sync'), { force: true });
    const appEnv = { WEBHOOK_PUBLIC_URL: TUNNEL, STATE_FILE: state('inventory-sync'), MOCK_DRIFT_SECONDS: '0', SYNC_SECONDS: '6', MOCK_SKU_COUNT: '3', PORT: '8787' };
    const wmsPort = loadConfig('inventory-sync').mockPort;
    const show = (e) => {
      switch (e.event) {
        case 'inventory-sync.ready': return ok(`connector up · mock WMS with store SKUs ${e.skus.join(', ')}`);
        case 'storefront.location': return ok(`location ${e.locationId} ${e.status} · isFulfillable ${e.isFulfillable} (HTTP ${e.http})`);
        case 'reports.sales_velocity': return ok(`sales-velocity report read · ${e.rows.length} of these SKUs sold in ${e.window?.days} days`);
        case 'reports.read_failed': return bad(`report refused HTTP ${e.http} ${e.code}`);
        case 'server.listening': return ok('listening for signed webhooks');
        case 'storefront.levels': return ok(`PUT /inventory/levels (${e.reason}) HTTP ${e.http} · drift ${e.drift?.length ? e.drift.map((d) => `${d.sku} ${d.quantityDelta > 0 ? '+' : ''}${d.quantityDelta}`).join(', ') : 'none (0)'}`);
        case 'storefront.movements': return ok(`POST /inventory/movements HTTP ${e.http} · ${e.count} movement(s) · receipt ${e.receiptId?.slice(0, 14)}…`);
        case 'storefront.movement_refused': return bad(`movement refused ${j(e)}`);
        case 'webhook.received': return hook(`signed webhook ${e.topic} · ${e.data?.sku} at ${e.data?.locationId}: balance ${e.data?.balance} · asOf ${e.data?.asOf}`);
        case 'inventory.changed.applied': return info('applied (newer than anything seen for this SKU)');
        case 'inventory.changed.stale': return info(`ignored: older than ${e.lastSeenAsOf}`);
        case 'webhook.refused': return bad(`webhook refused ${j(e.body)}`);
        case 'cleanup.levels_zeroed': return ok(`test stock zeroed (HTTP ${e.http})`);
        default: if (e.level === 'error') bad(`${e.event} ${e.error ?? ''}`);
      }
    };
    caption('Start the inventory-sync connector', 'Declares its own quarantine location, reads the sales report, then sends the WMS counts as the baseline.');
    const app = startApp('inventory-sync', appEnv, show);
    const ready = await app.waitFor((e) => e.event === 'inventory-sync.ready' || e.event === 'inventory.read_failed');
    if (ready.event !== 'inventory-sync.ready') throw new Error('inventory-sync could not read inventory; check apps/inventory-sync/.env');
    await waiting('baseline', app.waitFor((e) => e.event === 'storefront.levels'), 60);
    await sleep(pauseMs);
    const sku = ready.skus[0];
    const wms = (path, body) => fetch(`http://127.0.0.1:${wmsPort}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j(body) }).then((r) => r.json());

    caption('Goods arrive at the warehouse: +12', `WMS movement RECEIVE +12 for ${sku}`, 'The connector maps the WMS reason to Storefront\'s "received" and posts it, then re-checks the count (drift 0).');
    let m = app.mark();
    info(`WMS now holds ${(await wms('/_mock/move', { sku, qty: 12, reason: 'RECEIVE' })).quantityOnHand} of ${sku}`);
    await waiting('next sync', app.waitFor((e) => e.event === 'storefront.movements', m), 30);
    m = app.mark(); // the recount that follows this batch, not an earlier routine one
    await waiting('reconcile', app.waitFor((e) => e.event === 'storefront.levels', m), 30);
    await sleep(pauseMs);

    caption('A picker takes 2 units', `WMS movement PICK -2 for ${sku} → Storefront reason "picked"`);
    m = app.mark();
    const pick = await wms('/_mock/pick', { sku, qty: 2 });
    info(`WMS now holds ${pick.quantityOnHand} of ${sku}`);
    await waiting('next sync', app.waitFor((e) => e.event === 'storefront.movements', m), 30);
    m = app.mark(); // the recount that follows this batch, not an earlier routine one
    await waiting('reconcile', app.waitFor((e) => e.event === 'storefront.levels', m), 30);
    await sleep(pauseMs);

    caption('Storefront confirms every change with a signed inventory.changed webhook', 'RFC 9421 signature checked against the store\'s published keys; a newer asOf wins, an older one is ignored.', 'Preview deliveries take up to about a minute.');
    const got = await waiting('waiting for webhooks', app.waitFor((e) => e.event === 'webhook.received' && e.data?.sku === sku && e.data?.balance === pick.quantityOnHand), 180);
    if (!got) bad('no inventory.changed for the final balance within 3 minutes');
    await sleep(pauseMs);
    await app.stop();

    caption('Clean up the preview', 'Zero the test stock and archive the location (npm run inventory-sync -- --cleanup).');
    await startApp('inventory-sync', { ...appEnv, ARGS: ['--cleanup'] }, show).exited;
    await sleep(pauseMs);
  }

  // ================= fulfilment + hold: dropship =================
  const dropship = loadConfig('dropship');
  const supplierPort = dropship.mockPort;
  const dropshipShow = (e) => {
    switch (e.event) {
      case 'dropship.ready': return ok('dropship connector up · mock supplier platform');
      case 'server.listening': return ok('listening for signed webhooks');
      case 'assignment.start': return ok(`Storefront assigned order ${e.orderId} to this app · ${e.lines?.map((l) => `${l.sku} x${l.quantity}`).join(', ')} at ${e.locationId}`);
      case 'provider.po_created': return ok(`purchase order #${e.poId} sent to the supplier`);
      case 'storefront.shipment': return ok(`carton ${e.supplierShipment} (${e.carrier}) reported · POST …/shipments HTTP ${e.status} · order complete: ${e.complete}${e.code ? ` · ${e.code}` : ''}`);
      case 'webhook.received': return e.topic.startsWith('inventory.') ? null : hook(`signed webhook ${e.topic}${e.data?.state ? ` · state ${e.data.state} v${e.data.eventVersion}` : ''}`);
      case 'order.partially_fulfilled.event': return info('order is partially fulfilled');
      case 'order.fulfilled.event': return info('order is fulfilled');
      case 'assignment.updated': return ok(`assignment ${e.state} → supplier PO #${e.poId} ${{ held: 'put on hold', cancelled: 'cancelled', active: 'resumed' }[e.state] ?? ''}`);
      case 'assignment.failed': return bad(`assignment failed ${e.code ?? ''} ${e.error ?? ''}`);
      default: if (e.level === 'error') bad(`${e.event} ${e.error ?? ''}`);
    }
  };

  if (parts.includes('fulfilment')) {
    chapter('Fulfilment with a split shipment', 'The dropship starter turns a Storefront assignment into a supplier purchase order and reports each carton back.');
    rmSync(state('dropship'), { force: true });
    caption('Bind the dropship test install to its own preview location', `tot app test-order bind … --location ${LOCATION}`, 'Only orders at this location come to this app; other developers on the store are unaffected.');
    if (orderStep('bind', dropship.installId, '--location', LOCATION)) ok(`bound as preview processor for ${LOCATION}`);
    await sleep(pauseMs);
    const app = startApp('dropship', { WEBHOOK_PUBLIC_URL: TUNNEL, STATE_FILE: state('dropship'), POLL_SECONDS: '5', MOCK_SHIP_SECONDS: '10', PORT: '8787' }, dropshipShow);
    await app.waitFor((e) => e.event === 'server.listening');

    caption('A synthetic order for 2 units', `tot app test-order create --location ${LOCATION} --quantity 2, then release`, 'Preview data only; never a live order.');
    const orderId = orderStep('create', '--location', LOCATION, '--quantity', '2')?.order?.orderId;
    if (!orderId) {
      await app.stop();
      throw new Error('no order created');
    }
    ok(`order ${orderId} created`);
    orderStep('release', orderId);
    ok('released to the bound install');
    await sleep(pauseMs);

    caption('The app picks up the assignment and orders from the supplier', 'GET /fulfillment/assignments → recipient read in memory only → supplier purchase order.');
    await waiting('assignment', app.waitFor((e) => e.event === 'provider.po_created' && e.orderId === orderId), 120);
    await sleep(pauseMs);

    caption('The supplier ships in two cartons', 'Each carton is reported with POST /fulfillment/assignments/{id}/shipments.', 'Carton 1 leaves the order partially fulfilled; carton 2 completes it.');
    await waiting('carton 1', app.waitFor((e) => e.event === 'storefront.shipment' && e.orderId === orderId), 60);
    await waiting('carton 2', app.waitFor((e) => e.event === 'storefront.shipment' && e.orderId === orderId && e.complete === true), 60);
    await sleep(pauseMs);

    caption('Storefront announces the progress with signed order webhooks', 'order.partially_fulfilled after carton 1, order.fulfilled after carton 2 (up to about a minute on preview).');
    await waiting('order.partially_fulfilled', app.waitFor((e) => e.event === 'order.partially_fulfilled.event'), 180);
    await waiting('order.fulfilled', app.waitFor((e) => e.event === 'order.fulfilled.event'), 180);
    await sleep(pauseMs);
    await app.stop();
  }

  if (parts.includes('hold')) {
    chapter('Hold and cancel', 'Storefront can hold or cancel an assigned order; the app mirrors it at the supplier.');
    rmSync(state('dropship-hold'), { force: true });
    // The supplier never ships on its own here (MOCK_SHIP_SECONDS=0): webhooks drive every change.
    const app = startApp('dropship', { WEBHOOK_PUBLIC_URL: TUNNEL, STATE_FILE: state('dropship-hold'), POLL_SECONDS: '600', MOCK_SHIP_SECONDS: '0', PORT: '8787' }, dropshipShow);
    await app.waitFor((e) => e.event === 'server.listening');
    const po = async (id) => (await fetch(`http://127.0.0.1:${supplierPort}/purchase_orders/${id}`)).json();

    caption('A synthetic order, assigned to the app', 'create + release; fulfillment.assignment.created webhook → supplier purchase order.');
    const orderId = orderStep('create', '--location', LOCATION, '--quantity', '2')?.order?.orderId;
    if (!orderId) {
      await app.stop();
      throw new Error('no order created');
    }
    ok(`order ${orderId} created`);
    orderStep('release', orderId);
    ok('released');
    const created = await waiting('assignment webhook', app.waitFor((e) => e.event === 'provider.po_created' && e.orderId === orderId), 180);
    if (!created) {
      await app.stop();
      throw new Error('no purchase order within 3 minutes');
    }
    await sleep(pauseMs);

    caption('The merchant puts the order on hold', `tot app test-order hold ${orderId}`, 'fulfillment.assignment.updated state "held" → the app holds the supplier purchase order.');
    orderStep('hold', orderId);
    ok('order held in Storefront');
    await waiting('held webhook', app.waitFor((e) => e.event === 'assignment.updated' && e.state === 'held'), 180);
    info(`supplier PO #${created.poId} status: ${(await po(created.poId)).status}`);
    await sleep(pauseMs);

    caption('The merchant cancels the order', `tot app test-order cancel ${orderId}`, 'fulfillment.assignment.updated state "cancelled" → the app cancels the supplier purchase order.');
    orderStep('cancel', orderId);
    ok('order cancelled in Storefront');
    await waiting('cancelled webhook', app.waitFor((e) => e.event === 'assignment.updated' && e.state === 'cancelled'), 180);
    const final = await po(created.poId);
    info(`supplier PO #${created.poId} status: ${final.status} · shipped cartons: ${final.shipments.length}`);
    await sleep(pauseMs);
    await app.stop();
  }
  say(`\n${C.m}${C.b}██  Done${C.x}`);
}

const HELP = `npm run e2e [-- --only ${PARTS.join('|')}] [--pause <seconds>]

Runs against your store's PREVIEW with test installs; writes only to quarantine locations and synthetic
orders, and cleans up. Needs, in ./.env or the environment (never printed):
  TOT_TENANT, TOT_CLIENT_ID, TOT_CLIENT_SECRET   this example's test install (tot app install --env test)
  WEBHOOK_PUBLIC_URL                              tunnel to http://127.0.0.1:8787, set as the webhook endpoint
                                                  of the inventory-sync and dropship test installs
  E2E_LOCATION_ID (default loc-e2e-dropship), TOT_BIN (default tot, CLI 7.5.5+)
and ../connector-starter/apps/{inventory-sync,dropship}/.env for those installs.`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log(HELP);
    else await run(args, loadEnv(process.env.E2E_ENV_FILE || join(HERE, '.env')));
  } catch (err) {
    bad(err.message);
    process.exitCode = 1;
  }
}
