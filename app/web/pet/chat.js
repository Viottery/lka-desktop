(function () {
  var messages = document.querySelector("#messages");
  var input = document.querySelector("#questionInput");
  var sendButton = document.querySelector("#sendButton");
  var form = document.querySelector("#chatForm");
  var chatShell = document.querySelector("#chatShell");
  var sidebarBackdrop = document.querySelector("#sidebarBackdrop");
  var sessionList = document.querySelector("#sessionList");
  var sessionSearchInput = document.querySelector("#sessionSearchInput");
  var loadMoreSessionsButton = document.querySelector("#loadMoreSessionsButton");
  var sessionListStatus = document.querySelector("#sessionListStatus");
  var sessionListCaption = document.querySelector("#sessionListCaption");
  var toggleDeletedSessionsButton = document.querySelector("#toggleDeletedSessionsButton");
  var toggleSidebarButton = document.querySelector("#toggleSidebarButton");
  var newSessionButton = document.querySelector("#newSessionButton");
  var activeSessionTitle = document.querySelector("#activeSessionTitle");
  var activeSessionSubtitle = document.querySelector("#activeSessionSubtitle");
  var backendOfflinePanel = document.querySelector("#backendOfflinePanel");
  var backendOfflineReason = document.querySelector("#backendOfflineReason");
  var startBackendButton = document.querySelector("#startBackendButton");
  var retryBackendButton = document.querySelector("#retryBackendButton");
  var workspaceInput = document.querySelector("#workspaceInput");
  var llmModelInput = document.querySelector("#llmModelInput");
  var refreshModelsButton = document.querySelector("#refreshModelsButton");
  var modelCatalogStatus = document.querySelector("#modelCatalogStatus");
  var workspaceParentInput = document.querySelector("#workspaceParentInput");
  var defaultsSaveStatus = document.querySelector("#defaultsSaveStatus");
  var resetDefaultsButton = document.querySelector("#resetDefaultsButton");
  var safetyModeSelect = document.querySelector("#safetyModeSelect");
  var streamToggle = document.querySelector("#streamToggle");
  var indexWorkspaceButton = document.querySelector("#indexWorkspaceButton");
  var runStatus = document.querySelector("#runStatus");
  var runTimeline = document.querySelector("#runTimeline");
  var runTimelineSummary = document.querySelector("#runTimelineSummary");
  var runTimelineList = document.querySelector("#runTimelineList");
  var liveAnswers = Object.create(null), runProcesses = Object.create(null), timelineViewKey = "";
  var multiAgentStatus = document.querySelector("#multiAgentStatus");
  var approvalQueueStatus = document.querySelector("#approvalQueueStatus");
  var workspaceSummary = document.querySelector("#workspaceSummary");
  var openWorkbenchButton = document.querySelector("#openWorkbenchButton");
  var continueWorkbenchButton = document.querySelector("#continueWorkbenchButton");
  var toggleSettingsButton = document.querySelector("#toggleSettingsButton");
  var closeSettingsButton = document.querySelector("#closeSettingsButton");
  var changeWorkspaceButton = document.querySelector("#changeWorkspaceButton");
  var newQuickSessionButton = document.querySelector("#newQuickSessionButton");
  var filesTabButton = document.querySelector("#filesTabButton");
  var settingsTabButton = document.querySelector("#settingsTabButton");
  var filesPanel = document.querySelector("#filesPanel");
  var settingsPanel = document.querySelector("#settingsPanel");
  var fileList = document.querySelector("#fileList");
  var filePreview = document.querySelector("#filePreview");
  var fileCurrentPath = document.querySelector("#fileCurrentPath");
  var fileUpButton = document.querySelector("#fileUpButton");
  var refreshFilesButton = document.querySelector("#refreshFilesButton");
  var sidebarResizeHandle = document.querySelector("#sidebarResizeHandle");
  var railResizeHandle = document.querySelector("#railResizeHandle");
  var undoToast = document.querySelector("#undoToast");
  var undoToastText = document.querySelector("#undoToastText");
  var undoDeleteButton = document.querySelector("#undoDeleteButton");
  var dismissUndoButton = document.querySelector("#dismissUndoButton");
  var urlParams = new URLSearchParams(window.location.search);
  var workMode = urlParams.get("mode") === "work" || urlParams.get("layout") === "mobile";
  var requestedSessionId = safeText(urlParams.get("session_id")).trim();
  var requestedRunId = safeText(urlParams.get("run_id")).trim();
  document.body.classList.toggle("work-mode", workMode);
  document.body.classList.toggle("quick-mode", !workMode);

  if (!messages || !input || !sendButton || !form) {
    return;
  }

  // v4: use unified conversation ids as session ids + editable titles.
  var sessionsKey = "agentic-rag-pet-chat-sessions-v4";
  var runCursorKeyPrefix = sessionsKey + "-run-cursor-";
  var activeSessionKey = "agentic-rag-pet-chat-active-session-v4";
  var deletedSessionsKey = sessionsKey + "-deleted";
  var deletedSnapshotsKey = sessionsKey + "-deleted-snapshots";
  var draftKeyPrefix = sessionsKey + "-draft-";
  var panelSizeKey = "agentic-rag-workbench-panel-sizes-v1";
  var panelVisibilityKey = "lka-workbench-panel-visibility-v1";
  var desktopPanels = workMode && urlParams.get("layout") !== "mobile";
  var panelVisibility = { sidebar: true, rail: true };
  var deletedSessionIds = Object.create(null);
  var deletingSessionIds = Object.create(null);
  var deletedThisPage = Object.create(null);
  var restoringSessionIds = Object.create(null);
  var deletedSessionSnapshots = [];
  var backendDeletedSessions = [];
  var viewingDeletedSessions = false;
  var previousSessionsKey = "agentic-rag-pet-chat-sessions-v3";
  var previousActiveSessionKey = "agentic-rag-pet-chat-active-session-v3";
  var legacySessionsKey = "agentic-rag-pet-chat-sessions-v2";
  var sessions = [];
  var historyItems = [];
  var deletedHistoryItems = [];
  var historyOffset = 0;
  var historyHasMore = false;
  var historyLoading = false;
  var historyRequestGeneration = 0;
  var historySearchTimer = null;
  var historyError = "";
  var lastKnownSearch = "";
  var undoSessionId = "";
  var undoTimer = null;
  var fileRelativePath = "";
  var fileRequestGeneration = 0;
  var selectedFilePath = "";
  var activeRailTab = workMode ? "files" : "settings";
  var sessionSyncPromise = null;
  var emptyCleanupCapability = null;
  var multiAgentSnapshotRequestIds = {};
  var activeAgentEventController = null;
  var activeAgentTurnGeneration = 0;
  var pendingSafetyReviews = [];
  var approvalQueueReady = false;
  var approvalQueueRequestInFlight = false;
  var approvalQueueRefreshRequested = false;
  var approvalActionInFlight = false;
  var approvalQueueNotice = "";
  var approvalQueuePollTimer = null;
  var multiAgentCommandInFlight = {};
  var pendingContinuationCommands = {};
  var activeSessionId = "";
  var lastSubmitAt = 0;
  var pendingState = null;
  var renamingSessionId = "";
  var renameDraft = "";
  var backendOffline = false;
  var backendBaseUrl = resolveBackendBaseUrl();
  var runSettingsKey = "agentic-rag-pet-run-settings-v1";
  var runSettings = { workspace: "", llmClient: "", llmModel: "", safetyMode: "backend", stream: true, workspaceParent: "" };
  var modelCatalog = null;
  var modelCatalogRetryTimer = null;
  var defaultsDirty = false;
  var defaultsSaveChain = Promise.resolve();
  var defaultsReady = Promise.resolve();
  var workspaceRequests = {};
  var workspaceBindings = Object.create(null);
  var fileWorkspacePreparations = [];
  var workbenchOpening = false;
  var workspaceSwitchPromise = Promise.resolve(true);
  var bridgeWorkspaceRetryScheduled = false;

  function setRunStatus(text, kind) {
    if (!runStatus) return;
    runStatus.textContent = safeText(text);
    runStatus.className = "run-status" + (kind ? " " + kind : "");
  }

  function loadRunSettings() {
    try { runSettings = Object.assign(runSettings, JSON.parse(localStorage.getItem(runSettingsKey) || "{}")); } catch (ignored) {}
    if (workspaceInput) workspaceInput.value = "";
    renderModelOptions();
    if (safetyModeSelect) safetyModeSelect.value = runSettings.safetyMode || "backend";
    if (streamToggle) streamToggle.checked = runSettings.stream !== false;
    if (workspaceParentInput) workspaceParentInput.value = runSettings.workspaceParent || "";
  }

  function saveRunSettings() {
    var session = getActiveSession();
    runSettings.workspace = session ? safeText(session.workspace).trim() : "";
    runSettings.safetyMode = safetyModeSelect ? safetyModeSelect.value : "backend";
    runSettings.stream = streamToggle ? streamToggle.checked : true;
    try { localStorage.setItem(runSettingsKey, JSON.stringify(runSettings)); } catch (ignored) {}
  }

  function selectedModelValue() {
    return runSettings.llmClient && runSettings.llmModel ? JSON.stringify([runSettings.llmClient, runSettings.llmModel]) : "";
  }

  function renderModelOptions() {
    if (!llmModelInput) return;
    llmModelInput.textContent = "";
    var defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "跟随后端默认模型";
    llmModelInput.appendChild(defaultOption);
    var found = false;
    (modelCatalog && modelCatalog.clients || []).forEach(function (client) {
      var group = document.createElement("optgroup");
      group.label = client.name;
      (client.models || []).forEach(function (model) {
        var option = document.createElement("option");
        option.value = JSON.stringify([client.name, model]);
        option.textContent = model === client.default_model ? model + " · 默认" : model;
        if (runSettings.llmModel === model && (!runSettings.llmClient || runSettings.llmClient === client.name)) {
          option.selected = true;
          runSettings.llmClient = client.name;
          found = true;
        }
        group.appendChild(option);
      });
      llmModelInput.appendChild(group);
    });
    if (!found && runSettings.llmModel) {
      var oldOption = document.createElement("option");
      oldOption.value = selectedModelValue() || JSON.stringify(["", runSettings.llmModel]);
      oldOption.textContent = runSettings.llmModel + " · 已保存，当前未列出";
      oldOption.selected = true;
      llmModelInput.appendChild(oldOption);
    }
  }

  async function loadModelCatalog(refresh) {
    if (modelCatalogRetryTimer) {
      clearTimeout(modelCatalogRetryTimer);
      modelCatalogRetryTimer = null;
    }
    if (modelCatalogStatus) modelCatalogStatus.textContent = "正在读取可用模型…";
    try {
      var response = await fetch(backendBaseUrl + "/agent/models" + (refresh ? "?refresh=true" : ""));
      if (!response.ok) throw new Error("HTTP " + response.status);
      modelCatalog = await response.json();
      renderModelOptions();
      var count = (modelCatalog.clients || []).reduce(function (sum, item) { return sum + (item.models || []).length; }, 0);
      if (modelCatalogStatus) modelCatalogStatus.textContent = count ? "已读取 " + count + " 个模型" : "未配置可用模型";
      if (backendOffline) setBackendOfflineState(false, "");
    } catch (error) {
      var reason = error && error.message ? error.message : String(error);
      if (modelCatalogStatus) modelCatalogStatus.textContent = isBackendOfflineError(reason)
        ? "后端未连接；恢复后将自动重试"
        : "读取失败（" + reason + "）；稍后自动重试";
      if (modelCatalogRetryTimer) clearTimeout(modelCatalogRetryTimer);
      modelCatalogRetryTimer = setTimeout(function () {
        modelCatalogRetryTimer = null;
        loadModelCatalog(false);
      }, 8000);
    }
  }

  async function loadSharedDefaults() {
    try {
      var response = await fetch(backendBaseUrl + "/agent/ui-defaults");
      if (!response.ok) throw new Error("HTTP " + response.status);
      var payload = await response.json();
      if (!payload.configured || defaultsDirty) return;
      var defaults = payload.defaults || {};
      runSettings.llmClient = defaults.llm_client || "";
      runSettings.llmModel = defaults.llm_model || "";
      runSettings.safetyMode = defaults.safety_mode || "backend";
      runSettings.stream = defaults.stream !== false;
      runSettings.workspaceParent = defaults.workspace_parent || "";
      if (safetyModeSelect) safetyModeSelect.value = runSettings.safetyMode;
      if (streamToggle) streamToggle.checked = runSettings.stream;
      if (workspaceParentInput) workspaceParentInput.value = runSettings.workspaceParent;
      renderModelOptions();
      try { localStorage.setItem(runSettingsKey, JSON.stringify(runSettings)); } catch (ignored) {}
    } catch (ignored) {
      if (defaultsSaveStatus) defaultsSaveStatus.textContent = "暂时无法读取共享设置；使用本机已保存设置";
    }
  }

  function saveDefaultPreferences() {
    var parent = workspaceParentInput ? workspaceParentInput.value.trim() : "";
    if (parent && !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(parent)) {
      if (defaultsSaveStatus) { defaultsSaveStatus.textContent = "请输入完整的绝对路径"; defaultsSaveStatus.classList.add("error"); }
      return;
    }
    defaultsDirty = true;
    if (llmModelInput && llmModelInput.value) {
      try {
        var selected = JSON.parse(llmModelInput.value);
        runSettings.llmClient = selected[0] || "";
        runSettings.llmModel = selected[1] || "";
      } catch (ignored) { return; }
    } else {
      runSettings.llmClient = "";
      runSettings.llmModel = "";
    }
    runSettings.workspaceParent = parent;
    saveRunSettings();
    var defaults = { llm_client: runSettings.llmClient, llm_model: runSettings.llmModel,
      safety_mode: runSettings.safetyMode, stream: runSettings.stream, workspace_parent: parent };
    if (defaultsSaveStatus) { defaultsSaveStatus.textContent = "正在保存…"; defaultsSaveStatus.classList.remove("error"); }
    defaultsSaveChain = defaultsSaveChain.catch(function () {}).then(async function () {
      if (window.petBridge && typeof window.petBridge.saveUiDefaults === "function") {
        var bridgeResult = JSON.parse(window.petBridge.saveUiDefaults(JSON.stringify(defaults)) || "{}");
        if (bridgeResult.error) throw new Error(bridgeResult.error);
      } else {
        var response = await fetch(backendBaseUrl + "/agent/ui-defaults", { method: "PUT",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(defaults) });
        if (!response.ok) throw new Error("HTTP " + response.status);
      }
      if (defaultsSaveStatus) defaultsSaveStatus.textContent = "默认设置已保存";
    }).catch(function (error) {
      if (defaultsSaveStatus) { defaultsSaveStatus.textContent = "保存失败：" + error.message; defaultsSaveStatus.classList.add("error"); }
    });
  }

  function resolveBackendBaseUrl() {
    var fallback = "http://127.0.0.1:8765";
    var params = new URLSearchParams(window.location.search || "");
    var configured = safeText(params.get("backend") || params.get("backend_url") || window.LKA_BACKEND_URL).trim();
    if (!configured) {
      try {
        configured = safeText(localStorage.getItem("lka-current-backend-url")).trim();
      } catch (ignored) {
        configured = "";
      }
    }
    var pageIsLocal = /^(?:localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(window.location.hostname);
    if (!configured) configured = pageIsLocal ? fallback : window.location.origin + "/workbench";
    // A desktop bookmark's localhost target points to the phone itself remotely.
    try {
      var target = new URL(configured, window.location.origin);
      var targetIsLocal = /^(?:localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(target.hostname);
      if (!pageIsLocal && targetIsLocal
          || pageIsLocal && targetIsLocal && target.port === "8765"
            && !target.pathname.replace(/\/$/, "")
            && window.location.pathname.indexOf("/desktop-pet/") === 0) {
        // Use the existing fixed gateway for the default desktop backend too.
        // JavaFX's HTTP/1.1 loader omits some CORS preflight headers; same-origin
        // history, settings and attachments keep the native window consistent.
        configured = window.location.origin + "/workbench";
      }
    } catch (ignored) {}
    configured = configured.replace(/\/+$/, "");
    try {
      localStorage.setItem("lka-current-backend-url", configured);
    } catch (ignored) {
    }
    return configured;
  }

  function newToken() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID().replace(/-/g, "");
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function newConversationId() {
    return "conv_" + newToken();
  }

  function safeText(value) {
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  }

  function normalizePendingApproval(rawApproval) {
    if (!rawApproval || typeof rawApproval !== "object") {
      return null;
    }
    var approvalId = safeText(rawApproval.approval_id).trim();
    if (!approvalId) {
      return null;
    }
    return {
      approval_id: approvalId,
      command: safeText(rawApproval.command).trim(),
      cwd: safeText(rawApproval.cwd).trim(),
      risk_level: safeText(rawApproval.risk_level).trim() || "medium",
      reason: safeText(rawApproval.reason).trim(),
      expires_at_ts: Number(rawApproval.expires_at_ts) || 0,
      status: safeText(rawApproval.status).trim() || "pending"
    };
  }

  function truncateText(text, maxLength) {
    var value = safeText(text).trim();
    if (!value) {
      return "";
    }
    if (value.length <= maxLength) {
      return value;
    }
    return value.slice(0, Math.max(0, maxLength - 1)) + "...";
  }


  function normalizeProgressEvents(rawEvents) {
    if (!Array.isArray(rawEvents)) {
      return [];
    }
    return rawEvents
      .filter(function (event) { return event && typeof event === "object" && event.type !== "llm_delta"; })
      .map(function (event) {
        return {
          event_index: Number(event.event_index) || 0,
          type: safeText(event.type).trim(),
          message: safeText(event.message).trim(),
          stage: safeText(event.stage).trim(),
          tool_name: safeText(event.tool_name).trim(),
          package_name: safeText(event.package_name).trim(),
          status: safeText(event.status).trim()
        };
      })
      .filter(function (event) { return !!event.message || !!event.type; })
      .slice(-24);
  }

  function normalizeVerificationWarnings(rawWarnings) {
    if (!Array.isArray(rawWarnings)) {
      return [];
    }
    return rawWarnings
      .filter(function (warning) { return warning && typeof warning === "object"; })
      .map(function (warning) {
        return {
          code: safeText(warning.code).trim(),
          message: safeText(warning.message).trim(),
          severity: safeText(warning.severity).trim() || "warning"
        };
      })
      .filter(function (warning) { return !!warning.code || !!warning.message; })
      .slice(-8);
  }

  function buildAgentRunDetails(result) {
    if (!result || typeof result !== "object") {
      return {};
    }
    return {
      traceId: safeText(result.trace_id).trim(),
      logPath: safeText(result.log_path).trim(),
      selectedPackage: safeText(result.selected_package).trim(),
      progressEvents: normalizeProgressEvents(result.progress_events),
      verificationWarnings: normalizeVerificationWarnings(result.verification_warnings)
    };
  }

  function normalizeConversationId(rawId) {
    var cleaned = safeText(rawId).trim();
    if (cleaned) {
      return cleaned;
    }
    return newConversationId();
  }

  function defaultGreetingMessage() {
    return {
      role: "assistant",
      text: "把任务交给我。可以先从提问、查找资料或整理文件开始。",
      isError: false
    };
  }

  function createSession(seedConversationId) {
    var conversationId = normalizeConversationId(seedConversationId);
    return {
      id: conversationId,
      conversation_id: conversationId,
      title: "新会话",
      title_is_custom: false,
      created_at: Date.now(),
      updated_at: Date.now(),
      workspace: "",
      multiAgentRunId: "",
      multiAgentSequence: 0,
      multiAgentSnapshot: null,
      timelineEvents: [],
      timelineState: "",
      messages: [defaultGreetingMessage()]
    };
  }

  function loadRunCursor(sessionId) {
    try {
      var raw = localStorage.getItem(runCursorKeyPrefix + encodeURIComponent(sessionId));
      var cursor = raw ? JSON.parse(raw) : null;
      return cursor && typeof cursor === "object" ? cursor : {};
    } catch (ignored) {
      return {};
    }
  }

  function saveRunCursor(session) {
    if (!session || !session.id || !session.multiAgentRunId) return;
    try {
      localStorage.setItem(runCursorKeyPrefix + encodeURIComponent(session.id), JSON.stringify({
        run_id: session.multiAgentRunId,
        sequence: session.multiAgentSequence || 0
      }));
    } catch (ignored) {
    }
  }

  function sanitizeMessage(rawMessage) {
    if (!rawMessage || typeof rawMessage !== "object") {
      return null;
    }
    var role = rawMessage.role === "user" ? "user" : "assistant";
    var pendingApproval = normalizePendingApproval(rawMessage.pendingApproval || rawMessage.pending_approval);
    var text = safeText(rawMessage.text || rawMessage.content).trim();
    if (!text && !pendingApproval) {
      return null;
    }
    return {
      role: role,
      text: text,
      isError: !!rawMessage.isError,
      pendingApproval: pendingApproval,
      progressEvents: normalizeProgressEvents(rawMessage.progressEvents || rawMessage.progress_events),
      verificationWarnings: normalizeVerificationWarnings(rawMessage.verificationWarnings || rawMessage.verification_warnings),
      traceId: safeText(rawMessage.traceId || rawMessage.trace_id).trim(),
      logPath: safeText(rawMessage.logPath || rawMessage.log_path).trim(),
      attachments: window.LkaImageComposer.normalize(rawMessage.attachments),
      clientId: safeText(rawMessage.clientId),
      selectedPackage: safeText(rawMessage.selectedPackage || rawMessage.selected_package).trim()
    };
  }

  function sanitizeSession(rawSession) {
    if (!rawSession || typeof rawSession !== "object") {
      return null;
    }

    var conversationId = normalizeConversationId(
      rawSession.conversation_id || rawSession.id || rawSession.session_id
    );
    var runCursor = loadRunCursor(conversationId);
    var savedRunId = safeText(runCursor.run_id).trim();
    var savedSequence = Math.max(0, Number(runCursor.sequence) || 0);
    var messageList = Array.isArray(rawSession.messages) ? rawSession.messages : [];
    var normalizedMessages = messageList
      .map(sanitizeMessage)
      .filter(function (item) { return item !== null; });

    if (!normalizedMessages.length) {
      normalizedMessages = [defaultGreetingMessage()];
    }

    var customTitle = !!rawSession.title_is_custom;
    var normalizedTitle = truncateText(rawSession.title || "", 40);
    // Old default titles are not custom session names.
    if (normalizedTitle === "Chat" || normalizedTitle === "New Chat") {
      normalizedTitle = "";
      customTitle = false;
    }

    var normalizedSession = {
      id: conversationId,
      conversation_id: conversationId,
      title: normalizedTitle,
      title_is_custom: customTitle,
      created_at: Number(rawSession.created_at) || Date.now(),
      updated_at: Number(rawSession.updated_at) || Date.now(),
      workspace: safeText(rawSession.workspace).trim(),
      workspace_is_custom: !!rawSession.workspace_is_custom,
      project_id: safeText(rawSession.project_id).trim(),
      backendWorkspace: safeText(rawSession.backendWorkspace).trim(),
      multiAgentRunId: savedRunId || safeText(rawSession.multiAgentRunId || rawSession.multi_agent_run_id).trim(),
      multiAgentSequence: savedRunId
        ? savedSequence
        : Math.max(0, Number(rawSession.multiAgentSequence || rawSession.multi_agent_sequence) || 0),
      multiAgentSnapshot: null,
      timelineEvents: Array.isArray(rawSession.timelineEvents) ? rawSession.timelineEvents.slice(-100).map(function (item) {
        return { type: safeText(item.type), message: truncateText(item.message, item.type === "safety_review_decided" ? 4000 : 180), at: Number(item.at) || Date.now() };
      }) : [],
      timelineState: safeText(rawSession.timelineState || ""),
      messages: normalizedMessages.slice(-180)
    };
    applySessionTitle(normalizedSession);
    return normalizedSession;
  }

  function dedupeSessions(items) {
    var latestById = {};
    items.forEach(function (item) {
      if (!item || !item.id) {
        return;
      }
      var existing = latestById[item.id];
      if (!existing || Number(item.updated_at) >= Number(existing.updated_at)) {
        latestById[item.id] = item;
      }
    });
    return Object.keys(latestById).map(function (id) {
      return latestById[id];
    });
  }

  function normalizeSessionBounds() {
    sessions = dedupeSessions(
      sessions
        .map(function (session) {
          var normalized = sanitizeSession(session);
          if (!normalized) return null;
          // A pending turn holds this object across progress saves and workspace binding.
          // Keep it live while applying the same cache schema and message limits.
          Object.keys(session).forEach(function (key) {
            if (!Object.prototype.hasOwnProperty.call(normalized, key)) delete session[key];
          });
          Object.assign(session, normalized);
          return session;
        })
        .filter(function (item) { return item !== null && !deletedSessionIds[item.id]; })
    )
      .sort(function (a, b) { return b.updated_at - a.updated_at; });
    var blank = sessions.find(function (session) {
      return session.id === activeSessionId && isReusableEmptySession(session);
    }) || sessions.find(isUnusedLocalSession);
    sessions = sessions.filter(function (session) {
      return !isUnusedLocalSession(session) || session === blank;
    }).slice(0, 24);
  }

  function persistSessions() {
    var snapshotsBySession = {};
    sessions.forEach(function (session) {
      if (session && session.multiAgentSnapshot) snapshotsBySession[session.id] = session.multiAgentSnapshot;
    });
    normalizeSessionBounds();
    sessions.forEach(function (session) {
      if (!session.multiAgentSnapshot && snapshotsBySession[session.id]) {
        session.multiAgentSnapshot = snapshotsBySession[session.id];
      }
    });
    try {
      localStorage.setItem(sessionsKey, JSON.stringify(sessions.map(function (session) {
        var storedSession = Object.assign({}, session);
        delete storedSession.multiAgentSnapshot;
        delete storedSession.multiAgentSnapshotRequest;
        return storedSession;
      })));
      localStorage.setItem(activeSessionKey, activeSessionId);
    } catch (ignored) {
    }
  }

  function draftStorageKey(sessionId) {
    return draftKeyPrefix + encodeURIComponent(sessionId);
  }

  function readDraft(sessionId) {
    if (!sessionId) return "";
    try { return localStorage.getItem(draftStorageKey(sessionId)) || ""; }
    catch (ignored) { return ""; }
  }

  function writeDraft(sessionId, value) {
    if (!sessionId) return;
    try {
      if (value) localStorage.setItem(draftStorageKey(sessionId), value);
      else localStorage.removeItem(draftStorageKey(sessionId));
    } catch (ignored) {}
  }

  function saveCurrentDraft() {
    var session = getActiveSession();
    if (session && !document.body.classList.contains("native-composer")) {
      writeDraft(session.id, input.value);
    }
  }

  function showDraftForSession(session) {
    var draft = session ? readDraft(session.id) : "";
    input.value = draft;
    window.LkaImageComposer.refresh();
    if (window.petBridge && typeof window.petBridge.setComposerDraft === "function") {
      window.petBridge.setComposerDraft(draft);
    }
  }

  window.__petChatNativeDraftChanged = function (draft) {
    var session = getActiveSession();
    if (session) writeDraft(session.id, safeText(draft));
  };

  function loadDeletedSessionIds() {
    deletedSessionIds = Object.create(null);
    try {
      var parsed = JSON.parse(localStorage.getItem(deletedSessionsKey) || "[]");
      if (Array.isArray(parsed)) parsed.forEach(function (id) {
        if (typeof id === "string" && id) deletedSessionIds[id] = true;
      });
    } catch (ignored) {}
  }

  function rememberDeletedSessionId(sessionId) {
    deletedSessionIds[sessionId] = true;
    deletedThisPage[sessionId] = Date.now();
    try {
      localStorage.setItem(deletedSessionsKey, JSON.stringify(Object.keys(deletedSessionIds).slice(-100)));
    } catch (ignored) {}
  }

  function loadDeletedSessionSnapshots() {
    deletedSessionSnapshots = [];
    try {
      var parsed = JSON.parse(localStorage.getItem(deletedSnapshotsKey) || "[]");
      if (Array.isArray(parsed)) deletedSessionSnapshots = parsed.map(function (item) {
        var restored = sanitizeSession(item);
        if (!restored) return null;
        restored.title = safeText(item.title).trim() || restored.title;
        restored.deleted_at = Number(item.deleted_at) || Date.now();
        restored.local_only = !!item.local_only;
        return restored;
      }).filter(function (item) { return item !== null; });
    } catch (ignored) {}
  }

  function persistDeletedSessionSnapshots() {
    try { localStorage.setItem(deletedSnapshotsKey, JSON.stringify(deletedSessionSnapshots.slice(0, 24))); }
    catch (ignored) {}
  }

  function rememberDeletedSessionSnapshot(session, localOnly) {
    var snapshot = Object.assign({}, session, {
      deleted_at: Date.now(),
      local_only: !!localOnly,
      messages: localOnly ? session.messages : [defaultGreetingMessage()]
    });
    delete snapshot.multiAgentSnapshot;
    deletedSessionSnapshots = deletedSessionSnapshots.filter(function (item) { return item.id !== session.id; });
    deletedSessionSnapshots.unshift(snapshot);
    deletedSessionSnapshots = deletedSessionSnapshots.slice(0, 24);
    persistDeletedSessionSnapshots();
  }

  function forgetDeletedSessionId(sessionId) {
    delete deletedSessionIds[sessionId];
    delete deletedThisPage[sessionId];
    deletedSessionSnapshots = deletedSessionSnapshots.filter(function (item) { return item.id !== sessionId; });
    backendDeletedSessions = backendDeletedSessions.filter(function (item) { return item.id !== sessionId; });
    try { localStorage.setItem(deletedSessionsKey, JSON.stringify(Object.keys(deletedSessionIds))); }
    catch (ignored) {}
    persistDeletedSessionSnapshots();
  }

  function getSessionById(sessionId) {
    var targetId = safeText(sessionId).trim();
    for (var i = 0; i < sessions.length; i += 1) {
      if (sessions[i].id === targetId) {
        return sessions[i];
      }
    }
    return null;
  }

  function getOrCreateSessionById(sessionId) {
    var normalizedId = normalizeConversationId(sessionId);
    var existing = getSessionById(normalizedId);
    if (existing) {
      return existing;
    }
    var created = createSession(normalizedId);
    sessions.unshift(created);
    return created;
  }

  function getActiveSession() {
    return getSessionById(activeSessionId);
  }

  function touchSession(session) {
    if (!session) {
      return;
    }
    session.updated_at = Date.now();
  }

  function pinSessionToTop(sessionId) {
    var index = -1;
    for (var i = 0; i < sessions.length; i += 1) {
      if (sessions[i].id === sessionId) {
        index = i;
        break;
      }
    }
    if (index <= 0) {
      return;
    }
    var picked = sessions.splice(index, 1)[0];
    sessions.unshift(picked);
  }

  function deriveAutoSessionTitle(session) {
    if (!session) {
      return "新会话";
    }
    var firstUser = null;
    for (var i = 0; i < session.messages.length; i += 1) {
      if (session.messages[i].role === "user" && safeText(session.messages[i].text).trim()) {
        firstUser = session.messages[i].text;
        break;
      }
    }
    return firstUser ? truncateText(firstUser, 20) : "新会话";
  }

  function applySessionTitle(session) {
    if (!session) {
      return;
    }
    var normalizedCustomTitle = truncateText(session.title, 40);
    var customEnabled = !!session.title_is_custom && !!normalizedCustomTitle;
    if (customEnabled) {
      session.title = normalizedCustomTitle;
      session.title_is_custom = true;
      return;
    }
    session.title_is_custom = false;
    session.title = deriveAutoSessionTitle(session);
    if (/^\[(Image|File) input\]$/.test(session.title)) session.title = session.title === "[File input]" ? "文件任务" : "图片任务";
  }

  function getSessionMessageCount(session) {
    if (!session || !Array.isArray(session.messages)) {
      return 0;
    }
    var count = 0;
    for (var i = 0; i < session.messages.length; i += 1) {
      if (safeText(session.messages[i].text).trim()) {
        count += 1;
      }
    }
    if (session.messages.length && session.messages[0].role === "assistant" &&
        session.messages[0].text === defaultGreetingMessage().text) {
      count -= 1;
    }
    return Math.max(0, count);
  }

  function isAutomaticSessionWorkspace(session) {
    var path = safeText(session && session.workspace).replace(/\\/g, "/").replace(/\/+$/, "");
    if (!path) return true;
    var folder = path.split("/").pop();
    return folder === session.id || /^conv_[a-z0-9]+$/.test(folder) || /^session-[0-9a-f]{64}$/.test(folder);
  }

  function isReusableEmptySession(session) {
    return !!session && !session.summary_only && !session.title_is_custom
      && !session.workspace_is_custom && isAutomaticSessionWorkspace(session)
      && !readDraft(session.id) && !window.LkaImageComposer.hasDraft(session.id) && !session.multiAgentRunId && !session.timelineState
      && !(session.timelineEvents && session.timelineEvents.length)
      && !(session.messages || []).some(function (message) { return !!message.pendingApproval; })
      && getSessionMessageCount(session) === 0
      && !(pendingState && pendingState.conversationId === session.id);
  }

  function isUnusedLocalSession(session) {
    return isReusableEmptySession(session) && session.id.indexOf("conv_") === 0
      && !session.backendWorkspace && !session.project_id;
  }

  function ensureActiveSession() {
    var active = getActiveSession();
    if (active) {
      return active;
    }
    if (sessions.length) {
      activeSessionId = sessions[0].id;
      return sessions[0];
    }
    var created = createSession("");
    sessions.unshift(created);
    activeSessionId = created.id;
    return created;
  }

  function loadSessions(preserveActiveSelection) {
    var loadedSessions = [];
    var loadedActiveId = "";
    var previousActive = preserveActiveSelection ? getActiveSession() : null;

    try {
      var rawSessions = localStorage.getItem(sessionsKey);
      if (!rawSessions) {
        rawSessions = localStorage.getItem(previousSessionsKey);
      }
      if (!rawSessions) {
        rawSessions = localStorage.getItem(legacySessionsKey);
      }
      if (rawSessions) {
        var parsed = JSON.parse(rawSessions);
        if (Array.isArray(parsed)) {
          loadedSessions = parsed;
        }
      }
      loadedActiveId = localStorage.getItem(activeSessionKey)
        || localStorage.getItem(previousActiveSessionKey)
        || "";
    } catch (ignored) {
      loadedSessions = [];
      loadedActiveId = "";
    }

    sessions = loadedSessions
      .map(sanitizeSession)
      .filter(function (item) { return item !== null; });

    if (previousActive && !deletedSessionIds[previousActive.id]
        && !sessions.some(function (item) { return item.id === previousActive.id; })) {
      sessions.unshift(previousActive);
    }

    activeSessionId = preserveActiveSelection && previousActive
      ? previousActive.id : safeText(loadedActiveId).trim();
    normalizeSessionBounds();
    activeSessionId = preserveActiveSelection && previousActive && getSessionById(previousActive.id)
      ? previousActive.id : safeText(loadedActiveId || (sessions[0] && sessions[0].id)).trim();
    if (preserveActiveSelection) ensureActiveSession();
  }

  function timestampToMillis(rawValue) {
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      return rawValue;
    }
    var parsed = Date.parse(safeText(rawValue));
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function normalizeBackendRole(rawRole) {
    return rawRole === "user" ? "user" : "assistant";
  }

  function sessionFromBackendDetail(detail) {
    if (!detail || typeof detail !== "object" || !detail.session) {
      return null;
    }
    var rawSession = detail.session;
    var sessionId = safeText(rawSession.session_id).trim();
    if (!sessionId) {
      return null;
    }
    var rawMessages = Array.isArray(detail.messages) ? detail.messages : [];
    var normalizedMessages = rawMessages
      .map(function (entry) {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        var text = safeText(entry.content).trim();
        if (!text) {
          return null;
        }
        var details = entry.payload && typeof entry.payload === "object"
          ? buildAgentRunDetails(entry.payload)
          : {};
        return {
          role: normalizeBackendRole(entry.role),
          text: text,
          isError: false,
          progressEvents: details.progressEvents || [],
          verificationWarnings: details.verificationWarnings || [],
          traceId: details.traceId || "",
          logPath: details.logPath || "",
          attachments: window.LkaImageComposer.fromIds(entry.payload && entry.payload.attachment_ids),
          selectedPackage: details.selectedPackage || ""
        };
      })
      .filter(function (item) { return item !== null; });

    return sanitizeSession({
      id: sessionId,
      conversation_id: sessionId,
      title: safeText(rawSession.title).trim() || "新会话",
      title_is_custom: !!(rawSession.metadata && rawSession.metadata.title_is_custom),
      created_at: timestampToMillis(rawSession.created_at),
      updated_at: timestampToMillis(rawSession.updated_at),
      workspace: rawSession.workspace && rawSession.workspace.path || "",
      project_id: rawSession.project_id || "",
      backendWorkspace: rawSession.workspace && rawSession.workspace.path || "",
      workspace_is_custom: !!(rawSession.metadata && (rawSession.metadata.explicit_workspace || rawSession.metadata.project_session || rawSession.metadata.workspace_is_custom)),
      messages: normalizedMessages.length ? normalizedMessages : [defaultGreetingMessage()]
    });
  }

  function mergeBackendSession(remoteSession) {
    if (!remoteSession || !remoteSession.id) {
      return;
    }
    var existing = getSessionById(remoteSession.id);
    if (!existing) {
      sessions.push(remoteSession);
      return;
    }

    var existingMessages = Array.isArray(existing.messages) ? existing.messages : [];
    var remoteMessages = Array.isArray(remoteSession.messages) ? remoteSession.messages : [];
    // A sync started before the user sent a turn must not replace its local messages.
    if (!(pendingState && pendingState.conversationId === existing.id)
        && (remoteMessages.length >= existingMessages.length || existingMessages.length <= 1)) {
      existing.messages = remoteMessages;
    }
    if (renamingSessionId !== existing.id && remoteSession.title && remoteSession.title_is_custom) {
      existing.title = remoteSession.title;
      existing.title_is_custom = true;
    } else if (!existing.title_is_custom && remoteSession.title && remoteSession.title !== "New Chat" && remoteSession.title !== "新会话") {
      existing.title = remoteSession.title;
    }
    existing.workspace_is_custom = existing.workspace_is_custom || remoteSession.workspace_is_custom;
    existing.updated_at = Math.max(Number(existing.updated_at) || 0, Number(remoteSession.updated_at) || 0);
    if (!pendingState && (!existing.backendWorkspace || existing.workspace === existing.backendWorkspace)) {
      existing.workspace = remoteSession.workspace;
      existing.backendWorkspace = remoteSession.backendWorkspace;
      existing.project_id = remoteSession.project_id;
    }
    applySessionTitle(existing);
  }

  async function reconcileMissingSessions(backendSessions) {
    var listedIds = Object.create(null);
    backendSessions.forEach(function (item) { if (item) listedIds[item.session_id] = true; });
    saveCurrentDraft();
    function eligible(session) {
      return session && !listedIds[session.id] && getSessionMessageCount(session) > 0
        && !(pendingState && pendingState.conversationId === session.id)
        && !deletingSessionIds[session.id] && renamingSessionId !== session.id
        && !readDraft(session.id).trim();
    }
    function revision(session) {
      return JSON.stringify([session.updated_at, session.title, session.workspace, session.messages]);
    }
    var candidates = sessions.filter(eligible).map(function (session) {
      return { id: session.id, revision: revision(session) };
    });
    var missingIds = Object.create(null);
    // The list is paginated: absence alone never means the session was deleted.
    for (var i = 0; i < candidates.length; i += 4) {
      await Promise.all(candidates.slice(i, i + 4).map(async function (candidate) {
        try {
          var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(candidate.id), {
            headers: { Accept: "application/json" }
          });
          var current = getSessionById(candidate.id);
          if (response.status === 404 && eligible(current) && revision(current) === candidate.revision) {
            missingIds[candidate.id] = true;
          }
        } catch (ignored) {} // Keep cached history while offline or on a transient failure.
      }));
    }
    // Recheck after all requests: a user may have started typing or sending meanwhile.
    saveCurrentDraft();
    sessions = sessions.filter(function (session) {
      var candidate = candidates.find(function (item) { return item.id === session.id; });
      if (!missingIds[session.id] || !eligible(session) || !candidate
          || revision(session) !== candidate.revision) {
        delete missingIds[session.id];
        return true;
      }
      try { localStorage.removeItem(runCursorKeyPrefix + encodeURIComponent(session.id)); } catch (ignored) {}
      return false;
    });
    historyItems = historyItems.filter(function (item) { return !missingIds[item.id]; });
  }

  async function supportsEmptySessionCleanup() {
    if (!emptyCleanupCapability) emptyCleanupCapability = fetch(backendBaseUrl + "/openapi.json")
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (schema) {
        var route = schema && schema.paths && schema.paths["/sessions/{session_id}"];
        return !!(route && route.delete && (route.delete.parameters || []).some(function (parameter) {
          return parameter.name === "only_if_empty";
        }));
      }).catch(function () { emptyCleanupCapability = null; return false; });
    return emptyCleanupCapability;
  }

  function emptyCleanupStillSafe(session) {
    if (!isReusableEmptySession(session) || session.id === activeSessionId
        || renamingSessionId === session.id || deletingSessionIds[session.id]) return false;
    try {
      var stored = JSON.parse(localStorage.getItem(sessionsKey) || "[]");
      var latest = stored.find(function (item) { return item.id === session.id; });
      if (latest && !isReusableEmptySession(latest)) return false;
    } catch (ignored) { return false; }
    return true;
  }

  async function cleanupEmptyBackendSessions(details) {
    var candidates = details.filter(function (detail) {
      var raw = detail.session;
      var local = raw && getSessionById(raw.session_id);
      return raw && raw.metadata && raw.metadata.source_frontend === "windows-pet"
        && Array.isArray(detail.messages) && !detail.messages.length
        && raw.updated_at && emptyCleanupStillSafe(local);
    });
    if (!candidates.length || !await supportsEmptySessionCleanup()) return;
    for (var i = 0; i < candidates.length; i += 1) {
      var detail = candidates[i], id = detail.session.session_id;
      var session = getSessionById(id);
      if (!emptyCleanupStillSafe(session)) continue;
      try {
        if (session.workspace) {
          var filesResponse = await fetch(fileApiUrl(id, "files", ""));
          if (!filesResponse.ok) continue;
          var files = await filesResponse.json();
          if (!Array.isArray(files.entries) || files.entries.length || files.truncated) continue;
        }
        if (!emptyCleanupStillSafe(getSessionById(id))) continue;
        var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(id)
          + "?only_if_empty=true&expected_updated_at=" + encodeURIComponent(detail.session.updated_at), {
          method: "DELETE"
        });
        if (!response.ok) continue;
        // A draft or selection can appear while the guarded request is in flight.
        if (!emptyCleanupStillSafe(getSessionById(id))) {
          await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(id) + "/restore", { method: "POST" });
          continue;
        }
        rememberDeletedSessionSnapshot(session, false);
        rememberDeletedSessionId(id);
        sessions = sessions.filter(function (item) { return item.id !== id; });
        historyItems = historyItems.filter(function (item) { return item.id !== id; });
      } catch (ignored) {} // Keep history when validation or the backend is unavailable.
    }
  }

  async function syncSessionsFromBackend() {
    if (sessionSyncPromise) return sessionSyncPromise;
    sessionSyncPromise = (async function () {
    try {
      await refreshDeletedSessions();
      var listResponse = await fetch(backendBaseUrl + "/sessions?limit=50", {
        method: "GET",
        headers: { "Accept": "application/json" }
      });
      if (!listResponse.ok) throw new Error("HTTP " + listResponse.status);
      var listPayload = await listResponse.json();
      var backendSessions = Array.isArray(listPayload.sessions) ? listPayload.sessions : [];
      var needDetails = backendSessions.filter(function (summary) {
        var id = safeText(summary && summary.session_id).trim();
        if (!id || deletingSessionIds[id]
            || (deletedThisPage[id] && Date.now() - deletedThisPage[id] < 3000)) return false;
        var local = getSessionById(id);
        return !local || local.summary_only || id === activeSessionId
          || isReusableEmptySession(local)
          || timestampToMillis(summary.updated_at) > Number(local.updated_at || 0) + 100;
      });
      var details = [];
      for (var i = 0; i < needDetails.length; i += 4) {
        var batch = await Promise.all(needDetails.slice(i, i + 4).map(async function (summary) {
          try {
            var detailResponse = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(summary.session_id), {
              method: "GET", headers: { "Accept": "application/json" }
            });
            return detailResponse.ok ? await detailResponse.json() : null;
          } catch (ignoredDetail) { return null; }
        }));
        details = details.concat(batch.filter(function (item) { return item !== null; }));
      }

      var remoteSessions = details
        .map(sessionFromBackendDetail)
        .filter(function (item) { return item !== null; });
      var activeBefore = getActiveSession();
      var activeBeforeState = activeBefore ? JSON.stringify({
        id: activeBefore.id, title: activeBefore.title, workspace: activeBefore.workspace, messages: activeBefore.messages
      }) : "";
      await reconcileMissingSessions(backendSessions);
      var backendDeletedIds = Object.create(null);
      backendDeletedSessions.forEach(function (item) { backendDeletedIds[item.id] = true; });
      remoteSessions.forEach(function (item) {
        if (deletedSessionIds[item.id] && (!deletedThisPage[item.id]
            || Date.now() - deletedThisPage[item.id] >= 3000)
            && !deletingSessionIds[item.id] && !backendDeletedIds[item.id]) {
          forgetDeletedSessionId(item.id);
        }
      });
      remoteSessions = remoteSessions.filter(function (session) {
        return !deletedSessionIds[session.id] && !deletingSessionIds[session.id];
      });
      remoteSessions.forEach(mergeBackendSession);
      await cleanupEmptyBackendSessions(details);
      normalizeSessionBounds();

      if (!getActiveSession()) {
        activeAgentTurnGeneration += 1;
        abortActiveAgentEventStream();
        ensureActiveSession();
        showDraftForSession(getActiveSession());
        fileRelativePath = "";
        prepareSessionWorkspace(getActiveSession());
        refreshActiveMultiAgentSnapshot();
        reconnectActiveSavedRun();
        loadFileList();
      }
      renderSessionList();
      var activeAfter = getActiveSession();
      var activeAfterState = activeAfter ? JSON.stringify({
        id: activeAfter.id, title: activeAfter.title, workspace: activeAfter.workspace, messages: activeAfter.messages
      }) : "";
      if (activeBeforeState !== activeAfterState) {
        renderActiveMessages();
        renderWorkspaceSummary(activeAfter);
      }
      persistSessions();
    } catch (error) {
      historyError = "历史会话加载失败：" + safeText(error.message || error);
      renderSessionList();
    }
    })();
    try { return await sessionSyncPromise; }
    finally { sessionSyncPromise = null; }
  }

  function sessionSummaryFromBackend(raw) {
    if (!raw || !raw.session_id) return null;
    return {
      id: safeText(raw.session_id), conversation_id: safeText(raw.session_id),
      title: safeText(raw.title).trim() || "新会话", title_is_custom: true,
      updated_at: timestampToMillis(raw.updated_at), created_at: timestampToMillis(raw.created_at),
      workspace: raw.workspace && raw.workspace.path || "", messages: [defaultGreetingMessage()],
      project_id: raw.project_id || "",
      summary_only: true
    };
  }

  async function loadHistoryPage(reset) {
    if (!reset && (historyLoading || !historyHasMore)) return;
    var generation = reset ? ++historyRequestGeneration : historyRequestGeneration;
    var deletedView = viewingDeletedSessions;
    var query = sessionSearchInput ? sessionSearchInput.value.trim() : "";
    if (reset) {
      historyOffset = 0;
      historyHasMore = true;
      historyError = "";
      lastKnownSearch = query;
      if (deletedView) deletedHistoryItems = [];
      else historyItems = [];
    }
    historyLoading = true;
    renderSessionList();
    try {
      var url = backendBaseUrl + (deletedView ? "/sessions/deleted" : "/sessions")
        + "?limit=30&offset=" + historyOffset + (query ? "&q=" + encodeURIComponent(query) : "");
      var response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var payload = await response.json();
      if (generation !== historyRequestGeneration || deletedView !== viewingDeletedSessions) return;
      var page = (Array.isArray(payload.sessions) ? payload.sessions : [])
        .map(sessionSummaryFromBackend).filter(function (item) { return item !== null; });
      if (deletedView) deletedHistoryItems = deletedHistoryItems.concat(page);
      else historyItems = historyItems.concat(page);
      historyOffset += page.length;
      historyHasMore = page.length === 30;
      historyError = "";
    } catch (error) {
      if (generation === historyRequestGeneration) historyError = "加载失败：" + safeText(error.message || error);
    } finally {
      if (generation === historyRequestGeneration) {
        historyLoading = false;
        renderSessionList();
      }
    }
  }

  function formatTimestamp(timestamp) {
    var value = Number(timestamp) || Date.now();
    var date = new Date(value);
    var hours = String(date.getHours()).padStart(2, "0");
    var minutes = String(date.getMinutes()).padStart(2, "0");
    return hours + ":" + minutes;
  }

  function sidebarDocked() { return desktopPanels && window.innerWidth > 700; }
  function railDocked() { return desktopPanels && window.innerWidth > 1180; }
  function panelOpen(side) {
    if (side === "sidebar") return sidebarDocked() ? panelVisibility.sidebar : chatShell.classList.contains("sidebar-open");
    return railDocked() ? panelVisibility.rail : chatShell.classList.contains("settings-open");
  }
  function syncWorkbenchPanels() {
    if (!desktopPanels || !chatShell) return;
    var topbar = document.querySelector(".chat-topbar");
    if (topbar) document.body.style.setProperty("--workbench-header-height", Math.ceil(topbar.getBoundingClientRect().height) + "px");
    document.body.classList.toggle("work-sidebar-hidden", !panelVisibility.sidebar);
    document.body.classList.toggle("work-rail-hidden", !panelVisibility.rail);
    [["sidebar", toggleSidebarButton, "sessionSidebar", "会话列表"], ["rail", toggleSettingsButton, "contextRail", "工作区与设置"]].forEach(function (item) {
      var open = panelOpen(item[0]), button = item[1], panel = document.getElementById(item[2]);
      var docked = item[0] === "sidebar" ? sidebarDocked() : railDocked();
      if (button) {
        var label = (open ? (docked ? "收起" : "关闭") : "展开") + item[3];
        button.setAttribute("aria-expanded", String(open));
        button.setAttribute("aria-label", label); button.title = label;
      }
      if (panel) {
        if (!open && panel.contains(document.activeElement) && button) button.focus({ preventScroll: true });
        panel.inert = !open;
      }
    });
  }
  function setWorkbenchPanelVisible(side, open) {
    panelVisibility[side] = !!open;
    if (open) setPanelSize(side, panelSize(side));
    try { localStorage.setItem(panelVisibilityKey, JSON.stringify(panelVisibility)); } catch (ignored) {}
    syncWorkbenchPanels();
  }

  function setSidebarOpen(isOpen) {
    // Session selection closes a drawer; it should not collapse a docked list.
    if (sidebarDocked()) {
      if (isOpen) setWorkbenchPanelVisible("sidebar", true);
      return;
    }
    if (!chatShell) {
      return;
    }
    if (isOpen) {
      chatShell.classList.add("sidebar-open");
      if (sidebarBackdrop) {
        sidebarBackdrop.hidden = false;
      }
    } else {
      chatShell.classList.remove("sidebar-open");
      if (sidebarBackdrop) {
        sidebarBackdrop.hidden = true;
      }
    }
    syncWorkbenchPanels();
  }

  function setBackendOfflineState(isOffline, reasonText) {
    backendOffline = !!isOffline;
    if (backendOfflinePanel) {
      backendOfflinePanel.hidden = !backendOffline;
    }
    if (backendOfflineReason && backendOffline) {
      backendOfflineReason.textContent = safeText(reasonText).trim() || "当前无法连接后端服务。";
    }
    if (chatShell) {
      if (backendOffline) {
        chatShell.classList.add("backend-offline-visible");
      } else {
        chatShell.classList.remove("backend-offline-visible");
      }
    }
    if (backendOffline) {
      setComposerDisabled(true);
    } else if (!pendingState) {
      setComposerDisabled(false);
    }
  }

  function isBackendOfflineError(errorText) {
    var value = safeText(errorText).toLowerCase();
    if (!value) {
      return false;
    }
    return value.indexOf("connectexception") >= 0
      || value.indexOf("connection refused") >= 0
      || value.indexOf("failed to connect") >= 0
      || value.indexOf("forcibly closed") >= 0
      || value.indexOf("timed out") >= 0
      || value.indexOf("failed to fetch") >= 0
      || value.indexOf("load failed") >= 0
      || value.indexOf("desktop bridge is not ready") >= 0;
  }

  function parseBridgeResult(rawResult) {
    if (rawResult && typeof rawResult === "object") {
      return rawResult;
    }
    if (typeof rawResult !== "string") {
      return {};
    }
    try {
      return JSON.parse(rawResult);
    } catch (ignored) {
      return { ok: false, message: rawResult };
    }
  }

  function requestBackendStartFromBridge() {
    if (!window.petBridge || typeof window.petBridge.startBackendService !== "function") {
      setBackendOfflineState(true, "桌面桥接不可用，无法启动后端服务。");
      return;
    }
    var result = {};
    try {
      result = parseBridgeResult(window.petBridge.startBackendService());
    } catch (error) {
      setBackendOfflineState(true, "启动后端失败：" + safeText(error && error.message ? error.message : error));
      return;
    }
    var ok = !(result.ok === false || result.ok === "false");
    if (!ok) {
      setBackendOfflineState(true, safeText(result.message) || "后端启动失败。");
      return;
    }
    setBackendOfflineState(true, safeText(result.message) || "后端启动命令已发送，正在重试连接...");
    setTimeout(function () {
      window.location.reload();
    }, 1200);
  }

  function createMessageElement(role, text, isError, pendingApproval, sessionId, details) {
    var article = document.createElement("article");
    article.className = "message " + role + (isError ? " error" : "");

    var bubble = document.createElement("div");
    bubble.className = "bubble";

    var label = document.createElement("strong");
    label.textContent = role === "user" ? "你" : "真理";

    bubble.appendChild(label);
    var richAnswer = role === "assistant" && !isError;
    var body = document.createElement(richAnswer ? "div" : "p");
    body.className = "message-content" + (richAnswer ? " markdown-body" : "");
    if (richAnswer) window.PetMarkdown.render(body, text);
    else body.textContent = text;
    if (safeText(text).trim()) {
      bubble.appendChild(body);
    }
    if (role === "user") window.LkaImageComposer.renderHistory(bubble, details && details.attachments, sessionId);
    if (role === "assistant") {
      appendAgentRunDetails(bubble, details || {});
    }
    if (role === "assistant" && pendingApproval && pendingApproval.status === "pending") {
      var approvalBox = document.createElement("div");
      approvalBox.className = "approval-box";

      var approvalMeta = document.createElement("p");
      approvalMeta.className = "approval-meta";
      approvalMeta.textContent =
        "需要确认此操作 · 风险：" + pendingApproval.risk_level + " · 编号：" + pendingApproval.approval_id;
      approvalBox.appendChild(approvalMeta);

      if (pendingApproval.command) {
        var approvalCommand = document.createElement("pre");
        approvalCommand.className = "approval-command";
        approvalCommand.textContent = pendingApproval.command;
        approvalBox.appendChild(approvalCommand);
      }

      var actions = document.createElement("div");
      actions.className = "approval-actions";

      var approveButton = document.createElement("button");
      approveButton.type = "button";
      approveButton.className = "approval-button approve";
      approveButton.textContent = "Approve";

      var rejectButton = document.createElement("button");
      rejectButton.type = "button";
      rejectButton.className = "approval-button reject";
      rejectButton.textContent = "Reject";

      approveButton.addEventListener("click", function () {
        handleApprovalAction(sessionId, pendingApproval, "approve", approveButton, rejectButton);
      });
      rejectButton.addEventListener("click", function () {
        handleApprovalAction(sessionId, pendingApproval, "reject", approveButton, rejectButton);
      });

      actions.appendChild(approveButton);
      actions.appendChild(rejectButton);
      approvalBox.appendChild(actions);
      bubble.appendChild(approvalBox);
    }
    article.appendChild(bubble);
    return { article: article, body: body };
  }

  function appendAgentRunDetails(bubble, details) {
    if (!bubble || !details) {
      return;
    }
    var progressEvents = normalizeProgressEvents(details.progressEvents || details.progress_events);
    var warnings = normalizeVerificationWarnings(details.verificationWarnings || details.verification_warnings);
    var traceId = safeText(details.traceId || details.trace_id).trim();
    var logPath = safeText(details.logPath || details.log_path).trim();
    var selectedPackage = safeText(details.selectedPackage || details.selected_package).trim();
    var initialPackage = safeText(details.initialPackage || details.initial_package).trim();
    var usedPackages = Array.isArray(details.usedPackages || details.used_packages) ? (details.usedPackages || details.used_packages).join(", ") : "";
    if (!progressEvents.length && !warnings.length && !traceId && !logPath && !selectedPackage && !initialPackage && !usedPackages) {
      return;
    }

    var box = document.createElement("details");
    box.className = "agent-run-details";
    var summary = document.createElement("summary");
    summary.textContent = "运行过程";
    box.appendChild(summary);

    if (traceId || selectedPackage || logPath) {
      var meta = document.createElement("p");
      meta.className = "agent-run-meta";
      var parts = [];
      if (initialPackage || selectedPackage) parts.push("起始包=" + (initialPackage || selectedPackage));
      if (usedPackages) parts.push("已用=" + usedPackages);
      if (traceId) {
        parts.push("trace=" + traceId);
      }
      if (logPath) {
        parts.push("log=" + logPath);
      }
      meta.textContent = parts.join(" | ");
      box.appendChild(meta);
    }

    if (progressEvents.length) {
      var list = document.createElement("ol");
      list.className = "agent-progress-list";
      progressEvents.forEach(function (event) {
        var item = document.createElement("li");
        var prefix = event.type ? "[" + event.type + "] " : "";
        item.textContent = prefix + (event.message || event.status || "completed");
        list.appendChild(item);
      });
      box.appendChild(list);
    }

    if (warnings.length) {
      var warningList = document.createElement("ul");
      warningList.className = "agent-warning-list";
      warnings.forEach(function (warning) {
        var item = document.createElement("li");
        item.textContent = (warning.code ? warning.code + ": " : "") + (warning.message || warning.severity);
        warningList.appendChild(item);
      });
      box.appendChild(warningList);
    }

    bubble.appendChild(box);
  }

  function scrollMessagesToBottom() {
    if (!workMode && typeof window.__petQuickScrollToLatest === "function") { window.__petQuickScrollToLatest(); return; }
    messages.scrollTop = messages.scrollHeight;
  }

  function appendMessageToDom(role, text, isError, pendingApproval, sessionId, details) {
    var welcome = messages.querySelector(".welcome");
    if (welcome) welcome.remove();
    var created = createMessageElement(role, text, isError, pendingApproval, sessionId, details);
    if (role === "user") {
      var rememberButton = document.createElement("button");
      rememberButton.type = "button";
      rememberButton.className = "memory-message-action";
      rememberButton.textContent = "记住这条";
      rememberButton.addEventListener("click", function () {
        var selection = window.getSelection();
        var chosen = selection && created.article.contains(selection.anchorNode) ? selection.toString().trim() : "";
        if (window.LkaMemory) window.LkaMemory.remember(chosen || text);
      });
      created.article.appendChild(rememberButton);
    }
    messages.appendChild(created.article);
    scrollMessagesToBottom();
    return created.body;
  }

  function renderActiveSessionMeta() {
    var session = getActiveSession();
    if (continueWorkbenchButton) continueWorkbenchButton.disabled = workbenchOpening || !session || getSessionMessageCount(session) === 0;
    if (!session) {
      if (activeSessionTitle) {
        activeSessionTitle.textContent = "新会话";
      }
      if (activeSessionSubtitle) {
        activeSessionSubtitle.textContent = "尚无会话";
      }
      return;
    }
    applySessionTitle(session);
    if (activeSessionTitle) {
      activeSessionTitle.textContent = !workMode && session.project_name && !getSessionMessageCount(session) ? session.project_name + " · 新任务" : session.title || "新会话";
    }
    if (activeSessionSubtitle) {
      activeSessionSubtitle.textContent =
        "更新于 " + formatTimestamp(session.updated_at) + " · " + getSessionMessageCount(session) + " 条消息";
    }
  }

  function renderWorkspaceSummary(session) {
    var path = session && safeText(session.workspace).trim();
    if (workspaceInput) workspaceInput.value = path || "";
    if (workspaceSummary) {
      var parts = path ? path.replace(/[\\/]+$/, "").split(/[\\/]/) : [];
      var folderName = parts.pop() || "";
      var isDefaultFolder = folderName === (session && session.id) ||
        (/^session-[0-9a-f]{64}$/.test(folderName) && parts.slice(-2).join("/") === "Local Knowledge Agent/Workspaces");
      workspaceSummary.textContent = !path ? "正在准备独立工作区…" : isDefaultFolder ? "默认任务工作区" : folderName;
      workspaceSummary.title = path || "尚未设置工作区";
    }
    var projectButton = document.querySelector("#newProjectSessionButton");
    if (projectButton) projectButton.disabled = !path || !!pendingState;
    window.dispatchEvent(new CustomEvent("lka-session-context", { detail: {
      sessionId: session ? session.id : "", workspace: path || ""
    } }));
  }

  function setRailTab(tab) {
    activeRailTab = tab === "files" && workMode ? "files" : "settings";
    if (filesPanel) filesPanel.hidden = activeRailTab !== "files";
    if (settingsPanel) settingsPanel.hidden = activeRailTab !== "settings";
    if (filesTabButton) filesTabButton.setAttribute("aria-selected", activeRailTab === "files" ? "true" : "false");
    if (settingsTabButton) settingsTabButton.setAttribute("aria-selected", activeRailTab === "settings" ? "true" : "false");
    if (activeRailTab === "files") loadFileList();
  }

  function fileApiUrl(sessionId, kind, path) {
    return backendBaseUrl + "/sessions/" + encodeURIComponent(sessionId) + "/" + kind
      + "?path=" + encodeURIComponent(path || "");
  }

  function showFilePanelMessage(text, action) {
    if (!fileList) return;
    fileList.textContent = "";
    var message = document.createElement("p");
    message.className = "file-panel-message";
    message.textContent = text;
    fileList.appendChild(message);
    if (action) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "file-panel-action";
      button.textContent = "载入当前工作区";
      button.addEventListener("click", async function () {
        var session = getActiveSession();
        if (!session) return;
        button.disabled = true;
        try {
          await ensureSessionWorkspace(session);
          await bindSessionWorkspace(session);
          await loadFileList();
        } catch (error) {
          showFilePanelMessage("工作区载入失败：" + safeText(error.message || error), true);
        }
      });
      fileList.appendChild(button);
    }
  }

  async function loadFileList() {
    if (!workMode || !fileList || activeRailTab !== "files") return;
    var session = getActiveSession();
    var generation = ++fileRequestGeneration;
    selectedFilePath = "";
    window.dispatchEvent(new CustomEvent("lka-workspace-files", { detail: { sessionId: session ? session.id : "", workspace: session ? session.workspace || "" : "", path: fileRelativePath } }));
    if (filePreview) filePreview.textContent = "选择文件后在这里预览。";
    if (fileCurrentPath) fileCurrentPath.textContent = fileRelativePath || "当前工作区";
    if (fileUpButton) fileUpButton.disabled = !fileRelativePath;
    if (!session) { showFilePanelMessage("打开会话后查看工作区文件。", false); return; }
    if (session.id.indexOf("conv_") === 0) {
      showFilePanelMessage("需要先载入这个新任务的工作区。", true);
      return;
    }
    showFilePanelMessage("正在读取文件…", false);
    try {
      var response = await fetch(fileApiUrl(session.id, "files", fileRelativePath));
      if (response.status === 409) { showFilePanelMessage("会话还没有绑定工作区。", true); return; }
      if (!response.ok) throw new Error("HTTP " + response.status);
      var payload = await response.json();
      if (generation !== fileRequestGeneration || activeSessionId !== session.id) return;
      fileList.textContent = "";
      var entries = Array.isArray(payload.entries) ? payload.entries.slice() : [];
      entries.sort(function (a, b) {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (b.type === "directory" && a.type !== "directory") return 1;
        return safeText(a.name).localeCompare(safeText(b.name), "zh-CN", { numeric: true });
      });
      if (!entries.length) showFilePanelMessage("这个目录还没有文件。", false);
      entries.forEach(function (entry) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "file-item" + (entry.type === "directory" ? " directory" : "");
        button.disabled = entry.type !== "directory" && entry.type !== "file";
        var name = document.createElement("span");
        name.textContent = (entry.type === "directory" ? "▸  " : "□  ") + safeText(entry.name);
        button.appendChild(name);
        if (entry.type === "file" && Number.isFinite(entry.size_bytes)) {
          var size = document.createElement("small");
          size.textContent = entry.size_bytes >= 1024 ? Math.ceil(entry.size_bytes / 1024) + " KB" : entry.size_bytes + " B";
          button.appendChild(size);
        }
        button.addEventListener("click", function () {
          if (entry.type === "directory") { fileRelativePath = entry.path; loadFileList(); }
          else if (entry.type === "file") previewFile(entry);
        });
        var row = document.createElement("div");
        row.className = "file-row";
        row.setAttribute("role", "listitem");
        row.appendChild(button);
        if (entry.type === "file" && window.LkaWorkspaceFiles) {
          row.appendChild(window.LkaWorkspaceFiles.downloadButton(entry, { sessionId: session.id, workspace: session.workspace, path: fileRelativePath }));
        }
        fileList.appendChild(row);
      });
      if (payload.truncated) {
        var note = document.createElement("p");
        note.className = "file-panel-message";
        note.textContent = "文件较多，仅显示前 200 项。请进入子目录查看。";
        fileList.appendChild(note);
      }
    } catch (error) {
      if (generation === fileRequestGeneration) showFilePanelMessage("文件读取失败：" + safeText(error.message || error), false);
    }
  }

  async function previewFile(entry) {
    var session = getActiveSession();
    if (!session || !filePreview) return;
    var path = safeText(entry.path);
    selectedFilePath = path;
    filePreview.textContent = "正在预览 " + safeText(entry.name) + "…";
    var extension = safeText(entry.name).split(".").pop().toLocaleLowerCase();
    if (["png", "jpg", "jpeg", "webp"].indexOf(extension) >= 0) {
      filePreview.textContent = "";
      var image = document.createElement("img");
      image.alt = safeText(entry.name);
      image.src = fileApiUrl(session.id, "file/raw", path);
      image.onerror = function () { filePreview.textContent = "图片预览不可用。"; };
      filePreview.appendChild(image);
      return;
    }
    if (extension === "pdf") {
      filePreview.textContent = "";
      var frame = document.createElement("iframe");
      frame.title = safeText(entry.name);
      frame.src = fileApiUrl(session.id, "file/raw", path);
      filePreview.appendChild(frame);
      return;
    }
    try {
      var response = await fetch(fileApiUrl(session.id, "file", path));
      if (!response.ok) throw new Error(response.status === 415 ? "仅支持 UTF-8 文本、图片与 PDF 预览" : "HTTP " + response.status);
      var payload = await response.json();
      if (selectedFilePath !== path || activeSessionId !== session.id) return;
      filePreview.textContent = "";
      var heading = document.createElement("strong");
      heading.textContent = safeText(entry.name) + (payload.truncated ? " · 仅显示前 256 KB" : "");
      var code = document.createElement("pre");
      code.textContent = safeText(payload.text);
      filePreview.appendChild(heading);
      filePreview.appendChild(code);
    } catch (error) {
      if (selectedFilePath === path) filePreview.textContent = "预览失败：" + safeText(error.message || error);
    }
  }

  async function ensureSessionWorkspace(session) {
    if (!session || session.workspace) return session && session.workspace;
    await defaultsReady;
    var requestKey = session.id;
    if (workspaceRequests[requestKey]) return workspaceRequests[requestKey];
    workspaceRequests[requestKey] = (async function () {
      var data;
      if (window.petBridge && typeof window.petBridge.createSessionWorkspace === "function") {
        data = JSON.parse(window.petBridge.createSessionWorkspace(requestKey, runSettings.workspaceParent || "") || "{}");
        if (data.error) throw new Error(data.error);
      } else {
        var response = await fetch("/pet/session-workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: requestKey, base_path: runSettings.workspaceParent || "" })
        });
        data = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          var detail = data.detail;
          if (Array.isArray(detail)) {
            detail = detail.map(function (item) { return item.msg || item.message || ""; }).filter(Boolean).join("；");
          }
          if (response.status === 404) detail = "前端服务未提供工作区接口，请重启前端服务";
          throw new Error("HTTP " + response.status + "：" + (typeof detail === "string" && detail || "无法创建工作目录"));
        }
      }
      if (!data.path) throw new Error("工作区服务没有返回目录路径");
      if (!session.workspace) {
        session.workspace = data.path;
        var liveSession = getSessionById(requestKey);
        if (liveSession && !liveSession.workspace) liveSession.workspace = data.path;
        persistSessions();
        if (activeSessionId === session.id) renderWorkspaceSummary(session);
      }
      return session.workspace;
    }());
    try { return await workspaceRequests[requestKey]; }
    finally { delete workspaceRequests[requestKey]; }
  }

  async function prepareSessionWorkspace(session) {
    if (!session) return;
    renderWorkspaceSummary(session);
    if (session.workspace) return;
    try {
      await ensureSessionWorkspace(session);
      if (activeSessionId === session.id) setRunStatus("已创建此会话的工作区");
    } catch (error) {
      if (activeSessionId === session.id) setRunStatus("工作区创建失败：" + error.message, "error");
    }
  }

  function focusRenameInputSoon() {
    setTimeout(function () {
      var renameInput = document.querySelector(".session-rename-input");
      if (renameInput && typeof renameInput.focus === "function") {
        renameInput.focus();
        if (typeof renameInput.select === "function") {
          renameInput.select();
        }
      }
    }, 0);
  }

  function applyCustomSessionTitle(session, proposedTitle) {
    if (!session) {
      return;
    }
    var cleaned = truncateText(proposedTitle, 40);
    if (!cleaned) {
      session.title = "";
      session.title_is_custom = false;
    } else {
      session.title = cleaned;
      session.title_is_custom = true;
    }
    applySessionTitle(session);
  }

  function renderSessionList() {
    if (!sessionList) {
      return;
    }
    sessionList.innerHTML = "";
    if (sessionListCaption) sessionListCaption.textContent = viewingDeletedSessions ? "已删除的会话" : "最近的工作";
    if (toggleDeletedSessionsButton) toggleDeletedSessionsButton.textContent = viewingDeletedSessions ? "返回会话" : "已删除";
    if (sessionSearchInput) sessionSearchInput.placeholder = viewingDeletedSessions ? "搜索已删除会话" : "搜索会话";
    if (loadMoreSessionsButton) {
      loadMoreSessionsButton.hidden = !historyHasMore && !historyLoading;
      loadMoreSessionsButton.disabled = historyLoading;
      loadMoreSessionsButton.textContent = historyLoading ? "加载中…" : "加载更早的会话";
    }
    if (sessionListStatus) {
      var loadedCount = viewingDeletedSessions ? deletedHistoryItems.length : historyItems.length;
      sessionListStatus.textContent = historyError || (historyLoading ? "正在读取历史…" : loadedCount ? "已载入 " + loadedCount + " 条历史" : "");
    }
    if (viewingDeletedSessions) {
      renderDeletedSessionList();
      return;
    }

    var searchTerm = sessionSearchInput ? sessionSearchInput.value.trim().toLocaleLowerCase() : "";
    var ordered = sessions.filter(function (session) {
      if (!searchTerm) return true;
      applySessionTitle(session);
      return (session.title || "").toLocaleLowerCase().indexOf(searchTerm) !== -1 ||
        (session.workspace || "").toLocaleLowerCase().indexOf(searchTerm) !== -1;
    }).sort(function (a, b) {
      return b.updated_at - a.updated_at;
    });
    var includedIds = Object.create(null);
    ordered.forEach(function (session) { includedIds[session.id] = true; });
    historyItems.forEach(function (summary) {
      if (!includedIds[summary.id] && !deletedSessionIds[summary.id] && !deletingSessionIds[summary.id]) {
        ordered.push(getSessionById(summary.id) || summary);
        includedIds[summary.id] = true;
      }
    });
    if (!ordered.length) {
      var empty = document.createElement("p");
      empty.className = "session-list-empty";
      empty.textContent = historyLoading ? "正在搜索历史会话…" :
        searchTerm ? "没有找到匹配的会话" : "还没有会话";
      sessionList.appendChild(empty);
    }

    ordered.forEach(function (session) {
      if (!session.summary_only) applySessionTitle(session);

      var item = document.createElement("article");
      item.className = "session-item" + (session.id === activeSessionId ? " active" : "");
      item.dataset.sessionId = session.id;

      var row = document.createElement("div");
      row.className = "session-row";

      if (renamingSessionId === session.id) {
        var renameInput = document.createElement("input");
        renameInput.type = "text";
        renameInput.className = "session-rename-input";
        renameInput.maxLength = 40;
        renameInput.value = renameDraft || session.title || "新会话";
        renameInput.addEventListener("input", function () {
          renameDraft = renameInput.value;
        });
        renameInput.addEventListener("keydown", function (event) {
          if (event.key === "Enter") {
            event.preventDefault();
            commitRenameSession(session.id, renameInput.value);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancelRenameSession();
          }
        });
        row.appendChild(renameInput);

        var editingActions = document.createElement("div");
        editingActions.className = "session-actions";

        var saveButton = document.createElement("button");
        saveButton.type = "button";
        saveButton.className = "session-mini";
        saveButton.textContent = "保存";
        saveButton.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          commitRenameSession(session.id, renameInput.value);
        });

        var cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.className = "session-mini";
        cancelButton.textContent = "取消";
        cancelButton.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          cancelRenameSession();
        });

        editingActions.appendChild(saveButton);
        editingActions.appendChild(cancelButton);
        row.appendChild(editingActions);
      } else {
        var openButton = document.createElement("button");
        openButton.type = "button";
        openButton.className = "session-open";
        openButton.dataset.sessionId = session.id;
        openButton.addEventListener("click", function () {
          switchSession(session.id);
        });

        var title = document.createElement("span");
        title.className = "session-title";
        title.textContent = session.title || "新会话";
        openButton.appendChild(title);

        var actions = document.createElement("div");
        actions.className = "session-actions";

        var renameButton = document.createElement("button");
        renameButton.type = "button";
        renameButton.className = "session-mini";
        renameButton.textContent = "重命名";
        renameButton.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          renameSession(session.id);
        });

        var deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "session-mini danger";
        deleteButton.textContent = "删除";
        deleteButton.disabled = !!deletingSessionIds[session.id];
        deleteButton.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          deleteSession(session.id);
        });

        actions.appendChild(renameButton);
        actions.appendChild(deleteButton);
        row.appendChild(openButton);
        row.appendChild(actions);
      }

      var meta = document.createElement("span");
      meta.className = "session-meta";
      meta.textContent = formatTimestamp(session.updated_at) + (session.summary_only ? " · 点击载入" : " · " + getSessionMessageCount(session) + " 条消息");

      item.appendChild(row);
      item.appendChild(meta);
      sessionList.appendChild(item);
    });

    if (renamingSessionId) {
      focusRenameInputSoon();
    }
  }

  function renderDeletedSessionList() {
    var byId = Object.create(null);
    deletedHistoryItems.forEach(function (item) {
      byId[item.id] = {
        id: item.id, title: item.title, deleted_at: item.updated_at, local_only: false
      };
    });
    var searchTerm = sessionSearchInput ? sessionSearchInput.value.trim().toLocaleLowerCase() : "";
    deletedSessionSnapshots.forEach(function (item) {
      if (byId[item.id]) {
        if (item.title_is_custom) byId[item.id].title = item.title;
      } else if (item.local_only && (!searchTerm || (item.title || "").toLocaleLowerCase().indexOf(searchTerm) !== -1)) {
        byId[item.id] = { id: item.id, title: item.title || "新会话", deleted_at: item.deleted_at, local_only: true };
      }
    });
    var ordered = Object.keys(byId).map(function (id) { return byId[id]; })
      .sort(function (a, b) { return b.deleted_at - a.deleted_at; });
    if (!ordered.length) {
      var empty = document.createElement("p");
      empty.className = "session-list-empty";
      empty.textContent = searchTerm ? "没有找到匹配的会话" : "没有已删除的会话";
      sessionList.appendChild(empty);
    }
    ordered.forEach(function (item) {
      var card = document.createElement("article");
      card.className = "session-item deleted-session";
      card.dataset.sessionId = item.id;
      var row = document.createElement("div");
      row.className = "session-row";
      var title = document.createElement("span");
      title.className = "session-title";
      title.textContent = item.title || "新会话";
      var restoreButton = document.createElement("button");
      restoreButton.type = "button";
      restoreButton.className = "session-mini";
      restoreButton.textContent = restoringSessionIds[item.id] ? "恢复中" : "恢复";
      restoreButton.disabled = !!restoringSessionIds[item.id];
      restoreButton.addEventListener("click", function () { restoreSession(item.id); });
      var meta = document.createElement("span");
      meta.className = "session-meta";
      meta.textContent = "已删除 · " + formatTimestamp(item.deleted_at);
      row.appendChild(title);
      row.appendChild(restoreButton);
      card.appendChild(row);
      card.appendChild(meta);
      sessionList.appendChild(card);
    });
  }

  async function refreshDeletedSessions() {
    try {
      var response = await fetch(backendBaseUrl + "/sessions/deleted?limit=200", {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var payload = await response.json();
      backendDeletedSessions = (Array.isArray(payload.sessions) ? payload.sessions : [])
        .filter(function (item) { return item && item.session_id; })
        .map(function (item) {
          return {
            id: safeText(item.session_id),
            title: safeText(item.title).trim() || "新会话",
            deleted_at: timestampToMillis(item.updated_at),
            local_only: false
          };
        });
      var remoteDeletedIds = Object.create(null);
      backendDeletedSessions.forEach(function (item) {
        remoteDeletedIds[item.id] = true;
        delete deletedThisPage[item.id];
      });
      var newlyDeleted = sessions.filter(function (item) { return !!remoteDeletedIds[item.id]; });
      if (newlyDeleted.length) {
        if (remoteDeletedIds[activeSessionId]) saveCurrentDraft();
        newlyDeleted.forEach(function (item) {
          deletedSessionIds[item.id] = true;
          rememberDeletedSessionSnapshot(item, false);
        });
        try { localStorage.setItem(deletedSessionsKey, JSON.stringify(Object.keys(deletedSessionIds).slice(-100))); }
        catch (ignored) {}
        sessions = sessions.filter(function (item) { return !remoteDeletedIds[item.id]; });
        if (!getSessionById(activeSessionId)) {
          activeAgentTurnGeneration += 1;
          abortActiveAgentEventStream();
          ensureActiveSession();
          showDraftForSession(getActiveSession());
          prepareSessionWorkspace(getActiveSession());
          renderActiveMessages();
          renderWorkspaceSummary(getActiveSession());
          loadFileList();
        }
        persistSessions();
      }
      if (viewingDeletedSessions || newlyDeleted.length) renderSessionList();
    } catch (error) {
      if (viewingDeletedSessions) setRunStatus("已删除会话加载失败：" + safeText(error.message || error), "error");
    }
  }

  function renderActiveMessages() {
    var session = getActiveSession();
    if (!workMode && typeof window.__petQuickBeforeMessagesRender === "function") window.__petQuickBeforeMessagesRender();
    messages.innerHTML = "";
    if (!session) {
      if (workMode) appendMessageToDom("assistant", defaultGreetingMessage().text, false);
      renderMultiAgentSnapshot(null);
      renderRunTimeline(null);
      renderActiveSessionMeta();
      return;
    }

    if (!Array.isArray(session.messages) || !session.messages.length) {
      session.messages = [defaultGreetingMessage()];
    }

    if (workMode && session.messages.length === 1 &&
        session.messages[0].role === "assistant" &&
        session.messages[0].text === defaultGreetingMessage().text) {
      renderWelcome();
      renderMultiAgentSnapshot(session);
      renderRunTimeline(session);
      renderActiveSessionMeta();
      return;
    }

    session.messages.forEach(function (message, index) {
      if (index === 0 && message.role === "assistant" &&
          message.text === defaultGreetingMessage().text) return;
      appendMessageToDom(
        message.role === "user" ? "user" : "assistant",
        message.text,
        !!message.isError,
        message.pendingApproval || null,
        session.id,
        message
      );
    });
    var lastMessage = session.messages[session.messages.length - 1];
    if (lastMessage && lastMessage.isError) {
      var priorUser = session.messages.slice().reverse().find(function (item) { return item.role === "user" && item.text; });
      var errorBubble = messages.querySelector(".message.error:last-child .bubble");
      if (priorUser && errorBubble) {
        var retryButton = document.createElement("button");
        retryButton.type = "button";
        retryButton.className = "retry-task-button";
        retryButton.textContent = "重新编辑这条任务";
        retryButton.addEventListener("click", function () {
          if (readDraft(session.id).trim() || window.LkaImageComposer.hasAttachments(session.id)) {
            setRunStatus("当前会话已有草稿，请先处理草稿后再重新编辑失败任务", "error");
            focusComposer();
            return;
          }
          window.LkaImageComposer.queueRefs(session.id, priorUser.attachments);
          writeDraft(session.id, /^\[(Image|File) input\]$/.test(priorUser.text) ? "" : priorUser.text);
          showDraftForSession(session);
          setRunStatus("原任务已放回输入框，确认内容后发送");
          focusComposer();
        });
        errorBubble.appendChild(retryButton);
      }
    }
    renderMultiAgentSnapshot(session);
    renderRunTimeline(session);
    renderActiveSessionMeta();
  }

  function renderWelcome() {
    var welcome = document.createElement("div");
    welcome.className = "welcome";
    welcome.innerHTML = '<span class="welcome-eyebrow">理事所 · 工作台</span>' +
      '<h1>现在，想推进哪件事？</h1>' +
      '<p>直接描述目标即可。会话消息独立保存，资料与结果留在当前工作目录。</p>';
    var suggestions = document.createElement("div");
    suggestions.className = "welcome-suggestions";
    ["梳理这个工作区的文件", "帮我制定下一步计划", "总结一份资料"].forEach(function (prompt) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = prompt + " ↗";
      button.addEventListener("click", function () {
        if (document.body.classList.contains("native-composer")
            && window.petBridge && typeof window.petBridge.setComposerDraft === "function") {
          window.petBridge.setComposerDraft(prompt);
        } else {
          input.value = prompt;
          writeDraft(activeSessionId, prompt);
          focusComposer();
        }
      });
      suggestions.appendChild(button);
    });
    welcome.appendChild(suggestions);
    messages.appendChild(welcome);
  }

  async function ensureLocalSession(sessionId) {
    var existing = getSessionById(sessionId);
    if (existing) return existing;
    var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(sessionId));
    if (!response.ok) throw new Error("HTTP " + response.status);
    var loaded = sessionFromBackendDetail(await response.json());
    if (!loaded) throw new Error("会话内容无效");
    touchSession(loaded);
    sessions.unshift(loaded);
    persistSessions();
    return getSessionById(loaded.id) || loaded;
  }

  async function switchSession(sessionId) {
    var next;
    try { next = await ensureLocalSession(sessionId); }
    catch (error) {
      setRunStatus("会话载入失败：" + safeText(error.message || error), "error");
      loadHistoryPage(true);
      return;
    }
    saveCurrentDraft();
    activeAgentTurnGeneration += 1;
    abortActiveAgentEventStream();
    pendingState = null;
    setComposerDisabled(backendOffline);
    renamingSessionId = "";
    renameDraft = "";
    activeSessionId = next.id;
    showDraftForSession(next);
    fileRelativePath = "";
    renderSessionList();
    renderActiveMessages();
    prepareSessionWorkspace(next);
    refreshActiveMultiAgentSnapshot();
    reconnectActiveSavedRun();
    loadFileList();
    persistSessions();
    setSidebarOpen(false);
    focusComposer();
  }

  function createAndSwitchNewSession(projectWorkspace) {
    saveCurrentDraft();
    activeAgentTurnGeneration += 1;
    abortActiveAgentEventStream();
    pendingState = null;
    setComposerDisabled(backendOffline);
    viewingDeletedSessions = false;
    if (sessionSearchInput) sessionSearchInput.value = "";
    var created = typeof projectWorkspace === "string" ? null : sessions.find(isUnusedLocalSession);
    if (!created) {
      created = createSession("");
      if (typeof projectWorkspace === "string") {
        created.workspace = projectWorkspace;
        created.workspace_is_custom = true;
      }
      sessions.unshift(created);
    }
    touchSession(created);
    renamingSessionId = "";
    renameDraft = "";
    activeSessionId = created.id;
    pendingState = null;
    showDraftForSession(created);
    fileRelativePath = "";
    renderSessionList();
    renderActiveMessages();
    prepareSessionWorkspace(created);
    loadFileList();
    persistSessions();
    setSidebarOpen(false);
    focusComposer();
  }

  function openFreshTask() {
    var active = getActiveSession();
    if (!isReusableEmptySession(active)) {
      createAndSwitchNewSession();
      return;
    }
    viewingDeletedSessions = false;
    if (sessionSearchInput) sessionSearchInput.value = "";
    showDraftForSession(active);
    fileRelativePath = "";
    renderSessionList();
    renderActiveMessages();
    prepareSessionWorkspace(active);
    loadFileList();
    persistSessions();
    focusComposer();
  }

  async function renameSession(sessionId) {
    var session;
    try { session = await ensureLocalSession(sessionId); }
    catch (error) { setRunStatus("会话载入失败：" + safeText(error.message || error), "error"); return; }
    applySessionTitle(session);
    renamingSessionId = session.id;
    renameDraft = session.title || "新会话";
    renderSessionList();
  }

  async function commitRenameSession(sessionId, proposedTitle) {
    var session = getSessionById(sessionId);
    if (!session) {
      renamingSessionId = "";
      renameDraft = "";
      renderSessionList();
      return;
    }
    var title = truncateText(proposedTitle, 40) || deriveAutoSessionTitle(session);
    try {
      if (window.petBridge && typeof window.petBridge.renameSession === "function") {
        var bridgeResult = JSON.parse(window.petBridge.renameSession(sessionId, title) || "{}");
        if (bridgeResult.error || (bridgeResult.not_found && getSessionMessageCount(session) > 0)) {
          throw new Error(bridgeResult.error || "后端未找到这条会话");
        }
      } else {
        var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(sessionId), {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title })
        });
        if (!response.ok && !(response.status === 404 && getSessionMessageCount(session) === 0)) {
          throw new Error("HTTP " + response.status);
        }
      }
      applyCustomSessionTitle(session, title);
      historyItems.forEach(function (item) { if (item.id === sessionId) item.title = title; });
      renamingSessionId = "";
      renameDraft = "";
      renderSessionList();
      renderActiveSessionMeta();
      persistSessions();
    } catch (error) {
      setRunStatus("重命名失败：" + safeText(error.message || error), "error");
    }
  }

  function cancelRenameSession() {
    if (!renamingSessionId) {
      return;
    }
    renamingSessionId = "";
    renameDraft = "";
    renderSessionList();
  }

  function hideUndoToast() {
    if (undoTimer) window.clearTimeout(undoTimer);
    undoTimer = null;
    undoSessionId = "";
    if (undoToast) undoToast.hidden = true;
  }

  function showUndoToast(session) {
    if (!undoToast || !session) return;
    if (undoTimer) window.clearTimeout(undoTimer);
    undoSessionId = session.id;
    if (undoToastText) undoToastText.textContent = "“" + (session.title || "会话") + "”已删除，其记忆来源已撤回";
    undoToast.hidden = false;
    undoTimer = window.setTimeout(hideUndoToast, 10000);
  }

  async function deleteSession(sessionId) {
    var session = getSessionById(sessionId);
    if (!session) {
      try { session = await ensureLocalSession(sessionId); }
      catch (error) { setRunStatus("删除前载入失败：" + safeText(error.message || error), "error"); return; }
    }
    if (!session || deletingSessionIds[sessionId]) return;
    if (fileWorkspacePreparations.some(function (item) { return item.id === sessionId; })) {
      setRunStatus("文件目录正在准备，请稍后再删除会话。", "error");
      return;
    }
    if (pendingState && pendingState.conversationId === sessionId) {
      setRunStatus("当前会话仍在处理，完成后再删除", "error");
      return;
    }

    deletingSessionIds[sessionId] = true;
    renderSessionList();
    try {
      var backendDeleted = false;
      if (window.petBridge && typeof window.petBridge.deleteSession === "function") {
        var bridgeResult = JSON.parse(window.petBridge.deleteSession(sessionId) || "{}");
        if (bridgeResult.error) throw new Error(bridgeResult.error);
        backendDeleted = !!bridgeResult.backend_deleted;
      } else {
        var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(sessionId), {
          method: "DELETE"
        });
        // A draft that was never sent has no backend row to delete.
        if (!response.ok && response.status !== 404) {
          var detail = "HTTP " + response.status;
          try {
            var payload = await response.json();
            if (payload.detail) detail += "：" + safeText(payload.detail);
          } catch (ignored) {}
          throw new Error(detail);
        }
        backendDeleted = response.ok;
      }

      if (!backendDeleted && getSessionMessageCount(session) > 0) {
        throw new Error("后端未找到这条有消息的会话，请确认快速窗口与工作台连接同一后端");
      }

      rememberDeletedSessionSnapshot(session, !backendDeleted);
      rememberDeletedSessionId(sessionId);
      try { localStorage.removeItem(runCursorKeyPrefix + encodeURIComponent(sessionId)); } catch (ignored) {}
      if (renamingSessionId === sessionId) {
        renamingSessionId = "";
        renameDraft = "";
      }
      sessions = sessions.filter(function (item) { return item.id !== sessionId; });
      if (!sessions.length) sessions.unshift(createSession(""));
      if (!getSessionById(activeSessionId)) {
        activeAgentTurnGeneration += 1;
        abortActiveAgentEventStream();
        activeSessionId = sessions[0].id;
        showDraftForSession(getActiveSession());
        fileRelativePath = "";
        renderActiveMessages();
        prepareSessionWorkspace(getActiveSession());
        refreshActiveMultiAgentSnapshot();
        reconnectActiveSavedRun();
        loadFileList();
      }
      persistSessions();
      setRunStatus("会话已移至已删除列表；相关记忆来源停止使用，会话可恢复");
      showUndoToast(session);
      if (viewingDeletedSessions) refreshDeletedSessions();
      focusComposer();
    } catch (error) {
      setRunStatus("删除失败：" + safeText(error.message || error), "error");
    } finally {
      delete deletingSessionIds[sessionId];
      renderSessionList();
    }
  }

  async function restoreSession(sessionId) {
    if (restoringSessionIds[sessionId]) return;
    var snapshot = deletedSessionSnapshots.find(function (item) { return item.id === sessionId; });
    restoringSessionIds[sessionId] = true;
    renderSessionList();
    try {
      var detail = null;
      var missing = false;
      if (window.petBridge && typeof window.petBridge.restoreSession === "function") {
        var bridgeResult = JSON.parse(window.petBridge.restoreSession(sessionId) || "{}");
        if (bridgeResult.error) throw new Error(bridgeResult.error);
        missing = !!bridgeResult.not_found;
        if (!missing) detail = bridgeResult;
      } else {
        var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(sessionId) + "/restore", {
          method: "POST"
        });
        missing = response.status === 404;
        if (!response.ok && !missing) throw new Error("HTTP " + response.status);
        if (!missing) detail = await response.json();
      }
      if (missing && !(snapshot && snapshot.local_only)) {
        throw new Error("后端未找到该会话，无法恢复");
      }
      var restored = detail ? sessionFromBackendDetail(detail) : null;
      if (!restored && snapshot) restored = sanitizeSession(snapshot);
      if (!restored) throw new Error("没有可恢复的会话内容");
      if (snapshot && snapshot.title_is_custom) {
        restored.title = snapshot.title;
        restored.title_is_custom = true;
      }
      forgetDeletedSessionId(sessionId);
      if (undoSessionId === sessionId) hideUndoToast();
      sessions.unshift(restored);
      activeSessionId = restored.id;
      showDraftForSession(restored);
      fileRelativePath = "";
      viewingDeletedSessions = false;
      if (sessionSearchInput) sessionSearchInput.value = "";
      normalizeSessionBounds();
      persistSessions();
      renderSessionList();
      renderActiveMessages();
      prepareSessionWorkspace(restored);
      loadFileList();
      setRunStatus("会话已恢复；已撤回的记忆不会自动重新发布，需要重新确认");
      setSidebarOpen(false);
      focusComposer();
    } catch (error) {
      setRunStatus("恢复失败：" + safeText(error.message || error), "error");
    } finally {
      delete restoringSessionIds[sessionId];
      if (viewingDeletedSessions) renderSessionList();
    }
  }

  function addMessageToSession(session, role, text, isError, options) {
    if (!session) {
      return;
    }
    if (!Array.isArray(session.messages)) {
      session.messages = [];
    }
    var normalizedText = safeText(text).trim();
    var pendingApproval = normalizePendingApproval(options && options.pendingApproval);
    if (!normalizedText && pendingApproval && pendingApproval.status !== "pending") {
      return;
    }
    if (!normalizedText && !pendingApproval) {
      return;
    }
    session.messages.push({
      role: role === "user" ? "user" : "assistant",
      text: normalizedText,
      isError: !!isError,
      pendingApproval: pendingApproval,
      progressEvents: normalizeProgressEvents(options && options.progressEvents),
      verificationWarnings: normalizeVerificationWarnings(options && options.verificationWarnings),
      traceId: safeText(options && options.traceId).trim(),
      logPath: safeText(options && options.logPath).trim(),
      attachments: window.LkaImageComposer.normalize(options && options.attachments),
      clientId: safeText(options && options.clientId),
      selectedPackage: safeText(options && options.selectedPackage).trim()
    });
    if (session.messages.length > 180) {
      session.messages = session.messages.slice(-180);
    }
  }

  function setComposerDisabled(disabled) {
    sendButton.disabled = !!disabled;
    var projectButton = document.querySelector("#newProjectSessionButton"), active = getActiveSession();
    if (projectButton) projectButton.disabled = !!disabled || !active || !active.workspace;
    // Keep the next task editable while the current Agent turn is running.
    input.disabled = false;
    if (window.petBridge && typeof window.petBridge.setComposerBusy === "function") {
      window.petBridge.setComposerBusy(!!disabled);
    }
  }

  function focusComposer(force) {
    if (document.body.classList.contains("native-composer")
        && window.petBridge && typeof window.petBridge.focusComposer === "function") {
      window.petBridge.focusComposer();
    } else {
      // Returning to a conversation on touch devices must not summon the keyboard.
      if (document.body.classList.contains("mobile-workbench")
          && window.matchMedia("(pointer: coarse)").matches && !force && document.activeElement !== input) return;
      input.focus();
    }
  }

  function extractAnswer(payload) {
    if (!payload || typeof payload !== "object") {
      return "Empty response from backend.";
    }
    if (typeof payload.answer === "string") {
      return payload.answer;
    }
    if (typeof payload.response === "string") {
      return payload.response;
    }
    if (typeof payload.result === "string") {
      return payload.result;
    }
    if (payload.result && typeof payload.result.answer === "string") {
      return payload.result.answer;
    }
    return JSON.stringify(payload, null, 2);
  }

  function normalizeBackendMessages(rawMessages) {
    if (!Array.isArray(rawMessages)) {
      return [];
    }
    var normalized = [];
    rawMessages.forEach(function (entry) {
      if (!entry || typeof entry !== "object") {
        return;
      }
      var role = entry.role === "user" ? "user" : (entry.role === "assistant" ? "assistant" : "");
      var content = safeText(entry.content || entry.text).trim();
      if (!role || !content) {
        return;
      }
      normalized.push({
        role: role,
        text: content,
        isError: false,
        attachments: window.LkaImageComposer.fromIds(entry.payload && entry.payload.attachment_ids)
      });
    });
    return normalized.slice(-180);
  }

  function findPendingApprovalMessage(session, approvalId) {
    if (!session || !Array.isArray(session.messages)) {
      return null;
    }
    for (var i = session.messages.length - 1; i >= 0; i -= 1) {
      var item = session.messages[i];
      if (!item || !item.pendingApproval) {
        continue;
      }
      if (safeText(item.pendingApproval.approval_id).trim() === approvalId) {
        return item;
      }
    }
    return null;
  }

  function removePendingApprovalMessage(session, approvalId) {
    if (!session || !Array.isArray(session.messages)) {
      return;
    }
    session.messages = session.messages.filter(function (item) {
      if (!item || !item.pendingApproval) {
        return true;
      }
      return safeText(item.pendingApproval.approval_id).trim() !== approvalId;
    });
  }

  function renderShellExecutionResult(result) {
    if (!result || typeof result !== "object") {
      return "我已执行审批命令，但没有拿到结果详情。";
    }
    var command = safeText(result.command).trim();
    var exitCode = String(result.exit_code);
    var succeeded = exitCode === "0";
    if (!command) {
      return succeeded
        ? "好的，命令已经执行完成。"
        : "我已执行命令，但执行结果不是成功状态（exit_code=" + exitCode + "）。";
    }
    if (succeeded) {
      return "好的，已经为你执行完成。\ncommand: " + command + "\nexit_code: " + exitCode;
    }
    return "我已执行命令，但执行结果不是成功状态。\ncommand: " + command + "\nexit_code: " + exitCode;
  }

  async function handleApprovalAction(sessionId, approval, action, approveButton, rejectButton) {
    var approvalId = safeText(approval && approval.approval_id).trim();
    if (!approvalId) {
      return;
    }
    if (approveButton) {
      approveButton.disabled = true;
    }
    if (rejectButton) {
      rejectButton.disabled = true;
    }

    var endpoint = "/shell/approvals/" + encodeURIComponent(approvalId) + "/" + action;
    var session = getOrCreateSessionById(sessionId);
    try {
      var response = await fetch(backendBaseUrl + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      if (!response.ok) {
        throw new Error("HTTP " + response.status + " " + response.statusText);
      }
      var payload = await response.json();
      var pendingMessage = findPendingApprovalMessage(session, approvalId);
      if (pendingMessage && pendingMessage.pendingApproval) {
        pendingMessage.pendingApproval.status = action === "approve" ? "approved" : "rejected";
      }
      removePendingApprovalMessage(session, approvalId);

      var feedbackText = "";
      if (action === "approve") {
        var assistantMessage = safeText(payload && payload.assistant_message).trim();
        feedbackText = assistantMessage || renderShellExecutionResult(payload && payload.result);
      } else {
        feedbackText = "Command approval rejected. The queued command will not run.";
      }
      addMessageToSession(session, "assistant", feedbackText, false);
      touchSession(session);
      pinSessionToTop(session.id);
      renderSessionList();
      if (activeSessionId === session.id) {
        renderActiveMessages();
      }
      persistSessions();
    } catch (error) {
      addMessageToSession(
        session,
        "assistant",
        "Approval action failed: " + safeText(error && error.message ? error.message : error),
        true
      );
      touchSession(session);
      pinSessionToTop(session.id);
      renderSessionList();
      if (activeSessionId === session.id) {
        renderActiveMessages();
      }
      persistSessions();
    }
  }

  async function callAgentTurn(payload) {
    var llm = {};
    if (runSettings.llmClient) llm.client_name = runSettings.llmClient;
    if (runSettings.llmModel) llm.model = runSettings.llmModel;
    var response = await fetch(backendBaseUrl + "/agent/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: payload.session_id || payload.conversation_id,
        user_input: payload.question || payload.user_input || "",
        attachment_ids: payload.attachment_ids || [],
        llm: llm,
        safety_review_mode: payload.safety_review_mode || undefined
      })
    });
    var text = await response.text();
    var data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " " + response.statusText + ": " + text);
    }
    data.conversation_id = data.session_id || payload.conversation_id || payload.session_id;
    return data;
  }

  async function callAgentTurnStream(payload, onEvent, signal) {
    var llm = { response_mode: "stream" };
    if (runSettings.llmClient) llm.client_name = runSettings.llmClient;
    if (runSettings.llmModel) llm.model = runSettings.llmModel;
    var response = await fetch(backendBaseUrl + "/agent/turn/stream", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ session_id: payload.session_id, user_input: payload.question, attachment_ids: payload.attachment_ids || [],
        llm: llm, safety_review_mode: payload.safety_review_mode || undefined }),
      signal: signal
    });
    if (!response.ok) {
      var errorBody = await response.text();
      throw new Error("HTTP " + response.status + " " + response.statusText + (errorBody ? ": " + errorBody.slice(0, 500) : ""));
    }
    if (!response.body) throw new Error("HTTP stream unavailable in this WebView");
    var reader = response.body.getReader(), decoder = new TextDecoder(), buffer = "", currentEvent = "message";
    function consume(block) {
      var eventName = "message", eventId = "", data = [];
      block.split(/\r?\n/).forEach(function (line) {
        if (line.indexOf("event:") === 0) eventName = line.slice(6).trim();
        else if (line.indexOf("id:") === 0) eventId = line.slice(3).trim();
        else if (line.indexOf("data:") === 0) data.push(line.slice(5).trim());
      });
      if (!data.length) return;
      try { onEvent(eventName, JSON.parse(data.join("\n")), eventId); } catch (error) { setRunStatus("事件解析失败：" + error.message, "error"); }
    }
    while (true) {
      var part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      var blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() || "";
      blocks.forEach(consume);
    }
    if (buffer.trim()) consume(buffer);
  }

  function renderMultiAgentSnapshot(session) {
    if (!multiAgentStatus) return;
    multiAgentStatus.textContent = "";
    var snapshot = session && session.multiAgentSnapshot;
    var plan = snapshot && snapshot.plan;
    var children = snapshot && Array.isArray(snapshot.children) ? snapshot.children : [];
    var parentRun = snapshot && snapshot.run && typeof snapshot.run === "object" ? snapshot.run : {};
    var parentStatus = safeText(parentRun.status);
    var activeStatuses = ["queued", "running", "waiting_confirmation", "waiting_user"];
    if (!plan && !children.length && activeStatuses.indexOf(parentStatus) < 0 && !parentRun.pending_user_question) {
      multiAgentStatus.hidden = true;
      return;
    }

    multiAgentStatus.hidden = false;
    var title = document.createElement("strong");
    title.textContent = plan || children.length
      ? "多 Agent 计划" + (plan && plan.status ? " · " + safeText(plan.status) : "")
      : "Agent 运行控制 · " + parentStatus;
    multiAgentStatus.appendChild(title);
    if (plan && plan.objective) {
      var objective = document.createElement("p");
      objective.textContent = truncateText(safeText(plan.objective), 240);
      multiAgentStatus.appendChild(objective);
    }

    if (activeStatuses.indexOf(parentStatus) >= 0) {
      appendSnapshotAction(multiAgentStatus, "取消本轮 Agent", "cancel_parent", session, parentRun.run_id || session.multiAgentRunId);
    }
    appendPendingQuestionControl(multiAgentStatus, session, parentRun.run_id || session.multiAgentRunId, parentStatus, parentRun.pending_user_question);

    var steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
    steps.slice(0, 30).forEach(function (step) {
      if (!step || typeof step !== "object") return;
      var row = document.createElement("div");
      row.className = "multi-agent-step";
      var dependencies = Array.isArray(step.depends_on) && step.depends_on.length
        ? " ← " + step.depends_on.map(safeText).join(", ")
        : "";
      row.textContent = truncateText("任务 " + safeText(step.step_id || "") + " · " + safeText(step.status || "pending")
        + " · " + safeText(step.agent_id || step.role || "通用 Agent") + dependencies, 320);
      multiAgentStatus.appendChild(row);
    });

    var renderedChildren = 0;
    function appendChildren(items, depth) {
      if (!Array.isArray(items) || depth > 8) return;
      items.forEach(function (child) {
        if (!child || typeof child !== "object" || renderedChildren >= 40) return;
        renderedChildren += 1;
        var row = document.createElement("div");
        row.className = "multi-agent-child";
        row.style.paddingLeft = (depth * 12) + "px";
        var step = child.step && typeof child.step === "object" ? child.step : {};
        row.textContent = truncateText("子任务 " + safeText(child.step_id || step.step_id || child.run_id || "")
          + (child.attempt ? " · 尝试 " + safeText(child.attempt) : "")
          + " · " + safeText(child.status || child.step_status || "unknown")
          + (step.agent_id || step.role ? " · " + safeText(step.agent_id || step.role) : ""), 240);
        multiAgentStatus.appendChild(row);
        var childRunId = safeText(child.run_id).trim();
        var childParentRunId = safeText(child.parent_run_id).trim()
          || (depth === 0 ? safeText(parentRun.run_id || session.multiAgentRunId).trim() : "");
        var childStatus = safeText(child.status);
        if (childRunId && childParentRunId && activeStatuses.indexOf(childStatus) >= 0) {
          appendSnapshotAction(multiAgentStatus, "取消子任务", "cancel_child", session, childRunId, childParentRunId);
        } else if (depth === 0 && childRunId && childParentRunId && ["failed", "timed_out"].indexOf(childStatus) >= 0
          && parentStatus === "running" && plan && ["running", "replanning"].indexOf(safeText(plan.status)) >= 0
          && isLatestSnapshotAttempt(items, child)) {
          appendSnapshotAction(multiAgentStatus, "重试子任务", "retry_child", session, childRunId, childParentRunId);
        }
        appendPendingQuestionControl(multiAgentStatus, session, childRunId, childStatus, child.pending_user_question);
        appendChildren(child.children, depth + 1);
      });
    }
    appendChildren(children, 0);
  }

  function isLatestSnapshotAttempt(siblings, child) {
    var stepId = safeText(child && child.step_id).trim();
    var planId = safeText(child && child.plan_id).trim();
    var attempt = Number(child && child.attempt) || 0;
    return !siblings.some(function (candidate) {
      return candidate && candidate.run_id !== child.run_id
        && safeText(candidate.step_id).trim() === stepId
        && safeText(candidate.plan_id).trim() === planId
        && (Number(candidate.attempt) || 0) > attempt;
    });
  }

  function appendSnapshotAction(container, label, action, session, targetRunId, parentRunId) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "multi-agent-control";
    button.textContent = label;
    var key = action + ":" + targetRunId;
    button.disabled = !!multiAgentCommandInFlight[key];
    button.addEventListener("click", function () {
      runSnapshotCommand(action, session, targetRunId, parentRunId || session.multiAgentRunId, key);
    });
    container.appendChild(button);
  }

  function appendPendingQuestionControl(container, session, targetRunId, status, question) {
    if (status !== "waiting_user" || !question || !safeText(question.question_id).trim()) return;
    var label = document.createElement("p");
    label.textContent = "Agent 需要补充信息：" + truncateText(safeText(question.question), 500);
    container.appendChild(label);
    var answer = document.createElement("textarea");
    answer.rows = 2;
    answer.maxLength = 20000;
    answer.setAttribute("aria-label", "回答 Agent 的澄清问题");
    answer.placeholder = "输入回答…";
    container.appendChild(answer);
    var button = document.createElement("button");
    button.type = "button";
    button.className = "multi-agent-control";
    button.textContent = "提交回答";
    var key = "continue:" + targetRunId + ":" + safeText(question.question_id);
    button.disabled = !!multiAgentCommandInFlight[key];
    button.addEventListener("click", function () {
      var cleanAnswer = answer.value.trim();
      var submission = pendingContinuationCommands[key];
      if (!submission || submission.answer !== cleanAnswer) {
        submission = { answer: cleanAnswer, commandId: "continue-" + newToken() };
        pendingContinuationCommands[key] = submission;
      }
      runSnapshotCommand("continue", session, targetRunId, session.multiAgentRunId, key, {
        command_id: submission.commandId, answer: cleanAnswer
      });
    });
    container.appendChild(button);
  }

  async function runSnapshotCommand(action, session, targetRunId, parentRunId, key, payload) {
    if (!session || !targetRunId || multiAgentCommandInFlight[key]) return;
    if (action === "continue" && (!payload || !safeText(payload.answer).trim())) {
      setRunStatus("请先输入对 Agent 澄清问题的回答。", "error");
      return;
    }
    multiAgentCommandInFlight[key] = true;
    if (activeSessionId === session.id) renderMultiAgentSnapshot(session);
    var base = backendBaseUrl + "/agent/runs/" + encodeURIComponent(targetRunId);
    var endpoint = action === "continue" ? base + "/continue"
      : action === "cancel_parent" ? base + "/cancel"
        : action === "cancel_child" ? backendBaseUrl + "/agent/runs/" + encodeURIComponent(parentRunId)
          + "/children/" + encodeURIComponent(targetRunId) + "/cancel"
          : backendBaseUrl + "/agent/runs/" + encodeURIComponent(parentRunId)
            + "/children/" + encodeURIComponent(targetRunId) + "/retry";
    try {
      var response = await fetch(endpoint, {
        method: "POST",
        headers: action === "continue" ? { "Content-Type": "application/json" } : {},
        body: action === "continue" ? JSON.stringify(payload) : undefined
      });
      var responseText = await response.text();
      if (!response.ok) throw new Error("HTTP " + response.status + (responseText ? ": " + responseText.slice(0, 400) : ""));
      if (action === "retry_child") {
        var updatedSnapshot = responseText ? JSON.parse(responseText) : null;
        if (updatedSnapshot && typeof updatedSnapshot === "object") {
          var current = getSessionById(session.id);
          if (current && current.multiAgentRunId === session.multiAgentRunId) {
            current.multiAgentSnapshot = updatedSnapshot;
            persistSessions();
          }
        }
      }
      await fetchMultiAgentSnapshot(session, session.multiAgentRunId);
      if (activeSessionId === session.id) setRunStatus("多 Agent 操作已提交，状态已刷新。");
    } catch (error) {
      if (activeSessionId === session.id) setRunStatus("多 Agent 操作失败：" + safeText(error.message), "error");
      await fetchMultiAgentSnapshot(session, session.multiAgentRunId);
    } finally {
      delete multiAgentCommandInFlight[key];
      if (activeSessionId === session.id) renderMultiAgentSnapshot(getSessionById(session.id) || session);
    }
  }

  function refreshActiveMultiAgentSnapshot() {
    var session = getActiveSession();
    if (!session || !session.multiAgentRunId) return;
    fetchMultiAgentSnapshot(session, session.multiAgentRunId);
  }

  async function fetchMultiAgentSnapshot(session, runId) {
    if (!session || !runId) return;
    var sessionId = session.id;
    var requestId = (multiAgentSnapshotRequestIds[sessionId] || 0) + 1;
    multiAgentSnapshotRequestIds[sessionId] = requestId;
    try {
      var response = await fetch(backendBaseUrl + "/agent/runs/" + encodeURIComponent(runId) + "/snapshot");
      if (!response.ok) return;
      var snapshot = await response.json();
      var currentSession = getSessionById(sessionId);
      if (!currentSession || currentSession.multiAgentRunId !== runId || multiAgentSnapshotRequestIds[sessionId] !== requestId) return;
      currentSession.multiAgentSnapshot = snapshot && typeof snapshot === "object" ? snapshot : null;
      persistSessions();
      currentSession = getSessionById(sessionId);
      if (activeSessionId === sessionId && currentSession) renderMultiAgentSnapshot(currentSession);
    } catch (ignored) {
      // A missing or temporarily unavailable run snapshot should not interrupt chat.
    }
  }

  function rememberStreamPosition(session, data, eventId) {
    if (!session) return;
    var currentSession = getSessionById(session.id) || session;
    var eventRunId = safeText(data && data.run_id).trim();
    var cursor = safeText(eventId).trim();
    if (!eventRunId && cursor.indexOf(":") >= 0) eventRunId = cursor.slice(0, cursor.lastIndexOf(":"));
    var sequence = Number(data && data.sequence) || 0;
    if (!sequence && cursor.indexOf(":") >= 0) sequence = Number(cursor.slice(cursor.lastIndexOf(":") + 1)) || 0;
    if (eventRunId && currentSession.multiAgentRunId !== eventRunId) {
      currentSession.multiAgentRunId = eventRunId;
      currentSession.multiAgentSequence = 0;
      currentSession.multiAgentSnapshot = null;
      if (activeSessionId === currentSession.id) renderMultiAgentSnapshot(currentSession);
    }
    if (eventRunId && sequence > currentSession.multiAgentSequence) currentSession.multiAgentSequence = sequence;
    saveRunCursor(currentSession);
    return currentSession;
  }

  function isMultiAgentRefreshEvent(eventName) {
    return eventName.indexOf("multi_agent_") === 0
      || eventName.indexOf("subtask_") === 0
      || eventName === "plan_created"
      || eventName === "plan_validated"
      || eventName === "replan_required"
      || eventName === "run_completed"
      || eventName === "run_failed"
      || eventName === "run_cancelled"
      || eventName === "run_timed_out";
  }

  function isApprovalQueueRefreshEvent(eventName) {
    return eventName.indexOf("safety_review_") === 0
      || eventName === "subtask_waiting_confirmation"
      || eventName === "multi_agent_waiting_confirmation"
      || eventName === "fork_waiting_confirmation"
      || eventName === "waiting_confirmation"
      || eventName === "run_completed"
      || eventName === "run_failed"
      || eventName === "run_cancelled"
      || eventName === "run_timed_out";
  }

  function scheduleApprovalQueuePoll() {
    if (approvalQueuePollTimer) window.clearTimeout(approvalQueuePollTimer);
    var intervalMs = pendingSafetyReviews.length ? 6000 : 20000;
    approvalQueuePollTimer = window.setTimeout(function () {
      approvalQueuePollTimer = null;
      refreshSafetyReviewQueue();
    }, intervalMs);
  }

  function renderApprovalQueue() {
    if (!approvalQueueStatus) return;
    approvalQueueStatus.textContent = "";
    approvalQueueStatus.setAttribute("role", "dialog");
    approvalQueueStatus.setAttribute("aria-modal", "true");
    approvalQueueStatus.setAttribute("aria-label", "安全审查确认");
    if (!pendingSafetyReviews.length && !approvalQueueNotice) {
      approvalQueueStatus.hidden = true;
      return;
    }
    approvalQueueStatus.hidden = false;

    var heading = document.createElement("strong");
    heading.textContent = "安全审批队列 · " + pendingSafetyReviews.length + " 项待处理";
    approvalQueueStatus.appendChild(heading);
    if (pendingSafetyReviews.length) {
      var head = pendingSafetyReviews[0];
      var summary = document.createElement("p");
      summary.textContent = "当前第 1 项：" + safeText(head.tool_name || "工具调用")
        + " · 风险 " + safeText(head.tool_risk || "unknown");
      approvalQueueStatus.appendChild(summary);
      if (head.reason) {
        var reason = document.createElement("p");
        reason.textContent = truncateText(safeText(head.reason), 260);
        approvalQueueStatus.appendChild(reason);
      }
      if (Array.isArray(head.side_effects) && head.side_effects.length) {
        var effects = document.createElement("p");
        effects.textContent = "可能影响：" + head.side_effects.map(safeText).join("、");
        approvalQueueStatus.appendChild(effects);
      }
      if (Array.isArray(head.input_fields) && head.input_fields.length) {
        var fields = document.createElement("p");
        fields.textContent = "涉及字段：" + head.input_fields.map(safeText).join("、");
        approvalQueueStatus.appendChild(fields);
      }
      if (Array.isArray(head.workspace_access) && head.workspace_access.length) {
        var paths = document.createElement("p");
        paths.textContent = "申请访问工作区外路径：" + head.workspace_access.map(safeText).join("、");
        approvalQueueStatus.appendChild(paths);
      }
      if (head.child_run_id) {
        var child = document.createElement("p");
        child.textContent = "子 Agent：" + safeText(head.child_run_id);
        approvalQueueStatus.appendChild(child);
      }

      var actions = document.createElement("div");
      actions.className = "approval-queue-actions";
      ["approve", "reject"].forEach(function (decision) {
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = decision === "approve" ? "允许当前项" : "拒绝当前项";
        button.disabled = !approvalQueueReady || approvalQueueRequestInFlight || approvalActionInFlight;
        button.addEventListener("click", function () {
          decideHeadSafetyReview(head, decision);
        });
        actions.appendChild(button);
      });
      approvalQueueStatus.appendChild(actions);
    }
    if (approvalQueueNotice) {
      var notice = document.createElement("p");
      notice.className = "approval-queue-notice";
      notice.textContent = safeText(approvalQueueNotice);
      approvalQueueStatus.appendChild(notice);
    }
  }

  async function refreshSafetyReviewQueue() {
    if (approvalQueueRequestInFlight) {
      approvalQueueRefreshRequested = true;
      return;
    }
    approvalQueueRequestInFlight = true;
    renderApprovalQueue();
    try {
      var response = await fetch(backendBaseUrl + "/agent/safety-reviews", {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var result = await response.json();
      var reviews = Array.isArray(result && result.reviews) ? result.reviews : [];
      pendingSafetyReviews = reviews.filter(function (review) {
        return review && safeText(review.review_id).trim() && review.status === "pending";
      });
      approvalQueueReady = true;
      if (!approvalActionInFlight) approvalQueueNotice = "";
    } catch (error) {
      var wasReady = approvalQueueReady;
      approvalQueueReady = false;
      approvalQueueNotice = wasReady && pendingSafetyReviews.length
        ? "审批队列刷新失败：" + safeText(error.message)
        : "";
    } finally {
      approvalQueueRequestInFlight = false;
      renderApprovalQueue();
      scheduleApprovalQueuePoll();
      if (approvalQueueRefreshRequested) {
        approvalQueueRefreshRequested = false;
        window.setTimeout(refreshSafetyReviewQueue, 0);
      }
    }
  }

  async function decideHeadSafetyReview(review, decision) {
    var head = pendingSafetyReviews[0];
    if (!review || !head || review.review_id !== head.review_id || approvalActionInFlight || !approvalQueueReady) return;
    approvalActionInFlight = true;
    approvalQueueNotice = "正在提交当前队列项…";
    renderApprovalQueue();
    try {
      var response = await fetch(backendBaseUrl + "/agent/safety-reviews/" + encodeURIComponent(head.review_id) + "/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: decision, reason: "用户通过 Agent 审批队列决定", decided_by: "user" })
      });
      if (response.status === 409) {
        approvalQueueNotice = "队列顺序已变化，已重新读取当前首项。";
        await refreshSafetyReviewQueue();
        renderApprovalQueue();
        return;
      }
      if (!response.ok) throw new Error("HTTP " + response.status);
      approvalQueueNotice = "";
      await refreshSafetyReviewQueue();
      setRunStatus(decision === "approve" ? "审批已通过，Agent 将继续执行。" : "审批已拒绝，Agent 将收到拒绝结果。");
    } catch (error) {
      var failureNotice = "审批提交失败：" + safeText(error.message);
      await refreshSafetyReviewQueue();
      approvalQueueNotice = failureNotice;
      renderApprovalQueue();
    } finally {
      approvalActionInFlight = false;
      renderApprovalQueue();
    }
  }

  function abortActiveAgentEventStream() {
    var controller = activeAgentEventController;
    activeAgentEventController = null;
    if (controller && !controller.signal.aborted) controller.abort();
  }

  function isTerminalRunStatus(status) {
    return ["completed", "failed", "cancelled", "timed_out"].indexOf(safeText(status)) >= 0;
  }

  async function readSavedRunStatus(runId, signal) {
    var response = await fetch(backendBaseUrl + "/agent/runs/" + encodeURIComponent(runId), { signal: signal });
    if (!response.ok) return "";
    var run = await response.json();
    return safeText(run && run.status).trim();
  }

  function waitForReconnectRetry(delayMs, signal) {
    return new Promise(function (resolve) {
      if (signal.aborted) return resolve(false);
      var timer = window.setTimeout(function () {
        signal.removeEventListener("abort", onAbort);
        resolve(!signal.aborted);
      }, delayMs);
      function onAbort() {
        window.clearTimeout(timer);
        resolve(false);
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function applySavedRunEvent(session, eventName, data, eventId, turnState) {
    var currentSession = rememberStreamPosition(session, data, eventId) || session;
    recordRunEvent(currentSession, eventName, data);
    var payload = data && data.payload && typeof data.payload === "object" ? data.payload : {};
    var answer = turnState ? turnState.answer : liveAnswers[currentSession.id] || "";
    if (eventName === "llm_delta" && payload.display_target === "assistant_answer") {
      answer = safeText(payload.content_snapshot || (answer + safeText(payload.delta)));
      var streamedBody = renderStreamingAnswer(currentSession, answer, false);
      if (turnState) { turnState.answer = answer; turnState.body = streamedBody; }
    } else if (eventName === "final_answer") {
      var metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
      if (typeof metadata.answer === "string" || (!answer && typeof data.message === "string")) {
        answer = metadata.answer || data.message;
        var finalBody = renderStreamingAnswer(currentSession, answer, true);
        if (turnState) { turnState.answer = answer; turnState.body = finalBody; }
      }
    }
    if (turnState) {
      if (eventName === "run_completed") turnState.terminalStatus = "completed";
      else if (eventName === "run_failed") turnState.terminalStatus = "failed";
      else if (eventName === "run_cancelled") turnState.terminalStatus = "cancelled";
      else if (eventName === "run_timed_out") turnState.terminalStatus = "timed_out";
      turnState.events.push(data);
    }
    if (isMultiAgentRefreshEvent(eventName)) fetchMultiAgentSnapshot(currentSession, currentSession.multiAgentRunId);
    if (isApprovalQueueRefreshEvent(eventName)) refreshSafetyReviewQueue();

    if (activeSessionId === currentSession.id) {
      if (eventName === "run_completed") setRunStatus("本轮完成");
      else if (eventName === "run_failed") setRunStatus(eventMessage(data) || "本轮失败", "error");
      else if (eventName === "run_cancelled") setRunStatus("本轮已取消");
      else if (eventName === "run_timed_out") setRunStatus("本轮已超时", "error");
      else if (eventName === "safety_review_required") {
        var review = data && data.payload && data.payload.review;
        if (review && review.mode === "manual" && review.status === "pending") {
          setRunStatus("等待安全审查确认", "review");
        }
      }
      else if (eventName.indexOf("subtask_") === 0 || eventName.indexOf("multi_agent_") === 0
        || eventName === "plan_created" || eventName === "plan_validated" || eventName === "replan_required") {
        setRunStatus(eventMessage(data) || "多 Agent 进度已更新");
      }
    }
    if (eventName === "run_completed") {
      reconcileCompletedSession(currentSession.id);
      return "completed";
    }
    if (eventName === "run_failed") return "failed";
    if (eventName === "run_cancelled") return "cancelled";
    if (eventName === "run_timed_out") return "timed_out";
    return "";
  }

  async function consumeSavedRunEventStream(session, controller, turnState) {
    var runId = session.multiAgentRunId;
    var afterSequence = Math.max(0, Number(session.multiAgentSequence) || 0);
    var url = backendBaseUrl + "/agent/runs/" + encodeURIComponent(runId)
      + "/stream?after_sequence=" + encodeURIComponent(afterSequence);
    var response = await fetch(url, { headers: { Accept: "text/event-stream" }, signal: controller.signal });
    if (response.status === 404 || response.status === 410) return { terminalStatus: "missing", missing: true };
    if (!response.ok) throw new Error("HTTP " + response.status + " " + response.statusText);
    if (!response.body) throw new Error("HTTP event stream unavailable");

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var terminalStatus = "";
    function consume(block) {
      var eventName = "message", eventId = "", dataLines = [];
      block.split(/\r?\n/).forEach(function (line) {
        if (line.indexOf("event:") === 0) eventName = line.slice(6).trim();
        else if (line.indexOf("id:") === 0) eventId = line.slice(3).trim();
        else if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).trim());
      });
      if (!dataLines.length) return;
      try {
        var data = JSON.parse(dataLines.join("\n"));
        if (controller.signal.aborted || activeSessionId !== session.id) return;
        terminalStatus = applySavedRunEvent(session, eventName, data, eventId, turnState) || terminalStatus;
      } catch (error) {
        setRunStatus("事件解析失败：" + error.message, "error");
      }
    }

    while (!terminalStatus && !controller.signal.aborted) {
      var part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      var blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      blocks.forEach(consume);
    }
    if (!terminalStatus && buffer.trim()) consume(buffer);
    if (terminalStatus) {
      try { await reader.cancel(); } catch (ignored) {}
    }
    return { terminalStatus: terminalStatus, closed: !terminalStatus && !controller.signal.aborted };
  }

  function finishReconnectedTurn(session, turnState, status) {
    if (!turnState || turnState.finalized || turnState.generation !== activeAgentTurnGeneration) return;
    turnState.finalized = true;
    if (status === "completed") {
      window.__petChatReceive({
        session_id: session.id,
        answer: turnState.answer || "本轮完成。",
        progress_events: turnState.events
      });
    } else if (status) {
      window.__petChatReceive({ session_id: session.id, error: "Agent run " + status + "." });
    }
  }

  async function reconnectSavedRun(session, turnState) {
    if (!session || !session.multiAgentRunId) return;
    if (typeof AbortController !== "function") {
      if (activeSessionId === session.id) setRunStatus("当前 WebView 不支持 Agent 事件流重连", "error");
      finishReconnectedTurn(session, turnState, "disconnected");
      return;
    }
    abortActiveAgentEventStream();
    var controller = new AbortController();
    activeAgentEventController = controller;
    var retryDelays = [400, 900, 1800, 3600];
    var runId = session.multiAgentRunId;
    var terminalStatus = "";
    try {
      for (var attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        if (controller.signal.aborted || activeSessionId !== session.id
          || (getSessionById(session.id) || session).multiAgentRunId !== runId) return;
        try {
          var currentSession = getSessionById(session.id) || session;
          var result = await consumeSavedRunEventStream(currentSession, controller, turnState);
          if (result.terminalStatus) {
            if (result.missing) {
              if (activeSessionId === session.id) setRunStatus("保存的 Agent 运行已不可用", "error");
              finishReconnectedTurn(session, turnState, "missing");
              return;
            }
            terminalStatus = result.terminalStatus;
            break;
          }
          if (controller.signal.aborted) return;
          terminalStatus = await readSavedRunStatus(runId, controller.signal);
          if (isTerminalRunStatus(terminalStatus)) break;
          throw new Error("Agent event stream closed before the run reached a terminal state");
        } catch (error) {
          if (controller.signal.aborted || (error && error.name === "AbortError")) return;
          if (attempt >= retryDelays.length) break;
          if (activeSessionId === session.id) setRunStatus("Agent 事件流断开，正在重连（" + (attempt + 1) + "/" + retryDelays.length + "）…");
          if (!await waitForReconnectRetry(retryDelays[attempt], controller.signal)) return;
        }
      }

      if (!terminalStatus) {
        try { terminalStatus = await readSavedRunStatus(runId, controller.signal); } catch (ignored) {}
      }
      if (isTerminalRunStatus(terminalStatus)) {
        if (activeSessionId === session.id) {
          if (terminalStatus === "completed") setRunStatus("本轮完成");
          else setRunStatus("本轮" + (terminalStatus === "failed" ? "失败" : terminalStatus === "cancelled" ? "已取消" : "已超时"), terminalStatus === "failed" || terminalStatus === "timed_out" ? "error" : "");
        }
        fetchMultiAgentSnapshot(session, runId);
        finishReconnectedTurn(session, turnState, terminalStatus);
        // A saved run may report completed after the cursor passed its final event.
        if (terminalStatus === "completed") reconcileCompletedSession(session.id);
      } else if (activeSessionId === session.id) {
        setRunStatus("Agent 事件流暂不可用，已停止自动重连；重新打开会话可继续恢复。", "error");
        if (turnState) finishReconnectedTurn(session, turnState, "disconnected");
      }
    } finally {
      if (activeAgentEventController === controller) activeAgentEventController = null;
    }
  }

  function reconnectActiveSavedRun() {
    var session = getActiveSession();
    if (session && session.multiAgentRunId) reconnectSavedRun(session, null);
  }

  async function refreshActiveRunState() {
    var session = getActiveSession();
    if (!session || !session.multiAgentRunId || pendingState || activeAgentEventController
        || ["running", "waiting"].indexOf(session.timelineState) < 0) return;
    var runId = session.multiAgentRunId;
    try {
      var status = await readSavedRunStatus(runId);
      var current = getActiveSession();
      if (!current || current.id !== session.id || current.multiAgentRunId !== runId) return;
      session = current;
      if (status === "completed") {
        recordRunEvent(session, "run_completed", {});
        setRunStatus("本轮完成");
        reconcileCompletedSession(session.id);
      } else if (isTerminalRunStatus(status)) {
        recordRunEvent(session, status === "failed" ? "run_failed" :
          status === "timed_out" ? "run_timed_out" : "run_cancelled", {});
        setRunStatus("本轮" + (status === "failed" ? "失败" : status === "timed_out" ? "超时" : "已取消"), "error");
      } else if (status) {
        reconnectSavedRun(session, null);
      }
    } catch (ignored) {}
  }

  function showSafetyReview(review, state) {
    if (!review || review.mode !== "manual" || review.status !== "pending") return;
    if (state) state.review = null;
    setRunStatus("安全审查已加入全局 FIFO 队列：" + safeText(review.tool_name || "工具调用"), "review");
    refreshSafetyReviewQueue();
  }

  function eventMessage(data) {
    var payload = data && data.payload && typeof data.payload === "object" ? data.payload : {};
    return safeText(data && (data.message || payload.message || payload.delta || payload.content_snapshot)).trim();
  }

  function timelineText(eventName, data) {
    if (eventName === "run_started") return "开始处理任务";
    if (eventName === "llm_started") return "正在分析任务";
    if (eventName === "tool_started") return "调用工具：" + safeText(data && (data.tool_name || data.payload && data.payload.tool_name) || "处理中");
    if (eventName === "safety_review_required") return "等待安全审查";
    if (eventName === "safety_review_decided") {
      var review = data && data.payload && data.payload.review || {};
      var result = review.status === "approved" ? "安全审批通过" : "安全审批未通过";
      return result + "：" + safeText(review.tool_name || "工具调用")
        + "；原因：" + safeText(review.decision_reason || review.reason || "未提供具体理由");
    }
    if (eventName === "final_answer") return "正在整理回答";
    if (eventName === "run_completed") return "任务完成";
    if (eventName === "run_failed") return eventMessage(data) || "任务失败";
    if (eventName === "run_cancelled") return "任务已取消";
    if (eventName === "run_timed_out") return "任务超时";
    return eventMessage(data);
  }

  function ensureLiveRunOutput(session, restoreAnswer) {
    var output = messages.querySelector(".agent-live-output");
    if (!output) {
      var created = createMessageElement("assistant", "正在处理…", false);
      output = created.article;
      output.classList.add("agent-live-output");
      messages.appendChild(output);
    }
    var body = output.querySelector(".message-content");
    var answer = liveAnswers[session.id] || "";
    body.hidden = !answer;
    if (restoreAnswer !== false && answer && body._petMarkdownSource !== answer) window.PetMarkdown.render(body, answer);
    return output;
  }

  function renderStreamingAnswer(session, answer, complete) {
    var first = !liveAnswers[session.id];
    liveAnswers[session.id] = answer;
    if (session.id !== activeSessionId) return null;
    var output = ensureLiveRunOutput(session, false);
    var body = output.querySelector(".message-content");
    body.hidden = !answer;
    if (complete || first) {
      if (!workMode && typeof window.__petQuickBeforeMessagesRender === "function") window.__petQuickBeforeMessagesRender();
      window.PetMarkdown.render(body, answer);
    } else window.PetMarkdown.schedule(body, answer);
    scrollMessagesToBottom();
    return body;
  }

  function processEventTime(data) {
    var timestamp = Date.parse(data && data.created_at || "");
    return isFinite(timestamp) ? timestamp : Date.now();
  }

  function recordProcessOutput(session, eventName, data) {
    var payload = data && data.payload && typeof data.payload === "object" ? data.payload : {};
    var runId = safeText(data && data.run_id || session.multiAgentRunId);
    var process = runProcesses[session.id];
    if (!process || (runId && process.runId !== runId)) {
      process = runProcesses[session.id] = { runId: runId, sequence: 0, entries: [], serial: 0 };
    }
    var sequence = Number(data && data.sequence) || 0;
    if (sequence && sequence <= process.sequence) return false;
    if (sequence) process.sequence = sequence;
    var entries = process.entries, entry = null, index;
    // Backend emits decoded, user-visible progress after validating a decision.
    // Raw agent_process deltas contain control JSON, never display text.
    if (eventName === "llm_delta" || eventName === "llm_completed" || eventName === "llm_failed") return false;
    if (eventName === "assistant_message") {
      var text = safeText(data && data.message).trim();
      if (!text) return false;
      var step = Number(payload.metadata && payload.metadata.step_index) || 0;
      if (step && entries.some(function (item) { return item.kind === "model" && item.step === step && item.content === text; })) return false;
      entries.push({ key: ++process.serial, type: "assistant_message", kind: "model", step: step,
        message: "过程说明", content: text, at: processEventTime(data) });
    } else if (eventName === "tool_started" || eventName === "tool_completed" || eventName === "tool_failed") {
      var toolName = safeText(data && data.tool_name || payload.tool_name) || "工具";
      if (eventName !== "tool_started") {
        for (index = entries.length - 1; index >= 0; index -= 1) {
          if (entries[index].kind === "tool" && entries[index].toolName === toolName && entries[index].status === "running") {
            entry = entries[index]; break;
          }
        }
      }
      if (!entry) {
        entry = { key: ++process.serial, type: eventName, kind: "tool", toolName: toolName,
          message: "调用工具：" + toolName, at: processEventTime(data), status: "running" };
        entries.push(entry);
      }
      entry.status = eventName === "tool_started" ? "running" : eventName === "tool_failed" ? "failed" :
        safeText(payload.status || data && data.status) || "ended";
      entry.message = (entry.status === "running" ? "调用工具：" : entry.status === "completed" ? "工具完成：" :
        entry.status === "failed" || entry.status === "error" ? "工具失败：" : "工具已结束：") + toolName;
    } else if (eventName === "safety_review_decided") {
      entries.push({ key: ++process.serial, type: eventName, kind: "review",
        message: truncateText(timelineText(eventName, data), 4000), at: processEventTime(data) });
    } else if (["run_started", "llm_started", "safety_review_required"].indexOf(eventName) >= 0) {
      var message = truncateText(timelineText(eventName, data), 180);
      if (!message) return false;
      entries.push({ key: ++process.serial, type: eventName, kind: "event", message: message, at: processEventTime(data) });
    } else return false;
    process.entries = entries.slice(-100);
    return true;
  }

  function renderProcessEntry(item, entry) {
    item.className = "run-process-entry run-process-" + (entry.kind || "event");
    item.setAttribute("data-process-key", String(entry.key || entry.at));
    if (entry.kind === "model") {
      var body = item.querySelector(".run-process-text");
      if (!body) {
        item.textContent = ""; body = document.createElement("div"); body.className = "run-process-text markdown-body";
        body.setAttribute("aria-label", "过程说明"); item.appendChild(body);
      }
      if (item._processSource !== entry.content) {
        item._processSource = entry.content;
        window.PetMarkdown.render(body, entry.content);
      }
    } else if (entry.kind === "tool") {
      var heading = item.querySelector(".run-process-heading");
      if (!heading) {
        item.textContent = ""; heading = document.createElement("div"); heading.className = "run-process-heading";
        var label = document.createElement("span"), badge = document.createElement("span");
        label.className = "run-process-label"; badge.className = "run-process-state";
        heading.appendChild(label); heading.appendChild(badge); item.appendChild(heading);
      }
      heading.querySelector(".run-process-label").textContent = entry.toolName;
      var badge = heading.querySelector(".run-process-state");
      badge.textContent = { failed: "失败", error: "失败", completed: "完成", rejected: "未执行", blocked: "受阻",
        cancelled: "已取消", timed_out: "超时", timeout: "超时" }[entry.status] ||
        (entry.status === "running" ? "调用中" : "已结束");
      badge.setAttribute("data-status", entry.status);
    } else item.textContent = entry.message || entry.type || "步骤已完成";
  }

  function renderRunTimeline(session) {
    if (!runTimeline || !runTimelineList) return;
    if (!workMode && typeof window.__petQuickBeforeMessagesRender === "function") window.__petQuickBeforeMessagesRender();
    var storedEvents = session && Array.isArray(session.timelineEvents) ? session.timelineEvents : [];
    var process = session && runProcesses[session.id];
    var events = process && process.entries.length ? process.entries : storedEvents;
    var outputBlocks = events.filter(function (entry) { return entry.kind === "tool" || entry.kind === "review" || entry.kind === "model" && entry.content; });
    if (outputBlocks.length) events = outputBlocks;
    else events = events.slice(-1);
    var state = session && session.timelineState || "";
    var active = state === "running" || state === "waiting";
    var hasFinal = storedEvents.some(function (item) { return item.type === "final_answer"; });
    var visible = active && !hasFinal;
    document.body.classList.toggle("run-progress-inline", visible);
    runTimeline.hidden = !visible;
    if (!visible) {
      runTimeline.remove();
      if (session && liveAnswers[session.id]) ensureLiveRunOutput(session);
      return;
    }
    var output = ensureLiveRunOutput(session);
    output.querySelector(".bubble").insertBefore(runTimeline, output.querySelector(".message-content"));
    var key = session.id;
    if (timelineViewKey !== key) { runTimeline.open = true; timelineViewKey = key; }
    var latest = process && process.entries.length ? process.entries[process.entries.length - 1] : events[events.length - 1];
    var preview = latest && latest.kind === "model" && latest.content ?
      truncateText(latest.content.trim().replace(/\s+/g, " "), 140) :
      latest ? latest.message || latest.type : "开始处理任务";
    runTimelineSummary.textContent = runTimeline.open ? "收起过程" : preview;
    runTimelineSummary.setAttribute("aria-live", "polite");
    runTimelineSummary.title = runTimeline.open ? "收起本轮过程" : "展开过程说明与工具调用";
    var existing = Array.prototype.slice.call(runTimelineList.children);
    events.forEach(function (event, index) {
      var key = String(event.key || event.at);
      var item = existing.find(function (node) { return node.getAttribute("data-process-key") === key; });
      if (!item) item = document.createElement("li");
      renderProcessEntry(item, event);
      if (index === events.length - 1) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
      if (runTimelineList.children[index] !== item) runTimelineList.insertBefore(item, runTimelineList.children[index] || null);
    });
    while (runTimelineList.children.length > events.length) runTimelineList.lastElementChild.remove();
  }
  if (runTimeline) runTimeline.addEventListener("toggle", function () {
    runTimelineSummary.title = runTimeline.open ? "收起本轮过程" : "展开过程说明与工具调用";
    renderRunTimeline(getActiveSession());
  });

  function recordRunEvent(session, eventName, data) {
    if (!session || eventName === "heartbeat") return;
    var processChanged = recordProcessOutput(session, eventName, data);
    if (eventName === "llm_delta") return;
    var message = truncateText(timelineText(eventName, data), eventName === "safety_review_decided" ? 4000 : 180);
    if (!message) {
      if (processChanged && session.id === activeSessionId) renderRunTimeline(getSessionById(session.id) || session);
      return;
    }
    var live = getSessionById(session.id) || session;
    if (!Array.isArray(live.timelineEvents)) live.timelineEvents = [];
    var last = live.timelineEvents[live.timelineEvents.length - 1];
    if (!last || last.type !== eventName || last.message !== message) {
      live.timelineEvents.push({ type: eventName, message: message, at: Date.now() });
      live.timelineEvents = live.timelineEvents.slice(-100);
    }
    if (eventName === "safety_review_required") live.timelineState = "waiting";
    else if (eventName === "run_completed") live.timelineState = "completed";
    else if (eventName === "run_failed" || eventName === "run_timed_out") live.timelineState = "failed";
    else if (eventName === "run_cancelled") live.timelineState = "cancelled";
    else if (eventName === "run_started" || eventName === "llm_started" || eventName === "tool_started") live.timelineState = "running";
    if (activeSessionId === live.id) {
      renderRunTimeline(live);
      if (eventName === "safety_review_decided") {
        var review = data && data.payload && data.payload.review || {};
        setRunStatus(message + (review.status === "rejected" ? "。可在下一条消息中明确授权这项操作后重试。" : ""),
          review.status === "rejected" ? "error" : "");
      }
    }
    if (["run_completed", "run_failed", "run_timed_out", "run_cancelled"].indexOf(eventName) >= 0) delete runProcesses[live.id];
    persistSessions();
  }

  function handleStreamEvent(eventName, data, state) {
    recordRunEvent(state.session, eventName, data);
    var payload = data && data.payload && typeof data.payload === "object" ? data.payload : {};
    if (eventName === "llm_delta" && payload.display_target === "assistant_answer") {
      state.answer = safeText(payload.content_snapshot || (state.answer + safeText(payload.delta)));
      state.body = renderStreamingAnswer(state.session, state.answer, false);
      setRunStatus("正在生成回答…");
      scrollMessagesToBottom();
      return;
    }
    if (eventName === "final_answer") {
      var finalMetadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
      if (typeof finalMetadata.answer === "string" || (!state.answer && typeof data.message === "string")) {
        state.answer = finalMetadata.answer || data.message;
        state.body = renderStreamingAnswer(state.session, state.answer, true);
      }
    }
    if (eventName === "safety_review_required") {
      var review = payload.safety_review || payload.review || payload;
      if (review.mode === "manual" && review.status === "pending") {
        state.review = review;
        setRunStatus("等待安全审查确认：" + (review.tool_name || "工具调用"), "review");
      } else {
        setRunStatus(review.mode === "llm" ? "正在进行模型安全审查…" : "安全审查已自动通过");
      }
      return;
    }
    if (["run_completed", "run_failed", "run_cancelled", "run_timed_out"].indexOf(eventName) >= 0) {
      state.terminal = true;
      state.terminalStatus = eventName === "run_completed" ? "completed"
        : eventName === "run_failed" ? "failed"
          : eventName === "run_cancelled" ? "cancelled" : "timed_out";
    }
    if (eventName === "run_started") setRunStatus("Agent 已启动");
    else if (eventName === "llm_started") setRunStatus("LLM：" + (data.stage || "处理中") + "…");
    else if (eventName === "tool_started") setRunStatus("正在调用工具：" + (data.tool_name || payload.tool_name || "处理中"));
    else if (eventName === "run_completed") setRunStatus("本轮完成");
    else if (eventName === "run_failed") setRunStatus(eventMessage(data) || "本轮失败", "error");
    else if (eventName !== "heartbeat" && eventMessage(data)) setRunStatus(eventMessage(data));
    state.events.push(data);
  }

  function sendAgentTurnViaDesktopBridge(payload) {
    if (!window.petBridge || typeof window.petBridge.send !== "function") {
      return false;
    }
    window.petBridge.send(JSON.stringify({
      question: payload.question || payload.user_input || "",
      conversation_id: payload.conversation_id || payload.session_id,
      session_id: payload.session_id || payload.conversation_id,
      mode: payload.mode || "wait",
      attachment_ids: payload.attachment_ids || [],
      llm_client: runSettings.llmClient || "",
      llm_model: runSettings.llmModel || "",
      safety_review_mode: payload.safety_review_mode || ""
    }));
    return true;
  }

  function sendAgentStreamViaDesktopBridge(payload, onEvent) {
    if (!window.petBridge || typeof window.petBridge.stream !== "function") return false;
    window.__petChatReceiveStream = onEvent;
    window.petBridge.stream(JSON.stringify({
      question: payload.question || payload.user_input || "",
      conversation_id: payload.conversation_id || payload.session_id,
      attachment_ids: payload.attachment_ids || [],
      llm_client: runSettings.llmClient || "",
      llm_model: runSettings.llmModel || "",
      safety_review_mode: payload.safety_review_mode || ""
    }));
    return true;
  }

  function createdBackendSessionId(response) {
    return safeText(response && (response.session_id || (response.session && response.session.session_id))).trim();
  }

  function replaceSessionId(session, newId) {
    var oldId = session.id;
    window.LkaImageComposer.rekey(oldId, newId);
    var oldDraft = readDraft(oldId);
    var liveSession = getSessionById(oldId);
    session.id = newId;
    session.conversation_id = newId;
    if (liveSession) {
      liveSession.id = newId;
      liveSession.conversation_id = newId;
      liveSession.workspace = session.workspace;
    }
    if (Object.prototype.hasOwnProperty.call(liveAnswers, oldId)) {
      liveAnswers[newId] = liveAnswers[oldId]; delete liveAnswers[oldId];
    }
    if (runProcesses[oldId]) { runProcesses[newId] = runProcesses[oldId]; delete runProcesses[oldId]; }
    if (activeSessionId === oldId) activeSessionId = newId;
    if (pendingState && pendingState.conversationId === oldId) pendingState.conversationId = newId;
    if (oldDraft) {
      writeDraft(newId, oldDraft);
      writeDraft(oldId, "");
    }
    persistSessions();
  }

  async function bindSessionWorkspace(session, requestedWorkspace, assertCurrent) {
    var workspace = requestedWorkspace === undefined ? session.workspace : requestedWorkspace;
    var key = session.id + "\n" + (workspace || "");
    if (workspaceBindings[key]) return workspaceBindings[key];
    var binding = bindSessionWorkspaceNow(session, requestedWorkspace, assertCurrent);
    workspaceBindings[key] = binding;
    try { return await binding; }
    finally { if (workspaceBindings[key] === binding) delete workspaceBindings[key]; }
  }

  async function bindSessionWorkspaceNow(session, requestedWorkspace, assertCurrent) {
    if (assertCurrent) assertCurrent();
    var workspace = requestedWorkspace === undefined ? session.workspace : requestedWorkspace;
    if (!workspace) return session.id;
    if (session.backendWorkspace === workspace) return session.id;
    if (window.petBridge && typeof window.petBridge.setSessionWorkspace === "function") {
      var bridgeResult = JSON.parse(window.petBridge.setSessionWorkspace(session.id, workspace) || "{}");
      if (bridgeResult.error && bridgeResult.error.indexOf("HTTP 404") >= 0 && typeof window.petBridge.createSession === "function") {
        if (assertCurrent) assertCurrent(true);
        var createdByBridge = JSON.parse(window.petBridge.createSession(session.title || "新会话") || "{}");
        var bridgeSessionId = createdBackendSessionId(createdByBridge);
        if (createdByBridge.error || !bridgeSessionId) throw new Error(createdByBridge.error || "后端创建会话响应缺少 session.session_id");
        replaceSessionId(session, bridgeSessionId);
        if (session.title_is_custom && typeof window.petBridge.renameSession === "function") {
          var renamedByBridge = JSON.parse(window.petBridge.renameSession(bridgeSessionId, session.title) || "{}");
          if (renamedByBridge.error) throw new Error(renamedByBridge.error);
        }
        bridgeResult = JSON.parse(window.petBridge.setSessionWorkspace(session.id, workspace) || "{}");
      }
      if (bridgeResult.error) throw new Error(bridgeResult.error);
      session.project_id = bridgeResult.project_id || "";
      session.backendWorkspace = workspace;
      session.workspace = workspace;
      var bridgeLiveSession = getSessionById(session.id);
      if (bridgeLiveSession) { bridgeLiveSession.project_id = session.project_id; bridgeLiveSession.backendWorkspace = workspace; bridgeLiveSession.workspace = workspace; }
      persistSessions();
      if (session.id === activeSessionId) renderWorkspaceSummary(session);
      return session.id;
    }
    var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(session.id) + "/workspace", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: workspace, platform: workspace.charAt(0) === "/" ? "linux" : "windows" })
    });
    if (assertCurrent) assertCurrent();
    if (response.status === 404) {
      if (assertCurrent) assertCurrent(true);
      var createResponse = await fetch(backendBaseUrl + "/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: session.title || "新会话", metadata: {
          source_frontend: "windows-pet", title_is_custom: !!session.title_is_custom,
          explicit_workspace: !!session.workspace_is_custom
        } })
      });
      var created = await createResponse.json();
      var createdSessionId = createdBackendSessionId(created);
      if (!createResponse.ok || !createdSessionId) throw new Error("HTTP " + createResponse.status + ": 后端创建会话响应缺少 session.session_id");
      replaceSessionId(session, createdSessionId);
      response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(session.id) + "/workspace", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: workspace, platform: workspace.charAt(0) === "/" ? "linux" : "windows" })
      });
    }
    var data = await response.json();
    if (!response.ok) throw new Error("HTTP " + response.status + ": " + (data.detail || "workspace binding failed"));
    session.project_id = data.project_id || "";
    session.backendWorkspace = workspace;
    session.workspace = workspace;
    var liveSession = getSessionById(session.id);
    if (liveSession) { liveSession.project_id = session.project_id; liveSession.backendWorkspace = workspace; liveSession.workspace = workspace; }
    persistSessions();
    if (session.id === activeSessionId) renderWorkspaceSummary(session);
    return session.id;
  }

  async function sendQuestion(question) {
    var cleaned = safeText(question).trim();
    if (!cleaned && !window.LkaImageComposer.hasAttachments(activeSessionId)) {
      focusComposer();
      return;
    }

    var session = getActiveSession();
    if (!session) {
      session = ensureActiveSession();
      if (!session) {
        return;
      }
    }

    var fileOnly = window.LkaImageComposer.hasDocuments(session.id);
    var selectedImages = window.LkaImageComposer.capture(session.id);
    var imageMessageId = "input-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    var requestStarted = false;
    activeAgentTurnGeneration += 1;
    var turnGeneration = activeAgentTurnGeneration;
    abortActiveAgentEventStream();

    touchSession(session);
    liveAnswers[session.id] = "";
    delete runProcesses[session.id];
    timelineViewKey = "";
    session.timelineEvents = [];
    session.timelineState = "running";
    recordRunEvent(session, "run_started", {});

    addMessageToSession(session, "user", cleaned || (fileOnly ? "[File input]" : "[Image input]"), false, { attachments: selectedImages, clientId: imageMessageId });
    applySessionTitle(session);
    touchSession(session);
    pinSessionToTop(session.id);
    persistSessions();
    renderSessionList();
    renderActiveMessages();

    var liveBody = ensureLiveRunOutput(session).querySelector(".message-content");
    setComposerDisabled(true);
    pendingState = {
      conversationId: session.id,
      generation: turnGeneration
    };

    if (workMode) {
      // History appends scroll before the live output and progress change the
      // layout. An explicit send must reveal the whole new turn after those
      // changes, without moving a different session if the user switches.
      scrollMessagesToBottom();
      window.requestAnimationFrame(function () {
        if (turnGeneration === activeAgentTurnGeneration && session.id === activeSessionId) scrollMessagesToBottom();
      });
    }

    var payload = {
      question: cleaned,
      conversation_id: session.id,
      session_id: session.id,
      mode: "wait"
    };

    try {
      saveRunSettings();
      if (!await workspaceSwitchPromise) throw new Error("工作区切换失败，请检查路径后重试");
      await ensureSessionWorkspace(session);
      var boundSessionId = await bindSessionWorkspace(session);
      session = getSessionById(boundSessionId) || session;
      payload.session_id = boundSessionId;
      payload.conversation_id = boundSessionId;
      payload.attachment_ids = await window.LkaImageComposer.prepare(selectedImages, boundSessionId);
      var imageMessage = session.messages.find(function (item) { return item.clientId === imageMessageId; });
      if (imageMessage) imageMessage.attachments = window.LkaImageComposer.normalize(selectedImages);
      persistSessions();
      if (session.id === activeSessionId && selectedImages.length) { renderActiveMessages(); liveBody = ensureLiveRunOutput(session).querySelector(".message-content"); }
      requestStarted = true;
      payload.safety_review_mode = runSettings.safetyMode === "backend" ? "" : runSettings.safetyMode;
      if (!runSettings.stream && sendAgentTurnViaDesktopBridge(payload)) {
        console.log("[pet-chat] sent through desktop bridge:", backendBaseUrl, payload);
        return;
      }
      console.log("[pet-chat] streaming LKA agent turn:", backendBaseUrl, payload);
      if (runSettings.stream) {
        var streamState = {
          answer: "", body: liveBody, events: [], review: null, session: session,
          generation: turnGeneration, initialRunId: session.multiAgentRunId, terminal: false
        };
        try {
          var onStreamEvent = function (eventName, data, eventId) {
            if (turnGeneration !== activeAgentTurnGeneration) return;
            session = rememberStreamPosition(session, data, eventId) || session;
            streamState.session = session;
            if (isMultiAgentRefreshEvent(eventName)) fetchMultiAgentSnapshot(session, session.multiAgentRunId);
            if (isApprovalQueueRefreshEvent(eventName)) refreshSafetyReviewQueue();
            handleStreamEvent(eventName, data, streamState);
            if (streamState.review) showSafetyReview(streamState.review, streamState);
            if (streamState.viaBridge && eventName === "run_completed") {
              window.__petChatReceive({ session_id: session.id,
                answer: streamState.answer || "本轮没有生成可显示的回答。", progress_events: streamState.events });
              reconcileCompletedSession(session.id);
            }
          };
          if (sendAgentStreamViaDesktopBridge(payload, onStreamEvent)) {
            streamState.viaBridge = true;
            return;
          }
          var turnController = typeof AbortController === "function" ? new AbortController() : null;
          if (turnController) activeAgentEventController = turnController;
          try {
            await callAgentTurnStream(payload, onStreamEvent, turnController && turnController.signal);
          } finally {
            if (turnController && activeAgentEventController === turnController) activeAgentEventController = null;
          }
          if (!streamState.terminal && session.multiAgentRunId && session.multiAgentRunId !== streamState.initialRunId) {
            setRunStatus("Agent 事件流结束，正在恢复运行状态…");
            await reconnectSavedRun(session, streamState);
            return;
          }
          if (streamState.terminalStatus && streamState.terminalStatus !== "completed") {
            window.__petChatReceive({ session_id: session.id, error: "Agent run " + streamState.terminalStatus + "." });
            return;
          }
        } catch (streamError) {
          if (turnGeneration !== activeAgentTurnGeneration || (streamError && streamError.name === "AbortError")) return;
          if (session.multiAgentRunId && session.multiAgentRunId !== streamState.initialRunId) {
            setRunStatus("Agent 事件流中断，正在恢复运行状态…");
            await reconnectSavedRun(session, streamState);
            return;
          }
          if ((!payload.attachment_ids.length && safeText(streamError.message).indexOf("HTTP 422") >= 0) || safeText(streamError.message).indexOf("stream unavailable") >= 0) {
            if (sendAgentTurnViaDesktopBridge(payload)) {
              setRunStatus("WebView 流式请求不兼容，已切换桌面桥接兼容模式…");
              return;
            }
            setRunStatus("流式入口不可用，已切换兼容模式…");
            var fallbackResult = await callAgentTurn(payload);
            window.__petChatReceive(fallbackResult);
            return;
          }
          throw streamError;
        }
        window.__petChatReceive({ session_id: session.id,
          answer: streamState.answer || "本轮没有生成可显示的回答。", progress_events: streamState.events });
        reconcileCompletedSession(session.id);
      } else {
        var result = await callAgentTurn(payload);
        window.__petChatReceive(result);
      }
    } catch (error) {
      if (turnGeneration !== activeAgentTurnGeneration || (error && error.name === "AbortError")) return;
      if (!requestStarted) window.LkaImageComposer.restore(selectedImages, session.id);
      var failureText = "Backend request failed: " + (error && error.message ? error.message : String(error));
      recordRunEvent(session, "run_failed", { message: failureText });
      setRunStatus("发送失败：" + (error && error.message ? error.message : String(error)), "error");
      if (isBackendOfflineError(failureText) || failureText.indexOf("Failed to fetch") >= 0) {
        setBackendOfflineState(true, "后端未连接：" + failureText + "。请确认 LKA backend 正在运行：" + backendBaseUrl);
      }
      addMessageToSession(session, "assistant", failureText, true);
      pendingState = null;
      setComposerDisabled(backendOffline);
      touchSession(session);
      pinSessionToTop(session.id);
      renderSessionList();
      renderActiveMessages();
      persistSessions();
      focusComposer();
    }
  }

  async function reconcileCompletedSession(sessionId) {
    if (!sessionId) return;
    try {
      var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(sessionId), {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) return;
      var remote = sessionFromBackendDetail(await response.json());
      if (!remote || !remote.messages.length
          || remote.messages[remote.messages.length - 1].role !== "assistant"
          || remote.messages[remote.messages.length - 1].text === defaultGreetingMessage().text) return;
      var existing = getSessionById(sessionId);
      if (!existing || (pendingState && pendingState.conversationId === sessionId)) return;
      // Backend history is authoritative once the run has completed.
      delete liveAnswers[sessionId];
      existing.messages = remote.messages;
      touchSession(existing);
      if (activeSessionId === sessionId) renderActiveMessages();
      persistSessions();
    } catch (error) {
      console.warn("[pet-chat] answer reconciliation failed", error);
    }
  }

  function submitCurrentInput() {
    if (pendingState || backendOffline || sendButton.disabled) return;
    var now = Date.now();
    if (now - lastSubmitAt < 260) {
      return;
    }
    lastSubmitAt = now;

    var question = input.value;
    if (!question.trim() && !window.LkaImageComposer.hasAttachments(activeSessionId)) { window.LkaImageComposer.explainEmpty(); return; }
    input.value = "";
    writeDraft(activeSessionId, "");
    sendQuestion(question);
  }

  window.__petChatReceive = function (result) {
    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch (ignored) {
        result = { answer: result };
      }
    }

    var responseConversationId = normalizeConversationId(
      (result && (result.session_id || result.conversation_id)) || (pendingState && pendingState.conversationId) || activeSessionId
    );
    if (deletedSessionIds[responseConversationId]) return;
    var session = getOrCreateSessionById(responseConversationId);
    if (!session) {
      setComposerDisabled(false);
      pendingState = null;
      return;
    }

    // Keep frontend id aligned with backend conversation id.
    session.id = responseConversationId;
    session.conversation_id = responseConversationId;

    var pendingApproval = normalizePendingApproval(result && result.pending_approval);
    var hasStructuredApproval = !!pendingApproval;
    var hasAnswerText = !!safeText(result && result.answer).trim();
    var shouldTreatAsHardError = !!(result && result.error) && !hasStructuredApproval && !hasAnswerText;

    if (shouldTreatAsHardError) {
      var errorText = "Request failed: " + result.error;
      recordRunEvent(session, "run_failed", { message: errorText });
      if (isBackendOfflineError(result.error)) {
        setBackendOfflineState(true, "后端未连接：" + result.error);
      }
      addMessageToSession(session, "assistant", errorText, true);
    } else {
      if (hasAnswerText) recordRunEvent(session, "run_completed", {});
      setBackendOfflineState(false, "");
      var backendMessages = normalizeBackendMessages(result && result.messages);
      if (pendingApproval) {
        // Approval flow: avoid noisy backend status text and only render approval card.
      } else {
        var answerText = safeText(extractAnswer(result)).trim();
        if (answerText) {
          addMessageToSession(session, "assistant", answerText, false, buildAgentRunDetails(result));
        } else if (!session.messages || !session.messages.length) {
          // Use backend history only as a bootstrap fallback for an empty local session.
          if (backendMessages.length) {
            session.messages = backendMessages;
          }
        }
      }
      if (pendingApproval) {
        var existedPending = findPendingApprovalMessage(session, pendingApproval.approval_id);
        if (!existedPending) {
          addMessageToSession(
            session,
            "assistant",
            "",
            false,
            { pendingApproval: pendingApproval }
          );
        }
      }
    }

    if (hasAnswerText || shouldTreatAsHardError) { delete liveAnswers[session.id]; delete runProcesses[session.id]; }
    applySessionTitle(session);
    touchSession(session);
    pinSessionToTop(session.id);
    renderSessionList();

    if (!activeSessionId || activeSessionId === (pendingState && pendingState.conversationId)) {
      activeSessionId = session.id;
    }
    if (activeSessionId === session.id) {
      renderActiveMessages();
    } else {
      renderActiveSessionMeta();
    }
    persistSessions();

    pendingState = null;
    setComposerDisabled(backendOffline);
    focusComposer();
  };

  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      submitCurrentInput();
    });
  }

  sendButton.addEventListener("click", function (event) {
    event.preventDefault();
    submitCurrentInput();
  });

  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      if (document.body.classList.contains("mobile-workbench")
          && window.matchMedia("(pointer: coarse)").matches && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      submitCurrentInput();
    }
  });
  // JavaFX WebView can still perform the textarea default action after keydown.
  input.addEventListener("beforeinput", function (event) {
    if (event.inputType === "insertLineBreak" && !event.isComposing
        && Date.now() - lastSubmitAt < 500) event.preventDefault();
  });
  window.__petChatSubmitCurrentInput = submitCurrentInput;
  window.__petChatSubmitText = function (text) {
    if (pendingState || backendOffline || sendButton.disabled) return false;
    if (!safeText(text).trim() && !window.LkaImageComposer.hasAttachments(activeSessionId)) { window.LkaImageComposer.explainEmpty(); return false; }
    writeDraft(activeSessionId, "");
    sendQuestion(text);
    return true;
  };

  input.addEventListener("input", function () { writeDraft(activeSessionId, input.value); });

  if (toggleSidebarButton) {
    toggleSidebarButton.addEventListener("click", function () {
      if (!chatShell) {
        return;
      }
      if (sidebarDocked()) setWorkbenchPanelVisible("sidebar", !panelVisibility.sidebar);
      else setSidebarOpen(!chatShell.classList.contains("sidebar-open"));
    });
  }

  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", function () {
      setSidebarOpen(false);
    });
  }

  if (newSessionButton) {
    newSessionButton.addEventListener("click", function () {
      createAndSwitchNewSession();
    });
  }

  if (newQuickSessionButton) newQuickSessionButton.addEventListener("click", createAndSwitchNewSession);
  if (undoDeleteButton) undoDeleteButton.addEventListener("click", function () {
    if (undoSessionId) restoreSession(undoSessionId);
  });
  if (dismissUndoButton) dismissUndoButton.addEventListener("click", hideUndoToast);
  if (sessionSearchInput) {
    sessionSearchInput.addEventListener("input", function () {
      if (historySearchTimer) window.clearTimeout(historySearchTimer);
      historyRequestGeneration += 1;
      historyLoading = false;
      historyHasMore = false;
      historyError = "";
      if (viewingDeletedSessions) deletedHistoryItems = [];
      else historyItems = [];
      renderSessionList();
      historySearchTimer = window.setTimeout(function () { loadHistoryPage(true); }, 240);
    });
    sessionSearchInput.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown") {
        var first = sessionList && sessionList.querySelector(".session-open, .deleted-session .session-mini");
        if (first) { event.preventDefault(); first.focus(); }
      } else if (event.key === "Escape" && sessionSearchInput.value) {
        sessionSearchInput.value = "";
        loadHistoryPage(true);
      }
    });
  }
  if (loadMoreSessionsButton) loadMoreSessionsButton.addEventListener("click", function () { loadHistoryPage(false); });
  if (sessionList) sessionList.addEventListener("keydown", function (event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    var links = Array.from(sessionList.querySelectorAll(".session-open, .deleted-session .session-mini"));
    var index = links.indexOf(document.activeElement);
    var next = links[Math.max(0, Math.min(links.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next) { event.preventDefault(); next.focus(); }
  });
  if (toggleDeletedSessionsButton) toggleDeletedSessionsButton.addEventListener("click", function () {
    viewingDeletedSessions = !viewingDeletedSessions;
    if (sessionSearchInput) sessionSearchInput.value = "";
    renderSessionList();
    if (viewingDeletedSessions) refreshDeletedSessions();
    loadHistoryPage(true);
  });
  window.__petChatBridgeReady = function () {
    document.body.classList.add("native-composer");
    setComposerDisabled(backendOffline || !!pendingState);
    var session = getActiveSession();
    if (!session || session.workspace || bridgeWorkspaceRetryScheduled) return;
    bridgeWorkspaceRetryScheduled = true;
    var pending = workspaceRequests[session.id];
    var retry = function () {
      setTimeout(function () {
        bridgeWorkspaceRetryScheduled = false;
        if (!session.workspace) prepareSessionWorkspace(session);
      }, 0);
    };
    if (pending) pending.then(retry, retry);
    else retry();
  };
  async function openCurrentWorkbench() {
    if (workbenchOpening) return false;
    var session = getActiveSession();
    if (!session) return false;
    workbenchOpening = true;
    if (openWorkbenchButton) openWorkbenchButton.disabled = true;
    if (continueWorkbenchButton) continueWorkbenchButton.disabled = true;
    var nativeOpener = window.petBridge && typeof window.petBridge.openWorkbenchSession === "function";
    var browserWindow = null;
    try {
      // Reserve the browser window during the click, before any asynchronous binding.
      if (!nativeOpener) {
        browserWindow = window.open("about:blank", "lka-workbench", "width=1320,height=840");
        if (!browserWindow) throw new Error("浏览器阻止了弹窗，请允许打开工作台后重试");
      }
      saveCurrentDraft();
      var sessionId = "";
      // An untouched new task stays local; opening the workbench must not create
      // an empty database session. Existing conversations keep their exact ID.
      if (getSessionMessageCount(session) > 0 || session.backendWorkspace) {
        if (!await workspaceSwitchPromise) throw new Error("工作区切换失败，请检查路径后重试");
        await ensureSessionWorkspace(session);
        sessionId = await bindSessionWorkspace(session);
      }
      persistSessions();
      if (nativeOpener) {
        window.petBridge.openWorkbenchSession(sessionId, session.multiAgentRunId || "");
      } else {
        browserWindow.location.href = "/desktop-pet/chat.html?mode=work&backend=" + encodeURIComponent(backendBaseUrl)
          + (sessionId ? "&session_id=" + encodeURIComponent(sessionId) : "")
          + (session.multiAgentRunId ? "&run_id=" + encodeURIComponent(session.multiAgentRunId) : "");
        if (!workMode) window.close();
      }
      setRunStatus("已在工作台打开当前任务");
      return true;
    } catch (error) {
      if (browserWindow && browserWindow.location.href === "about:blank") browserWindow.close();
      setRunStatus("无法打开工作台：" + safeText(error.message || error), "error");
      return false;
    } finally {
      workbenchOpening = false;
      if (openWorkbenchButton) openWorkbenchButton.disabled = false;
      renderActiveSessionMeta();
    }
  }
  window.__petChatOpenWorkbench = openCurrentWorkbench;
  if (openWorkbenchButton) openWorkbenchButton.addEventListener("click", openCurrentWorkbench);
  if (continueWorkbenchButton) continueWorkbenchButton.addEventListener("click", openCurrentWorkbench);

  async function openRequestedSession() {
    if (!requestedSessionId) { openFreshTask(); return; }
    var session = getSessionById(requestedSessionId);
    if (!session) {
      try {
        var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(requestedSessionId));
        if (!response.ok) throw new Error("HTTP " + response.status);
        session = sessionFromBackendDetail(await response.json());
        if (!session) throw new Error("会话内容无效");
        sessions.unshift(session);
        normalizeSessionBounds();
      } catch (error) {
        openFreshTask();
        setRunStatus("无法继续原任务：" + safeText(error.message || error), "error");
        return;
      }
    }
    if (requestedRunId && session.multiAgentRunId !== requestedRunId) {
      session.multiAgentRunId = requestedRunId;
      session.multiAgentSequence = 0;
      session.timelineState = "running";
    }
    activeSessionId = session.id;
    showDraftForSession(session);
    fileRelativePath = "";
    renderSessionList();
    renderActiveMessages();
    renderWorkspaceSummary(session);
    refreshActiveMultiAgentSnapshot();
    reconnectActiveSavedRun();
    loadFileList();
    persistSessions();
    focusComposer();
  }
  function setSettingsOpen(open) {
    if (railDocked()) setWorkbenchPanelVisible("rail", open);
    else if (chatShell) chatShell.classList.toggle("settings-open", !!open);
    syncWorkbenchPanels();
    if (open && !desktopPanels) setRailTab("settings");
    if (open && workspaceInput && filesPanel.hidden) workspaceInput.focus();
  }
  if (filesTabButton) filesTabButton.addEventListener("click", function () { setRailTab("files"); });
  if (settingsTabButton) settingsTabButton.addEventListener("click", function () { setRailTab("settings"); });
  if (fileUpButton) fileUpButton.addEventListener("click", function () {
    fileRelativePath = fileRelativePath.split("/").slice(0, -1).join("/");
    loadFileList();
  });
  if (refreshFilesButton) refreshFilesButton.addEventListener("click", loadFileList);
  function panelSize(side) {
    return parseInt(getComputedStyle(document.body).getPropertyValue(side === "sidebar" ? "--sidebar-width" : "--rail-width"), 10)
      || (side === "sidebar" ? 250 : 290);
  }

  function setPanelSize(side, requested) {
    var other = panelSize(side === "sidebar" ? "rail" : "sidebar");
    var min = side === "sidebar" ? 210 : 250;
    var max = side === "sidebar" ? 380 : 520;
    var otherVisible = !desktopPanels || (side === "sidebar" ? railDocked() && panelVisibility.rail : sidebarDocked() && panelVisibility.sidebar);
    var centerReserve = window.innerWidth > 1180 && otherVisible ? other + 420 : 420;
    var value = Math.max(min, Math.min(max, window.innerWidth - centerReserve, Math.round(requested)));
    document.body.style.setProperty(side === "sidebar" ? "--sidebar-width" : "--rail-width", value + "px");
    try {
      localStorage.setItem(panelSizeKey, JSON.stringify({ sidebar: panelSize("sidebar"), rail: panelSize("rail") }));
    } catch (ignored) {}
  }

  function installPanelResizer(handle, side) {
    if (!handle || !workMode) return;
    handle.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      var move = function (pointerEvent) {
        setPanelSize(side, side === "sidebar" ? pointerEvent.clientX : window.innerWidth - pointerEvent.clientX);
      };
      var stop = function () {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    });
    handle.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      var direction = event.key === "ArrowRight" ? 1 : -1;
      setPanelSize(side, panelSize(side) + (side === "sidebar" ? direction : -direction) * (event.shiftKey ? 32 : 16));
    });
  }

  if (workMode) {
    try {
      var storedPanelSizes = JSON.parse(localStorage.getItem(panelSizeKey) || "{}");
      if (Number.isFinite(storedPanelSizes.sidebar)) setPanelSize("sidebar", storedPanelSizes.sidebar);
      if (Number.isFinite(storedPanelSizes.rail)) setPanelSize("rail", storedPanelSizes.rail);
    } catch (ignored) {}
    installPanelResizer(sidebarResizeHandle, "sidebar");
    installPanelResizer(railResizeHandle, "rail");
    window.addEventListener("resize", function () {
      setPanelSize("sidebar", panelSize("sidebar"));
      if (window.innerWidth > 1180) setPanelSize("rail", panelSize("rail"));
    });
  }
  if (desktopPanels) {
    try {
      var savedVisibility = JSON.parse(localStorage.getItem(panelVisibilityKey) || "{}");
      ["sidebar", "rail"].forEach(function (side) { if (typeof savedVisibility[side] === "boolean") panelVisibility[side] = savedVisibility[side]; });
    } catch (ignored) {}
    function panelIcon(right) {
      return '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M' + (right ? '15' : '9') + ' 4v16"/></svg>';
    }
    toggleSidebarButton.innerHTML = panelIcon(false);
    toggleSettingsButton.innerHTML = panelIcon(true);
    closeSettingsButton.title = "收起工作区与设置";
    new MutationObserver(syncWorkbenchPanels).observe(chatShell, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", function () {
      if (sidebarDocked()) { chatShell.classList.remove("sidebar-open"); if (sidebarBackdrop) sidebarBackdrop.hidden = true; }
      if (railDocked()) chatShell.classList.remove("settings-open");
      syncWorkbenchPanels();
    });
    syncWorkbenchPanels();
  }
  if (toggleSettingsButton) toggleSettingsButton.addEventListener("click", function () { setSettingsOpen(!panelOpen("rail")); });
  if (closeSettingsButton) closeSettingsButton.addEventListener("click", function () { setSettingsOpen(false); });
  if (changeWorkspaceButton) changeWorkspaceButton.addEventListener("click", function () {
    if (window.LkaWorkspacePicker) window.LkaWorkspacePicker.open();
    else setSettingsOpen(true);
  });
  document.addEventListener("keydown", function (event) {
    if ((window.LkaProjects && window.LkaProjects.isOpen()) ||
        (document.getElementById("memoryOverlay") && !document.getElementById("memoryOverlay").hidden) ||
        (document.getElementById("memoryEditorOverlay") && !document.getElementById("memoryEditorOverlay").hidden) ||
        (document.getElementById("workspacePicker") && !document.getElementById("workspacePicker").hidden)) return;
    if (event.key === "Escape") {
      if (!railDocked()) setSettingsOpen(false);
      setSidebarOpen(false);
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "k") { event.preventDefault(); focusComposer(true); }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "k") {
      event.preventDefault(); setSidebarOpen(true); if (sessionSearchInput) sessionSearchInput.focus();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") { event.preventDefault(); createAndSwitchNewSession(); }
  });

  if (startBackendButton) {
    startBackendButton.addEventListener("click", function () {
      requestBackendStartFromBridge();
    });
  }

  if (retryBackendButton) {
    retryBackendButton.addEventListener("click", function () {
      window.location.reload();
    });
  }

  loadRunSettings();
  defaultsReady = loadSharedDefaults();
  loadModelCatalog(false);
  [llmModelInput, safetyModeSelect, streamToggle, workspaceParentInput].forEach(function (control) {
    if (control) control.addEventListener("change", saveDefaultPreferences);
  });
  if (refreshModelsButton) refreshModelsButton.addEventListener("click", function () { loadModelCatalog(true); });
  if (resetDefaultsButton) resetDefaultsButton.addEventListener("click", function () {
    if (llmModelInput) llmModelInput.value = "";
    if (safetyModeSelect) safetyModeSelect.value = "backend";
    if (streamToggle) streamToggle.checked = true;
    if (workspaceParentInput) workspaceParentInput.value = "";
    saveDefaultPreferences();
  });
  function switchWorkspace(requestedWorkspace, expectedSessionId) {
    var session = getActiveSession();
    if (!session || (expectedSessionId && expectedSessionId !== session.id)) throw new Error("会话已改变，请重新选择工作目录。");
    if (pendingState) throw new Error("请等待当前任务完成后切换工作目录。");
    requestedWorkspace = safeText(requestedWorkspace).trim();
    if (requestedWorkspace === safeText(session.workspace).trim()) return Promise.resolve(true);
    if (!requestedWorkspace) {
      renderWorkspaceSummary(session);
      setRunStatus("请输入要切换到的工作目录", "error");
      return Promise.resolve(false);
    }
    var switchTask = workspaceSwitchPromise.then(async function () {
      var previousCustomWorkspace = session.workspace_is_custom;
      try {
        session.workspace_is_custom = true;
        await bindSessionWorkspace(session, requestedWorkspace);
        session.workspace = requestedWorkspace;
        runSettings.workspace = requestedWorkspace;
        persistSessions();
        if (activeSessionId === session.id) {
          renderWorkspaceSummary(session);
          fileRelativePath = "";
          loadFileList();
        }
        setRunStatus("已切换工作区");
        renderSessionList();
        return true;
      } catch (error) {
        session.workspace_is_custom = previousCustomWorkspace;
        if (activeSessionId === session.id) renderWorkspaceSummary(session);
        setRunStatus("工作区切换失败：" + error.message, "error");
        return false;
      }
    });
    workspaceSwitchPromise = switchTask;
    switchTask.then(function () {
      if (workspaceSwitchPromise === switchTask) workspaceSwitchPromise = Promise.resolve(true);
    });
    return switchTask;
  }
  if (workspaceInput) workspaceInput.addEventListener("change", function () {
    try { switchWorkspace(workspaceInput.value); }
    catch (error) { renderWorkspaceSummary(getActiveSession()); setRunStatus(error.message, "error"); }
  });
  if (indexWorkspaceButton) {
    indexWorkspaceButton.addEventListener("click", async function () {
      if (!await workspaceSwitchPromise) return;
      saveRunSettings();
      if (!runSettings.workspace) { setRunStatus("请先填写 workspace 路径", "error"); return; }
      indexWorkspaceButton.disabled = true; setRunStatus("正在索引 workspace…");
      try {
        var response = await fetch(backendBaseUrl + "/workspaces/index", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace: runSettings.workspace, source_frontend: "windows-pet", options: { recursive: true, skip_hidden: true } })
        });
        var data = await response.json();
        if (!response.ok) throw new Error(data.detail || ("HTTP " + response.status));
        setRunStatus("Workspace 已索引：" + (data.indexed_files || 0) + " 个文件");
      } catch (error) { setRunStatus("Workspace 索引失败：" + error.message, "error"); }
      finally { indexWorkspaceButton.disabled = false; }
    });
  }

  loadDeletedSessionIds();
  loadDeletedSessionSnapshots();
  loadSessions();
  setRailTab(activeRailTab);
  openRequestedSession();
  refreshSafetyReviewQueue();
  syncSessionsFromBackend();
  loadHistoryPage(true);

  window.__petChatOpenFreshTask = function () {
    if (window.LkaProjects && window.LkaProjects.isOpen()) window.LkaProjects.close();
    openFreshTask();
    syncSessionsFromBackend();
  };

  window.LkaChatContext = {
    setWorkspace: switchWorkspace,
    prepareWorkspace: async function (sessionId) {
      var session = getSessionById(sessionId);
      function assertCurrent(creating) {
        if (!session || !getSessionById(session.id) || deletedSessionIds[session.id] || deletingSessionIds[session.id] || activeSessionId !== session.id) {
          throw new Error("会话已关闭或切换，请在目标会话重新选择文件。");
        }
        if (creating && session.id.indexOf("conv_") !== 0) throw new Error("会话已失效，请刷新后重新选择。");
      }
      assertCurrent();
      fileWorkspacePreparations.push(session);
      try {
        if (!await workspaceSwitchPromise) throw new Error("请先完成工作区切换。");
        assertCurrent();
        await ensureSessionWorkspace(session);
        assertCurrent();
        var boundId = await bindSessionWorkspace(session, undefined, assertCurrent);
        assertCurrent();
        return boundId;
      } finally {
        var index = fileWorkspacePreparations.indexOf(session);
        if (index >= 0) fileWorkspacePreparations.splice(index, 1);
      }
    },
    getFileContext: function () {
      var session = getActiveSession();
      return { sessionId: session ? session.id : "", workspace: session ? session.workspace || "" : "", path: fileRelativePath };
    },
    refreshWorkspaceFiles: function (view) {
      var session = getActiveSession();
      if (session && session.id === view.sessionId && session.workspace === view.workspace && fileRelativePath === view.path) return loadFileList();
    },
    prepareAttachments: async function (sessionId) {
      var session = getSessionById(sessionId);
      if (!session || deletedSessionIds[sessionId]) throw new Error("会话已关闭，请重新选择图片。");
      if (!await workspaceSwitchPromise) throw new Error("请先完成工作区切换。");
      await ensureSessionWorkspace(session);
      return bindSessionWorkspace(session);
    },
    get: function () {
      var session = getActiveSession();
      return { backend: backendBaseUrl, workMode: workMode, sessionId: session ? session.id : "",
        workspace: session ? session.workspace || "" : "", projectId: session ? session.project_id || "" : "", busy: !!pendingState };
    },
    startProjectDraft: function (project) {
      if (pendingState) throw new Error("请等待当前任务完成后选择项目。");
      if (!project || !project.workspace_path || !project.project_id) throw new Error("项目还没有可用的工作目录。");
      saveCurrentDraft();
      var previousDraft = readDraft(activeSessionId);
      createAndSwitchNewSession(project.workspace_path);
      var session = getActiveSession();
      if (previousDraft) { writeDraft(session.id, previousDraft); showDraftForSession(session); }
      session.project_id = project.project_id;
      session.project_name = project.name || "";
      renderActiveSessionMeta();
      persistSessions();
      renderWorkspaceSummary(session);
      return true;
    },
    newProjectSession: function () {
      var session = getActiveSession();
      if (!session || !session.workspace || pendingState) return false;
      if (window.LkaProjects) { window.LkaProjects.createForCurrent(); return true; }
      createAndSwitchNewSession(session.workspace);
      return true;
    },
    openSession: switchSession,
    acceptSession: async function (detail) {
      if (pendingState) throw new Error("当前任务正在处理，请完成后再打开项目会话。");
      var session = sessionFromBackendDetail(detail);
      if (!session) throw new Error("后端返回的会话内容无效。");
      session.workspace_is_custom = true;
      mergeBackendSession(session);
      return switchSession(session.id);
    }
  };
  var newProjectSessionButton = document.querySelector("#newProjectSessionButton");
  if (newProjectSessionButton) newProjectSessionButton.addEventListener("click", function () {
    if (!window.LkaChatContext.newProjectSession()) setRunStatus("请先选择工作目录，并等待当前任务结束", "error");
  });

  window.addEventListener("focus", function () {
    refreshSafetyReviewQueue();
    syncSessionsFromBackend();
    loadHistoryPage(true);
    refreshActiveRunState();
  });
  window.addEventListener("storage", function (event) {
    if (event.key !== sessionsKey && event.key !== deletedSessionsKey
        && event.key !== deletedSnapshotsKey) return;
    if (pendingState) return;
    var activeBefore = getActiveSession();
    var before = activeBefore ? JSON.stringify({ title: activeBefore.title,
      workspace: activeBefore.workspace, messages: activeBefore.messages }) : "";
    loadDeletedSessionIds();
    loadDeletedSessionSnapshots();
    loadSessions(true);
    renderSessionList();
    var activeAfter = getActiveSession();
    if (activeAfter !== activeBefore && (!activeBefore || activeAfter.id !== activeBefore.id
        || before !== JSON.stringify({ title: activeAfter.title,
          workspace: activeAfter.workspace, messages: activeAfter.messages }))) {
      renderActiveMessages();
      renderWorkspaceSummary(activeAfter);
    }
    loadHistoryPage(true);
    refreshActiveRunState();
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      refreshSafetyReviewQueue();
      syncSessionsFromBackend();
      loadHistoryPage(true);
      refreshActiveRunState();
    }
  });
  window.setInterval(function () {
    if (document.hidden) return;
    syncSessionsFromBackend();
    loadHistoryPage(true);
    refreshActiveRunState();
  }, 15000);

  window.addEventListener("load", function () {
    focusComposer();
  });
}());
