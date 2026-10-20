(function () {
  "use strict";
  // 真理 presence: while she works, the conversation header says what she is doing right now,
  // derived from the same live process rows the transcript renders. Display only.
  // Quick window: always. Workbench and phone: only inside the 真理 (manager) conversation.
  var body = document.body;
  var quick = body.classList.contains("quick-mode");
  if (!quick && !body.classList.contains("work-mode")) return;
  var activity = null, lastText = "";

  function host() {
    if (quick) return document.querySelector("#quickAssistantBar .qa-identity");
    return body.classList.contains("manager-conversation") ? document.querySelector(".chat-session-meta") : null;
  }

  function ensureActivity() {
    var parent = host();
    if (!parent) { if (activity) activity.hidden = true; return null; }
    if (!activity) {
      activity = document.createElement("span");
      activity.id = "qaActivity"; activity.className = "qa-activity"; activity.setAttribute("aria-live", "polite");
      activity.innerHTML = '<span class="qa-activity-text"></span><span class="qa-typing" aria-hidden="true"><i></i><i></i><i></i></span>';
    }
    if (activity.parentNode !== parent) {
      var title = parent.querySelector("#activeSessionTitle");
      if (title) title.insertAdjacentElement("afterend", activity); else parent.appendChild(activity);
    }
    return activity;
  }

  function currentAction() {
    var rows = document.querySelectorAll("#runTimelineList .run-process-entry");
    var latest = rows[rows.length - 1];
    if (latest && latest.classList.contains("run-process-tool")) {
      var state = latest.querySelector(".run-process-state");
      var label = latest.querySelector(".run-process-label");
      if (state && state.getAttribute("data-status") === "running" && label) return "正在" + label.textContent.trim() + "…";
    }
    var live = document.querySelector(".agent-live-output .message-content");
    if (live && !live.hidden && live.textContent.trim()) return "正在回复…";
    return "在想…";
  }

  function sync() {
    var node = ensureActivity();
    var busy = !!node && (body.classList.contains("run-progress-inline") || !!document.querySelector(".agent-live-output"));
    body.classList.toggle("qa-busy", busy);
    if (!node) return;
    var text = busy ? currentAction() : "";
    if (text !== lastText) { node.querySelector(".qa-activity-text").textContent = text; lastText = text; }
    node.hidden = !busy;
  }

  // Mark only genuinely new rows for the entrance animation. Re-renders rebuild every row with
  // the same content, and a finished stream replaces its live row; neither should replay it.
  var transcript = document.getElementById("messages"), seen = Object.create(null), primed = false;
  function rowKey(row) {
    if (row.classList.contains("agent-live-output")) return "live";
    var text = (row.querySelector(".message-content") || row).textContent.trim().slice(0, 120);
    return (row.classList.contains("user") ? "u:" : "a:") + (row.dataset.clientId || text);
  }
  if (transcript) new MutationObserver(function (records) {
    var replacedLive = records.some(function (record) {
      return Array.prototype.some.call(record.removedNodes, function (node) { return node.classList && node.classList.contains("agent-live-output"); });
    });
    records.forEach(function (record) {
      Array.prototype.forEach.call(record.addedNodes, function (node) {
        if (!node.classList || !node.classList.contains("message")) return;
        var key = rowKey(node), fresh = primed && !seen[key] && !(replacedLive && node.classList.contains("assistant"));
        seen[key] = true;
        if (fresh) { node.classList.add("is-new"); setTimeout(function () { node.classList.remove("is-new"); }, 400); }
      });
    });
    if (!transcript.querySelector(".agent-live-output")) delete seen.live;
    primed = true;
  }).observe(transcript, { childList: true });
  setTimeout(function () { primed = true; }, 1500);

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; sync(); });
  }
  new MutationObserver(schedule).observe(body, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true, characterData: true });
  sync();
}());
