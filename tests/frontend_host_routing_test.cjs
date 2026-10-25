'use strict';
// Deterministic routing/identity contracts, with only synthetic credentials/data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../app/web/pet');
const code = fs.readFileSync(path.join(root, 'lka-host.js'), 'utf8');
const matterCode = fs.readFileSync(path.join(root, 'matters-host.js'), 'utf8');
function fixture({ role = 'replica', mode = 'local', loggedIn = true, infoFails = false, statusFails = false } = {}) {
  const calls = [], bridge = [], timers = new Map(), events = new Map(), storage = new Map();
  const state = { role, mode, loggedIn, infoFails, statusFails, unauthorized: false, stalled: false };
  let timerId = 0, host;
  const classes = { add() {}, toggle() {}, contains() { return false; } };
  const sandbox = { URL, URLSearchParams, Headers, Response, Request, AbortController, console,
    location: new URL('http://127.0.0.1:8780/desktop-pet/matters.html?native=1'),
    document: { documentElement: { classList: classes }, body: { classList: classes, hasAttribute: () => true }, addEventListener() {} },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    sessionStorage: { getItem() {}, setItem() {}, removeItem() {} },
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval() {},
    addEventListener(type, fn) { if (!events.has(type)) events.set(type, []); events.get(type).push(fn); },
    removeEventListener() {}, dispatchEvent(event) { for (const fn of events.get(event.type) || []) fn(event); },
    fetch: async (input, init = {}) => {
      const url = String(input); calls.push({ url, init });
      if (url === '/cloud-auth/status') {
        if (state.stalled) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('probe aborted'))));
        if (state.statusFails) throw new Error('status offline');
        return Response.json({ client_mode: state.mode, configured: true, logged_in: state.loggedIn, origin: 'https://synthetic.invalid', account: state.loggedIn ? { user_id: 'owner' } : null });
      }
      if (url === '/workbench/client/info') return Response.json({ role: state.role }, { status: state.infoFails ? 503 : 200 });
      if (state.unauthorized && url.startsWith('/cloud/')) return Response.json({ detail: 'expired' }, { status: 401 });
      return Response.json({ ok: true });
    },
    petBridge: { requestMemory(raw) { const item = JSON.parse(raw); bridge.push(item); sandbox.__lkaMemoryBridgeReceive(item.id, 200, '{"bridge":true}'); } }
  };
  sandbox.window = sandbox; sandbox.parent = sandbox;
  vm.createContext(sandbox); vm.runInContext(code, sandbox); host = sandbox.LkaHost;
  vm.runInContext(matterCode, sandbox);
  return { sandbox, host, matter: sandbox.LkaMatterHost, state, calls, bridge, timers };
}
(async () => {
  const html = fs.readFileSync(path.join(root, 'matters.html'), 'utf8');
  assert(html.indexOf('./lka-host.js') >= 0 && html.indexOf('./lka-host.js') < html.indexOf('./matters-host.js'), 'standalone loads routing before matter host');
  const replica = fixture({ infoFails: true });
  await replica.matter.ready;
  assert.equal(replica.host.backendRole, 'unknown');
  await assert.rejects(replica.matter.request('/matters', 'POST', { title: 'synthetic' }), e => e.status === 503);
  assert.equal(replica.bridge.length, 0, 'unknown ownership cannot fall back to native writes');
  const unknownNamespace = replica.matter.namespace;
  replica.state.infoFails = false;
  const refreshing = replica.host.refreshCloud();
  const writing = replica.matter.request('/matters', 'POST', { title: 'synthetic' });
  await refreshing; await writing;
  assert.equal(replica.host.backendRole, 'replica');
  assert.equal(replica.host.cloudRouting, true);
  assert.equal(replica.host.routesViaCloud('/matters'), true);
  assert(replica.calls.some(c => c.url === '/cloud/matters' && c.init.method === 'POST'));
  assert.equal(replica.matter.namespace, unknownNamespace, 'role recovery retains the known cloud account cache');
  await replica.matter.request('/sessions/ordinary');
  assert.equal(replica.bridge.length, 1, 'ordinary replica session retains native bridge');
  replica.host.rememberCloudSession('manager-owned');
  replica.state.unauthorized = true;
  await assert.rejects(replica.matter.request('/matters', 'PATCH', {}), e => e.status === 401);
  replica.state.loggedIn = false;
  await replica.host.refreshCloud();
  assert.notEqual(replica.matter.namespace, unknownNamespace, 'signed-out cache is isolated from the account');
  const cloudCalls = replica.calls.filter(c => c.url === '/cloud/matters').length;
  await assert.rejects(replica.matter.request('/matters', 'POST', {}), e => e.status === 503);
  await assert.rejects(replica.matter.request('/sessions/manager-owned', 'PATCH', {}), e => e.status === 503);
  assert.equal(replica.bridge.length, 1, 'expired cloud requests never fall back to native');
  assert.equal(replica.calls.filter(c => c.url === '/cloud/matters').length, cloudCalls);
  replica.state.loggedIn = true; replica.state.unauthorized = false;
  await replica.host.refreshCloud(); await replica.matter.request('/matters');
  assert.equal(replica.host.cloudRouting, true, 'same page recovers after login');

  const local = fixture({ role: 'local' }); await local.matter.ready;
  await local.matter.request('/matters', 'POST', {});
  assert.equal(local.bridge.length, 1, 'local backend preserves native matter transport');
  assert.equal(local.host.cloudRouting, false);

  const cloud = fixture({ mode: 'cloud', role: 'hub' }); await cloud.matter.ready;
  await cloud.matter.request('/matters'); await cloud.matter.request('/sessions/ordinary');
  assert.equal(cloud.bridge.length, 0, 'pure cloud client never calls local Java transport');
  assert(cloud.calls.some(c => c.url === 'http://127.0.0.1:8780/workbench/sessions/ordinary'));
  cloud.state.statusFails = true; cloud.state.infoFails = true;
  await cloud.host.refreshCloud();
  assert.equal(cloud.host.clientMode, 'cloud', 'transient status failure keeps deployment mode');
  await cloud.matter.request('/matters', 'POST', {});
  assert.equal(cloud.bridge.length, 0, 'disconnected cloud client cannot become a local client');

  const stalled = fixture(); await stalled.host.ready;
  stalled.state.stalled = true;
  const retry = stalled.host.refreshCloud();
  const probeTimer = [...stalled.timers.values()].find(t => t.delay === 6000);
  assert(probeTimer, 'identity probe has a bounded deadline'); probeTimer.fn();
  await retry;
  assert.equal(stalled.host.cloudRouting, false, 'stalled probe settles and disables authenticated routing');
  console.log('PASS standalone/native routing: role retry, local/replica/cloud-only, expired login, bounded readiness, isolated caches');
})().catch(error => { console.error(error); process.exitCode = 1; });
