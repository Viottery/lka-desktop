// Isolated session lifecycle regression. Browser HTTP is restricted to a synthetic localhost origin.
// Run from Windows with Playwright/Chrome installed; see the invocation printed in the task report.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const ROOT = path.resolve(process.env.FRONTEND_ROOT || path.join(__dirname, '../app/web/pet'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SESSIONS_KEY = 'agentic-rag-pet-chat-sessions-v4';
const ACTIVE_KEY = 'agentic-rag-pet-chat-active-session-v4';
const DELETED_KEY = SESSIONS_KEY + '-deleted';
const SNAPSHOTS_KEY = SESSIONS_KEY + '-deleted-snapshots';
const DRAFT_PREFIX = SESSIONS_KEY + '-draft-';
const now = Date.now();
const greeting = '把任务交给我。可以先从提问、查找资料或整理文件开始。';
const remoteDetails = Object.create(null);
const requests = [];
const softDeletes = [];
const deleteAttempts = [];
const manualDeletes = [];
const externalAttempts = [];
const pageErrors = [];
const rejectedDeleteIds = new Set(['conv_rejected']);
const nonEmptyWorkspaceIds = new Set(['conv_nonempty-workspace']);
const unreadableWorkspaceIds = new Set(['conv_unreadable-workspace']);
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
const detail = (id, overrides = {}) => ({
  session: Object.assign({ session_id: id, title: '新会话', status: 'active', created_at: new Date(now).toISOString(), updated_at: new Date(now - 1000).toISOString(),
    workspace: { path: 'C:/synthetic/workspaces/' + id }, project_id: null, metadata: { source_frontend: 'windows-pet' } }, overrides),
  messages: []
});
const summary = id => ({ session_id: id, title: '新会话', created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() });
const readBody = req => new Promise(resolve => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requests.push({ method: req.method, path: url.pathname });
  if (url.pathname === '/' || url.pathname === '/chat.html') {
    const html = fs.readFileSync(path.join(ROOT, 'chat.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  if (url.pathname.startsWith('/')) {
    const relative = url.pathname === '/' ? 'chat.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(ROOT, relative);
    if (file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
  }
  if (url.pathname === '/agent/models') return json(res, 200, { clients: [] });
  if (url.pathname === '/agent/ui-defaults') return json(res, 200, { configured: false, defaults: {} });
  if (url.pathname === '/openapi.json') return json(res, 200, { paths: { '/sessions/{session_id}': { delete: { parameters: [
    { name: 'only_if_empty', in: 'query', required: false }, { name: 'expected_updated_at', in: 'query', required: false }
  ] } } } });
  if (url.pathname === '/sessions' && req.method === 'GET') {
    return json(res, 200, { sessions: Object.keys(remoteDetails).map(summary) });
  }
  if (url.pathname === '/sessions/deleted') return json(res, 200, { sessions: [] });
  if (url.pathname === '/pet/session-workspace' && req.method === 'POST') {
    const body = await readBody(req);
    const id = body.session_id || 'conv_unspecified';
    return json(res, 200, { path: 'C:/synthetic/workspaces/' + id });
  }
  if (url.pathname.includes('/files') && req.method === 'GET') {
    const filesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/files$/);
    const id = filesMatch ? decodeURIComponent(filesMatch[1]) : '';
    if (unreadableWorkspaceIds.has(id)) return json(res, 503, { detail: 'synthetic_files_unavailable' });
    return json(res, 200, { files: [], entries: nonEmptyWorkspaceIds.has(id) ? [{ name: 'kept.txt' }] : [] });
  }
  const match = url.pathname.match(/^\/sessions\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (req.method === 'GET') return remoteDetails[id] ? json(res, 200, remoteDetails[id]) : json(res, 404, { detail: 'synthetic_not_found' });
    if (req.method === 'DELETE') {
      const params = Object.fromEntries(url.searchParams.entries());
      if (!Object.keys(params).length) {
        manualDeletes.push(id);
        delete remoteDetails[id];
        return json(res, 200, { deleted: true });
      }
      deleteAttempts.push({ id, params });
      if (params.only_if_empty !== 'true' || !params.expected_updated_at) return json(res, 400, { detail: 'synthetic_missing_guard_parameters' });
      if (rejectedDeleteIds.has(id)) return json(res, 409, { detail: 'synthetic_session_changed' });
      softDeletes.push(id);
      delete remoteDetails[id];
      return json(res, 200, { deleted: true });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (remoteDetails[id]) {
        remoteDetails[id].session.title = body.title || remoteDetails[id].session.title;
        remoteDetails[id].session.metadata.title_is_custom = true;
      }
      return json(res, 200, { session: { session_id: id } });
    }
  }
  return json(res, 404, { detail: 'not_mocked', path: url.pathname });
});

function session(id, extra = {}) {
  return Object.assign({
    id, conversation_id: id, title: '新会话', title_is_custom: false,
    created_at: now - 5000, updated_at: now - 1000,
    workspace: '', project_id: '', multiAgentRunId: '', multiAgentSequence: 0,
    timelineEvents: [], timelineState: '', messages: [{ role: 'assistant', text: greeting }]
  }, extra);
}

async function openPage(browser, origin, storage = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) {
      externalAttempts.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(({ draftPrefix, storage }) => {
    if (sessionStorage.getItem('__session_smoke_fixture_seeded') !== '1') {
      for (const [key, value] of Object.entries(storage)) {
        localStorage.setItem(key, key.startsWith(draftPrefix) || typeof value === 'string' ? String(value) : JSON.stringify(value));
      }
      sessionStorage.setItem('__session_smoke_fixture_seeded', '1');
    }
    localStorage.setItem('lka-current-backend-url', location.origin);
  }, { draftPrefix: DRAFT_PREFIX, storage });
  await page.goto(origin + '/chat.html?mode=work&backend=' + encodeURIComponent(origin));
  await page.waitForFunction(() => typeof window.__petChatSubmitText === 'function');
  return { context, page };
}

async function storedSessions(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]'), SESSIONS_KEY);
}

