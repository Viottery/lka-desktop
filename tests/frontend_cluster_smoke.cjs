// Synthetic multi-device acceptance: one hub and two node origins with separate
// in-memory data. No real backend, credentials, model calls or QQ messages.
// Browsers treat each localhost port as its own origin (cookies are per host,
// storage per origin), which is enough to check isolation and routing.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = path.resolve(__dirname, '../app/web/pet');
const OUT = path.resolve(__dirname, '../.runtime/cluster-preview');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const errors = [], external = [];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function json(res, value, status = 200, headers = {}) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(value)); }
function cookie(req, name) { const match = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)')); return match ? match[1] : ''; }
function staticFile(req, res, p) {
  if (req.method !== 'GET' || !p.startsWith('/desktop-pet/')) return false;
  const file = path.resolve(ROOT, decodeURIComponent(p.slice('/desktop-pet/'.length)));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res); return true;
}
async function body(req) { let raw = ''; for await (const chunk of req) raw += chunk; return raw; }

// ---------- Hub ----------
const hub = { requests: [], sessions: new Map(), grants: new Map(), csrf: 'hub-csrf', online: true, decisions: [], taskState: 'waiting_confirmation', reviewStep: 0, holdDecision: 0, inputs: [] };
const HUB_ORIGIN = 'https://hub.example.ts.net';
function makeNode(id, workspaces) {
  return { id, workspaces, requests: [], sessions: new Map(), files: new Map(), connections: new Map(), redeemAttempts: 0, nextSession: 1, turns: [], csrfPosts: [] };
}
const nodes = { 'desk-a': makeNode('desk-a', ['work']), 'desk-b': makeNode('desk-b', ['notes', 'lab']) };
nodes['desk-a'].files.set('', [{ name: 'readme.md', is_directory: false, size: 42 }, { name: 'src', is_directory: true, size: 0 }]);
nodes['desk-b'].files.set('', [{ name: 'journal.txt', is_directory: false, size: 9 }]);
const ports = {};
const stamp = '2026-10-24T03:00:00Z';
const managerSession = { session_id: 'manager-main', kind: 'manager', title: '真理', status: 'active', metadata: {}, workspace: null, created_at: stamp, updated_at: stamp };
const delegatedSession = { session_id: 'delegated-a', kind: 'ordinary', title: '整理书房电脑项目结构', status: 'active', metadata: { remote_execution: { task_id: 'remote_task_t1', node_id: 'desk-a', environment_id: 'linux', workspace_id: 'work', owner_session_id: 'manager-main' } }, workspace: null, created_at: stamp, updated_at: stamp };
const delegatedSessionA2 = { session_id: 'delegated-a2', kind: 'ordinary', title: '书房电脑第二轮', status: 'active', metadata: { remote_execution: { task_id: 'remote_task_t1b', node_id: 'desk-a', environment_id: 'linux', workspace_id: 'work' } }, workspace: null, created_at: stamp, updated_at: '2026-10-24T02:55:00Z' };
const delegatedSessionB = { session_id: 'delegated-b', kind: 'ordinary', title: '实验室笔记本任务', status: 'active', metadata: { remote_execution: { task_id: 'remote_task_t2', node_id: 'desk-b', environment_id: 'linux', workspace_id: 'lab' } }, workspace: null, created_at: stamp, updated_at: '2026-10-24T02:58:00Z' };
const cloudSession = { session_id: 'cloud-chat', kind: 'ordinary', title: '云端讨论', status: 'active', metadata: {}, workspace: null, created_at: stamp, updated_at: '2026-10-24T02:59:00Z' };
const cloudAssistantSession = { session_id: 'cloud-agent-task', kind: 'ordinary', title: '云端本机整理资料', status: 'active', metadata: { creation_source: 'assistant', creator_session_id: 'manager-main' }, workspace: null, created_at: stamp, updated_at: '2026-10-24T02:57:00Z' };
const managerView = () => ({ session: managerSession, controller: { session_id: 'manager-main', revision: 2, status: 'active', default_execution_workspace: null }, autonomy: { autonomous_enabled: false } });
// Two successive reviews from the device: list a directory, then write a file.
const reviews = [
  { review_id: 'rev-list-0001', run_id: 'remote-run', tool_name: 'filesystem.list_directory', tool_input: { path: 'work/reports' }, tool_risk: 'low', read_only: true, reason: '列出报告目录' },
  { review_id: 'rev-write-0002', run_id: 'remote-run', tool_name: 'filesystem.write_file', tool_input: { path: 'work/reports/summary.md' }, tool_risk: 'medium', read_only: false, reason: '写入汇总文件' }
];
function remoteTask() {
  const review = reviews[hub.reviewStep];
  const state = review ? hub.taskState : 'completed';
  return { task_id: 'remote_task_t1', run_id: 'remote-run', owner_session_id: 'manager-main', session_id: 'delegated-execution-01', title: '整理书房电脑项目结构', node_id: 'desk-a', environment_id: 'linux', workspace_id: 'work', approval: { requested_mode: 'skip', effective_mode: 'manual', source: 'node_policy' }, state, updated_at: stamp, next_offset: null,
    reports: [{ status: state, reviews: state === 'waiting_confirmation' && review ? [review] : [], result: state === 'completed' ? { answer: '远程汇总已完成' } : null }] };
}
function cors(req, res) {
  const origin = req.headers.origin || '';
  // Synthetic stand-in for CORSMiddleware with the configured node origins.
  if (/^https:\/\/desk-[ab]\.example\.ts\.net$/.test(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE', 'access-control-allow-headers': req.headers['access-control-request-headers'] || '*' });
      res.end(); return true;
    }
  }
  return false;
}

const hubServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (cors(req, res)) return;
  const raw = await body(req);
  hub.requests.push({ method: req.method, path: p, csrf: req.headers['x-csrf-token'] || '', origin: req.headers.origin || '' });
  if (!hub.online && !p.startsWith('/desktop-pet/')) { res.writeHead(503); return res.end(); }
  if (staticFile(req, res, p)) return;
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (p === '/client/info') return json(res, { role: 'hub', node_id: null, connections_enabled: true, execution_enabled: true, workbench: true });
  if (p === '/auth/login' && req.method === 'POST') {
    const data = JSON.parse(raw);
    if (data.password !== 'correct-horse-battery') return json(res, { detail: 'Invalid credentials' }, 401);
    // SameSite=Strict still flows between *.ts.net names: they are one site.
    return json(res, { account: { user_id: 'u1', username: 'owner' }, session_id: 's1', csrf_token: hub.csrf, expires_at: 4102444800 }, 200, { 'set-cookie': 'lka_session=hub-cookie; Path=/; HttpOnly; Secure; SameSite=Strict' });
  }
  const signed = cookie(req, 'lka_session') === 'hub-cookie';
  if (!signed) return json(res, { detail: 'Account authentication required' }, 401);
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== hub.csrf) return json(res, { detail: 'Allowed Origin and CSRF token required' }, 403);
  // The CSRF token is re-derived from the cookie, so new tabs need no new login.
  if (p === '/auth/me') return json(res, { user_id: 'u1', username: 'owner', session_id: 's1', is_admin: true, csrf_token: hub.csrf });
  if (p === '/auth/logout') { res.writeHead(204, { 'set-cookie': 'lka_session=; Max-Age=0; Path=/' }); return res.end(); }
  if (p === '/auth/sessions') return json(res, { items: [{ session_id: 's1', created_at: 1761264000, expires_at: 4102444800 }] });
  if (p === '/devices') return json(res, { items: Object.values(nodes).map(n => ({ device_id: n.id, node_id: n.id, name: n.id === 'desk-a' ? '书房电脑' : '实验室笔记本', platform: 'linux',
    systems: [{ environment_id: 'linux', platform: 'linux', workspace_ids: n.workspaces }], workspace_ids: n.workspaces, scopes: ['heartbeat', 'sync.read', 'connections.poll'],
    advertised_url: 'https://' + n.id + '.example.ts.net', online: n.id === 'desk-a', revoked: false, revision: 1, last_seen: '2026-10-24T00:00:00Z' })) });
  const grantMatch = p.match(/^\/devices\/([\w.-]+)\/connections$/);
  if (grantMatch && req.method === 'POST') {
    const grant = 'grant-' + grantMatch[1] + '-' + Math.random().toString(36).slice(2) + 'x'.repeat(24);
    hub.grants.set(grant, grantMatch[1]);
    return json(res, { grant, grant_id: 'g1', node_id: grantMatch[1], origin: 'https://' + grantMatch[1] + '.example.ts.net', expires_at: 4102444800, delivery: 'pending_node_poll' }, 201);
  }
  if (p === '/remote-execution/targets') return json(res, { items: [{ device_id: 'desk-a', name: '书房电脑', systems: [{ environment_id: 'linux', execution_online: true }] }] });
  if (p === '/remote-execution/tasks') return json(res, { items: [remoteTask(), { task_id: 'remote_task_t2', run_id: 'remote-run-b', title: '实验室任务', node_id: 'desk-b', environment_id: 'linux', workspace_id: 'lab', state: 'completed', updated_at: stamp, next_offset: null, reports: [] }], next_offset: null });
  if (p === '/remote-execution/tasks/remote_task_t1') return json(res, remoteTask());
  const decision = p.match(/^\/remote-execution\/tasks\/remote_task_t1\/reviews\/([\w-]+)$/);
  if (decision && req.method === 'POST') {
    hub.decisions.push({ review: decision[1], decision: JSON.parse(raw).decision });
    // The cloud accepts at once; the device applies it a few polls later.
    hub.holdDecision = 2;
    return json(res, { task_id: 'remote_task_t1', review_id: decision[1], decision: JSON.parse(raw).decision });
  }
  if (p === '/sync/status') return json(res, { hub_id: 'hub_synthetic', cursor: 7 });
  if (p === '/sync/proposals') return json(res, { items: [] });
  if (p === '/sync/memory-records/conflicts') return json(res, { items: [], next_offset: null });
  // 真理: default manager, follow-up feeds and the waiting remote run.
  if (p === '/managers/default' && req.method === 'POST') return json(res, managerView());
  if (p === '/managers/manager-main' && req.method === 'GET') return json(res, managerView());
  if (p === '/managers/manager-main/goals') return json(res, { goals: [], next_offset: null });
  if (p === '/managers/manager-main/events') {
    const events = Number(url.searchParams.get('after') || 0) < 1 ? [{ event_id: 1, kind: 'task_waiting', payload: { task_waiting: true, run_id: 'remote-run', status: 'waiting_confirmation' } }] : [];
    return json(res, { events, next_after: null });
  }
  if (p === '/managers/manager-main/deliveries' || p === '/managers/manager-main/executions') return json(res, { deliveries: [], executions: [], next_after: null });
  if (p === '/agent/runs/remote-run') return json(res, { run_id: 'remote-run', session_id: 'remote-session', trace_id: 't', status: reviews[hub.reviewStep] ? 'waiting_confirmation' : 'completed', created_at: stamp,
    remote_execution: { task_id: 'remote_task_t1', node_id: 'desk-a', environment_id: 'linux', workspace_id: 'work' } });
  if (p === '/sessions/manager-main') return json(res, { session: managerSession, messages: [{ message_id: 'm1', role: 'agent', content: '你好，我是真理。', payload: {} }] });
  if (p === '/sessions/delegated-a') return json(res, { session: delegatedSession, messages: [{ message_id: 'm2', role: 'user', content: '整理书房电脑项目结构', payload: {} }] });
  if (p === '/sessions/manager-main/inputs' && req.method === 'GET') return json(res, { inputs: hub.inputs, paused: false, pending_count: 0, active_run_id: null });
  if (p === '/sessions/manager-main/inputs' && req.method === 'POST') {
    const data = JSON.parse(raw);
    hub.inputs.push({ input_id: 'i' + hub.inputs.length, client_message_id: data.client_message_id, message_id: 'mi' + hub.inputs.length, sequence: hub.inputs.length + 1, status: 'completed', run_id: null });
    return json(res, { input: hub.inputs.at(-1), queue: { paused: false, pending_count: 0, active_run_id: null } }, 202);
  }
  if (p === '/sessions/manager-main/runs') return json(res, { session_id: 'manager-main', runs: [] });
  // Minimal hub workbench surfaces so the hosted chat page boots quietly.
  if (p === '/sessions' && req.method === 'GET') return json(res, { sessions: [managerSession, delegatedSession, cloudSession, delegatedSessionB, delegatedSessionA2, cloudAssistantSession], next_offset: null });
  if (p === '/sessions/deleted') return json(res, { sessions: [] });
  if (p === '/agent/models') return json(res, { default_client: 'synthetic', clients: [{ name: 'synthetic', default_model: 'm', models: ['m'] }] });
  if (p === '/agent/ui-defaults') return json(res, { configured: false, defaults: {} });
  if (p === '/agent/safety-reviews') return json(res, { reviews: [] });
  if (p === '/knowledge/file-types') return json(res, { file_types: [] });
  if (p === '/openapi.json') return json(res, { paths: {} });
  if (p === '/matters/sync') return json(res, { matters: [], items: [], cursor: 0, next_after: null });
  if (['/projects', '/memories', '/memories/feedback', '/matters', '/background/jobs'].includes(p)) return json(res, { projects: [], memories: [], feedback: [], items: [], matters: [], jobs: [], next_offset: null, cursor: 0 });
  if (p === '/memories/learning') return json(res, { scope: 'global', enabled: false });
  if (p === '/background/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(': idle\n\n'); }
  return json(res, { detail: 'Not mocked ' + p }, 404);
});
// The device applies a decision after a delay, then raises its next review.
setInterval(() => {
  if (hub.holdDecision > 0 && --hub.holdDecision === 0) hub.reviewStep += 1;
}, 1000).unref();

