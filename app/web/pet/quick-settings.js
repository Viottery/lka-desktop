(function () {
  'use strict';
  if (!window.LkaChatContext) return;
  var quick = document.body.classList.contains('quick-mode');
  if (!quick && !document.body.classList.contains('work-mode')) return;
  var chat = window.LkaChatContext, host = window.LkaMatterHost;
  var controller = null, owner = '', draft = null, busy = false, loading = false, error = '', notice = '', epoch = 0;
  var opened = false, lastFocus = null;
  function context() { return chat.get(); }
  function same(id) { return context().sessionId === id; }
  function managerModel(value) { return value && (value.llm_client_name || value.llm_model) ? JSON.stringify([value.llm_client_name || '', value.llm_model || '']) : ''; }
  function snapshot() {
    var view = context(), prefs = chat.preferences(), manager = view.kind === 'manager';
    var ready = !!view.sessionId && (!manager || !!controller && owner === view.sessionId);
    var value = manager ? ready ? managerModel(controller) : '' : prefs.modelValue;
    var model = draft && owner === view.sessionId ? draft.modelValue : value;
    var models = prefs.models.slice();
    if (model && !models.some(function (row) { return row.value === model; })) {
      try { var pair = JSON.parse(model); models.push({ value: model, label: (pair[1] || pair[0] + ' 默认模型') + ' · 当前已保存' }); } catch (_) {}
    }
    return { sessionId: view.sessionId || '', kind: view.kind || 'ordinary', scopeLabel: manager ? '真理模型' : '独立任务默认模型',
      modelValue: model, models: models, safetyMode: draft && owner === view.sessionId ? draft.safetyMode : prefs.safetyMode,
      stream: draft && owner === view.sessionId ? draft.stream : prefs.stream,
      loading: loading, busy: busy, ready: ready && !loading, error: error, notice: notice };
  }
  function publish() {
    var value = snapshot();
    if (window.petBridge && typeof window.petBridge.setQuickSettingsState === 'function') {
      window.petBridge.setQuickSettingsState(JSON.stringify(value));
    }
    if (opened) render(value);
    return value;
  }
  function accept(value, id) {
    if (!value || !value.session || value.session.kind !== 'manager' || value.session.session_id !== id
        || !value.controller || value.controller.session_id !== id || !Number.isInteger(value.controller.revision) || value.controller.revision < 1) throw new Error('助手设置响应不完整，请重试。');
    if (typeof chat.acceptAssistantSettings === 'function') chat.acceptAssistantSettings(value);
    return value.controller;
  }
  async function request(id, method, body) {
    if (!host) throw new Error('设置连接尚未就绪，请重新打开窗口。');
    await host.ready;
    return host.request('/managers/' + encodeURIComponent(id), method || 'GET', body);
  }
  async function refresh(refreshModels) {
    if (busy) return snapshot();
    var id = context().sessionId, manager = context().kind === 'manager', ticket = ++epoch;
    if (owner !== id) { owner = id; controller = null; draft = null; notice = ''; }
    loading = true; error = ''; publish();
    try {
      await chat.preferencesReady(!!refreshModels);
      if (ticket !== epoch || !same(id)) return snapshot();
      if (manager && id) {
        var value = await request(id);
        if (ticket !== epoch || !same(id)) return snapshot();
        controller = accept(value, id);
      }
    } catch (failure) { if (ticket === epoch && same(id)) error = failure.message || '暂时无法读取设置，请重试。'; }
    finally { if (ticket === epoch && same(id)) { loading = false; publish(); } }
    return snapshot();
  }
  async function update(values) {
    if (busy || loading) return snapshot();
    var current = snapshot(), id = current.sessionId, manager = current.kind === 'manager', prefs = chat.preferences();
    if (!current.ready) { error = '请等当前会话连接完成后再设置。'; return publish(); }
    var next = { modelValue: values.modelValue === undefined ? current.modelValue : values.modelValue,
      safetyMode: values.safetyMode === undefined ? current.safetyMode : values.safetyMode,
      stream: values.stream === undefined ? current.stream : values.stream };
    if (typeof next.modelValue !== 'string' || !current.models.some(function (row) { return row.value === next.modelValue; })
        || ['backend', 'llm', 'manual', 'skip'].indexOf(next.safetyMode) < 0 || typeof next.stream !== 'boolean') {
      error = '请选择有效的模型和审查方式。'; return publish();
    }
    var ticket = ++epoch; owner = id; draft = next; busy = true; error = ''; notice = ''; publish();
    try {
      if (manager && next.modelValue !== managerModel(controller)) {
        var pair = next.modelValue ? JSON.parse(next.modelValue) : [null, null];
        var value = await request(id, 'PATCH', { expected_revision: controller.revision, llm_client_name: pair[0] || null, llm_model: pair[1] || null });
        if (ticket !== epoch || !same(id)) return snapshot();
        controller = accept(value, id);
      }
      if (ticket !== epoch || !same(id)) return snapshot();
      var changes = {};
      if (!manager && (next.modelValue !== prefs.modelValue || prefs.saveError)) changes.modelValue = next.modelValue;
      if (next.safetyMode !== prefs.safetyMode || prefs.saveError) changes.safetyMode = next.safetyMode;
      if (next.stream !== prefs.stream || prefs.saveError) changes.stream = next.stream;
      if (Object.keys(changes).length) await chat.savePreferences(changes);
      if (ticket !== epoch || !same(id)) return snapshot();
      draft = null; notice = '已保存，下次新运行生效。';
    } catch (failure) {
      if (ticket !== epoch || !same(id)) return snapshot();
      if (failure.status === 409 && manager) {
        // Keep the user's choices. Reading a new revision never retries a write.
        error = '设置已在其他窗口改变。请核对本次选择，再次应用。';
        try { var latest = await request(id); if (ticket === epoch && same(id)) controller = accept(latest, id); } catch (_) { error += ' 暂时无法读取最新版本，请刷新。'; }
      } else error = failure.message || '保存失败，请重试。';
    } finally { if (ticket === epoch && same(id)) { busy = false; publish(); } }
    return snapshot();
  }
  chat.quickSettings = snapshot;
  chat.refreshQuickSettings = refresh;
  chat.updateQuickSettings = update;

  // Workbench and browser quick windows share the settings/save path with JavaFX.
  var panel = document.createElement('section'); panel.id = 'quickSettings'; panel.className = 'qs-panel'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '对话设置');
  panel.innerHTML = '<header><div><h2>设置</h2><p id="qsScope"></p></div><button id="qsClose" class="qs-icon" type="button" aria-label="关闭设置">×</button></header>' +
    '<form id="qsForm"><div class="qs-field"><label for="qsModel">对话模型</label><div class="qs-model-row"><select id="qsModel"></select><button id="qsRefresh" type="button" class="qs-icon" aria-label="刷新模型列表" title="刷新模型列表">↻</button></div></div>' +
    '<div class="qs-field"><label for="qsSafety">审批模式</label><select id="qsSafety"><option value="backend">跟随后端配置</option><option value="llm">模型审查</option><option value="manual">每次确认</option><option value="skip">请求自动通过</option></select><small>后端策略可要求更严格的审查。</small></div>' +
    '<label class="qs-switch"><span>实时显示回复</span><input id="qsStream" type="checkbox"></label><p class="qs-help">审查方式与回复显示用于后续对话。</p>' +
    '<p id="qsStatus" role="status" aria-live="polite"></p><button id="qsApply" type="submit">应用更改</button></form>';
  document.body.appendChild(panel);
  function el(id) { return document.getElementById(id); }
  function render(value) {
    el('qsScope').textContent = value.scopeLabel;
    var selected = el('qsModel'); selected.textContent = '';
    value.models.forEach(function (row) { var option = document.createElement('option'); option.value = row.value; option.textContent = row.label; selected.appendChild(option); });
    selected.value = value.modelValue; el('qsSafety').value = value.safetyMode; el('qsStream').checked = value.stream;
    ['qsModel', 'qsSafety', 'qsStream', 'qsApply'].forEach(function (id) { el(id).disabled = !value.ready || value.busy; });
    el('qsRefresh').disabled = value.busy || value.loading;
    el('qsApply').textContent = value.busy ? '正在保存…' : '应用更改';
    el('qsStatus').textContent = value.loading ? '正在读取设置…' : value.error || value.notice || '更改在应用后保存。';
    el('qsStatus').classList.toggle('qs-error', !!value.error);
  }
  function close(focus) {
    opened = false; panel.hidden = true; if (button) button.setAttribute('aria-expanded', 'false');
    if (focus && lastFocus && !lastFocus.hidden) lastFocus.focus();
  }
  function open() {
    if (!quick && context().kind !== 'manager') return;
    lastFocus = document.activeElement; opened = true; panel.hidden = false;
    if (button) button.setAttribute('aria-expanded', 'true');
    if (!quick && button) {
      var anchor = button.getBoundingClientRect();
      panel.style.top = Math.max(10, anchor.bottom + 10) + 'px';
      panel.style.right = Math.max(10, innerWidth - anchor.right) + 'px';
      panel.style.maxHeight = 'calc(100dvh - ' + (Math.max(10, anchor.bottom + 10) + 10) + 'px)';
    }
    publish(); refresh();
    el('qsClose').focus();
  }
  var button = quick ? el('toggleSettingsButton') : document.createElement('button');
  if (!quick) {
    button.id = 'assistantSettingsButton'; button.type = 'button'; button.className = 'icon-button';
    el('toggleSettingsButton').before(button);
  }
  function syncEntry() { if (!quick) button.hidden = context().kind !== 'manager'; }
  syncEntry();
  if (button) {
    button.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 3-.7 2.6-2 .9L4 6l-2 3 2 2v2l-2 2 2 3 2.3-.5 2 .9L9 21h6l.7-2.6 2-.9 2.3.5 2-3-2-2v-2l2-2-2-3-2.3.5-2-.9L15 3Z"/><circle cx="12" cy="12" r="3"/></svg>';
    button.setAttribute('aria-label', quick ? '对话设置' : '真理设置'); button.setAttribute('aria-controls', 'quickSettings');
    button.setAttribute('aria-expanded', 'false'); button.title = quick ? '对话设置' : '真理设置';
    button.addEventListener('click', function (event) { event.stopImmediatePropagation(); opened ? close(true) : open(); }, true);
  }
  el('qsClose').addEventListener('click', function () { close(true); });
  el('qsRefresh').addEventListener('click', function () { refresh(true); });
  el('qsForm').addEventListener('submit', function (event) { event.preventDefault(); update({ modelValue: el('qsModel').value, safetyMode: el('qsSafety').value, stream: el('qsStream').checked }); });
  panel.addEventListener('change', function () { owner = context().sessionId; draft = { modelValue: el('qsModel').value, safetyMode: el('qsSafety').value, stream: el('qsStream').checked }; });
  document.addEventListener('pointerdown', function (event) { if (opened && !panel.contains(event.target) && (!button || !button.contains(event.target))) close(false); });
  document.addEventListener('keydown', function (event) {
    if (!opened) return;
    if (event.key === 'Escape') { event.stopPropagation(); close(true); }
    if (event.key === 'Tab') {
      var nodes = Array.from(panel.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not(:disabled)'));
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('resize', function () { if (!quick && opened) close(false); });
  window.addEventListener('lka-session-context', function () {
    syncEntry();
    if (owner === context().sessionId) return;
    if (!quick) close(false);
    ++epoch; owner = context().sessionId; controller = null; draft = null; busy = loading = false; error = notice = '';
    publish(); if (opened || window.petBridge && typeof window.petBridge.setQuickSettingsState === 'function') refresh();
  });
}());
