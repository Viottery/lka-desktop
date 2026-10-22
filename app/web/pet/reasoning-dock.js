(function () {
  "use strict";
  // Reasoning depth as one-click segments: in the composer (workbench) and in place of the
  // settings sliders. Sliders stay the source of truth for saving; segments only drive them.
  var chat = window.LkaChatContext;
  if (!chat || !document.body.classList.contains("work-mode")) return;
  var LEVELS = ["off", "low", "high", "max"], LABELS = ["关闭", "低", "高", "最高"];
  function el(id) { return document.getElementById(id); }

  function segments(container, onPick) {
    container.classList.add("reasoning-segments");
    container.setAttribute("role", "radiogroup");
    container.innerHTML = '<span class="reasoning-thumb" aria-hidden="true"></span>' + LABELS.map(function (label, index) {
      return '<button type="button" role="radio" data-level="' + LEVELS[index] + '">' + label + '</button>';
    }).join("");
    var buttons = Array.prototype.slice.call(container.querySelectorAll("button"));
    buttons.forEach(function (button, index) {
      button.addEventListener("click", function () { if (!button.disabled) onPick(LEVELS[index]); });
      button.addEventListener("keydown", function (event) {
        var step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        for (var next = index + step; next >= 0 && next < buttons.length; next += step) {
          if (!buttons[next].disabled) { onPick(LEVELS[next]); buttons[next].focus(); return; }
        }
      });
    });
    var lastKey = "";
    return function paint(state) {
      // Painting mutates attributes observers may watch; skip identical states to stay quiet.
      var key = JSON.stringify([state.level, !!state.disabled, !!state.invalid, state.available || null, state.hint || ""]);
      if (key === lastKey) return;
      lastKey = key;
      var selected = Math.max(0, LEVELS.indexOf(state.level));
      container.style.setProperty("--reasoning-index", selected);
      container.classList.toggle("is-disabled", !!state.disabled);
      container.classList.toggle("is-invalid", !!state.invalid);
      buttons.forEach(function (button, index) {
        var on = index === selected;
        button.setAttribute("aria-checked", String(on));
        button.tabIndex = on ? 0 : -1;
        button.disabled = !!state.disabled || state.available && !state.available[index] && !on;
        button.classList.toggle("is-unavailable", !!(state.available && !state.available[index]));
      });
      if (state.hint) container.title = state.hint;
    };
  }

  // Settings sliders (rail and 真理 popover): keep the range input for saving, show segments.
  function enhance(slider) {
    if (!slider || slider.dataset.segmented) return;
    slider.dataset.segmented = "true";
    var control = slider.closest(".reasoning-control");
    var holder = document.createElement("div");
    slider.insertAdjacentElement("afterend", holder);
    slider.classList.add("is-proxied"); slider.tabIndex = -1; slider.setAttribute("aria-hidden", "true");
    var paint = segments(holder, function (level) {
      slider.value = String(LEVELS.indexOf(level));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
    });
    function sync() {
      var ticks = control ? control.querySelectorAll(".reasoning-ticks span") : [];
      paint({ level: LEVELS[Number(slider.value)] || "low", disabled: slider.disabled,
        invalid: control && control.classList.contains("reasoning-invalid"),
        available: Array.prototype.map.call(ticks, function (tick) { return !tick.classList.contains("is-unavailable"); }) });
    }
    new MutationObserver(function (records) {
      if (records.some(function (record) { return !holder.contains(record.target); })) sync();
    }).observe(control || slider, { attributes: true, subtree: true, attributeFilter: ["class", "disabled", "aria-valuetext", "style"] });
    sync();
  }
  enhance(el("reasoningLevelInput"));
  var qs = el("qsReasoning");
  if (qs) enhance(qs);

  // Composer dock: the current model and reasoning depth, one click away.
  var form = el("chatForm"), hint = el("composerKeyboardHint");
  if (!form || !hint || document.body.classList.contains("mobile-workbench")) return;
  var footer = document.createElement("div");
  footer.className = "composer-footer";
  footer.innerHTML = '<div class="reasoning-dock" id="reasoningDock"><button type="button" class="dock-model" id="dockModelButton" title="更换模型">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 7.5 12 12l9-4.5Z"/><path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5"/></svg>' +
    '<span id="dockModelName">默认模型</span></button><span class="dock-divider" aria-hidden="true"></span>' +
    '<div id="dockReasoning" aria-label="推理深度"></div>' +
    '<span class="dock-status" id="dockStatus" role="status" aria-live="polite"></span></div>';
  hint.before(footer); footer.appendChild(hint);

  var lastManagerRefresh = "", statusTimer = 0;
  function view() { return chat.get(); }
  function manager() { return view().kind === "manager"; }
  function modelLabel(value, options) {
    var match = (options || []).find(function (row) { return row.value === value; });
    var label = match ? match.label : "";
    if (!value || !label) return "默认模型";
    return label.replace(/^[^/]+ \/ /, "").replace(/ · (默认|当前已保存|已保存，当前未列出)$/, "");
  }
  function state() {
    if (manager()) {
      var snap = chat.quickSettings ? chat.quickSettings() : null;
      if (!snap) return { level: "low", disabled: true, model: "真理模型" };
      return { level: snap.reasoningLevel, disabled: !snap.ready || snap.busy || !snap.reasoningAvailable,
        invalid: !snap.reasoningValid, hint: snap.error || snap.reasoningHint,
        available: (snap.reasoningLevels || []).map(function (row) { return row.available; }),
        model: modelLabel(snap.modelValue, snap.models), loading: snap.loading };
    }
    var slider = el("reasoningLevelInput"), select = el("llmModelInput"), prefs = chat.preferences();
    var level = slider ? LEVELS[Number(slider.value)] || "low" : prefs.reasoningLevel;
    var options = chat.reasoningOptions(prefs.modelValue, level);
    return { level: level, disabled: !options.reasoningAvailable, invalid: !options.reasoningValid, hint: options.reasoningHint,
      available: options.reasoningLevels.map(function (row) { return row.available; }),
      model: select && select.value ? modelLabel(select.value, prefs.models) : "默认模型" };
  }
  function flash(text, error) {
    var node = el("dockStatus");
    node.textContent = text || ""; node.classList.toggle("is-error", !!error);
    clearTimeout(statusTimer);
    if (text && !error) statusTimer = setTimeout(function () { node.textContent = ""; }, 2200);
  }
  // Drag the thumb like a slider; it snaps to the nearest available stop on release.
  function draggable(container, onPick) {
    var dragging = false, moved = false, startX = 0;
    function stop(event) {
      var rect = container.getBoundingClientRect(), width = rect.width / LEVELS.length;
      return Math.max(0, Math.min(LEVELS.length - 1, (event.clientX - rect.left) / width - 0.5));
    }
    container.addEventListener("pointerdown", function (event) {
      if (container.classList.contains("is-disabled") || event.button !== 0) return;
      dragging = true; moved = false; startX = event.clientX;
    });
    container.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      if (!moved && Math.abs(event.clientX - startX) < 4) return;
      // Capture only once dragging starts, so a plain click still lands on its button.
      if (!moved) container.setPointerCapture(event.pointerId);
      moved = true;
      container.classList.add("is-dragging");
      container.style.setProperty("--reasoning-index", stop(event));
    });
    function end(event) {
      if (!dragging) return;
      dragging = false;
      container.classList.remove("is-dragging");
      if (!moved) return;
      var buttons = container.querySelectorAll("button"), target = Math.round(stop(event)), best = -1;
      for (var offset = 0; offset < LEVELS.length && best < 0; offset++) {
        [target - offset, target + offset].forEach(function (i) { if (best < 0 && buttons[i] && !buttons[i].classList.contains("is-unavailable")) best = i; });
      }
      var current = Array.prototype.findIndex.call(buttons, function (b) { return b.getAttribute("aria-checked") === "true"; });
      container.style.setProperty("--reasoning-index", current);
      if (best >= 0 && best !== current) onPick(LEVELS[best]);
      // Swallow the click that follows a drag.
      container.addEventListener("click", function swallow(e) { e.stopPropagation(); e.preventDefault(); }, { capture: true, once: true });
    }
    container.addEventListener("pointerup", end);
    container.addEventListener("pointercancel", function () { dragging = false; container.classList.remove("is-dragging"); });
  }
  var pickDock = async function (level) {
    if (manager()) {
      var result = await chat.updateQuickSettings({ reasoningLevel: level });
      render();
      flash(result && result.error ? result.error : "", !!(result && result.error));
      return;
    }
    var slider = el("reasoningLevelInput");
    if (!slider) return;
    slider.value = String(LEVELS.indexOf(level));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    render();
    var save = el("defaultsSaveStatus");
    if (save && save.classList.contains("error")) flash(save.textContent, true); else flash("");
  };
  var paintDock = segments(el("dockReasoning"), pickDock);
  draggable(el("dockReasoning"), pickDock);
  function render() {
    var current = state();
    paintDock(current);
    el("dockModelName").textContent = current.model;
    el("reasoningDock").classList.toggle("is-manager", manager());
    if (manager() && !current.loading && current.disabled && lastManagerRefresh !== view().sessionId && chat.refreshQuickSettings) {
      lastManagerRefresh = view().sessionId;
      chat.refreshQuickSettings().then(render, render);
    }
  }
  el("dockModelButton").addEventListener("click", function () {
    if (manager()) { var assistant = el("assistantSettingsButton"); if (assistant) assistant.click(); return; }
    var rail = el("contextRail"), shell = el("chatShell");
    var open = shell && (shell.classList.contains("settings-open") || rail && getComputedStyle(rail).display !== "none" && rail.getBoundingClientRect().width > 40);
    if (!open) el("toggleSettingsButton").click();
    var tab = el("settingsTabButton"); if (tab && tab.getAttribute("aria-selected") !== "true") tab.click();
    var select = el("llmModelInput");
    if (select) setTimeout(function () { select.focus(); }, 60);
  });
  var scheduled = false;
  function schedule() { if (scheduled) return; scheduled = true; requestAnimationFrame(function () { scheduled = false; render(); }); }
  ["lka-session-context", "lka-quick-assistant-state"].forEach(function (name) { window.addEventListener(name, schedule); });
  ["llmModelInput", "reasoningLevelInput"].forEach(function (id) { var node = el(id); if (node) { node.addEventListener("change", schedule); node.addEventListener("input", schedule); } });
  var watch = [el("llmModelInput"), el("reasoningControl")].filter(Boolean);
  var observer = new MutationObserver(schedule);
  watch.forEach(function (node) { observer.observe(node, { childList: true, subtree: true, attributes: true }); });
  var qsPanel = el("quickSettings");
  if (qsPanel) observer.observe(qsPanel, { attributes: true, subtree: true, attributeFilter: ["disabled", "class"] });
  render();
}());
