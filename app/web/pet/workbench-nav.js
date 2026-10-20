(function () {
  "use strict";
  // One navigation model for the workbench: the session sidebar stays in place and
  // 待办 / 项目 / 消息 / 记忆 open as views beside it, one at a time.
  var body = document.body;
  if (!body.classList.contains("work-mode")) return;
  var desktop = !body.classList.contains("mobile-workbench");
  function el(id) { return document.getElementById(id); }

  // The workspace line joins the title block so the transcript gains a full row.
  if (desktop) {
    var strip = document.querySelector(".context-strip"), meta = document.querySelector(".chat-session-meta");
    if (strip && meta) { meta.appendChild(strip); body.classList.add("workspace-in-header"); }
  }

  var views = {
    matters: { open: function () { return !!(window.LkaMatters && window.LkaMatters.isOpen()); },
      close: function () { if (window.LkaMatters) window.LkaMatters.close(); } },
    projects: { open: function () { var node = el("projectsOverlay"); return !!node && !node.hidden; },
      close: function () { var button = el("projectsClose"); if (button) button.click(); } },
    memory: { open: function () { var node = el("memoryOverlay"); return !!node && !node.hidden; },
      close: function () { var button = el("memoryClose"); if (button) button.click(); } },
    messages: { open: function () { var node = el("messageCenter"); return !!node && !node.hidden; },
      close: function () { var button = el("mcClose"); if (button) button.click(); } }
  };
  function openView() {
    for (var key in views) if (views[key].open()) return key;
    return "";
  }
  function closeViews(except) {
    Object.keys(views).forEach(function (key) { if (key !== except && views[key].open()) views[key].close(); });
  }
  function sync() {
    var current = openView();
    body.classList.toggle("wb-view-open", !!current);
    if (current) body.setAttribute("data-wb-view", current); else body.removeAttribute("data-wb-view");
    Array.prototype.forEach.call(document.querySelectorAll(".wb-nav-item[data-view]"), function (item) {
      var view = item.getAttribute("data-view");
      if (view === "assistant") { item.classList.toggle("is-shadowed", !!current); return; }
      if (view === current) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
    });
  }

  // Selecting a view closes the previous one first; picking a conversation leaves every view.
  document.addEventListener("click", function (event) {
    var target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    var nav = target.closest(".wb-nav-item[data-view]");
    if (nav) {
      var view = nav.getAttribute("data-view");
      if (view === "assistant") closeViews("");
      else if (views[view] && views[view].open()) { event.stopImmediatePropagation(); event.preventDefault(); return; }
      else closeViews(view);
      return;
    }
    if (target.closest("#sessionList .session-item, #newSessionButton, #newQuickSessionButton")) closeViews("");
  }, true);

  var observer = new MutationObserver(sync);
  function watch() {
    ["projectsOverlay", "memoryOverlay", "messageCenter", "matterWorkspace"].forEach(function (id) {
      var node = el(id);
      if (node && !node._wbWatched) { node._wbWatched = true; observer.observe(node, { attributes: true, attributeFilter: ["hidden"] }); }
    });
    sync();
  }
  observer.observe(body, { attributes: true, attributeFilter: ["class"] });
  watch();
  // Views are created by their own modules; pick up late ones without polling forever.
  var tries = 0, timer = setInterval(function () { watch(); if (++tries > 20) clearInterval(timer); }, 250);
}());
