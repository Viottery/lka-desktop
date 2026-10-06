/* Shared local transport. QQ/backend control credentials never enter the page. */
(function () {
  'use strict';
  const pending = new Map(), controllers = new Set();
  const nonce = 'messageui' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  let serial = 0;
  const previous = window.__lkaMemoryBridgeReceive;
  function decode(code, text) {
    let value;
    try { value = JSON.parse(text || '{}'); } catch (_) { value = {}; }
    if (code < 200 || code >= 300) {
      const messages = {0:'连接已中断，请检查本机服务。', 400:'请检查输入和消息组合。', 401:'消息控制尚未配对，请在前端本机配置中设置控制凭据。',
        403:'这个会话尚未授权此操作，或页面访问受限。', 404:'内容当前不可访问，或运行中的服务尚未更新。',
        409:'版本或证据已变化。你的编辑已保留，请刷新后重新核对。', 413:'文件或请求超出大小限制。', 415:'文件格式不支持，请选择 PNG、JPEG、GIF、WebP、MP4 或 WebM。',
        422:'输入不符合接口要求，请检查字段和时间范围。', 502:'QQ 或后端暂时无法完成请求。', 503:'功能未启用或服务未就绪，请检查本机配置。', 507:'本机存储已达到限额。'};
      const detail = {messaging_disabled:'QQ 消息插件未启用，仍可查看已记录的历史。', sending_disabled:'本机发送总开关未启用。',
        conversation_not_allowed:'请先为这个 QQ 会话授予本机接收或发送权限。', video_must_be_standalone:'视频需要单独发送。',
        media_kind_mismatch:'附件类型与上传类型不匹配。', media_unavailable:'本机附件已不可用，请重新上传。',
        media_download_failed:'附件未能缓存，原消息仍保留。', idempotency_conflict:'本次消息标识已用于其他内容，请先核对回执。'};
      const error = new Error(detail[value.detail] || messages[code] || ('请求失败（HTTP ' + code + '）。'));
      error.status = code; error.code = typeof value.detail === 'string' ? value.detail : ''; throw error;
    }
    return value;
  }
  window.__lkaMemoryBridgeReceive = function (id, code, body) {
    const item = pending.get(id);
    if (!item) { if (previous) previous(id, code, body); return; }
    pending.delete(id); clearTimeout(item.timer);
    try { item.resolve(decode(code, body)); } catch (error) { item.reject(error); }
  };
  async function request(path, method, body) {
    method = method || 'GET';
    if (!path.startsWith('/plugins/message-reading/') && !path.startsWith('/plugins/qq-ui/')) throw new Error('消息请求地址不受支持。');
    const timeoutMs = method === 'POST' && path.startsWith('/plugins/qq-ui/') ? 90000 : 30000;
    if (window.petBridge && typeof window.petBridge.requestMemory === 'function') {
      return new Promise((resolve, reject) => {
        const id = 'memory-' + nonce + '-' + (++serial);
        const timer = setTimeout(() => { pending.delete(id); const e = new Error('请求超时。发送请求请查询回执，不要直接重发。'); e.status = 0; reject(e); }, timeoutMs);
        pending.set(id, {resolve, reject, timer});
        try { window.petBridge.requestMemory(JSON.stringify({id, path, method, body:body === undefined ? '' : JSON.stringify(body)})); }
        catch (_) { clearTimeout(timer); pending.delete(id); reject(new Error('桌面通信未就绪，请更新并重启桌宠。')); }
      });
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    controllers.add(controller);
    try {
      const response = await fetch(new URL(path, window.location.href), {method, credentials:'omit', cache:'no-store', redirect:'error',
        headers:{Accept:'application/json', 'Content-Type':'application/json', ...(method === 'GET' ? {} : {'X-LKA-UI-Intent':'1'})},
        body:body === undefined ? undefined : JSON.stringify(body), signal:controller.signal});
      return decode(response.status, await response.text());
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) { const e = new Error('连接中断或超时。发送请求请查询回执，不要直接重发。'); e.status = 0; throw e; }
      throw error;
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  function upload(kind, file, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', new URL('/plugins/qq-ui/media/' + kind, window.location.href).href);
      xhr.timeout = 90000; xhr.withCredentials = false;
      xhr.setRequestHeader('Content-Type','application/octet-stream'); xhr.setRequestHeader('X-LKA-UI-Intent','1');
      xhr.upload.onprogress = event => { if (progress && event.lengthComputable) progress(event.loaded / event.total); };
      xhr.onload = () => { try { resolve(decode(xhr.status, xhr.responseText)); } catch (e) { reject(e); } };
      xhr.onerror = xhr.ontimeout = () => reject(new Error('附件上传未完成，请检查本机连接。'));
      xhr.send(file);
    });
  }
  window.LkaMessageApi = {
    backend:(path, method, value) => request('/plugins/message-reading' + path, method, value),
    qq:(path, method, value) => request('/plugins/qq-ui' + path, method, value), upload
  };
  window.addEventListener('pagehide', () => {
    controllers.forEach(c => c.abort());
    pending.forEach(item => { clearTimeout(item.timer); item.reject(new Error('页面已关闭。')); }); pending.clear();
  });
}());
