// Run-control regression coverage against an isolated synthetic backend.
// Quick mode mocks the native bridge; work and mobile use browser HTTP/SSE.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const ROOT = path.resolve(__dirname, '../app/web/pet');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const requests = [];
const liveStreams = new Map();
const runStatuses = new Map();
const replaceAttempts = new Map();
const errors = [];
const previewDir = path.resolve(ROOT, '../../../.runtime/run-controls-preview');
let activeLayout = '';
let sessionSerial = 0;

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}
function writeEvent(res, runId, eventName, data) {
  if (!res || res.destroyed || res.writableEnded) return;
  const seq = Number(data.sequence) || 1;
  res.write('id: ' + runId + ':' + seq + '\nevent: ' + eventName + '\ndata: ' + JSON.stringify(data) + '\n\n');
}
function emitRunEvent(runId, eventName, sequence, extra = {}) {
  const data = Object.assign({ run_id: runId, sequence }, extra);
  writeEvent(liveStreams.get(runId), runId, eventName, data);
  if (eventName === 'run_paused') runStatuses.set(runId, 'paused');
  if (eventName === 'run_completed') runStatuses.set(runId, 'completed');
}
function endRunStream(runId) {
  const res = liveStreams.get(runId);
  if (res && !res.destroyed && !res.writableEnded) res.end();
  liveStreams.delete(runId);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const body = await readBody(req);
  requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

  if (url.pathname === '/' || url.pathname.endsWith('/chat.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(ROOT, 'chat.html'), 'utf8'));
  }
  const relative = decodeURIComponent(url.pathname.replace(/^\/(?:desktop-pet\/)?/, ''));
  const file = path.resolve(ROOT, relative);
  if (file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }

  if (url.pathname === '/agent/models') return json(res, 200, { clients: [] });
  if (url.pathname === '/agent/ui-defaults' && req.method === 'GET') return json(res, 200, { configured: false, defaults: {} });
  if (url.pathname === '/agent/ui-defaults' && req.method === 'PUT') return json(res, 200, { saved: true });
  if (url.pathname === '/knowledge/file-types') return json(res, 200, { file_types: [] });
  if (url.pathname === '/sessions' && req.method === 'GET') return json(res, 200, { sessions: [] });
  if (url.pathname === '/sessions/deleted') return json(res, 200, { sessions: [] });
  if (url.pathname === '/sessions' && req.method === 'POST') {
    sessionSerial += 1;
    return json(res, 201, { session: { session_id: 'session-' + sessionSerial, title: 'Synthetic task', metadata: {} } });
  }
  if (url.pathname === '/pet/session-workspace') return json(res, 200, { path: 'C:/synthetic/workspace' });
  if (/^\/sessions\/[^/]+\/workspace$/.test(url.pathname)) return json(res, 200, { project_id: 'synthetic-project' });
  if (/^\/sessions\/[^/]+$/.test(url.pathname)) return json(res, 200, {
    session: { session_id: decodeURIComponent(url.pathname.split('/')[2]), title: 'Synthetic task', metadata: {}, workspace: { path: 'C:/synthetic/workspace' } },
    messages: []
  });

  if (url.pathname === '/agent/turn/stream' && req.method === 'POST') {
    const runId = 'run-' + activeLayout;
    runStatuses.set(runId, 'running');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'connection': 'keep-alive' });
    liveStreams.set(runId, res);
    writeEvent(res, runId, 'run_started', { run_id: runId, sequence: 10, status: 'running' });
    res.on('close', () => { if (liveStreams.get(runId) === res) liveStreams.delete(runId); });
    return;
  }

  const runMatch = url.pathname.match(/^\/agent\/runs\/([^/]+)(?:\/(interrupt|resume|replace|stream|snapshot|events))?$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]);
    const action = runMatch[2] || '';
    if (action === 'interrupt' && req.method === 'POST') {
      runStatuses.set(runId, 'running');
      return json(res, 200, { run_id: runId, status: 'running', pause_requested: true });
    }
    if (action === 'resume' && req.method === 'POST') {
      runStatuses.set(runId, 'paused');
      return json(res, 200, { run_id: runId, status: 'paused' });
    }
    if (action === 'replace' && req.method === 'POST') {
      const attempt = (replaceAttempts.get(runId) || 0) + 1;
      replaceAttempts.set(runId, attempt);
      if (attempt === 1) return json(res, 409, { detail: 'synthetic_replace_conflict' });
      const newRunId = 'replacement-' + runId;
      runStatuses.set(newRunId, 'running');
      return json(res, 200, { run_id: newRunId, status: 'running' });
    }
    if (!action && req.method === 'GET') return json(res, 200, { run_id: runId, status: runStatuses.get(runId) || 'running' });
    if (action === 'snapshot' && req.method === 'GET') {
      return json(res, 200, { run: { run_id: runId, status: runStatuses.get(runId) || 'running' }, children: [] });
    }
    if (action === 'events' && req.method === 'GET') return json(res, 200, { events: [] });
    if (action === 'stream' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'connection': 'keep-alive' });
      liveStreams.set(runId, res);
      if (runId.startsWith('replacement-')) {
        writeEvent(res, runId, 'run_started', { run_id: runId, sequence: 1, status: 'running' });
        writeEvent(res, runId, 'final_answer', { run_id: runId, sequence: 2, payload: { metadata: { answer: '合成最终回复' } } });
        runStatuses.set(runId, 'completed');
        writeEvent(res, runId, 'run_completed', { run_id: runId, sequence: 3, status: 'completed' });
        res.end(); liveStreams.delete(runId);
      } else {
        writeEvent(res, runId, 'run_resumed', { run_id: runId, sequence: 13, status: 'running' });
      }
      res.on('close', () => { if (liveStreams.get(runId) === res) liveStreams.delete(runId); });
      return;
    }
  }
  return json(res, 404, { detail: 'not_mocked', path: url.pathname });
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitNode(predicate, message, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await sleep(20); }
  assert.fail(message);
}
function matching(method, path) { return requests.filter(row => row.method === method && row.path === path); }
function screenshotPath(name) {
  fs.mkdirSync(previewDir, { recursive: true });
  return path.join(previewDir, name + '.png');
}

