(function () {
  'use strict';
  var STORE = 'lka-conversation-positions-v1', LIMIT = 100;
  var memory = Object.create(null);
  function hash(text) {
    var a = 2166136261, b = 5381;
    for (var i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
    return (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
  }
  function valid(value) {
    return value && typeof value === 'object' && typeof value.bottom === 'boolean'
      && Number.isFinite(value.top) && value.top >= 0 && Number.isFinite(value.updatedAt);
  }
  function readStore() {
    var values = Object.create(null);
    try {
      var raw = JSON.parse(window.localStorage.getItem(STORE) || '{}');
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) Object.keys(raw).forEach(function (key) { if (valid(raw[key])) values[key] = raw[key]; });
    } catch (_) {}
    Object.keys(memory).forEach(function (key) { if (!values[key] || memory[key].updatedAt >= values[key].updatedAt) values[key] = memory[key]; });
    return values;
  }
  function save(key, value) {
    var values = readStore(); values[key] = value;
    var keys = Object.keys(values).sort(function (a, b) { return values[b].updatedAt - values[a].updatedAt; });
    keys.slice(LIMIT).forEach(function (old) { delete values[old]; });
    memory = values;
    try { window.localStorage.setItem(STORE, JSON.stringify(values)); } catch (_) {}
  }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function layoutTop(node) {
    var top = 0;
    for (; node; node = node.offsetParent) top += node.offsetTop || 0;
    return top;
  }
  function create(options) {
    var container = options.container;
    if (!container) throw new Error('Conversation position requires a container.');
    var prefix = hash(String(options.namespace || '')) + '/' + (options.surface === 'quick' ? 'quick' : 'work') + '/';
    var selector = options.messageSelector || '.message';
    var owner = '', position = null, rendering = false, disposed = false, frame = null, programTop = null, constrained = false;
    var persistTimer = null, watched = [], resizeObserver = null, appliedGeometry = null;
    var previousOverflowAnchor = container.style.overflowAnchor;
    container.style.overflowAnchor = 'none';
    function sessionId() { return String(options.getSessionId ? options.getSessionId() || '' : owner); }
    function rows() { return Array.prototype.filter.call(container.querySelectorAll(selector), function (row) { return !row.hidden && row.getClientRects().length; }); }
    function rowKey(row, index) {
      if (options.getMessageKey) {
        var key = options.getMessageKey(row, index);
        if (key != null && key !== '') return 'id:' + String(key).slice(0, 200);
      }
      var stable = row.getAttribute('data-message-id') || row.getAttribute('data-client-id') || row.getAttribute('data-conversation-message-id');
      if (stable) return 'id:' + stable.slice(0, 200);
      var body = row.querySelector('.message-content') || row;
      var text = (body.textContent || '').replace(/\s+/g, ' ').trim();
      var role = row.classList.contains('user') ? 'user' : 'assistant';
      return 'text:' + hash(role + ':' + text.length + ':' + text.slice(0, 160) + ':' + text.slice(-80));
    }
    function relativeTop(row) { return layoutTop(row) - layoutTop(container) - container.clientTop; }
    function maxTop() { return Math.max(0, container.scrollHeight - container.clientHeight); }
    function writePosition() {
      if (!owner || !position) return;
      var record = copy(position); record.updatedAt = Date.now();
      save(prefix + encodeURIComponent(owner), record);
    }
    function queuePersist() {
      if (persistTimer != null) return;
      persistTimer = window.setTimeout(function () { persistTimer = null; writePosition(); }, 180);
    }
    function remember(updateIntent) {
      if (!owner || !position || rendering || !container.clientHeight) return;
      // A newly focused question may need quick layout to add reading space.
      // Automatic captures must not replace that intent with the clamped viewport.
      if (!updateIntent && constrained) return;
      if (updateIntent) constrained = false;
      var list = rows();
      if (!list.length) return;
      var top = Math.max(0, container.scrollTop);
      if (updateIntent) position.bottom = maxTop() - top <= (options.bottomThreshold == null ? 32 : options.bottomThreshold);
      position.top = top;
      var base = layoutTop(container) + container.clientTop;
      var index = list.findIndex(function (row) { return layoutTop(row) - base + row.offsetHeight > top + 1; });
      if (index < 0) index = list.length - 1;
      var row = list[index], key = rowKey(row, index), occurrence = 0;
      for (var i = 0; i < index; i++) if (rowKey(list[i], i) === key) occurrence++;
      position.anchor = { key: key, index: index, occurrence: occurrence, offset: relativeTop(row) - top };
    }
    function geometryMatches() {
      return appliedGeometry && appliedGeometry.width === container.clientWidth
        && appliedGeometry.height === container.clientHeight && Math.abs(appliedGeometry.max - maxTop()) <= 1;
    }
    function takeUnreportedScroll() {
      // Native/class changes can reflow the transcript before ResizeObserver's
      // first callback. Only unchanged geometry proves a changed scroll offset
      // is new reading input rather than layout clamping.
      if (programTop == null || Math.abs(container.scrollTop - programTop) <= 1 || !geometryMatches()) return false;
      remember(true); programTop = container.scrollTop; queuePersist();
      return true;
    }
    function apply() {
      if (disposed || rendering || !owner || !position || !container.clientHeight) return;
      takeUnreportedScroll();
      var list = rows(), top = position.top;
      if (position.bottom) top = maxTop();
      else if (list.length && position.anchor) {
        var anchor = position.anchor;
        var matches = list.filter(function (row, index) { return rowKey(row, index) === anchor.key; });
        var row = matches[Math.min(Number(anchor.occurrence) || 0, matches.length - 1)] || list[Math.min(Math.max(0, anchor.index || 0), list.length - 1)];
        if (row && Number.isFinite(anchor.offset)) top = relativeTop(row) - anchor.offset;
      }
      var reachableTop = Math.max(0, Math.min(maxTop(), top));
      constrained = !position.bottom && Math.abs(reachableTop - top) > 1;
      top = reachableTop;
      if (Math.abs(container.scrollTop - top) > 0.5) container.scrollTop = top;
      programTop = container.scrollTop;
      appliedGeometry = { width: container.clientWidth, height: container.clientHeight, max: maxTop() };
    }
    function watchRows() {
      if (!resizeObserver) return;
      var next = rows();
      watched.forEach(function (row) { if (next.indexOf(row) < 0) resizeObserver.unobserve(row); });
      next.forEach(function (row) { if (watched.indexOf(row) < 0) resizeObserver.observe(row); });
      watched = next;
    }
    function schedule() {
      if (disposed || frame != null || !owner || rendering) return;
      frame = window.requestAnimationFrame(function () { frame = null; watchRows(); apply(); });
    }
    function capture() {
      if (!position || !owner) return null;
      // A mutation/reflow may have happened just before navigation. Reconcile
      // its saved anchor before replacing it with current layout coordinates.
      if (!rendering) apply();
      remember(false); writePosition();
      return copy(position);
    }
    function restore(id) {
      id = String(id == null ? sessionId() : id);
      if (id !== owner) {
        if (owner) capture();
        owner = id; constrained = false; programTop = null; appliedGeometry = null;
        var saved = readStore()[prefix + encodeURIComponent(id)];
        position = saved ? copy(saved) : { top: 0, bottom: true, anchor: null, updatedAt: Date.now() };
      }
      rendering = false;
      watchRows(); apply(); schedule();
      return position ? copy(position) : null;
    }
    function beforeRender() {
      if (!rendering) capture();
      rendering = true; programTop = null; appliedGeometry = null;
    }
    function afterRender() {
      var id = sessionId();
      if (id !== owner || !position) return restore(id);
      rendering = false; watchRows(); apply(); schedule();
      return copy(position);
    }
    function followLatest(settings) {
      if (!position || sessionId() !== owner) restore(sessionId());
      if (settings && settings.force) {
        position.bottom = true; position.anchor = null; programTop = null; appliedGeometry = null;
      }
      apply(); schedule();
      return !!position.bottom;
    }
    function focusRow(row) {
      if (!row || !container.contains(row)) return false;
      if (!position || sessionId() !== owner) restore(sessionId());
      var list = rows(), index = list.indexOf(row);
      if (index < 0) return false;
      var key = rowKey(row, index), occurrence = 0;
      for (var i = 0; i < index; i++) if (rowKey(list[i], i) === key) occurrence++;
      var offset = parseFloat(window.getComputedStyle(container).paddingTop) || 0;
      position.bottom = false; programTop = null; appliedGeometry = null;
      position.top = Math.max(0, relativeTop(row) - offset);
      position.anchor = { key: key, index: index, occurrence: occurrence, offset: offset };
      apply(); schedule(); writePosition();
      return true;
    }
    function onScroll() {
      if (disposed || rendering || !position || !owner || !container.clientHeight) return;
      if (programTop != null && Math.abs(container.scrollTop - programTop) <= 1) return;
      if (!takeUnreportedScroll()) schedule();
    }
    function leave() { capture(); }
    function visibility() { if (document.visibilityState === 'hidden') leave(); }
    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('load', schedule, true);
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', visibility);
    var mutationObserver = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
    if (mutationObserver) mutationObserver.observe(container, { childList: true, characterData: true, subtree: true });
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(container);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule, function () {});
    return {
      capture: capture, restore: restore, beforeRender: beforeRender, afterRender: afterRender, followLatest: followLatest,
      isFollowingLatest: function () { return !position || position.bottom; }, focusRow: focusRow,
      dispose: function () {
        if (disposed) return;
        capture(); disposed = true;
        if (frame != null) window.cancelAnimationFrame(frame);
        if (persistTimer != null) window.clearTimeout(persistTimer);
        if (mutationObserver) mutationObserver.disconnect();
        if (resizeObserver) resizeObserver.disconnect();
        container.removeEventListener('scroll', onScroll);
        container.removeEventListener('load', schedule, true);
        window.removeEventListener('pagehide', leave);
        document.removeEventListener('visibilitychange', visibility);
        container.style.overflowAnchor = previousOverflowAnchor;
      }
    };
  }
  window.LkaConversationPosition = { create: create };
}());
