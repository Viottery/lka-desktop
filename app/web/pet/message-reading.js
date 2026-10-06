/* Reading results only; every write starts with a trusted UI action. */
(function () {
  'use strict';
  const host = document.getElementById('messageHistoryPanel');
  if (!host) return;
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n; };
  const root = el('section', undefined, 'message-reading'); root.setAttribute('aria-label', '消息阅读中心');
  host.insertBefore(root, document.getElementById('messagePolicyForm'));
  const status = el('p', '阅读接口尚未载入。'); status.setAttribute('role', 'status');
  const tabs = el('div', undefined, 'reading-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '阅读视图');
  const filters = el('form', undefined, 'reading-filters');
  const group = el('select'); group.setAttribute('aria-label', '阅读会话'); const all = el('option', '所有已记录会话'); all.value = ''; group.append(all);
  const since = el('input'); since.type = 'datetime-local'; since.setAttribute('aria-label', '起始时间');
  const until = el('input'); until.type = 'datetime-local'; until.setAttribute('aria-label', '结束时间');
  const filterButton = el('button', '筛选'); filterButton.type = 'submit'; filters.append(group, since, until, filterButton);
  const list = el('div', undefined, 'reading-list'), detail = el('section', undefined, 'reading-detail');
  detail.setAttribute('aria-label', '结果详情与人工审阅');
  root.append(el('h3', '消息阅读'), tabs, filters, list, detail, status);
  let tab = 'overview', cursor = null, generation = 0, detailGeneration = 0, service = null, profile = null, configuration = null;
  let selected = null, proposal = null, draft = null, approval = null, busy = false, timer = null;
  const pending = new Map(); let serial = 0;
  const oldReceive = window.__lkaMemoryBridgeReceive;
  window.__lkaMemoryBridgeReceive = function (id, code, body) {
    const item = pending.get(id);
    if (!item) { if (oldReceive) oldReceive(id, code, body); return; }
    pending.delete(id); clearTimeout(item.timeout);
    try { item.resolve(decode(code, body)); } catch (error) { item.reject(error); }
  };
  function decode(code, body) {
    if (code < 200 || code > 299) {
      const error = new Error(({401:'尚未配对独立的消息控制凭据。',403:'只允许可信本机页面操作。',404:'结果不可访问或接口尚未加载。',409:'版本或证据已变化；编辑已保留，请重新预览并核对。',422:'字段不符合要求，请检查后重试。',503:'后台不可用，请检查本机服务。'})[code] || '读取失败，请稍后重试。');
      error.status = code; throw error;
    }
    try { return JSON.parse(body || '{}'); } catch (_) { throw new Error('后台返回格式无效。'); }
  }
  async function api(path, method, body) {
    if (window.LkaMessageApi) return window.LkaMessageApi.backend(path, method, body);
    method = method || 'GET';
    const proxyPath = '/plugins/message-reading' + path;
    if (window.petBridge && typeof window.petBridge.requestMemory === 'function') {
      return new Promise((resolve, reject) => {
        const id = 'memory-' + Date.now().toString(36) + '-' + (++serial);
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('后台请求超时。')); }, 30000);
        pending.set(id, {resolve, reject, timeout});
        try { window.petBridge.requestMemory(JSON.stringify({id, path:proxyPath, method, body:body === undefined ? '' : JSON.stringify(body)})); }
        catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
      });
    }
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(new URL(proxyPath, window.location.href), {
        method, headers:{Accept:'application/json', 'Content-Type':'application/json'},
        body:body === undefined ? undefined : JSON.stringify(body), credentials:'omit',
        cache:'no-store', redirect:'error', signal:controller.signal
      });
      return decode(response.status, await response.text());
    } finally { clearTimeout(timeout); }
  }
  detail.hidden=true;
  let detailRetry=null;
  const conversationName=key=>Array.from(group.options||group.children).find(option=>option.value===key)?.textContent||'当前会话';
  function beginDetail(title,key,retry,conversation){
    generation++;detailRetry=retry;detail.dataset.loading='true';detail.setAttribute('aria-busy','true');detail.replaceChildren(el('p','正在读取详情与原文…','mc-loading'));
    if(window.LkaMessages?.openDetail){
      window.LkaMessages.openDetail({key:'reading:'+key,title,subtitle:conversationName(conversation||group.value),content:detail,
        canLeave:()=>{if(busy){notify('正在保存，请稍候。',true);return false;}return !draft||window.confirm('返回列表会放弃这次未保存的编辑，继续？');},
        onBack:()=>{detailGeneration++;detail.hidden=true;detail.dataset.loading='false';draft=approval=proposal=selected=null;detail.replaceChildren();}});
    }else{detail.hidden=false;detail.scrollIntoView?.({block:'start'});}
  }
  function detailReady(){detail.dataset.loading='false';detail.setAttribute('aria-busy','false');}
  function detailError(error){if(detail.dataset.loading!=='true')return;detailReady();detail.replaceChildren(el('p',error.message,'mc-inline-error'));if(detailRetry)detail.append(button('重试读取',detailRetry));}
  const messageTime=value=>{const d=new Date(typeof value==='number'?value*1000:value);return value&&Number.isFinite(d.getTime())?d.toLocaleString():'时间未知';};
  function sourceQuote(m,target,conversation){
    const quote=el('blockquote',undefined,'reading-quote'),header=el('header');
    header.append(el('strong',m.sender_name||m.sender_id||'未知发言者'),el('time',messageTime(m.sent_at||m.received_at)));quote.append(header);window.LkaMessageContent.render(m,quote);
    if((m.message_id||m.id)&&window.LkaMessages?.openContext)quote.append(button('查看前后消息',()=>window.LkaMessages.openContext({...m,conversation_key:m.conversation_key||conversation||selected?.conversation_key||group.value})));
    target.append(quote);
  }

  function sourceError(target,error,retry){const recovery=el('div',undefined,'reading-source-error');recovery.append(el('p',error.message,'mc-inline-error'),button('重试原文',()=>{recovery.remove();return retry();}));target.append(recovery);notify(error.message,true);}

  function notify(text, error) { status.textContent = text; status.classList.toggle('error', !!error);window.LkaMessages?.notify?.(text,error); }
  function button(label, action, write) {
    const n = el('button', label, 'text-action'); n.type = 'button';
    n.addEventListener('click', async event => {
      if (write && !event.isTrusted) return;
      n.disabled = true;
      try { await action(); } catch (error) { detailError(error);notify(error.message, true); } finally { n.disabled = false; }
    }); return n;
  }
  function pretty(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  function field(form, name, label, value, type) {
    const wrap = el('label', label), input = el(type === 'textarea' ? 'textarea' : 'input');
    input.name = name; if (type && type !== 'textarea') input.type = type;
    input.value = value == null ? '' : String(value); input.maxLength = name === 'summary' ? 4000 : 512;
    wrap.append(input); form.append(wrap); return input;
  }
  function coverage(value, target) {
    const rows = Array.isArray(value) ? value : value ? [value] : [];
    if (!rows.length) target.append(el('p', '尚无新阅读流水线覆盖；历史摘要不代表新结果。'));
    rows.forEach(c => {
      const section = el('div', undefined, 'reading-coverage');
      const name=conversationName(c.conversation_key);
      section.append(el('strong', c.display_name || name || '当前会话'));
      section.append(el('p', '待处理 ' + (c.pending_messages ?? '未知') + ' 条；平台历史完整性：' + (c.complete_for_platform === true ? '完整' : '不保证完整')));
      const range=el('details');range.append(el('summary','查看处理范围与缺口'));section.append(range);
      range.append(el('p', '采集：' + (c.capture_mode || '未知') + '；缺口：' + (c.capture_gaps || '未知') + '；完整平台覆盖：' + (c.complete_for_platform === true ? '是' : '否')));
      range.append(el('p', '本地扫描 ' + (c.local_signal_seq ?? '未知') + '；筛选到 ' + (c.screened_seq ?? '未知') + '；发布到 ' + (c.generation_published_seq ?? c.analysis_covered_seq ?? '未知') + '；简报 ' + (c.digest_covered_seq ?? '未知') + '；待处理 ' + (c.pending_messages ?? '未知')));
      range.append(el('p', '覆盖方式：' + (c.coverage_mode || '未知') + '；模型见过 ' + (c.model_seen_count ?? '未知') + ' 条；筛选排除 ' + (c.selected_out_count ?? '未知') + ' 条。筛选进度与发布进度不表示模型已读全部原文。'));
      range.append(el('small', '分析状态：' + (c.analysis_state || '未知') + '；基线：' + (c.baseline_start_seq ?? '未知') + '；流水线：' + (c.pipeline_version || '未知') + '；下次资格：' + (c.next_eligible_at || '未知')));
      if (c.conversation_key) section.append(button('展开该会话简报', async () => {
        if (draft && !window.confirm('打开简报将关闭当前未提交的编辑。继续？')) return;
        const request = ++detailGeneration;beginDetail('会话简报','digest:'+c.conversation_key,()=>section.querySelector('button')?.click(),c.conversation_key);
        const data = await api('/messages/conversations/' + encodeURIComponent(c.conversation_key) + '/digest');
        if (request !== detailGeneration) return;detailReady();
        draft = approval = proposal = selected = null;
        const value = data.digest || data;
        detail.replaceChildren(el('h4', '会话简报'), el('p', '更新时间：' + (value.generated_at || '暂无') + '；过时：' + (value.stale ? '是' : '否') + '；覆盖到：' + (value.covered_seq ?? '未知')), el('pre', pretty({topics:value.topics,insights:value.insights})));
        coverage(value.coverage, detail);
      }));
      if (c.conversation_key) section.append(button('查看群关注重点', () => openFocus(c.conversation_key)));
      target.append(section);
    });
  }
  function query(more) {
    const q = new URLSearchParams({limit:'30'});
    if (group.value.trim()) q.set('conversation_key', group.value.trim());
    if (since.value && tab !== 'participants') q.set('since', new Date(since.value).toISOString());
    if (until.value && tab !== 'participants') q.set('until', new Date(until.value).toISOString());
    if (more && cursor) q.set('cursor', cursor);
    if (tab === 'important') { q.set('unseen', 'true'); q.set('kind', 'importance'); }
    if (tab === 'highlights') q.set('kind', 'highlight');
    if (tab === 'proposals') q.set('state', 'pending');
    return '?' + q;
  }
  const tabNames = [['overview','概览'], ['topics','话题'], ['participants','参与者'], ['focus','群关注'], ['highlights','亮点'], ['important','重要信息'], ['proposals','事项候选']];
  tabNames.forEach(([name, label]) => {
    const b = button(label, () => { tab = name; cursor = null; refresh(); });
    b.setAttribute('role', 'tab'); b.dataset.tab = name; b.setAttribute('aria-selected', name === tab ? 'true' : 'false'); tabs.append(b);
  });
  filters.addEventListener('submit', event => { event.preventDefault(); cursor = null; refresh(); });
  function appendItem(item, kind) {
    const row = el('article', undefined, 'reading-row');
    if (kind === 'participants') {
      row.append(el('strong', window.LkaMessageNames.personLabel(item)),el('small',window.LkaMessageNames.personIdentity(item)), el('p', item.summary || '尚无画像摘要'), el('small', '状态：' + (item.status || 'candidate') + '；会话：' + conversationName(item.conversation_key)));
      row.append(button('查看画像与证据', () => openParticipant(item))); list.append(row); return;
    }
    row.append(el('strong', item.title || item.text || item.proposed_fields?.title || '未命名结果'));
    if (item.summary || item.description) row.append(el('p', item.summary || item.description));
    if (kind === 'insights') row.append(el('small', '重要性：' + (item.importance || '未知') + '；依据：' + (item.detector || '未知') + '；确定性：' + (item.certainty || '待核实') + '；阅读：' + (item.attention?.state || '未阅')));
    if (kind === 'topics') row.append(el('small', '参与：' + (item.heat?.participant_count ?? item.participant_count ?? item.participants?.length ?? '未知') + '；变化：' + (item.change || item.discussion_change || '未标注')));
    row.append(button('打开详情与原文', () => openItem(item, kind))); list.append(row);
  }
  async function refresh(more) {
    const request = ++generation, activeTab = tab;
    Array.from(tabs.children).forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'));
    try {
      if (tab === 'focus') {
        list.replaceChildren(el('p', '填写阅读会话，再查看或调整这个群的关注重点。'), button('查看群关注重点', () => {
          if (!group.value.trim()) throw new Error('请先填写阅读会话。');
          return openFocus(group.value.trim());
        })); return;
      }
      const path = tab === 'overview' ? '/messages/reading/overview' : tab === 'topics' ? '/messages/reading/topics' : tab === 'participants' ? '/messages/reading/participants' : tab === 'proposals' ? '/messages/matter-proposals' : '/messages/reading/insights';
      const data = await api(path + (tab === 'overview' ? (group.value.trim() ? '?conversation_key=' + encodeURIComponent(group.value.trim()) : '') : query(more)));
      if (request !== generation || activeTab !== tab) return;
      if (!more) list.replaceChildren();
      if (tab === 'participants' && !more) {
        const lookup = el('form', undefined, 'reading-form'), sender = field(lookup, 'participant_sender', '参与者平台标识（可查找已隐藏画像）', '');
        lookup.addEventListener('submit', event => event.preventDefault());
        lookup.append(button('按标识查看画像', () => {
          if (!group.value.trim() || !sender.value.trim()) throw new Error('请填写阅读会话和参与者平台标识。');
          return openParticipant({conversation_key:group.value.trim(),sender_id:sender.value.trim()});
        })); list.append(lookup);
      }
      if (tab === 'overview') {
        list.append(el('p', '更新时间：' + (data.updated_at || data.generated_at || '见各群覆盖') + '；重要项未阅：' + (data.unseen_count ?? data.counts?.unseen ?? data.counts?.unread ?? '未知')));
        coverage(data.coverage, list); (data.topics || []).forEach(v => appendItem(v, 'topics'));
        (data.insights || []).forEach(v => appendItem(v, 'insights'));
      } else {
        const kind = tab === 'topics' ? 'topics' : tab === 'participants' ? 'participants' : tab === 'proposals' ? 'proposals' : 'insights';
        const values = data[kind] || data.items || [];
        if (tab === 'important') {
          [['explicit','明确指向或明确行动'],['possible','可能相关，待核实']].forEach(([certainty,label]) => {
            const items = values.filter(item => certainty === 'explicit' ? item.certainty === 'explicit' : item.certainty !== 'explicit');
            if (items.length) { list.append(el('h4', label)); items.forEach(item => appendItem(item, kind)); }
          });
        } else values.forEach(item => appendItem(item, kind));
        if (!values.length && !more) list.append(el('p', '当前条件下没有阅读结果。可检查会话许可、覆盖和预算。'));
      }
      cursor = data.next_cursor || null;
      if (cursor) { const next = button('加载下一页', async () => { next.remove(); await refresh(true); }); list.append(next); }
      notify('阅读列表已更新。打开详情不会标记已阅。');
    } catch (error) { if (request === generation) notify(error.message, true); }
  }
  function participantPath(conversation, sender) {
    return '/messages/reading/participants/' + encodeURIComponent(conversation) + '/' + encodeURIComponent(sender);
  }
  function profileNotices(value, target) {
    target.append(el('p', '状态：' + (value.status || 'candidate') + '；版本：' + (value.revision ?? 0) + '；更新：' + (value.updated_at || '暂无')));
    if (value.stale || value.status === 'stale' || value.status === 'cold' || (value.claims || []).some(c => c.status === 'stale')) target.append(el('p', '画像已过时，请核对最近原文。'));
    if (value.status === 'candidate' || (value.claims || []).some(c => c.status === 'candidate')) target.append(el('p', '候选画像：推断尚未确认，请结合证据核实。'));
    if (value.status === 'contested' || (value.claims || []).some(c => c.status === 'contested')) target.append(el('p', '画像存在争议或相互冲突的证据，不能作为确定事实。'));
  }
  async function openParticipant(item, saved) {
    if (!saved && draft && !window.confirm('打开其他详情将关闭当前未提交的编辑。继续？')) return;
    const conversation = item.conversation_key, sender = item.sender_id || item.sender;
    if (!conversation || !sender) throw new Error('画像缺少会话或参与者标识。');
    const request = ++detailGeneration, path = participantPath(conversation, sender);beginDetail(window.LkaMessageNames.personLabel(item),'participant:'+conversation+':'+sender,()=>openParticipant(item,saved),conversation);const value=await api(path);
    if (request !== detailGeneration) return;detailReady();
    selected={kind:'participants',id:sender,conversation_key:conversation};const person={...item,...value,sender_id:sender},name=window.LkaMessageNames.personLabel(person);window.LkaMessages?.updateDetail?.(detail,{title:name});detail.replaceChildren(el('h4',name),el('small',window.LkaMessageNames.personIdentity(person))); draft = saved || null;
    profileNotices(value, detail); detail.append(el('p', value.summary || '尚无摘要'), el('small', '活跃度：' + (value.score ?? '未知')));
    (value.claims || []).forEach(claim => detail.append(el('p', (claim.status || 'candidate') + '：' + (claim.text || claim.quote || claim.summary || pretty(claim)))));
    coverage(value.coverage, detail);
    const form = el('form', undefined, 'reading-form'); form.addEventListener('submit', event => event.preventDefault());
    const summary = field(form, 'participant_summary', '人工更正摘要', saved?.summary ?? value.summary, 'textarea'); summary.maxLength = 240;
    summary.addEventListener('input', () => { draft = {summary:summary.value}; });
    const control = async action => {
      if (action === 'delete' && !window.confirm('删除这个本地画像？原消息不会删除。')) return;
      if (action === 'correct') draft = {summary:summary.value};
      await api(path + '/control', 'POST', {expected_revision:value.revision ?? 0, action, ...(action === 'correct' ? {summary:summary.value} : {})});
      draft = null;
      if (action === 'delete') detail.replaceChildren(el('p', '本地画像已删除。')); else await openParticipant(item);
      await refresh(); notify('画像管理已保存。');
    };
    [['pin','置顶'],['unpin','取消置顶'],['hide','隐藏'],['unhide','取消隐藏'],['delete','删除画像'],['correct','保存人工更正']].forEach(([action,label]) => form.append(button(label, () => control(action), true)));
    form.append(button('载入最新版本并保留更正', () => openParticipant(item, {summary:summary.value}))); detail.append(form);
    const sources = el('div'); detail.append(el('h4', '画像证据原文'), sources);
    if (value.status === 'hidden' || value.status === 'suppressed') { sources.append(el('p', '画像已隐藏或删除，证据原文不可访问。')); return; }
    await participantSources(path, sources, null, request);
  }
  async function participantSources(path, target, nextCursor, request) {
    let data;try{data=await api(path+'/sources?limit=20'+(nextCursor?'&cursor='+encodeURIComponent(nextCursor):''));}catch(error){if(request===detailGeneration){sourceError(target,error,()=>participantSources(path,target,nextCursor,request));}return;}
    if (request !== detailGeneration) return;detailReady();
    (data.sources || []).forEach(m=>sourceQuote(m,target,decodeURIComponent(path.split('/')[4])));
    if (!(data.sources || []).length && !nextCursor) target.append(el('p', '当前没有可访问的证据原文。'));
    if (data.next_cursor) { const next = button('继续查看证据', async () => { next.remove(); await participantSources(path, target, data.next_cursor, request); }); target.append(next); }
  }
  const focusLabels = [['technical_support','技术支持'],['project_collaboration','项目协作'],['interest','兴趣交流'],['social','社交'],['general','综合']];
  async function openFocus(conversation, saved) {
    if (!saved && draft && !window.confirm('打开群关注将关闭当前未提交的编辑。继续？')) return;
    const request=++detailGeneration,path='/messages/reading/focus/'+encodeURIComponent(conversation);beginDetail('群关注重点','focus:'+conversation,()=>openFocus(conversation,saved),conversation);const value=await api(path);
    if (request !== detailGeneration) return;detailReady();
    detail.replaceChildren(el('h4', '群关注重点：' + conversationName(conversation)), el('p', '版本：' + value.revision + '；更新：' + (value.updated_at || '暂无')), el('pre', pretty(value.focus || [])));
    draft = saved || null;
    if (value.fallback) detail.append(el('p', '当前使用兜底重点：' + pretty(value.fallback)));
    const form = el('form', undefined, 'reading-form'); form.addEventListener('submit', event => event.preventDefault());
    const wrap = el('label', '关注方式'), mode = el('select');
    [['auto','自动识别'],['manual','手动选择']].forEach(([key,label]) => { const option = el('option', label); option.value = key; mode.append(option); });
    mode.value = saved?.mode || value.mode || 'auto'; wrap.append(mode); form.append(wrap);
    const labels = saved?.labels || (value.focus || []).map(f => f.label), choices = [];
    focusLabels.forEach(([key,label]) => { const wrap = el('label', undefined, 'message-check'), input = el('input'); input.type = 'checkbox'; input.checked = labels.includes(key); choices.push([key,input]); wrap.append(input, document.createTextNode(label)); form.append(wrap); });
    const snapshot = () => ({mode:mode.value, labels:choices.filter(([,input]) => input.checked).map(([key]) => key)});
    form.addEventListener('change', () => { draft = snapshot(); });
    form.append(button('保存群关注重点', async () => {
      draft = snapshot();
      await api(path, 'PUT', {expected_revision:value.revision ?? 0, ...snapshot()}); draft = null; await openFocus(conversation); notify('群关注重点已保存。');
    }, true), button('载入最新版本并保留选择', () => openFocus(conversation, snapshot()))); detail.append(form);
  }
  async function sourcePage(kind, id, target, nextCursor, request) {
    const path = '/messages/reading/' + kind + '/' + encodeURIComponent(id) + '/sources?limit=20' + (nextCursor ? '&cursor=' + encodeURIComponent(nextCursor) : '');
    let data;try{data=await api(path);}catch(error){if(request===detailGeneration){sourceError(target,error,()=>sourcePage(kind,id,target,nextCursor,request));}return;}
    if (request !== detailGeneration) return;detailReady();
    (data.sources || []).forEach(m=>sourceQuote(m,target));
    if(!(data.sources||[]).length&&!nextCursor)target.append(el('p','暂无可访问的原文。'));
    if (data.next_cursor) {
      const next = button('继续查看原文', async () => { next.remove(); await sourcePage(kind, id, target, data.next_cursor, request); });
      target.append(next);
    }
  }
  async function openItem(item, kind) {
    if (draft && !window.confirm('打开其他详情将关闭当前未提交的编辑。继续？')) return;
    const request = ++detailGeneration;
    const id = item.proposal_id || item.topic_id || item.insight_id || item.id;
    if(!id)throw new Error('这条阅读结果缺少标识，请刷新列表。');
    beginDetail(item.title||item.text||'阅读详情',kind+':'+id,()=>openItem(item,kind),item.conversation_key);
    const data = await api((kind === 'proposals' ? '/messages/matter-proposals/' : '/messages/reading/' + kind + '/') + encodeURIComponent(id));
    if (request !== detailGeneration) return;detailReady();
    selected = {id, kind,conversation_key:item.conversation_key||group.value}; detail.replaceChildren(); draft = null; approval = null;
    if (kind === 'proposals') { proposal = data.proposal || data; proposalForm(); return; }
    const value = data.topic || data.insight || data;
    selected.conversation_key=value.conversation_key||selected.conversation_key;window.LkaMessages?.updateDetail?.(detail,{title:value.title||item.title||'阅读详情',subtitle:conversationName(selected.conversation_key)});
    detail.append(el('h4', value.title || '阅读详情'));
    [['summary','摘要'],['text','内容'],['conclusions','结论'],['disagreements','不同意见'],['open_questions','待解决问题'],['certainty','确定性'],['detector','识别依据'],['uncertainty','尚待核实']].forEach(([key,label])=>{if(!value[key])return;if(typeof value[key]==='string'&&['summary','text'].includes(key)&&window.PetMarkdown?.render){const block=el('div',undefined,'reading-result-field'),content=el('div',undefined,'markdown-body');block.append(el('h4',label),content);window.PetMarkdown.render(content,value[key]);detail.append(block);}else detail.append(el('p',label+'：'+pretty(value[key])));});
    coverage(value.coverage, detail);
    if (kind === 'insights') {
      const attention = value.attention || {};
      ['已阅','忽略','稍后看'].forEach((label, index) => detail.append(button(label, async () => {
        const payload = {expected_revision:attention.revision || 0};
        if (index === 0) payload.viewed_revision = value.revision;
        if (index === 1) payload.dismissed_revision = value.revision;
        if (index === 2) payload.snoozed_until = new Date(Date.now() + 3600000).toISOString();
        await api('/messages/reading/insights/' + encodeURIComponent(id) + '/attention', 'POST', payload);
        notify(label + '已保存；不会向平台发送阅读回执。'); await openItem(item, kind); refresh();
      }, true)));
      renderBadcaseForm(value, request);
    }
    const sources = el('div'); detail.append(el('h4', '原消息'), sources); await sourcePage(kind, id, sources, null, request);
  }
  function renderBadcaseForm(value, request) {
    const ids = Array.isArray(value.source_message_ids) ? Array.from(new Set(value.source_message_ids.filter(id => typeof id === 'string'))).slice(0, 20) : [];
    if (!ids.length) return;
    const section = el('details'), form = el('form', undefined, 'reading-form'), previewArea = el('div');
    section.append(el('summary', '保存为本地评测样例'));
    form.addEventListener('submit', event => event.preventDefault());
    form.append(el('p', '仅把你选定的原文保存在本机评测集。不会上传、训练、调用模型或写入个人记忆。最多保存当前结果的前 20 条来源。'));
    const labelWrap = el('label', '问题类型'), label = el('select');
    [['','请选择问题类型'],['missed_importance','漏掉重要信息'],['false_positive','错误提示重要信息'],['topic_split','同一话题被拆开'],['topic_merge','不同话题被合并'],['deadline_correction','期限更正未处理'],['evidence_error','证据与结果不符']].forEach(([key,text]) => {
      const option = el('option', text); option.value = key; label.append(option);
    });
    labelWrap.append(label); form.append(labelWrap);
    const note = field(form, 'evaluation_note', '你的说明（可留空）', '', 'textarea'); note.maxLength = 2000;
    const consentWrap = el('label', undefined, 'message-check'), consent = el('input'); consent.type = 'checkbox';
    consentWrap.append(consent, document.createTextNode('我同意把下面预览的原文复制到本机评测集'));
    let preview = null;
    form.append(button('预览将保存的原文', async () => {
      const loaded = await api('/messages/reading/evaluation/badcases/preview', 'POST', {evidence_message_ids:ids});
      if (request !== detailGeneration) return;detailReady();
      preview = loaded; consent.checked = false; previewArea.replaceChildren();
      (loaded.evidence||[]).forEach(m=>sourceQuote(m,previewArea));
      notify('原文已预览；请核对内容、选择问题类型并确认本机复制许可。');
    }, true), previewArea, consentWrap);
    form.append(button('确认保存这一条本地样例', async () => {
      if (!preview) throw new Error('请先预览本次要保存的原文。');
      if (!label.value) throw new Error('请选择问题类型。');
      if (!consent.checked) throw new Error('保存原文需要明确同意本机复制。');
      try {
        await api('/messages/reading/evaluation/badcases', 'POST', {
          evidence_message_ids:preview.evidence_message_ids, expected_evidence_digest:preview.evidence_digest,
          label:label.value, note:note.value, local_copy_consent:true
        });
        if (request !== detailGeneration) return;detailReady();
        preview = null; form.replaceChildren(el('p', '样例已保存到本机评测集。没有上传或启动模型。'));
        notify('本地评测样例已保存。');
      } catch (error) {
        if (error.status === 409) {
          preview = null; consent.checked = false;
          previewArea.replaceChildren(el('p', '证据或权限已变化。说明已保留，请重新预览原文并确认复制许可。'));
        }
        throw error;
      }
    }, true));
    section.append(form); detail.append(section);
  }
  function proposalForm(saved) {
    detail.replaceChildren(); approval = null;
    detail.append(el('h4', '人工审阅候选'), el('p', '创建会复制你确认的字段到独立事项；停用消息来源不会撤回这份副本。'));
    if (proposal.state === 'revoked') { detail.append(el('p', '来源已撤销，候选正文不可访问。')); draft = null; return; }
    const evidence=el('div');(proposal.evidence||[]).forEach(m=>sourceQuote(m,evidence,proposal.conversation_key));detail.append(el('h4','证据原文'),evidence);
    if (proposal.frozen_reason) detail.append(el('p', '候选冻结：' + proposal.frozen_reason + '。可拒绝，不能批准。'));
    const form = el('form', undefined, 'reading-form'), operationWrap = el('label', '本次操作'), operation = el('select');
    [['create','创建事项'],['link_existing','仅关联已有事项来源'],['reject','拒绝候选']].forEach(([value,label]) => { const option = el('option', label); option.value = value; operation.append(option); });
    operationWrap.append(operation); form.append(operationWrap);
    const create = el('div'), fields = proposal.proposed_fields || {};
    const title = field(create, 'title', '标题', fields.title), summary = field(create, 'summary', '摘要', fields.summary, 'textarea');
    const priorityWrap = el('label', '优先级'), priority = el('select');
    ['low','normal','high','urgent'].forEach(value => { const option = el('option', ({low:'低',normal:'普通',high:'高',urgent:'紧急'})[value]); option.value = value; priority.append(option); }); priority.value = fields.priority || 'normal'; priorityWrap.append(priority); create.append(priorityWrap);
    const due = field(create, 'due_at', '期限（含时区的 ISO 时间，可留空）', fields.due_at), tags = field(create, 'tags', '标签（逗号分隔）', (fields.tags || []).join(','));
    const link = el('div'), targetWrap = el('label', '已有事项（仅添加来源，不修改事项字段）'), target = el('select');
    const empty = el('option', '请选择事项'); empty.value = ''; target.append(empty);
    (proposal.suggested_matters || []).forEach(m => { const option = el('option', m.title + '（版本 ' + m.revision + '）'); option.value = m.matter_id; option.dataset.revision = m.revision; target.append(option); });
    targetWrap.append(target); link.append(targetWrap);
    const sourceReason = field(link, 'source_reason', '实际保存的来源说明', '', 'textarea');
    const reject = el('div'), reason = field(reject, 'reason', '拒绝原因（可留空）', '', 'textarea');
    form.append(create, link, reject);
    draft = {operation, title, summary, priority, due, tags, target, sourceReason, reason};
    if (saved) Object.keys(saved).forEach(key => { if (draft[key]) draft[key].value = saved[key]; });
    function change() { create.hidden = operation.value !== 'create'; link.hidden = operation.value !== 'link_existing'; reject.hidden = operation.value !== 'reject'; approval = null; confirmation.replaceChildren(); }
    operation.addEventListener('change', change);
    const confirmation = el('div', undefined, 'reading-confirmation');
    form.addEventListener('input', () => { approval = null; confirmation.replaceChildren(); });
    form.append(button('预览本次写入', () => {
      if (proposal.frozen_reason && operation.value !== 'reject') throw new Error('候选已冻结，请先重新验证。');
      const payload = {action:operation.value, expected_revision:proposal.revision, preview_digest:proposal.preview_digest, evidence_digest:proposal.evidence_digest, decision_key:decisionKey()};
      if (operation.value === 'create') {
        if (!title.value.trim()) throw new Error('请填写标题。');
        if (due.value && (!/([zZ]|[+-][0-9]{2}:[0-9]{2})$/.test(due.value) || !Number.isFinite(Date.parse(due.value)))) throw new Error('期限必须含时区。');
        payload.reviewed_fields = {title:title.value.trim(), summary:summary.value.trim(), priority:priority.value, due_at:due.value.trim() || null, tags:tags.value.split(',').map(v => v.trim()).filter(Boolean)};
      } else if (operation.value === 'link_existing') {
        if (!target.value) throw new Error('请选择有版本信息的已有事项。');
        payload.target_matter_id = target.value; payload.expected_target_revision = Number(target.selectedOptions[0].dataset.revision); payload.source_reason = sourceReason.value;
      } else payload.reason = reason.value;
      approval = payload; confirmation.replaceChildren(el('h4', '核对实际保存内容'), el('pre', pretty(payload)));
      confirmation.append(button(operation.value === 'reject' ? '确认拒绝这一条' : '确认这一条', decide, true));
    }, true));
    form.append(button('重新载入审批预览（保留编辑）', async () => {
      const savedDraft = Object.fromEntries(Object.entries(draft).map(([k,v]) => [k,v.value]));
      proposal = await api('/messages/matter-proposals/' + encodeURIComponent(selected.id));
      proposal = proposal.proposal || proposal; proposalForm(savedDraft); notify('已载入新证据和版本，请核对后重新预览实际写入。');
    }));
    if (proposal.frozen_reason) form.append(button('重新验证候选', async () => {
      await api('/messages/matter-proposals/' + encodeURIComponent(selected.id) + '/revalidate', 'POST', {expected_revision:proposal.revision});
      notify('已请求重新验证；请重新载入预览。');
    }, true));
    form.append(confirmation); detail.append(form); change();
  }
  function decisionKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = new Uint8Array(16); window.crypto.getRandomValues(bytes); return Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
  }
  async function decide() {
    if (!approval || busy) return;
    busy = true;
    try {
      await api('/messages/matter-proposals/' + encodeURIComponent(selected.id) + '/decision', 'POST', approval);
      proposal = null; draft = null; approval = null; detail.replaceChildren(el('p', '这一条已处理。请选择下一条候选。')); await refresh();
      const next = list.querySelector('.reading-row button'); if (next) { next.focus(); next.click(); }
    } catch (error) {
      if (error.status === 409) { approval = null; detail.querySelector('.reading-confirmation')?.replaceChildren(el('p', '版本冲突。编辑保留，请重新载入审批预览，核对证据与字段后再确认。')); }
      throw error;
    } finally { busy = false; }
  }
  const management = el('details'), managementSummary = el('summary', '阅读后台与显式关注配置');
  const serviceDisplay = el('div'), settingsArea = el('div'), profileArea = el('div');
  management.append(managementSummary, serviceDisplay, settingsArea, profileArea); root.append(management);
  async function loadManagement() {
    const data = await Promise.all([api('/background/services/message-reading'), api('/background/config'), api('/messages/reading/profile')]);
    service = data[0]; configuration = data[1]; profile = data[2].profile || data[2];
    serviceDisplay.replaceChildren(el('p', '阅读服务：' + (service.paused ? '已暂停' : service.enabled === false || service.background_enabled === false ? '全局未启用' : '可运行') + '；采集在线状态请查看 QQ 只读接入。'), el('pre', pretty({budget:service.budget || service.budgets, limits:service.limits, pricing_known:service.pricing_known, backlog:service.backlog, oldest_pending_at:service.oldest_pending_at, failures:service.failures, schedules:service.schedules})));
    serviceDisplay.append(button(service.paused ? '恢复阅读服务' : '暂停阅读服务', async () => {
      await api('/background/services/message-reading/' + (service.paused ? 'resume' : 'pause'), 'POST', {expected_revision:service.revision}); await loadManagement();
    }, true));
    if (!settingsArea.childElementCount) renderSettings();
    if (!profileArea.childElementCount) renderProfile();
  }
  function renderSettings() {
    const snapshot = configuration, form = el('form', undefined, 'reading-form'), inputs = {};
    form.append(el('h4', '模型与预算'), el('p', '保存的是目标配置；模型和 worker 配置重启后生效。'), el('pre', pretty({active:snapshot.active?.message_history, desired:snapshot.desired?.message_history, restart_required:snapshot.restart_required})));
    const raw=form.querySelector('pre');const configDetails=el('details');configDetails.append(el('summary','当前配置与待生效配置'));if(raw)configDetails.append(raw);form.append(configDetails);
    const values = snapshot.desired?.message_history || {};
    const algorithmWrap = el('label', '阅读方式（切换后重启生效）'), algorithm = el('select');
    [['legacy','现有方式'],['compact','紧凑阅读（主动启用）'],['selected','筛选阅读（主动启用）']].forEach(([key,label]) => { const option = el('option', label); option.value = key; algorithm.append(option); });
    algorithm.value = values.reading_algorithm || 'legacy'; algorithmWrap.append(algorithm); form.append(algorithmWrap); inputs.reading_algorithm = algorithm;
    [['participant_pool_capacity','普通画像池容量'],['participant_pinned_capacity','置顶画像容量']].forEach(([key,label]) => { inputs[key] = field(form,key,label,values[key] ?? (key === 'participant_pool_capacity' ? 30 : 10),'number'); inputs[key].min = key === 'participant_pool_capacity' ? '1' : '0'; inputs[key].max = key === 'participant_pool_capacity' ? '100' : '20'; });
    [['max_job_tokens','每任务 token 上限'],['max_job_calls','每任务调用上限'],['service_daily_token_limit','服务每天 token 上限'],['service_daily_call_limit','服务每天调用上限'],['conversation_daily_token_limit','每会话每天 token 上限'],['conversation_daily_call_limit','每会话每天调用上限']].forEach(([key,label]) => inputs[key] = field(form,key,label,values[key],key.includes('limit') || key.startsWith('max_') ? 'number' : undefined));
    inputs.background_client_name=el('input');inputs.background_client_name.value=values.background_client_name || '';
    inputs.background_model=el('input');inputs.background_model.value=values.background_model || '';
    const modelLabel=el('label','阅读模型'), modelSelect=el('select');modelLabel.append(modelSelect);form.insertBefore(modelLabel,form.children[3]);
    function modelOption(label,value){const option=el('option',label);option.value=value;return option;}
    function seedModels(){modelSelect.replaceChildren(modelOption('跟随后端默认模型',''));if(values.background_model){const saved=modelOption(values.background_model+'（已保存）',JSON.stringify([values.background_client_name||'',values.background_model]));saved.selected=true;modelSelect.append(saved);}}
    seedModels();modelSelect.addEventListener('change',()=>{const pair=modelSelect.value?JSON.parse(modelSelect.value):['',''];inputs.background_client_name.value=pair[0];inputs.background_model.value=pair[1];});
    api('/agent/models').then(catalog=>{if(!modelSelect.isConnected)return;const saved=modelSelect.value;seedModels();(catalog.clients||[]).forEach(client=>{const group=el('optgroup');group.label=client.name;(client.models||[]).forEach(model=>group.append(modelOption(model,JSON.stringify([client.name,model]))));modelSelect.append(group);});modelSelect.value=saved;}).catch(()=>{modelLabel.append(el('small','模型列表暂不可用，已保存的选择保留。'));});
    const cost = field(form, 'daily_cost_limit', '共享每天费用上限（0 表示不设费用门槛）', snapshot.desired?.background?.daily_cost_limit || 0, 'number'); cost.step = 'any'; cost.min = '0';
    form.append(button('保存目标配置', async () => {
      const message_history = {}; Object.entries(inputs).forEach(([key,input]) => message_history[key] = input.type === 'number' ? Number(input.value) : input.value.trim() || null);
      await api('/background/config', 'PATCH', {expected_revision:snapshot.revision,message_history,background:{daily_cost_limit:Number(cost.value)}});
      settingsArea.replaceChildren(); await loadManagement(); notify('目标配置已保存；请查看 active/desired 差异。');
    }, true));
    settingsArea.append(form);
  }
  function renderProfile() {
    const snapshot = profile, form = el('form', undefined, 'reading-form');
    form.append(el('h4', '显式关注设置'), el('p', '仅保存你明确填写的设置；不会扫描联系人或自动写入长期记忆。'));
    const inputs = {}; ['self_ids','aliases','keywords','critical_keywords','important_contacts','exclusions','tracked_topics'].forEach(key => inputs[key] = field(form,key,({self_ids:'我的平台账号',aliases:'我的称呼',keywords:'关注关键词',critical_keywords:'重要关键词',important_contacts:'重点联系人',exclusions:'忽略关键词',tracked_topics:'跟踪话题'})[key],pretty(snapshot[key] || (key === 'self_ids' ? {} : [])),'textarea'));
    Object.values(inputs).forEach(input => input.maxLength = 16000);
    form.append(button('保存关注设置', async () => {
      const payload = {expected_revision:snapshot.revision || 0}; Object.entries(inputs).forEach(([key,input]) => { payload[key] = JSON.parse(input.value); });
      const expected_revision = payload.expected_revision; delete payload.expected_revision;
      await api('/messages/reading/profile', 'PUT', {profile:payload,expected_revision}); profileArea.replaceChildren(); await loadManagement(); notify('显式关注设置已保存。');
    }, true)); profileArea.append(form);
  }
  management.addEventListener('toggle', () => { if (management.open) loadManagement().catch(error => notify(error.message,true)); });
  function schedule(event) {
    clearInterval(timer); timer = null;
    if (!document.hidden && (window.LkaMessages ? window.LkaMessages.view()==='reading'&&!window.LkaMessages.hasDetail?.() : host.open)) {if(!event?.detail?.back)refresh();timer=setInterval(()=>{if(!busy)refresh();},15000);}
  }
  host.addEventListener('toggle', schedule); window.addEventListener('lka-message-center-view', schedule); document.addEventListener('visibilitychange', schedule);
  let centerSelectedKey = '';
  window.LkaMessageReading = {refresh, setConversations(values, selectedKey) {
    const old = group.value, changed = selectedKey !== centerSelectedKey; centerSelectedKey = selectedKey; group.replaceChildren(); const all = el('option', '所有已记录会话'); all.value=''; group.append(all);
    values.forEach(item => { const option=el('option', (item.display_name || item.conversation_id) + '（' + item.conversation_id + '）'); option.value=item.conversation_key; group.append(option); });
    group.value = changed ? selectedKey || '' : old || '';
    if(changed){cursor=null; generation++; if(window.LkaMessages?.view()==='reading'&&!window.LkaMessages.hasDetail?.()) refresh();}
  }};
  window.addEventListener('pagehide', () => { clearInterval(timer); pending.forEach(item => { clearTimeout(item.timeout); item.reject(new Error('页面已关闭。')); }); pending.clear(); draft = approval = proposal = null; });
}());
