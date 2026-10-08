(function () {
  'use strict';
  var MAX_BYTES = 10 * 1024 * 1024, MAX_SOURCE_BYTES = 20 * 1024 * 1024, MAX_ATTACHMENTS = 4, MAX_PIXELS = 4000000, MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
  var types = ['image/png', 'image/jpeg', 'image/webp'];
  var drafts = Object.create(null), items = Object.create(null), metadataCache = Object.create(null);
  var documentExtensions = ['.txt', '.text', '.md', '.pdf', '.docx', '.pptx', '.xlsx', '.xls', '.html', '.htm', '.epub', '.csv', '.json', '.xml', '.msg'];
  var catalogPromise = null;
  function sendable(item) { return item.kind !== 'file' && !item.cache_id; }
  function kindOf(value) { return value.kind === 'document' ? 'document' : value.kind === 'image' || types.indexOf(value.media_type) >= 0 ? 'image' : 'unknown'; }
  function warnings(value) { var data = value && value.extraction && value.extraction.warnings; return (Array.isArray(data) ? data : []).slice(0, 8).map(function (text) { return String(text).slice(0, 300); }); }
  function sizeLabel(size) { return size >= 1048576 ? (size / 1048576).toFixed(1) + ' MiB' : Math.max(1, Math.ceil(size / 1024)) + ' KiB'; }
  function ensureCatalog() {
    if (catalogPromise || !context().backend) return catalogPromise;
    catalogPromise = fetch(base() + '/knowledge/file-types', { headers: { Accept: 'application/json' } }).then(function (response) {
      if (!response.ok) return null; return response.json();
    }).then(function (data) {
      if (!data || !Array.isArray(data.file_types)) return;
      documentExtensions = data.file_types.filter(function (item) { return item.index_supported === true; }).reduce(function (all, item) {
        return all.concat((Array.isArray(item.extensions) ? item.extensions : []).filter(function (extension) { return /^\.[a-z0-9]{1,12}$/.test(extension); }));
      }, []);
      fileInput.accept = ['.png', '.jpg', '.jpeg', '.webp'].concat(documentExtensions).join(',');
    }).catch(function () {});
    return catalogPromise;
  }
  var storageKey = 'lka-composer-attachments-v1';
  var panel = document.getElementById('composerAttachments'), notice = document.getElementById('attachmentNotice');
  var uploadButton = document.getElementById('uploadAttachmentButton'), menu = document.getElementById('attachmentMenu');
  var imageInput = document.getElementById('imageFileInput'), fileInput = document.getElementById('cachedFileInput');
  var lastSession = '', noticeSession = '', lastNotice = '';
  function context() { return window.LkaChatContext ? window.LkaChatContext.get() : {}; }
  function activeId() { return context().sessionId || ''; }
  function list(id) { return drafts[id] || (drafts[id] = []); }
  function id() { return 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  function normalize(values) {
    if (!Array.isArray(values)) return [];
    return values.slice(0, MAX_ATTACHMENTS).map(function (value) {
      if (!value || typeof value !== 'object') return null;
      var attachmentId = /^att_[0-9a-f]{32}$/.test(value.attachment_id || '') ? value.attachment_id : '';
      var localId = /^img-[a-z0-9-]{1,80}$/.test(value.local_id || '') ? value.local_id : '';
      if (!attachmentId && !localId) return null;
      return { attachment_id: attachmentId, local_id: localId, filename: String(value.filename || '附件').slice(0, 120),
        kind: kindOf(value), media_type: String(value.media_type || '').slice(0, 128), size_bytes: Math.max(0, Number(value.size_bytes) || 0),
        total_chars: Math.max(0, Number(value.total_chars) || 0), extraction: { warnings: warnings(value) } };
    }).filter(Boolean);
  }
  function fromIds(ids) { return normalize((Array.isArray(ids) ? ids : []).map(function (value) { return { attachment_id: value, filename: '附件' }; })); }
  function persist() {
    var saved = {};
    Object.keys(drafts).slice(-24).forEach(function (sessionId) {
      var values = list(sessionId).filter(function (item) { return item.attachment_id || item.cache_id; }).map(function (item) {
        return { attachment_id: item.attachment_id || '', cache_id: item.cache_id || '', filename: item.filename,
          media_type: item.media_type, size_bytes: item.size_bytes, kind: item.kind };
      });
      if (values.length) saved[sessionId] = values;
    });
    try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch (ignored) {}
  }
  try {
    var stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
    Object.keys(stored).slice(-24).forEach(function (sessionId) {
      if (!Array.isArray(stored[sessionId])) return;
      drafts[sessionId] = stored[sessionId].slice(0, 8).filter(function (item) {
        return /^att_[0-9a-f]{32}$/.test(item.attachment_id || '') || /^(?:file_)?[0-9a-f]{32}$/.test(item.cache_id || '');
      }).map(function (value) {
        var item = Object.assign({}, value, { kind: value.cache_id ? 'file' : kindOf(value), local_id: id(), sessionId: sessionId, status: value.cache_id ? '旧缓存 · 重新选择后发送' : '待发送' });
        items[item.local_id] = item; return item;
      });
    });
  } catch (ignored) {}
  function say(message, error, sessionId) {
    noticeSession = sessionId || activeId(); lastNotice = String(message || '');
    if (noticeSession !== activeId()) return;
    notice.textContent = lastNotice; notice.classList.toggle('error', !!error); notice.hidden = !lastNotice;
  }
  // Default desktop/Java and mobile route images through the same fixed local gateway.
  // Custom backend targets retain their own URL instead of silently mixing sessions.
  function base() {
    var backend = context().backend || window.LKA_BACKEND_URL || '';
    try {
      var target = new URL(backend, window.location.href);
      if (['127.0.0.1', 'localhost', '[::1]'].indexOf(target.hostname) >= 0 && target.port === '8765' && !target.pathname.replace(/\/$/, '')) return window.location.origin + '/workbench';
    } catch (ignored) {}
    return backend.replace(/\/$/, '');
  }
  function rawUrl(sessionId, attachmentId) { return base() + '/sessions/' + encodeURIComponent(sessionId) + '/attachments/' + encodeURIComponent(attachmentId) + '/raw'; }
  function statusError(response, data) {
    var detail = typeof data.detail === 'string' ? data.detail : '';
    var explanations = {
      'This document file type is not supported.': '暂不支持这个文件类型，请选择文档或图片。',
      'The document content type does not match its file type.': '文件内容类型和名称不匹配，请检查格式。',
      'Binary source does not match declared text type.': '这不是有效的文字文件，请按真实文件格式上传。',
      'The document is unreadable or contains no extractable text.': '文档无法解析，可能已加密、损坏或没有可提取的文字。',
      'The PDF is unreadable or has no extractable text. Scanned PDFs require OCR.': 'PDF 没有可提取的文字，可能是扫描件；请先 OCR 或改为图片上传。',
      'The document contains too much extraction metadata.': '文档结构过于复杂，请拆分后上传。',
      'Document exceeds the 64 MiB upload limit.': '文档超过 64 MiB，请拆分或缩小后上传。',
      'Unsupported attachment file type.': '暂不支持这个文件类型，请选择文档或图片。',
      'Document media type does not match its filename.': '文件内容类型和名称不匹配，请检查格式。',
      'Invalid, encrypted or unreadable document, or no extractable text.': '文档无法解析，可能已加密、损坏或没有可提取的文字。',
      'Invalid, encrypted or unreadable document, or no extractable text. PDF text-layer extraction only; scanned PDFs require separate OCR.': 'PDF 没有可提取的文字，可能是扫描件；请先 OCR 或改为图片上传。',
      'Image exceeds the 10 MiB upload limit.': '图片超过 10 MiB，请缩小后再上传。',
      'Image exceeds the four million pixel limit.': '图片超过 400 万像素，请缩小后再上传。',
      'Animated or multi-frame images are not supported.': '当前只支持静态图片，请选择一张单帧图片。',
      'Choose a PNG, JPEG, or WebP image.': '请选择 PNG、JPEG 或 WebP 图片。',
      'The selected image does not match its file type.': '图片内容和扩展名不匹配，请重新导出图片。',
      'The selected image is invalid or corrupt.': '图片文件损坏或无法读取，请换一张图片。',
      'The image filename is invalid.': '图片名称无效，请重命名后上传。',
      'The image filename is too long.': '图片名称太长，请缩短名称后上传。'
    };
    if (explanations[detail]) return explanations[detail];
    if (detail && detail !== 'workbench_request_failed') return detail;
    if (response.status === 413) return '附件太大：文档最多 64 MiB，图片上传最多 10 MiB、400 万像素。';
    if (response.status === 415) return '请选择支持的文档格式，或 PNG、JPEG、WebP 图片。';
    if (response.status === 422) return '附件无法使用，请检查文件格式、加密状态和图片模型能力。';
    if (response.status === 404) return '会话或附件不存在，请确认后端已更新并重新选择文件。';
    if (response.status === 403) return '当前访问地址未获准上传，请检查前端的远程访问配置。';
    return '上传失败（HTTP ' + response.status + '），请重试。';
  }
  async function upload(item, sessionId) {
    if (item.attachment_id) return item;
    if (!item.file) throw new Error('这个附件的本地草稿已失效，请重新选择。');
    item.status = item.kind === 'document' ? '上传并解析…' : '上传中…'; refresh();
    // JavaFX 21's HTTP2Loader cannot open the file-backed body produced for
    // an in-memory File. Send byte-array form data in the native WebView instead.
    // Ordinary browsers keep their streaming File upload to avoid a second copy.
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer, response, data;
    var timeout = item.kind === 'document' ? 240000 : 60000;
    try {
      var result = await Promise.race([
        (async function () {
          var body = item.file;
          if (window.petBridge) body = await new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = function () { reject(new Error('无法读取附件，请重新选择。')); };
            reader.onabort = function () { reject(new Error('附件读取已取消，请重试。')); };
            reader.readAsArrayBuffer(body);
          });
          var response = await fetch(base() + '/sessions/' + encodeURIComponent(sessionId) + '/attachments', {
            method: 'POST', headers: { 'Content-Type': item.media_type, 'X-Filename': encodeURIComponent(item.filename) },
            body: body, signal: controller ? controller.signal : undefined
          });
          return { response: response, data: await response.json().catch(function () { return {}; }) };
        }()),
        new Promise(function (_, reject) { timer = setTimeout(function () {
          reject(new Error('附件上传超时，文件已保留，请重试。'));
          if (controller) controller.abort();
        }, timeout); })
      ]);
      response = result.response; data = result.data;
    } finally { clearTimeout(timer); }
    if (!response.ok) throw new Error(statusError(response, data));
    if (!/^att_[0-9a-f]{32}$/.test(data.attachment_id || '')) throw new Error('附件上传结果不完整，请重试。');
    Object.assign(item, data); item.kind = kindOf(item); item.status = warnings(item).length ? '待发送 · 有解析提示' : '待发送';
    metadataCache[sessionId + '/' + item.attachment_id] = normalize([item])[0]; item.sessionId = sessionId;
    if (item.preview) URL.revokeObjectURL(item.preview);
    delete item.preview; delete item.file;
    if (item.errorMessage && lastNotice === item.errorMessage) say('', false, item.sessionId);
    item.errorMessage = '';
    persist(); refresh(); return item;
  }
  function refresh() {
    ensureCatalog();
    var sessionId = activeId();
    if (sessionId !== lastSession) { lastSession = sessionId; notice.hidden = noticeSession !== sessionId || !lastNotice; }
    panel.textContent = '';
    var values = list(sessionId); panel.hidden = !values.length;
    values.forEach(function (item) {
      var card = document.createElement('div'); card.className = 'attachment-card' + (item.kind !== 'image' ? ' attachment-file' : '');
      if (item.kind === 'image') {
        var image = document.createElement('img'); image.alt = item.filename;
        image.src = item.preview || (item.attachment_id ? rawUrl(sessionId, item.attachment_id) : '');
        card.appendChild(image);
      }
      if (item.kind === 'document') { var icon = document.createElement('span'); icon.className = 'attachment-file-type'; icon.textContent = (item.filename.split('.').pop() || '文件').toUpperCase().slice(0, 6); card.appendChild(icon); }
      var name = document.createElement('strong'); name.textContent = item.filename; name.title = item.filename; card.appendChild(name);
      var status = document.createElement('small'); status.textContent = (item.size_bytes ? sizeLabel(item.size_bytes) + ' · ' : '') + (item.status || '待发送'); status.title = warnings(item).join('\n'); card.appendChild(status);
      var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove'; remove.textContent = '×';
      remove.setAttribute('aria-label', '移除 ' + item.filename); remove.title = '从本次输入移除';
      remove.addEventListener('click', function () { drafts[sessionId] = list(sessionId).filter(function (value) { return value !== item; }); persist(); refresh(); });
      card.appendChild(remove); panel.appendChild(card);
    });
    window.dispatchEvent(new CustomEvent('lka-attachments-changed'));
  }
  function fileType(file) {
    if (types.indexOf(file.type) >= 0) return file.type;
    var extension = (file.name || '').split('.').pop().toLowerCase();
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[extension] || '';
  }
  async function normalizeImage(file, type) {
    // Phone camera images often exceed the backend pixel bound. Resize once before
    // caching; never turn animations into still images merely to bypass validation.
    var url = URL.createObjectURL(file);
    try {
      var image = await new Promise(function (resolve, reject) { var value = new Image(); value.onload = function () { resolve(value); }; value.onerror = function () { reject(new Error('图片无法打开，请换一张有效的图片。')); }; value.src = url; });
      if (image.naturalWidth * image.naturalHeight <= MAX_PIXELS && file.size <= MAX_BYTES) return file;
      if (type === 'image/webp') throw new Error('WebP 需不超过 400 万像素和 10 MiB，请缩小后再上传。');
      if (type === 'image/png') {
        var bytes = await new Promise(function (resolve, reject) { var reader = new FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = function () { reject(new Error('无法读取图片。')); }; reader.readAsArrayBuffer(file); });
        var view = new DataView(bytes), offset = 8;
        while (offset + 12 <= view.byteLength) {
          var length = view.getUint32(offset), chunk = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
          if (chunk === 'acTL') throw new Error('当前只支持静态图片，请选择一张单帧图片。');
          if (length > view.byteLength - offset - 12) break;
          offset += length + 12;
        }
      }
      var ratio = Math.min(1, Math.sqrt(MAX_PIXELS / (image.naturalWidth * image.naturalHeight)));
      var canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.floor(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.floor(image.naturalHeight * ratio));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, type, 0.9); });
      if (!blob) throw new Error('图片缩放失败，请手动缩小后上传。');
      return new File([blob], file.name, { type: type });
    } finally { URL.revokeObjectURL(url); }
  }
  async function addImage(file, sessionId) {
    sessionId = sessionId || activeId();
    if (!sessionId) { say('页面尚未准备好，请稍后选择图片。', true); return false; }
    while (aliases[sessionId]) sessionId = aliases[sessionId];
    var type = fileType(file);
    if (list(sessionId).filter(sendable).length >= MAX_ATTACHMENTS) { say('每条消息最多发送 4 个附件（图片和文件合计）。', true, sessionId); return false; }
    if (!type) { say('图片支持 PNG、JPEG 和 WebP。其他文件请用“上传文件”。', true, sessionId); return false; }
    if (!file.size || file.size > MAX_SOURCE_BYTES) { say('原始图片最多 20 MiB，请缩小后再上传。', true, sessionId); return false; }
    var item = { local_id: id(), filename: file.name || '粘贴的图片.png', media_type: type, size_bytes: file.size,
      kind: 'image', file: file, preview: URL.createObjectURL(file), sessionId: sessionId, status: '读取图片…' };
    items[item.local_id] = item; list(sessionId).push(item); refresh(); say('', false, sessionId);
    item.ready = (async function () {
      var prepared;
      try {
        prepared = await normalizeImage(file, type);
        if (prepared.size > MAX_BYTES) throw new Error('缩小后的图片仍超过 10 MiB，请降低图片质量后重试。');
      } catch (error) {
        item.validationError = error.message; item.status = '图片无法使用';
        drafts[item.sessionId] = list(item.sessionId).filter(function (value) { return value !== item; });
        say(error.message, true, item.sessionId); refresh(); return item;
      }
      if (prepared !== file) {
        URL.revokeObjectURL(item.preview); item.preview = URL.createObjectURL(prepared);
        item.file = prepared; item.size_bytes = prepared.size;
        say('图片已压缩至上传限制以内，正在上传到电脑。', false, item.sessionId);
      }
      try {
        var boundId = await window.LkaChatContext.prepareAttachments(item.sessionId);
        return await upload(item, boundId);
      } catch (error) {
        item.errorMessage = error.message; item.status = '上传失败 · 发送时重试'; say(error.message || '图片上传失败。', true, item.sessionId); refresh(); return item;
      }
    }());
    return true;
  }
  async function addFile(file, sessionId) {
    if (fileType(file)) return addImage(file, sessionId);
    sessionId = sessionId || activeId();
    while (aliases[sessionId]) sessionId = aliases[sessionId];
    if (!sessionId) { say('页面尚未准备好，请稍后选择文件。', true); return false; }
    if (list(sessionId).filter(sendable).length >= MAX_ATTACHMENTS) { say('每条消息最多发送 4 个附件（图片和文件合计）。', true, sessionId); return false; }
    if (!file.size || file.size > MAX_DOCUMENT_BYTES) { say('单个文档需不超过 64 MiB。', true, sessionId); return false; }
    var item = { local_id: id(), kind: 'document', filename: file.name || '文件', size_bytes: file.size, media_type: 'application/octet-stream',
      file: file, sessionId: sessionId, status: '准备上传…' };
    items[item.local_id] = item; list(sessionId).push(item); refresh(); say('', false, sessionId);
    item.ready = (async function () {
      await ensureCatalog();
      var extension = '.' + item.filename.split('.').pop().toLowerCase();
      if (documentExtensions.indexOf(extension) < 0) {
        item.validationError = '暂不支持这个文件类型。可上传文档、表格、PDF 或文字文件；旧版 DOC/PPT 请先转换格式。';
        drafts[item.sessionId] = list(item.sessionId).filter(function (value) { return value !== item; });
        say(item.validationError, true, item.sessionId); refresh(); return item;
      }
      try { var boundId = await window.LkaChatContext.prepareAttachments(item.sessionId); return await upload(item, boundId); }
      catch (error) { item.errorMessage = error.message; item.status = '上传失败 · 发送时重试'; say(error.message || '文件上传失败。', true, item.sessionId); refresh(); return item; }
    }());
    return true;
  }
  function capture(sessionId) {
    var selected = list(sessionId).filter(sendable).slice(0, MAX_ATTACHMENTS);
    drafts[sessionId] = list(sessionId).filter(function (item) { return selected.indexOf(item) < 0; }); persist(); refresh(); return selected;
  }
  async function prepare(selected, sessionId) {
    for (var i = 0; i < selected.length; i += 1) {
      var item = items[selected[i].local_id] || selected[i];
      if (item.ready) await item.ready;
      if (item.validationError) throw new Error(item.validationError);
      await upload(item, sessionId); Object.assign(selected[i], normalize([item])[0]);
    }
    return selected.map(function (item) { return item.attachment_id; });
  }
  var aliases = Object.create(null);
  function rekey(oldId, newId) {
    if (oldId === newId) return;
    aliases[oldId] = newId;
    Object.keys(metadataCache).forEach(function (key) { if (key.indexOf(oldId + '/') === 0) { metadataCache[newId + key.slice(oldId.length)] = metadataCache[key]; delete metadataCache[key]; } });
    drafts[newId] = (drafts[newId] || []).concat(drafts[oldId] || []); delete drafts[oldId];
    Object.keys(items).forEach(function (key) { if (items[key].sessionId === oldId) items[key].sessionId = newId; });
    persist(); refresh();
  }
  function restore(selected, sessionId) {
    var deferred = false;
    selected.forEach(function (value) {
      var item = items[value.local_id] || value;
      if (item.validationError || list(sessionId).some(function (existing) { return existing.local_id === item.local_id; })) return;
      if (list(sessionId).filter(sendable).length >= MAX_ATTACHMENTS) { deferred = true; return; }
      list(sessionId).push(item);
    });
    if (deferred) say('原附件保留在失败任务中。先处理当前附件草稿，再重新编辑该任务。', false, sessionId);
    persist(); refresh();
  }
  function queueRefs(sessionId, refs) { restore(normalize(refs).map(function (value) { return items[value.local_id] || Object.assign({}, value, { kind: kindOf(value), status: '待发送', local_id: id(), sessionId: sessionId }); }), sessionId); }
  function metadata(sessionId, attachmentId) {
    var key = sessionId + '/' + attachmentId;
    if (metadataCache[key]) return Promise.resolve(metadataCache[key]);
    if (metadataRequests[key]) return metadataRequests[key];
    metadataRequests[key] = fetch(base() + '/sessions/' + encodeURIComponent(sessionId) + '/attachments/' + encodeURIComponent(attachmentId), { headers: { Accept: 'application/json' } }).then(function (response) {
      if (!response.ok) throw new Error('附件暂时不可用'); return response.json();
    }).then(function (value) {
      var result = normalize([value])[0]; if (!result) throw new Error('附件信息不完整');
      metadataCache[key] = result; return result;
    }).finally(function () { delete metadataRequests[key]; });
    return metadataRequests[key];
  }
  var metadataRequests = Object.create(null), lazyMetadata = null;
  if (window.IntersectionObserver) lazyMetadata = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) { if (entry.isIntersecting && entry.target.loadMetadata) { lazyMetadata.unobserve(entry.target); entry.target.loadMetadata(); } });
  }, { root: document.getElementById('messages'), rootMargin: '160px' });
  function renderHistory(bubble, refs, sessionId) {
    var values = normalize(refs); if (!values.length) return;
    var row = document.createElement('div'); row.className = 'message-images';
    values.forEach(function (value, index) {
      var local = items[value.local_id], link = document.createElement('a');
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      function paint(data) {
        if (data) Object.assign(value, data);
        link.textContent = ''; var kind = kindOf(value), source = value.attachment_id ? rawUrl(sessionId, value.attachment_id) : local && local.preview;
        link.className = 'message-image' + (kind !== 'image' ? ' message-document' : '');
        link.setAttribute('aria-label', (kind === 'image' ? '查看图片：' : '下载文件：') + value.filename);
        if (source) link.href = source;
        var name = document.createElement('span'); name.textContent = value.filename || '附件';
        if (kind === 'image' && source) {
          link.removeAttribute('download'); var image = document.createElement('img'); image.src = source; image.alt = name.textContent; image.loading = 'lazy';
          image.addEventListener('error', function () { link.classList.add('image-unavailable'); name.textContent = '图片暂时不可用 · 点击重试'; }); link.appendChild(image);
        } else {
          link.setAttribute('download', value.filename || '附件'); var icon = document.createElement('b'); icon.className = 'attachment-file-type'; icon.textContent = kind === 'unknown' ? '文件' : (value.filename.split('.').pop() || '文件').toUpperCase().slice(0, 6); link.appendChild(icon);
          var detail = document.createElement('small'); detail.textContent = kind === 'unknown' ? '正在读取附件信息…' : sizeLabel(value.size_bytes) + ' · 下载原文件'; link.appendChild(detail);
        }
        link.appendChild(name); link.title = warnings(value).join('\n');
        if (warnings(value).length) { var hint = document.createElement('small'); hint.className = 'attachment-extraction-hint'; hint.textContent = '部分内容可能未提取'; link.appendChild(hint); }
      }
      paint(metadataCache[sessionId + '/' + value.attachment_id]);
      if (kindOf(value) === 'unknown' && value.attachment_id) {
        link.loadMetadata = function () { metadata(sessionId, value.attachment_id).then(function (result) {
          if (!link.isConnected) return; paint(result); if (refs && refs[index]) Object.assign(refs[index], result);
        }).catch(function () { if (link.isConnected) { var detail = link.querySelector('small'); if (detail) detail.textContent = '附件暂不可用 · 点击重试'; } }); };
        if (lazyMetadata) lazyMetadata.observe(link); else setTimeout(link.loadMetadata, 0);
      }
      row.appendChild(link);
    });
    bubble.appendChild(row);
    if (bubble.querySelector('.message-content') && /^\[(Image|File) input\]$/.test(bubble.querySelector('.message-content').textContent)) bubble.querySelector('.message-content').hidden = true;
  }
  function setMenu(open) { menu.hidden = !open; uploadButton.setAttribute('aria-expanded', String(open)); }
  uploadButton.addEventListener('click', function () { setMenu(menu.hidden); });
  document.getElementById('chooseImageButton').addEventListener('click', function () { setMenu(false); imageInput.click(); });
  document.getElementById('chooseFileButton').addEventListener('click', function () { setMenu(false); fileInput.click(); });
  document.addEventListener('click', function (event) { if (!event.target.closest('.composer-upload')) setMenu(false); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !menu.hidden) { setMenu(false); uploadButton.focus(); } });
  imageInput.addEventListener('change', function () { var sessionId = activeId(), files = Array.from(imageInput.files || []); imageInput.value = ''; files.forEach(function (file) { addImage(file, sessionId); }); });
  fileInput.addEventListener('change', function () { var sessionId = activeId(), files = Array.from(fileInput.files || []); fileInput.value = ''; files.forEach(function (file) { addFile(file, sessionId); }); });
  document.getElementById('questionInput').addEventListener('paste', function (event) {
    var data = event.clipboardData; if (!data) return;
    var files = Array.from(data.files || []);
    if (!files.length) files = Array.from(data.items || []).filter(function (item) { return item.kind === 'file'; }).map(function (item) { return item.getAsFile(); }).filter(Boolean);
    if (!files.length) return;
    event.preventDefault(); var sessionId = activeId(); files.forEach(function (file) { addFile(file, sessionId); });
    // Some clipboard formats carry a user caption with the bitmap. Preserve text.
    var text = data.getData('text/plain'), input = event.target;
    if (text && !(/^(file:\/\/|[a-z]:[\\\/])/i.test(text.trim()))) { input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  window.addEventListener('lka-session-context', refresh);
  window.addEventListener('beforeunload', function () { Object.keys(items).forEach(function (key) { if (items[key].preview) URL.revokeObjectURL(items[key].preview); }); });
  window.LkaImageComposer = {
    normalize: normalize, fromIds: fromIds, refresh: refresh, rekey: rekey, capture: capture, prepare: prepare, restore: restore,
    queueRefs: queueRefs, renderHistory: renderHistory,
    hasDraft: function (sessionId) { return list(sessionId).length > 0; },
    hasImages: function (sessionId) { return list(sessionId).some(sendable); },
    hasAttachments: function (sessionId) { return list(sessionId).some(sendable); },
    hasDocuments: function (sessionId) { return list(sessionId).some(function (item) { return item.kind === 'document'; }); },
    explainEmpty: function () { if (list(activeId()).some(function (item) { return item.kind === 'file'; })) say('这是旧版缓存文件，请重新选择文件后发送。', false); },
    errorText: function (message) { say(message, true); },
    addNativeFile: async function (filename, mediaType, encoded, originSessionId) {
      var sessionId = originSessionId || activeId();
      if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4) { say('文件超过 64 MiB，请缩小后再粘贴。', true); return false; }
      try { var bytes = atob(encoded), raw = new Uint8Array(bytes.length); for (var i = 0; i < bytes.length; i++) raw[i] = bytes.charCodeAt(i);
        return await addFile(new File([raw], filename, { type: mediaType }), sessionId);
      } catch (error) { say('无法读取粘贴的附件，请重新复制。', true, sessionId); return false; }
    }
  };
  window.LkaImageComposer.addNativeImage = window.LkaImageComposer.addNativeFile;
  fileInput.accept = ['.png', '.jpg', '.jpeg', '.webp'].concat(documentExtensions).join(',');
  setTimeout(ensureCatalog, 0);
}());
