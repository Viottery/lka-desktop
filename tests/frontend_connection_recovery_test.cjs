'use strict';
// Execute the production turn/reconnect functions with synthetic HTTP/SSE only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../app/web/pet/chat.js'), 'utf8');
function production(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert(start >= 0, name);
  const tail = source.slice(start + 1), next = tail.search(/^  (?:async )?function /m);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}
function fixture() {
  const session = { id: 'synthetic', messages: [], timelineState: 'running', runControlStatus: 'running', multiAgentRunId: 'run-original', multiAgentSequence: 27 };
  const calls = [], events = [], deliveries = [], notices = [];
  const noop = () => {};
  const ctx = {
    console: { log: noop }, AbortController, TextDecoder, Date, Math, JSON, Promise, encodeURIComponent,
    session, sessions: [session], calls, events, deliveries, notices,
    activeSessionId: session.id, activeAgentTurnGeneration: 0, managerEmbedding: false, managerPendingTurns: {}, managerStreams: {},
    nativeTurnGenerations: {}, nativeStreamCallbacks: {}, activeAgentEventController: null, pendingState: null, backendOffline: false, backendBaseUrl: 'http://synthetic',
    assistantCacheEpoch: 0, runCursorKeyPrefix: 'cursor-', liveAnswers: {}, runProcesses: {}, timelineViewKey: '',
    runSettings: { stream: true, safetyMode: 'backend' }, workspaceSwitchPromise: Promise.resolve(true),
    runStatusRequestInFlight: false, lkaHost: null, replacementCommands: {}, suspendedTurns: {},
    localStorage: { removeItem: noop }, isManagerSession: () => false, getSessionById: id => id === session.id ? session : null, getActiveSession: () => session,
    safeText: value => value == null ? '' : String(value), setRunStatus: value => notices.push(value), setComposerDisabled: noop,
    persistSessions: noop, renderActiveMessages: noop, renderRunControls: noop, renderSessionList: noop, touchSession: noop,
    pinSessionToTop: noop, applySessionTitle: noop, scrollMessagesToBottom: noop, focusComposer: noop,
    ensureLiveRunOutput: () => ({ querySelector: () => ({}) }), saveRunSettings: noop, ensureSessionWorkspace: noop,
    bindSessionWorkspace: async () => session.id, modelOverridesAllowed: () => false, requestReasoningLevel: () => '',
    sendAgentStreamViaDesktopBridge: () => false, sendAgentTurnViaDesktopBridge: () => false,
    isMultiAgentRefreshEvent: () => false, isApprovalQueueRefreshEvent: () => false, refreshSafetyReviewQueue: noop,
    fetchMultiAgentSnapshot: noop, saveRunCursor: noop, reconcileCompletedSession: async () => {},
    recordRunEvent: (s, name) => { events.push(name); if (name === 'run_failed') s.timelineState = 'failed'; },
    addMessageToSession: (s, role, text, error, extra) => s.messages.push({ role, text, error, ...extra }),
    isBackendOfflineError: () => false, setBackendOfflineState: noop,
    applyRunSnapshot: (s, run) => { s.runControlStatus = run.status; s.timelineState = run.status === 'completed' ? 'completed' : 'running'; },
    settlePausedRun: s => { s.runControlStatus = 'paused'; }, settleCancelledRun: s => { s.runControlStatus = 'cancelled'; },
    rememberStreamPosition: (s, data) => { if (data.run_id) s.multiAgentRunId = data.run_id; return s; },
    handleStreamEvent: (name, data, state) => { if (['run_completed', 'run_failed', 'run_cancelled', 'run_timed_out'].includes(name)) { state.terminal = true; state.terminalStatus = name.slice(4); } },
    window: { setTimeout, clearTimeout, requestAnimationFrame: fn => fn(), __petChatReceive: result => deliveries.push(result), LkaImageComposer: {
      hasAttachments: () => false, hasDocuments: () => false, hasAudios: () => false, capture: () => [], prepare: async () => [], normalize: x => x
    } }
  };
  vm.createContext(ctx);
  for (const name of ['agentTurnError', 'callAgentTurn', 'callAgentTurnStream', 'turnIsCurrent', 'abortActiveAgentEventStream', 'isTerminalRunStatus', 'readSavedRunStatus', 'consumeSavedRunEventStream', 'preserveUncertainTurn', 'recoverUncertainSubmission', 'handleNativeUncertainTurn', 'finishReconnectedTurn', 'reconnectSavedRun', 'refreshActiveRunState', 'sendQuestion']) vm.runInContext(production(name), ctx);
  ctx.waitForReconnectRetry = async () => true;
  ctx.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    throw new TypeError('synthetic connection lost');
  };
  return ctx;
}
function streamResponse(text) {
  let read = false;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: Buffer.from(text) }), cancel: async () => {} }) } };
}
(async () => {
  for (const mode of ['throw', 'empty']) {
    const c = fixture();
    c.fetch = async (url, options = {}) => { c.calls.push({ url, method: options.method || 'GET', body: options.body }); if (mode === 'throw') throw new TypeError('connection lost after acceptance'); return streamResponse(''); };
    await c.sendQuestion('perform the synthetic task');
    assert.equal(c.session.connectionUncertain, true, mode);
    assert.equal(c.session.timelineState, 'running');
    assert.equal(c.session.multiAgentRunId, '');
    assert(!c.events.includes('run_failed'));
    assert.equal(c.deliveries.length, 0, 'no invented failure or empty success');
    assert.equal(c.session.messages.filter(m => m.role === 'assistant').length, 0);
    assert.equal(c.calls.filter(x => x.method === 'POST').length, 1, 'never resend ambiguous POST');
    assert.equal(JSON.parse(c.calls.find(x => x.method === 'POST').body).client_request_id, c.session.pendingClientRequestId);
    await c.sendQuestion('manual duplicate');
    assert.equal(c.calls.filter(x => x.method === 'POST').length, 1, 'uncertain turn cannot be manually duplicated');
  }
  {
    const c = fixture(), turn = { generation: 0, events: [], answer: '' };
    await c.reconnectSavedRun(c.session, turn);
    assert.equal(c.session.connectionUncertain, true);
    assert.equal(c.session.multiAgentRunId, 'run-original');
    assert.equal(c.session.multiAgentSequence, 27);
    assert.equal(c.session.timelineState, 'running');
    assert.equal(c.deliveries.length, 0);
    c.fetch = async url => { c.calls.push({ url, method: 'GET' }); return { ok: true, json: async () => ({ run_id: 'run-original', status: 'completed' }) }; };
    await c.refreshActiveRunState();
    assert.equal(c.session.connectionUncertain, false);
    assert.deepEqual(c.events, ['run_completed']);
    await c.refreshActiveRunState();
    assert.deepEqual(c.events, ['run_completed'], 'completion occurs once');
    assert(c.calls.every(x => x.method === 'GET'));
  }
  for (const status of ['failed', 'timed_out', 'cancelled']) {
    const c = fixture();
    c.consumeSavedRunEventStream = async () => ({ terminalStatus: status });
    await c.reconnectSavedRun(c.session, { generation: 0, events: [], answer: '' });
    if (status === 'cancelled') assert.equal(c.session.runControlStatus, status);
    else assert.match(c.deliveries[0].error, new RegExp(status));
  }
  for (const status of [401, 403]) {
    const c = fixture();
    c.fetch = async (url, options = {}) => { c.calls.push({ url, method: options.method || 'GET' }); return { ok: false, status, statusText: 'Forbidden', text: async () => '' }; };
    await c.reconnectSavedRun(c.session, { generation: 0, events: [] });
    assert.equal(c.calls.filter(x => x.url.includes('/stream')).length, 1, 'no authentication retry loop');
    assert.match(c.session.controlNotice, /登录和访问权限/);
    assert.equal(c.deliveries.length, 0);
  }
  {
    const c = fixture();
    c.fetch = async (url, options) => {
      c.calls.push({ url, method: options.method, body: JSON.parse(options.body) });
      return { ok: true, text: async () => JSON.stringify({ session_id: c.session.id, answer: 'verified' }) };
    };
    await c.callAgentTurn({ session_id: c.session.id, question: 'text compatibility', client_request_id: 'stable-text-request' });
    assert.equal(c.calls[0].body.client_request_id, 'stable-text-request');
    assert.equal(c.calls.length, 1);
  }
  for (const responseKind of ['exact', 'unrelated', 'ambiguous', 'old-server']) {
    const c = fixture();
    c.session.multiAgentRunId = ''; c.session.connectionUncertain = true; c.session.pendingClientRequestId = 'request-ours';
    let followed = '';
    c.reconnectSavedRun = async s => { followed = s.multiAgentRunId; };
    c.fetch = async url => {
      c.calls.push({ url, method: 'GET' });
      const run = { run_id: 'recovered-original', session_id: c.session.id, client_request_id: responseKind === 'unrelated' ? 'request-other-device' : 'request-ours', status: 'running' };
      if (responseKind === 'old-server') delete run.client_request_id;
      return { ok: true, json: async () => ({ session_id: c.session.id, runs: responseKind === 'ambiguous' ? [run, { ...run, run_id: 'second-run' }] : [run], next_offset: null }) };
    };
    await c.recoverUncertainSubmission(c.session, null);
    assert.equal(followed, responseKind === 'exact' ? 'recovered-original' : '', responseKind);
    assert(c.calls.every(x => x.method === 'GET' && x.url.includes('client_request_id=request-ours')));
    assert(c.calls.length <= 2);
  }
  {
    const c = fixture();
    await c.sendQuestion('accepted before connection vanished');
    const requestId = c.session.pendingClientRequestId;
    assert(requestId, 'uncertain request correlation survives outage');
    let followed = '';
    c.reconnectSavedRun = async s => { followed = s.multiAgentRunId; };
    c.fetch = async url => {
      c.calls.push({ url, method: 'GET' });
      return { ok: true, json: async () => ({ session_id: c.session.id, runs: [{ run_id: 'original-after-outage', session_id: c.session.id, client_request_id: requestId, status: 'running' }], next_offset: null }) };
    };
    await c.refreshActiveRunState();
    assert.equal(followed, 'original-after-outage');
    assert.equal(c.session.pendingClientRequestId, '');
    assert.equal(c.calls.filter(x => x.method === 'POST').length, 1);
    assert.equal(c.deliveries.length, 0);
  }
  for (const observedRun of ['', 'native-observed-run']) {
    const c = fixture();
    c.session.multiAgentRunId = ''; c.session.pendingClientRequestId = 'native-request-ours';
    const start = source.indexOf('  window.__petChatReceive = function (result) {');
    const end = source.indexOf('\n  if (form) {', start);
    vm.runInContext(source.slice(start, end), c);
    let followed = '';
    c.reconnectSavedRun = async s => { followed = s.multiAgentRunId; };
    c.fetch = async url => {
      c.calls.push({ url, method: 'GET' });
      return { ok: true, json: async () => ({ session_id: c.session.id, runs: [{ run_id: 'native-reconciled-run', session_id: c.session.id, client_request_id: 'native-request-ours', status: 'running' }], next_offset: null }) };
    };
    c.window.__petChatReceive({ error: 'Native network response unavailable', transport_uncertain: true, session_id: c.session.id,
      client_request_id: 'native-request-ours', run_id: observedRun });
    await new Promise(setImmediate);
    assert.equal(followed, observedRun || 'native-reconciled-run');
    assert(!c.events.includes('run_failed'));
    assert.equal(c.session.messages.length, 0, 'native transport callback creates no error bubble');
    assert(c.calls.every(x => x.method === 'GET'));
  }
  {
    const c = fixture();
    c.session.multiAgentRunId = ''; c.session.pendingClientRequestId = 'new-native-request';
    await c.handleNativeUncertainTurn({ transport_uncertain: true, session_id: c.session.id, client_request_id: 'old-native-request', run_id: 'old-native-run' });
    assert.equal(c.session.connectionUncertain, undefined, 'stale native callback cannot disturb current turn');
    assert.equal(c.session.multiAgentRunId, '');
    assert.equal(c.calls.length, 0);
  }
  console.log('Connection recovery regressions passed (synthetic transport, no network/model calls).');
})().catch(error => { console.error(error); process.exitCode = 1; });
