(function () {
  "use strict";
  if (!document.body.classList.contains("quick-mode")) return;
  document.title = "理事所 · 快速会话";
  var transcript = document.getElementById("messages");
  var status = document.getElementById("runStatus");
  var shell = document.getElementById("chatShell");
  var projectButton = document.getElementById("quickProjectsButton");
  var sidebarButton = document.getElementById("toggleSidebarButton");
  var newButton = document.getElementById("newQuickSessionButton");
  var lastHeight = -1, lastBridge = null, scheduled = false, requestId = 0, timer, nextOffset = null;
  var picker = document.createElement("section");
  picker.className = "quick-project-picker";
  picker.hidden = true;
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", "选择项目");
  picker.innerHTML = '<div class="quick-project-heading"><strong>选择项目</strong><button type="button" aria-label="关闭项目选择">×</button></div><input type="search" aria-label="搜索项目" placeholder="搜索项目"><div class="quick-project-list"></div><button type="button" class="quick-project-more" hidden>加载更多</button><p role="status">选择项目后，在该目录开始新任务。</p>';
  shell.appendChild(picker);
  var search = picker.querySelector("input"), list = picker.querySelector(".quick-project-list"), note = picker.querySelector("p"), more = picker.querySelector(".quick-project-more");
  function closePicker(focus) {
    picker.hidden = true; requestId++; clearTimeout(timer);
    projectButton.setAttribute("aria-expanded", "false");
    if (focus) {
      if (document.body.classList.contains("native-composer") && window.petBridge && typeof window.petBridge.focusComposer === "function") window.petBridge.focusComposer();
      else projectButton.focus();
    }
    schedule();
  }
  function addProject(project) {
    var button = document.createElement("button"), name = document.createElement("strong"), path = document.createElement("small");
    button.type = "button"; name.textContent = project.name || "未命名项目"; path.textContent = project.workspace_path || "工作目录未绑定";
    button.appendChild(name); button.appendChild(path); button.disabled = !project.workspace_path;
    button.addEventListener("click", function () {
      try { window.LkaChatContext.startProjectDraft(project); closePicker(false); }
      catch (error) { note.textContent = error.message; }
    });
    list.appendChild(button);
  }
  async function loadProjects(append) {
    var token = ++requestId;
    if (!append) { list.textContent = ""; more.hidden = true; }
    note.textContent = "正在读取项目…";
    try {
      if (!window.LkaMemory) throw new Error("项目服务尚未准备好，请重试。");
      var result = await window.LkaMemory.request("/projects?limit=30&offset=" + (append ? nextOffset : 0) + (search.value.trim() ? "&q=" + encodeURIComponent(search.value.trim()) : ""));
      if (token !== requestId || picker.hidden) return;
      (result.projects || []).forEach(addProject);
      nextOffset = result.next_offset; more.hidden = nextOffset == null;
      note.textContent = list.children.length ? "选择项目后，在该目录开始新任务。" : "还没有项目。可在工作台中登记已有目录。";
    } catch (error) { if (token === requestId && !picker.hidden) note.textContent = "项目读取失败：" + (error.message || error); }
    schedule();
  }
  projectButton.setAttribute("aria-expanded", "false");
  projectButton.addEventListener("click", function () {
    if (!picker.hidden) { closePicker(true); return; }
    if (window.LkaChatContext.get().busy) { status.textContent = "请等待当前任务完成后选择项目"; status.classList.add("error"); schedule(); return; }
    shell.classList.remove("sidebar-open"); document.getElementById("sidebarBackdrop").hidden = true;
    picker.hidden = false; projectButton.setAttribute("aria-expanded", "true"); search.value = "";
    loadProjects(false); search.focus(); schedule();
  });
  picker.querySelector(".quick-project-heading button").addEventListener("click", function () { closePicker(true); });
  more.addEventListener("click", function () { loadProjects(true); });
  search.addEventListener("input", function () { requestId++; clearTimeout(timer); timer = setTimeout(function () { loadProjects(false); }, 180); });
  sidebarButton.addEventListener("click", function () { closePicker(false); if (shell.classList.contains("sidebar-open")) document.getElementById("sessionSearchInput").focus(); schedule(); });
  newButton.addEventListener("click", function () { closePicker(false); status.classList.remove("error"); status.textContent = "就绪"; schedule(); });
  newButton.textContent = "+"; newButton.setAttribute("aria-label", "开始新任务"); newButton.title = "开始新任务";
  document.getElementById("sendButton").innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11L21 3L13 21L10 13Z M10 13L21 3"/></svg>';
  document.getElementById("sendButton").setAttribute("aria-label", "发送任务");
  document.getElementById("questionInput").placeholder = "写下问题，或交给我一件事…";
  document.addEventListener("keydown", function (event) { if (event.key === "Escape" && !picker.hidden) { closePicker(true); event.preventDefault(); } });
  document.addEventListener("pointerdown", function (event) { if (!picker.hidden && !picker.contains(event.target) && !projectButton.contains(event.target)) closePicker(false); });
  var viewSession = "", lastQuestion = "", lastQuestionIndex = -1, readingOffset = 0, restoringScroll = false, focusLatest = false;
  transcript.addEventListener("scroll", function () { if (!restoringScroll) readingOffset = transcript.scrollTop; }, { passive: true });
  // Re-rendering a turn must not reset a reader's scroll position.
  window.__petQuickBeforeMessagesRender = function () { restoringScroll = true; };
  window.__petQuickScrollToLatest = schedule;
  function updateConversation(busy) {
    var current = window.LkaChatContext.get().sessionId;
    var rows = Array.prototype.slice.call(transcript.querySelectorAll(".message"));
    var latestUser = -1;
    rows.forEach(function (row, index) { if (row.classList.contains("user")) latestUser = index; });
    var questionBody = latestUser >= 0 ? rows[latestUser].querySelector(".message-content") : null;
    var question = questionBody ? questionBody.textContent : "";
    if (viewSession !== current || question !== lastQuestion || latestUser !== lastQuestionIndex) {
      viewSession = current; lastQuestion = question; lastQuestionIndex = latestUser; readingOffset = 0; focusLatest = true;
    }
    rows.forEach(function (row) {
      var body = row.querySelector(".message-content");
      var placeholder = busy && row.classList.contains("assistant") && body && body.textContent.trim() === "正在处理…";
      var hide = placeholder && !row.querySelector(".run-timeline:not([hidden])");
      if (row.hidden !== hide) row.hidden = hide;
      row.setAttribute("aria-label", row.classList.contains("user") ? "你的提问" : "真理的回复");
      var details = row.querySelector(".agent-run-details");
      if (details) {
        var warning = details.querySelector(".agent-warning-list");
        if (details.hidden !== !warning) details.hidden = !warning;
        if (warning) {
          if (!details.classList.contains("quick-warning-details")) details.classList.add("quick-warning-details");
          var summary = details.querySelector("summary");
          if (summary.textContent !== "需要留意") summary.textContent = "需要留意";
        }
      }
      Array.prototype.forEach.call(row.querySelectorAll(".markdown-body pre"), function (pre) {
        pre.tabIndex = 0; pre.setAttribute("aria-label", "代码，可滚动查看");
      });
    });
  }
  function visibleHeight(node) { return node && !node.hidden && node.getClientRects().length ? node.getBoundingClientRect().height : 0; }
  function updateLayout() {
    scheduled = false;
    var busy = document.getElementById("sendButton").disabled && document.getElementById("backendOfflinePanel").hidden;
    var error = status.classList.contains("error");
    if (status.hidden !== !error) status.hidden = !error;
    var waiting = !document.getElementById("approvalQueueStatus").hidden;
    updateConversation(busy);
    var style = window.getComputedStyle(transcript);
    var natural = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    var visibleRows = 0;
    Array.prototype.forEach.call(transcript.children, function (child) {
      if (child.hidden || !child.getClientRects().length) return;
      visibleRows++;
      var spacing = window.getComputedStyle(child);
      natural += child.getBoundingClientRect().height + parseFloat(spacing.marginTop || 0) + parseFloat(spacing.marginBottom || 0);
    });
    // The native host uses this as a preferred size, while CSS fills the actual
    // viewport. User resizing must never be limited by an inline transcript height.
    var conversationHeight = visibleRows ? Math.min(600, Math.max(440, Math.ceil(natural))) : 0;
    var questions = transcript.querySelectorAll(".message.user");
    var latest = questions[questions.length - 1];
    // A short new turn can start at the top without forcing previous turns into
    // view. This reading space is viewport-dependent and never a host size input.
    var tail = 0;
    if (latest) {
      var sectionHeight = 0, node = latest;
      while (node) {
        if (!node.hidden) {
          var nodeStyle = window.getComputedStyle(node);
          sectionHeight += node.getBoundingClientRect().height + parseFloat(nodeStyle.marginTop || 0) + parseFloat(nodeStyle.marginBottom || 0);
        }
        node = node.nextElementSibling;
      }
      tail = Math.max(0, Math.ceil(transcript.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - sectionHeight));
    }
    var tailText = tail + "px";
    if (transcript.style.getPropertyValue("--quick-tail-space") !== tailText) transcript.style.setProperty("--quick-tail-space", tailText);
    if (focusLatest) {
      readingOffset = latest ? Math.max(0, latest.getBoundingClientRect().top - transcript.getBoundingClientRect().top + transcript.scrollTop - parseFloat(style.paddingTop)) : 0;
      focusLatest = false;
    }
    // Start at the latest question; leave the reader in control while its reply grows.
    if (Math.abs(transcript.scrollTop - readingOffset) > 1) transcript.scrollTop = readingOffset;
    readingOffset = transcript.scrollTop;
    restoringScroll = false;
    var toolbarHeight = document.body.classList.contains("native-composer") ? 0 : 28;
    var desired = toolbarHeight + conversationHeight + visibleHeight(status) + visibleHeight(document.getElementById("backendOfflinePanel"));
    if (!picker.hidden || shell.classList.contains("sidebar-open")) desired = Math.max(desired, 310);
    if (document.body.classList.contains("workspace-picker-open")) desired = Math.max(desired, 510);
    if (waiting) desired = Math.max(310, toolbarHeight + conversationHeight + visibleHeight(document.getElementById("approvalQueueStatus")) + 12);
    // Use natural child heights, never viewport/scrollHeight: the host resizes in response.
    var bridge = window.petBridge;
    if (bridge && typeof bridge.setQuickPanelHeight === "function" && (desired !== lastHeight || bridge !== lastBridge)) {
      lastHeight = desired; lastBridge = bridge; bridge.setQuickPanelHeight(desired);
    }
    document.body.setAttribute("data-quick-content-height", String(Math.ceil(desired)));
    sidebarButton.setAttribute("aria-expanded", String(shell.classList.contains("sidebar-open")));
  }
  function schedule() { if (scheduled) return; scheduled = true; window.requestAnimationFrame(updateLayout); }
  var tooltip = document.createElement("div"), tooltipTarget = null;
  tooltip.className = "quick-tooltip"; tooltip.id = "quickButtonTooltip";
  tooltip.setAttribute("role", "tooltip"); tooltip.hidden = true;
  document.body.appendChild(tooltip);
  function hideTooltip() {
    if (tooltipTarget) {
      var described = tooltipTarget.getAttribute("aria-describedby") || "";
      var ids = described.split(/\s+/).filter(function (id) { return id && id !== tooltip.id; });
      if (ids.length) tooltipTarget.setAttribute("aria-describedby", ids.join(" "));
      else tooltipTarget.removeAttribute("aria-describedby");
    }
    tooltipTarget = null; tooltip.hidden = true;
  }
  function showTooltip(event) {
    var button = event.target.closest("button");
    if (!button || !shell.contains(button) || button === tooltipTarget) return;
    var text = button.title || button.getAttribute("data-quick-tooltip") || button.getAttribute("aria-label") || button.textContent.trim();
    if (!text) return;
    hideTooltip(); tooltipTarget = button;
    // Avoid the browser's second, differently styled tooltip.
    if (button.title) { button.setAttribute("data-quick-tooltip", button.title); button.removeAttribute("title"); }
    button.setAttribute("aria-describedby", ((button.getAttribute("aria-describedby") || "") + " " + tooltip.id).trim());
    tooltip.textContent = text; tooltip.hidden = false;
    var bounds = button.getBoundingClientRect(), box = tooltip.getBoundingClientRect();
    var left = Math.max(6, Math.min(window.innerWidth - box.width - 6, bounds.left + (bounds.width - box.width) / 2));
    var top = bounds.top - box.height - 7;
    if (top < 6) top = bounds.bottom + 7;
    tooltip.style.left = left + "px";
    tooltip.style.top = Math.max(6, Math.min(window.innerHeight - box.height - 6, top)) + "px";
  }
  document.addEventListener("pointerover", showTooltip);
  document.addEventListener("focusin", showTooltip);
  document.addEventListener("pointerout", function (event) { if (tooltipTarget && !tooltipTarget.contains(event.relatedTarget)) hideTooltip(); });
  document.addEventListener("focusout", hideTooltip);
  document.addEventListener("pointerdown", hideTooltip);
  window.addEventListener("resize", hideTooltip);
  var observer = new MutationObserver(schedule);
  observer.observe(shell, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class", "disabled"] });
  if (window.ResizeObserver) { new ResizeObserver(schedule).observe(transcript); }
  window.addEventListener("resize", schedule);
  window.addEventListener("lka-session-context", schedule);
  window.addEventListener("lka-workspace-picker", schedule);
  var bridgeReady = window.__petChatBridgeReady;
  window.__petChatBridgeReady = function () { bridgeReady(); schedule(); };
  var fresh = window.__petChatOpenFreshTask;
  window.__petChatOpenFreshTask = function () { closePicker(false); shell.classList.remove("sidebar-open"); document.getElementById("sidebarBackdrop").hidden = true; status.classList.remove("error"); status.textContent = "就绪"; fresh(); schedule(); };
  schedule();
})();
