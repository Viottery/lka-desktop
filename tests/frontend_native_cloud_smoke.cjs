'use strict';
// Synthetic browser regression for native bridge versus cloud-owned requests.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = process.env.FRONTEND_ROOT || path.resolve(__dirname, '../app/web/pet');
const requests = [], errors = [];
const reviewFixtureRunId = 'node-review-fixture';
const routingState = { role: 'replica', mode: 'local', infoFails: false, delayInfo: false, loggedIn: true };
const now = new Date().toISOString();
const managerId = 'manager-cloud-fixture';
const manager = { session: { session_id: managerId, kind: 'manager', title: '真理', created_at: now, updated_at: now, metadata: {} },
  controller: { session_id: managerId, revision: 1, status: 'paused', default_execution_workspace: { path: '/synthetic/cloud', platform: 'linux', backend_path: '/synthetic/cloud' } } };
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (!url.pathname.startsWith('/cloud/') && !url.pathname.startsWith('/workbench/')) {
    const file = path.resolve(ROOT, '.' + url.pathname);
    if (file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body = {}; try { body = JSON.parse(raw || '{}'); } catch (_) {}
  const cloud = url.pathname.startsWith('/cloud/');
  const route = url.pathname.replace(/^\/(?:cloud|workbench)\//, '');
  requests.push({ cloud, route, method: req.method, body });
  if (url.pathname === '/cloud-auth/status') return json(res, 200, { client_mode: routingState.mode, configured: true, logged_in: routingState.loggedIn, account: { user_id: 'synthetic' }, origin: 'https://hub.invalid' });
  if (route === 'client/info') {
    if (routingState.delayInfo) await new Promise(resolve => setTimeout(resolve, 120));
    return json(res, routingState.infoFails ? 503 : 200, { role: routingState.role, hub_url: 'https://hub.invalid' });
  }
  if (route === 'matters/sync') return json(res, 200, { changes: [], cursor: 0, has_more: false });
  if (route === 'projects') return json(res, 200, { projects: [], next_offset: null });
  if (route === 'managers/default' && req.method === 'POST') return json(res, 200, manager);
  if (route === 'background/config') {
    const config = { memory: { enabled: true, background_client_name: 'cloud-provider', background_model: 'cloud-model' }, background: { max_llm_concurrency: 2 } };
    return json(res, 200, { revision: 1, active: config, desired: config, restart_required: false, pending_restart_fields: [] });
  }
  if (route === 'background/config/schema') return json(res, 200, { memory: { properties: { enabled: { type: 'boolean' } } }, background: { properties: { max_llm_concurrency: { type: 'integer' } } } });
  if (route === 'agent/models' && cloud) return json(res, 200, { default_client: 'cloud-provider', clients: [{ name: 'cloud-provider', source: 'configured', models: ['cloud-model'], default_model: 'cloud-model' }] });
  if (route === 'agent/ui-defaults') return json(res, 200, { configured: true, defaults: { stream: true } });
  if (route === 'agent/models') return json(res, 200, { clients: [] });
  if (route === 'agent/runs/' + reviewFixtureRunId + '/safety-reviews') return json(res, 200, { reviews: [] });
  if (route === 'sessions' && req.method === 'GET') return json(res, 200, { sessions: [] });
  if (route === 'sessions/' + managerId) return json(res, 200, { session: manager.session, messages: [] });
  if (route === 'sessions/' + managerId + '/runs') return json(res, 200, { session_id: managerId, runs: [], next_offset: null });
  if (route === 'managers/' + managerId) return json(res, 200, manager);
  if (route === 'managers/' + managerId + '/events') return json(res, 200, { events: [], next_after: null });
  if (route === 'managers/' + managerId + '/deliveries') return json(res, 200, { deliveries: [], next_after: null });
  if (route === 'sessions/not-learned') return json(res, 200, { synthetic: 'ordinary bridge session' });
  if (route.startsWith('sessions/') && route.endsWith('/workspace')) return json(res, 200, { project_id: 'synthetic' });
  if (route === 'knowledge/file-types') return json(res, 200, { file_types: [] });
  if (route === 'openapi.json') return json(res, 200, { paths: {} });
  if (route === 'agent/safety-reviews') return json(res, 200, { reviews: [] });
  return json(res, 200, {});
});
async function until(check) { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('synthetic browser condition timed out'); }
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/tmp/lka-playwright-browsers/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(() => {
      if (new URLSearchParams(location.search).has('node-review-fixture')) {
        const session = { id: 'node-review-session', kind: 'ordinary', title: 'Node review fixture', created_at: Date.now(), updated_at: Date.now(),
          workspace: '', nodeWorkspaceId: 'work', multiAgentRunId: 'node-review-fixture', messages: [] };
        localStorage.setItem('agentic-rag-pet-chat-sessions-v4', JSON.stringify([session]));
        localStorage.setItem('agentic-rag-pet-chat-active-session-v4', session.id);
      }
      window.bridgeRequests = [];
      window.petBridge = { requestMemory(raw) {
        const item = JSON.parse(raw); window.bridgeRequests.push(item);
        if (item.path.startsWith('/managers/') || item.path.startsWith('/sessions/' + 'manager-cloud-fixture')) {
          window.__lkaMemoryBridgeReceive(item.id, 403, JSON.stringify({ detail: 'synthetic_bridge_must_not_receive_cloud_request' })); return;
        }
        window.__lkaMemoryBridgeReceive(item.id, 200, JSON.stringify({ synthetic: 'ordinary bridge session' }));
      }, setQuickPanelHeight() {}, setComposerBusy() {}, setComposerAction() {} };
    });
    await page.goto(origin + '/chat.html?mode=quick&assistant=quick&backend=' + encodeURIComponent(origin + '/workbench'));
    await page.waitForFunction(() => !!window.LkaChatContext && !!window.LkaHost && !!window.LkaMatterHost);
    await page.waitForFunction(() => LkaChatContext.get().kind === 'manager', null, { timeout: 10000 }).catch(async error => { console.error(JSON.stringify({errors, requests, state: await page.evaluate(() => ({ host: LkaHost.snapshot(), chat: LkaChatContext.get(), assistant: LkaChatContext.assistantState(), bridge: window.bridgeRequests }))})); throw error; });
    await until(() => requests.some(r => r.cloud && r.route === 'sessions/' + managerId));
    assert(requests.some(r => r.cloud && r.route === 'managers/default' && r.method === 'POST'), 'assistant initialization uses /cloud');
    assert(requests.some(r => r.cloud && r.route === 'sessions/' + managerId), 'manager session detail uses /cloud');
    await until(() => requests.some(r => r.cloud && r.route === 'managers/' + managerId + '/events'));
    assert(requests.some(r => r.cloud && r.route === 'managers/' + managerId + '/events'), 'manager history/feed uses /cloud');
    assert.equal(await page.evaluate(() => window.bridgeRequests.length), 0, 'cloud assistant initialization and history never call Java bridge');
    const routing = await page.evaluate(() => ({
      manager: LkaHost.routesViaCloud('/managers/default'),
      learnedSession: LkaHost.routesViaCloud('/sessions/manager-cloud-fixture'),
      unknownSession: LkaHost.routesViaCloud('/sessions/not-learned'),
      localWorkspace: LkaHost.routesViaCloud('/local/workspaces'),
      query: LkaHost.routesViaCloud('/managers/default?next=https://outside.invalid'),
      absolute: LkaHost.routesViaCloud('https://outside.invalid/managers/default')
    }));
    assert.deepEqual(routing, { manager: true, learnedSession: true, unknownSession: false, localWorkspace: false, query: false, absolute: false });
    const ordinary = await page.evaluate(() => LkaMatterHost.request('/sessions/not-learned', 'GET'));
    assert.equal(ordinary.synthetic, 'ordinary bridge session');
    assert.equal(await page.evaluate(() => window.bridgeRequests.length), 1, 'ordinary session keeps native bridge');
    assert(!requests.some(r => r.cloud && r.route === 'sessions/not-learned'), 'unknown ordinary session never reaches cloud');
    assert.equal(await page.evaluate(() => window.LkaHost.routesViaCloud('/local/workspaces/index')), false, 'local workspace remains node-owned');
    await page.goto(origin + '/chat.html?mode=work&backend=' + encodeURIComponent(origin + '/workbench'));
    await page.waitForFunction(() => !!window.LkaMemory && !!window.LkaHost);
    await page.evaluate(async () => { await LkaHost.ready; LkaMemory.open(); });
    await page.click('[data-memory-tab="config"]');
    await page.locator('#memoryConfigForm').waitFor();
    assert(requests.some(r => r.cloud && r.route === 'background/config'));
    assert(requests.some(r => r.cloud && r.route === 'background/config/schema'));
    assert(requests.some(r => r.cloud && r.route === 'agent/models'), 'advanced model catalogue belongs to hub');
    assert.equal(await page.locator('#memoryBackgroundClient').inputValue(), 'cloud-provider');
    assert.equal(await page.locator('#memoryBackgroundModel').inputValue(), 'cloud-model');
    assert(!requests.some(r => r.route === 'background/config' && ['PATCH', 'DELETE'].includes(r.method)), 'opening settings does not change configuration');

    // A loopback frontend can be backed by a replica. Delay role discovery to
    // prove the initial review refresh waits before deciding which queue is legal.
    const reviewUrl = new URL('/chat.html', origin);
    reviewUrl.searchParams.set('mode', 'work'); reviewUrl.searchParams.set('backend', origin + '/workbench');
    reviewUrl.searchParams.set('node-review-fixture', '1');
    reviewUrl.searchParams.set('session_id', 'node-review-session');
    routingState.delayInfo = true;
    await page.goto(reviewUrl.href);
    await page.waitForFunction(() => LkaChatContext && LkaChatContext.get().sessionId === 'node-review-session');
    await until(() => requests.some(r => r.route === 'agent/runs/' + reviewFixtureRunId + '/safety-reviews'));
    routingState.delayInfo = false;
    assert(!requests.some(r => !r.cloud && r.route === 'agent/safety-reviews'), 'replica never requests the forbidden global local review queue');
    assert(!requests.some(r => r.cloud && r.route === 'agent/runs/' + reviewFixtureRunId + '/safety-reviews'), 'unknown local run reviews remain node-owned');

    // The visible quick-assistant retry must re-probe routing before opening.
    routingState.infoFails = true;
    await page.goto(origin + '/chat.html?mode=quick&assistant=quick&backend=' + encodeURIComponent(origin + '/workbench'));
    await page.locator('#qaRetry:not([hidden])').waitFor();
    assert.equal(await page.evaluate(() => LkaHost.backendRole), 'unknown');
    const roleProbes = requests.filter(r => r.route === 'client/info').length;
    routingState.infoFails = false;
    await page.locator('#qaRetry').click();
    await page.waitForFunction(() => LkaChatContext.get().kind === 'manager');
    assert(requests.filter(r => r.route === 'client/info').length > roleProbes, 'retry UI re-probes backend role');
    assert.equal(await page.evaluate(() => LkaHost.cloudRouting), true);
    assert.equal(await page.evaluate(() => bridgeRequests.length), 0, 'retry initialization never calls Java');

    // Embedded matters and memory delegate to the shared memory transport.
    routingState.loggedIn = false;
    await page.evaluate(() => LkaHost.refreshCloud());
    const embeddedSignedOut = await page.evaluate(async () => {
      const outcomes = [];
      for (const api of [LkaMemory, LkaMatterHost]) {
        try { await api.request('/matters', 'POST', { title: 'must stay cloud-owned' }); outcomes.push(200); }
        catch (error) { outcomes.push(error.status); }
      }
      return outcomes;
    });
    assert.deepEqual(embeddedSignedOut, [503, 503]);
    assert.equal(await page.evaluate(() => bridgeRequests.length), 0, 'signed-out embedded matters and memory writes never reach Java');
    routingState.loggedIn = true;
    await page.evaluate(() => LkaHost.refreshCloud());

    // The native standalone window must load the same host router as chat.
    await page.goto(origin + '/matters.html?native=1&backend=' + encodeURIComponent(origin + '/workbench'));
    await page.waitForFunction(() => window.LkaMatterHost && window.LkaHost);
    await page.evaluate(() => LkaMatterHost.ready);
    await until(() => requests.some(r => r.cloud && r.route.startsWith('matters/sync')));
    assert.equal(await page.evaluate(() => bridgeRequests.length), 0, 'standalone matter initialization uses cloud gateway');
    routingState.loggedIn = false;
    await page.evaluate(() => LkaHost.refreshCloud());
    const signedOut = await page.evaluate(async () => {
      try { await LkaMatterHost.request('/matters', 'POST', { title: 'must not become local' }); return 200; }
      catch (error) { return error.status; }
    });
    assert.equal(signedOut, 503);
    assert.equal(await page.evaluate(() => bridgeRequests.length), 0, 'signed-out standalone writes never reach Java');
    routingState.loggedIn = true; routingState.infoFails = true;
    await page.reload(); await page.evaluate(() => LkaHost.ready);
    assert.equal(await page.evaluate(() => LkaHost.backendRole), 'unknown');
    routingState.infoFails = false;
    await page.evaluate(() => LkaHost.refreshCloud());
    assert.equal(await page.evaluate(() => LkaHost.cloudRouting), true, 'role and login probes recover on the same page');
    await page.evaluate(() => LkaMatterHost.request('/matters/sync?after=0&limit=200'));
    assert.equal(await page.evaluate(() => bridgeRequests.length), 0);

    routingState.mode = 'cloud'; routingState.role = 'hub';
    await page.reload(); await page.evaluate(() => LkaMatterHost.ready);
    await page.evaluate(() => LkaMatterHost.request('/sessions/ordinary-cloud-client'));
    assert.equal(await page.evaluate(() => bridgeRequests.length), 0, 'pure cloud standalone ordinary requests use workbench gateway');
    assert(requests.some(r => !r.cloud && r.route === 'sessions/ordinary-cloud-client'));

    // A thin cloud client must never publish a Windows folder as the hub default.
    manager.controller.default_execution_workspace = null;
    const beforeCloudHome = requests.length;
    await page.goto(origin + '/chat.html?mode=quick&assistant=quick&backend=' + encodeURIComponent(origin + '/workbench'));
    await page.waitForFunction(() => LkaChatContext.get().kind === 'manager').catch(async error => { console.error(await page.evaluate(() => ({host: LkaHost.snapshot(), chat:LkaChatContext.get(), status:document.querySelector('#runStatus').textContent})), requests.slice(beforeCloudHome), errors); throw error; });
    assert(!requests.slice(beforeCloudHome).some(r => r.route.endsWith('pet/session-workspace-parent')), 'cloud-only assistant never requests a local task directory');

    assert.deepEqual(errors, [], 'browser reports no uncaught errors');
    await page.close();
    process.stdout.write('PASS native cloud routing stays on /cloud; ordinary requests stay on Java bridge\n');
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
