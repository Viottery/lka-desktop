/* Unified entry for hosted pages (cloud hub or a node backend's own origin).
   Hub: sign in, talk to 真理, or enter an approved computer with a one-use grant.
   Node: redeem the grant from the URL fragment, then open the workbench.
   Offline hub: list previously entered computers; each checks its own cookie. */
(function () {
  'use strict';
  var CSRF_KEY = 'lka.host.csrf', DIRECTORY_KEY = 'lka-device-directory-v1', VISITS_KEY = 'lka-device-visits-v1', ROLE_KEY = 'lka-host-role-v1';
  var params = new URLSearchParams(window.location.search);
  // Read and remove one-use secrets before any network request or error display.
  var fragment = new URLSearchParams(window.location.hash.slice(1));
  var grant = fragment.get('grant') || '', carried = fragment.get('dir') || '';
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  var mobile = params.get('layout') === 'mobile' || params.get('layout') !== 'desktop'
    && window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900;
  var state = { info: null, account: null, csrf: '' };
  try { state.csrf = sessionStorage.getItem(CSRF_KEY) || ''; } catch (ignored) {}
  function $(id) { return document.getElementById(id); }
  function show(id) {
    ['loginView', 'hubView', 'redeemView', 'offlineView'].forEach(function (view) { $(view).hidden = view !== id; });
    $('entry').setAttribute('aria-busy', 'false');
  }
  function notice(text, error) { $('entryNotice').textContent = text || ''; $('entryNotice').hidden = !text; $('entryNotice').classList.toggle('is-error', !!error); }
  function node(tag, className, text) { var item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; }
  function readStore(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (ignored) { return fallback; } }
  function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (ignored) {} }
  function setCsrf(value) { state.csrf = value || ''; try { if (value) sessionStorage.setItem(CSRF_KEY, value); else sessionStorage.removeItem(CSRF_KEY); } catch (ignored) {} }
  function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function workbenchUrl(role, extra) {
    var url = new URL('./chat.html', window.location.href);
    url.searchParams.set('mode', 'work'); url.searchParams.set('host', role);
    if (mobile) url.searchParams.set('layout', 'mobile');
    Object.keys(extra || {}).forEach(function (key) { url.searchParams.set(key, extra[key]); });
    return url.href;
  }
  function safeOrigin(value) {
    try {
      var url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return '';
      return url.origin;
    } catch (ignored) { return ''; }
  }
  function encodeDirectory(directory) {
    var raw = JSON.stringify(directory), bytes = new TextEncoder().encode(raw), binary = '';
    bytes.forEach(function (byte) { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeDirectory(value) {
    try {
      var binary = atob(value.replace(/-/g, '+').replace(/_/g, '/')), bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var parsed = JSON.parse(new TextDecoder().decode(bytes));
      return parsed && Array.isArray(parsed.devices) ? parsed : null;
    } catch (ignored) { return null; }
  }
  // Only non-secret identity fields travel between origins.
  function cleanDirectory(directory) {
    return { hub: safeOrigin(directory.hub || ''), saved_at: Date.now(), devices: (directory.devices || []).slice(0, 50).map(function (device) {
      return { node_id: String(device.node_id || '').slice(0, 120), name: String(device.name || '').slice(0, 120), platform: String(device.platform || '').slice(0, 80),
        origin: safeOrigin(device.origin || ''), workspace_ids: (device.workspace_ids || []).slice(0, 20).map(String) };
    }).filter(function (device) { return device.node_id; }) };
  }
  async function api(path, options) {
    options = options || {};
    var headers = { Accept: 'application/json' };
    if (options.json !== undefined) headers['Content-Type'] = 'application/json';
    if (options.method && options.method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
    var response = await fetch(path, { method: options.method || 'GET', headers: headers, credentials: 'same-origin', cache: 'no-store',
      body: options.json === undefined ? undefined : JSON.stringify(options.json) });
    var data = null;
    if (response.status !== 204) { try { data = await response.json(); } catch (ignored) { data = null; } }
    if (!response.ok) { var error = new Error(typeof (data && data.detail) === 'string' ? data.detail : 'HTTP ' + response.status); error.status = response.status; throw error; }
    return data;
  }
  function placeLabel() {
    if (!state.info) return '离线';
    if (state.info.role === 'hub') return '云端';
    return '设备 · ' + (state.info.node_id || '本机');
  }

  // ---------- Hub ----------
  async function loadDevices() {
    var list = $('deviceList'); list.setAttribute('aria-busy', 'true');
    try {
      var data = await api('/devices?limit=100&offset=0');
      var devices = (data && data.items || []);
      var directory = cleanDirectory({ hub: window.location.origin, devices: devices.filter(function (device) { return !device.revoked; }).map(function (device) {
        var workspaces = []; (device.systems || []).forEach(function (system) { (system.workspace_ids || []).forEach(function (id) { if (workspaces.indexOf(id) < 0) workspaces.push(id); }); });
        return { node_id: device.node_id || device.device_id, name: device.name, platform: device.platform, origin: device.advertised_url || '', workspace_ids: workspaces.length ? workspaces : device.workspace_ids || [] };
      }) });
      writeStore(DIRECTORY_KEY, directory);
      renderDevices(devices);
    } catch (error) {
      if (error.status === 401) return showLogin('登录已过期，请重新登录。');
      list.textContent = ''; list.appendChild(node('p', 'entry-empty', error.status === 404 ? '云端未开启设备登记。' : '设备列表读取失败：' + error.message));
    } finally { list.setAttribute('aria-busy', 'false'); }
  }
  function renderDevices(devices) {
    var list = $('deviceList'); list.textContent = '';
    var visits = readStore(VISITS_KEY, {});
    var usable = devices.filter(function (device) { return !device.revoked; });
    if (!usable.length) { list.appendChild(node('p', 'entry-empty', '还没有可进入的设备。在「账号与设备管理」中登记电脑后，这里会出现入口。')); return; }
    usable.forEach(function (device) {
      var id = device.node_id || device.device_id, enterable = !!device.advertised_url && state.info.connections_enabled;
      var card = node('article', 'entry-device' + (device.online ? ' is-online' : ''));
      var text = node('div', 'entry-device-text');
      var title = node('strong', '', device.name || id);
      var dot = node('span', 'entry-dot'); dot.setAttribute('aria-hidden', 'true'); title.prepend(dot);
      text.appendChild(title);
      var meta = [device.platform, device.online ? '在线' : '离线'];
      if (visits[id]) meta.push('上次进入 ' + new Date(visits[id]).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }));
      text.appendChild(node('small', '', meta.filter(Boolean).join(' · ')));
      card.appendChild(text);
      var enter = node('button', 'entry-enter', enterable ? '进入' : '未开放');
      enter.type = 'button'; enter.disabled = !enterable;
      enter.setAttribute('aria-label', enterable ? '进入 ' + (device.name || id) : (device.name || id) + ' 尚未开放直接连接');
      if (enterable) enter.addEventListener('click', function () { enterDevice(device, enter); });
      card.appendChild(enter);
      list.appendChild(card);
    });
  }
  async function enterDevice(device, button) {
    var id = device.node_id || device.device_id;
    if (!state.csrf) return showLogin('请重新登录以确认身份，再进入设备。');
    button.disabled = true; button.textContent = '正在授权…'; notice('');
    try {
      var issued = await api('/devices/' + encodeURIComponent(id) + '/connections', { method: 'POST', json: {} });
      var origin = safeOrigin(issued && issued.origin || '');
      if (!origin || !/\.ts\.net$/.test(new URL(origin).hostname)) throw new Error('设备地址不是已批准的 Tailscale HTTPS 地址。');
      var visits = readStore(VISITS_KEY, {}); visits[id] = Date.now(); writeStore(VISITS_KEY, visits);
      var target = new URL('/desktop-pet/connect.html', origin);
      if (mobile) target.searchParams.set('layout', 'mobile');
      target.hash = new URLSearchParams({ grant: issued.grant, dir: encodeDirectory(readStore(DIRECTORY_KEY, { devices: [] })) }).toString();
      window.location.assign(target.href);
    } catch (error) {
      button.disabled = false; button.textContent = '进入';
      if (error.status === 401) return showLogin('登录已过期，请重新登录。');
      notice(error.status === 403 ? '没有进入这台设备的权限，或操作凭据已失效，请重新登录。' : error.status === 404 ? '这台设备尚未开启直接连接。' : '授权失败：' + error.message, true);
    }
  }
  function showLogin(message) {
    $('entryPlace').textContent = placeLabel();
    $('loginTitle').textContent = state.info && state.info.role === 'replica' ? '登录这台设备' : '登录';
    show('loginView'); notice(message || '');
    setTimeout(function () { $('loginUser').focus(); }, 0);
  }
  async function showHub(account) {
    state.account = account;
    $('entryPlace').textContent = '云端 · ' + window.location.host;
    $('accountLine').textContent = account && account.username ? account.username : '';
    $('openAssistant').href = workbenchUrl('hub', { assistant: 'global' });
    $('openManage').href = workbenchUrl('hub', { panel: 'cluster' });
    show('hubView');
    if (!state.csrf) notice('登录仍有效，但缺少操作凭据（升级前的旧登录）。请退出后重新登录一次，之后新标签页都会自动保持登录。');
    await loadDevices();
  }
  $('loginForm').addEventListener('submit', async function (event) {
    event.preventDefault();
    var password = $('loginPassword').value; $('loginPassword').value = '';
    var button = event.currentTarget.querySelector('button'); button.disabled = true; $('loginError').textContent = '';
    try {
      var data = await api('/auth/login', { method: 'POST', json: { username: $('loginUser').value.trim(), password: password } });
      setCsrf(data.csrf_token); notice('');
      await showHub(data.account);
    } catch (error) {
      $('loginError').textContent = error.status === 401 ? '账号或密码不正确。' : error.status === 429 ? '尝试次数过多，请稍后再试。' : error.status === 403 ? '此地址未被允许登录，请使用云端配置的入口地址。' : '登录失败：' + error.message;
    } finally { button.disabled = false; }
  });
  $('logoutButton').addEventListener('click', async function () {
    try { await api('/auth/logout', { method: 'POST', json: {} }); } catch (ignored) {}
    setCsrf(''); showLogin('已退出。');
  });
  $('refreshDevices').addEventListener('click', loadDevices);

  // ---------- Node ----------
  async function redeem() {
    show('redeemView');
    $('entryPlace').textContent = placeLabel();
    var deadline = Date.now() + 115000;
    for (var attempt = 0; Date.now() < deadline; attempt++) {
      try {
        var data = await api('/connections/redeem', { method: 'POST', json: { grant: grant } });
        setCsrf(data.csrf_token);
        try { localStorage.setItem(ROLE_KEY, 'replica'); } catch (ignored) {}
        window.location.replace(workbenchUrl('replica'));
        return;
      } catch (error) {
        // 403 until the node's background poll installs the grant hash.
        if (error.status !== 403) {
          $('redeemTitle').textContent = '进入失败';
          $('redeemHelp').textContent = error.status === 401 || error.status === 422 ? '授权已失效或已被使用。请回到云端重新进入。' : '设备暂时无法完成授权：' + error.message;
          return offerHub();
        }
        if (attempt === 3) $('redeemHelp').textContent = '设备还在接收授权。若设备刚连上网络，可能需要更久一些。';
        await delay(2000);
      }
    }
    $('redeemTitle').textContent = '设备未收到授权';
    $('redeemHelp').textContent = '这台设备可能暂时连不上云端。请稍后回到云端重新进入。';
    offerHub();
  }
  function offerHub() {
    var hub = readStore(DIRECTORY_KEY, {}).hub;
    if (!hub || $('redeemView').querySelector('.entry-primary')) return;
    var back = node('a', 'entry-primary', '回到云端入口'); back.href = hub + '/desktop-pet/connect.html' + (mobile ? '?layout=mobile' : '');
    $('redeemView').appendChild(back);
  }

  // ---------- Offline fallback ----------
  function showFallback(title, help) {
    var directory = readStore(DIRECTORY_KEY, { devices: [] }), list = $('fallbackList');
    $('entryPlace').textContent = placeLabel();
    if (title) $('offlineTitle').textContent = title;
    if (help) $('offlineHelp').textContent = help;
    list.textContent = '';
    var others = directory.devices.filter(function (device) { return device.origin && device.origin !== window.location.origin; });
    if (!others.length) list.appendChild(node('p', 'entry-empty', '这个浏览器还没有保存其他设备。云端恢复后登录即可看到设备列表。'));
    others.forEach(function (device) {
      var link = node('a', 'entry-device entry-link');
      link.href = device.origin + '/desktop-pet/connect.html' + (mobile ? '?layout=mobile' : '');
      var text = node('div', 'entry-device-text'); text.appendChild(node('strong', '', device.name || device.node_id));
      text.appendChild(node('small', '', [device.platform, '使用已保存的连接'].filter(Boolean).join(' · ')));
      link.appendChild(text); link.appendChild(node('span', 'entry-chevron', '›'));
      list.appendChild(link);
    });
    if (directory.hub && directory.hub !== window.location.origin) {
      var hub = node('a', 'entry-device entry-link');
      hub.href = directory.hub + '/desktop-pet/connect.html' + (mobile ? '?layout=mobile' : '');
      var hubText = node('div', 'entry-device-text'); hubText.appendChild(node('strong', '', '云端入口')); hubText.appendChild(node('small', '', '登录后重新进入设备'));
      hub.appendChild(hubText); hub.appendChild(node('span', 'entry-chevron', '›'));
      list.prepend(hub);
    }
    show('offlineView');
  }
  $('retryButton').addEventListener('click', function () { window.location.reload(); });

  async function start() {
    if (carried) { var directory = decodeDirectory(carried); if (directory) writeStore(DIRECTORY_KEY, cleanDirectory(directory)); }
    try { state.info = await api('/client/info'); }
    catch (error) {
      if (error.status === 404) { window.location.replace(new URL('./chat.html?mode=work' + (mobile ? '&layout=mobile' : ''), window.location.href).href); return; }
      return showFallback();
    }
    if (state.info.role === 'local') { window.location.replace(new URL('./chat.html?mode=work' + (mobile ? '&layout=mobile' : ''), window.location.href).href); return; }
    if (state.info.role === 'replica') {
      if (grant) return redeem();
      try {
        var me = await api('/connections/me');
        if (me && me.csrf_token) setCsrf(me.csrf_token);
        try { localStorage.setItem(ROLE_KEY, 'replica'); } catch (ignored) {}
        window.location.replace(workbenchUrl('replica'));
      } catch (error) {
        showFallback('需要通过云端重新进入', params.get('reason') === 'expired'
          ? '这台设备的连接已过期或被撤销。请回到云端入口重新进入；下面也可以直接打开其他已进入过的设备。'
          : '这个浏览器在这台设备上没有有效连接。请从云端入口进入，不会自动改连其他电脑。');
      }
      return;
    }
    try { localStorage.setItem(ROLE_KEY, 'hub'); } catch (ignored) {}
    try {
      var me = await api('/auth/me');
      // Recovered from the HttpOnly cookie: any tab in this browser keeps the login.
      if (me && me.csrf_token) { setCsrf(me.csrf_token); delete me.csrf_token; }
      await showHub(me);
    }
    catch (error) {
      if (error.status === 401 || error.status === 403) return showLogin(params.get('reason') === 'expired' ? '登录已过期，请重新登录。' : '');
      showFallback();
    }
  }
  if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () { /* Offline shell is optional. */ });
  }
  start();
}());
