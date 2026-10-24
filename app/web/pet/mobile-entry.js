// External so hosted pages can keep a strict script-src 'self' policy.
(function () {
  var target = new URL('./chat.html', window.location.href);
  target.search = window.location.search;
  target.searchParams.set('mode', 'work');
  target.searchParams.set('layout', 'mobile');
  target.hash = window.location.hash;
  document.getElementById('mobileEntry').href = target.href;
  window.location.replace(target.href);
}());
