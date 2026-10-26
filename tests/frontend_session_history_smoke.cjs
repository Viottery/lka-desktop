'use strict';
// Actual chat DOM and quick-assistant host transport; synthetic localhost only.
const assert = require('node:assert/strict'), http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = path.resolve(__dirname, '../app/web/pet'), calls = [], errors = [];
const stamp = '2026-10-24T01:00:00Z';
let values = Array.from({ length: 240 }, (_, i) => i + 1), reset = '', releaseManager;
const session = () => ({ session_id: 'history-manager', kind: 'manager', title: '分页合成助手', created_at: stamp, updated_at: stamp, metadata: { history_reset_at: reset } });
const manager = () => ({ session: session(), controller: { session_id: 'history-manager', status: 'active', revision: 1,
  default_execution_workspace: { path: '/synthetic/tasks', platform: 'linux', backend_path: '/synthetic/tasks' } } });
const json = (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(payload)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const file = path.resolve(ROOT, '.' + url.pathname);
  if (file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    if (file.endsWith('chat.html')) {
      let html = fs.readFileSync(file, 'utf8').replace(/<script src="\.\/([^"?]+)(?:\?[^\"]*)?"><\/script>/g,
        (match, script) => ['vendor/markdown-it-15.0.2.umd.min.js', 'markdown.js', 'image-composer.js', 'conversation-position.js', 'session-history.js', 'chat.js'].includes(script) ? match : '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' }); return fs.createReadStream(file).pipe(res);
  }
  for await (const chunk of req) {} // Drain synthetic request bodies.
  calls.push({ path: url.pathname, query: url.search, method: req.method });
  if (url.pathname === '/managers/default') { releaseManager = () => json(res, 200, manager()); return; }
  if (url.pathname === '/sessions') return json(res, 200, { sessions: [] });
  if (url.pathname === '/sessions/history-manager') {
    const after = url.searchParams.get('after_message_id'), before = url.searchParams.get('before_message_id');
    if ((after || before) && !values.includes(Number(after || before))) return json(res, 409, { detail: 'history_cursor_invalid' });
    let selected = values.filter(id => after ? id > Number(after) : before ? id < Number(before) : true);
    // Model a raw page where hidden background rows would occupy 28 of 30 slots.
    // The conversation view filters those rows before choosing its 30 visible messages.
    if (url.searchParams.get('message_view') !== 'conversation') selected = selected.filter(id => id % 15 === 0);
    const more = selected.length > 30;
    selected = after ? selected.slice(0, 30) : selected.slice(-30);
    return json(res, 200, { session: session(), messages: selected.map(id => ({ message_id: String(id), role: id % 2 ? 'user' : 'assistant', content: 'history-message-' + id })),
      message_page: { direction: after ? 'after' : 'before', has_more: more, first_message_id: String(selected[0] || ''), last_message_id: String(selected.at(-1) || ''), history_reset_at: reset } });
  }
  if (url.pathname === '/sessions/history-manager/runs') return json(res, 200, { session_id: 'history-manager', runs: [], next_offset: null });
  if (url.pathname === '/managers/history-manager') return json(res, 200, manager());
  if (url.pathname === '/agent/models') return json(res, 200, { clients: [] });
  if (url.pathname === '/agent/ui-defaults') return json(res, 200, { configured: false, defaults: {} });
  if (url.pathname === '/knowledge/file-types') return json(res, 200, { file_types: [] });
  if (url.pathname === '/agent/safety-reviews') return json(res, 200, { reviews: [] });
  return json(res, 404, { detail: 'synthetic_unsupported' });
});
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(({ origin }) => {
      window.hostHistoryCalls = [];
      window.LkaMatterHost = { ready: Promise.resolve(), namespace: 'synthetic-account', request: async (path, method, body) => {
        window.hostHistoryCalls.push(path);
        const response = await fetch(origin + path, { method: method || 'GET', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
        const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.detail), { status: response.status, detail: data.detail }); return data;
      } };
      window.handoffs = [];
      window.petBridge = { openWorkbenchSession: (sessionId, runId) => window.handoffs.push({ sessionId, runId }) };
    }, { origin });
    await page.goto(origin + '/chat.html?assistant=quick&backend=' + encodeURIComponent(origin));
    await page.waitForFunction(() => typeof window.__petChatOpenWorkbench === 'function' && !window.LkaChatContext.get().sessionId);
    assert.equal(await page.evaluate(() => window.__petChatOpenWorkbench()), true);
    assert.deepEqual(await page.evaluate(() => window.handoffs), [{ sessionId: '', runId: '' }]);
    assert(!calls.some(call => call.path === '/sessions' && call.method === 'POST'), 'empty workbench handoff creates no backend session');
    for (let attempt = 0; !releaseManager && attempt < 500; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(releaseManager, "quick assistant manager request reached synthetic host: " + JSON.stringify(calls));
    releaseManager();
    await page.waitForFunction(() => window.LkaChatContext.get().sessionId === 'history-manager', null, { timeout: 5000 }).catch(async error => { console.error(await page.evaluate(() => ({ state: window.LkaChatContext.get(), status: document.querySelector('#runStatus').textContent, hostCalls: window.hostHistoryCalls })), calls, errors); throw error; });
    await page.waitForSelector('#loadEarlierMessagesButton');
    assert.equal(await page.locator('#messages .message').count(), 30);
    assert((await page.evaluate(() => window.hostHistoryCalls)).includes('/sessions/history-manager?message_limit=30&message_view=conversation'), 'native-compatible host detail read uses the filtered paged view');
    for (let i = 0; i < 7; i++) {
      const before = await page.locator('#messages .message').count();
      await page.locator('#loadEarlierMessagesButton').click();
      await page.waitForFunction(count => document.querySelectorAll('#messages .message').length === count + 30, before);
    }
    assert.equal(await page.locator('#messages .message').count(), 240, 'explicit older pages extend beyond 180 in-memory messages');
    assert.equal(await page.locator('#loadEarlierMessagesButton').count(), 0);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4')).find(s => s.id === 'history-manager').messages.length), 180);
    values.push(...Array.from({ length: 66 }, (_, i) => i + 241));
    assert.equal(await page.evaluate(() => window.LkaChatContext.refreshConversation()), true);
    await page.waitForFunction(() => document.querySelectorAll('#messages .message').length === 306);
    assert(calls.some(call => /after_message_id=240/.test(call.query)) && calls.some(call => /after_message_id=300/.test(call.query)), 'incremental history follows all newer cursors');
    values = [401, 402]; reset = '2026-10-24T02:00:00Z';
    await page.evaluate(() => window.LkaChatContext.refreshConversation());
    await page.waitForFunction(() => document.querySelectorAll('#messages .message').length === 2);
    assert(!(await page.locator('#messages').innerText()).includes('history-message-240'), 'reset never mixes prior history');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS: real chat recent page, host bypass, explicit older pages >180, bounded persistence, incremental recovery, reset and empty workbench handoff');
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
