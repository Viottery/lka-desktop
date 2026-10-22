'use strict';
// Synthetic same-origin browser fixture only. External network is blocked.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const ROOT = path.resolve(__dirname, '../app/web/pet');
const requests = [], errors = [], outside = [];
const stamp = new Date().toISOString();
let defaults = { llm_client: 'alpha', llm_model: 'full', reasoning_level: 'high', safety_mode: 'backend', stream: true, workspace_parent: '' };
let catalogMode = 'full', managerRevision = 1, managerReasoning = null, managerConflict = false, rejectNextStream = false;
const manager = { session_id: 'reasoning-manager', kind: 'manager', title: '真理', created_at: stamp, updated_at: stamp, metadata: {}, workspace: null };
const ordinary = { ...manager, session_id: 'reasoning-ordinary', kind: 'ordinary', title: '普通会话', workspace: { path: '/synthetic/work' } };
const fullCaps = {
  full: { controlled: true, supports_off: true, effort_map: { low: 'low', high: 'high', max: 'xhigh' } },
  alias: { controlled: true, supports_off: false, effort_map: { low: 'low', high: 'high', max: 'high' } },
  lowonly: { controlled: false, supports_off: false, effort_map: { low: 'low' } },
  limited: { controlled: true, supports_off: false, effort_map: { low: 'low' } }
};
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
async function waitRequest(page, predicate, message) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await page.waitForTimeout(20); }
  const state = await page.evaluate(() => ({ kind: LkaChatContext.get().kind, sessionId: LkaChatContext.get().sessionId,
    buttonDisabled: document.querySelector('#sendButton').disabled, status: document.querySelector('#runStatus').textContent,
    composer: document.querySelector('#questionInput').value }));
  assert.fail((message || 'timed out waiting for synthetic request') + '; page=' + JSON.stringify(state) + '; seen=' + requests.map(r => r.method + ' ' + r.path).join(', '));
}
function managerState() { return { session: manager, controller: { session_id: manager.session_id, status: 'paused', revision: managerRevision, reasoning_level: managerReasoning, llm_client_name: 'alpha', llm_model: 'full', default_execution_workspace: { path: '/synthetic/tasks', platform: 'linux', backend_path: '/synthetic/tasks' } } }; }
function capabilities() {
  if (catalogMode === 'legacy') return { clients: [{ name: 'alpha', default_model: 'full', models: ['full'] }] };
  const names = catalogMode === 'unsupported' ? ['limited'] : catalogMode === 'alias' ? ['alias'] : ['full', 'alias', 'lowonly', 'limited'];
  const reasoning_capabilities = {};
  names.forEach(name => { reasoning_capabilities[name] = fullCaps[name]; });
  return { default_client: 'alpha', clients: [{ name: 'alpha', default_model: names[0], models: names, reasoning_capabilities }] };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/' || url.pathname.endsWith('/chat.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(path.join(ROOT, 'chat.html')).pipe(res);
  }
  if (url.pathname === '/pet/session-workspace') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    return json(res, 200, { path: '/synthetic/work' });
  }
  if (!url.pathname.startsWith('/mock')) {
    const f = path.resolve(ROOT, '.' + url.pathname.replace(/^\/desktop-pet/, ''));
    if (f.startsWith(ROOT + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'application/octet-stream', 'cache-control': 'no-store' });
      return fs.createReadStream(f).pipe(res);
    }
    return json(res, 404, {});
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {}, p = url.pathname.replace(/^\/mock/, '');
  requests.push({ path: p, method: req.method, body });
  if (p === '/agent/models') return json(res, 200, capabilities());
  if (p === '/agent/ui-defaults') {
    if (req.method === 'PUT') defaults = body;
    return json(res, 200, { configured: true, defaults });
  }
  if (p === '/managers/default') return json(res, 200, managerState());
  if (p === '/managers/reasoning-manager') {
    if (req.method === 'PATCH') {
      if (managerConflict) { managerConflict = false; managerRevision++; return json(res, 409, { detail: 'management_revision_conflict' }); }
      assert.equal(body.expected_revision, managerRevision);
      managerReasoning = body.reasoning_level;
      managerRevision++;
      return json(res, 200, managerState());
    }
    return json(res, 200, managerState());
  }
  if (p === '/sessions' && req.method === 'GET') return json(res, 200, { sessions: [manager, ordinary], next_offset: null });
  if (/^\/sessions\/[^/]+\/workspace$/.test(p) && req.method === 'PUT') return json(res, 200, { project_id: 'synthetic-project' });
  if (p === '/sessions/deleted') return json(res, 200, { sessions: [] });
  if (p === '/agent/safety-reviews') return json(res, 200, { reviews: [] });
  if (p.endsWith('/goals')) return json(res, 200, { goals: [], next_offset: null });
  if (p.endsWith('/events')) return json(res, 200, { events: [], next_after: null });
  if (p.endsWith('/deliveries')) return json(res, 200, { deliveries: [], next_after: null });
  if (p.endsWith('/runs')) return json(res, 200, { session_id: p.split('/')[2], runs: [], next_offset: null });
  if (p === '/sessions/reasoning-manager') return json(res, 200, { session: manager, messages: [] });
  if (/^\/sessions\/[^/]+$/.test(p)) return json(res, 200, { session: ordinary, messages: [] });
  if (p === '/pet/session-workspace') return json(res, 200, { path: '/synthetic/work' });
  if (p === '/projects') return json(res, 200, { projects: [] });
  if (p === '/agent/turn') return json(res, 200, { session_id: body.session_id, answer: 'synthetic answer' });
  if (p === '/agent/turn/stream') {
    if (rejectNextStream) { rejectNextStream = false; return json(res, 422, { detail: 'synthetic_no_stream' }); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.end('event: final_answer\ndata: {"payload":{"metadata":{"answer":"synthetic stream answer"}}}\n\nevent: run_completed\ndata: {}\n\n');
    return;
  }
  return json(res, 200, {});
});

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); } return route.continue(); });
    await page.goto(origin + '/chat.html?mode=work&backend=' + encodeURIComponent(origin + '/mock'));
    await page.waitForFunction(() => !!window.LkaChatContext && !!LkaChatContext.preferences().reasoningLevel);
    await page.waitForFunction(() => document.querySelector('#reasoningLevelInput') && !document.querySelector('#reasoningLevelInput').disabled);
    const slider = page.locator('#reasoningLevelInput');
    assert.equal(await slider.inputValue(), '2', 'shared high default loads into the slider');
    assert.equal(await page.locator('#reasoningLevelValue').innerText(), '高');
    assert.deepEqual(await page.evaluate(() => LkaChatContext.reasoningOptions(JSON.stringify(['alpha','full']), 'max').reasoningLevels.map(x => [x.value,x.available])), [
      ['off',true], ['low',true], ['high',true], ['max',true]
    ]);
    await slider.evaluate(el => { el.value = '3'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitRequest(page, () => requests.some(r => r.path === '/agent/ui-defaults' && r.method === 'PUT' && r.body.reasoning_level === 'max'));
    assert.equal(defaults.reasoning_level, 'max', 'ordinary slider persists max in shared defaults');
    await page.reload(); await page.waitForFunction(() => LkaChatContext.preferences().reasoningLevel === 'max');
    await page.evaluate(() => __petChatOpenFreshTask());
    await page.waitForFunction(() => LkaChatContext.get().kind === 'ordinary');

    // Compatibility fallback uses /agent/turn; regular requests use SSE. Both carry the selected default.
    rejectNextStream = true;
    const acceptedTurn = await page.evaluate(() => __petChatSubmitText('non-stream synthetic request'));
    assert.equal(acceptedTurn, true, 'ordinary conversation accepted the synthetic turn');
    await waitRequest(page, () => requests.some(r => r.path === '/agent/turn'));
    assert.equal(requests.findLast(r => r.path === '/agent/turn').body.llm.reasoning_level, 'max');
    await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('synthetic answer'));
    await page.evaluate(() => __petChatSubmitText('stream synthetic request'));
    await waitRequest(page, () => requests.filter(r => r.path === '/agent/turn/stream').length >= 2);
    assert.equal(requests.findLast(r => r.path === '/agent/turn/stream').body.llm.reasoning_level, 'max');

    // Alias is explicit in the hint; unsupported choices are neither silently lowered nor saved.
    await page.locator('#llmModelInput').evaluate(el => { el.value = JSON.stringify(['alpha', 'alias']); el.dispatchEvent(new Event('change', { bubbles: true })); });
    catalogMode = 'alias'; await page.evaluate(() => LkaChatContext.preferencesReady(true));
    await page.waitForFunction(() => document.querySelector('#reasoningLevelHint').textContent.includes('相同强度'));
    assert.equal(await slider.isDisabled(), false);
    catalogMode = 'full'; await page.evaluate(() => LkaChatContext.preferencesReady(true));
    await page.locator('#llmModelInput').evaluate(el => { el.value = JSON.stringify(['alpha', 'limited']); el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelector('#reasoningLevelHint').textContent.includes('不支持'));
    const beforeUnsupported = requests.filter(r => r.path === '/agent/ui-defaults' && r.method === 'PUT').length;
    const opts = await page.evaluate(() => LkaChatContext.reasoningOptions(JSON.stringify(['alpha','limited']), 'max'));
    assert.equal(opts.reasoningValid, false, 'an unavailable selected level remains invalid');
    assert.equal(await slider.inputValue(), '3', 'unsupported max is not silently lowered');
    assert.match(await page.locator('#defaultsSaveStatus').innerText(), /不支持/);
    assert.equal(requests.filter(r => r.path === '/agent/ui-defaults' && r.method === 'PUT').length, beforeUnsupported, 'unsupported model does not persist a lowered value');
    catalogMode = 'legacy'; await page.evaluate(() => LkaChatContext.preferencesReady(true));
    await page.waitForFunction(() => document.querySelector('#reasoningLevelInput').disabled);
    assert.equal((await page.evaluate(() => LkaChatContext.reasoningOptions('', 'max'))).reasoningSupported, false);
    assert.equal((await page.evaluate(() => LkaChatContext.reasoningOptions('', 'max'))).reasoningValid, true);

    // Manager preference writes use CAS and never mutate shared defaults.
    catalogMode = 'full'; await page.evaluate(() => LkaChatContext.preferencesReady(true));
    await page.locator('#openGlobalAssistant').click();
    try { await page.waitForFunction(() => LkaChatContext.get().kind === 'manager', null, { timeout: 5000 }); }
    catch (_) { assert.fail('manager navigation failed: ' + JSON.stringify(await page.evaluate(() => ({ context: LkaChatContext.get(), assistant: LkaChatContext.assistantState(), text: document.querySelector('#runStatus').textContent }))) + '; seen=' + requests.map(r => r.method + ' ' + r.path).join(', ')); }
    await page.locator('#assistantSettingsButton').click();
    await page.waitForFunction(() => document.querySelector('#qsApply') && !document.querySelector('#qsApply').disabled);
    assert.equal(await page.locator('#qsReasoning').inputValue(), '3', 'null manager preference inherits the shared max default');
    // Manager slider choice is an explicit controller preference and leaves shared prefs untouched.
    await page.locator('#qsReasoning').evaluate(el => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.locator('#qsApply').click();
    await waitRequest(page, () => requests.some(r => r.path === '/managers/reasoning-manager' && r.method === 'PATCH'));
    let patch = requests.findLast(r => r.path === '/managers/reasoning-manager' && r.method === 'PATCH');
    assert.equal(patch.body.expected_revision, 1); assert.equal(patch.body.reasoning_level, 'low');
    assert.equal(defaults.reasoning_level, 'max', 'manager override never writes global defaults');

    managerReasoning = 'low'; managerRevision++;
    await page.evaluate(() => LkaChatContext.refreshQuickSettings());
    await page.locator('#qsReasoning').evaluate(el => { el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }); managerConflict = true; await page.locator('#qsApply').click();
    await page.waitForFunction(() => document.querySelector('#qsStatus').textContent.includes('其他窗口'));
    assert.equal(await page.locator('#qsReasoning').inputValue(), '2', '409 preserves selected manager setting');
    const patchCount = requests.filter(r => r.path === '/managers/reasoning-manager' && r.method === 'PATCH').length;
    await page.waitForTimeout(120); assert.equal(requests.filter(r => r.path === '/managers/reasoning-manager' && r.method === 'PATCH').length, patchCount, '409 does not retry');
    const screenshotDir = path.resolve(__dirname, '../.runtime/reasoning-settings-preview');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, 'manager-desktop.png') });

    // Capability-less legacy backend keeps slider disabled and omits the new request field.
    await page.locator('#toggleSettingsButton').click().catch(() => {});
    await page.evaluate(() => __petChatOpenFreshTask());
    await page.waitForFunction(() => LkaChatContext.get().kind === 'ordinary');
    catalogMode = 'legacy'; await page.evaluate(() => LkaChatContext.preferencesReady(true));
    await page.locator('#toggleSettingsButton').click();
    await page.evaluate(() => __petChatSubmitText('legacy synthetic request'));
    await waitRequest(page, () => requests.filter(r => r.path === '/agent/turn' || r.path === '/agent/turn/stream').length >= 4);
    const legacyTurn = requests.filter(r => r.path === '/agent/turn/stream' || r.path === '/agent/turn').at(-1);
    assert.equal(Object.hasOwn(legacyTurn.body.llm, 'reasoning_level'), false, 'legacy backend gets no unsupported request field');

    // Viewport checks use the explicit mobile workbench layout, not only a narrow desktop viewport.
    catalogMode = 'full';
    const mobile = await browser.newPage({ viewport: { width: 390, height: 740 } });
    mobile.on('pageerror', error => errors.push(error.message));
    await mobile.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); } return route.continue(); });
    await mobile.goto(origin + '/chat.html?layout=mobile&backend=' + encodeURIComponent(origin + '/mock'));
    await mobile.waitForFunction(() => document.body.classList.contains('mobile-workbench') && LkaChatContext.preferences().reasoningLevel);
    await mobile.locator('[data-mobile-action="files"]').click();
    await mobile.locator('#settingsTabButton').click();
    await mobile.waitForFunction(() => !document.querySelector('#reasoningLevelInput').disabled);
    const overflow = await mobile.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert(overflow.width <= overflow.viewport, '390px mobile workbench has no horizontal overflow');
    const sliderBounds = await mobile.locator('#reasoningLevelInput').boundingBox();
    assert(sliderBounds && sliderBounds.x >= 0 && sliderBounds.x + sliderBounds.width <= 390, 'reasoning slider stays inside the mobile viewport: ' + JSON.stringify(sliderBounds));
    await mobile.screenshot({ path: path.join(screenshotDir, 'mobile.png') });
    await page.screenshot({ path: path.join(screenshotDir, 'desktop-workbench.png') });
    assert.equal(errors.length, 0, errors.join('\n')); assert.equal(outside.length, 0, 'external network remains blocked and unused');
    console.log('PASS reasoning controls: defaults, HTTP/SSE, model capability boundaries, manager CAS isolation, legacy payload omission, and mobile viewport');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
