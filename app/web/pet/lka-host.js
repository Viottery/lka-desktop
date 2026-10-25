/* Hosting and identity layer; loads before chat.js.
   local   — the 8780 frontend service and its /workbench gateway (unchanged behavior).
   hub     — this page is served by the cloud backend's own HTTPS origin (account cookie).
   replica — this page is served by a node backend's own origin (node connection cookie).
   Secrets never enter storage: cookies are HttpOnly; only the CSRF token is kept per tab. */
(function () {
  'use strict';
  if (window.LkaHost) return;
  var params = new URLSearchParams(window.location.search);
  var CSRF_KEY = 'lka.host.csrf', HUB_CSRF_KEY = 'lka.hub.csrf';
  var ROLE_KEY = 'lka-host-role-v1';
  var ROUTING_KEY = 'lka-cloud-routing-ids-v1';
  var DIRECTORY_KEY = 'lka-device-directory-v1';
  // A hosted origin is the backend's own HTTPS origin, never the 8780 frontend
  // service, so a role confirmed by this origin's /client/info is safe to reuse
  // for new tabs and embedded frames opened without the query parameter.
  var requested = params.get('host'), stored = '';
  try { stored = localStorage.getItem(ROLE_KEY) || ''; } catch (ignored) {}
  try { if (!requested && window.parent !== window && window.parent.LkaHost && window.parent.LkaHost.hosted) requested = window.parent.LkaHost.role; } catch (ignored) {}
  if (requested !== 'hub' && requested !== 'replica') requested = stored === 'hub' || stored === 'replica' ? stored : '';
  var hosted = !!requested, nodePage = requested === 'replica';
  var nativeFetch = window.fetch.bind(window);
  var listeners = [], resolved = false, hubResolved = false;
  var host = {
    hosted: hosted, clientMode: 'local',
    role: hosted ? requested : 'local',
    backendRole: hosted ? requested : 'unknown',
    origin: window.location.origin,
    info: null, principal: null, csrf: '', identity: hosted ? 'checking' : 'local',
    cloud: { configured: false, loggedIn: false, account: null, origin: '' },
    // A node page reaches the hub directly: Tailscale names share one site
    // (ts.net is a public suffix), so the hub's Strict cookie still applies.
    hub: { origin: '', reachable: false, loggedIn: false, account: null, csrf: '' },
    cloudRouting: false
  };
  try { host.csrf = sessionStorage.getItem(CSRF_KEY) || ''; } catch (ignored) {}
  try { host.hub.csrf = sessionStorage.getItem(HUB_CSRF_KEY) || ''; } catch (ignored) {}
  document.documentElement.classList.add(hosted ? 'lka-hosted' : 'lka-local', 'lka-role-' + host.role);
  if (hosted) window.LKA_BACKEND_URL = window.location.origin;
  // QQ and message history belong to the local frontend service (/plugins/*),
  // which a backend-hosted page does not have; their modules check this flag.
  if (hosted) window.LkaMessageApiDisabled = true;

  function emit() {
    var snapshot = host.snapshot();
    listeners.forEach(function (listener) { try { listener(snapshot); } catch (ignored) {} });
    window.dispatchEvent(new CustomEvent('lka-host-changed', { detail: snapshot }));
  }
  function setCsrf(value) {
    host.csrf = value || '';
    try { if (value) sessionStorage.setItem(CSRF_KEY, value); else sessionStorage.removeItem(CSRF_KEY); } catch (ignored) {}
  }
  function urlOf(input) { return typeof input === 'string' ? input : input && input.url || String(input || ''); }
  function sameOrigin(url) { try { return new URL(url, window.location.href).origin === window.location.origin; } catch (ignored) { return false; } }
  function isWrite(method) { return ['GET', 'HEAD', 'OPTIONS'].indexOf(String(method || 'GET').toUpperCase()) < 0; }
  function pathOf(url) { try { return new URL(url, window.location.href).pathname; } catch (ignored) { return ''; } }
  function entryUrl(extra) {
    var url = new URL('./connect.html', window.location.href);
    if (document.documentElement.classList.contains('lka-layout-mobile') || params.get('layout') === 'mobile') url.searchParams.set('layout', 'mobile');
    Object.keys(extra || {}).forEach(function (key) { url.searchParams.set(key, extra[key]); });
    return url.href;
  }

  // ---- Local mode: optional cloud routing for 真理 / 待办 / 项目 / 记忆 ----
  // Only active when the local backend itself reports replica (no local manager)
  // and the frontend service holds a cloud login. Otherwise every request stays local.
  var routing = { sessions: Object.create(null), runs: Object.create(null) };
  try {
    var savedRouting = JSON.parse(localStorage.getItem(ROUTING_KEY) || '{}');
    (savedRouting.sessions || []).forEach(function (id) { routing.sessions[id] = true; });
    (savedRouting.runs || []).slice(-200).forEach(function (id) { routing.runs[id] = true; });
  } catch (ignored) {}
  function saveRouting() {
    try { localStorage.setItem(ROUTING_KEY, JSON.stringify({ sessions: Object.keys(routing.sessions).slice(-20), runs: Object.keys(routing.runs).slice(-200) })); } catch (ignored) {}
  }
  // 真理 and 待办 live on the hub. On a node page (or a local page whose
  // backend is a node) these paths, and the assistant's own sessions, runs and
  // reviews, are sent to the hub; everything else stays on this computer.
  var CLOUD_OWNED = /^(?:managers(?:\/|$)|matters(?:\/|\?|$)|projects(?:\/|\?|$)|memories(?:\/|\?|$)|background\/)/;
  var NODE_CLOUD_OWNED = /^(?:managers(?:\/|$)|matters(?:\/|\?|$))/;
  var STARTUP_OWNED = /^(?:managers|matters|projects|memories|background)(?:\/|\?|$)/;
  function relativeRest(url) {
    if (!sameOrigin(url)) return null;
    var parsed = new URL(url, window.location.href);
    if (hosted) return { rest: parsed.pathname.slice(1), search: parsed.search };
    var match = parsed.pathname.match(/^\/workbench\/(.*)$/);
    return match ? { rest: match[1], search: parsed.search } : null;
  }
  function assistantOwned(rest) {
    var session = rest.match(/^sessions\/([^/?]+)/), run = rest.match(/^agent\/runs\/([^/?]+)/), review = rest.match(/^agent\/safety-reviews\/([^/?]+)/);
    return (hosted ? NODE_CLOUD_OWNED : CLOUD_OWNED).test(rest) || !!(session && routing.sessions[decodeURIComponent(session[1])])
      || !!(run && routing.runs[decodeURIComponent(run[1])]) || !!(review && routing.reviews[decodeURIComponent(review[1])]);
  }
  function cloudTarget(url) {
    if (!host.cloudRouting) return '';
    var target = relativeRest(url);
    if (!target || !assistantOwned(target.rest)) return '';
    return (hosted ? host.hub.origin + '/' : '/cloud/') + target.rest + target.search;
  }
  routing.reviews = Object.create(null);
  function learn(value, depth) {
    if (!value || typeof value !== 'object' || depth > 4) return;
    if (Array.isArray(value)) { value.slice(0, 200).forEach(function (item) { learn(item, depth + 1); }); return; }
    if (value.session && value.session.kind === 'manager' && value.session.session_id) routing.sessions[value.session.session_id] = true;
    if (value.kind === 'manager' && value.session_id) routing.sessions[value.session_id] = true;
    ['run_id', 'active_run_id'].forEach(function (key) { if (typeof value[key] === 'string' && value[key]) routing.runs[value[key]] = true; });
    if (typeof value.review_id === 'string' && value.review_id) routing.reviews[value.review_id] = true;
    // Manager feeds (events, executions, deliveries) name the runs 真理 owns.
    ['input', 'inputs', 'session', 'controller', 'runs', 'items', 'reviews', 'events', 'executions', 'deliveries', 'payload'].forEach(function (key) { if (value[key]) learn(value[key], depth + 1); });
  }
  function hubInit(init, method) {
    var headers = new Headers(init.headers || {});
    if (isWrite(method) && host.hub.csrf && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', host.hub.csrf);
    return Object.assign({}, init, { headers: headers, credentials: 'include', mode: 'cors' });
  }
  function hubLost(response) {
    if (response.status === 401 && host.hub.loggedIn) { host.hub.loggedIn = false; host.hub.account = null; applyHub(); }
  }
  function unavailable() {
    return Promise.resolve(new Response(JSON.stringify({ detail: 'cloud_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
  }

  window.fetch = function (input, init) {
    init = init || {};
    var url = urlOf(input), method = init.method || (input && input.method) || 'GET';
    var rest = relativeRest(url);
    // Cloud-owned requests made during startup wait until the routing decision exists.
    if (rest && STARTUP_OWNED.test(rest.rest) && (!hosted && !resolved || nodePage && !hubResolved)) {
      return (hosted ? host.hubReady : localProbe || host.ready).then(function () { return window.fetch(input, init); });
    }
    // A node never answers for 真理 or 待办; without the hub, fail fast and quietly.
    if (rest && !host.cloudRouting && ((nodePage && assistantOwned(rest.rest))
        || (!hosted && host.clientMode !== 'cloud' && host.backendRole !== 'local' && assistantOwned(rest.rest)))) return unavailable();
    var rewritten = cloudTarget(url);
    if (rewritten) {
      return nativeFetch(rewritten, hosted ? hubInit(init, method) : init).then(async function (response) {
        if (hosted) hubLost(response); else if (response.status === 401) { applyCloud(Object.assign({}, host.cloudStatus, { logged_in: false })); refreshCloud(); }
        if ((response.headers.get('content-type') || '').indexOf('application/json') >= 0) {
          var learned = response.clone().json().then(function (data) { learn(data, 0); saveRouting(); }).catch(function () {});
          // Callers can read this manager's session as soon as fetch resolves.
          // Register its cloud identity before allowing that dependent request.
          if (/^managers(?:\/|$)/.test(rest && rest.rest || '')) await learned;
        }
        return response;
      });
    }
    // Panels address the hub by origin directly (devices, tasks, account).
    if (nodePage && host.hub.origin && (function () { try { return new URL(url, window.location.href).origin === host.hub.origin; } catch (ignored) { return false; } }())) {
      return nativeFetch(input, hubInit(init, method)).then(function (response) { hubLost(response); return response; });
    }
    if (hosted && sameOrigin(url)) {
      var headers = new Headers(init.headers || (typeof input !== 'string' && input && input.headers) || {});
      if (isWrite(method) && host.csrf && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', host.csrf);
      init = Object.assign({}, init, { headers: headers, credentials: 'same-origin' });
      return nativeFetch(input, init).then(function (response) {
        var path = pathOf(url);
        if (response.status === 401 && path !== '/auth/login' && path !== '/connections/redeem' && host.identity !== 'expired') {
          host.identity = 'expired'; emit();
        }
        return response;
      });
    }
    return nativeFetch(input, init);
  };
  if (hosted) {
    var xhrOpen = XMLHttpRequest.prototype.open, xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) { this.__lkaRequest = { method: method, url: url }; return xhrOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var meta = this.__lkaRequest;
      if (meta && sameOrigin(meta.url) && isWrite(meta.method) && host.csrf) { try { this.setRequestHeader('X-CSRF-Token', host.csrf); } catch (ignored) {} }
      return xhrSend.apply(this, arguments);
    };
  }

  // ---- JSON helper for the cluster panels ----
  function failure(status, detail) {
    var messages = {
      0: '无法连接服务，请检查网络后重试。', 401: '登录已失效，请重新登录或重新进入设备。', 403: '当前身份没有这项权限，或操作凭据已失效。',
      404: '此功能未开启或内容已不可用。', 409: '内容已变化或与当前状态冲突，请刷新后再试。', 413: '内容超过大小限制。',
      422: '输入不符合要求，请检查后重试。', 429: '操作太频繁，请稍候再试。', 502: '云端暂时无法连接。', 503: '服务暂时不可用。'
    };
    var text = typeof detail === 'string' && detail && detail.length < 200 && !/^workbench_|^cloud_/.test(detail) ? detail : '';
    var error = new Error((messages[status] || '请求未完成（HTTP ' + status + '）') + (text && status !== 401 ? ' ' + text : ''));
    error.status = status; error.detail = detail;
    return error;
  }
  host.request = async function (base, path, options) {
    options = options || {};
    if (base === null) throw failure(401);
    var init = { method: options.method || 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal: options.signal };
    if (options.json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(options.json); }
    else if (options.body !== undefined) { init.body = options.body; init.headers['Content-Type'] = options.contentType || 'application/octet-stream'; }
    var response;
    try { response = await window.fetch(base + path, init); }
    catch (error) { if (error && error.name === 'AbortError') throw error; throw failure(0); }
    if (options.raw && response.ok) return response;
    var text = response.status === 204 ? '' : await response.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (ignored) { data = null; }
    if (!response.ok) {
      if (base === '/cloud' && response.status === 401) refreshCloud();
      throw failure(response.status, data && data.detail);
    }
    return data;
  };
  // Hub address for cluster panels: same origin on the hub, the hub's own origin
  // from a node page, the loopback gateway on the local 8780 workbench.
  host.cloudBase = function () {
    if (hosted) return host.role === 'hub' ? '' : host.hub.loggedIn ? host.hub.origin : null;
    return host.cloud.loggedIn ? '/cloud' : null;
  };
  // CSRF for the hub, needed when carrying the session into another device.
  host.hubCsrf = function () { return host.role === 'hub' ? host.csrf : nodePage ? host.hub.csrf : ''; };
  host.entryUrl = entryUrl;
  host.setCsrf = setCsrf;
  host.onChange = function (listener) { listeners.push(listener); };
  host.snapshot = function () {
    return { hosted: host.hosted, clientMode: host.clientMode, role: host.role, backendRole: host.backendRole, identity: host.identity, principal: host.principal,
      csrf: !!host.csrf, info: host.info, cloud: Object.assign({}, host.cloud), cloudRouting: host.cloudRouting };
  };
  host.directory = function () {
    try {
      var saved = JSON.parse(localStorage.getItem(DIRECTORY_KEY) || 'null');
      return saved && Array.isArray(saved.devices) ? saved : { hub: '', devices: [] };
    } catch (ignored) { return { hub: '', devices: [] }; }
  };
  host.saveDirectory = function (value) {
    try { localStorage.setItem(DIRECTORY_KEY, JSON.stringify({ hub: value.hub || '', devices: (value.devices || []).slice(0, 50), saved_at: Date.now() })); } catch (ignored) {}
  };
  host.rememberCloudSession = function (sessionId) { if (sessionId) { routing.sessions[sessionId] = true; saveRouting(); } };
  host.isCloudSession = function (sessionId) { return host.cloudRouting && !!routing.sessions[sessionId]; };
  // Transport selection only: keep the existing ownership policy and fetch
  // wrapper as the sole router. Never accept a caller-supplied origin/base.
  host.routesViaCloud = function (path) {
    if (hosted || !host.cloudRouting || typeof path !== 'string'
        || !/^\/(?:managers|matters|projects|memories|background|sessions|agent)(?:[/?]|$)/.test(path)
        || /[\\\r\n#]/.test(path) || /(?:^|\/)\.\.?(?:\/|[?]|$)/.test(path)) return false;
    var candidate = new URL(window.location.origin + '/workbench' + path);
    if (/^\/managers(?:[/?]|$)/.test(path) && Array.from(candidate.searchParams.keys()).some(function (key) {
      return ['after', 'limit', 'offset'].indexOf(key) < 0;
    })) return false;
    return !!cloudTarget(candidate.href);
  };

  host.routingReady = function () { return hosted ? host.hubReady : localProbe || host.ready; };
  host.requiresCloudTransport = function (path) {
    if (typeof path !== 'string' || path.charAt(0) !== '/' || path.indexOf('//') === 0) return false;
    return host.clientMode === 'cloud' || hosted || (host.backendRole !== 'local' && assistantOwned(path.slice(1)));
  };

  // Identity probes must settle even when the service accepts a connection but stalls.
  async function readJson(path) {
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 6000);
    try {
      var response = await nativeFetch(path, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller.signal });
      var data = null;
      try { data = await response.json(); } catch (ignored) { data = null; }
      return { status: response.status, ok: response.ok, data: data };
    } finally { clearTimeout(timer); }
  }
  function applyCloud(cloud) {
    cloud = cloud || {};
    host.cloudStatus = cloud;
    host.clientMode = cloud.client_mode === 'cloud' ? 'cloud' : 'local';
    if (host.clientMode === 'cloud') window.LkaMessageApiDisabled = true;
    host.cloud = { configured: !!cloud.configured, loggedIn: !!cloud.logged_in, account: cloud.account || null, origin: cloud.origin || '', expiresAt: cloud.expires_at || 0 };
    host.cloudRouting = host.backendRole === 'replica' && host.cloud.loggedIn;
    emit();
  }
  var localProbe = null;
  function refreshCloud() {
    if (hosted) return Promise.resolve(host.snapshot());
    if (localProbe) return localProbe;
    resolved = false;
    localProbe = (async function () {
      // Retry both halves of routing: a failed startup role probe must recover
      // after login or reconnect, without requiring a page reload.
      var results = await Promise.all([
        readJson('/cloud-auth/status').catch(function () { return { status: 0 }; }),
        readJson('/workbench/client/info').catch(function () { return { status: 0 }; })
      ]);
      var service = results[0], local = results[1];
      if (!service.ok && service.status !== 0) {
        var direct = await readJson('/client/info').catch(function () { return { ok: false }; });
        if (direct.ok && direct.data && (direct.data.role === 'hub' || direct.data.role === 'replica')) {
          window.location.replace(entryUrl()); return host.snapshot();
        }
      }
      if (local.ok && local.data && local.data.role) {
        host.backendRole = local.data.role; host.info = local.data;
      }
      // Keep the known deployment mode and owner when a transient probe fails.
      // Authentication is unavailable until a successful status probe confirms it.
      applyCloud(service.ok && service.data ? service.data : Object.assign({}, host.cloudStatus, { logged_in: false }));
      return host.snapshot();
    }()).finally(function () { resolved = true; localProbe = null; });
    return localProbe;
  }
  host.refreshCloud = refreshCloud;

  // ---- Node page: reach the hub directly for 真理, 待办 and cluster panels ----
  function safeOrigin(value) {
    try {
      var url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && ['', '/'].indexOf(url.pathname) >= 0 ? url.origin : '';
    } catch (ignored) { return ''; }
  }
  function applyHub() {
    var before = host.cloudRouting;
    host.cloudRouting = nodePage && host.hub.loggedIn;
    document.documentElement.classList.toggle('lka-cloud-ready', host.cloudRouting);
    if (document.body) document.body.classList.toggle('lka-cloud-ready', host.cloudRouting);
    emit();
    // Assistant modules reload their state when the account behind them changes.
    if (before !== host.cloudRouting && resolvedOnce) window.dispatchEvent(new CustomEvent('lka-matter-auth-changed', { detail: { namespace: 'hub:' + host.hub.origin } }));
  }
  var resolvedOnce = false;
  async function probeHub() {
    if (!nodePage || !host.hub.origin) { host.hub.reachable = false; host.hub.loggedIn = false; applyHub(); return; }
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 6000);
    try {
      var response = await nativeFetch(host.hub.origin + '/auth/me', { credentials: 'include', mode: 'cors', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
      host.hub.reachable = true;
      host.hub.loggedIn = response.ok;
      host.hub.account = response.ok ? await response.json().catch(function () { return null; }) : null;
      if (host.hub.account) {
        // The hub hands its cookie session the matching CSRF token.
        if (host.hub.account.csrf_token) {
          host.hub.csrf = host.hub.account.csrf_token;
          try { sessionStorage.setItem(HUB_CSRF_KEY, host.hub.csrf); } catch (ignored) {}
        }
        delete host.hub.account.csrf_token; delete host.hub.account.csrf_hash;
      }
    } catch (ignored) { host.hub.reachable = false; host.hub.loggedIn = false; host.hub.account = null; }
    finally { clearTimeout(timer); }
    applyHub();
  }
  host.refreshHub = probeHub;
  host.hubLogin = async function (username, password) {
    var response = await nativeFetch(host.hub.origin + '/auth/login', { method: 'POST', credentials: 'include', mode: 'cors', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ username: username, password: password }) });
    var data = await response.json().catch(function () { return null; });
    if (!response.ok) throw failure(response.status, response.status === 403 ? '云端尚未允许这台电脑的地址登录（auth.allowed_origins）。' : data && data.detail);
    host.hub.csrf = data.csrf_token || '';
    try { sessionStorage.setItem(HUB_CSRF_KEY, host.hub.csrf); } catch (ignored) {}
    await probeHub();
    return host.hub.account;
  };
  host.hubLogout = async function () {
    try { await window.fetch(host.hub.origin + '/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (ignored) {}
    host.hub.csrf = '';
    try { sessionStorage.removeItem(HUB_CSRF_KEY); } catch (ignored) {}
    await probeHub();
  };

  host.ready = (async function () {
    if (!hosted) {
      return refreshCloud();
    }
    var info;
    try { info = await readJson('/client/info'); }
    catch (ignored) { host.identity = 'offline'; emit(); return host.snapshot(); }
    if (!info.ok || !info.data || info.data.role !== host.role) {
      try { localStorage.removeItem(ROLE_KEY); } catch (ignored) {}
      window.location.replace(entryUrl()); return host.snapshot();
    }
    host.info = info.data; host.backendRole = info.data.role;
    try { localStorage.setItem(ROLE_KEY, host.role); } catch (ignored) {}
    var me = await readJson(host.role === 'replica' ? '/connections/me' : '/auth/me').catch(function () { return { status: 0 }; });
    if (me.status === 401 || me.status === 403) { window.location.replace(entryUrl({ reason: 'expired' })); return host.snapshot(); }
    if (!me.ok) { host.identity = 'offline'; emit(); return host.snapshot(); }
    host.principal = me.data;
    // Both the hub and node return a CSRF token derived from the HttpOnly
    // cookie, so a new tab in the same browser works without signing in again.
    if (me.data && me.data.csrf_token) setCsrf(me.data.csrf_token);
    if (host.principal) delete host.principal.csrf_token;
    // read-only only remains for hub sessions signed in before CSRF derivation.
    host.identity = host.csrf ? 'ready' : 'read-only';
    if (nodePage) {
      // The node reports its configured hub; the saved directory covers older nodes.
      host.hub.origin = safeOrigin(info.data.hub_url || '') || safeOrigin(host.directory().hub || '');
    }
    emit();
    return host.snapshot();
  }());
  host.hubReady = host.ready.then(function () { return nodePage ? probeHub() : null; }).catch(function () {}).then(function () {
    hubResolved = true; resolvedOnce = true;
    if (nodePage) {
      // Re-check when the hub was away or the page returns to view.
      setInterval(function () { if (!document.hidden && !host.hub.loggedIn) probeHub(); }, 60000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) probeHub(); });
    }
    return host.snapshot();
  });
  window.LkaHost = host;
}());