async function testLayout(browser, origin, layout) {
  activeLayout = layout;
  requests.length = 0;
  const viewport = layout === 'mobile' ? { width: 390, height: 780 } : layout === 'quick' ? { width: 430, height: 700 } : { width: 1280, height: 820 };
  const context = await browser.newContext({ viewport, hasTouch: layout === 'mobile' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(layout + ': ' + error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  if (layout === 'quick') {
    await page.addInitScript(() => {
      const active = Object.create(null);
      window.__nativeMock = { turns: [], callbacks: [], savedRequests: [], cancelled: [], composerActions: [], drafts: [], active };
      window.petBridge = {
        stream(payload) {
          window.__nativeMock.turns.push(JSON.parse(payload));
          const requestId = JSON.parse(payload).request_id;
          const callback = (name, data) => window.__petChatReceiveStream(name, data, requestId);
          window.__nativeMock.callbacks.push(callback);
          const runId = 'run-quick', sequence = 10;
          setTimeout(() => callback('run_started', { run_id: runId, sequence, status: 'running' }, runId + ':' + sequence), 0);
        },
        streamSavedRun(payloadJson) {
          const payload = JSON.parse(payloadJson);
          const controller = new AbortController();
          window.__nativeMock.savedRequests.push(payload);
          active[payload.request_id] = controller;
          const url = location.origin + '/agent/runs/' + encodeURIComponent(payload.run_id)
            + '/stream?after_sequence=' + encodeURIComponent(payload.after_sequence);
          fetch(url, { headers: { Accept: 'text/event-stream' }, signal: controller.signal }).then(async response => {
            const reader = response.body.getReader(), decoder = new TextDecoder();
            let buffer = '';
            const consume = block => {
              let eventName = 'message', eventId = '', lines = [];
              block.split(/\r?\n/).forEach(line => {
                if (line.startsWith('event:')) eventName = line.slice(6).trim();
                else if (line.startsWith('id:')) eventId = line.slice(3).trim();
                else if (line.startsWith('data:')) lines.push(line.slice(5).trim());
              });
              if (lines.length) window.__petChatReceiveSavedRunStream(payload.request_id, eventName, JSON.stringify(JSON.parse(lines.join('\n'))), eventId);
            };
            while (true) {
              const part = await reader.read(); if (part.done) break;
              buffer += decoder.decode(part.value, { stream: true });
              const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() || ''; blocks.forEach(consume);
            }
            if (buffer.trim()) consume(buffer);
            window.__petChatSavedRunStreamClosed(payload.request_id, '');
          }).catch(error => {
            if (error.name !== 'AbortError') window.__petChatSavedRunStreamClosed(payload.request_id, error.message);
          }).finally(() => { delete active[payload.request_id]; });
        },
        cancelSavedRunStream(requestId) {
          window.__nativeMock.cancelled.push(requestId);
          if (active[requestId]) active[requestId].abort();
          delete active[requestId];
        },
        setComposerAction(action) { window.__nativeMock.composerActions.push(action); },
        setComposerBusy() {}, setComposerDraft(draft) { window.__nativeMock.drafts.push(draft); }, focusComposer() {}
      };
    });
  }

  const query = layout === 'quick' ? 'mode=quick' : layout === 'mobile' ? 'layout=mobile' : 'mode=work';
  await page.goto(origin + '/chat.html?' + query + '&backend=' + encodeURIComponent(origin));
  await page.waitForFunction(() => typeof window.__petChatSubmitText === 'function');
  await page.waitForFunction(() => document.querySelector('#sendButton')?.getAttribute('data-action'));
  if (layout === 'quick') await page.evaluate(() => window.__petChatBridgeReady());
  assert.equal(await page.locator('#sendButton').getAttribute('data-action'), 'send', layout + ': idle control sends');
  assert.equal(await page.locator('#sendButton').isDisabled(), false);

  if (layout === 'work') {
    if (!(await page.locator('#contextRail').isVisible())) await page.locator('#toggleSettingsButton').click();
    await page.locator('#settingsTabButton').click();
    await page.locator('#streamToggle').uncheck();
    await page.waitForTimeout(60);
  }
  const firstText = '原任务 ' + layout;
  let sessionId = '';
  if (layout === 'quick') {
    assert.equal(await page.locator('#chatForm').isVisible(), false, 'native quick layout hides the browser composer');
    await page.evaluate(() => window.__petChatNativeDraftChanged(''));
    assert.equal(await page.evaluate(text => window.__petChatSubmitText(text), firstText), true);
  } else {
    await page.locator('#questionInput').fill(firstText);
    await page.locator('#sendButton').click(); // Browser paper-plane / submit path.
  }

  const runId = 'run-' + layout;
  if (layout === 'quick') {
    await page.waitForFunction(() => window.__nativeMock.turns.length === 1);
    const turn = await page.evaluate(() => window.__nativeMock.turns[0]);
    assert.equal(turn.question, firstText);
    assert.equal(turn.resumable, true, 'native turns request resumable runs');
    sessionId = turn.session_id || turn.conversation_id;
  } else {
    await waitNode(() => matching('POST', '/agent/turn/stream').length === 1, layout + ': first turn uses HTTP streaming');
    const turn = matching('POST', '/agent/turn/stream')[0].body;
    assert.equal(turn.user_input, firstText);
    assert.equal(turn.resumable, true, layout + ': HTTP turns request resumable runs');
    sessionId = turn.session_id || turn.conversation_id;
  }
  await page.waitForFunction(() => document.querySelector('#sendButton')?.getAttribute('data-run-state') === 'running');
  if (layout === 'work') await page.screenshot({ path: screenshotPath('work-running') });
  assert.equal(await page.locator('#sendButton').getAttribute('data-action'), 'pause', layout + ': running empty composer pauses');
  assert.equal(await page.locator('#sendButton').isDisabled(), false);

  const controlsBefore = requests.filter(row => row.method === 'POST' &&
    (row.path === '/agent/turn/stream' || /\/agent\/runs\/[^/]+\/(interrupt|resume|replace)$/.test(row.path))).length;
  if (layout === 'quick') await page.evaluate(() => window.__petChatNativeDraftChanged('synthetic queued draft'));
  else await page.locator('#questionInput').fill('synthetic queued draft');
  assert.equal(await page.locator('#sendButton').getAttribute('data-action'), 'send', layout + ': running text draft keeps send selected');
  assert.equal(await page.locator('#sendButton').isDisabled(), true, layout + ': running draft cannot be sent');
  await page.waitForTimeout(60);
  assert.equal(requests.filter(row => row.method === 'POST' &&
    (row.path === '/agent/turn/stream' || /\/agent\/runs\/[^/]+\/(interrupt|resume|replace)$/.test(row.path))).length,
  controlsBefore, layout + ': running draft creates no turn or control request');
  if (layout === 'quick') await page.evaluate(() => window.__petChatNativeDraftChanged(''));
  else await page.locator('#questionInput').fill('');
  assert.equal(await page.locator('#sendButton').getAttribute('data-action'), 'pause', layout + ': clearing draft restores pause');

  await page.waitForTimeout(280); // Separate this pause action from the preceding submit.
  if (layout === 'quick') await page.evaluate(() => window.__petChatSubmitText(''));
  else await page.locator('#sendButton').click();
  await waitNode(() => matching('POST', '/agent/runs/' + runId + '/interrupt').length === 1,
    layout + ': empty running composer interrupts');
  const interrupt = matching('POST', '/agent/runs/' + runId + '/interrupt')[0];
  await page.waitForFunction(() => document.querySelector('#sendButton')?.getAttribute('data-run-state') === 'pause_requested');
  assert.equal(interrupt.method, 'POST');
  assert.equal((await page.locator('#sendButton').getAttribute('data-action')), 'pause');
  assert.equal(await page.locator('#sendButton').isDisabled(), true, layout + ': pause request stays busy until run_paused');
  assert.equal(await page.locator('#questionInput').isDisabled(), false, layout + ': draft remains editable while pause is pending');

  if (layout === 'quick') {
    await page.evaluate(({ id }) => window.__nativeMock.callbacks[0]('run_paused',
      { run_id: id, sequence: 12, status: 'paused' }, id + ':12'), { id: runId });
  } else {
    emitRunEvent(runId, 'run_paused', 12, { status: 'paused' }); endRunStream(runId);
  }
  await page.waitForFunction(() => document.querySelector('#sendButton')?.getAttribute('data-run-state') === 'paused');
  assert.equal(await page.locator('#sendButton').getAttribute('data-action'), 'resume');
  assert.equal(await page.locator('#sendButton').isDisabled(), false, layout + ': paused empty composer resumes');
  assert.equal(await page.locator('#questionInput').isDisabled(), false, layout + ': paused composer remains editable');
  assert.equal(await page.locator('#messages .message.error').count(), 0, layout + ': paused stream EOF is not an error');
  assert.equal(await page.locator('#messages .message.assistant:not(.agent-live-output)').count(), 0,
    layout + ': pause does not fabricate an assistant answer');
  if (layout === 'mobile' || layout === 'quick') await page.screenshot({ path: screenshotPath(layout + '-paused') });

  await page.waitForTimeout(280); // Preserve the existing submit double-click guard.
  if (layout === 'quick') await page.evaluate(() => window.__petChatSubmitText(''));
  else await page.locator('#sendButton').click();
  await waitNode(() => matching('POST', '/agent/runs/' + runId + '/resume').length === 1, layout + ': resume targets the same run');
  await waitNode(() => matching('GET', '/agent/runs/' + runId + '/stream').length === 1, layout + ': resume opens saved stream');
  const resumeStream = matching('GET', '/agent/runs/' + runId + '/stream')[0];
  assert.equal(resumeStream.query.after_sequence, '12', layout + ': resume continues after the pause cursor');
  if (layout === 'quick') {
    await page.waitForFunction(() => window.__nativeMock.savedRequests.length === 1);
    const bridgeRequest = await page.evaluate(() => window.__nativeMock.savedRequests[0]);
    assert.equal(bridgeRequest.run_id, runId);
    assert.equal(bridgeRequest.after_sequence, 12);
    assert(bridgeRequest.request_id, 'native saved stream has a request ID');
  }
  await page.waitForFunction(() => document.querySelector('#sendButton')?.getAttribute('data-run-state') === 'running');
  emitRunEvent(runId, 'run_paused', 14, { status: 'paused' }); endRunStream(runId);
  await page.waitForFunction(() => document.querySelector('#sendButton')?.getAttribute('data-run-state') === 'paused');
  if (layout === 'quick') {
    await page.waitForFunction(() => window.__nativeMock.cancelled.length === 1);
    const bridgeRequest = await page.evaluate(() => window.__nativeMock.savedRequests[0]);
    assert.deepEqual(await page.evaluate(() => window.__nativeMock.cancelled), [bridgeRequest.request_id],
      'native saved stream is cancelled by its request ID after the pause event');
  }

  await page.waitForTimeout(280); // The existing submit debounce also covers resume clicks.
  const replacementText = '替换任务 ' + layout;
  if (layout === 'quick') {
    await page.evaluate(text => window.__petChatNativeDraftChanged(text), replacementText);
    assert.equal(await page.evaluate(text => window.__petChatSubmitText(text), replacementText), true);
  } else {
    await page.locator('#questionInput').fill(replacementText);
    assert.equal(await page.locator('#sendButton').getAttribute('data-action'), 'send');
    assert.equal(await page.locator('#sendButton').isDisabled(), false, layout + ': paused text can replace');
    await page.locator('#sendButton').click();
  }
  const replacePath = '/agent/runs/' + runId + '/replace';
  await waitNode(() => matching('POST', replacePath).length === 1, layout + ': paused text atomically replaces');
  const failedReplace = matching('POST', replacePath)[0];
  assert.equal(failedReplace.body.user_input, replacementText);
  assert.equal(failedReplace.body.resumable, true);
  assert.equal(failedReplace.body.session_id, sessionId);
  const firstCommandId = failedReplace.body.command_id;
  assert(firstCommandId);
  await page.waitForFunction(() => document.querySelector('#sendButton')?.getAttribute('data-run-state') === 'paused');
  if (layout === 'quick') {
    assert.equal(await page.evaluate(() => window.__nativeMock.drafts.at(-1)), replacementText,
      layout + ': 409 restores the draft into the native composer');
  } else {
    assert.equal(await page.locator('#questionInput').inputValue(), replacementText, layout + ': 409 restores the draft');
  }
  assert.equal(await page.locator('#messages .message.error').count(), 0, layout + ': replace conflict is recoverable, not a fake turn failure');
  await page.waitForTimeout(280); // A deliberate retry, rather than the original double click.
  if (layout === 'quick') {
    await page.evaluate(text => window.__petChatNativeDraftChanged(text), replacementText);
    assert.equal(await page.evaluate(text => window.__petChatSubmitText(text), replacementText), true);
  } else {
    await page.locator('#sendButton').click();
  }
  await waitNode(() => matching('POST', replacePath).length === 2, layout + ': retry sends replacement once more');
  const retriedReplace = matching('POST', replacePath)[1];
  assert.equal(retriedReplace.body.command_id, firstCommandId, layout + ': retry reuses the idempotency command ID');
  assert.equal(retriedReplace.body.user_input, replacementText);
  const replacementRunId = 'replacement-' + runId;
  await waitNode(() => matching('GET', '/agent/runs/' + replacementRunId + '/stream').length === 1,
    layout + ': accepted replacement reconnects with its returned run ID');
  await page.waitForFunction(() => document.querySelector('#messages .message.assistant:not(.agent-live-output) .message-content')?.textContent.includes('合成最终回复'));
  assert.equal(await page.locator('#messages .message.assistant:not(.agent-live-output) .message-content').count(), 1,
    layout + ': final answer appears exactly once');
  assert.equal(await page.locator('#messages .message.error').count(), 0);
  if (layout === 'quick') await page.waitForFunction(() => window.__nativeMock.cancelled.length === 2);
  await context.close();
}

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox'] });
    for (const layout of ['work', 'mobile', 'quick']) await testLayout(browser, origin, layout);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Run controls smoke passed for work, mobile, and quick layouts.');
    console.log('Paused layout screenshots: .runtime/run-controls-preview/mobile-paused.png and quick-paused.png');
  } finally {
    for (const [runId] of liveStreams) endRunStream(runId);
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
