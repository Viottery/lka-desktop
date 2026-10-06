(function () {
  "use strict";
  if (!window.LkaChatContext) return;
  var chat = window.LkaChatContext;
  var state = { scope: "global", tab: "entries", rows: [], next: null, selected: null,
    generation: 0, projectId: null, token: "", config: null, schema: null, models: null,
    jobs: [], preview: null, contextKey: "" };
  var typeNames = { preference: "偏好", project_decision: "项目决策", user_fact: "个人事实" };
  var statusNames = { active: "已生效", candidate: "候选", retracted: "已撤回", superseded: "已替代",
    queued: "排队中", running: "处理中", retry_wait: "等待重试", succeeded: "已完成", failed: "失败", cancelled: "已取消" };
  var requestSequence = 0, requestNonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  var bridgePending = {}, streamController = null, lastFocus = null, editorFocus = null;
  function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  }); }
  function date(value) { return value ? new Date(value).toLocaleString() : "—"; }
  function el(id) { return document.getElementById(id); }
  function context() { return chat.get(); }
  function isOpen() { return !el("memoryOverlay").hidden; }
  function notice(text, error) {
    el("memoryStatus").textContent = text || "";
    el("memoryStatus").classList.toggle("error", !!error);
  }
  function query(scope, workspace) {
    scope = scope || state.scope;
    workspace = workspace === undefined ? context().workspace : workspace;
    if (scope === "project" && !workspace) throw new Error("请先选择当前会话的工作目录。");
    return "scope=" + scope + (scope === "project" ? "&workspace_path=" + encodeURIComponent(workspace) : "");
  }
  function recordQuery(record, workspace) {
    return record.scope === "project" ? "?workspace_path=" + encodeURIComponent(workspace || context().workspace) : "";
  }
  function parseResponse(status, text) {
    var payload;
    try { payload = text ? JSON.parse(text) : {}; } catch (ignored) { payload = {}; }
    if (status < 200 || status >= 300) {
      var messages = { 0: "无法连接后端，请检查服务地址或连接设置。", 401: "此接口需要访问令牌，请在连接设置中填写。",
        403: "当前连接没有访问权限；请检查工作目录范围或本机访问限制。",
        404: "此接口或内容不可用。请确认后端已加载新版记忆模块。",
        409: "内容或状态已变化，请重新载入后再操作；当前编辑内容已保留。" };
      var detail = Array.isArray(payload.detail) ? payload.detail.map(function (e) { return (e.loc || []).join(".") + "：" + e.msg; }).join("；") : payload.detail;
      var error = new Error(messages[status] || ("请求失败 HTTP " + status + (detail ? "：" + String(detail) : "")));
      error.status = status;
      throw error;
    }
    return payload;
  }
  window.__lkaMemoryBridgeReceive = function (id, status, text) {
    var pending = bridgePending[id];
    if (!pending) {
      if (window.__lkaMessageBridgeReceive) window.__lkaMessageBridgeReceive(id, status, text);
      return;
    }
    delete bridgePending[id]; clearTimeout(pending.timer);
    try { pending.resolve(parseResponse(status, text)); } catch (error) { pending.reject(error); }
  };
  async function api(path, method, body) {
    method = method || "GET";
    if (window.petBridge && typeof window.petBridge.requestMemory === "function") {
      return new Promise(function (resolve, reject) {
        var id = "memory-" + requestNonce + "-" + (++requestSequence);
        bridgePending[id] = { resolve: resolve, reject: reject, timer: setTimeout(function () {
          delete bridgePending[id]; reject(new Error("请求超时，请刷新状态后再操作。"));
        }, 30000) };
        try { window.petBridge.requestMemory(JSON.stringify({ id: id, method: method, path: path,
          body: body === undefined ? "" : JSON.stringify(body), token: state.token })); }
        catch (error) { clearTimeout(bridgePending[id].timer); delete bridgePending[id]; reject(error); }
      });
    }
    if (document.body.classList.contains("native-composer") && method !== "GET") {
      throw new Error("桌面通信适配尚未就绪，请更新并重新启动 Java 桌宠后再操作。");
    }
    var controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); }, 25000);
    try {
      var headers = { Accept: "application/json" };
      if (state.token) headers.Authorization = "Bearer " + state.token;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      var response = await fetch(context().backend + path, { method: method, headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      return parseResponse(response.status, await response.text());
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求超时，请刷新状态后再操作。");
      if (error instanceof TypeError) throw new Error("无法连接后端；请检查服务地址和跨域连接配置。");
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function run(button, operation) {
    if (button && button.disabled) return;
    if (button) button.disabled = true;
    try { await operation(); }
    catch (error) {
      notice(error.message || String(error), true);
      if (error.status === 401 || error.status === 403) el("memoryConnection").open = true;
    } finally { if (button && button.isConnected && button.dataset.keepDisabled !== "true") button.disabled = false; }
  }
  function tag(record) {
    var review = record.metadata && record.metadata.needs_review;
    return '<span class="memory-tag' + (review || record.status === "candidate" ? ' warning' : '') + '">' +
      esc(review ? "冲突待确认" : statusNames[record.status] || record.status) + '</span><span class="memory-tag">' +
      esc(typeNames[record.memory_type] || record.memory_type) + '</span>';
  }

  var overlay = document.createElement("div");
  overlay.id = "memoryOverlay"; overlay.className = "memory-overlay"; overlay.hidden = true;
  overlay.innerHTML = '<section class="memory-center" role="dialog" aria-modal="true" aria-labelledby="memoryTitle">' +
    '<header class="memory-header"><div><h2 id="memoryTitle">记忆与自动学习</h2><p>让长期偏好和项目决策可查看、可纠正。</p></div><button id="memoryClose" aria-label="关闭记忆中心">×</button></header>' +
    '<details class="memory-connection" id="memoryConnection"><summary>连接设置</summary><form id="memoryTokenForm"><label>记忆接口访问令牌<input id="memoryToken" type="password" autocomplete="off" placeholder="本机未设置令牌时留空"><small>只在此页面内存中使用，不写入网址或浏览器存储。</small></label><button type="submit">应用并重试</button></form></details>' +
    '<nav class="memory-navigation" role="tablist" aria-label="记忆中心"><button data-memory-tab="entries" role="tab" aria-selected="true">记忆</button>' +
    '<button data-memory-tab="jobs" role="tab" class="memory-work-only" aria-selected="false">后台任务</button><button data-memory-tab="config" role="tab" class="memory-work-only" aria-selected="false">高级设置</button>' +
    '<button data-memory-tab="files" role="tab" class="memory-work-only" aria-selected="false">导出与文件</button></nav>' +
    '<div class="memory-content" id="memoryContent" role="tabpanel"></div><p id="memoryStatus" class="memory-status" role="status" aria-live="polite"></p></section>';
  document.body.appendChild(overlay);
  var editor = document.createElement("div");
  editor.id = "memoryEditorOverlay"; editor.className = "memory-overlay"; editor.style.zIndex = "190"; editor.hidden = true;
  editor.innerHTML = '<section class="memory-editor" role="dialog" aria-modal="true" aria-labelledby="memoryEditorTitle"><header class="memory-header"><div><h2 id="memoryEditorTitle">保存为记忆</h2></div><button id="memoryEditorClose" aria-label="关闭记忆编辑">×</button></header>' +
    '<form class="memory-form" id="memoryEditorForm"><div class="memory-inline"><label>作用范围<select id="memoryEditorScope"><option value="global">所有会话</option><option value="project">当前项目</option></select></label>' +
    '<label>类型<select id="memoryEditorType"><option value="preference">偏好</option><option value="project_decision">项目决策</option><option value="user_fact">个人事实</option></select></label></div>' +
    '<p id="memoryEditorWorkspace" class="memory-note"></p><label>记忆内容<textarea id="memoryEditorText" maxlength="500" required></textarea><small id="memoryCharacterCount"></small></label>' +
    '<label class="memory-inline"><input id="memoryEditorPersonal" type="checkbox">包含个人信息</label><p class="memory-note">保存后可在后续任务中使用；记忆不改变工具权限。</p>' +
    '<p id="memoryEditorError" class="memory-note" role="alert"></p><footer><button id="memoryEditorReload" type="button" hidden>重新载入最新版本</button><button id="memoryEditorCancel" type="button">取消</button><button id="memoryEditorSave" type="submit" class="memory-primary">保存</button></footer></form></section>';
  document.body.appendChild(editor);
  var contextPanel = document.createElement("details");
  contextPanel.id = "memoryContextStatus"; contextPanel.className = "memory-context"; contextPanel.hidden = true;
  contextPanel.innerHTML = '<summary id="memoryContextSummary">会话上下文</summary><p id="memoryContextDetail"></p>';
  var strip = document.querySelector(".context-strip"); strip.parentNode.insertBefore(contextPanel, strip.nextSibling);

  function scopeToolbar(extra) {
    return '<div class="memory-toolbar"><label>作用范围<select id="memoryScope"><option value="global">全局记忆</option><option value="project"' +
      (!context().workspace ? ' disabled' : '') + '>当前项目</option></select></label>' + (extra || "") + '</div><p class="memory-note">' +
      esc(state.scope === "project" ? "当前项目：" + context().workspace : "全局偏好可以在不同工作目录和会话中使用。") + '</p>';
  }
  function bindScope() {
    el("memoryScope").value = state.scope;
    el("memoryScope").onchange = function () { state.scope = this.value; state.generation++; state.selected = null; state.preview = null; renderTab(); };
  }
  function open(scope) {
    if (scope === "project" && context().workspace) { state.scope = scope; state.tab = "entries"; }
    lastFocus = document.activeElement;
    overlay.hidden = false; notice(""); renderTab(); el("memoryClose").focus();
  }
  function close() { overlay.hidden = true; stopStream(); if (lastFocus && lastFocus.isConnected) lastFocus.focus(); }
  el("memoryClose").onclick = close;
  el("openMemoryCenterButton").onclick = open;
  el("openMemoryQuickButton").onclick = open;
  el("memoryTokenForm").onsubmit = function (event) {
    event.preventDefault(); state.token = el("memoryToken").value.trim(); el("memoryToken").value = "";
    state.generation++; renderTab(); refreshContext();
  };
  Array.prototype.forEach.call(overlay.querySelectorAll("[data-memory-tab]"), function (button) {
    button.onclick = function () { state.tab = button.dataset.memoryTab; renderTab(); };
  });
  function renderTab() {
    stopStream(); notice(""); state.generation++;
    Array.prototype.forEach.call(overlay.querySelectorAll("[data-memory-tab]"), function (button) {
      button.setAttribute("aria-selected", String(button.dataset.memoryTab === state.tab));
    });
    if (state.tab === "entries") renderEntries();
    if (state.tab === "jobs") renderJobs();
    if (state.tab === "config") renderConfig();
    if (state.tab === "files") renderFiles();
  }
  function openWorkbench() {
    var c = context();
    var url = new URL("./chat.html", window.location.href);
    url.search = "?mode=work&panel=memory&backend=" + encodeURIComponent(c.backend) +
      (c.sessionId ? "&session_id=" + encodeURIComponent(c.sessionId) : "");
    if (window.petBridge && typeof window.petBridge.openExternalUrl === "function") window.petBridge.openExternalUrl(url.href);
    else window.open(url.href, "_blank", "noopener");
  }
  function renderEntries() {
    el("memoryContent").innerHTML = '<button class="memory-quick-workbench" id="memoryWorkbench">在工作台管理后台任务与高级设置</button>' +
      scopeToolbar('<input id="memorySearch" type="search" aria-label="搜索已载入记忆" placeholder="搜索已载入记忆"><button id="memoryAdd" class="memory-primary">新增记忆</button><button id="memoryRefresh">刷新</button>') +
      '<div class="memory-learning"><label><input id="memoryLearningGlobal" type="checkbox" disabled>自动学习我的偏好</label><label><input id="memoryLearningProject" type="checkbox" disabled>自动学习当前项目</label></div>' +
      '<p class="memory-note">学习开关立即生效；关闭后仍保留并使用已有记忆。候选及冲突待确认条目暂不用于回答。</p>' +
      '<div class="memory-layout"><div><div class="memory-list" id="memoryList">正在读取记忆…</div><button id="memoryMore" hidden>加载更多</button></div><div id="memoryDetail" class="memory-detail"><p class="memory-note">选择一条记忆，查看来源或纠正内容。</p></div></div>' +
      '<details class="memory-work-only" id="memoryRelocate"><summary>项目目录搬迁</summary><p class="memory-note">仅在同一项目搬到新目录时使用。保留项目记忆身份，不移动磁盘文件；普通工作目录切换不需要搬迁。</p>' +
      '<form id="memoryRelocateForm" class="memory-toolbar"><label>新目录<input id="memoryRelocatePath" required placeholder="已搬迁项目的新目录"></label><button type="submit">迁移记忆身份</button></form></details>';
    bindScope(); el("memoryWorkbench").onclick = openWorkbench;
    el("memoryAdd").onclick = function () { remember(""); };
    el("memoryRefresh").onclick = function () { run(this, function () { return loadEntries(false); }); loadLearning(); };
    el("memoryMore").onclick = function () { run(this, function () { return loadEntries(true); }); };
    el("memorySearch").oninput = paintEntries;
    el("memoryRelocate").hidden = state.scope !== "project";
    el("memoryRelocateForm").onsubmit = function (event) {
      event.preventDefault(); var button = this.querySelector("button"), c = context(), destination = el("memoryRelocatePath").value.trim();
      run(button, async function () {
        if (!state.projectId) throw new Error("当前目录尚未建立项目记忆身份。");
        if (destination === c.workspace) throw new Error("新目录与当前目录相同。");
        await api("/memories/projects/" + encodeURIComponent(state.projectId) + "/relocate", "POST", {
          old_workspace_path: c.workspace, new_workspace_path: destination });
        await loadEntries(false); await loadLearning();
        notice("项目记忆已迁移。请在工作目录设置中切换到新目录；磁盘文件未移动。");
      });
    };
    run(null, function () { return loadEntries(false); }); loadLearning();
  }
  var entriesRequestSequence = 0;
  async function loadEntries(more) {
    var generation = state.generation, request = ++entriesRequestSequence, scope = query();
    var data = await api("/memories?" + scope + "&include_candidates=true&limit=50&offset=" + (more ? state.next || 0 : 0));
    if (generation !== state.generation || request !== entriesRequestSequence || state.tab !== "entries") return;
    state.rows = more ? state.rows.concat(data.memories || []) : data.memories || [];
    state.next = data.next_offset;
    paintEntries();
    if (state.selected) {
      var selected = state.rows.find(function (row) { return row.memory_id === state.selected.memory_id; });
      if (selected) selectMemory(selected);
      else { state.selected = null; el("memoryDetail").innerHTML = '<p class="memory-note">此条目已不在当前列表，可能已更正、撤回或失效。</p>'; }
    }
    notice(state.rows.length ? "已载入 " + state.rows.length + " 条记忆" : "暂无记忆。可以新增一条偏好或项目决策。");
  }
  function paintEntries() {
    if (!el("memoryList")) return;
    var term = el("memorySearch").value.trim().toLocaleLowerCase();
    var rows = state.rows.filter(function (row) { return row.content.toLocaleLowerCase().indexOf(term) !== -1; });
    el("memoryList").innerHTML = rows.map(function (row, index) {
      return '<button class="memory-entry" data-index="' + index + '" aria-pressed="' + Boolean(state.selected && state.selected.memory_id === row.memory_id) + '">' +
        tag(row) + '<p>' + esc(row.content) + '</p><small>' + esc(date(row.updated_at)) + '</small></button>';
    }).join("") || '<p class="memory-note">' + (term ? "已载入条目中没有匹配内容；可继续加载更多。" : "暂无记忆。") + '</p>';
    Array.prototype.forEach.call(el("memoryList").querySelectorAll("button"), function (button) {
      button.onclick = function () { selectMemory(rows[Number(button.dataset.index)]); };
    });
    el("memoryMore").hidden = state.next == null;
  }
  async function loadLearning() {
    var generation = state.generation;
    try {
      var globalPolicy = await api("/memories/learning?scope=global");
      if (generation !== state.generation || !el("memoryLearningGlobal")) return;
      bindLearning(el("memoryLearningGlobal"), globalPolicy.enabled, "global");
      if (context().workspace) {
        var projectPolicy = await api("/memories/learning?" + query("project"));
        if (generation !== state.generation) return;
        state.projectId = projectPolicy.project_id;
        bindLearning(el("memoryLearningProject"), projectPolicy.enabled, "project");
      }
    } catch (error) { if (generation === state.generation) notice(error.message, true); }
  }
  function bindLearning(input, enabled, scope) {
    if (!input) return;
    input.disabled = false; input.checked = !!enabled;
    input.onchange = function () {
      var requested = input.checked, workspace = context().workspace, generation = state.generation;
      input.disabled = true;
      api("/memories/learning", "PUT", { scope: scope, enabled: requested,
        workspace_path: scope === "project" ? workspace : null }).then(function (policy) {
        if (generation !== state.generation) return;
        if (scope === "project") state.projectId = policy.project_id;
        notice((scope === "global" ? "全局" : "项目") + "自动学习已" + (requested ? "开启" : "关闭") + "，立即生效。已有记忆保留。");
      }).catch(function (error) { input.checked = !requested; if (generation === state.generation) notice(error.message, true); }).finally(function () { input.disabled = false; });
    };
  }
  function selectMemory(record) {
    state.selected = record; paintEntries();
    var generation = state.generation, workspace = context().workspace, q = recordQuery(record, workspace), metadata = record.metadata || {};
    el("memoryDetail").innerHTML = '<h3>记忆详情</h3>' + tag(record) + '<blockquote>' + esc(record.content) + '</blockquote><dl>' +
      '<dt>作用范围</dt><dd>' + esc(record.scope === "global" ? "所有会话" : workspace) + '</dd><dt>有效期</dt><dd>' + esc(record.expires_at ? date(record.expires_at) : "未设置") + '</dd>' +
      '<dt>版本</dt><dd>' + esc(record.version) + '</dd><dt>敏感程度</dt><dd>' + (record.sensitivity === "personal" ? "个人信息" : "普通") + '</dd></dl>' +
      (metadata.needs_review ? '<p class="memory-restart">与其他记忆存在冲突，暂不参与回答。请查看冲突条目，并明确保留或纠正哪条要求。</p><div id="memoryConflicts"></div>' : "") +
      '<div class="memory-actions"><button id="memoryEdit">' + (record.status === "candidate" || metadata.needs_review ? "确认或纠正" : "纠正") + '</button><button id="memoryRetract" class="memory-danger">停止使用</button></div>' +
      '<div id="memoryRetractConfirm" hidden><p class="memory-note">停止使用后保留原始来源与审计。当前接口不支持直接恢复；以后需要重新确认并保存。</p><button id="memoryRetractYes" class="memory-danger">确认停止使用</button><button id="memoryRetractNo">取消</button></div>' +
      '<h3 style="margin-top:20px">来源</h3><div id="memorySources">正在读取来源…</div><p class="memory-note">来源接口提供标识与时间，不提供原始私密正文。</p>';
    el("memoryEdit").onclick = function () { remember(record.content, record); };
    el("memoryRetract").onclick = function () { el("memoryRetractConfirm").hidden = false; el("memoryRetractYes").focus(); };
    el("memoryRetractNo").onclick = function () { el("memoryRetractConfirm").hidden = true; };
    el("memoryRetractYes").onclick = function () { run(this, async function () {
      await api("/memories/" + encodeURIComponent(record.memory_id) + q + (q ? "&" : "?") + "expected_version=" + record.version, "DELETE");
      await loadEntries(false); notice("记忆已停止使用，原始来源与审计记录保留。");
    }); };
    api("/memories/" + encodeURIComponent(record.memory_id) + "/sources" + q).then(function (data) {
      if (generation !== state.generation || !state.selected || state.selected.memory_id !== record.memory_id) return;
      el("memorySources").innerHTML = (data.sources || []).map(function (source) {
        return '<div class="memory-source">' + esc({ user_api: "用户确认", user_message: "用户消息" }[source.source_type] || source.source_type) +
          ' · ' + esc(statusNames[source.status] || source.status) + '<br><small>' + esc(source.source_ref) + '<br>' + esc(date(source.created_at)) + '</small></div>';
      }).join("") || "暂无来源";
    }).catch(function (error) { if (generation === state.generation && el("memorySources")) el("memorySources").textContent = error.message; });
    (metadata.conflict_ids || []).forEach(function (id) {
      api("/memories/" + encodeURIComponent(id) + q).then(function (peer) {
        if (generation !== state.generation || !state.selected || state.selected.memory_id !== record.memory_id || !el("memoryConflicts")) return;
        var button = document.createElement("button"); button.textContent = "冲突条目：" + peer.content;
        button.onclick = function () { selectMemory(peer); }; el("memoryConflicts").appendChild(button);
      }).catch(function () {});
    });
  }

  var editorRecord = null, editorWorkspace = "", editorSaving = false, editorGeneration = 0;
  function remember(text, record) {
    if (editorSaving) return;
    editorGeneration++; editorFocus = document.activeElement; editorRecord = record || null; editorWorkspace = context().workspace;
    editor.hidden = false; overlay.setAttribute("aria-hidden", "true");
    el("memoryEditorTitle").textContent = record ? (record.status === "candidate" || record.metadata && record.metadata.needs_review ? "确认或纠正记忆" : "纠正记忆") : "保存为记忆";
    el("memoryEditorScope").value = record ? record.scope : state.scope;
    if (!editorWorkspace && el("memoryEditorScope").value === "project") el("memoryEditorScope").value = "global";
    el("memoryEditorScope").querySelector('[value="project"]').disabled = !editorWorkspace;
    el("memoryEditorScope").disabled = !!record; el("memoryEditorType").disabled = !!record;
    el("memoryEditorType").value = record ? record.memory_type : "preference";
    el("memoryEditorText").value = String(text || "");
    el("memoryEditorPersonal").checked = !!record && record.sensitivity === "personal";
    el("memoryEditorPersonal").disabled = !!record;
    el("memoryEditorError").textContent = ""; el("memoryEditorReload").hidden = true;
    paintEditor(); el("memoryEditorText").focus();
  }
  function paintEditor() {
    var count = Array.from(el("memoryEditorText").value).length;
    el("memoryCharacterCount").textContent = count + " / 500 字" + (count > 500 ? "，请先选取需要长期保留的部分" : "");
    el("memoryEditorSave").disabled = count > 500 || !el("memoryEditorText").value.trim();
    el("memoryEditorWorkspace").textContent = el("memoryEditorScope").value === "project" ? "仅用于项目：" + editorWorkspace : "可用于所有会话";
  }
  function closeEditor() { if (editorSaving) return; editorGeneration++; editor.hidden = true; overlay.removeAttribute("aria-hidden"); if (editorFocus && editorFocus.isConnected) editorFocus.focus(); }
  el("memoryEditorClose").onclick = closeEditor; el("memoryEditorCancel").onclick = closeEditor;
  el("memoryEditorText").oninput = paintEditor; el("memoryEditorScope").onchange = paintEditor;
  el("memoryEditorForm").onsubmit = async function (event) {
    event.preventDefault(); var button = el("memoryEditorSave"), text = el("memoryEditorText").value.trim(), scope = el("memoryEditorScope").value;
    if (button.disabled || !text || Array.from(text).length > 500) return;
    editorSaving = true; button.disabled = true; el("memoryEditorError").textContent = "";
    var formControls = Array.prototype.map.call(editor.querySelectorAll("input,select,textarea,button"), function (input) {
      var previous = input.disabled; input.disabled = true; return { input: input, disabled: previous };
    });
    try {
      if (scope === "project" && context().workspace !== editorWorkspace) throw new Error("当前项目已切换。编辑内容保留，请关闭后在目标项目重新保存。");
      var data = editorRecord ? await api("/memories/" + encodeURIComponent(editorRecord.memory_id) + recordQuery(editorRecord, editorWorkspace), "PATCH", {
        content: text, expected_version: editorRecord.version }) : await api("/memories", "POST", {
        content: text, memory_type: el("memoryEditorType").value, scope: scope,
        workspace_path: scope === "project" ? editorWorkspace : null, sensitivity: el("memoryEditorPersonal").checked ? "personal" : "normal" });
      editorSaving = false; closeEditor();
      if (isOpen() && state.tab === "entries") {
        loadEntries(false).then(loadLearning).catch(function (error) { notice("记忆已保存，但列表刷新失败：" + error.message, true); });
      }
      notice("记忆已保存并确认。" + (data.memory_file_status === "conflict_or_unavailable" ? "MEMORY.md 未同步，请在导出与文件中检查。" : ""));
      if (!isOpen()) { el("memoryContextStatus").hidden = false; el("memoryContextSummary").textContent = "记忆已保存，可在记忆中心纠正或停止使用"; }
    } catch (error) {
      el("memoryEditorError").textContent = error.message;
      if (error.status === 409 && editorRecord) el("memoryEditorReload").hidden = false;
      if (error.status === 401 || error.status === 403) {
        el("memoryEditorError").textContent += " 关闭编辑后，在记忆中心的连接设置中填写访问令牌。";
      }
    } finally { editorSaving = false; formControls.forEach(function (item) { item.input.disabled = item.disabled; }); paintEditor(); }
  };
  el("memoryEditorReload").onclick = async function () {
    this.disabled = true; var generation = editorGeneration, record = editorRecord, workspace = editorWorkspace;
    try {
      var fresh = await api("/memories/" + encodeURIComponent(record.memory_id) + recordQuery(record, workspace));
      if (generation !== editorGeneration) return;
      el("memoryEditorError").textContent = "最新内容：" + fresh.content + "。当前草稿保留；请确认差异后再保存。";
      if (fresh.status === "retracted" || fresh.status === "superseded") throw new Error("原条目已撤回或被替代，请重新打开对应的有效条目。当前草稿保留。");
      editorRecord = fresh; this.hidden = true;
    } catch (error) { if (generation === editorGeneration) el("memoryEditorError").textContent = error.message; }
    finally { this.disabled = false; }
  };

  function stopStream() { if (streamController) streamController.abort(); streamController = null; }
  async function startStream() {
    if (window.petBridge || !window.TextDecoder) return;
    var controller = new AbortController(); streamController = controller;
    try {
      var headers = { Accept: "text/event-stream" }; if (state.token) headers.Authorization = "Bearer " + state.token;
      var response = await fetch(context().backend + "/background/events?interval=5", { headers: headers, signal: controller.signal });
      if (!response.ok) return;
      var reader = response.body.getReader(), decoder = new TextDecoder(), buffer = "";
      while (!controller.signal.aborted) {
        var part = await reader.read(); if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, "\n");
        var boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          var frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (frame.indexOf("event: background_health") !== -1 && isOpen() && state.tab === "jobs") loadJobs().catch(function (error) { notice(error.message, true); });
        }
        if (buffer.length > 200000) buffer = "";
      }
    } catch (ignored) { /* The visible-page poll reconnects using regular JSON requests. */ }
    finally { if (streamController === controller) streamController = null; }
  }
  function renderJobs() {
    el("memoryContent").innerHTML = '<div class="memory-toolbar"><label>任务范围<select id="memoryJobScope"><option value="all">所有后台任务</option><option value="session">当前会话</option></select></label>' +
      '<label>状态<select id="memoryJobStatus"><option value="">全部状态</option>' + ["queued", "running", "retry_wait", "failed", "cancelled", "succeeded"].map(function (s) { return '<option value="' + s + '">' + statusNames[s] + '</option>'; }).join("") +
      '</select></label><button id="memoryJobRefresh">刷新</button></div><div id="memoryHealth"></div><p class="memory-note">后台整理与当前对话独立。取消不能撤销已完成的结果，也不保证中止已发出的模型调用。</p><div id="memoryJobs">正在读取任务…</div>';
    el("memoryJobStatus").onchange = function () { run(null, loadJobs); }; el("memoryJobScope").onchange = function () { run(null, loadJobs); };
    el("memoryJobRefresh").onclick = function () { run(this, loadJobs); };
    run(null, loadJobs); startStream();
  }
  var jobsLoadingKey = "", jobsRequestSequence = 0;
  async function loadJobs(force) {
    if (state.tab !== "jobs" || !el("memoryJobStatus")) return;
    var generation = state.generation;
    var loadingKey = generation + "|" + el("memoryJobStatus").value + "|" + el("memoryJobScope").value + "|" + context().sessionId;
    if (!force && jobsLoadingKey === loadingKey) return;
    jobsLoadingKey = loadingKey;
    var request = ++jobsRequestSequence;
    try {
      var suffix = "?limit=100" + (el("memoryJobStatus").value ? "&status=" + el("memoryJobStatus").value : "") +
        (el("memoryJobScope").value === "session" ? "&scope_id=" + encodeURIComponent(context().sessionId) : "");
      var results = await Promise.all([api("/background/jobs" + suffix), api("/background/health")]);
      if (generation !== state.generation || request !== jobsRequestSequence) return;
      state.jobs = results[0].jobs || [];
      var health = results[1], counts = health.queue_depth_by_status || {}, workload = health.llm_workloads || {};
      var usage = (workload.last_24h || []).reduce(function (total, row) { total.tokens += (row.input_tokens || 0) + (row.output_tokens || 0); total.cost += row.estimated_cost || 0; return total; }, { tokens: 0, cost: 0 });
      el("memoryHealth").innerHTML = '<div class="memory-stats"><span>排队<b>' + esc((counts.queued || 0) + (counts.retry_wait || 0)) + '</b></span><span>处理中<b>' + esc(counts.running || 0) + '</b></span>' +
        '<span>失败<b>' + esc(counts.failed || 0) + '</b></span><span>近 24 小时调用用量<b>' + esc(usage.tokens.toLocaleString()) + ' tokens</b></span></div>' +
        '<p class="memory-note">' + (workload.cost_pricing_configured ? "近 24 小时估算费用：" + esc(usage.cost.toFixed(4)) + "（按后台配置单价计算，非账单）" : "未配置计费单价，无法估算费用。") + '</p>' +
        (results[0].last_memory_file_error ? '<p class="memory-restart">记忆文件同步异常，请在导出与文件中检查。</p>' : "");
      el("memoryJobs").innerHTML = state.jobs.map(function (job, index) {
        var retryable = ["memory_extract", "context_compact"].indexOf(job.kind) !== -1 && ["failed", "cancelled"].indexOf(job.status) !== -1;
        var cancellable = ["queued", "running", "retry_wait"].indexOf(job.status) !== -1;
        return '<article class="memory-job"><strong>' + esc({ memory_extract: "学习记忆", context_compact: "整理上下文", instruction_index: "整理指导文件" }[job.kind] || job.kind) + '</strong> ' +
          '<span class="memory-tag' + (job.status === "failed" ? ' warning' : '') + '">' + esc(statusNames[job.status] || job.status) + '</span><p>' + esc(job.job_id) + '</p><p>更新于 ' + esc(date(job.updated_at)) + ' · 尝试 ' + esc(job.attempts || 0) + ' 次</p>' +
          (job.error_class ? '<p>失败原因：' + esc(job.error_class) + '</p>' : "") +
          '<div class="memory-actions">' + (retryable ? '<button data-job-index="' + index + '" data-job-action="retry">重试</button>' : "") +
          (cancellable ? '<button data-job-index="' + index + '" data-job-action="cancel">取消任务</button>' : "") + '</div></article>';
      }).join("") || '<p class="memory-note">此范围没有后台任务。</p>';
      Array.prototype.forEach.call(el("memoryJobs").querySelectorAll("[data-job-action]"), function (button) {
        button.onclick = function () { run(button, async function () {
          var job = state.jobs[Number(button.dataset.jobIndex)];
          try { await api("/background/jobs/" + encodeURIComponent(job.job_id) + "/" + button.dataset.jobAction, "POST", { expected_updated_at: job.updated_at }); }
          catch (error) { await loadJobs(true); throw error; }
          await loadJobs(true); notice(button.dataset.jobAction === "retry" ? "任务已重新排队。" : "已请求取消任务；已完成的结果保留。");
        }); };
      });
    } finally { if (request === jobsRequestSequence) jobsLoadingKey = ""; }
  }

  var configLabels = { enabled: "启用记忆及记忆召回", background_enabled: "后台自动整理", allow_remote_extraction: "使用模型辅助学习（会产生额外调用）",
    background_worker_count: "后台工作线程数", max_recalled_items: "每次最多引用记忆条数", max_recalled_chars: "记忆引用字符预算", extraction_debounce_seconds: "学习合并等待（秒）",
    max_job_tokens: "每个整理任务 token 上限", generation_output_tokens: "整理输出 token 上限", recovery_output_tokens: "恢复调用输出 token 上限",
    request_timeout_seconds: "模型请求超时（秒）", max_pending_jobs: "排队任务上限", max_llm_concurrency: "模型调用并发上限", interactive_reserved: "为对话保留的并发数",
    memory_concurrency: "记忆整理并发数", io_concurrency: "其他后台调用并发数", hourly_token_limit: "后台每小时 token 上限（0 不限制）", daily_token_limit: "后台每日 token 上限（0 不限制）",
    daily_cost_limit: "后台每日估算费用上限（0 不限制）", input_cost_per_million: "每百万输入 token 单价", output_cost_per_million: "每百万输出 token 单价" };
  async function renderConfig() {
    var generation = state.generation;
    el("memoryContent").innerHTML = '<p class="memory-note">正在读取设置与字段约束…</p>';
    try {
      var data = await Promise.all([api("/background/config"), api("/background/config/schema"), api("/agent/models")]);
      if (generation !== state.generation) return;
      state.config = data[0]; state.schema = data[1]; state.models = data[2];
      var html = '<p class="memory-note">自动学习开关立即生效；以下系统设置保存后需要重启后端。保存不会中断当前对话。页面不提供后端自重启。</p>' +
        (state.config.restart_required ? '<p class="memory-restart">已保存，待重启生效：' + esc(state.config.pending_restart_fields.map(function (field) {
          var key = field.split(".").pop(); return { background_client_name: "后台服务商", background_model: "后台模型" }[key] || configLabels[key] || field;
        }).join("、")) + '</p>' : '<p class="memory-note">已保存设置与当前运行配置一致。</p>') +
        (state.config.config_load_error ? '<p class="memory-restart">已保存配置加载异常，请检查并重新保存或恢复配置文件默认值。</p>' : "") + '<form id="memoryConfigForm">';
      ["memory", "background"].forEach(function (section) {
        html += '<fieldset class="memory-config-group"><legend>' + (section === "memory" ? "记忆" : "后台资源") + '</legend><div class="memory-config-fields">';
        var properties = state.schema[section].properties;
        Object.keys(properties).forEach(function (key) {
          if (key === "background_client_name" || key === "background_model") return;
          var spec = properties[key], value = state.config.desired[section][key], current = state.config.active[section][key], name = section + "." + key;
          html += '<label>' + esc(configLabels[key] || key);
          if (spec.type === "boolean") html += '<span><input type="checkbox" data-config="' + name + '"' + (value ? ' checked' : '') + '>启用</span>';
          else html += '<input type="number" data-config="' + name + '" value="' + esc(value) + '" step="' + (spec.type === "integer" ? '1' : 'any') + '"' +
            (spec.minimum !== undefined ? ' min="' + esc(spec.minimum) + '"' : '') + (spec.maximum !== undefined ? ' max="' + esc(spec.maximum) + '"' : '') + ' required>';
          html += '<small>当前生效：' + esc(typeof current === "boolean" ? current ? "开启" : "关闭" : current) + '</small></label>';
        });
        html += '</div></fieldset>';
      });
      html += '<div class="memory-config-fields"><label>后台服务商<select id="memoryBackgroundClient"><option value="">跟随后端默认服务商</option>' + (state.models.clients || []).map(function (client) { return '<option value="' + esc(client.name) + '">' + esc(client.name) + '</option>'; }).join("") +
        '</select></label><label>后台模型<select id="memoryBackgroundModel"></select></label></div><p class="memory-note">仅显示可确认已配置的模型。服务商动态目录未区分其他模型是否在本地配置，后台设置不能直接使用未配置模型。</p>' +
        '<div class="memory-actions"><button type="submit" class="memory-primary">保存，重启后生效</button><button type="button" id="memoryConfigReload">重新载入设置</button><button type="button" id="memoryConfigReset">恢复配置文件默认值</button></div><div id="memoryConfigResetConfirm" hidden><p class="memory-note">将清除前端保存的覆盖项。记忆、任务及历史不会删除；重启后跟随配置文件。</p><button type="button" id="memoryConfigResetYes">确认恢复</button></div></form>';
      el("memoryContent").innerHTML = html;
      el("memoryBackgroundClient").value = state.config.desired.memory.background_client_name || "";
      paintBackgroundModels(state.config.desired.memory.background_model || "");
      el("memoryBackgroundClient").onchange = function () { paintBackgroundModels(""); };
      el("memoryConfigReload").onclick = function () { renderConfig(); };
      el("memoryConfigReset").onclick = function () { el("memoryConfigResetConfirm").hidden = !el("memoryConfigResetConfirm").hidden; };
      el("memoryConfigResetYes").onclick = function () { run(this, async function () {
        await api("/background/config?expected_revision=" + state.config.revision, "DELETE"); await renderConfig(); notice("已清除前端覆盖项；重启后生效。");
      }); };
      el("memoryConfigForm").onsubmit = function (event) {
        event.preventDefault(); var button = this.querySelector('[type="submit"]');
        run(button, async function () {
          var patch = { expected_revision: state.config.revision, memory: {}, background: {} };
          Array.prototype.forEach.call(el("memoryConfigForm").querySelectorAll("[data-config]"), function (input) {
            var parts = input.dataset.config.split("."), value = input.type === "checkbox" ? input.checked : Number(input.value);
            if (value !== state.config.desired[parts[0]][parts[1]]) patch[parts[0]][parts[1]] = value;
          });
          var client = el("memoryBackgroundClient").value || null, model = el("memoryBackgroundModel").value || null;
          if (client !== state.config.desired.memory.background_client_name) patch.memory.background_client_name = client;
          if (model !== state.config.desired.memory.background_model) patch.memory.background_model = model;
          await api("/background/config", "PATCH", patch); await renderConfig(); notice("设置已保存，当前运行配置保持原值；待重启后生效。");
        });
      };
    } catch (error) { if (generation === state.generation) notice(error.message, true); }
  }
  function paintBackgroundModels(selected) {
    var name = el("memoryBackgroundClient").value || state.models.default_client;
    var client = (state.models.clients || []).find(function (item) { return item.name === name; });
    var models = client ? (client.source === "configured" ? client.models.slice() : [client.default_model]) : [];
    [state.config.active.memory, state.config.desired.memory].forEach(function (config) {
      if ((config.background_client_name || state.models.default_client) === name && config.background_model) models.push(config.background_model);
    });
    models = models.filter(function (model, index) { return model && models.indexOf(model) === index; });
    el("memoryBackgroundModel").innerHTML = '<option value="">跟随该服务商默认模型</option>' + models.map(function (model) { return '<option value="' + esc(model) + '">' + esc(model) + '</option>'; }).join("");
    el("memoryBackgroundModel").value = selected;
  }

  function download(name, data, type) {
    var blob = new Blob([data], { type: type || "application/json;charset=utf-8" }), url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function renderFiles() {
    state.preview = null;
    el("memoryContent").innerHTML = scopeToolbar('<button id="memoryExport">导出 JSON</button><button id="memoryFileRead">读取 MEMORY.md</button><button id="memoryFileGenerate">同步生成文件</button><button id="memoryFilePreview">预览文件修改</button>') +
      '<p class="memory-note">JSON 导出包含全部分页的当前条目和候选，不是历史数据库备份；导出期间请避免编辑。MEMORY.md 是可查看的记忆侧写，不是权限或指导文件。</p>' +
      '<p id="memoryFilePath" class="memory-note"></p><pre id="memoryFileContent">读取后在这里查看。可在本地编辑器修改文件，再预览并导入；每次只能修改一个已有条目的内容。</pre><div id="memoryFileDiff"></div><button id="memoryFileImport" disabled>确认导入这一条修改</button>';
    bindScope();
    el("memoryExport").onclick = function () { run(this, async function () {
      var generation = state.generation, scope = state.scope, q = query(), rows = [], offset = 0;
      do {
        var page = await api("/memories/export?" + q + "&include_candidates=true&limit=500&offset=" + offset);
        if (generation !== state.generation) throw new Error("作用范围已变化，导出已取消。");
        rows = rows.concat(page.memories || []);
        var next = page.next_offset;
        if (next != null && next <= offset) throw new Error("导出分页未推进，请重新尝试。");
        offset = next;
      } while (offset != null);
      download("memories-" + scope + "-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify({ version: 1, scope: scope, exported_at: new Date().toISOString(), memories: rows }, null, 2));
      notice("已导出 " + rows.length + " 条记忆；并发编辑时请重新导出。");
    }); };
    el("memoryFileRead").onclick = function () { run(this, async function () {
      var generation = state.generation, data = await api("/memories/file?" + query());
      if (generation !== state.generation) return;
      el("memoryFilePath").textContent = data.path; el("memoryFileContent").textContent = data.content;
      notice("文件已读取，尚未导入任何修改。");
    }); };
    el("memoryFileGenerate").onclick = function () { run(this, async function () {
      var generation = state.generation; await api("/memories/file/generate?" + query(), "POST");
      if (generation !== state.generation) return;
      state.preview = null; el("memoryFileImport").disabled = true; notice("文件已同步生成。手动修改存在时，后端会保留原文件并报告冲突。");
    }); };
    el("memoryFilePreview").onclick = function () { run(this, async function () {
      var generation = state.generation, data = await api("/memories/file/preview?" + query());
      if (generation !== state.generation) return;
      state.preview = data;
      el("memoryFileDiff").innerHTML = (data.edits || []).map(function (edit) {
        return '<div class="memory-diff"><strong>条目 ' + esc(edit.memory_id) + '</strong><p>' + esc(edit.content || edit.new_content || JSON.stringify(edit)) + '</p></div>';
      }).join("") || '<p class="memory-note">没有可导入的内容修改。</p>';
      el("memoryFilePath").textContent = data.path;
      el("memoryFileImport").disabled = data.edits.length !== 1;
      el("memoryFileImport").dataset.keepDisabled = String(data.edits.length !== 1);
      notice(data.edits.length > 1 ? "有多条修改。当前后端每次只接受一条，请先在文件中保留一条修改再预览。" : "差异已预览，尚未导入。");
    }); };
    el("memoryFileImport").onclick = function () { run(this, async function () {
      var preview = state.preview, q = query(), generation = state.generation;
      if (!preview || preview.edits.length !== 1) throw new Error("请先预览一条修改。");
      var fresh = await api("/memories/file/preview?" + q);
      if (generation !== state.generation || fresh.current_hash !== preview.current_hash || JSON.stringify(fresh.edits) !== JSON.stringify(preview.edits)) throw new Error("文件已变化，请重新预览后再导入。");
      var result = await api("/memories/file/import?" + q, "POST");
      state.preview = null; el("memoryFileImport").disabled = true; el("memoryFileImport").dataset.keepDisabled = "true"; el("memoryFileDiff").textContent = "";
      notice("已导入 " + (result.changed || []).length + " 条修改。" + (result.memory_file_status === "conflict_or_unavailable" ? "文件同步仍需检查。" : ""));
    }); };
  }

  var contextLoading = false;
  async function refreshContext() {
    if (document.hidden || contextLoading) return;
    var c = context(); if (!c.sessionId) return;
    contextLoading = true;
    try {
      var data = await api("/sessions/" + encodeURIComponent(c.sessionId) + "/context-status");
      if (context().sessionId !== c.sessionId) return;
      var jobs = data.active_compaction_jobs || {}, pending = (jobs.queued || 0) + (jobs.retry_wait || 0) + (jobs.running || 0);
      var count = data.token_estimate || 0, budget = data.token_budget || 0;
      contextPanel.hidden = false;
      el("memoryContextSummary").textContent = pending ? "正在后台整理上下文，可继续输入" : data.degraded ? "上下文已整理，使用了备用整理方式" : "会话上下文：" + count.toLocaleString() + " / " + budget.toLocaleString() + " tokens";
      el("memoryContextDetail").textContent = "计数方式：" + (data.token_count_method || "估算") + "。当前窗口约 " + count + " tokens，预算 " + budget +
        "；最近未整理消息 " + data.recent_message_count + " 条。" + (data.degraded ? "备用整理可能有信息损失，请对关键要求再次确认。" : "") +
        "原始会话历史保留；这是上下文整理状态，不代表整次请求的 token 用量或任务完成进度。";
    } catch (error) {
      if (context().sessionId !== c.sessionId) return;
      contextPanel.hidden = error.status === 404;
      if (!contextPanel.hidden) { el("memoryContextSummary").textContent = "上下文状态暂不可用"; el("memoryContextDetail").textContent = error.message; }
    } finally { contextLoading = false; }
  }
  window.addEventListener("lka-session-context", function () {
    var c = context(), key = c.sessionId + "|" + c.workspace;
    if (key === state.contextKey) return;
    state.contextKey = key; state.generation++; state.selected = null; state.projectId = null; state.preview = null;
    contextPanel.hidden = true; if (!c.workspace) state.scope = "global";
    if (isOpen()) renderTab(); refreshContext();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopStream(); else { refreshContext(); if (isOpen() && state.tab === "jobs") { run(null, loadJobs); startStream(); } }
  });
  document.addEventListener("keydown", function (event) {
    if (window.LkaProjects && window.LkaProjects.isOpen()) return;
    if (editor.hidden && overlay.hidden) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); if (!editor.hidden) closeEditor(); else close(); return; }
    if (event.key !== "Tab") return;
    var top = editor.hidden ? overlay : editor;
    var buttons = Array.prototype.filter.call(top.querySelectorAll('button,input,select,textarea,summary,[tabindex="0"]'), function (node) { return !node.disabled && node.getClientRects().length; });
    if (!buttons.length) return;
    var first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && (document.activeElement === first || !top.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !top.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }, true);
  setInterval(function () {
    if (document.hidden) return;
    refreshContext();
    if (isOpen() && editor.hidden) {
      if (state.tab === "jobs") { run(null, loadJobs); if (!streamController) startStream(); }
    }
  }, 15000);
  window.LkaMemory = { remember: remember, open: open, request: api,
    setToken: function (value) { state.token = String(value || "").trim(); state.generation++; },
    hasToken: function () { return !!state.token; } };
  refreshContext();
  if (new URLSearchParams(window.location.search).get("panel") === "memory") open();
})();
