// Entirely synthetic fixture: no personal backend, credentials, models or services.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = process.env.FRONTEND_PET_ROOT || path.resolve(__dirname, '../app/web/pet');
const FALLBACK = process.env.FRONTEND_PET_FALLBACK || '/mnt/d/lka-desktop/app/web/pet';
const OUT = process.env.SMOKE_ARTIFACT_DIR || '/tmp/frontend-matters-redesign';
fs.mkdirSync(OUT, { recursive: true });
const requests = [], errors = [], rows = new Map(), journal = [], sessions = new Map();
let serial = 0, holdSync = false, waitingSync = [], forceConflict = null;
const stamp = new Date().toISOString();
function key(date) { return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); }
const today = key(new Date()), tomorrowDate = new Date(); tomorrowDate.setDate(tomorrowDate.getDate() + 1); const tomorrow = key(tomorrowDate);
function record(input) {
  const row = { matter_id: 'fixture_' + ++serial, title: '收集事项 ' + serial, summary: '', kind: 'task', status: 'open', priority: 'normal', due_at: null, scheduled_on: null, scheduled_start: null, scheduled_end: null, inbox: true, parent_matter_id: null, project_id: null, sections: [], section: '', sort_order: serial * 1024, source_links: [], tags: [], metadata: {}, revision: 1, created_at: stamp, updated_at: stamp, ...input };
  rows.set(row.matter_id, row); changed(row); return row;
}
function changed(row) { journal.push({ sequence: journal.length + 1, matter: structuredClone(row) }); }
for (let i = 0; i < 205; i++) record({ title: '收集事项 ' + i });
const xss = record({ title: '<img src=x onerror=alert(1)>', summary: '<script>window.bad=1</script>' });
const precise = record({ title: '精确截止事项', due_at: today + 'T18:30:22.123+08:00', scheduled_start: today + 'T09:00:22.123+08:00', scheduled_end: today + 'T09:07:29.623+08:00' });
const locked = record({ title: '来源保护事项', source_links: [{ source_type: 'message_history_message', source_id: 'synthetic-proof' }] });
const timed = record({ title: '日历定时事项', inbox: false, scheduled_start: today + 'T09:00:00+08:00', scheduled_end: today + 'T10:15:00+08:00', due_at: today + 'T18:30:00+08:00' });
const allDay = record({ title: '日历全天事项', inbox: false, scheduled_on: today });
const tray = record({ title: '日历待安排事项', due_at: today });
const internal = record({ title: '日历内部隐藏事项', visibility: 'internal', scheduled_on: today, due_at: today });
const userCount = () => [...rows.values()].filter(r => (r.visibility || 'user') === 'user').length;
function send(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__smoke-font') {
    const font = process.env.SMOKE_FONT_PATH || '/mnt/c/Windows/Fonts/msyh.ttc';
    if (!fs.existsSync(font)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'font/collection' }); return fs.createReadStream(font).pipe(res);
  }
  if (!url.pathname.startsWith('/mock/')) {
    const relative = decodeURIComponent(url.pathname === '/' ? '/matters.html' : url.pathname);
    const file = [ROOT, FALLBACK].map(root => path.resolve(root, '.' + relative)).find(file => [ROOT, FALLBACK].some(root => file.startsWith(path.resolve(root) + path.sep)) && fs.existsSync(file));
    if (!file) { res.writeHead(404); return res.end('missing'); }
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[path.extname(file)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  let raw = ''; req.on('data', data => raw += data); req.on('end', () => {
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch (_) { return send(res, 400, { detail: 'Invalid JSON' }); }
    const route = url.pathname.slice(5); requests.push({ path: route + url.search, method: req.method, body });
    if (route === '/matters/sync') {
      const respond = () => {
        const after = Number(url.searchParams.get('after') || 0), limit = Math.min(200, Number(url.searchParams.get('limit') || 200));
        // Feed returns full current records for each journal entry, matching the backend contract.
        const changes = journal.filter(change => change.sequence > after).slice(0, limit).map(change => ({ sequence: change.sequence, matter: rows.get(change.matter.matter_id) }));
        const cursor = changes.length ? changes[changes.length - 1].sequence : after;
        send(res, 200, { changes, cursor, has_more: journal.some(change => change.sequence > cursor) });
      };
      if (holdSync) waitingSync.push(respond); else respond(); return;
    }
    if (route === '/projects') return send(res, 200, { projects: [{ project_id: 'directory_demo', name: '目录示例', workspace_path: '/synthetic/demo', revision: 1 }], next_offset: null });
    if (route === '/matters' && req.method === 'POST') {
      if (body.parent_matter_id && body.project_id !== rows.get(body.parent_matter_id)?.project_id) return send(res, 422, { detail: 'child must explicitly inherit parent directory' });
      return send(res, 200, record(body));
    }
    if (route.startsWith('/matters/') && req.method === 'PATCH') {
      const row = rows.get(decodeURIComponent(route.slice('/matters/'.length))); if (!row) return send(res, 404, { detail: 'missing' });
      if (row.source_links.some(link => link.source_type === 'message_history_message')) return send(res, 403, { detail: 'source approval required' });
      if (forceConflict === row.matter_id) { forceConflict = null; row.title = '其他入口更新'; row.summary = '其他入口说明必须保留'; row.revision++; changed(row); return send(res, 409, { detail: 'revision conflict' }); }
      if (body.expected_revision !== row.revision) return send(res, 409, { detail: 'revision conflict' });
      const patch = { ...body }; delete patch.expected_revision;
      Object.assign(row, patch, { revision: row.revision + 1, updated_at: new Date().toISOString() }); changed(row); return send(res, 200, row);
    }
    // Minimal read-only startup fixtures for the existing workbench shell.
    if (route === '/health') return send(res, 200, { status: 'ok', service: 'local-knowledge-agent-os' });
    if (route === '/agent/models') return send(res, 200, { clients: [] });
    if (route === '/agent/ui-defaults') return send(res, 200, { configured: false, defaults: {} });
    if (route === '/managers/default' && req.method === 'POST') return send(res, 409, { detail: 'management_disabled' });
    if (route === '/sessions' && req.method === 'POST') {
      const session = { session_id: 'synthetic_session_' + (sessions.size + 1), title: body.title || '新会话', metadata: body.metadata || {}, workspace: null, created_at: stamp, updated_at: stamp };
      sessions.set(session.session_id, session); return send(res, 200, { session });
    }
    const sessionRoute = route.match(/^\/sessions\/([^/]+)(?:\/(files|workspace))?$/);
    if (sessionRoute && sessions.has(sessionRoute[1])) {
      const session = sessions.get(sessionRoute[1]);
      if (sessionRoute[2] === 'files') return send(res, 200, { entries: [], truncated: false });
      if (sessionRoute[2] === 'workspace') return send(res, 200, { project_id: null, workspace: session.workspace });
      if (req.method === 'PATCH') Object.assign(session, body);
      return send(res, 200, { session, messages: [] });
    }
    if (route === '/sessions' || route === '/sessions/deleted') return send(res, 200, { sessions: [] });
    if (route === '/memories') return send(res, 200, { memories: [] });
    return send(res, 200, {});
  });
});
function matterRequests() { return requests.filter(request => request.path.startsWith('/matters')); }
async function until(predicate, message) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.fail(message);
}
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port, backend = origin + '/mock';
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/tmp/lka-playwright-browsers/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Shanghai' });
    context.on('page', p => p.on('pageerror', error => errors.push(error.message)));
    const page = await context.newPage();
    page.on('dialog', dialog => { errors.push('Unexpected dialog: ' + dialog.message()); dialog.dismiss(); });
    async function fonts(p) { await p.addStyleTag({ content: '@font-face{font-family:SmokeChinese;src:url("' + origin + '/__smoke-font")}body,body *,.mw,.mw *{font-family:SmokeChinese,sans-serif!important}' }); await p.evaluate(() => document.fonts.ready); }
    async function nav(view) { await page.locator('[data-matter-view="' + view + '"]').click(); }
    async function openEditor(id) { await nav('all'); await page.locator('#matterSearch').fill(''); await page.locator('[data-matter-open="' + id + '"]').click(); await page.locator('#matterEditTitle').waitFor(); }
    async function closeEditor() { if (await page.locator('#matterEditorClose').isVisible()) await page.locator('#matterEditorClose').click(); }
    holdSync = true;
    await page.goto(origin + '/matters.html?backend=' + encodeURIComponent(backend));
    await until(() => waitingSync.length === 1, 'reference waits for initial matter sync');
    await page.evaluate(id => window.LkaMatters.openMatter(id), precise.matter_id);
    assert.equal(await page.locator('#matterEditor').isVisible(), false, 'reference does not select before its record loads');
    holdSync = false; waitingSync.splice(0).forEach(respond => respond());
    await page.locator('#matterEditTitle').waitFor();
    assert.equal(await page.locator('#matterEditTitle').inputValue(), precise.title, 'ordinary reference selects after paginated sync');
    await page.locator('#matterEditTitle').fill('引用事项未保存草稿');
    await page.evaluate(id => window.LkaMatters.openMatter(id), precise.matter_id);
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#matterEditTitle').inputValue(), '引用事项未保存草稿', 'reopening the same reference preserves its draft');
    await page.locator('#matterEditTitle').fill(precise.title);
    await closeEditor();
    await page.waitForFunction(() => document.querySelector('#matterCacheState')?.textContent.includes('已同步'));
    assert.equal(matterRequests().filter(r => r.path.startsWith('/matters/sync')).length, 2, 'complete bootstrap pages over 200 records');
    assert.equal(new URL('http://fixture' + matterRequests()[1].path).searchParams.get('after'), '200');
    await page.locator('#matterWorkspace').focus(); await page.keyboard.press('n'); await page.locator('#matterEditTitle').waitFor(); assert.equal(await page.locator('#matterEditTitle').inputValue(), '', 'N opens a new task draft'); await closeEditor();
    await nav('all'); assert.equal(await page.locator('.mw-row').count(), userCount(), 'all cached records rendered without 50 item truncation');
    assert.equal(await page.locator('#matterWorkspace img').count(), 0, 'untrusted titles escaped');
    assert.equal(await page.locator('[data-row="' + internal.matter_id + '"]').count(), 0, 'internal records stay out of all tasks');
    assert.equal(await page.evaluate(() => window.bad), undefined);
    await fonts(page); await page.screenshot({ path: path.join(OUT, 'all-tasks.png'), fullPage: false });
    let before = matterRequests().length;
    await page.evaluate(() => { window.LkaMatters.close(); window.LkaMatters.open(); });
    await page.waitForTimeout(100); assert.equal(matterRequests().length, before, 'fresh close/reopen makes zero requests');
    await page.reload(); await page.locator('.mw-row').first().waitFor(); await page.waitForTimeout(100);
    assert.equal(matterRequests().length, before, 'fresh page reload makes zero matter requests');
    assert.equal(await page.locator('.mw-row').count(), userCount());

    // Layout matrix: tools stay visible while the work area and detail pane scroll separately.
    for (const size of [{width:980,height:700},{width:1280,height:800},{width:1680,height:1050},{width:768,height:720},{width:480,height:850}]) {
      await page.setViewportSize(size); await nav('all'); await page.locator('#matterSearch').fill('');
      const headingBefore = await page.locator('.mw-heading').boundingBox();
      await page.locator('#matterContent').evaluate(node => { node.scrollTop = node.scrollHeight; });
      const headingAfter = await page.locator('.mw-heading').boundingBox(), addBox = await page.locator('#matterQuickForm').boundingBox();
      assert.equal(headingAfter.y, headingBefore.y, 'list scroll keeps heading fixed at ' + size.width);
      assert(addBox.y >= 0 && addBox.y + addBox.height < size.height, 'quick add stays visible at ' + size.width);
      await openEditor(precise.matter_id); await page.waitForFunction(() => document.getElementById('matterWorkspace').dataset.pane === 'editor');
      const mainBox = await page.locator('.mw-main').boundingBox(), editorBox = await page.locator('#matterEditor').boundingBox(), saveBox = await page.locator('#matterSave').boundingBox();
      assert(saveBox.y >= 0 && saveBox.y + saveBox.height <= size.height, 'save fits ' + size.width);
      if (size.width >= 900) assert(mainBox.x + mainBox.width <= editorBox.x + 1, 'detail pane never covers task list at ' + size.width);
      else { assert(await page.locator('.mw-pane-backdrop').isVisible(), 'narrow detail has a dismissible backdrop'); await page.locator('#matterEditorClose').focus(); await page.keyboard.press('Shift+Tab'); assert(await page.evaluate(()=>document.getElementById('matterEditor').contains(document.activeElement)), 'drawer keyboard focus stays inside'); }
      if (size.width === 980) { assert.equal(await page.locator('#matterWorkspace').getAttribute('data-nav'), 'rail'); await fonts(page); await page.screenshot({path:path.join(OUT,'split-980.png')}); }
      await closeEditor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow at ' + size.width);
    }
    await page.setViewportSize({width:980,height:700}); await nav('calendar'); await page.locator('[data-mc-mode="week"]').click();
    await page.waitForFunction(() => document.querySelector('.mc-week-scroll')?.clientHeight > 0);
    const weekFits = await page.locator('.mc-week-scroll').evaluate(n => ({width:n.clientWidth,scroll:n.scrollWidth,height:n.clientHeight,top:n.scrollTop}));
    assert(weekFits.scroll <= weekFits.width + 1, 'all seven days fit a 980px window');
    assert(weekFits.top > 0, 'week opens near working hours');
    await fonts(page); await page.screenshot({path:path.join(OUT,'week-980.png')});
    await page.locator('[data-mc-mode="month"]').click();
    const monthFits = await page.locator('.mc-month-scroll').evaluate(n=>({height:n.clientHeight,scroll:n.scrollHeight}));
    assert(monthFits.scroll <= monthFits.height + 2, 'whole month fits default window height');
    const todayCell = await page.locator('.mc-month .mc-today').boundingBox(), overflowLink = await page.locator('.mc-month .mc-today .mc-overflow>summary').boundingBox(); assert(overflowLink && overflowLink.y + overflowLink.height <= todayCell.y + todayCell.height, 'dense-date more link stays visible without cell scrolling');
    await page.screenshot({path:path.join(OUT,'month-980.png')});
    await page.setViewportSize({width:1440,height:950}); await nav('all'); await page.locator('#matterToggleNav').click();
    assert.equal(await page.locator('#matterWorkspace').getAttribute('data-nav'),'rail','manual collapse works');
    const layoutRequests = matterRequests().length; await page.reload(); await page.locator('.mw-row').first().waitFor();
    assert.equal(await page.locator('#matterWorkspace').getAttribute('data-nav'),'rail','navigation preference survives reload');
    assert.equal(matterRequests().length,layoutRequests,'layout preferences do not force network requests');
    await page.locator('#matterToggleNav').click(); assert.equal(await page.locator('#matterWorkspace').getAttribute('data-nav'),'full','manual expansion works');
    await page.setViewportSize({width:1440,height:950}); await nav('all');

    // A stale reopen paints existing records before the delayed refresh completes.
    await page.evaluate(() => { const cache = Object.keys(localStorage).find(key => key.startsWith('lka.matters.v2:') && !key.endsWith(':view')); const value = JSON.parse(localStorage.getItem(cache)); value.updatedAt = Date.now() - 61000; localStorage.setItem(cache, JSON.stringify(value)); });
    holdSync = true; await page.reload(); await page.locator('.mw-row').first().waitFor();
    await until(() => waitingSync.length > 0, 'stale cache refresh started');
    assert.equal(await page.locator('.mw-row').count(), userCount(), 'stale content remains visible during background sync');
    holdSync = false; waitingSync.splice(0).forEach(respond => respond());
    await page.waitForFunction(() => document.getElementById('matterCacheState').textContent.includes('已同步'));

    // Row scheduling and undo must be usable without opening the editor.
    await nav('all');
    const dateRow = page.locator('[data-row="' + tray.matter_id + '"]');
    await dateRow.hover(); await dateRow.locator('[data-row-date]').click();
    await page.locator('.mw-date-popover [data-date-choice="' + tomorrow + '"]').click();
    await until(() => tray.scheduled_on === tomorrow, 'row date menu persists schedule');
    assert.equal(tray.due_at, today, 'row date menu never edits deadline');
    await page.locator('#matterUndo').click(); await until(() => tray.scheduled_on === null, 'schedule undo restores original arrangement');
    await page.waitForFunction(() => document.getElementById('matterStatus').textContent === '已撤销修改。'); await page.locator('[data-row]').first().scrollIntoViewIfNeeded(); const denseRow = await page.locator('[data-row]').first().boundingBox(); assert(denseRow.height <= 50,'desktop task rows remain compact');

    // Parsing schedules a single timed block and leaves the deadline unset.
    await page.locator('#matterQuickTitle').fill('明天 15:00 整理研究资料 45分钟');
    assert.match(await page.locator('#matterParseHint').textContent(), /15:00，45分钟/);
    await page.locator('#matterQuickTitle').press('Enter');
    await until(() => [...rows.values()].some(r => r.title === '整理研究资料'), 'natural date task created');
    const quick = [...rows.values()].find(r => r.title === '整理研究资料');
    assert.equal(quick.due_at, null); assert.equal(quick.scheduled_on, tomorrow);
    assert.equal(new Date(quick.scheduled_end) - new Date(quick.scheduled_start), 45 * 60000);
    assert.match(quick.scheduled_start, /T07:00:00/);
    await page.locator('#matterQuickTitle').fill('<img src=x onerror=alert(2)>'); await page.locator('#matterQuickTitle').press('Enter');
    await until(() => [...rows.values()].some(r => r.title.includes('alert(2)')), 'escaped quick title created');
    assert.equal(await page.locator('#matterWorkspace img').count(), 0);

    // An unrelated edit must preserve the exact original deadline, including seconds and offset.
    const exactDeadline = precise.due_at, exactStart = precise.scheduled_start, exactEnd = precise.scheduled_end;
    await openEditor(precise.matter_id); await page.locator('#matterEditTitle').fill('精确截止事项 已编辑'); await page.locator('#matterSave').click();
    await until(() => precise.title.endsWith('已编辑'), 'precise record saved'); assert.equal(precise.due_at, exactDeadline); assert.equal(precise.scheduled_start, exactStart); assert.equal(precise.scheduled_end, exactEnd); assert.equal(new Date(precise.scheduled_end) - new Date(precise.scheduled_start), 7.125 * 60000, 'title-only edit preserves fractional duration and timestamp precision');
    await openEditor(precise.matter_id); await page.locator('#matterEditDue').fill(tomorrow); await page.locator('#matterSave').click();
    await until(() => precise.due_at === tomorrow, 'deadline changed deliberately');
    await openEditor(precise.matter_id); await page.locator('#matterEditDue').fill(''); await page.locator('#matterSave').click();
    await until(() => precise.due_at === null, 'deadline explicitly cleared');
    await openEditor(precise.matter_id); await page.locator('#matterEditTitle').fill('冲突草稿必须保留'); forceConflict = precise.matter_id; await page.locator('#matterSave').click();
    await page.locator('#matterEditorConflict').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#matterEditTitle').inputValue(), '冲突草稿必须保留');
    await page.locator('#matterRebase').click(); await page.locator('#matterLatest').filter({ hasText: '其他入口更新' }).waitFor();
    assert.equal(await page.locator('#matterEditTitle').inputValue(), '冲突草稿必须保留');
    assert.equal(await page.locator('#matterEditSummary').inputValue(), '其他入口说明必须保留', 'rebase merges unchanged remote fields into the retained draft');
    await page.locator('#matterSave').click(); await until(() => precise.title === '冲突草稿必须保留', 'rebased draft saved'); assert.equal(precise.summary, '其他入口说明必须保留');

    await openEditor(locked.matter_id); assert(await page.locator('#matterEditTitle').isDisabled());
    assert(await page.locator('[data-complete="' + locked.matter_id + '"]').isDisabled()); await closeEditor();
    await page.locator('[data-complete="' + precise.matter_id + '"]').click(); await until(() => precise.status === 'done', 'task completion persisted');
    await nav('history'); await page.locator('[data-complete="' + precise.matter_id + '"]').click(); await until(() => precise.status === 'open', 'completed task reopened');

    await nav('projects'); await page.locator('#matterNewPlan').click();
    await page.locator('#matterEditTitle').fill('独立学习规划'); await page.locator('#matterEditSummary').fill('完成一门课，并写出可验证的作品');
    await page.locator('#matterEditSections').fill('准备\n实践'); await page.locator('#matterSave').click();
    await until(() => [...rows.values()].some(r => r.title === '独立学习规划'), 'independent plan created');
    const plan = [...rows.values()].find(r => r.title === '独立学习规划');
    assert.equal(plan.kind, 'plan'); assert.equal(plan.project_id, null); assert.deepEqual(plan.sections, ['准备', '实践']);
    // Link this formerly independent plan, then require its quick action to inherit explicitly.
    await page.locator('[data-matter-open="' + plan.matter_id + '"]').click();
    await page.locator('#matterEditProject option[value="directory_demo"]').waitFor({ state: 'attached' });
    await page.locator('#matterEditProject').selectOption('directory_demo'); await page.locator('#matterSave').click();
    await until(() => plan.project_id === 'directory_demo', 'plan linked to directory'); await page.locator('#matterEditor').waitFor({ state: 'hidden' });
    await page.locator('#matterAddSection').click(); await page.locator('#matterSectionForm input').fill('复盘'); await page.locator('#matterSectionForm button').first().click();
    await until(() => plan.sections.includes('复盘'), 'inline section added');
    await page.locator('[data-add-to-section="复盘"]').click(); await page.locator('#matterEditTitle').fill('回顾本周学习');
    await page.locator('#matterEditTitle').press('Control+Enter');
    await until(() => [...rows.values()].some(r => r.title === '回顾本周学习' && r.section === '复盘' && r.parent_matter_id === plan.matter_id), 'stage action inherits chosen stage and parent');
    const extra = [...rows.values()].find(r => r.title === '回顾本周学习');
    await page.locator('[data-complete="' + extra.matter_id + '"]').click(); await until(() => extra.status === 'done', 'stage action completes');
    await page.locator('#matterUndo').click(); await until(() => extra.status === 'open', 'complete undo restores task');
    await page.locator('[data-complete="' + extra.matter_id + '"]').click(); await until(() => extra.status === 'done', 'stage action complete after undo');
    await page.locator('#matterQuickTitle').fill('完成第一份实践'); await page.locator('#matterQuickTitle').press('Enter');
    await until(() => [...rows.values()].some(r => r.title === '完成第一份实践'), 'plan action created');
    const action = [...rows.values()].find(r => r.title === '完成第一份实践'); assert.equal(action.parent_matter_id, plan.matter_id); assert.equal(action.project_id, plan.project_id, 'linked-plan quick action explicitly inherits directory');
    await page.locator('[data-matter-open="' + action.matter_id + '"]').click(); await page.locator('.mw-more-properties summary').click(); await page.locator('#matterEditSection').selectOption('实践'); await page.locator('#matterSave').click();
    await until(() => action.section === '实践', 'action stage persisted');
    await page.locator('[data-section="实践"] [data-row="' + action.matter_id + '"]').waitFor();
    assert.equal(await page.locator('[data-section="实践"] [data-row="' + action.matter_id + '"]').count(), 1);
    await page.locator('[data-complete="' + action.matter_id + '"]').click(); await until(() => action.status === 'done', 'plan action complete');
    await page.waitForFunction(() => document.querySelector('.mw-plan-summary').textContent.includes('2 / 2 已完成'));
    await fonts(page); await page.screenshot({ path: path.join(OUT, 'plan.png') });

    await nav('calendar'); await page.locator('#matterSearch').fill('日历');
    assert.equal(await page.locator('[data-mc-id="' + internal.matter_id + '"]').count(), 0, 'internal records stay out of calendar'); await page.locator('[data-mc-mode="week"]').click();
    assert.equal(await page.locator('.mc-week .mc-day').count(), 7);
    assert.equal(await page.locator('.mc-week .mc-hour').count(), 168);
    assert.equal(await page.locator('.mc-deadline[data-mc-id="' + tray.matter_id + '"]').count(), 1, 'deadline-only task has distinct reminder');
    assert.equal(await page.locator('.mc-hours [data-mc-id="' + tray.matter_id + '"]').count(), 0, 'deadline does not imply timed schedule');
    const dueBeforeMove = timed.due_at;
    async function drop(id, targetSelector) {
      // Wait for each previous mutation's rendered acknowledgement before starting another drag.
      await page.locator('#matterStatus').evaluate(node => { node.textContent = ''; });
      await page.evaluate(({ id, targetSelector }) => {
        const source = document.querySelector('[data-mc-id="' + id + '"][draggable="true"]'), target = document.querySelector(targetSelector), transfer = new DataTransfer();
        if (!source || !target) throw Error('missing synthetic drag target');
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }, { id, targetSelector });
      await page.waitForFunction(() => document.getElementById('matterStatus').textContent.startsWith('已更新「'));
    }
    await drop(timed.matter_id, '[data-mc-drop-day="' + today + '"][data-mc-drop-time="11:00"]');
    await until(() => new Date(timed.scheduled_start).toISOString().includes('T03:00:00'), 'timed drag changed slot');
    assert.equal(new Date(timed.scheduled_end) - new Date(timed.scheduled_start), 75 * 60000); assert.equal(timed.due_at, dueBeforeMove);
    await drop(tray.matter_id, '[data-mc-drop-day="' + today + '"][data-mc-drop-time="14:00"]');
    await until(() => !!tray.scheduled_start, 'tray task scheduled');
    assert.equal(new Date(tray.scheduled_end) - new Date(tray.scheduled_start), 30 * 60000);
    await drop(timed.matter_id, '[data-mc-drop-day="' + today + '"][data-mc-drop-time="all"]');
    await until(() => timed.scheduled_on === today && timed.scheduled_start === null, 'timed to all-day clears timed fields'); assert.equal(timed.scheduled_end, null); assert.equal(timed.due_at, dueBeforeMove);
    await drop(timed.matter_id, '[data-mc-unschedule]'); await until(() => timed.scheduled_on === null, 'unschedule retains task');
    assert.equal(timed.scheduled_start, null); assert.equal(timed.scheduled_end, null); assert(rows.has(timed.matter_id)); assert.equal(timed.due_at, dueBeforeMove);
    await page.locator('[data-mc-mode="month"]').click(); assert.equal(await page.locator('.mc-month>.mc-day').count(), 42);
    await fonts(page); await page.screenshot({ path: path.join(OUT, 'calendar-month.png') });
    await page.locator('[data-mc-mode="agenda"]').click(); assert.equal(await page.locator('.mc-agenda-day').count(), 14);
    await page.locator('.mc-schedule-editor summary').click();
    await page.locator('[data-mc-form] select[name="matter"]').selectOption(timed.matter_id);
    await page.locator('[data-mc-form] input[name="allDay"]').uncheck(); await page.locator('[data-mc-form] input[name="date"]').fill(today); await page.locator('[data-mc-form] input[name="time"]').fill('16:00');
    await page.locator('[data-mc-duration="15"]').click(); assert.equal(await page.locator('[data-mc-form] input[name="duration"]').inputValue(), '45');
    await page.locator('[data-mc-form] button[type="submit"]').click(); await until(() => !!timed.scheduled_start, 'keyboard schedule form persisted'); assert.equal(new Date(timed.scheduled_end) - new Date(timed.scheduled_start), 45 * 60000);

    // A second same-origin window consumes the same complete cache and sees writes via broadcast.
    before = matterRequests().length;
    const second = await context.newPage(); await second.goto(origin + '/matters.html?backend=' + encodeURIComponent(backend)); await second.locator('#matterWorkspace').waitFor(); await second.waitForTimeout(100);
    assert.equal(matterRequests().length, before, 'independent window reuses fresh cache without request');
    await second.locator('[data-matter-view="all"]').click(); await second.locator('#matterSearch').fill('');
    await second.locator('[data-matter-open="' + precise.matter_id + '"]').click(); await second.locator('#matterEditTitle').fill('另一窗口更新'); await second.locator('#matterSave').click();
    await until(() => precise.title === '另一窗口更新', 'second window saved');
    await nav('all'); await page.locator('#matterSearch').fill('另一窗口更新'); await page.locator('[data-matter-open="' + precise.matter_id + '"]').waitFor();
    await second.close();

    // Existing workbench entry consumes the same cache; quick chat opens a separate window.
    const work = await context.newPage();
    await work.goto(origin + '/chat.html?mode=work&backend=' + encodeURIComponent(backend));
    await work.waitForFunction(() => !!window.LkaMatters);
    await work.locator('#questionInput').fill('原会话未发送的草稿');
    before = matterRequests().length;
    await work.locator('#openMattersSidebarButton').click(); await work.locator('#matterWorkspace').waitFor();
    await work.waitForTimeout(100); assert.equal(matterRequests().length, before, 'workbench entry reuses the shared fresh cache');
    await fonts(work); await work.screenshot({ path: path.join(OUT, 'workbench-tasks.png') });
    const originalConversation = await work.evaluate(() => window.LkaChatContext.get().sessionId);
    const sessionCreatesBefore = requests.filter(r => r.path === '/sessions' && r.method === 'POST').length;
    await work.locator('#matterAsk').click();
    await work.waitForFunction(() => document.querySelector('#matterAssistantBody iframe')?.contentDocument?.getElementById('questionInput')?.value.includes('我的要求：'));
    const assistantFrame = work.frames().find(frame => new URL(frame.url()).searchParams.get('embedded') === 'matter');
    assert(assistantFrame, 'real chat assistant iframe loaded');
    assert.equal(requests.filter(r => r.path === '/sessions' && r.method === 'POST').length, sessionCreatesBefore + 1, 'assistant creates an independent session');
    const assistantSession = await assistantFrame.evaluate(() => window.LkaChatContext.get().sessionId);
    assert.notEqual(assistantSession, originalConversation);
    assert.equal(await work.evaluate(() => window.LkaChatContext.get().sessionId), originalConversation, 'assistant never switches the original conversation');
    assert.equal(await work.locator('#questionInput').inputValue(), '原会话未发送的草稿');
    assert.equal(requests.filter(r => r.method === 'POST' && /\/agent\//.test(r.path)).length, 0, 'opening assistant prepares an editable draft without starting a model turn');
    await fonts(assistantFrame); await work.screenshot({ path: path.join(OUT, 'assistant.png') });
    const completionSyncBefore = matterRequests().filter(r => r.path.startsWith('/matters/sync')).length;
    await assistantFrame.evaluate(sessionId => window.dispatchEvent(new CustomEvent('lka-agent-turn-finished', { detail: { sessionId } })), assistantSession);
    await until(() => matterRequests().filter(r => r.path.startsWith('/matters/sync')).length === completionSyncBefore + 1, 'assistant completion invalidates and refreshes cache once');
    await work.waitForFunction(() => document.getElementById('matterCacheState').textContent.includes('已同步'));
    assert.equal(matterRequests().filter(r => r.path.startsWith('/matters/sync')).length, completionSyncBefore + 1);
    await work.locator('#matterAssistantClose').click();
    await work.locator('#matterBack').click();
    assert.equal(await work.locator('#questionInput').inputValue(), '原会话未发送的草稿', 'opening and closing tasks preserves the conversation draft');
    assert.equal(await work.locator('#matterWorkspace').isVisible(), false);
    await work.close();
    const quickPage = await context.newPage();
    await quickPage.goto(origin + '/chat.html?mode=quick&backend=' + encodeURIComponent(backend));
    await quickPage.waitForFunction(() => !!window.LkaMatters);
    before = matterRequests().length;
    const popupPromise = quickPage.waitForEvent('popup'); await quickPage.locator('#openMattersButton').click(); const popup = await popupPromise;
    await popup.locator('#matterWorkspace').waitFor(); await popup.waitForTimeout(100);
    assert.match(popup.url(), /matters\.html/);
    assert.equal(await quickPage.locator('#matterWorkspace').isVisible(), false, 'quick entry keeps tasks in an independent window');
    assert.equal(matterRequests().length, before, 'quick independent window reuses fresh cache');
    await popup.close();
    await quickPage.evaluate(id => {
      const ref = document.createElement('button'); ref.className = 'matter-ref'; ref.dataset.matterId = id; ref.textContent = '打开引用事项';
      ref.style.cssText = 'position:fixed;top:0;left:0;z-index:9999'; document.body.appendChild(ref);
    }, precise.matter_id);
    const referencePopupPromise = quickPage.waitForEvent('popup');
    await quickPage.locator('.matter-ref').click();
    const referencePopup = await referencePopupPromise;
    await referencePopup.locator('#matterEditTitle').waitFor();
    assert.equal(new URL(referencePopup.url()).searchParams.get('matter_id'), precise.matter_id, 'quick fallback carries the referenced id');
    assert.equal(await referencePopup.locator('#matterEditTitle').inputValue(), rows.get(precise.matter_id).title, 'quick fallback window selects the referenced record');
    assert.equal(await quickPage.locator('#matterWorkspace').isVisible(), false, 'quick reference stays in the independent window');
    await referencePopup.close();
    const nativeOptions = await quickPage.evaluate(id => {
      const previous = window.petBridge;
      let options;
      window.petBridge = { openMatters(value) { options = JSON.parse(value); } };
      try { window.LkaMatters.openMatter(id); } finally { window.petBridge = previous; }
      return options;
    }, precise.matter_id);
    assert.deepEqual(nativeOptions, { view: 'all', matterId: precise.matter_id }, 'quick native bridge carries the referenced id');
    // PetMatterWindow applies these options by calling LkaMatters.open in its retained page.
    await page.evaluate(options => window.LkaMatters.open(options), nativeOptions);
    await page.locator('#matterEditTitle').waitFor();
    assert.equal(await page.locator('#matterEditTitle').inputValue(), rows.get(precise.matter_id).title, 'native receiving page consumes the reference options');
    await closeEditor(); await quickPage.close();

    await page.setViewportSize({ width: 480, height: 850 }); await page.locator('#matterSearch').fill('');
    await fonts(page); await page.screenshot({ path: path.join(OUT, 'mobile-list.png') });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '480px list has no horizontal page overflow');
    await page.locator('[data-matter-open="' + precise.matter_id + '"]').click();
    await page.screenshot({ path: path.join(OUT, 'mobile-editor.png') });
    await page.locator('#matterEditor fieldset').evaluate(n => { n.scrollTop = n.scrollHeight; });
    const footerBox = await page.locator('#matterSave').boundingBox(); assert(footerBox.y >= 0 && footerBox.y + footerBox.height <= 850, 'save stays in mobile viewport while properties scroll');
    const box = await page.locator('#matterEditor').boundingBox(); assert(box.x >= 0 && box.x + box.width <= 481, 'mobile editor stays inside viewport');
    await closeEditor(); await nav('calendar'); await page.locator('[data-mc-mode="week"]').click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '480px week scrolls internally without page overflow');
    await page.screenshot({ path: path.join(OUT, 'mobile-calendar.png') });
    assert.deepEqual(errors, [], 'no browser runtime errors or XSS dialogs');
    console.log('PASS matters redesign: complete paginated cache, zero-request reopen/reload, stale background, parsing, deadline fidelity, CAS drafts, plans/stages, protection, calendar scheduling, cross-window broadcast, workbench/quick entries, real assistant iframe isolation/draft/completion, mobile. ' + requests.length + ' synthetic requests.');
  } finally {
    holdSync = false; waitingSync.splice(0).forEach(respond => respond());
    if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
