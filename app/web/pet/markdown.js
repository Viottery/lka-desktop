(function (global) {
  "use strict";

  var parser = typeof global.markdownit === "function"
    ? global.markdownit({ html: false, linkify: true, breaks: true, typographer: false })
    : null;
  var safeLink = parser && parser.validateLink.bind(parser);

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  if (parser) {
    // Agent text is untrusted. Keep raw HTML disabled and allow explicit web/mail links only.
    parser.validateLink = function (url) {
      return /^(https?:\/\/|mailto:)/i.test(url) && safeLink(url);
    };
    parser.renderer.rules.link_open = function (tokens, index, options, env, renderer) {
      tokens[index].attrSet("target", "_blank");
      tokens[index].attrSet("rel", "noopener noreferrer");
      return renderer.renderToken(tokens, index, options);
    };
    // Do not load remote images automatically in a local conversation.
    parser.renderer.rules.image = function (tokens, index) {
      var token = tokens[index];
      var src = token.attrGet("src") || "";
      var label = token.content || "查看图片";
      return '<a class="markdown-image-link" href="' + escapeHtml(src)
        + '" target="_blank" rel="noopener noreferrer">图片：' + escapeHtml(label) + '</a>';
    };
  }

  function render(element, source) {
    if (!element) return;
    if (element._petMarkdownTimer) {
      global.clearTimeout(element._petMarkdownTimer);
      element._petMarkdownTimer = null;
    }
    element._petMarkdownSource = String(source == null ? "" : source);
    if (!parser) {
      element.textContent = element._petMarkdownSource;
      return;
    }
    element.innerHTML = parser.render(element._petMarkdownSource);
    Array.prototype.forEach.call(element.querySelectorAll("table"), function (table) {
      var wrapper = document.createElement("div");
      wrapper.className = "markdown-table-scroll";
      wrapper.setAttribute("role", "region");
      wrapper.setAttribute("aria-label", "表格，可横向滚动");
      wrapper.tabIndex = 0;
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
    Array.prototype.forEach.call(element.querySelectorAll("pre > code"), function (code) {
      var match = /(?:^|\s)language-([^\s]+)/.exec(code.className || "");
      if (match) code.parentNode.setAttribute("data-language", match[1]);
    });
  }

  function schedule(element, source) {
    if (!element) return;
    element._petMarkdownSource = String(source == null ? "" : source);
    if (element._petMarkdownTimer) return;
    element._petMarkdownTimer = global.setTimeout(function () {
      var latest = element._petMarkdownSource;
      element._petMarkdownTimer = null;
      render(element, latest);
    }, 40);
  }

  document.addEventListener("click", function (event) {
    var anchor = event.target;
    while (anchor && anchor !== document && anchor.tagName !== "A") anchor = anchor.parentNode;
    if (!anchor || anchor === document) return;
    var parent = anchor;
    while (parent && parent !== document && !(parent.classList && parent.classList.contains("markdown-body"))) {
      parent = parent.parentNode;
    }
    if (!parent || parent === document) return;
    var href = anchor.getAttribute("href") || "";
    if (!/^(https?:\/\/|mailto:)/i.test(href)) {
      event.preventDefault();
      return;
    }
    if (global.petBridge && typeof global.petBridge.openExternalUrl === "function") {
      event.preventDefault();
      global.petBridge.openExternalUrl(href);
    }
  });

  global.PetMarkdown = { render: render, schedule: schedule, available: !!parser };
}(window));
