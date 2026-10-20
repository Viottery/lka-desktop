(function () {
  "use strict";
  var params = new URLSearchParams(window.location.search || "");
  if (params.get("embedded") !== "matter" || window.parent === window) return;
  var globalAssistant = params.get("assistant") === "global";
  var sessionId = params.get("session_id") || "", applied = Object.create(null), queued = null;
  // This file must load before chat.js. Isolate session selection, drafts, settings
  // writes and attachment state; no assistant context enters shared browser storage.
  var savedStorage, ephemeral = Object.create(null);
  try {
    savedStorage = window.localStorage;
    ["lka-current-backend-url", "agentic-rag-pet-run-settings-v1", "agentic-rag-workbench-panel-sizes-v1", "lka-workbench-panel-visibility-v1"].forEach(function (key) {
      var value = savedStorage.getItem(key);
      if (value !== null && key === "agentic-rag-pet-run-settings-v1") {
        try { var settings = JSON.parse(value); delete settings.workspace; if (globalAssistant) { delete settings.llmClient; delete settings.llmModel; delete settings.workspaceParent; } value = JSON.stringify(settings); } catch (ignored) { value = null; }
      }
      if (value !== null) ephemeral[key] = value;
    });
    var isolated = {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(ephemeral, String(key)) ? ephemeral[String(key)] : null; },
      setItem: function (key, value) { ephemeral[String(key)] = String(value); },
      removeItem: function (key) { delete ephemeral[String(key)]; },
      clear: function () { ephemeral = Object.create(null); },
      key: function (index) { return Object.keys(ephemeral)[index] || null; }
    };
    Object.defineProperty(isolated, "length", { get: function () { return Object.keys(ephemeral).length; } });
    Object.defineProperty(window, "localStorage", { configurable: true, get: function () { return isolated; } });
    // Other windows' storage notifications must not switch this isolated session.
    window.addEventListener("storage", function (event) { event.stopImmediatePropagation(); }, true);
  } catch (error) {
    // Refuse embedding if this engine cannot isolate storage before chat starts.
    window.__lkaMatterAssistantStorageError = true;
  }
  var css = document.createElement("style");
  css.textContent = "body.work-mode .chat-shell{grid-template-columns:minmax(0,1fr)!important}body.work-mode .chat-main{grid-column:1!important}.session-sidebar,.context-rail,.chat-topbar,.context-strip,.column-resizer,.sidebar-backdrop{display:none!important}body.work-mode .messages{padding:18px!important}body.work-mode .composer{padding:12px 16px!important}body{min-width:0!important}.welcome-eyebrow,.welcome-suggestions{display:none!important}.welcome{padding:24px 4px!important}.welcome h1{font-size:21px!important}.welcome p{font-size:12px!important}";
  document.head.appendChild(css);
  function send(payload) { window.parent.postMessage(payload, window.location.origin); }
  function active() {
    if (window.__lkaMatterAssistantStorageError) return false;
    var chat = window.LkaChatContext;
    return !!(chat && typeof chat.prepareMatterDraft === "function" && chat.get().sessionId === sessionId && (!globalAssistant || chat.get().kind === "manager"));
  }
  function personalizeWelcome() { var welcome = document.querySelector('.welcome'); if (!welcome) return; var title = welcome.querySelector('h1'), description = welcome.querySelector('p'); if (title) title.textContent = globalAssistant ? '把事情交给真理' : '想安排什么？'; if (description) description.textContent = globalAssistant ? '整理目标、委托任务，持续跟进进展。需要你决定时，会在右侧提醒。' : '可以创建规划、拆分行动，或调整已有安排。例如：制定六周英语学习计划。'; }
  function apply() {
    if (!active() || !queued) return;
    var message = queued; queued = null;
    if (!applied[message.draftId]) {
      window.LkaChatContext.prepareMatterDraft(message.text);
      applied[message.draftId] = true;
    }
    send({ type: "lka-matter-assistant-draft-ready", sessionId: sessionId, draftId: message.draftId });
  }
  window.addEventListener("message", function (event) {
    var message = event.data;
    if (event.origin !== window.location.origin || event.source !== window.parent || !message || message.sessionId !== sessionId) return;
    if (message.type === "lka-global-assistant-refresh") {
      if (globalAssistant && active() && typeof window.LkaChatContext.refreshConversation === "function") {
        Promise.resolve(window.LkaChatContext.refreshConversation()).catch(function () {});
      }
      return;
    }
    if (message.type !== "lka-matter-assistant-draft" || typeof message.draftId !== "string" || typeof message.text !== "string") return;
    queued = message; apply();
  });
  var announced = false, attempts = 0, timer;
  function announce() {
    if (active()) {
      personalizeWelcome();
      if (!announced) { announced = true; send({ type: "lka-matter-assistant-ready", sessionId: sessionId }); }
      apply(); return;
    }
    if (++attempts < 600) timer = setTimeout(announce, 50);
  }
  window.addEventListener("lka-session-context", function () { if (active()) { clearTimeout(timer); announce(); } });
  window.addEventListener("lka-agent-turn-finished", function (event) {
    if (active() && event.detail && event.detail.sessionId === sessionId) send({ type: "lka-matter-agent-finished", sessionId: sessionId });
  });
  window.addEventListener("pagehide", function () { clearTimeout(timer); queued = null; });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce, { once: true });
  else announce();
})();
