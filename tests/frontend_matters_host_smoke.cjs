'use strict';
// Synthetic transport and isolated iframe contract checks; no browser/backend needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.FRONTEND_PET_ROOT || path.resolve(__dirname, '../app/web/pet');
const hostCode = fs.readFileSync(path.join(root, 'matters-host.js'), 'utf8');
const assistantCode = fs.readFileSync(path.join(root, 'matter-assistant-host.js'), 'utf8');
function environment(url, extra = {}) {
  const listeners = new Map(), timers = new Map(), storage = new Map(), fetches = [], elements = [];
  let timerSequence = 0;
  function node(tag) {
    const events = new Map();
    const item = { tagName: tag.toUpperCase(), style: {}, children: [], parentNode: null,
      contentWindow: tag === 'iframe' ? { sent: [], postMessage(data, origin) { this.sent.push({ data, origin }); } } : null,
      addEventListener(type, fn) { events.set(type, fn); },
      emit(type) { if (events.has(type)) events.get(type)(); },
      appendChild(child) { item.children.push(child); child.parentNode = item; return child; },
      removeChild(child) { item.children.splice(item.children.indexOf(child), 1); child.parentNode = null; },
      hasAttribute() { return false; }
    };
    elements.push(item); return item;
  }
  const sandbox = {
    URL, URLSearchParams, Promise, JSON, Date, Math, Object, String, Number, Error, AbortController,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    location: new URL(url), console,
    setTimeout(fn, delay) { const id = ++timerSequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn)); },
    dispatchEvent(event) { for (const fn of [...listeners.get(event.type) || []]) fn(event); },
    localStorage: { getItem(key) { return storage.has(key) ? storage.get(key) : null; }, setItem(key, value) { storage.set(key, String(value)); }, removeItem(key) { storage.delete(key); } },
    fetch: async (url, options) => { fetches.push({ url, options }); return { status: 200, text: async () => '{"ok":true}' }; },
    ...extra
  };
  sandbox.window = sandbox; sandbox.parent = sandbox.parent || sandbox;
  sandbox.document = { body: node('body'), head: node('head'), readyState: 'complete',
    createElement: node, querySelector() { return null; }, getElementById(id) { return elements.find(item => item.id === id) || null; }, addEventListener(type, fn) { sandbox.addEventListener(type, fn); } };
  vm.createContext(sandbox);
  return { sandbox, storage, fetches, elements, timers, node,
    load(code) { vm.runInContext(code, sandbox); },
    emit(type, data = {}) { sandbox.dispatchEvent({ type, ...data }); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const browser = environment('http://127.0.0.1:8780/desktop-pet/matters.html?backend=http%3A%2F%2F127.0.0.1%3A8765');
  browser.load(hostCode);
  const host = browser.sandbox.LkaMatterHost;
  await host.ready;
  assert.equal(host.backend, 'http://127.0.0.1:8780/workbench');
  assert.equal(host.standalone, true);
  const anonymous = host.namespace;
  let authChanges = 0;
  browser.sandbox.addEventListener('lka-matter-auth-changed', () => authChanges++);
  host.setToken('secret-only-in-memory');
  assert.notEqual(host.namespace, anonymous);
  assert.ok(!host.namespace.includes('secret-only-in-memory'));
  assert.equal(browser.storage.size, 0);
  await host.request('/matters', 'POST', { title: 'Synthetic' });
  assert.equal(browser.fetches[0].options.headers.Authorization, 'Bearer secret-only-in-memory');
  browser.sandbox.fetch = async () => ({ status: 409, text: async () => '{"detail":"matter_revision_conflict"}' });
  await assert.rejects(host.request('/matters/task', 'PATCH', {}), error => error.status === 409 && error.detail === 'matter_revision_conflict');
  await assert.rejects(host.request('//external.example/matters'), error => error.status === 0);
  assert.equal(authChanges, 1);
  const remote = environment('https://desktop.example/desktop-pet/matters.html?backend=http%3A%2F%2F127.0.0.1%3A8765');
  remote.load(hostCode); assert.equal(remote.sandbox.LkaMatterHost.backend, 'https://desktop.example/workbench');

  const calls = [], memory = { request(...args) { calls.push(args); return Promise.resolve({ delegated: true }); }, setToken(value) { this.token = value; }, hasToken() { return false; } };
  const workbench = environment('https://desktop.example/desktop-pet/chat.html?mode=work', { LkaChatContext: { get: () => ({ backend: '/workbench', workMode: true }) }, LkaMemory: memory });
  const tokenForm = workbench.node('form'); tokenForm.id = 'memoryTokenForm';
  const tokenInput = workbench.node('input'); tokenInput.id = 'memoryToken'; tokenInput.value = 'form-secret';
  workbench.load(hostCode);
  assert.equal(workbench.sandbox.LkaMatterHost.standalone, false);
  assert.equal(workbench.sandbox.LkaMatterHost.quick, false);
  await workbench.sandbox.LkaMatterHost.request('/matters', 'GET');
  assert.equal(calls[0][0], '/matters'); assert.equal(workbench.fetches.length, 0);
  workbench.sandbox.LkaMatterHost.setToken('new-secret'); assert.equal(memory.token, 'new-secret');
  const firstScope = workbench.sandbox.LkaMatterHost.namespace;
  memory.setToken('project-token');
  const secondScope = workbench.sandbox.LkaMatterHost.namespace;
  assert.notEqual(firstScope, secondScope);
  tokenForm.emit('submit');
  assert.notEqual(workbench.sandbox.LkaMatterHost.namespace, secondScope);

  const native = environment('http://127.0.0.1:8780/desktop-pet/matters.html?native=1&mode=quick');
  native.load(hostCode);
  const nativeHost = native.sandbox.LkaMatterHost;
  let sent;
  const waiting = nativeHost.request('/matters/sync?after=0&limit=200');
  await flush(); assert.equal(native.fetches.length, 0);
  native.sandbox.petBridge = { requestMemory(text) { sent = JSON.parse(text); } };
  native.sandbox.__petMatterBridgeReady(); await flush();
  assert.ok(sent.id.startsWith('memory-')); assert.equal(sent.body, '');
  assert.equal(nativeHost.quick, true);
  native.sandbox.__lkaMemoryBridgeReceive(sent.id, 200, '{"changes":[],"cursor":0,"has_more":false}');
  assert.equal((await waiting).cursor, 0);
  nativeHost.setToken('native-secret');
  const rejected = nativeHost.request('/matters/task', 'PATCH', { expected_revision: 1 }); await flush();
  assert.equal(sent.token, 'native-secret'); assert.equal(JSON.parse(sent.body).expected_revision, 1);
  native.sandbox.__lkaMemoryBridgeReceive(sent.id, 403, '{"detail":"receipt_required"}');
  await assert.rejects(rejected, error => error.status === 403 && error.detail === 'receipt_required');
  const timeout = nativeHost.request('/matters'); await flush();
  const pendingTimer = [...native.timers.values()].find(item => item.delay === 30000);
  pendingTimer.fn(); await assert.rejects(timeout, error => error.status === 0);

  // Parent creates a separate backend session and sends a draft only to its own frame.
  const parent = environment('http://127.0.0.1:8780/desktop-pet/matters.html');
  parent.load(hostCode); const parentHost = parent.sandbox.LkaMatterHost;
  parentHost.setToken('never-put-in-iframe-url');
  parent.sandbox.fetch = async (url, options) => {
    assert.ok(url.endsWith('/managers/default')); assert.equal(options.body, undefined);
    return { status: 200, text: async () => JSON.stringify({ session: { session_id: 'session-isolated', kind: 'manager' }, controller: { session_id: 'session-isolated', revision: 1, status: 'paused' } }) };
  };
  const container = parent.node('div');
  const opened = parentHost.openAssistant(container, { text: '请帮我安排本周任务。', matter: { matter_id: 'matter-selected', revision: 7, title: 'Same title' }, plan: { matter_id: 'plan-selected', revision: 3, title: 'Same title' }, view: 'today', selection: { visibility: 'user', query: '本周' } });
  await flush(); await flush();
  const frame = container.children[0]; assert.ok(frame);
  assert.ok(frame.src.includes('embedded=matter')); assert.ok(!frame.src.includes('never-put-in-iframe-url'));
  frame.emit('load'); const draft = frame.contentWindow.sent[0].data;
  assert.match(draft.text, /请帮我安排本周任务。/); assert.match(draft.text, /matter-selected/); assert.match(draft.text, /当前版本：7/); assert.match(draft.text, /plan-selected/); assert.match(draft.text, /规划版本：3/); assert.match(draft.text, /"visibility":"user"/);
  parent.emit('message', { origin: parent.sandbox.location.origin, source: frame.contentWindow, data: { type: 'lka-matter-assistant-draft-ready', sessionId: 'session-isolated', draftId: draft.draftId } });
  const result = await opened; assert.equal(result.sessionId, 'session-isolated');
  assert.equal(result.controller.status, 'paused', 'opening never activates management');
  parent.sandbox.fetch = async (url, options) => {
    assert.ok(url.endsWith('/managers/session-isolated')); assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(options.body), { expected_revision: 1, status: 'active' });
    return { status: 200, text: async () => JSON.stringify({ controller: { revision: 2, status: 'active' } }) };
  };
  assert.equal((await parentHost.updateAssistantManager('session-isolated', 1, 'active')).controller.revision, 2);
  let finished = 0;
  parent.sandbox.addEventListener('lka-matter-agent-finished', () => finished++);
  const completion = { type: 'lka-matter-agent-finished', sessionId: 'session-isolated' };
  parent.emit('message', { origin: 'https://wrong.example', source: frame.contentWindow, data: completion });
  parent.emit('message', { origin: parent.sandbox.location.origin, source: {}, data: completion });
  assert.equal(finished, 0);
  parent.emit('message', { origin: parent.sandbox.location.origin, source: frame.contentWindow, data: completion }); assert.equal(finished, 1);
  parentHost.closeAssistant(); assert.equal(container.children.length, 0);

  // Compatibility needs explicit disablement or verified legacy OpenAPI capabilities.
  for (const [status, detail] of [[401, 'management_disabled'], [403, 'denied'], [404, 'missing'], [405, 'missing'], [409, 'management_revision_conflict'], [503, 'unavailable']]) {
    const rejectedHost = environment('http://127.0.0.1:8780/desktop-pet/matters.html'); let attempts = [];
    rejectedHost.sandbox.fetch = async url => { attempts.push(url); return { status, text: async () => JSON.stringify({ detail }) }; };
    rejectedHost.load(hostCode);
    await assert.rejects(rejectedHost.sandbox.LkaMatterHost.openAssistant(rejectedHost.node('div'), {}), error => error.status === status);
    assert.equal(attempts.length, status === 404 ? 2 : 1, 'authorization and transport errors never create ordinary sessions');
  }
  const offline = environment('http://127.0.0.1:8780/desktop-pet/matters.html'); let offlineCalls = 0;
  offline.sandbox.fetch = async () => { offlineCalls++; throw Error('offline'); }; offline.load(hostCode);
  await assert.rejects(offline.sandbox.LkaMatterHost.openAssistant(offline.node('div'), {})); assert.equal(offlineCalls, 1);
  const legacy = environment('http://127.0.0.1:8780/desktop-pet/matters.html'); let legacyCalls = [];
  legacy.sandbox.fetch = async (url, options) => {
    legacyCalls.push(url);
    return url.endsWith('/managers/default') ? { status: 409, text: async () => '{"detail":"management_disabled"}' }
      : { status: 200, text: async () => '{"session":{"session_id":"legacy-session"}}' };
  }; legacy.load(hostCode);
  const legacyContainer = legacy.node('div'), legacyOpen = legacy.sandbox.LkaMatterHost.openAssistant(legacyContainer, 'legacy draft');
  await flush(); await flush(); const legacyFrame = legacyContainer.children[0]; legacyFrame.emit('load');
  const legacyDraft = legacyFrame.contentWindow.sent[0].data;
  legacy.emit('message', { origin: legacy.sandbox.location.origin, source: legacyFrame.contentWindow, data: { type: 'lka-matter-assistant-draft-ready', sessionId: 'legacy-session', draftId: legacyDraft.draftId } });
  assert.equal((await legacyOpen).controller, null); assert.equal(legacyCalls.length, 2); legacy.sandbox.LkaMatterHost.closeAssistant();

  // Old servers retain the original Matter helper only after capability evidence.
  for (const [schema, compatible] of [
    [{ paths: { '/sessions': { post: {} }, '/agent/turn': { post: {} } } }, true],
    [{ paths: { '/sessions': { post: {} }, '/agent/turn': { post: {} }, '/managers/default': { post: {} } } }, false],
    [{ paths: {} }, false], [null, false]
  ]) {
    const old = environment('http://127.0.0.1:8780/desktop-pet/matters.html'); const calls = [];
    old.sandbox.fetch = async (url, options) => { calls.push(url); return url.endsWith('/managers/default') ? { status: 404, text: async () => '{"detail":"Not Found"}' } : url.endsWith('/openapi.json') ? { status: 200, text: async () => JSON.stringify(schema) } : { status: 200, text: async () => '{"session":{"session_id":"old-helper"}}' }; };
    old.load(hostCode); const container = old.node('div'), opening = old.sandbox.LkaMatterHost.openAssistant(container, {});
    if (!compatible) { await assert.rejects(opening, e => e.status === 404); assert.equal(calls.length, 2); continue; }
    await flush(); await flush(); const frame = container.children[0]; frame.emit('load'); const draft = frame.contentWindow.sent[0].data;
    old.emit('message', { origin: old.sandbox.location.origin, source: frame.contentWindow, data: { type: 'lka-matter-assistant-draft-ready', sessionId: 'old-helper', draftId: draft.draftId } });
    assert.equal((await opening).controller, null); assert.equal(calls.length, 3); old.sandbox.LkaMatterHost.closeAssistant();
  }

  // Child storage stays in memory, waits for the target session, and never submits.
  const messages = [], prepared = [];
  const child = environment('http://127.0.0.1:8780/desktop-pet/chat.html?mode=work&embedded=matter&session_id=session-isolated', { parent: { postMessage(data, origin) { messages.push({ data, origin }); } } });
  child.storage.set('agentic-rag-pet-chat-active-session-v4', 'main-session');
  child.storage.set('agentic-rag-pet-chat-sessions-v4-draft-main-session', 'Keep my main draft');
  child.storage.set('agentic-rag-pet-run-settings-v1', JSON.stringify({ workspace: '/main-workspace', model: 'synthetic-model' }));
  child.load(assistantCode);
  assert.equal(child.sandbox.localStorage.getItem('agentic-rag-pet-chat-active-session-v4'), null);
  assert.equal(JSON.parse(child.sandbox.localStorage.getItem('agentic-rag-pet-run-settings-v1')).workspace, undefined);
  child.sandbox.localStorage.setItem('agentic-rag-pet-chat-active-session-v4', 'session-isolated');
  child.sandbox.localStorage.setItem('assistant-draft', 'Only in memory');
  assert.equal(child.storage.get('agentic-rag-pet-chat-active-session-v4'), 'main-session');
  assert.equal(child.storage.get('agentic-rag-pet-chat-sessions-v4-draft-main-session'), 'Keep my main draft');
  assert.equal(child.storage.has('assistant-draft'), false);
  const childDraft = { type: 'lka-matter-assistant-draft', sessionId: 'session-isolated', draftId: 'draft-one', text: 'Draft, never auto-send' };
  child.emit('message', { origin: child.sandbox.location.origin, source: child.sandbox.parent, data: childDraft });
  assert.equal(prepared.length, 0);
  child.sandbox.LkaChatContext = { get: () => ({ sessionId: 'session-isolated' }), prepareMatterDraft(text) { prepared.push(text); } };
  child.emit('lka-session-context', { detail: { sessionId: 'session-isolated' } });
  assert.deepEqual(prepared, ['Draft, never auto-send']);
  child.emit('message', { origin: child.sandbox.location.origin, source: child.sandbox.parent, data: childDraft });
  assert.equal(prepared.length, 1);
  child.emit('message', { origin: 'https://wrong.example', source: child.sandbox.parent, data: { ...childDraft, draftId: 'evil' } });
  assert.equal(prepared.length, 1);
  child.emit('lka-agent-turn-finished', { detail: { sessionId: 'main-session' } });
  child.emit('lka-agent-turn-finished', { detail: { sessionId: 'session-isolated' } });
  assert.equal(messages.filter(item => item.data.type === 'lka-matter-agent-finished').length, 1);
  console.log('Matter host transport, native readiness, auth scope, and isolated assistant contracts passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
