// Synthetic binary upload + turn regression. Never connects to a real backend/QQ.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = path.resolve(__dirname, '../app/web/pet');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
const records = new Map(), images = new Map(), attachmentMetadata = new Map(), turns = [], uploads = [], errors = [];
let rejectUploads = false, heldTurn, heldResolve;
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let pathname = url.pathname.replace(/^\/workbench(?=\/)/, '');
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const body = () => JSON.parse(raw.toString() || '{}');
  if (pathname === '/chat.html' || pathname === '/desktop-pet/chat.html') {
    let html = fs.readFileSync(path.join(ROOT, 'chat.html'), 'utf8').replace(/<script src="\.\/(memory|projects|qq-reader|message-ui-api|message-content|message-names|message-history|message-reading|messages-center)\.js[^>]*><\/script>/g, '');
    res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); return res.end(html);
  }
  const file = path.resolve(ROOT, pathname.replace(/^\/desktop-pet(?=\/)/, '').slice(1));
  if (file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' }); return fs.createReadStream(file).pipe(res);
  }
  if (pathname === '/knowledge/file-types') return json(res, 200, { file_types: [{ extensions: ['.txt', '.text', '.md', '.pdf', '.html', '.docx'], index_supported: true }] });
  if (pathname === '/agent/models') return json(res, 200, { clients: [] });
  if (pathname === '/agent/ui-defaults') return json(res, 200, { configured: false, defaults: {} });
  if (pathname === '/agent/safety-reviews') return json(res, 200, { reviews: [] });
  if (pathname === '/sessions/deleted') return json(res, 200, { sessions: [] });
  if (pathname === '/sessions' && req.method === 'GET') return json(res, 200, { sessions: [...records.values()].map(r => r.session) });
  if (pathname === '/sessions' && req.method === 'POST') {
    const sid = 'synthetic-' + records.size;
    records.set(sid, { session: { session_id: sid, title: body().title || '合成会话', metadata: {}, workspace: { path: 'C:/synthetic/images' } }, messages: [] });
    return json(res, 201, records.get(sid));
  }
  if (pathname === '/pet/session-workspace') return json(res, 200, { path: 'C:/synthetic/images' });
  if (pathname === '/pet/composer-files') return json(res, 200, { cache_id: 'f'.repeat(32), filename: decodeURIComponent(req.headers['x-filename']), size_bytes: raw.length, status: 'cached', agent_ready: false });
  const workspace = pathname.match(/^\/sessions\/([^/]+)\/workspace$/);
  if (workspace) return json(res, records.has(workspace[1]) ? 200 : 404, { project_id: '' });
  const attachment = pathname.match(/^\/sessions\/([^/]+)\/attachments(?:\/([^/]+)(\/raw)?)?$/);
  if (attachment && req.method === 'POST') {
    uploads.push({ path: pathname, raw, filename: decodeURIComponent(req.headers['x-filename']), type: req.headers['content-type'] });
    if (rejectUploads) return json(res, 503, { detail: 'synthetic_upload_failure' });
    const aid = 'att_' + (uploads.length.toString(16)).padStart(32, '0');
    images.set(aid, raw);
    const filename = decodeURIComponent(req.headers['x-filename']);
    const document = !req.headers['content-type'].startsWith('image/');
    const metadata = { attachment_id: aid, kind: document ? 'document' : 'image', filename, media_type: document ? 'text/plain' : req.headers['content-type'], size_bytes: raw.length,
      ...(document ? { total_chars: raw.length, extraction: { warnings: filename.endsWith('.pdf') ? ['Text layer only; no OCR'] : [] } } : { width: 1, height: 1 }) };
    attachmentMetadata.set(aid, metadata);
    return json(res, 200, metadata);
  }
  if (attachment && attachment[3]) { const meta = attachmentMetadata.get(attachment[2]); res.writeHead(200, { 'content-type': meta?.media_type || 'image/png', ...(meta?.kind === 'document' ? { 'content-disposition': 'attachment; filename=' + encodeURIComponent(meta.filename) } : {}) }); return res.end(images.get(attachment[2]) || PNG); }
  if (attachment && attachment[2]) return json(res, 200, attachmentMetadata.get(attachment[2]));
  const session = pathname.match(/^\/sessions\/([^/]+)$/);
  if (session) return json(res, records.has(session[1]) ? 200 : 404, records.get(session[1]) || {});
  if (pathname === '/agent/turn/stream' || pathname === '/agent/turn') {
    const payload = body(); turns.push(payload);
    const record = records.get(payload.session_id);
    record.messages.push({ role: 'user', content: payload.user_input || (payload.attachment_ids.some(id => attachmentMetadata.get(id)?.kind === 'document') ? '[File input]' : '[Image input]'), payload: { attachment_ids: payload.attachment_ids } });
    if (heldTurn) await new Promise(resolve => { heldResolve = resolve; });
    record.messages.push({ role: 'assistant', content: '**合成图像回复**', payload: {} });
    if (pathname.endsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end('event: final_answer\ndata: {"payload":{"metadata":{"answer":"**合成图像回复**"}}}\n\nevent: run_completed\ndata: {}\n\n');
    }
    return json(res, 200, { session_id: payload.session_id, answer: '**合成图像回复**' });
  }
  return json(res, 404, { detail: 'not_mocked' });
});
async function paste(page, name = '合成截图.png') {
  return page.evaluate(({ bytes, name }) => {
    const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], name, { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.getElementById('questionInput').dispatchEvent(event); return event.defaultPrevented;
  }, { bytes: PNG.toString('base64'), name });
}
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox'] });
    for (const surface of ['work', 'mobile', 'quick', 'native']) {
      const context = await browser.newContext({ viewport: surface === 'mobile' ? { width: 390, height: 844 } : { width: surface === 'work' ? 1440 : 410, height: 760 } });
      const page = await context.newPage();
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(origin + '/chat.html?' + (surface === 'mobile' ? 'mode=work&layout=mobile' : surface === 'work' ? 'mode=work' : 'mode=pet') + '&backend=' + encodeURIComponent(origin));
      await page.waitForFunction(() => window.LkaChatContext && window.LkaImageComposer);
      if (surface === 'native') await page.evaluate(() => { document.body.classList.add('native-composer'); window.petBridge = {}; });
      assert.equal(await paste(page), true, 'image paste is intercepted');
      // Immediate submit must wait for decoder and upload, not silently drop pixels.
      const count = turns.length;
      assert.equal(await page.evaluate(() => window.__petChatSubmitText('')), true, 'image-only task accepted immediately after paste');
      await page.waitForFunction(() => !document.getElementById('sendButton').disabled && document.getElementById('messages').innerText.includes('合成图像回复'));
      assert.equal(turns.length, count + 1);
      assert.equal(turns.at(-1).attachment_ids.length, 1);
      assert.equal(turns.at(-1).user_input, '');
      assert.equal(uploads.at(-1).filename, '合成截图.png');
      assert(uploads.at(-1).raw.equals(PNG), 'image body is binary and unchanged');
      assert.equal(await page.locator('.message.user .message-image img').count(), 1);
      assert.equal(await page.locator('#messages .message.user').count(), 1, 'upload/session binding creates one user bubble');
      const saved = await page.evaluate(() => JSON.stringify(localStorage));
      assert(!saved.includes('data:image') && !saved.includes('blob:') && !saved.includes(PNG.toString('base64')), 'storage contains references only');
      await page.evaluate(() => window.__petChatSubmitText('接下来的纯文本'));
      await page.waitForFunction(() => !document.getElementById('sendButton').disabled);
      assert.deepEqual(turns.at(-1).attachment_ids, [], 'text-only turn explicitly clears stale image selection');
      // Paste documents and images in one operation with a text caption on every surface.
      await page.evaluate(bytes => {
        const data = new DataTransfer();
        data.items.add(new File(['# 合成文档内容'], '混合资料.md', { type: 'text/markdown' }));
        data.items.add(new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], '混合截图.png', { type: 'image/png' }));
        data.setData('text/plain', '结合文档和图片说明');
        document.getElementById('questionInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, PNG.toString('base64'));
      assert.equal(await page.locator('#questionInput').inputValue(), '结合文档和图片说明');
      const beforeMixed = turns.length;
      await page.evaluate(() => window.__petChatSubmitText(document.getElementById('questionInput').value));
      await page.waitForFunction(() => !document.getElementById('sendButton').disabled);
      assert.equal(turns.length, beforeMixed + 1);
      assert.equal(turns.at(-1).attachment_ids.length, 2);
      assert.equal(turns.at(-1).user_input, '结合文档和图片说明');
      assert.deepEqual(turns.at(-1).attachment_ids.map(id => attachmentMetadata.get(id).kind), ['document', 'image']);
      assert.equal(await page.locator('#messages .message-document img').count(), 0, 'document is never rendered as an image/HTML page');
      assert((await page.locator('#messages .message-document').last().innerText()).includes('混合资料.md'));
      await page.evaluate(() => document.getElementById('questionInput').value = '');
      if (surface === 'mobile') {
        assert(await page.locator('#uploadAttachmentButton').isVisible());
        const rect = await page.locator('#uploadAttachmentButton').boundingBox(); assert(rect.width >= 40);
        await page.locator('#uploadAttachmentButton').click();
        assert(await page.locator('#chooseImageButton').isVisible()); assert(await page.locator('#chooseFileButton').isVisible());
        await page.locator('#cachedFileInput').setInputFiles({ name: '资料.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic file') });
        await page.waitForFunction(() => document.getElementById('composerAttachments').innerText.includes('待发送'));
        assert.equal(await page.evaluate(() => window.__petChatSubmitText('')), true, 'document-only turn accepted');
        await page.waitForFunction(() => !document.getElementById('sendButton').disabled);
        assert.equal(turns.at(-1).attachment_ids.length, 1); assert.equal(turns.at(-1).user_input, '');
        assert(!JSON.stringify(turns.at(-1)).includes('cache_id'));
        await page.locator('#messages .message-document').last().waitFor();
        assert((await page.locator('#messages .message-document').last().innerText()).includes('资料.txt'));
        assert.equal(await page.locator('#messages .message-document').last().getAttribute('download'), '资料.txt');
        await page.locator('#uploadAttachmentButton').click();
        await page.locator('#cachedFileInput').setInputFiles({ name: '手机文档.md', mimeType: 'text/markdown', buffer: Buffer.from('# Mobile notes') });
        await paste(page, '手机待发送.png');
        await page.waitForFunction(() => document.querySelectorAll('#composerAttachments .attachment-card').length === 2);
        await page.screenshot({ path: path.resolve(ROOT, '../../../.runtime/quick-chat-preview/mobile-image-composer.png') });
      }
      if (surface === 'work') {
        await paste(page, '移除.png');
        await page.locator('#composerAttachments .attachment-remove').click();
        assert.equal(await page.evaluate(() => window.__petChatSubmitText('')), false);
        // The source session owns its images even when another conversation is selected.
        await paste(page, '原会话.png');
        const original = await page.evaluate(() => window.LkaChatContext.get().sessionId);
        await page.locator('#newSessionButton').click();
        assert.equal(await page.locator('#composerAttachments').isVisible(), false);
        await page.evaluate(sid => window.LkaChatContext.openSession(sid), original);
        await page.waitForFunction(() => document.getElementById('composerAttachments').innerText.includes('原会话.png'));
        await page.locator('#composerAttachments .attachment-remove').click();
        rejectUploads = true;
        await paste(page, '重试.png');
        await page.waitForFunction(() => document.getElementById('composerAttachments').innerText.includes('上传失败'));
        const beforeFailure = turns.length;
        await page.evaluate(() => window.__petChatSubmitText('图片上传失败不应发空任务'));
        await page.waitForFunction(() => !document.getElementById('sendButton').disabled && document.getElementById('messages').innerText.includes('synthetic_upload_failure'));
        assert.equal(turns.length, beforeFailure, 'upload failure prevents Agent task and restores image');
        assert(await page.locator('#composerAttachments').isVisible());
        rejectUploads = false;
        await page.evaluate(() => window.__petChatSubmitText('重试发送'));
        await page.waitForFunction(() => !document.getElementById('sendButton').disabled);
        assert.equal(turns.at(-1).attachment_ids.length, 1);
        await page.evaluate(async () => {
          var canvas = document.createElement('canvas'); canvas.width = 3000; canvas.height = 2000;
          canvas.getContext('2d').fillRect(0, 0, 3000, 2000);
          var blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
          blob = new Blob([blob, new Uint8Array(10 * 1024 * 1024)], { type: "image/jpeg" });
          var bytes = new Uint8Array(await blob.arrayBuffer()), binary = '';
          bytes.forEach(value => { binary += String.fromCharCode(value); });
          await window.LkaImageComposer.addNativeImage('大照片.jpg', 'image/jpeg', btoa(binary));
        });
        await page.waitForFunction(() => document.getElementById('composerAttachments').innerText.includes('待发送'));
        var resizedDimensions = await page.evaluate(async () => {
          var image = document.querySelector('#composerAttachments img');
          await image.decode(); return [image.naturalWidth, image.naturalHeight];
        });
        assert(resizedDimensions[0] * resizedDimensions[1] <= 4000000, 'phone photo is resized within backend pixel bound');
        assert(resizedDimensions[0] > 2000, 'photo retains useful image detail');
        assert.equal(uploads.at(-1).type, 'image/jpeg');
        assert(uploads.at(-1).raw.length <= 10 * 1024 * 1024, 'large source photo is compressed before upload');
        await page.screenshot({ path: path.resolve(ROOT, '../../../.runtime/quick-chat-preview/workbench-image-composer.png') });
      }
      if (surface === 'quick') {
        const accepted = await page.evaluate(bytes => window.LkaImageComposer.addNativeImage('native.png', 'image/png', bytes), PNG.toString('base64'));
        assert.equal(accepted, true); await page.waitForFunction(() => document.getElementById('composerAttachments').innerText.includes('待发送'));
        assert.equal(await page.locator('#composerAttachments').isVisible(), true);
        await page.locator('#cachedFileInput').setInputFiles([{ name: '边界1.txt', mimeType: 'text/plain', buffer: Buffer.from('first') }, { name: '边界2.md', mimeType: 'text/markdown', buffer: Buffer.from('second') }]);
        await paste(page, '边界图片.png');
        await paste(page, '第5个.png');
        assert.equal(await page.locator('#composerAttachments .attachment-card').count(), 4, 'max 4 total even with mixed documents and concurrent image decoding');
        assert((await page.locator('#attachmentNotice').innerText()).includes('最多发送 4'));
        await page.evaluate(() => window.LkaImageComposer.queueRefs(window.LkaChatContext.get().sessionId, [{ attachment_id: 'att_' + 'a'.repeat(32), filename: '恢复图片.png' }]));
        assert.equal(await page.locator('#composerAttachments .attachment-card').count(), 4, 'restoring failed images cannot overflow the next draft');
      }
      if (surface === 'native') {
        // A native/network stall must release the send button, preserve the file,
        // and permit retry without submitting a text-only Agent task.
        const beforeStall = turns.length;
        await page.evaluate(() => {
          window.uploadTestOriginalFetch = window.fetch;
          window.uploadTestOriginalTimeout = window.setTimeout;
          window.setTimeout = function (callback, delay, ...args) {
            return window.uploadTestOriginalTimeout(callback, delay === 60000 ? 100 : delay, ...args);
          };
          window.fetch = function (url, options) {
            if (options?.method === 'POST' && String(url).endsWith('/attachments')) {
              return new Promise((resolve, reject) => {
                if (options.signal) options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
              });
            }
            return window.uploadTestOriginalFetch(url, options);
          };
        });
        await paste(page, '超时后重试.png');
        await page.evaluate(() => window.__petChatSubmitText('上传超时测试'));
        await page.waitForFunction(() => !document.getElementById('sendButton').disabled && document.getElementById('messages').innerText.includes('附件上传超时'));
        assert.equal(turns.length, beforeStall, 'timeout must not create an Agent task');
        assert((await page.locator('#composerAttachments').innerText()).includes('超时后重试.png'));
        await page.evaluate(() => {
          window.fetch = window.uploadTestOriginalFetch;
          window.setTimeout = window.uploadTestOriginalTimeout;
          delete window.uploadTestOriginalFetch; delete window.uploadTestOriginalTimeout;
          window.__petChatSubmitText('超时后重新发送');
        });
        await page.waitForFunction(() => !document.getElementById('sendButton').disabled);
        assert.equal(turns.length, beforeStall + 1);
        assert.equal(turns.at(-1).attachment_ids.length, 1);
        assert(uploads.at(-1).raw.equals(PNG), 'retry preserves original image bytes');
      }
      await context.close();
    }
    // A fresh browser has only backend IDs, so metadata must recover document kind/name.
    const historyContext = await browser.newContext({ viewport: { width: 1200, height: 850 } });
    const history = await historyContext.newPage();
    history.on('pageerror', e => errors.push(e.message));
    await history.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const mixedSession = turns.find(t => t.user_input === '结合文档和图片说明').session_id;
    await history.goto(origin + '/chat.html?mode=work&session_id=' + mixedSession + '&backend=' + encodeURIComponent(origin));
    await history.locator('#messages .message-document').filter({ hasText: '混合资料.md' }).first().waitFor();
    assert.equal(await history.locator('#messages .message-document img').count(), 0);
    assert(await history.locator('#messages .message-image img').count() > 0, 'history metadata distinguishes images from documents');
    assert(![...uploads].some(upload => upload.path === '/pet/composer-files'), 'new files use session-scoped backend uploads');
    await historyContext.close();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', surfaces: 4, imageUploads: uploads.length, agentTurns: turns.length,
      checks: ['binary paste, immediate image-only send, documents/images/text mixed on every surface, preview/history, no persisted pixels', 'mobile picker, document-only send, downloads and mixed drafts', 'session isolation, removal, bounded count', 'upload failure prevents task and allows retry', 'explicit empty image selection in text turns', 'native JS ingress and hidden composer previews'] }));
  } finally { heldResolve?.(); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
