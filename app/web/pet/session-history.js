(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LkaSessionHistory = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  function cancelled() { var error = new Error("History scope changed"); error.name = "AbortError"; return error; }
  function create(options) {
    var entries = new Map(), limit = options.limit || 30;
    function namespace(id) { return String(options.namespace ? options.namespace(id) : ""); }
    function key(id) { return JSON.stringify([namespace(id), id]); }
    function fresh() { return { detail: null, first: "", last: "", more: false, moreAfter: false, anchorMessageId: "", reset: "", expanded: false, legacy: false, chain: Promise.resolve(), pending: {} }; }
    function state(id) {
      var entry = entries.get(key(id));
      return { hasMore: !!(entry && entry.more), anchored: !!(entry && entry.anchorMessageId), loading: !!(entry && entry.pending.before), loaded: !!(entry && entry.detail), expanded: !!(entry && entry.expanded) };
    }
    function clear(id) {
      if (id === undefined) entries.clear();
      else entries.delete(key(id));
    }
    function load(id, settings) {
      settings = settings || {};
      var scope = namespace(id), cacheKey = key(id), entry = entries.get(cacheKey);
      if (!entry) { entry = fresh(); entries.set(cacheKey, entry); }
      var mode = settings.around ? "around" : settings.before ? "before" : "after";
      if (mode === "after" && entry.anchorMessageId && entry.detail) return Promise.resolve(entry.detail);
      if (entry.pending[mode]) return entry.pending[mode];
      function current() { if (namespace(id) !== scope || entries.get(cacheKey) !== entry) throw cancelled(); }
      async function execute() {
        current();
        var draft = { detail: entry.detail, first: entry.first, last: entry.last, more: entry.more, moreAfter: entry.moreAfter, anchorMessageId: entry.anchorMessageId, reset: entry.reset, expanded: entry.expanded, legacy: entry.legacy };
        var direction = mode === "around" ? "around" : draft.detail && (mode === "before" ? draft.first : draft.last) ? mode : "recent";
        if (mode === "before" && draft.detail && !draft.more) return draft.detail;
        var restarts = 0;
        while (true) {
          current();
          var cursor = direction === "before" ? draft.first : direction === "after" ? draft.last : "";
          var path = "/sessions/" + encodeURIComponent(id) + "?message_limit=" + limit + "&message_view=conversation";
          if (cursor) path += "&" + (direction === "before" ? "before_message_id" : "after_message_id") + "=" + encodeURIComponent(cursor);
          if (direction === "around") path += "&around_message_id=" + encodeURIComponent(settings.around);
          if (draft.legacy) path = path.split("?")[0];
          var payload, request = settings.request || options.request;
          try {
            try { payload = await request(path); }
            catch (error) {
              current();
              if (!draft.legacy && error.status === 404 && (error.detail === "Unsupported workbench request" || error.detail === "Unsupported cloud request")) {
                draft.legacy = true;
                payload = await request(path.split("?")[0]);
              } else throw error;
            }
          }
          catch (error) {
            current();
            if (cursor && error.status === 409 && error.detail === "history_cursor_invalid" && restarts++ < 1) {
              draft = { detail: null, first: "", last: "", more: false, moreAfter: false, anchorMessageId: "", reset: "", expanded: false }; direction = "recent"; continue;
            }
            throw error;
          }
          current();
          var page = payload && payload.message_page;
          if (!page) {
            // Old servers return their complete history despite the optional query.
            draft = { detail: payload, first: "", last: "", more: false, reset: "", expanded: false, legacy: true };
            break;
          }
          var reset = String(page.history_reset_at || payload.session && payload.session.metadata && payload.session.metadata.history_reset_at || "");
          if (draft.detail && reset !== draft.reset) {
            if (restarts++ >= 1) throw cancelled();
            draft = { detail: null, first: "", last: "", more: false, moreAfter: false, anchorMessageId: "", reset: "", expanded: false }; direction = "recent"; continue;
          }
          var incoming = Array.isArray(payload.messages) ? payload.messages : [];
          var previous = draft.detail && Array.isArray(draft.detail.messages) ? draft.detail.messages : [];
          var merged = direction === "recent" || direction === "around" ? incoming.slice() : direction === "before" ? incoming.concat(previous) : previous.concat(incoming);
          var seen = new Set();
          merged = merged.filter(function (message) {
            var messageId = message && message.message_id;
            if (!messageId) return true;
            if (seen.has(messageId)) return false;
            seen.add(messageId); return true;
          });
          if (direction === "recent" || direction === "around") {
            draft.first = page.first_message_id || ""; draft.last = page.last_message_id || ""; draft.more = !!page.has_more;
            draft.moreAfter = !!page.has_more_after;
            draft.anchorMessageId = direction === "around" ? page.anchor_message_id || settings.around : "";
          } else if (direction === "before") {
            draft.first = page.first_message_id || draft.first; draft.more = !!page.has_more;
          } else { draft.last = page.last_message_id || draft.last; draft.moreAfter = !!page.has_more_after; }
          if (direction === "before") draft.expanded = true;
          if (!draft.expanded && merged.length > 180) {
            if (draft.anchorMessageId) {
              var anchorIndex = merged.findIndex(function (message) { return message && message.message_id === draft.anchorMessageId; });
              var start = anchorIndex < 0 ? Math.max(0, merged.length - 180) : Math.max(0, Math.min(anchorIndex - 90, merged.length - 180));
              var wasTrimmedBefore = start > 0, wasTrimmedAfter = start + 180 < merged.length;
              merged = merged.slice(start, start + 180);
              draft.more = wasTrimmedBefore || draft.more; draft.moreAfter = wasTrimmedAfter || draft.moreAfter;
              draft.first = merged[0].message_id || draft.first; draft.last = merged[merged.length - 1].message_id || draft.last;
            } else {
              merged = merged.slice(-180); draft.more = true;
              draft.first = merged[0].message_id || draft.first;
            }
          }
          draft.reset = reset;
          draft.detail = Object.assign({}, payload, { messages: merged, message_page: Object.assign({}, page, {
            first_message_id: draft.first, last_message_id: draft.last, has_more: draft.more,
            has_more_after: draft.moreAfter, expanded: draft.expanded
          }) });
          if (direction !== "after" || !page.has_more || draft.anchorMessageId) break;
          if (!page.last_message_id || page.last_message_id === cursor) throw new Error("History cursor did not advance");
        }
        current();
        Object.assign(entry, draft);
        return entry.detail;
      }
      var operation = entry.chain.catch(function () {}).then(execute);
      entry.pending[mode] = operation;
      entry.chain = operation;
      operation.then(function () { if (entry.pending[mode] === operation) delete entry.pending[mode]; },
        function () { if (entry.pending[mode] === operation) delete entry.pending[mode]; });
      return operation;
    }
    return { load: load, state: state, clear: clear };
  }
  return { create: create };
});
