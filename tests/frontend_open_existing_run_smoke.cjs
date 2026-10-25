'use strict';
// Open existing conversations and discover/replay their current durable root run.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = path.resolve(__dirname, '../app/web/pet');
const requests = [], errors = [], streams = new Map();
const stamp = new Date().toISOString();
const sessions = new Map();
const runs = new Map();
const runEvents = new Map();
const statuses = new Map();
let holdRunListFor = '', releaseHeldRunList = null;
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
function session(id, title, remote) {
  return { session_id: id, kind: 'ordinary', title, created_at: stamp, updated_at: stamp,
    metadata: { creation_source: 'assistant', remote_execution: remote || undefined },
    workspace: { path: '/synthetic/work' } };
}
function addEvent(id, type, sequence, message, payload = {}) {
  const event = { run_id: id, sequence, status: statuses.get(id) || 'running', message, payload, created_at: stamp };
  runEvents.get(id).push({ type, event });
  const res = streams.get(id);
  if (res && !res.destroyed && !res.writableEnded) writeEvent(res, id, type, event);
}
function writeEvent(res, id, type, event) {
  if (!res || res.destroyed || res.writableEnded) return;
  res.write('id: ' + id + ':' + event.sequence + '\nevent: ' + type + '\ndata: ' + JSON.stringify(event) + '\n\n');
}
function root(id, status, created = stamp, extra = {}) { return { run_id: id, session_id: 'dispatched-session', parent_run_id: null, status, created_at: created, ...extra }; }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const route = url.pathname.replace(/^\/mock/, '');
  let body = {};
  if (req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { body = JSON.parse(raw || '{}'); } catch (_) { body = {}; }
  }
  if (!url.pathname.startsWith('/mock')) {
    const file = path.resolve(ROOT, '.' + url.pathname);
    if (file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      return fs.createReadStream(file).pipe(res);
    }
    return json(res, 404, {});
  }
  requests.push({ method: req.method, route, query: url.searchParams.toString() });
  if (route === '/health') return json(res, 200, { status: 'ok' });
  if (route === '/agent/ui-defaults') return json(res, 200, { configured: false, defaults: {} });
  if (route === '/agent/models') return json(res, 200, { clients: [] });
  if (route === '/agent/safety-reviews') return json(res, 200, { reviews: [] });
  if (route === '/knowledge/file-types') return json(res, 200, { file_types: [] });
  if (route === '/sessions/deleted') return json(res, 200, { sessions: [] });
  if (route === '/sessions') return json(res, 200, { sessions: Array.from(sessions.values()) });
  const runList = route.match(/^\/sessions\/([^/]+)\/runs$/);
  if (runList) {
    const id = decodeURIComponent(runList[1]);
    if (id === holdRunListFor) {
      holdRunListFor = '';
      const snapshot = { session_id: id, runs: runs.get(id) || [], next_offset: null };
      return new Promise(resolve => { releaseHeldRunList = () => { json(res, 200, snapshot); resolve(); }; });
    }
    return json(res, 200, { session_id: id, runs: runs.get(id) || [], next_offset: null });
  }
  const detail = route.match(/^\/sessions\/([^/]+)$/);
  if (detail) {
    const id = decodeURIComponent(detail[1]), value = sessions.get(id);
    if (!value) return json(res, 404, {});
    return json(res, 200, { session: value, messages: [{ message_id: 'task-source', role: 'user', content: 'Inspect the assigned workspace', payload: {} }] });
  }
  if (route === '/pet/session-workspace') return json(res, 200, { path: '/synthetic/work' });
  if (route.endsWith('/workspace')) return json(res, 200, { project_id: 'synthetic-project' });
  if (route.endsWith('/files')) return json(res, 200, { entries: [] });
  if (route === '/projects') return json(res, 200, { projects: [] });
  if (route === '/agent/turn/stream' && req.method === 'POST') {
    const id = body.session_id || body.conversation_id, runId = 'race-current';
    statuses.set(runId, 'running'); runs.set(id, [root(runId, 'running')]); runEvents.set(runId, []);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    streams.set(runId, res); addEvent(runId, 'run_started', 1, 'Concurrent task started');
    res.on('close', () => { if (streams.get(runId) === res) streams.delete(runId); });
    return;
  }
  const run = route.match(/^\/agent\/runs\/([^/]+)(?:\/(stream|snapshot))?$/);
  if (run) {
    const id = decodeURIComponent(run[1]), action = run[2] || '';
    if (!action) return json(res, 200, { run_id: id, session_id: 'dispatched-session', status: statuses.get(id) || 'running' });
    if (action === 'snapshot') return json(res, 200, { run: { run_id: id, status: statuses.get(id) || 'running' }, children: [] });
    if (action === 'stream') {
      const after = Number(url.searchParams.get('after_sequence') || 0);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      streams.set(id, res);
      for (const item of runEvents.get(id) || []) if (item.event.sequence > after) writeEvent(res, id, item.type, item.event);
      res.on('close', () => { if (streams.get(id) === res) streams.delete(id); });
      return;
    }
  }
  return json(res, 404, { detail: 'unmocked', route });
});
(async () => {
  let browser;
  try {
    sessions.set('dispatched-session', session('dispatched-session', '真理派发的工作区任务', { node_id: 'cloud', workspace_id: 'project' }));
    sessions.set('idle-session', session('idle-session', '稍后由另一设备启动的会话'));
    runs.set('dispatched-session', [
      root('old-superseded', 'cancelled', '2026-10-01T00:00:00.000Z', { superseded_by_run_id: 'live-dispatched' }),
      root('live-dispatched', 'running', '2026-10-02T00:00:00.000Z')
    ]);
    statuses.set('live-dispatched', 'running');
    runEvents.set('live-dispatched', []);
    addEvent('live-dispatched', 'run_started', 1, 'Started');
    addEvent('live-dispatched', 'assistant_message', 2, '检查工作区文件。', { metadata: { step_index: 1 } });
    addEvent('live-dispatched', 'tool_started', 3, '', { tool_name: 'filesystem.read_file' });
    runs.set('idle-session', []);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin + '/chat.html?mode=work&session_id=dispatched-session&backend=' + encodeURIComponent(origin + '/mock'));
    await page.locator('#runTimelineList .run-process-tool').filter({ hasText: 'filesystem.read_file' }).waitFor();
    assert((await page.locator('#runStatus').textContent()).includes('任务处理中'), 'opening shows the active run status');
    assert(requests.some(row => row.route === '/sessions/dispatched-session/runs'), 'opening an existing dispatched session discovers its root run');
    assert(requests.some(row => row.route === '/agent/runs/live-dispatched/stream' && row.query.includes('after_sequence=0')), 'fresh storage replays the complete saved event stream');
    assert(!requests.some(row => row.method === 'POST' && row.route.includes('/agent/turn')), 'opening never posts a new turn');
    assert(!requests.some(row => row.route.includes('/resume') || row.route.includes('/interrupt')), 'opening never changes task execution');
    addEvent('live-dispatched', 'tool_completed', 4, '', { tool_name: 'filesystem.read_file', status: 'completed' });
    await page.locator('#runTimelineList .run-process-state').filter({ hasText: '完成' }).waitFor();

    await page.locator('[data-session-id="idle-session"] .session-open').click();
    await page.locator('[data-session-id="idle-session"].active').waitFor();
    await page.locator('#messages').waitFor();
    for (let i = 0; i < 100 && streams.has('live-dispatched'); i++) await page.waitForTimeout(20);
    assert(!streams.has('live-dispatched'), 'switching sessions aborts the old live subscription');
    addEvent('live-dispatched', 'tool_failed', 5, 'STALE_OLD_SESSION_EVENT', { tool_name: 'old.tool', status: 'failed' });
    assert(!requests.some(row => row.route === '/agent/runs/idle-remote/stream'), 'idle conversation does not subscribe before a run exists');
    // Hold the next discovery response after it snapshots the empty run list.
    // A user-created run advances while that response is in flight; the stale
    // empty list must not clear the new run or its live subscription.
    holdRunListFor = 'idle-session';
    for (let i = 0; i < 700 && !releaseHeldRunList; i++) await page.waitForTimeout(20);
    assert(releaseHeldRunList, 'selected idle session begins its bounded discovery probe');
    await page.locator('#questionInput').fill('Concurrent task');
    await page.locator('#sendButton').click();
    for (let i = 0; i < 200 && !requests.some(row => row.method === 'POST' && row.route === '/agent/turn/stream'); i++) await page.waitForTimeout(20);
    assert(requests.some(row => row.method === 'POST' && row.route === '/agent/turn/stream'), 'explicit user submission creates the concurrent task');
    releaseHeldRunList(); releaseHeldRunList = null;
    await page.waitForFunction(() => window.LkaChatContext?.get().busy);
    assert(streams.has('race-current'), 'stale run-list response cannot abort the newer task stream');
    // End the synthetic direct run, then continue with remote-created failure discovery.
    statuses.set('race-current', 'completed');
    addEvent('race-current', 'final_answer', 2, 'Concurrent task completed', { metadata: { answer: 'Concurrent task completed' } });
    addEvent('race-current', 'run_completed', 3, 'Completed');
    const idle = root('idle-remote', 'failed', '2026-10-03T00:00:00.000Z');
    idle.session_id = 'idle-session';
    runs.set('idle-session', [idle]);
    statuses.set('idle-remote', 'failed'); runEvents.set('idle-remote', []);
    addEvent('idle-remote', 'run_started', 1, 'Started');
    addEvent('idle-remote', 'tool_started', 2, '', { tool_name: 'filesystem.read_file' });
    addEvent('idle-remote', 'tool_failed', 3, '', { tool_name: 'filesystem.read_file', status: 'failed' });
    addEvent('idle-remote', 'run_failed', 4, 'Worker failed');
    await page.waitForFunction(() => document.querySelector('#runStatus')?.textContent.includes('本轮失败'), null, { timeout: 20000 });
    assert(requests.some(row => row.route === '/sessions/idle-session/runs'), 'idle selected sessions are polled for remote-created runs');
    for (let i = 0; i < 250 && !requests.some(row => row.route === '/agent/runs/idle-remote/stream'); i++) await page.waitForTimeout(20);
    assert(requests.some(row => row.route === '/agent/runs/idle-remote/stream' && row.query.includes('after_sequence=0')), 'new remote-created run is replayed from sequence zero: ' + JSON.stringify(requests.filter(row => row.route === '/agent/runs/idle-remote/stream')));
    await page.locator('#runTimelineList .run-process-tool').filter({ hasText: 'filesystem.read_file' }).waitFor();
    await page.locator('#runTimelineList .run-process-state').filter({ hasText: '失败' }).waitFor();
    await page.waitForTimeout(100);
    const streamRequest = requests.find(row => row.route === '/agent/runs/live-dispatched/stream');
    assert(streamRequest, 'first run stream was opened');
    assert.equal(await page.locator('#runTimelineList .run-process-tool').count(), 1, 'events from the previous session do not enter the selected session process');
    assert(!await page.locator('#messages').innerText().then(text => text.includes('STALE_OLD_SESSION_EVENT')), 'late old-run events are ignored');
    assert.deepEqual(errors, []);
    console.log('PASS opened-session run recovery: root selection, fresh event replay, live process updates, idle discovery, failed status, and read-only lifecycle');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
