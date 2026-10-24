(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  // Embedded conversations must never create another assistant workspace.
  if (params.get('embedded') || !window.LkaChatContext || !window.LkaMatterHost) return;
  // 真理 runs on the cloud. A node page reaches it directly; until the cloud
  // is signed in, the entry offers sign-in instead of a broken conversation.
  var lkaHost = window.LkaHost, viaHub = !!(lkaHost && lkaHost.hosted && lkaHost.role === 'replica');
  function cloudReady() { return !viaHub || lkaHost.cloudRouting; }
  var chat = window.LkaChatContext;
  if (!chat.get().workMode) return;
  var host = window.LkaMatterHost, manager = null, opened = false;
  var opening = null, refreshing = null, changing = false, generation = 0, selectedId = '';
  var connectionFailed = false, preparing = null, authEpoch = 0, selectionEpoch = 0;
  var contexts = new Map();
  var knownWaits = new Map(), attentionRuns = new Map(), attentionCheckOffset = 0;
  var goals = [], nextGoalOffset = null, events = new Map(), deliveries = new Map();
  var eventCursor = 0, deliveryCursor = 0, pending = [], attentionLimited = false, tab = 'attention';
  var root = document.createElement('aside');
  root.id = 'globalAssistantFollowup'; root.className = 'ga-workspace'; root.hidden = true; root.setAttribute('aria-label', '跟进面板');
  root.innerHTML = '<div class="ga-followup-heading"><div><h2 id="gaTitle">跟进</h2><p id="gaUpdated">目标与需要你决定的事</p></div><button id="gaRefresh" type="button" aria-label="刷新跟进" title="刷新跟进">↻</button></div>' +
    '<div class="ga-controller"><span id="gaState" role="status">尚未连接</span><button id="gaReconnect" type="button" aria-label="重新连接默认助手" title="重新连接默认助手">↻</button><button id="gaToggle" type="button" hidden></button></div>' +
    '<div id="gaNotice" class="ga-notice" role="status" aria-live="polite" hidden></div>' +
    '<div class="ga-tabs" role="tablist" aria-label="跟进视图"><button type="button" id="gaTab-attention" role="tab" data-tab="attention" aria-controls="gaRecords" aria-selected="true">待处理<span id="gaBadge" hidden></span></button><button type="button" id="gaTab-goals" role="tab" data-tab="goals" aria-controls="gaRecords" aria-selected="false" tabindex="-1">目标</button><button type="button" id="gaTab-deliveries" role="tab" data-tab="deliveries" aria-controls="gaRecords" aria-selected="false" tabindex="-1">交付记录</button></div><div id="gaRecords" class="ga-records" role="tabpanel" aria-labelledby="gaTab-attention" tabindex="0"></div><div class="ga-followup-foot"><p id="gaModeHelp">管理暂停时仍可对话、查看进展。启用后，助手可整理事项和委托任务。</p><button id="gaPlan" type="button">让真理整理接下来的安排</button></div>';
  document.getElementById('chatShell').appendChild(root);
  var connection = document.createElement('div'); connection.id = 'gaConnection'; connection.className = 'ga-connection'; connection.hidden = true;
  connection.innerHTML = '<span class="ga-emblem" aria-hidden="true">✦</span><h2>真理</h2><p id="gaConnectionText">正在连接真理…</p><button id="gaRetry" type="button" hidden>重新连接</button>';
  document.querySelector('.chat-main').prepend(connection);
  function el(id) { return document.getElementById(id); }
  function node(tag, className, text) { var n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; }
  function notice(text, bad) { var box = el('gaNotice'); box.textContent = text; box.hidden = !text; box.classList.toggle('ga-error', !!bad); }
  function problem(error) {
    if (error.detail === 'management_disabled') return '后端尚未启用真理。请先启用后端 management.enabled，再重新连接。';
    if (error.detail === 'default_manager_deleted') return '原真理已被删除。请在后端确认默认助手配置后重新连接。';
    if (error.detail === 'manager_not_found') return '这个助手已不可用。请重新连接默认助手，原对话草稿仍保留在本页。';
    if (error.status === 404) return '当前后端尚未提供真理接口，请接入包含管理智能体的后端版本。';
    if (error.status === 401 || error.status === 403) return '当前连接没有管理权限。请检查工作台配对或访问令牌。';
    if (error.status === 409) return '助手状态已在其他窗口改变。已读取最新状态，请核对后再操作。';
    return error.message || '连接失败，请检查后端服务后重试。';
  }
  function validate(value, expectedId) {
    if (!value || !value.session || value.session.kind !== 'manager' || !value.session.session_id || !value.controller || value.controller.session_id !== value.session.session_id || !Number.isInteger(value.controller.revision) || value.controller.revision < 1 || ['active', 'paused'].indexOf(value.controller.status) < 0) throw new Error('后端返回的真理信息不完整，请检查版本。');
    if (expectedId && value.session.session_id !== expectedId) throw new Error('助手会话身份不匹配，请重新连接。');
    return value;
  }
  function controller() {
    var active = manager && manager.controller.status === 'active';
    el('gaState').textContent = manager ? active ? '管理已启用' : '管理已暂停' : '尚未连接';
    el('gaState').classList.toggle('ga-active', !!active);
    if (connectionFailed) el('gaState').textContent = '连接异常';
    el('gaToggle').hidden = !manager; el('gaToggle').disabled = changing || connectionFailed || !!opening;
    el('gaToggle').textContent = changing ? '正在更新…' : active ? '暂停管理' : '启用管理';
    // Rendered as a switch: on = management active.
    el('gaToggle').setAttribute('role', 'switch'); el('gaToggle').setAttribute('aria-checked', String(!!active)); el('gaToggle').title = active ? '暂停管理' : '启用管理';
    // "管理" allows organizing and dispatching. Waking up on its own when a task
    // finishes is a separate server setting; say which one applies.
    var autonomy = manager && manager.autonomy, auto = !!(autonomy && autonomy.autonomous_enabled);
    var wake = !manager || !autonomy ? '' : auto ? '任务完成后，真理会在后台自动汇报。' : '任务完成后不会自动汇报；结果会等你下次发消息时处理（后台自动处理需在服务端开启）。';
    el('gaModeHelp').textContent = (active ? '助手可整理事项、委托任务。暂停管理后，已委托的任务仍会独立运行。' : '管理暂停时仍可对话、查看进展。启用后，助手可整理事项和委托任务。') + (active && wake ? ' ' + wake : '');
  }
  function managerPath(suffix) { return '/managers/' + encodeURIComponent(manager.session.session_id) + (suffix || ''); }
  function chatUrl(sessionId, runId) {
    var url = new URL('./chat.html', location.href), current = new URLSearchParams(location.search); url.search = '';
    url.searchParams.set('mode', 'work');
    // Hosted pages carry their host role; local pages keep the gateway address.
    if (window.LkaHost && window.LkaHost.hosted) url.searchParams.set('host', window.LkaHost.role);
    else url.searchParams.set('backend', host.backend);
    if (current.get('layout') === 'mobile') url.searchParams.set('layout', 'mobile');
    url.searchParams.set('session_id', sessionId);
    if (runId) url.searchParams.set('run_id', runId);
    return url.href;
  }
  function time(value) { var d = new Date(value); return isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function empty(title, description) { var n = node('div', 'ga-empty'); n.appendChild(node('strong', '', title)); n.appendChild(node('p', '', description)); return n; }
  function record(title, status, detail) { var row = node('article', 'ga-record'); var heading = node('div', 'ga-record-heading'); heading.appendChild(node('strong', '', title)); if (status) heading.appendChild(node('span', 'ga-record-status', status)); row.appendChild(heading); if (detail) row.appendChild(node('p', 'ga-record-detail', detail)); return row; }
  // Goal objectives are long briefs; show only the leading name, e.g.
  // "每日邮件整理工作线（用户…）：每天自动…" -> "每日邮件整理工作线".
  function goalTitle(objective) {
    var first = String(objective || '').split(/\r?\n/)[0].trim();
    var cut = first.search(/[（(：:。；;]/);
    var title = (cut > 0 ? first.slice(0, cut) : first).trim();
    if (!title) title = first;
    return Array.from(title).length > 28 ? Array.from(title).slice(0, 27).join('') + '…' : title;
  }
  // Opens in this page: a remote task goes to its review detail (approvals live
  // in the task report on the cloud); an ordinary task switches the conversation.
  // The href keeps host/layout/run for a deliberate new tab, which restores its
  // own session from the shared cookie.
  function runLink(row, sessionId, runId, title, run) {
    if (!sessionId || !runId) return;
    var link = node('a', 'ga-record-link', title); link.href = chatUrl(sessionId, runId);
    link.addEventListener('click', function (event) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      var remote = run && run.remote_execution;
      if (remote && remote.task_id && window.LkaCluster) { window.LkaCluster.openRemoteTask(remote.task_id); return; }
      close();
      Promise.resolve(chat.openSession(sessionId)).catch(function (error) { notice(problem(error), true); });
    });
    row.appendChild(link);
  }
  function render() {
    var list = el('gaRecords'); list.replaceChildren();
    el('gaBadge').hidden = !pending.length; el('gaBadge').textContent = pending.length;
    if (!manager) { list.appendChild(empty('连接后显示跟进', '对话、目标与交付都归属于同一个真理。')); return; }
    if (tab === 'attention') {
      if (!pending.length) list.appendChild(empty(attentionLimited ? '还有等待提醒需要核对' : '暂时不需要你处理', '任务需要补充信息或操作确认时，会在这里提醒。'));
      pending.forEach(function (run) {
        var question = run.pending_user_question, remote = run.remote_execution;
        var heading = run.status === 'waiting_confirmation' ? '任务等待你的确认' : '任务需要补充信息';
        var where = remote ? '在 ' + (remote.node_id || '设备') + (remote.workspace_id ? ' · ' + remote.workspace_id : '') + ' 上执行。' : '';
        var row = record(heading, remote ? '远程任务' : '待处理', where + (question && (question.question || question.prompt) || (remote ? '查看操作详情并批准或拒绝。' : '打开原任务查看具体内容，并在那里处理。')));
        runLink(row, run.session_id, run.run_id, remote ? (run.status === 'waiting_confirmation' ? '查看并确认' : '查看并回答') : '打开原任务', run); list.appendChild(row);
      });
      if (attentionLimited) { list.appendChild(node('p', 'ga-list-note', '等待提醒较多，每次核对20项。已确认的待处理任务会保留，直到确认其状态变化。')); var next = node('button', 'ga-more', '继续核对等待提醒'); next.type = 'button'; next.onclick = refresh; list.appendChild(next); }
    } else if (tab === 'goals') {
      if (!goals.length) list.appendChild(empty('还没有持续跟进的目标', '在左侧告诉真理你想完成什么，以及何时需要再次跟进。'));
      var labels = { active: '跟进中', waiting: '等待中', paused: '已暂停', completed: '跟进已结束', cancelled: '已取消跟进' };
      goals.forEach(function (goal) {
        var finishedMatter = goal.matter_status === 'done' || goal.matter_status === 'cancelled';
        var label = finishedMatter ? goal.matter_status === 'done' ? '事项已完成' : '事项已取消' : labels[goal.status] || goal.status;
        var row = record(goalTitle(goal.objective), label, '');
        row.title = goal.objective;
        if (!finishedMatter && goal.next_wake_at) row.querySelector('.ga-record-heading').appendChild(node('small', 'ga-record-when', time(goal.next_wake_at)));
        var button = node('button', 'ga-record-link', '和真理讨论'); button.type = 'button'; button.onclick = function () { draft('请帮我查看这个目标的进展，并讨论下一步：\n' + goal.objective + '\n目标编号：' + goal.goal_id); }; row.appendChild(button); list.appendChild(row);
      });
      if (nextGoalOffset !== null) { var more = node('button', 'ga-more', '加载更多目标'); more.type = 'button'; more.onclick = async function () { more.disabled = true; try { await loadGoals(false); render(); } catch (e) { notice(problem(e), true); more.disabled = false; } }; list.appendChild(more); }
    } else {
      var rows = Array.from(deliveries.values()).sort(function (a, b) { return b.cursor - a.cursor; });
      if (!rows.length) list.appendChild(empty('交付记录会留在这里', '助手完成跟进并将结果写入对话后，可在这里重新打开记录。'));
      rows.forEach(function (delivery) {
        // Older backends send no topic; keep the generic label for them.
        var row = record(delivery.topic || '一份跟进结果已送达', '', '');
        row.querySelector('.ga-record-heading').appendChild(node('small', 'ga-record-when', time(delivery.created_at)));
        runLink(row, delivery.session_id, delivery.run_id, '查看本次对话记录', null); list.appendChild(row);
      });
      if (rows.length) list.appendChild(node('p', 'ga-list-note', '交付表示已有回复；目标是否完成，以目标状态和结果内容为准。'));
    }
  }
  async function loadGoals(reset) {
    var scope = generation, desired = reset ? Math.max(50, goals.length) : 50;
    var offset = reset ? 0 : nextGoalOffset;
    if (offset === null) return;
    var response = await host.request(managerPath('/goals') + '?limit=50&offset=' + offset);
    if (scope !== generation) return;
    if (!Array.isArray(response.goals)) throw new Error('目标列表响应不完整。');
    goals = reset ? response.goals : goals.concat(response.goals); nextGoalOffset = response.next_offset == null ? null : response.next_offset;
    while (reset && goals.length < desired && nextGoalOffset !== null) await loadGoals(false);
  }
  async function feed(kind) {
    var scope = generation;
    var cursor = kind === 'events' ? eventCursor : deliveryCursor, records = kind === 'events' ? events : deliveries;
    // Bounded catch-up continues on the next refresh. Advance on each returned row,
    // including the final page whose next_after is null.
    for (var page = 0; page < 4; page++) {
      var response = await host.request(managerPath('/' + kind) + '?after=' + cursor + '&limit=100');
      if (scope !== generation) return;
      if (!Array.isArray(response[kind])) throw new Error('跟进记录响应不完整。');
      response[kind].forEach(function (row) {
        var n = Number(kind === 'events' ? row.event_id : row.cursor);
        if (!Number.isSafeInteger(n) || n <= cursor) return;
        records.set(kind === 'events' ? row.event_id : row.delivery_id, row); cursor = Math.max(cursor, n);
        if (kind === 'events') { var payload = row.payload || {}; if (payload.run_id && payload.task_waiting === true) knownWaits.set(payload.run_id, payload); else if (row.kind === 'task_terminal' && payload.run_id) { knownWaits.delete(payload.run_id); attentionRuns.delete(payload.run_id); } }
      });
      if (kind === 'events') eventCursor = cursor; else deliveryCursor = cursor;
      while (records.size > 500) records.delete(records.keys().next().value);
      if (response.next_after == null) break;
    }
  }
  async function currentAttention() {
    var scope = generation;
    var waiting = Array.from(knownWaits.values());
    attentionLimited = waiting.length > 20;
    var candidates = [], count = Math.min(20, waiting.length);
    for (var i = 0; i < count; i++) candidates.push(waiting[(attentionCheckOffset + i) % waiting.length]);
    attentionCheckOffset = waiting.length ? (attentionCheckOffset + count) % waiting.length : 0;
    var checked = await Promise.allSettled(candidates.map(async function (p) {
      var run = await host.request('/agent/runs/' + encodeURIComponent(p.run_id));
      if (run.run_id !== p.run_id || run.parent_run_id || ['waiting_user', 'waiting_confirmation'].indexOf(run.status) < 0) return null;
      // A new question in the same waiting run is still a real pending decision.
      return run;
    }));
    if (scope !== generation) return;
    checked.forEach(function (result, index) {
      var id = candidates[index].run_id;
      if (result.status === 'fulfilled' && result.value) attentionRuns.set(id, result.value);
      else if (result.status === 'fulfilled' || result.reason.status === 404) { attentionRuns.delete(id); knownWaits.delete(id); }
    });
    pending = Array.from(attentionRuns.values());
    attentionLimited = knownWaits.size > 20;
    if (checked.some(function (r) { return r.status === 'rejected' && r.reason.status !== 404; })) throw new Error('部分任务状态暂时无法核对，请刷新后重试。');
  }

  async function refresh() {
    if (!manager) return;
    if (refreshing) return refreshing;
    var current = generation, previousDeliveryCursor = deliveryCursor;
    el('gaRefresh').disabled = true;
    refreshing = (async function () {
      try {
        var value = validate(await host.request(managerPath()), selectedId);
        if (current !== generation) return;
        if (!manager || value.controller.revision >= manager.controller.revision) manager = value; connectionFailed = false; publishController(); controller();
        await Promise.all([loadGoals(true), feed('events'), feed('deliveries')]);
        if (current !== generation) return;
        await currentAttention();
        if (current !== generation) return;
        render(); el('gaUpdated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        if (deliveryCursor > previousDeliveryCursor && isSelected(manager.session.session_id)) await chat.refreshConversation();
        if (deliveryCursor > previousDeliveryCursor) window.dispatchEvent(new CustomEvent('lka-matter-agent-finished', { detail: { sessionId: manager.session.session_id } }));
      } catch (e) { if (current === generation) { if (e.status === 404 || e.status === 401 || e.status === 403 || e.detail === 'management_disabled') { connectionFailed = true; controller(); } notice(problem(e), true); el('gaUpdated').textContent = '刷新失败，保留上次结果'; } }
      finally { if (current === generation) { refreshing = null; el('gaRefresh').disabled = false; } }
    })();
    return refreshing;
  }
  function isSelected(id) { var view = chat.get(); return view.kind === 'manager' && view.sessionId === id; }
  function saveContext() {
    if (!manager) return;
    contexts.set(selectedId, { manager: manager, knownWaits: knownWaits, attentionRuns: attentionRuns, attentionCheckOffset: attentionCheckOffset,
      goals: goals, nextGoalOffset: nextGoalOffset, events: events, deliveries: deliveries, eventCursor: eventCursor, deliveryCursor: deliveryCursor,
      pending: pending, attentionLimited: attentionLimited });
  }
  function adopt(value) {
    var id = value.session.session_id;
    if (selectedId !== id) {
      saveContext(); generation++; selectedId = id;
      var saved = contexts.get(id) || {};
      knownWaits = saved.knownWaits || new Map(); attentionRuns = saved.attentionRuns || new Map(); attentionCheckOffset = saved.attentionCheckOffset || 0;
      goals = saved.goals || []; nextGoalOffset = saved.nextGoalOffset == null ? null : saved.nextGoalOffset;
      events = saved.events || new Map(); deliveries = saved.deliveries || new Map(); eventCursor = saved.eventCursor || 0; deliveryCursor = saved.deliveryCursor || 0;
      pending = saved.pending || []; attentionLimited = !!saved.attentionLimited; refreshing = null; changing = false; el('gaRefresh').disabled = false;
      manager = saved.manager || null;
    }
    if (!manager || value.controller.revision >= manager.controller.revision) manager = value;
    connectionFailed = false; saveContext(); controller(); render();
  }
  function publishController() { if (manager && chat.acceptAssistantSettings) chat.acceptAssistantSettings(manager); }
  function prepare() {
    if (!cloudReady()) return Promise.resolve(null);
    if (preparing) return preparing;
    var scope = authEpoch;
    preparing = (async function () {
      try {
        var value = validate(await chat.prepareAssistant());
        if (scope !== authEpoch) return null;
        if (!manager || selectedId === value.session.session_id) { adopt(value); await refresh(); }
        else contexts.set(value.session.session_id, { manager: value });
        return value;
      } catch (error) { if (scope === authEpoch) { connectionFailed = true; controller(); } throw error; }
    })();
    return preparing;
  }
  function visibility(show) {
    opened = show; root.hidden = !show; document.body.classList.toggle('global-assistant-open', show);
    var entry = el('openGlobalAssistant');
    if (entry) { entry.classList.toggle('active', show); if (show) entry.setAttribute('aria-current', 'page'); else entry.removeAttribute('aria-current'); }
    window.dispatchEvent(new CustomEvent('lka-global-assistant-layout'));
  }
  function connecting() {
    visibility(true); connection.hidden = false; el('gaRetry').hidden = true;
    el('gaConnectionText').textContent = '正在连接真理…';
    document.body.classList.add('global-assistant-loading'); document.body.classList.remove('global-assistant-error');
  }
  function connected() {
    connection.hidden = true; document.body.classList.remove('global-assistant-loading', 'global-assistant-error');
  }
  function failed(error) {
    connectionFailed = true; controller(); connection.hidden = false; el('gaConnectionText').textContent = problem(error); el('gaRetry').hidden = false;
    document.body.classList.remove('global-assistant-loading'); document.body.classList.add('global-assistant-error'); render();
  }
  async function connect(options) {
    if (!cloudReady()) {
      // The entry stays: sign in to the cloud from this device, then talk.
      if (window.LkaCluster) window.LkaCluster.openCloudSignIn();
      return;
    }
    if (opening) return opening;
    var current = authEpoch, selected = ++selectionEpoch, manual = !!(options && options.refresh);
    if (!manager) connecting();
    var operation = (async function () {
      try {
        var value = validate(await chat.openAssistant(manual ? { refresh: true } : undefined));
        if (current !== authEpoch || selected !== selectionEpoch || !isSelected(value.session.session_id)) return;
        adopt(value); connected(); visibility(true); publishController(); notice('', false);
        if (manual) { preparing = Promise.resolve(value); await refresh(); }
        else if (!preparing) { preparing = Promise.resolve(value); await refresh(); }
      } catch (e) { if (current === authEpoch && selected === selectionEpoch) failed(e); }
      finally { if (opening === operation) { opening = null; controller(); } }
    })();
    opening = operation; controller(); return operation;
  }
  async function selection() {
    var view = chat.get();
    if (view.kind !== 'manager') {
      if (opening && chat.assistantState && chat.assistantState().loading) return;
      selectionEpoch++; opening = null; visibility(false); connected(); return;
    }
    visibility(true);
    if (opening) return;
    if (selectedId === view.sessionId && manager) { connected(); controller(); return; }
    var scope = authEpoch, selected = ++selectionEpoch;
    try {
      // Startup preparation never changes the user's selected ordinary session.
      await prepare();
      if (scope !== authEpoch || selected !== selectionEpoch || !isSelected(view.sessionId)) return;
      var cached = contexts.get(view.sessionId);
      if (cached) { adopt(cached.manager); connected(); return; }
      connecting();
      var value = validate(await host.request('/managers/' + encodeURIComponent(view.sessionId)), view.sessionId);
      if (scope !== authEpoch || selected !== selectionEpoch || !isSelected(view.sessionId)) return;
      if (chat.ensureAssistantWorkspace) value = validate(await chat.ensureAssistantWorkspace(value), view.sessionId);
      if (scope !== authEpoch || selected !== selectionEpoch || !isSelected(view.sessionId)) return;
      if (chat.restoreAssistantConversation) await chat.restoreAssistantConversation(view.sessionId);
      if (scope !== authEpoch || selected !== selectionEpoch || !isSelected(view.sessionId)) return;
      adopt(value); connected(); await refresh();
    } catch (e) { if (scope === authEpoch && selected === selectionEpoch && isSelected(view.sessionId)) failed(e); }
  }
  function draft(text) { if (manager && isSelected(manager.session.session_id)) chat.prepareMatterDraft(text); }
  function open() { return connect(); }
  function close() { visibility(false); connected(); }
  el('gaToggle').onclick = async function () {
    if (!manager || changing) return;
    var scope = generation;
    changing = true; controller(); notice('', false);
    try { var value = validate(await host.request(managerPath(), 'PATCH', { expected_revision: manager.controller.revision, status: manager.controller.status === 'active' ? 'paused' : 'active' }), selectedId); if (scope === generation && (!manager || value.controller.revision >= manager.controller.revision)) manager = value; }
    catch (e) { if (scope !== generation) return; if (e.status === 409) { try { var latest = validate(await host.request(managerPath()), selectedId); if (scope === generation) manager = latest; } catch (_) {} } if (scope === generation) notice(problem(e), true); }
    finally { if (scope === generation) { changing = false; publishController(); saveContext(); controller(); } }
  };
  function reconnect() { return connect({ refresh: true }); }
  el('gaReconnect').onclick = reconnect;
  el('gaRetry').onclick = reconnect; el('gaRefresh').onclick = function () { notice('', false); refresh(); };
  el('gaPlan').onclick = function () { draft('请帮我梳理接下来需要关注的目标和任务，先列出当前进展与待决定的问题，再和我讨论下一步安排。'); };
  root.querySelector('.ga-tabs').addEventListener('click', function (event) { var button = event.target.closest('[data-tab]'); if (!button) return; tab = button.dataset.tab; root.querySelectorAll('[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b === button)); b.tabIndex = b === button ? 0 : -1; }); el('gaRecords').setAttribute('aria-labelledby', button.id); render(); });
  root.querySelector('.ga-tabs').addEventListener('keydown', function (event) { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(event.key) < 0) return; event.preventDefault(); var buttons = Array.from(root.querySelectorAll('[data-tab]')), i = buttons.indexOf(document.activeElement); i = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length; buttons[i].click(); buttons[i].focus(); });
  window.addEventListener('lka-session-context', selection);
  window.addEventListener('lka-agent-turn-finished', function () { if (manager) refresh(); });
  window.addEventListener('lka-quick-assistant-state', function (event) {
    var value = event.detail && event.detail.manager;
    if (!value || !manager || !value.session || value.session.session_id !== selectedId || !value.controller || value.controller.revision <= manager.controller.revision) return;
    try { manager = validate(value, selectedId); saveContext(); controller(); } catch (_) {}
  });
  window.addEventListener('lka-matter-auth-changed', function () {
    authEpoch++; generation++; selectionEpoch++; contexts.clear(); manager = null; selectedId = ''; preparing = opening = refreshing = null;
    connectionFailed = false; changing = false; knownWaits = new Map(); attentionRuns = new Map(); attentionCheckOffset = 0; goals = []; nextGoalOffset = null; events = new Map(); deliveries = new Map(); eventCursor = deliveryCursor = 0; pending = []; attentionLimited = false; controller(); render(); connected();
    prepare().then(selection).catch(function (error) { if (opened) failed(error); });
  });
  ['openGlobalAssistant'].forEach(function (id) { var button = el(id); if (button) button.onclick = open; });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  window.setInterval(function () { if (!document.hidden) refresh(); }, 8000);
  window.LkaGlobalAssistant = { open: open, close: close, isOpen: function () { return opened; } };
  // On a node page, wait for the hub check; sign-in later replays auth-changed.
  (viaHub ? lkaHost.hubReady : Promise.resolve()).then(function () {
    return prepare().then(function () { if (viaHub && params.get('assistant') === 'global' && cloudReady()) open(); });
  }).catch(function () { /* Ordinary work remains available when background preparation fails. */ });
  if (!viaHub && params.get('assistant') === 'global') open(); else selection();
})();
