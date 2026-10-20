/* Complete, revision-aware matter cache shared by the browser and native workbench. */
(function (root) {
  "use strict";
  var SCHEMA = 2, MAX_BYTES = 8 * 1024 * 1024;
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function create(options) {
    options = options || {};
    if (!options.namespace || typeof options.request !== "function") throw new Error("Matter store requires namespace and request");
    var key = "lka.matters.v2:" + options.namespace, viewKey = key + ":view";
    var storage = options.storage, now = options.now || Date.now, ttl = options.ttl == null ? 60000 : options.ttl;
    if (storage === undefined) { try { storage = root.localStorage; } catch (_) { storage = null; } }
    var records = new Map(), ready = false, cursor = 0, updatedAt = 0, dirty = false;
    var error = null, listeners = new Set(), pending = null, disposed = false, generation = 0, channel = null;
    var savedView = {}, origin = Math.random().toString(36).slice(2);
    function merge(rows) {
      rows.forEach(function (row) {
        if (!row || typeof row.matter_id !== "string") throw new Error("Invalid matter record");
        var old = records.get(row.matter_id);
        if (!old || Number(row.revision || 0) > Number(old.revision || 0)) records.set(row.matter_id, copy(row));
      });
    }
    function select(settings) {
      var visibility = settings && settings.visibility || "user";
      if (["user", "internal", "all"].indexOf(visibility) < 0) throw new Error("Invalid matter visibility projection");
      var rows = Array.from(records.values()).map(copy), plans = new Map();
      rows.forEach(function (r) { if (r.kind === "plan") { r.progress = { total: 0, done: 0, cancelled: 0 }; plans.set(r.matter_id, r); } });
      rows.forEach(function (r) {
        var parent = plans.get(r.parent_matter_id);
        if (parent && r.kind !== "plan" && (r.visibility || "user") === "user") { parent.progress.total++; if (r.status === "done") parent.progress.done++; if (r.status === "cancelled") parent.progress.cancelled++; }
      });
      return rows.filter(function (r) { return visibility === "all" || (r.visibility || "user") === visibility; });
    }
    function all() { return select({ visibility: "all" }); }
    function snapshot() { return { records: select(), ready: ready, updatedAt: updatedAt, error: error, stale: dirty || !ready || now() - updatedAt >= ttl }; }
    function emit() { if (!disposed) { var value = snapshot(); listeners.forEach(function (fn) { try { fn(value); } catch (_) { /* One view cannot break other subscribers. */ } }); } }
    function envelope() { return { schema: SCHEMA, records: Array.from(records.values()), ready: ready, cursor: cursor, updatedAt: updatedAt, dirty: dirty }; }
    function valid(data) { return data && data.schema === SCHEMA && Array.isArray(data.records) && typeof data.ready === "boolean" && Number.isSafeInteger(data.cursor) && data.cursor >= 0 && Number.isFinite(data.updatedAt); }
    function writeStorage(target, value, limit) {
      if (!storage) return;
      try { var serialized = JSON.stringify(value); if (serialized.length * 2 > limit) { storage.removeItem(target); return; } storage.setItem(target, serialized); } catch (_) { try { storage.removeItem(target); } catch (_) {} }
    }
    function persist(broadcast) {
      // A second window may have written a newer revision before its event arrives.
      try { if (storage) { var disk = JSON.parse(storage.getItem(key)); if (valid(disk) && disk.records.every(function (r) { return r && typeof r.matter_id === "string"; })) { merge(disk.records); if (ready && disk.ready) cursor = Math.max(cursor, disk.cursor); } } } catch (_) {}
      var data = envelope(); writeStorage(key, data, MAX_BYTES);
      if (broadcast && channel) { try { channel.postMessage({ origin: origin, data: data }); } catch (_) {} }
    }
    function accept(data, initial) {
      if (!valid(data)) return;
      // Validate the entire envelope before admitting its coverage marker.
      if (data.records.some(function (r) { return !r || typeof r.matter_id !== "string"; })) return;
      merge(data.records);
      if (data.ready) {
        ready = true; cursor = Math.max(cursor, data.cursor);
        if (initial || data.updatedAt > updatedAt) { updatedAt = data.updatedAt; dirty = !!data.dirty; if (!initial && data.dirty) generation++; }
        else if (data.dirty && data.updatedAt >= updatedAt) { dirty = true; generation++; }
      } else if (initial) { cursor = data.cursor; dirty = true; }
      if (!initial) emit();
    }
    try { if (storage) { accept(JSON.parse(storage.getItem(key)), true); var view = JSON.parse(storage.getItem(viewKey)); if (view && typeof view === "object" && !Array.isArray(view)) savedView = view; } } catch (_) { /* Corrupt/disabled cache falls back to a full sync. */ }
    function receive(event) { var message = event.data; if (message && message.origin !== origin) accept(message.data, false); }
    function storageEvent(event) { if (event.key === key && event.newValue) { try { accept(JSON.parse(event.newValue), false); } catch (_) {} } }
    if (typeof root.BroadcastChannel === "function") { try { channel = new root.BroadcastChannel(key); channel.onmessage = receive; } catch (_) {} }
    if (root.addEventListener) root.addEventListener("storage", storageEvent);
    async function runSync() {
      var startGeneration = generation;
      // Incomplete caches always restart from zero; their cursor has no coverage guarantee.
      var next = ready ? cursor : 0;
      try {
        for (;;) {
          var result = await options.request("/matters/sync?after=" + next + "&limit=200");
          if (!result || !Array.isArray(result.changes) || !Number.isSafeInteger(result.cursor) || result.cursor < next || typeof result.has_more !== "boolean") throw new Error("Invalid matter sync response");
          if (result.has_more && result.cursor <= next) throw new Error("Matter sync cursor did not advance");
          var rows = result.changes.map(function (change) { if (!change || !Number.isSafeInteger(change.sequence) || !change.matter || typeof change.matter.matter_id !== "string") throw new Error("Invalid matter change"); return change.matter; });
          merge(rows); next = result.cursor;
          if (!result.has_more) break;
        }
        cursor = Math.max(cursor, next); ready = true; updatedAt = now(); dirty = generation !== startGeneration; error = null;
        persist(true); emit(); return snapshot();
      } catch (failure) {
        error = failure && failure.message ? failure.message : String(failure); dirty = true;
        // Previously complete data stays usable after a failed refresh.
        persist(false); emit(); throw failure;
      }
    }
    return {
      hydrate: snapshot,
      subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
      sync: function (settings) {
        if (pending) return pending;
        if (!(settings && settings.force) && ready && !dirty && now() - updatedAt < ttl) return Promise.resolve(snapshot());
        pending = runSync().finally(function () { pending = null; }); return pending;
      },
      mutate: async function (path, method, body) {
        try {
          var result = await options.request(path, method, body), row = result && (result.matter || result);
          if (!row || typeof row.matter_id !== "string") { dirty = true; generation++; persist(true); emit(); throw new Error("Mutation response did not include a complete matter"); }
          merge([row]); error = null; persist(true); emit(); return result;
        } catch (failure) {
          // A rejected optimistic revision may mean another writer has changed the record.
          error = failure && failure.message ? failure.message : String(failure); dirty = true; generation++;
          persist(true); emit(); throw failure;
        }
      },
      get: function (id) { return all().find(function (r) { return r.matter_id === id; }) || null; },
      all: all,
      select: select,
      invalidate: function () { dirty = true; generation++; persist(true); emit(); },
      saveView: function (view) { savedView = copy(view || {}); writeStorage(viewKey, savedView, 128 * 1024); },
      view: function () { return copy(savedView); },
      dispose: function () { disposed = true; listeners.clear(); if (channel) channel.close(); if (root.removeEventListener) root.removeEventListener("storage", storageEvent); }
    };
  }
  root.LkaMatterStore = { create: create };
})(typeof window !== "undefined" ? window : globalThis);