(async () => {
  let browser;
  const contexts = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox'] });

    // Empty initial task is reused across refreshes and repeated new-task actions.
    const first = await openPage(browser, origin);
    contexts.push(first.context);
    await first.page.waitForFunction(() => JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4') || '[]').length > 0);
    const initial = await storedSessions(first.page);
    assert.equal(initial.filter(s => !s.title_is_custom && !(s.messages || []).some(m => m.role === 'user')).length, 1,
      'initialization leaves a single blank autogenerated session');
    const initialId = await first.page.evaluate(key => localStorage.getItem(key), ACTIVE_KEY);
    await first.page.locator('#newSessionButton').click();
    await first.page.locator('#newQuickSessionButton').click();
    await first.page.waitForTimeout(100);
    let afterActions = await storedSessions(first.page);
    assert.equal(await first.page.evaluate(key => localStorage.getItem(key), ACTIVE_KEY), initialId,
      'new-task actions reuse the same eligible blank conv_ session');
    assert.equal(afterActions.filter(s => !s.title_is_custom && !(s.messages || []).some(m => m.role === 'user')).length, 1,
      'repeated new-session actions do not accumulate blank autogenerated sessions');
    await first.page.reload();
    await first.page.waitForFunction(() => typeof window.__petChatSubmitText === 'function');
    const afterReload = await storedSessions(first.page);
    assert.equal(afterReload.filter(s => !s.title_is_custom && !(s.messages || []).some(m => m.role === 'user')).length, 1,
      'refresh does not accumulate another blank autogenerated session');
    assert(afterReload.some(s => s.id === initialId), 'refresh preserves/reuses the active blank task identity');
    await first.context.close();
    contexts.splice(contexts.indexOf(first.context), 1);

    // Cleanup removes only verified, truly empty remote auto-sessions. Drafts, names,
    // active runs, and either kind of selected workspace remain local and untouched.
    const cleanupRows = [
      session('conv_old-empty', { workspace: 'C:/synthetic/workspaces/conv_old-empty' }),
      session('conv_draft-empty', { workspace: 'C:/synthetic/workspaces/conv_draft-empty' }),
      session('conv_named-empty', { title: '手工标题', title_is_custom: true, workspace: 'C:/synthetic/workspaces/conv_named-empty' }),
      session('conv_running-empty', { multiAgentRunId: 'synthetic-run', timelineState: 'running', workspace: 'C:/synthetic/workspaces/conv_running-empty' }),
      session('conv_workspace-empty', { workspace: 'C:/synthetic/custom-workspace' }),
      session('conv_project-empty', { workspace: 'C:/synthetic/project-workspace', project_id: 'synthetic-project', project_session: true }),
      session('conv_workspace-explicit', { workspace: 'C:/synthetic/selected-folder', workspace_is_custom: true }),
      session('conv_has-message', { workspace: 'C:/synthetic/workspaces/conv_has-message', messages: [{ role: 'assistant', text: '已有回复' }] }),
      session('conv_rejected', { workspace: 'C:/synthetic/workspaces/conv_rejected' }),
      session('conv_nonempty-workspace', { workspace: 'C:/synthetic/workspaces/conv_nonempty-workspace' }),
      session('conv_unreadable-workspace', { workspace: 'C:/synthetic/workspaces/conv_unreadable-workspace' }),
      session('conv_other-source', { workspace: 'C:/synthetic/workspaces/conv_other-source' }),
      session('conv_local-old-a', { workspace: 'C:/synthetic/workspaces/conv_local-old-a' }),
      session('conv_local-old-b', { workspace: 'C:/synthetic/workspaces/conv_local-old-b' }),
      session('conv_current', { workspace: 'C:/synthetic/workspaces/conv_current' })
    ];
    const backendIds = new Set(['conv_old-empty', 'conv_draft-empty', 'conv_named-empty', 'conv_running-empty', 'conv_workspace-empty', 'conv_project-empty', 'conv_workspace-explicit', 'conv_has-message', 'conv_rejected', 'conv_nonempty-workspace', 'conv_unreadable-workspace', 'conv_other-source', 'conv_current']);
    cleanupRows.forEach(row => { if (backendIds.has(row.id)) row.backendWorkspace = row.workspace; });
    for (const id of ['conv_old-empty', 'conv_draft-empty', 'conv_named-empty', 'conv_running-empty', 'conv_workspace-empty', 'conv_project-empty', 'conv_workspace-explicit', 'conv_has-message', 'conv_rejected', 'conv_nonempty-workspace', 'conv_unreadable-workspace', 'conv_other-source', 'conv_current']) {
      const extra = id === 'conv_other-source' ? { metadata: { source_frontend: 'other-client' } }
        : id === 'conv_project-empty' ? { workspace: { path: 'C:/synthetic/project-workspace' }, project_id: 'synthetic-project', metadata: { source_frontend: 'windows-pet', project_session: true } }
        : id === 'conv_running-empty' ? { status: 'running', metadata: { source_frontend: 'windows-pet', run_id: 'synthetic-run', timeline_state: 'running' } }
        : id === 'conv_workspace-empty' ? { workspace: { path: 'C:/synthetic/custom-workspace' }, metadata: { source_frontend: 'windows-pet', explicit_workspace: true } }
        : id === 'conv_workspace-explicit' ? { workspace: { path: 'C:/synthetic/selected-folder' }, metadata: { source_frontend: 'windows-pet', workspace_is_custom: true } }
        : {};
      remoteDetails[id] = detail(id, extra);
      if (id === 'conv_has-message') {
        remoteDetails[id].messages = [{ message_id: id + '-assistant', session_id: id, role: 'assistant', content: '已有回复', created_at: new Date(now).toISOString() }];
      }
    }
    const cleanup = await openPage(browser, origin, {
      [SESSIONS_KEY]: cleanupRows, [ACTIVE_KEY]: 'conv_current', [DRAFT_PREFIX + encodeURIComponent('conv_draft-empty')]: '还没发送的内容',
      [SESSIONS_KEY + '-run-cursor-' + encodeURIComponent('conv_running-empty')]: { run_id: 'synthetic-run', sequence: 4 }
    });
    contexts.push(cleanup.context);
    await cleanup.page.waitForFunction(() => !document.querySelector('#sessionListStatus')?.textContent.includes('正在读取历史'));
    await cleanup.page.waitForTimeout(300);
    let retained = await storedSessions(cleanup.page);
    assert(!retained.some(s => s.id === 'conv_old-empty'), 'verified remote blank auto-session is cleaned from the local active cache');
    assert(retained.some(s => s.id === 'conv_draft-empty'), 'unsent input draft protects its empty session');
    assert(retained.some(s => s.id === 'conv_named-empty' && s.title_is_custom), 'custom-title empty session is retained');
    assert(retained.some(s => s.id === 'conv_running-empty' && s.multiAgentRunId === 'synthetic-run'), 'running session is retained');
    assert(retained.some(s => s.id === 'conv_workspace-empty' && s.workspace === 'C:/synthetic/custom-workspace'), 'selected workspace session is retained');
    assert(retained.some(s => s.id === 'conv_project-empty' && s.project_id === 'synthetic-project'), 'project workspace session is retained');
    assert(retained.some(s => s.id === 'conv_workspace-explicit' && s.workspace === 'C:/synthetic/selected-folder'), 'explicit custom-workspace session is retained');
    assert(retained.some(s => s.id === 'conv_has-message'), 'session with message history is retained');
    assert(retained.some(s => s.id === 'conv_rejected'), '409 response keeps the local session');
    assert(retained.some(s => s.id === 'conv_nonempty-workspace'), 'workspace containing a file is retained');
    assert(retained.some(s => s.id === 'conv_unreadable-workspace'), 'workspace validation failure keeps the session');
    assert(retained.some(s => s.id === 'conv_other-source'), 'remote auto-cleanup skips sessions from other frontend sources');
    assert(!retained.some(s => s.id === 'conv_local-old-a' || s.id === 'conv_local-old-b'), 'stale pure-local blank conv_ drafts collapse to one reusable session');
    assert.deepEqual(softDeletes, ['conv_old-empty'], 'only confirmed eligible remote auto-session is deleted');
    assert.deepEqual(deleteAttempts.map(item => item.id).sort(), ['conv_old-empty', 'conv_rejected'].sort(), 'only eligible sessions reach guarded DELETE');
    assert(retained.some(s => s.id === 'conv_current') && !deleteAttempts.some(item => item.id === 'conv_current'), 'a genuinely empty backend detail for the active new task is protected from cleanup');
    assert(deleteAttempts.every(item => item.params.only_if_empty === 'true' && item.params.expected_updated_at), 'DELETE includes both empty-only and revision guards');
    assert.equal(await cleanup.page.evaluate(key => localStorage.getItem(key), DRAFT_PREFIX + encodeURIComponent('conv_draft-empty')), '还没发送的内容');
    await cleanup.context.close();
    contexts.splice(contexts.indexOf(cleanup.context), 1);
    for (const id of Object.keys(remoteDetails)) delete remoteDetails[id];

    // An unverified remote session is kept: detail lookup failure is not proof of emptiness.
    remoteDetails['conv_unverified-empty'] = null;
    const unverified = await openPage(browser, origin, {
      [SESSIONS_KEY]: [session('conv_unverified-empty')], [ACTIVE_KEY]: 'conv_unverified-empty'
    });
    contexts.push(unverified.context);
    await unverified.page.waitForTimeout(250);
    assert((await storedSessions(unverified.page)).some(s => s.id === 'conv_unverified-empty'), 'failed remote validation keeps the local session');
    assert(!deleteAttempts.some(item => item.id === 'conv_unverified-empty'), 'failed remote validation never issues DELETE');
    await unverified.context.close();
    contexts.splice(contexts.indexOf(unverified.context), 1);
    for (const id of Object.keys(remoteDetails)) delete remoteDetails[id];

    // Card meta/blank area opens a session; rename is an independent action.
    const cardRows = [
      session('card-active', { messages: [{ role: 'assistant', text: greeting }, { role: 'user', text: '当前会话正文' }] }),
      session('card-target', { messages: [{ role: 'assistant', text: greeting }, { role: 'user', text: '目标会话正文' }] })
    ];
    for (const id of ['card-active', 'card-target']) {
      remoteDetails[id] = Object.assign(detail(id), {
        messages: [{ message_id: id + '-user', session_id: id, role: 'user', content: id === 'card-active' ? '当前会话正文' : '目标会话正文', created_at: new Date(now).toISOString() }]
      });
    }
    const cards = await openPage(browser, origin, { [SESSIONS_KEY]: cardRows, [ACTIVE_KEY]: 'card-active' });
    contexts.push(cards.context);
    const target = cards.page.locator('.session-item[data-session-id="card-target"]');
    await target.scrollIntoViewIfNeeded();
    let hitBox = await target.locator('.session-meta').boundingBox();
    await cards.page.mouse.click(hitBox.x + Math.min(8, hitBox.width / 2), hitBox.y + hitBox.height / 2);
    await cards.page.waitForFunction(() => localStorage.getItem('agentic-rag-pet-chat-active-session-v4') === 'card-target');
    assert((await cards.page.locator('#messages').innerText()).includes('目标会话正文'), 'clicking card metadata switches the active session');
    const activeTitle = cards.page.locator('.session-item[data-session-id="card-active"] .session-title');
    await activeTitle.scrollIntoViewIfNeeded();
    hitBox = await activeTitle.boundingBox();
    await cards.page.mouse.click(hitBox.x + hitBox.width / 2, hitBox.y + hitBox.height / 2);
    await cards.page.waitForFunction(() => localStorage.getItem('agentic-rag-pet-chat-active-session-v4') === 'card-active');
    const targetTitle = target.locator('.session-title');
    await targetTitle.scrollIntoViewIfNeeded();
    hitBox = await targetTitle.boundingBox();
    await cards.page.mouse.click(hitBox.x + hitBox.width / 2, hitBox.y + hitBox.height / 2);
    await cards.page.waitForFunction(() => localStorage.getItem('agentic-rag-pet-chat-active-session-v4') === 'card-target');
    const activeCard = cards.page.locator('.session-item[data-session-id="card-active"]');
    await activeCard.scrollIntoViewIfNeeded();
    const activeCardBox = await activeCard.boundingBox();
    await cards.page.mouse.click(activeCardBox.x + 4, activeCardBox.y + 4);
    await cards.page.waitForFunction(() => localStorage.getItem('agentic-rag-pet-chat-active-session-v4') === 'card-active');
    await target.scrollIntoViewIfNeeded();
    hitBox = await target.locator('.session-meta').boundingBox();
    await cards.page.mouse.click(hitBox.x + Math.min(8, hitBox.width / 2), hitBox.y + hitBox.height / 2);
    await cards.page.waitForFunction(() => localStorage.getItem('agentic-rag-pet-chat-active-session-v4') === 'card-target');
    await cards.page.locator('.session-item[data-session-id="card-active"] .session-open').click();
    await cards.page.waitForFunction(() => localStorage.getItem('agentic-rag-pet-chat-active-session-v4') === 'card-active');
    await cards.page.locator('.session-item[data-session-id="card-target"] button.session-mini:not(.danger)').click();
    assert.equal(await cards.page.evaluate(key => localStorage.getItem(key), ACTIVE_KEY), 'card-active', 'rename action does not switch sessions');
    assert.equal(await cards.page.locator('.session-item[data-session-id="card-target"] .session-rename-input').count(), 1, 'rename action enters inline edit mode');
    await cards.page.locator('.session-item[data-session-id="card-target"] .session-rename-input').fill('合成重命名');
    await cards.page.locator('.session-item[data-session-id="card-target"] button').filter({ hasText: '保存' }).click();
    await cards.page.waitForFunction(() => JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4') || '[]').some(s => s.id === 'card-target' && s.title === '合成重命名'));
    assert.equal(await cards.page.evaluate(key => localStorage.getItem(key), ACTIVE_KEY), 'card-active', 'saving rename does not switch sessions');
    await cards.page.locator('.session-item[data-session-id="card-target"] button.session-mini.danger').click();
    await cards.page.waitForFunction(() => !JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4') || '[]').some(s => s.id === 'card-target'));
    assert.deepEqual(manualDeletes, ['card-target'], 'independent delete button deletes only its target session');
    assert.equal(await cards.page.evaluate(key => localStorage.getItem(key), ACTIVE_KEY), 'card-active', 'deleting another card does not change the active session');
    assert((await storedSessions(cards.page)).some(s => s.id === 'card-active'), 'delete leaves the other session intact');
    await cards.context.close();
    contexts.splice(contexts.indexOf(cards.context), 1);
    for (const id of Object.keys(remoteDetails)) delete remoteDetails[id];

    // Minimal native bridge compatibility: opening/creating an empty task does not require HTTP.
    const bridge = await browser.newContext();
    contexts.push(bridge);
    const bridgePage = await bridge.newPage();
    await bridgePage.addInitScript(() => {
      window.petBridge = {
        createSessionWorkspace: sessionId => JSON.stringify({ path: 'C:/synthetic/native-workspaces/' + sessionId }),
        createSession: () => JSON.stringify({ session: { session_id: 'native-empty-session' } })
      };
    });
    await bridgePage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (externalAttempts.push(route.request().url()), route.abort()));
    await bridgePage.goto(origin + '/chat.html?mode=work&backend=' + encodeURIComponent(origin));
    await bridgePage.waitForFunction(() => typeof window.__petChatSubmitText === 'function');
    const nativeBlankId = await bridgePage.evaluate(key => localStorage.getItem(key), ACTIVE_KEY);
    await bridgePage.locator('#newSessionButton').click();
    await bridgePage.locator('#newQuickSessionButton').click();
    await bridgePage.waitForTimeout(100);
    assert.equal((await storedSessions(bridgePage)).length, 1, 'native bridge reuses a single blank task');
    assert.equal(await bridgePage.evaluate(key => localStorage.getItem(key), ACTIVE_KEY), nativeBlankId, 'native bridge preserves reusable blank identity');
    await bridgePage.reload();
    await bridgePage.waitForFunction(() => typeof window.__petChatSubmitText === 'function');
    assert.equal((await storedSessions(bridgePage)).length, 1, 'native bridge refresh does not accumulate empty tasks');

    assert.equal(externalAttempts.length, 0, 'all browser network requests stay on the synthetic localhost origin');
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
    console.log(JSON.stringify({
      result: 'PASS',
      syntheticRequests: requests.length,
      verifiedRemoteSoftDeletes: softDeletes,
      checks: [
        'refresh and repeated new-session buttons keep only one blank initial task',
        'validated remote empty auto-session cleanup',
        'draft/custom title/running/custom workspace/project workspace/nonempty session retention',
        'guarded DELETE and 409 keeps local session; workspace file/error validation retains session',
        'remote validation failure never deletes local session',
        'session card metadata/title/blank padding clicks switch session',
        'rename/save and independent delete do not switch the active session',
        'native bridge refresh and repeated new-task actions reuse one blank task',
        'synthetic-origin-only network'
      ]
    }, null, 2));
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
})();
