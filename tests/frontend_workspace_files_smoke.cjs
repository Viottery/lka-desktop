// Real HTTP/browser transfers, synthetic sessions and bytes only.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = path.resolve(__dirname, '../app/web/pet');
const OUT = path.resolve(__dirname, '../.runtime/workspace-files-preview');
const remoteOrigin = 'http://phone-workbench.test:8780';
const requests = [], errors = [], unknown = [];
const stamp = '2026-10-08T00:00:00Z';
let workspace = 'C:/synthetic/workspace', hold = false, held = null, holdWorkspace = false, heldWorkspace = null;
const downloads = Buffer.from([0, 255, 127, 10, 13, 128, 33]);
const files = [{ name: '资料', path: '资料', type: 'directory' }, { name: '成果.zip', path: '成果.zip', type: 'file', size_bytes: downloads.length }];
const session = () => ({ session_id: 'transfer-existing', title: '跨终端合成任务', status: 'active', metadata: { explicit_workspace: true }, workspace: { path: workspace, platform: 'windows' }, created_at: stamp, updated_at: stamp });
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1'), p = u.pathname.replace(/^\/workbench(?=\/)/, '');
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  requests.push({ method: req.method, path: p, query: Object.fromEntries(u.searchParams), filename: decodeURIComponent(req.headers['x-filename'] || ''), body });
  const rel = decodeURIComponent(p.replace(/^\/desktop-pet(?=\/)/, '').slice(1)), file = path.resolve(ROOT, rel || 'chat.html');
  if (req.method === 'GET' && file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  if (p === '/agent/models') return json(res, { clients: [], default_client: '' });
  if (p === '/agent/ui-defaults') return json(res, { defaults: {} });
  if (p === '/agent/safety-reviews') return json(res, { reviews: [] });
  if (p === '/knowledge/file-types') return json(res, { file_types: [] });
  if (p === '/sessions/deleted') return json(res, { sessions: [] });
  if (p === '/sessions' && req.method === 'GET') return json(res, { sessions: [session()], next_offset: null });
  if (p === '/sessions' && req.method === 'POST') return json(res, { session: { ...session(), session_id: 'transfer-created', metadata: JSON.parse(body).metadata }, messages: [] }, 201);
  if (p === '/pet/session-workspace') { if (holdWorkspace) { heldWorkspace = res; return; } return json(res, { path: 'C:/synthetic/new-workspace' }); }
  if (p === '/sessions/transfer-existing') return json(res, { session: session(), messages: [{ role: 'user', content: '跨终端任务' }, { role: 'assistant', content: '合成历史回复' }] });
  if (/^\/sessions\/conv_[^/]+\/workspace$/.test(p)) return json(res, { detail: 'No backend session yet' }, 404);
  if (p === '/sessions/transfer-created') return json(res, { session: { ...session(), session_id: 'transfer-created' }, messages: [] });
  if (/^\/sessions\/transfer-(existing|created)\/workspace$/.test(p)) { workspace = JSON.parse(body.toString()).path; return json(res, { workspace: { path: workspace }, project_id: 'synthetic-project' }); }
  if (/^\/sessions\/transfer-(existing|created)\/files$/.test(p)) return json(res, { entries: u.searchParams.get('path') ? files.filter(f => f.path.startsWith('资料/')) : files.filter(f => !f.path.includes('/')), truncated: false });
  if (p === '/sessions/transfer-existing/file') return json(res, { detail: 'Unsupported preview' }, 415);
  if (p === '/pet/workspace-directories') {
    const location = u.searchParams.get('path') || workspace;
    return json(res, { path: location, parent: 'C:/synthetic', roots: [{ name: 'C:', path: 'C:/' }], directories: location.endsWith('chosen') ? [] : [{ name: 'chosen', path: 'C:/synthetic/chosen' }], next_offset: null });
  }
  if (/^\/pet\/workspace-files\/transfer-(existing|created)\/upload$/.test(p)) {
    if (hold) { held = res; return; }
    const name = decodeURIComponent(req.headers['x-filename']), dir = u.searchParams.get('path');
    const collision = files.some(f => f.path === (dir ? dir + '/' : '') + name);
    const filename = collision ? name.replace(/(\.[^.]*)?$/, ' (2)$1') : name;
    const filePath = (dir ? dir + '/' : '') + filename;
    files.push({ name: filename, path: filePath, type: 'file', size_bytes: body.length });
    return json(res, { filename, path: filePath, size_bytes: body.length, renamed: collision });
  }
  if (p === '/pet/workspace-files/transfer-existing/download') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': downloads.length, 'content-disposition': "attachment; filename*=UTF-8''%E6%88%90%E6%9E%9C.zip" });
    return res.end(downloads);
  }
  if (p === '/background/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(': synthetic\n\n'); }
  if (p === '/plugins/qq-reader/status') return json(res, { enabled: false, connection_state: 'disconnected' });
  if (p === '/plugins/qq-ui/status') return json(res, { enabled: false, ready: false, reading_paired: true });
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  unknown.push(req.method + ' ' + p); return json(res, { detail: 'Unmocked ' + p }, 404);
});
const within = async (page, selector) => {
  const value = await page.locator(selector).evaluate(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight }; });
  assert(value.x >= -1 && value.y >= -1 && value.right <= value.w + 1 && value.bottom <= value.h + 1, selector + ': ' + JSON.stringify(value));
};
(async () => {
  let browser;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
    await context.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.origin !== remoteOrigin) return route.abort();
      try {
        const response = await context.request.fetch(origin + u.pathname + u.search, { method: route.request().method(), headers: route.request().headers(), data: route.request().postDataBuffer() || undefined });
        await route.fulfill({ response });
      } catch (error) {
        // The cancel fixture intentionally closes its pending HTTP response.
        if (!u.pathname.endsWith('/upload')) throw error;
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(remoteOrigin + '/desktop-pet/mobile.html?session_id=transfer-existing');
    await page.locator('#messages').getByText('合成历史回复', { exact: true }).waitFor();
    await page.locator('#mobileNav [data-mobile-action=files]').click();
    await page.locator('#fileList .file-download-button').waitFor();
    assert.equal(await page.evaluate(() => window.LkaChatContext.get().backend), remoteOrigin + '/workbench');
    for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [844, 390]]) {
      await page.setViewportSize({ width, height });
      for (const selector of ['#fileChooseWorkspaceButton', '#fileUploadButton', '#fileList .file-download-button']) { await page.locator(selector).scrollIntoViewIfNeeded(); await within(page, selector); }
      const touch = await page.locator('#fileList .file-download-button').evaluate(n => ({ w: n.offsetWidth, h: n.offsetHeight }));
      assert(touch.w >= 44 && touch.h >= 44);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(OUT, 'files-' + width + '.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#fileChooseWorkspaceButton').click();
    await page.locator('#workspacePickerList').getByRole('button', { name: 'chosen' }).click();
    await page.waitForFunction(() => document.querySelector('#workspacePickerSelection').textContent === 'C:/synthetic/chosen');
    await within(page, '#workspacePickerUse'); await page.locator('#workspacePickerCancel').click();
    assert.equal(workspace, 'C:/synthetic/workspace', 'cancel keeps workspace');
    const payload = { name: '手机资料.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 3, 4]) };
    await page.locator('#workspaceUploadInput').setInputFiles(payload);
    await page.locator('#workspaceTransferList').getByText('已保存到电脑', { exact: false }).waitFor();
    await page.locator('#fileList .file-item').getByText('□  手机资料.bin', { exact: true }).waitFor();
    const uploaded = requests.find(r => r.path.endsWith('/upload'));
    assert.deepEqual(uploaded.body, payload.buffer); assert.equal(uploaded.query.workspace, workspace); assert.equal(uploaded.filename, payload.name);
    await page.locator('#workspaceUploadInput').setInputFiles(payload);
    await page.locator('#workspaceTransferList').getByText('已另存为 手机资料 (2).bin', { exact: false }).waitFor();
    await page.locator('#fileList .file-item').getByText('▸  资料', { exact: true }).click();
    await page.locator('#workspaceUploadInput').setInputFiles({ ...payload, name: '子目录.txt' });
    await page.locator('#fileList .file-item').getByText('□  子目录.txt', { exact: true }).waitFor();
    assert.equal(requests.filter(r => r.path.endsWith('/upload')).at(-1).query.path, '资料');
    await page.locator('#fileUpButton').click();
    const event = page.waitForEvent('download'); await page.getByRole('button', { name: '下载 成果.zip', exact: true }).click();
    const download = await event; assert.equal(download.suggestedFilename(), '成果.zip');
    const saved = path.join(OUT, 'download-fixture.zip'); await download.saveAs(saved); assert.deepEqual(fs.readFileSync(saved), downloads); fs.unlinkSync(saved);
    await page.getByRole('button', { name: '□ 成果.zip', exact: false }).click();
    await page.locator('#filePreview').getByText('仅支持 UTF-8', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '下载 成果.zip', exact: true }).isEnabled(), true, 'unsupported preview still downloadable');
    hold = true;
    await page.locator('#workspaceUploadInput').setInputFiles({ ...payload, name: '取消测试.bin' });
    await page.locator('#workspaceTransferList .running').waitFor();
    await page.locator('#workspaceTransferList .running').getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('#workspaceTransferList .canceled').waitFor();
    if (held) held.destroy(); hold = false;
    await page.locator('#workspaceTransferList .canceled').getByRole('button', { name: '重试', exact: true }).click();
    await page.locator('#fileList .file-item').getByText('□  取消测试.bin', { exact: true }).waitFor();
    await page.locator('#clearWorkspaceTransfersButton').click();
    assert.equal(await page.locator('#workspaceTransferPanel').isVisible(), false);
    await page.locator('#fileChooseWorkspaceButton').click();
    await page.locator('#workspacePickerList').getByRole('button', { name: 'chosen' }).click();
    await page.waitForFunction(() => document.querySelector('#workspacePickerSelection').textContent === 'C:/synthetic/chosen');
    await page.locator('#workspacePickerUse').click();
    await page.waitForFunction(() => document.querySelector('#workspacePicker').hidden);
    assert.equal(workspace, 'C:/synthetic/chosen');
    await page.locator('#fileWorkspaceLabel').getByText(workspace, { exact: true }).waitFor();
    const oversized = path.join(OUT, 'oversized-fixture.bin'), fd = fs.openSync(oversized, 'w'); fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); fs.closeSync(fd);
    const before = requests.filter(r => r.path.endsWith('/upload')).length;
    await page.locator('#workspaceUploadInput').setInputFiles(oversized);
    await page.locator('#workspaceTransferStatus').getByText('超过 64 MiB', { exact: false }).waitFor();
    assert.equal(requests.filter(r => r.path.endsWith('/upload')).length, before, 'oversize rejected before transfer'); fs.unlinkSync(oversized);
    await page.locator('#closeSettingsButton').click();
    await page.locator('#newQuickSessionButton').click();
    await page.locator('#questionInput').fill('保留下一条草稿');
    await page.locator('#mobileNav [data-mobile-action=files]').click();
    await page.locator('#workspaceUploadInput').setInputFiles({ ...payload, name: '新任务文件.bin' });
    await page.locator('#fileList .file-item').getByText('□  新任务文件.bin', { exact: true }).waitFor();
    assert.equal(requests.filter(r => r.path === '/sessions' && r.method === 'POST').length, 1, 'upload prepares a new session only when needed');
    assert.equal(requests.filter(r => r.path.endsWith('/upload')).at(-1).path, '/pet/workspace-files/transfer-created/upload');
    assert.equal(await page.locator('#questionInput').inputValue(), '保留下一条草稿', 'workspace upload preserves Agent draft');
    const desktop = await context.newPage(); desktop.on('pageerror', e => errors.push(e.message));
    await desktop.setViewportSize({ width: 1440, height: 1000 });
    await desktop.goto(remoteOrigin + '/desktop-pet/chat.html?mode=work&session_id=transfer-existing');
    await desktop.locator('#messages').getByText('合成历史回复', { exact: true }).waitFor();
    assert.equal(await desktop.evaluate(() => document.body.classList.contains('mobile-workbench')), false);
    await desktop.locator('#filesTabButton').click();
    await desktop.locator('#fileList .file-download-button').first().waitFor();
    await within(desktop, '#fileUploadButton'); await within(desktop, '#fileChooseWorkspaceButton');
    await desktop.locator('#workspaceUploadInput').setInputFiles({ ...payload, name: '桌面文件.bin' });
    await desktop.locator('#fileList .file-item').getByText('□  桌面文件.bin', { exact: true }).waitFor();
    await desktop.screenshot({ path: path.join(OUT, 'files-desktop.png') });
    await desktop.close();
    const beforeCreates = requests.filter(r => r.path === '/sessions' && r.method === 'POST').length;
    const beforeUploads = requests.filter(r => r.path.endsWith('/upload')).length;
    holdWorkspace = true;
    await page.locator('#closeSettingsButton').click();
    await page.locator('#newQuickSessionButton').click();
    await page.locator('#mobileNav [data-mobile-action=files]').click();
    await page.locator('#workspaceUploadInput').setInputFiles({ ...payload, name: '失效会话不保存.bin' });
    await page.waitForFunction(() => document.querySelector('#fileUploadButton').textContent === '准备目录…');
    await page.locator('#sessionList .session-open[data-session-id="transfer-existing"]').evaluate(n => n.click());
    await page.waitForFunction(() => window.LkaChatContext.get().sessionId === 'transfer-existing');
    assert(heldWorkspace, 'workspace preparation is held'); holdWorkspace = false; json(heldWorkspace, { path: 'C:/synthetic/new-workspace' }); heldWorkspace = null;
    await page.locator('#workspaceTransferStatus').getByText('会话已关闭或切换', { exact: false }).waitFor();
    assert.equal(requests.filter(r => r.path === '/sessions' && r.method === 'POST').length, beforeCreates, 'switch during preparation creates no stale backend session');
    assert.equal(requests.filter(r => r.path.endsWith('/upload')).length, beforeUploads, 'switch during preparation uploads no file');
    assert.equal(requests.some(r => r.path.startsWith('/agent/turn')), false, 'file transfers never launch Agent');
    assert.deepEqual(errors, []); assert.deepEqual(unknown, []);
    console.log(JSON.stringify({ ok: true, remoteFolderPicker: true, uploadBytes: true, collision: true, subdirectory: true, binaryDownload: true, cancelAndRetry: true, oversize: true, newTaskUpload: true, draftPreserved: true, desktopShared: true, stalePreparation: true, viewports: 4, requests: requests.length }));
  } finally { if (browser) await browser.close(); if (held) held.destroy(); if (heldWorkspace) heldWorkspace.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
