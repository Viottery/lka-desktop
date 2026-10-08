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
let releaseStream, pushStreamEvent;
let signalStreamArrival;
const streamArrived = new Promise(resolve => { signalStreamArrival = resolve; });
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let body = ''; for await (const chunk of req) body += chunk;
  requests.push({ method: req.method, path: url.pathname, body });
  if (url.pathname === '/' || url.pathname === '/chat.html' || url.pathname === '/desktop-pet/chat.html') {
    let html = fs.readFileSync(path.join(ROOT, 'chat.html'), 'utf8');
    html = html.replace(/<script src="\.\/(memory|projects|qq-reader|message-ui-api|message-content|message-names|message-history|message-reading|messages-center)\.js[^>]*><\/script>/g, (match, module) => module === 'memory' && url.searchParams.has('with_memory') ? match : '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html);
  }
  if (url.pathname.startsWith('/')) {
    const relative = url.pathname === '/' ? 'chat.html' : decodeURIComponent(url.pathname.replace(/^\/desktop-pet(?=\/)/, '').slice(1));
    const file = path.resolve(ROOT, relative);
    if (file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      if (url.pathname === '/chat.js' && OLD_CHAT) return res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }), fs.createReadStream(OLD_CHAT).pipe(res);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); return fs.createReadStream(file).pipe(res);
    }
  }
  if (url.pathname === '/memories' && req.method === 'POST') return json(res, 201, { memory_id: 'synthetic-memory', memory_file_status: 'synced' });
  if (url.pathname === '/knowledge/file-types') return json(res, 200, { file_types: [{ extensions: ['.txt', '.text', '.md', '.pdf', '.docx', '.pptx', '.xlsx', '.xls', '.html', '.htm', '.epub', '.csv', '.json', '.xml', '.msg'], index_supported: true }] });
  if (url.pathname === '/agent/models') return json(res, 200, { clients: [] });
  if (url.pathname === '/agent/ui-defaults') return json(res, 200, { configured: false, defaults: {} });
  if (url.pathname === '/sessions' && req.method === 'GET') return json(res, 200, { sessions: [] });
  if (url.pathname === '/sessions/deleted') return json(res, 200, { sessions: [] });
  if (url.pathname === '/pet/workspace-directories') {
    const picked = url.searchParams.get('path') || 'C:/synthetic/workspace';
    if (picked === 'C:/synthetic/missing') return json(res, 404, { detail: 'Directory does not exist' });
    if (picked.startsWith('/home/')) return json(res, 422, { detail: 'Choose a local drive path' });
    const names = picked === 'C:/synthetic' ? ['chosen', 'forbidden', 'workspace'] : [];
    const matches = names.filter(name => name.includes(url.searchParams.get('query') || ''));
    const offset = Number(url.searchParams.get('offset') || 0);
    return json(res, 200, { path: picked, parent: picked === 'C:/' ? null : picked.slice(0, picked.lastIndexOf('/')) || 'C:/', roots: [{ name: 'C:', path: 'C:/' }],
      directories: matches.slice(offset, offset + 2).map(name => ({ name, path: picked + '/' + name })), next_offset: matches.length > offset + 2 ? offset + 2 : null, truncated: false });
  }
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
    if (JSON.parse(body).path === 'C:/synthetic/forbidden') return json(res, 422, { detail: 'synthetic_workspace_denied' });
    return json(res, 200, { project_id: 'synthetic-project' });
  }
  if (url.pathname === '/agent/turn/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write('event: llm_started\ndata: {"stage":"synthetic"}\n\n');
    pushStreamEvent = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(Object.assign({ type: event }, data)) + '\n\n');
    signalStreamArrival();
    await new Promise(resolve => { releaseStream = resolve; });
    pushStreamEvent('final_answer', { payload: { metadata: { answer: '**合成回复**' } } });
    res.write('event: run_completed\ndata: {}\n\n');
    return res.end();
  }
  if (url.pathname === '/agent/turn') return failAgentTurn ? json(res, 502, { detail: 'synthetic_agent_failure' }) : json(res, 200, { answer: '**合成回复**' });
  if (url.pathname === '/sessions/synthetic-workbench-existing') return json(res, 200, {
    session: { session_id: 'synthetic-workbench-existing', title: '合成已有会话', metadata: {}, workspace: { path: 'C:/synthetic/existing' } },
    messages: [{ role: 'user', content: '已有会话里的合成问题' }, { role: 'assistant', content: '**已有会话里的合成回答**' }]
  });
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
    await page.goto(origin + '/chat.html?mode=work&with_memory=1&backend=' + encodeURIComponent(origin));
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
    const createsBeforeHandoff = requests.filter(r => r.method === 'POST' && r.path === '/sessions').length;
    await page.evaluate(() => {
      window.__handoffs = [];
      window.petBridge = { openWorkbenchSession: (sessionId, runId) => window.__handoffs.push({ sessionId, runId }) };
      window.__handoffPending = window.__petChatOpenWorkbench();
    });
    assert.equal(await page.evaluate(() => window.__handoffs.length), 0, 'handoff waits for the first workspace/session binding');
    assert.equal(await page.evaluate(() => window.__petChatOpenWorkbench()), false, 'duplicate handoff clicks are ignored while binding');
    releaseWorkspace?.(); releaseWorkspace = null; holdWorkspace = false;
    await backendSessionCreated;
    await streamArrived;
    assert.equal(await page.evaluate(() => window.__handoffPending), true);
    assert.deepEqual(await page.evaluate(() => window.__handoffs), [{ sessionId: 'synthetic-bound-session', runId: '' }], 'first-turn handoff follows the bound ID instead of opening a new session');
    assert.equal(requests.filter(r => r.method === 'POST' && r.path === '/sessions').length, createsBeforeHandoff + 1, 'sender and workbench share a single backend session creation');
    assert(await page.locator('#messages').innerText().then(t => t.includes('合成首条用户消息')), 'binding a new backend session keeps the user message visible');
    await page.waitForFunction(() => document.querySelector('#messages #runTimelineSummary')?.textContent === '收起过程');
    assert.equal(await page.locator('#memoryContextStatus').count(), 0, 'memory module creates no token/context counter');
    assert.equal(requests.some(r => r.path.endsWith('/context-status')), false, 'removed counter performs no polling');
    assert.equal(await page.locator('#messages #runTimeline').isVisible(), true, 'workbench progress is inside the assistant output');
    assert.equal(await page.locator('#runTimeline').evaluate(el => el.open), true, 'model output is directly visible by default');
    assert.equal(await page.locator('#runStatus').isVisible(), false, 'progress is not duplicated above the transcript');
    pushStreamEvent('llm_started', { stage: 'decision', payload: { llm_call_id: 'work-call-1' } });
    pushStreamEvent('llm_delta', { stage: 'decision', payload: { llm_call_id: 'work-call-1', display_target: 'agent_process', content_snapshot: '{"operation":{"type":"tool_call"},"reason":"内部原因不可见","assistant_message":"先查找相关资料"}' } });
    await page.waitForTimeout(60);
    assert.equal(await page.locator('.run-process-model').count(), 0, 'raw decision JSON is never rendered, even when it contains assistant_message');
    assert.equal((await page.locator('#messages').innerText()).includes('内部原因不可见'), false);
    pushStreamEvent('assistant_message', { message: '**先查找相关资料**。需要使用检索工具。', payload: { metadata: { step_index: 1 } } });
    await page.waitForFunction(() => document.querySelector('.run-process-text')?.innerText.includes('先查找相关资料'));
    assert.equal(await page.locator('.run-process-text strong').innerText(), '先查找相关资料');
    assert.equal(await page.locator('.run-process-model').count(), 1, 'one parsed assistant_message becomes one text block');
    pushStreamEvent('tool_started', { payload: { tool_name: '合成检索', status: 'running' } });
    await page.waitForFunction(() => document.querySelector('.run-process-tool .run-process-state')?.textContent === '调用中');
    pushStreamEvent('tool_completed', { payload: { tool_name: '合成检索', status: 'completed' } });
    await page.waitForFunction(() => document.querySelector('.run-process-tool .run-process-state')?.textContent === '完成');
    pushStreamEvent('assistant_message', { message: '**继续整理检索结果**\n\n<img src=x onerror=window.__unsafeProcess=true>', payload: { metadata: { step_index: 2 } } });
    await page.waitForFunction(() => document.querySelectorAll('.run-process-model').length === 2);
    assert.deepEqual(await page.locator('#runTimelineList li').evaluateAll(nodes => nodes.map(node => node.classList.contains('run-process-model') ? 'message' : 'tool')), ['message', 'tool', 'message']);
    assert.equal(await page.locator('.run-process-tool').count(), 1, 'tool completion updates its original line');
    assert.equal(await page.locator('.run-process-text strong').count(), 2);
    assert.equal(await page.locator('.run-process-text img').count(), 0, 'progress text is rendered without executing HTML');
    assert.equal(await page.evaluate(() => Boolean(window.__unsafeProcess)), false);
    assert.equal((await page.locator('#messages .message-content').allInnerTexts()).join('').includes('继续整理检索结果'), false, 'assistant_message stays separate from final answer');
    await page.locator('#runTimelineSummary').click();
    assert.equal(await page.locator('#runTimeline').evaluate(el => el.open), false);
    pushStreamEvent('assistant_message', { message: '折叠后的最新过程文字', payload: { metadata: { step_index: 3 } } });
    await page.waitForFunction(() => document.querySelector('#runTimelineSummary').textContent.includes('折叠后的最新过程文字'));
    assert.equal(await page.locator('#runTimeline').evaluate(el => el.open), false, 'new text preserves manual collapse');
    await page.locator('#runTimelineSummary').click();
    pushStreamEvent('llm_delta', { payload: { display_target: 'assistant_answer', content_snapshot: '**第一段实时文字**' } });
    await page.waitForFunction(() => document.querySelector('#messages .agent-live-output .message-content')?.innerText.includes('第一段实时文字'));
    assert.equal(await page.locator('#sendButton').isDisabled(), true, 'answer is painted while the SSE stream remains unfinished');
    pushStreamEvent('llm_delta', { payload: { display_target: 'assistant_answer', delta: '\n\n第二段继续到达' } });
    await page.waitForFunction(() => document.querySelector('#messages .agent-live-output .message-content')?.innerText.includes('第二段继续到达'));
    await page.screenshot({ path: path.resolve(ROOT, '../../../.runtime/quick-chat-preview/work-live-progress.png') });

    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(30);
    assert.equal(await page.locator('#messages .message.user').count(), 1, 'background synchronization/focus does not duplicate the user message');
    releaseStream?.(); releaseStream = null;
    await page.waitForFunction(() => document.querySelector('#messages').innerText.includes('合成回复'), null, { timeout: 5000 });
    assert.equal(await page.locator('#messages .message.user').count(), 1);
    assert.equal(await page.locator('#messages .message.assistant').count(), 1);
    assert.equal(await page.locator('#messages .agent-live-output').count(), 0, 'final completion replaces live output once');
    assert.equal(await page.locator('#runTimeline:visible').count(), 0, 'final answer removes the live progress display');
    assert(await page.locator('#messages .message.assistant strong').count() >= 1, 'assistant markdown is rendered');
    assert.equal(failures.length, 0, failures.join('\n'));
    assert.equal(externalAttempts.length, 0, 'all browser network requests stay on the synthetic origin');

    const popupAwaited = context.waitForEvent('page');
    await page.evaluate(() => { delete window.petBridge; document.getElementById('openWorkbenchButton').click(); });
    const workbenchPopup = await popupAwaited;
    await workbenchPopup.waitForURL('**/desktop-pet/chat.html?**session_id=synthetic-bound-session');
    const target = new URL(workbenchPopup.url());
    assert.equal(target.searchParams.get('mode'), 'work');
    assert.equal(target.searchParams.get('session_id'), 'synthetic-bound-session', 'HTML workbench button opens the selected conversation');
    await workbenchPopup.close();

    // Independent panel preferences must resize the conversation without losing data.
    const panelsContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const panels = await panelsContext.newPage();
    panels.on('pageerror', error => failures.push(error.message));
    await panels.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await panels.goto(origin + '/chat.html?mode=work&session_id=synthetic-workbench-existing&backend=' + encodeURIComponent(origin));
    await panels.locator('#messages').getByText('已有会话里的合成回答', { exact: true }).waitFor();
    const mainWidth = () => panels.locator('.chat-main').evaluate(n => n.getBoundingClientRect().width);
    const initialWidth = await mainWidth();
    await panels.locator('#questionInput').fill('切换面板时保留的合成草稿');
    await panels.locator('#toggleSidebarButton').click();
    assert.equal(await panels.locator('#sessionSidebar').isVisible(), false);
    assert.equal(await panels.locator('#sidebarResizeHandle').isVisible(), false, 'collapsed list has no invisible resize handle');
    assert.equal(await panels.locator('#toggleSidebarButton').getAttribute('aria-expanded'), 'false');
    assert(await mainWidth() > initialWidth + 200, 'closing the list frees its entire column');
    await panels.locator('#filesTabButton').click();
    const widthWithoutList = await mainWidth();
    await panels.locator('#toggleSettingsButton').click();
    assert.equal(await panels.locator('#contextRail').isVisible(), false);
    assert.equal(await panels.locator('#railResizeHandle').isVisible(), false);
    assert(await mainWidth() > widthWithoutList + 250, 'closing the rail frees its entire column');
    assert.equal(await panels.locator('#workspaceInput').evaluate(n => { n.focus(); return document.activeElement === n; }), false, 'hidden settings cannot receive keyboard focus');
    assert.equal(await panels.locator('#questionInput').inputValue(), '切换面板时保留的合成草稿');
    assert.equal(await panels.locator('#messages').getByText('已有会话里的合成回答', { exact: true }).count(), 1);
    await panels.screenshot({ path: path.resolve(ROOT, '../../../.runtime/quick-chat-preview/workbench-panels-collapsed.png') });
    await panels.reload();
    await panels.waitForFunction(() => window.LkaChatContext);
    assert.equal(await panels.locator('#sessionSidebar').isVisible(), false, 'list preference survives refresh');
    assert.equal(await panels.locator('#contextRail').isVisible(), false, 'rail preference survives refresh');
    await panels.locator('#toggleSettingsButton').click();
    assert.equal(await panels.locator('#contextRail').isVisible(), true, 'rail opens independently of the list');
    await panels.locator('#filesTabButton').click();
    await panels.locator('#toggleSettingsButton').click();
    await panels.locator('#toggleSettingsButton').click();
    assert.equal(await panels.locator('#filesPanel').isVisible(), true, 'reopening preserves the chosen file/settings tab');
    await panels.locator('#toggleSidebarButton').focus();
    await panels.keyboard.press('Enter');
    assert.equal(await panels.locator('#sessionSidebar').isVisible(), true, 'panel controls work from the keyboard');
    assert.equal(await panels.locator('#closeSidebarButton').count(), 0, 'no redundant sidebar arrow');
    assert.equal(await panels.locator('#closeSettingsButton').isVisible(), false, 'no redundant desktop rail close button');
    await panels.locator('#newQuickSessionButton').click();
    assert.equal(await panels.locator('#sessionSidebar').isVisible(), true, 'starting a new task preserves the docked list');
    await panels.locator('#toggleSidebarButton').click();
    assert.equal(await panels.locator('#sessionSidebar').isVisible(), false, 'topbar toggle also closes the list');
    await panels.locator('#toggleSidebarButton').click();
    await panels.screenshot({ path: path.resolve(ROOT, '../../../.runtime/quick-chat-preview/workbench-panels-expanded.png') });
    // On narrower screens the rail/list become temporary drawers; desktop choices survive.
    await panels.setViewportSize({ width: 1000, height: 768 });
    await panels.waitForFunction(() => document.querySelector('#contextRail').inert);
    await panels.locator('#toggleSettingsButton').click();
    await panels.waitForFunction(() => !document.querySelector('#contextRail').inert);
    await panels.locator('#toggleSettingsButton').click();
    await panels.setViewportSize({ width: 640, height: 700 });
    await panels.locator('#toggleSidebarButton').click();
    await panels.waitForFunction(() => !document.querySelector('#sessionSidebar').inert);
    await panels.locator('#toggleSidebarButton').click();
    await panels.waitForFunction(() => document.querySelector('#sessionSidebar').inert);
    await panels.keyboard.press('Control+Shift+K');
    assert.equal(await panels.locator('#sessionSearchInput').evaluate(n => n === document.activeElement), true, 'search shortcut opens a drawer and focuses its input immediately');
    await panels.keyboard.press('Escape');
    await panels.setViewportSize({ width: 1440, height: 900 });
    await panels.waitForFunction(() => !document.querySelector('#contextRail').inert && !document.querySelector('#sessionSidebar').inert);
    assert.equal(await panels.locator('#sessionSidebar').isVisible(), true);
    assert.equal(await panels.locator('#contextRail').isVisible(), true, 'desktop preferences are not overwritten by drawer closes');
    assert(await panels.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'panels introduce no horizontal overflow');
    await panelsContext.close();

    // Browse locations without binding until the user explicitly confirms.
    const workspaceWrites = () => requests.filter(r => r.method === 'PUT' && /\/sessions\/[^/]+\/workspace$/.test(r.path));
    const beforeBrowse = workspaceWrites().length;
    await page.locator('#changeWorkspaceButton').click();
    await page.waitForFunction(() => document.querySelector('#workspacePickerSelection').textContent === 'C:/synthetic/workspace');
    await page.locator('#workspacePickerUp').click();
    await page.locator('.workspace-browser-folder').filter({ hasText: 'chosen' }).waitFor();
    await page.locator('#workspacePickerMore').click();
    await page.locator('.workspace-browser-folder').filter({ hasText: 'workspace' }).waitFor();
    await page.locator('#workspacePickerFilter').fill('chosen');
    await page.waitForFunction(() => document.querySelectorAll('.workspace-browser-folder').length === 1);
    await page.locator('.workspace-browser-folder').click();
    await page.waitForFunction(() => document.querySelector('#workspacePickerSelection').textContent === 'C:/synthetic/chosen');
    assert.equal(workspaceWrites().length, beforeBrowse, 'directory navigation does not bind or create workspaces');
    await page.locator('#workspacePickerCancel').click();
    assert.equal(await page.evaluate(() => window.LkaChatContext.get().workspace), 'C:/synthetic/workspace');
    await page.evaluate(() => window.LkaChatContext.setWorkspace('/home/synthetic/linux-workspace'));
    await page.locator('#changeWorkspaceButton').click();
    await page.waitForFunction(() => document.querySelector('#workspacePickerSelection').textContent === 'C:/synthetic/workspace');
    assert.equal(await page.evaluate(() => window.LkaChatContext.get().workspace), '/home/synthetic/linux-workspace', 'Windows browsing fallback does not change a WSL-only workspace');
    await page.locator('#workspacePickerCancel').click();
    await page.evaluate(() => window.LkaChatContext.setWorkspace('C:/synthetic/workspace'));
    await page.locator('#changeWorkspaceButton').click();
    await page.waitForFunction(() => document.querySelector('#workspacePickerSelection').textContent === 'C:/synthetic/workspace');
    await page.locator('#workspacePickerPath').fill('C:/synthetic/chosen');
    await page.locator('#workspacePickerLocation').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector('#workspacePickerSelection').textContent === 'C:/synthetic/chosen');
    await page.screenshot({ path: path.resolve(ROOT, '../../../.runtime/quick-chat-preview/workspace-picker-desktop.png') });
    await page.locator('#workspacePickerUse').click();
    await page.waitForFunction(() => document.querySelector('#workspacePicker').hidden);
    assert.equal(await page.evaluate(() => window.LkaChatContext.get().workspace), 'C:/synthetic/chosen');
    assert.equal(JSON.parse(workspaceWrites().at(-1).body).path, 'C:/synthetic/chosen');
    assert.equal(await page.locator('#workspaceInput').inputValue(), 'C:/synthetic/chosen');
    await page.locator('#changeWorkspaceButton').click();
    await page.waitForFunction(() => document.querySelector('#workspacePickerSelection').textContent === 'C:/synthetic/chosen');
    await page.locator('#workspacePickerPath').fill('C:/synthetic/forbidden');
    await page.locator('#workspacePickerLocation').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector('#workspacePickerSelection').textContent === 'C:/synthetic/forbidden');
    await page.locator('#workspacePickerUse').click();
    await page.locator('#workspacePickerStatus').getByText('synthetic_workspace_denied', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.LkaChatContext.get().workspace), 'C:/synthetic/chosen', 'rejected directory preserves original workspace');
    assert.equal(await page.locator('#workspacePicker').isVisible(), true, 'failed binding is shown in the picker');
    await page.locator('#workspacePickerCancel').click();
    await page.setViewportSize({ width: 390, height: 568 });
    await page.locator('#changeWorkspaceButton').click();
    await page.waitForFunction(() => document.querySelector('#workspacePickerSelection').textContent === 'C:/synthetic/chosen');
    const pickerBounds = await page.locator('.workspace-browser').evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom }; });
    assert(pickerBounds.left >= 0 && pickerBounds.right <= 390 && pickerBounds.bottom <= 568, 'phone directory browser fits viewport');
    await page.screenshot({ path: path.resolve(ROOT, '../../../.runtime/quick-chat-preview/workspace-picker-phone.png') });
    await page.locator('#workspacePickerPath').fill('C:/synthetic/missing');
    await page.locator('#workspacePickerLocation').evaluate(form => form.requestSubmit());
    await page.locator('#workspacePickerStatus').getByText('目录不存在', { exact: false }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#workspacePicker').isVisible(), false);
    await page.setViewportSize({ width: 1280, height: 720 });

    // Saving from a chat message still confirms success after removing the token panel.
    await page.evaluate(() => window.LkaMemory.remember('合成记忆保存验证'));
    await page.locator('#memoryEditorSave').click();
    await page.waitForFunction(() => document.getElementById('memoryEditorOverlay').hidden);
    assert.equal(await page.locator('#memorySaveNotice').isVisible(), true);
    assert((await page.locator('#memorySaveNotice').innerText()).includes('记忆已保存并确认'));
    assert.equal(await page.locator('#memoryEditorError').innerText(), '');
    assert.equal(await page.locator('#memoryContextStatus').count(), 0);

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
    // Sending from the top of a long workbench history must reveal the new
    // question and its live output after the complete turn layout is applied.
    await bridgePage.evaluate(() => window.__petChatReceive({ session_id: 'synthetic-native-session',
      answer: Array.from({ length: 100 }, (_, i) => '合成历史段落 ' + (i + 1)).join('\n\n') }));
    await bridgePage.waitForFunction(() => { const log = document.querySelector('#messages'); return log.scrollHeight > log.clientHeight * 3; });
    await bridgePage.locator('#messages').evaluate(log => { log.scrollTop = 0; });
    assert.equal(await bridgePage.evaluate(() => window.__petChatSubmitText('从历史顶部发送新的工作台任务')), true);
    await bridgePage.waitForFunction(() => window.__sentPayload.question === '从历史顶部发送新的工作台任务');
    await bridgePage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const sentPosition = await bridgePage.locator('#messages').evaluate(log => {
      const question = log.querySelector('.message.user:last-of-type') || Array.from(log.querySelectorAll('.message.user')).at(-1);
      const view = log.getBoundingClientRect(), rect = question.getBoundingClientRect();
      return { remaining: log.scrollHeight - log.clientHeight - log.scrollTop, questionVisible: rect.top >= view.top && rect.bottom <= view.bottom };
    });
    assert(sentPosition.remaining <= 2, 'new workbench turn reaches the bottom after layout: ' + JSON.stringify(sentPosition));
    assert(sentPosition.questionVisible, 'latest workbench question is visible');
    await bridgePage.locator('#messages').evaluate(log => { log.scrollTop = 65; });
    await bridgePage.locator('#questionInput').fill('阅读历史时保留位置的草稿');
    await bridgePage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await bridgePage.locator('#messages').evaluate(log => Math.abs(log.scrollTop - 65) < 2), 'editing a draft does not jump away from history');
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
    // Quick mode: compact start, then a resizable reading area with complete history.
    const quickContext = await browser.newContext({ viewport: { width: 420, height: 174 } });
    const quick = await quickContext.newPage();
    quick.on('pageerror', error => failures.push(error.message));
    await quick.addInitScript(() => {
      localStorage.setItem('agentic-rag-pet-run-settings-v1', JSON.stringify({ stream: false }));
      window.__panelHeights = [];
      window.__handoffs = [];
      window.petBridge = {
        openWorkbenchSession: (sessionId, runId) => window.__handoffs.push({ sessionId, runId }),
        createSessionWorkspace: () => JSON.stringify({ path: 'C:/synthetic/quick-workspace' }),
        setSessionWorkspace: () => JSON.stringify({ project_id: 'synthetic-quick-project' }),
        setQuickPanelHeight: height => window.__panelHeights.push(height),
        send: payload => { window.__sentPayload = JSON.parse(payload); }
      };
      window.LkaMemory = { request: async () => ({ projects: [{ project_id: 'synthetic-chosen-project', name: '合成项目', workspace_path: 'C:/synthetic/chosen-project' }], next_offset: null }) };
    });
    await quick.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { externalAttempts.push(new URL(route.request().url()).origin); return route.abort(); } return route.continue(); });
    await quick.goto(origin + '/chat.html?mode=quick&backend=' + encodeURIComponent(origin));
    await quick.waitForFunction(() => window.__panelHeights.length > 0);
    assert.equal(await quick.locator('#messages .message').count(), 0, 'quick mode has no greeting occupying space');
    assert.equal(await quick.locator('.context-strip').isVisible(), false, 'workspace controls are not in the resting quick window');
    assert.equal(await quick.locator('#questionInput').isVisible(), true);
    assert(await quick.evaluate(() => window.__panelHeights.at(-1) <= 45), 'native content starts with only the compact toolbar');
    await quick.screenshot({ path: path.resolve(ROOT, '../../../.runtime/quick-chat-preview/empty.png') });
    const createsBeforeEmptyHandoff = requests.filter(r => r.method === 'POST' && r.path === '/sessions').length;
    assert.equal(await quick.evaluate(() => window.__petChatOpenWorkbench()), true);
    assert.deepEqual(await quick.evaluate(() => window.__handoffs), [{ sessionId: '', runId: '' }], 'empty quick task opens the workbench new-task page');
    assert.equal(requests.filter(r => r.method === 'POST' && r.path === '/sessions').length, createsBeforeEmptyHandoff, 'empty handoff does not persist a new blank backend session');
    const createsBeforeProject = requests.filter(r => r.method === 'POST' && r.path === '/sessions').length;
    await quick.locator('#questionInput').fill('选择项目前的草稿');
    await quick.locator('#quickProjectsButton').click();
    await quick.waitForFunction(() => window.__panelHeights.at(-1) >= 310);
    await quick.locator('.quick-project-list button').click();
    assert.equal(await quick.evaluate(() => window.LkaChatContext.get().workspace), 'C:/synthetic/chosen-project');
    assert.equal(await quick.evaluate(() => window.LkaChatContext.get().projectId), 'synthetic-chosen-project');
    assert.equal(await quick.locator('#questionInput').inputValue(), '选择项目前的草稿', 'project selection preserves the current draft');
    assert.equal(requests.filter(r => r.method === 'POST' && r.path === '/sessions').length, createsBeforeProject, 'selecting a project keeps a local draft until the first send');
    await quick.locator('#toggleSidebarButton').click();
    await quick.waitForFunction(() => window.__panelHeights.at(-1) >= 310);
    assert.equal(await quick.locator('#sessionSidebar').isVisible(), true);
    await quick.locator('#sidebarBackdrop').click({ position: { x: 410, y: 3 } });
    await quick.locator('#questionInput').fill('合成快速任务');
    await quick.locator('#questionInput').press('Shift+Enter');
    assert((await quick.locator('#questionInput').inputValue()).endsWith('\n'), 'Shift+Enter keeps a newline');
    await quick.locator('#questionInput').press('Enter');
    await quick.waitForFunction(() => window.__sentPayload);
    assert.equal(await quick.locator('#messages .message.user').count(), 1);
    await quick.waitForFunction(() => window.__panelHeights.at(-1) > 45);
    await quick.locator('#questionInput').fill('下一条草稿');
    assert.equal(await quick.locator('#questionInput').isEnabled(), true, 'busy quick mode keeps input editable');
    assert.equal(await quick.locator('#sendButton').isDisabled(), true);
    assert.equal(await quick.evaluate(() => window.__petChatOpenWorkbench()), true);
    assert.equal(await quick.evaluate(() => window.__handoffs.at(-1).sessionId === window.__sentPayload.session_id), true, 'running quick task opens the currently sent conversation');
    assert.equal(await quick.locator('#sendButton').isDisabled(), true, 'handoff does not cancel or complete the running task');
    await quick.evaluate(() => {
      const opener = window.petBridge.openWorkbenchSession;
      window.petBridge.openWorkbenchSession = () => { throw new Error('synthetic_browser_launch_failure'); };
      window.__savedOpener = opener;
    });
    assert.equal(await quick.evaluate(() => window.__petChatOpenWorkbench()), false);
    assert((await quick.locator('#runStatus').textContent()).includes('synthetic_browser_launch_failure'), 'failed browser launch is visible as an error');
    assert.equal(await quick.locator('#messages .message.user').count(), 1, 'failed launch retains the current task');
    await quick.evaluate(() => { window.petBridge.openWorkbenchSession = window.__savedOpener; });
    assert.equal(await quick.evaluate(() => window.__petChatOpenWorkbench()), true, 'browser launch can be retried');
    assert.equal(await quick.locator('#runStatus').evaluate(el => el.classList.contains('error')), false, 'successful retry clears the launch error');

    await quick.evaluate(() => {
      const approval = document.getElementById('approvalQueueStatus');
      approval.innerHTML = '<h3>需要确认</h3><p>合成操作说明</p><button>允许执行</button>'; approval.hidden = false;
    });
    await quick.waitForFunction(() => window.__panelHeights.at(-1) >= 310);
    await quick.setViewportSize({ width: 420, height: 552 });
    assert.equal(await quick.locator('#approvalQueueStatus button').isVisible(), true, 'quick approval is visible in the expanded window');
    await quick.evaluate(() => {
      document.getElementById('approvalQueueStatus').hidden = true;
      window.__petChatReceive({ session_id: window.__sentPayload.session_id, answer: '**合成快速回复**\n\n' + Array(30).fill('这是合成的长内容，用来检查窗口滚动。').join('\n\n') });
    });
    await quick.waitForFunction(() => document.querySelector('#messages').scrollHeight > document.querySelector('#messages').clientHeight);
    assert(await quick.locator('#messages .message.assistant strong').count() >= 1);
    assert(await quick.locator('#messages').evaluate(el => el.clientHeight >= 420), 'expanded transcript has a substantial reading area');
    assert.equal(await quick.locator('#questionInput').inputValue(), '下一条草稿');
    assert.equal(await quick.evaluate(() => window.__petChatOpenWorkbench()), true);
    assert.equal(await quick.evaluate(() => window.__handoffs.at(-1).sessionId === window.__sentPayload.session_id), true, 'completed task opens the same conversation');

    await quick.screenshot({ path: path.resolve(ROOT, '../../../.runtime/quick-chat-preview/conversation.png') });
    assert.equal(await quick.locator('.memory-message-action:visible').count(), 0, 'message actions do not squeeze quick text');
    assert.equal(await quick.locator('#messages .bubble > strong:visible').count(), 0, 'role labels do not repeat on each quick message');
    assert.equal(await quick.locator('#messages .markdown-body strong').evaluate(el => getComputedStyle(el).fontSize), '13px', 'bold reply text keeps readable body sizing');
    assert.equal(await quick.locator('#messages').evaluate(el => el.scrollTop), 0, 'long reply starts at its beginning');
    await quick.locator('#messages').evaluate(el => { el.scrollTop = 65; });
    await quick.waitForTimeout(30);
    await quick.evaluate(() => {
      const body = document.querySelector('#messages .assistant .message-content');
      window.PetMarkdown.render(body, body._petMarkdownSource + '\n\n合成流式追加段落。');
      window.__petQuickScrollToLatest();
    });
    await quick.waitForTimeout(50);
    assert(await quick.locator('#messages').evaluate(el => Math.abs(el.scrollTop - 65) < 2), 'reply growth preserves the reader scroll position');
    await quick.evaluate(() => window.__petChatSubmitText('第二个合成问题'));
    await quick.waitForFunction(() => window.__sentPayload.question === '第二个合成问题');
    await quick.evaluate(() => window.__petChatReceive({ session_id: window.__sentPayload.session_id, answer: '好的，先处理当前这件事。' }));
    await quick.waitForFunction(() => document.querySelectorAll('#messages .message:not([hidden])').length === 4);
    assert.equal(await quick.locator('#messages .message.user:visible').count(), 2, 'previous questions remain in the normal transcript');
    assert.equal(await quick.locator('#messages .message.assistant:visible').count(), 2);
    assert.equal(await quick.locator('#quickHistoryButton').count(), 0, 'no context/history header occupies reading space');
    assert.equal(await quick.locator('.chat-session-meta').isVisible(), false, 'context title is hidden in quick mode');
    assert(await quick.locator('#messages').evaluate(el => el.scrollTop > 0), 'a new turn starts near the latest question');
    await quick.waitForFunction(() => { const el = document.getElementById('messages'); return Math.abs(el.querySelectorAll('.message.user')[1].getBoundingClientRect().top - el.getBoundingClientRect().top - 6) < 3; });
    await quick.screenshot({ path: path.resolve(ROOT, '../../../.runtime/quick-chat-preview/short.png') });
    const beforeResize = await quick.locator('#messages').evaluate(el => el.clientHeight);
    const preferenceBeforeResize = await quick.evaluate(() => window.__panelHeights.at(-1));
    await quick.setViewportSize({ width: 520, height: 702 });
    await quick.waitForTimeout(80);
    assert(await quick.locator('#messages').evaluate((el, previous) => el.clientHeight >= previous + 145, beforeResize), 'dragging taller gives the space to the transcript');
    assert(await quick.locator('#questionInput').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), 'composer stays visible after resizing');
    assert.equal(await quick.evaluate(() => window.__panelHeights.at(-1)), preferenceBeforeResize, 'viewport changes do not recursively change the host height preference');
    await quick.evaluate(() => window.__petChatSubmitText('第二个合成问题'));
    await quick.waitForFunction(() => document.querySelectorAll('#messages .message.user').length === 3);
    await quick.evaluate(() => window.__petChatReceive({ session_id: window.__sentPayload.session_id, answer: '再次提问也会定位到新一轮。' }));
    await quick.waitForFunction(() => document.querySelectorAll('#messages .message.assistant').length === 3 && !document.getElementById('sendButton').disabled);
    await quick.waitForTimeout(50);
    assert(await quick.locator('#messages').evaluate(el => Math.abs(el.querySelectorAll('.message.user')[2].getBoundingClientRect().top - el.getBoundingClientRect().top - 6) < 3), 'repeating the same question still navigates to its new turn');
    await quick.evaluate(() => {
      const bodies = document.querySelectorAll('#messages .assistant .message-content');
      window.PetMarkdown.render(bodies[bodies.length - 1], '# 可以从这两步开始\n\n先整理目标，再处理最重要的一件事。\n\n- **明确目标**：把今天要完成的事情写下来。\n- **留下结果**：整理文件时记下修改原因。\n\n## 文件示例\n\n```python\nprint("一条很长的合成代码示例，仅供验证横向滚动，不能挤压整个快速会话的排版")\n```\n\n| 事项 | 状态 | 下一步 |\n| --- | --- | --- |\n| 资料整理 | 准备完成 | 检查来源 |\n\n最后，在工作台继续处理更长的内容。');
    });
    await quick.waitForTimeout(80);
    const typography = await quick.evaluate(() => {
      const node = Array.from(document.querySelectorAll('#messages .assistant .message-content')).at(-1);
      const messages = document.getElementById('messages');
      return { title: getComputedStyle(node.querySelector('h1')).fontSize,
        body: getComputedStyle(node).fontSize, code: getComputedStyle(node.querySelector('pre')).maxHeight,
        width: node.getBoundingClientRect().width, available: messages.clientWidth - 18,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(typography.title, '15px'); assert.equal(typography.body, '13px'); assert.equal(typography.code, '128px');
    assert(typography.width >= typography.available - 2, 'assistant text has the full reading column');
    assert.equal(typography.overflow, false, 'wide code/table do not overflow the whole window');
    await quick.screenshot({ path: path.resolve(ROOT, '../../../.runtime/quick-chat-preview/markdown.png') });
    await quick.locator('#messages .message.user').last().locator('.message-content').evaluate(el => {
      el.textContent = '这是一段很长的合成提问，用来确认大段内容不会把回复挤出小窗口。'.repeat(8);
    });
    await quick.waitForTimeout(60);
    assert(await quick.locator('#messages .message.user').last().locator('.message-content').evaluate(el => el.clientHeight > 35), 'questions remain complete in the taller transcript');
    await quick.locator('#quickProjectsButton').hover();
    await quick.waitForFunction(() => !document.getElementById('quickButtonTooltip').hidden);
    assert.equal(await quick.locator('#quickButtonTooltip').innerText(), '选择项目', 'icon hover describes its function');
    await quick.mouse.move(410, 20);
    await quick.waitForFunction(() => document.getElementById('quickButtonTooltip').hidden);

    await quick.locator('#newQuickSessionButton').click();
    await quick.waitForFunction(() => window.__panelHeights.at(-1) <= 45);
    assert.equal(await quick.locator('#messages .message').count(), 0, 'new task collapses the conversation');
    await quick.evaluate(() => window.__petChatBridgeReady());
    assert.equal(await quick.locator('#questionInput').isVisible(), false, 'native mode uses the native IME composer');
    assert.equal(failures.length, 0, failures.join('\n'));
    assert.equal(externalAttempts.length, 0);
    await quickContext.close();

    // Java bridge SSE: the quick window paints deltas before terminal completion.
    const quickStreamContext = await browser.newContext({ viewport: { width: 420, height: 552 } });
    const quickStream = await quickStreamContext.newPage();
    quickStream.on('pageerror', error => failures.push(error.message));
    await quickStream.addInitScript(() => {
      localStorage.setItem('agentic-rag-pet-run-settings-v1', JSON.stringify({ stream: true }));
      window.petBridge = {
        createSessionWorkspace: () => JSON.stringify({ path: 'C:/synthetic/stream-workspace' }),
        setSessionWorkspace: () => JSON.stringify({ project_id: 'synthetic-stream-project' }),
        setQuickPanelHeight: () => {},
        stream: payload => { window.__streamPayload = JSON.parse(payload); }
      };
    });
    await quickStream.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { externalAttempts.push(new URL(route.request().url()).origin); return route.abort(); } return route.continue(); });
    await quickStream.goto(origin + '/chat.html?mode=quick&with_memory=1&backend=' + encodeURIComponent(origin));
    await quickStream.waitForFunction(() => typeof window.__petChatSubmitText === 'function');
    await quickStream.evaluate(() => window.__petChatSubmitText('合成快速流式任务'));
    await quickStream.waitForFunction(() => window.__streamPayload && typeof window.__petChatReceiveStream === 'function');
    await quickStream.evaluate(() => window.__petChatReceiveStream('llm_started', { stage: 'answer' }));
    await quickStream.waitForFunction(() => document.querySelector('#messages #runTimelineSummary')?.textContent === '收起过程');
    assert.equal(await quickStream.locator('#runTimeline').isVisible(), true);
    assert.equal(await quickStream.locator('.quick-progress').count(), 0, 'no separate bottom progress bar');
    assert.equal(await quickStream.locator('#memoryContextStatus').count(), 0);
    assert.equal(await quickStream.locator('#runTimeline').evaluate(el => el.open), true);
    await quickStream.evaluate(() => {
      const event = (name, sequence, stage, payload, message) => window.__petChatReceiveStream(name, { type: name, run_id: 'quick-demo-run', sequence, stage, payload, message });
      event('llm_started', 1, 'decision', { llm_call_id: 'quick-call-1' });
      event('llm_delta', 2, 'decision', { llm_call_id: 'quick-call-1', display_target: 'agent_process', delta: '{"operation":{"tool_input":{"assistant_message":"嵌套内容不可见"}},' });
      event('llm_delta', 3, 'decision', { llm_call_id: 'quick-call-1', display_target: 'agent_process', delta: '"reason":"内部原因不可见","assistant_message":"先查资料"}' });
      event('llm_completed', 4, 'decision', { llm_call_id: 'quick-call-1', status: 'completed' });
      event('assistant_message', 5, 'decision', { metadata: { step_index: 1 } }, '我先查找相关资料。');
      event('assistant_message', 5, 'decision', { metadata: { step_index: 1 } }, '我先查找相关资料。');
      event('tool_started', 6, 'tool_execute', { tool_name: '合成读取', status: 'running' });
      event('tool_completed', 7, 'tool_execute', { tool_name: '合成读取', status: 'failed' });
      event('llm_started', 8, 'decision', { llm_call_id: 'quick-call-2' });
      event('llm_delta', 9, 'decision', { llm_call_id: 'quick-call-2', display_target: 'agent_process', content_snapshot: '{"operation":{"type":"no_op"},"assistant_message":"读取失败，调整下一步"}' });
      event('llm_completed', 10, 'decision', { llm_call_id: 'quick-call-2', status: 'completed' });
      event('assistant_message', 11, 'decision', { metadata: { step_index: 2 } }, '**读取失败，调整下一步**');
      event('assistant_message', 12, 'decision', { metadata: { step_index: 3 } }, '   ');
    });
    await quickStream.waitForFunction(() => document.querySelectorAll('.run-process-model').length === 2);
    assert.deepEqual(await quickStream.locator('#runTimelineList li').evaluateAll(nodes => nodes.map(node => node.classList.contains('run-process-model') ? 'message' : 'tool')), ['message', 'tool', 'message']);
    assert.equal(await quickStream.locator('.run-process-tool .run-process-state').innerText(), '失败');
    assert.equal(await quickStream.locator('.run-process-model').first().innerText(), '我先查找相关资料。', 'duplicate sequence does not duplicate assistant_message');
    assert.equal(await quickStream.locator('.run-process-model strong').innerText(), '读取失败，调整下一步');
    assert.equal(await quickStream.locator('.run-process-model pre').count(), 0, 'no raw JSON code blocks are shown');
    const processText = await quickStream.locator('#runTimelineList').innerText();
    for (const internal of ['operation', 'assistant_message', '内部原因不可见', '嵌套内容不可见']) assert.equal(processText.includes(internal), false, 'internal control fields must not appear: ' + internal);
    await quickStream.screenshot({ path: path.resolve(ROOT, '../../../.runtime/quick-chat-preview/quick-live-progress.png') });
    await quickStream.evaluate(() => {
      window.__petChatReceiveStream('tool_started', { payload: { tool_name: '合成未授权工具', status: 'running' } });
      window.__petChatReceiveStream('tool_completed', { payload: { tool_name: '合成未授权工具', status: 'rejected' } });
    });
    await quickStream.waitForFunction(() => Array.from(document.querySelectorAll('.run-process-state')).some(el => el.textContent === '未执行'));
    await quickStream.evaluate(() => {
      for (let step = 0; step < 105; step++) window.__petChatReceiveStream('tool_started', { tool_name: '合成步骤 ' + step });
    });
    await quickStream.waitForFunction(() => Array.from(document.querySelectorAll('.run-process-tool .run-process-label')).some(el => el.textContent === '合成步骤 104'));
    assert.equal(await quickStream.locator('#runTimeline').evaluate(el => el.open), true, 'bounded event history must not close an expanded progress list');
    assert.equal(await quickStream.locator('#runTimelineList li').count(), 100, 'progress history remains bounded');
    assert.equal(await quickStream.locator('#runTimelineList').evaluate(el => getComputedStyle(el).maxHeight), 'none', 'process text uses the full transcript rather than a second tiny scroll box');
    await quickStream.evaluate(() => window.__petChatReceiveStream('llm_delta', { payload: { display_target: 'assistant_answer', content_snapshot: '**先到的文字**' } }));
    await quickStream.waitForFunction(() => document.querySelector('#messages .agent-live-output .message-content')?.innerText.includes('先到的文字'));
    assert.equal(await quickStream.locator('#sendButton').isDisabled(), true);
    // Simulate a view replacement while a stream still owns its old body reference.
    await quickStream.evaluate(() => {
      document.querySelector('#messages .agent-live-output').remove();
      window.__petChatReceiveStream('llm_delta', { payload: { display_target: 'assistant_answer', content_snapshot: '**先到的文字**\n\n刷新视图后的新文字' } });
    });
    await quickStream.waitForFunction(() => document.querySelector('#messages .agent-live-output .message-content')?.innerText.includes('刷新视图后的新文字'));
    await quickStream.evaluate(() => window.__petChatReceiveStream('tool_started', { tool_name: '合成整理' }));
    await quickStream.waitForFunction(() => Array.from(document.querySelectorAll('#messages .run-process-tool .run-process-label')).some(el => el.textContent === '合成整理'));
    const processModelsBeforeFinalAudit = await quickStream.locator('.run-process-model').count();
    await quickStream.evaluate(() => {
      window.__petChatReceiveStream('llm_started', { stage: 'answer', payload: { llm_call_id: 'quick-final-call', content_role: 'final_answer' } });
      window.__petChatReceiveStream('llm_completed', { stage: 'answer', payload: { llm_call_id: 'quick-final-call', content_role: 'final_answer', status: 'completed' } });
    });
    assert.equal(await quickStream.locator('.run-process-model').count(), processModelsBeforeFinalAudit, 'final answer audit never becomes a blank process block');
    await quickStream.evaluate(() => window.__petChatReceiveStream('final_answer', { payload: { metadata: { answer: '**最终校准的完整答案**' } } }));
    await quickStream.waitForFunction(() => document.querySelector('#messages').innerText.includes('最终校准的完整答案'));
    assert.equal(await quickStream.locator('#runTimeline:visible').count(), 0);
    await quickStream.evaluate(() => window.__petChatReceiveStream('run_completed', {}));
    await quickStream.waitForFunction(() => !document.getElementById('sendButton').disabled);
    assert.equal(await quickStream.locator('#messages .message.assistant').count(), 1);
    assert.equal(await quickStream.locator('#messages .agent-live-output').count(), 0);
    assert.equal(await quickStream.locator('#messages .message.assistant .message-content').innerText(), '最终校准的完整答案');
    assert.equal(await quickStream.evaluate(() => JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4')).flatMap(session => session.messages).flatMap(message => message.progressEvents || []).filter(event => event.type === 'llm_delta').length), 0, 'raw model JSON chunks are not duplicated into persisted chat details');
    assert.equal(failures.length, 0, failures.join('\n'));
    assert.equal(externalAttempts.length, 0);
    await quickStreamContext.close();

    // Separate native and browser storage: the workbench must load by backend ID.
    const sourceContext = await browser.newContext();
    const destinationContext = await browser.newContext();
    const source = await sourceContext.newPage();
    const destination = await destinationContext.newPage();
    for (const isolated of [source, destination]) {
      isolated.on('pageerror', error => failures.push(error.message));
      await isolated.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    }
    await source.addInitScript(() => {
      window.__handoff = null;
      window.petBridge = { openWorkbenchSession: (sessionId, runId) => { window.__handoff = { sessionId, runId }; } };
    });
    await source.goto(origin + '/chat.html?mode=quick&session_id=synthetic-workbench-existing&backend=' + encodeURIComponent(origin));
    await source.waitForFunction(() => window.LkaChatContext?.get().sessionId === 'synthetic-workbench-existing');
    const createsBeforeExisting = requests.filter(r => r.method === 'POST' && r.path === '/sessions').length;
    assert.equal(await source.evaluate(() => window.__petChatOpenWorkbench()), true);
    const handoff = await source.evaluate(() => window.__handoff);
    assert.equal(handoff.sessionId, 'synthetic-workbench-existing');
    await destination.goto(origin + '/desktop-pet/chat.html?mode=work&session_id=' + encodeURIComponent(handoff.sessionId) + '&backend=' + encodeURIComponent(origin));
    await destination.waitForFunction(() => window.LkaChatContext?.get().sessionId === 'synthetic-workbench-existing');
    assert((await destination.locator('#messages').innerText()).includes('已有会话里的合成问题'));
    assert.equal(await destination.locator('#messages .message.assistant .markdown-body strong').innerText(), '已有会话里的合成回答');
    assert.equal(requests.filter(r => r.method === 'POST' && r.path === '/sessions').length, createsBeforeExisting);
    assert.equal(failures.length, 0, failures.join('\n'));
    await sourceContext.close(); await destinationContext.close();

    console.log(JSON.stringify({ result: 'PASS', requests: requests.length, checks: ['workbench panels independently collapse and restore, reclaim width, remember visibility, preserve draft/history/tab, isolate hidden focus and adapt to drawers', 'workspace browser navigation/filter/pagination/cancel, confirmed binding, rollback and phone layout', 'new workbench sends reveal latest question and live output after layout; draft editing preserves history position', 'current workbench handoff for empty/running/completed tasks; first-binding dedup and launch failure', 'immediate first user visibility and localStorage persistence', 'workspace bind and backend session ID replacement', 'focus synchronization and single user bubble', 'single assistant answer with markdown', 'native fake bridge chat and __petChatReceive', 'next draft retained during reply', 'non-streaming request failure retains user and shows error', 'synthetic-origin-only network', 'held SSE stream shows real partial text before terminal, no process text as answer, final calibration', 'assistant_message text only, interleaved tool names in both modes; no JSON/operation/reason, event dedup, failure states, collapse and safe Markdown', 'compact quick window, project draft, taller viewport-filling transcript, Enter and editable busy draft, visible approval, collapse and native composer', 'full-width reply, readable Markdown, complete history without context header, stable reading offset, viewport resize and icon tooltips'] }, null, 2));
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
