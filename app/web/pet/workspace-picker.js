(function () {
  'use strict';
  if (!window.LkaChatContext) return;
  var chat = window.LkaChatContext, lastFocus = null, currentPath = '', parentPath = '', roots = [];
  var generation = 0, loading = false, applying = false, nextOffset = null, sessionId = '', searchTimer;
  var overlay = document.createElement('div');
  overlay.id = 'workspacePicker'; overlay.className = 'workspace-picker-overlay'; overlay.hidden = true;
  overlay.innerHTML = '<section class="workspace-browser" role="dialog" aria-modal="true" aria-labelledby="workspacePickerTitle">' +
    '<header class="workspace-browser-header"><div><h2 id="workspacePickerTitle">选择工作目录</h2><p>浏览电脑上的文件夹，选好后再切换。</p></div><button id="workspacePickerClose" type="button" aria-label="关闭目录选择">×</button></header>' +
    '<form id="workspacePickerLocation" class="workspace-browser-location"><button id="workspacePickerUp" type="button" aria-label="返回上一级" title="返回上一级">↑</button><label class="sr-only" for="workspacePickerPath">当前浏览路径</label><input id="workspacePickerPath" autocomplete="off" placeholder="目录路径"><button type="submit">前往</button></form>' +
    '<div class="workspace-browser-layout"><aside class="workspace-browser-places" aria-label="目录位置"><div id="workspacePickerPlaces"></div></aside>' +
    '<main class="workspace-browser-main"><label class="workspace-browser-filter"><span class="sr-only">筛选当前目录中的文件夹</span><input id="workspacePickerFilter" type="search" placeholder="筛选文件夹…" autocomplete="off"></label><div id="workspacePickerList" class="workspace-browser-list" aria-label="文件夹列表" aria-busy="false"></div><button id="workspacePickerMore" class="workspace-browser-more" type="button" hidden>显示更多文件夹</button></main></div>' +
    '<p id="workspacePickerStatus" class="workspace-browser-status" role="status" aria-live="polite"></p>' +
    '<footer class="workspace-browser-footer"><div><span>将使用这个目录</span><strong id="workspacePickerSelection">尚未选择</strong></div><button id="workspacePickerCancel" type="button">取消</button><button id="workspacePickerUse" type="button" class="workspace-browser-primary" disabled>使用此目录</button></footer></section>';
  document.body.appendChild(overlay);
  function el(id) { return document.getElementById(id); }
  function notice(text, error) { el('workspacePickerStatus').textContent = text || ''; el('workspacePickerStatus').classList.toggle('error', !!error); }
  function button(text, path) {
    var node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.title = path;
    node.addEventListener('click', function () { el('workspacePickerFilter').value = ''; browse(path); }); return node;
  }
  function recentPaths() {
    var result = [], active = chat.get().workspace;
    if (active) result.push(active);
    try {
      var rows = JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4') || '[]');
      rows.forEach(function (row) { if (row.workspace && result.indexOf(row.workspace) < 0) result.push(row.workspace); });
    } catch (ignored) {}
    return result.slice(0, 6);
  }
  function requireDirectNodeEntry() {
    var status = el('workspacePickerStatus');
    status.textContent = '当前工作台通过本机代理连接节点，代理没有节点的目录授权凭据，因此不能安全地代发完整文件树请求。请在该设备的安全入口打开工作台后选择目录。';
    status.classList.add('error');
    var host = window.LkaHost, info = host && host.info, id = info && (info.node_id || info.device_id);
    var directory = host && host.directory ? host.directory() : null;
    var devices = directory && Array.isArray(directory.devices) ? directory.devices : [];
    var device = devices.find(function (item) { return id && (item.node_id || item.device_id) === id; });
    var origin = device && (device.advertised_url || device.origin);
    if (!origin) return;
    try {
      var url = new URL('/desktop-pet/connect.html', origin);
      if (url.protocol !== 'https:' || !/\.ts\.net$/.test(url.hostname)) return;
      var link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = '打开此设备的安全入口'; link.className = 'workspace-browser-node-entry';
      status.appendChild(document.createTextNode(' ')); status.appendChild(link);
    } catch (ignored) {}
  }
  function renderPlaces() {
    var places = el('workspacePickerPlaces'); places.textContent = '';
    var heading = document.createElement('h3'); heading.textContent = '位置'; places.appendChild(heading);
    roots.forEach(function (root) { places.appendChild(button(root.name, root.path)); });
    var recent = recentPaths();
    if (recent.length) {
      heading = document.createElement('h3'); heading.textContent = '最近使用'; places.appendChild(heading);
      recent.forEach(function (path) { places.appendChild(button(path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path, path)); });
    }
  }
  function setControls() {
    var context = chat.get();
    el('workspacePickerUse').disabled = !currentPath || loading || applying || context.busy || context.sessionId !== sessionId;
    el('workspacePickerUp').disabled = !parentPath || loading || applying;
    el('workspacePickerUse').textContent = applying ? '正在切换…' : context.busy ? '任务进行中' : '使用此目录';
    el('workspacePickerList').setAttribute('aria-busy', loading ? 'true' : 'false');
    Array.prototype.forEach.call(overlay.querySelectorAll('button'), function (node) {
      if (node.id !== 'workspacePickerUse' && node.id !== 'workspacePickerUp') node.disabled = applying;
    });
  }
  async function browse(path, append, initial) {
    if (applying) return;
    clearTimeout(searchTimer);
    var requestId = ++generation, offset = append ? nextOffset : 0;
    if (append && offset == null) return;
    loading = true; notice('正在读取文件夹…'); setControls();
    if (!append) el('workspacePickerList').textContent = '';
    el('workspacePickerMore').hidden = true;
    try {
      var response, context = chat.get(), nodeBrowser = !!context.nodeBoundary;
      if (context.hosted && !nodeBrowser) {
        currentPath = ''; parentPath = ''; nextOffset = null;
        el('workspacePickerList').textContent = '';
        notice('云端助理工作台没有开放服务器目录浏览。请从设备切换器连接一台电脑，再从该电脑的工作台选择目录。', true);
        el('workspacePickerSelection').textContent = '请先连接电脑';
        return;
      }
      if (nodeBrowser && !context.nodeHosted) {
        currentPath = ''; parentPath = ''; nextOffset = null;
        el('workspacePickerList').textContent = '';
        el('workspacePickerSelection').textContent = '请打开设备的安全工作台';
        requireDirectNodeEntry();
        return;
      }
      var controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); }, 15000);
      try {
        var endpoint = nodeBrowser
          ? String(context.backend || location.origin).replace(/\/+$/, '') + '/local/filesystem/entries'
          : '/pet/workspace-directories';
        response = await fetch(endpoint + '?path=' + encodeURIComponent(path || '') + '&query=' + encodeURIComponent(el('workspacePickerFilter').value.trim()) + '&offset=' + offset + '&limit=100',
          { headers: { Accept: 'application/json' }, signal: controller.signal });
      } finally { clearTimeout(timeout); }
      var data = await response.json();
      if (!response.ok) {
        // A WSL-only or moved workspace cannot be enumerated by Windows. Offer
        // the frontend's default location without changing the session itself.
        if (initial && path && (response.status === 404 || response.status === 422)) return browse('');
        var message = response.status === 403 ? (nodeBrowser
          ? '当前设备尚未启用完整目录浏览，或连接授权已失效。请检查设备端 filesystem_browser_enabled 设置并重新连接。'
          : /permission denied/i.test(data.detail || '') ? '没有读取这个目录的权限，请选择其他位置。' : '此地址尚未允许浏览目录，请检查电脑端的工作台来源配置。') : response.status === 404 ? (nodeBrowser ? '当前设备尚未提供远程目录浏览接口，请更新设备端后再试。' : '目录不存在，检查路径或选择其他位置。') :
          response.status === 422 ? '无法浏览这个路径，请选择本机磁盘上的普通文件夹。' : '读取目录失败，请重试。';
        throw new Error(message);
      }
      if (requestId !== generation || overlay.hidden) return;
      currentPath = data.path; parentPath = data.parent || '';
      if (Array.isArray(data.roots) && data.roots.length) roots = data.roots;
      el('workspacePickerPath').value = currentPath;
      el('workspacePickerSelection').textContent = currentPath; el('workspacePickerSelection').title = currentPath;
      nextOffset = data.next_offset; renderPlaces();
      (data.directories || []).forEach(function (directory) {
        var entry = button(directory.name, directory.path); entry.className = 'workspace-browser-folder';
        var icon = document.createElement('span'); icon.className = 'workspace-browser-folder-icon'; icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 6h7l2 2h9v12H3Z"/></svg>';
        entry.insertBefore(icon, entry.firstChild); el('workspacePickerList').appendChild(entry);
      });
      if (!el('workspacePickerList').children.length) {
        var empty = document.createElement('p'); empty.className = 'workspace-browser-empty';
        empty.textContent = el('workspacePickerFilter').value.trim() ? '没有匹配的文件夹。' : '这个目录没有子文件夹，可以直接使用它。';
        el('workspacePickerList').appendChild(empty);
      }
      el('workspacePickerMore').hidden = nextOffset == null;
      notice(data.truncated ? '文件夹较多，请用筛选缩小范围或输入完整路径。' : '单击文件夹进入，确认后才切换工作区。');
    } catch (error) {
      if (requestId !== generation || overlay.hidden) return;
      // Keep the previous valid selection but never select an unreadable path.
      notice(error.name === 'AbortError' ? '读取目录超时，请选择其他位置或重试。' : error.message, true);
      el('workspacePickerPath').value = currentPath || path || '';
    } finally { if (requestId === generation) { loading = false; setControls(); } }
  }
  function open() {
    var context = chat.get();
    sessionId = context.sessionId; currentPath = ''; parentPath = ''; nextOffset = null;
    lastFocus = document.activeElement; overlay.hidden = false;
    document.body.classList.add('workspace-picker-open');
    window.dispatchEvent(new CustomEvent('lka-workspace-picker', { detail: { open: true } }));
    el('workspacePickerFilter').value = ''; el('workspacePickerSelection').textContent = '尚未选择';
    renderPlaces(); el('workspacePickerClose').focus(); browse(context.workspace, false, true);
  }
  function close() {
    if (applying) return;
    overlay.hidden = true; generation++; clearTimeout(searchTimer); loading = false;
    document.body.classList.remove('workspace-picker-open');
    window.dispatchEvent(new CustomEvent('lka-workspace-picker', { detail: { open: false } }));
    if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
  }
  el('workspacePickerClose').addEventListener('click', close);
  el('workspacePickerCancel').addEventListener('click', close);
  el('workspacePickerUp').addEventListener('click', function () { el('workspacePickerFilter').value = ''; browse(parentPath); });
  el('workspacePickerMore').addEventListener('click', function () { browse(currentPath, true); });
  el('workspacePickerLocation').addEventListener('submit', function (event) { event.preventDefault(); el('workspacePickerFilter').value = ''; browse(el('workspacePickerPath').value.trim()); });
  el('workspacePickerFilter').addEventListener('input', function () {
    generation++; loading = true; setControls(); clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { browse(currentPath); }, 180);
  });
  overlay.addEventListener('click', function (event) { if (event.target === overlay) close(); });
  el('workspacePickerUse').addEventListener('click', async function () {
    if (loading || applying || !currentPath) return;
    applying = true; setControls(); notice('正在切换工作区…');
    try {
      var context = chat.get(), nodeWorkspaceId = '';
      if (context.nodeBoundary) {
        var response = await fetch(String(context.backend || location.origin).replace(/\/+$/, '') + '/local/workspaces/selections', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ path: currentPath })
        });
        var selection = await response.json().catch(function () { return {}; });
        if (!response.ok || !selection.workspace_id) throw new Error(selection.detail || '当前设备拒绝了这个目录。');
        nodeWorkspaceId = selection.workspace_id;
      }
      if (!await chat.setWorkspace(currentPath, sessionId, nodeWorkspaceId)) throw new Error(el('runStatus').textContent || '工作区切换失败，请重试。');
      applying = false; close();
    } catch (error) { notice(error.message, true); }
    finally { applying = false; setControls(); }
  });
  document.addEventListener('keydown', function (event) {
    if (overlay.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    var nodes = Array.prototype.filter.call(overlay.querySelectorAll('button:not(:disabled),input:not(:disabled)'), function (node) { return node.getClientRects().length && !node.hidden; });
    if (!nodes.length) return;
    if (event.shiftKey && (document.activeElement === nodes[0] || !overlay.contains(document.activeElement))) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
    else if (!event.shiftKey && (document.activeElement === nodes[nodes.length - 1] || !overlay.contains(document.activeElement))) { event.preventDefault(); nodes[0].focus(); }
  }, true);
  new MutationObserver(function () { if (!overlay.hidden) setControls(); }).observe(el('sendButton'), { attributes: true, attributeFilter: ['disabled'] });
  window.addEventListener('lka-session-context', function () {
    if (!overlay.hidden) {
      setControls();
      if (chat.get().sessionId !== sessionId) notice('会话已改变，请关闭后重新选择工作目录。', true);
    }
  });
  el('browseWorkspaceButton').addEventListener('click', open);
  window.LkaWorkspacePicker = { open: open, close: close, isOpen: function () { return !overlay.hidden; } };
}());
