'use strict';
// Two-window storage/run-state regression. All HTTP is served by this synthetic
// fixture; it never reaches the configured backend or starts an Agent task.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const ROOT = path.resolve(__dirname, '../app/web/pet');
const CHROME = process.env.CHROME_PATH || '/tmp/lka-playwright-browsers/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell';
const SOURCE = process.env.FRONTEND_CHAT_SOURCE || path.join(ROOT, 'chat.js');
const hookMarker = '  window.addEventListener("storage", function (event) {';
const sessionsKey = 'agentic-rag-pet-chat-sessions-v4';
const activeKey = 'agentic-rag-pet-chat-active-session-v4';
const runGets = [], historyGets = [], errors = [];
const startedAt = Date.now();
let holdRunStatus = false;
const heldRunResponses = [];

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function makeSession(id, kind, title) {
  return {
    id, conversation_id: id, kind, title, title_is_custom: true,
    created_at: startedAt, updated_at: startedAt, workspace: '/synthetic/storage-sync',
    backendWorkspace: '/synthetic/storage-sync', project_id: '', backendHistoryVersion: 1,
    multiAgentRunId: id === 'sync-session' ? 'run-storage-sync' : '',
    runControlStatus: id === 'sync-session' ? 'queued' : '',
    timelineState: id === 'sync-session' ? 'running' : '', pauseRequested: false,
    messages: [
      { id: id + '-user', role: 'user', text: '合成问题', timestamp: startedAt },
      { id: id + '-assistant', role: 'assistant', text: '合成答复', timestamp: startedAt }
    ]
  };
}
const ordinary = makeSession('sync-session', 'ordinary', '合成运行会话');
const manager = makeSession('manager-progress', 'manager', '合成管理会话');
const backendSession = {
  session_id: ordinary.id, kind: 'ordinary', title: ordinary.title,
  created_at: new Date(startedAt).toISOString(), updated_at: new Date(startedAt).toISOString(),
  workspace: { path: ordinary.workspace }, metadata: { title_is_custom: true }
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;
  if (route === '/' || route === '/chat.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(ROOT, 'chat.html'), 'utf8'));
  }
  if (route === '/chat.js' || route === '/desktop-pet/chat.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    const source = fs.readFileSync(SOURCE, 'utf8');
    if (!source.includes(hookMarker)) throw new Error('chat.js storage listener marker not found');
    const testHooks = `  window.__lkaStorageSyncSmoke = {
    keepManagerLive: function (id, offset) {
      var session = getSessionById(id);
      if (!session) throw new Error("synthetic manager session missing");
      managerStreams[id] = { controller: { signal: { aborted: false } }, runId: "synthetic-manager-run" };
      session.updated_at = Number(session.updated_at) + offset;
      session.timelineEvents = [{ type: "tool_completed", message: "synthetic local manager progress " + offset, at: session.updated_at }];
    },
    clearManagerLive: function (id) { delete managerStreams[id]; },
    persist: persistSessions,
    refresh: refreshActiveRunState
  };\n`;
    return res.end(source.replace(hookMarker, testHooks + hookMarker));
  }
  const relative = decodeURIComponent(route.replace(/^\/(?:desktop-pet\/)?/, ''));
  const file = path.resolve(ROOT, relative);
  if (file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream', 'cache-control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }
  if (route === '/health') return json(res, 200, { status: 'ok' });
  if (route === '/agent/ui-defaults') return json(res, 200, { configured: false, defaults: {} });
  if (route === '/agent/models') return json(res, 200, { clients: [] });
  if (route === '/agent/safety-reviews') return json(res, 200, { reviews: [] });
  if (route === '/knowledge/file-types') return json(res, 200, { file_types: [] });
  if (route === '/sessions/deleted') return json(res, 200, { sessions: [] });
  if (route === '/sessions' && req.method === 'GET') {
    if (url.searchParams.get('limit') === '30') historyGets.push(Date.now());
    return json(res, 200, { sessions: [
      { session_id: ordinary.id, kind: 'ordinary', title: ordinary.title, updated_at: new Date(startedAt).toISOString(), created_at: new Date(startedAt).toISOString() },
      { session_id: manager.id, kind: 'manager', title: manager.title, updated_at: new Date(startedAt).toISOString(), created_at: new Date(startedAt).toISOString() }
    ] });
  }
  if (route === '/sessions/sync-session') return json(res, 200, { session: backendSession, messages: [] });
  if (route === '/pet/session-workspace') return json(res, 200, { path: ordinary.workspace });
  if (route.endsWith('/files')) return json(res, 200, { entries: [] });
  const runRoute = route.match(/^\/agent\/runs\/([^/]+)(?:\/(events|snapshot))?$/);
  if (runRoute) {
    const runId = decodeURIComponent(runRoute[1]);
    if (runRoute[2] === 'events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': synthetic stream held open\n\n');
      req.on('close', () => {});
      return;
    }
    if (runRoute[2] === 'snapshot') return json(res, 200, { run: { run_id: runId, status: 'running' }, children: [] });
    runGets.push(Date.now());
    if (holdRunStatus) {
      heldRunResponses.push(() => json(res, 200, { run_id: runId, status: 'running', pause_requested: false }));
      return;
    }
    return json(res, 200, { run_id: runId, status: 'running', pause_requested: false });
  }
  return json(res, 404, { detail: 'unmocked synthetic route: ' + route });
});
const wait = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('synthetic browser condition timed out');
};

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    await context.addInitScript(({ sessionsKey, activeKey, ordinary, manager }) => {
      window.__lkaStorageSyncWriteCount = 0;
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === sessionsKey) window.__lkaStorageSyncWriteCount += 1;
        return originalSetItem.call(this, key, value);
      };
      if (!localStorage.getItem(sessionsKey)) localStorage.setItem(sessionsKey, JSON.stringify([ordinary, manager]));
      if (!localStorage.getItem(activeKey)) localStorage.setItem(activeKey, ordinary.id);
    }, { sessionsKey, activeKey, ordinary, manager });
    const pages = [];
    for (let i = 0; i < 2; i += 1) {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/chat.html?mode=work&session_id=sync-session&backend=' + encodeURIComponent(origin));
      await page.locator('.session-item[data-session-id="sync-session"]').waitFor();
      pages.push(page);
    }
    await wait(() => runGets.length >= 2);
    // Hold the backend at a stable running status. Each page keeps its own live
    // manager object with a different local progress marker, matching the
    // managerStreams preservation branch in loadSessions(true).
    const getCountBeforeStableRefresh = runGets.length;
    const writesBeforeStableRefresh = await pages[0].evaluate(() => window.__lkaStorageSyncWriteCount || 0);
    await pages[0].evaluate(() => window.__lkaStorageSyncSmoke.refresh());
    await wait(() => runGets.length > getCountBeforeStableRefresh);
    await new Promise(resolve => setTimeout(resolve, 100));
    const writesAfterStableRefresh = await pages[0].evaluate(() => window.__lkaStorageSyncWriteCount || 0);

    await pages[0].evaluate(({ managerId }) => window.__lkaStorageSyncSmoke.keepManagerLive(managerId, 11), { managerId: manager.id });
    await pages[1].evaluate(({ managerId }) => window.__lkaStorageSyncSmoke.keepManagerLive(managerId, 29), { managerId: manager.id });
    const getCountBeforeFeedback = runGets.length;
    const historyBeforeManager = historyGets.length;
    const hoveredIdentity = await pages[1].evaluate(() => {
      window.__lkaStorageSyncStorageEvents = 0;
      window.addEventListener('storage', event => { if (event.key === 'agentic-rag-pet-chat-sessions-v4') window.__lkaStorageSyncStorageEvents += 1; });
      const card = document.querySelector('.session-item[data-session-id="sync-session"]');
      const rename = card.querySelector('.session-icon-action[aria-label^="重命名会话"]');
      const remove = card.querySelector('.session-icon-action[aria-label^="删除会话"]');
      window.__lkaStorageSyncCardBefore = card;
      window.__lkaStorageSyncRenameBefore = rename;
      window.__lkaStorageSyncDeleteBefore = remove;
      rename.focus();
      return { focused: document.activeElement === rename, opacity: getComputedStyle(card.querySelector('.session-actions')).opacity };
    });
    await pages[1].locator('.session-item[data-session-id="sync-session"] .session-icon-action[aria-label^="重命名会话"]').hover();
    await wait(async () => await pages[1].locator('.session-item[data-session-id="sync-session"] .session-actions').evaluate(node => getComputedStyle(node).opacity) === '1');
    const hoverReady = await pages[1].evaluate(() => ({
      focused: document.activeElement === window.__lkaStorageSyncRenameBefore,
      opacity: getComputedStyle(window.__lkaStorageSyncCardBefore.querySelector('.session-actions')).opacity
    }));
    await pages[0].evaluate(() => window.__lkaStorageSyncSmoke.persist());
    await new Promise(resolve => setTimeout(resolve, 900));
    const stormCount = runGets.length - getCountBeforeFeedback;
    const managerHistoryDelta = historyGets.length - historyBeforeManager;
    const hoverAfterManagerProgress = await pages[1].evaluate(() => {
      const card = document.querySelector('.session-item[data-session-id="sync-session"]');
      const rename = card.querySelector('.session-icon-action[aria-label^="重命名会话"]');
      const remove = card.querySelector('.session-icon-action[aria-label^="删除会话"]');
      return {
        storageEvents: window.__lkaStorageSyncStorageEvents,
        sameCard: card === window.__lkaStorageSyncCardBefore,
        sameRename: rename === window.__lkaStorageSyncRenameBefore,
        sameDelete: remove === window.__lkaStorageSyncDeleteBefore,
        focusPreserved: document.activeElement === window.__lkaStorageSyncRenameBefore,
        opacity: getComputedStyle(card.querySelector('.session-actions')).opacity
      };
    });
    await pages[1].locator('.session-item[data-session-id="sync-session"] .session-icon-action[aria-label^="重命名会话"]').click();
    const renameEditor = pages[1].locator('.session-item[data-session-id="sync-session"] .session-rename-input');
    await renameEditor.waitFor();
    await renameEditor.fill('编辑状态应保留');
    await renameEditor.evaluate(node => node.setSelectionRange(3, 3));
    const editorBeforeSync = await renameEditor.evaluate(node => {
      window.__lkaStorageSyncEditorBefore = node;
      return { focused: document.activeElement === node, caret: node.selectionStart };
    });
    const editorEventCount = await pages[1].evaluate(() => window.__lkaStorageSyncStorageEvents);
    await pages[0].evaluate(({ managerId }) => {
      window.__lkaStorageSyncSmoke.keepManagerLive(managerId, 7);
      window.__lkaStorageSyncSmoke.persist();
    }, { managerId: manager.id });
    await wait(async () => await pages[1].evaluate(count => window.__lkaStorageSyncStorageEvents > count, editorEventCount));
    const editorAfterSync = await renameEditor.evaluate(node => ({
      sameInput: node === window.__lkaStorageSyncEditorBefore,
      focused: document.activeElement === node,
      caret: node.selectionStart,
      value: node.value
    }));

    // A peer's ordinary run-state update still appears in the other window.
    holdRunStatus = true;
    await renameEditor.press('Escape');
    await pages[1].mouse.move(5, 5);
    await pages[0].evaluate(({ sessionsKey, sessionId }) => {
      const rows = JSON.parse(localStorage.getItem(sessionsKey));
      rows.find(row => row.id === sessionId).runControlStatus = 'waiting_confirmation';
      localStorage.setItem(sessionsKey, JSON.stringify(rows));
    }, { sessionsKey, sessionId: ordinary.id });
    await wait(async () => await pages[1].locator('.session-item[data-session-id="sync-session"] .session-time').evaluate(node => node.textContent.includes('待确认')), 2000);
    const syncedStatus = await pages[1].locator('.session-item[data-session-id="sync-session"] .session-time').evaluate(node => node.textContent);
    holdRunStatus = false;
    heldRunResponses.splice(0).forEach(release => release());
    await Promise.all(pages.map(page => page.evaluate(({ managerId }) => window.__lkaStorageSyncSmoke.clearManagerLive(managerId), { managerId: manager.id })));

    console.log(JSON.stringify({ source: SOURCE, stableSnapshotCacheWrites: writesAfterStableRefresh - writesBeforeStableRefresh, runStatusGetsFromManagerFeedback: stormCount, managerHistoryReloads: managerHistoryDelta, hoveredIdentity, hoverReady, hoverAfterManagerProgress, editorBeforeSync, editorAfterSync, syncedStatus }, null, 2));
    if (process.env.EXPECT_FEEDBACK === '1') {
      assert(stormCount >= 10, 'pre-fix fixture should reproduce stable-run manager-cache feedback; observed ' + stormCount);
      assert(managerHistoryDelta > 0, 'pre-fix manager timestamp should perturb history signature');
      assert(writesAfterStableRefresh > writesBeforeStableRefresh, 'pre-fix unchanged snapshot should repersist local cache');
    } else {
      assert(stormCount <= 6, 'fixed storage sync must keep run GET count bounded; observed ' + stormCount);
      assert.equal(managerHistoryDelta, 0, 'manager-only progress must not reload ordinary history');
      assert.equal(writesAfterStableRefresh, writesBeforeStableRefresh, 'unchanged run snapshot must not repersist session cache');
      assert(hoveredIdentity.focused && hoverReady.focused && hoverReady.opacity === '1', 'rename action becomes visible and remains focused on hover');
      assert(hoverAfterManagerProgress.storageEvents > 0, 'peer received manager progress storage update');
      assert(hoverAfterManagerProgress.sameCard && hoverAfterManagerProgress.sameRename && hoverAfterManagerProgress.sameDelete,
        'manager-only refresh keeps the hovered card and both actions in place');
      assert(hoverAfterManagerProgress.focusPreserved && hoverAfterManagerProgress.opacity === '1',
        'manager-only refresh preserves focus and visible hover actions');
      assert(editorBeforeSync.focused && editorBeforeSync.caret === 3, 'rename editor starts with its caret');
      assert(editorAfterSync.sameInput && editorAfterSync.focused && editorAfterSync.caret === 3
        && editorAfterSync.value === '编辑状态应保留', 'manager-only refresh preserves rename input, value, focus and caret');
    }
    assert.match(syncedStatus, /待确认/, 'peer run state remains visible through storage sync');
    assert.deepEqual(errors, []);
    console.log('PASS two-window storage sync: bounded run polling, manager history isolation, peer state rendering');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
