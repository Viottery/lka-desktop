// Isolated chat-turn regression. All HTTP is served from a synthetic localhost origin.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = path.resolve(__dirname, '../app/web/pet');
const OLD_CHAT = process.env.FRONTEND_CHAT_SOURCE || '';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const requests = [];
let releaseWorkspace;
let holdWorkspace = true;
let signalWorkspaceArrival;
const workspaceArrived = new Promise(resolve => { signalWorkspaceArrival = resolve; });
let signalBackendCreate;
const backendSessionCreated = new Promise(resolve => { signalBackendCreate = resolve; });
let failAgentTurn = false;
let currentBackendSession = 'synthetic-backend-session';
let releaseStream;
let signalStreamArrival;
const streamArrived = new Promise(resolve => { signalStreamArrival = resolve; });
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requests.push({ method: req.method, path: url.pathname });
  if (url.pathname === '/' || url.pathname === '/chat.html') {
    let html = fs.readFileSync(path.join(ROOT, 'chat.html'), 'utf8');
    html = html.replace(/<script src="\.\/(memory|projects|qq-reader|message-ui-api|message-content|message-names|message-history|message-reading|messages-center)\.js[^>]*><\/script>/g, '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html);
  }
  if (url.pathname.startsWith('/')) {
    const relative = url.pathname === '/' ? 'chat.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(ROOT, relative);
    if (file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      if (url.pathname === '/chat.js' && OLD_CHAT) return res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }), fs.createReadStream(OLD_CHAT).pipe(res);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); return fs.createReadStream(file).pipe(res);
    }
  }
  if (url.pathname === '/agent/models') return json(res, 200, { clients: [] });
  if (url.pathname === '/agent/ui-defaults') return json(res, 200, { configured: false, defaults: {} });
  if (url.pathname === '/sessions' && req.method === 'GET') return json(res, 200, { sessions: [] });
  if (url.pathname === '/sessions/deleted') return json(res, 200, { sessions: [] });
  if (url.pathname === '/pet/session-workspace') {
    if (holdWorkspace) { signalWorkspaceArrival(); await new Promise(resolve => { releaseWorkspace = resolve; }); }
    return json(res, 200, { path: 'C:/synthetic/workspace' });
  }
  if (url.pathname === '/sessions' && req.method === 'POST') {
    currentBackendSession = 'synthetic-bound-session'; signalBackendCreate();
    return json(res, 201, { session: { session_id: currentBackendSession } });
  }
  if (/^\/sessions\/[^/]+\/workspace$/.test(url.pathname) && req.method === 'PUT') {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    if (id !== currentBackendSession) return json(res, 404, { detail: 'synthetic_missing_session' });
    return json(res, 200, { project_id: 'synthetic-project' });
  }
  if (url.pathname === '/agent/turn/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write('event: llm_started\ndata: {"stage":"synthetic"}\n\n');
    signalStreamArrival();
    await new Promise(resolve => { releaseStream = resolve; });
    res.write('event: llm_delta\ndata: {"payload":{"display_target":"assistant_answer","content_snapshot":"**合成回复**"}}\n\n');
    res.write('event: run_completed\ndata: {}\n\n');
    return res.end();
  }
  if (url.pathname === '/agent/turn') return failAgentTurn ? json(res, 502, { detail: 'synthetic_agent_failure' }) : json(res, 200, { answer: '**合成回复**' });
  if (/^\/sessions\/[^/]+$/.test(url.pathname)) return json(res, 404, { detail: 'synthetic_not_found' });
  return json(res, 404, { detail: 'not_mocked' });
});

