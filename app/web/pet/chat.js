(function () {
  var messages = document.querySelector("#messages");
  var input = document.querySelector("#questionInput");
  var sendButton = document.querySelector("#sendButton");
  var form = document.querySelector("#chatForm");
  if (window.__lkaMatterAssistantStorageError) {
    if (sendButton) sendButton.disabled = true;
    if (input) input.disabled = true;
    if (form) form.addEventListener("submit", function (event) { event.preventDefault(); });
    var isolationStatus = document.querySelector("#runStatus");
    if (isolationStatus) { isolationStatus.textContent = "当前浏览器无法隔离助手会话，请在其他受支持的窗口重新打开。"; isolationStatus.classList.add("error"); }
    return;
  }
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
  var llmAnswerModelInput = document.querySelector("#llmAnswerModelInput");
  var reasoningLevelInput = document.querySelector("#reasoningLevelInput");
  var reasoningLevels = ["off", "low", "high", "max"];
  var reasoningLabels = ["关闭", "低", "高", "最高"];
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
  var historicalProcesses = new Map();
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
  var requestedMessageId = safeText(urlParams.get("message_id")).trim();
  var managerEmbedding = window.parent !== window && urlParams.get("embedded") === "matter" && urlParams.get("assistant") === "global";
  var quickAssistantDefault = !workMode && urlParams.get("assistant") === "quick" && !requestedSessionId && !requestedRunId;
  var quickAssistantEpoch = 0, quickAssistantPromise = null, quickAssistantManager = null;
  var assistantPreparation = null, assistantCacheEpoch = 0, preparedAssistantId = "";
  var unassignedQuickDraft = "";
  var quickAssistantLoading = quickAssistantDefault;
  var quickAssistantLastState = { loading: quickAssistantDefault, manager: null };
  var managerSessionReady = !managerEmbedding && !quickAssistantDefault;
  var globalAssistantLaunch = !managerEmbedding && urlParams.get("assistant") === "global" && !requestedSessionId;
  function isManagerSession(session) { return !!session && session.kind === "manager"; }
  function modelOverridesAllowed(sessionId) { return !managerEmbedding && !isManagerSession(getSessionById(sessionId)); }
  // A page hosted by a node backend talks to that node directly: workspaces are
  // approved IDs, files use /local/workspaces and only ordinary sessions exist.
  var lkaHost = window.LkaHost || null;
  var hostedPage = !!(lkaHost && lkaHost.hosted);
  var nodeHosted = hostedPage && lkaHost.role === "replica";
  var backendBaseUrl = resolveBackendBaseUrl();
  var backendCacheTarget = backendBaseUrl;
  try { var cacheTargetUrl = new URL(backendBaseUrl, window.location.origin); backendCacheTarget = cacheTargetUrl.origin + cacheTargetUrl.pathname; } catch (ignored) {}
  if (hostedPage) document.body.classList.add("lka-hosted-page", nodeHosted ? "lka-node-page" : "lka-hub-page");
  document.body.classList.toggle("work-mode", workMode);
  document.body.classList.toggle("quick-mode", !workMode);

  if (!messages || !input || !sendButton || !form) {
    return;
  }

  // v4: use unified conversation ids as session ids + editable titles.
  // Hosted pages keep a separate cache from the local 8780 workbench.
  // Hosted node caches used to share one replica namespace across every device.
  // Keep old entries in storage, but do not let another origin's session IDs or
  // run cursors become active on this node.
  var cacheScope = encodeURIComponent(JSON.stringify([window.location.origin, hostedPage ? lkaHost.role : "local", backendCacheTarget, lkaHost && lkaHost.info && lkaHost.info.node_id || ""]));
  var sessionsKey = "agentic-rag-pet-chat-sessions-v5-" + cacheScope;
  var runCursorKeyPrefix = sessionsKey + "-run-cursor-";
  var activeSessionKey = "agentic-rag-pet-chat-active-session-v5-" + cacheScope + (workMode ? "" : "-quick");
  var deletedSessionsKey = sessionsKey + "-deleted";
  var deletedSnapshotsKey = sessionsKey + "-deleted-snapshots";
  var draftKeyPrefix = sessionsKey + "-draft-";
  var panelSizeKey = "agentic-rag-workbench-panel-sizes-v1";
  var panelVisibilityKey = "lka-workbench-panel-visibility-v2";
  var legacyPanelVisibilityKey = "lka-workbench-panel-visibility-v1";
  var desktopPanels = workMode && urlParams.get("layout") !== "mobile";
  var panelVisibility = { sidebar: true, rail: false, followup: true };
  var deletedSessionIds = Object.create(null);
  var deletingSessionIds = Object.create(null);
  var deletedThisPage = Object.create(null);
  var restoringSessionIds = Object.create(null);
  var deletedSessionSnapshots = [];
  var backendDeletedSessions = [];
  var viewingDeletedSessions = false;
  var sessions = [];
  var historyItems = [];
  var deletedHistoryItems = [];
  var historyOffset = 0;
  var historyHasMore = false;
  var historyLoading = false;
  var historyRequestGeneration = 0;
  var historyRequestInFlight = false;
  var historyActiveRequestKey = "";
  var historyLoadedRequestKey = "";
  var historyActiveRequestGeneration = 0;
  var historyResetQueued = false;
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
  var managerStreams = Object.create(null), managerPendingTurns = Object.create(null);
  var activeAgentTurnGeneration = 0;
  var pendingSafetyReviews = [];
  var approvalQueueReady = false;
  var approvalQueueRequestInFlight = false;
  var approvalQueueRefreshRequested = false;
  var approvalActionInFlight = false;
  var approvalQueueNotice = "";
  var approvalQueuePollTimer = null;
  var approvalQueueEpoch = 0, approvalQueueRenderKey = "";
  var multiAgentCommandInFlight = {};
  var pendingContinuationCommands = {};
  var activeSessionId = "";
  var lastSubmitAt = 0;
  var pendingState = null;
  var runCommandInFlight = Object.create(null);
  var managerInputQueues = Object.create(null);
  var composerRequestedBusy = false;
  var suspendedTurns = Object.create(null);
  var cancelledRunIds = Object.create(null);
  var runStatusRequestInFlight = false;
  var runDiscoveryAt = Object.create(null);
  var replacementCommands = Object.create(null);
  var renamingSessionId = "";
  var renameDraft = "";
  var backendOffline = false;
  function historyNamespace(sessionId) {
    var host = window.LkaHost || {}, cloud = host.clientMode === "cloud" || host.hosted && host.role === "hub" || !!(host.isCloudSession && host.isCloudSession(sessionId));
    var account = cloud ? host.cloud && host.cloud.account || host.hub && host.hub.account || host.principal : host.principal;
    return JSON.stringify([backendBaseUrl, host.role, host.backendRole, host.clientMode, cloud,
      account && (account.user_id || account.username || account.id) || "", host.cloud && host.cloud.origin, host.hub && host.hub.origin]);
  }
  async function historyRequest(path) {
    var response = await window.fetch(backendBaseUrl + path, { headers: { Accept: "application/json" } });
    var payload = await response.json();
    if (!response.ok) { var error = new Error("HTTP " + response.status); error.status = response.status; error.detail = payload.detail; throw error; }
    return payload;
  }
  var sessionHistory = window.LkaSessionHistory && window.LkaSessionHistory.create({ namespace: historyNamespace, request: historyRequest });
  async function fetch(url, options) {
    var method = String(options && options.method || "GET").toUpperCase(), target;
    try { target = new URL(String(url), window.location.href); } catch (ignored) {}
    var base = new URL(backendBaseUrl, window.location.href);
    var relative = target && target.origin === base.origin && target.pathname.indexOf(base.pathname.replace(/\/$/, "") + "/") === 0
      ? target.pathname.slice(base.pathname.replace(/\/$/, "").length) : "";
    var detail = relative.match(/^\/sessions\/([^/]+)$/);
    if (!sessionHistory || !detail || detail[1] === "deleted" || target.search || (method !== "GET" && method !== "DELETE")) return window.fetch(url, options);
    var id = decodeURIComponent(detail[1]);
    if (method === "DELETE") { sessionHistory.clear(id); return window.fetch(url, options); }
    if (lkaHost) await (lkaHost.routingReady ? lkaHost.routingReady() : lkaHost.ready);
    var payload;
    try { payload = await sessionHistory.load(id); }
    catch (error) {
      if (!error.status) throw error;
      return new Response(JSON.stringify({ detail: error.detail }), { status: error.status, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  }
  var renderingMessages = false;
  var conversationReading = window.LkaConversationPosition ? window.LkaConversationPosition.create({
    container: messages, namespace: backendBaseUrl, surface: workMode ? "work" : "quick",
    getSessionId: function () { return activeSessionId; }
  }) : null;
  window.LkaConversationReading = conversationReading;
  var runSettingsKey = "agentic-rag-pet-run-settings-v1";
  var runSettings = { workspace: "", llmClient: "", llmModel: "", llmAnswerClient: "", llmAnswerModel: "", reasoningLevel: "low", safetyMode: "backend", stream: true, workspaceParent: "" };
  var modelCatalog = null;
  var modelCatalogRetryTimer = null;
  var defaultsDirty = false;
  var defaultsSaveChain = Promise.resolve();
  var defaultsReady = Promise.resolve();
  var defaultsSaveError = null;
  var workspaceRequests = {};
  var workspaceBindings = Object.create(null);
  var fileWorkspacePreparations = [];
  var workbenchOpening = false;
  var workspaceSwitchPromise = Promise.resolve(true);
  var bridgeWorkspaceRetryScheduled = false;

  var runStatusFadeTimer = 0;
  function setRunStatus(text, kind) {
    if (!runStatus) return;
    var value = safeText(text);
    runStatus.textContent = value;
    clearTimeout(runStatusFadeTimer);
    // "就绪" carries no information; short confirmations fade so the transcript keeps its height.
    var idle = !kind && /^(就绪|真理已就绪)?$/.test(value.trim());
    var transient = !kind && !idle && !/^(正在|等待|请|暂时|无法|当前)/.test(value.trim());
    runStatus.className = "run-status" + (kind ? " " + kind : "") + (idle ? " is-idle" : "");
    if (transient) runStatusFadeTimer = setTimeout(function () {
      if (runStatus.textContent === value) runStatus.classList.add("is-idle");
    }, 4000);
  }

  function loadRunSettings() {
    try { runSettings = Object.assign(runSettings, JSON.parse(localStorage.getItem(runSettingsKey) || "{}")); } catch (ignored) {}
    if (workspaceInput) workspaceInput.value = "";
    if (managerEmbedding) { runSettings.workspace = ""; runSettings.llmClient = ""; runSettings.llmModel = ""; }
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

  function reasoningOptions(modelValue, level) {
    var pair = [];
    try { pair = modelValue ? JSON.parse(modelValue) : []; } catch (ignored) {}
    var clients = modelCatalog && modelCatalog.clients || [];
    var clientName = pair[0] || modelCatalog && modelCatalog.default_client;
    var client = clients.find(function (item) { return item.name === clientName; }) || (!clientName ? clients[0] : null);
    var model = pair[1] || client && client.default_model;
    var supported = clients.some(function (item) { return !!item.reasoning_capabilities; });
    var capability = client && client.reasoning_capabilities && client.reasoning_capabilities[model];
    var selected = reasoningLevels.indexOf(level) >= 0 ? level : "low";
    var levels = reasoningLevels.map(function (value, index) {
      var available = value === "low";
      if (capability) available = value === "off" ? !!capability.supports_off
        : capability.controlled ? Object.prototype.hasOwnProperty.call(capability.effort_map || {}, value) : value === "low";
      return { value: value, label: reasoningLabels[index], available: supported && available };
    });
    var valid = !supported || levels.some(function (row) { return row.value === selected && row.available; });
    var hint = !supported ? "当前后端未提供推理强度设置。"
      : !valid ? "当前模型不支持此档位，请选择可用档位。"
      : !capability || !capability.controlled ? "此模型未提供可调推理强度，低档沿用模型默认行为。"
      : selected === "max" && capability.effort_map && capability.effort_map.max === capability.effort_map.high
        ? "此模型的最高档与高档使用相同强度。" : "更深入的推理可能需要更长时间；新运行生效。";
    return { reasoningLevel: selected, reasoningLevels: levels, reasoningSupported: supported,
      reasoningAvailable: supported && (levels.filter(function (row) { return row.available; }).length > 1 || !valid),
      reasoningValid: valid, reasoningHint: hint };
  }

  function renderReasoningControl(level) {
    if (!reasoningLevelInput) return;
    var settings = reasoningOptions(llmModelInput ? llmModelInput.value : selectedModelValue(), level || runSettings.reasoningLevel);
    var index = reasoningLevels.indexOf(settings.reasoningLevel);
    reasoningLevelInput.value = index;
    reasoningLevelInput.disabled = !settings.reasoningAvailable;
    reasoningLevelInput.style.setProperty("--reasoning-progress", (index / 3 * 100) + "%");
    reasoningLevelInput.setAttribute("aria-valuetext", reasoningLabels[index]);
    document.getElementById("reasoningLevelValue").textContent = reasoningLabels[index];
    document.getElementById("reasoningLevelHint").textContent = settings.reasoningHint;
    document.getElementById("reasoningControl").classList.toggle("reasoning-invalid", !settings.reasoningValid);
    document.querySelectorAll("#reasoningControl .reasoning-ticks span").forEach(function (node, i) {
      node.classList.toggle("is-unavailable", !settings.reasoningLevels[i].available);
      node.classList.toggle("is-selected", i === index);
    });
  }

  function requestReasoningLevel(sessionId) {
    // Manager requests inherit their controller; ordinary tasks use UI defaults.
    if (isManagerSession(getSessionById(sessionId))) return "";
    var modelValue = selectedModelValue() || (runSettings.llmModel ? JSON.stringify([runSettings.llmClient, runSettings.llmModel]) : "");
    var settings = reasoningOptions(modelValue, runSettings.reasoningLevel);
    if (!settings.reasoningValid) throw new Error("当前模型不支持所选推理强度，请在设置中调整。");
    return settings.reasoningSupported ? settings.reasoningLevel : "";
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
    renderAnswerModelOptions();
    renderReasoningControl();
  }

  function renderAnswerModelOptions() {
    if (!llmAnswerModelInput) return;
    llmAnswerModelInput.textContent = "";
    var follow = document.createElement("option"); follow.value = ""; follow.textContent = "跟随推理模型"; llmAnswerModelInput.appendChild(follow);
    (modelCatalog && modelCatalog.clients || []).forEach(function (client) {
      var group = document.createElement("optgroup"); group.label = client.name;
      (client.models || []).forEach(function (model) { var option = document.createElement("option"); option.value = JSON.stringify([client.name, model]); option.textContent = model === client.default_model ? model + " · 默认" : model; group.appendChild(option); });
      llmAnswerModelInput.appendChild(group);
    });
    var saved = runSettings.llmAnswerModel ? JSON.stringify([runSettings.llmAnswerClient || "", runSettings.llmAnswerModel]) : "";
    if (saved && !Array.from(llmAnswerModelInput.options).some(function (option) { return option.value === saved; })) { var stale = document.createElement("option"); stale.value = saved; stale.textContent = runSettings.llmAnswerModel + " · 已保存，当前未列出"; llmAnswerModelInput.appendChild(stale); }
    llmAnswerModelInput.value = saved;
  }

  function selectPreferenceModel(select, value) {
    if (value && !Array.from(select.options).some(function (option) { return option.value === value; })) {
      var pair = JSON.parse(value);
      var saved = document.createElement("option");
      saved.value = value;
      saved.textContent = (pair[1] || pair[0] + " 默认模型") + " · 已保存，当前未列出";
      select.appendChild(saved);
    }
    select.value = value;
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
      runSettings.llmClient = managerEmbedding ? "" : defaults.llm_client || "";
      runSettings.llmModel = managerEmbedding ? "" : defaults.llm_model || "";
      runSettings.llmAnswerClient = managerEmbedding ? "" : defaults.llm_answer_client || "";
      runSettings.llmAnswerModel = managerEmbedding ? "" : defaults.llm_answer_model || "";
      runSettings.reasoningLevel = reasoningLevels.indexOf(defaults.reasoning_level) >= 0 ? defaults.reasoning_level : "low";
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
      defaultsSaveError = new Error("请输入完整的绝对路径");
      if (defaultsSaveStatus) { defaultsSaveStatus.textContent = defaultsSaveError.message; defaultsSaveStatus.classList.add("error"); }
      return;
    }
    defaultsDirty = true;
    defaultsSaveError = null;
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
    if (llmAnswerModelInput && llmAnswerModelInput.value) {
      try { var answerSelected = JSON.parse(llmAnswerModelInput.value); runSettings.llmAnswerClient = answerSelected[0] || ""; runSettings.llmAnswerModel = answerSelected[1] || ""; }
      catch (ignored) { return; }
    } else { runSettings.llmAnswerClient = ""; runSettings.llmAnswerModel = ""; }
    runSettings.reasoningLevel = reasoningLevelInput ? reasoningLevels[Number(reasoningLevelInput.value)] || "low" : runSettings.reasoningLevel;
    var reasoning = reasoningOptions(llmModelInput ? llmModelInput.value : selectedModelValue(), runSettings.reasoningLevel);
    renderReasoningControl();
    if (!reasoning.reasoningValid) {
      defaultsSaveError = new Error(reasoning.reasoningHint);
      if (defaultsSaveStatus) { defaultsSaveStatus.textContent = defaultsSaveError.message; defaultsSaveStatus.classList.add("error"); }
      return;
    }
    runSettings.workspaceParent = parent;
    saveRunSettings();
    var defaults = { llm_client: runSettings.llmClient, llm_model: runSettings.llmModel,
      llm_answer_client: runSettings.llmAnswerClient, llm_answer_model: runSettings.llmAnswerModel,
      safety_mode: runSettings.safetyMode, stream: runSettings.stream, workspace_parent: parent };
    if (reasoning.reasoningSupported) defaults.reasoning_level = runSettings.reasoningLevel;
    if (defaultsSaveStatus) { defaultsSaveStatus.textContent = "正在保存…"; defaultsSaveStatus.classList.remove("error"); }
    defaultsSaveChain = defaultsSaveChain.catch(function () {}).then(async function () {
      if (nodeHosted) {
        // Nodes accept only reads of shared defaults; keep the choice in this browser.
        if (defaultsSaveStatus) defaultsSaveStatus.textContent = "已保存在此浏览器；设备的共享默认值由设备本机设置";
        return;
      }
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
      defaultsSaveError = error;
      if (defaultsSaveStatus) { defaultsSaveStatus.textContent = "保存失败：" + error.message; defaultsSaveStatus.classList.add("error"); }
    });
    return defaultsSaveChain;
  }

  function resolveBackendBaseUrl() {
    if (hostedPage) return window.location.origin;
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
      .filter(function (event) { return event && typeof event === "object" && event.type !== "llm_delta"
        && (backendUserVisible(event) || ["assistant_message", "final_answer"].indexOf(event.type) < 0); })
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
      runId: safeText(result.run_id).trim(),
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
      kind: "ordinary",
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
        history_reset_at: session.historyResetAt || "",
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
      messageKind: role === "assistant" && rawMessage.messageKind === "manager_instruction" ? "manager_instruction" : "",
      text: text,
      isError: !!rawMessage.isError,
      pendingApproval: pendingApproval,
      progressEvents: normalizeProgressEvents(rawMessage.progressEvents || rawMessage.progress_events),
      verificationWarnings: normalizeVerificationWarnings(rawMessage.verificationWarnings || rawMessage.verification_warnings),
      runId: safeText(rawMessage.runId || rawMessage.run_id).trim(),
      traceId: safeText(rawMessage.traceId || rawMessage.trace_id).trim(),
      logPath: safeText(rawMessage.logPath || rawMessage.log_path).trim(),
      attachments: window.LkaImageComposer.normalize(rawMessage.attachments),
      clientId: safeText(rawMessage.clientId),
      messageId: safeText(rawMessage.messageId || rawMessage.message_id),
      inputStatus: safeText(rawMessage.inputStatus),
      inputError: safeText(rawMessage.inputError),
      queueRequest: rawMessage.queueRequest || null,
      queueRestoredDraft: rawMessage.queueRestoredDraft,
      queuePriorDraft: rawMessage.queuePriorDraft,
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
    if (rawSession.historyResetAt && runCursor.history_reset_at !== rawSession.historyResetAt) runCursor = {};
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
      kind: safeText(rawSession.kind).trim() || "ordinary",
      remoteExecution: rawSession.remoteExecution || rawSession.remote_execution || rawSession.metadata && rawSession.metadata.remote_execution || null,
      creationSource: safeText(rawSession.creationSource || rawSession.creation_source || rawSession.metadata && rawSession.metadata.creation_source).trim(),
      creatorSessionId: safeText(rawSession.creatorSessionId || rawSession.creator_session_id || rawSession.metadata && rawSession.metadata.creator_session_id).trim(),
      backendHistoryVersion: rawSession.backendHistoryVersion === 1 ? 1 : 0,
      historyResetAt: safeText(rawSession.historyResetAt).trim(),
      backendHistoryPaged: !!rawSession.backendHistoryPaged,
      title: normalizedTitle,
      title_is_custom: customTitle,
      backend_title: usefulBackendTitle(rawSession.backend_title),
      created_at: Number(rawSession.created_at) || Date.now(),
      updated_at: Number(rawSession.updated_at) || Date.now(),
      workspace: rawSession.kind === "manager" ? "" : safeText(rawSession.workspace).trim(),
      workspace_is_custom: !!rawSession.workspace_is_custom,
      project_id: rawSession.kind === "manager" ? "" : safeText(rawSession.project_id).trim(),
      backendWorkspace: rawSession.kind === "manager" ? "" : safeText(rawSession.backendWorkspace).trim(),
      // "reserved": the default folder is allocated by path only; the backend creates it on first write.
      workspaceState: rawSession.workspaceState === "reserved" ? "reserved" : "",
      workspaceReserved: !!rawSession.workspaceReserved,
      nodeWorkspaceId: safeText(rawSession.nodeWorkspaceId).trim(),
      nodeWorkspaceBound: safeText(rawSession.nodeWorkspaceBound).trim(),
      multiAgentRunId: savedRunId || safeText(rawSession.multiAgentRunId || rawSession.multi_agent_run_id).trim(),
      multiAgentSequence: savedRunId
        ? savedSequence
        : Math.max(0, Number(rawSession.multiAgentSequence || rawSession.multi_agent_sequence) || 0),
      multiAgentSnapshot: null,
      timelineEvents: Array.isArray(rawSession.timelineEvents) ? rawSession.timelineEvents.slice(-100).map(function (item) {
        return { type: safeText(item.type), message: truncateText(item.message, item.type === "safety_review_decided" ? 4000 : 180), at: Number(item.at) || Date.now() };
      }) : [],
      runControlStatus: safeText(rawSession.runControlStatus || ""),
      connectionUncertain: !!rawSession.connectionUncertain,
      pendingClientRequestId: safeText(rawSession.pendingClientRequestId),
      pauseRequested: !!rawSession.pauseRequested,
      resumePending: !!rawSession.resumePending,
      controlNotice: safeText(rawSession.controlNotice),
      pausedAnswer: safeText(rawSession.pausedAnswer),
      timelineState: safeText(rawSession.timelineState || ""),
      messages: normalizedMessages
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
    var pinnedManagers = sessions.filter(function (session) {
      return isManagerSession(session) && (session.id === preparedAssistantId || managerStreams[session.id] || managerPendingTurns[session.id]);
    });
    sessions = sessions.filter(function (session) {
      return pinnedManagers.indexOf(session) < 0 && (!isUnusedLocalSession(session) || session === blank);
    }).slice(0, 24).concat(pinnedManagers);
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
        storedSession.messages = storedSession.messages.slice(-180);
        delete storedSession.resumePending;
        delete storedSession.controlNotice;
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
    if (!sessionId) { if (quickAssistantDefault && !getActiveSession()) unassignedQuickDraft = safeText(value); return; }
    try {
      if (value) localStorage.setItem(draftStorageKey(sessionId), value);
      else localStorage.removeItem(draftStorageKey(sessionId));
    } catch (ignored) {}
  }

  function saveCurrentDraft() {
    var session = getActiveSession();
    if (!document.body.classList.contains("native-composer")) {
      writeDraft(session ? session.id : "", input.value);
    }
  }

  function showDraftForSession(session) {
    if (session && unassignedQuickDraft) {
      var existingDraft = readDraft(session.id), pendingDraft = unassignedQuickDraft;
      unassignedQuickDraft = "";
      if (existingDraft !== pendingDraft && !existingDraft.endsWith("\n" + pendingDraft)) writeDraft(session.id, existingDraft ? existingDraft + "\n" + pendingDraft : pendingDraft);
    }
    var draft = session ? readDraft(session.id) : "";
    input.value = draft;
    window.LkaImageComposer.refresh();
    renderRunControls();
    if (window.petBridge && typeof window.petBridge.setComposerDraft === "function") {
      window.petBridge.setComposerDraft(draft);
    }
  }

  window.__petChatNativeDraftChanged = function (draft) {
    var session = getActiveSession();
    writeDraft(session ? session.id : "", safeText(draft));
    renderRunControls();
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

  // Backend-generated titles beat a truncated first message, but never a user rename.
  function usefulBackendTitle(title) {
    var cleaned = truncateText(safeText(title).trim(), 40);
    return /^(New Chat|Chat|新会话|新任务|管理会话)$/i.test(cleaned) ? "" : cleaned;
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
    session.title = usefulBackendTitle(session.backend_title) || deriveAutoSessionTitle(session);
    if (/^\[(Image|File|Audio) input\]$/.test(session.title)) session.title = session.title === "[File input]" ? "文件任务" : session.title === "[Audio input]" ? "音频任务" : "图片任务";
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
    return !!session && !isManagerSession(session) && !session.summary_only && !session.title_is_custom
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
    if (managerEmbedding) return managerSessionReady && isManagerSession(active) ? active : null;
    if (quickAssistantLoading || quickAssistantDefault && !managerSessionReady) return active;
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
    var awaitingQuickIdentity = preserveActiveSelection && quickAssistantDefault && !managerSessionReady && !getActiveSession();
    var loadedSessions = [];
    var loadedActiveId = "";
    var previousActive = preserveActiveSelection ? getActiveSession() : null;
    var liveManagers = preserveActiveSelection ? sessions.filter(function (item) { return isManagerSession(item) && (managerPendingTurns[item.id] || managerStreams[item.id]); }) : [];

    try {
      var rawSessions = localStorage.getItem(sessionsKey);
      if (rawSessions) {
        var parsed = JSON.parse(rawSessions);
        if (Array.isArray(parsed)) {
          loadedSessions = parsed;
        }
      }
      loadedActiveId = localStorage.getItem(activeSessionKey) || "";
    } catch (ignored) {
      loadedSessions = [];
      loadedActiveId = "";
    }

    sessions = loadedSessions
      .map(sanitizeSession)
      .filter(function (item) { return item !== null; });

    liveManagers.forEach(function (live) {
      sessions = sessions.filter(function (item) { return item.id !== live.id; });
      if (!deletedSessionIds[live.id]) sessions.unshift(live);
    });
    if (previousActive && !deletedSessionIds[previousActive.id]
        && !sessions.some(function (item) { return item.id === previousActive.id; })) {
      sessions.unshift(previousActive);
    }

    activeSessionId = preserveActiveSelection && previousActive
      ? previousActive.id : safeText(loadedActiveId).trim();
    normalizeSessionBounds();
    activeSessionId = preserveActiveSelection && previousActive && getSessionById(previousActive.id)
      ? previousActive.id : safeText(loadedActiveId || (sessions[0] && sessions[0].id)).trim();
    if (awaitingQuickIdentity) { activeSessionId = ""; return; }
    if (preserveActiveSelection) ensureActiveSession();
  }

  function recoverableLocalCache() {
    if (hostedPage) return { key: "", rows: [] };
    var key = "agentic-rag-pet-chat-sessions-v4";
    var marker = key + "-recovered-" + cacheScope;
    try {
      var rows = JSON.parse(localStorage.getItem(key) || "[]");
      return { key: key, marker: marker, rows: localStorage.getItem(marker) ? [] : Array.isArray(rows) ? rows : [] };
    } catch (ignored) { return { key: key, rows: [] }; }
  }

  async function recoverLegacyLocalCache(button) {
    var archive = recoverableLocalCache();
    if (!archive.rows.length || hostedPage || button.disabled) return;
    if (!window.confirm("旧版本本机缓存没有记录它属于哪个后端。只会恢复能从当前连接重新读取的普通会话；无法核验的缓存和草稿会留在原存储中。继续？")) return;
    button.disabled = true; button.textContent = "正在核对旧缓存…";
    var imported = [], omitted = 0;
    try {
      if (lkaHost) await (lkaHost.routingReady ? lkaHost.routingReady() : lkaHost.ready);
      for (var i = 0; i < archive.rows.length; i += 1) {
        var raw = archive.rows[i], id = safeText(raw && (raw.id || raw.session_id)).trim();
        if (!id || raw.kind === "manager" || lkaHost && lkaHost.isCloudSession && lkaHost.isCloudSession(id)) { omitted += 1; continue; }
        try {
          var response = await window.fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(id)
            + "?message_limit=30&message_view=conversation", { headers: { Accept: "application/json" } });
          if (!response.ok) { omitted += 1; continue; }
          var detail = await response.json(), restored = sessionFromBackendDetail(detail), cached = sanitizeSession(raw);
          if (!restored || restored.id !== id || isManagerSession(restored)) { omitted += 1; continue; }
          if (cached && cached.title_is_custom) { restored.title = cached.title; restored.title_is_custom = true; }
          if (cached && cached.messages.some(function (message) { return message.queueRequest; })) restored.messages = mergeQueuedMessages(cached, restored);
          var oldDraft = localStorage.getItem(archive.key + "-draft-" + encodeURIComponent(id));
          if (oldDraft) writeDraft(id, oldDraft);
          imported.push(restored);
        } catch (ignoredSession) { omitted += 1; }
      }
      if (imported.length) {
        var importIds = Object.create(null); imported.forEach(function (item) { importIds[item.id] = true; });
        sessions = imported.concat(sessions.filter(function (item) { return !importIds[item.id]; }));
        var oldActive = safeText(localStorage.getItem("agentic-rag-pet-chat-active-session-v4" + (workMode ? "" : "-quick"))).trim();
        if (importIds[oldActive]) activeSessionId = oldActive;
        normalizeSessionBounds(); persistSessions(); renderSessionList(); renderActiveMessages();
        if (activeSessionId && importIds[activeSessionId]) { prepareSessionWorkspace(getActiveSession()); loadFileList(); }
      }
      button.textContent = imported.length ? "已恢复 " + imported.length + " 条；未核验 " + omitted + " 条留在旧缓存" : "未找到当前连接可核验的普通会话；旧缓存已保留";
      button.disabled = omitted === 0;
      if (omitted === 0) localStorage.setItem(archive.marker, "1");
    } catch (error) {
      button.textContent = "恢复失败：" + safeText(error.message || error);
      button.disabled = false;
    }
  }

  function timestampToMillis(rawValue) {
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      return rawValue;
    }
    var parsed = Date.parse(safeText(rawValue));
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function backendManagerInstruction(entry) {
    if (entry.role !== "tool") return "";
    var payload = entry.payload && typeof entry.payload === "object" ? entry.payload : {};
    var envelope = payload.input_envelope && typeof payload.input_envelope === "object" ? payload.input_envelope : {};
    if ((payload.input_origin || envelope.origin) !== "manager" || envelope.origin !== "manager") return "";
    // Project explicit task text only; never render the provenance/debug envelope.
    return typeof envelope.purpose === "string" ? envelope.purpose.trim() : "";
  }

  function backendUserVisible(value) {
    var payload = value && value.payload && typeof value.payload === "object" ? value.payload : {};
    return !(value && value.user_visible === false || value && value.metadata && value.metadata.user_visible === false
      || payload.user_visible === false || payload.metadata && payload.metadata.user_visible === false);
  }

  function normalizeBackendRole(entry) {
    if (!backendUserVisible(entry)) return "";
    // Provenance describes persisted inputs, never the agent's actual answer.
    if (entry.role === "assistant" || entry.role === "agent") return "assistant";
    var payload = entry.payload && typeof entry.payload === "object" ? entry.payload : {};
    var envelope = payload.input_envelope && typeof payload.input_envelope === "object" ? payload.input_envelope : {};
    var origin = safeText(payload.input_origin || envelope.origin).trim();
    if (origin === "manager" && backendManagerInstruction(entry)) return "assistant";
    if (origin && origin !== "user") return "";
    if (entry.role === "user" || origin === "user") return "user";
    // Older backends persisted visible tool messages without input provenance.
    return entry.role === "tool" ? "assistant" : "";
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
    var normalizedMessages = normalizeBackendMessages(rawMessages, !!(detail.message_page && detail.message_page.expanded));

    var loaded = sanitizeSession({
      id: sessionId,
      conversation_id: sessionId,
      kind: rawSession.kind,
      remoteExecution: rawSession.metadata && rawSession.metadata.remote_execution || rawSession.remote_execution || null,
      creationSource: rawSession.metadata && rawSession.metadata.creation_source || rawSession.creation_source || "",
      creatorSessionId: rawSession.metadata && rawSession.metadata.creator_session_id || rawSession.creator_session_id || "",
      historyResetAt: detail.message_page && detail.message_page.history_reset_at || rawSession.metadata && rawSession.metadata.history_reset_at,
      title: safeText(rawSession.title).trim() || "新会话",
      title_is_custom: !!(rawSession.metadata && rawSession.metadata.title_is_custom),
      backend_title: rawSession.title,
      created_at: timestampToMillis(rawSession.created_at),
      updated_at: timestampToMillis(rawSession.updated_at),
      workspace: rawSession.workspace && rawSession.workspace.path || "",
      project_id: rawSession.project_id || "",
      backendWorkspace: rawSession.workspace && rawSession.workspace.path || "",
      workspaceState: rawSession.workspace && rawSession.workspace.state === "reserved" ? "reserved" : "",
      workspace_is_custom: !!(rawSession.metadata && (rawSession.metadata.explicit_workspace || rawSession.metadata.project_session || rawSession.metadata.workspace_is_custom)),
      messages: normalizedMessages.length ? normalizedMessages : [defaultGreetingMessage()]
    });
    loaded.backendHistoryVersion = 1;
    loaded.backendHistoryPaged = !!detail.message_page;
    loaded.backendHistoryFiltered = rawMessages.some(function (entry) {
      return entry && !normalizeBackendRole(entry);
    });
    return loaded;
  }

  function sessionMessageSnapshot(sessionId) {
    var session = getSessionById(sessionId);
    return session ? JSON.stringify(session.messages || []) : null;
  }

  function mergeBackendSession(remoteSession, expectedMessages) {
    if (!remoteSession || !remoteSession.id) {
      return;
    }
    var existing = getSessionById(remoteSession.id);
    if (!existing) {
      sessions.push(remoteSession);
      return;
    }

    var historyReset = reconcileHistoryReset(existing, remoteSession);
    if (historyReset < 0) return;
    var existingMessages = Array.isArray(existing.messages) ? existing.messages : [];
    var remoteMessages = Array.isArray(remoteSession.messages) ? remoteSession.messages : [];
    // A sync started before the user sent a turn must not replace its local messages.
    if (historyReset > 0) {
      existing.messages = remoteMessages;
      existing.backendHistoryVersion = remoteSession.backendHistoryVersion;
    } else if (isManagerSession(existing) && (queueEnabled(existing) || existingMessages.some(function (item) { return !!item.queueRequest; }))
        && (expectedMessages === undefined || expectedMessages === sessionMessageSnapshot(existing.id))) {
      existing.messages = mergeQueuedMessages(existing, remoteSession);
      existing.backendHistoryVersion = remoteSession.backendHistoryVersion;
    } else if (!managerPendingTurns[existing.id] && !(pendingState && pendingState.conversationId === existing.id)
        && (expectedMessages === undefined || expectedMessages === sessionMessageSnapshot(existing.id))
        && (remoteSession.backendHistoryPaged || remoteSession.backendHistoryFiltered || isManagerSession(remoteSession) || remoteMessages.length >= existingMessages.length || existingMessages.length <= 1)) {
      existing.messages = remoteMessages;
      existing.backendHistoryVersion = remoteSession.backendHistoryVersion;
    }
    if (renamingSessionId !== existing.id && remoteSession.title && remoteSession.title_is_custom) {
      existing.title = remoteSession.title;
      existing.title_is_custom = true;
    }
    if (usefulBackendTitle(remoteSession.backend_title)) existing.backend_title = usefulBackendTitle(remoteSession.backend_title);
    existing.kind = remoteSession.kind;
    if (remoteSession.remoteExecution) existing.remoteExecution = remoteSession.remoteExecution;
    if (remoteSession.creationSource) existing.creationSource = remoteSession.creationSource;
    if (remoteSession.creatorSessionId) existing.creatorSessionId = remoteSession.creatorSessionId;
    existing.workspace_is_custom = existing.workspace_is_custom || remoteSession.workspace_is_custom;
    existing.updated_at = Math.max(Number(existing.updated_at) || 0, Number(remoteSession.updated_at) || 0);
    if (!pendingState && (!existing.backendWorkspace || existing.workspace === existing.backendWorkspace)) {
      existing.workspace = remoteSession.workspace;
      existing.backendWorkspace = remoteSession.backendWorkspace;
      existing.workspaceState = remoteSession.workspaceState;
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
        && !managerPendingTurns[session.id] && !managerStreams[session.id]
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
    if (nodeHosted) return false; // Nodes do not publish their OpenAPI schema.
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
      return raw && raw.kind !== "manager" && raw.metadata && raw.metadata.source_frontend === "windows-pet"
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
    if (managerEmbedding || quickAssistantLoading || quickAssistantDefault && !managerSessionReady) return;
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
      backendSessions.forEach(function (summary) {
        var cached = getSessionById(summary.session_id);
        if (cached && summary.kind) cached.kind = summary.kind;
        var remoteExecution = summary.metadata && summary.metadata.remote_execution || summary.remote_execution;
        if (cached && remoteExecution) cached.remoteExecution = remoteExecution;
        if (cached && summary.metadata && summary.metadata.creation_source) cached.creationSource = summary.metadata.creation_source;
        if (cached && summary.metadata && summary.metadata.creator_session_id) cached.creatorSessionId = summary.metadata.creator_session_id;
      });
      var needDetails = backendSessions.filter(function (summary) {
        var id = safeText(summary && summary.session_id).trim();
        if (!id || summary.kind === "manager" && id !== activeSessionId && id !== requestedSessionId || deletingSessionIds[id]
            || (deletedThisPage[id] && Date.now() - deletedThisPage[id] < 3000)) return false;
        var local = getSessionById(id);
        return !local || !local.backendHistoryVersion || local.summary_only || id === activeSessionId
          || isReusableEmptySession(local)
          || timestampToMillis(summary.updated_at) > Number(local.updated_at || 0) + 100;
      });
      var details = [], detailMessageSnapshots = Object.create(null);
      for (var i = 0; i < needDetails.length; i += 4) {
        var batch = await Promise.all(needDetails.slice(i, i + 4).map(async function (summary) {
          try {
            detailMessageSnapshots[summary.session_id] = sessionMessageSnapshot(summary.session_id);
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
      remoteSessions.forEach(function (remote) { mergeBackendSession(remote, detailMessageSnapshots[remote.id]); });
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
      id: safeText(raw.session_id), conversation_id: safeText(raw.session_id), kind: safeText(raw.kind).trim() || "ordinary",
      title: safeText(raw.title).trim() || "新会话", title_is_custom: true, backend_title: usefulBackendTitle(raw.title),
      updated_at: timestampToMillis(raw.updated_at), created_at: timestampToMillis(raw.created_at),
      workspace: raw.workspace && raw.workspace.path || "", messages: [defaultGreetingMessage()],
      project_id: raw.project_id || "",
      remoteExecution: raw.metadata && raw.metadata.remote_execution || raw.remote_execution || null,
      creationSource: raw.metadata && raw.metadata.creation_source || raw.creation_source || "",
      creatorSessionId: raw.metadata && raw.metadata.creator_session_id || raw.creator_session_id || "",
      summary_only: true
    };
  }

  async function loadHistoryPage(reset) {
    if (managerEmbedding) return;
    var deletedView = viewingDeletedSessions;
    var query = sessionSearchInput ? sessionSearchInput.value.trim() : "";
    var requestKey = (deletedView ? "deleted" : "active") + "\u0000" + query;
    var sameLoadedView = requestKey === historyLoadedRequestKey;
    if (historyRequestInFlight) {
      if (!reset) return;
      // Repeated resets for the same active request are already satisfied. If
      // the search or view changed, let the old request drain and run only the
      // latest requested page afterward.
      if (!historyResetQueued && requestKey === historyActiveRequestKey
          && historyActiveRequestGeneration === historyRequestGeneration) return;
      historyRequestGeneration += 1;
      historyResetQueued = true;
      historyLoading = !sameLoadedView;
      lastKnownSearch = query;
      if (!sameLoadedView) {
        historyLoadedRequestKey = "";
        historyOffset = 0;
        historyHasMore = true;
        historyError = "";
        if (deletedView) deletedHistoryItems = [];
        else historyItems = [];
      }
      renderSessionList();
      return;
    }
    if (!reset && (!historyHasMore || historyLoading)) return;
    var generation = reset ? ++historyRequestGeneration : historyRequestGeneration;
    if (reset) {
      lastKnownSearch = query;
      // Keep the loaded index visible during same-view background refreshes.
      if (!sameLoadedView) {
        historyLoadedRequestKey = "";
        historyOffset = 0;
        historyHasMore = true;
        historyError = "";
        if (deletedView) deletedHistoryItems = [];
        else historyItems = [];
      }
    }
    historyLoading = !reset || !sameLoadedView;
    historyRequestInFlight = true;
    historyActiveRequestKey = requestKey;
    historyActiveRequestGeneration = generation;
    renderSessionList();
    var requestOffset = reset ? 0 : historyOffset;
    try {
      var url = backendBaseUrl + (deletedView ? "/sessions/deleted" : "/sessions")
        + "?limit=30&offset=" + requestOffset + (query ? "&q=" + encodeURIComponent(query) : "");
      var response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var payload = await response.json();
      if (generation !== historyRequestGeneration || deletedView !== viewingDeletedSessions) return;
      var page = (Array.isArray(payload.sessions) ? payload.sessions : [])
        .map(sessionSummaryFromBackend).filter(function (item) { return item !== null; });
      if (deletedView) deletedHistoryItems = reset ? page : deletedHistoryItems.concat(page);
      else historyItems = reset ? page : historyItems.concat(page);
      historyLoadedRequestKey = requestKey;
      historyOffset = requestOffset + page.length;
      historyHasMore = page.length === 30;
      historyError = "";
    } catch (error) {
      if (generation === historyRequestGeneration) historyError = "加载失败：" + safeText(error.message || error);
    } finally {
      historyRequestInFlight = false;
      historyActiveRequestKey = "";
      historyActiveRequestGeneration = 0;
      if (generation === historyRequestGeneration) {
        historyLoading = false;
        renderSessionList();
      }
      if (historyResetQueued) {
        historyResetQueued = false;
        loadHistoryPage(true);
      } else if (generation !== historyRequestGeneration) {
        historyLoading = false;
        renderSessionList();
      }
    }
  }

  function historyIndexSignature(rawValue) {
    try {
      var rows = JSON.parse(rawValue || "[]");
      if (!Array.isArray(rows)) return "";
      return JSON.stringify(rows.filter(function (item) {
        return item && typeof item === "object" && item.kind !== "manager";
      }).map(function (item) {
        var messages = Array.isArray(item.messages) ? item.messages : [];
        var last = messages[messages.length - 1] || {};
        return [item.id || item.session_id || "", item.title || "", !!item.title_is_custom,
          Number(item.updated_at) || 0, item.workspace || "", item.project_id || "",
          messages.length, last.messageId || last.message_id || last.id || "", last.role || ""];
      }).sort(function (a, b) { return safeText(a[0]).localeCompare(safeText(b[0])); }));
    } catch (ignored) { return ""; }
  }

  function formatTimestamp(timestamp) {
    var value = Number(timestamp) || Date.now();
    var date = new Date(value);
    var hours = String(date.getHours()).padStart(2, "0");
    var minutes = String(date.getMinutes()).padStart(2, "0");
    var days = sessionDayOffset(value);
    if (days === 0) return hours + ":" + minutes;
    if (days === 1) return "昨天 " + hours + ":" + minutes;
    if (date.getFullYear() === new Date().getFullYear()) return (date.getMonth() + 1) + "月" + date.getDate() + "日";
    return date.getFullYear() + "/" + (date.getMonth() + 1) + "/" + date.getDate();
  }

  function sessionDayOffset(timestamp) {
    var day = new Date(Number(timestamp) || Date.now()); day.setHours(0, 0, 0, 0);
    var today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((today - day) / 86400000));
  }

  function sessionGroupLabel(timestamp) {
    var days = sessionDayOffset(timestamp);
    return days === 0 ? "今天" : days === 1 ? "昨天" : days < 7 ? "最近 7 天" : days < 30 ? "最近 30 天" : "更早";
  }

  // One quiet line of the latest exchange; markdown punctuation is noise in a list.
  function sessionPreviewText(session) {
    if (!session || session.summary_only) return "";
    var list = Array.isArray(session.messages) ? session.messages : [];
    for (var i = list.length - 1; i >= 0; i -= 1) {
      var text = safeText(list[i] && list[i].text).replace(/```[\s\S]*?```/g, " ").replace(/[#*_>`|\[\]-]+/g, " ").replace(/\s+/g, " ").trim();
      if (text && list[i].role !== "system" && list[i].text !== defaultGreetingMessage().text) return (list[i].role === "user" ? "你：" : "") + truncateText(text, 48);
    }
    return "";
  }

  function sessionRunState(session) {
    if (!session) return "";
    if (session.connectionUncertain || pendingState && pendingState.conversationId === session.id) return "running";
    var status = safeText(session.runControlStatus);
    if (status === "waiting_confirmation" || status === "waiting_user") return "waiting";
    if (status === "paused") return "paused";
    if ((status === "queued" || status === "running") && session.multiAgentRunId) return "running";
    return "";
  }

  function sidebarDocked() { return desktopPanels && window.innerWidth > 700; }
  function railDocked() { return desktopPanels && window.innerWidth > 1180; }
  // The ordinary file/settings rail and 真理's follow-up ledger remember their visibility separately.
  function railVisibilityKey() { return isManagerSession(getActiveSession()) ? "followup" : "rail"; }
  function panelOpen(side) {
    if (side === "sidebar") return sidebarDocked() ? panelVisibility.sidebar : chatShell.classList.contains("sidebar-open");
    return railDocked() ? panelVisibility[railVisibilityKey()] : chatShell.classList.contains("settings-open");
  }
  function syncWorkbenchPanels() {
    if (!desktopPanels || !chatShell) return;
    var topbar = document.querySelector(".chat-topbar");
    if (topbar) document.body.style.setProperty("--workbench-header-height", Math.ceil(topbar.getBoundingClientRect().height) + "px");
    document.body.classList.toggle("work-sidebar-hidden", !panelVisibility.sidebar);
    document.body.classList.toggle("work-rail-hidden", !panelVisibility[railVisibilityKey()]);
    var managerView = isManagerSession(getActiveSession()), followup = document.querySelector(".ga-workspace");
    [["sidebar", toggleSidebarButton, "sessionSidebar", "会话列表"], ["rail", toggleSettingsButton, "contextRail", managerView ? "跟进面板" : "工作区与设置"]].forEach(function (item) {
      var open = panelOpen(item[0]), button = item[1], panel = item[0] === "rail" && managerView && followup ? followup : document.getElementById(item[2]);
      var docked = item[0] === "sidebar" ? sidebarDocked() : railDocked();
      if (button) {
        var label = (open ? (docked ? "收起" : "关闭") : "展开") + item[3];
        button.setAttribute("aria-expanded", String(open));
        if (panel) button.setAttribute("aria-controls", panel.id || item[2]);
        button.setAttribute("aria-label", label); button.title = label;
      }
      if (panel) {
        if (!open && panel.contains(document.activeElement) && button) button.focus({ preventScroll: true });
        panel.inert = !open;
      }
    });
  }
  function setWorkbenchPanelVisible(side, open) {
    panelVisibility[side === "rail" ? railVisibilityKey() : side] = !!open;
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
    var managerInstruction = !!(details && details.messageKind === "manager_instruction");
    // Delegation is an input-side bubble; keep its source separate from human input.
    var displayRole = managerInstruction ? "user" : role;
    article.className = "message " + displayRole + (isError ? " error" : "");
    if (details && details.clientId) article.dataset.clientId = details.clientId;
    if (details && details.messageId) article.dataset.messageId = details.messageId;

    var bubble = document.createElement("div");
    bubble.className = "bubble";

    var label = document.createElement("strong");
    if (managerInstruction) article.dataset.messageKind = "manager_instruction";
    label.textContent = managerInstruction ? "真理派发的任务" : role === "user" ? "你" : "真理";

    bubble.appendChild(label);
    var richAnswer = role === "assistant" && !isError;
    var body = document.createElement(richAnswer ? "div" : "p");
    body.className = "message-content" + (richAnswer ? " markdown-body" : "");
    if (richAnswer) window.PetMarkdown.render(body, text);
    else body.textContent = text;
    if (safeText(text).trim()) {
      bubble.appendChild(body);
    }
    // A delegated brief can run to many paragraphs; show its opening and let the reader expand it.
    if (managerInstruction && safeText(text).length > 180) {
      article.classList.add("is-collapsible", "is-collapsed");
      var expand = document.createElement("button");
      expand.type = "button"; expand.className = "message-expand"; expand.textContent = "展开全部";
      expand.setAttribute("aria-expanded", "false");
      expand.addEventListener("click", function () {
        var collapsed = article.classList.toggle("is-collapsed");
        expand.textContent = collapsed ? "展开全部" : "收起";
        expand.setAttribute("aria-expanded", String(!collapsed));
      });
      bubble.appendChild(expand);
    }
    if (role === "user") window.LkaImageComposer.renderHistory(bubble, details && details.attachments, sessionId);
    if (role === "user" && details && details.inputStatus) {
      article.dataset.inputStatus = details.inputStatus;
      if (details.inputStatus === "submission_failed" && details.queueRequest) {
        var retryInput = document.createElement("button");
        retryInput.type = "button"; retryInput.className = "message-retry";
        retryInput.title = "重试发送"; retryInput.setAttribute("aria-label", "重试发送");
        retryInput.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7"/></svg>';
        retryInput.addEventListener("click", function () { retryQueuedInput(sessionId, details.clientId); });
        bubble.appendChild(retryInput);
      }
    }
    if (role === "assistant") {
      appendAgentRunDetails(bubble, details || {}, sessionId);
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

  function appendAgentRunDetails(bubble, details, sessionId) {
    if (!bubble || !details) {
      return;
    }
    var progressEvents = normalizeProgressEvents(details.progressEvents || details.progress_events);
    var warnings = normalizeVerificationWarnings(details.verificationWarnings || details.verification_warnings);
    var runId = safeText(details.runId || details.run_id).trim();
    var traceId = safeText(details.traceId || details.trace_id).trim();
    var logPath = safeText(details.logPath || details.log_path).trim();
    var selectedPackage = safeText(details.selectedPackage || details.selected_package).trim();
    var initialPackage = safeText(details.initialPackage || details.initial_package).trim();
    var usedPackages = Array.isArray(details.usedPackages || details.used_packages) ? (details.usedPackages || details.used_packages).join(", ") : "";
    if (!runId && !progressEvents.length && !warnings.length && !traceId && !logPath && !selectedPackage && !initialPackage && !usedPackages) {
      return;
    }

    var box = document.createElement("details");
    box.className = "agent-run-details";
    var summary = document.createElement("summary");
    summary.textContent = "运行过程";
    box.appendChild(summary);

    var processBody = document.createElement("div"); processBody.className = "run-history-content";
    box.appendChild(processBody);
    var loaded = false, loading = false;
    async function load() {
      if (!box.open || loaded || loading) return;
      loading = true; processBody.textContent = "正在读取运行过程…";
      try {
        if (!runId && traceId && sessionId) runId = await findHistoricalRun(sessionId, traceId);
        if (!runId) {
          processBody.textContent = "这次运行没有保存可回看的事件。";
          loaded = true; return;
        }
        box.dataset.runId = runId;
        var scope = assistantCacheEpoch;
        var process = await loadHistoricalProcess(runId);
        if (scope !== assistantCacheEpoch || !box.isConnected) return;
        processBody.textContent = "";
        var entries = process.entries.filter(function (entry) { return entry.kind === "model" || entry.kind === "tool" || entry.kind === "review"; });
        if (!entries.length) entries = process.entries;
        if (entries.length) {
          var list = document.createElement("ol"); list.className = "run-history-list";
          entries.forEach(function (entry) { var row = document.createElement("li"); renderProcessEntry(row, entry); list.appendChild(row); });
          processBody.appendChild(list);
          var toolCount = entries.filter(function (entry) { return entry.kind === "tool"; }).length;
          var failedCount = entries.filter(function (entry) { return entry.kind === "tool" && /failed|error|rejected|blocked|timeout|timed_out/.test(entry.status || ""); }).length;
          summary.textContent = "运行过程" + (toolCount ? " · " + toolCount + " 次工具调用" : "") + (failedCount ? " · " + failedCount + " 次未成功" : "");
          var fallback = box.querySelector(".agent-progress-list"); if (fallback) fallback.hidden = true;
        } else processBody.textContent = "这次运行没有保存可回看的事件。";
        loaded = process.complete;
      } catch (error) {
        processBody.textContent = error.status === 404 ? "这次运行的事件记录已不可用。" : "暂时无法读取运行过程。";
        var retry = document.createElement("button"); retry.type = "button"; retry.className = "text-action"; retry.textContent = "重试";
        retry.addEventListener("click", load); processBody.appendChild(retry);
      } finally { loading = false; }
    }
    box.addEventListener("toggle", load);

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

  function scrollMessagesToBottom(force) {
    if (renderingMessages) return;
    if (force === true && !workMode && conversationReading && conversationReading.focusRow) {
      var questions = messages.querySelectorAll(".message.user");
      var latest = questions[questions.length - 1];
      if (latest) { conversationReading.focusRow(latest); return; }
    }
    if (conversationReading) { conversationReading.followLatest({ force: force === true }); return; }
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
    renderRunControls();
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
      activeSessionTitle.textContent = workMode && isManagerSession(session) ? "真理" : !workMode && session.project_name && !getSessionMessageCount(session) ? session.project_name + " · 新任务" : session.title || "新会话";
    }
    if (activeSessionSubtitle) {
      activeSessionSubtitle.textContent = workMode && isManagerSession(session)
        ? "真理会接着跟进你交代的事"
        : "更新于 " + formatTimestamp(session.updated_at) + " · " + getSessionMessageCount(session) + " 条消息";
    }
  }

  function renderWorkspaceSummary(session) {
    if (nodeBoundary() && !isManagerSession(session)) {
      // The header place switcher already names the device; this line names the workspace.
      if (workspaceSummary) {
        workspaceSummary.textContent = session && session.nodeWorkspaceId ? "工作区 · " + session.nodeWorkspaceId : "未选择工作区";
        workspaceSummary.title = "这台设备上的已批准工作区";
      }
      document.body.classList.remove("manager-conversation");
      syncWorkbenchPanels();
      window.dispatchEvent(new CustomEvent("lka-session-context", { detail: { sessionId: session ? session.id : "", workspace: session && session.nodeWorkspaceId || "" } }));
      return;
    }
    var path = session && safeText(session.workspace).trim();
    if (workspaceInput) workspaceInput.value = path || "";
    if (workspaceSummary) {
      var parts = path ? path.replace(/[\\/]+$/, "").split(/[\\/]/) : [];
      var folderName = parts.pop() || "";
      var isDefaultFolder = folderName === (session && session.id) ||
        (/^session-[0-9a-f]{64}$/.test(folderName) && parts.slice(-2).join("/") === "Local Knowledge Agent/Workspaces");
      workspaceSummary.textContent = isManagerSession(session) ? "真理 · 按授权范围处理任务" : !path ? (getSessionMessageCount(session) ? "正在准备独立工作区…" : "新任务 · 发送后创建工作区") : isDefaultFolder ? (session.workspaceState === "reserved" ? "默认任务工作区 · 写入文件时创建" : "默认任务工作区") : folderName;
      workspaceSummary.title = path || "尚未设置工作区";
    }
    var managerView = isManagerSession(session);
    document.body.classList.toggle("manager-conversation", managerView);
    [workspaceInput, changeWorkspaceButton, indexWorkspaceButton].forEach(function (control) { if (control) control.disabled = managerView; });
    if (workMode && !managerEmbedding && input) {
      input.placeholder = urlParams.get("layout") === "mobile" ? "Привет, Doctor."
        : managerView ? "和真理聊聊目标、进展或下一步…" : "描述你想完成的任务…";
    }
    syncWorkbenchPanels();
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
      button.textContent = "现在创建工作区";
      button.addEventListener("click", async function () {
        var session = getActiveSession();
        if (!session) return;
        button.disabled = true;
        try {
          await ensureSessionWorkspace(session);
          await bindSessionWorkspace(session);
          await materializeSessionWorkspace(getSessionById(session.id) || session);
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
    if (managerEmbedding || isManagerSession(session)) { showFilePanelMessage("真理不绑定工作目录；可直接上传附件。", false); return; }
    var generation = ++fileRequestGeneration;
    selectedFilePath = "";
    window.dispatchEvent(new CustomEvent("lka-workspace-files", { detail: { sessionId: session ? session.id : "", workspace: session ? session.workspace || "" : "", path: fileRelativePath } }));
    if (filePreview) filePreview.textContent = "选择文件后在这里预览。";
    if (fileCurrentPath) fileCurrentPath.textContent = fileRelativePath || "当前工作区";
    if (fileUpButton) {
      fileUpButton.disabled = !fileRelativePath;
      fileUpButton.title = fileRelativePath ? "返回上一级" : "已到工作区根目录，无法返回上一级";
    }
    if (!session) { showFilePanelMessage("打开会话后查看工作区文件。", false); return; }
    if (nodeBoundary()) { await loadNodeFileList(session, generation); return; }
    if (hostedPage) { showFilePanelMessage("云端不托管文件。进入一台电脑后可浏览它的工作区。", false); return; }
    if (session.id.indexOf("conv_") === 0 || session.workspaceState === "reserved") {
      showFilePanelMessage("默认工作区会在第一次写入文件时自动创建；只是聊天或修改其他目录的文件不会创建它。", true);
      return;
    }
    showFilePanelMessage("正在读取文件…", false);
    try {
      var response = await fetch(fileApiUrl(session.id, "files", fileRelativePath));
      if (response.status === 409) {
        var conflict = await response.json().catch(function () { return {}; });
        if (conflict.detail === "session_workspace_reserved") {
          session.workspaceState = "reserved"; renderWorkspaceSummary(session);
          showFilePanelMessage("默认工作区会在第一次写入文件时自动创建；只是聊天或修改其他目录的文件不会创建它。", true);
        } else showFilePanelMessage("会话还没有绑定工作区。", true);
        return;
      }
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

  // Node workspaces: choose an approved ID, then browse it with relative paths.
  async function loadNodeFileList(session, generation) {
    var approved = await nodeWorkspaces(true);
    if (generation !== fileRequestGeneration || activeSessionId !== session.id) return;
    if (approved === null) { showFilePanelMessage("无法读取当前设备的授权工作区，请检查连接后重试。", false); return; }
    if (session.nodeWorkspaceId && approved.indexOf(session.nodeWorkspaceId) < 0) {
      // A browser may retain a workspace ID from another node or an older grant.
      // Drop only the stale binding; cached conversation text and drafts remain.
      session.nodeWorkspaceId = ""; session.nodeWorkspaceBound = "";
      session.workspace = ""; session.backendWorkspace = "";
      persistSessions();
    }
    if (!session.nodeWorkspaceId && approved.length === 1) session.nodeWorkspaceId = approved[0];
    fileList.textContent = "";
    var oldPicker = filesPanel && filesPanel.querySelector(".node-workspace-picker");
    if (oldPicker) oldPicker.remove();
    var heading = filesPanel && filesPanel.querySelector(".workspace-file-heading > strong");
    if (heading) heading.textContent = "设备文件";
    if (!approved.length) { showFilePanelMessage("此设备没有为当前连接开放工作区。", false); return; }
    var picker = document.createElement("label");
    picker.className = "node-workspace-picker";
    var caption = document.createElement("span"); caption.textContent = "工作区";
    var select = document.createElement("select");
    select.setAttribute("aria-label", "选择这台设备上的工作区");
    if (!session.nodeWorkspaceId) { var placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "选择工作区"; select.appendChild(placeholder); }
    approved.forEach(function (id) { var option = document.createElement("option"); option.value = id; option.textContent = id; select.appendChild(option); });
    select.value = session.nodeWorkspaceId || "";
    select.disabled = !!pendingState;
    select.addEventListener("change", function () {
      if (!select.value) return;
      session.nodeWorkspaceId = select.value; fileRelativePath = "";
      persistSessions(); renderWorkspaceSummary(session);
      if (session.id.indexOf("conv_") !== 0 && getSessionMessageCount(session) > 0) {
        bindSessionWorkspace(session, select.value).then(function () { setRunStatus("已切换到工作区 " + select.value); })
          .catch(function (error) { setRunStatus(error.message, "error"); });
      }
      loadFileList();
    });
    picker.appendChild(caption); picker.appendChild(select);
    // The choice sits under the heading, above the toolbar, where the path label is locally.
    var label = document.getElementById("fileWorkspaceLabel");
    if (label && label.parentNode) label.parentNode.insertBefore(picker, label.nextSibling); else fileList.appendChild(picker);
    if (!session.nodeWorkspaceId) { var hint = document.createElement("p"); hint.className = "file-panel-message"; hint.textContent = "选择工作区后，对话与文件都在这个目录中进行。"; fileList.appendChild(hint); return; }
    var workspaceId = session.nodeWorkspaceId, requestedPath = fileRelativePath;
    var listing = document.createElement("div"); listing.className = "node-file-listing"; listing.textContent = "正在读取文件…";
    fileList.appendChild(listing);
    try {
      var response = await fetch(nodeFileUrl(workspaceId, "entries", requestedPath), { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(response.status === 403 ? "工作区未授权或暂不可用" : response.status === 404 ? "目录已不存在" : "HTTP " + response.status);
      var payload = await response.json();
      if (generation !== fileRequestGeneration || activeSessionId !== session.id) return;
      listing.textContent = "";
      var items = Array.isArray(payload.items) ? payload.items : [];
      if (!items.length) { var empty = document.createElement("p"); empty.className = "file-panel-message"; empty.textContent = "这个目录还没有文件。"; listing.appendChild(empty); }
      items.forEach(function (item) {
        var path = [requestedPath, item.name].filter(Boolean).join("/");
        var entry = { name: safeText(item.name), path: path, type: item.is_directory ? "directory" : "file", size_bytes: Number(item.size) || 0 };
        var button = document.createElement("button");
        button.type = "button"; button.className = "file-item" + (item.is_directory ? " directory" : "");
        var name = document.createElement("span"); name.textContent = (item.is_directory ? "▸  " : "□  ") + entry.name; button.appendChild(name);
        if (!item.is_directory) { var size = document.createElement("small"); size.textContent = entry.size_bytes >= 1024 ? Math.ceil(entry.size_bytes / 1024) + " KB" : entry.size_bytes + " B"; button.appendChild(size); }
        button.addEventListener("click", function () { if (item.is_directory) { fileRelativePath = path; loadFileList(); } else previewFile(entry); });
        var row = document.createElement("div"); row.className = "file-row"; row.setAttribute("role", "listitem"); row.appendChild(button);
        if (!item.is_directory && window.LkaWorkspaceFiles) row.appendChild(window.LkaWorkspaceFiles.downloadButton(entry, { sessionId: session.id, workspace: workspaceId, path: requestedPath, workspaceId: workspaceId }));
        listing.appendChild(row);
      });
      if (items.length >= 200) { var note = document.createElement("p"); note.className = "file-panel-message"; note.textContent = "仅显示前 200 项，请进入子目录查看。"; listing.appendChild(note); }
    } catch (error) {
      if (generation === fileRequestGeneration) listing.textContent = "文件读取失败：" + safeText(error.message || error);
    }
  }

  async function previewFile(entry) {
    var session = getActiveSession();
    if (!session || !filePreview) return;
    if (nodeBoundary()) {
      // Direct node files are downloads; previews stay on the owning computer.
      selectedFilePath = entry.path;
      filePreview.textContent = safeText(entry.name) + " · 点击右侧图标下载到这台设备查看。";
      return;
    }
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

  // Node boundary: the page or the local backend is a cluster node. Workspaces
  // are then operator-approved IDs, never directories chosen by this computer.
  function nodeBoundary() { return nodeHosted || !!(lkaHost && lkaHost.backendRole === "replica"); }
  function noLocalWorkspaceService() { return hostedPage || nodeBoundary(); }
  var nodeWorkspaceList = null;
  async function nodeWorkspaces(refresh) {
    if (nodeWorkspaceList && !refresh) return nodeWorkspaceList;
    try {
      var response = await fetch(backendBaseUrl + "/local/workspaces", { headers: { Accept: "application/json" } });
      if (!response.ok) { nodeWorkspaceList = null; return null; }
      var data = await response.json();
      nodeWorkspaceList = (data.items || []).map(function (item) { return safeText(item.workspace_id); }).filter(Boolean);
    } catch (ignored) { nodeWorkspaceList = null; }
    return nodeWorkspaceList;
  }
  function nodeFileUrl(workspaceId, kind, path) {
    return backendBaseUrl + "/local/workspaces/" + encodeURIComponent(workspaceId) + "/" + kind + "?path=" + encodeURIComponent(path || "");
  }

  async function ensureSessionWorkspace(session) {
    if (managerEmbedding || isManagerSession(session)) return "";
    if (lkaHost) await lkaHost.ready;
    if (session && noLocalWorkspaceService()) {
      // Default to the only approved workspace; several require an explicit choice.
      if (nodeBoundary() && !session.nodeWorkspaceId) {
        var approved = await nodeWorkspaces();
        if (approved.length === 1) { session.nodeWorkspaceId = approved[0]; persistSessions(); }
      }
      return session.workspace || "";
    }
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
          body: JSON.stringify({ session_id: requestKey, base_path: runSettings.workspaceParent || "", reserve: true })
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
        session.workspaceReserved = true;
        var liveSession = getSessionById(requestKey);
        if (liveSession && !liveSession.workspace) { liveSession.workspace = data.path; liveSession.workspaceReserved = true; }
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
    if (managerEmbedding || isManagerSession(session) || globalAssistantLaunch && getSessionMessageCount(session) === 0) { renderWorkspaceSummary(session); return; }
    renderWorkspaceSummary(session);
    if (session.workspace) return;
    // An untouched task creates its directory on first send, file panel use or
    // attachment preparation; merely opening a window must not leave folders behind.
    if (getSessionMessageCount(session) === 0) return;
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

  function reconcileSessionList(nodes) {
    var next = sessionList.firstChild;
    nodes.forEach(function (node) {
      if (node === next) next = next.nextSibling;
      else sessionList.insertBefore(node, next);
    });
    while (next) {
      var removed = next;
      next = next.nextSibling;
      removed.remove();
    }
  }

  function renderSessionList() {
    if (!sessionList) {
      return;
    }
    if (sessionListCaption) sessionListCaption.textContent = viewingDeletedSessions ? "已删除的会话" : "最近的工作";
    if (toggleDeletedSessionsButton) toggleDeletedSessionsButton.textContent = viewingDeletedSessions ? "返回会话" : "已删除";
    if (sessionSearchInput) sessionSearchInput.placeholder = viewingDeletedSessions ? "搜索已删除会话" : "搜索会话";
    if (loadMoreSessionsButton) {
      loadMoreSessionsButton.hidden = !historyHasMore && !historyLoading;
      loadMoreSessionsButton.disabled = historyRequestInFlight;
      loadMoreSessionsButton.textContent = historyLoading ? "加载中…" : "加载更早的会话";
    }
    if (sessionListStatus) {
      var loadedCount = viewingDeletedSessions ? deletedHistoryItems.length : historyItems.length;
      sessionListStatus.textContent = historyError || (historyLoading ? "正在读取历史…" : loadedCount ? "已载入 " + loadedCount + " 条历史" : "");
    }
    if (viewingDeletedSessions) {
      sessionList.innerHTML = "";
      renderDeletedSessionList();
      return;
    }
    var existingCards = Object.create(null), existingGroups = Object.create(null);
    Array.prototype.forEach.call(sessionList.children, function (node) {
      if (node.classList.contains("session-item") && !node.classList.contains("deleted-session")) existingCards[node.dataset.sessionId] = node;
      else if (node.classList.contains("session-group-label")) {
        if (!existingGroups[node.textContent]) existingGroups[node.textContent] = [];
        existingGroups[node.textContent].push(node);
      }
    });
    var nodes = [], renameEditorCreated = false;
    var legacyArchive = recoverableLocalCache();
    if (legacyArchive.rows.length) {
      var recovery = document.createElement("div"); recovery.className = "legacy-cache-recovery";
      var explanation = document.createElement("span"); explanation.textContent = "发现 " + legacyArchive.rows.length + " 条未标注后端的旧缓存";
      var recoverButton = document.createElement("button"); recoverButton.type = "button"; recoverButton.textContent = "核验并恢复";
      recoverButton.addEventListener("click", function () { recoverLegacyLocalCache(recoverButton); });
      recovery.appendChild(explanation); recovery.appendChild(recoverButton); nodes.push(recovery);
    }

    var searchTerm = sessionSearchInput ? sessionSearchInput.value.trim().toLocaleLowerCase() : "";
    var ordered = sessions.filter(function (session) {
      if (isManagerSession(session)) return false;
      if (!searchTerm) return true;
      applySessionTitle(session);
      return (session.title || "").toLocaleLowerCase().indexOf(searchTerm) !== -1 ||
        (session.workspace || "").toLocaleLowerCase().indexOf(searchTerm) !== -1;
    });
    var includedIds = Object.create(null);
    ordered.forEach(function (session) { includedIds[session.id] = true; });
    historyItems.forEach(function (summary) {
      if (isManagerSession(summary) || isManagerSession(getSessionById(summary.id))) return;
      var cachedSession = getSessionById(summary.id);
      if (cachedSession && summary.remoteExecution) cachedSession.remoteExecution = summary.remoteExecution;
      if (cachedSession && summary.creationSource) cachedSession.creationSource = summary.creationSource;
      if (cachedSession && summary.creatorSessionId) cachedSession.creatorSessionId = summary.creatorSessionId;
      if (!includedIds[summary.id] && !deletedSessionIds[summary.id] && !deletingSessionIds[summary.id]) {
        ordered.push(cachedSession || summary);
        includedIds[summary.id] = true;
      }
    });
    ordered.sort(function (a, b) {
      if (!searchTerm) {
        var groupDifference = sessionExecutionGroup(a).localeCompare(sessionExecutionGroup(b), "zh-CN");
        if (groupDifference) return groupDifference;
      }
      return b.updated_at - a.updated_at;
    });
    if (!ordered.length) {
      var empty = document.createElement("p");
      empty.className = "session-list-empty";
      empty.textContent = historyLoading ? "正在搜索历史会话…" :
        searchTerm ? "没有找到匹配的会话" : "还没有会话";
      nodes.push(empty);
    }

    var lastGroup = "";
    ordered.forEach(function (session) {
      if (!session.summary_only) applySessionTitle(session);
      var group = "";
      if (!searchTerm) {
        group = sessionExecutionGroup(session);
      }
      if (group && group !== lastGroup) {
        var groupLabel = (existingGroups[group] || []).shift() || document.createElement("p");
        groupLabel.className = "session-group-label";
        if (groupLabel.textContent !== group) groupLabel.textContent = group;
        nodes.push(groupLabel);
        lastGroup = group;
      }

      var runState = sessionRunState(session);
      var itemClass = "session-item" + (session.id === activeSessionId ? " active" : "") + (runState ? " is-" + runState : "");
      var timeText = runState === "running" ? "进行中" : runState === "waiting" ? "待确认" : runState === "paused" ? "已暂停" : formatTimestamp(session.updated_at);
      var folder = safeText(session.workspace).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
      var metaText = sessionPreviewText(session) || (session.summary_only ? (folder && !/^(conv|session)[-_]/.test(folder) ? folder + " · 点击载入" : "点击载入") : "尚未开始");
      var remote = session.remoteExecution && typeof session.remoteExecution === "object" ? session.remoteExecution : null;
      if (remote && (remote.task_id || remote.node_id || remote.environment_id)) {
        var executionLabel = "真理派发 · " + (remote.node_name || remote.device_name || remote.node_id || "指定设备");
        if (remote.environment_id) executionLabel += " / " + remote.environment_id;
        if (remote.workspace_id) executionLabel += " · " + remote.workspace_id;
        metaText = executionLabel + (metaText && metaText !== "尚未开始" ? " · " + metaText : "");
      } else if (session.creationSource === "assistant") {
        var assistantExecutionLabel = hostedPage && lkaHost.role === "hub" ? "真理派发 · 云端本机" : "真理派发";
        metaText = assistantExecutionLabel + (metaText && metaText !== "尚未开始" ? " · " + metaText : "");
      }
      var item = existingCards[session.id], renaming = renamingSessionId === session.id;
      // Keep hovered actions and an active rename editor mounted during sync.
      if (item && !!item._renaming === renaming) {
        if (item.className !== itemClass) item.className = itemClass;
        var titleNode = item.querySelector(".session-title"), timeNode = item.querySelector(".session-time"), metaNode = item.querySelector(".session-meta");
        if (titleNode && titleNode.textContent !== session.title) titleNode.textContent = session.title || "新会话";
        if (timeNode && timeNode.textContent !== timeText) timeNode.textContent = timeText;
        if (metaNode.textContent !== metaText) metaNode.textContent = metaText;
        if (!renaming) {
          var buttons = item.querySelectorAll(".session-actions button");
          buttons[0].setAttribute("aria-label", "重命名会话：" + (session.title || "新会话"));
          buttons[1].disabled = !!deletingSessionIds[session.id];
          buttons[1].setAttribute("aria-label", "删除会话：" + (session.title || "新会话"));
        }
        nodes.push(item);
        return;
      }
      item = document.createElement("article");
      item.className = itemClass;
      item.dataset.sessionId = session.id;
      item._renaming = renaming;

      var row = document.createElement("div");
      row.className = "session-row";

      if (renamingSessionId === session.id) {
        renameEditorCreated = true;
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
        var time = document.createElement("span");
        time.className = "session-time";
        time.textContent = timeText;
        openButton.appendChild(time);

        var actions = document.createElement("div");
        actions.className = "session-actions";

        var renameButton = document.createElement("button");
        renameButton.type = "button";
        renameButton.className = "session-mini session-icon-action";
        renameButton.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3l5 5-12 12-6 1 1-6L16 3Z M14 5l5 5"/></svg>';
        renameButton.title = "重命名会话";
        renameButton.setAttribute("aria-label", "重命名会话：" + (session.title || "新会话"));
        renameButton.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          renameSession(session.id);
        });

        var deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "session-mini danger session-icon-action";
        deleteButton.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/></svg>';
        deleteButton.title = "删除会话（可恢复）";
        deleteButton.setAttribute("aria-label", "删除会话：" + (session.title || "新会话"));
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
      meta.textContent = metaText;

      item.appendChild(row);
      item.appendChild(meta);
      nodes.push(item);
    });
    reconcileSessionList(nodes);

    if (renameEditorCreated) {
      focusRenameInputSoon();
    }
  }

  function sessionExecutionGroup(session) {
    var remote = session && session.remoteExecution && typeof session.remoteExecution === "object" ? session.remoteExecution : null;
    if (remote && (remote.task_id || remote.node_id)) {
      return "执行设备：" + (remote.node_name || remote.device_name || remote.node_id || "未知设备");
    }
    if (hostedPage && lkaHost.role === "hub") return "云端会话";
    if (hostedPage && lkaHost.role === "replica") return "本机 · " + (lkaHost.info && lkaHost.info.node_id || "设备");
    return "本机会话";
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
    if (managerEmbedding) return;
    try {
      var response = await fetch(backendBaseUrl + "/sessions/deleted?limit=200", {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var payload = await response.json();
      backendDeletedSessions = (Array.isArray(payload.sessions) ? payload.sessions : [])
        .filter(function (item) { return item && item.session_id && item.kind !== "manager"; })
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
    if (conversationReading) conversationReading.beforeRender();
    renderingMessages = true;
    try { renderActiveMessagesContent(); } finally {
      renderingMessages = false;
      if (conversationReading) conversationReading.afterRender();
    }
  }

  async function loadEarlierMessages() {
    var session = getActiveSession();
    if (!session || !sessionHistory || sessionHistory.state(session.id).loading) return;
    var expected = sessionMessageSnapshot(session.id);
    var host = window.LkaMatterHost;
    try {
      var operation = sessionHistory.load(session.id, { before: true, request: isManagerSession(session) && host && host.request
        ? function (path) { return Promise.resolve(host.ready).then(function () { return host.request(path, "GET"); }); } : historyRequest });
      renderActiveMessages();
      var remote = sessionFromBackendDetail(await operation);
      if (getSessionById(session.id) !== session || activeSessionId !== session.id) return;
      mergeBackendSession(remote, expected);
      persistSessions(); renderActiveMessages();
    } catch (error) {
      if (error.name !== "AbortError") setRunStatus("更早消息加载失败，请重试：" + safeText(error.message || error), "error");
      if (activeSessionId === session.id) renderActiveMessages();
    }
  }

  async function loadLatestMessages() {
    var session = getActiveSession();
    if (!session || !sessionHistory || !sessionHistory.state(session.id).anchored) return;
    var expected = sessionMessageSnapshot(session.id);
    try {
      sessionHistory.clear(session.id);
      var detail = await sessionHistory.load(session.id);
      if (getActiveSession() !== session) return;
      var remote = sessionFromBackendDetail(detail);
      if (remote) mergeBackendSession(remote, expected);
      renderActiveMessages(); messages.scrollTop = messages.scrollHeight;
      setRunStatus("已回到最新消息");
    } catch (error) {
      if (activeSessionId === session.id) setRunStatus("载入最新消息失败：" + safeText(error.message || error), "error");
    }
  }

  function renderActiveMessagesContent() {
    var session = getActiveSession();
    if (session && session.pausedAnswer && !isTerminalRunStatus(session.runControlStatus) && !liveAnswers[session.id]) liveAnswers[session.id] = session.pausedAnswer;
    if (!workMode && typeof window.__petQuickBeforeMessagesRender === "function") window.__petQuickBeforeMessagesRender();
    messages.innerHTML = "";
    if (session && sessionHistory && sessionHistory.state(session.id).hasMore) {
      var earlier = document.createElement("button");
      earlier.type = "button"; earlier.id = "loadEarlierMessagesButton"; earlier.className = "side-action";
      earlier.disabled = sessionHistory.state(session.id).loading;
      earlier.textContent = earlier.disabled ? "正在加载更早消息…" : "加载更早消息";
      earlier.addEventListener("click", loadEarlierMessages);
      messages.appendChild(earlier);
    }
    if (session && sessionHistory && sessionHistory.state(session.id).anchored) {
      var latest = document.createElement("button"); latest.type = "button"; latest.id = "loadLatestMessagesButton";
      latest.className = "side-action"; latest.textContent = "回到最新消息"; latest.addEventListener("click", loadLatestMessages);
      messages.appendChild(latest);
    }
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
      ((managerEmbedding || isManagerSession(getActiveSession())) ? '<h1>把事情交给真理</h1><p>整理目标、委托任务，持续跟进进展。需要你决定时，会在右侧提醒。</p>' : '<h1>现在，想推进哪件事？</h1><p>直接描述目标即可。会话消息独立保存，资料与结果留在当前工作目录。</p>');
    var suggestions = document.createElement("div");
    suggestions.className = "welcome-suggestions";
    (isManagerSession(getActiveSession()) ? ["整理本周需要关注的事", "查看目标进展", "规划接下来的安排"] : ["梳理这个工作区的文件", "帮我制定下一步计划", "总结一份资料"]).forEach(function (prompt) {
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
          renderRunControls();
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

  async function switchSession(sessionId, assistantEpoch, manager) {
    if (assistantEpoch === undefined) cancelQuickAssistantOpen();
    var selectionEpoch = quickAssistantEpoch, next;
    try { next = await ensureLocalSession(sessionId); }
    catch (error) {
      if (selectionEpoch !== quickAssistantEpoch) return false;
      setRunStatus("会话载入失败：" + safeText(error.message || error), "error");
      loadHistoryPage(true);
      return;
    }
    if (selectionEpoch !== quickAssistantEpoch) return false;
    saveCurrentDraft();
    leaveActiveConversation();
    setComposerDisabled(backendOffline);
    renamingSessionId = "";
    renameDraft = "";
    activeSessionId = next.id;
    pendingState = managerPendingTurns[next.id] || null;
    activeAgentEventController = managerStreams[next.id] && managerStreams[next.id].controller || null;
    managerSessionReady = !isManagerSession(next);
    setComposerDisabled(backendOffline);
    if (isManagerSession(next)) {
      try { await prepareManagerConversation(next.id, manager); }
      catch (error) { return false; }
      if (selectionEpoch !== quickAssistantEpoch || activeSessionId !== next.id) return false;
    }
    var discovered = null;
    try { discovered = await discoverSessionRootRun(next); }
    catch (error) { if (activeSessionId === next.id) setRunStatus("无法核对当前任务：" + safeText(error.message || error), "error"); }
    if (selectionEpoch !== quickAssistantEpoch || activeSessionId !== next.id) return false;
    showDraftForSession(next);
    fileRelativePath = "";
    renderSessionList();
    renderActiveMessages();
    prepareSessionWorkspace(next);
    refreshActiveMultiAgentSnapshot();
    refreshManagerInputs();
    var discoveredIsPausedManager = discovered && isManagerSession(next) && discovered.run.status === "paused"
      && !next.resumePending && !!runProcesses[next.id];
    if (discovered && discovered.run.status !== "completed" && discovered.run.status !== "cancelled") {
      if (!discoveredIsPausedManager && !(isManagerSession(next) && managerStreams[next.id] && managerStreams[next.id].runId === next.multiAgentRunId)) reconnectSavedRun(next, null);
    } else if (!discovered) reconnectActiveSavedRun();
    loadFileList();
    persistSessions();
    setSidebarOpen(false);
    focusComposer();
    return true;
  }

  function createAndSwitchNewSession(projectWorkspace) {
    if (managerEmbedding) return;
    cancelQuickAssistantOpen();
    setRunStatus("就绪");
    saveCurrentDraft();
    leaveActiveConversation();
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
    if (managerEmbedding) return;
    cancelQuickAssistantOpen();
    setRunStatus("就绪");
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
      runId: safeText(options && options.runId).trim(),
      traceId: safeText(options && options.traceId).trim(),
      logPath: safeText(options && options.logPath).trim(),
      attachments: window.LkaImageComposer.normalize(options && options.attachments),
      clientId: safeText(options && options.clientId),
      messageId: safeText(options && options.messageId),
      inputStatus: safeText(options && options.inputStatus),
      inputError: "",
      queueRequest: options && options.queueRequest || null,
      selectedPackage: safeText(options && options.selectedPackage).trim()
    });
    if (session.messages.length > 180 && !(sessionHistory && sessionHistory.state(session.id).expanded)) session.messages = session.messages.slice(-180);
  }

  function resizeWorkbenchComposer() {
    if (!workMode) return;
    if (document.body.classList.contains("mobile-workbench")) {
      if (typeof window.LkaMobileResizeComposer === "function") window.LkaMobileResizeComposer();
      return;
    }
    input.rows = 1;
    input.style.height = "36px";
    var draftHeight = input.scrollHeight;
    input.style.height = Math.min(156, Math.max(36, draftHeight)) + "px";
    input.style.overflowY = draftHeight > 156 ? "auto" : "hidden";
  }

  function renderInputQueueNotice(session) {
    var state = queueEnabled(session) ? queueState(session) : null;
    var visible = !!(state && state.paused && state.pending_count > 0);
    var notice = document.querySelector("#managerInputQueueNotice");
    if (!notice && visible && form && form.parentNode) {
      notice = document.createElement("div");
      notice.id = "managerInputQueueNotice";
      notice.className = "run-status review";
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      var text = document.createElement("span");
      text.textContent = "上一轮未完成，消息已收到，等待继续";
      notice.appendChild(text);
      var button = document.createElement("button");
      button.type = "button";
      button.className = "text-action";
      button.textContent = "继续处理";
      button.addEventListener("click", function () { resumeManagerInputs(getActiveSession()); });
      notice.appendChild(button);
      var primaryButton = document.createElement("button");
      primaryButton.type = "button";
      primaryButton.className = "text-action";
      primaryButton.textContent = "改用推理模型继续";
      primaryButton.setAttribute("data-action", "resume-primary");
      primaryButton.addEventListener("click", function () {
        var active = getActiveSession(), pending = firstUnboundManagerInput(active);
        if (pending) resumeManagerInputs(active, pending.input_id);
      });
      notice.appendChild(primaryButton);
      form.parentNode.insertBefore(notice, form);
    }
    if (!notice) return;
    notice.hidden = !visible;
    if (visible) {
      var resumeButton = notice.querySelector("button");
      // A queue continuation cannot resume a paused root or approve its tools.
      resumeButton.disabled = backendOffline || !managerSessionReady || state.resuming || !inputQueueNeedsResume(session);
      resumeButton.textContent = state.resuming ? "正在继续…" : "继续处理";
      resumeButton.title = inputQueueNeedsResume(session) ? "继续处理已收到的消息，不重发失败消息" : "请先处理当前任务的暂停、审批或待回答问题";
      var primaryButton = notice.querySelector('[data-action="resume-primary"]');
      primaryButton.hidden = !firstUnboundManagerInput(session);
      primaryButton.disabled = resumeButton.disabled;
      primaryButton.title = "使用推理模型回答下一条已收到的消息，不重发失败消息";
    }
  }

  function renderRunControls(overrideDraft) {
    resizeWorkbenchComposer();
    var session = getActiveSession(), status = session && session.runControlStatus || "";
    var activeRun = !!(session && session.multiAgentRunId && status && !isTerminalRunStatus(status));
    var inputState = isManagerSession(session) ? queueState(session) : null;
    renderInputQueueNotice(session);
    var controlState = (session && session.resumePending || inputState && inputState.resuming) ? "resuming" : session && session.pauseRequested ? "pause_requested" : status || "idle";
    if (sendButton.getAttribute("data-run-state") !== controlState) sendButton.setAttribute("data-run-state", controlState);
    var draft = document.body.classList.contains("native-composer") ? session && readDraft(session.id) || "" : input.value;
    if (typeof overrideDraft === "string") draft = overrideDraft;
    var hasContent = !!safeText(draft).trim() || !!(session && window.LkaImageComposer.hasAttachments(session.id));
    var continuous = queueEnabled(session);
    var resumeInputs = !hasContent && inputQueueNeedsResume(session);
    var action = resumeInputs ? "resume" : hasContent || !activeRun ? "send" : status === "paused" ? "resume" : "pause";
    if (form && form.dataset.inputMode !== (continuous ? "continuous" : "single")) form.dataset.inputMode = continuous ? "continuous" : "single";
    var locked = backendOffline || !managerSessionReady || !!(session && (runCommandInFlight[session.id] || session.resumePending || session.pauseRequested));
    var running = activeRun && status !== "paused";
    if (continuous && action === "send") locked = backendOffline || !managerSessionReady;
    if (session && session.connectionUncertain && !session.multiAgentRunId) locked = true;
    if (resumeInputs && inputState.resuming) locked = true;
    var inputCapability = inputState;
    if (action === "send" && inputCapability && !inputCapability.supported && !inputCapability.unsupported) locked = true;
    var disabled = locked || action === "send" && !continuous && (running || !!pendingState || !activeRun && composerRequestedBusy);
    if (sendButton.getAttribute("data-action") !== action) {
      var path = action === "pause" ? "M8 5v14M16 5v14" : action === "resume" ? "m9 5 11 7-11 7Z" : "M3 11L21 3L13 21L10 13Z M10 13L21 3";
      sendButton.innerHTML = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"/></svg>';
      sendButton.setAttribute("data-action", action);
    }
    var label = action === "pause" ? "暂停任务" : action === "resume" ? "继续任务" : "发送任务";
    var title = session && session.pauseRequested ? "正在暂停，等待当前步骤结束" : session && session.resumePending ? "正在继续任务" :
      action === "pause" ? "暂停任务，当前步骤结束后生效" : action === "resume" ? "从暂停的位置继续" :
      status === "paused" ? "发送新指令，打断并替换暂停的任务" : running ? "任务运行中，可先写好下一条消息" : "发送任务";
    if (continuous && action === "send") {
      var replacingPaused = !!pausedInputReplacement(session);
      label = replacingPaused ? "替换暂停任务" : "发送消息";
      title = replacingPaused ? "用新指令替换暂停的任务并开始执行；保留其他排队消息" : activeRun ? "发送后排队，当前任务结束后自动处理" : "发送消息";
    }
    if (resumeInputs) { label = "继续处理消息"; title = "继续处理未完成的消息"; }
    if (sendButton.title !== title) sendButton.title = title;
    if (sendButton.getAttribute("aria-label") !== label) sendButton.setAttribute("aria-label", label);
    sendButton.disabled = !!disabled;
    input.disabled = false;
    var projectButton = document.querySelector("#newProjectSessionButton");
    if (projectButton) projectButton.disabled = !!pendingState || running || !session || !session.workspace;
    if (window.petBridge) {
      if (typeof window.petBridge.setComposerAction === "function") window.petBridge.setComposerAction(action);
      if (typeof window.petBridge.setComposerBusy === "function") window.petBridge.setComposerBusy(!!disabled);
    }
  }

  function settlePausedRun(session, turnState) {
    session = session && (getSessionById(session.id) || session);
    session.runControlStatus = "paused"; session.pauseRequested = false; session.resumePending = false;
    session.timelineState = "paused";
    session.pausedAnswer = turnState && turnState.answer || liveAnswers[session.id] || session.pausedAnswer || "";
    if (turnState) suspendedTurns[session.id] = turnState;
    delete managerPendingTurns[session.id];
    if (pendingState && pendingState.conversationId === session.id) pendingState = null;
    if (activeSessionId === session.id) {
      setRunStatus(session.controlNotice || "已暂停，可继续或发送新指令", session.controlNotice ? "error" : "");
      setComposerDisabled(backendOffline);
      renderRunTimeline(session);
    }
    persistSessions();
  }

  function settleCancelledRun(session) {
    session = session && (getSessionById(session.id) || session);
    if (cancelledRunIds[session.multiAgentRunId]) return;
    cancelledRunIds[session.multiAgentRunId] = true;
    if (activeSessionId === session.id) { activeAgentTurnGeneration += 1; abortActiveAgentEventStream(); }
    session.runControlStatus = "cancelled"; session.pauseRequested = false; session.resumePending = false;
    session.controlNotice = ""; session.timelineState = "cancelled"; session.pausedAnswer = "";
    delete suspendedTurns[session.id]; delete runProcesses[session.id];
    delete managerPendingTurns[session.id];
    if (managerStreams[session.id]) { managerStreams[session.id].controller.abort(); delete managerStreams[session.id]; }
    // Preserve already streamed text, but never invent an assistant error/reply.
    if (liveAnswers[session.id]) { addMessageToSession(session, "assistant", liveAnswers[session.id], false); delete liveAnswers[session.id]; }
    if (pendingState && pendingState.conversationId === session.id) pendingState = null;
    if (activeSessionId === session.id) { setRunStatus("本轮已打断，可发送新任务"); setComposerDisabled(backendOffline); renderActiveMessages(); }
    persistSessions();
  }

  function followSupersedingRun(session, replacementId) {
    session = session && (getSessionById(session.id) || session);
    if (!replacementId || replacementId === session.multiAgentRunId) return;
    var generation = activeSessionId === session.id ? ++activeAgentTurnGeneration : activeAgentTurnGeneration;
    if (activeSessionId === session.id) abortActiveAgentEventStream();
    session.multiAgentRunId = replacementId; session.multiAgentSequence = 0; session.multiAgentSnapshot = null;
    session.runControlStatus = "running"; session.pauseRequested = false; session.resumePending = false;
    session.controlNotice = ""; session.timelineState = "running"; session.timelineEvents = []; session.pausedAnswer = "";
    delete liveAnswers[session.id]; delete runProcesses[session.id]; delete suspendedTurns[session.id];
    delete replacementCommands[session.id]; saveRunCursor(session); persistSessions();
    if (activeSessionId !== session.id) {
      if (isManagerSession(session)) { delete managerPendingTurns[session.id]; reconnectSavedRun(session, null); }
      return;
    }
    pendingState = { conversationId: session.id, generation: generation };
    setComposerDisabled(true); setRunStatus("正在接回新指令的任务…");
    var expectedMessages = sessionMessageSnapshot(session.id);
    fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(session.id)).then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (detail) {
      if (!detail || activeAgentTurnGeneration !== generation || session.multiAgentRunId !== replacementId
          || expectedMessages !== sessionMessageSnapshot(session.id)) return;
      var remote = sessionFromBackendDetail(detail);
      var historyReset = remote ? reconcileHistoryReset(session, remote) : -1;
      if (historyReset >= 0 && (historyReset > 0 || remote.backendHistoryFiltered || remote.messages.length >= session.messages.length)) { session.messages = remote.messages; if (activeSessionId === session.id) renderActiveMessages(); persistSessions(); }
    }).catch(function () {});
    reconnectSavedRun(session, { answer: "", events: [], session: session, generation: generation, terminal: false });
  }

  function applyRunSnapshot(session, run) {
    session = session && (getSessionById(session.id) || session);
    if (!session || !run || run.run_id && run.run_id !== session.multiAgentRunId) return;
    if (run.superseded_by_run_id) { followSupersedingRun(session, run.superseded_by_run_id); return; }
    // Reading an unchanged status must not broadcast the page's cache again.
    if (session.runControlStatus === safeText(run.status) && session.pauseRequested === !!run.pause_requested
        && !session.resumePending && (run.status !== "paused" || session.timelineState === "paused")
        && (run.status !== "cancelled" || session.timelineState === "cancelled")) {
      if (activeSessionId === session.id) setComposerDisabled(!!pendingState && !isTerminalRunStatus(session.runControlStatus));
      return;
    }
    session.runControlStatus = safeText(run.status);
    session.pauseRequested = !!run.pause_requested;
    if (session.runControlStatus !== "paused") session.resumePending = false;
    if (session.runControlStatus === "paused" && !session.resumePending) settlePausedRun(session);
    else if (session.runControlStatus === "cancelled") settleCancelledRun(session);
    else if (activeSessionId === session.id) setComposerDisabled(!!pendingState && !isTerminalRunStatus(session.runControlStatus));
    persistSessions();
  }

  async function postRunCommand(runId, action, body) {
    var response = await fetch(backendBaseUrl + "/agent/runs/" + encodeURIComponent(runId) + "/" + action, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {})
    });
    var data = await response.json();
    if (!response.ok) {
      var detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail || {});
      throw new Error("HTTP " + response.status + "：" + (detail || response.statusText));
    }
    return data;
  }

  async function controlActiveRun(action) {
    var session = getActiveSession();
    if (!session || !session.multiAgentRunId || runCommandInFlight[session.id] || backendOffline) return;
    var runId = session.multiAgentRunId, controlAuthEpoch = assistantCacheEpoch;
    runCommandInFlight[session.id] = true; session.controlNotice = ""; setComposerDisabled(true);
    try {
      var result = await postRunCommand(runId, action);
      if (controlAuthEpoch !== assistantCacheEpoch) return;
      session = getSessionById(session.id) || session;
      if (session.multiAgentRunId !== runId) return;
      if (action === "resume") {
        // The response may still be a paused snapshot: resume is scheduled async.
        session.resumePending = true; session.pauseRequested = false;
        session.controlNotice = "";
        var state = suspendedTurns[session.id] || { answer: liveAnswers[session.id] || "", events: [] };
        state.generation = activeSessionId === session.id ? ++activeAgentTurnGeneration : activeAgentTurnGeneration; state.finalized = false; state.paused = false; state.terminal = false; state.terminalStatus = "";
        if (activeSessionId === session.id || isManagerSession(session)) {
          var resumedPending = { conversationId: session.id, generation: state.generation };
          if (activeSessionId === session.id) pendingState = resumedPending;
          if (isManagerSession(session)) managerPendingTurns[session.id] = resumedPending;
          reconnectSavedRun(session, state);
        }
      } else applyRunSnapshot(session, result);
    } catch (error) {
      session.resumePending = false;
      session.controlNotice = "操作未生效：" + safeText(error.message);
      if (activeSessionId === session.id) setRunStatus(session.controlNotice, "error");
    } finally {
      delete runCommandInFlight[session.id];
      if (activeSessionId === session.id) setComposerDisabled(!!pendingState);
    }
  }

  function setComposerDisabled(disabled) {
    composerRequestedBusy = !!disabled;
    renderRunControls();
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

  function normalizeBackendMessages(rawMessages, keepAll) {
    if (!Array.isArray(rawMessages)) {
      return [];
    }
    var normalized = [];
    rawMessages.forEach(function (entry) {
      if (!entry || typeof entry !== "object") {
        return;
      }
      var role = normalizeBackendRole(entry);
      var instruction = backendManagerInstruction(entry);
      var content = instruction || safeText(entry.content || entry.text).trim();
      if (!content && entry.payload && Array.isArray(entry.payload.attachment_ids) && entry.payload.attachment_ids.length) content = "[File input]";
      if (!role || !content) {
        return;
      }
      var details = !instruction && entry.payload && typeof entry.payload === "object" ? buildAgentRunDetails(entry.payload) : {};
      normalized.push({
        messageId: safeText(entry.message_id),
        clientId: safeText(entry.payload && entry.payload.client_message_id),
        progressEvents: details.progressEvents || [],
        verificationWarnings: details.verificationWarnings || [],
        runId: details.runId || "",
        traceId: details.traceId || "",
        logPath: details.logPath || "",
        selectedPackage: details.selectedPackage || "",
        role: role,
        messageKind: instruction ? "manager_instruction" : "",
        text: content,
        isError: false,
        attachments: window.LkaImageComposer.fromIds(entry.payload && entry.payload.attachment_ids)
      });
    });
    return keepAll ? normalized : normalized.slice(-180);
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

  function agentTurnError(response, text, sessionId) {
    var error = new Error("HTTP " + response.status + " " + response.statusText + (text ? ": " + text.slice(0, 500) : ""));
    error.httpStatus = response.status;
    if (response.status === 409 && getSessionById(sessionId)) {
      try { var conflict = JSON.parse(text); if (conflict.session_id === sessionId && typeof conflict.run_id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(conflict.run_id)) error.conflictingRunId = conflict.run_id; } catch (ignored) {}
    }
    return error;
  }

  async function callAgentTurn(payload) {
    var llm = {};
    if (modelOverridesAllowed(payload.session_id || payload.conversation_id) && runSettings.llmClient) llm.client_name = runSettings.llmClient;
    if (modelOverridesAllowed(payload.session_id || payload.conversation_id) && runSettings.llmModel) llm.model = runSettings.llmModel;
    if (modelOverridesAllowed(payload.session_id || payload.conversation_id) && runSettings.llmAnswerModel) { llm.answer_client_name = runSettings.llmAnswerClient || undefined; llm.answer_model = runSettings.llmAnswerModel; }
    var reasoningLevel = requestReasoningLevel(payload.session_id || payload.conversation_id);
    if (reasoningLevel) llm.reasoning_level = reasoningLevel;
    var response = await fetch(backendBaseUrl + "/agent/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: payload.session_id || payload.conversation_id,
        user_input: payload.question || payload.user_input || "",
        attachment_ids: payload.attachment_ids || [],
        resumable: true,
        client_request_id: payload.client_request_id,
        llm: llm,
        safety_review_mode: payload.safety_review_mode || undefined
      })
    });
    var text = await response.text();
    var data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw agentTurnError(response, text, payload.session_id || payload.conversation_id);
    }
    data.conversation_id = data.session_id || payload.conversation_id || payload.session_id;
    return data;
  }

  async function callAgentTurnStream(payload, onEvent, signal) {
    var llm = { response_mode: runSettings.stream ? "stream" : "text" };
    if (modelOverridesAllowed(payload.session_id || payload.conversation_id) && runSettings.llmClient) llm.client_name = runSettings.llmClient;
    if (modelOverridesAllowed(payload.session_id || payload.conversation_id) && runSettings.llmModel) llm.model = runSettings.llmModel;
    if (modelOverridesAllowed(payload.session_id || payload.conversation_id) && runSettings.llmAnswerModel) { llm.answer_client_name = runSettings.llmAnswerClient || undefined; llm.answer_model = runSettings.llmAnswerModel; }
    var reasoningLevel = requestReasoningLevel(payload.session_id || payload.conversation_id);
    if (reasoningLevel) llm.reasoning_level = reasoningLevel;
    var response = await fetch(backendBaseUrl + "/agent/turn/stream", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ session_id: payload.session_id, user_input: payload.question, attachment_ids: payload.attachment_ids || [],
        resumable: true, client_request_id: payload.client_request_id,
        llm: llm, safety_review_mode: payload.safety_review_mode || undefined }),
      signal: signal
    });
    if (!response.ok) {
      var errorBody = await response.text();
      throw agentTurnError(response, errorBody, payload.session_id || payload.conversation_id);
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
      || eventName === "run_timed_out"
      || eventName === "run_paused"
      || eventName === "run_resumed";
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
      || eventName === "run_timed_out"
      || eventName === "run_paused"
      || eventName === "run_resumed";
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
    var head = pendingSafetyReviews[0];
    var origin = head && (getSessionById(head.session_id) || historyItems.find(function (item) { return item.id === head.session_id; }));
    var sourceName = origin ? isManagerSession(origin) ? "真理" : origin.title || "独立任务" : "其他会话";
    // Preserve focus and disclosure state while background snapshots revalidate.
    var renderKey = JSON.stringify([pendingSafetyReviews, sourceName, approvalQueueReady, approvalActionInFlight, approvalQueueNotice]);
    if (approvalQueueRenderKey === renderKey) return;
    approvalQueueRenderKey = renderKey;
    var oldDetails = approvalQueueStatus.querySelector(".approval-details");
    var expanded = oldDetails && oldDetails.open && head && approvalQueueStatus.dataset.reviewId === head.review_id;
    approvalQueueStatus.textContent = "";
    approvalQueueStatus.setAttribute("role", "region");
    approvalQueueStatus.removeAttribute("aria-modal");
    approvalQueueStatus.setAttribute("aria-label", "待确认操作");
    approvalQueueStatus.dataset.reviewId = head ? head.review_id : "";
    approvalQueueStatus.hidden = !head && !approvalQueueNotice;
    if (approvalQueueStatus.hidden) return;

    function textNode(tag, className, text) { var node = document.createElement(tag); node.className = className; node.textContent = text; return node; }
    if (head) {
      var content = document.createElement("div"); content.className = "approval-content";
      var header = document.createElement("div"); header.className = "approval-heading";
      var mark = document.createElement("span"); mark.className = "approval-mark"; mark.setAttribute("aria-hidden", "true");
      mark.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="M12 8v5m0 3h.01"/></svg>';
      header.appendChild(mark); header.appendChild(textNode("strong", "approval-title", "需要确认"));
      var source = textNode("span", "approval-source", "来自 " + sourceName); source.title = source.textContent; header.appendChild(source);
      var risk = textNode("span", "approval-risk", { low: "低风险", medium: "中风险", high: "高风险", critical: "高风险" }[head.tool_risk] || "风险待评估");
      risk.dataset.risk = safeText(head.tool_risk); header.appendChild(risk); content.appendChild(header);
      var tool = textNode("p", "approval-tool", safeText(head.tool_name || "工具调用")); tool.title = tool.textContent; content.appendChild(tool);
      var paths = Array.isArray(head.workspace_access) ? head.workspace_access : [];
      var preview = paths.length ? "访问工作区外：" + safeText(paths[0]) + (paths.length > 1 ? "（另 " + (paths.length - 1) + " 处）" : "") : safeText(head.reason || "此操作需要你的允许后才能继续。");
      var reason = textNode("p", "approval-reason", preview); reason.title = preview; content.appendChild(reason);
      approvalQueueStatus.appendChild(content);

      var actions = document.createElement("div"); actions.className = "approval-queue-actions";
      ["approve", "reject"].forEach(function (decision) {
        var button = document.createElement("button"); button.type = "button";
        button.className = decision === "approve" ? "approval-allow" : "approval-deny";
        button.textContent = decision === "approve" ? "允许" : "拒绝";
        button.setAttribute("aria-label", decision === "approve" ? "允许当前项" : "拒绝当前项");
        button.disabled = !approvalQueueReady || approvalActionInFlight;
        button.addEventListener("click", function () { decideHeadSafetyReview(head, decision); });
        actions.appendChild(button);
      });
      approvalQueueStatus.appendChild(actions);

      var details = document.createElement("details"); details.className = "approval-details"; details.open = !!expanded;
      details.appendChild(textNode("summary", "", "操作详情"));
      var facts = document.createElement("dl"); facts.className = "approval-facts";
      function fact(label, value) { if (!value) return; facts.appendChild(textNode("dt", "", label)); facts.appendChild(textNode("dd", "", value)); }
      fact("原因", safeText(head.reason));
      fact("可能影响", Array.isArray(head.side_effects) ? head.side_effects.map(safeText).join("、") : "");
      fact("涉及字段", Array.isArray(head.input_fields) ? head.input_fields.map(safeText).join("、") : "");
      fact("工作区外路径", paths.map(safeText).join("\n"));
      if (head.child_run_id) fact("执行方式", "子任务");
      details.appendChild(facts);
      if (head.session_id) {
        var link = document.createElement("a"), url = new URL("./chat.html", location.href); url.search = "";
        url.searchParams.set("mode", "work"); url.searchParams.set("session_id", head.session_id); url.searchParams.set("backend", backendBaseUrl);
        if (head.run_id) url.searchParams.set("run_id", head.run_id);
        link.href = url.href; link.target = "_blank"; link.rel = "noopener"; link.className = "approval-origin-link"; link.textContent = "查看来源会话";
        details.appendChild(link);
      }
      approvalQueueStatus.appendChild(details);
    }
    if (approvalQueueNotice) {
      var notice = textNode("p", "approval-queue-notice", safeText(approvalQueueNotice));
      notice.setAttribute("role", "status"); approvalQueueStatus.appendChild(notice);
    }
  }

  async function refreshSafetyReviewQueue() {
    if (approvalQueueRequestInFlight) {
      approvalQueueRefreshRequested = true;
      return;
    }
    approvalQueueRequestInFlight = true;
    var epoch = approvalQueueEpoch;
    try {
      // A loopback workbench does not know whether its backend is a local node
      // until the async identity probe completes. Wait before selecting the
      // global queue: replicas only authorize reviews scoped to a run.
      if (lkaHost && typeof lkaHost.routingReady === "function") await lkaHost.routingReady();
      var result;
      if (nodeBoundary()) {
        // Nodes refuse the global queue; read the active run's own reviews.
        // Cloud assistant runs still route through the host layer by run ID.
        var nodeSession = getActiveSession();
        var nodeRun = nodeSession ? safeText(nodeSession.multiAgentRunId).trim() : "";
        result = { reviews: [] };
        if (nodeRun) {
          var runResponse = await fetch(backendBaseUrl + "/agent/runs/" + encodeURIComponent(nodeRun) + "/safety-reviews", { headers: { Accept: "application/json" } });
          if (!runResponse.ok && runResponse.status !== 404 && runResponse.status !== 403) throw new Error("HTTP " + runResponse.status);
          if (runResponse.ok) result = await runResponse.json();
        }
      } else {
        var response = await fetch(backendBaseUrl + "/agent/safety-reviews", {
          headers: { Accept: "application/json" }
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        result = await response.json();
      }
      if (epoch !== approvalQueueEpoch) return;
      var reviews = Array.isArray(result && result.reviews) ? result.reviews : [];
      pendingSafetyReviews = reviews.filter(function (review) {
        return review && safeText(review.review_id).trim() && review.status === "pending";
      });
      approvalQueueReady = true;
      if (!approvalActionInFlight) approvalQueueNotice = "";
    } catch (error) {
      if (epoch !== approvalQueueEpoch) return;
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
    ++approvalQueueEpoch;
    approvalQueueNotice = "正在提交…";
    renderApprovalQueue();
    try {
      var response = await fetch(backendBaseUrl + "/agent/safety-reviews/" + encodeURIComponent(head.review_id) + "/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: decision, reason: "用户通过 Agent 审批队列决定", decided_by: "user" })
      });
      if (response.status === 409) {
        ++approvalQueueEpoch; approvalQueueReady = false;
        approvalQueueNotice = "队列顺序已变化，已重新读取当前首项。";
        await refreshSafetyReviewQueue();
        renderApprovalQueue();
        return;
      }
      if (!response.ok) throw new Error("HTTP " + response.status);
      // Commit the acknowledged item locally without waiting for another GET.
      // Fence snapshots started before the acknowledgement so it cannot return.
      ++approvalQueueEpoch;
      pendingSafetyReviews = pendingSafetyReviews.filter(function (item) { return item.review_id !== head.review_id; });
      approvalQueueNotice = "";
      renderApprovalQueue();
      refreshSafetyReviewQueue();
      setRunStatus(decision === "approve" ? "审批已通过，Agent 将继续执行。" : "审批已拒绝，Agent 将收到拒绝结果。");
    } catch (error) {
      var failureNotice = "审批提交失败：" + safeText(error.message);
      ++approvalQueueEpoch; approvalQueueReady = false;
      await refreshSafetyReviewQueue();
      approvalQueueNotice = failureNotice;
      renderApprovalQueue();
    } finally {
      approvalActionInFlight = false;
      renderApprovalQueue();
    }
  }

  function leaveActiveConversation() {
    if (conversationReading) conversationReading.capture();
    var current = getActiveSession();
    if (isManagerSession(current)) {
      if (pendingState && pendingState.conversationId === current.id) managerPendingTurns[current.id] = pendingState;
      activeAgentEventController = null;
    } else abortActiveAgentEventStream();
    activeAgentTurnGeneration += 1;
    pendingState = null;
  }
  function turnIsCurrent(session, generation) {
    if (isManagerSession(session)) {
      var turn = managerPendingTurns[session.id];
      return !!turn && turn.generation === generation && !deletedSessionIds[session.id];
    }
    return generation === activeAgentTurnGeneration;
  }
  function abortActiveAgentEventStream() {
    var entry = managerStreams[activeSessionId];
    var controller = activeAgentEventController || entry && entry.controller;
    if (entry) delete managerStreams[activeSessionId];
    delete managerPendingTurns[activeSessionId];
    activeAgentEventController = null;
    if (controller && !controller.signal.aborted) controller.abort();
  }

  function isTerminalRunStatus(status) {
    return ["completed", "failed", "cancelled", "timed_out"].indexOf(safeText(status)) >= 0;
  }

  async function readSavedRunStatus(runId, signal) {
    var response = await fetch(backendBaseUrl + "/agent/runs/" + encodeURIComponent(runId), { signal: signal });
    if (!response.ok) throw agentTurnError(response, "", "");
    var run = await response.json();
    var session = sessions.find(function (item) { return item.multiAgentRunId === runId; });
    if (session) { if (session.connectionUncertain) session.controlNotice = ""; session.connectionUncertain = false; applyRunSnapshot(session, run); }
    return session && session.multiAgentRunId !== runId ? session.runControlStatus : safeText(run && run.status).trim();
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
    if (data && data.run_id && data.run_id !== session.multiAgentRunId) return "";
    var sequence = Number(data && data.sequence) || 0, cursor = safeText(eventId).trim();
    if (!sequence && cursor.indexOf(":") >= 0) sequence = Number(cursor.slice(cursor.lastIndexOf(":") + 1)) || 0;
    if (sequence > 0 && data && data.run_id === session.multiAgentRunId
        && sequence <= (Number(session.multiAgentSequence) || 0)) return "";
    var currentSession = rememberStreamPosition(session, data, eventId) || session;
    if (eventName === "run_cancelled" && data && data.payload && data.payload.superseded_by_run_id) {
      followSupersedingRun(currentSession, data.payload.superseded_by_run_id); return "superseded";
    }
    recordRunEvent(currentSession, eventName, data);
    if (eventName === "run_paused") { settlePausedRun(currentSession, turnState); return "paused"; }
    if (eventName === "run_cancelled") settleCancelledRun(currentSession);
    var payload = data && data.payload && typeof data.payload === "object" ? data.payload : {};
    var answer = turnState ? turnState.answer : liveAnswers[currentSession.id] || "";
    var answerVisible = backendUserVisible(data);
    if (!answerVisible && ["llm_delta", "final_answer", "run_completed"].indexOf(eventName) >= 0) {
      clearHiddenStreamAnswer(currentSession, turnState);
      answer = "";
    }
    if (answerVisible && eventName === "llm_delta" && payload.display_target === "assistant_answer") {
      answer = safeText(payload.content_snapshot || (answer + safeText(payload.delta)));
      var streamedBody = runSettings.stream ? renderStreamingAnswer(currentSession, answer, false) : null;
      if (turnState) { turnState.answer = answer; turnState.body = streamedBody; }
    } else if (answerVisible && eventName === "final_answer") {
      var metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
      if (typeof metadata.answer === "string" || (!answer && typeof data.message === "string")) {
        answer = metadata.answer || data.message;
        var finalBody = renderStreamingAnswer(currentSession, answer, true);
        if (turnState) { turnState.answer = answer; turnState.body = finalBody; turnState.userVisible = true; }
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
      if (isTerminalRunStatus(currentSession.runControlStatus) && !pendingState) setComposerDisabled(backendOffline);
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

  var savedRunSubscriptions = Object.create(null);
  window.__petChatReceiveSavedRunStream = function (requestId, eventName, data, eventId) {
    var subscription = savedRunSubscriptions[requestId];
    if (!subscription) return;
    if (typeof data === "string") {
      try { data = JSON.parse(data); }
      catch (error) { subscription.close("保存的运行事件格式无效"); return; }
    }
    subscription.event(eventName, data, eventId);
  };
  window.__petChatSavedRunStreamClosed = function (requestId, error) {
    var subscription = savedRunSubscriptions[requestId];
    if (subscription) subscription.close(error);
  };

  function consumeSavedRunViaBridge(session, controller, turnState) {
    return new Promise(function (resolve, reject) {
      var runId = session.multiAgentRunId, requestBackend = backendBaseUrl;
      var requestId = "saved-" + Date.now() + "-" + Math.random().toString(36).slice(2), settled = false;
      function finish(status, error) {
        if (settled) return; settled = true;
        delete savedRunSubscriptions[requestId]; controller.signal.removeEventListener("abort", abort);
        if (typeof window.petBridge.cancelSavedRunStream === "function") window.petBridge.cancelSavedRunStream(requestId);
        if (error) reject(new Error(safeText(error)));
        else resolve({ terminalStatus: status || "", closed: !status && !controller.signal.aborted });
      }
      function abort() { finish(""); }
      savedRunSubscriptions[requestId] = {
        event: function (name, data, eventId) {
          if (controller.signal.aborted || backendBaseUrl !== requestBackend
              || (activeSessionId !== session.id && !isManagerSession(session)) || session.multiAgentRunId !== runId) return;
          if (data && data.run_id && data.run_id !== runId) return;
          try {
            var status = applySavedRunEvent(session, name, data, eventId, turnState);
            if (status) finish(status);
          } catch (error) { finish("", error.message); }
        },
        close: function (error) { finish("", error); }
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) { abort(); return; }
      try {
        window.petBridge.streamSavedRun(JSON.stringify({ run_id: runId, after_sequence: Math.max(0, Number(session.multiAgentSequence) || 0), request_id: requestId }));
      } catch (error) { finish("", error.message); }
    });
  }

  async function consumeSavedRunEventStream(session, controller, turnState) {
    if (!(lkaHost && lkaHost.isCloudSession(session.id)) && window.petBridge && typeof window.petBridge.streamSavedRun === "function") return consumeSavedRunViaBridge(session, controller, turnState);
    var runId = session.multiAgentRunId, requestBackend = backendBaseUrl;
    var afterSequence = Math.max(0, Number(session.multiAgentSequence) || 0);
    var url = backendBaseUrl + "/agent/runs/" + encodeURIComponent(runId)
      + "/stream?after_sequence=" + encodeURIComponent(afterSequence);
    var response = await fetch(url, { headers: { Accept: "text/event-stream" }, signal: controller.signal });
    if (response.status === 404 || response.status === 410) return { terminalStatus: "missing", missing: true };
    if (!response.ok) throw agentTurnError(response, "", session.id);
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
        if (controller.signal.aborted || backendBaseUrl !== requestBackend
            || (activeSessionId !== session.id && !isManagerSession(session))) return;
        terminalStatus = applySavedRunEvent(session, eventName, data, eventId, turnState) || terminalStatus;
      } catch (error) {
        if (activeSessionId === session.id) setRunStatus("事件解析失败：" + error.message, "error");
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

  function preserveUncertainTurn(session, turnState, error) {
    // A transport outcome says nothing about whether the backend executed a turn.
    // Keep its identity and event cursor so later status reads can settle it.
    if (isTerminalRunStatus(session.runControlStatus)) return;
    session.timelineState = "running";
    session.connectionUncertain = true;
    session.controlNotice = error && [401, 403].indexOf(error.httpStatus) >= 0
      ? "运行状态无法核对：请检查登录和访问权限。"
      : session.multiAgentRunId ? "连接暂不可用，任务状态尚未确认；恢复连接后继续核对。"
      : "发送结果尚未确认，请先核对会话记录；不要重复发送这条任务。";
    if (pendingState && pendingState.conversationId === session.id) pendingState = null;
    delete managerPendingTurns[session.id];
    if (activeSessionId === session.id) {
      setRunStatus(session.controlNotice, "error");
      setComposerDisabled(backendOffline);
    }
    persistSessions();
  }

  async function recoverUncertainSubmission(session, turnState) {
    var requestId = session.pendingClientRequestId, epoch = assistantCacheEpoch;
    if (!requestId || session.multiAgentRunId || !session.connectionUncertain) return;
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, 10000);
    function current() {
      var loaded = getSessionById(session.id);
      return !controller.signal.aborted && epoch === assistantCacheEpoch && loaded
        && loaded.pendingClientRequestId === requestId && !loaded.multiAgentRunId
        && (activeSessionId === session.id || isManagerSession(loaded));
    }
    try {
      // This is correlation, not POST idempotency. Never replay an uncertain turn.
      for (var attempt = 0; attempt < 2 && current(); attempt += 1) {
        try {
          var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(session.id)
            + "/runs?limit=2&client_request_id=" + encodeURIComponent(requestId), { signal: controller.signal });
          if (!response.ok) throw agentTurnError(response, "", session.id);
          var result = await response.json();
          if (!current()) return;
          var runs = result && result.runs;
          // Old servers may ignore the filter. Require explicit exact correlation
          // on a single root run, and reject truncated/ambiguous results.
          if (result.session_id === session.id && Array.isArray(runs) && runs.length === 1
              && !result.next_offset && runs[0].client_request_id === requestId
              && runs[0].session_id === session.id && !runs[0].parent_run_id
              && /^[A-Za-z0-9_-]{1,160}$/.test(runs[0].run_id || "")) {
            session = getSessionById(session.id);
            session.multiAgentRunId = runs[0].run_id; session.multiAgentSequence = 0;
            session.pendingClientRequestId = ""; session.connectionUncertain = false;
            saveRunCursor(session); applyRunSnapshot(session, runs[0]); persistSessions();
            await reconnectSavedRun(session, turnState);
            return;
          }
        } catch (error) {
          if (!current()) return;
          if ([401, 403].indexOf(error.httpStatus) >= 0) { preserveUncertainTurn(session, turnState, error); return; }
        }
        if (attempt === 0 && !await waitForReconnectRetry(400, controller.signal)) return;
      }
    } finally { window.clearTimeout(timer); }
  }

  async function handleNativeUncertainTurn(result) {
    var sessionId = result.session_id || result.conversation_id, session = getSessionById(sessionId);
    if (!session || isTerminalRunStatus(session.runControlStatus)) return;
    var exactRequest = result.client_request_id && result.client_request_id === session.pendingClientRequestId;
    var exactRun = result.run_id && result.run_id === session.multiAgentRunId;
    // Never route a delayed native response to a newer turn or another session.
    if (!exactRequest && !exactRun) return;
    if (result.run_id && session.multiAgentRunId && !exactRun) return;
    if (!session.multiAgentRunId && exactRequest && /^[A-Za-z0-9_-]{1,160}$/.test(result.run_id || "")) {
      session.multiAgentRunId = result.run_id; session.multiAgentSequence = 0; saveRunCursor(session);
    }
    delete nativeTurnGenerations[sessionId];
    var stream = managerStreams[sessionId];
    if (stream) {
      delete managerStreams[sessionId];
      if (activeAgentEventController === stream.controller) activeAgentEventController = null;
      stream.controller.abort();
    }
    preserveUncertainTurn(session, null);
    if (session.multiAgentRunId) await reconnectSavedRun(session, null);
    else await recoverUncertainSubmission(session, null);
  }

  function finishReconnectedTurn(session, turnState, status) {
    if (status === "paused") { settlePausedRun(session, turnState); return; }
    if (status === "cancelled") { settleCancelledRun(session); return; }
    if (!turnState || turnState.finalized || !turnIsCurrent(session, turnState.generation)) return;
    turnState.finalized = true;
    if (status === "completed") {
      window.__petChatReceive({
        session_id: session.id,
        run_id: session.multiAgentRunId,
        answer: turnState.answer || "本轮完成。",
        progress_events: turnState.events, user_visible: turnState.userVisible !== false
      });
    } else if (status) {
      window.__petChatReceive({ session_id: session.id, run_id: session.multiAgentRunId, error: "Agent run " + status + "." });
    }
  }

  async function reconnectSavedRun(session, turnState) {
    if (!session || !session.multiAgentRunId) return;
    if (typeof AbortController !== "function") {
      if (activeSessionId === session.id) setRunStatus("当前 WebView 不支持 Agent 事件流重连", "error");
      preserveUncertainTurn(session, turnState);
      return;
    }
    var existingStream = managerStreams[session.id];
    if (isManagerSession(session) && existingStream && !existingStream.controller.signal.aborted && existingStream.runId === session.multiAgentRunId) return;
    var pendingTurn = activeSessionId === session.id ? pendingState : managerPendingTurns[session.id];
    if (activeSessionId === session.id) abortActiveAgentEventStream();
    else if (existingStream) existingStream.controller.abort();
    var controller = new AbortController();
    if (activeSessionId === session.id) activeAgentEventController = controller;
    if (isManagerSession(session)) managerStreams[session.id] = { controller: controller, runId: session.multiAgentRunId };
    if (turnState && isManagerSession(session)) managerPendingTurns[session.id] = pendingTurn || { conversationId: session.id, generation: turnState.generation };
    var retryDelays = [400, 900, 1800, 3600];
    var runId = session.multiAgentRunId, requestBackend = backendBaseUrl;
    var terminalStatus = "", connectionError = null;
    function stillFollowingRun() {
      return !controller.signal.aborted && backendBaseUrl === requestBackend
        && (activeSessionId === session.id || isManagerSession(session))
        && (getSessionById(session.id) || session).multiAgentRunId === runId;
    }
    try {
      for (var attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        if (controller.signal.aborted || (activeSessionId !== session.id && !isManagerSession(session))
          || (getSessionById(session.id) || session).multiAgentRunId !== runId) return;
        try {
          var currentSession = getSessionById(session.id) || session;
          var result = await consumeSavedRunEventStream(currentSession, controller, turnState);
          if (!stillFollowingRun()) return;
          if (result.terminalStatus) {
            if (result.terminalStatus === "superseded") return;
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
          if (!stillFollowingRun()) return;
          if (isTerminalRunStatus(terminalStatus) || terminalStatus === "paused" && !currentSession.resumePending) break;
          terminalStatus = "";
          throw new Error("Agent event stream closed before the run reached a terminal state");
        } catch (error) {
          if (controller.signal.aborted || (error && error.name === "AbortError")) return;
          connectionError = error;
          if ([401, 403].indexOf(error.httpStatus) >= 0 || attempt >= retryDelays.length) break;
          if (activeSessionId === session.id) setRunStatus("Agent 事件流断开，正在重连（" + (attempt + 1) + "/" + retryDelays.length + "）…");
          if (!await waitForReconnectRetry(retryDelays[attempt], controller.signal)) return;
        }
      }

      if (!terminalStatus) {
        try { terminalStatus = await readSavedRunStatus(runId, controller.signal); } catch (error) { connectionError = error; }
      }
      if (!stillFollowingRun()) return;
      if (terminalStatus === "paused") {
        if (!session.resumePending) settlePausedRun(session, turnState);
        else { session.resumePending = false; if (pendingState && pendingState.conversationId === session.id) pendingState = null; session.controlNotice = "继续尚未生效，请重试"; if (activeSessionId === session.id) setComposerDisabled(backendOffline); }
      } else if (isTerminalRunStatus(terminalStatus)) {
        if (activeSessionId === session.id) {
          if (terminalStatus === "completed") setRunStatus("本轮完成");
          else setRunStatus("本轮" + (terminalStatus === "failed" ? "失败" : terminalStatus === "cancelled" ? "已取消" : "已超时"), terminalStatus === "failed" || terminalStatus === "timed_out" ? "error" : "");
        }
        fetchMultiAgentSnapshot(session, runId);
        finishReconnectedTurn(session, turnState, terminalStatus);
        // A saved run may report completed after the cursor passed its final event.
        if (terminalStatus === "completed") reconcileCompletedSession(session.id);
      } else {
        preserveUncertainTurn(session, turnState, connectionError);
      }
    } finally {
      if (activeAgentEventController === controller) activeAgentEventController = null;
      if (managerStreams[session.id] && managerStreams[session.id].controller === controller) delete managerStreams[session.id];
    }
  }

  function reconnectActiveSavedRun() {
    var session = getActiveSession();
    if (session && session.runControlStatus === "paused" && !session.resumePending) { setComposerDisabled(backendOffline); return; }
    if (session && session.multiAgentRunId && !isTerminalRunStatus(session.runControlStatus)) {
      if (isManagerSession(session) && managerStreams[session.id] && !managerStreams[session.id].controller.signal.aborted) return;
      if (!session.runControlStatus) session.runControlStatus = "queued";
      setComposerDisabled(false);
      readSavedRunStatus(session.multiAgentRunId).catch(function () {});
      reconnectSavedRun(session, null);
    }
  }

  async function refreshActiveRunState() {
    var session = getActiveSession();
    if (runStatusRequestInFlight || !session) return;
    var now = Date.now();
    if (now - (runDiscoveryAt[session.id] || 0) >= 12000) {
      runDiscoveryAt[session.id] = now;
      runStatusRequestInFlight = true;
      try {
        var discovered = await discoverSessionRootRun(session, { replay: false });
        var current = getActiveSession();
        if (!current || current.id !== session.id) return;
        session = current;
        var needsReplay = !runProcesses[session.id]
          && discovered && discovered.run.status !== "completed" && discovered.run.status !== "cancelled";
        var cachedPausedProcess = discovered && discovered.run.status === "paused" && !!runProcesses[session.id];
        if (discovered && (discovered.changed || needsReplay || !cachedPausedProcess && !isTerminalRunStatus(discovered.run.status)
            && !managerStreams[session.id] && !activeAgentEventController)) {
          if (discovered.run.status !== "completed" && discovered.run.status !== "cancelled") {
            if (needsReplay && !managerStreams[session.id] && !activeAgentEventController) {
              session.multiAgentSequence = 0; saveRunCursor(session);
            }
            reconnectSavedRun(session, null);
          }
          return;
        }
      } catch (error) {
        if ([401, 403].indexOf(error.httpStatus) >= 0) setRunStatus("运行状态无法核对：请检查登录和访问权限。", "error");
      } finally { runStatusRequestInFlight = false; }
      if (!getActiveSession() || getActiveSession().id !== session.id) return;
    }
    if (session.connectionUncertain && !session.multiAgentRunId && session.pendingClientRequestId) {
      runStatusRequestInFlight = true;
      try { await recoverUncertainSubmission(session, null); } finally { runStatusRequestInFlight = false; }
      return;
    }
    if (!session.multiAgentRunId || ["running", "waiting", "paused"].indexOf(session.timelineState) < 0) return;
    runStatusRequestInFlight = true;
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
      } else if (status && status !== "paused" && !pendingState && !activeAgentEventController) {
        reconnectSavedRun(session, null);
      }
    } catch (error) {
      if (activeSessionId === session.id && [401, 403].indexOf(error.httpStatus) >= 0) {
        session.controlNotice = "运行状态无法核对：请检查登录和访问权限。";
        setRunStatus(session.controlNotice, "error");
      }
    }
    finally { runStatusRequestInFlight = false; }
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

  // Display names for registered tools; the raw id stays visible as secondary text.
  var toolPackageLabels = { matter: "事项", mail: "邮件", filesystem: "文件", bash: "命令", web: "网页", memory: "记忆",
    observation: "工具结果", knowledge: "知识库", instructions: "指引", context: "上下文", vision: "图片", runtime: "运行环境",
    messages: "消息", projects: "项目", management: "管理", management_delegates: "委托" };
  var toolNameLabels = { "bash.run": "运行命令", "bash.python_environment": "查看 Python 环境", "runtime.now": "查看当前时间",
    "web.open": "打开网页", "web.find": "在网页中查找", "vision.inspect_image": "查看图片", "mail.sync": "同步邮件",
    "mail.snapshot": "读取邮件快照", "mail.persist_matters": "从邮件写入事项", "matter.link_source": "关联事项来源",
    "memory.remember": "保存记忆", "filesystem.list_directory": "查看目录", "context.source": "读取上下文来源" };
  var toolVerbLabels = { list: "查看", get: "读取", read: "读取", search: "搜索", create: "创建", create_many: "批量创建",
    update: "更新", delete: "删除", load: "读取", load_messages: "读取", load_document: "读取", load_chunks: "读取",
    batch_load: "批量读取", group: "整理", list_sources: "查看", read_project: "读取项目", search_project: "搜索项目",
    read_file: "读取", edit_file: "编辑", create_file: "创建", read_session: "读取", write_session: "写入",
    list_sessions: "查看", interrupt_session: "中断", terminate_session: "结束" };
  function friendlyToolName(name) {
    var raw = safeText(name).trim();
    if (toolNameLabels[raw]) return toolNameLabels[raw];
    var match = /^([a-z_]+)\.([a-z_]+)$/.exec(raw);
    if (!match || !toolPackageLabels[match[1]]) return raw;
    var object = toolPackageLabels[match[1]] + (/_session/.test(match[2]) ? "会话" : /_file$/.test(match[2]) ? "" : /_sources$/.test(match[2]) ? "来源" : "");
    return toolVerbLabels[match[2]] ? toolVerbLabels[match[2]] + object : object + " · " + match[2];
  }
  // Skip-mode approvals are a configured pass-through, not information worth a timeline row.
  function reviewIsAutomatic(review) {
    return !!review && review.status === "approved" && (review.decided_by === "system.skip" || review.mode === "skip" ||
      /automatically approved/i.test(safeText(review.decision_reason || review.reason)));
  }

  function timelineText(eventName, data) {
    if (eventName === "run_pause_requested") return "正在暂停，等待当前步骤结束";
    if (eventName === "run_paused") return "任务已暂停";
    if (eventName === "run_resumed") return "继续处理任务";
    if (eventName === "run_started") return "开始处理任务";
    if (eventName === "llm_started") return "正在分析任务";
    if (eventName === "tool_started") return "调用工具：" + friendlyToolName(safeText(data && (data.tool_name || data.payload && data.payload.tool_name) || "处理中"));
    if (eventName === "safety_review_required") return "等待安全审查";
    if (eventName === "safety_review_decided") {
      var review = data && data.payload && data.payload.review || {};
      if (reviewIsAutomatic(review)) return "";
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

  function clearHiddenStreamAnswer(session, state) {
    if (state) { state.userVisible = false; state.answer = ""; state.body = null; }
    delete liveAnswers[session.id];
    if (session.id === activeSessionId) {
      var output = messages.querySelector(".agent-live-output");
      if (output) output.remove();
    }
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
    var runId = safeText(data && data.run_id || session.multiAgentRunId);
    var process = runProcesses[session.id];
    if (!process || (runId && process.runId !== runId)) {
      process = runProcesses[session.id] = { runId: runId, sequence: 0, entries: [], serial: 0 };
    }
    var changed = appendProcessEvent(process, eventName, data);
    process.entries = process.entries.slice(-100);
    return changed;
  }

  function appendProcessEvent(process, eventName, data) {
    var payload = data && data.payload && typeof data.payload === "object" ? data.payload : {};
    var sequence = Number(data && data.sequence) || 0;
    if (sequence && sequence <= process.sequence) return false;
    if (sequence) process.sequence = sequence;
    if (!backendUserVisible(data) && ["llm_delta", "final_answer", "assistant_message"].indexOf(eventName) >= 0) return false;
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
      var decided = payload.review || {};
      if (reviewIsAutomatic(decided)) return false;
      entries.push({ key: ++process.serial, type: eventName, kind: "review", reviewStatus: safeText(decided.status),
        toolName: safeText(decided.tool_name), reason: truncateText(safeText(decided.decision_reason || decided.reason), 4000),
        message: truncateText(timelineText(eventName, data), 4000), at: processEventTime(data) });
    } else if (["run_started", "llm_started", "safety_review_required"].indexOf(eventName) >= 0) {
      var message = truncateText(timelineText(eventName, data), 180);
      if (!message) return false;
      entries.push({ key: ++process.serial, type: eventName, kind: "event", message: message, at: processEventTime(data) });
    } else return false;
    process.entries = entries;
    return true;
  }

  async function findHistoricalRun(sessionId, traceId) {
    var offset = 0;
    while (true) {
      var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(sessionId) + "/runs?limit=100&offset=" + offset);
      if (!response.ok) throw new Error("运行索引暂不可用");
      var result = await response.json();
      var runs = Array.isArray(result.runs) ? result.runs : [];
      var match = runs.find(function (run) { return run.session_id === sessionId && run.trace_id === traceId; });
      if (match) return safeText(match.run_id);
      if (result.next_offset == null) return "";
      if (!Number.isSafeInteger(result.next_offset) || result.next_offset <= offset) throw new Error("运行索引无效");
      offset = result.next_offset;
    }
  }

  async function loadHistoricalProcess(runId) {
    var key = backendBaseUrl + "/" + runId, cached = historicalProcesses.get(key);
    if (cached) return cached;
    var request = (async function () {
      var response = await fetch(backendBaseUrl + "/agent/runs/" + encodeURIComponent(runId) + "/events?after_sequence=0", { headers: { Accept: "application/json" } });
      if (!response.ok) { var failure = new Error("运行事件暂不可用"); failure.status = response.status; throw failure; }
      var result = await response.json();
      if (result.run_id !== runId || !Array.isArray(result.events)) throw new Error("运行事件身份不匹配");
      var process = { runId: runId, sequence: 0, entries: [], serial: 0, complete: false };
      result.events.slice().sort(function (a, b) { return a.sequence - b.sequence; }).forEach(function (event) {
        if (event.run_id !== runId) return;
        appendProcessEvent(process, event.type, event);
        if (["run_completed", "run_failed", "run_cancelled", "run_timed_out"].indexOf(event.type) >= 0) process.complete = true;
      });
      return process;
    })();
    historicalProcesses.set(key, request);
    while (historicalProcesses.size > 12) historicalProcesses.delete(historicalProcesses.keys().next().value);
    try {
      var process = await request;
      if (!process.complete && historicalProcesses.get(key) === request) historicalProcesses.delete(key);
      return process;
    } catch (error) { if (historicalProcesses.get(key) === request) historicalProcesses.delete(key); throw error; }
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
      var friendly = friendlyToolName(entry.toolName);
      heading.querySelector(".run-process-label").textContent = friendly;
      var rawId = heading.querySelector(".run-process-tool-id");
      if (friendly !== entry.toolName) {
        if (!rawId) { rawId = document.createElement("code"); rawId.className = "run-process-tool-id"; heading.insertBefore(rawId, heading.querySelector(".run-process-state")); }
        rawId.textContent = entry.toolName;
      } else if (rawId) rawId.remove();
      var badge = heading.querySelector(".run-process-state");
      badge.textContent = { failed: "失败", error: "失败", completed: "完成", rejected: "未执行", blocked: "受阻",
        cancelled: "已取消", timed_out: "超时", timeout: "超时" }[entry.status] ||
        (entry.status === "running" ? "调用中" : "已结束");
      badge.setAttribute("data-status", entry.status);
    } else if (entry.kind === "review" && entry.reviewStatus) {
      // Approved reviews collapse to one line; a rejection keeps its full reason visible.
      item.textContent = "";
      var approved = entry.reviewStatus === "approved";
      var line = document.createElement("span");
      line.className = "run-process-review-line" + (approved ? "" : " is-rejected");
      line.textContent = (approved ? "已通过安全审查" : "安全审查未通过") + (entry.toolName ? "：" + friendlyToolName(entry.toolName) : "");
      item.appendChild(line);
      if (entry.reason && (!approved || entry.reason.length < 80)) {
        var reason = document.createElement("span"); reason.className = "run-process-review-reason"; reason.textContent = entry.reason;
        item.appendChild(reason);
      } else if (entry.reason) item.title = entry.reason;
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
    var active = state === "running" || state === "waiting" || state === "paused";
    var hasFinal = storedEvents.some(function (item) { return item.type === "final_answer"; });
    var visible = (active || state === "failed" && process && process.entries.length > 0) && !hasFinal;
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
    var current = getSessionById(session.id) || session;
    var statuses = { run_started: "running", run_resumed: "running", run_paused: "paused", run_completed: "completed", run_failed: "failed", run_cancelled: "cancelled", run_timed_out: "timed_out" };
    if (["run_completed", "run_failed", "run_timed_out"].indexOf(eventName) >= 0) current.pausedAnswer = "";
    if (statuses[eventName]) { current.runControlStatus = statuses[eventName]; current.pauseRequested = false; current.controlNotice = ""; if (eventName !== "run_paused") current.resumePending = false; }
    if (eventName === "run_pause_requested") current.pauseRequested = true;
    if (eventName === "run_resumed") current.timelineState = "running";
    if (eventName === "run_paused") current.timelineState = "paused";
    if (current.id === activeSessionId) renderRunControls();
    var processChanged = recordProcessOutput(session, eventName, data);
    if (eventName === "llm_delta" || !backendUserVisible(data) && ["final_answer", "assistant_message"].indexOf(eventName) >= 0) return;
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
      if (eventName === "safety_review_decided" && !reviewIsAutomatic(data && data.payload && data.payload.review)) {
        var review = data && data.payload && data.payload.review || {};
        setRunStatus(message + (review.status === "rejected" ? "。可在下一条消息中明确授权这项操作后重试。" : ""),
          review.status === "rejected" ? "error" : "");
      }
    }
    persistSessions();
  }

  function handleStreamEvent(eventName, data, state) {
    if (eventName === "run_cancelled" && data && data.payload && data.payload.superseded_by_run_id) {
      followSupersedingRun(state.session, data.payload.superseded_by_run_id); return;
    }
    recordRunEvent(state.session, eventName, data);
    if (eventName === "run_paused") { state.paused = true; settlePausedRun(state.session, state); return; }
    if (eventName === "run_cancelled") settleCancelledRun(state.session);
    var payload = data && data.payload && typeof data.payload === "object" ? data.payload : {};
    var answerVisible = backendUserVisible(data);
    if (!answerVisible && ["llm_delta", "final_answer", "run_completed"].indexOf(eventName) >= 0) clearHiddenStreamAnswer(state.session, state);
    if (answerVisible && eventName === "llm_delta" && payload.display_target === "assistant_answer") {
      state.answer = safeText(payload.content_snapshot || (state.answer + safeText(payload.delta)));
      if (runSettings.stream) state.body = renderStreamingAnswer(state.session, state.answer, false);
      if (activeSessionId === state.session.id) { setRunStatus("正在生成回答…"); scrollMessagesToBottom(); }
      return;
    }
    if (answerVisible && eventName === "final_answer") {
      state.userVisible = true;
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
        if (activeSessionId === state.session.id) setRunStatus("等待安全审查确认：" + (review.tool_name || "工具调用"), "review");
      } else {
        if (activeSessionId === state.session.id) setRunStatus(review.mode === "llm" ? "正在进行模型安全审查…" : "安全审查已自动通过");
      }
      return;
    }
    if (["run_completed", "run_failed", "run_cancelled", "run_timed_out"].indexOf(eventName) >= 0) {
      state.terminal = true;
      state.terminalStatus = eventName === "run_completed" ? "completed"
        : eventName === "run_failed" ? "failed"
          : eventName === "run_cancelled" ? "cancelled" : "timed_out";
    }
    if (activeSessionId === state.session.id) {
      if (eventName === "run_started") setRunStatus("Agent 已启动");
      else if (eventName === "llm_started") setRunStatus("LLM：" + (data.stage || "处理中") + "…");
      else if (eventName === "tool_started") setRunStatus("正在调用工具：" + (data.tool_name || payload.tool_name || "处理中"));
      else if (eventName === "run_completed") setRunStatus("本轮完成");
      else if (eventName === "run_failed") setRunStatus(eventMessage(data) || "本轮失败", "error");
      else if (eventName !== "heartbeat" && backendUserVisible(data) && eventMessage(data)) setRunStatus(eventMessage(data));
    }
    state.events.push(data);
  }

  var nativeTurnGenerations = Object.create(null);
  function markNativePendingTurn(payload) {
    var sessionId = payload.session_id || payload.conversation_id;
    var originalPending = managerPendingTurns[sessionId] || pendingState;
    if (originalPending && originalPending.conversationId === sessionId && turnIsCurrent(getSessionById(sessionId), originalPending.generation)) {
      originalPending.nativeTurn = { sessionId: sessionId, generation: originalPending.generation };
      var generations = nativeTurnGenerations[sessionId] || (nativeTurnGenerations[sessionId] = new Set());
      generations.add(originalPending.generation);
    }
  }

  function sendAgentTurnViaDesktopBridge(payload) {
    if (lkaHost && lkaHost.isCloudSession(payload.conversation_id || payload.session_id)) return false;
    if (!window.petBridge || typeof window.petBridge.send !== "function") {
      return false;
    }
    markNativePendingTurn(payload);
    window.petBridge.send(JSON.stringify({
      question: payload.question || payload.user_input || "",
      conversation_id: payload.conversation_id || payload.session_id,
      session_id: payload.session_id || payload.conversation_id,
      mode: payload.mode || "wait",
      attachment_ids: payload.attachment_ids || [],
      resumable: true,
      client_request_id: payload.client_request_id,
      llm_response_mode: runSettings.stream ? "stream" : "text",
      llm_client: modelOverridesAllowed(payload.session_id || payload.conversation_id) ? runSettings.llmClient || "" : "",
      llm_model: modelOverridesAllowed(payload.session_id || payload.conversation_id) ? runSettings.llmModel || "" : "",
      llm_answer_client: modelOverridesAllowed(payload.session_id || payload.conversation_id) ? runSettings.llmAnswerClient || "" : "",
      llm_answer_model: modelOverridesAllowed(payload.session_id || payload.conversation_id) ? runSettings.llmAnswerModel || "" : "",
      llm_reasoning_level: requestReasoningLevel(payload.session_id || payload.conversation_id),
      safety_review_mode: payload.safety_review_mode || ""
    }));
    return true;
  }

  var nativeStreamCallbacks = Object.create(null);
  window.__petChatReceiveStream = function (eventName, data, requestId) {
    var keys = Object.keys(nativeStreamCallbacks);
    // Old hosts do not tag callbacks; only an unambiguous subscription is routable.
    var key = requestId || (keys.length === 1 ? keys[0] : ""), subscription = nativeStreamCallbacks[key];
    if (!subscription) return;
    subscription.event(eventName, data);
    if (["run_completed", "run_failed", "run_cancelled", "run_timed_out", "run_paused"].indexOf(eventName) >= 0) {
      delete nativeStreamCallbacks[key];
      var entry = managerStreams[subscription.sessionId];
      if (entry && entry.controller === subscription.controller) delete managerStreams[subscription.sessionId];
      if (subscription.controller && activeAgentEventController === subscription.controller) activeAgentEventController = null;
    }
  };
  function sendAgentStreamViaDesktopBridge(payload, onEvent) {
    if (lkaHost && lkaHost.isCloudSession(payload.conversation_id || payload.session_id)) return false;
    if (!window.petBridge || typeof window.petBridge.stream !== "function") return false;
    var requestId = "turn-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    var originalPending = managerPendingTurns[payload.conversation_id || payload.session_id] || pendingState;
    nativeStreamCallbacks[requestId] = { event: onEvent, sessionId: payload.conversation_id || payload.session_id, generation: originalPending && originalPending.generation };
    markNativePendingTurn(payload);
    if (isManagerSession(getSessionById(payload.conversation_id || payload.session_id))) {
      var nativeController = new AbortController(), nativeSessionId = payload.conversation_id || payload.session_id;
      nativeController.signal.addEventListener("abort", function () { delete nativeStreamCallbacks[requestId]; }, { once: true });
      nativeStreamCallbacks[requestId].controller = nativeController;
      managerStreams[nativeSessionId] = { controller: nativeController, runId: "" };
    }
    window.petBridge.stream(JSON.stringify({
      request_id: requestId,
      question: payload.question || payload.user_input || "",
      conversation_id: payload.conversation_id || payload.session_id,
      attachment_ids: payload.attachment_ids || [],
      resumable: true,
      client_request_id: payload.client_request_id,
      llm_response_mode: runSettings.stream ? "stream" : "text",
      llm_client: modelOverridesAllowed(payload.session_id || payload.conversation_id) ? runSettings.llmClient || "" : "",
      llm_model: modelOverridesAllowed(payload.session_id || payload.conversation_id) ? runSettings.llmModel || "" : "",
      llm_answer_client: modelOverridesAllowed(payload.session_id || payload.conversation_id) ? runSettings.llmAnswerClient || "" : "",
      llm_answer_model: modelOverridesAllowed(payload.session_id || payload.conversation_id) ? runSettings.llmAnswerModel || "" : "",
      llm_reasoning_level: requestReasoningLevel(payload.session_id || payload.conversation_id),
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
      liveSession.nodeWorkspaceId = session.nodeWorkspaceId || "";
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

  // Explicit user actions (upload, "create now") need the reserved folder on disk.
  async function materializeSessionWorkspace(session) {
    if (!session || session.workspaceState !== "reserved" || noLocalWorkspaceService()) return;
    var data;
    if (window.petBridge && typeof window.petBridge.materializeSessionWorkspace === "function") {
      data = JSON.parse(window.petBridge.materializeSessionWorkspace(session.id) || "{}");
      if (data.error) throw new Error(data.error);
    } else {
      var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(session.id) + "/workspace/materialize", { method: "POST" });
      data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error("HTTP " + response.status + ": " + (data.detail || "无法创建工作区"));
    }
    session.workspaceState = "";
    session.project_id = data.project_id || session.project_id || "";
    var live = getSessionById(session.id);
    if (live) { live.workspaceState = ""; live.project_id = session.project_id; }
    persistSessions();
    if (session.id === activeSessionId) renderWorkspaceSummary(session);
  }

  async function bindSessionWorkspace(session, requestedWorkspace, assertCurrent) {
    if (isManagerSession(session)) { if (assertCurrent) assertCurrent(); return session.id; }
    if (managerEmbedding) throw new Error("真理会话尚未载入，请重试。");
    var workspace = requestedWorkspace === undefined ? (nodeBoundary() ? session.nodeWorkspaceId : session.workspace) : requestedWorkspace;
    var key = session.id + "\n" + (workspace || "");
    if (workspaceBindings[key]) return workspaceBindings[key];
    var binding = bindSessionWorkspaceNow(session, requestedWorkspace, assertCurrent);
    workspaceBindings[key] = binding;
    try { return await binding; }
    finally { if (workspaceBindings[key] === binding) delete workspaceBindings[key]; }
  }

  // Node sessions exist on the node before the first turn; the workspace is an
  // approved ID bound through /sessions/{id}/workspace-id, never a local path.
  async function ensureNodeSession(session, assertCurrent) {
    if (session.id.indexOf("conv_") !== 0) return session.id;
    if (assertCurrent) assertCurrent(true);
    var response = await fetch(backendBaseUrl + "/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: session.title || "新会话", metadata: { source_frontend: "lka-desktop-node", title_is_custom: !!session.title_is_custom } })
    });
    var created = await response.json().catch(function () { return {}; });
    var createdId = createdBackendSessionId(created);
    if (!response.ok || !createdId) throw new Error("HTTP " + response.status + "：无法在当前设备创建会话");
    replaceSessionId(session, createdId);
    return createdId;
  }
  async function bindNodeWorkspace(session, requestedWorkspace, assertCurrent) {
    if (assertCurrent) assertCurrent();
    var sessionId = await ensureNodeSession(session, assertCurrent);
    var workspaceId = requestedWorkspace === undefined ? session.nodeWorkspaceId : requestedWorkspace;
    if (!workspaceId || session.nodeWorkspaceBound === workspaceId) return sessionId;
    var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(sessionId) + "/workspace-id", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace_id: workspaceId })
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(response.status === 403 ? "这个工作区未获当前连接授权。" : "工作区绑定失败（HTTP " + response.status + "）");
    session.nodeWorkspaceId = workspaceId; session.nodeWorkspaceBound = workspaceId;
    session.workspace = safeText(data.path || data.backend_path || session.workspace);
    session.backendWorkspace = session.workspace; session.workspaceState = "";
    var live = getSessionById(sessionId);
    if (live && live !== session) Object.assign(live, { nodeWorkspaceId: workspaceId, nodeWorkspaceBound: workspaceId, workspace: session.workspace, backendWorkspace: session.workspace, workspaceState: "" });
    persistSessions();
    if (sessionId === activeSessionId) renderWorkspaceSummary(session);
    return sessionId;
  }

  async function bindSessionWorkspaceNow(session, requestedWorkspace, assertCurrent) {
    if (isManagerSession(session)) { if (assertCurrent) assertCurrent(); return session.id; }
    if (nodeBoundary()) return bindNodeWorkspace(session, requestedWorkspace, assertCurrent);
    if (hostedPage) { if (assertCurrent) assertCurrent(); return ensureNodeSession(session, assertCurrent); }
    if (assertCurrent) assertCurrent();
    var workspace = requestedWorkspace === undefined ? session.workspace : requestedWorkspace;
    if (!workspace) return session.id;
    if (session.backendWorkspace === workspace) return session.id;
    if (window.petBridge && typeof window.petBridge.setSessionWorkspace === "function") {
      var reserveBinding = !!session.workspaceReserved && workspace === session.workspace && typeof window.petBridge.reserveSessionWorkspace === "function";
      var bindThroughBridge = function () {
        return JSON.parse((reserveBinding ? window.petBridge.reserveSessionWorkspace(session.id, workspace) : window.petBridge.setSessionWorkspace(session.id, workspace)) || "{}");
      };
      var bridgeResult = bindThroughBridge();
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
        bridgeResult = bindThroughBridge();
      }
      if (bridgeResult.error) throw new Error(bridgeResult.error);
      session.project_id = bridgeResult.project_id || "";
      session.backendWorkspace = workspace;
      session.workspace = workspace;
      session.workspaceState = bridgeResult.workspace && bridgeResult.workspace.state === "reserved" ? "reserved" : "";
      var bridgeLiveSession = getSessionById(session.id);
      if (bridgeLiveSession) { bridgeLiveSession.project_id = session.project_id; bridgeLiveSession.backendWorkspace = workspace; bridgeLiveSession.workspace = workspace; bridgeLiveSession.workspaceState = session.workspaceState; }
      persistSessions();
      if (session.id === activeSessionId) renderWorkspaceSummary(session);
      return session.id;
    }
    var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(session.id) + "/workspace", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: workspace, platform: workspace.charAt(0) === "/" ? "linux" : "windows", reserve: !!session.workspaceReserved && workspace === session.workspace })
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
        body: JSON.stringify({ path: workspace, platform: workspace.charAt(0) === "/" ? "linux" : "windows", reserve: !!session.workspaceReserved && workspace === session.workspace })
      });
    }
    var data = await response.json();
    if (!response.ok) throw new Error("HTTP " + response.status + ": " + (data.detail || "workspace binding failed"));
    session.project_id = data.project_id || "";
    session.backendWorkspace = workspace;
    session.workspace = workspace;
    session.workspaceState = data.workspace && data.workspace.state === "reserved" ? "reserved" : "";
    var liveSession = getSessionById(session.id);
    if (liveSession) { liveSession.project_id = session.project_id; liveSession.backendWorkspace = workspace; liveSession.workspace = workspace; liveSession.workspaceState = session.workspaceState; }
    persistSessions();
    if (session.id === activeSessionId) renderWorkspaceSummary(session);
    return session.id;
  }

  // The persistent manager inbox is separate from an executing turn. Enqueueing
  // must never reset the current generation, output or event subscription.
  function queueState(session) {
    return session && (managerInputQueues[session.id] || (managerInputQueues[session.id] = { supported: false, unsupported: false, chain: Promise.resolve(), receipts: [] }));
  }
  function queueEnabled(session) { return isManagerSession(session) && !!(managerInputQueues[session.id] && managerInputQueues[session.id].supported); }
  function validInputSnapshot(value) {
    return value && Array.isArray(value.inputs) && typeof value.paused === "boolean"
      && Number.isInteger(value.pending_count) && value.pending_count >= 0
      && (value.active_run_id === null || typeof value.active_run_id === "string");
  }
  async function inputQueueRequest(session, method, body, suffix) {
    var path = "/sessions/" + encodeURIComponent(session.id) + "/inputs" + (suffix || "");
    if (window.LkaMatterHost && typeof window.LkaMatterHost.request === "function") return window.LkaMatterHost.request(path, method, body);
    var response = await fetch(backendBaseUrl + path, { method: method, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    var value = await response.json();
    if (!response.ok) { var error = new Error(typeof value.detail === "string" ? value.detail : "HTTP " + response.status); error.status = response.status; error.detail = value.detail; throw error; }
    return value;
  }
  // Reset markers are monotonic: a GET issued before a reset cannot restore
  // deleted history, even when it finishes after a newer GET.
  function reconcileHistoryReset(session, remote) {
    var previous = Date.parse(session.historyResetAt || "") || 0;
    var incoming = Date.parse(remote.historyResetAt || "") || 0;
    if (previous > incoming) return -1;
    if (incoming <= previous) return 0;
    session.historyResetAt = remote.historyResetAt;
    (session.messages || []).forEach(function (message) {
      if (message.queueRequest) clearAcknowledgedQueueDraft(session, message);
    });
    // Replacing the state invalidates outstanding probes, uploads and POSTs;
    // unknown submissions must not be reconstructed or automatically retried.
    delete managerInputQueues[session.id];
    if (activeSessionId === session.id) {
      activeAgentTurnGeneration += 1;
      abortActiveAgentEventStream();
      if (pendingState && pendingState.conversationId === session.id) pendingState = null;
    } else {
      var subscription = managerStreams[session.id];
      if (subscription) subscription.controller.abort();
      delete managerStreams[session.id];
      delete managerPendingTurns[session.id];
    }
    session.multiAgentRunId = ""; session.multiAgentSequence = 0;
    session.multiAgentSnapshot = null; delete session.multiAgentSnapshotRequest;
    multiAgentSnapshotRequestIds[session.id] = (multiAgentSnapshotRequestIds[session.id] || 0) + 1;
    session.timelineEvents = []; session.timelineState = ""; session.runControlStatus = "";
    session.pauseRequested = false; session.resumePending = false; session.pausedAnswer = "";
    try { localStorage.removeItem(runCursorKeyPrefix + encodeURIComponent(session.id)); } catch (ignored) {}
    delete liveAnswers[session.id];
    delete runProcesses[session.id];
    session.messages = remote.messages;
    session.backendHistoryVersion = remote.backendHistoryVersion;
    return 1;
  }
  function mergeQueuedMessages(session, remoteSession) {
    var reset = reconcileHistoryReset(session, remoteSession);
    if (reset < 0) return session.messages;
    if (reset > 0) return remoteSession.messages;
    var remote = remoteSession.messages;
    var local = session.messages || [], state = queueState(session);
    var merged = remote.map(function (message) {
      var prior = local.find(function (item) { return message.messageId && item.messageId === message.messageId || message.clientId && item.clientId === message.clientId; });
      if (prior) Object.assign(message, { clientId: prior.clientId || message.clientId, inputStatus: prior.inputStatus, queueRequest: prior.queueRequest, inputError: prior.inputError, queueRestoredDraft: prior.queueRestoredDraft, queuePriorDraft: prior.queuePriorDraft });
      var receipt = state.receipts.find(function (item) { return item.message_id === message.messageId || message.clientId && item.client_message_id === message.clientId; });
      if (receipt) { message.clientId = receipt.client_message_id; message.messageId = receipt.message_id; message.inputStatus = receipt.status; message.inputError = ""; }
      return message;
    });
    local.forEach(function (message) {
      if (message.clientId && message.queueRequest && !merged.some(function (item) { return item.clientId === message.clientId || message.messageId && item.messageId === message.messageId; })) merged.push(message);
    });
    return merged;
  }
  async function refreshQueuedHistory(session) {
    var state = queueState(session), historyEpoch = (state.historyEpoch || 0) + 1, runId = session.multiAgentRunId;
    state.historyEpoch = historyEpoch;
    try {
      var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(session.id), { headers: { Accept: "application/json" } });
      if (!response.ok) return false;
      var remote = sessionFromBackendDetail(await response.json()), current = getSessionById(session.id);
      if (!current || !isManagerSession(remote) || remote.id !== current.id || state.historyEpoch !== historyEpoch || managerInputQueues[session.id] !== state) return false;
      current.messages = mergeQueuedMessages(current, remote);
      current.backendHistoryVersion = remote.backendHistoryVersion;
      // A terminal run's final answer is now represented by durable history.
      if (current.multiAgentRunId === runId && isTerminalRunStatus(current.runControlStatus)) { delete liveAnswers[current.id]; delete runProcesses[current.id]; }
      if (activeSessionId === current.id) renderActiveMessages();
      persistSessions(); return true;
    } catch (ignored) { return false; }
  }
  function inputQueueNeedsResume(session) {
    if (!queueEnabled(session)) return false;
    var state = queueState(session);
    return !!state.paused && state.pending_count > 0
      && (!session.multiAgentRunId || isTerminalRunStatus(session.runControlStatus));
  }
  function firstUnboundManagerInput(session) {
    if (!queueEnabled(session)) return null;
    return queueState(session).receipts.filter(function (item) {
      return item.status === "queued" && !item.run_id;
    }).sort(function (left, right) { return left.sequence - right.sequence; })[0] || null;
  }
  async function resumeManagerInputs(session, inputId) {
    if (!inputQueueNeedsResume(session)) return;
    var state = queueState(session);
    if (state.resuming) return;
    state.resuming = true;
    if (activeSessionId === session.id) renderRunControls();
    var epoch = (state.requestEpoch || 0) + 1; state.requestEpoch = epoch;
    try {
      var body = inputId ? { input_id: inputId, answer_client_name: null, answer_model: null } : {};
      var snapshot = await inputQueueRequest(session, "POST", body, "/resume");
      if (!validInputSnapshot(snapshot)) throw new Error("消息状态无效");
      if (managerInputQueues[session.id] === state) await applyInputSnapshot(session, snapshot, epoch);
    } catch (error) {
      if (managerInputQueues[session.id] === state && activeSessionId === session.id) setRunStatus("暂时无法继续，请重试", "error");
    } finally {
      state.resuming = false;
      if (activeSessionId === session.id) renderRunControls();
    }
  }
  function clearAcknowledgedQueueDraft(session, message) {
    if (message.queueRestoredDraft !== undefined && readDraft(session.id) === message.queueRestoredDraft) {
      writeDraft(session.id, message.queuePriorDraft || "");
      var currentAttachments = window.LkaImageComposer.capture(session.id);
      window.LkaImageComposer.restore(currentAttachments.filter(function (item) {
        return !(message.attachments || []).some(function (sent) { return sent.local_id === item.local_id || sent.attachment_id && sent.attachment_id === item.attachment_id; });
      }), session.id);
      if (activeSessionId === session.id) showDraftForSession(session);
    }
    delete message.queueRestoredDraft; delete message.queuePriorDraft;
  }
  async function applyInputSnapshot(session, snapshot, epoch) {
    session = getSessionById(session.id) || session;
    var state = queueState(session);
    if (epoch !== state.requestEpoch) return;
    var signature = JSON.stringify(snapshot), changed = state.signature !== signature;
    state.supported = true; state.signature = signature; state.receipts = snapshot.inputs;
    state.paused = snapshot.paused; state.pending_count = snapshot.pending_count;
    session.messages.forEach(function (message) {
      var receipt = snapshot.inputs.find(function (item) { return item.client_message_id === message.clientId || message.messageId && item.message_id === message.messageId; });
      if (receipt) {
        clearAcknowledgedQueueDraft(session, message);
        message.messageId = receipt.message_id; message.inputStatus = receipt.status; message.inputError = "";
        delete message.queueRestoredDraft; delete message.queuePriorDraft;
      }
    });
    if (!state.jobs) state.jobs = session.messages.filter(function (message) {
      return message.queueRequest && ["submitting", "submission_failed"].indexOf(message.inputStatus) >= 0
        && !snapshot.inputs.some(function (receipt) { return receipt.client_message_id === message.clientId; });
    }).map(function (message) { return { clientId: message.clientId, selected: message.attachments || [] }; });
    if (changed) await refreshQueuedHistory(session);
    if (epoch !== state.requestEpoch || managerInputQueues[session.id] !== state) return;
    var runId = snapshot.active_run_id, selected = activeSessionId === session.id;
    if (runId && runId !== session.multiAgentRunId) {
      // Queue roots advance independently of the viewed conversation. Replace
      // only this manager's subscription, leaving another session's turn intact.
      if (selected) { activeAgentTurnGeneration += 1; abortActiveAgentEventStream(); pendingState = null; }
      else {
        var previous = managerStreams[session.id];
        if (previous) { previous.controller.abort(); delete managerStreams[session.id]; }
        delete managerPendingTurns[session.id];
      }
      delete liveAnswers[session.id]; delete runProcesses[session.id];
      session.multiAgentRunId = runId; session.multiAgentSequence = 0; session.timelineEvents = [];
      session.runControlStatus = "queued"; session.timelineState = "running"; session.pausedAnswer = "";
      session.pauseRequested = false; session.resumePending = false; saveRunCursor(session);
      // active_run_id also includes paused and waiting roots; it is not a status.
      try { await readSavedRunStatus(runId); } catch (ignored) {}
      if (epoch !== state.requestEpoch || managerInputQueues[session.id] !== state || session.multiAgentRunId !== runId) return;
    }
    var subscription = managerStreams[session.id];
    if (runId && !(subscription && !subscription.controller.signal.aborted)
        && !isTerminalRunStatus(session.runControlStatus) && (session.runControlStatus !== "paused" || session.resumePending)) {
      reconnectSavedRun(session, null);
    }
    persistSessions();
    if (activeSessionId === session.id) renderRunControls();
    drainQueuedInputs(session);
  }
  function refreshManagerInputs(session) {
    session = session || getActiveSession();
    if (document.hidden || !isManagerSession(session) || deletedSessionIds[session.id] || deletingSessionIds[session.id]) return Promise.resolve(false);
    var state = queueState(session);
    if (state.loading) return state.refreshPromise || Promise.resolve(false);
    if (state.unsupported || state.resuming) return Promise.resolve(false);
    state.loading = true;
    var epoch = (state.requestEpoch || 0) + 1; state.requestEpoch = epoch;
    var refresh = (async function () {
    try {
      var snapshot = await inputQueueRequest(session, "GET");
      if (!validInputSnapshot(snapshot)) {
        if (!state.supported) { state.unsupported = true; return false; }
        throw new Error("消息队列响应无效");
      }
      if (managerInputQueues[session.id] !== state) return false;
      await applyInputSnapshot(session, snapshot, epoch); return true;
    } catch (error) {
      if (managerInputQueues[session.id] !== state) return false;
      if (!state.supported && (error.status === 404 || error.status === 409 && ["session_input_queue_requires_default_manager", "session_input_queue_disabled"].indexOf(error.detail) >= 0)) state.unsupported = true;
      else if (!state.supported && activeSessionId === session.id) setRunStatus("暂时无法核对消息队列，草稿已保留，正在重试连接…", "error");
      // Only a validated response enables continuous sending. Failures never
      // reroute an attempted inbox submission to the legacy turn endpoint.
      return false;
    } finally { state.loading = false; if (activeSessionId === session.id) renderRunControls(); }
    }());
    state.refreshPromise = refresh;
    return refresh;
  }
  function sameQueuedAttachments(left, right) {
    return JSON.stringify((left || []).map(function (item) { return item.local_id || item.attachment_id; })) === JSON.stringify((right || []).map(function (item) { return item.local_id || item.attachment_id; }));
  }
  function pausedInputReplacement(session) {
    if (!session || session.runControlStatus !== "paused" || !session.multiAgentRunId) return "";
    // Reserve the paused task for the first explicit replacement, including an
    // uncertain request restored after reload. Later messages stay in FIFO order.
    var pending = (session.messages || []).some(function (message) {
      return message.queueRequest && message.queueRequest.replace_run_id === session.multiAgentRunId;
    });
    return pending ? "" : session.multiAgentRunId;
  }
  function enqueueManagerInput(session, question) {
    var text = safeText(question).trim(), selected = window.LkaImageComposer.capture(session.id);
    var failed = session.messages.find(function (item) { return item.inputStatus === "submission_failed" && item.queueRequest && item.queueRequest.user_input === text && sameQueuedAttachments(item.attachments, selected); });
    var body = failed ? failed.queueRequest : { client_message_id: "input-" + Date.now() + "-" + Math.random().toString(36).slice(2), user_input: text, attachment_ids: [], llm: { response_mode: runSettings.stream ? "stream" : "text" } };
    if (!failed) {
      var pausedRunId = pausedInputReplacement(session);
      if (pausedRunId) body.replace_run_id = pausedRunId;
    }
    if (!failed && ["skip", "llm", "manual"].indexOf(runSettings.safetyMode) >= 0) body.safety_review_mode = runSettings.safetyMode;
    if (!failed) addMessageToSession(session, "user", text || "[File input]", false, { clientId: body.client_message_id, attachments: selected, inputStatus: "submitting", queueRequest: body });
    // Capture/clear synchronously, before uploads or requests yield to a new draft.
    input.value = ""; writeDraft(session.id, "");
    var message = failed || session.messages[session.messages.length - 1];
    message.inputStatus = "submitting"; message.inputError = "";
    submitQueuedInput(session, message, selected);
    if (activeSessionId === session.id) {
      scrollMessagesToBottom(true);
      window.requestAnimationFrame(function () { if (activeSessionId === session.id) scrollMessagesToBottom(true); });
    }
  }
  function retryQueuedInput(sessionId, clientId) {
    var session = getSessionById(sessionId), message = session && session.messages.find(function (item) { return item.clientId === clientId; });
    if (!message || message.inputStatus !== "submission_failed" || !queueEnabled(session)) return;
    var draft = readDraft(sessionId), selected = message.attachments;
    if (draft.trim() === message.queueRequest.user_input && activeSessionId === sessionId) {
      var current = window.LkaImageComposer.capture(sessionId);
      if (sameQueuedAttachments(current, selected)) { selected = current; input.value = ""; writeDraft(sessionId, ""); showDraftForSession(session); }
      else window.LkaImageComposer.restore(current, sessionId);
    }
    message.inputStatus = "submitting"; message.inputError = ""; submitQueuedInput(session, message, selected);
  }
  function submitQueuedInput(session, message, selected) {
    var state = queueState(session);
    state.jobs = state.jobs || [];
    var job = state.jobs.find(function (item) { return item.clientId === message.clientId; });
    if (job) job.selected = selected;
    else state.jobs.push({ clientId: message.clientId, selected: selected });
    persistSessions();
    if (activeSessionId === session.id) { renderActiveMessages(); renderRunControls(); }
    drainQueuedInputs(session);
  }
  function drainQueuedInputs(session) {
    var state = queueState(session);
    if (state.processing || !state.jobs || !state.jobs.length) return;
    state.processing = true;
    function renderSubmission() { persistSessions(); if (activeSessionId === session.id) { renderActiveMessages(); renderRunControls(); } }
    state.chain = (async function () {
      while (state.jobs.length && managerInputQueues[session.id] === state) {
        var job = state.jobs[0], selected = job.selected;
        var message = session.messages.find(function (item) { return item.clientId === job.clientId; });
        if (!message) { state.jobs.shift(); continue; }
        var body = message.queueRequest;
        var accepted = state.receipts.find(function (item) { return item.client_message_id === job.clientId; });
        if (accepted) { state.jobs.shift(); continue; }
        // An uncertain send blocks later local submissions until its stable ID
        // is acknowledged or explicitly retried. Never silently reverse input order.
        if (message.inputStatus === "submission_failed") break;
        try {
          body.attachment_ids = await window.LkaImageComposer.prepare(selected, session.id);
          if (managerInputQueues[session.id] !== state) return;
          message = session.messages.find(function (item) { return item.clientId === job.clientId; }) || message;
          message.attachments = window.LkaImageComposer.normalize(selected); renderSubmission();
          var result = await inputQueueRequest(session, "POST", body);
          if (managerInputQueues[session.id] !== state) return;
          if (!result || !result.input || result.input.client_message_id !== body.client_message_id || !result.input.message_id) throw new Error("发送回执无效，请重试核对");
          message = session.messages.find(function (item) { return item.clientId === job.clientId; }) || message;
          clearAcknowledgedQueueDraft(session, message);
          message.messageId = result.input.message_id; message.inputStatus = result.input.status; message.inputError = "";
          state.jobs.shift(); renderSubmission(); await refreshManagerInputs(session);
        } catch (error) {
          if (managerInputQueues[session.id] !== state) return;
          message = session.messages.find(function (item) { return item.clientId === job.clientId; }) || message;
          accepted = state.receipts.find(function (item) { return item.client_message_id === job.clientId; });
          if (accepted) { clearAcknowledgedQueueDraft(session, message); message.inputStatus = accepted.status; message.messageId = accepted.message_id; message.inputError = ""; state.jobs.shift(); renderSubmission(); continue; }
          message.inputStatus = "submission_failed"; message.inputError = safeText(error.message);
          var later = readDraft(session.id), text = body.user_input;
          message.queuePriorDraft = later.trim() === text ? "" : later;
          message.queueRestoredDraft = later.trim() === text ? later : text + (text && later ? "\n" : "") + later;
          writeDraft(session.id, message.queueRestoredDraft);
          window.LkaImageComposer.restore(selected, session.id);
          if (activeSessionId === session.id) { showDraftForSession(session); setRunStatus("发送失败，可点击消息旁的图标重试", "error"); }
          renderSubmission(); break;
        }
      }
    }()).finally(function () { state.processing = false; });
  }

  async function sendQuestion(question, replaceRunId) {
    if (managerEmbedding && (!managerSessionReady || !isManagerSession(getActiveSession()))) {
      setRunStatus("真理会话尚未载入，请刷新后重试。", "error"); return;
    }
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

    if (session.connectionUncertain && !session.multiAgentRunId) {
      setRunStatus(session.controlNotice || "发送结果尚未确认，请先核对会话记录。", "error");
      return;
    }

    function restoreUnsentInput() {
      session = getSessionById(session.id) || session;
      session.messages = session.messages.filter(function (item) { return item.clientId !== imageMessageId; });
      var laterDraft = readDraft(session.id), restoredDraft = cleaned;
      if (laterDraft && laterDraft !== cleaned) restoredDraft += (restoredDraft ? "\n" : "") + laterDraft;
      writeDraft(session.id, restoredDraft);
      window.LkaImageComposer.restore(selectedImages, session.id);
      if (activeSessionId === session.id) showDraftForSession(session);
    }
    function recoverSessionConflict(runId) {
      var originalPending = managerPendingTurns[session.id] || pendingState;
      if (!turnIsCurrent(session, turnGeneration) || !originalPending
        || originalPending.conversationId !== session.id || originalPending.generation !== turnGeneration
        || originalPending.recoverSessionConflict !== recoverSessionConflict) return false;
      restoreUnsentInput();
      if (pendingState && pendingState.conversationId === session.id) pendingState = null;
      delete managerPendingTurns[session.id];
      if (managerStreams[session.id]) { managerStreams[session.id].controller.abort(); delete managerStreams[session.id]; }
      session.multiAgentRunId = runId || ""; session.multiAgentSequence = 0;
      session.runControlStatus = runId ? "queued" : "failed"; session.timelineState = runId ? "running" : "failed";
      session.controlNotice = runId ? "此会话已有任务进行中，已连接原任务；本次输入已保留，尚未发送。"
        : "发送失败：运行冲突响应不完整。本次文字和附件已保留，请核对后重试。";
      delete liveAnswers[session.id]; delete runProcesses[session.id];
      if (activeSessionId === session.id) {
        renderActiveMessages(); setRunStatus(session.controlNotice, "error");
        setComposerDisabled(backendOffline);
      }
      if (runId) reconnectSavedRun(session, null);
      persistSessions(); return true;
    }
    var fileOnly = window.LkaImageComposer.hasDocuments(session.id);
    var audioOnly = window.LkaImageComposer.hasAudios(session.id);
    var selectedImages = window.LkaImageComposer.capture(session.id);
    var imageMessageId = "input-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    var requestStarted = false;
    var replacementAccepted = false;
    var priorPausedTurn = replaceRunId ? { events: session.timelineEvents, answer: liveAnswers[session.id], pausedAnswer: session.pausedAnswer, process: runProcesses[session.id] } : null;
    session.pausedAnswer = "";
    if (!replaceRunId) {
      session.multiAgentRunId = ""; session.multiAgentSequence = 0; session.pausedAnswer = "";
      try { localStorage.removeItem(runCursorKeyPrefix + encodeURIComponent(session.id)); } catch (ignored) {}
    }
    session.runControlStatus = "queued"; session.pauseRequested = false; session.controlNotice = "";
    activeAgentTurnGeneration += 1;
    var turnGeneration = activeAgentTurnGeneration, turnAuthEpoch = assistantCacheEpoch;
    abortActiveAgentEventStream();

    touchSession(session);
    liveAnswers[session.id] = "";
    delete runProcesses[session.id];
    timelineViewKey = "";
    session.timelineEvents = [];
    session.timelineState = "running";
    recordRunEvent(session, "run_started", {});

    addMessageToSession(session, "user", cleaned || (fileOnly ? "[File input]" : audioOnly ? "[Audio input]" : "[Image input]"), false, { attachments: selectedImages, clientId: imageMessageId });
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
      generation: turnGeneration,
      recoverSessionConflict: recoverSessionConflict
    };
    if (isManagerSession(session)) managerPendingTurns[session.id] = pendingState;

    {
      // History appends scroll before the live output and progress change the
      // layout. An explicit send must reveal the whole new turn after those
      // changes, without moving a different session if the user switches.
      scrollMessagesToBottom(true);
      window.requestAnimationFrame(function () {
        if (turnIsCurrent(session, turnGeneration) && session.id === activeSessionId) scrollMessagesToBottom(true);
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
      if (turnAuthEpoch !== assistantCacheEpoch || !turnIsCurrent(session, turnGeneration)) throw quickAssistantCancelled();
      requestStarted = true;
      if (!replaceRunId) { payload.client_request_id = imageMessageId; session.pendingClientRequestId = imageMessageId; persistSessions(); }
      payload.safety_review_mode = runSettings.safetyMode === "backend" ? "" : runSettings.safetyMode;
      if (replaceRunId) {
        var replacementBody = { session_id: boundSessionId, user_input: cleaned, attachment_ids: payload.attachment_ids, resumable: true,
          llm: { response_mode: runSettings.stream ? "stream" : "text" }, safety_review_mode: payload.safety_review_mode || undefined };
        if (!isManagerSession(session) && runSettings.llmClient) replacementBody.llm.client_name = runSettings.llmClient;
        if (!isManagerSession(session) && runSettings.llmModel) replacementBody.llm.model = runSettings.llmModel;
        if (!isManagerSession(session) && runSettings.llmAnswerModel) { replacementBody.llm.answer_client_name = runSettings.llmAnswerClient || undefined; replacementBody.llm.answer_model = runSettings.llmAnswerModel; }
        var replacementReasoning = requestReasoningLevel(session.id);
        if (replacementReasoning) replacementBody.llm.reasoning_level = replacementReasoning;
        var fingerprint = JSON.stringify(replacementBody), previous = replacementCommands[session.id];
        replacementBody.command_id = previous && previous.runId === replaceRunId && previous.fingerprint === fingerprint ? previous.id : "replace-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        replacementCommands[session.id] = { runId: replaceRunId, fingerprint: fingerprint, id: replacementBody.command_id };
        var replacement = await postRunCommand(replaceRunId, "replace", replacementBody);
        session = getSessionById(session.id) || session;
        replacementAccepted = true; session.pausedAnswer = ""; delete replacementCommands[session.id]; delete suspendedTurns[session.id];
        session.multiAgentRunId = replacement.run_id; session.multiAgentSequence = 0; session.multiAgentSnapshot = null;
        saveRunCursor(session); applyRunSnapshot(session, replacement);
        await reconnectSavedRun(session, { answer: "", events: [], session: session, generation: turnGeneration, terminal: false });
        return;
      }
      if (!runSettings.stream && window.petBridge && typeof window.petBridge.stream !== "function" && sendAgentTurnViaDesktopBridge(payload)) {
        console.log("[pet-chat] sent through desktop bridge:", backendBaseUrl, payload);
        return;
      }
      console.log("[pet-chat] streaming LKA agent turn:", backendBaseUrl, payload);
      // Keep a live event subscription even when token-by-token display is off.
      {
        var streamState = {
          answer: "", body: liveBody, events: [], review: null, session: session,
          generation: turnGeneration, initialRunId: session.multiAgentRunId, terminal: false
        };
        try {
          var onStreamEvent = function (eventName, data, eventId) {
            if (!turnIsCurrent(session, turnGeneration)) return;
            session = rememberStreamPosition(session, data, eventId) || session;
            streamState.session = session;
            if (data && data.run_id) { session.pendingClientRequestId = ""; session.connectionUncertain = false; }
            if (isMultiAgentRefreshEvent(eventName)) fetchMultiAgentSnapshot(session, session.multiAgentRunId);
            if (isApprovalQueueRefreshEvent(eventName)) refreshSafetyReviewQueue();
            handleStreamEvent(eventName, data, streamState);
            if (streamState.review && activeSessionId === session.id) showSafetyReview(streamState.review, streamState);
            if (streamState.viaBridge && eventName === "run_cancelled") return;
            if (streamState.viaBridge && ["run_failed", "run_timed_out"].indexOf(eventName) >= 0) {
              window.__petChatReceive({ session_id: session.id, run_id: session.multiAgentRunId, error: eventMessage(data) || "Agent run " + streamState.terminalStatus }); return;
            }
            if (streamState.viaBridge && eventName === "run_completed") {
              window.__petChatReceive({ session_id: session.id, run_id: session.multiAgentRunId,
                answer: streamState.answer || "本轮没有生成可显示的回答。", progress_events: streamState.events, user_visible: streamState.userVisible !== false });
              reconcileCompletedSession(session.id);
            }
          };
          if (sendAgentStreamViaDesktopBridge(payload, onStreamEvent)) {
            streamState.viaBridge = true;
            return;
          }
          var turnController = typeof AbortController === "function" ? new AbortController() : null;
          if (turnController) {
            if (activeSessionId === session.id) activeAgentEventController = turnController;
            if (isManagerSession(session)) managerStreams[session.id] = { controller: turnController, runId: session.multiAgentRunId };
          }
          try {
            await callAgentTurnStream(payload, onStreamEvent, turnController && turnController.signal);
          } finally {
            if (turnController && activeAgentEventController === turnController) activeAgentEventController = null;
            if (managerStreams[session.id] && managerStreams[session.id].controller === turnController) delete managerStreams[session.id];
          }
          if (streamState.paused) return;
          if (streamState.terminalStatus === "cancelled") { settleCancelledRun(session); return; }
          if (!streamState.terminal && session.multiAgentRunId && session.multiAgentRunId !== streamState.initialRunId) {
            if (activeSessionId === session.id) setRunStatus("Agent 事件流结束，正在恢复运行状态…");
            await reconnectSavedRun(session, streamState);
            return;
          }
          if (!streamState.terminal) {
            preserveUncertainTurn(session, streamState);
            await recoverUncertainSubmission(session, streamState);
            return;
          }
          if (streamState.terminalStatus && streamState.terminalStatus !== "completed") {
            window.__petChatReceive({ session_id: session.id, run_id: session.multiAgentRunId, error: "Agent run " + streamState.terminalStatus + "." });
            return;
          }
        } catch (streamError) {
          if (streamError.conflictingRunId) throw streamError;
          if (!turnIsCurrent(session, turnGeneration) || (streamError && streamError.name === "AbortError")) return;
          if (session.multiAgentRunId && session.multiAgentRunId !== streamState.initialRunId) {
            if (activeSessionId === session.id) setRunStatus("Agent 事件流中断，正在恢复运行状态…");
            await reconnectSavedRun(session, streamState);
            return;
          }
          if (!payload.attachment_ids.length && streamError.httpStatus === 422) {
            if (sendAgentTurnViaDesktopBridge(payload)) {
              if (activeSessionId === session.id) setRunStatus("WebView 流式请求不兼容，已切换桌面桥接兼容模式…");
              return;
            }
            if (activeSessionId === session.id) setRunStatus("流式入口不可用，已切换兼容模式…");
            var fallbackResult = await callAgentTurn(payload);
            window.__petChatReceive(fallbackResult);
            return;
          }
          throw streamError;
        }
        window.__petChatReceive({ session_id: session.id, run_id: session.multiAgentRunId,
          answer: streamState.answer || "本轮没有生成可显示的回答。", progress_events: streamState.events, user_visible: streamState.userVisible !== false });
        reconcileCompletedSession(session.id);
      }
    } catch (error) {
      if (!turnIsCurrent(session, turnGeneration) || (error && error.name === "AbortError")) return;
      if (error.conflictingRunId && recoverSessionConflict(error.conflictingRunId)) return;
      if (replaceRunId && !replacementAccepted) {
        session = getSessionById(session.id) || session;
        session.runControlStatus = "paused"; session.timelineState = "paused";
        session.timelineEvents = priorPausedTurn.events; session.pausedAnswer = priorPausedTurn.pausedAnswer || ""; liveAnswers[session.id] = priorPausedTurn.answer || "";
        if (priorPausedTurn.process) runProcesses[session.id] = priorPausedTurn.process;
        session.controlNotice = "新指令未发送：" + safeText(error.message); pendingState = null;
        window.LkaImageComposer.restore(selectedImages, session.id);
        session.messages = session.messages.filter(function (item) { return item.clientId !== imageMessageId; });
        writeDraft(session.id, cleaned); if (session.id === activeSessionId) { setRunStatus(session.controlNotice, "error"); showDraftForSession(session); setComposerDisabled(backendOffline); renderActiveMessages(); }
        persistSessions(); return;
      }
      if (requestStarted && !replaceRunId && (!error.httpStatus || error.httpStatus >= 500 || error.httpStatus === 408)) {
        preserveUncertainTurn(session, null, error);
        await recoverUncertainSubmission(session, null);
        return;
      }
      if (!requestStarted) restoreUnsentInput();
      var failureText = "Backend request failed: " + (error && error.message ? error.message : String(error));
      recordRunEvent(session, "run_failed", { message: failureText });
      if (activeSessionId === session.id) setRunStatus("发送失败：" + (error && error.message ? error.message : String(error)), "error");
      if (isBackendOfflineError(failureText) || failureText.indexOf("Failed to fetch") >= 0) {
        setBackendOfflineState(true, "后端未连接：" + failureText + "。请确认 LKA backend 正在运行：" + backendBaseUrl);
      }
      addMessageToSession(session, "assistant", failureText, true);
      delete managerPendingTurns[session.id];
      if (pendingState && pendingState.conversationId === session.id) pendingState = null;
      if (activeSessionId === session.id) setComposerDisabled(backendOffline);
      touchSession(session);
      pinSessionToTop(session.id);
      renderSessionList();
      if (activeSessionId === session.id) renderActiveMessages();
      persistSessions();
      if (activeSessionId === session.id) focusComposer();
    }
  }

  async function reconcileCompletedSession(sessionId, mayApply) {
    if (!sessionId || mayApply && !mayApply()) return false;
    if (queueEnabled(getSessionById(sessionId))) return refreshQueuedHistory(getSessionById(sessionId));
    var expectedMessages = sessionMessageSnapshot(sessionId);
    try {
      var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(sessionId), {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) return false;
      var remote = sessionFromBackendDetail(await response.json());
      var current = getSessionById(sessionId);
      var historyReset = current && remote ? reconcileHistoryReset(current, remote) : -1;
      if (historyReset < 0) return false;
      if (historyReset > 0) { if (activeSessionId === sessionId) renderActiveMessages(); persistSessions(); return true; }
      if (!remote || !remote.messages.length || !remote.backendHistoryFiltered
          && (remote.messages[remote.messages.length - 1].role !== "assistant"
          || remote.messages[remote.messages.length - 1].text === defaultGreetingMessage().text)) return false;
      var existing = getSessionById(sessionId);
      if (!existing || expectedMessages !== sessionMessageSnapshot(sessionId)
          || (pendingState && pendingState.conversationId === sessionId) || mayApply && !mayApply()
          || isManagerSession(existing) && !isManagerSession(remote)) return false;
      // Backend history is authoritative once the run has completed.
      delete liveAnswers[sessionId];
      existing.messages = remote.messages;
      touchSession(existing);
      if (activeSessionId === sessionId) renderActiveMessages();
      persistSessions();
      return true;
    } catch (error) {
      console.warn("[pet-chat] answer reconciliation failed", error);
      return false;
    }
  }

  var managerConversationRefresh = null;
  function refreshManagerConversation() {
    var session = getActiveSession(), generation = activeAgentTurnGeneration;
    if (queueEnabled(session)) return refreshQueuedHistory(session);
    function safeToRefresh() {
      return managerSessionReady && isManagerSession(session) && getActiveSession() === session
        && generation === activeAgentTurnGeneration && !pendingState && !runCommandInFlight[session.id]
        && !session.resumePending && !session.pauseRequested
        && (!session.multiAgentRunId || isTerminalRunStatus(session.runControlStatus));
    }
    if (!safeToRefresh()) return Promise.resolve(false);
    if (managerConversationRefresh) return managerConversationRefresh;
    var refresh = reconcileCompletedSession(session.id, safeToRefresh).finally(function () {
      if (managerConversationRefresh === refresh) managerConversationRefresh = null;
    });
    managerConversationRefresh = refresh;
    return refresh;
  }

  function performComposerAction(question) {
    renderRunControls(safeText(question));
    if (backendOffline || sendButton.disabled) return false;
    var action = sendButton.getAttribute("data-action");
    if (action === "resume" && inputQueueNeedsResume(getActiveSession())) {
      resumeManagerInputs(getActiveSession());
      return false;
    }
    if (action === "pause" || action === "resume") {
      controlActiveRun(action === "pause" ? "interrupt" : "resume");
      return false; // Native host preserves its draft for control actions.
    }
    if (queueEnabled(getActiveSession()) && action === "send") {
      if (!safeText(question).trim() && !window.LkaImageComposer.hasAttachments(activeSessionId)) { window.LkaImageComposer.explainEmpty(); return false; }
      enqueueManagerInput(getActiveSession(), question);
      return true;
    }
    if (pendingState) return false;
    if (!safeText(question).trim() && !window.LkaImageComposer.hasAttachments(activeSessionId)) { window.LkaImageComposer.explainEmpty(); return false; }
    input.value = ""; writeDraft(activeSessionId, "");
    var active = getActiveSession();
    sendQuestion(question, active && active.runControlStatus === "paused" ? active.multiAgentRunId : "");
    return true;
  }

  function submitCurrentInput() {
    var now = Date.now();
    if (now - lastSubmitAt < 260 && !(queueEnabled(getActiveSession()) && (input.value.trim() || window.LkaImageComposer.hasAttachments(activeSessionId)))) return;
    lastSubmitAt = now;
    performComposerAction(input.value);
  }

  window.__petChatReceive = function (result) {
    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch (ignored) {
        result = { answer: result };
      }
    }

    if (result && result.error && !result.session_id && !result.conversation_id && !result.request_id && !/^HTTP 409:/.test(result.error)) {
      var outstandingSessions = Object.keys(nativeTurnGenerations).filter(function (id) { return nativeTurnGenerations[id].size; });
      if (outstandingSessions.length > 1 || outstandingSessions.length === 1 && nativeTurnGenerations[outstandingSessions[0]].size > 1) return;
      if (outstandingSessions.length === 1) result.session_id = outstandingSessions[0];
    }
    if (result && result.request_id) {
      var nativeRequest = nativeStreamCallbacks[result.request_id];
      if (!nativeRequest || nativeRequest.sessionId !== (result.session_id || result.conversation_id)
          || !turnIsCurrent(getSessionById(nativeRequest.sessionId), nativeRequest.generation)) return;
      delete nativeStreamCallbacks[result.request_id];
    }
    if (result && result.transport_uncertain) {
      handleNativeUncertainTurn(result);
      return;
    }
    // Busy errors identify the original session. Never assign a stale response
    // to whichever session happens to be pending now.
    if (result && typeof result.error === "string" && /^HTTP 409:/.test(result.error)) {
      var nativeConflict = result.error.match(/^HTTP 409:\s*(\{[\s\S]*\})\s*$/), identity = null;
      try { identity = nativeConflict ? JSON.parse(nativeConflict[1]) : null; } catch (ignored) {}
      var conflictPending = pendingState;
      var turn = conflictPending && conflictPending.nativeTurn;
      var outerSessionId = result.session_id || result.conversation_id;
      var conflictSessionId = identity && typeof identity.session_id === "string" ? identity.session_id : outerSessionId;
      // Legacy Java errors do not echo a generation. An otherwise unidentified
      // failure belongs to the pending turn only when exactly one native attempt
      // remains outstanding in the whole page.
      var outstanding = Object.keys(nativeTurnGenerations).reduce(function (count, id) { return count + nativeTurnGenerations[id].size; }, 0);
      if (!conflictSessionId && outstanding === 1 && turn) conflictSessionId = turn.sessionId;
      if (conflictSessionId && managerPendingTurns[conflictSessionId]) {
        conflictPending = managerPendingTurns[conflictSessionId]; turn = conflictPending.nativeTurn;
      }
      var generations = conflictSessionId && nativeTurnGenerations[conflictSessionId];
      if (turn && conflictSessionId === turn.sessionId && getSessionById(conflictSessionId)
          && generations && generations.size === 1 && generations.has(turn.generation)
          && turnIsCurrent(getSessionById(conflictSessionId), turn.generation) && conflictPending.generation === turn.generation
          && conflictPending.conversationId === conflictSessionId && typeof conflictPending.recoverSessionConflict === "function"
          && (!outerSessionId || outerSessionId === conflictSessionId)) {
        var validRun = identity && typeof identity.run_id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(identity.run_id);
        delete nativeTurnGenerations[conflictSessionId];
        conflictPending.recoverSessionConflict(validRun ? identity.run_id : null);
      } else if (generations && generations.size === 1 && (!turn || conflictSessionId !== turn.sessionId)) {
        delete nativeTurnGenerations[conflictSessionId];
      }
      // Unknown sessions and ambiguous generations cannot clear another turn.
      return;
    }
    var responseConversationId = normalizeConversationId(
      (result && (result.session_id || result.conversation_id)) || (pendingState && pendingState.conversationId) || activeSessionId
    );
    delete nativeTurnGenerations[responseConversationId];
    if (deletedSessionIds[responseConversationId]) return;
    var session = getOrCreateSessionById(responseConversationId);
    if (!session) {
      setComposerDisabled(false);
      pendingState = null;
      return;
    }

    if (result && result.status === "paused") {
      if (result.run_id) session.multiAgentRunId = result.run_id;
      settlePausedRun(session); return;
    }
    if (result && result.status === "cancelled") { settleCancelledRun(session); return; }

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
      addMessageToSession(session, "assistant", errorText, true, { runId: safeText(result.run_id) });
    } else {
      if (hasAnswerText) recordRunEvent(session, "run_completed", {});
      setBackendOfflineState(false, "");
      var backendMessages = normalizeBackendMessages(result && result.messages);
      if (pendingApproval || !backendUserVisible(result)) {
        // Keep internal completions out of chat; pending approvals still use their card.
      } else {
        var answerText = safeText(extractAnswer(result)).trim();
        if (answerText) {
          var runDetails = buildAgentRunDetails(result);
          runDetails.runId = runDetails.runId || (!runDetails.traceId ? session.multiAgentRunId : "") || "";
          addMessageToSession(session, "assistant", answerText, false, runDetails);
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

    if (hasAnswerText || shouldTreatAsHardError || !backendUserVisible(result)) { delete liveAnswers[session.id]; delete runProcesses[session.id]; }
    applySessionTitle(session);
    touchSession(session);
    pinSessionToTop(session.id);
    renderSessionList();

    if (!activeSessionId) activeSessionId = session.id;
    if (activeSessionId === session.id) {
      renderActiveMessages();
    } else {
      renderActiveSessionMeta();
    }
    persistSessions();

    delete managerPendingTurns[session.id];
    var completedStream = managerStreams[session.id];
    if (completedStream) {
      delete managerStreams[session.id];
      if (activeAgentEventController === completedStream.controller) activeAgentEventController = null;
    }
    if (pendingState && pendingState.conversationId === session.id) pendingState = null;
    if (activeSessionId === session.id) setComposerDisabled(backendOffline);
    window.dispatchEvent(new CustomEvent("lka-agent-turn-finished", { detail: { sessionId: session.id } }));
    if (activeSessionId === session.id) focusComposer();
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
  window.__petChatSubmitText = function (text) { return performComposerAction(text); };

  input.addEventListener("input", function () { writeDraft(activeSessionId, input.value); renderRunControls(); });
  window.addEventListener("lka-attachments-changed", renderRunControls);
  if (workMode && !document.body.classList.contains("mobile-workbench") && typeof ResizeObserver === "function") {
    var composerInputWidth = -1;
    new ResizeObserver(function (entries) {
      var width = entries[0].contentRect.width;
      if (Math.abs(width - composerInputWidth) < 0.5) return;
      composerInputWidth = width;
      resizeWorkbenchComposer();
    }).observe(input);
  }

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
      historyLoadedRequestKey = "";
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
    if (!session || managerEmbedding || quickAssistantLoading || !managerSessionReady || isManagerSession(session) || session.workspace || bridgeWorkspaceRetryScheduled) return;
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
      if (session && (getSessionMessageCount(session) > 0 || session.backendWorkspace)) {
        if (!await workspaceSwitchPromise) throw new Error("工作区切换失败，请检查路径后重试");
        await ensureSessionWorkspace(session);
        sessionId = await bindSessionWorkspace(session);
      }
      persistSessions();
      if (nativeOpener) {
        window.petBridge.openWorkbenchSession(sessionId, session && session.multiAgentRunId || "");
      } else {
        browserWindow.location.href = "/desktop-pet/chat.html?mode=work&backend=" + encodeURIComponent(backendBaseUrl)
          + (sessionId ? "&session_id=" + encodeURIComponent(sessionId) : "")
          + (session && session.multiAgentRunId ? "&run_id=" + encodeURIComponent(session.multiAgentRunId) : "");
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

  async function discoverSessionRootRun(session, options) {
    if (!session || !session.id) return null;
    options = options || {};
    var selectedId = activeSessionId, selectionEpoch = quickAssistantEpoch, requestBackend = backendBaseUrl;
    var requestRunId = safeText(session.multiAgentRunId).trim();
    var requestSequence = Number(session.multiAgentSequence) || 0;
    var requestTurnGeneration = activeAgentTurnGeneration;
    var response = await fetch(requestBackend + "/sessions/" + encodeURIComponent(session.id) + "/runs?limit=100&offset=0", {
      headers: { Accept: "application/json" }, signal: options.signal
    });
    if (!response.ok) { var requestError = new Error("无法核对会话运行 HTTP " + response.status); requestError.httpStatus = response.status; throw requestError; }
    var payload = await response.json();
    if (!Array.isArray(payload.runs) || payload.session_id !== session.id) throw new Error("会话运行记录无效");
    if (options.signal && options.signal.aborted || requestBackend !== backendBaseUrl
        || safeText(session.multiAgentRunId).trim() !== requestRunId
        || (Number(session.multiAgentSequence) || 0) !== requestSequence
        || activeSessionId === session.id && requestTurnGeneration !== activeAgentTurnGeneration
        || selectionEpoch !== quickAssistantEpoch || selectedId !== activeSessionId
        || (selectedId && selectedId !== session.id && !isManagerSession(session))) return null;
    var roots = payload.runs.filter(function (run) {
      return run && run.run_id && !run.parent_run_id && !run.superseded_by_run_id
        && run.session_id === session.id;
    }).sort(function (a, b) { return timestampToMillis(b.created_at) - timestampToMillis(a.created_at); });
    var latest = roots[0] || null;
    runDiscoveryAt[session.id] = Date.now();
    var previousId = session.multiAgentRunId;
    var previousStream = managerStreams[session.id];
    if (!latest) {
      if (previousId) {
        if (previousStream) { previousStream.controller.abort(); delete managerStreams[session.id]; }
        if (activeSessionId === session.id) abortActiveAgentEventStream();
        session.multiAgentRunId = ""; session.multiAgentSequence = 0;
        session.runControlStatus = ""; session.timelineState = ""; session.timelineEvents = [];
        delete runProcesses[session.id]; delete liveAnswers[session.id];
      }
      return null;
    }
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(latest.run_id)) throw new Error("会话运行编号无效");
    var changed = previousId !== latest.run_id;
    if (changed) {
      if (previousStream) { previousStream.controller.abort(); delete managerStreams[session.id]; }
      if (activeSessionId === session.id) abortActiveAgentEventStream();
      delete runProcesses[session.id]; delete liveAnswers[session.id];
      session.timelineEvents = [];
      session.multiAgentSequence = 0;
    } else if (!runProcesses[session.id] && options.replay !== false
        && !(isManagerSession(session) && previousStream && !previousStream.controller.signal.aborted && previousStream.runId === latest.run_id)) {
      // A persisted cursor alone cannot rebuild the visible process on another device.
      session.multiAgentSequence = 0;
      if (previousStream && previousStream.runId === latest.run_id) {
        previousStream.controller.abort(); delete managerStreams[session.id];
      }
    }
    session.multiAgentRunId = latest.run_id;
    runDiscoveryAt[session.id] = Date.now();
    var previousStatus = session.runControlStatus;
    session.runControlStatus = latest.status || "queued";
    session.timelineState = ({ queued: "running", running: "running", paused: "paused",
      waiting_confirmation: "waiting", waiting_user: "waiting", completed: "completed",
      failed: "failed", timed_out: "failed", cancelled: "cancelled" })[latest.status] || "running";
    session.resumePending = false;
    session.connectionUncertain = false;
    session.controlNotice = "";
    saveRunCursor(session);
    persistSessions();
    if (activeSessionId === session.id && (changed || previousStatus !== session.runControlStatus)
        && (!runStatus || !runStatus.classList.contains("error")
        || latest.status === "failed" || latest.status === "timed_out")) {
      if (latest.status === "failed" || latest.status === "timed_out") setRunStatus("本轮失败", "error");
      else if (latest.status === "paused") setRunStatus("任务已暂停");
      else if (latest.status === "waiting_confirmation") setRunStatus("等待操作确认", "review");
      else if (latest.status === "waiting_user") setRunStatus("等待补充信息");
      else if (latest.status === "completed") setRunStatus("本轮完成");
      else setRunStatus("任务处理中");
      renderRunControls();
    }
    return { run: latest, changed: changed };
  }

  async function recoverManagerRun(session) {
    return discoverSessionRootRun(session);
  }

  function quickAssistantState(detail) {
    quickAssistantLastState = detail;
    window.dispatchEvent(new CustomEvent("lka-quick-assistant-state", { detail: detail }));
  }
  function cancelQuickAssistantOpen() {
    quickAssistantEpoch += 1;
    quickAssistantPromise = null;
    quickAssistantLoading = false;
    managerSessionReady = true;
    quickAssistantState({ loading: false, manager: null });
  }
  function quickAssistantCancelled() {
    var error = new Error("助手载入已被新的会话选择取消。"); error.name = "AbortError"; return error;
  }
  async function quickAssistantRequest(path, method, body) {
    var host = window.LkaMatterHost;
    if (host && typeof host.request === "function") {
      await host.ready;
      if (sessionHistory && (!method || method === "GET") && /^\/sessions\/[^/?]+$/.test(path)) {
        return sessionHistory.load(decodeURIComponent(path.slice("/sessions/".length)), {
          request: function (pagedPath) { return host.request(pagedPath, "GET"); }
        });
      }
      return host.request(path, method || "GET", body);
    }
    var response = await fetch(backendBaseUrl + path, { method: method || "GET", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    var data = await response.json();
    if (!response.ok) { var failure = new Error("助手连接失败"); failure.status = response.status; failure.detail = data.detail; throw failure; }
    return data;
  }
  async function ensureManagerExecutionWorkspace(manager) {
    if (manager.controller.default_execution_workspace) return manager;
    // A cloud 真理 never receives a directory from this computer; remote work
    // names its device and workspace through execution_target instead.
    var cloudHost = typeof window !== "undefined" && window.LkaHost;
    if (cloudHost && (cloudHost.hosted || cloudHost.cloudRouting || cloudHost.clientMode === "cloud")) return manager;
    await defaultsReady;
    var response = await fetch("/pet/session-workspace-parent", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_path: runSettings.workspaceParent || "" })
    });
    var parent = await response.json();
    if (!response.ok || !parent.path || ["windows", "linux", "macos"].indexOf(parent.platform) < 0) {
      throw new Error("默认任务目录准备失败：" + safeText(parent.detail || "前端未返回有效目录"));
    }
    try {
      var updated = await quickAssistantRequest("/managers/" + encodeURIComponent(manager.session.session_id), "PATCH", {
        expected_revision: manager.controller.revision,
        default_execution_workspace: { path: parent.path, platform: parent.platform }
      });
      if (!updated.session || updated.session.session_id !== manager.session.session_id || !updated.controller
          || !updated.controller.default_execution_workspace || updated.controller.default_execution_workspace.path !== parent.path
          || updated.controller.default_execution_workspace.platform !== parent.platform
          || updated.controller.revision <= manager.controller.revision) throw new Error("后端未确认默认目录已保存");
      return updated;
    } catch (error) {
      // A conflicting writer's choice wins; never blindly retry its revision.
      if (error.status === 409) {
        var latest = await quickAssistantRequest("/managers/" + encodeURIComponent(manager.session.session_id));
        if (latest.controller && latest.controller.default_execution_workspace) return latest;
      }
      throw new Error("默认任务目录同步失败，请重试：" + safeText(error.message));
    }
  }
  var managerWorkspaceRequests = Object.create(null);
  async function prepareManagerConversation(sessionId, supplied) {
    var epoch = quickAssistantEpoch, scope = assistantCacheEpoch;
    function selected() { return activeSessionId === sessionId && epoch === quickAssistantEpoch && scope === assistantCacheEpoch; }
    if (selected()) { managerSessionReady = false; setComposerDisabled(true); }
    try {
      if (!managerWorkspaceRequests[sessionId]) {
        managerWorkspaceRequests[sessionId] = (async function () {
          var cached = quickAssistantManager && quickAssistantManager.session.session_id === sessionId
            && quickAssistantManager.controller.default_execution_workspace ? quickAssistantManager : null;
          var manager = supplied || cached || await quickAssistantRequest("/managers/" + encodeURIComponent(sessionId));
          if (!manager || !manager.session || manager.session.kind !== "manager" || manager.session.session_id !== sessionId
              || !manager.controller || manager.controller.session_id !== sessionId
              || !Number.isSafeInteger(manager.controller.revision) || manager.controller.revision < 1) throw new Error("真理会话身份无效");
          return ensureManagerExecutionWorkspace(manager);
        }());
      }
      var operation = managerWorkspaceRequests[sessionId];
      var manager = await operation;
      if (selected()) {
        quickAssistantManager = manager; managerSessionReady = true;
        quickAssistantState({ loading: false, manager: manager }); setComposerDisabled(backendOffline || !!pendingState);
      }
      return manager;
    } catch (error) {
      if (selected()) {
        managerSessionReady = false; setComposerDisabled(true);
        var reason = "真理载入失败：" + quickAssistantErrorMessage(error) + "。请重试。";
        setRunStatus(reason, "error"); quickAssistantState({ loading: false, error: reason, manager: null });
      }
      throw error;
    } finally { if (managerWorkspaceRequests[sessionId] === operation) delete managerWorkspaceRequests[sessionId]; }
  }
  function quickAssistantErrorMessage(error) {
    if (error.detail === "management_disabled") return "当前后端尚未启用真理";
    if (error.status === 409 && (error.detail === "default_manager_deleted" || error.detail === "Default management session is unavailable; restore or explicitly replace it")) return "原真理已被删除，请在后端确认默认助手配置后重新连接";
    if (error.status === 401 || error.status === 403) return "当前连接没有使用真理的权限";
    if (error.status === 404) return "后端暂不支持真理，请检查服务版本";
    if (error.status >= 500 || error.status === 0 || error instanceof TypeError || /HTTP \d{3}/.test(safeText(error.message))) return "暂时无法连接助手服务";
    return safeText(error.message || "助手暂不可用");
  }
  function prepareAssistant(options) {
    if (assistantPreparation) return assistantPreparation;
    if (!(options && options.refresh) && quickAssistantManager && quickAssistantManager.controller.default_execution_workspace
        && getSessionById(quickAssistantManager.session.session_id)) return Promise.resolve(quickAssistantManager);
    var scope = assistantCacheEpoch, startedAt = Date.now();
    var request = (async function () {
      var manager = await quickAssistantRequest("/managers/default", "POST");
      var raw = manager && manager.session, controller = manager && manager.controller;
      if (!raw || raw.kind !== "manager" || !safeText(raw.session_id).trim() || !controller || controller.session_id !== raw.session_id
          || !Number.isSafeInteger(controller.revision) || controller.revision < 1 || ["active", "paused"].indexOf(controller.status) < 0) throw new Error("管理会话状态无效，请重试。");
      if (scope !== assistantCacheEpoch) throw quickAssistantCancelled();
      manager = await ensureManagerExecutionWorkspace(manager);
      if (scope !== assistantCacheEpoch) throw quickAssistantCancelled();
      controller = manager.controller;
      var existing = getSessionById(raw.session_id);
      if (!quickAssistantManager || quickAssistantManager.session.session_id !== raw.session_id || !existing) {
        var detail = await quickAssistantRequest("/sessions/" + encodeURIComponent(raw.session_id));
        var loaded = sessionFromBackendDetail(detail);
        if (!isManagerSession(loaded) || loaded.id !== raw.session_id) throw new Error("真理会话类型不匹配，请重试。");
        var cached = getSessionById(loaded.id);
        var resetBeforeRecovery = cached ? reconcileHistoryReset(cached, loaded) : 0;
        if (resetBeforeRecovery < 0) loaded = cached;
        await recoverManagerRun(loaded);
        if (scope !== assistantCacheEpoch) throw quickAssistantCancelled();
        preparedAssistantId = loaded.id;
        var latest = getSessionById(loaded.id);
        var historyReset = latest ? reconcileHistoryReset(latest, loaded) : 0;
        if (historyReset >= 0 && resetBeforeRecovery > 0) { Object.assign(latest, loaded); loaded = latest; }
        if (historyReset < 0) loaded = latest;
        else if (historyReset > 0) { latest.messages = loaded.messages; loaded = latest; }
        else if (latest && latest.messages.some(function (item) { return item.queueRequest; })) loaded.messages = mergeQueuedMessages(latest, loaded);
        // A live conversation can start while default identity/history is loading.
        // Keep that exact object and its cursor rather than replacing it with an older snapshot.
        if (isManagerSession(latest) && (managerPendingTurns[latest.id] || managerStreams[latest.id] || latest.updated_at > startedAt)) loaded = latest;
        else {
          sessions = sessions.filter(function (item) { return item.id !== loaded.id; });
          sessions.unshift(loaded);
        }
        if (loaded.multiAgentRunId) {
          saveRunCursor(loaded);
          if (loaded.runControlStatus !== "completed" && loaded.runControlStatus !== "cancelled"
              && (loaded.runControlStatus !== "paused" || loaded.resumePending)) reconnectSavedRun(loaded, null);
        }
        persistSessions();
      }
      if (!quickAssistantManager || quickAssistantManager.session.session_id !== raw.session_id || quickAssistantManager.controller.revision <= controller.revision) quickAssistantManager = manager;
      if (activeSessionId === raw.session_id && !quickAssistantLoading) {
        managerSessionReady = true; setComposerDisabled(backendOffline || !!pendingState);
      }
      var preparedSession = getSessionById(raw.session_id);
      if (options && options.refresh && preparedSession) queueState(preparedSession).unsupported = false;
      refreshManagerInputs(preparedSession);
      quickAssistantState({ loading: quickAssistantLoading, manager: quickAssistantManager });
      return quickAssistantManager;
    }()).finally(function () { if (assistantPreparation === request) assistantPreparation = null; });
    assistantPreparation = request;
    return request;
  }
  function openQuickAssistant(options) {
    if (quickAssistantPromise) return quickAssistantPromise;
    var epoch = ++quickAssistantEpoch;
    var prepared = quickAssistantManager && getSessionById(quickAssistantManager.session.session_id);
    quickAssistantLoading = !prepared; managerSessionReady = !!prepared;
    if (!prepared) { setComposerDisabled(true); setRunStatus("正在连接真理…"); }
    quickAssistantState({ loading: !prepared, manager: quickAssistantManager });
    var request = (async function () {
      try {
        var manager = await prepareAssistant(options);
        if (epoch !== quickAssistantEpoch) throw quickAssistantCancelled();
        managerSessionReady = true;
        if (activeSessionId !== manager.session.session_id) {
          var switched = await switchSession(manager.session.session_id, epoch, manager);
          if (switched === false || epoch !== quickAssistantEpoch) throw quickAssistantCancelled();
        }
        quickAssistantLoading = false;
        setComposerDisabled(backendOffline || !!pendingState);
        await refreshManagerInputs();
        if (!getActiveSession().multiAgentRunId && (queueState(getActiveSession()).supported || queueState(getActiveSession()).unsupported)) setRunStatus("真理已就绪");
        quickAssistantState({ loading: false, manager: manager });
        return manager;
      } catch (error) {
        if (epoch === quickAssistantEpoch) {
          quickAssistantLoading = false; managerSessionReady = false;
          var reason = "真理连接失败：" + quickAssistantErrorMessage(error) + "。可以重试，或开始新任务。";
          setRunStatus(reason, "error"); setComposerDisabled(true);
          quickAssistantState({ loading: false, error: reason, manager: null });
        }
        throw error;
      } finally { if (quickAssistantPromise === request) quickAssistantPromise = null; }
    }());
    quickAssistantPromise = request;
    return request;
  }
  window.addEventListener("lka-matter-auth-changed", function () {
    if (sessionHistory) sessionHistory.clear();
    assistantCacheEpoch++; assistantPreparation = null; quickAssistantManager = null; preparedAssistantId = "";
    managerWorkspaceRequests = Object.create(null); historicalProcesses.clear();
    activeAgentTurnGeneration++;
    if (activeAgentEventController) activeAgentEventController.abort();
    activeAgentEventController = null; pendingState = null;
    Object.keys(managerStreams).forEach(function (id) { managerStreams[id].controller.abort(); delete liveAnswers[id]; });
    managerStreams = Object.create(null); managerPendingTurns = Object.create(null);
    managerInputQueues = Object.create(null);
    nativeStreamCallbacks = Object.create(null); nativeTurnGenerations = Object.create(null);
    cancelQuickAssistantOpen();
    if (isManagerSession(getActiveSession())) { managerSessionReady = false; setComposerDisabled(true); }
  });
  window.__petChatOpenAssistant = function () { return openQuickAssistant().catch(function () { return null; }); };

  async function openRequestedSession() {
    if (!requestedSessionId) { if (managerEmbedding) { setRunStatus("缺少真理会话，请从助手入口重新打开。", "error"); setComposerDisabled(true); } else openFreshTask(); return; }
    var requestEpoch = quickAssistantEpoch;
    managerSessionReady = false;
    setComposerDisabled(true);
    var session = managerEmbedding ? null : getSessionById(requestedSessionId);
    if (!session) {
      try {
        var response = await fetch(backendBaseUrl + "/sessions/" + encodeURIComponent(requestedSessionId));
        if (!response.ok) throw new Error("HTTP " + response.status);
        session = sessionFromBackendDetail(await response.json());
        if (requestEpoch !== quickAssistantEpoch) return;
        if (!session) throw new Error("会话内容无效");
        if (managerEmbedding && (session.id !== requestedSessionId || !isManagerSession(session))) throw new Error("真理会话类型不匹配，请从助手入口重新打开。");
        sessions = sessions.filter(function (item) { return item.id !== session.id; });
        sessions.unshift(session);
        normalizeSessionBounds();
      } catch (error) {
        if (requestEpoch !== quickAssistantEpoch) return;
        if (managerEmbedding) { setRunStatus("真理载入失败：" + safeText(error.message || error) + "。请刷新后重试。", "error"); setComposerDisabled(true); return; }
        openFreshTask();
        setRunStatus("无法继续原任务：" + safeText(error.message || error), "error");
        return;
      }
    }
    if (requestEpoch !== quickAssistantEpoch) return;
    if (isManagerSession(session)) {
      activeSessionId = session.id;
      try { await prepareManagerConversation(session.id); }
      catch (error) { return; }
      if (requestEpoch !== quickAssistantEpoch || activeSessionId !== session.id) return;
    }
    activeSessionId = session.id;
    var discoveredRun = null;
    try { discoveredRun = await discoverSessionRootRun(session); }
    catch (error) { if (activeSessionId === session.id) setRunStatus("无法核对当前任务：" + safeText(error.message || error), "error"); }
    if (requestEpoch !== quickAssistantEpoch || activeSessionId !== session.id) return;
    if (!managerEmbedding && !discoveredRun && requestedRunId && session.multiAgentRunId !== requestedRunId) {
      session.multiAgentRunId = requestedRunId;
      session.multiAgentSequence = 0;
      session.timelineState = "running";
    }
    managerSessionReady = true;
    setComposerDisabled(backendOffline);
    showDraftForSession(session);
    fileRelativePath = "";
    renderSessionList();
    renderActiveMessages();
    renderWorkspaceSummary(session);
    refreshActiveMultiAgentSnapshot();
    refreshManagerInputs();
    var requestedRunIsPausedManager = discoveredRun && isManagerSession(session) && discoveredRun.run.status === "paused"
      && !session.resumePending && !!runProcesses[session.id];
    if (discoveredRun && discoveredRun.run.status !== "completed" && discoveredRun.run.status !== "cancelled") {
      if (!requestedRunIsPausedManager && !(isManagerSession(session) && managerStreams[session.id] && managerStreams[session.id].runId === session.multiAgentRunId)) reconnectSavedRun(session, null);
    } else if (!discoveredRun) reconnectActiveSavedRun();
    if (requestedMessageId && isManagerSession(session)) await revealRequestedMessage(session);
    loadFileList();
    persistSessions();
    focusComposer();
  }
  async function revealRequestedMessage(session) {
    if (!sessionHistory || !requestedMessageId || !session) return;
    try {
      // Fetch directly around the published delivery message. This avoids
      // landing at the newest part of a long manager conversation.
      sessionHistory.clear(session.id);
      var detail = await sessionHistory.load(session.id, { around: requestedMessageId });
      if (activeSessionId !== session.id) return;
      var loaded = sessionFromBackendDetail(detail);
      if (loaded) mergeBackendSession(loaded, sessionMessageSnapshot(session.id));
      renderActiveMessages();
      var target = Array.prototype.find.call(messages.querySelectorAll(".message[data-message-id]"), function (item) {
        return item.dataset.messageId === requestedMessageId;
      });
      if (!target) { setRunStatus("已打开交付会话，但目标消息不在后端返回的记录页中。", "error"); return; }
      target.classList.add("delivery-message-target");
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(function () { if (target.isConnected) target.classList.remove("delivery-message-target"); }, 5000);
    } catch (error) {
      if (activeSessionId === session.id) setRunStatus("交付记录定位失败：" + safeText(error.message || error), "error");
    }
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
    var otherVisible = !desktopPanels || (side === "sidebar" ? railDocked() && panelVisibility[railVisibilityKey()] : sidebarDocked() && panelVisibility.sidebar);
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
      var savedVisibility = JSON.parse(localStorage.getItem(panelVisibilityKey) || "null");
      // v1 only carried a list preference worth keeping; the rail adopts the new collapsed default.
      if (!savedVisibility) savedVisibility = { sidebar: (JSON.parse(localStorage.getItem(legacyPanelVisibilityKey) || "{}") || {}).sidebar };
      ["sidebar", "rail", "followup"].forEach(function (side) { if (typeof savedVisibility[side] === "boolean") panelVisibility[side] = savedVisibility[side]; });
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
    if ((window.LkaMatters && window.LkaMatters.isOpen()) ||
        (window.LkaProjects && window.LkaProjects.isOpen()) ||
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
  if (reasoningLevelInput) reasoningLevelInput.addEventListener("input", function () {
    renderReasoningControl(reasoningLevels[Number(reasoningLevelInput.value)]);
  });
  [llmModelInput, llmAnswerModelInput, reasoningLevelInput, safetyModeSelect, streamToggle, workspaceParentInput].forEach(function (control) {
    if (control) control.addEventListener("change", saveDefaultPreferences);
  });
  if (refreshModelsButton) refreshModelsButton.addEventListener("click", function () { loadModelCatalog(true); });
  if (resetDefaultsButton) resetDefaultsButton.addEventListener("click", function () {
    if (llmModelInput) llmModelInput.value = "";
    if (llmAnswerModelInput) llmAnswerModelInput.value = "";
    if (safetyModeSelect) safetyModeSelect.value = "backend";
    if (reasoningLevelInput) reasoningLevelInput.value = 1;
    if (streamToggle) streamToggle.checked = true;
    if (workspaceParentInput) workspaceParentInput.value = "";
    saveDefaultPreferences();
  });
  function switchWorkspace(requestedWorkspace, expectedSessionId, selectedNodeWorkspaceId) {
    var session = getActiveSession();
    if (!session || (expectedSessionId && expectedSessionId !== session.id)) throw new Error("会话已改变，请重新选择工作目录。");
    if (managerEmbedding || isManagerSession(session)) throw new Error("真理不绑定工作目录，请在普通任务会话中操作文件。");
    if (pendingState) throw new Error("请等待当前任务完成后切换工作目录。");
    requestedWorkspace = safeText(requestedWorkspace).trim();
    selectedNodeWorkspaceId = safeText(selectedNodeWorkspaceId).trim();
    if (nodeBoundary() && selectedNodeWorkspaceId && selectedNodeWorkspaceId === session.nodeWorkspaceId
        || !selectedNodeWorkspaceId && requestedWorkspace === safeText(session.workspace).trim()) return Promise.resolve(true);
    if (!requestedWorkspace) {
      renderWorkspaceSummary(session);
      setRunStatus("请输入要切换到的工作目录", "error");
      return Promise.resolve(false);
    }
    var switchTask = workspaceSwitchPromise.then(async function () {
      var previousCustomWorkspace = session.workspace_is_custom;
      try {
        session.workspace_is_custom = true;
        // A user-chosen directory is an explicit workspace, never a reserved default.
        var previousReserved = session.workspaceReserved;
        session.workspaceReserved = false;
        try { await bindSessionWorkspace(session, nodeBoundary() && selectedNodeWorkspaceId ? selectedNodeWorkspaceId : requestedWorkspace); }
        catch (bindError) { session.workspaceReserved = previousReserved; throw bindError; }
        session.workspace = requestedWorkspace;
        if (nodeBoundary() && selectedNodeWorkspaceId) {
          session.nodeWorkspaceId = selectedNodeWorkspaceId;
          session.nodeWorkspaceBound = selectedNodeWorkspaceId;
        }
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
  sessions.forEach(function (session) {
    session.messages.forEach(function (message) {
      if (message.queueRequest && message.inputStatus === "submitting") { message.inputStatus = "submission_failed"; message.inputError = "窗口已重新打开，请重试核对发送结果"; }
    });
  });
  if (quickAssistantDefault) { activeSessionId = ""; setComposerDisabled(true); }
  if (globalAssistantLaunch) showDraftForSession(getActiveSession());
  if (managerEmbedding) { sessions = []; activeSessionId = ""; input.placeholder = "和真理聊聊目标、进展或下一步…"; setComposerDisabled(true); }
  setRailTab(activeRailTab);
  if (quickAssistantDefault) Promise.resolve().then(openQuickAssistant).catch(function () {});
  else openRequestedSession();
  refreshSafetyReviewQueue();
  syncSessionsFromBackend();
  loadHistoryPage(true);

  window.__petChatOpenFreshTask = function () {
    if (window.LkaProjects && window.LkaProjects.isOpen()) window.LkaProjects.close();
    openFreshTask();
    syncSessionsFromBackend();
  };

  window.LkaChatContext = {
    reasoningOptions: reasoningOptions,
    preferences: function () {
      return {
        modelValue: llmModelInput ? llmModelInput.value : "",
        answerModelValue: llmAnswerModelInput ? llmAnswerModelInput.value : "",
        models: llmModelInput ? Array.from(llmModelInput.options).map(function (option) {
          var group = option.parentElement.tagName === "OPTGROUP" ? option.parentElement.label : "";
          return { value: option.value, label: (group ? group + " / " : "") + option.textContent };
        }) : [],
        reasoningLevel: runSettings.reasoningLevel || "low",
        safetyMode: safetyModeSelect ? safetyModeSelect.value : "backend",
        stream: streamToggle ? streamToggle.checked : true,
        saveError: !!defaultsSaveError
      };
    },
    preferencesReady: async function (refreshModels) {
      await defaultsReady;
      if (refreshModels || !modelCatalog) await loadModelCatalog(!!refreshModels);
    },
    savePreferences: async function (values) {
      if (Object.prototype.hasOwnProperty.call(values, "modelValue")) selectPreferenceModel(llmModelInput, values.modelValue);
      if (Object.prototype.hasOwnProperty.call(values, "answerModelValue")) selectPreferenceModel(llmAnswerModelInput, values.answerModelValue);
      if (Object.prototype.hasOwnProperty.call(values, "reasoningLevel")) {
        if (reasoningLevels.indexOf(values.reasoningLevel) < 0) throw new Error("请选择有效的推理强度。");
        if (reasoningLevelInput) reasoningLevelInput.value = reasoningLevels.indexOf(values.reasoningLevel);
      }
      if (Object.prototype.hasOwnProperty.call(values, "safetyMode")) safetyModeSelect.value = values.safetyMode;
      if (Object.prototype.hasOwnProperty.call(values, "stream")) streamToggle.checked = values.stream;
      await saveDefaultPreferences();
      if (defaultsSaveError) throw defaultsSaveError;
    },
    acceptAssistantSettings: function (value) {
      var session = getActiveSession();
      if (!isManagerSession(session) || !value || !value.session || value.session.session_id !== session.id || !value.controller) return;
      if (quickAssistantManager && quickAssistantManager.controller.revision > value.controller.revision) return;
      quickAssistantManager = value;
      quickAssistantState({ loading: false, manager: value });
    },
    syncPanels: syncWorkbenchPanels,
    restoreAssistantConversation: async function (id) {
      var session = getSessionById(id), generation = activeAgentTurnGeneration;
      if (!isManagerSession(session) || activeSessionId !== id || pendingState) return false;
      if (session.multiAgentRunId && !isTerminalRunStatus(session.runControlStatus)) return false;
      var candidate = Object.assign({}, session);
      await recoverManagerRun(candidate);
      if (activeSessionId !== id || generation !== activeAgentTurnGeneration || pendingState || !candidate.multiAgentRunId) return false;
      session.multiAgentRunId = candidate.multiAgentRunId; session.multiAgentSequence = candidate.multiAgentSequence;
      session.runControlStatus = candidate.runControlStatus; session.timelineState = candidate.timelineState;
      saveRunCursor(session); persistSessions(); renderActiveMessages(); reconnectActiveSavedRun();
      return true;
    },
    ensureAssistantWorkspace: function (manager) {
      return prepareManagerConversation(manager.session.session_id, manager);
    },
    prepareAssistant: prepareAssistant,
    openAssistant: openQuickAssistant,
    assistantState: function () { return Object.assign({}, quickAssistantLastState); },
    refreshConversation: refreshManagerConversation,
    prepareMatterDraft: function (text) {
      var session = getActiveSession();
      var draft = safeText(input.value || readDraft(activeSessionId));
      var next = (draft ? draft + "\n" : "") + text;
      input.value = next; writeDraft(activeSessionId, next);
      if (session) showDraftForSession(session);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      focusComposer(true);
    },
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
      if (isManagerSession(session)) throw new Error("真理不绑定工作目录，请通过附件按钮上传文件。");
      if (managerEmbedding) throw new Error("真理会话尚未载入。");
      fileWorkspacePreparations.push(session);
      try {
        if (!await workspaceSwitchPromise) throw new Error("请先完成工作区切换。");
        assertCurrent();
        await ensureSessionWorkspace(session);
        assertCurrent();
        var boundId = await bindSessionWorkspace(session, undefined, assertCurrent);
        assertCurrent();
        await materializeSessionWorkspace(getSessionById(boundId) || session);
        assertCurrent();
        return boundId;
      } finally {
        var index = fileWorkspacePreparations.indexOf(session);
        if (index >= 0) fileWorkspacePreparations.splice(index, 1);
      }
    },
    getFileContext: function () {
      var session = getActiveSession();
      if (nodeBoundary()) {
        var id = session && session.nodeWorkspaceId || "";
        return { sessionId: session ? session.id : "", workspace: id, workspaceId: id, path: fileRelativePath };
      }
      return { sessionId: session ? session.id : "", workspace: session ? session.workspace || "" : "", path: fileRelativePath };
    },
    refreshWorkspaceFiles: function (view) {
      var session = getActiveSession();
      var current = session && (nodeBoundary() ? session.nodeWorkspaceId : session.workspace);
      if (session && session.id === view.sessionId && current === view.workspace && fileRelativePath === view.path) return loadFileList();
    },
    prepareAttachments: async function (sessionId) {
      var session = getSessionById(sessionId);
      if (!session || deletedSessionIds[sessionId]) throw new Error("会话已关闭，请重新选择图片。");
      if (isManagerSession(session)) return session.id;
      if (managerEmbedding) throw new Error("真理会话尚未载入。");
      if (!await workspaceSwitchPromise) throw new Error("请先完成工作区切换。");
      await ensureSessionWorkspace(session);
      return bindSessionWorkspace(session);
    },
    invalidateHistory: function (sessionId) { if (sessionHistory) sessionHistory.clear(sessionId); },
    get: function () {
      var session = getActiveSession();
      return { backend: backendBaseUrl, workMode: workMode, hosted: hostedPage, nodeHosted: nodeHosted, nodeBoundary: nodeBoundary(), sessionId: session ? session.id : "", kind: session ? session.kind : "",
        workspace: session ? session.workspace || "" : "", projectId: session ? session.project_id || "" : "", busy: !!pendingState || !!(session && session.multiAgentRunId && ["queued", "running", "waiting_confirmation", "waiting_user"].indexOf(session.runControlStatus) >= 0) };
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
    var refreshHistory = event.key !== sessionsKey
      || historyIndexSignature(event.oldValue) !== historyIndexSignature(event.newValue);
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
    if (refreshHistory) loadHistoryPage(true);
    // Storage already carries the peer's run state. Render it without a GET
    // that would save the same cache and notify the other window again.
    renderRunControls();
    renderRunTimeline(getActiveSession());
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
    refreshActiveRunState();
    var selected = getActiveSession(), prepared = getSessionById(preparedAssistantId);
    if (isManagerSession(selected)) refreshManagerInputs(selected);
    if (isManagerSession(prepared) && (!selected || selected.id !== prepared.id)) refreshManagerInputs(prepared);
  }, 2500);

  window.setInterval(function () {
    if (document.hidden) return;
    syncSessionsFromBackend();
    loadHistoryPage(true);
    refreshActiveRunState();
  }, 15000);

  window.addEventListener("lka-global-assistant-layout", syncWorkbenchPanels);

  window.addEventListener("load", function () {
    focusComposer();
  });
}());
