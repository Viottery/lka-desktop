(function () {
  'use strict';
  var chat = window.LkaChatContext, panel = document.getElementById('workspaceTransferPanel');
  if (!chat || !panel || typeof chat.getFileContext !== 'function' || !chat.get().workMode) return;
  var el = function (id) { return document.getElementById(id); };
  var queue = [], sequence = 0, uploadRunning = false, preparing = false;
  var MAX_UPLOAD = 64 * 1024 * 1024, MAX_DOWNLOAD = 128 * 1024 * 1024;
  var downloadIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function size(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
    if (bytes >= 1024) return Math.ceil(bytes / 1024) + ' KiB';
    return bytes + ' B';
  }
  function notice(text, error) {
    el('workspaceTransferStatus').textContent = text || '';
    el('workspaceTransferStatus').classList.toggle('error', !!error);
  }
  function sameView(a, b) { return a.sessionId === b.sessionId && a.workspace === b.workspace && a.path === b.path; }
  function sync() {
    var view = chat.getFileContext(), label = el('fileWorkspaceLabel');
    label.textContent = view.workspace || '本次任务的独立工作区'; label.title = view.workspace || '';
    el('fileUploadButton').disabled = preparing || !view.sessionId;
    el('fileUploadButton').textContent = preparing ? '准备目录…' : '上传到这里';
  }
  function stateLabel(item) {
    if (item.state === 'done') return item.message || (item.kind === 'upload' ? '已保存到电脑' : '已交给浏览器下载');
    if (item.state === 'failed') return item.message || '传输失败';
    if (item.state === 'canceled') return '已取消';
    if (item.state === 'queued') return '等待上传';
    if (item.percent === 100) return item.kind === 'upload' ? '正在保存…' : '正在准备下载…';
    return (item.kind === 'upload' ? '上传中' : '下载中') + (item.percent == null ? '…' : ' ' + item.percent + '%');
  }
  function render() {
    panel.hidden = !queue.length;
    var list = el('workspaceTransferList'); list.textContent = '';
    queue.forEach(function (item) {
      var row = document.createElement('article'); row.className = 'workspace-transfer-item ' + item.state;
      var name = document.createElement('strong'); name.textContent = item.filename; name.title = item.filename;
      var status = document.createElement('span'); status.textContent = size(item.bytes) + ' · ' + stateLabel(item);
      var destination = document.createElement('small');
      destination.textContent = (item.kind === 'upload' ? '到电脑：' : '从电脑：') + item.view.workspace + (item.view.path ? '/' + item.view.path : '');
      destination.title = destination.textContent;
      var info = document.createElement('div'); info.className = 'workspace-transfer-info'; info.appendChild(name); info.appendChild(status); info.appendChild(destination); row.appendChild(info);
      var running = item.state === 'running' || item.state === 'queued';
      var action = document.createElement('button'); action.type = 'button'; action.className = 'text-action';
      action.textContent = running ? '取消' : item.state === 'failed' || item.state === 'canceled' ? '重试' : '移除';
      action.addEventListener('click', function () {
        if (running) {
          item.state = 'canceled';
          if (item.xhr) item.xhr.abort();
        } else if (item.state === 'failed' || item.state === 'canceled') {
          if (!sameView(chat.getFileContext(), item.view)) { notice('请回到原会话和目录后再重试，文件会保留在传输列表中。', true); return; }
          notice(''); item.message = ''; item.percent = null;
          if (item.kind === 'upload') { item.state = 'queued'; drain(); }
          else run(item);
        } else queue = queue.filter(function (entry) { return entry !== item; });
        render();
      });
      row.appendChild(action);
      if (running) {
        var progress = document.createElement('progress'); progress.max = 100;
        if (item.percent != null) progress.value = item.percent;
        progress.setAttribute('aria-label', item.filename + '传输进度'); row.appendChild(progress);
      }
      list.appendChild(row);
    });
  }
  function url(item) {
    return '/pet/workspace-files/' + encodeURIComponent(item.view.sessionId) + '/' + item.kind
      + '?path=' + encodeURIComponent(item.kind === 'upload' ? item.view.path : item.filePath)
      + '&workspace=' + encodeURIComponent(item.view.workspace);
  }
  function errorMessage(status, detail) {
    var known = { 403: '当前地址没有文件访问权限。', 404: '会话、目录或文件已不存在。', 409: '工作区已改变或此目录无法在前端电脑上访问，请刷新后重试。',
      413: '文件超过传输大小限制。', 422: '文件名或目录不受支持，请检查后重试。', 502: '后端暂时无法连接，请稍后重试。', 503: '电脑暂时无法读写这个目录。', 507: '电脑存储空间不足。' };
    return known[status] || (status ? '传输失败（HTTP ' + status + '）。' : detail || '连接中断，请检查网络后重试。');
  }
  async function run(item) {
    if (item.state === 'canceled') return;
    item.state = 'running'; item.percent = null; render();
    var xhr = new XMLHttpRequest(); item.xhr = xhr;
    await new Promise(function (resolve) {
      var settled = false;
      function done(state, message) {
        if (settled) return; settled = true;
        item.xhr = null; item.state = state; item.message = message || ''; render(); resolve();
      }
      xhr.open(item.kind === 'upload' ? 'POST' : 'GET', url(item), true);
      xhr.timeout = 10 * 60 * 1000;
      xhr.responseType = item.kind === 'download' ? 'blob' : 'json';
      xhr.setRequestHeader('Accept', item.kind === 'download' ? 'application/octet-stream' : 'application/json');
      if (item.kind === 'upload') {
        xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.setRequestHeader('X-Filename', encodeURIComponent(item.filename));
        xhr.upload.onprogress = function (event) { item.percent = event.lengthComputable ? Math.min(100, Math.round(event.loaded / event.total * 100)) : null; render(); };
      } else xhr.onprogress = function (event) {
        if (event.loaded > MAX_DOWNLOAD) { done('failed', '文件超过 128 MiB 下载限制。'); xhr.abort(); return; }
        item.percent = event.lengthComputable ? Math.min(100, Math.round(event.loaded / event.total * 100)) : null; render();
      };
      xhr.onload = function () {
        if (xhr.status < 200 || xhr.status >= 300) { done('failed', errorMessage(xhr.status)); return; }
        if (item.kind === 'upload') {
          var result = xhr.response;
          if (!result || typeof result.filename !== 'string' || typeof result.path !== 'string') { done('failed', '电脑未返回有效的保存结果，请刷新文件列表后确认。'); return; }
          item.filename = result.filename;
          done('done', result.renamed ? '已另存为 ' + result.filename : '已保存到电脑');
          chat.refreshWorkspaceFiles(item.view);
        } else {
          if (!(xhr.response instanceof Blob)) { done('failed', '下载未返回有效的文件。'); return; }
          var blobUrl = URL.createObjectURL(xhr.response), link = document.createElement('a');
          link.href = blobUrl; link.download = item.filename; link.hidden = true; document.body.appendChild(link); link.click(); link.remove();
          window.setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60000);
          done('done');
        }
      };
      xhr.onerror = function () { done('failed', errorMessage(0)); };
      xhr.ontimeout = function () { done('failed', '传输超时，可以重试。'); };
      xhr.onabort = function () { done('canceled'); };
      try { xhr.send(item.kind === 'upload' ? item.file : null); } catch (error) { done('failed', errorMessage(0)); }
    });
  }
  async function drain() {
    if (uploadRunning) return;
    uploadRunning = true;
    try {
      var item;
      while ((item = queue.find(function (entry) { return entry.kind === 'upload' && entry.state === 'queued'; }))) await run(item);
    } finally { uploadRunning = false; }
  }
  function newItem(kind, filename, bytes, view) { return { id: ++sequence, kind: kind, filename: filename, bytes: bytes, view: Object.assign({}, view), state: 'queued', percent: null }; }
  el('fileChooseWorkspaceButton').addEventListener('click', function () { if (window.LkaWorkspacePicker) window.LkaWorkspacePicker.open(); });
  el('fileUploadButton').addEventListener('click', function () { notice(''); el('workspaceUploadInput').click(); });
  el('workspaceUploadInput').addEventListener('change', async function () {
    var files = Array.prototype.slice.call(this.files || []); this.value = '';
    if (!files.length) return;
    var view = chat.getFileContext();
    var oversized = files.filter(function (file) { return file.size > MAX_UPLOAD; });
    files = files.filter(function (file) { return file.size <= MAX_UPLOAD; });
    if (oversized.length) notice('这些文件超过 64 MiB，未上传：' + oversized.map(function (file) { return file.name; }).join('、'), true);
    if (!files.length || preparing) return;
    preparing = true; sync();
    try {
      var backendSessionId = await chat.prepareWorkspace(view.sessionId);
      var current = chat.getFileContext();
      if (current.sessionId !== backendSessionId || current.path !== view.path || view.workspace && current.workspace !== view.workspace) throw new Error('会话或目录已切换，请在目标目录重新选择文件。');
      view = current;
      files.forEach(function (file) { var item = newItem('upload', file.name, file.size, view); item.file = file; queue.push(item); });
      render(); drain();
    } catch (error) { notice(error.message || '工作区准备失败，请稍后重试。', true); }
    finally { preparing = false; sync(); }
  });
  el('clearWorkspaceTransfersButton').addEventListener('click', function () { queue = queue.filter(function (item) { return item.state !== 'done'; }); render(); });
  window.addEventListener('lka-session-context', sync);
  window.addEventListener('lka-workspace-files', sync);
  window.LkaWorkspaceFiles = {
    downloadButton: function (entry, view) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'file-download-button';
      button.innerHTML = downloadIcon; button.setAttribute('aria-label', '下载 ' + entry.name); button.title = '下载到这台设备';
      button.disabled = Number(entry.size_bytes) > MAX_DOWNLOAD;
      if (button.disabled) button.title = '文件超过 128 MiB 下载限制';
      button.addEventListener('click', function () {
        notice('');
        var item = newItem('download', String(entry.name), Number(entry.size_bytes) || 0, view); item.filePath = entry.path;
        queue.push(item); run(item);
      });
      return button;
    }
  };
  sync();
}());
