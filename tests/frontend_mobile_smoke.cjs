// Synthetic localhost acceptance: no backend, credentials, QQ sends or LLM calls.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = path.resolve(__dirname, '../app/web/pet');
const OUT = path.resolve(__dirname, '../.runtime/mobile-preview');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const requests = [], errors = [], external = [], unknown = [];
const stamp = '2026-10-07T00:00:00Z';
const existing = { session_id: 'mobile-existing', title: '合成已有会话', status: 'active', metadata: {}, workspace: { path: 'C:/synthetic/workspace' }, created_at: stamp, updated_at: stamp };
const answer = '**合成最终回复**\n\n| 名称 | 详细内容 |\n| --- | --- |\n| 示例 | ' + 'LONG_UNBROKEN_VALUE_'.repeat(35) + ' |';
let stream = null, sentSession = '', sentQuestion = '', sentCompleted = false;
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1'), p = url.pathname.replace(/^\/workbench(?=\/)/, '');
  let body = ''; for await (const chunk of req) body += chunk;
  requests.push({ transportPath: url.pathname, path: p, method: req.method, body, credentials: Boolean(req.headers.authorization || req.headers.cookie) });
  const relative = decodeURIComponent(p.replace(/^\/desktop-pet(?=\/)/, '').slice(1));
  const file = path.resolve(ROOT, relative || 'chat.html');
  if (req.method === 'GET' && file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  if (p === '/agent/models') return json(res, { default_client: 'synthetic', clients: [{ name: 'synthetic', default_model: 'model-a', models: ['model-a', 'model-b'] }] });
  if (p === '/agent/safety-reviews' && req.method === 'GET') return json(res, { reviews: [] });
  if (p === '/agent/ui-defaults') return json(res, { configured: false, defaults: {} });
  if (p === '/pet/session-workspace') return json(res, { path: 'C:/synthetic/workspace' });
  if (p === '/sessions/deleted') return json(res, { sessions: [] });
  if (p === '/sessions' && req.method === 'GET') return json(res, { sessions: [existing], next_offset: null });
  if (p === '/sessions' && req.method === 'POST') return json(res, { session: { ...existing, session_id: 'mobile-created' }, messages: [] }, 201);
  if (/^\/sessions\/[^/]+\/workspace$/.test(p)) return json(res, { project_id: 'mobile-project' });
  if (/^\/sessions\/[^/]+\/files$/.test(p)) return json(res, { entries: [], truncated: false, path: '', workspace: 'C:/synthetic/workspace' });
  if (/^\/sessions\/[^/]+$/.test(p)) {
    const id = p.split('/')[2];
    const messages = id === sentSession ? [{ role: 'user', content: sentQuestion }, ...(sentCompleted ? [{ role: 'assistant', content: answer }] : [])] : [{ role: 'user', content: '合成历史问题' }, { role: 'assistant', content: '合成历史回复' }];
    return json(res, { session: { ...existing, session_id: id }, messages });
  }
  if (p === '/agent/turn/stream') {
    const turn = JSON.parse(body); sentSession = turn.session_id; sentQuestion = turn.user_input; sentCompleted = false;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    stream = res; res.write('event: llm_started\ndata: {"stage":"synthetic"}\n\n'); return;
  }
  if (p === '/projects') return json(res, { projects: [], next_offset: null });
  if (p === '/memories') return json(res, { memories: [], next_offset: null });
  if (p === '/memories/learning') return json(res, { scope: 'global', enabled: false });
  if (p === '/background/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(': synthetic\n\n'); }
  if (p === '/plugins/qq-reader/status') return json(res, { enabled: false, connection_state: 'disconnected', sync_state: 'idle' });
  if (p === '/plugins/qq-ui/status') return json(res, { enabled: false, ready: false, send_enabled: false, reading_paired: true });
  if (p === '/plugins/qq-ui/capabilities') return json(res, {});
  if (p === '/plugins/message-reading/messages/conversations') return json(res, { conversations: [], next_offset: null });
  if (p === '/plugins/message-reading/messages/policies') return json(res, { policies: [] });
  if (p === '/plugins/message-reading/messages/reading/overview') return json(res, { coverage: [], topics: [], insights: [], unseen_count: 0 });
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  unknown.push(req.method + ' ' + p); return json(res, { detail: 'Unmocked synthetic endpoint ' + p }, 404);
});
function event(type, data = {}) { assert(stream && !stream.writableEnded, 'held stream available'); stream.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n'); }
async function fits(page, selector) {
  try {
    await page.waitForFunction(selector => { const n = document.querySelector(selector); if (!n) return false; const r = n.getBoundingClientRect(); return r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }, selector);
  } catch (error) {
    const diagnostic = await page.evaluate(selector => {
      const node = document.querySelector(selector), root = document.documentElement;
      const rect = n => n ? n.getBoundingClientRect().toJSON() : null;
      return { selector, rect: rect(node), viewport: { width: innerWidth, height: innerHeight }, visualViewport: window.visualViewport ? { width: visualViewport.width, height: visualViewport.height, offsetTop: visualViewport.offsetTop, scale: visualViewport.scale } : null,
        mobileHeight: getComputedStyle(root).getPropertyValue('--mobile-height'), mobileTop: getComputedStyle(root).getPropertyValue('--mobile-top'), bodyRect: rect(document.body), scroll: { top: root.scrollTop, bodyTop: document.body.scrollTop, windowY: scrollY }, keyboardOpen: document.body.classList.contains('mobile-keyboard-open'), activeElement: document.activeElement?.id };
    }, selector);
    const screenshot = path.join(OUT, 'failure-' + selector.replace(/[^a-z0-9]+/gi, '-') + '.png');
    await page.screenshot({ path: screenshot }).catch(() => {});
    throw new Error('Viewport fit timed out: ' + JSON.stringify({ ...diagnostic, screenshot }), { cause: error });
  }
  const bounds = await page.locator(selector).evaluate(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight }; });
  assert(bounds.x >= -1 && bounds.y >= -1 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1, selector + ' fits viewport: ' + JSON.stringify(bounds));
}
async function reachableControl(page, selector) {
  const control = page.locator(selector);
  assert.equal(await control.isVisible(), true, selector + ' is available');
  await control.scrollIntoViewIfNeeded();
  await fits(page, selector);
  const clipped = await control.evaluate(node => {
    const target = node.getBoundingClientRect(), failures = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
      const left = rect.left + parent.clientLeft, top = rect.top + parent.clientTop;
      const right = left + parent.clientWidth, bottom = top + parent.clientHeight;
      if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX) && (target.left < left - 1 || target.right > right + 1)) failures.push((parent.id || parent.className || parent.tagName) + ' clips horizontally');
      if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY) && (target.top < top - 1 || target.bottom > bottom + 1)) failures.push((parent.id || parent.className || parent.tagName) + ' clips vertically');
    }
    return failures;
  });
  assert.deepEqual(clipped, [], selector + ' is reachable without ancestor clipping');
}
async function noOverflow(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'page has no horizontal overflow');
}
async function composer(page) {
  await fits(page, '#questionInput'); await fits(page, '#sendButton');
  assert(await page.locator('#questionInput').evaluate(n => parseFloat(getComputedStyle(n).fontSize) >= 16), 'input uses at least 16px text');
  assert.equal(await page.locator('#questionInput').isDisabled(), false);
}
(async () => {
  let browser;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.route('**/*', route => { const u = new URL(route.request().url()); if (u.origin !== origin) { external.push(u.origin); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(8000);
    await page.goto(origin + '/desktop-pet/mobile.html?session_id=mobile-existing');
    await page.waitForFunction(() => document.body.classList.contains('mobile-workbench'));
    const params = new URL(page.url()).searchParams;
    assert.equal(params.get('layout'), 'mobile'); assert.equal(params.get('mode'), 'work');
    assert.equal(params.get('backend'), null); assert.equal(params.get('session_id'), 'mobile-existing');
    assert.equal(await page.evaluate(() => window.LkaChatContext.get().backend), origin + '/workbench');
    await page.locator('#messages').getByText('合成历史回复', { exact: true }).waitFor();
    const creates = () => requests.filter(r => r.path === '/sessions' && r.method === 'POST').length;
    const before = creates();
    await page.locator('#newQuickSessionButton').click();
    await page.waitForFunction(() => !document.querySelector('#messages').textContent.includes('合成历史回复'));
    assert.equal(creates(), before, 'new task does not create a backend session');
    for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size); await composer(page); await noOverflow(page);
      assert.equal(await page.locator('#mobileNav [data-mobile-action]').count(), 5);
      const touchTargets = await page.locator('#mobileNav button').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
      assert(touchTargets.every(r => r.width >= 44 && r.height >= 44), 'navigation touch targets: ' + JSON.stringify(touchTargets));
      for (const [action, dialog, close] of [['projects', '#projectsOverlay [role=dialog]', '#projectsClose'], ['memory', '#memoryOverlay [role=dialog]', '#memoryClose'], ['messages', '#messageCenter', '#mcClose']]) {
        await page.locator('#mobileNav [data-mobile-action=' + action + ']').click(); await page.locator(dialog).waitFor();
        await fits(page, dialog); await fits(page, close); await noOverflow(page);
        if (action === 'messages') {
          const mainHeight = await page.locator('#messageCenter .mc-main').evaluate(n => n.getBoundingClientRect().height);
          assert(mainHeight > 80, 'message main has usable height: ' + mainHeight);
          for (const selector of ['#mcDraft', '#mcSend', '#mcAddImage', '#mcAddVideo', '#mcAddSticker', '#mcFavorites']) await reachableControl(page, selector);
          await page.locator('#mcDraft').fill('合成消息草稿');
          await page.locator('#mcDraft').press('Enter');
          assert.equal(await page.locator('#mcDraft').inputValue(), '合成消息草稿\n', 'touch Enter inserts a newline');
          assert.equal(requests.some(r => /\/messages\/send$/.test(r.path)), false, 'touch Enter does not send');
          await page.locator('#mcDraft').fill('');
          if (size.width === 390 && size.height === 844) {
            assert.equal(await page.locator('#mobileMessageSidebar').evaluate(n => n.inert), true, 'closed message contacts are inert');
            assert.equal(await page.locator('#mobileMessageSidebar').isVisible(), false);
            assert.equal(await page.locator('#mcConversationSearch').evaluate(n => { n.focus(); return n === document.activeElement; }), false, 'closed contacts cannot receive focus');
            await page.locator('#mobileMessageContacts').click();
            await page.waitForFunction(() => document.querySelector('#messageCenter').classList.contains('mobile-contacts-open'));
            assert.equal(await page.locator('#mobileMessageSidebar').evaluate(n => n.inert), false, 'open contacts accept focus');
            await fits(page, '#mobileMessageSidebar');
            await page.locator('#mobileMessageContacts').click();
            assert.equal(await page.locator('#mobileMessageSidebar').evaluate(n => n.inert), true, 'contacts toggle closes drawer');
            await page.locator('#mobileMessageContacts').click();
            const backdropWidth = await page.locator('#mobileMessageContactsBackdrop').evaluate(n => n.getBoundingClientRect().width);
            await page.locator('#mobileMessageContactsBackdrop').click({ position: { x: backdropWidth - 8, y: 8 } });
            assert.equal(await page.locator('#mobileMessageSidebar').isVisible(), false, 'contacts backdrop closes drawer');
            assert.equal(await page.locator('#mobileMessageSidebar').evaluate(n => n.inert), true);
            for (let i = 0; i < 6; i++) {
              await page.keyboard.press('Tab');
              assert.equal(await page.locator('#mobileMessageSidebar').evaluate(n => n.contains(document.activeElement)), false, 'Tab skips closed message contacts');
            }
          }
        }
        await page.screenshot({ path: path.join(OUT, action + '-' + size.width + 'x' + size.height + '.png') });
        await page.locator(close).click(); assert.equal(await page.locator(dialog).isVisible(), false);
      }
      await page.locator('#mobileNav [data-mobile-action=files]').click(); await fits(page, '#contextRail');
      await page.locator('#closeSettingsButton').click(); assert.equal(await page.locator('#contextRail').isVisible(), false);
      await page.locator('#toggleSettingsButton').click(); await fits(page, '#contextRail');
      await page.waitForFunction(() => document.querySelector('#llmModelInput').options.length >= 3);
      await page.locator('#llmModelInput').selectOption(JSON.stringify(['synthetic', 'model-b']));
      assert.equal(await page.locator('#llmModelInput').inputValue(), JSON.stringify(['synthetic', 'model-b']));
      await page.locator('#closeSettingsButton').click();
      await page.screenshot({ path: path.join(OUT, 'chat-' + size.width + 'x' + size.height + '.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#toggleSidebarButton').click(); await fits(page, '#sessionSidebar');
    await page.locator('#sidebarBackdrop').click({ position: { x: 385, y: 200 } });
    assert.equal(await page.locator('#sessionSidebar').isVisible(), false, 'phone drawer closes from backdrop');
    await page.locator('#toggleSidebarButton').click();
    await page.locator('.session-open[data-session-id="mobile-existing"]').click();
    await page.locator('#messages').getByText('合成历史回复', { exact: true }).waitFor();
    assert.equal(await page.locator('#sessionSidebar').isVisible(), false, 'session selection closes drawer');
    await page.locator('#newQuickSessionButton').click();
    await page.locator('#questionInput').fill('合成手机任务'); await page.locator('#sendButton').click();
    await page.waitForFunction(() => document.querySelector('#sendButton').disabled);
    const deadline = Date.now() + 8000; while (!stream && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    event('assistant_message', { message: '**合成过程文字**', payload: { metadata: { step_index: 1 } } });
    await page.locator('.run-process-text').getByText('合成过程文字', { exact: true }).waitFor();
    event('tool_started', { payload: { tool_name: '合成检索', status: 'running' } });
    await page.locator('.run-process-tool .run-process-state').getByText('调用中', { exact: true }).waitFor();
    event('tool_completed', { payload: { tool_name: '合成检索', status: 'completed' } });
    await page.locator('.run-process-tool .run-process-state').getByText('完成', { exact: true }).waitFor();
    event('llm_delta', { payload: { display_target: 'assistant_answer', content_snapshot: '**合成实时文字**' } });
    await page.locator('.agent-live-output').getByText('合成实时文字', { exact: true }).waitFor();
    event('llm_delta', { payload: { display_target: 'assistant_answer', delta: '\n\n第二段实时文字' } });
    await page.locator('.agent-live-output').getByText('第二段实时文字', { exact: true }).waitFor();
    assert.equal(await page.locator('#sendButton').isDisabled(), true, 'SSE remains held while deltas render');
    await page.locator('#questionInput').fill('仍可编辑的下一条草稿');
    await page.locator('#questionInput').focus(); await page.setViewportSize({ width: 390, height: 430 });
    await composer(page); await noOverflow(page);
    await page.screenshot({ path: path.join(OUT, 'focused-composer-reduced-height.png') });
    sentCompleted = true;
    event('final_answer', { payload: { metadata: { answer } } }); event('run_completed'); stream.end(); stream = null;
    await page.locator('#messages .message-content strong').getByText('合成最终回复', { exact: true }).waitFor();
    assert.equal(await page.locator('#questionInput').inputValue(), '仍可编辑的下一条草稿');
    assert.equal(await page.locator('.agent-live-output').count(), 0);
    for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size); await composer(page); await noOverflow(page);
      assert(await page.locator('#messages table').evaluate(table => { for (let n = table; n && n.id !== 'messages'; n = n.parentElement) { if (['auto', 'scroll'].includes(getComputedStyle(n).overflowX) && n.scrollWidth > n.clientWidth) return true; } return false; }), 'wide Markdown table has local horizontal scrolling');
      await page.screenshot({ path: path.join(OUT, 'answer-' + size.width + 'x' + size.height + '.png') });
    }
    assert(requests.some(r => r.transportPath === '/workbench/sessions'), 'history uses the same-origin gateway by default');
    assert(requests.some(r => r.transportPath === '/workbench/agent/turn/stream'), 'held real HTTP SSE uses the same gateway');
    assert(requests.some(r => r.path === '/pet/session-workspace'), 'new task requested frontend workspace creation');
    // A real remote hostname exposes accidental localhost/backend-port assumptions.
    const remoteContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const remotePage = await remoteContext.newPage();
    const remoteCalls = [];
    remotePage.on('pageerror', error => errors.push(error.message));
    await remotePage.route('**/*', async route => {
      const url = new URL(route.request().url()); remoteCalls.push(url);
      assert.equal(url.origin, 'http://mobile.workbench.test', 'remote page uses one origin without localhost or a second port');
      if (url.pathname === '/workbench/background/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': synthetic\n\n' });
      return route.fulfill({ response: await route.fetch({ url: origin + url.pathname + url.search }) });
    });
    await remotePage.goto('http://mobile.workbench.test/desktop-pet/mobile.html?backend=http%3A%2F%2F127.0.0.1%3A8765&session_id=mobile-existing');
    await remotePage.locator('#messages').getByText('合成历史回复', { exact: true }).waitFor();
    assert.equal(await remotePage.evaluate(() => window.LkaChatContext.get().backend), 'http://mobile.workbench.test/workbench', 'shared desktop localhost bookmarks are repaired on remote browsers');
    await remotePage.locator('#toggleSidebarButton').click();
    await remotePage.locator('#sessionList .session-open[data-session-id="mobile-existing"]').waitFor();
    await remotePage.locator('#sessionList .session-open[data-session-id="mobile-existing"]').click();
    await remotePage.locator('#messages').getByText('合成历史回复', { exact: true }).waitFor();
    await remotePage.locator('#newQuickSessionButton').click();
    await remotePage.waitForFunction(() => window.LkaChatContext.get().workspace === 'C:/synthetic/workspace');
    assert.equal((await remotePage.locator('#runStatus').innerText()).includes('创建失败'), false);
    assert(remoteCalls.some(url => url.pathname === '/workbench/sessions'));
    await remoteContext.close();
    assert.deepEqual(external, [], 'all traffic stays at synthetic origin');
    assert.equal(requests.some(r => /\/messages\/send$/.test(r.path)), false, 'no message sends');
    assert(requests.every(r => !r.credentials), 'no credentials');
    assert.deepEqual(errors, [], 'no browser errors'); assert.deepEqual(unknown, [], 'all interfaces explicitly mocked');
    console.log(JSON.stringify({ result: 'PASS', viewports: 5, requests: requests.length, screenshots: OUT, checks: ['same-origin history and streamed task, remote hostname and repaired localhost bookmark, frontend workspace create', 'entry parameters', 'lazy backend session creation', 'touch navigation', 'session drawer and selection', 'files/settings and models', 'shared domain dialogs, inert phone message contacts, touch newline and reachable message/media composer', 'held real HTTP SSE progress/tools/deltas/final', 'editable busy draft', 'reduced height focused composer', 'local Markdown table scrolling', 'no page overflow', 'synthetic origin only'] }, null, 2));
  } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
  finally { if (stream) stream.end(); if (browser) await browser.close(); server.close(); }
})();
