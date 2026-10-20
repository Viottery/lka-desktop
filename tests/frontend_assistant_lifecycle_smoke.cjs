'use strict';
// Actual chat scripts; all HTTP, composer delays and native events are synthetic.
// No personal backend, model, credentials or persistent user data is accessed.
const assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = process.env.FRONTEND_PET_ROOT || path.resolve(__dirname, '../app/web/pet');
const stamp = new Date().toISOString(), requests = [], errors = [], phases = new Map();
const managerId = 'manager_lifecycle', ordinaryId = 'ordinary_lifecycle';
function state(phase) {
  if (!phases.has(phase)) phases.set(phase, { status: phase === 'resume' ? 'paused' : 'completed', histories: {
    [managerId]: [{ role: 'assistant', content: '真理的合成历史', payload: {} }],
    [ordinaryId]: [{ role: 'assistant', content: '普通任务的合成历史', payload: {} }]
  }, stream: null, releaseResume: null });
  return phases.get(phase);
}
function session(id) { return { session_id: id, kind: id === managerId ? 'manager' : 'ordinary', title: id === managerId ? '真理' : '普通任务', status: 'active', created_at: stamp, updated_at: stamp, metadata: {}, workspace: id === managerId ? null : { path: '/synthetic/lifecycle' } }; }
function manager() { return { session: session(managerId), controller: { session_id: managerId, status: 'paused', revision: 1, llm_client_name: null, llm_model: null, default_execution_workspace: { path: '/synthetic/continuity', platform: 'linux' } } }; }
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }
function event(res, name, data) { res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture'), match = url.pathname.match(/^\/mock\/([^/]+)(\/.*)$/);
  if (!match) {
    const file = path.resolve(ROOT, '.' + url.pathname);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, {});
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html;charset=utf-8' }); return fs.createReadStream(file).pipe(res);
  }
  const phase = match[1], route = match[2], fixture = state(phase);
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {}; requests.push({ phase, route, method: req.method, body });
  if (route === '/agent/models') return json(res, 200, { clients: [] });
  if (route === '/agent/ui-defaults') return json(res, 200, { configured: true, defaults: { stream: true } });
  if (route === '/agent/safety-reviews') return json(res, 200, { reviews: [] });
  if (route === '/knowledge/file-types') return json(res, 200, { file_types: [] });
  if (route === '/sessions/deleted') return json(res, 200, { sessions: [], next_offset: null });
  if (route === '/sessions') return json(res, 200, { sessions: [session(ordinaryId), session(managerId)], next_offset: null });
  if (route === '/managers/default' || route === '/managers/' + managerId) return json(res, 200, manager());
  if (route.endsWith('/goals')) return json(res, 200, { goals: [], next_offset: null });
  if (route.endsWith('/events') && route.startsWith('/managers/')) return json(res, 200, { events: [], next_after: null });
  if (route.endsWith('/deliveries')) return json(res, 200, { deliveries: [], next_after: null });
  if (route === '/projects') return json(res, 200, { projects: [], next_offset: null });
  if (route === '/openapi.json') return json(res, 200, { paths: {} });
  if (route.endsWith('/files')) return json(res, 200, { entries: [], total: 0 });
  if (route.endsWith('/workspace')) return json(res, 200, { project_id: 'synthetic-project' });
  if (route.startsWith('/sessions/') && route.endsWith('/runs')) {
    const id = route.split('/')[2];
    return json(res, 200, { session_id: id, runs: phase === 'resume' && id === managerId ? [{ run_id: 'resume-root', session_id: id, status: fixture.status, parent_run_id: null, created_at: stamp }] : [], next_offset: null });
  }
  if (/^\/sessions\/[^/]+$/.test(route)) { const id = route.split('/')[2]; return json(res, 200, { session: session(id), messages: fixture.histories[id] || [] }); }
  if (route === '/agent/runs/resume-root/resume') {
    fixture.releaseResume = () => { fixture.status = 'running'; json(res, 200, { run_id: 'resume-root', status: 'running' }); }; return;
  }
  const runRoute = route.match(/^\/agent\/runs\/([^/]+)(?:\/(snapshot|stream|events))?$/);
  if (runRoute) {
    const runId = runRoute[1];
    if (runRoute[2] === 'snapshot') return json(res, 200, { parent_run: { run_id: runId, status: fixture.status }, children: [], steps: [] });
    if (runRoute[2] === 'stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      if (runId === 'resume-root') { fixture.stream = res; event(res, 'run_resumed', { run_id: runId, status: 'running', sequence: 1 }); return; }
      // An existing busy run finishes directly in SSE; no status-poll side effect
      // should be needed to release the failed send's composer busy state.
      fixture.status = 'completed'; fixture.histories[managerId].push({ role: 'assistant', content: '原运行已完成', payload: {} });
      event(res, 'final_answer', { run_id: runId, sequence: 1, payload: { metadata: { answer: '原运行已完成' } } });
      event(res, 'run_completed', { run_id: runId, status: 'completed', sequence: 2 }); return res.end();
    }
    return json(res, 200, { run_id: runId, session_id: managerId, status: fixture.status, events: [] });
  }
  if (route === '/agent/turn/stream') return json(res, 500, { detail: 'Unexpected real transport: this case requires native stub' });
  return json(res, 404, { detail: 'unmocked_synthetic_route ' + route });
});
async function until(check, label) { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Timed out: ' + label); }
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
    async function open(phase) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.addInitScript(() => { const interval = window.setInterval; window.setInterval = (fn, delay, ...args) => interval(delay === 8000 ? () => {} : fn, delay, ...args); });
      await page.goto(origin + '/chat.html?mode=work&session_id=' + ordinaryId + '&backend=' + encodeURIComponent(origin + '/mock/' + phase));
      await page.waitForFunction(() => window.LkaChatContext && document.getElementById('gaUpdated')?.textContent.startsWith('更新于'));
      await page.evaluate(() => LkaChatContext.openAssistant()); await page.waitForFunction(() => LkaChatContext.get().kind === 'manager'); return { context, page };
    }
    async function nativeDelay(page) {
      await page.evaluate(managerId => {
        window.fixtureNativeTurns = []; window.fixturePrepareStarted = false; window.fixturePrepareDone = false;
        const original = LkaImageComposer.prepare;
        LkaImageComposer.prepare = async function (items, sid) {
          if (sid !== managerId || window.fixturePrepareReleased) return original.call(this, items, sid);
          window.fixturePrepareStarted = true;
          await new Promise(resolve => { window.fixtureReleasePrepare = () => { window.fixturePrepareReleased = true; resolve(); }; });
          window.fixturePrepareDone = true; return [];
        };
        window.petBridge = { stream: raw => fixtureNativeTurns.push(JSON.parse(raw)) };
      }, managerId);
    }
    // 1. Async attachment preparation can finish after an ordinary turn starts.
    // A native manager failure still belongs to its original generation/session.
    const delayed = await open('delayed-native'); await nativeDelay(delayed.page);
    await delayed.page.evaluate(() => __petChatSubmitText('真理延迟发送的内容'));
    await delayed.page.waitForFunction(() => fixturePrepareStarted);
    await delayed.page.evaluate(id => LkaChatContext.openSession(id), ordinaryId);
    await delayed.page.evaluate(() => __petChatSubmitText('普通任务仍在运行'));
    await delayed.page.waitForFunction(() => fixtureNativeTurns.length === 1);
    await delayed.page.evaluate(() => fixtureReleasePrepare()); await delayed.page.waitForFunction(() => fixtureNativeTurns.length === 2);
    const managerTurn = await delayed.page.evaluate(id => fixtureNativeTurns.find(turn => turn.conversation_id === id), managerId);
    const ordinaryTurn = await delayed.page.evaluate(id => fixtureNativeTurns.find(turn => turn.conversation_id === id), ordinaryId);
    assert.notEqual(managerTurn.request_id, ordinaryTurn.request_id);
    await delayed.page.evaluate(turn => __petChatReceive({ session_id: turn.conversation_id, request_id: turn.request_id, error: 'HTTP 409: ' + JSON.stringify({ detail: 'session_busy', session_id: turn.conversation_id, run_id: 'recovered-root' }) }), managerTurn);
    await until(() => requests.some(r => r.phase === 'delayed-native' && r.route === '/agent/runs/recovered-root/stream'), 'manager conflict recovery subscription');
    assert.equal(await delayed.page.evaluate(() => LkaChatContext.get().sessionId), ordinaryId);
    assert.equal(await delayed.page.evaluate(() => LkaChatContext.get().busy), true, 'background error cannot clear ordinary pending');
    assert.equal(await delayed.page.locator('.message.error').count(), 0);
    await delayed.page.evaluate(turn => { __petChatReceiveStream('run_started', { run_id: 'ordinary-root', session_id: turn.conversation_id, sequence: 1 }, turn.request_id); __petChatReceiveStream('final_answer', { run_id: 'ordinary-root', sequence: 2, payload: { metadata: { answer: '普通任务完成' } } }, turn.request_id); __petChatReceiveStream('run_completed', { run_id: 'ordinary-root', sequence: 3, status: 'completed' }, turn.request_id); }, ordinaryTurn);
    await delayed.page.evaluate(() => LkaChatContext.openAssistant());
    await delayed.page.waitForFunction(() => !LkaChatContext.get().busy && !document.getElementById('sendButton').disabled);
    assert.equal(await delayed.page.locator('#questionInput').inputValue(), '真理延迟发送的内容', 'busy input is restored to manager draft');
    assert.equal(requests.filter(r => r.phase === 'delayed-native' && r.route === '/agent/turn/stream').length, 0);
    await delayed.context.close();

    // Active conflict recovery must release busy on terminal SSE without relying
    // on navigation (which independently resets the visible composer's state).
    const activeConflict = await open('active-conflict');
    await activeConflict.page.evaluate(() => { window.fixtureNativeTurns = []; window.petBridge = { stream: raw => fixtureNativeTurns.push(JSON.parse(raw)) }; __petChatSubmitText('当前会话的冲突输入'); });
    await activeConflict.page.waitForFunction(() => fixtureNativeTurns.length === 1);
    await activeConflict.page.evaluate(() => { const turn = fixtureNativeTurns[0]; __petChatReceive({ session_id: turn.conversation_id, request_id: turn.request_id, error: 'HTTP 409: ' + JSON.stringify({ detail: 'session_busy', session_id: turn.conversation_id, run_id: 'active-recovered-root' }) }); });
    await activeConflict.page.waitForFunction(() => !LkaChatContext.get().busy && !document.getElementById('sendButton').disabled);
    assert.equal(await activeConflict.page.locator('#questionInput').inputValue(), '当前会话的冲突输入');
    assert.equal(await activeConflict.page.evaluate(() => fixtureNativeTurns.length), 1, 'recovery never resends the restored input');
    assert.equal(await activeConflict.page.evaluate(() => LkaChatContext.get().sessionId), managerId);
    await activeConflict.context.close();

    // 2. Changing auth while preparation waits cancels the unsent old-scope input.
    // Switching away must not resurrect its pending record or send it later.
    const auth = await open('auth'); await nativeDelay(auth.page);
    await auth.page.evaluate(() => __petChatSubmitText('旧认证范围的未发送内容')); await auth.page.waitForFunction(() => fixturePrepareStarted);
    await auth.page.evaluate(() => dispatchEvent(new CustomEvent('lka-matter-auth-changed')));
    await auth.page.evaluate(id => LkaChatContext.openSession(id), ordinaryId);
    await auth.page.evaluate(() => fixtureReleasePrepare()); await auth.page.waitForFunction(() => fixturePrepareDone);
    await auth.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await auth.page.evaluate(() => fixtureNativeTurns.length), 0, 'old auth preparation never reaches native transport');
    assert.equal(requests.filter(r => r.phase === 'auth' && r.route === '/agent/turn/stream').length, 0);
    await auth.page.evaluate(() => LkaChatContext.openAssistant());
    await auth.page.waitForFunction(() => !LkaChatContext.get().busy && !document.getElementById('sendButton').disabled);
    await auth.page.evaluate(() => __petChatSubmitText('新认证范围的明确发送')); await auth.page.waitForFunction(() => fixtureNativeTurns.length === 1);
    assert.equal(await auth.page.evaluate(() => fixtureNativeTurns[0].question), '新认证范围的明确发送');
    await auth.context.close();

    // 3. Cached paused runs stay idle on navigation. A delayed resume response
    // must start its manager subscription even after the user selects ordinary.
    const resumed = await open('resume');
    await resumed.page.waitForFunction(() => document.getElementById('sendButton').dataset.action === 'resume');
    const pausedStreams = requests.filter(r => r.phase === 'resume' && r.route === '/agent/runs/resume-root/stream').length;
    for (let i = 0; i < 2; i++) { await resumed.page.evaluate(id => LkaChatContext.openSession(id), ordinaryId); await resumed.page.evaluate(() => LkaChatContext.openAssistant()); }
    assert.equal(requests.filter(r => r.phase === 'resume' && r.route === '/agent/runs/resume-root/stream').length, pausedStreams, 'paused cache does not resubscribe on each return');
    await resumed.page.locator('#sendButton').click(); await until(() => state('resume').releaseResume, 'held resume command');
    await resumed.page.evaluate(id => LkaChatContext.openSession(id), ordinaryId); await resumed.page.locator('#questionInput').fill('普通草稿保持原样'); state('resume').releaseResume();
    await until(() => state('resume').stream, 'background resumed stream');
    assert.equal(await resumed.page.evaluate(() => LkaChatContext.get().sessionId), ordinaryId);
    assert.equal(await resumed.page.locator('#questionInput').inputValue(), '普通草稿保持原样');
    const fixture = state('resume'); fixture.status = 'completed'; fixture.histories[managerId].push({ role: 'assistant', content: '后台继续后的完整结果', payload: {} });
    event(fixture.stream, 'final_answer', { run_id: 'resume-root', sequence: 2, payload: { metadata: { answer: '后台继续后的完整结果' } } }); event(fixture.stream, 'run_completed', { run_id: 'resume-root', sequence: 3, status: 'completed' }); fixture.stream.end();
    await resumed.page.evaluate(() => LkaChatContext.openAssistant()); await resumed.page.locator('#messages').filter({ hasText: '后台继续后的完整结果' }).waitFor();
    await resumed.page.waitForFunction(() => !LkaChatContext.get().busy && !document.getElementById('sendButton').disabled);
    assert.deepEqual(errors, []); await resumed.context.close();
    console.log('PASS assistant lifecycle: delayed native error attribution, recovered terminal composer, auth preparation cancellation, paused cache and background resume subscription');
  } finally {
    for (const fixture of phases.values()) if (fixture.stream && !fixture.stream.writableEnded) fixture.stream.end();
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
