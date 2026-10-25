/* 设备与账号: one panel for every multi-device control.
   hub page    — same-origin account cookie; devices, grants, remote tasks, sync review.
   local page  — the 8780 service signs in to the cloud natively (/cloud-auth, /cloud).
   node page   — this computer's connection, other devices, shared memory mirror. */
(function () {
  'use strict';
  var host = window.LkaHost, chat = window.LkaChatContext;
  if (!host || !chat || !document.body.classList.contains('work-mode')) return;
  // The Java pet window counts as the pet: no device switching there.
  var nativeWindow = !!window.petBridge || document.body.classList.contains('native-composer');
  var mobile = document.body.classList.contains('mobile-workbench');
  var state = { tab: 'overview', devices: [], deviceOffset: 0, deviceMore: false, tasks: new Map(), commandIds: new Map(), decisions: new Map(), watchers: new Map(), focusTask: '',
    memoryDraft: null, memoryDraftId: '', sharedRecords: [], sharedWritable: false, lastFocus: null, generation: 0 };
  function $(id) { return document.getElementById(id); }
  function node(tag, className, text) { var item = document.createElement(tag); if (className) item.className = className; if (text !== undefined && text !== null) item.textContent = String(text); return item; }
  function button(text, onClick, className) {
    var item = node('button', className || 'cl-button', text); item.type = 'button';
    item.addEventListener('click', function () {
      if (item.disabled) return;
      item.disabled = true;
      Promise.resolve().then(onClick).catch(fail).finally(function () { if (item.isConnected) item.disabled = false; });
    });
    return item;
  }
  function field(label, input, hint) {
    var wrap = node('label', 'cl-field'); wrap.appendChild(node('span', '', label)); wrap.appendChild(input);
    if (hint) wrap.appendChild(node('small', '', hint));
    return wrap;
  }
  function input(type, attrs) { var item = document.createElement(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') item.type = type; Object.keys(attrs || {}).forEach(function (key) { item.setAttribute(key, attrs[key]); }); return item; }
  function uuid() { return window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }
  function when(value) {
    if (!value) return '—';
    var date = typeof value === 'number' ? new Date(value * (value < 1e12 ? 1000 : 1)) : new Date(value);
    return isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function notice(text, error) { var bar = $('clNotice'); if (!bar) return; bar.textContent = text || ''; bar.hidden = !text; bar.classList.toggle('is-error', !!error); }
  function fail(error) { if (error && error.name === 'AbortError') return; notice(error && error.message || String(error), true); }
  function mode() { return host.hosted ? host.role : 'local'; }
  function cloudClient() { return !host.hosted && host.clientMode === 'cloud'; }
  function cloud() { return host.cloudBase(); }
  function api(path, options) {
    var base = cloud();
    if (base === null) return Promise.reject(Object.assign(new Error('请先登录云端账号。'), { status: 401 }));
    return host.request(base, path, options);
  }
  function local(path, options) { return host.request(host.hosted ? '' : chat.get().backend, path, options); }
  function hubOrigin() { return mode() === 'hub' ? window.location.origin : mode() === 'replica' ? host.hub.origin : host.cloud.origin; }
  function stableCommand(key) { if (!state.commandIds.has(key)) state.commandIds.set(key, uuid()); return state.commandIds.get(key); }

  // ---------- Shell ----------
  var overlay = node('div', 'cl-overlay'); overlay.id = 'clusterOverlay'; overlay.hidden = true;
  overlay.innerHTML = '<section class="cl-panel" role="dialog" aria-modal="true" aria-labelledby="clTitle">' +
    '<header class="cl-head"><div><h2 id="clTitle">设备与账号</h2><p id="clPlace"></p></div><button id="clClose" class="cl-close" type="button" aria-label="关闭设备与账号">×</button></header>' +
    '<nav id="clTabs" class="cl-tabs" role="tablist" aria-label="设备与账号"></nav>' +
    '<p id="clNotice" class="cl-notice" role="status" aria-live="polite" hidden></p>' +
    '<div id="clBody" class="cl-body" tabindex="-1"></div></section>';
  document.body.appendChild(overlay);
  var tabs = {
    overview: { label: '概览', render: renderOverview },
    devices: { label: '设备', render: renderDevices, when: function () { return cloud() !== null; } },
    tasks: { label: '真理派发', render: renderTasks, when: function () { return cloud() !== null; } },
    sync: { label: '同步', render: renderSync, when: function () { return cloud() !== null; } },
    memory: { label: '共享记忆', render: renderSharedMemory, when: function () { return mode() === 'replica'; } },
    account: { label: '账号', render: renderAccount, when: function () { return mode() === 'hub' || mode() === 'replica' ? cloud() !== null : host.cloud.configured; } }
  };
  function renderTabs() {
    var bar = $('clTabs'); bar.textContent = '';
    Object.keys(tabs).forEach(function (key) {
      if (tabs[key].when && !tabs[key].when()) { if (state.tab === key) state.tab = 'overview'; return; }
      var tab = node('button', 'cl-tab', tabs[key].label); tab.type = 'button'; tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(state.tab === key));
      tab.addEventListener('click', function () { state.tab = key; render(); });
      bar.appendChild(tab);
    });
  }
  function render() {
    var generation = ++state.generation;
    renderTabs(); notice('');
    $('clPlace').textContent = placeLabel();
    var body = $('clBody'); body.textContent = '';
    Promise.resolve(tabs[state.tab].render(body, function () { return generation === state.generation; })).catch(fail);
  }
  function placeLabel() {
    var snapshot = host.snapshot();
    if (mode() === 'hub') return '云端' + (snapshot.principal && snapshot.principal.username ? ' · ' + snapshot.principal.username : '');
    if (mode() === 'replica') return '设备 · ' + (snapshot.info && snapshot.info.node_id || '本机') + (host.hub.loggedIn ? ' · 云端已连接' : host.hub.reachable ? ' · 云端未登录' : ' · 云端离线');
    return (cloudClient() ? '云端客户端' : '这台电脑') + (snapshot.cloud.loggedIn ? ' · 云端已登录' : snapshot.cloud.configured ? ' · 云端未登录' : '');
  }
  function open(tab) {
    state.lastFocus = document.activeElement;
    if (tab && tabs[tab]) state.tab = tab;
    overlay.hidden = false; render();
    setTimeout(function () { $('clClose').focus({ preventScroll: true }); }, 0);
  }
  function close() { overlay.hidden = true; state.generation++; if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus({ preventScroll: true }); }
  $('clClose').addEventListener('click', close);
  overlay.addEventListener('click', function (event) { if (event.target === overlay) close(); });
  document.addEventListener('keydown', function (event) {
    if (overlay.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    var nodes = Array.prototype.filter.call(overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary'), function (item) { return item.getClientRects().length; });
    if (!nodes.length) return;
    var first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }, true);

  // ---------- Overview ----------
  function card(title, detail, className) {
    var item = node('article', 'cl-card' + (className ? ' ' + className : ''));
    item.appendChild(node('strong', '', title));
    if (detail) item.appendChild(node('p', '', detail));
    return item;
  }
  async function renderOverview(body, current) {
    var snapshot = host.snapshot();
    if (mode() === 'replica') {
      var me = snapshot.principal || {};
      var here = card('你正在直接使用 ' + (snapshot.info && snapshot.info.node_id || '这台设备'),
        '对话与文件都在这台设备上处理。云端暂时无法连接时，这里仍然可用。', 'cl-card-here');
      var facts = node('dl', 'cl-facts');
      [['可用工作区', (me.workspace_ids || []).join('、') || '无'], ['连接有效至', when(me.expires_at)], ['操作凭据', snapshot.csrf ? '已就绪' : '缺失，需重新进入']].forEach(function (row) {
        facts.appendChild(node('dt', '', row[0])); facts.appendChild(node('dd', '', row[1]));
      });
      here.appendChild(facts);
      body.appendChild(here);
      body.appendChild(hubStatusCard());
      var cache = node('p', 'cl-muted', '正在读取共享记忆缓存…'); body.appendChild(cache);
      local('/local/cache').then(function (value) {
        if (!current()) return;
        if (!value || !value.available) { cache.textContent = '共享记忆尚未同步；使用本机记忆。'; return; }
        var age = typeof value.age_seconds === 'number' ? (value.age_seconds < 90 ? Math.round(value.age_seconds) + ' 秒前' : value.age_seconds < 5400 ? Math.round(value.age_seconds / 60) + ' 分钟前' : Math.round(value.age_seconds / 3600) + ' 小时前') : '时间未知';
        cache.textContent = '共享记忆缓存' + (value.stale ? '可能落后' : '较新') + '，最近同步 ' + age + '。' + (value.memory_aggregation && value.memory_aggregation.enabled ? '自动学习的记忆会同步到云端。' : '');
      }).catch(function () { if (current()) cache.textContent = '暂时无法读取缓存状态；普通会话不受影响。'; });
      body.appendChild(connectionsSection(current));
      var leave = node('div', 'cl-actions');
      leave.appendChild(button('退出这台设备', async function () {
        await local('/connections/logout', { method: 'POST', json: {} });
        host.setCsrf(''); window.location.replace(host.entryUrl());
      }, 'cl-button cl-danger'));
      body.appendChild(leave);
      return;
    }
    if (mode() === 'hub') {
      body.appendChild(card('云端 · 真理与共享数据', '真理、待办、项目和记忆都在云端。普通会话和文件属于各自的电脑；用顶栏的位置标记切换到那台电脑。', 'cl-card-here'));
      return;
    }
    // Local 8780 workbench.
    var role = snapshot.backendRole;
    var localCard = card(cloudClient() ? '云端客户端' : '这台电脑', cloudClient()
      ? '本机仅运行界面和桌宠，会话与助理由云端处理；其他电脑的工作区可从顶栏位置菜单进入。'
      : role === 'replica' ? '本机后端是集群节点：普通会话和文件在本机，真理、待办与记忆来自云端。'
      : role === 'hub' ? '本机后端就是云端。' : '本机后端独立运行，现有功能保持不变。', 'cl-card-here');
    body.appendChild(localCard);
    if (!snapshot.cloud.configured) {
      body.appendChild(card('尚未配置云端', '在前端服务的 .env 中设置 LKA_CLOUD_ORIGIN（云端 HTTPS 地址）并重启前端服务后，可在这里登录云端账号。'));
      return;
    }
    if (!snapshot.cloud.loggedIn) { body.appendChild(cloudLoginForm()); return; }
    body.appendChild(card('云端已登录 · ' + (snapshot.cloud.account && snapshot.cloud.account.username || ''), '登录由本机服务保管；是否在重启后保留，取决于本机的加密会话配置。'));
  }
  async function enter(device) {
    var id = device.node_id || device.device_id;
    // Hosted hub pages issue the grant with their cookie; the local page through the gateway.
    var issued = mode() === 'local' ? await host.request('', '/cloud-auth/connections/' + encodeURIComponent(id), { method: 'POST', json: {} })
      : await api('/devices/' + encodeURIComponent(id) + '/connections', { method: 'POST', json: {} });
    var origin = new URL(issued.origin);
    if (origin.protocol !== 'https:' || !/\.ts\.net$/.test(origin.hostname)) throw new Error('设备地址不是已批准的 Tailscale HTTPS 地址。');
    var directory = { hub: hubOrigin(), devices: state.devices.length ? state.devices : host.directory().devices };
    var target = new URL('/desktop-pet/connect.html', origin.origin);
    if (mobile) target.searchParams.set('layout', 'mobile');
    var encoded = btoa(String.fromCharCode.apply(null, new TextEncoder().encode(JSON.stringify({ hub: directory.hub, devices: directory.devices.map(function (item) {
      return { node_id: item.node_id || item.device_id, name: item.name, platform: item.platform, origin: item.advertised_url || item.origin || '' };
    }) })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    target.hash = new URLSearchParams({ grant: issued.grant, dir: encoded }).toString();
    if (mode() === 'local') window.open(target.href, '_blank', 'noopener');
    else window.location.assign(target.href);
  }
  function connectionsSection(current) {
    var section = node('section', 'cl-section'); section.appendChild(node('h3', '', '我在这台设备的连接'));
    var list = node('div', 'cl-list'); section.appendChild(list);
    local('/connections/sessions').then(function (data) {
      if (!current()) return;
      (data && data.items || []).forEach(function (item) {
        var row = node('div', 'cl-row');
        row.appendChild(node('span', '', (item.current ? '当前浏览器' : '其他浏览器') + ' · 有效至 ' + when(item.expires_at)));
        row.appendChild(button(item.current ? '退出' : '撤销', async function () {
          await local('/connections/sessions/' + encodeURIComponent(item.session_id), { method: 'DELETE' });
          if (item.current) { host.setCsrf(''); window.location.replace(host.entryUrl()); } else render();
        }, 'cl-button cl-quiet'));
        list.appendChild(row);
      });
    }).catch(function () { if (current()) list.appendChild(node('p', 'cl-muted', '连接列表暂不可用。')); });
    return section;
  }
  function cloudLoginForm() {
    var form = node('form', 'cl-form cl-card');
    form.appendChild(node('strong', '', '登录云端账号'));
    form.appendChild(node('p', 'cl-muted', '登录后，桌宠和本机工作台可以使用云端真理，并管理设备。密码只用于这次登录，不会保存。'));
    var user = input('text', { autocomplete: 'username', maxlength: '64', required: '', autocapitalize: 'none', spellcheck: 'false' });
    var pass = input('password', { autocomplete: 'current-password', maxlength: '256', required: '' });
    form.appendChild(field('账号', user)); form.appendChild(field('密码', pass));
    var submit = node('button', 'cl-button cl-primary', '登录'); submit.type = 'submit'; form.appendChild(submit);
    form.addEventListener('submit', async function (event) {
      event.preventDefault(); submit.disabled = true;
      var password = pass.value; pass.value = '';
      try {
        await host.request('', '/cloud-auth/login', { method: 'POST', json: { username: user.value.trim(), password: password } });
        await host.refreshCloud();
        if (cloudClient()) { window.location.reload(); return; }
        notice('已登录云端。'); render();
      } catch (error) { fail(error); } finally { submit.disabled = false; }
    });
    return form;
  }

  // ---------- Devices ----------
  async function renderDevices(body, current) {
    var head = node('div', 'cl-section-head'); head.appendChild(node('h3', '', '已登记的设备'));
    head.appendChild(button('登记设备', function () { deviceEditor(body, null); }, 'cl-button cl-primary'));
    body.appendChild(head);
    var list = node('div', 'cl-list'); body.appendChild(list);
    var data = await api('/devices?limit=100&offset=' + state.deviceOffset);
    if (!current()) return;
    state.devices = data && data.items || [];
    host.saveDirectory({ hub: hubOrigin(), devices: state.devices.filter(function (item) { return !item.revoked; }).map(function (item) {
      return { node_id: item.node_id || item.device_id, name: item.name, platform: item.platform, origin: item.advertised_url || '' };
    }) });
    if (!state.devices.length) list.appendChild(node('p', 'cl-muted', '还没有登记设备。'));
    state.devices.forEach(function (device) {
      var id = device.node_id || device.device_id;
      var item = node('details', 'cl-device-card' + (device.revoked ? ' is-revoked' : device.online ? ' is-online' : ''));
      var summary = node('summary'); var dot = node('span', 'cl-dot'); dot.setAttribute('aria-hidden', 'true'); summary.appendChild(dot);
      summary.appendChild(node('strong', '', device.name || id));
      summary.appendChild(node('small', '', device.revoked ? '已撤销' : device.online ? '在线' : '离线 · ' + when(device.last_seen)));
      item.appendChild(summary);
      var facts = node('dl', 'cl-facts');
      [['设备 ID', id], ['平台', device.platform], ['执行系统', (device.systems || []).map(function (system) { return system.environment_id + (system.platform ? '（' + system.platform + '）' : ''); }).join('、') || '—'],
        ['工作区', (device.workspace_ids || []).join('、') || '—'], ['权限', (device.scopes || []).join('、')], ['直连地址', device.advertised_url || '未设置'], ['修订', device.revision]].forEach(function (row) {
        facts.appendChild(node('dt', '', row[0])); facts.appendChild(node('dd', '', row[1]));
      });
      item.appendChild(facts);
      if (!device.revoked) {
        var actions = node('div', 'cl-actions');
        if (device.advertised_url && !nativeWindow) actions.appendChild(button('进入', function () { return enter(device); }, 'cl-button cl-primary'));
        actions.appendChild(button('编辑', function () { deviceEditor(body, device); }, 'cl-button'));
        actions.appendChild(button('撤销我的连接', async function () {
          await api('/devices/' + encodeURIComponent(id) + '/connections/revoke', { method: 'POST', json: {} });
          notice('已撤销。设备下次连上云端时生效；离线设备暂时保留原连接。');
        }, 'cl-button cl-quiet'));
        actions.appendChild(button('轮换令牌', async function () {
          if (!window.confirm('轮换后旧设备令牌立即失效，需要把新令牌配置到设备上。继续吗？')) return;
          var result = await api('/devices/' + encodeURIComponent(id) + '/rotate', { method: 'POST', json: { expected_revision: device.revision } });
          showToken(body, result.token, device.name || id); render();
        }, 'cl-button cl-quiet'));
        actions.appendChild(button('撤销设备', async function () {
          if (!window.confirm('撤销后这台设备立即失去全部授权，无法恢复。继续吗？')) return;
          await api('/devices/' + encodeURIComponent(id) + '/revoke', { method: 'POST', json: { expected_revision: device.revision } });
          notice('设备已撤销。'); render();
        }, 'cl-button cl-danger'));
        item.appendChild(actions);
      }
      list.appendChild(item);
    });
    body.appendChild(selectionSection(current));
  }
  function showToken(body, token, name) {
    var box = node('section', 'cl-token');
    box.appendChild(node('strong', '', name + ' 的设备令牌'));
    box.appendChild(node('p', '', '只显示这一次。复制后配置到设备的 LKA_NODE_TOKEN 环境变量；不要放进聊天、截图或代码仓库。'));
    var value = input('text', { readonly: '', 'aria-label': '设备令牌' }); value.value = token; box.appendChild(value);
    var actions = node('div', 'cl-actions');
    actions.appendChild(button('复制', async function () { await navigator.clipboard.writeText(token); notice('已复制。'); }, 'cl-button cl-primary'));
    actions.appendChild(button('我已保存', function () { value.value = ''; box.remove(); }, 'cl-button'));
    box.appendChild(actions);
    body.prepend(box); value.select();
  }
  function deviceEditor(body, device) {
    var existing = body.querySelector('.cl-editor'); if (existing) existing.remove();
    var form = node('form', 'cl-editor cl-card');
    form.appendChild(node('strong', '', device ? '编辑 ' + (device.name || device.node_id) : '登记新设备'));
    var id = input('text', { required: '', maxlength: '120', pattern: '[A-Za-z0-9_.\\-]+', autocapitalize: 'none', spellcheck: 'false' });
    var name = input('text', { required: '', maxlength: '120' });
    var platform = document.createElement('select');
    ['windows', 'linux', 'macos', 'android', 'ios'].forEach(function (value) { var option = node('option', '', value); option.value = value; platform.appendChild(option); });
    var systems = input('text', { placeholder: 'wsl:linux, windows:windows', maxlength: '600' });
    var workspaces = input('text', { placeholder: 'work, notes', maxlength: '2000' });
    var url = input('url', { placeholder: 'https://desktop.example.ts.net', maxlength: '300' });
    var scopeBox = node('fieldset', 'cl-scopes'); scopeBox.appendChild(node('legend', '', '授权范围'));
    var scopeNames = { heartbeat: '心跳', 'sync.read': '读取共享数据', 'sync.propose': '提交候选', 'connections.poll': '接收直连授权', 'execution.poll': '领取远程任务',
      'execution.run': '执行远程任务', 'execution.result': '回报任务结果', 'sync.memory.write': '人工共享记忆写入', 'sync.memory.aggregate': '自动记忆同步' };
    var chosen = device ? device.scopes || [] : ['heartbeat', 'sync.read', 'connections.poll'];
    Object.keys(scopeNames).forEach(function (scope) {
      var label = node('label', 'cl-check'), box = input('checkbox', { value: scope }); box.checked = chosen.indexOf(scope) >= 0; box.disabled = scope === 'heartbeat';
      label.appendChild(box); label.appendChild(node('span', '', scopeNames[scope])); scopeBox.appendChild(label);
    });
    if (device) {
      id.value = device.device_id || device.node_id; id.readOnly = true; name.value = device.name || ''; platform.value = device.platform || 'linux';
      systems.value = (device.systems || []).map(function (system) { return system.environment_id + (system.platform ? ':' + system.platform : ''); }).join(', ');
      workspaces.value = (device.workspace_ids || []).join(', '); url.value = device.advertised_url || '';
    }
    form.appendChild(field('设备 ID', id, '登记后不可更改，例如 desktop-a'));
    form.appendChild(field('名称', name)); form.appendChild(field('平台', platform));
    form.appendChild(field('执行系统', systems, '环境 ID:平台，逗号分隔；留空使用设备平台'));
    form.appendChild(field('工作区 ID', workspaces, '设备本机配置中已映射的工作区 ID，不是路径'));
    form.appendChild(field('直连地址', url, '仅接受 Tailscale HTTPS 地址（*.ts.net），留空则不开放直接进入'));
    form.appendChild(scopeBox);
    var actions = node('div', 'cl-actions');
    var submit = node('button', 'cl-button cl-primary', device ? '保存' : '登记'); submit.type = 'submit';
    actions.appendChild(submit); actions.appendChild(button('取消', function () { form.remove(); }, 'cl-button cl-quiet'));
    form.appendChild(actions);
    form.addEventListener('submit', async function (event) {
      event.preventDefault(); submit.disabled = true;
      try {
        var workspaceIds = workspaces.value.split(/[,，\s]+/).map(function (value) { return value.trim(); }).filter(Boolean);
        var systemList = systems.value.split(/[,，]+/).map(function (value) { return value.trim(); }).filter(Boolean).map(function (value) {
          var parts = value.split(':'); return { environment_id: parts[0].trim(), platform: (parts[1] || '').trim(), workspace_ids: workspaceIds };
        });
        if (!systemList.length) systemList = [{ environment_id: platform.value, platform: platform.value, workspace_ids: workspaceIds }];
        var payload = { device_id: id.value.trim(), name: name.value.trim(), platform: platform.value, systems: systemList, workspace_ids: workspaceIds,
          scopes: Array.prototype.filter.call(scopeBox.querySelectorAll('input'), function (box) { return box.checked; }).map(function (box) { return box.value; }),
          advertised_url: url.value.trim() || null };
        if (device) {
          payload.expected_revision = device.revision; payload.capabilities = device.capabilities || [];
          await api('/devices/' + encodeURIComponent(payload.device_id), { method: 'PATCH', json: payload });
          notice('已保存。'); render();
        } else {
          var created = await api('/devices', { method: 'POST', json: payload });
          render(); setTimeout(function () { showToken($('clBody'), created.token, payload.name); }, 60);
        }
      } catch (error) {
        fail(error.status === 409 ? Object.assign(new Error('设备已被其他操作修改或 ID 已存在，请刷新后重试。'), { status: 409 }) : error);
      } finally { submit.disabled = false; }
    });
    body.prepend(form); name.focus();
  }
  function selectionSection(current) {
    var section = node('details', 'cl-section cl-fold');
    section.appendChild(node('summary', '', '连接偏好'));
    section.appendChild(node('p', 'cl-muted', '为不同用途记录首选设备。它只是偏好；真理派发任务时以任务里指定的目标为准，不会因为这里的改动悄悄换电脑。'));
    var key = input('text', { value: 'default', maxlength: '200' }); section.appendChild(field('用途', key));
    var modeSelect = document.createElement('select');
    [['auto', '自动选择在线设备'], ['fixed', '固定一台设备']].forEach(function (pair) { var option = node('option', '', pair[1]); option.value = pair[0]; modeSelect.appendChild(option); });
    var target = document.createElement('select'); section.appendChild(field('方式', modeSelect)); section.appendChild(field('设备', target));
    var allowed = node('fieldset', 'cl-scopes'); allowed.appendChild(node('legend', '', '允许的设备')); section.appendChild(allowed);
    var result = node('p', 'cl-muted'); var revision = 0;
    state.devices.filter(function (device) { return !device.revoked; }).forEach(function (device) {
      var id = device.node_id || device.device_id, option = node('option', '', device.name || id); option.value = id; target.appendChild(option);
      var label = node('label', 'cl-check'), box = input('checkbox', { value: id }); box.checked = true; label.appendChild(box); label.appendChild(node('span', '', device.name || id)); allowed.appendChild(label);
    });
    async function load() {
      try {
        var saved = await api('/devices/selection?selection_key=' + encodeURIComponent(key.value.trim() || 'default'));
        revision = saved.revision || 0; modeSelect.value = saved.mode || 'auto'; if (saved.device_id) target.value = saved.device_id;
        Array.prototype.forEach.call(allowed.querySelectorAll('input'), function (box) { box.checked = (saved.allowed_device_ids || []).indexOf(box.value) >= 0; });
        result.textContent = '已读取修订 ' + revision + '。';
      } catch (error) { revision = 0; result.textContent = error.status === 404 ? '这个用途还没有保存偏好。' : error.message; }
    }
    var actions = node('div', 'cl-actions');
    actions.appendChild(button('读取', load, 'cl-button cl-quiet'));
    actions.appendChild(button('保存', async function () {
      var ids = Array.prototype.filter.call(allowed.querySelectorAll('input'), function (box) { return box.checked; }).map(function (box) { return box.value; });
      try {
        var saved = await api('/devices/selection?selection_key=' + encodeURIComponent(key.value.trim() || 'default'), { method: 'PUT', json: {
          mode: modeSelect.value, device_id: modeSelect.value === 'fixed' ? target.value : null, allowed_device_ids: ids, capabilities: [], expected_revision: revision } });
        revision = saved.revision || revision + 1; result.textContent = '已保存。';
      } catch (error) { if (error.status === 409) { result.textContent = '偏好已被其他地方修改，已重新读取，请核对后再保存。'; await load(); } else throw error; }
    }, 'cl-button'));
    actions.appendChild(button('测试解析', async function () {
      try {
        var resolved = await api('/devices/selection/resolve?selection_key=' + encodeURIComponent(key.value.trim() || 'default'), { method: 'POST', json: {} });
        result.textContent = '当前会选择 ' + resolved.device_id + (resolved.environment_id ? ' / ' + resolved.environment_id : '') + (resolved.remote_execution_available ? '，可以执行远程任务。' : '，暂不能执行远程任务。');
      } catch (error) { result.textContent = error.status === 409 ? '没有符合条件的在线设备；不会自动换到其他电脑。' : error.message; }
    }, 'cl-button cl-quiet'));
    section.appendChild(actions); section.appendChild(result);
    section.addEventListener('toggle', function () { if (section.open && current()) load(); }, { once: true });
    return section;
  }

  // ---------- Remote tasks ----------
  var taskStates = { queued: '等待领取', leased: '设备已领取', running: '正在执行', waiting_confirmation: '等待你确认', waiting_user: '等待你回答', paused: '已暂停',
    resuming: '恢复中 · 等待设备确认', completed: '已完成', failed: '失败', timed_out: '已超时', cancelled: '已取消', unknown: '结果不明 · 不会自动重做' };
  var terminal = ['completed', 'failed', 'timed_out', 'cancelled', 'unknown'];
  async function renderTasks(body, current) {
    var targetsBox = node('section', 'cl-section'); targetsBox.appendChild(node('h3', '', '可执行的设备'));
    var targets = node('div', 'cl-chips'); targetsBox.appendChild(targets); body.appendChild(targetsBox);
    api('/remote-execution/targets').then(function (data) {
      if (!current()) return;
      var items = data && (data.items || data.targets) || [];
      if (!items.length) targets.appendChild(node('span', 'cl-muted', '没有授权执行的设备。'));
      items.forEach(function (device) {
        (device.systems || [device]).forEach(function (system) {
          var chip = node('span', 'cl-chip' + (system.execution_online ? ' is-online' : ''), (device.name || device.device_id || device.node_id) + ' · ' + (system.environment_id || ''));
          chip.title = system.execution_online ? '执行器在线' : '执行器离线'; targets.appendChild(chip);
        });
      });
    }).catch(function (error) { if (current()) targets.appendChild(node('span', 'cl-muted', error.status === 404 ? '云端未开启远程执行。' : error.message)); });
    var listHead = node('div', 'cl-section-head'); listHead.appendChild(node('h3', '', '真理派出的任务'));
    listHead.appendChild(button('刷新', render, 'cl-button cl-quiet')); body.appendChild(listHead);
    var list = node('div', 'cl-list'); body.appendChild(list);
    var data = await api('/remote-execution/tasks?limit=50&offset=0');
    if (!current()) return;
    var items = data && data.items || [];
    if (mode() === 'replica') {
      var currentNode = host.snapshot().info && host.snapshot().info.node_id || '';
      items = items.filter(function (task) { return task.node_id === currentNode || task.task_id === state.focusTask; });
    }
    // A reminder can point at a task older than the first page; fetch it directly.
    var focus = state.focusTask; state.focusTask = '';
    if (focus && !items.some(function (task) { return task.task_id === focus; })) {
      try { items.unshift(await api('/remote-execution/tasks/' + encodeURIComponent(focus) + '?limit=1&offset=0')); } catch (error) { notice('找不到这个远程任务：' + error.message, true); }
    }
    if (!items.length) list.appendChild(node('p', 'cl-muted', '还没有远程任务。和真理对话时可以让它在指定设备上处理事情。'));
    items.forEach(function (task) {
      var item = taskCard(task);
      list.appendChild(item);
      if (task.task_id === focus) { item.open = true; item.classList.add('is-focus'); setTimeout(function () { item.scrollIntoView({ block: 'start' }); }, 0); }
    });
  }
  function taskCard(task) {
    var item = node('details', 'cl-task cl-task-' + task.state);
    var summary = node('summary');
    summary.appendChild(node('strong', '', (task.title || task.session_title || task.node_id || '真理派发任务') + ' · 执行于 ' + (task.node_name || task.node_id || '指定设备') + (task.environment_id ? ' / ' + task.environment_id : '') + (task.workspace_id ? ' · ' + task.workspace_id : '')));
    summary.appendChild(node('span', 'cl-state', taskStates[task.state] || task.state));
    summary.appendChild(node('small', '', when(task.updated_at)));
    item.appendChild(summary);
    var detail = node('div', 'cl-task-body'); item.appendChild(detail);
    item.addEventListener('toggle', function () { if (item.open) loadTask(task.task_id, detail); });
    return item;
  }
  // Remote approvals: review_id → {taskId, decision, status: submitting|submitted|failed}.
  // "submitted" means the cloud accepted the decision; the device has not
  // necessarily applied it yet, so it stays visibly locked until the device moves on.
  function describeInput(review) {
    var input = review.tool_input && typeof review.tool_input === 'object' ? review.tool_input : {};
    var rows = [];
    ['command', 'path', 'cwd', 'target', 'destination', 'url', 'workspace_root'].forEach(function (key) {
      if (typeof input[key] === 'string' && input[key]) rows.push([key, input[key]]);
    });
    if (!rows.length) Object.keys(input).slice(0, 6).forEach(function (key) {
      var value = input[key]; rows.push([key, typeof value === 'string' ? value : JSON.stringify(value)]);
    });
    return rows;
  }
  function reviewBox(taskId, task, review, detail) {
    var decided = state.decisions.get(review.review_id);
    var box = node('div', 'cl-review' + (decided ? ' is-' + decided.status : ''));
    box.dataset.reviewId = review.review_id;
    var head = node('div', 'cl-review-head');
    head.appendChild(node('strong', '', review.tool_name || '待确认的操作'));
    head.appendChild(node('span', 'cl-state', review.tool_risk === 'high' ? '高风险' : review.read_only ? '只读' : '会修改内容'));
    box.appendChild(head);
    box.appendChild(node('small', 'cl-muted', (task.node_id || '设备') + (task.workspace_id ? ' · ' + task.workspace_id : '') + ' · 审批 ' + review.review_id.slice(-8)));
    var facts = describeInput(review);
    if (facts.length) {
      var list = node('dl', 'cl-facts');
      facts.forEach(function (row) { list.appendChild(node('dt', '', row[0])); var value = node('dd', 'cl-code', String(row[1]).slice(0, 600)); list.appendChild(value); });
      box.appendChild(list);
    }
    if (review.reason) box.appendChild(node('p', '', review.reason));
    var row = node('div', 'cl-actions');
    if (decided && decided.status !== 'failed') {
      row.appendChild(node('span', 'cl-muted', decided.status === 'submitting' ? '正在提交…' : (decided.decision === 'approve' ? '已批准' : '已拒绝') + '，等待设备处理'));
    } else {
      if (decided && decided.status === 'failed') row.appendChild(node('span', 'cl-error', '提交失败：' + decided.message + ' 可以重试。'));
      [['批准', 'approve', 'cl-primary'], ['拒绝', 'reject', 'cl-danger']].forEach(function (choice) {
        row.appendChild(button(choice[0], async function () {
          state.decisions.set(review.review_id, { taskId: taskId, decision: choice[1], status: 'submitting' });
          box.replaceWith(reviewBox(taskId, task, review, detail));
          try {
            await api('/remote-execution/tasks/' + encodeURIComponent(taskId) + '/reviews/' + encodeURIComponent(review.review_id), { method: 'POST', json: { decision: choice[1] } });
            state.decisions.set(review.review_id, { taskId: taskId, decision: choice[1], status: 'submitted', at: Date.now() });
          } catch (error) {
            // 409 means it was already decided (here or elsewhere); never re-offer it.
            state.decisions.set(review.review_id, error.status === 409
              ? { taskId: taskId, decision: choice[1], status: 'submitted', at: Date.now() }
              : { taskId: taskId, decision: choice[1], status: 'failed', message: error.message });
          }
          await loadTask(taskId, detail).catch(fail);
          watchTask(taskId, detail);
        }, 'cl-button ' + choice[2]));
      });
    }
    box.appendChild(row);
    return box;
  }
  // Follow a task after a decision until the device reports past the reviewed step.
  function watchTask(taskId, detail) {
    if (state.watchers.has(taskId)) return;
    var started = Date.now();
    var timer = setInterval(function () {
      var pending = Array.from(state.decisions.values()).some(function (entry) { return entry.taskId === taskId && entry.status === 'submitted'; });
      if (!detail.isConnected || !pending || Date.now() - started > 5 * 60 * 1000) { clearInterval(timer); state.watchers.delete(taskId); return; }
      loadTask(taskId, detail, null, true).catch(function () {});
    }, 3000);
    state.watchers.set(taskId, timer);
  }
  async function loadTask(taskId, detail, append, quiet) {
    if (!append && !quiet) detail.textContent = '正在读取…';
    var task = await api('/remote-execution/tasks/' + encodeURIComponent(taskId) + '?limit=20&offset=' + (append ? append.next_offset : 0));
    if (append) task.reports = (append.reports || []).concat(task.reports || []);
    state.tasks.set(taskId, task);
    // A decision is settled once the latest complete report no longer lists it.
    var reportsNow = task.reports || [], latestNow = reportsNow[reportsNow.length - 1];
    if (task.next_offset == null) {
      var stillPending = Object.create(null);
      (task.state === 'waiting_confirmation' && latestNow && latestNow.reviews || []).forEach(function (review) { stillPending[review.review_id] = true; });
      state.decisions.forEach(function (entry, reviewId) {
        if (entry.taskId === taskId && entry.status === 'submitted' && !stillPending[reviewId]) state.decisions.delete(reviewId);
      });
    }
    detail.textContent = '';
    var approval = task.approval || task._summary && task._summary.approval;
    if (approval) {
      var requested = approval.requested_mode || '未记录';
      var effective = approval.effective_mode || (approval.source === 'legacy' ? '旧任务未记录' : '等待设备回报');
      var sourceLabels = { node_policy: '设备策略', request: '任务请求', host_execution: '宿主执行限制', legacy: '旧版兼容策略' };
      detail.appendChild(node('p', 'cl-muted', '审批模式：请求 ' + requested + ' · 实际 ' + effective + (approval.source ? '（' + (sourceLabels[approval.source] || approval.source) + '）' : '')));
    }
    if (task.owner_session_id) detail.appendChild(node('p', 'cl-muted', '来源：真理会话 ' + task.owner_session_id));
    if (task.session_id) detail.appendChild(node('p', 'cl-muted', '执行会话：' + task.session_id));
    if (task.state === 'unknown') detail.appendChild(node('p', 'cl-warn', '设备没有确认最后的结果。已发生的外部操作可能已经生效，系统不会自动重做或换设备重放。'));
    if (task.state === 'resuming') detail.appendChild(node('p', 'cl-muted', '恢复指令已排队，等待设备报告继续执行。无需重复点击。'));
    var reports = task.reports || [], latest = reports[reports.length - 1], complete = task.next_offset === null || task.next_offset === undefined;
    reports.forEach(function (report) {
      if (report.error || report.error_type) detail.appendChild(node('p', 'cl-error', typeof report.error === 'string' ? report.error : '设备报告：' + (report.error_type || '执行失败')));
      if (report.result) detail.appendChild(node('pre', 'cl-result', typeof report.result.answer === 'string' ? report.result.answer : JSON.stringify(report.result, null, 2).slice(0, 20000)));
    });
    if (!complete) detail.appendChild(button('继续读取结果', function () { return loadTask(taskId, detail, task); }, 'cl-button cl-quiet'));
    var actions = node('div', 'cl-actions');
    function control(kind, values) {
      return async function () {
        var payload = Object.assign({ command_id: stableCommand(taskId + kind + JSON.stringify(values || {})) }, values || {});
        await api('/remote-execution/tasks/' + encodeURIComponent(taskId) + '/' + kind, { method: 'POST', json: payload });
        notice('指令已送达云端，等待设备处理。'); await loadTask(taskId, detail);
      };
    }
    if (['running', 'waiting_user', 'waiting_confirmation'].indexOf(task.state) >= 0) actions.appendChild(button('暂停', control('pause'), 'cl-button'));
    if (task.state === 'paused') actions.appendChild(button('继续', control('resume'), 'cl-button cl-primary'));
    if (terminal.indexOf(task.state) < 0) actions.appendChild(button('取消任务', async function () {
      if (!window.confirm('取消后设备会在下一个检查点停止，已开始的操作不会被撤回。继续吗？')) return;
      await api('/remote-execution/tasks/' + encodeURIComponent(taskId) + '/cancel', { method: 'POST', json: {} }); await loadTask(taskId, detail);
    }, 'cl-button cl-danger'));
    detail.appendChild(actions);
    // Only the latest report's pending items are current requests. Each review
    // is decided on its own; a submitted decision is never re-offered by a stale
    // report, and the next review appears as a new, separate request.
    if (complete && latest && task.state === 'waiting_confirmation') (latest.reviews || []).forEach(function (review) {
      if (review.review_id) detail.appendChild(reviewBox(taskId, task, review, detail));
    });
    if (complete && Array.from(state.decisions.values()).some(function (entry) { return entry.taskId === taskId && entry.status === 'submitted'; })) {
      detail.appendChild(node('p', 'cl-muted', '审批已提交，等待设备处理。设备继续执行后会自动刷新。'));
    }
    if (complete && latest && task.state === 'waiting_user' && latest.pending_user_question && latest.pending_user_question.question_id) {
      var question = latest.pending_user_question, answer = input('textarea', { maxlength: '16000', rows: '3', required: '' });
      var form = node('form', 'cl-form'); form.appendChild(field(question.question || question.prompt || '设备需要你补充信息', answer));
      var send = node('button', 'cl-button cl-primary', '回答并继续'); send.type = 'submit'; form.appendChild(send);
      form.addEventListener('submit', function (event) { event.preventDefault(); send.disabled = true; control('answer', { question_id: question.question_id, answer: answer.value })().catch(fail).finally(function () { send.disabled = false; }); });
      detail.appendChild(form);
    }
    if (complete && ['completed', 'failed'].indexOf(task.state) >= 0 && latest && ['completed', 'failed'].indexOf(latest.status) >= 0) {
      var purpose = input('textarea', { maxlength: '16000', rows: '2', required: '' });
      var more = node('form', 'cl-form'); more.appendChild(field('在原设备和会话中继续', purpose, '目标设备、系统和工作区保持不变'));
      var go = node('button', 'cl-button', '补充指令'); go.type = 'submit'; more.appendChild(go);
      more.addEventListener('submit', function (event) { event.preventDefault(); go.disabled = true; control('instruction', { expected_run_id: task.run_id, purpose: purpose.value })().catch(fail).finally(function () { go.disabled = false; }); });
      detail.appendChild(more);
    }
  }

  // ---------- Sync review ----------
  async function renderSync(body, current) {
    var status = node('section', 'cl-section'); status.appendChild(node('h3', '', '云端同步'));
    var line = node('p', 'cl-muted', '正在读取…'); status.appendChild(line); body.appendChild(status);
    api('/sync/status').then(function (value) {
      if (!current()) return;
      var known = ''; try { known = localStorage.getItem('lka-hub-id-v1') || ''; } catch (ignored) {}
      if (known && value.hub_id !== known) line.textContent = '注意：云端身份已改变（' + known + ' → ' + value.hub_id + '）。若不是计划内的迁移，请先核对再继续。';
      else line.textContent = '云端身份 ' + value.hub_id + ' · 变更序号 ' + value.cursor;
      try { localStorage.setItem('lka-hub-id-v1', value.hub_id); } catch (ignored) {}
    }).catch(function (error) { if (current()) line.textContent = error.status === 404 ? '云端未开启共享同步。' : error.message; });
    var proposals = node('section', 'cl-section'); proposals.appendChild(node('h3', '', '设备提交的候选'));
    var plist = node('div', 'cl-list'); proposals.appendChild(plist); body.appendChild(proposals);
    api('/sync/proposals?limit=100').then(function (data) {
      if (!current()) return;
      var items = (data && data.items || []).filter(function (item) { return !item.status || item.status === 'pending'; });
      if (!items.length) plist.appendChild(node('p', 'cl-muted', '没有待查看的候选。'));
      items.forEach(function (item) {
        var row = node('article', 'cl-card');
        row.appendChild(node('strong', '', (item.kind === 'assistant_note' ? '助理备注' : '记忆候选') + ' · ' + item.node_id));
        row.appendChild(node('p', '', item.text));
        var actions = node('div', 'cl-actions');
        [['标为已查看', 'reviewed', ''], ['拒绝', 'rejected', 'cl-danger']].forEach(function (choice) {
          actions.appendChild(button(choice[0], async function () {
            await api('/sync/proposals/' + encodeURIComponent(item.node_id) + '/' + encodeURIComponent(item.proposal_id) + '/resolve', { method: 'POST', json: { status: choice[1] } });
            row.remove();
          }, 'cl-button ' + choice[2]));
        });
        row.appendChild(actions);
        row.appendChild(node('small', 'cl-muted', '已查看只表示看过，不会把它发布成记忆。'));
        plist.appendChild(row);
      });
    }).catch(function (error) { if (current()) plist.appendChild(node('p', 'cl-muted', error.status === 404 ? '未开启。' : error.message)); });
    var conflicts = node('section', 'cl-section'); conflicts.appendChild(node('h3', '', '自动同步待核对的记忆'));
    var clist = node('div', 'cl-list'); conflicts.appendChild(clist); body.appendChild(conflicts);
    api('/sync/memory-records/conflicts?limit=50&offset=0').then(function (data) {
      if (!current()) return;
      var items = data && data.items || [];
      if (!items.length) clist.appendChild(node('p', 'cl-muted', '没有需要核对的内容。'));
      items.forEach(function (item) {
        var row = node('article', 'cl-card');
        var proposal = item.proposal || item.record || {}, currentRecord = item.current || {};
        row.appendChild(node('strong', '', '来自 ' + (item.node_id || '设备')));
        row.appendChild(node('p', '', '设备版本：' + (proposal.content || '（已撤回）')));
        if (currentRecord.content) row.appendChild(node('p', 'cl-muted', '云端当前：' + currentRecord.content));
        row.appendChild(node('small', 'cl-muted', '在记忆中心里明确更正后，这条提示会消失。'));
        clist.appendChild(row);
      });
    }).catch(function (error) { if (current()) clist.appendChild(node('p', 'cl-muted', error.status === 404 ? '未开启自动记忆同步。' : error.message)); });
  }

  // ---------- Shared memory (node page) ----------
  async function renderSharedMemory(body, current) {
    var status = node('p', 'cl-muted', '正在读取共享记忆…'); body.appendChild(status);
    var control;
    try { control = await local('/local/shared-memory/status'); }
    catch (error) { status.textContent = error.status === 404 ? '这台设备未启用共享记忆镜像。' : error.message; return; }
    if (!current()) return;
    state.sharedWritable = control.write_enabled === true;
    status.textContent = (control.cache && control.cache.stale ? '镜像可能落后' : '使用本机镜像') + ' · 待提交 ' + (control.queued || 0) + ' · 冲突 ' + (control.conflict || 0) + ' · 被拒绝 ' + (control.rejected || 0) +
      (state.sharedWritable ? '。云端暂时断开时修改会先排队。' : '。这台设备未开放共享写入。');
    var scope = document.createElement('select');
    [['global', '全局记忆'], ['project', '项目记忆']].forEach(function (pair) { var option = node('option', '', pair[1]); option.value = pair[0]; scope.appendChild(option); });
    var workspace = document.createElement('select');
    ((host.principal && host.principal.workspace_ids) || []).forEach(function (id) { var option = node('option', '', id); option.value = id; workspace.appendChild(option); });
    var filters = node('div', 'cl-inline'); filters.appendChild(field('范围', scope)); filters.appendChild(field('工作区', workspace)); body.appendChild(filters);
    var list = node('div', 'cl-list'); body.appendChild(list);
    var editorHost = node('div'); body.appendChild(editorHost);
    var outbox = node('section', 'cl-section'); outbox.appendChild(node('h3', '', '提交记录')); var olist = node('div', 'cl-list'); outbox.appendChild(olist); body.appendChild(outbox);
    function selection() { return { scope: scope.value, workspace_id: scope.value === 'project' ? workspace.value || null : null }; }
    async function load() {
      workspace.parentElement.hidden = scope.value !== 'project';
      list.textContent = ''; var sel = selection();
      var query = new URLSearchParams({ scope: sel.scope }); if (sel.workspace_id) query.set('workspace_id', sel.workspace_id);
      var data = sel.scope === 'project' && !sel.workspace_id ? { memories: [], bound: false } : await local('/local/shared-memory/records?' + query.toString());
      if (!current()) return;
      state.sharedRecords = data.memories || [];
      if (!state.sharedRecords.length) list.appendChild(node('p', 'cl-muted', sel.scope === 'project' && !data.bound ? '这个工作区还没有关联云端项目。' : '这个范围暂时没有共享记忆。'));
      state.sharedRecords.forEach(function (record) {
        var row = node('article', 'cl-card'); row.appendChild(node('p', '', record.content));
        row.appendChild(node('small', 'cl-muted', '版本 ' + record.version + ' · ' + (record.scope === 'project' ? '项目' : '全局')));
        if (state.sharedWritable) {
          var actions = node('div', 'cl-actions');
          actions.appendChild(button('更正', function () { editor(record, 'update'); }, 'cl-button cl-quiet'));
          actions.appendChild(button('删除', function () { editor(record, 'delete'); }, 'cl-button cl-quiet'));
          row.appendChild(actions);
        }
        list.appendChild(row);
      });
      if (state.sharedWritable) list.appendChild(button('新增共享记忆', function () { editor(null, 'create'); }, 'cl-button'));
      var mutations = await local('/local/shared-memory/mutations');
      if (!current()) return;
      olist.textContent = '';
      var labels = { queued: '本机待提交', accepted: '云端已受理', conflict: '版本冲突 · 需要你核对', rejected: '云端未受理' };
      (mutations && mutations.items || []).slice(0, 30).forEach(function (entry) {
        var row = node('article', 'cl-card' + (entry.status === 'conflict' ? ' is-warn' : ''));
        row.appendChild(node('strong', '', labels[entry.status] || entry.status));
        row.appendChild(node('p', '', entry.proposal && entry.proposal.content || '删除记忆'));
        if (entry.status === 'conflict') {
          var currentValue = entry.receipt && entry.receipt.current;
          row.appendChild(node('p', 'cl-muted', currentValue && currentValue.content ? '云端当前版本 ' + currentValue.version + '：' + currentValue.content : '目标已撤回或不在可同步范围。'));
          row.appendChild(node('small', 'cl-muted', '你的提案已保留，不会覆盖云端。核对后会以新的编号重新提交。'));
          if (state.sharedWritable && currentValue && currentValue.status === 'active') row.appendChild(button('基于最新版本重新编辑', async function () {
            await load();
            var latest = state.sharedRecords.find(function (record) { return record.metadata && record.metadata.shared_memory_id === currentValue.memory_id && record.version === currentValue.version; });
            if (!latest) throw new Error('最新版本还没有同步到这台设备，请稍后刷新。');
            editor(latest, entry.proposal.operation, entry.proposal.content);
          }, 'cl-button cl-quiet'));
        }
        olist.appendChild(row);
      });
      if (!olist.childElementCount) olist.appendChild(node('p', 'cl-muted', '还没有提交记录。'));
    }
    function editor(record, operation, content) {
      editorHost.textContent = '';
      state.memoryDraftId = uuid();
      var form = node('form', 'cl-card cl-form');
      form.appendChild(node('strong', '', operation === 'create' ? '新增共享记忆' : operation === 'delete' ? '删除共享记忆' : '更正共享记忆'));
      if (record) form.appendChild(node('small', 'cl-muted', '基于版本 ' + record.version + '；云端已变化时会进入冲突核对，不会覆盖。'));
      var text = input('textarea', { maxlength: '500', rows: '3' }); text.value = content || record && record.content || ''; text.disabled = operation === 'delete'; text.required = operation !== 'delete';
      var type = document.createElement('select');
      [['preference', '偏好'], ['project_decision', '项目决定'], ['user_fact', '个人事实']].forEach(function (pair) { var option = node('option', '', pair[1]); option.value = pair[0]; type.appendChild(option); });
      var sensitivity = document.createElement('select');
      [['normal', '普通 · 同步到已批准设备'], ['personal', '敏感 · 不进入设备镜像']].forEach(function (pair) { var option = node('option', '', pair[1]); option.value = pair[0]; sensitivity.appendChild(option); });
      if (record) { type.value = record.memory_type || 'user_fact'; sensitivity.value = record.sensitivity === 'personal' ? 'personal' : 'normal'; type.disabled = sensitivity.disabled = true; }
      var confirm = node('label', 'cl-check'), box = input('checkbox', { required: '' }); confirm.appendChild(box);
      confirm.appendChild(node('span', '', operation === 'delete' ? '我确认删除这条共享记忆。' : '我确认这是我本人要保存的内容。'));
      form.appendChild(field('内容', text)); form.appendChild(field('类型', type)); form.appendChild(field('保存范围', sensitivity)); form.appendChild(confirm);
      var actions = node('div', 'cl-actions'), submit = node('button', 'cl-button cl-primary', '确认并排队提交'); submit.type = 'submit';
      actions.appendChild(submit); actions.appendChild(button('取消', function () { editorHost.textContent = ''; }, 'cl-button cl-quiet')); form.appendChild(actions);
      form.addEventListener('submit', async function (event) {
        event.preventDefault(); if (!box.checked) return; submit.disabled = true;
        try {
          var sel = selection();
          await local('/local/shared-memory/mutations', { method: 'POST', json: Object.assign({}, sel, { mutation_id: state.memoryDraftId, operation: operation,
            memory_id: record ? record.memory_id : null, expected_version: record ? record.version : 0, confirmed: true, memory_type: type.value,
            sensitivity: sensitivity.value, content: operation === 'delete' ? null : text.value.trim() }) });
          editorHost.textContent = ''; notice('已在本机排队。云端受理并同步回来后才会用于记忆召回。'); await load();
        } catch (error) { fail(error); } finally { submit.disabled = false; }
      });
      editorHost.appendChild(form); text.focus();
    }
    scope.addEventListener('change', function () { load().catch(fail); });
    workspace.addEventListener('change', function () { load().catch(fail); });
    await load();
  }

  // ---------- Account ----------
  async function renderAccount(body, current) {
    if (mode() === 'local' && !host.cloud.loggedIn) { body.appendChild(cloudLoginForm()); return; }
    var who = mode() === 'hub' ? host.snapshot().principal || {} : host.cloud.account || {};
    var me = card(who.username || '当前账号', '所有管理员共享同一套个人数据。');
    var actions = node('div', 'cl-actions');
    actions.appendChild(button('退出登录', async function () {
      if (mode() === 'hub') { await host.request('', '/auth/logout', { method: 'POST', json: {} }); host.setCsrf(''); window.location.replace(host.entryUrl()); }
      else { await host.request('', '/cloud-auth/logout', { method: 'POST', json: {} }); await host.refreshCloud(); render(); }
    }, 'cl-button cl-quiet'));
    me.appendChild(actions); body.appendChild(me);
    // Password change revokes every session of this account.
    var pw = node('details', 'cl-section cl-fold'); pw.appendChild(node('summary', '', '修改密码'));
    var oldPw = input('password', { autocomplete: 'current-password', required: '', maxlength: '256' }), newPw = input('password', { autocomplete: 'new-password', required: '', minlength: '12', maxlength: '256' });
    var pwForm = node('form', 'cl-form'); pwForm.appendChild(field('当前密码', oldPw)); pwForm.appendChild(field('新密码', newPw, '至少 12 位。修改后所有登录都会失效，设备直连会在下次同步时失效。'));
    var pwSubmit = node('button', 'cl-button cl-primary', '修改密码'); pwSubmit.type = 'submit'; pwForm.appendChild(pwSubmit); pw.appendChild(pwForm);
    pwForm.addEventListener('submit', async function (event) {
      event.preventDefault(); pwSubmit.disabled = true;
      var payload = { current_password: oldPw.value, new_password: newPw.value }; oldPw.value = newPw.value = '';
      try {
        if (mode() === 'hub') { await host.request('', '/auth/password', { method: 'POST', json: payload }); host.setCsrf(''); window.location.replace(host.entryUrl({ reason: 'expired' })); }
        else { await host.request('', '/cloud-auth/password', { method: 'POST', json: payload }); await host.refreshCloud(); notice('密码已修改，请重新登录。'); render(); }
      } catch (error) { fail(error); } finally { pwSubmit.disabled = false; }
    });
    body.appendChild(pw);
    var authBase = mode() === 'hub' ? '' : '/cloud';
    var sessions = node('section', 'cl-section'); sessions.appendChild(node('h3', '', '登录中的会话')); var slist = node('div', 'cl-list'); sessions.appendChild(slist); body.appendChild(sessions);
    host.request(authBase, '/auth/sessions').then(function (data) {
      if (!current()) return;
      (data && data.items || []).forEach(function (item) {
        var row = node('div', 'cl-row'), mine = item.session_id === who.session_id;
        row.appendChild(node('span', '', (mine ? '当前 · ' : '') + '登录于 ' + when(item.created_at) + ' · 到期 ' + when(item.expires_at)));
        if (!mine) row.appendChild(button('撤销', async function () { await host.request(authBase, '/auth/sessions/' + encodeURIComponent(item.session_id), { method: 'DELETE' }); row.remove(); }, 'cl-button cl-quiet'));
        slist.appendChild(row);
      });
    }).catch(function () { if (current()) slist.appendChild(node('p', 'cl-muted', '会话列表暂不可用。')); });
    var admins = node('details', 'cl-section cl-fold'); admins.appendChild(node('summary', '', '管理员')); body.appendChild(admins);
    admins.addEventListener('toggle', function () {
      if (!admins.open || admins.dataset.loaded) return; admins.dataset.loaded = '1';
      var alist = node('div', 'cl-list'); admins.appendChild(alist);
      host.request(authBase, '/auth/accounts').then(function (data) {
        (data && data.items || []).forEach(function (account) {
          var row = node('div', 'cl-row'); row.appendChild(node('span', '', account.username + (account.disabled ? ' · 已停用' : '')));
          if (account.user_id !== who.user_id) {
            row.appendChild(button(account.disabled ? '启用' : '停用', async function () {
              await host.request(authBase, '/auth/accounts/' + encodeURIComponent(account.user_id), { method: 'PATCH', json: { disabled: !account.disabled } }); admins.dataset.loaded = ''; admins.open = false; render();
            }, 'cl-button cl-quiet'));
            row.appendChild(button('重置密码', async function () {
              var value = window.prompt('为 ' + account.username + ' 设置新密码（至少 12 位）。对方所有登录会失效。');
              if (!value) return;
              await host.request(authBase, '/auth/accounts/' + encodeURIComponent(account.user_id) + '/password', { method: 'POST', json: { new_password: value } }); notice('已重置。');
            }, 'cl-button cl-quiet'));
          }
          alist.appendChild(row);
        });
        var form = node('form', 'cl-form'), name = input('text', { required: '', minlength: '3', maxlength: '64', autocapitalize: 'none', spellcheck: 'false' }), pass = input('password', { required: '', minlength: '12', maxlength: '256', autocomplete: 'new-password' });
        form.appendChild(field('新管理员', name)); form.appendChild(field('初始密码', pass, '所有管理员共享同一套数据，请只添加完全信任的人。'));
        var add = node('button', 'cl-button', '添加管理员'); add.type = 'submit'; form.appendChild(add);
        form.addEventListener('submit', async function (event) {
          event.preventDefault(); add.disabled = true;
          var payload = { username: name.value.trim(), password: pass.value }; pass.value = '';
          try { await host.request(authBase, '/auth/accounts', { method: 'POST', json: payload }); notice('已添加。'); admins.dataset.loaded = ''; admins.open = false; render(); }
          catch (error) { fail(error); } finally { add.disabled = false; }
        });
        admins.appendChild(form);
      }).catch(fail);
    });
  }

  // ---------- Entry points ----------
  function addNavEntry() {
    var nav = document.querySelector('.wb-nav');
    if (!nav || $('openClusterButton')) return;
    var entry = node('button', 'wb-nav-item cl-nav-entry'); entry.id = 'openClusterButton'; entry.type = 'button';
    // Switching lives in the header place menu; this entry only manages.
    entry.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/></svg><span>账号与管理</span>';
    entry.setAttribute('aria-label', '设备与账号管理');
    entry.addEventListener('click', function () { open(); });
    nav.appendChild(entry);
  }
  function addNodeTaskEntry() {
    if (mode() !== 'replica') return;
    var tools = document.querySelector('.sidebar-tools');
    if (!tools || $('openNodeTasksButton')) return;
    var link = node('button', 'cl-node-tasks', '查看真理派发到本机的任务');
    link.id = 'openNodeTasksButton'; link.type = 'button';
    link.addEventListener('click', function () { open('tasks'); });
    tools.appendChild(link);
  }
  // ---------- Place switcher ----------
  // One entry in the header: it names where this workbench runs and lists every
  // place it can move to — the cloud workbench and each approved device —
  // plus a link to 设备与账号 for management. Nothing else in the page switches.
  function entryLink(origin) {
    return origin.replace(/\/$/, '') + '/desktop-pet/connect.html' + (mobile ? '?layout=mobile' : '');
  }
  function hubWorkbenchLink() {
    var hub = hubOrigin();
    if (!hub) return '';
    var url = new URL('/desktop-pet/chat.html', hub);
    url.searchParams.set('mode', 'work'); url.searchParams.set('host', 'hub');
    if (mobile) url.searchParams.set('layout', 'mobile');
    return url.href;
  }
  function hereId() { return mode() === 'replica' ? host.info && host.info.node_id || '' : ''; }
  function placeName() {
    if (mode() === 'hub' || cloudClient()) return '云端';
    if (mode() === 'replica') {
      var id = hereId(), saved = host.directory().devices.find(function (device) { return device.node_id === id; });
      return saved && saved.name || id || '这台设备';
    }
    return '这台电脑';
  }
  var placeMenu = { button: null, panel: null, loaded: 0, devices: null, live: false };
  function closePlaceMenu(restoreFocus) {
    if (!placeMenu.panel || placeMenu.panel.hidden) return;
    placeMenu.panel.hidden = true; placeMenu.scrim.hidden = true; placeMenu.button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) placeMenu.button.focus({ preventScroll: true });
  }
  function placeRow(options) {
    var row = node(options.href ? 'a' : 'button', 'cl-place-option' + (options.current ? ' is-current' : '') + (options.online ? ' is-online' : ''));
    if (options.href) row.href = options.href; else row.type = 'button';
    row.setAttribute('role', 'menuitem');
    if (options.current) row.setAttribute('aria-current', 'true');
    if (options.disabled) { row.setAttribute('aria-disabled', 'true'); row.tabIndex = -1; }
    var dot = node('span', 'cl-dot'); dot.setAttribute('aria-hidden', 'true'); row.appendChild(dot);
    var text = node('span', 'cl-place-text'); text.appendChild(node('strong', '', options.title));
    if (options.detail) text.appendChild(node('small', '', options.detail));
    row.appendChild(text);
    row.appendChild(node('span', 'cl-place-mark', options.current ? '当前' : options.disabled ? '' : '›'));
    if (options.onClick && !options.disabled) row.addEventListener('click', function (event) {
      event.preventDefault();
      if (row.getAttribute('aria-busy') === 'true') return;
      row.setAttribute('aria-busy', 'true'); row.querySelector('.cl-place-mark').textContent = '…';
      Promise.resolve().then(options.onClick).catch(function (error) {
        row.removeAttribute('aria-busy'); row.querySelector('.cl-place-mark').textContent = '›';
        placeMenu.panel.querySelector('.cl-place-error').textContent = error && error.message || String(error);
      });
    });
    return row;
  }
  function renderPlaceMenu() {
    var panel = placeMenu.panel; panel.textContent = '';
    var here = hereId();
    panel.appendChild(node('p', 'cl-place-heading', '切换到'));
    var list = node('div', 'cl-place-list'); list.setAttribute('role', 'none');
    var hubLink = hubWorkbenchLink();
    // The cloud workbench: 真理, 待办, 项目 and 记忆 in one place.
    if (mode() !== 'local' || host.cloud.loggedIn) list.appendChild(placeRow({
      title: '云端工作台', detail: mode() === 'local' && !cloudClient() ? '在浏览器中打开' : '真理、待办、项目与记忆', current: mode() === 'hub' || cloudClient(), online: mode() === 'hub' || host.hub.reachable || host.cloud.loggedIn,
      href: mode() === 'hub' || cloudClient() ? null : hubLink || null, disabled: mode() !== 'hub' && !cloudClient() && !hubLink,
      onClick: mode() === 'hub' || cloudClient() ? function () { closePlaceMenu(true); } : null
    }));
    if (mode() === 'local' && !cloudClient()) list.appendChild(placeRow({ title: '这台电脑', detail: '本机工作台', current: true, online: true, onClick: function () { closePlaceMenu(true); } }));
    var devices = placeMenu.devices || host.directory().devices || [];
    devices.filter(function (device) { return !device.revoked; }).forEach(function (device) {
      var id = device.node_id || device.device_id, current = id && id === here;
      var origin = device.advertised_url || device.origin || '';
      var detail = current ? '正在使用' : [device.platform, placeMenu.live ? (device.online ? '在线' : '离线') : '已保存的入口'].filter(Boolean).join(' · ');
      list.appendChild(placeRow({
        title: device.name || id, detail: origin ? detail : detail + ' · 未开放直连', current: current, online: current || device.online,
        disabled: !current && !origin,
        // With the cloud signed in, issue a fresh grant; otherwise reopen the saved entry.
        href: !current && origin && !placeMenu.live ? entryLink(origin) : null,
        onClick: current ? function () { closePlaceMenu(true); } : origin && placeMenu.live ? function () { return enter(device); } : null
      }));
    });
    if (!devices.length) list.appendChild(node('p', 'cl-muted cl-place-empty', placeMenu.loaded ? '还没有已登记的设备。' : '正在读取设备…'));
    panel.appendChild(list);
    panel.appendChild(node('p', 'cl-error cl-place-error'));
    var foot = node('div', 'cl-place-foot');
    var manage = node('button', 'cl-place-manage', '设备与账号'); manage.type = 'button'; manage.setAttribute('role', 'menuitem');
    manage.addEventListener('click', function () { closePlaceMenu(false); open('overview'); });
    foot.appendChild(manage);
    if (mode() !== 'local') {
      var entry = node('a', 'cl-place-manage', '统一入口'); entry.setAttribute('role', 'menuitem');
      entry.href = hubOrigin() ? entryLink(hubOrigin()) : host.entryUrl();
      foot.appendChild(entry);
    }
    panel.appendChild(foot);
  }
  async function loadPlaceDevices() {
    var stamp = ++placeMenu.loaded;
    if (cloud() === null) { placeMenu.live = false; placeMenu.devices = null; renderPlaceMenu(); return; }
    try {
      var data = await api('/devices?limit=100&offset=0');
      if (stamp !== placeMenu.loaded) return;
      placeMenu.devices = data && data.items || []; placeMenu.live = true;
      state.devices = placeMenu.devices;
      host.saveDirectory({ hub: hubOrigin(), devices: placeMenu.devices.filter(function (item) { return !item.revoked; }).map(function (item) {
        return { node_id: item.node_id || item.device_id, name: item.name, platform: item.platform, origin: item.advertised_url || '' };
      }) });
    } catch (ignored) { placeMenu.live = false; placeMenu.devices = null; }
    if (!placeMenu.panel.hidden) { renderPlaceMenu(); placeMenu.place(); }
  }
  function togglePlaceMenu() {
    if (!placeMenu.panel.hidden) { closePlaceMenu(true); return; }
    placeMenu.panel.hidden = false; placeMenu.scrim.hidden = false; placeMenu.button.setAttribute('aria-expanded', 'true');
    placeMenu.place(); renderPlaceMenu(); loadPlaceDevices();
    setTimeout(function () { var first = placeMenu.panel.querySelector('.cl-place-option:not([aria-disabled="true"])'); if (first) first.focus({ preventScroll: true }); }, 0);
  }
  function addPlaceSwitcher() {
    var topbar = document.querySelector('.chat-topbar');
    if (!topbar || $('clLocation')) return;
    var wrap = node('div', 'cl-place'); wrap.id = 'clPlaceSwitcher';
    var chip = node('button', 'cl-location'); chip.id = 'clLocation'; chip.type = 'button';
    chip.setAttribute('aria-haspopup', 'menu'); chip.setAttribute('aria-expanded', 'false'); chip.setAttribute('aria-controls', 'clPlaceMenu');
    var panel = node('div', 'cl-place-menu'); panel.id = 'clPlaceMenu'; panel.hidden = true; panel.setAttribute('role', 'menu'); panel.setAttribute('aria-label', '切换设备或工作台');
    placeMenu.button = chip; placeMenu.panel = panel;
    function sync() {
      var snapshot = host.snapshot();
      chip.textContent = '';
      var dot = node('span', 'cl-dot'); dot.setAttribute('aria-hidden', 'true'); chip.appendChild(dot);
      chip.appendChild(node('span', 'cl-location-name', placeName()));
      var caret = node('span', 'cl-location-caret', '▾'); caret.setAttribute('aria-hidden', 'true'); chip.appendChild(caret);
      chip.classList.toggle('is-warn', mode() !== 'local' && snapshot.identity !== 'ready');
      var state = snapshot.identity === 'read-only' ? '缺少操作凭据，请重新进入' : '切换设备或工作台';
      chip.title = state; chip.setAttribute('aria-label', '当前：' + placeName() + '。' + state);
      if (!panel.hidden) renderPlaceMenu();
    }
    chip.addEventListener('click', togglePlaceMenu);
    wrap.appendChild(chip);
    topbar.insertBefore(wrap, document.querySelector('.topbar-actions'));
    // The menu lives on body so the phone bottom sheet layers above the nav bar,
    // outside the header's stacking context; a scrim closes it on tap.
    var scrim = node('div', 'cl-place-scrim'); scrim.hidden = true;
    document.body.appendChild(scrim); document.body.appendChild(panel);
    placeMenu.scrim = scrim;
    scrim.addEventListener('click', function () { closePlaceMenu(true); });
    document.addEventListener('click', function (event) { if (!wrap.contains(event.target) && !panel.contains(event.target)) closePlaceMenu(false); });
    function place() {
      if (panel.hidden || window.innerWidth < 760) { panel.style.top = panel.style.right = ''; return; }
      var rect = chip.getBoundingClientRect();
      panel.style.top = Math.round(rect.bottom + 8) + 'px';
      panel.style.right = Math.max(12, Math.round(window.innerWidth - rect.right)) + 'px';
    }
    placeMenu.place = place;
    window.addEventListener('resize', place);
    // Escape closes the menu wherever focus is, before other page shortcuts.
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); event.stopImmediatePropagation(); closePlaceMenu(true); }
    }, true);
    panel.addEventListener('keydown', function (event) {
      if (panel.hidden) return;
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      var items = Array.prototype.filter.call(panel.querySelectorAll('[role="menuitem"]'), function (item) { return item.getAttribute('aria-disabled') !== 'true'; });
      if (!items.length) return;
      event.preventDefault();
      var at = items.indexOf(document.activeElement);
      items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    });
    sync(); host.onChange(sync);
  }
  function expiredBanner() {
    var bar = $('clExpired');
    if (host.identity !== 'expired') { if (bar) bar.remove(); return; }
    if (bar) return;
    bar = node('div', 'cl-expired'); bar.id = 'clExpired'; bar.setAttribute('role', 'alert');
    bar.appendChild(node('span', '', mode() === 'replica' ? '与这台设备的连接已失效。草稿已保留；请通过云端重新进入。' : '登录已失效。草稿已保留；请重新登录。'));
    var go = node('a', 'cl-button cl-primary', mode() === 'replica' ? '重新进入' : '重新登录'); go.href = host.entryUrl({ reason: 'expired' });
    bar.appendChild(go);
    document.body.appendChild(bar);
  }
  // Node page cloud sign-in: one small form, reachable from 真理 and the panel.
  function hubSignInForm() {
    var form = node('form', 'cl-form cl-card');
    var origin = host.hub.origin ? new URL(host.hub.origin).host : '';
    form.appendChild(node('strong', '', '登录云端，使用真理与待办'));
    form.appendChild(node('p', 'cl-muted', '在这台设备上登录一次即可。普通会话和文件仍在这台电脑上。' + (origin ? '云端：' + origin : '')));
    var user = input('text', { autocomplete: 'username', maxlength: '64', required: '', autocapitalize: 'none', spellcheck: 'false' });
    var pass = input('password', { autocomplete: 'current-password', maxlength: '256', required: '' });
    form.appendChild(field('账号', user)); form.appendChild(field('密码', pass));
    var submit = node('button', 'cl-button cl-primary', '登录'); submit.type = 'submit'; form.appendChild(submit);
    form.addEventListener('submit', async function (event) {
      event.preventDefault(); submit.disabled = true;
      var password = pass.value; pass.value = '';
      try {
        await host.hubLogin(user.value.trim(), password);
        notice('已登录云端，真理与待办已可用。');
        close();
        if (window.LkaGlobalAssistant) window.LkaGlobalAssistant.open();
      } catch (error) { fail(error); } finally { submit.disabled = false; }
    });
    setTimeout(function () { user.focus(); }, 0);
    return form;
  }
  function hubStatusCard() {
    var hub = host.hub;
    if (!hub.origin) return card('云端未配置', '这台设备没有登记云端地址。真理与待办需要从云端入口进入后才可用。');
    if (hub.loggedIn) {
      var signed = card('云端已连接 · ' + (hub.account && hub.account.username || ''), '真理、待办和设备管理来自云端。');
      var actions = node('div', 'cl-actions');
      actions.appendChild(button('退出云端', async function () { await host.hubLogout(); render(); }, 'cl-button cl-quiet'));
      signed.appendChild(actions);
      return signed;
    }
    if (!hub.reachable) {
      var away = card('云端暂时连不上', '这台设备上的会话和文件照常可用。云端恢复后，真理会自动回来。');
      var retry = node('div', 'cl-actions'); retry.appendChild(button('重新检查', async function () { await host.refreshHub(); render(); }, 'cl-button')); away.appendChild(retry);
      return away;
    }
    return hubSignInForm();
  }

  // Phones on a node page: 记忆 opens the shared mirror; one tab joins the nav.
  function adaptMobileNav() {
    var nav = $('mobileNav');
    if (!nav) return;
    if (mode() === 'replica') {
      var memoryButton = nav.querySelector('[data-mobile-action="memory"]');
      if (memoryButton) memoryButton.addEventListener('click', function (event) { event.stopImmediatePropagation(); open('memory'); }, true);
    }
    // Phones switch from the header place menu; its footer opens 设备与账号.
  }
  host.ready.then(function () {
    if (host.hosted) document.body.classList.add('cl-hosted');
    adaptMobileNav();
    addNavEntry();
    addNodeTaskEntry();
    // The Java window counts as the pet: no switching there.
    if (host.hosted || !nativeWindow && host.cloud.configured) addPlaceSwitcher();
    expiredBanner(); host.onChange(expiredBanner);
    if (cloudClient() && !host.cloud.loggedIn) open('account');
    else if (new URLSearchParams(window.location.search).get('panel') === 'cluster') open();
  });
  function openCloudSignIn() {
    if (mode() === 'local') { open('account'); return; }
    state.lastFocus = document.activeElement; state.tab = 'overview';
    overlay.hidden = false; renderTabs(); notice('');
    $('clPlace').textContent = placeLabel();
    var body = $('clBody'); body.textContent = ''; state.generation++;
    body.appendChild(hubStatusCard());
  }
  function openRemoteTask(taskId) {
    if (cloud() === null) { openCloudSignIn(); return; }
    state.focusTask = String(taskId || '');
    open('tasks');
  }
  window.LkaCluster = { open: open, close: close, openCloudSignIn: openCloudSignIn, openRemoteTask: openRemoteTask, isOpen: function () { return !overlay.hidden; } };
}());
