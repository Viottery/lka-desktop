const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app/web/pet/matter-store.js'), 'utf8');
function memoryStorage() {
  const values = new Map();
  return { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k), values };
}
function environment(sharedChannels) {
  const handlers = new Map();
  const window = { addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  if (sharedChannels) window.BroadcastChannel = class {
    constructor(name) { this.name = name; sharedChannels.add(this); }
    postMessage(data) { for (const other of sharedChannels) if (other !== this && other.name === this.name && other.onmessage) other.onmessage({ data: structuredClone(data) }); }
    close() { sharedChannels.delete(this); }
  };
  vm.runInNewContext(source, { window });
  return { create: window.LkaMatterStore.create, storageEvent: event => handlers.get('storage')?.(event) };
}
const record = (matter_id, revision = 1, fields = {}) => ({ matter_id, revision, kind: 'action', status: 'open', title: matter_id, ...fields });
const page = (rows, cursor = rows.length, has_more = false) => ({ changes: rows.map((matter, i) => ({ sequence: i + 1, matter })), cursor, has_more });
const plain = value => JSON.parse(JSON.stringify(value));
async function main() {
  const storage = memoryStorage(), env = environment();
  let time = 1000, requests = [];
  const responses = [page([record('p', 1, { kind: 'plan', progress: { total: 999 } }), record('a', 1, { parent_matter_id: 'p' })], 2, true), page([record('a', 2, { parent_matter_id: 'p', status: 'done' }), record('b', 1, { parent_matter_id: 'p', status: 'cancelled' })], 4)];
  const store = env.create({ namespace: 'backend-user', storage, now: () => time, request: async path => { requests.push(path); return responses.shift(); } });
  assert.equal(store.hydrate().ready, false);
  const first = store.sync();
  assert.equal(store.sync({ force: true }), first, 'concurrent sync is deduplicated');
  await first;
  assert.deepEqual(requests, ['/matters/sync?after=0&limit=200', '/matters/sync?after=2&limit=200']);
  assert.deepEqual(plain(store.get('p').progress), { total: 2, done: 1, cancelled: 1 });
  assert.equal(store.all().length, 3);
  await store.sync(); await store.sync();
  assert.equal(requests.length, 2, 'fresh cache makes zero extra requests');
  store.saveView({ selected: 'a', calendar: '2026-10', scroll: 22 });
  store.dispose();
  let reopeningRequests = 0;
  const reopened = env.create({ namespace: 'backend-user', storage, now: () => time, request: async () => { reopeningRequests++; throw Error('offline'); } });
  assert.equal(reopened.hydrate().ready, true);
  assert.equal(reopened.get('a').status, 'done');
  assert.equal(reopened.view().scroll, 22);
  await reopened.sync(); assert.equal(reopeningRequests, 0, 'reopen persists freshness');
  time += 60000;
  await assert.rejects(reopened.sync(), /offline/);
  assert.equal(reopened.hydrate().ready, true);
  assert.equal(reopened.get('a').status, 'done');
  assert.equal(reopened.hydrate().error, 'offline');
  await assert.rejects(reopened.sync({ force: true }), /offline/);
  assert.equal(reopeningRequests, 2);
  reopened.dispose();

  const bad = env.create({ namespace: 'unknown', storage, request: async () => { throw Error('unknown'); } });
  await assert.rejects(bad.sync()); assert.equal(bad.hydrate().ready, false);
  bad.dispose();
  const partialResponses = [page([record('partial')], 1, true), null];
  const partial = env.create({ namespace: 'partial', storage, request: async () => partialResponses.shift() });
  await assert.rejects(partial.sync()); assert.equal(partial.hydrate().ready, false); partial.dispose();
  let restartPath;
  const restarted = env.create({ namespace: 'partial', storage, request: async path => { restartPath = path; return page([record('partial')]); } });
  await restarted.sync(); assert.match(restartPath, /after=0&/); restarted.dispose();

  const mutationStorage = memoryStorage(); let finishFetch, calls = [];
  const newer = record('a', 4, { status: 'done', parent_matter_id: 'p' });
  const mutation = env.create({ namespace: 'mutations', storage: mutationStorage, now: () => 100, request: (path, method, body) => {
    calls.push({ path, method, body });
    if (method) return Promise.resolve({ matter: newer });
    return new Promise(resolve => { finishFetch = resolve; });
  } });
  const fetching = mutation.sync();
  await mutation.mutate('/matters/a', 'PATCH', { status: 'done', expected_revision: 3 });
  finishFetch(page([record('a', 3), record('p', 1, { kind: 'plan', progress: { total: 200 } })], 2));
  await fetching;
  assert.equal(mutation.get('a').revision, 4, 'older in-flight result cannot regress mutation');
  assert.deepEqual(plain(mutation.get('p').progress), { total: 1, done: 1, cancelled: 0 });
  assert.equal(calls.length, 2, 'mutation does not reload list');
  await mutation.mutate('/matters/a', 'PATCH', { status: 'done' });
  assert.equal(calls.length, 3);
  mutation.invalidate();
  const refresh = mutation.sync(); finishFetch(page([], 2)); await refresh;
  assert.equal(calls.length, 4, 'invalidation bypasses fresh TTL');
  mutation.dispose();

  const channels = new Set(), crossStorage = memoryStorage(), leftEnv = environment(channels), rightEnv = environment(channels);
  let leftCalls = 0;
  const left = leftEnv.create({ namespace: 'shared', storage: crossStorage, now: () => 10, request: async (path, method) => { leftCalls++; return method ? record('shared', 3, { status: 'done' }) : page([record('shared')]); } });
  const right = rightEnv.create({ namespace: 'shared', storage: crossStorage, now: () => 10, request: async () => { throw Error('must use broadcast'); } });
  let notifications = 0; const unsubscribe = right.subscribe(() => { notifications++; });
  await left.sync(); assert.equal(right.hydrate().ready, true); await right.sync();
  await left.mutate('/matters/shared', 'PATCH', { status: 'done' });
  assert.equal(right.get('shared').revision, 3); assert.equal(leftCalls, 2); assert.ok(notifications >= 2);
  left.invalidate(); assert.equal(right.hydrate().stale, true, 'same timestamp invalidations cross windows');
  unsubscribe(); left.dispose(); right.dispose(); assert.equal(channels.size, 0);

  const fallbackStorage = memoryStorage(), fallbackEnv = environment();
  const fallback = fallbackEnv.create({ namespace: 'fallback', storage: fallbackStorage, request: async () => page([]) });
  fallbackEnv.storageEvent({ key: 'lka.matters.v2:fallback', newValue: JSON.stringify({ schema: 2, records: [record('storage', 5)], ready: true, cursor: 5, updatedAt: Date.now() }) });
  assert.equal(fallback.get('storage').revision, 5);
  fallbackEnv.storageEvent({ key: 'lka.matters.v2:fallback', newValue: JSON.stringify({ schema: 2, records: [record('storage', 2)], ready: true, cursor: 2, updatedAt: 1 }) });
  assert.equal(fallback.get('storage').revision, 5); fallback.dispose();

  const invalidationEnv = environment();
  let finishOlderSync, invalidationCalls = 0;
  const invalidatedDuringSync = invalidationEnv.create({ namespace: 'pending-invalidation', storage: null, now: () => 300,
    request: () => {
      invalidationCalls++;
      return invalidationCalls === 1 ? new Promise(resolve => { finishOlderSync = resolve; }) : Promise.resolve(page([], 1));
    }
  });
  const remoteEnvelope = (updatedAt, dirty) => ({ key: 'lka.matters.v2:pending-invalidation', newValue: JSON.stringify({
    schema: 2, records: [record('remote')], ready: true, cursor: 1, updatedAt, dirty
  }) });
  invalidationEnv.storageEvent(remoteEnvelope(100, false));
  const olderForceSync = invalidatedDuringSync.sync({ force: true });
  invalidationEnv.storageEvent(remoteEnvelope(200, true));
  assert.equal(invalidatedDuringSync.hydrate().stale, true, 'newer remote invalidation marks an in-flight refresh stale');
  finishOlderSync(page([], 1));
  await olderForceSync;
  assert.equal(invalidatedDuringSync.hydrate().stale, true, 'earlier force sync cannot clear a newer remote invalidation');
  await invalidatedDuringSync.sync();
  assert.equal(invalidationCalls, 2, 'retained remote invalidation bypasses fresh TTL for the next sync');
  assert.equal(invalidatedDuringSync.hydrate().stale, false, 'a sync begun after the invalidation restores freshness');
  invalidatedDuringSync.dispose();

  // Visibility transitions retain identity and revisions in raw storage while user projections stay clean.
  const visibilityStorage = memoryStorage();
  visibilityStorage.setItem('lka.matters.v1:visibility', JSON.stringify({ schema: 1, records: [record('old')], ready: true, cursor: 100, updatedAt: Date.now() }));
  let visibilityCalls = [], batches = [page([record('plan', 1, { kind: 'plan' }), record('legacy', 1, { parent_matter_id: 'plan', status: 'done' }), record('hidden', 1, { parent_matter_id: 'plan', visibility: 'internal', status: 'done' })], 3), page([record('legacy', 2, { parent_matter_id: 'plan', visibility: 'internal' }), record('hidden', 2, { parent_matter_id: 'plan', visibility: 'user' })], 5)];
  const visibility = env.create({ namespace: 'visibility', storage: visibilityStorage, request: async path => { visibilityCalls.push(path); return batches.shift(); } });
  assert.equal(visibility.hydrate().ready, false, 'v1 coverage is not trusted');
  await visibility.sync();
  assert.match(visibilityCalls[0], /after=0&/);
  assert.deepEqual(plain(visibility.select()).map(r => r.matter_id), ['plan', 'legacy']);
  assert.equal(visibility.hydrate().records.length, 2);
  assert.equal(visibility.select({ visibility: 'internal' })[0].matter_id, 'hidden');
  assert.equal(visibility.select({ visibility: 'all' }).length, 3);
  assert.deepEqual(plain(visibility.get('plan').progress), { total: 1, done: 1, cancelled: 0 });
  assert.deepEqual(plain(visibility.select({ visibility: 'all' })[0].progress), { total: 1, done: 1, cancelled: 0 }, 'expansion cannot change user progress');
  await visibility.sync({ force: true });
  assert.deepEqual(plain(visibility.select()).map(r => r.matter_id), ['plan', 'hidden']);
  assert.equal(visibility.all().length, 3);
  assert.equal(visibility.get('legacy').revision, 2);
  assert.deepEqual(plain(visibility.get('plan').progress), { total: 1, done: 0, cancelled: 0 });
  assert.throws(() => visibility.select({ visibility: 'unknown' }), /Invalid/);
  assert.equal(JSON.parse(visibilityStorage.getItem('lka.matters.v2:visibility')).records.length, 3);
  visibility.dispose();

  const quotaStorage = { getItem: () => null, setItem: () => { throw Error('quota'); }, removeItem() {} };
  const quota = env.create({ namespace: 'quota', storage: quotaStorage, request: async () => page([record('memory')]) });
  await quota.sync(); assert.equal(quota.get('memory').matter_id, 'memory'); assert.equal(quota.hydrate().ready, true); quota.dispose();
  assert.ok([...storage.values.keys()].every(key => !key.includes('token')));
  assert.ok([...storage.values.values()].every(value => !value.includes('request') && !value.includes('Authorization')));
  console.log('matter_store_test: all assertions passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