(async () => {
  let browser;
  let context;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox'] });
    context = await browser.newContext();
    const page = await context.newPage();
    const failures = [], externalAttempts = [];
    await page.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { externalAttempts.push(new URL(route.request().url()).origin); return route.abort(); } return route.continue(); });
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(origin + '/chat.html?mode=work&backend=' + encodeURIComponent(origin));
    await page.waitForFunction(() => typeof window.__petChatSubmitText === 'function');
    await workspaceArrived;
    const accepted = await page.evaluate(() => window.__petChatSubmitText('合成首条用户消息'));
    assert.equal(accepted, true, 'native-compatible submit hook accepts the first user message');
    const immediate = await page.evaluate(() => ({
      visible: document.querySelector('#messages').innerText.includes('合成首条用户消息'),
      sessions: JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4') || '[]').map(s => ({ id: s.id, messages: s.messages.map(m => ({ role: m.role, text: m.text })) }))
    }));
    assert.equal(immediate.visible, true, 'first user message is visible before workspace creation/binding or the Agent reply completes');
    assert(immediate.sessions.some(s => s.messages.some(m => m.role === 'user' && m.text === '合成首条用户消息')), 'first user message is already persisted locally');
    releaseWorkspace?.(); releaseWorkspace = null; holdWorkspace = false;
    await backendSessionCreated;
    await streamArrived;
    assert(await page.locator('#messages').innerText().then(t => t.includes('合成首条用户消息')), 'binding a new backend session keeps the user message visible');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(30);
    assert.equal(await page.locator('#messages .message.user').count(), 1, 'background synchronization/focus does not duplicate the user message');
    releaseStream?.(); releaseStream = null;
    await page.waitForFunction(() => document.querySelector('#messages').innerText.includes('合成回复'), null, { timeout: 5000 });
    assert.equal(await page.locator('#messages .message.user').count(), 1);
    assert.equal(await page.locator('#messages .message.assistant').count(), 1);
    assert(await page.locator('#messages .message.assistant strong').count() >= 1, 'assistant markdown is rendered');
    assert.equal(failures.length, 0, failures.join('\n'));
    assert.equal(externalAttempts.length, 0, 'all browser network requests stay on the synthetic origin');

    // Native host bridge path: workspace/session binding and chat() are synthetic callbacks.
    const bridgeContext = await browser.newContext();
    const bridgePage = await bridgeContext.newPage();
    bridgePage.on('pageerror', error => failures.push(error.message));
    await bridgePage.addInitScript(() => {
      localStorage.setItem('agentic-rag-pet-run-settings-v1', JSON.stringify({ stream: false }));
      window.petBridge = {
        createSessionWorkspace: () => JSON.stringify({ path: 'C:/synthetic/native-workspace' }),
        setSessionWorkspace: (id, workspace) => { window.__bindingCalls = (window.__bindingCalls || 0) + 1; return window.__bindingCalls === 1 ? JSON.stringify({ error: 'HTTP 404' }) : JSON.stringify({ project_id: 'synthetic-native-project' }); },
        createSession: () => JSON.stringify({ session: { session_id: 'synthetic-native-session' } }),
        send: payload => { window.__sentPayload = JSON.parse(payload); }
      };
    });
    await bridgePage.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { externalAttempts.push(new URL(route.request().url()).origin); return route.abort(); } return route.continue(); });
    await bridgePage.goto(origin + '/chat.html?mode=work&backend=' + encodeURIComponent(origin));
    await bridgePage.waitForFunction(() => typeof window.__petChatSubmitText === 'function');
    assert.equal(await bridgePage.evaluate(() => window.__petChatSubmitText('合成原生桥接用户消息')), true);
    await bridgePage.waitForFunction(() => window.__sentPayload);
    assert(await bridgePage.locator('#messages').innerText().then(t => t.includes('合成原生桥接用户消息')), 'native bridge mode shows user text immediately');
    await bridgePage.locator('#questionInput').fill('保留的下一条草稿');
    await bridgePage.evaluate(() => window.__petChatReceive({ session_id: 'synthetic-native-session', answer: '**原生桥接回复**' }));
    await bridgePage.waitForFunction(() => document.querySelector('#messages').innerText.includes('原生桥接回复'));
    assert.equal(await bridgePage.locator('#messages .message.user').count(), 1);
    assert.equal(await bridgePage.locator('#messages .message.assistant').count(), 1);
    assert.equal(await bridgePage.locator('#questionInput').inputValue(), '保留的下一条草稿');
    const bridgeMessages = await bridgePage.evaluate(() => JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4')).find(s => s.id === 'synthetic-native-session').messages.map(m => [m.role, m.text]));
    assert.deepEqual(bridgeMessages.filter(([role, text]) => !(role === 'assistant' && text === '把任务交给我。可以先从提问、查找资料或整理文件开始。')), [['user', '合成原生桥接用户消息'], ['assistant', '**原生桥接回复**']]);
    await bridgeContext.close();

    // Non-streaming HTTP failure keeps the submitted text and renders a marked error.
    failAgentTurn = true;
    const failedContext = await browser.newContext();
    const failedPage = await failedContext.newPage();
    failedPage.on('pageerror', error => failures.push(error.message));
    await failedPage.addInitScript(() => localStorage.setItem('agentic-rag-pet-run-settings-v1', JSON.stringify({ stream: false })));
    await failedPage.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { externalAttempts.push(new URL(route.request().url()).origin); return route.abort(); } return route.continue(); });
    await failedPage.goto(origin + '/chat.html?mode=work&backend=' + encodeURIComponent(origin));
    await failedPage.waitForFunction(() => typeof window.__petChatSubmitText === 'function');
    await failedPage.locator('#streamToggle').uncheck();
    assert.equal(await failedPage.evaluate(() => window.__petChatSubmitText('失败路径合成用户消息')), true);
    await failedPage.waitForFunction(() => document.querySelector('#messages .message.error'));
    assert(await failedPage.locator('#messages').innerText().then(t => t.includes('失败路径合成用户消息')));
    assert(await failedPage.locator('#messages .message.error').innerText().then(t => t.includes('synthetic_agent_failure')));
    const failedMessages = await failedPage.evaluate(() => JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4')).flatMap(s => s.messages));
    assert(failedMessages.some(m => m.role === 'user' && m.text === '失败路径合成用户消息'), 'failed request retains the submitted user message locally');
    assert.equal(failures.length, 0, failures.join('\n'));
    assert.equal(externalAttempts.length, 0, 'all browser network requests stay on the synthetic origin');
    await failedContext.close();
    console.log(JSON.stringify({ result: 'PASS', requests: requests.length, checks: ['immediate first user visibility and localStorage persistence', 'workspace bind and backend session ID replacement', 'focus synchronization and single user bubble', 'single assistant answer with markdown', 'native fake bridge chat and __petChatReceive', 'next draft retained during reply', 'non-streaming request failure retains user and shows error', 'synthetic-origin-only network'] }, null, 2));
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    releaseWorkspace?.(); releaseStream?.();
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
})();
