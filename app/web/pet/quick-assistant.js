(function () {
  'use strict';
  if (!document.body.classList.contains('quick-mode') || !window.LkaChatContext || !window.LkaMatterHost) return;
  var chat = window.LkaChatContext, host = window.LkaMatterHost, state = null, loading = false, failure = '', epoch = 0;
  var toggling = false, polling = null, current = null, waitCursor = 0, deliveryCursor = 0, turn = 0;
  var waiting = new Map(), verified = new Map();
  var bar = document.createElement('section'); bar.id = 'quickAssistantBar'; bar.className = 'qa-bar'; bar.setAttribute('aria-label', '当前对话');
  bar.innerHTML = '<button type="button" id="qaHome" class="qa-identity" title="返回真理"><span class="qa-star" aria-hidden="true">✦</span><strong>真理</strong><span id="qaMode">对话与跟进</span></button><div class="qa-actions"><span id="qaState" role="status"></span><button id="qaManage" type="button" hidden>启用管理</button><button id="qaRetry" type="button" hidden>重试连接</button></div><p id="qaNotice" role="status" aria-live="polite" hidden></p>';
  var attention = document.createElement('section'); attention.id = 'quickAssistantAttention'; attention.className = 'qa-attention'; attention.hidden = true; attention.setAttribute('aria-label', '需要你处理');
  attention.innerHTML = '<span aria-hidden="true" class="qa-attention-dot"></span><span id="qaAttentionText">有任务需要你处理</span><button type="button" id="qaOpenTask">查看任务</button>';
  var messages = document.getElementById('messages'); messages.parentNode.insertBefore(bar, messages); messages.parentNode.insertBefore(attention, messages);
  function el(id) { return document.getElementById(id); }
  function isCurrent(id) { var view = chat.get(); return view.kind === 'manager' && view.sessionId === id; }
  function changed() { window.dispatchEvent(new CustomEvent('lka-quick-assistant-layout')); }
  function message(text) { el('qaNotice').textContent = text || ''; el('qaNotice').hidden = !text; changed(); }
  function clearFeed() { epoch++; waitCursor = deliveryCursor = turn = 0; waiting.clear(); verified.clear(); current = null; attention.hidden = true; }
  function render() {
    var view = chat.get(), manager = view.kind === 'manager', matched = state && isCurrent(state.session.session_id);
    document.body.classList.toggle('quick-assistant-view', manager || loading);
    el('qaHome').disabled = loading; el('qaHome').title = manager ? '真理' : '返回真理';
    el('qaMode').textContent = loading ? '正在连接' : manager ? '对话与跟进' : failure ? '助手未连接' : '独立任务';
    el('qaState').textContent = loading ? '请稍候' : matched ? state.controller.status === 'active' ? '管理已启用' : '管理已暂停' : '';
    el('qaManage').hidden = !matched || loading; el('qaManage').disabled = toggling;
    el('qaManage').textContent = toggling ? '正在更新' : matched && state.controller.status === 'active' ? '暂停管理' : '启用管理';
    el('qaManage').setAttribute('role', 'switch'); el('qaManage').setAttribute('aria-checked', String(!!(matched && state.controller.status === 'active')));
    el('qaManage').title = matched && state.controller.status === 'active' ? '暂停后，已委托的任务仍会继续' : '允许真理整理事项和委托任务';
    el('qaRetry').hidden = !failure; el('qaRetry').disabled = loading;
    attention.hidden = !matched || !current;
    if (current && matched) el('qaAttentionText').textContent = current.status === 'waiting_confirmation' ? '有任务等待你确认' : '有任务需要你补充信息';
    changed();
  }
  function report(error) {
    if (error.detail === 'management_disabled') return '真理尚未启用；你也可以先使用「新任务」。';
    if (error.status === 409) return '管理状态已变化，请核对最新状态后重试。';
    if (error.status === 401 || error.status === 403) return '管理连接没有权限，请检查本机配对。';
    return error.message || '暂时无法读取跟进状态，请稍后重试。';
  }
  function accept(value) {
    if (!value || !value.session || value.session.kind !== 'manager' || !value.controller || value.controller.session_id !== value.session.session_id || !Number.isInteger(value.controller.revision) || value.controller.revision < 1 || ['active', 'paused'].indexOf(value.controller.status) < 0) throw new Error('助手状态响应不完整。');
    if (state && state.session.session_id !== value.session.session_id) clearFeed();
    if (!state || state.session.session_id !== value.session.session_id || value.controller.revision >= state.controller.revision) state = value;
  }
  function path(suffix) { return '/managers/' + encodeURIComponent(state.session.session_id) + (suffix || ''); }
  async function readFeed(kind, scope) {
    var cursor = kind === 'events' ? waitCursor : deliveryCursor;
    for (var page = 0; page < 4; page++) {
      var data = await host.request(path('/' + kind) + '?after=' + cursor + '&limit=100');
      if (scope !== epoch) return;
      if (!Array.isArray(data[kind])) throw new Error('跟进记录响应不完整。');
      data[kind].forEach(function (row) {
        var n = Number(kind === 'events' ? row.event_id : row.cursor);
        if (!Number.isSafeInteger(n) || n <= cursor) return;
        cursor = n;
        if (kind === 'events') {
          var payload = row.payload || {};
          if (payload.run_id && payload.task_waiting === true) waiting.set(payload.run_id, payload);
          else if (payload.run_id && row.kind === 'task_terminal') { waiting.delete(payload.run_id); verified.delete(payload.run_id); }
        }
      });
      if (kind === 'events') waitCursor = cursor; else deliveryCursor = cursor;
      if (data.next_after == null) break;
    }
  }
  async function refresh() {
    if (!state || !isCurrent(state.session.session_id) || loading || document.hidden) return;
    if (polling) return polling;
    var scope = epoch, id = state.session.session_id;
    polling = (async function () {
      try {
        var value = await host.request(path());
        if (value && value.session && value.session.session_id !== id) throw new Error('返回的助手身份不匹配。');
        if (scope !== epoch || !isCurrent(id)) return;
        accept(value);
        await Promise.all([readFeed('events', scope), readFeed('deliveries', scope)]);
        if (scope !== epoch || !isCurrent(id)) return;
        var candidates = Array.from(waiting.keys()), count = Math.min(8, candidates.length), batch = [];
        for (var i = 0; i < count; i++) batch.push(candidates[(turn + i) % candidates.length]);
        turn = candidates.length ? (turn + count) % candidates.length : 0;
        var checked = await Promise.allSettled(batch.map(function (runId) { return host.request('/agent/runs/' + encodeURIComponent(runId)); }));
        if (scope !== epoch || !isCurrent(id)) return;
        checked.forEach(function (result, i) {
          if (result.status === 'fulfilled' && result.value.run_id === batch[i] && !result.value.parent_run_id && ['waiting_user', 'waiting_confirmation'].indexOf(result.value.status) >= 0) verified.set(batch[i], result.value);
          else if (result.status === 'fulfilled' || result.reason.status === 404) { verified.delete(batch[i]); waiting.delete(batch[i]); }
        });
        current = Array.from(verified.values())[0] || null; render();
        if (checked.some(function (r) { return r.status === 'rejected' && r.reason.status !== 404; })) message('部分任务状态暂时无法核对，可到工作台查看。');
        if (deliveryCursor && typeof chat.refreshConversation === 'function') await chat.refreshConversation();
      } catch (error) { if (scope === epoch && isCurrent(id)) { if (current && !verified.has(current.run_id)) current = null; render(); message(report(error)); } }
      finally { polling = null; }
    })();
    return polling;
  }
  async function home() {
    if (typeof chat.openAssistant !== 'function') return;
    try { var value = await chat.openAssistant(); if (value && isCurrent(value.session.session_id)) { accept(value); render(); refresh(); } }
    catch (error) { message(report(error)); }
  }
  el('qaHome').onclick = home; el('qaRetry').onclick = home;
  el('qaManage').onclick = async function () {
    if (!state || !isCurrent(state.session.session_id) || toggling) return;
    var scope = epoch, id = state.session.session_id; toggling = true; render(); message('');
    try { var value = await host.request(path(), 'PATCH', { expected_revision: state.controller.revision, status: state.controller.status === 'active' ? 'paused' : 'active' }); if (value && value.session && value.session.session_id !== id) throw new Error('返回的助手身份不匹配。'); if (scope === epoch && isCurrent(id)) accept(value); }
    catch (error) {
      if (scope !== epoch || !isCurrent(id)) return;
      if (error.status === 409) { try { var latest = await host.request(path()); if (scope === epoch && isCurrent(id)) accept(latest); } catch (_) {} }
      message(report(error));
    } finally { if (scope === epoch) { toggling = false; render(); } }
  };
  el('qaOpenTask').onclick = function () {
    if (!current) return;
    if (window.petBridge && typeof window.petBridge.openWorkbenchSession === 'function') { window.petBridge.openWorkbenchSession(current.session_id, current.run_id); return; }
    var url = new URL('./chat.html', location.href); url.search = ''; url.searchParams.set('mode', 'work'); url.searchParams.set('backend', host.backend); url.searchParams.set('session_id', current.session_id); url.searchParams.set('run_id', current.run_id);
    window.open(url.href, 'lka-task-' + current.run_id, 'width=1320,height=860');
  };
  var globalButton = el('openGlobalAssistantQuick');
  if (globalButton) globalButton.onclick = home;
  function applyState(event) {
    var data = event.detail || {}; loading = !!data.loading; failure = data.error || ''; toggling = false;
    if (data.manager) { try { accept(data.manager); } catch (e) { failure = report(e); } }
    var runStatus = el('runStatus');
    message(failure && (!runStatus || !runStatus.classList.contains('error')) ? failure : '');
    render(); if (!loading && !failure) refresh();
  }
  window.addEventListener('lka-quick-assistant-state', applyState);
  window.addEventListener('lka-session-context', function () { render(); refresh(); });
  window.addEventListener('lka-agent-turn-finished', function () { refresh(); });
  window.addEventListener('lka-matter-auth-changed', function () { clearFeed(); state = null; toggling = false; message(''); render(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  window.setInterval(refresh, 8000);
  if (typeof chat.assistantState === 'function') applyState({ detail: chat.assistantState() });
  else render();
  if (chat.prepareAssistant && new URLSearchParams(location.search).get('embedded') !== 'matter') chat.prepareAssistant().catch(function () { /* Keep independent tasks available if background preparation fails. */ });
})();
