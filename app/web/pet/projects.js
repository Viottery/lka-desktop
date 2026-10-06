(function () {
  "use strict";
  if (!window.LkaChatContext || !window.LkaMemory) return;
  var chat = window.LkaChatContext, transport = window.LkaMemory;
  var state = { rows: [], next: null, selected: null, sessions: [], offset: 0, more: false,
    listRequest: 0, detailRequest: 0, sessionRequest: 0, creating: false, registering: false, opening: false };
  var lastFocus = null, searchTimer = null, sessionTimer = null, noticeVersion = 0;
  function el(id) { return document.getElementById(id); }
  function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  }); }
  function api(path, method, body) { return transport.request(path, method, body); }
  function isOpen() { return !el("projectsOverlay").hidden; }
  function status(text, error) {
    noticeVersion++;
    el("projectStatus").textContent = text || ""; el("projectStatus").classList.toggle("error", !!error);
  }
  function explain(error) {
    if (error.status === 404) return "项目或会话不存在，或后端尚未加载项目管理接口。请刷新列表并检查后端版本。";
    if (error.status === 401 || error.status === 403) el("projectConnection").open = true;
    return error.message || String(error);
  }
  var overlay = document.createElement("div");
  overlay.id = "projectsOverlay"; overlay.className = "memory-overlay project-overlay"; overlay.hidden = true;
  overlay.innerHTML = '<section class="memory-center project-center" role="dialog" aria-modal="true" aria-labelledby="projectsTitle">' +
    '<header class="memory-header"><div><h2 id="projectsTitle">项目与会话</h2><p>按目录整理工作，在同一项目中继续新的任务。</p></div><button id="projectsClose" aria-label="关闭项目管理">×</button></header>' +
    '<details class="memory-connection" id="projectConnection"><summary>连接设置</summary><form id="projectTokenForm"><label>项目与记忆接口访问令牌<input id="projectToken" type="password" autocomplete="off" placeholder="未设置令牌时留空"><small id="projectTokenNote">仅在当前页面内存使用，与记忆中心共用。</small></label><button type="submit">应用并重试</button></form></details>' +
    '<div class="memory-content"><div class="memory-toolbar"><input id="projectSearch" type="search" maxlength="500" aria-label="搜索项目" placeholder="搜索项目名称"><button id="projectRefresh">刷新</button><button id="projectRegisterToggle" class="memory-primary">登记目录</button></div>' +
    '<form id="projectRegisterForm" class="project-register" hidden><div class="memory-config-fields"><label>项目名称（可选）<input id="projectRegisterName" maxlength="120" placeholder="默认使用目录名称"></label><label>目录路径<input id="projectRegisterPath" required maxlength="4000" placeholder="选择一个已有工作目录"></label><label>目录所在系统<select id="projectRegisterPlatform"><option value="">自动识别</option><option value="windows">Windows 路径</option><option value="linux">Linux / WSL 路径</option><option value="macos">macOS 路径</option></select></label></div><p class="memory-note">目录必须已存在且允许访问。登记不会创建文件夹；同目录重复登记会打开原项目。</p><button type="submit" class="memory-primary">登记项目</button><button type="button" id="projectUseCurrent">使用当前会话目录</button></form>' +
    '<div class="memory-layout project-layout"><div><div id="projectList" class="memory-list">正在读取项目…</div><button id="projectMore" hidden>加载更多项目</button></div><div id="projectDetail" class="memory-detail"><p class="memory-note">选择项目，查看会话或开始新的任务。</p></div></div></div>' +
    '<p id="projectStatus" class="memory-status" role="status" aria-live="polite"></p></section>';
  document.body.appendChild(overlay);
  var content = overlay.querySelector(".memory-content"), toolbar = content.querySelector(".memory-toolbar");
  toolbar.classList.add("project-main-toolbar"); content.parentNode.insertBefore(toolbar, content);

  function open() {
    lastFocus = document.activeElement; overlay.hidden = false;
    el("projectTokenNote").textContent = transport.hasToken() ? "当前页面已设置令牌，与记忆中心共用。" : "仅在当前页面内存使用，与记忆中心共用。";
    status(""); loadProjects(false); el("projectsClose").focus();
  }
  function close() {
    overlay.hidden = true; state.listRequest++; state.detailRequest++; state.sessionRequest++;
    state.opening = false;
    clearTimeout(searchTimer); clearTimeout(sessionTimer);
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
  }
  el("openProjectsButton").onclick = open;
  el("openProjectCenterButton").onclick = open;
  el("projectsClose").onclick = close;
  el("projectTokenForm").onsubmit = function (event) {
    event.preventDefault(); transport.setToken(el("projectToken").value); el("projectToken").value = "";
    el("projectConnection").open = false;
    el("projectTokenNote").textContent = transport.hasToken() ? "当前页面已设置令牌，与记忆中心共用。" : "当前页面未设置令牌。";
    loadProjects(false);
    if (state.selected) selectProject(state.selected.project_id);
  };
  el("projectRegisterToggle").onclick = function () {
    el("projectRegisterForm").hidden = !el("projectRegisterForm").hidden;
    if (!el("projectRegisterForm").hidden) el("projectRegisterPath").focus();
  };
  el("projectUseCurrent").onclick = function () { el("projectRegisterPath").value = chat.get().workspace || ""; };
  function platformFor(path, selected) { return selected || (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? "windows" : path.charAt(0) === "/" ? "linux" : ""); }
  async function register(path, name, platform) {
    var body = { path: path }, system = platformFor(path, platform);
    if (name) body.name = name;
    if (system) body.platform = system;
    return api("/projects", "POST", body);
  }
  el("projectRegisterForm").onsubmit = async function (event) {
    event.preventDefault(); if (state.registering) return;
    var button = this.querySelector('[type="submit"]'), path = el("projectRegisterPath").value.trim(), name = el("projectRegisterName").value.trim();
    if (!path) return;
    state.registering = true; button.disabled = true;
    try {
      var project = await register(path, name, el("projectRegisterPlatform").value);
      el("projectRegisterForm").hidden = true; el("projectSearch").value = "";
      await loadProjects(false);
      if (isOpen()) await selectProject(project.project_id);
      status("已登记项目。同目录已有项目时保留原名称；可在详情中重命名。");
    } catch (error) { status(explain(error), true); }
    finally { state.registering = false; button.disabled = false; }
  };
  el("projectSearch").oninput = function () {
    state.listRequest++; clearTimeout(searchTimer); searchTimer = setTimeout(function () { loadProjects(false); }, 220);
  };
  el("projectRefresh").onclick = function () {
    loadProjects(false); if (state.selected) selectProject(state.selected.project_id);
  };
  el("projectMore").onclick = function () { loadProjects(true); };
  async function loadProjects(more) {
    var request = ++state.listRequest, noticeAtStart = noticeVersion, offset = more ? state.next : 0, q = el("projectSearch").value.trim();
    if (more && offset == null) return;
    el("projectMore").disabled = true;
    try {
      var data = await api("/projects?limit=50&offset=" + offset + (q ? "&q=" + encodeURIComponent(q) : ""));
      if (request !== state.listRequest || !isOpen()) return;
      state.rows = more ? state.rows.concat(data.projects || []) : data.projects || []; state.next = data.next_offset;
      paintProjects(); if (noticeAtStart === noticeVersion) status(state.rows.length ? "已载入 " + state.rows.length + " 个项目" : "暂无匹配项目。可以登记一个已有目录。");
    } catch (error) { if (request === state.listRequest && isOpen()) { el("projectList").textContent = "项目列表暂不可用"; status(explain(error), true); } }
    finally { if (request === state.listRequest) el("projectMore").disabled = false; }
  }
  function paintProjects() {
    el("projectList").innerHTML = state.rows.map(function (p) {
      return '<button class="memory-entry project-entry" data-project-id="' + esc(p.project_id) + '" aria-pressed="' + Boolean(state.selected && state.selected.project_id === p.project_id) + '"><strong>' + esc(p.name) + '</strong><p>' + esc(p.workspace_path || "目录未绑定") + '</p><small>' + esc(p.session_count) + ' 个会话' + (chat.get().projectId === p.project_id ? ' · 当前项目' : '') + '</small></button>';
    }).join("") || '<p class="memory-note">暂无匹配项目。登记现有目录后可在其中建立多个会话。</p>';
    Array.prototype.forEach.call(el("projectList").querySelectorAll("[data-project-id]"), function (button) {
      button.onclick = function () { selectProject(button.dataset.projectId); };
    });
    el("projectMore").hidden = state.next == null;
  }
  async function selectProject(id) {
    if (state.creating) return;
    var request = ++state.detailRequest; state.sessionRequest++;
    el("projectDetail").textContent = "正在读取项目…";
    try {
      var project = await api("/projects/" + encodeURIComponent(id));
      if (request !== state.detailRequest || !isOpen()) return;
      state.selected = project; paintProjects(); renderDetail(project); loadProjectSessions(false);
    } catch (error) { if (request === state.detailRequest && isOpen()) { el("projectDetail").textContent = "项目详情暂不可用"; status(explain(error), true); } }
  }
  function renderDetail(project) {
    el("projectDetail").innerHTML = '<h3>' + esc(project.name) + '</h3><p class="project-path">' + esc(project.workspace_path || "目录未绑定") + '</p><p class="memory-note">' + esc(project.session_count) + ' 个会话。会话各自保留消息，共用这个目录和项目记忆。</p>' +
      '<form id="projectRenameForm"><label>显示名称<input id="projectRenameName" required maxlength="120" value="' + esc(project.name) + '"></label><div class="memory-actions"><button type="submit">保存名称</button><button type="button" id="projectRenameReload" hidden>重新载入版本</button></div><p class="memory-note" id="projectRenameStatus" role="status">只修改显示名称，不修改文件夹。</p></form>' +
      '<div class="memory-actions"><button id="projectNewSession" class="memory-primary">在此项目新建会话</button><button id="projectMemory">项目记忆</button></div>' +
      '<h3 class="project-sessions-heading">项目会话</h3><input id="projectSessionSearch" type="search" maxlength="500" aria-label="搜索项目会话" placeholder="搜索会话标题和消息"><div id="projectSessions" class="project-sessions"></div><button id="projectSessionMore" hidden>加载更多会话</button>';
    updateActions();
    el("projectNewSession").onclick = function () { createProjectSession(project); };
    el("projectMemory").onclick = function () { close(); transport.open("project"); };
    el("projectRenameForm").onsubmit = async function (event) {
      event.preventDefault(); var button = this.querySelector('[type="submit"]'), input = el("projectRenameName"), name = input.value.trim(), request = state.detailRequest;
      if (!name || button.disabled) return;
      button.disabled = true; input.disabled = true;
      try {
        var updated = await api("/projects/" + encodeURIComponent(project.project_id), "PATCH", { name: name, expected_revision: project.revision });
        if (request !== state.detailRequest || !isOpen()) return;
        project = updated; state.selected = updated;
        state.rows = state.rows.map(function (p) { return p.project_id === updated.project_id ? updated : p; });
        paintProjects(); el("projectDetail").querySelector("h3").textContent = updated.name;
        input.value = updated.name; el("projectRenameReload").hidden = true;
        el("projectRenameStatus").textContent = "名称已保存，文件夹和项目记忆保持原位。";
      } catch (error) {
        if (request !== state.detailRequest || !isOpen()) return;
        el("projectRenameStatus").textContent = explain(error);
        if (error.status === 409) el("projectRenameReload").hidden = false;
      } finally { button.disabled = false; input.disabled = false; }
    };
    el("projectRenameReload").onclick = async function () {
      var button = this, request = state.detailRequest; button.disabled = true;
      try {
        var fresh = await api("/projects/" + encodeURIComponent(project.project_id));
        if (request !== state.detailRequest || !isOpen()) return;
        project = fresh; state.selected = fresh;
        el("projectRenameStatus").textContent = "最新名称：" + fresh.name + "。当前草稿保留，确认后再保存。";
        button.hidden = true;
      } catch (error) { if (request === state.detailRequest) status(explain(error), true); }
      finally { button.disabled = false; }
    };
    el("projectSessionSearch").oninput = function () {
      state.sessionRequest++; clearTimeout(sessionTimer); sessionTimer = setTimeout(function () { loadProjectSessions(false); }, 220);
    };
    el("projectSessionMore").onclick = function () { loadProjectSessions(true); };
  }
  function updateActions() {
    if (!state.selected || !el("projectNewSession")) return;
    var c = chat.get();
    el("projectNewSession").disabled = state.creating || state.opening || c.busy || !state.selected.workspace_path;
    el("projectNewSession").title = c.busy ? "请等待当前任务完成" : "在项目目录内开始新会话";
    el("projectMemory").disabled = c.projectId !== state.selected.project_id;
    el("projectMemory").title = c.projectId === state.selected.project_id ? "管理当前项目的记忆" : "先打开此项目的会话，再管理其记忆";
  }
  async function loadProjectSessions(more) {
    if (!state.selected || !el("projectSessions")) return;
    var id = state.selected.project_id, request = ++state.sessionRequest;
    var offset = more ? state.offset : 0, q = el("projectSessionSearch").value.trim();
    el("projectSessionMore").disabled = true;
    try {
      var data = await api("/projects/" + encodeURIComponent(id) + "/sessions?limit=50&offset=" + offset + (q ? "&q=" + encodeURIComponent(q) : ""));
      if (request !== state.sessionRequest || !isOpen() || state.selected.project_id !== id) return;
      var rows = (data.sessions || []).filter(function (s) { return s.status !== "deleted"; });
      state.sessions = more ? state.sessions.concat(rows) : rows;
      state.offset = offset + (data.sessions || []).length; state.more = (data.sessions || []).length === 50;
      paintSessions();
    } catch (error) { if (request === state.sessionRequest && isOpen()) { el("projectSessions").textContent = explain(error); } }
    finally { if (request === state.sessionRequest && el("projectSessionMore")) el("projectSessionMore").disabled = false; }
  }
  function paintSessions() {
    var c = chat.get();
    el("projectSessions").innerHTML = state.sessions.map(function (s) {
      return '<button class="project-session" data-project-session="' + esc(s.session_id) + '"' + (c.busy || state.creating || state.opening ? ' disabled' : '') + '><strong>' + esc(s.title || "新会话") + '</strong><small>' + (c.sessionId === s.session_id ? "当前会话 · " : "") + esc(new Date(s.updated_at).toLocaleString()) + '</small></button>';
    }).join("") || '<p class="memory-note">此范围还没有会话，可以在项目内开始新任务。</p>';
    Array.prototype.forEach.call(el("projectSessions").querySelectorAll("[data-project-session]"), function (button) {
      button.onclick = async function () {
        if (chat.get().busy || state.creating || state.opening) return;
        var request = state.detailRequest; state.opening = true; button.disabled = true; updateActions();
        try {
          var data = await api("/sessions/" + encodeURIComponent(button.dataset.projectSession));
          if (!isOpen() || request !== state.detailRequest) return;
          await chat.acceptSession(data); close();
        } catch (error) { if (isOpen() && request === state.detailRequest) status(explain(error), true); }
        finally { state.opening = false; if (isOpen() && el("projectSessions")) { paintSessions(); updateActions(); } }
      };
    });
    el("projectSessionMore").hidden = !state.more;
  }
  async function createProjectSession(project) {
    if (state.creating || state.opening || chat.get().busy) { status("当前任务正在处理，请完成后再新建项目会话。", true); return; }
    state.creating = true; updateActions(); var startingSession = chat.get().sessionId;
    try {
      var data = await api("/sessions", "POST", { title: "新会话", project_id: project.project_id,
        metadata: { source_frontend: "windows-pet", title_is_custom: false, project_session: true } });
      if (chat.get().sessionId !== startingSession) {
        if (isOpen()) { loadProjectSessions(false); status("项目会话已创建；当前会话已变化，可以从项目列表打开。"); }
        return;
      }
      await chat.acceptSession(data);
      close();
    } catch (error) {
      if (!isOpen()) open(); status(explain(error), true);
    } finally { state.creating = false; updateActions(); }
  }
  async function createForCurrent() {
    var c = chat.get(); if (state.creating || c.busy || !c.workspace) return;
    state.creating = true;
    try {
      var project = c.projectId ? { project_id: c.projectId } : await register(c.workspace);
      if (chat.get().sessionId !== c.sessionId || chat.get().workspace !== c.workspace || chat.get().busy) throw new Error("当前会话已变化，请在目标项目重新新建会话。");
      state.creating = false; await createProjectSession(project);
    } catch (error) { state.creating = false; open(); status(explain(error), true); }
  }
  window.addEventListener("lka-session-context", function () {
    if (!isOpen()) return; updateActions(); paintProjects(); if (el("projectSessions")) paintSessions();
  });
  document.addEventListener("keydown", function (event) {
    if (!isOpen()) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    if (event.key !== "Tab") return;
    var controls = Array.prototype.filter.call(overlay.querySelectorAll("button,input,select,summary"), function (node) { return !node.disabled && node.getClientRects().length; });
    var first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }, true);
  window.LkaProjects = { open: open, close: close, isOpen: isOpen, createForCurrent: createForCurrent };
  if (new URLSearchParams(window.location.search).get("panel") === "projects") open();
})();
