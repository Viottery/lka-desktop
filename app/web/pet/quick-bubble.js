(function () {
  "use strict";
  // Pet bubble mode: transparent page, wheel scrolling and receding older bubbles.
  var body = document.body;
  if (!body.classList.contains("quick-mode") || new URLSearchParams(location.search).get("layout") !== "bubble") return;
  body.classList.add("quick-bubble");
  document.documentElement.style.background = "transparent";
  var list = document.getElementById("messages");
  if (!list) return;

  // Ease wheel scrolling toward its target.
  var target = null, frame = 0;
  function maxTop() { return Math.max(0, list.scrollHeight - list.clientHeight); }
  function clamp(value) { return Math.max(0, Math.min(maxTop(), value)); }
  function step() {
    frame = 0;
    if (target !== null) {
      var delta = target - list.scrollTop;
      if (Math.abs(delta) < 0.5) { list.scrollTop = target; target = null; }
      else { list.scrollTop += delta * 0.22; frame = requestAnimationFrame(step); }
    }
  }
  function run() { if (!frame) frame = requestAnimationFrame(step); }
  list.addEventListener("wheel", function (event) {
    if (event.ctrlKey) return;
    event.preventDefault();
    var unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? list.clientHeight : 1;
    target = clamp((target === null ? list.scrollTop : target) + event.deltaY * unit);
    run();
  }, { passive: false });

  var idleTimer = 0;
  function wake() {
    body.classList.remove("bubble-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { if (!body.classList.contains("qa-busy")) body.classList.add("bubble-idle"); }, 9000);
  }
  ["pointermove", "wheel", "keydown", "focusin"].forEach(function (name) { window.addEventListener(name, wake, { passive: true }); });
  wake();

  // The host shows the window with the page hidden and fades it in once this signals that the
  // reopened conversation has rendered (two frames after the assistant is ready).
  var openAssistant = window.__petChatOpenAssistant;
  if (typeof openAssistant === "function") {
    window.__petChatOpenAssistant = function () {
      var result = openAssistant.apply(this, arguments);
      function ready() {
        requestAnimationFrame(function () { requestAnimationFrame(function () {
          if (window.petBridge && typeof window.petBridge.quickRevealReady === "function") window.petBridge.quickRevealReady();
        }); });
      }
      Promise.resolve(result).then(ready, ready);
      return result;
    };
  }
}());
