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
  function emptyDetail() {
    return '<div class="memory-detail-empty"><span>项</span><p>在左侧选择一个项目</p><p class="memory-note">可以看到它的对话、在里面新开对话，或管理它的待办和记忆。</p></div>';
  }
  function glyph(name) { var text = String(name || "").trim(); return esc(text ? Array.from(text)[0].toUpperCase() : "项"); }
  function folderParts(path) {
    var shown = String(displayPath(path) || ""), parts = shown.replace(/[\\/]+$/, "").split(/[\\/]/);
    var folder = parts.pop() || shown; return { folder: folder, parent: parts.join("/") || "" };
  }
  function ago(value) {
    var time = new Date(value).getTime(); if (!isFinite(time)) return "";
    var minutes = Math.round((Date.now() - time) / 60000);
    if (minutes < 1) return "刚刚"; if (minutes < 60) return minutes + " 分钟前";
    var hours = Math.round(minutes / 60); if (hours < 24) return hours + " 小时前";
    var days = Math.round(hours / 24); if (days < 7) return days + " 天前";
    return new Date(time).toLocaleDateString();
  }
  var overlay = document.createElement("div");
  overlay.id = "projectsOverlay"; overlay.className = "memory-overlay project-overlay"; overlay.hidden = true;
  overlay.innerHTML = '<section class="memory-center project-center" role="dialog" aria-modal="true" aria-labelledby="projectsTitle">' +
    '<header class="memory-header"><div><span class="memory-eyebrow">Projects</span><h2 id="projectsTitle">项目与会话</h2><p>一个项目对应电脑上的一个文件夹；在项目里开的对话共用这个文件夹和项目记忆。</p></div><div class="memory-header-stats" id="projectStats"></div><button id="projectsClose" aria-label="关闭项目管理">×</button></header>' +
    '<details class="memory-connection" id="projectConnection"><summary>连接设置</summary><form id="projectTokenForm"><label>项目与记忆接口访问令牌<input id="projectToken" type="password" autocomplete="off" placeholder="未设置令牌时留空"><small id="projectTokenNote">仅在当前页面内存使用，与记忆中心共用。</small></label><button type="submit">应用并重试</button></form></details>' +
    '<div class="memory-content"><div class="memory-toolbar"><input id="projectSearch" type="search" maxlength="500" aria-label="搜索项目" placeholder="搜索项目名称"><button id="projectRefresh">刷新</button><button id="projectRegisterToggle" class="memory-primary">＋ 登记文件夹</button></div>' +
    '<form id="projectRegisterForm" class="project-register" hidden><h3>把已有文件夹登记为项目</h3><div class="project-register-path"><label>文件夹路径<input id="projectRegisterPath" required maxlength="4000" placeholder="例如 D:\\work\\report 或 /home/me/app"></label><button type="button" id="projectUseCurrent">填入当前会话目录</button></div><div class="memory-config-fields"><label>项目名称（可选）<input id="projectRegisterName" maxlength="120" placeholder="默认使用文件夹名称"></label><label>路径类型<select id="projectRegisterPlatform"><option value="">自动识别</option><option value="windows">Windows 路径</option><option value="linux">Linux / WSL 路径</option><option value="macos">macOS 路径</option></select></label></div><p class="memory-note">不会新建或移动文件夹。同一个文件夹重复登记时，会直接打开原来的项目。</p><div class="memory-actions"><button type="submit" class="memory-primary">登记项目</button><button type="button" id="projectRegisterCancel">取消</button></div></form>' +
    '<div class="memory-layout project-layout"><div><div id="projectList" class="memory-list">正在读取项目…</div><button id="projectMore" hidden>加载更多项目</button></div><div id="projectDetail" class="memory-detail">' + emptyDetail() + '</div></div></div>' +
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
    el("projectRegisterToggle").setAttribute("aria-expanded", String(!el("projectRegisterForm").hidden));
    if (!el("projectRegisterForm").hidden) el("projectRegisterPath").focus();
  };
  el("projectRegisterCancel").onclick = function () { el("projectRegisterForm").hidden = true; el("projectRegisterToggle").focus(); };
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
      paintProjects(); if (noticeAtStart === noticeVersion) status("");
    } catch (error) { if (request === state.listRequest && isOpen()) { el("projectList").textContent = "项目列表暂不可用"; status(explain(error), true); } }
    finally { if (request === state.listRequest) el("projectMore").disabled = false; }
  }
  // Per-task folders are named after their conversation id; they are not projects anyone chose.
  function automaticName(name) { return /^(conv|session)[-_][0-9a-f-]{8,}$/i.test(String(name || "")); }
  function displayName(p) { return automaticName(p.name) ? "任务工作区 · " + String(p.name).slice(-6) : p.name; }
  function displayPath(path) {
    var match = /^\/mnt\/([a-z])(\/.*)?$/i.exec(String(path || ""));
    return match ? match[1].toUpperCase() + ":" + (match[2] || "/") : path;
  }
  function projectCard(p) {
    var current = chat.get().projectId === p.project_id, where = folderParts(p.workspace_path);
    return '<button class="memory-entry project-entry' + (automaticName(p.name) ? ' is-automatic' : '') + '" data-project-id="' + esc(p.project_id) + '" aria-pressed="' + Boolean(state.selected && state.selected.project_id === p.project_id) + '">' +
      '<span class="project-glyph" aria-hidden="true">' + (automaticName(p.name) ? "任" : glyph(p.name)) + '</span><span class="project-entry-body"><span class="project-entry-title"><strong>' + esc(displayName(p)) + '</strong>' + (current ? '<span class="memory-tag">当前</span>' : '') + '</span>' +
      '<p title="' + esc(displayPath(p.workspace_path) || "") + '">' + (p.workspace_path ? esc(where.parent ? where.parent + "/" : "") + '<b>' + esc(where.folder) + '</b>' : "未绑定文件夹") + '</p>' +
      '<small>' + esc(Number(p.session_count) || 0) + ' 个对话' + (p.updated_at ? ' · ' + esc(ago(p.updated_at)) + '更新' : '') + '</small></span></button>';
  }
  function paintStats() {
    var named = state.rows.filter(function (p) { return !automaticName(p.name); }).length;
    var talks = state.rows.reduce(function (sum, p) { return sum + (Number(p.session_count) || 0); }, 0);
    // Counts cover loaded pages only; mark them as a lower bound while more remain.
    var more = state.next != null ? "+" : "";
    el("projectStats").innerHTML = state.rows.length ? '<span><b>' + named + more + '</b>项目</span><span><b>' + talks + more + '</b>对话</span>' : "";
  }
  function paintProjects() {
    var hidden = state.rows.filter(function (p) { return automaticName(p.name) && !Number(p.session_count); });
    var rows = state.showUnusedAutomatic ? state.rows : state.rows.filter(function (p) { return hidden.indexOf(p) < 0; });
    var named = rows.filter(function (p) { return !automaticName(p.name); }), automatic = rows.filter(function (p) { return automaticName(p.name); });
    paintStats();
    el("projectList").innerHTML = (named.length ? named.map(projectCard).join("") : "") +
      (automatic.length ? '<p class="project-list-label">任务工作区 <small>对话自动创建的文件夹</small></p>' + automatic.map(projectCard).join("") : "") +
      (hidden.length ? '<button type="button" class="project-unused-toggle" id="projectUnusedToggle">' + (state.showUnusedAutomatic ? "隐藏" : "显示") + ' ' + hidden.length + ' 个没有对话的任务工作区</button>' : "")
      || '<div class="memory-empty"><span>＋</span><p>' + (el("projectSearch").value.trim() ? "没有匹配的项目，换个关键词试试。" : "还没有项目。点右上角“登记文件夹”，把常用的工作文件夹加进来。") + '</p></div>';
    if (el("projectUnusedToggle")) el("projectUnusedToggle").onclick = function () { state.showUnusedAutomatic = !state.showUnusedAutomatic; paintProjects(); };
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
      if (window.matchMedia("(max-width: 640px)").matches) el("projectDetail").scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (error) { if (request === state.detailRequest && isOpen()) { el("projectDetail").textContent = "项目详情暂不可用"; status(explain(error), true); } }
  }
  function renderDetail(project) {
    var current = chat.get().projectId === project.project_id;
    el("projectDetail").innerHTML = '<div class="project-hero"><span class="project-glyph is-large" aria-hidden="true">' + (automaticName(project.name) ? "任" : glyph(project.name)) + '</span><div><h3>' + esc(displayName(project)) + '</h3>' +
      '<p class="project-path"><span>' + esc(displayPath(project.workspace_path) || "未绑定文件夹") + '</span>' + (project.workspace_path ? '<button type="button" id="projectCopyPath" class="project-copy" title="复制路径">复制</button>' : '') + '</p></div></div>' +
      '<div class="project-start"><button id="projectNewSession" class="memory-primary">＋ 在这个项目里开新对话</button><p class="memory-note">新对话直接在这个文件夹里工作，能用到项目记忆。</p></div>' +
      '<div class="project-shortcuts"><button id="projectMatters">待办与规划</button><button id="projectMemory">项目记忆</button></div>' +
      (current ? "" : '<p class="memory-note project-memory-hint">项目记忆要在这个项目的对话里打开：先点下面任意一个对话。</p>') +
      '<div class="project-sessions-head"><h3 class="project-sessions-heading">对话 <small>' + esc(Number(project.session_count) || 0) + '</small></h3><input id="projectSessionSearch" type="search" maxlength="500" aria-label="搜索项目会话" placeholder="搜索标题和消息"></div><div id="projectSessions" class="project-sessions"></div><button id="projectSessionMore" hidden>加载更多对话</button>' +
      '<details class="project-settings"' + (automaticName(project.name) ? '' : ' open') + '><summary>项目设置</summary><form id="projectRenameForm"><label>显示名称<input id="projectRenameName" required maxlength="120" value="' + esc(project.name) + '"></label><div class="memory-actions"><button type="submit">保存名称</button><button type="button" id="projectRenameReload" hidden>重新载入版本</button></div><p class="memory-note" id="projectRenameStatus" role="status">只改名字，文件夹本身不会改动。</p></form></details>';
    if (el("projectCopyPath")) el("projectCopyPath").onclick = function () {
      var text = displayPath(project.workspace_path), button = this;
      Promise.resolve(navigator.clipboard && navigator.clipboard.writeText(text)).then(function () { button.textContent = "已复制"; setTimeout(function () { button.textContent = "复制"; }, 1500); }, function () { status("复制失败，可以手动选中路径。", true); });
    };
    updateActions();
    el("projectNewSession").onclick = function () { createProjectSession(project); };
    el("projectMatters").onclick = function () { close(); if (window.LkaMatters) window.LkaMatters.open({ projectId: project.project_id, projectName: project.name }); };
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
        paintProjects(); el("projectDetail").querySelector("h3").textContent = displayName(updated);
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
    el("projectMemory").title = c.projectId === state.selected.project_id ? "管理当前项目的记忆" : "先打开这个项目的对话，再管理它的记忆";
    el("projectNewSession").textContent = state.creating ? "正在创建…" : c.busy ? "等当前任务完成后再开" : "＋ 在这个项目里开新对话";
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
      var current = c.sessionId === s.session_id;
      return '<button class="project-session' + (current ? ' is-current' : '') + '" data-project-session="' + esc(s.session_id) + '"' + (c.busy || state.creating || state.opening ? ' disabled' : '') + ' title="' + esc(new Date(s.updated_at).toLocaleString()) + '"><strong>' + esc(s.title || "新会话") + '</strong><small>' + (current ? '<span class="memory-tag">正在查看</span>' : '') + esc(ago(s.updated_at)) + '</small><span class="project-session-go" aria-hidden="true">›</span></button>';
    }).join("") || '<div class="memory-empty"><p>' + (el("projectSessionSearch") && el("projectSessionSearch").value.trim() ? "没有匹配的对话。" : "这个项目里还没有对话，点上面的按钮开第一个。") + '</p></div>';
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
