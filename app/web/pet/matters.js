(function () {
  'use strict';
  if (!window.LkaMatterHost || !window.LkaMatterStore) return;
  var host = window.LkaMatterHost, store, rows = [], snapshot = {}, drafts = new Map(), activeDraft = null;
  var calendarScroll = {}, pendingWrites = new Set(), undoAction = null, noticeTimer, dateTarget = null, previousFocus, lastListScope, lastCalendarAnchor, lastTray, layoutFrame, monthCompact = innerHeight < 760;
  var state = { view: 'today', plan: null, directory: null, selected: null, query: '', calendarMode: 'week', anchor: day(new Date()) };
  var opened = false, started = false, adding = false, directories = null, assistantLoaded = false, assistantManager = null, storeNamespace = null;
  var statusNames = { open: '待办', in_progress: '进行中', waiting: '等待中', done: '已完成', cancelled: '已取消' };
  var views = { inbox: ['收集箱', '先记下来，再决定何时做。'], today: ['今天', '把注意力留给今天要推进的事。'], upcoming: ['接下来', '看看未来的安排，给行动留出时间。'], calendar: ['日历', '把行动放进时间里。'], projects: ['项目规划', '从目标走到下一步。'], all: ['全部任务', '查看所有尚未完成的行动。'], history: ['完成记录', '已经完成和取消的事项。'] };
  var paths = { inbox: 'M4 4h16v16H4z M4 13h5l2 3h2l2-3h5', today: 'M5 5h14v15H5z M8 3v4m8-4v4M5 10h14m-10 4h3v3H9z', upcoming: 'M5 5h14v15H5z M8 3v4m8-4v4M5 10h14m-6 3 3 3-3 3m-5-3h8', calendar: 'M4 5h16v15H4z M8 3v4m8-4v4M4 10h16m-12 4h1m3 0h1m3 0h1m-9 3h1m3 0h1', projects: 'M4 7h6l2 2h8v11H4z M4 7V4h6l2 3h8v2', all: 'M9 6h11M9 12h11M9 18h11M4 6h.1M4 12h.1M4 18h.1', history: 'M4 11a8 8 0 1 1 2 7M4 5v6h6m2-4v5l3 2', plus: 'M12 5v14M5 12h14', date: 'M4 5h16v15H4z M8 3v4m8-4v4M4 10h16', search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', back: 'm10 6-6 6 6 6M4 12h16', spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z', sync: 'M20 7v5h-5M4 17v-5h5M5 8a7 7 0 0 1 12-3l3 3M4 16l3 3a7 7 0 0 0 12-3', close: 'm6 6 12 12M18 6 6 18' };
  function icon(name) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (paths[name] || paths.all) + '"/></svg>'; }
  var root = document.createElement('section'); root.id = 'matterWorkspace'; root.className = 'mw'; root.tabIndex = -1; root.hidden = true; root.setAttribute('aria-label', '待办与项目规划');
  root.innerHTML = '<aside class="mw-sidebar"><div class="mw-brand"><span class="mw-brand-mark">理</span><strong>理事所<small>待办与规划</small></strong><button id="matterToggleNav" aria-label="收起导航" aria-controls="matterNav" aria-expanded="true" title="收起导航">' + icon('back') + '</button></div><button id="matterNewTask" class="mw-new-task">' + icon('plus') + '新建任务<kbd>N</kbd></button><nav id="matterNav" aria-label="待办视图"></nav><div class="mw-sidebar-foot"><button id="matterBack">返回对话工作台</button><details id="matterConnection"><summary>连接设置</summary><form id="matterTokenForm"><label>访问令牌<input id="matterToken" type="password" autocomplete="off"></label><button>应用</button></form></details><p id="matterDate"></p><span id="matterCacheState"></span></div></aside>' +
    '<main class="mw-main"><header class="mw-heading"><div class="mw-title-block"><div class="mw-titleline"><h1 id="matterTitle"></h1><span id="matterCount"></span></div><p id="matterSubtitle"></p></div><div class="mw-actions"><label class="mw-search">' + icon('search') + '<input id="matterSearch" type="search" placeholder="搜索标题和说明" aria-label="搜索事项" maxlength="500"></label><div class="mw-command-buttons"><button id="matterRefresh" class="mw-icon-button" aria-label="同步最新事项" title="同步最新事项">' + icon('sync') + '</button><button id="matterAsk">' + icon('spark') + '对话管理</button><button id="matterNewPlan" class="mw-primary" hidden>新建规划</button></div></div></header>' +
    '<div class="mw-filter" id="matterFilter" hidden><button id="matterDirectory" hidden></button></div>' +
    '<div id="matterPlanHeader"></div><form id="matterQuickForm" class="mw-quick">' + icon('plus') + '<input id="matterQuickTitle" required maxlength="500" autocomplete="off" aria-label="添加待办" placeholder="添加任务，支持「明天 15:00 整理资料」"><button class="mw-primary">添加</button><p id="matterParseHint"></p></form>' +
    '<div id="matterContent" class="mw-content"><div id="matterList" class="mw-list"></div><div id="matterCalendar" hidden></div></div></main>' +
    '<aside id="matterEditor" class="mw-editor" hidden aria-label="事项详情"></aside><aside id="matterAssistant" class="mw-assistant" hidden><header><strong>对话管理</strong><span id="matterManagerStatus"></span><button id="matterManagerToggle" hidden></button><button id="matterAssistantClose" aria-label="关闭对话管理">×</button></header><p class="mw-assistant-hint">描述目标、拆分行动或调整安排。发送前可以修改，下方沿用现有工具确认流程。</p><div id="matterAssistantBody"></div></aside>';
  document.body.appendChild(root);
  var backdrop = document.createElement('button'); backdrop.className = 'mw-pane-backdrop'; backdrop.hidden = true; backdrop.setAttribute('aria-label','收起侧面板'); backdrop.onclick = function () { if (!el('matterEditor').hidden) el('matterEditorClose').click(); else el('matterAssistantClose').click(); }; root.appendChild(backdrop);
  function updateLayout() {
    var pane = !el('matterEditor').hidden ? 'editor' : !el('matterAssistant').hidden ? 'assistant' : 'none';
    var rail = innerWidth <= 650 || state.navCollapsed === true || state.navCollapsed == null && (innerWidth < 780 || pane !== 'none' && innerWidth < 1200);
    root.dataset.pane = pane; root.dataset.nav = rail ? 'rail' : 'full';
    var toggle = el('matterToggleNav'); toggle.setAttribute('aria-expanded', String(!rail)); var toggleText = rail ? '展开导航' : '收起导航'; toggle.title = toggleText; toggle.setAttribute('aria-label',toggleText);
    backdrop.hidden = pane === 'none' || innerWidth >= 900; ['.mw-main','.mw-sidebar'].forEach(function(selector){var node=root.querySelector(selector);if(!backdrop.hidden){node.setAttribute('inert','');node.setAttribute('aria-hidden','true');}else{node.removeAttribute('inert');node.removeAttribute('aria-hidden');}});
    var main = root.querySelector('.mw-main'), content = el('matterContent'), width = main.getBoundingClientRect().width;
    var calendarRail = width >= 1020 && content.clientHeight >= 450;
    root.dataset.calendarRail = String(calendarRail);
    var tray = root.querySelector('.mc-tray'); if (tray && tray !== lastTray) { tray.open = calendarRail; lastTray = tray; }
    else if (tray && !calendarRail && tray.dataset.lastRail === 'true') tray.open = false;
    if (tray) tray.dataset.lastRail = String(calendarRail);
    var box = main.getBoundingClientRect(); root.style.setProperty('--mw-notice-left', (box.left + box.width / 2) + 'px'); root.style.setProperty('--mw-notice-width', Math.max(240, box.width - 32) + 'px');
  }
  function requestLayout() { if (layoutFrame) return; layoutFrame = requestAnimationFrame(function () { layoutFrame = null; if (state.view === 'calendar' && state.calendarMode === 'month' && monthCompact !== (innerHeight < 760)) { monthCompact = innerHeight < 760; renderList(); } else updateLayout(); }); }
  var paneObserver = new MutationObserver(requestLayout); ['matterEditor','matterAssistant'].forEach(function(id){paneObserver.observe(el(id),{attributes:true,attributeFilter:['hidden']});});
  if (window.ResizeObserver) { var sizeObserver = new ResizeObserver(requestLayout); sizeObserver.observe(root); sizeObserver.observe(root.querySelector('.mw-main')); }
  window.addEventListener('resize',requestLayout);
  el('matterToggleNav').onclick = function () { state.navCollapsed = root.dataset.nav !== 'rail'; saveView(); updateLayout(); };
  el('matterContent').addEventListener('scroll',function(){ if (!dateMenu.hidden) closeDateMenu(); });
  var feedback = document.createElement('div'); feedback.className = 'mw-feedback'; feedback.hidden = true; feedback.innerHTML = '<p id="matterStatus" role="status" aria-live="polite"></p><button id="matterUndo" hidden>撤销</button><button id="matterDismissNotice" aria-label="关闭提示">×</button>'; root.appendChild(feedback);
  var dateMenu = document.createElement('div'); dateMenu.className = 'mw-date-popover'; dateMenu.hidden = true; dateMenu.setAttribute('role','dialog'); dateMenu.setAttribute('aria-label','安排任务'); root.appendChild(dateMenu);
  function el(id) { return document.getElementById(id); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function day(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dateOnly(v) { return !v ? '' : /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : day(new Date(v)); }
  function dayAfter(n) { var d = new Date(); d.setDate(d.getDate() + n); return day(d); }
  function localTime(v) { if (!v) return ''; var d = new Date(v); return day(d) + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function active(r) { return r.status !== 'done' && r.status !== 'cancelled'; }
  function protectedRow(r) { return (r.source_links || []).some(function (s) { return s.source_type === 'message_history_message'; }); }
  function plannedDay(r) { return r.scheduled_start ? dateOnly(r.scheduled_start) : r.scheduled_on || ''; }
  function lookup(id) { return rows.find(function (r) { return r.matter_id === id; }); }
  function note(s, bad, undo) { clearTimeout(noticeTimer); undoAction = undo || null; el('matterStatus').textContent = s || ''; feedback.hidden = !s; feedback.classList.toggle('mw-error', !!bad); el('matterUndo').hidden = !undoAction; if (s && !bad) noticeTimer = setTimeout(function () { feedback.hidden = true; undoAction = null; }, undo ? 9000 : 3500); }
  el('matterUndo').onclick = function () { var operation = undoAction; undoAction = null; el('matterUndo').hidden = true; if (operation) operation(); };
  el('matterDismissNotice').onclick = function () { feedback.hidden = true; };
  function closeDateMenu() { dateMenu.hidden = true; dateTarget = null; }
  function openDateMenu(id, target) { var r = lookup(id); if (!r || protectedRow(r)) return; dateTarget = id; var monday = new Date(); monday.setDate(monday.getDate() + (8 - (monday.getDay() || 7))); dateMenu.innerHTML = '<strong>安排时间</strong><p>' + esc(r.title) + '</p><button data-date-choice="' + dayAfter(0) + '">今天<small>' + dayAfter(0).slice(5) + '</small></button><button data-date-choice="' + dayAfter(1) + '">明天<small>' + dayAfter(1).slice(5) + '</small></button><button data-date-choice="' + day(monday) + '">下周一<small>' + day(monday).slice(5) + '</small></button><label>选择日期<input type="date" id="matterRowDate" value="' + plannedDay(r) + '"></label><button data-date-choice="clear" class="mw-date-clear">移除安排</button>'; dateMenu.hidden = false; var box = target.getBoundingClientRect(); dateMenu.style.left = Math.max(12, Math.min(box.left - 160, innerWidth - 252)) + 'px'; dateMenu.style.top = Math.max(12, Math.min(box.bottom + 8, innerHeight - 342)) + 'px'; dateMenu.querySelector('button').focus(); }
  dateMenu.onclick = function (e) { var choice = e.target.closest('[data-date-choice]'); if (!choice) return; var id = dateTarget, r = lookup(id), value = choice.dataset.dateChoice; closeDateMenu(); if (r) schedule(id, value === 'clear' ? {scheduled_on:null, scheduled_start:null, scheduled_end:null} : window.LkaMatterCalendar.schedulePatch(r,value)); };
  dateMenu.onchange = function (e) { if (e.target.id !== 'matterRowDate' || !e.target.value) return; var r = lookup(dateTarget), value = e.target.value; closeDateMenu(); if (r) schedule(r.matter_id,window.LkaMatterCalendar.schedulePatch(r,value)); };
  document.addEventListener('pointerdown',function(e){if(!dateMenu.hidden && !dateMenu.contains(e.target) && !e.target.closest('[data-row-date]')) closeDateMenu();});
  function errorText(e) { if (e.status === 409) return '事项已在其他入口修改。草稿已保留，请载入最新版本，核对后再保存。'; if (e.status === 403) return '这项操作需要专用审批，请到消息中心处理来源事项。'; if (e.status === 401) { el('matterConnection').open = true; return '连接需要访问令牌，请展开连接设置。'; } return e.message || String(e); }
  function saveView() { if (store) store.saveView(state); }
  function scoped() { return rows.filter(function (r) { return !state.directory || r.project_id === state.directory.project_id; }); }
  function match(r) { return !state.query || (r.title + ' ' + r.summary).toLowerCase().includes(state.query.toLowerCase()); }
  function compare(a, b) { return (a.sort_order || 0) - (b.sort_order || 0) || String(a.created_at).localeCompare(String(b.created_at)) || a.matter_id.localeCompare(b.matter_id); }
  function planProgress(r) { var p = r.progress || {}, total = (p.total || 0) - (p.cancelled || 0); return (p.done || 0) + ' / ' + total + ' 已完成'; }
  function renderNav() {
    var data = scoped(), task = data.filter(function (r) { return r.kind !== 'plan' && active(r); });
    el('matterNav').innerHTML = Object.keys(views).map(function (v) {
      var count = v === 'inbox' ? task.filter(function (r) { return r.inbox; }).length : v === 'today' ? task.filter(function (r) { return plannedDay(r) === dayAfter(0) || dateOnly(r.due_at) === dayAfter(0); }).length : v === 'projects' ? data.filter(function (r) { return r.kind === 'plan' && active(r); }).length : null;
      return '<button title="' + views[v][0] + '" aria-label="' + views[v][0] + '" data-matter-view="' + v + '" aria-current="' + (state.view === v ? 'page' : 'false') + '">' + icon(v) + '<span>' + views[v][0] + '</span>' + (count != null ? '<small>' + count + '</small>' : '') + '</button>';
    }).join('');
  }
  function metadata(r) {
    var pieces = [], d = plannedDay(r), today = dayAfter(0), parent = lookup(r.parent_matter_id);
    if (r.scheduled_start) pieces.push('<span>' + (d === today ? '今天' : d) + ' ' + localTime(r.scheduled_start).slice(11) + '–' + localTime(r.scheduled_end).slice(11) + '</span>');
    else if (d) pieces.push('<span>' + (d === today ? '今天安排' : d + ' 安排') + '</span>');
    if (r.due_at) pieces.push('<span class="' + (active(r) && dateOnly(r.due_at) < today ? 'mw-overdue' : '') + '">截止 ' + esc(dateOnly(r.due_at)) + '</span>');
    if (parent && state.plan !== parent.matter_id) pieces.push('<span>' + esc(parent.title) + '</span>');
    if (r.status === 'waiting') pieces.push('<span>等待中</span>');
    if (r.priority === 'high' || r.priority === 'urgent') pieces.push('<span class="mw-priority">' + (r.priority === 'urgent' ? '紧急' : '高优先') + '</span>');
    if (protectedRow(r)) pieces.push('<span>消息来源 · 需审批</span>');
    return pieces.join('');
  }
  function rowHTML(r, index) {
    return '<article class="mw-row' + (state.selected === r.matter_id ? ' mw-selected' : '') + '" data-row="' + esc(r.matter_id) + '" draggable="' + (!protectedRow(r) && active(r)) + '"><button class="mw-check" data-complete="' + esc(r.matter_id) + '" aria-label="' + (active(r) ? '完成 ' : '重新打开 ') + esc(r.title) + '" aria-pressed="' + !active(r) + '"' + (protectedRow(r) ? ' disabled' : '') + '>' + (!active(r) ? '✓' : '') + '</button><button class="mw-row-content" data-matter-open="' + esc(r.matter_id) + '"><strong>' + esc(r.title) + '</strong><span class="mw-meta">' + metadata(r) + '</span></button>' + (active(r) && !protectedRow(r) ? '<button class="mw-row-date" data-row-date="' + esc(r.matter_id) + '" title="安排时间" aria-label="安排 ' + esc(r.title) + '">' + icon('date') + '</button>' : '') + (state.plan && active(r) && !protectedRow(r) ? '<button class="mw-move" data-move="' + esc(r.matter_id) + '" data-direction="-1" aria-label="上移 ' + esc(r.title) + '">↑</button><button class="mw-move" data-move="' + esc(r.matter_id) + '" data-direction="1" aria-label="下移 ' + esc(r.title) + '">↓</button>' : '') + '</article>';
  }
  function group(title, items, options) { options = options || {}; return '<section class="mw-group' + (!items.length ? ' mw-group-empty-state' : '') + '"' + (options.section != null ? ' data-section="' + esc(options.section) + '"' : '') + '><h2>' + esc(title) + '<small>' + items.length + '</small>' + (options.section != null ? '<button data-add-to-section="' + esc(options.section) + '" aria-label="向 ' + esc(title) + ' 添加任务">' + icon('plus') + '</button>' : '') + '</h2>' + (items.length ? items.map(rowHTML).join('') : '<p class="mw-group-empty">' + (options.section != null ? '添加这个阶段的第一个行动' : options.empty || '暂无任务') + '</p>') + '</section>'; }
  function renderList() {
    renderNav(); saveView(); var scope = state.view + '|' + (state.plan || '') + '|' + state.query;
    var data = scoped(), tasks = data.filter(function (r) { return r.kind !== 'plan' && match(r); }).sort(compare), currentPlan = lookup(state.plan);
    el('matterDate').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
    el('matterTitle').textContent = currentPlan ? currentPlan.title : views[state.view][0];
    el('matterSubtitle').textContent = currentPlan ? '把目标拆成可以开始的行动。' : views[state.view][1];
    el('matterNewPlan').hidden = state.view !== 'projects' || !!state.plan;
    el('matterDirectory').hidden = !state.directory; el('matterFilter').hidden = !state.directory; el('matterTitle').title = el('matterTitle').textContent;
    el('matterDirectory').textContent = state.directory ? state.directory.name + ' ×' : '';
    el('matterQuickForm').hidden = state.view === 'history' || state.view === 'projects' && !state.plan || state.view === 'calendar';
    el('matterList').hidden = state.view === 'calendar'; el('matterCalendar').hidden = state.view !== 'calendar';
    el('matterPlanHeader').innerHTML = currentPlan ? '<div class="mw-plan-summary"><button id="matterPlansBack">‹ 所有规划</button><p>' + esc(currentPlan.summary || '添加目标说明和完成标准，让行动更清楚。') + '</p><div><strong>' + planProgress(currentPlan) + '</strong><button data-matter-open="' + esc(currentPlan.matter_id) + '">编辑目标</button><button id="matterAddSection">添加阶段</button></div></div>' : '';
    root.dataset.view = state.view; var html = '', visible = [];
    if (state.view === 'calendar') {
      visible = tasks.filter(active); monthCompact = innerHeight < 760;
      var oldWeek = el('matterCalendar').querySelector('.mc-week-scroll'); if (oldWeek) calendarScroll[lastCalendarAnchor || state.anchor] = { top: oldWeek.scrollTop, left: oldWeek.scrollLeft };
      window.LkaMatterCalendar.render(el('matterCalendar'), { records: visible, mode: state.calendarMode, anchor: state.anchor, selectedId: state.selected, onSelect: select,
        onNavigate: function (d) { state.anchor = d; renderList(); }, onModeChange: function (m) { state.calendarMode = m; renderList(); }, onSchedule: schedule, onCreate: function (patch) { newDraft('task', patch); } });
      lastCalendarAnchor = state.anchor; var week = el('matterCalendar').querySelector('.mc-week-scroll'); if (week) { var scroll = calendarScroll[state.anchor] || { top: 384, left: 0 }; week.scrollTop = scroll.top; week.scrollLeft = scroll.left; }
    } else if (state.view === 'projects' && !state.plan) {
      visible = data.filter(function (r) { return r.kind === 'plan' && active(r) && match(r); }).sort(compare);
      html = '<div class="mw-projects">' + visible.map(function (r) { var p = r.progress || {}, total = (p.total || 0) - (p.cancelled || 0); var next = rows.filter(function (t) { return t.parent_matter_id === r.matter_id && active(t); }).sort(compare)[0]; return '<button class="mw-plan-card" data-plan="' + esc(r.matter_id) + '"><div class="mw-plan-card-top">' + icon('projects') + '<small>' + statusNames[r.status] + '</small></div><h2>' + esc(r.title) + '</h2><p>' + esc(r.summary || '尚未填写目标说明') + '</p><progress max="' + Math.max(total, 1) + '" value="' + (p.done || 0) + '"></progress><small>' + planProgress(r) + '</small><span>下一步：' + esc(next ? next.title : '添加一个行动') + '</span></button>'; }).join('') + '</div>';
    } else if (currentPlan) {
      visible = tasks.filter(function (r) { return r.parent_matter_id === state.plan && active(r); });
      var sections = [''].concat(currentPlan.sections || []); visible.forEach(function (r) { if (r.section && !sections.includes(r.section)) sections.push(r.section); });
      html = sections.map(function (s) { return group(s || '行动', visible.filter(function (r) { return (r.section || '') === s; }), { section: s, empty: '将任务拖到这里，或在详情中选择阶段。' }); }).join('');
      var finished = tasks.filter(function (r) { return r.parent_matter_id === state.plan && !active(r); });
      if (finished.length) html += '<details class="mw-finished"><summary>已结束的行动 ' + finished.length + '</summary>' + finished.map(rowHTML).join('') + '</details>';
    } else if (state.view === 'today') {
      var overdue = tasks.filter(function (r) { return active(r) && dateOnly(r.due_at) && dateOnly(r.due_at) < dayAfter(0); });
      visible = tasks.filter(function (r) { return active(r) && (plannedDay(r) === dayAfter(0) || dateOnly(r.due_at) === dayAfter(0)); });
      if (overdue.length) html += '<details class="mw-overdue-group"><summary>逾期 · ' + overdue.length + '</summary>' + overdue.map(rowHTML).join('') + '</details>';
      html += group('今天要做', visible.filter(function (r) { return r.status !== 'waiting'; }), { empty: '今天还没有安排。添加任务，或从日历里安排时间。' });
      var waiting = visible.filter(function (r) { return r.status === 'waiting'; }); if (waiting.length) html += group('等待回复', waiting);
    } else if (state.view === 'upcoming') {
      visible = tasks.filter(function (r) { return active(r) && (plannedDay(r) || dateOnly(r.due_at)) >= dayAfter(1); });
      var dates = Array.from(new Set(visible.map(function (r) { return plannedDay(r) || dateOnly(r.due_at); }))).sort();
      html = dates.map(function (d) { return group(d === dayAfter(1) ? '明天 · ' + d : d, visible.filter(function (r) { return (plannedDay(r) || dateOnly(r.due_at)) === d; })); }).join('');
    } else {
      visible = tasks.filter(function (r) { return state.view === 'history' ? !active(r) : active(r) && (state.view !== 'inbox' || r.inbox); });
      if (state.view === 'history') { var plans = data.filter(function (r) { return r.kind === 'plan' && !active(r) && match(r); }); visible = visible.concat(plans); }
      html = visible.map(rowHTML).join('');
    }
    var shownCount = state.view === 'calendar' ? new Set(window.LkaMatterCalendar.visibleItems(visible, state.calendarMode, state.anchor).map(function (i) { return i.record.matter_id; })).size : visible.length; el('matterCount').textContent = shownCount + (state.view === 'projects' && !state.plan ? ' 个规划' : ' 项');
    if (!snapshot.ready && !rows.length) html = '<div class="mw-empty"><h2>正在读取本地事项…</h2><p>首次打开会同步完整清单，之后优先显示缓存。</p></div>';
    else if (!html && state.view !== 'calendar') html = '<div class="mw-empty"><h2>' + (state.query ? '没有匹配的事项' : state.view === 'history' ? '还没有完成记录' : state.view === 'projects' ? '把一个目标变成行动' : '这里已经清空了') + '</h2><p>' + (state.query ? '试试其他标题或说明。' : state.view === 'projects' ? '创建一个规划，写清目标，再添加下一步。学习和出行也可以独立规划。' : '可以添加新任务，或前往其他视图安排事项。') + '</p></div>';
    el('matterList').innerHTML = html; if (lastListScope !== scope) el('matterContent').scrollTop = 0; lastListScope = scope; updateLayout();
    el('matterCacheState').textContent = snapshot.error ? '显示本地缓存 · 同步失败' : snapshot.ready ? (snapshot.stale ? '本地缓存 · 等待同步' : '已同步 · 本地缓存可用') : '首次同步中';
  }
  async function refresh(force) { try { await store.sync({ force: !!force }); } catch (e) { note(errorText(e) + ' 已保留本地内容。', true); } }
  function init() {
    if (started) return; started = true;
    storeNamespace = host.namespace; store = window.LkaMatterStore.create({ namespace: storeNamespace, request: host.request });
    Object.assign(state, store.view()); if (!views[state.view]) state.view = 'today'; el('matterSearch').value = state.query || '';
    snapshot = store.hydrate(); rows = snapshot.records;
    store.subscribe(function (s) { snapshot = s; rows = s.records; renderList(); if (activeDraft && activeDraft.id && lookup(activeDraft.id) && lookup(activeDraft.id).revision > activeDraft.revision) { var banner = el('matterEditorConflict'); if (banner) { banner.hidden = false; banner.textContent = '其他入口已有更新。保存前请载入最新版本核对。'; if (el('matterRebase')) el('matterRebase').hidden = false; } } });
    renderList(); refresh(false);
  }
  function open(options) {
    options = options || {};
    if (!host.standalone && host.quick) { if (window.petBridge && typeof window.petBridge.openMatters === 'function') window.petBridge.openMatters(JSON.stringify(options)); else window.open('./matters.html?backend=' + encodeURIComponent(host.backend) + '&project_id=' + encodeURIComponent(options.projectId || ''), 'lka-matters', 'width=1000,height=740'); return; }
    opened = true; root.hidden = false; document.body.classList.add('matter-workspace-open');
    el('matterBack').textContent = host.standalone ? '打开对话工作台' : '返回对话工作台';
    host.ready.then(function () { if (started && storeNamespace !== host.namespace) resetStore(); var first = !started; init(); if (options.projectId) { state.directory = { project_id: options.projectId, name: options.projectName || '关联目录' }; state.view = 'all'; state.plan = null; } if (options.view && views[options.view]) state.view = options.view; renderList(); if (!root.contains(document.activeElement)) root.focus(); if (!first) refresh(false); }).catch(function (e) { note(errorText(e), true); });
  }
  function close() { opened = false; root.hidden = true; document.body.classList.remove('matter-workspace-open'); }
  function select(id) { var r = lookup(id); if (!r) return; previousFocus = document.activeElement; state.selected = id; activeDraft = drafts.get(id) || { id: id, revision: r.revision, original: JSON.parse(JSON.stringify(r)), values: JSON.parse(JSON.stringify(r)), dirty: false }; drafts.set(id, activeDraft); renderEditor(); renderList(); el('matterEditTitle').focus(); }
  function newDraft(kind, patch) { var id = 'new-' + Date.now(), values = Object.assign({ kind: kind, title: '', summary: '', status: 'open', priority: 'normal', due_at: null, scheduled_on: null, scheduled_start: null, scheduled_end: null, inbox: !state.plan, parent_matter_id: kind === 'plan' ? null : state.plan, project_id: state.plan && lookup(state.plan) ? lookup(state.plan).project_id : state.directory ? state.directory.project_id : null, section: '', sections: [] }, patch || {}); if (patch && (patch.scheduled_on || patch.scheduled_start)) values.inbox = false; activeDraft = { key: id, values: values, original: JSON.parse(JSON.stringify(values)), dirty: false }; drafts.set(id, activeDraft); state.selected = null; renderEditor(); el('matterEditTitle').focus(); }
  function optionsHTML(values, selected) { return Object.keys(values).map(function (k) { return '<option value="' + esc(k) + '"' + (k === selected ? ' selected' : '') + '>' + esc(values[k]) + '</option>'; }).join(''); }
  function renderEditor() {
    if (!activeDraft) { el('matterEditor').hidden = true; return; }
    el('matterAssistant').hidden = true; el('matterEditor').hidden = false;
    var d = activeDraft, r = d.values, isPlan = r.kind === 'plan', locked = protectedRow(r), plan = lookup(r.parent_matter_id);
    var plans = { '': '独立任务' }; rows.filter(function (x) { return x.kind === 'plan' && (active(x) || x.matter_id === r.parent_matter_id); }).forEach(function (x) { plans[x.matter_id] = x.title; });
    var sections = { '': '未分阶段' }; (plan && plan.sections || []).forEach(function (s) { sections[s] = s; }); if (r.section) sections[r.section] = r.section;
    el('matterEditor').innerHTML = '<header class="mw-editor-heading"><strong>' + (isPlan ? '规划目标' : '任务详情') + (d.dirty ? ' · 未保存' : '') + '</strong><button id="matterEditorClose" aria-label="收起详情">×</button></header><p id="matterEditorConflict" class="mw-conflict" hidden></p>' +
      (locked ? '<div class="mw-lock">此事项来自消息记录，内容和状态需在消息中心通过专用审批处理。<button id="matterOpenMessages">打开消息中心</button></div>' : '') +
      '<form id="matterEditForm"><fieldset' + (locked ? ' disabled' : '') + '><label class="mw-field">' + (isPlan ? '目标名称' : '任务名称') + '<input id="matterEditTitle" required maxlength="500" value="' + esc(r.title) + '"></label><label class="mw-field">' + (isPlan ? '目标与完成标准' : '说明') + '<textarea id="matterEditSummary" placeholder="添加说明…" rows="3">' + esc(r.summary) + '</textarea></label><div class="mw-field-pair"><label class="mw-field">状态<select id="matterEditStatus">' + optionsHTML(statusNames, r.status) + '</select></label><label class="mw-field">优先级<select id="matterEditPriority">' + optionsHTML({ low: '低', normal: '普通', high: '高', urgent: '紧急' }, r.priority) + '</select></label></div>' +
      (!isPlan ? '<h3>安排时间</h3><div class="mw-date-presets"><button type="button" data-editor-date="0">今天</button><button type="button" data-editor-date="1">明天</button><button type="button" data-editor-date="7">一周后</button></div><label class="mw-field">计划哪天做<input id="matterEditScheduled" type="date" value="' + esc(r.scheduled_on || dateOnly(r.scheduled_start)) + '"></label><details class="mw-time-details"' + (r.scheduled_start ? ' open' : '') + '><summary>指定时间与时长</summary><div class="mw-field-pair"><label class="mw-field">开始时间<input id="matterEditStart" type="datetime-local" value="' + localTime(r.scheduled_start) + '"></label><label class="mw-field">时长（分钟）<input id="matterEditDuration" type="number" min="0.001" step="any" value="' + (r.scheduled_start ? ((new Date(r.scheduled_end) - new Date(r.scheduled_start)) / 60000) : 30) + '"></label></div><button id="matterClearSchedule" type="button" class="mw-text">移除时间安排</button></details>' : '') +
      '<label class="mw-field">截止日期<input id="matterEditDue" type="date" value="' + esc(dateOnly(r.due_at)) + '"><small>最晚完成日期，与日历安排分别保存。</small></label>' +
      (!isPlan ? '<label class="mw-field">所属规划<select id="matterEditParent">' + optionsHTML(plans, r.parent_matter_id || '') + '</select></label><details class="mw-more-properties"' + (r.section ? ' open' : '') + '><summary>更多属性</summary><label class="mw-field">阶段<select id="matterEditSection">' + optionsHTML(sections, r.section || '') + '</select></label><label class="mw-checkbox"><input id="matterEditInbox" type="checkbox"' + (r.inbox ? ' checked' : '') + '>留在收集箱</label>' : '<label class="mw-field">阶段（每行一个）<textarea id="matterEditSections" rows="3">' + esc((r.sections || []).join('\n')) + '</textarea></label>') +
      '<label class="mw-field">关联目录（可选）<select id="matterEditProject"' + (!isPlan && r.parent_matter_id ? ' disabled' : '') + '><option value="">不关联目录</option>' + (directories || []).map(function (p) { return '<option value="' + esc(p.project_id) + '"' + (p.project_id === r.project_id ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + (r.project_id && !(directories || []).some(function (p) { return p.project_id === r.project_id; }) ? '<option selected value="' + esc(r.project_id) + '">当前关联目录</option>' : '') + '</select></label>' + (!isPlan ? '</details>' : '') + '</fieldset><div class="mw-editor-actions"><button id="matterSave" class="mw-primary"' + (locked ? ' disabled' : '') + '>' + (d.id ? '保存修改' : '创建' + (isPlan ? '规划' : '任务')) + '</button><button id="matterRebase" type="button"' + ' hidden>载入最新版本</button><button id="matterEditorCancel" type="button">收起</button></div></form><div id="matterLatest" class="mw-latest"></div>';
    el('matterEditorCancel').onclick = function () { el('matterEditorClose').click(); };
    el('matterEditorClose').onclick = function () { activeDraft = null; state.selected = null; renderEditor(); renderList(); if (previousFocus && previousFocus.isConnected) previousFocus.focus(); };
    el('matterEditForm').oninput = readDraft;
    el('matterEditForm').onchange = function (e) { readDraft(); if (e.target.id === 'matterEditParent') { var parent = lookup(d.values.parent_matter_id); if (parent) d.values.project_id = parent.project_id; d.values.section = ''; renderEditor(); } };
    el('matterEditForm').onsubmit = saveDraft;
    if (!isPlan) el('matterClearSchedule').onclick = function () { el('matterEditScheduled').value = ''; el('matterEditStart').value = ''; readDraft(); };
    if (el('matterRebase')) el('matterRebase').onclick = rebase;
    if (el('matterOpenMessages')) el('matterOpenMessages').onclick = function () { if (window.LkaMessages && window.LkaMessages.open) { close(); window.LkaMessages.open(); } else note('请在对话工作台的消息中心处理此事项。'); };
    if (directories === null) { directories = []; loadDirectories(); }
  }
  async function loadDirectories() { try { var list = [], next = 0; do { var data = await host.request('/projects?limit=100&offset=' + next); list = list.concat(data.projects || []); next = data.next_offset; } while (next != null); directories = list; var select = el('matterEditProject'); if (select && activeDraft) { var value = select.value; select.innerHTML = '<option value="">不关联目录</option>' + directories.map(function (p) { return '<option value="' + esc(p.project_id) + '">' + esc(p.name) + '</option>'; }).join(''); if (value && !directories.some(function (p) { return p.project_id === value; })) { var fallback = document.createElement('option'); fallback.value = value; fallback.textContent = '当前关联目录'; select.appendChild(fallback); } select.value = value; } } catch (e) { note('目录选项读取失败：' + errorText(e), true); } }
  function readDraft() {
    if (!activeDraft) return;
    var d = activeDraft, r = d.values;
    r.title = el('matterEditTitle').value; r.summary = el('matterEditSummary').value; r.status = el('matterEditStatus').value; r.priority = el('matterEditPriority').value;
    var due = el('matterEditDue').value; r.due_at = due === dateOnly(d.original.due_at) ? d.original.due_at : due || null;
    r.project_id = el('matterEditProject').value || null;
    if (r.kind !== 'plan') {
      var plannedInput = el('matterEditScheduled').value, originalDay = d.original.scheduled_on || dateOnly(d.original.scheduled_start); r.scheduled_on = plannedInput === originalDay ? d.original.scheduled_on || null : plannedInput || null;
      var start = el('matterEditStart').value, duration = Number(el('matterEditDuration').value) || 30;
      if (start) { if (plannedInput && plannedInput !== originalDay) { start = plannedInput + start.slice(10); el('matterEditStart').value = start; } var startDate = new Date(start); if (start === localTime(d.original.scheduled_start) && duration === ((new Date(d.original.scheduled_end) - new Date(d.original.scheduled_start)) / 60000)) { r.scheduled_start = d.original.scheduled_start; r.scheduled_end = d.original.scheduled_end; } else { r.scheduled_start = startDate.toISOString(); r.scheduled_end = new Date(startDate.getTime() + duration * 60000).toISOString(); r.scheduled_on = day(startDate); } }
      else { r.scheduled_start = null; r.scheduled_end = null; }
      r.parent_matter_id = el('matterEditParent').value || null; r.section = el('matterEditSection').value; r.inbox = el('matterEditInbox').checked;
    } else r.sections = el('matterEditSections').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    d.dirty = true; el('matterEditor').querySelector('header strong').textContent = (r.kind === 'plan' ? '规划目标' : '任务详情') + ' · 未保存';
  }
  async function saveDraft(e) {
    e.preventDefault(); var d = activeDraft; if (!d || d.saving || protectedRow(d.values)) return; readDraft(); if (!d.values.title.trim()) return;
    d.saving = true; el('matterSave').disabled = true;
    var body = d.id ? changedFields(d.values, d.original) : Object.assign({}, d.values); ['matter_id', 'revision', 'created_at', 'updated_at', 'source_links', 'progress', 'kind'].forEach(function (k) { delete body[k]; });
    if (d.id) body.expected_revision = d.revision; else body.kind = d.values.kind;
    try { var result = await store.mutate(d.id ? '/matters/' + encodeURIComponent(d.id) : '/matters', d.id ? 'PATCH' : 'POST', body); var saved = result.matter || result; drafts.delete(d.id || d.key); if (activeDraft === d) { activeDraft = null; state.selected = null; renderEditor(); } note('已保存。'); if (saved.kind === 'plan') { state.view = 'projects'; state.plan = saved.matter_id; renderList(); } }
    catch (err) { note(errorText(err), true); if (err.status === 409) { await refresh(true); if (activeDraft === d) { el('matterEditorConflict').hidden = false; el('matterEditorConflict').textContent = errorText(err); el('matterRebase').hidden = false; } } }
    finally { d.saving = false; if (activeDraft === d && el('matterSave')) el('matterSave').disabled = false; }
  }
  function changedFields(values, original) { var result = {}; Object.keys(values).forEach(function (k) { if (JSON.stringify(values[k]) !== JSON.stringify(original[k])) result[k] = values[k]; }); return result; }
  async function rebase() { var d = activeDraft; if (!d || !d.id || d.saving) return; readDraft(); var changes = changedFields(d.values, d.original); await refresh(true); var latest = lookup(d.id); if (!latest || activeDraft !== d) return; d.revision = latest.revision; d.original = JSON.parse(JSON.stringify(latest)); d.values = Object.assign(JSON.parse(JSON.stringify(latest)), changes); renderEditor(); el('matterLatest').textContent = '已载入其他入口的更新，并保留你的修改。最新内容：' + latest.title + '；' + latest.summary + '；' + statusNames[latest.status] + '；安排 ' + (latest.scheduled_start || latest.scheduled_on || '未设置') + '；截止 ' + (latest.due_at || '未设置') + '。请核对后保存。'; }
  async function reorder(id, direction) { var row = lookup(id); if (!row) return; var list = rows.filter(function (r) { return r.parent_matter_id === state.plan && active(r) && (r.section || '') === (row.section || ''); }).sort(compare), index = list.findIndex(function (r) { return r.matter_id === id; }), target = index + direction; if (target < 0 || target >= list.length) return; list.splice(target, 0, list.splice(index, 1)[0]); try { for (var i = 0; i < list.length; i++) { var current = lookup(list[i].matter_id), rank = (i + 1) * 1024; if (current.sort_order !== rank) await store.mutate('/matters/' + encodeURIComponent(current.matter_id), 'PATCH', { expected_revision: current.revision, sort_order: rank }); } note('已调整顺序。'); } catch (e) { note(errorText(e), true); refresh(true); } }
  async function patch(id, changes) { var r = lookup(id); if (!r || pendingWrites.has(id)) return; if (protectedRow(r)) { note('消息来源事项需到消息中心通过专用审批处理。', true); return; } pendingWrites.add(id); var item = Array.from(root.querySelectorAll('[data-row]')).find(function(n){return n.dataset.row===id;}); if(item)item.classList.add('mw-pending'); try { var result = await store.mutate('/matters/' + encodeURIComponent(id), 'PATCH', Object.assign({ expected_revision: r.revision }, changes)), saved = result.matter || result, before = {}; Object.keys(changes).forEach(function(k){before[k]=r[k] == null ? null : r[k];}); note(changes.status === 'done' ? '已完成「' + r.title + '」' : '已更新「' + r.title + '」', false, async function(){try{await store.mutate('/matters/'+encodeURIComponent(id),'PATCH',Object.assign({expected_revision:saved.revision},before));note('已撤销修改。');}catch(err){note(errorText(err),true);refresh(true);}}); return saved; } catch (e) { note(errorText(e), true); if (e.status === 409) refresh(true); } finally {pendingWrites.delete(id);if(item)item.classList.remove('mw-pending');} }
  function schedule(id, changes) { changes.inbox = false; return patch(id, changes); }
  function parseQuick(text) {
    var title = text.trim(), date = '', time = '', duration = 30, token = title.match(/(今天|明天|后天|(?:下)?周[一二三四五六日天]|\d{4}-\d{2}-\d{2})/);
    if (token) { var value = token[1]; if (/^\d/.test(value)) date = value; else if (['今天', '明天', '后天'].includes(value)) date = dayAfter(['今天', '明天', '后天'].indexOf(value)); else { var weekday = '日一二三四五六'.indexOf(value.slice(-1).replace('天', '日')), offset = (weekday - new Date().getDay() + 7) % 7; if (value[0] === '下') { var mondayIndex = (new Date().getDay() + 6) % 7; offset = 7 - mondayIndex + (weekday + 6) % 7; } date = dayAfter(offset); } title = title.replace(token[0], '').trim(); }
    var tm = title.match(/(?:上午|下午|晚上)?\s*(\d{1,2})[:：](\d{2})/);
    if (!tm) { var spoken = title.match(/(上午|下午|晚上)?\s*([零一二三四五六七八九十两\d]{1,3})点(半|[零一二三四五六七八九十\d]{1,3}分?)?/); if (spoken) { var chineseNumber = function (s) { if (!s) return 0; if (/^\d+$/.test(s)) return +s; var digits = '零一二三四五六七八九', parts = s.replace('两', '二').split('十'); if (parts.length === 2) return (parts[0] ? digits.indexOf(parts[0]) : 1) * 10 + (parts[1] ? digits.indexOf(parts[1]) : 0); return digits.indexOf(s); }; tm = [spoken[0], String(chineseNumber(spoken[2])), String(spoken[3] === '半' ? 30 : chineseNumber((spoken[3] || '').replace('分', ''))).padStart(2, '0')]; } }
    if (tm && +tm[1] < 24 && +tm[2] < 60) { var hour = +tm[1]; if (/下午|晚上/.test(tm[0]) && hour < 12) hour += 12; time = String(hour).padStart(2, '0') + ':' + tm[2]; title = title.replace(tm[0], '').trim(); date = date || dayAfter(0); }
    var dm = title.match(/(\d+)\s*分钟/); if (dm && time) { duration = Math.max(5, Math.min(10080, +dm[1])); title = title.replace(dm[0], '').trim(); }
    var changes = {}; if (date && !window.LkaMatterCalendar.dateFromKey(date)) throw Error('Invalid date'); if (date) changes.scheduled_on = date;
    if (time) { var start = new Date(date + 'T' + time); changes.scheduled_start = start.toISOString(); changes.scheduled_end = new Date(start.getTime() + duration * 60000).toISOString(); }
    return { title: title, patch: changes, label: date ? '安排：' + date + (time ? ' ' + time + '，' + duration + '分钟' : ' 全天') + '（截止日期可在详情中设置）' : '保存到' + (state.plan ? '当前规划' : state.view === 'today' ? '今天' : '收集箱') };
  }
  el('matterQuickTitle').oninput = function () { try { el('matterParseHint').textContent = this.value ? parseQuick(this.value).label : ''; } catch (_) { el('matterParseHint').textContent = '日期格式无效，请使用 YYYY-MM-DD。'; } };
  el('matterQuickForm').onsubmit = async function (e) { e.preventDefault(); if (adding || !snapshot.ready) return; var input = el('matterQuickTitle'), raw = input.value, parsed; try { parsed = parseQuick(raw); } catch (_) { note('无法识别日期，请检查后重试。', true); return; } if (!parsed.title) { note('请输入任务名称。', true); return; } adding = true; var payload = Object.assign({ title: parsed.title, kind: 'task', parent_matter_id: state.plan, project_id: state.plan && lookup(state.plan) ? lookup(state.plan).project_id : state.directory ? state.directory.project_id : null, inbox: !state.plan && !parsed.patch.scheduled_on && state.view !== 'today' }, parsed.patch); if (state.view === 'today' && !payload.scheduled_on) payload.scheduled_on = dayAfter(0); try { await store.mutate('/matters', 'POST', payload); if (input.value === raw) { input.value = ''; el('matterParseHint').textContent = ''; } note('已添加。'); } catch (err) { note(errorText(err), true); } finally { adding = false; } };
  root.onclick = function (e) {
    var nav = e.target.closest('[data-matter-view]'), item = e.target.closest('[data-matter-open]'), plan = e.target.closest('[data-plan]'), complete = e.target.closest('[data-complete]'), move = e.target.closest('[data-move]'), dateButton = e.target.closest('[data-row-date]'), sectionAdd = e.target.closest('[data-add-to-section]'), preset = e.target.closest('[data-editor-date]');
    if (dateButton) openDateMenu(dateButton.dataset.rowDate,dateButton);
    if (sectionAdd) newDraft('task',{section:sectionAdd.dataset.addToSection,inbox:false});
    if (preset && activeDraft && el('matterEditScheduled')) { el('matterEditScheduled').value = dayAfter(Number(preset.dataset.editorDate)); readDraft(); }
    if (nav) { closeDateMenu(); state.view = nav.dataset.matterView; state.plan = null; renderList(); }
    if (item) select(item.dataset.matterOpen);
    if (plan) { state.plan = plan.dataset.plan; state.view = 'projects'; renderList(); }
    if (complete) { var r = lookup(complete.dataset.complete); if (r) patch(r.matter_id, { status: active(r) ? 'done' : 'open' }); }
    if (move) reorder(move.dataset.move, Number(move.dataset.direction));
    if (e.target.id === 'matterPlansBack') { state.plan = null; renderList(); }
    if (e.target.id === 'matterAddSection') { var current = lookup(state.plan); newDraftSection(current); }
  };
  function newDraftSection(plan) { if (!plan || protectedRow(plan)) return; var existing=el('matterSectionForm');if(existing){existing.querySelector('input').focus();return;} var form=document.createElement('form');form.id='matterSectionForm';form.className='mw-section-form';form.innerHTML='<input required maxlength="120" placeholder="阶段名称，例如：准备材料" aria-label="阶段名称"><button class="mw-primary">添加</button><button type="button">取消</button>';el('matterPlanHeader').appendChild(form);form.querySelector('[type=button]').onclick=function(){form.remove();};form.onsubmit=async function(e){e.preventDefault();var value=form.querySelector('input').value.trim();if(!value)return;var sections=(lookup(plan.matter_id).sections||[]).slice();if(sections.includes(value)){note('已有同名阶段。',true);return;}await patch(plan.matter_id,{sections:sections.concat(value)});};form.querySelector('input').focus(); }
  root.addEventListener('dragstart', function (e) { var row = e.target.closest('[data-row]'); if (row && e.dataTransfer) e.dataTransfer.setData('application/x-lka-matter', row.dataset.row); });
  root.addEventListener('dragover', function (e) { if (e.target.closest('[data-section]')) e.preventDefault(); });
  root.addEventListener('drop', function (e) { var section = e.target.closest('[data-section]'); if (!section || !e.dataTransfer) return; e.preventDefault(); var id = e.dataTransfer.getData('application/x-lka-matter'); if (id) patch(id, { section: section.dataset.section }); });
  el('matterSearch').oninput = function () { state.query = this.value; renderList(); };
  el('matterRefresh').onclick = function () { refresh(true); };
  el('matterNewTask').onclick = function () { newDraft('task'); };
  el('matterNewPlan').onclick = function () { newDraft('plan'); };
  el('matterDirectory').onclick = function () { state.directory = null; renderList(); };
  el('matterBack').onclick = function () { if (host.standalone) window.open('./chat.html?mode=work&backend=' + encodeURIComponent(host.backend), '_blank'); else close(); };
  el('matterTokenForm').onsubmit = function (e) { e.preventDefault(); var tokenValue = el('matterToken').value; el('matterToken').value = ''; host.setToken(tokenValue); };
  function resetStore() { if (store) store.dispose(); store = null; started = false; rows = []; snapshot = {}; drafts.clear(); activeDraft = null; state.selected = null; state.plan = null; state.directory = null; assistantLoaded = false; assistantManager = null; renderManagerStatus(); directories = null; el('matterEditor').hidden = true; el('matterAssistant').hidden = true; }
  window.addEventListener('lka-matter-auth-changed', function () { resetStore(); if (opened) init(); });
  function renderManagerStatus() {
    var controller = assistantManager && assistantManager.controller;
    el('matterManagerStatus').textContent = controller ? (controller.status === 'paused' ? '管理已暂停' : '管理已启用') : '';
    el('matterManagerToggle').hidden = !controller;
    el('matterManagerToggle').textContent = controller && controller.status === 'active' ? '暂停管理' : '启用管理写入';
  }
  el('matterManagerToggle').onclick = async function () {
    if (!assistantManager) return;
    var current = assistantManager, button = el('matterManagerToggle'); button.disabled = true;
    try {
      var result = await host.updateAssistantManager(current.sessionId, current.controller.revision, current.controller.status === 'active' ? 'paused' : 'active');
      if (assistantManager === current) { current.controller = result.controller; renderManagerStatus(); }
    } catch (error) { note(errorText(error), true); }
    finally { button.disabled = false; }
  };
  el('matterAsk').onclick = async function () { el('matterEditor').hidden = true; el('matterAssistant').hidden = false; if (assistantLoaded) return; assistantManager = null; renderManagerStatus(); assistantLoaded = true; try { var p = lookup(state.plan), selected = lookup(state.selected); var assistantResult = await host.openAssistant(el('matterAssistantBody'), { matter: selected || p, plan: p, view: state.view, selection: { matter_id: selected ? selected.matter_id : null, expected_revision: selected ? selected.revision : null, plan_id: p ? p.matter_id : null, plan_revision: p ? p.revision : null, query: state.query || '', visibility: 'user' } }); assistantManager = assistantResult.controller ? { sessionId: assistantResult.sessionId, controller: assistantResult.controller } : null; renderManagerStatus(); } catch (e) { assistantLoaded = false; note(errorText(e), true); } };
  el('matterAssistantClose').onclick = function () { el('matterAssistant').hidden = true; };
  ['openMattersButton', 'openMatterCenterButton', 'openMattersSidebarButton'].forEach(function (id) { if (el(id)) el(id).onclick = function () { open(); }; });
  window.addEventListener('lka-matter-agent-finished', function () { if (store) { store.invalidate(); refresh(false); } });
  window.addEventListener('lka-agent-turn-finished', function () { if (store) { store.invalidate(); if (opened) refresh(false); } });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && opened && store) refresh(false); });
  window.setInterval(function () { if (opened && !document.hidden && store) refresh(false); }, 60000);
  root.addEventListener('keydown', function (e) { if (e.key === 'Tab' && !backdrop.hidden) { var pane = !el('matterEditor').hidden ? el('matterEditor') : el('matterAssistant'), focusable = Array.from(pane.querySelectorAll('button,input,textarea,select,iframe,[tabindex]')).filter(function(n){return !n.disabled && n.tabIndex >= 0 && n.getClientRects().length;}); if (focusable.length) { var first = focusable[0], last = focusable[focusable.length-1], outside = !pane.contains(document.activeElement); if (e.shiftKey && (document.activeElement === first || outside)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && (document.activeElement === last || outside)) {e.preventDefault();first.focus();} } } if (e.key === 'Escape') { if (!dateMenu.hidden) {closeDateMenu();e.stopPropagation();return;}  if (!el('matterAssistant').hidden) el('matterAssistant').hidden = true; else if (activeDraft) { activeDraft = null; state.selected = null; renderEditor(); renderList(); } else if (!host.standalone) close(); e.stopPropagation(); } if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && activeDraft) { e.preventDefault(); el('matterEditForm').requestSubmit(); } if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) {e.preventDefault();newDraft('task');} if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); el('matterSearch').focus(); } });
  window.LkaMatters = { open: open, close: close, isOpen: function () { return opened; }, parseQuick: parseQuick };
  if (host.standalone) open({ projectId: new URLSearchParams(location.search).get('project_id') || undefined });
})();
