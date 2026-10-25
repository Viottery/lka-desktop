const assert = require('node:assert/strict');
const { create } = require('../app/web/pet/session-history.js');
const row = id => ({ message_id: String(id), role: 'user', content: 'message ' + id });
const ids = payload => payload.messages.map(item => item.message_id);
const page = (values, more = false, reset = '', direction = 'before') => ({ session: { session_id: 's' }, messages: values.map(row),
  message_page: { direction, has_more: more, first_message_id: values.length ? String(values[0]) : null,
    last_message_id: values.length ? String(values.at(-1)) : null, history_reset_at: reset } });
async function main() {
  const requests = [], queue = [page([4, 5], true), page([6, 7], true, '', 'after'), page([8], false, '', 'after'), page([2, 3], true), page([1], false)];
  let scope = 'accountA:hub';
  const store = create({ namespace: () => scope, request: async path => { requests.push(path); return queue.shift(); } });
  assert.deepEqual(ids(await store.load('s')), ['4', '5']);
  assert.equal(requests[0], '/sessions/s?message_limit=30');
  const first = store.load('s'), duplicate = store.load('s');
  assert.equal(first, duplicate);
  assert.deepEqual(ids(await first), ['4', '5', '6', '7', '8']);
  assert.match(requests[1], /after_message_id=5$/); assert.match(requests[2], /after_message_id=7$/);
  assert.equal(store.state('s').hasMore, true);
  assert.deepEqual(ids(await store.load('s', { before: true })), ['2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(ids(await store.load('s', { before: true })), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.equal(store.state('s').hasMore, false);
  assert.match(requests[3], /before_message_id=4$/); assert.match(requests[4], /before_message_id=2$/);
  // Cursor invalidation replaces history with a fresh recent page.
  let count = 0;
  const invalid = create({ request: async path => {
    count++;
    if (count === 1) return page([10], true);
    if (path.includes('after_message_id')) throw Object.assign(new Error('invalid'), { status: 409, detail: 'history_cursor_invalid' });
    return page([20]);
  } });
  await invalid.load('s'); assert.deepEqual(ids(await invalid.load('s')), ['20']); assert.equal(count, 3);
  const resetQueue = [page([1, 2], true), page([3], false, '2026-10-24T12:00:00Z', 'after'), page([3], false, '2026-10-24T12:00:00Z')];
  const reset = create({ request: async () => resetQueue.shift() });
  await reset.load('s'); assert.deepEqual(ids(await reset.load('s')), ['3']);
  assert.equal(reset.state('s').hasMore, false);
  // Clear and account changes reject old in-flight pages without repopulating cache.
  let release;
  const late = create({ namespace: () => scope, request: () => new Promise(resolve => { release = resolve; }) });
  const pending = late.load('s'); await new Promise(resolve => setImmediate(resolve));
  late.clear('s'); release(page([99], true)); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(late.state('s').loaded, false);
  const changed = late.load('s'); await new Promise(resolve => setImmediate(resolve));
  scope = 'accountB:hub'; release(page([99])); await assert.rejects(changed, { name: 'AbortError' });
  assert.equal(late.state('s').loaded, false);
  scope = 'accountA:replica'; assert.equal(store.state('s').loaded, false);
  // Growing an empty cached history must request a recent page, not an after loop.
  const emptyCalls = [], emptyPages = [page([]), page(Array.from({ length: 30 }, (_, index) => index + 6), true)];
  const empty = create({ request: async path => { emptyCalls.push(path); return emptyPages.shift(); } });
  await empty.load('s'); assert.equal((await empty.load('s')).messages.length, 30);
  assert.deepEqual(emptyCalls, ['/sessions/s?message_limit=30', '/sessions/s?message_limit=30']);
  assert.equal(empty.state('s').hasMore, true);
  // Legacy servers keep full history and never show a false earlier-page affordance.
  const legacy = create({ request: async () => ({ session: { session_id: 's' }, messages: [row(1), row(2)] }) });
  assert.deepEqual(ids(await legacy.load('s')), ['1', '2']); assert.deepEqual(ids(await legacy.load('s')), ['1', '2']);
  assert.equal(legacy.state('s').hasMore, false);
  // Automatic recovery stays bounded; an explicit older-page read expands memory.
  let source = Array.from({ length: 30 }, (_, index) => index + 1);
  const bounded = create({ request: async path => {
    const query = new URL(path, 'http://fixture').searchParams;
    const after = query.get('after_message_id'), before = query.get('before_message_id');
    const candidates = source.filter(id => after ? id > Number(after) : before ? id < Number(before) : true);
    return page(after ? candidates.slice(0, 30) : candidates.slice(-30), candidates.length > 30, '', after ? 'after' : 'before');
  } });
  await bounded.load('s'); source = Array.from({ length: 250 }, (_, index) => index + 1);
  const recent = await bounded.load('s');
  assert.equal(recent.messages.length, 180); assert.equal(recent.messages[0].message_id, '71');
  assert.equal(bounded.state('s').hasMore, true);
  assert.equal((await bounded.load('s', { before: true })).messages.length, 210);
  assert.equal((await bounded.load('s')).messages.length, 210);
  // Version-skewed proxies reject new query keys before reaching the backend.
  for (const detail of ['Unsupported workbench request', 'Unsupported cloud request']) {
    const calls = [];
    const proxy = create({ request: async path => {
      calls.push(path);
      if (path.includes('?')) throw Object.assign(new Error(detail), { status: 404, detail });
      return { session: { session_id: 's' }, messages: [row(1)] };
    } });
    await proxy.load('s'); await proxy.load('s');
    assert.deepEqual(calls, ['/sessions/s?message_limit=30', '/sessions/s', '/sessions/s']);
  }
  for (const status of [401, 403, 404]) {
    let attempts = 0;
    const denied = create({ request: async () => { attempts++; throw Object.assign(new Error('denied'), { status, detail: 'session_not_found' }); } });
    await assert.rejects(denied.load('s'), { status }); assert.equal(attempts, 1);
  }
  // Before/after requests serialize so their independent cursors cannot lose messages.
  const parallelQueue = [page([3], true), page([2], true), page([4], false, '', 'after')];
  const parallel = create({ request: async () => parallelQueue.shift() });
  await parallel.load('s'); await Promise.all([parallel.load('s', { before: true }), parallel.load('s')]);
  assert.deepEqual(ids(await parallel.load('s', { before: true, request: async () => page([1], false) })), ['1', '2', '3', '4']);
  console.log('PASS: history recent/before/after paging, deduplication, resets, late responses, account/role isolation and legacy compatibility');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
