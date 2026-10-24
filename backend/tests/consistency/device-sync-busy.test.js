/**
 * Busy-device reporting (isolated: stubbed Prisma / logger / realtime listener, no database, no .env, no ZKTeco device, no network).
 *
 * When another operation holds a device, pullLogs() answers { skipped: true, skipReason: 'SYNC_ALREADY_RUNNING' } WITHOUT touching
 * the lock, and now also says who holds it (heldBy) and since when (heldSince) so the UI can report a truthful message.
 * Run:  node --test tests/consistency/device-sync-busy.test.js      (from backend/)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const SRC = path.resolve(process.env.CONSISTENCY_SRC || path.join(__dirname, '..', '..', 'src'));
process.env.NODE_PATH = [path.join(__dirname, '..', '..', 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();

const stub = (rel, exports) => {
  const file = require.resolve(path.join(SRC, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
};

const calls = [];
const device = { id: 1, name: 'Gate A', ipAddress: '192.0.2.10', port: 4370, enabled: true, autoSync: true, isArchived: false, branchId: 1, branch: null };
let deviceRow = device;
const prismaFake = new Proxy({}, {
  get: (_t, model) => new Proxy({}, {
    get: (_m, op) => async () => {
      calls.push(`db:${String(model)}.${String(op)}`);
      if (model === 'device' && op === 'findUnique') return deviceRow;
      if (model === 'device' && op === 'findMany') return deviceRow ? [deviceRow] : [];
      return {};
    },
  }),
  $transaction: async (x) => (typeof x === 'function' ? x(prismaFake) : Promise.all(x)),
});
stub('utils/prisma.js', { getPrisma: () => prismaFake, checkDbConnection: async () => true, disconnectPrisma: async () => {}, getLastDbErrorReason: () => null, classifyDbError: () => 'unknown' });
stub('utils/logger.js', { info() {}, warn() {}, error() {}, debug() {}, verbose() {}, log() {} });
stub('services/realtimeListenerService.js', {
  pauseListener: (id) => calls.push(`rt.pause:${id}`), resumeListener: (id) => calls.push(`rt.resume:${id}`),
  startAll() {}, stopAll() {}, refreshAll() {}, startListener() {}, stopListener() {}, restartListener() {},
  getStatus: () => ({}), getAllStatus: () => ({}), getListenerStatus: () => ({}),
});

const gate = require(path.join(SRC, 'services', 'deviceGate.js'));
const zk = require(path.join(SRC, 'services', 'zktecoService.js'));

const reset = () => { calls.length = 0; deviceRow = device; };

test('B1. a device held by a manual-style operation: the skip result names the holder and its start time', async () => {
  reset();
  const lease = gate.tryAcquireExclusive(1, 'users-discovery');
  const held = gate.heldBy(1);
  try {
    const r = await zk.pullLogs(1, null, 'manual');
    assert.equal(r.skipped, true);
    assert.equal(r.skipReason, 'SYNC_ALREADY_RUNNING');
    assert.equal(r.count, 0);
    assert.equal(r.heldBy, 'users-discovery');
    assert.equal(r.heldSince, new Date(held.startedAt).toISOString());
    assert.ok(!Number.isNaN(Date.parse(r.heldSince)));
  } finally { lease.release(); }
});

test('B2. the holder label of an auto sync is reported as such', async () => {
  reset();
  const lease = gate.tryAcquireExclusive(1, 'auto');
  try {
    const r = await zk.pullLogs(1, null, 'manual');
    assert.equal(r.skipReason, 'SYNC_ALREADY_RUNNING');
    assert.equal(r.heldBy, 'auto');
  } finally { lease.release(); }
});

test('B3. reporting does not touch the lock: same owner still holds it, no sync log row, no device session, no listener pause', async () => {
  reset();
  const lease = gate.tryAcquireExclusive(1, 'auto');
  const before = gate.heldBy(1);
  try {
    await zk.pullLogs(1, null, 'manual');
    await zk.pullLogs(1, null, 'manual');
    const after = gate.heldBy(1);
    assert.deepEqual(after, before, 'the holder is unchanged');
    assert.ok(!calls.some((c) => c.startsWith('db:deviceSyncLog.')), 'no sync log row is created for a skipped request');
    assert.ok(!calls.some((c) => c.startsWith('rt.')), 'the realtime listener is neither paused nor resumed by a skipped request');
  } finally { assert.equal(lease.release(), true, 'the original owner can still release its own lock'); }
  assert.equal(gate.heldBy(1), null);
});

test('B4. a device that is not held is NOT reported busy (no heldBy on a disabled-device skip)', async () => {
  reset();
  deviceRow = { ...device, enabled: false };
  const r = await zk.pullLogs(1, null, 'manual');
  assert.equal(r.skipped, true);
  assert.equal(r.skipReason, 'DEVICE_DISABLED');
  assert.equal(r.heldBy, undefined);
  assert.equal(r.heldSince, undefined);
  assert.equal(gate.heldBy(1), null, 'a skipped request never leaves a lock behind');
});

test('B5. sync-all (pullAllDevices) carries heldBy / heldSince through to each busy device result', async () => {
  reset();
  const lease = gate.tryAcquireExclusive(1, 'auto');
  try {
    const results = await zk.pullAllDevices(null, null);
    assert.equal(results.length, 1);
    assert.equal(results[0].deviceId, 1);
    assert.equal(results[0].skipReason, 'SYNC_ALREADY_RUNNING');
    assert.equal(results[0].heldBy, 'auto');
    assert.ok(!Number.isNaN(Date.parse(results[0].heldSince)));
  } finally { lease.release(); }
});

test('B6. guard: the lock code paths are the ones the investigation read (acquire in pullLogs, release only in finally / failed log insert)', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'zktecoService.js'), 'utf8');
  assert.equal((src.match(/deviceGate\.tryAcquireExclusive\(deviceId, triggeredBy\)/g) || []).length, 1, 'pullLogs acquires exactly once');
  assert.equal((src.match(/\breleaseLock\(\)/g) || []).length, 2, 'releaseLock() is called in exactly two places (failed log insert, finally)');
});
