(function () {
  "use strict";
  if (window.LkaMatterHost) return;
  var params = new URLSearchParams(window.location.search || "");
  var chat = window.LkaChatContext, memory = window.LkaMemory;
  var standalone = !chat || document.body.hasAttribute("data-matter-standalone");
  var nativeMode = standalone && params.get("native") === "1";
  var token = "", sequence = 0, nonce = Date.now().toString(36) + Math.random().toString(36).slice(2);
  var authScope = memory && memory.hasToken && memory.hasToken() ? "page-" + nonce : nativeMode ? "native-paired" : "anonymous";
  var pending = Object.create(null), assistant = null, assistantGeneration = 0;
  function failure(message, status, detail) {
    var error = new Error(message); error.status = status || 0;
    if (detail !== undefined) error.detail = detail;
    return error;
  }
  function resolveBackend() {
    if (chat) return String(chat.get().backend || "").replace(/\/+$/, "");
    var configured = String(params.get("backend") || params.get("backend_url") || window.LKA_BACKEND_URL || "").trim();
    if (!configured) {
      try { configured = String(localStorage.getItem("lka-current-backend-url") || "").trim(); } catch (ignored) {}
    }
    var pageIsLocal = /^(?:localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(window.location.hostname);
    if (!configured) configured = pageIsLocal ? "http://127.0.0.1:8765" : window.location.origin + "/workbench";
    try {
      var target = new URL(configured, window.location.origin);
      if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error("Invalid backend");
      var targetIsLocal = /^(?:localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(target.hostname);
      if ((!pageIsLocal && targetIsLocal) || (pageIsLocal && targetIsLocal && target.port === "8765" && !target.pathname.replace(/\/$/, "") && window.location.pathname.indexOf("/desktop-pet/") === 0)) {
        return window.location.origin + "/workbench";
      }
      return target.href.replace(/\/+$/, "");
    } catch (ignored) { return window.location.origin + "/workbench"; }
  }
  var standaloneBackend = standalone ? resolveBackend() : "";
  function backend() { return standalone ? standaloneBackend : resolveBackend(); }
  function namespace() { return backend() + "|auth:" + authScope; }
  function parseResponse(status, text) {
    var payload;
    try { payload = text ? JSON.parse(text) : {}; } catch (ignored) { payload = {}; }
    if (status < 200 || status >= 300) {
      var detail = status === 409 && payload.detail === "Default management session is unavailable; restore or explicitly replace it"
        ? "default_manager_deleted" : payload.detail;
      var messages = { 0: "无法连接后端，请检查服务地址。", 401: "需要访问令牌，请检查连接设置。", 403: "当前连接没有访问权限。", 404: "事项或接口不可用，请检查后端版本。", 409: "内容已变化；请载入最新版本后核对当前草稿。" };
      throw failure(messages[status] || "请求失败 HTTP " + status, status, detail);
    }
    return payload;
  }
  var readyResolve, readyReject, bridgeTimer;
  var ready = new Promise(function (resolve, reject) { readyResolve = resolve; readyReject = reject; });
  // A missing native bridge must never fall through to an early browser request.
  ready.catch(function () {});
  if (nativeMode) {
    var previousReady = window.__petMatterBridgeReady;
    window.__petMatterBridgeReady = function () {
      if (typeof previousReady === "function") previousReady();
      if (!window.petBridge || typeof window.petBridge.requestMemory !== "function") return;
      clearTimeout(bridgeTimer); readyResolve();
    };
    bridgeTimer = setTimeout(function () { readyReject(failure("桌面通信尚未就绪，请重新打开待办窗口。", 0)); }, 30000);
    if (window.petBridge && typeof window.petBridge.requestMemory === "function") window.__petMatterBridgeReady();
    var previousReceive = window.__lkaMemoryBridgeReceive;
    window.__lkaMemoryBridgeReceive = function (id, status, text) {
      var operation = pending[id];
      if (!operation) { if (typeof previousReceive === "function") previousReceive(id, status, text); return; }
      delete pending[id]; clearTimeout(operation.timer);
      try { operation.resolve(parseResponse(Number(status), text)); } catch (error) { operation.reject(error); }
    };
  } else readyResolve();
  async function request(path, method, body) {
    if (typeof path !== "string" || path.charAt(0) !== "/" || path.indexOf("//") === 0 || /[\\\r\n]/.test(path)) throw failure("无效的接口路径。", 0);
    method = String(method || "GET").toUpperCase();
    await ready;
    if (!standalone && memory) return memory.request(path, method, body);
    if (nativeMode) {
      return new Promise(function (resolve, reject) {
        var id = "memory-" + nonce + "-" + (++sequence);
        pending[id] = { resolve: resolve, reject: reject, timer: setTimeout(function () {
          delete pending[id]; reject(failure("请求超时，请刷新后再操作。", 0));
        }, 30000) };
        try {
          window.petBridge.requestMemory(JSON.stringify({ id: id, method: method, path: path,
            body: body === undefined ? "" : JSON.stringify(body), token: token }));
        } catch (error) { clearTimeout(pending[id].timer); delete pending[id]; reject(failure(error.message || "桌面请求失败。", 0)); }
      });
    }
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 30000);
    try {
      var headers = { Accept: "application/json" };
      if (token) headers.Authorization = "Bearer " + token;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      var response = await fetch(backend() + path, { method: method, headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      return parseResponse(response.status, await response.text());
    } catch (error) {
      if (error.status !== undefined) throw error;
      throw failure(error.name === "AbortError" ? "请求超时，请刷新后再操作。" : "无法连接后端，请检查服务地址。", 0);
    } finally { clearTimeout(timer); }
  }
  var memorySetToken = memory && memory.setToken;
  function updateAuthScope(value) {
    token = String(value || "").trim();
    // Random page scopes avoid persisting either the credential or a reversible fingerprint.
    authScope = token ? "page-" + nonce + "-" + (++sequence) : nativeMode ? "native-paired" : "anonymous";
    closeAssistant();
    window.dispatchEvent(new CustomEvent("lka-matter-auth-changed", { detail: { namespace: namespace(), backend: backend() } }));
  }
  function setToken(value) {
    if (typeof memorySetToken === "function") memorySetToken.call(memory, String(value || "").trim());
    updateAuthScope(value);
  }
  if (typeof memorySetToken === "function") {
    memory.setToken = function (value) { memorySetToken.call(memory, value); updateAuthScope(value); };
  }
  if (!standalone && document.getElementById) {
    var memoryTokenForm = document.getElementById("memoryTokenForm");
    if (memoryTokenForm) memoryTokenForm.addEventListener("submit", function () {
      var field = document.getElementById("memoryToken");
      if (field) updateAuthScope(field.value);
    }, true);
  }
  function draftText(context) {
    if (typeof context === "string") return context;
    context = context || {};
    var suppliedText = typeof context.text === "string" ? context.text : typeof context.draft === "string" ? context.draft : "";
    var lines = ["请帮我管理待办与规划；先核对当前记录，按我的后续说明处理。"];
    var record = context.matter || context.task || context.plan;
    if (record) {
      lines.push("当前" + (record.kind === "plan" ? "规划" : "事项") + "：" + String(record.title || "") + "（" + String(record.matter_id || "") + "）");
      if (record.revision != null) lines.push("当前版本：" + record.revision);
    }
    if (context.plan && context.plan !== record) lines.push("所属规划：" + String(context.plan.title || "") + "（" + String(context.plan.matter_id || "") + "）");
    if (context.view) lines.push("当前视图：" + String(context.view));
    if (context.plan && context.plan !== record && context.plan.revision != null) lines.push("规划版本：" + context.plan.revision);
    if (context.selection) lines.push("当前选择上下文：" + JSON.stringify(context.selection));
    if (suppliedText) lines.push(suppliedText);
    lines.push("\n我的要求：");
    return lines.join("\n");
  }
  function closeAssistant() {
    assistantGeneration++;
    if (!assistant) return;
    var current = assistant; assistant = null;
    clearTimeout(current.timer); window.removeEventListener("message", current.listener);
    if (current.frame && current.frame.parentNode) current.frame.parentNode.removeChild(current.frame);
    if (current.reject) current.reject(failure("待办助手已关闭。", 0));
  }
  async function openAssistant(container, context) {
    if (!container || typeof container.appendChild !== "function") throw failure("缺少助手显示区域。", 0);
    closeAssistant();
    var generation = assistantGeneration;
    var created, controller = null;
    try {
      created = await request("/managers/default", "POST");
      controller = created && created.controller;
      if (!created.session || created.session.kind !== "manager" || !controller || controller.session_id !== created.session.session_id || !Number.isSafeInteger(controller.revision) || controller.revision < 1 || ["paused", "active"].indexOf(controller.status) < 0) throw failure("管理会话状态无效。", 0);
    } catch (error) {
      var legacy = false;
      if (error.status === 404) {
        try {
          var schema = await request("/openapi.json"), paths = schema && schema.paths;
          legacy = !!(paths && typeof paths === "object" && !Array.isArray(paths)
            && !Object.prototype.hasOwnProperty.call(paths, "/managers/default")
            && paths["/sessions"] && paths["/sessions"].post
            && ((paths["/agent/turn"] && paths["/agent/turn"].post)
              || (paths["/agent/turn/stream"] && paths["/agent/turn/stream"].post)));
        } catch (ignored) { /* Failure is not evidence of a legacy backend. */ }
      }
      if (!legacy && (error.status !== 409 || error.detail !== "management_disabled")) throw error;
      if (generation !== assistantGeneration) throw failure("待办助手已关闭。", 0);
      created = await request("/sessions", "POST", { title: "待办与规划助手" });
    }
    if (generation !== assistantGeneration) throw failure("待办助手已关闭。", 0);
    var sessionId = created && created.session && created.session.session_id || created && created.session_id;
    if (!sessionId) throw failure("创建助手会话失败：后端未返回会话身份。", 0);
    var frame = document.createElement("iframe"), url = new URL("./chat.html", window.location.href);
    url.search = ""; url.searchParams.set("mode", "work"); url.searchParams.set("embedded", "matter");
    if (controller) url.searchParams.set("assistant", "global");
    url.searchParams.set("session_id", sessionId); url.searchParams.set("backend", backend());
    frame.title = "真理 · 待办助手"; frame.className = "matter-assistant-frame";
    frame.style.cssText = "display:block;width:100%;height:100%;min-height:360px;border:0;background:transparent";
    var draftId = "matter-draft-" + nonce + "-" + (++sequence);
    var draft = { type: "lka-matter-assistant-draft", sessionId: sessionId, draftId: draftId, text: draftText(context) };
    return new Promise(function (resolve, reject) {
      var current = { frame: frame, sessionId: sessionId, reject: reject };
      function sendDraft() { if (assistant === current && frame.contentWindow) frame.contentWindow.postMessage(draft, window.location.origin); }
      current.listener = function (event) {
        if (assistant !== current || event.origin !== window.location.origin || event.source !== frame.contentWindow || !event.data || event.data.sessionId !== sessionId) return;
        if (event.data.type === "lka-matter-assistant-ready") sendDraft();
        if (event.data.type === "lka-matter-assistant-draft-ready" && event.data.draftId === draftId) {
          clearTimeout(current.timer); current.reject = null;
          resolve({ sessionId: sessionId, frame: frame, controller: controller, close: closeAssistant });
        }
        if (event.data.type === "lka-matter-agent-finished") {
          window.dispatchEvent(new CustomEvent("lka-matter-agent-finished", { detail: { sessionId: sessionId } }));
        }
      };
      current.timer = setTimeout(function () {
        if (assistant !== current) return;
        current.reject = null; closeAssistant(); reject(failure("助手载入超时，请检查连接后重试。", 0));
      }, 30000);
      assistant = current; window.addEventListener("message", current.listener);
      frame.addEventListener("load", sendDraft); frame.src = url.href; container.appendChild(frame);
    });
  }
  window.addEventListener("pagehide", closeAssistant);
  window.LkaMatterHost = { request: request, ready: ready, setToken: setToken,
    openAssistant: openAssistant, closeAssistant: closeAssistant,
    updateAssistantManager: async function (sessionId, expectedRevision, status) {
      if (!assistant || assistant.sessionId !== sessionId) throw failure("待办助手已关闭。", 0);
      return request("/managers/" + encodeURIComponent(sessionId), "PATCH", { expected_revision: expectedRevision, status: status });
    },
    standalone: standalone, quick: chat ? !chat.get().workMode : params.get("mode") === "quick" };
  Object.defineProperties(window.LkaMatterHost, {
    namespace: { enumerable: true, get: namespace }, backend: { enumerable: true, get: backend }
  });
})();