// ---------- Node ----------
function nodeServer(n) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), p = url.pathname, raw = await body(req);
    n.requests.push({ method: req.method, path: p, csrf: req.headers['x-csrf-token'] || '', query: url.search });
    if (staticFile(req, res, p)) return;
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p === '/client/info') return json(res, { role: 'replica', node_id: n.id, hub_url: HUB_ORIGIN, connections_enabled: true, execution_enabled: false, workbench: true });
    if (p === '/connections/redeem' && req.method === 'POST') {
      const grant = JSON.parse(raw).grant;
      // The first attempt arrives before the node has polled the hub.
      if (++n.redeemAttempts === 1) return json(res, { detail: 'grant not installed' }, 403);
      if (hub.grants.get(grant) !== n.id) return json(res, { detail: 'invalid grant' }, 401);
      hub.grants.delete(grant);
      const token = 'conn-' + n.id + '-' + Math.random().toString(36).slice(2);
      n.connections.set(token, { csrf: 'csrf-' + n.id, session_id: 'c-' + n.id });
      return json(res, { session_id: 'c-' + n.id, node_id: n.id, csrf_token: 'csrf-' + n.id, expires_at: 4102444800, scopes: ['ordinary.chat', 'workspaces'] }, 200,
        { 'set-cookie': 'lka_node_connection=' + token + '; Path=/; HttpOnly; SameSite=Strict' });
    }
    const connection = n.connections.get(cookie(req, 'lka_node_connection'));
    if (!connection) return json(res, { detail: 'device connection authentication required' }, 401);
    if (!['GET', 'HEAD'].includes(req.method)) {
      n.csrfPosts.push(req.headers['x-csrf-token'] === connection.csrf);
      if (req.headers['x-csrf-token'] !== connection.csrf) return json(res, { detail: 'allowed Origin and CSRF token required' }, 403);
    }
    // Same refusal list as the real node boundary.
    if (/^\/(?:managers|matters|projects|memories|background|plugins|openapi\.json)/.test(p) || p === '/agent/safety-reviews' || p === '/agent/ui-defaults' && req.method === 'PUT') {
      return json(res, { detail: 'direct node access is limited to ordinary sessions and workspaces' }, 403);
    }
    if (p === '/connections/me') return json(res, { session_id: connection.session_id, node_id: n.id, user_id: 'u1', workspace_ids: n.workspaces, expires_at: 4102444800, csrf_token: connection.csrf });
    if (p === '/connections/sessions') return json(res, { items: [{ session_id: connection.session_id, node_id: n.id, expires_at: 4102444800, workspace_ids: n.workspaces, current: true }] });
    if (p === '/connections/logout') { n.connections.delete(cookie(req, 'lka_node_connection')); res.writeHead(204); return res.end(); }
    if (p === '/local/workspaces') return json(res, { items: n.workspaces.map(workspace_id => ({ workspace_id })) });
    const entries = p.match(/^\/local\/workspaces\/([^/]+)\/entries$/);
    if (entries) return json(res, { workspace_id: entries[1], path: url.searchParams.get('path') || '', items: n.files.get(url.searchParams.get('path') || '') || [] });
    const file = p.match(/^\/local\/workspaces\/([^/]+)\/file$/);
    if (file && req.method === 'PUT') {
      const target = url.searchParams.get('path');
      const list = n.files.get('') || [];
      if (list.some(item => item.name === target)) return json(res, { detail: 'path already exists' }, 409);
      list.push({ name: target, is_directory: false, size: raw.length }); n.files.set('', list);
      return json(res, { workspace_id: file[1], path: target, size: raw.length }, 201);
    }
    if (p === '/local/cache') return json(res, { available: true, stale: false, age_seconds: 12, cursor: 7, reads_allow_stale: true, memory_aggregation: { enabled: false } });
    if (p === '/local/shared-memory/status') return json(res, { write_enabled: true, queued: 0, conflict: 0, rejected: 0, cache: { stale: false } });
    if (p === '/local/shared-memory/records') return json(res, { memories: [{ memory_id: 'cloud_m1', content: n.id + ' 的共享偏好', version: 2, scope: 'global', memory_type: 'preference', sensitivity: 'normal', metadata: { shared_memory_id: 'm1' } }] });
    if (p === '/local/shared-memory/mutations' && req.method === 'GET') return json(res, { items: [] });
    if (p === '/agent/models') return json(res, { default_client: 'synthetic', clients: [{ name: 'synthetic', default_model: 'm', models: ['m'] }] });
    if (p === '/agent/ui-defaults') return json(res, { configured: false, defaults: {} });
    if (p === '/knowledge/file-types') return json(res, { detail: 'not allowed' }, 403);
    if (p === '/sessions/deleted') return json(res, { sessions: [] });
    if (p === '/sessions' && req.method === 'GET') return json(res, { sessions: [...n.sessions.values()].map(s => s.session), next_offset: null });
    if (p === '/sessions' && req.method === 'POST') {
      const id = n.id + '-s' + (n.nextSession++), stamp = '2026-10-24T02:00:00Z';
      const session = { session_id: id, title: JSON.parse(raw).title || '新会话', status: 'active', kind: 'ordinary', metadata: {}, created_at: stamp, updated_at: stamp };
      n.sessions.set(id, { session, messages: [], workspace: null });
      return json(res, { session, messages: [] }, 201);
    }
    const bind = p.match(/^\/sessions\/([^/]+)\/workspace-id$/);
    if (bind) {
      const record = n.sessions.get(bind[1]), workspace = JSON.parse(raw).workspace_id;
      if (!record) return json(res, { detail: 'not found' }, 404);
      if (!n.workspaces.includes(workspace)) return json(res, { detail: 'workspace not granted' }, 403);
      record.workspace = workspace;
      return json(res, { path: '/srv/' + n.id + '/' + workspace, platform: 'linux', backend_path: '/srv/' + n.id + '/' + workspace, state: 'created' });
    }
    const runReviews = p.match(/^\/agent\/runs\/([^/]+)\/safety-reviews$/);
    if (runReviews) return json(res, { reviews: [] });
    const run = p.match(/^\/agent\/runs\/([^/]+)(?:\/(snapshot|events))?$/);
    if (run) return json(res, { run_id: run[1], status: 'completed', events: [], next_sequence: 0 });
    const runs = p.match(/^\/sessions\/([^/]+)\/runs$/);
    if (runs) return json(res, { runs: [] });
    const detail = p.match(/^\/sessions\/([^/]+)$/);
    if (detail) { const record = n.sessions.get(detail[1]); return record ? json(res, { session: record.session, messages: record.messages }) : json(res, { detail: 'not found' }, 404); }
    if (p === '/agent/turn/stream' && req.method === 'POST') {
      const turn = JSON.parse(raw), record = n.sessions.get(turn.session_id);
      if (!record) return json(res, { detail: 'existing ordinary local session required' }, 403);
      n.turns.push({ session: turn.session_id, workspace: record.workspace, text: turn.user_input });
      record.messages.push({ role: 'user', content: turn.user_input }, { role: 'assistant', content: n.id + ' 已处理' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('event: run_started\ndata: ' + JSON.stringify({ type: 'run_started', run_id: n.id + '-run', session_id: turn.session_id }) + '\n\n');
      res.write('event: final_answer\ndata: ' + JSON.stringify({ type: 'final_answer', run_id: n.id + '-run', message: n.id + ' 已处理', payload: { answer: n.id + ' 已处理' } }) + '\n\n');
      res.write('event: run_completed\ndata: ' + JSON.stringify({ type: 'run_completed', run_id: n.id + '-run', status: 'completed' }) + '\n\n');
      return res.end();
    }
    return json(res, { detail: 'Not mocked ' + p }, 404);
  });
}

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  ports.hub = await listen(hubServer);
  ports['desk-a'] = await listen(nodeServer(nodes['desk-a']));
  ports['desk-b'] = await listen(nodeServer(nodes['desk-b']));
  // Map each *.example.ts.net origin to its synthetic localhost port.
  const mapping = { 'hub.example.ts.net': ports.hub, 'desk-a.example.ts.net': ports['desk-a'], 'desk-b.example.ts.net': ports['desk-b'] };
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    for (const viewport of [{ width: 1280, height: 820, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.mobile, isMobile: viewport.mobile, ignoreHTTPSErrors: true });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        const port = mapping[url.hostname];
        if (!port) { external.push(url.href); return route.abort(); }
        // Serve the HTTPS origin from the HTTP synthetic server; cookies and storage keep the HTTPS origin.
        const target = 'http://127.0.0.1:' + port + url.pathname + url.search;
        const headers = { ...route.request().headers() };
        const response = await route.fetch({ url: target, headers });
        return route.fulfill({ response });
      });
      // Delay response-copy parsing: manager identity must be learned before
      // callers can use the returned session on this node-hosted page.
      await context.addInitScript(() => {
        const clone = Response.prototype.clone;
        Response.prototype.clone = function () {
          const copy = clone.call(this);
          if (new URL(this.url || location.href).pathname === '/managers/default') {
            const json = copy.json.bind(copy);
            copy.json = async () => { await new Promise(resolve => setTimeout(resolve, 700)); return json(); };
          }
          return copy;
        };
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(viewport.width + ': ' + error.message));
      page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource|status of 40[134]/.test(message.text())) errors.push(viewport.width + ' console: ' + message.text()); });

      // 1. Unified entry: login on the hub, device list appears.
      await page.goto('https://hub.example.ts.net/desktop-pet/connect.html' + (viewport.mobile ? '?layout=mobile' : ''));
      await page.locator('#loginView').waitFor();
      await page.fill('#loginUser', 'owner'); await page.fill('#loginPassword', 'wrong-password');
      await page.click('#loginForm button[type=submit]');
      await page.locator('#loginError').filter({ hasText: '账号或密码不正确' }).waitFor();
      await page.fill('#loginPassword', 'correct-horse-battery');
      await page.click('#loginForm button[type=submit]');
      await page.locator('.entry-device').first().waitFor();
      assert.equal(await page.locator('.entry-device').count(), 2);
      assert.equal(await page.evaluate(() => document.cookie), '', 'session cookie is HttpOnly');
      assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => /token|password|grant/i.test(localStorage.getItem(key) || ''))), false, 'no secrets in storage');
      await page.screenshot({ path: path.join(OUT, viewport.width + '-entry.png'), fullPage: true });

      // 2. Enter A: grant in fragment only, retried redeem, workbench opens on A.
      await page.locator('.entry-device', { hasText: '书房电脑' }).locator('.entry-enter').click();
      await page.waitForURL(/desk-a\.example\.ts\.net\/desktop-pet\/chat\.html/, { timeout: 20000 });
      assert(!/grant/.test(page.url()), 'grant never stays in the URL');
      assert(nodes['desk-a'].requests.filter(r => r.path === '/connections/redeem').length >= 2, 'redeem retried after 403');
      assert(nodes['desk-a'].requests.every(r => !/grant/.test(r.query || '')), 'grant never sent as query');
      await page.locator('#clLocation').waitFor();
      assert.match(await page.locator('#clLocation').innerText(), /书房电脑/, 'header names the device');
      // One header entry names this place and lists every place to switch to.
      assert.equal(await page.locator('#clSwitchDevice').count(), 0, 'no separate switch link');
      await page.click('#clLocation');
      const menu = page.locator('#clPlaceMenu');
      await menu.locator('.cl-place-option', { hasText: '实验室笔记本' }).waitFor();
      assert.equal(await menu.locator('.cl-place-option.is-current').innerText().then(t => /书房电脑|desk-a/.test(t)), true, 'current device marked');
      const hubHref = await menu.locator('.cl-place-option', { hasText: '云端工作台' }).getAttribute('href');
      assert.match(hubHref, /^https:\/\/hub\.example\.ts\.net\/desktop-pet\/chat\.html\?mode=work&host=hub/);
      if (viewport.mobile) assert.match(hubHref, /layout=mobile/);
      await page.screenshot({ path: path.join(OUT, viewport.width + '-place-menu.png') });
      await page.keyboard.press('Escape');
      assert.equal(await menu.isHidden(), true, 'Escape closes the place menu');
      // The hub cookie carries over (ts.net is one site): 真理 and 待办 stay available on the node page.
      if (!viewport.mobile) {
        await page.locator('#openGlobalAssistant').waitFor();
        await page.waitForFunction(() => document.body.classList.contains('lka-cloud-ready'));
        assert.equal(await page.locator('#openMattersSidebarButton').isVisible(), true, '待办 entry on node page when the hub is signed in');
      }
      // Local-service surfaces stay absent on a node page.
      for (const id of ['openProjectsButton', 'openMessagesButton', 'qqReaderPanel']) {
        assert.equal(await page.locator('#' + id).isVisible().catch(() => false), false, id + ' hidden on node page');
      }

      // 3. Send a turn on A: session created on A and bound to its workspace ID.
      await page.fill('#questionInput', '整理 A 的项目结构');
      if (viewport.mobile) await page.click('#sendButton'); else await page.press('#questionInput', 'Enter');
      await page.locator('#messages').getByText('desk-a 已处理').first().waitFor({ timeout: 15000 });
      assert.equal(nodes['desk-a'].turns.length, 1);
      assert.equal(nodes['desk-a'].turns[0].workspace, 'work', 'single approved workspace bound before the turn');
      assert(nodes['desk-a'].csrfPosts.length > 0 && nodes['desk-a'].csrfPosts.every(Boolean), 'every node write carries CSRF');
      // Draft on A must not leak to B.
      await page.fill('#questionInput', 'A 的未发送草稿');
      await page.waitForTimeout(400);

      // 4. Files on A: listing, create-only upload with 409 on duplicates.
      if (viewport.mobile) await page.locator('#mobileNav [data-mobile-action="files"]').click();
      else { if (!(await page.locator('#contextRail').isVisible())) await page.click('#toggleSettingsButton'); await page.click('#filesTabButton'); }
      await page.locator('#fileList').getByText('readme.md').waitFor();
      await page.setInputFiles('#workspaceUploadInput', { name: 'readme.md', mimeType: 'text/plain', buffer: Buffer.from('dup') });
      await page.locator('#workspaceTransferList').getByText('同名文件').waitFor();
      await page.setInputFiles('#workspaceUploadInput', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
      await page.locator('#workspaceTransferList').getByText('已保存到设备').waitFor();
      assert(nodes['desk-a'].files.get('').some(item => item.name === 'notes.txt'));
      await page.screenshot({ path: path.join(OUT, viewport.width + '-node-a-files.png') });
      if (viewport.mobile) await page.click('#closeSettingsButton');

      if (!viewport.mobile) {
        // 4b. 真理 on node A: its reminder for a remote approval opens the task review in place.
        await page.click('#openGlobalAssistant');
        const reminder = page.locator('#gaRecords .ga-record', { hasText: '远程任务' });
        await reminder.waitFor({ timeout: 15000 });
        assert(!nodes['desk-a'].requests.some(r => r.path === '/sessions/manager-main'), 'manager session must never be read from a node while response-copy parsing is delayed');
        assert.equal(hub.requests.some(r => r.path === '/managers/default' && r.origin === 'https://desk-a.example.ts.net'), true, 'node page talks to the hub directly');
        await reminder.locator('a', { hasText: '查看并确认' }).click();
        await page.locator('.cl-task').filter({ hasText: '整理书房电脑项目结构' }).waitFor();
        const remoteTaskCard = page.locator('.cl-task').filter({ hasText: '整理书房电脑项目结构' });
        assert.match(await remoteTaskCard.locator('summary').innerText(), /执行于 desk-a \/ linux/);
        if (!(await remoteTaskCard.evaluate(element => element.open))) await remoteTaskCard.locator('summary').click();
        await remoteTaskCard.getByText(/审批模式：请求 skip · 实际 manual（设备策略）/).waitFor();
        await remoteTaskCard.getByText('来源：真理会话 manager-main').waitFor();
        await remoteTaskCard.getByText('执行会话：delegated-execution-01').waitFor();
        const first = page.locator('.cl-review[data-review-id="rev-list-0001"]');
        await first.waitFor();
        assert.match(await first.innerText(), /filesystem\.list_directory[\s\S]*work\/reports/, 'tool name and target path visible');
        assert.equal(page.url().includes('desk-a.example.ts.net'), true, 'reminder stays on this page, no new tab');
        await first.getByRole('button', { name: '批准' }).click();
        // Accepted by the cloud, not yet applied by the device: locked, not re-offered.
        await first.locator('text=等待设备处理').waitFor();
        assert.equal(await page.locator('.cl-review[data-review-id="rev-list-0001"] button', { hasText: '批准' }).count(), 0, 'submitted review cannot be approved twice');
        // The device moves on: the next review is a new, separate request.
        const second = page.locator('.cl-review[data-review-id="rev-write-0002"]');
        await second.waitFor({ timeout: 15000 });
        assert.match(await second.innerText(), /filesystem\.write_file[\s\S]*summary\.md/);
        assert.equal(await page.locator('.cl-review[data-review-id="rev-list-0001"]').count(), 0, 'settled review is gone');
        assert.deepEqual(hub.decisions, [{ review: 'rev-list-0001', decision: 'approve' }], 'only the reviewed step was decided');
        await page.screenshot({ path: path.join(OUT, viewport.width + '-remote-review.png') });
        await page.click('#clClose');
        // A new tab in the same browser keeps both the node connection and the cloud login.
        const tab = await context.newPage();
        tab.on('pageerror', error => errors.push(viewport.width + ' tab: ' + error.message));
        await tab.goto('https://desk-a.example.ts.net/desktop-pet/chat.html?mode=work&host=replica&session_id=manager-main');
        await tab.waitForFunction(() => window.LkaHost && window.LkaHost.snapshot().identity === 'ready' && document.body.classList.contains('lka-cloud-ready'), null, { timeout: 15000 });
        await tab.close();
      }

      // 5. Device panel on A: shared memory mirror, then switch to B through the hub.
      await page.screenshot({ path: path.join(OUT, viewport.width + '-node-a-chat.png') });
      await page.click('#clLocation');
      await page.locator('#clPlaceMenu .cl-place-manage', { hasText: '设备与账号' }).click();
      await page.locator('#clusterOverlay').waitFor();
      await page.getByRole('tab', { name: '共享记忆' }).click();
      await page.locator('#clBody').getByText('desk-a 的共享偏好').waitFor();
      await page.getByRole('tab', { name: '概览' }).click();
      assert.equal(await page.locator('#clBody').getByText('切换设备').count(), 0, 'overview no longer duplicates switching');
      await page.screenshot({ path: path.join(OUT, viewport.width + '-node-a-panel.png') });
      await page.click('#clClose');
      // Switch A → B straight from the header menu: a fresh grant, no detour through the entry page.
      await page.click('#clLocation');
      await page.locator('#clPlaceMenu .cl-place-option', { hasText: '实验室笔记本' }).click();
      await page.waitForURL(/desk-b\.example\.ts\.net\/desktop-pet\/chat\.html/, { timeout: 20000 });
      await page.locator('#clLocation').filter({ hasText: '实验室笔记本' }).waitFor();
      assert.equal(await page.inputValue('#questionInput'), '', 'A draft does not appear on B');
      assert.equal(await page.locator('#messages').getByText('desk-a 已处理').count(), 0, 'A history does not appear on B');
      assert.equal(nodes['desk-b'].requests.some(r => /desk-a-s/.test(r.path)), false, 'A session IDs never sent to B');

      assert.equal(await page.locator('#openNodeTasksButton').count(), 1, 'node sidebar has a direct entry for its dispatched tasks');
      await page.click('#clLocation');
      await page.locator('#clPlaceMenu .cl-place-manage', { hasText: '设备与账号' }).click();
      await page.locator('#clusterOverlay').waitFor();
      await page.getByRole('tab', { name: '真理派发' }).click();
      await page.locator('.cl-task').filter({ hasText: '实验室任务' }).waitFor();
      assert.equal(await page.locator('.cl-task').count(), 1, 'node B lists only its own remote tasks');
      await page.click('#clClose');

      // 6. B has two workspaces: the turn waits for an explicit choice, then binds.
      if (viewport.mobile) await page.locator('#mobileNav [data-mobile-action="files"]').click();
      else { if (!(await page.locator('#contextRail').isVisible())) await page.click('#toggleSettingsButton'); await page.click('#filesTabButton'); }
      const picker = page.locator('.node-workspace-picker select');
      await picker.waitFor();
      await picker.selectOption('lab');
      await page.locator('#fileList').getByText('journal.txt').waitFor();
      if (viewport.mobile) await page.click('#closeSettingsButton');
      await page.fill('#questionInput', 'B 上的任务');
      if (viewport.mobile) await page.click('#sendButton'); else await page.press('#questionInput', 'Enter');
      await page.locator('#messages').getByText('desk-b 已处理').first().waitFor({ timeout: 15000 });
      assert.equal(nodes['desk-b'].turns.at(-1).workspace, 'lab');
      // Node boundary: the page never asked for refused surfaces.
      const refused = nodes['desk-b'].requests.filter(r => /^\/(?:managers|matters|projects|memories|background|plugins|openapi\.json)/.test(r.path) || r.path === '/agent/safety-reviews');
      assert.deepEqual(refused.map(r => r.path), [], 'node pages do not call cloud-only APIs');

      // 7. Cloud offline: B's entry still lists the saved devices; A opens with its own cookie.
      hub.online = false;
      await page.goto('https://desk-b.example.ts.net/desktop-pet/connect.html?reason=expired');
      await page.waitForURL(/desk-b\.example\.ts\.net\/desktop-pet\/chat\.html/, { timeout: 10000 });
      await page.goto('https://hub.example.ts.net/desktop-pet/connect.html');
      await page.locator('#offlineView').waitFor();
      const fallback = page.locator('#fallbackList a', { hasText: '书房电脑' });
      await fallback.waitFor();
      await page.screenshot({ path: path.join(OUT, viewport.width + '-offline.png'), fullPage: true });
      await fallback.click();
      await page.waitForURL(/desk-a\.example\.ts\.net\/desktop-pet\/chat\.html/, { timeout: 10000 });
      await page.locator('#clLocation').filter({ hasText: '书房电脑' }).waitFor();
      // Revoked connection: clear A's cookie session, the page asks to re-enter instead of switching.
      nodes['desk-a'].connections.clear();
      await page.goto('https://desk-a.example.ts.net/desktop-pet/connect.html');
      await page.locator('#offlineTitle').filter({ hasText: '需要通过云端重新进入' }).waitFor();
      assert.match(page.url(), /desk-a\.example\.ts\.net/, 'no silent switch to another computer');
      hub.online = true;

      const hubHistory = await context.newPage();
      hubHistory.on('pageerror', error => errors.push(viewport.width + ' hub: ' + error.message));
      await hubHistory.goto('https://hub.example.ts.net/desktop-pet/chat.html?mode=work&host=hub');
      const delegatedRow = hubHistory.locator('.session-item', { hasText: '整理书房电脑项目结构' });
      await delegatedRow.waitFor({ timeout: 15000 });
      assert.match(await delegatedRow.locator('.session-meta').innerText(), /真理派发 · desk-a \/ linux · work/);
      const cloudAgentRow = hubHistory.locator('.session-item', { hasText: '云端本机整理资料' });
      await cloudAgentRow.waitFor();
      assert.match(await cloudAgentRow.locator('.session-meta').innerText(), /真理派发 · 云端本机/);
      const ordinaryCloudRow = hubHistory.locator('.session-item', { hasText: '云端讨论' });
      await ordinaryCloudRow.waitFor();
      assert.doesNotMatch(await ordinaryCloudRow.locator('.session-meta').innerText(), /真理派发/);
      const groupTitles = await hubHistory.locator('.session-group-label').allTextContents();
      assert.equal(groupTitles.filter(value => value === '执行设备：desk-a').length, 1, 'interleaved history rows remain in one device group');
      assert.equal(groupTitles.filter(value => value === '执行设备：desk-b').length, 1, 'second device has one group');
      assert.equal(groupTitles.filter(value => value === '云端会话').length, 1, 'cloud work has one group');
      assert.equal(nodes['desk-a'].requests.some(r => r.path === '/sessions/delegated-a'), false, 'hub delegated history is not loaded from the node');
      await hubHistory.close();

      if (viewport.mobile) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(overflow <= 1, 'no horizontal overflow on phone entry');
      }
      // Reset per-viewport synthetic state.
      Object.values(nodes).forEach(n => { n.redeemAttempts = 0; n.sessions.clear(); n.turns = []; n.csrfPosts = []; n.connections.clear(); n.files.set('', n.files.get('').filter(item => item.name !== 'notes.txt')); });
      await context.close();
    }
    assert.deepEqual(external, [], 'all traffic stays on synthetic origins');
    assert.deepEqual(errors, [], 'no browser errors');
    console.log(JSON.stringify({ result: 'PASS', viewports: ['1280x820', '390x844'], screenshots: OUT, checks: [
      'hub login, wrong password, HttpOnly cookie, no secrets in storage', 'grant only in fragment, redeem retried after 403',
      'node page hides 真理/待办/项目/消息/QQ', 'node session created and bound to approved workspace ID before turn', 'CSRF on every node write',
      'create-only upload with 409 on duplicate', 'shared memory mirror', 'switch A → B through entry; drafts, history and session IDs isolated',
      'explicit workspace choice when several are approved', 'node sidebar links to hub and lists only this node’s dispatched tasks',
      'remote session history is grouped by actual execution node with source, environment and workspace',
      'remote task cards show requested/effective review mode and source session',
      'no cloud-only calls on node pages', 'cloud offline fallback list and direct reopen', 'revoked node asks to re-enter, no silent switch'] }, null, 2));
  } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
  finally { await browser.close(); hubServer.close(); Object.values(nodes).forEach(() => {}); process.exit(process.exitCode || 0); }
})();
