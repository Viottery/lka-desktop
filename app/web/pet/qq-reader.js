/* Only frontend service status. No QQ messages, credentials, or OneBot actions. */
(function () {
  'use strict';
  const panel = document.getElementById('qqReaderPanel');
  if (!panel) return;
  const refresh = document.getElementById('qqReaderRefresh');
  const nonce = Math.random().toString(36).slice(2);
  const pending = new Map();
  let sequence = 0, busy = false, timer = null;
  const connection = {disabled:'未启用', stopped:'已停止', connecting:'连接中', connected:'已连接', offline:'断开，自动重连中'};
  const sync = {not_configured:'未配置后端同步', pending:'等待同步', idle:'已同步 / 等待新消息', syncing:'同步中', offline:'后端不可用，消息保留在本机', storage_error:'本机消息库异常，稍后重试'};
  const errors = {
    windows_only:'请在 Windows 原生前端服务中启用', invalid_ws_url:'QQ 网关地址必须为本机 WebSocket 地址',
    invalid_ws_auth:'请配置非空 QQ 网关 Token', invalid_sync_url:'后端同步地址无效', invalid_sync_auth:'请配置独立的同步密钥',
    invalid_db_path:'请选择 Windows 本地数据库路径', websockets_unavailable:'缺少 QQ Reader 可选依赖',
    websocket_error:'QQ 网关连接失败，请检查服务、路径和凭据', event_too_large:'已忽略超出大小限制的事件',
    text_too_large:'已忽略过长消息', field_too_large:'已忽略字段过长的事件', invalid_event:'已忽略格式不正确的事件',
    storage_error:'本机消息库读写失败，请检查磁盘与权限', sync_offline:'同步尚未成功，本机消息保留并自动重试', configuration_error:'Reader 启动失败，请检查本机配置',
    account_mismatch:'登录账号与目标账号不一致，已断开并停止入库，请核对账号',
    reader_error:'Reader 状态异常，请检查本机配置', local_queue_full:'本机待发队列已满，正在暂停读取并等待同步腾出空间'
  };
  const text = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  const visible = () => panel.open && !document.hidden && panel.getClientRects().length > 0;
  window.__lkaQQStatusReceive = function (id, status, body) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); clearTimeout(item.timeout);
    if (status !== 200) return item.reject(new Error(status === 404 ? 'unavailable' : 'request_failed'));
    try { item.resolve(JSON.parse(body)); } catch (_) { item.reject(new Error('request_failed')); }
  };
  function getStatus() {
    if (window.petBridge && typeof window.petBridge.requestQQReaderStatus === 'function') {
      return new Promise((resolve, reject) => {
        const id = 'qq-status-' + nonce + '-' + (++sequence);
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('request_failed')); }, 9000);
        pending.set(id, {resolve, reject, timeout});
        try { window.petBridge.requestQQReaderStatus(id); }
        catch (_) { pending.delete(id); clearTimeout(timeout); reject(new Error('request_failed')); }
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    return fetch(new URL('/plugins/qq-reader/status', window.location.href).href,
      {method:'GET', credentials:'omit', cache:'no-store', redirect:'error', signal:controller.signal})
      .then(response => {
        if (!response.ok) throw new Error(response.status === 404 ? 'unavailable' : 'request_failed');
        return response.json();
      }).finally(() => clearTimeout(timeout));
  }
  async function load() {
    if (busy || !visible()) return;
    busy = true; refresh.disabled = true;
    try {
      const state = await getStatus();
      if (!state || state.plugin_id !== 'qq_reader') throw new Error('request_failed');
      text('qqReaderEnabled', state.enabled === true ? '已启用' : '未启用');
      text('qqReaderBadge', state.enabled === true ? '已启用' : '未启用');
      text('qqReaderConnection', connection[state.connection_state] || '状态未知');
      text('qqReaderSync', sync[state.sync_state] || '状态未知');
      text('qqReaderPending', Number.isInteger(state.pending_count) ? String(state.pending_count) : '—');
      const stamp = typeof state.last_received_at === 'string' && state.last_received_at.length < 64 ? new Date(state.last_received_at) : null;
      text('qqReaderReceived', stamp && Number.isFinite(stamp.getTime()) ? stamp.toLocaleString() : '尚未接收');
      text('qqReaderError', state.last_error ? (errors[state.last_error] || errors.reader_error) : '无');
    } catch (error) {
      text('qqReaderConnection', '暂时无法读取状态');
      text('qqReaderError', error.message === 'unavailable' ? '前端服务尚未加载 QQ 插件，请重新启动前端服务' : '状态查询失败，请检查本机前端服务');
    } finally { busy = false; refresh.disabled = false; }
  }
  function schedule() {
    clearInterval(timer); timer = null;
    if (visible()) { load(); timer = setInterval(load, 15000); }
  }
  refresh.addEventListener('click', load);
  panel.addEventListener('toggle', schedule);
  document.addEventListener('visibilitychange', schedule);
  // Settings can be shown without changing the details element's open state.
  document.getElementById('toggleSettingsButton')?.addEventListener('click', () => setTimeout(schedule, 0));
  document.getElementById('settingsTabButton')?.addEventListener('click', () => setTimeout(schedule, 0));
  window.addEventListener('pagehide', () => {
    clearInterval(timer);
    for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error('request_failed')); }
    pending.clear();
  });
}());
