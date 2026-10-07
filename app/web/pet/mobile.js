/* Mobile shell only; conversations, tools and domain controls use the desktop modules. */
(function () {
  'use strict';
  var params = new URLSearchParams(window.location.search);
  if (params.get('layout') !== 'mobile') return;
  document.body.classList.add('mobile-workbench');
  document.title = '理事所 · 移动工作台';
  // A remote browser uses the frontend's fixed upstream through this same origin.
  // An explicit reachable backend remains available for custom installations.
  if (!params.get('backend') && !params.get('backend_url') && !window.LKA_BACKEND_URL) {
    window.LKA_BACKEND_URL = window.location.origin + '/workbench';
  }

  var root = document.documentElement, viewport = window.visualViewport;
  var baseline = window.innerHeight, previousWidth = window.innerWidth, scheduled = false;
  function editable(node) {
    return !!node && (node.tagName === 'TEXTAREA' || (node.tagName === 'INPUT'
      && !/^(?:checkbox|radio|button|submit|file)$/.test(node.type)) || node.isContentEditable);
  }
  function sizeViewport() {
    scheduled = false;
    var zoomed = viewport && viewport.scale > 1.05;
    var height = zoomed ? window.innerHeight : viewport ? viewport.height : window.innerHeight;
    var offset = zoomed ? 0 : viewport ? viewport.offsetTop : 0;
    if (Math.abs(previousWidth - window.innerWidth) > 80) {
      baseline = window.innerHeight;
      previousWidth = window.innerWidth;
    } else if (!editable(document.activeElement)) baseline = Math.max(height, window.innerHeight);
    else baseline = Math.max(baseline, window.innerHeight);
    root.style.setProperty('--mobile-height', Math.round(height) + 'px');
    root.style.setProperty('--mobile-top', Math.round(offset) + 'px');
    document.body.classList.toggle('mobile-keyboard-open', !zoomed && editable(document.activeElement) && baseline - height > 120);
    var input = document.getElementById('questionInput');
    if (input) {
      input.style.height = 'auto';
      input.style.height = Math.min(Math.max(50, input.scrollHeight), Math.max(64, Math.min(144, height * .26))) + 'px';
    }
  }
  function scheduleViewport() {
    if (!scheduled) { scheduled = true; window.requestAnimationFrame(sizeViewport); }
  }
  window.addEventListener('resize', scheduleViewport);
  if (viewport) {
    viewport.addEventListener('resize', scheduleViewport);
    viewport.addEventListener('scroll', scheduleViewport);
  }
  document.addEventListener('focusin', scheduleViewport);
  document.addEventListener('focusout', scheduleViewport);
  sizeViewport();

  function init() {
    var shell = document.getElementById('chatShell'), input = document.getElementById('questionInput');
    if (!shell || !window.LkaChatContext) return;
    var sidebar = document.getElementById('sessionSidebar'), rail = document.getElementById('contextRail');
    var toggle = document.getElementById('toggleSidebarButton');
    var paths = {
      chat: 'M4 5h16v12H9l-5 3V5Z M8 9h8 M8 13h5',
      projects: 'M3 7h7l2 2h9v11H3V7Z M3 7V4h7l2 3',
      messages: 'M4 4h16v13H9l-5 3V4Z M8 8h8 M8 12h6',
      memory: 'M7 3h10v18l-5-3-5 3V3Z M10 7h4 M10 10h4',
      files: 'M4 4h7v7H4V4Z M15 4h5v7h-5V4Z M4 15h7v5H4v-5Z M15 15h5v5h-5v-5Z',
      menu: 'M4 6h16 M4 12h16 M4 18h16',
      plus: 'M12 4v16 M4 12h16',
      settings: 'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
      close: 'M6 6l12 12 M18 6 6 18',
      send: 'M3 11L21 3L13 21L10 13Z M10 13L21 3'
    };
    function icon(name) { return '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + paths[name] + '"/></svg>'; }
    toggle.innerHTML = icon('menu');
    toggle.setAttribute('aria-controls', 'sessionSidebar');
    document.getElementById('newQuickSessionButton').innerHTML = icon('plus');
    document.getElementById('newQuickSessionButton').setAttribute('aria-label', '新建会话');
    document.getElementById('toggleSettingsButton').innerHTML = icon('settings');
    document.getElementById('closeSettingsButton').innerHTML = icon('close');
    document.getElementById('sendButton').innerHTML = icon('send');
    document.getElementById('sendButton').setAttribute('aria-label', '发送任务');
    input.rows = 1;
    input.placeholder = '写下问题，或交给真理一件事…';
    input.addEventListener('input', scheduleViewport);
    var hint = document.querySelector('.composer-hint');
    hint.textContent = window.matchMedia('(pointer: coarse)').matches ? 'Enter 换行 · 点击发送' : 'Enter 发送 · Shift + Enter 换行';

    var closeSidebar = document.createElement('button');
    closeSidebar.id = 'mobileCloseSessionsButton'; closeSidebar.type = 'button';
    closeSidebar.className = 'mobile-close-sessions'; closeSidebar.innerHTML = icon('close');
    closeSidebar.setAttribute('aria-label', '关闭会话列表');
    sidebar.querySelector('.sidebar-header').appendChild(closeSidebar);
    // Project-directory actions remain available in the workspace instead of
    // crowding the single-line phone context strip.
    document.getElementById('newProjectSessionButton').classList.add('mobile-project-session');
    document.getElementById('settingsPanel').insertBefore(document.getElementById('newProjectSessionButton'), document.getElementById('settingsPanel').firstChild);

    var backdrop = document.createElement('button'); backdrop.id = 'mobilePanelBackdrop';
    backdrop.type = 'button'; backdrop.hidden = true; backdrop.tabIndex = -1;
    backdrop.setAttribute('aria-label', '关闭工作区面板'); shell.appendChild(backdrop);
    var nav = document.createElement('nav'); nav.id = 'mobileNav'; nav.className = 'mobile-nav';
    nav.setAttribute('aria-label', '工作台导航');
    [['chat', '对话'], ['projects', '项目'], ['messages', '消息'], ['memory', '记忆'], ['files', '工作区']].forEach(function (item) {
      var button = document.createElement('button'); button.type = 'button';
      button.setAttribute('data-mobile-action', item[0]); button.setAttribute('aria-pressed', item[0] === 'chat' ? 'true' : 'false');
      button.innerHTML = icon(item[0]) + '<span>' + item[1] + '</span>';
      button.addEventListener('click', function () {
        closePanels();
        if (editable(document.activeElement)) document.activeElement.blur();
        var target = { projects: 'openProjectsButton', messages: 'openMessagesButton', memory: 'openMemoryCenterButton' }[item[0]];
        if (target) document.getElementById(target).click();
        else if (item[0] === 'files') {
          shell.classList.add('settings-open'); document.getElementById('filesTabButton').click();
          document.getElementById('closeSettingsButton').focus({ preventScroll: true });
        }
        syncPanels(); scheduleViewport();
      });
      nav.appendChild(button);
    });
    document.body.appendChild(nav);
    function closePanels() {
      shell.classList.remove('sidebar-open', 'settings-open');
      document.getElementById('sidebarBackdrop').hidden = true;
      backdrop.hidden = true;
    }
    function overlayOpen(id) { var node = document.getElementById(id); return !!node && !node.hidden; }
    function syncPanels() {
      var phone = window.innerWidth < 760;
      var sessionsOpen = phone && shell.classList.contains('sidebar-open');
      var filesOpen = shell.classList.contains('settings-open');
      toggle.setAttribute('aria-expanded', sessionsOpen ? 'true' : 'false');
      document.getElementById('toggleSettingsButton').setAttribute('aria-expanded', filesOpen ? 'true' : 'false');
      backdrop.hidden = !filesOpen;
      sidebar.inert = phone && !sessionsOpen;
      rail.inert = !filesOpen;
      var active = overlayOpen('messageCenter') ? 'messages' : overlayOpen('projectsOverlay') ? 'projects'
        : overlayOpen('memoryOverlay') || overlayOpen('memoryEditorOverlay') ? 'memory' : filesOpen ? 'files' : 'chat';
      Array.prototype.forEach.call(nav.children, function (button) { button.setAttribute('aria-pressed', button.getAttribute('data-mobile-action') === active ? 'true' : 'false'); });
    }
    closeSidebar.addEventListener('click', function () { closePanels(); syncPanels(); toggle.focus({ preventScroll: true }); });
    backdrop.addEventListener('click', function () { closePanels(); syncPanels(); document.getElementById('toggleSettingsButton').focus({ preventScroll: true }); });
    toggle.addEventListener('click', function () {
      shell.classList.remove('settings-open');
      if (shell.classList.contains('sidebar-open')) closeSidebar.focus({ preventScroll: true });
      syncPanels();
    });
    document.getElementById('toggleSettingsButton').addEventListener('click', function () {
      shell.classList.remove('sidebar-open'); document.getElementById('sidebarBackdrop').hidden = true;
      if (shell.classList.contains('settings-open')) document.getElementById('closeSettingsButton').focus({ preventScroll: true });
      syncPanels();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Tab' || ['messageCenter', 'memoryOverlay', 'memoryEditorOverlay', 'projectsOverlay'].some(overlayOpen)) return;
      var panel = shell.classList.contains('settings-open') ? rail
        : window.innerWidth < 760 && shell.classList.contains('sidebar-open') ? sidebar : null;
      if (!panel) return;
      var nodes = Array.prototype.filter.call(panel.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href],[tabindex="0"]'), function (node) { return node.getClientRects().length && !node.hidden; });
      if (!nodes.length) return;
      var at = nodes.indexOf(document.activeElement);
      if (event.shiftKey && at <= 0) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
      else if (!event.shiftKey && (at < 0 || at === nodes.length - 1)) { event.preventDefault(); nodes[0].focus(); }
    });
    var panelObserver = new MutationObserver(syncPanels);
    panelObserver.observe(shell, { attributes: true, attributeFilter: ['class'] });
    ['messageCenter', 'memoryOverlay', 'memoryEditorOverlay', 'projectsOverlay'].forEach(function (id) {
      var overlay = document.getElementById(id);
      if (overlay) panelObserver.observe(overlay, { attributes: true, attributeFilter: ['hidden'] });
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 760) {
        shell.classList.remove('sidebar-open'); document.getElementById('sidebarBackdrop').hidden = true;
      }
      syncPanels();
    });
    // On phones, message conversations open on demand instead of taking a
    // permanent row away from the transcript. Existing business buttons remain.
    var center = document.getElementById('messageCenter');
    if (center) {
      document.getElementById('mcDraft').rows = 1;
      var messageSidebar = center.querySelector('.mc-sidebar');
      var contacts = document.createElement('button');
      contacts.id = 'mobileMessageContacts'; contacts.type = 'button';
      contacts.innerHTML = icon('menu');
      contacts.setAttribute('aria-label', '选择消息会话');
      messageSidebar.id = 'mobileMessageSidebar';
      contacts.setAttribute('aria-controls', messageSidebar.id);
      center.querySelector('.mc-header').insertBefore(contacts, document.getElementById('mcRefresh'));
      var contactsBackdrop = document.createElement('button');
      contactsBackdrop.id = 'mobileMessageContactsBackdrop'; contactsBackdrop.type = 'button';
      contactsBackdrop.hidden = true; contactsBackdrop.tabIndex = -1;
      contactsBackdrop.setAttribute('aria-label', '关闭消息会话列表');
      center.querySelector('.mc-layout').appendChild(contactsBackdrop);
      function closeContacts() { center.classList.remove('mobile-contacts-open'); syncContacts(); }
      function syncContacts() {
        var phone = window.innerWidth < 760;
        var open = phone && center.classList.contains('mobile-contacts-open') && !center.hidden;
        contacts.setAttribute('aria-expanded', open ? 'true' : 'false');
        contactsBackdrop.hidden = !open;
        messageSidebar.inert = phone && !open;
      }
      contacts.addEventListener('click', function () {
        if (editable(document.activeElement)) document.activeElement.blur();
        center.classList.toggle('mobile-contacts-open'); syncContacts();
      });
      contactsBackdrop.addEventListener('click', function () { closeContacts(); contacts.focus({ preventScroll: true }); });
      messageSidebar.addEventListener('click', function (event) {
        if (event.target.closest('.mc-conversation') && window.innerWidth < 760) closeContacts();
      });
      center.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && center.classList.contains('mobile-contacts-open')) closeContacts();
      });
      new MutationObserver(function () { if (center.hidden) closeContacts(); else syncContacts(); })
        .observe(center, { attributes: true, attributeFilter: ['hidden'] });
      window.addEventListener('resize', function () { if (window.innerWidth >= 760) closeContacts(); else syncContacts(); });
      var media = document.createElement('div'); media.className = 'mobile-media-actions';
      var mediaActions = center.querySelector('.mc-composer-actions');
      mediaActions.insertBefore(media, mediaActions.firstChild);
      ['mcAddImage', 'mcAddVideo', 'mcAddSticker', 'mcFavorites'].forEach(function (id) { media.appendChild(document.getElementById(id)); });
      syncContacts();
    }
    syncPanels(); sizeViewport();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
