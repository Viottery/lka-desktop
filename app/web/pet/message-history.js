/* Explicit message history controls; normal UI requests use the local host proxy. */
(function () {
  'use strict';
  var panel = document.getElementById('messageHistoryPanel');
  if (!panel) return;
  var token = '', policies = [], timer = null, serial = 0, authRevision = 0, actionRevision = 0;
  var editingPolicy = null;
  var pending = new Map();
  var detailRevision = 0;
  var byId = function (id) { return document.getElementById(id); };
  var status = function (value, error) {
    var node = byId('messageHistoryStatus'); node.textContent = value;
    node.classList.toggle('error', !!error);window.LkaMessages?.notify?.(value,error);
  };
  function decode(code, body) {
    var value = {}; try { value = body ? JSON.parse(body) : {}; } catch (_) {}
    if (code < 200 || code > 299) {
      var e = new Error(code === 401 ? '管理令牌无效或尚未配置。' : code === 403 ? '本接口仅允许本机页面访问。' :
        code === 404 ? '消息历史接口尚未启动或会话不可用。' : code === 409 ? '白名单或分析任务版本已更新，请刷新后重试。' :
        code === 503 ? '消息分析当前未启用。' : '请求失败：HTTP ' + code);
      e.status = code; throw e;
    }
    return value;
  }
  window.__lkaMessageBridgeReceive = function (id, code, body) {
    var item = pending.get(id); if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    try { item.resolve(decode(code, body)); } catch (e) { item.reject(e); }
  };
  async function api(path, method, body) {
    if (window.LkaMessageApi) return window.LkaMessageApi.backend(path, method, body);
    method = method || 'GET';
    if (window.petBridge && typeof window.petBridge.requestMemory === 'function') {
      return new Promise(function (resolve, reject) {
        var id = 'memory-' + Date.now().toString(36) + '-' + (++serial);
        var timeout = setTimeout(function () { pending.delete(id); reject(new Error('请求超时，请检查后端连接。')); }, 30000);
        pending.set(id, {resolve:resolve, reject:reject, timer:timeout});
        try { window.petBridge.requestMemory(JSON.stringify({id:id, method:method, path:path,
          body:body === undefined ? '' : JSON.stringify(body), token:token})); }
        catch (e) { pending.delete(id); clearTimeout(timeout); reject(e); }
      });
    }
    var context = window.LkaChatContext && window.LkaChatContext.get();
    var backend = context && context.backend;
    if (!backend) throw new Error('请先配置后端连接。');
    var headers = {Accept:'application/json'};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    var response = await fetch(backend + path, {method:method, headers:headers,
      body:body === undefined ? undefined : JSON.stringify(body), credentials:'omit', cache:'no-store', redirect:'error'});
    return decode(response.status, await response.text());
  }
  function node(tag, className, value) {
    var n = document.createElement(tag); if (className) n.className = className;
    if (value !== undefined) n.textContent = String(value); return n;
  }
  function keyOf(item) { return [item.platform,item.account_id,item.conversation_type,item.conversation_id].join('\u001f'); }
  function render(items) {
    var root = byId('messageHistoryList'); root.replaceChildren();
    items.forEach(function (item) {
      var row = node('section','message-history-row');
      var title = node('strong','', window.LkaMessages?.conversationLabel?.(item) || item.display_name || (item.conversation_type + ' · ' + item.conversation_id));
      row.appendChild(title);
      row.appendChild(node('small','', item.platform + ' / ' + item.account_id + ' / ' + item.conversation_type + ':' + item.conversation_id));
      row.appendChild(node('small','', '记录 ' + (item.record_enabled ? '开' : '关') + '；分析 ' + (item.analysis_enabled ? '开' : '关') +
        '；覆盖到 ' + (item.covered_seq || 0) + '；待处理 ' + (item.pending_count || 0) + '；仅接收' +
        (item.analysis_job && item.analysis_job.status ? '；任务 ' + item.analysis_job.status : '')));
      var actions = node('div','message-history-actions');
      var edit = node('button','text-action','编辑策略'); edit.type = 'button';
      edit.addEventListener('click', function () { fillPolicy(item); }); actions.appendChild(edit);
      [['浏览原文','history'],['摘要','summary'],['事实','facts'],['处理尾批','analyze'],['重试失败任务','retry']].forEach(function (spec) {
        var button = node('button','text-action',spec[0]); button.type = 'button';
        button.addEventListener('click', function () { runAction(button, item, spec[1]); }); actions.appendChild(button);
      });
      row.appendChild(actions); root.appendChild(row);
    });
    if (!items.length) root.appendChild(node('p','', '还没有已记录的白名单会话。填写上方账号与会话 ID 后可手动批准。'));
  }
  async function load(options) {
    options = options || {};
    var authAtStart = authRevision, actionAtStart = actionRevision;
    try {
      var loaded = await Promise.all([api('/messages/conversations'), api('/messages/policies')]);
      var result = loaded[0], p = loaded[1];
      if (authAtStart !== authRevision || actionAtStart !== actionRevision) return;
      policies = Array.isArray(p.policies) ? p.policies : [];
      var conversations = Array.isArray(result.conversations) ? result.conversations : [];
      var byKey = new Map(conversations.map(function (item) { return [keyOf(item), item]; }));
      var entries = policies.map(function (policy) { return Object.assign({}, policy, byKey.get(keyOf(policy)) || {}); });
      if (!entries.length) entries = conversations;
      render(entries); byId('messageHistoryBadge').textContent = entries.length + ' 个会话';
      if (!options.quiet) status('白名单与覆盖状态已更新。');
    } catch (e) { if (authAtStart === authRevision && actionAtStart === actionRevision) status(e.message || '读取失败。', true); }
  }
  async function runAction(button, item, action) {
    button.disabled = true;
    var currentAction = ++actionRevision, currentAuth = authRevision;
    try {
      if(action==='history'&&window.LkaMessages?.openConversation){await window.LkaMessages.openConversation(item.conversation_key);return;}
      var resultPage=byId('messageHistoryDetail');resultPage.replaceChildren(node('p','mc-loading','正在读取结果…'));
      window.LkaMessages?.openDetail?.({key:'history:'+item.conversation_key+':'+action,title:({'summary':'会话摘要',facts:'提取的事实',analyze:'尾批分析',retry:'分析任务'})[action]||'消息历史',subtitle:window.LkaMessages?.conversationLabel?.(item)||window.LkaMessageNames?.label(item)||item.display_name,content:resultPage,onBack:function(){actionRevision++;detailRevision++;}});
      var base = '/messages/conversations/' + encodeURIComponent(item.conversation_key);
      var result;
      if (action === 'history') result = await api(base + '/history?limit=20');
      else if (action === 'analyze') result = await api(base + '/analyze', 'POST', {});
      else if (action === 'retry') {
        var latest = await api(base + '/summary');
        var summary = latest.summary || {};
        var job = summary.analysis_job || summary.job || item.analysis_job || item.job || {};
        if (!job.updated_at) throw new Error('没有可重试任务，或任务版本信息不可用。');
        result = await api(base + '/retry', 'POST', {expected_updated_at:job.updated_at});
      }
      else result = await api(base + '/' + action);
      if (currentAction !== actionRevision || currentAuth !== authRevision) return;
      var panelTitle = (window.LkaMessages?.conversationLabel?.(item)||window.LkaMessageNames?.label(item)||item.display_name||'当前会话');
      if (action === 'history') {
        showHistory(item, result, false, currentAction, currentAuth);
      } else if (action === 'facts') {
        var facts = result.facts || [];
        showDetail(panelTitle + '\n\n' + (facts.length ? facts.map(function (v) {
          return v.text + '\n来源消息：' + (v.source_message_ids || []).join(', ') + (v.certainty ? '\n把握：' + v.certainty : '');
        }).join('\n\n') : '暂无事实。'));
      } else if (action === 'summary') {
        var summary = result.summary || {};
        var coverage = summary.coverage || {};
        var tail = Array.isArray(summary.raw_tail) ? summary.raw_tail : [];
        var lines = [panelTitle, '覆盖到序号 ' + (summary.covered_seq || 0) + '；未处理原文 ' + (summary.pending_count || 0),
          summary.summary || '暂无摘要。', summary.batch_summary || ''];
        if (coverage && Object.keys(coverage).length) lines.push('覆盖详情：' + JSON.stringify(coverage));
        if (tail.length) lines.push('未处理原文：\n' + tail.map(messageLine).join('\n\n'));
        if (summary.analysis_job) lines.push('分析任务：' + (summary.analysis_job.status || '未知'));
        showDetail(lines.filter(Boolean).join('\n\n'));
      } else if (action === 'analyze') {
        var analyzeStatus = result.status === 'nothing_pending' ? '没有待处理原文。' :
          result.status === 'blocked' ? '任务未能排队；请检查现有分析任务。' : '尾批分析已排队。';
        showDetail(panelTitle + '\n' + analyzeStatus);
      } else {
        showDetail(panelTitle + '\n' + (result.status === 'retried' ? '失败任务已重新排队。' : '重试状态：' + (result.status || '未知')));
      }
      await load({quiet:true});
    } catch (e) { if (currentAction === actionRevision && currentAuth === authRevision) {byId('messageHistoryDetail').replaceChildren(node('p','mc-inline-error',e.message||'操作失败。'));status(e.message||'操作失败。',true);} }
    finally { button.disabled = false; }
  }
  function messageLine(message) {
    return '#' + (message.seq == null ? '—' : message.seq) + ' · ' + (message.sender_name || message.sender_id || '未知发言者') +
      ' · 发送 ' + (message.sent_at || '时间未知') + ' · 接收 ' + (message.received_at || '时间未知') +
      '\n' + (message.text || '[非文本消息]');
  }
  function showDetail(value) { byId('messageHistoryDetail').textContent = value; }
  async function showHistory(item, result, append, requestId, authId) {
    var root = byId('messageHistoryDetail');
    if (!append) { root.replaceChildren(); detailRevision++; }
    var heading = append ? null : node('strong','', (item.display_name || item.conversation_id) + ' [' + item.conversation_key + ']\n');
    if (heading) root.appendChild(heading);
    var lines = (result.messages || []).map(messageLine).join('\n\n') || '暂无历史消息。';
    root.appendChild(node('p','message-history-page',lines));
    var cursor = result.next_before_seq;
    if (cursor != null) {
      var button = node('button','text-action','查看更多历史'); button.type = 'button';
      button.addEventListener('click', async function () {
        button.disabled = true;
        try {
          var base = '/messages/conversations/' + encodeURIComponent(item.conversation_key);
          var page = await api(base + '/history?limit=20&before_seq=' + encodeURIComponent(cursor));
          if (requestId !== actionRevision || authId !== authRevision) return;
          button.remove();
          showHistory(item, page, true, requestId, authId);
        } catch (e) { if (requestId === actionRevision && authId === authRevision) status(e.message || '读取历史失败。', true); }
        finally { button.disabled = false; }
      }); root.appendChild(button);
    }
  }
  function fillPolicy(item) {
    editingPolicy = {
      identity: {platform:item.platform, account_id:item.account_id,
        conversation_type:item.conversation_type, conversation_id:item.conversation_id},
      expected_revision:item.revision
    };
    byId('messagePlatform').value = item.platform || 'qq';
    byId('messageAccount').value = item.account_id || '';
    byId('messageConversationType').value = item.conversation_type || 'private';
    byId('messageConversationId').value = item.conversation_id || '';
    byId('messageDisplayName').value = item.display_name || '';
    byId('messageBatchSize').value = item.batch_size || 20;
    byId('messageMinInterval').value = item.min_interval_seconds ?? 300;
    byId('messageMaxWait').value = item.max_wait_seconds ?? 900;
    byId('messageTimezone').value = item.timezone || 'Asia/Shanghai';
    byId('messageRecordEnabled').checked = item.record_enabled === true;
    byId('messageAnalysisEnabled').checked = item.analysis_enabled === true;
    byId('messageMediaEnabled').checked = item.media_enabled === true;
    byId('messageStartFromNow').checked = false;
    byId('messageStartFromNow').disabled = item.analysis_baseline_floor_seq != null || item.analysis_enabled === true;
    byId('messageProposalsEnabled').checked = item.proposals_enabled === true;
    status('已载入该会话策略；取消“记录后续消息”即可撤销采集许可。');
    byId('messagePlatform').focus();
    byId('messagePolicyForm').scrollIntoView({block:'nearest'});
  }
  byId('messageApiToken')?.addEventListener('change', function (e) {
    token = e.target.value; authRevision++; actionRevision++; showDetail(''); load();
  });
  byId('messagePolicyForm').addEventListener('submit', async function (e) {
    e.preventDefault(); var button = e.submitter; if (button) button.disabled = true;
    var payload = {platform:byId('messagePlatform').value.trim(), account_id:byId('messageAccount').value.trim(),
      conversation_type:byId('messageConversationType').value, conversation_id:byId('messageConversationId').value.trim(),
      display_name:byId('messageDisplayName').value.trim(), record_enabled:byId('messageRecordEnabled').checked,
      media_enabled:byId('messageMediaEnabled').checked, analysis_enabled:byId('messageAnalysisEnabled').checked, batch_size:Number(byId('messageBatchSize').value || 20),
      proposals_enabled:byId('messageProposalsEnabled').checked,
      min_interval_seconds:Number(byId('messageMinInterval').value),
      max_wait_seconds:Number(byId('messageMaxWait').value),
      timezone:byId('messageTimezone').value.trim() || 'Asia/Shanghai'};
    if (byId('messageStartFromNow').checked && !byId('messageStartFromNow').disabled && payload.analysis_enabled) payload.start_from_now = true;
    var prior = editingPolicy && keyOf(editingPolicy.identity) === keyOf(payload)
      ? editingPolicy : policies.find(function (p) { return keyOf(p) === keyOf(payload); });
    payload.expected_revision = prior ? (prior.expected_revision === undefined ? prior.revision : prior.expected_revision) : 0;
    var currentAuth = authRevision, currentAction = ++actionRevision;
    try {
      var saved = await api('/messages/policies','PUT',payload);
      if (currentAuth !== authRevision || currentAction !== actionRevision) return;
      if (saved.policy) {
        editingPolicy = {identity:{platform:saved.policy.platform, account_id:saved.policy.account_id,
          conversation_type:saved.policy.conversation_type, conversation_id:saved.policy.conversation_id},
          expected_revision:saved.policy.revision};
      }
      await load({quiet:true}); status('白名单已保存。');
    }
    catch (err) { if (currentAuth === authRevision && currentAction === actionRevision) status(err.message || '保存失败。', true); }
    finally { if (button) button.disabled = false; }
  });
  function schedule() {
    clearInterval(timer); timer = null;
    if (panel.open && !document.hidden && panel.getClientRects().length && (!window.LkaMessages || window.LkaMessages.isOpen())) { load(); timer = setInterval(function () { load({quiet:true}); }, 10000); }
  }
  panel.addEventListener('toggle', schedule);
  window.addEventListener('lka-message-center-view', schedule);
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('pagehide', function () { clearInterval(timer); token = ''; });
}());
