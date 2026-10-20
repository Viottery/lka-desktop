(function () {
  "use strict";
  // Pet bubble mode (chat.html?mode=quick&layout=bubble): transparent page, eased wheel and
  // drag scrolling with momentum, and older bubbles receding while the pointer is away.
  var body = document.body;
  if (!body.classList.contains("quick-mode") || new URLSearchParams(location.search).get("layout") !== "bubble") return;
  body.classList.add("quick-bubble");
  document.documentElement.style.background = "transparent";
  var list = document.getElementById("messages");
  if (!list) return;

  // One animation loop owns programmatic scrolling: wheel sets a target, drag releases velocity.
  var target = null, velocity = 0, frame = 0;
  function maxTop() { return Math.max(0, list.scrollHeight - list.clientHeight); }
  function clamp(value) { return Math.max(0, Math.min(maxTop(), value)); }
  function step() {
    frame = 0;
    if (target !== null) {
      var delta = target - list.scrollTop;
      if (Math.abs(delta) < 0.5) { list.scrollTop = target; target = null; }
      else { list.scrollTop += delta * 0.22; frame = requestAnimationFrame(step); }
      return;
    }
    if (Math.abs(velocity) > 0.2) {
      list.scrollTop = clamp(list.scrollTop + velocity);
      velocity *= 0.92;
      frame = requestAnimationFrame(step);
    }
  }
  function run() { if (!frame) frame = requestAnimationFrame(step); }
  list.addEventListener("wheel", function (event) {
    if (event.ctrlKey) return;
    event.preventDefault();
    var unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? list.clientHeight : 1;
    velocity = 0;
    target = clamp((target === null ? list.scrollTop : target) + event.deltaY * unit);
    run();
  }, { passive: false });

  var drag = null;
  list.addEventListener("pointerdown", function (event) {
    if (event.button !== 0 || event.target.closest("a, button, summary, input, textarea, .markdown-body pre")) return;
    target = null; velocity = 0;
    drag = { y: event.clientY, top: list.scrollTop, moved: false, id: event.pointerId, lastY: event.clientY, lastT: performance.now(), v: 0 };
  });
  window.addEventListener("pointermove", function (event) {
    if (!drag || event.pointerId !== drag.id) return;
    var dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true; body.classList.add("bubble-dragging");
      try { list.setPointerCapture(drag.id); } catch (ignored) {}
      var selection = window.getSelection(); if (selection) selection.removeAllRanges();
    }
    var now = performance.now(), dt = Math.max(1, now - drag.lastT);
    drag.v = 0.8 * ((drag.lastY - event.clientY) / dt * 16) + 0.2 * drag.v;
    drag.lastY = event.clientY; drag.lastT = now;
    list.scrollTop = clamp(drag.top - dy);
    event.preventDefault();
  });
  function endDrag() {
    if (!drag) return;
    if (drag.moved) { velocity = drag.v; run(); }
    drag = null; body.classList.remove("bubble-dragging");
  }
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  var idleTimer = 0;
  function wake() {
    body.classList.remove("bubble-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { if (!body.classList.contains("qa-busy")) body.classList.add("bubble-idle"); }, 9000);
  }
  ["pointermove", "wheel", "keydown", "focusin"].forEach(function (name) { window.addEventListener(name, wake, { passive: true }); });
  wake();
}());
