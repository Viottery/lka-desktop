(function (root) {
  'use strict';
  var MINUTE = 60000;
  function pad(n) { return String(n).padStart(2, '0'); }
  function dayKey(date) { return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()); }
  function dateFromKey(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) return null;
    var parts = key.split('-').map(Number), date = new Date(parts[0], parts[1] - 1, parts[2]);
    return dayKey(date) === key ? date : null;
  }
  function addDays(date, amount) { var next = new Date(date); next.setDate(next.getDate() + amount); return next; }
  function range(mode, anchor) {
    var date = dateFromKey(anchor) || new Date(), first = new Date(date.getFullYear(), date.getMonth(), date.getDate()), count = 7;
    if (mode === 'month') { first.setDate(1); count = 42; }
    first.setDate(first.getDate() - (first.getDay() + 6) % 7);
    if (mode === 'agenda') count = 14;
    var days = []; for (var i = 0; i < count; i++) days.push(dayKey(addDays(first, i)));
    return { start: days[0], end: dayKey(addDays(first, count)), days: days };
  }
  function timed(record) {
    if (!record.scheduled_start) return null;
    var start = new Date(record.scheduled_start), end = new Date(record.scheduled_end);
    if (!Number.isFinite(start.getTime())) return null;
    return { start: start, end: Number.isFinite(end.getTime()) && end > start ? end : new Date(start.getTime() + 30 * MINUTE) };
  }
  // Omitted time preserves a timed task's local clock; null explicitly means all-day.
  function schedulePatch(record, date, time, minutes) {
    var local = dateFromKey(date); if (!local) throw Error('Invalid calendar date');
    var existing = timed(record || {});
    if (time === undefined && existing) time = pad(existing.start.getHours()) + ':' + pad(existing.start.getMinutes());
    if (time == null || time === '') return { scheduled_on: date, scheduled_start: null, scheduled_end: null };
    if (!/^\d{2}:\d{2}$/.test(time) || +time.slice(0, 2) > 23 || +time.slice(3) > 59) throw Error('Invalid calendar time');
    local.setHours(+time.slice(0, 2), +time.slice(3), existing && minutes === undefined ? existing.start.getSeconds() : 0, existing && minutes === undefined ? existing.start.getMilliseconds() : 0);
    var duration = minutes === undefined && existing ? existing.end - existing.start : (minutes === undefined ? 30 : Number(minutes)) * MINUTE;
    if (!Number.isFinite(duration) || duration <= 0) throw Error('Duration must be greater than zero');
    return { scheduled_on: null, scheduled_start: local.toISOString(), scheduled_end: new Date(local.getTime() + duration).toISOString() };
  }
  function deadlineDay(value) { if (!value) return null; if (dateFromKey(value)) return value; var d = new Date(value); return Number.isFinite(d.getTime()) ? dayKey(d) : null; }
  function visibleItems(records, mode, anchor, projectId) {
    var bounds = range(mode, anchor), items = [], start = dateFromKey(bounds.start), end = dateFromKey(bounds.end);
    (records || []).forEach(function (record) {
      if (record.kind === 'plan' || (projectId && record.project_id !== projectId)) return;
      var block = timed(record), scheduled = dateFromKey(record.scheduled_on);
      if (block) bounds.days.forEach(function (key) {
        var day = dateFromKey(key), tomorrow = addDays(day, 1);
        if (block.start < tomorrow && block.end > day) items.push({ record: record, type: 'schedule', day: key, allDay: false, start: block.start, end: block.end });
      });
      else if (scheduled && scheduled >= start && scheduled < end) items.push({ record: record, type: 'schedule', day: record.scheduled_on, allDay: true });
      var due = deadlineDay(record.due_at);
      if (due && due >= bounds.start && due < bounds.end) items.push({ record: record, type: 'deadline', day: due, allDay: true });
    });
    return items.sort(function (a, b) { return a.day.localeCompare(b.day) || (a.start ? a.start.getTime() : 0) - (b.start ? b.start.getTime() : 0); });
  }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clock(date) { return pad(date.getHours()) + ':' + pad(date.getMinutes()); }
  function render(container, options) {
    var state = Object.assign({ mode: 'week', anchor: dayKey(new Date()), records: [] }, options);
    function call(name) { if (typeof state[name] === 'function') state[name].apply(null, Array.prototype.slice.call(arguments, 1)); }
    function rows() { return state.records.filter(function (r) { return r.kind !== 'plan' && (!state.projectId || r.project_id === state.projectId); }); }
    function block(item, grid) {
      var r = item.record, label = item.type === 'deadline' ? '截止 · ' : item.allDay ? '全天 · ' : clock(item.start) + '–' + clock(item.end) + ' · ';
      var style = '';
      if (grid && !item.allDay) {
        var start = dateFromKey(item.day), end = addDays(start, 1);
        var from = item.start < start ? 0 : item.start.getHours() * 60 + item.start.getMinutes();
        var to = item.end >= end ? 1440 : item.end.getHours() * 60 + item.end.getMinutes();
        var cols = item.columns || 1, column = item.column || 0; style = ' style="top:' + (from / 60 * 48) + 'px;height:' + Math.max(24, (to - from) / 60 * 48) + 'px;left:calc(3px + (100% - 6px) * ' + column + ' / ' + cols + ');width:calc((100% - 6px) / ' + cols + ')"';
      }
      return '<button type="button" class="mc-block' + (item.type === 'deadline' ? ' mc-deadline' : '') + (r.matter_id === state.selectedId ? ' mc-selected' : '') + '" data-mc-id="' + esc(r.matter_id) + '"' + (item.type === 'deadline' ? '' : ' draggable="true"') + style + ' title="' + esc(label + r.title) + '"><span>' + esc(label) + '</span><strong>' + esc(r.title) + '</strong></button>';
    }
    function compactItems(items) {
      var grouped = new Map();
      items.forEach(function (item) { var id = item.record.matter_id; if (!grouped.has(id)) grouped.set(id, []); grouped.get(id).push(item); });
      return Array.from(grouped.values()).map(function (entries) {
        var first = entries[0], schedule = entries.find(function (i) { return i.type === 'schedule'; });
        var labels = [];
        if (schedule) labels.push(schedule.allDay ? '全天' : clock(schedule.start));
        if (entries.some(function (i) { return i.type === 'deadline'; })) labels.push('截止');
        var markup = block(schedule || first, false);
        return markup.replace(/<span>.*?<\/span>/, '<span>' + esc(labels.join(' · ')) + '</span>');
      });
    }
    function draw() {
      var bounds = range(state.mode, state.anchor), items = visibleItems(state.records, state.mode, state.anchor, state.projectId), available = rows();
      var unscheduled = available.filter(function (r) { return !timed(r) && !dateFromKey(r.scheduled_on) && r.status !== 'done' && r.status !== 'cancelled'; });
      var anchorDate = dateFromKey(state.anchor) || new Date(), today = dayKey(new Date());
      var title = state.mode === 'month' ? anchorDate.getFullYear() + '年' + (anchorDate.getMonth() + 1) + '月' : bounds.start.slice(5).replace('-', '月') + '日 — ' + bounds.days[bounds.days.length - 1].slice(5).replace('-', '月') + '日';
      var html = '<section class="mc-calendar" data-mode="' + esc(state.mode) + '"><div class="mc-toolbar"><div><button type="button" data-mc-nav="-1" aria-label="上一段日期">‹</button><button type="button" data-mc-today>今天</button><button type="button" data-mc-nav="1" aria-label="下一段日期">›</button></div><strong>' + esc(title) + '</strong><div class="mc-modes">';
      [['week', '周'], ['month', '月'], ['agenda', '日程']].forEach(function (mode) { html += '<button type="button" data-mc-mode="' + mode[0] + '" aria-pressed="' + (state.mode === mode[0]) + '">' + mode[1] + '</button>'; });
      html += '</div></div><div class="mc-content"><div class="mc-board">';
      if (state.mode === 'week') {
        html += '<div class="mc-week-scroll"><div class="mc-week"><div class="mc-time-axis" aria-hidden="true"><div class="mc-axis-head">时间</div><div class="mc-axis-all">全天</div><div class="mc-axis-hours">' + Array.from({ length: 24 }, function (_, h) { return '<span>' + pad(h) + ':00</span>'; }).join('') + '</div></div>';
        bounds.days.forEach(function (day) {
          var date = dateFromKey(day), daily = items.filter(function (i) { return i.day === day; });
          var cluster = [], ends = [], clusterEnd = 0; function finishCluster() { cluster.forEach(function (i) { i.columns = ends.length; }); cluster = []; ends = []; } daily.filter(function (i) { return !i.allDay; }).forEach(function (i) { if (cluster.length && +i.start >= clusterEnd) finishCluster(); var col = ends.findIndex(function (end) { return end <= +i.start; }); if (col < 0) col = ends.length; ends[col] = +i.end; i.column = col; cluster.push(i); clusterEnd = Math.max(clusterEnd, +i.end); }); finishCluster();
          html += '<section class="mc-day' + (day === today ? ' mc-today' : '') + '"><h4><span>' + ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()] + '</span><b>' + date.getDate() + '</b></h4><div class="mc-all-day" data-mc-drop-day="' + day + '" data-mc-drop-time="all"><button type="button" class="mc-create" data-mc-create-day="' + day + '">+ 全天</button>' + daily.filter(function (i) { return i.allDay; }).map(function (i) { return block(i, false); }).join('') + '</div><div class="mc-hours">';
          for (var hour = 0; hour < 24; hour++) html += '<button type="button" class="mc-hour" data-mc-create-day="' + day + '" data-mc-time="' + pad(hour) + ':00" data-mc-drop-day="' + day + '" data-mc-drop-time="' + pad(hour) + ':00" aria-label="' + day + ' ' + pad(hour) + ':00 新建安排"><span>' + pad(hour) + ':00</span></button>';
          html += daily.filter(function (i) { return !i.allDay; }).map(function (i) { return block(i, true); }).join('') + '</div></section>';
        });
        html += '</div></div>';
      } else if (state.mode === 'month') {
        html += '<div class="mc-month-scroll"><div class="mc-weekdays">' + ['一', '二', '三', '四', '五', '六', '日'].map(function (d) { return '<span>周' + d + '</span>'; }).join('') + '</div><div class="mc-month">';
        bounds.days.forEach(function (day) {
          var monthLimit = typeof window !== 'undefined' && window.innerHeight < 760 ? 1 : 3; var compact = compactItems(items.filter(function (i) { return i.day === day; }));
          html += '<section class="mc-day' + (day.slice(0, 7) !== state.anchor.slice(0, 7) ? ' mc-outside' : '') + (day === today ? ' mc-today' : '') + '" data-mc-drop-day="' + day + '"><button type="button" class="mc-date" data-mc-create-day="' + day + '" aria-label="' + day + ' 新建全天安排"' + (day === today ? ' aria-current="date"' : '') + '>' + Number(day.slice(8)) + '</button>' + compact.slice(0, monthLimit).join('');
          if (compact.length > monthLimit) html += '<details class="mc-overflow"><summary>＋' + (compact.length - monthLimit) + ' 项</summary>' + compact.slice(monthLimit).join('') + '</details>';
          html += '</section>';
        });
        html += '</div></div>';
      } else {
        html += '<div class="mc-agenda">';
        bounds.days.forEach(function (day) { html += '<section class="mc-agenda-day" data-mc-drop-day="' + day + '"><button type="button" class="mc-date" data-mc-create-day="' + day + '">' + day + ' +</button>' + (items.filter(function (i) { return i.day === day; }).map(function (i) { return block(i, false); }).join('') || '<span class="mc-empty">暂无安排</span>') + '</section>'; });
        html += '</div>';
      }
      html += '</div><details class="mc-tray"' + (typeof window !== 'undefined' && window.innerWidth > 1100 ? ' open' : '') + '><summary>待安排 <span>' + unscheduled.length + '</span></summary><div class="mc-tray-body"><p>拖入日历安排时间，或点击任务编辑。</p><input class="mc-tray-search" type="search" placeholder="搜索待安排任务" aria-label="搜索待安排任务"><div class="mc-tray-items" data-mc-unschedule="true">' + (unscheduled.map(function (r) { return '<button type="button" class="mc-block" draggable="true" data-mc-id="' + esc(r.matter_id) + '">' + esc(r.title) + '</button>'; }).join('') || '<span class="mc-empty">没有待安排事项</span>') + '<span class="mc-drop-hint">拖到这里，移除时间安排</span></div></div></details></div>';
      html += '<details class="mc-schedule-editor"><summary>更多安排方式 · 键盘与精确时间</summary><form data-mc-form><label>事项<select name="matter" aria-label="安排事项">' + available.map(function (r) { return '<option value="' + esc(r.matter_id) + '"' + (r.matter_id === state.selectedId ? ' selected' : '') + '>' + esc(r.title) + '</option>'; }).join('') + '</select></label><label>日期<input name="date" type="date" required value="' + esc(state.anchor) + '"></label><label><input name="allDay" type="checkbox" checked>全天</label><label>开始时间<input name="time" type="time" value="09:00"></label><label>时长（分钟）<input name="duration" type="number" min="1" step="any" value="30" required></label><button type="button" data-mc-duration="-15" aria-label="缩短十五分钟">−15</button><button type="button" data-mc-duration="15" aria-label="延长十五分钟">+15</button><button type="submit"' + (available.length ? '' : ' disabled') + '>安排</button><button type="button" data-mc-clear' + (available.length ? '' : ' disabled') + '>取消时间安排</button><p class="mc-form-note">新增定时安排默认 30 分钟。取消安排不会删除事项或截止日期。</p></form></details></section>';
      container.innerHTML = html;
      updateForm();
    }
    function form() { return container.querySelector('[data-mc-form]'); }
    function updateForm() {
      var f = form(), r = state.records.find(function (r) { return r.matter_id === f.elements.matter.value; }), block = r && timed(r);
      if (!r) return;
      f.elements.date.value = block ? dayKey(block.start) : r.scheduled_on || state.anchor;
      f.elements.allDay.checked = !block; f.elements.time.value = block ? clock(block.start) : '09:00';
      f.elements.duration.value = block ? (block.end - block.start) / MINUTE : 30;
    }
    function schedule(id, day, time) { var r = state.records.find(function (r) { return r.matter_id === id; }); if (r) call('onSchedule', id, schedulePatch(r, day, time)); }
    container.onclick = function (event) {
      var target = event.target.closest('button'); if (!target || !container.contains(target)) return;
      var data = target.dataset;
      if (data.mcId) call('onSelect', data.mcId);
      else if (data.mcMode) { state.mode = data.mcMode; if (typeof state.onModeChange === 'function') call('onModeChange', state.mode); else draw(); }
      else if (data.mcNav || target.hasAttribute('data-mc-today')) {
        var anchor = dateFromKey(state.anchor) || new Date(), direction = Number(data.mcNav || 0);
        if (!direction) anchor = new Date();
        else if (state.mode === 'month') { anchor.setDate(1); anchor.setMonth(anchor.getMonth() + direction); }
        else anchor = addDays(anchor, direction * (state.mode === 'agenda' ? 14 : 7));
        state.anchor = dayKey(anchor); if (typeof state.onNavigate === 'function') call('onNavigate', state.anchor); else draw();
      } else if (data.mcCreateDay) call('onCreate', schedulePatch({}, data.mcCreateDay, data.mcTime || null));
      else if (data.mcDuration) { var f = form(); f.elements.duration.value = Math.max(1, Number(f.elements.duration.value) + Number(data.mcDuration)); }
      else if (target.hasAttribute('data-mc-clear')) call('onSchedule', form().elements.matter.value, { scheduled_on: null, scheduled_start: null, scheduled_end: null });
    };
    container.oninput = function (event) { if (!event.target.classList.contains('mc-tray-search')) return; var query = event.target.value.trim().toLocaleLowerCase(); container.querySelectorAll('.mc-tray-items [data-mc-id]').forEach(function (button) { button.hidden = !!query && !button.textContent.toLocaleLowerCase().includes(query); }); };
    container.onchange = function (event) { if (event.target.name === 'matter') updateForm(); };
    container.onsubmit = function (event) {
      if (!event.target.hasAttribute('data-mc-form')) return; event.preventDefault();
      var f = event.target, r = state.records.find(function (r) { return r.matter_id === f.elements.matter.value; });
      if (r && f.reportValidity()) call('onSchedule', r.matter_id, schedulePatch(r, f.elements.date.value, f.elements.allDay.checked ? null : f.elements.time.value, f.elements.duration.value));
    };
    container.ondragstart = function (event) {
      var target = event.target.closest('[data-mc-id][draggable="true"]');
      if (target && event.dataTransfer) { event.dataTransfer.setData('application/x-lka-matter', target.dataset.mcId); event.dataTransfer.setData('text/plain', target.dataset.mcId); event.dataTransfer.effectAllowed = 'move'; }
    };
    container.ondragover = function (event) { var target = event.target.closest('[data-mc-drop-day],[data-mc-unschedule]'); if (target) { event.preventDefault(); container.querySelectorAll('.mc-drag-over').forEach(function (node) { if (node !== target) node.classList.remove('mc-drag-over'); }); target.classList.add('mc-drag-over'); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; } };
    container.ondragleave = function (event) { var target = event.target.closest('.mc-drag-over'); if (target && !target.contains(event.relatedTarget)) target.classList.remove('mc-drag-over'); };
    container.ondragend = function () { container.querySelectorAll('.mc-drag-over').forEach(function (node) { node.classList.remove('mc-drag-over'); }); };
    container.ondrop = function (event) {
      container.ondragend();
      var target = event.target.closest('[data-mc-drop-day],[data-mc-unschedule]'); if (!target || !event.dataTransfer) return; event.preventDefault();
      var id = event.dataTransfer.getData('application/x-lka-matter') || event.dataTransfer.getData('text/plain');
      if (!state.records.some(function (r) { return r.matter_id === id; })) return;
      if (target.hasAttribute('data-mc-unschedule')) call('onSchedule', id, { scheduled_on: null, scheduled_start: null, scheduled_end: null });
      else schedule(id, target.dataset.mcDropDay, target.dataset.mcDropTime === 'all' ? null : target.dataset.mcDropTime);
    };
    draw();
  }
  root.LkaMatterCalendar = { render: render, dayKey: dayKey, dateFromKey: dateFromKey, range: range, schedulePatch: schedulePatch, visibleItems: visibleItems };
})(typeof window !== 'undefined' ? window : globalThis);
