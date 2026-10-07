/* A conversation-first workbench for local evidence and explicit QQ sending. */
(function () {
  'use strict';
  if (!window.LkaMessageApi) return;
  const api = window.LkaMessageApi;
  const byId = id => document.getElementById(id);
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n; };
  const date = value => { const d = new Date(typeof value === 'number' ? value*1000 : value); return value && Number.isFinite(d.getTime()) ? d.toLocaleString() : '时间未知'; };
  const center = node('div', undefined, 'message-center-overlay'); center.id = 'messageCenter'; center.hidden = true;
  center.innerHTML = `<section class="message-center" role="dialog" aria-modal="true" aria-labelledby="messageCenterTitle">
    <header class="mc-header"><div><h2 id="messageCenterTitle">消息中心</h2><p>原文、阅读结果与人物档案</p></div><span id="mcConnection" class="mc-badge">正在连接</span><button id="mcRefresh" type="button" class="mc-quiet">刷新</button><button id="mcClose" type="button" aria-label="关闭消息中心">×</button></header>
    <nav class="mc-tabs" role="tablist" aria-label="消息中心视图"><button data-mc-tab="messages" role="tab" aria-selected="true" aria-controls="mcMessages">消息</button><button data-mc-tab="reading" role="tab" aria-selected="false" aria-controls="mcReading">阅读</button><button data-mc-tab="people" role="tab" aria-selected="false" aria-controls="mcPeople">人物档案</button><button data-mc-tab="settings" role="tab" aria-selected="false" aria-controls="mcSettings">设置</button></nav>
    <div class="mc-layout"><aside class="mc-sidebar" aria-label="消息会话"><label class="sr-only" for="mcConversationSearch">按名称或号码查找会话</label><input id="mcConversationSearch" type="search" placeholder="会话名称或号码" maxlength="256"><button id="mcResolve" type="button" class="mc-quiet">按名称或号码定位</button><div id="mcConversationList" class="mc-conversations" role="list"></div><button id="mcMoreConversations" type="button" class="mc-quiet" hidden>更多会话</button><div class="mc-sidebar-footer"><span id="mcConversationCount"></span></div></aside>
    <main class="mc-main"><section id="mcMessages" role="tabpanel" class="mc-message-view"><header class="mc-conversation-header"><div><h3 id="mcConversationTitle">选择一个会话</h3><p id="mcConversationMeta">只显示已授权记录的内容</p></div><button id="mcRename" type="button" class="mc-name-button" title="设置会话名称" aria-label="设置会话名称" disabled>✎</button><button id="mcDetails" type="button" class="mc-quiet" disabled>会话信息</button></header>
      <form id="mcSearchForm" class="mc-search"><label class="sr-only" for="mcQuery">搜索消息原文</label><input id="mcQuery" type="search" placeholder="搜索消息原文" maxlength="256"><label class="mc-check"><input id="mcSearchAll" type="checkbox">所有会话</label><button type="submit" class="mc-quiet">搜索</button><button id="mcClearSearch" type="button" class="mc-quiet" hidden>返回消息</button></form>
      <details class="mc-filter-details"><summary>作者与接收时间</summary><div class="mc-filter-fields"><label>作者名称<input id="mcSender" type="text" maxlength="256" placeholder="包含这个名字"></label><label>作者 ID<input id="mcSenderId" type="text" maxlength="256" placeholder="精确匹配"></label><label>接收开始<input id="mcSince" type="datetime-local"></label><label>接收结束<input id="mcUntil" type="datetime-local"></label></div></details>
      <div class="mc-timeline" id="mcTimeline" aria-label="消息原文"><p class="mc-empty">选择会话后，在这里查看消息。读取不会标记 QQ 已读。</p></div>
      <button id="mcNewMessages" type="button" class="mc-new" hidden>查看新消息</button>
      <div id="mcAttachments" class="mc-staged"></div><form id="mcComposer" class="mc-composer"><label class="sr-only" for="mcDraft">给当前 QQ 会话发消息</label><textarea id="mcDraft" rows="2" placeholder="可以先写草稿；发送需要本机与会话授权" maxlength="60000"></textarea><div class="mc-composer-actions"><button id="mcAddImage" type="button" class="mc-quiet">图片</button><button id="mcAddVideo" type="button" class="mc-quiet">视频</button><button id="mcAddSticker" type="button" class="mc-quiet">表情包</button><button id="mcFavorites" type="button" class="mc-quiet">收藏表情</button><span id="mcSendHint">发送尚未启用</span><button id="mcSend" type="submit" class="mc-primary" disabled>发送</button></div><input id="mcFile" type="file" hidden><p class="mc-key-hint">Enter 核对后发送 · Shift + Enter 换行</p></form><div id="mcReceipt" class="mc-receipt" role="status"></div>
    </section><section id="mcReading" role="tabpanel" class="mc-scroll" hidden></section><section id="mcPeople" role="tabpanel" class="mc-scroll" hidden><header class="mc-section-head"><h3>人物档案</h3><p>保留有原文证据的观察，可查证、可更正。活跃画像在“阅读”中查看。</p></header><div id="mcPeopleList" class="mc-people-list"></div><div id="mcPersonDetail" class="mc-person-detail"></div></section><section id="mcSettings" role="tabpanel" class="mc-scroll" hidden><div id="mcSendingSettings"></div></section><section id="mcDetailPanel" class="mc-detail-panel" hidden><header class="mc-detail-header"><button id="mcDetailBack" type="button">‹ 返回</button><div><h3 id="mcDetailTitle" tabindex="-1"></h3><p id="mcDetailSubtitle"></p></div></header><div id="mcDetailBody" class="mc-detail-body"></div></section></main></div>
    <footer class="mc-status" id="mcStatus" role="status" aria-live="polite">消息正文来自会话记录，请结合原文判断。</footer></section>`;
  document.body.append(center);
  const state = {open:false, tab:'messages', conversations:[], selected:null, metadata:new Map(), offset:null,
    generation:0, listGeneration:0, peopleGeneration:0, infoGeneration:0, messages:new Map(), outbound:new Map(), outboundCursor:0, outboundLoading:false,
    attachments:new Map(), before:null, searchOffset:null, searching:false,
    qq:null, caps:null, localPolicy:null, drafts:new Map(), attempts:new Map(), busy:false, uploading:false, timer:null, lastFocus:null};
  const getDraft = () => { const key = state.selected?.conversation_key || ''; if (!state.drafts.has(key)) state.drafts.set(key,{text:'',files:[]}); return state.drafts.get(key); };
  const title = item => window.LkaMessageNames.label(item,state.metadata.get(item.conversation_key));
  const notice = (text, bad) => { byId('mcStatus').textContent = text; byId('mcStatus').classList.toggle('error',!!bad); };
  const button = (text, fn, cls) => { const b = node('button',text,cls || 'mc-quiet'); b.type = 'button'; b.addEventListener('click', async event => { b.disabled=true; try { await fn(event); } catch (e) { notice(e.message,true); } finally { if (b.isConnected&&b.dataset.managed!=='true') b.disabled=false; } }); return b; };
  function identity(item) { return item && [item.platform,item.account_id,item.conversation_type,item.conversation_id].join(':'); }
  function backendPath(suffix) { return '/messages/conversations/' + encodeURIComponent(state.selected.conversation_key) + suffix; }
  function same(key, generation) { return state.open && state.selected?.conversation_key === key && state.generation === generation; }
  function renderConversations() {
    const value = byId('mcConversationSearch').value.trim().toLocaleLowerCase(), list = byId('mcConversationList'); list.replaceChildren();
    state.conversations.filter(item => [title(item),item.conversation_id,item.account_id].some(v => String(v || '').toLocaleLowerCase().includes(value))).forEach(item => {
      const row = button('', () => select(item), 'mc-conversation'); row.setAttribute('aria-current', String(state.selected?.conversation_key === item.conversation_key)); row.setAttribute('role','listitem');row.title=title(item)+(state.metadata.get(item.conversation_key)?.qq_name_stale?'（缓存名称，等待 QQ 更新）':'')+'\n'+item.account_id+' / '+item.conversation_id;
      row.append(node('strong',title(item)),node('span',(item.conversation_type === 'group' ? '群聊' : '私聊') + ' · ' + (item.message_count ?? item.total_count ?? 0) + ' 条记录'));
      row.append(node('small',(item.conversation_type==='group'?'群号 ':'QQ ')+item.conversation_id));
      if (item.pending_count) row.append(node('small',item.pending_count + ' 条待处理'));
      list.append(row);
    });
    if (!list.children.length) list.append(node('p', state.conversations.length ? '没有匹配的已载入会话。可按名称或号码定位。' : '尚无可查看的会话，请在设置中批准记录。', 'mc-empty'));
    byId('mcConversationCount').textContent = state.conversations.length + ' 个会话';
    byId('mcMoreConversations').hidden = state.offset == null;
    if(state.offset!=null)list.append(button('更多会话',()=>loadConversations(true),'mc-conversation mc-mobile-more'));
    syncReadingSelector();
  }
  async function loadConversations(more) {
    const generation = ++state.listGeneration;
    const data = await api.backend('/messages/conversations?limit=50&offset=' + (more ? state.offset || 0 : 0));
    if (!state.open || generation !== state.listGeneration) return;
    const values = data.conversations || [];values.forEach(item=>{const cached=state.metadata.get(item.conversation_key);if(cached?.label_source==='policy')state.metadata.set(item.conversation_key,{...cached,display_name:item.display_name,manual_display_name:item.display_name,user_alias:null});});
    state.conversations = more ? state.conversations.concat(values.filter(v => !state.conversations.some(x => x.conversation_key === v.conversation_key))) : values;
    state.offset = data.next_offset ?? null; renderConversations();
    if (!state.selected && state.conversations.length) await select(state.conversations[0]);
    // Bounded hydration improves labels without delaying the usable list.
    for (let start=0;start<values.length;start+=5) {
      await Promise.all(values.slice(start,start+5).map(async item => {
        await Promise.allSettled([hydrateGroupName(item,generation),(async()=>{
          try { const value = await api.backend('/messages/conversations/' + encodeURIComponent(item.conversation_key) + '/metadata'); if (state.open && generation === state.listGeneration) state.metadata.set(item.conversation_key,{...state.metadata.get(item.conversation_key),...value}); } catch (error) { if(error.status===404&&typeof item.display_name==='string'&&item.display_name.trim()&&item.display_name.trim()!==String(item.conversation_id))state.metadata.set(item.conversation_key,{...state.metadata.get(item.conversation_key),manual_display_name:item.display_name.trim(),label_source:'policy'}); }
        })()]);
      }));
      if (generation !== state.listGeneration || !state.open) return;
      renderConversations();
      if(state.selected)byId('mcConversationTitle').textContent=title(state.selected);
    }
  }
  let qqNamesUnavailableUntil=0;
  async function hydrateGroupName(item,generation){
    if(item.platform!=='qq'||item.conversation_type!=='group'||Date.now()<qqNamesUnavailableUntil)return;
    if(state.qq?.account_id&&String(state.qq.account_id)!==String(item.account_id))return;
    const old=state.metadata.get(item.conversation_key)||{};
    if(old.qq_name_checked_at&&Date.now()-old.qq_name_checked_at<300000)return;
    try{
      const data=await api.qq('/groups/'+encodeURIComponent(item.conversation_id)+'?account_id='+encodeURIComponent(item.account_id));
      if(!state.open||generation!==state.listGeneration)return;
      if(String(data.account_id)!==String(item.account_id)||String(data.group_id)!==String(item.conversation_id)||typeof data.group_name!=='string'||!data.group_name.trim())return;
      state.metadata.set(item.conversation_key,{...state.metadata.get(item.conversation_key),qq_group_name:data.group_name.trim(),qq_name_stale:data.stale===true,qq_name_checked_at:Date.now()});
    }catch(error){if([0,401,502,503].includes(error.status))qqNamesUnavailableUntil=Date.now()+30000;/* Local names remain available while QQ reconnects. */}
  }
  function syncReadingSelector() {
    if (window.LkaMessageReading) window.LkaMessageReading.setConversations(state.conversations.map(item => ({...item,display_name:title(item)})),state.selected?.conversation_key || '');
  }
  async function resolveConversation() {
    const query = byId('mcConversationSearch').value.trim(); if (!query) return;
    const generation = ++state.listGeneration, data = await api.backend('/messages/conversations/resolve?query=' + encodeURIComponent(query));
    if (!state.open || generation !== state.listGeneration) return;
    const values = data.matches || [];
    values.forEach(item => { state.metadata.set(item.conversation_key,{...state.metadata.get(item.conversation_key),...item}); if (!state.conversations.some(v => v.conversation_key === item.conversation_key)) state.conversations.push(item); });
    renderConversations();
    if (values.length === 1 && !data.ambiguous) await select(values[0]);
    else notice(values.length ? '名称对应多个会话，请在左侧按平台、账号与号码核对选择。' : '没有找到名称或号码完全匹配的已授权会话。');
  }
  async function select(item) {
    if (state.selected?.conversation_key === item.conversation_key) {if(detailStack.length&&clearDetails())window.dispatchEvent(new CustomEvent('lka-message-center-view',{detail:{open:state.open,tab:state.tab,back:true}}));return;}
    if(!clearDetails())return;
    if (state.selected) getDraft().text = byId('mcDraft').value;
    state.selected = item; state.generation++; state.peopleGeneration++; state.infoGeneration++; state.localPolicy = null;
    state.messages.clear(); state.outbound.clear(); state.outboundCursor=0; state.attachments.clear(); state.before = null; state.searching = false; state.searchOffset = null;
    byId('mcQuery').value = ''; byId('mcSearchAll').checked = false; byId('mcClearSearch').hidden = true;
    byId('mcConversationTitle').textContent = title(item);
    byId('mcConversationMeta').textContent = (item.conversation_type === 'group' ? '群聊' : '私聊') + ' ' + item.conversation_id + ' · ' + item.platform + ' · 账号 ' + item.account_id;
    byId('mcDetails').disabled = false;byId('mcRename').disabled=false; byId('mcPersonDetail').replaceChildren();
    byId('mcDraft').value = getDraft().text; renderStaged(); renderConversations(); renderReceipt(); updateSend();
    byId('mcTimeline').replaceChildren(node('p','正在读取消息…','mc-empty'));
    await Promise.allSettled([loadMessages(false), loadAttachments(), loadLocalPolicy()]);
    if (state.tab === 'people') loadPeople().catch(e=>notice(e.message,true));
  }
  function appendMessage(item, target, contextOnly) {
    const article = node('article',undefined,'mc-message');
    if (item.local_outgoing) article.classList.add('mc-outgoing');
    const author = item.sender_name || item.sender_id || (item.local_outgoing ? '我' : '未知发言者');
    const meta = node('header'); meta.append(node('strong',author),node('time',date(item.sent_at || item.received_at)));
    if (item.local_outgoing) meta.append(node('small','本机发送记录'));
    article.append(meta);
    if (item.reply_to_message_id) article.append(node('p','回复消息 ' + item.reply_to_message_id,'mc-reply'));
    if (state.searching && item.conversation_key !== state.selected?.conversation_key) {
      const conv = state.conversations.find(v => v.conversation_key === item.conversation_key);
      article.append(node('small',conv ? title(conv) : '其他已授权会话'));
    }
    window.LkaMessageContent.render({...item,attachments:item.attachments||state.attachments.get(item.message_id)},article);
    if (item.message_id && !item.local_outgoing && !contextOnly) article.append(button('查看上下文', () => showContext(item)));
    target.append(article); return article;
  }
  function renderTimeline(scroll) {
    const list = byId('mcTimeline'), oldTop=list.scrollTop, oldHeight=list.scrollHeight; list.replaceChildren();
    if (!state.searching && state.before != null) list.append(button('加载更早消息', () => loadMessages(true),'mc-load-more'));
    const values = Array.from(state.messages.values());
    const providers=new Set(values.map(m=>String(m.provider_message_id)));
    if(!state.searching)state.outbound.forEach(m=>{if(!providers.has(String(m.message_id)))values.push(m);});
    const time = m => typeof m.received_at==='number'?m.received_at*1000:Date.parse(m.received_at)||0;
    values.sort((a,b) => state.searching ? time(b)-time(a) : a.local_outgoing||b.local_outgoing ? time(a)-time(b) : Number(a.seq || 0)-Number(b.seq || 0));
    values.forEach(item => appendMessage({...item,attachments:state.attachments.get(item.message_id)||item.attachments},list));
    if (!values.length) list.append(node('p',state.searching ? '没有找到匹配原文。试试简短关键词，或调整作者和接收时间。' : '这个会话还没有可访问的记录。新消息会在记录与同步后出现。','mc-empty'));
    if (state.searching && state.searchOffset != null) list.append(button('更多搜索结果',()=>loadMessages(true),'mc-load-more'));
    if (scroll === 'bottom') list.scrollTop = list.scrollHeight;
    else if (scroll === 'prepend') list.scrollTop=oldTop+list.scrollHeight-oldHeight;
    else list.scrollTop=oldTop;
  }
  function rawQuery(more) {
    const q = new URLSearchParams({query:byId('mcQuery').value.trim(),limit:'50',offset:String(more ? state.searchOffset || 0 : 0)});
    if (!byId('mcSearchAll').checked && state.selected) q.set('conversation_key',state.selected.conversation_key);
    if (byId('mcSender').value.trim()) q.set('sender',byId('mcSender').value.trim());
    if (byId('mcSenderId').value.trim()) q.set('sender_id',byId('mcSenderId').value.trim());
    for (const [id,key] of [['mcSince','since'],['mcUntil','until']]) if (byId(id).value) q.set(key,String(Math.floor(new Date(byId(id).value).getTime()/1000)));
    if (q.has('since') && q.has('until') && Number(q.get('since'))>Number(q.get('until'))) throw new Error('接收开始时间不能晚于结束时间。');
    return q;
  }
  async function loadMessages(more, quiet) {
    const item = state.selected; if (!item) return;
    const key=item.conversation_key,generation=state.generation, searching=state.searching;
    try {
      let data;
      if (searching) data = await api.backend('/messages/search?' + rawQuery(more));
      else data = await api.backend(backendPath('/history?limit=50' + (more && state.before != null ? '&before_seq='+state.before : '')));
      if (!same(key,generation) || searching !== state.searching) return;
      const list=byId('mcTimeline'),follow=list.scrollHeight-list.scrollTop-list.clientHeight<100;
      if (!more && !quiet) state.messages.clear();
      let added=0;
      (data.messages || []).forEach(m => { const id=m.message_id || String(m.seq); if (!state.messages.has(id)) added++; state.messages.set(id,m); });
      if (searching) state.searchOffset=data.next_offset ?? null;
      else if (more || !quiet) state.before=data.next_before_seq ?? null;
      if (added || !quiet) renderTimeline(more && !searching ? 'prepend' : quiet ? (follow ? 'bottom':undefined) : searching ? undefined : 'bottom');
      if(quiet&&added&&!searching)loadAttachments();
      if (quiet && added && !follow) { byId('mcNewMessages').hidden=false; byId('mcNewMessages').textContent='查看 '+added+' 条新消息'; }
      if (!quiet) notice(searching ? '搜索匹配消息原文，时间条件按接收时间筛选。' : '原文已载入。查看不会改变 QQ 已读状态。');
    } catch(e) { if (same(key,generation)) { if([401,403,404].includes(e.status)){state.messages.clear();state.outbound.clear();state.attachments.clear();state.before=null;} if (!quiet) byId('mcTimeline').replaceChildren(node('p',e.message,'mc-empty')); notice(e.message,true); } }
  }
  function renderAttachment(value,target) {return window.LkaMessageContent.renderAttachment(value,target);}
  async function loadAttachments(){
    const item=state.selected;if(!item)return;const generation=state.generation;
    try{const data=await api.backend('/messages/attachments?conversation_key='+encodeURIComponent(item.conversation_key)+'&limit=50&offset=0');if(!same(item.conversation_key,generation))return;
      state.attachments.clear();(data.attachments||[]).forEach(a=>{const key=a.internal_message_id;if(!state.attachments.has(key))state.attachments.set(key,[]);state.attachments.get(key).push(a);});renderTimeline();
    }catch(_){/* Text remains available when the media interface isn't deployed. */}
  }
  async function showContext(item) {
    const generation=++state.infoGeneration, originalId=item.message_id||item.id;
    if(!originalId)throw new Error('这条消息没有可定位的消息标识。');
    const view=node('div',undefined,'mc-context-view'), controls=node('div',undefined,'mc-context-controls'), hint=node('p','正在定位原消息…','mc-context-hint'), thread=node('div',undefined,'mc-context-thread');
    const messages=new Map();let first=null,last=null,busy=false,older=true,newer=true;
    const convKey=item.conversation_key||state.selected?.conversation_key;
    const conversation=state.conversations.find(v=>v.conversation_key===convKey);
    const focusAnchor=()=>{const target=Array.from(thread.children).find(n=>n.dataset.anchor==='true');target?.scrollIntoView({block:'center',behavior:'auto'});};
    const beforeButton=button('更早消息',()=>load('before')),afterButton=button('较新消息',()=>load('after')),anchorButton=button('回到目标消息',focusAnchor),conversationButton=button('打开会话',()=>openConversation(convKey));
    beforeButton.dataset.managed=afterButton.dataset.managed='true';controls.append(beforeButton,anchorButton,afterButton,conversationButton);view.append(controls,hint,thread);
    openDetail({key:'context:'+originalId,title:'前后消息',subtitle:conversation?title(conversation):'消息原文',content:view,onBack:()=>{if(generation===state.infoGeneration)state.infoGeneration++;}});
    function update(){beforeButton.disabled=busy||!older;afterButton.disabled=busy||!newer;anchorButton.disabled=!messages.size;}
    const id=m=>m.message_id||m.id||String(m.seq);
    async function fetchContext(anchor,before,after){
      try{return await api.backend('/messages/records/'+encodeURIComponent(anchor.message_id||anchor.id)+'/context?before='+before+'&after='+after);}
      catch(error){
        if(error.status!==404)throw error;
        if(!convKey)throw new Error('运行中的服务不能定位这条原文。请更新后端上下文接口。');
        const base='/messages/conversations/'+encodeURIComponent(convKey)+'/history';
        let seq=Number(anchor.seq);
        if(!Number.isSafeInteger(seq)||seq<1){const page=await api.backend(base+'?limit=100');const found=(page.messages||[]).find(m=>id(m)===id(anchor)||m.provider_message_id===anchor.provider_message_id&&anchor.provider_message_id!=null);seq=Number(found?.seq);}
        if(!Number.isSafeInteger(seq)||seq<1)throw new Error('最近的历史记录中未找到这条原文。可点“打开会话”查看已记录的消息。');
        const [page,latest]=await Promise.all([api.backend(base+'?limit='+(before+after+1)+'&before_seq='+(seq+after+1)),api.backend(base+'?limit=1')]);
        const values=(page.messages||[]).filter(m=>after!==0||Number(m.seq)<=seq).filter(m=>before!==0||Number(m.seq)>=seq).sort((a,b)=>Number(a.seq)-Number(b.seq));
        if(!values.some(m=>id(m)===id(anchor)||Number(m.seq)===seq))throw new Error('这条原文已不可访问。可点“打开会话”查看当前已授权的历史。');
        return {messages:values,has_more_before:page.next_before_seq!=null,has_more_after:Number(latest.messages?.[0]?.seq)>Number(values.at(-1)?.seq),legacy_history:true};
      }
    }
    async function load(direction){
      if(busy)return;busy=true;update();const body=byId('mcDetailBody'),oldTop=body.scrollTop,oldHeight=body.scrollHeight;
      try{
        const data=await fetchContext(direction==='before'?first:direction==='after'?last:item,direction==='after'?0:direction==='before'?25:10,direction==='before'?0:direction==='after'?25:10);
        if(generation!==state.infoGeneration||!state.open)return;
        (data.messages||[]).forEach(m=>messages.set(id(m),m));const values=Array.from(messages.values()).sort((a,b)=>Number(a.seq)-Number(b.seq));first=values[0];last=values.at(-1);
        if(direction!=='after')older=data.has_more_before===true;if(direction!=='before')newer=data.has_more_after===true;
        thread.replaceChildren();let prior=null;
        values.forEach(m=>{if(prior!=null&&Number(m.seq)>prior+1)thread.append(node('p','此处有消息缺口','mc-context-gap'));const article=appendMessage(m,thread,true);if(id(m)===originalId){article.classList.add('mc-anchor');article.dataset.anchor='true';article.prepend(node('span','目标消息','mc-anchor-label'));}prior=Number(m.seq);});
        if(!values.length)thread.append(node('p','这条消息已不可访问。','mc-empty'));
        hint.classList.remove('error');notice('已显示 '+values.length+' 条前后消息。');
        hint.textContent=(data.legacy_history?'来自本机已授权历史；当前服务使用历史分页定位。':'来自当前采集范围。')+' 已载入 '+values.length+' 条消息；不保证完整 QQ 历史。'+(data.gap_before||data.gap_after?' 当前范围存在缺口。':'');
        if(direction==='before')body.scrollTop=oldTop+body.scrollHeight-oldHeight;else if(!direction)requestAnimationFrame(focusAnchor);else body.scrollTop=oldTop;
      }catch(e){if(generation!==state.infoGeneration)return;hint.textContent=e.message;hint.classList.add('error');if(!thread.children.length){appendMessage(item,thread,true);thread.append(button('重试定位',()=>load()));}notice(e.message,true);}
      finally{busy=false;update();}
    }
    await load();
  }
  async function openConversation(key){
    let item=state.conversations.find(v=>v.conversation_key===key);
    if(!item){const data=await api.backend('/messages/conversations?limit=200&offset=0');item=(data.conversations||[]).find(v=>v.conversation_key===key);if(item){state.conversations.push(item);renderConversations();}}
    if(!item)throw new Error('当前无法访问这条消息所在的会话。');
    if(!clearDetails())return;await select(item);setTab('messages');state.generation++;state.searching=false;byId('mcQuery').value='';byId('mcClearSearch').hidden=true;await loadMessages(false);
  }
  async function showInfo() {
    const selected=state.selected;if(!selected)return;
    const generation=++state.infoGeneration,key=selected.conversation_key;
    const results=await Promise.allSettled([api.backend(backendPath('/metadata')),api.backend(backendPath('/coverage')),api.backend('/messages/attachments?conversation_key='+encodeURIComponent(key)+'&limit=20&offset=0')]);
    if(!state.open || state.selected?.conversation_key!==key || generation!==state.infoGeneration)return;
    const metadata=results[0].status==='fulfilled'?results[0].value:state.metadata.get(key);
    const content=node('div',undefined,'mc-info');
    content.append(node('p','平台：'+selected.platform+'；账号：'+selected.account_id),node('p','会话号码：'+selected.conversation_id),node('p','内部标识：'+key,'mc-muted'));
    content.append(button('设置会话名称',showRename));
    const coverage=results[1].status==='fulfilled'?(results[1].value.coverage||results[1].value):null;
    if(coverage){content.append(node('h4','分析覆盖'),node('p','本轮分析起点：'+(coverage.analysis_baseline_floor_seq??'未知')+'；分析到：'+(coverage.analysis_watermark_seq??coverage.analysis_covered_seq??'未知')),node('p','排除的历史：'+(coverage.excluded_history_count??'未知')+' 条；待处理：'+(coverage.pending_messages??'未知')+' 条'),node('p','覆盖表示处理范围，不代表模型已读全部原文，也不代表平台历史完整。','mc-muted'));}
    if(results[2].status==='fulfilled'){content.append(node('h4','最近附件'));const values=results[2].value.attachments||[];values.forEach(v=>renderAttachment(v,content));if(!values.length)content.append(node('p','没有可访问的附件记录。','mc-muted'));}
    openSheet('会话信息',content);
  }
  async function loadPeople(more) {
    const key=state.selected?.conversation_key || '', generation=++state.peopleGeneration;
    const root=byId('mcPeopleList');if(!more)root.replaceChildren(node('p','正在载入档案…','mc-empty'));
    try{
      const data=await api.backend('/messages/reading/dossiers?limit=30&offset='+(more||0)+(key?'&conversation_key='+encodeURIComponent(key):''));
      if(!state.open || generation!==state.peopleGeneration)return;
      if(!more)root.replaceChildren();root.querySelector('.mc-load-more')?.remove();
      (data.dossiers||[]).forEach(person=>{const row=node('article',undefined,'mc-person');row.append(node('strong',window.LkaMessageNames.personLabel(person)),node('small',window.LkaMessageNames.personIdentity(person)),node('p',(person.claim_count??0)+' 条观察 · '+(person.source_count??0)+' 条原文证据'),node('small',person.human_correction?'已人工更正':'模型观察，需结合证据核实'));row.append(button('查看档案与证据',()=>openPerson(person)));root.append(row);});
      if(!root.children.length)root.append(node('p','还没有有证据的持久人物档案。后台阅读形成结果后会出现在这里。','mc-empty'));
      if(data.next_offset!=null)root.append(button('更多人物档案',()=>loadPeople(data.next_offset),'mc-load-more'));
    }catch(e){if(generation===state.peopleGeneration)root.replaceChildren(node('p',e.status===404?'当前后端尚未提供持久档案接口。可在“阅读 → 参与者”查看已有活跃画像。':e.message,'mc-empty'));}
  }
  async function openPerson(person) {
    const generation=++state.infoGeneration;
    const detail=byId('mcPersonDetail');detail.replaceChildren(node('p','正在载入人物档案与证据…','mc-loading'));openDetail({key:'person:'+person.conversation_key+':'+person.sender_id,title:window.LkaMessageNames.personLabel(person),content:detail});
    const base='/messages/reading/dossiers/'+encodeURIComponent(person.conversation_key)+'/'+encodeURIComponent(person.sender_id);
    let data;try{data=await api.backend(base+'?limit=30&offset=0');}catch(e){if(generation===state.infoGeneration)detail.replaceChildren(node('p',e.message,'mc-inline-error'),button('重试读取',()=>openPerson(person)));throw e;}
    if(!state.open || generation!==state.infoGeneration)return;
    const name=window.LkaMessageNames.personLabel({...person,...data});window.LkaMessages.updateDetail(detail,{title:name});
    detail.replaceChildren(node('h3',name),node('p',window.LkaMessageNames.personIdentity(person)+'；更新：'+date(data.updated_at),'mc-muted'));
    if(data.human_correction)detail.append(node('h4','人工更正'),node('p',data.human_correction));
    const claims=node('div');detail.append(claims);renderObservations(data,claims);
    async function moreEntries(offset){const page=await api.backend(base+'?limit=30&offset='+offset);if(generation!==state.infoGeneration)return;renderObservations(page,claims);}
    function renderObservations(page,target){target.querySelector('.mc-load-more')?.remove();for(const [field,label] of [['claims','有证据的观察'],['machine_notes','未采纳的模型记录']]){const entries=page[field]||[];if(!entries.length)continue;target.append(node('h4',label));entries.forEach(claim=>{const card=node('article',undefined,'mc-observation');card.append(node('p',claim.text||claim.summary||claim.note||'待核实观察'),node('small',({explicit:'原文明确表达',observed:'行为观察',uncertain:'推测，待核实'})[claim.basis||claim.proposed_basis]||'待核实'));if(field==='machine_notes'){card.append(node('small','状态：'+(({stale:'已过时',expired:'已过期',rejected:'未采纳',candidate:'候选',uncertain:'不确定'})[claim.status]||'未确认')));if(claim.rejection_reason)card.append(node('small','未采纳原因：'+claim.rejection_reason));}if(claim.quote)card.append(node('blockquote',claim.quote));const expiry=claim.valid_until||claim.expires_at||claim.proposed_valid_until;if(expiry)card.append(node('small','有效期：'+date(expiry)));target.append(card);});}if(page.next_offset!=null)target.append(button('更多观察',()=>moreEntries(page.next_offset),'mc-load-more'));}
    detail.append(node('p','这些是可修订的观察，不是人格或永久事实认证。','mc-muted'));
    const sources=node('div');detail.append(node('h4','原文证据'),sources);
    async function loadSources(offset){const page=await api.backend(base+'/sources?limit=20&offset='+(offset||0));if(generation!==state.infoGeneration)return;sources.querySelector('.mc-load-more')?.remove();(page.sources||[]).forEach(m=>appendMessage(m,sources));if(page.next_offset!=null)sources.append(button('更多证据',()=>loadSources(page.next_offset),'mc-load-more'));}
    await loadSources(0);
  }
  function isQQTarget() { const item=state.selected;return !!item&&item.platform==='qq'&&['private','group'].includes(item.conversation_type)&&String(item.account_id)===String(state.qq?.account_id); }
  function maySend() { return isQQTarget()&&state.qq?.ready&&state.qq?.send_enabled&&state.localPolicy?.send_enabled; }
  async function loadLocalPolicy() {
    if(!isQQTarget()||!state.qq?.ready)return;
    const item=state.selected,generation=state.generation;
    try{const value=await api.qq('/conversations/'+item.conversation_type+'/'+encodeURIComponent(item.conversation_id));if(same(item.conversation_key,generation)){state.localPolicy=value;updateSend();renderSendingSettings();await loadOutbound();}}catch(e){if(same(item.conversation_key,generation)){state.localPolicy=null;updateSend();}}
  }
  async function loadOutbound() {
    if(!isQQTarget()||!state.localPolicy?.receive_enabled||state.searching||state.outboundLoading)return;
    const item=state.selected,generation=state.generation;
    state.outboundLoading=true;let changed=false;
    try{for(let page=0;page<3;page++){
      const data=await api.qq('/messages?conversation_type='+item.conversation_type+'&conversation_id='+encodeURIComponent(item.conversation_id)+'&after='+state.outboundCursor+'&limit=100');
      if(!same(item.conversation_key,generation)||state.searching)return;
      (data.messages||[]).filter(m=>m.direction==='outgoing').forEach(m=>{const key='local:'+m.message_id;if(!state.outbound.has(key))changed=true;state.outbound.set(key,{...m,local_outgoing:true});});
      if(data.next_cursor!=null&&data.next_cursor>state.outboundCursor)state.outboundCursor=data.next_cursor;else break;
      if(!data.has_more)break;
    }if(changed)renderTimeline();}finally{state.outboundLoading=false;}
  }
  function updateSend() {
    const draft=getDraft(), attempt=state.attempts.get(state.selected?.conversation_key);
    byId('mcSend').disabled=!maySend()||state.busy||state.uploading||!!attempt&&['pending','unknown'].includes(attempt.state)||(!byId('mcDraft').value.trim()&&!draft.files.length);
    byId('mcSend').textContent=state.busy?'发送中…':'发送';
    const hint=!state.selected?'先选择 QQ 会话':!isQQTarget()?'当前会话不属于已连接的 QQ 账号':!state.qq?.ready?'QQ 消息插件未启用':!state.qq?.send_enabled?'本机发送总开关未启用':!state.localPolicy?.send_enabled?'当前会话尚未授权发送':state.uploading?'正在上传附件':state.busy?'可继续输入下一条草稿':'手动发送';
    byId('mcSendHint').textContent=hint;
    ['mcAddImage','mcAddVideo','mcAddSticker','mcFavorites'].forEach(id=>byId(id).disabled=!maySend()||state.uploading);
    // Draft input deliberately stays enabled during upload, sending and offline states.
  }
  function renderStaged() {
    const root=byId('mcAttachments');root.replaceChildren();
    getDraft().files.forEach((file,index)=>{const card=node('div',undefined,'mc-file-chip');card.append(node('span',file.name||file.kind));card.append(button('移除',()=>{getDraft().files.splice(index,1);renderStaged();updateSend();}));root.append(card);});
  }
  function chooseFile(kind) {
    if(!maySend())return;
    const input=byId('mcFile');input.value='';input.dataset.kind=kind;
    input.accept=kind==='video'?'.mp4,.webm':'image/png,image/jpeg,image/gif,image/webp';input.click();
  }
  async function onFile(event) {
    if(!maySend())return;const file=event.target.files[0];if(!file)return;
    const kind=event.target.dataset.kind,key=state.selected?.conversation_key,draft=getDraft();
    const limit=kind==='video'?state.caps?.video_max_bytes||209715200:state.caps?.image_max_bytes||20971520;
    if(file.size>limit){notice('文件超出限制：'+Math.round(limit/1048576)+' MB。',true);return;}
    if((kind==='video'&&(draft.files.length||draft.text.trim()))||draft.files.some(v=>v.kind==='video'||v.kind==='custom_face')){notice('视频和收藏表情需要单独发送。请先移除当前草稿内容。',true);return;}
    state.uploading=true;updateSend();
    try{const value=await api.upload(kind,file,p=>{if(state.selected?.conversation_key===key)notice('正在上传 '+file.name+'：'+Math.round(p*100)+'%');});draft.files.push({kind,media_id:value.id,name:file.name});if(state.selected?.conversation_key===key){renderStaged();notice('附件已上传，核对后再发送。');}}
    catch(e){notice(e.message,true);}finally{state.uploading=false;updateSend();}
  }
  async function favorites() {
    if(!maySend())return;const item=state.selected;
    const data=await api.qq('/stickers?limit=48');if(state.selected?.conversation_key!==item.conversation_key)return;
    const content=node('div');content.append(node('p','收藏表情按 QQ 标识列出，当前接口未提供缩略图。','mc-muted'));
    (data.stickers||[]).forEach((value,index)=>content.append(button('收藏表情 '+(index+1),()=>{if(state.selected?.conversation_key!==item.conversation_key)return;const draft=getDraft();if(draft.text.trim()||draft.files.length)throw new Error('收藏表情需要单独发送，请先清空这条草稿。');draft.files.push({kind:'custom_face',emoji_id:value.emoji_id,name:'收藏表情 '+(index+1)});renderStaged();updateSend();closeSheet();})));
    if(!data.stickers?.length)content.append(node('p','QQ 未返回可用收藏表情。','mc-empty'));openSheet('选择收藏表情',content);
  }
  function newKey(){if(window.crypto?.randomUUID)return window.crypto.randomUUID();const b=new Uint8Array(16);window.crypto.getRandomValues(b);return Array.from(b,n=>n.toString(16).padStart(2,'0')).join('');}
  async function send(event) {
    event.preventDefault();if(!event.isTrusted||state.busy||!maySend())return;
    const item=state.selected,key=item.conversation_key,draft=getDraft(),text=byId('mcDraft').value;
    const prior=state.attempts.get(key);if(prior&&['pending','unknown'].includes(prior.state)){notice('上一条结果尚未明确，请先查询回执。',true);return;}
    const segments=[];if(text.trim())segments.push({type:'text',text});draft.files.forEach(f=>segments.push(f.kind==='custom_face'?{type:f.kind,emoji_id:f.emoji_id}:{type:f.kind,media_id:f.media_id}));
    if(!segments.length)return;
    if(segments.length>1&&segments.some(v=>v.type==='video'||v.type==='custom_face')){notice('视频和收藏表情必须单独发送。',true);return;}
    const files=draft.files.slice();
    const confirmed=await confirmSend(item,text,files);if(!confirmed||state.selected?.conversation_key!==key||!maySend())return;
    const attempt={key:newKey(),state:'pending',text,files,segments,draft,created_at:new Date().toISOString(),target:title(item),conversationKey:key};
    state.attempts.set(key,attempt);state.busy=true;renderReceipt();updateSend();
    try{
      const receipt=await api.qq('/messages/send','POST',{idempotency_key:attempt.key,conversation_type:item.conversation_type,conversation_id:item.conversation_id,segments});Object.assign(attempt,receipt);
      reconcileReceipt(attempt);
    }catch(e){attempt.state=e.status&&e.status>=400&&e.status<500?'failed':'unknown';attempt.error=e.message;}
    finally{state.busy=false;if(state.selected?.conversation_key===key)renderReceipt();updateSend();}
  }
  function renderReceipt() {
    const root=byId('mcReceipt');root.replaceChildren();const attempt=state.attempts.get(state.selected?.conversation_key);if(!attempt)return;
    const labels={pending:'正在发送，可继续写下一条草稿。',accepted:'QQ 已接受这条消息。对方是否收到或已读仍需确认。',failed:'这条消息被拒绝，草稿已保留。',unknown:'发送结果未知，请先核对回执和 QQ，避免重复发送。'};
    root.append(node('span',labels[attempt.state]||'发送状态未知。'));
    if(attempt.error)root.append(node('small',({account_mismatch:'QQ 登录账号已变化，请核对本机配置。',auth_error:'动作接口鉴权失败。',action_failed:'QQ 网关拒绝了发送。',timeout:'等待 QQ 回执超时。',network_error:'连接中断。'})[attempt.error]||attempt.error));
    if(['unknown','pending'].includes(attempt.state))root.append(button('查询回执',async()=>{const data=await api.qq('/sends/'+encodeURIComponent(attempt.key));Object.assign(attempt,data);reconcileReceipt(attempt);renderReceipt();updateSend();}));
  }
  function reconcileReceipt(attempt){
    if(attempt.state!=='accepted'||attempt.reconciled)return;attempt.reconciled=true;
    if(attempt.draft.text===attempt.text){attempt.draft.text='';if(state.selected?.conversation_key===attempt.conversationKey&&byId('mcDraft').value===attempt.text)byId('mcDraft').value='';}
    attempt.draft.files=attempt.draft.files.filter(f=>!attempt.files.includes(f));
    if(state.selected?.conversation_key===attempt.conversationKey){state.outbound.set('local:'+attempt.message_id,{message_id:attempt.message_id,local_outgoing:true,received_at:attempt.created_at,text:attempt.text,segments:attempt.segments,sender_name:'我'});renderTimeline('bottom');renderStaged();}
  }
  async function loadStatus() {
    const [status,caps]=await Promise.allSettled([api.qq('/status'),api.qq('/capabilities')]);
    if(!state.open)return;
    state.qq=status.status==='fulfilled'?status.value:null;state.caps=caps.status==='fulfilled'?caps.value:null;
    byId('mcConnection').textContent=state.qq?.reading_paired?'阅读已配对':state.qq?'阅读未配对':'前端适配未加载';
    updateSend();if(state.selected)await loadLocalPolicy();renderSendingSettings();
  }
  let settingsSignature='';
  function renderSendingSettings() {
    const signature=JSON.stringify([identity(state.selected),state.qq?.account_id,state.qq?.ready,state.qq?.send_enabled,state.localPolicy?.receive_enabled,state.localPolicy?.send_enabled]);
    if(signature===settingsSignature)return;settingsSignature=signature;
    const root=byId('mcSendingSettings');root.replaceChildren(node('h3','QQ 手动发送'),node('p','采集、模型阅读与手动发送分别授权。这里不会自动开启发送总开关。','mc-muted'));
    root.append(node('p','本机消息插件：'+(state.qq?.ready?'已就绪':'未启用')+'；发送总开关：'+(state.qq?.send_enabled?'已启用':'关闭')));
    if(!isQQTarget()||!state.qq?.ready){root.append(node('p','选择属于当前 QQ 账号的会话，并在本机配置启用消息插件后，才能调整发送权限。','mc-muted'));return;}
    const form=node('form',undefined,'mc-policy');const receive=node('input'),send=node('input');receive.type=send.type='checkbox';receive.checked=state.localPolicy?.receive_enabled===true;send.checked=state.localPolicy?.send_enabled===true;
    for(const [input,label] of [[receive,'保存此会话到本机消息插件'],[send,'允许向此会话手动发送']]){const wrap=node('label',undefined,'mc-check');wrap.append(input,document.createTextNode(label));form.append(wrap);}
    form.append(button('保存此会话权限',async event=>{if(!event.isTrusted)return;const item=state.selected;const value=await api.qq('/conversations/'+item.conversation_type+'/'+encodeURIComponent(item.conversation_id),'PUT',{receive_enabled:receive.checked,send_enabled:send.checked});if(state.selected?.conversation_key===item.conversation_key){state.localPolicy=value;updateSend();}notice('本机会话权限已保存。后台记录与分析策略未改变。');}));form.addEventListener('submit',event=>event.preventDefault());root.append(form);
  }
  const detailStack=[];
  const tabLabel=()=>({messages:'消息',reading:'阅读列表',people:'人物列表',settings:'设置'})[state.tab];
  function restoreContent(frame){if(frame.parent){frame.parent.insertBefore(frame.content,frame.next?.parentNode===frame.parent?frame.next:null);frame.content.hidden=!!frame.restoreHidden;}else frame.content.remove();}
  function renderDetail(){
    const frame=detailStack.at(-1), panel=byId('mcDetailPanel');
    for(const [tab,id] of [['messages','mcMessages'],['reading','mcReading'],['people','mcPeople'],['settings','mcSettings']])byId(id).hidden=!!frame||state.tab!==tab;
    panel.hidden=!frame;if(!frame)return;
    byId('mcDetailTitle').textContent=frame.title;byId('mcDetailTitle').title=frame.title;
    byId('mcDetailSubtitle').textContent=frame.subtitle||'';
    byId('mcDetailBack').textContent='‹ '+(detailStack.length>1?'返回上一页':'返回'+tabLabel());
    frame.content.hidden=false;byId('mcDetailBody').replaceChildren(frame.content);
  }
  function openDetail(options){
    const current=detailStack.at(-1);
    if(current?.content===options.content){Object.assign(current,options);renderDetail();return;}
    const parent=options.content.parentNode;
    detailStack.push({...options,parent,next:options.content.nextSibling,restoreHidden:options.restoreHidden!==false,focus:document.activeElement,bodyScroll:current?byId('mcDetailBody').scrollTop:0,scroll:byId('mc'+({messages:'Timeline',reading:'Reading',people:'People',settings:'Settings'})[state.tab])?.scrollTop||0});
    renderDetail();byId('mcDetailTitle').focus();byId('mcDetailBody').scrollTop=0;
    window.dispatchEvent(new CustomEvent('lka-message-center-view',{detail:{open:state.open,tab:state.tab,detail:true}}));
  }
  function backDetail(){
    const frame=detailStack.at(-1);if(!frame)return false;
    if(frame.canLeave&&!frame.canLeave())return false;
    detailStack.pop();frame.onBack?.();restoreContent(frame);renderDetail();
    const scroller=detailStack.length?byId('mcDetailBody'):byId('mc'+({messages:'Timeline',reading:'Reading',people:'People',settings:'Settings'})[state.tab]);
    if(scroller)scroller.scrollTop=detailStack.length?frame.bodyScroll:frame.scroll;
    if(frame.focus?.isConnected&&frame.focus.getClientRects().length)frame.focus.focus();else if(detailStack.length)byId('mcDetailTitle').focus();else center.querySelector('[data-mc-tab][aria-selected="true"]')?.focus();
    window.dispatchEvent(new CustomEvent('lka-message-center-view',{detail:{open:state.open,tab:state.tab,detail:!!detailStack.length,back:true}}));return true;
  }
  function clearDetails(){
    if(detailStack.some(frame=>frame.canLeave&&!frame.canLeave()))return false;
    while(detailStack.length){const frame=detailStack.pop();frame.onBack?.();restoreContent(frame);}renderDetail();return true;
  }
  byId('mcDetailBack').addEventListener('click',backDetail);
  async function showRename(){
    const item=state.selected;if(!item)return;
    const content=node('form',undefined,'mc-info-form'),label=node('label','显示名称'),input=node('input');
    input.value=title(item).startsWith('未命名')?'':title(item);input.maxLength=512;input.placeholder=item.conversation_type==='group'?'可选：设置群聊显示备注':'输入联系人名称';label.append(input);content.append(label,node('p','群名默认从 QQ 读取。这里可设置本应用的显示备注，不会修改 QQ 名称或采集、分析权限。','mc-muted'));
    const error=node('p',undefined,'mc-inline-error');error.setAttribute('role','alert');content.append(error);
    const saveName=async event=>{if(!event.isTrusted)return;try{const metadata=await window.LkaMessageNames.rename(item,input.value);state.metadata.set(item.conversation_key,metadata);const original=state.conversations.find(v=>v.conversation_key===item.conversation_key);if(original)original.display_name=metadata.display_name||metadata.user_alias;renderConversations();if(state.selected?.conversation_key===item.conversation_key)byId('mcConversationTitle').textContent=title(item);closeSheet();notice('会话名称已保存。');}catch(e){error.textContent=e.message;input.focus();}};const save=button('保存名称',saveName);
    content.append(save);content.addEventListener('submit',event=>{event.preventDefault();saveName(event);});openSheet('设置会话名称',content);input.focus();
  }

  const sheet=node('div',undefined,'mc-sheet-overlay');sheet.hidden=true;sheet.innerHTML='<section class="mc-sheet" role="dialog" aria-modal="true" aria-labelledby="mcSheetTitle"><header><h3 id="mcSheetTitle"></h3><button id="mcSheetClose" type="button" aria-label="关闭详情">×</button></header><div id="mcSheetBody"></div></section>';center.append(sheet);
  let sheetFocus=null, confirmationResolve=null;
  function openSheet(title,content){sheetFocus=document.activeElement;byId('mcSheetTitle').textContent=title;byId('mcSheetBody').replaceChildren(content);sheet.hidden=false;byId('mcSheetClose').focus();}
  function closeSheet(){sheet.hidden=true;if(confirmationResolve){confirmationResolve(false);confirmationResolve=null;}if(sheetFocus?.isConnected)sheetFocus.focus();}
  byId('mcSheetClose').addEventListener('click',closeSheet);
  function confirmSend(item,text,files){return new Promise(resolve=>{const content=node('div');content.append(node('p','发送给：'+title(item)+'（'+item.conversation_id+'）'),node('p','从 QQ 账号 '+item.account_id+' 发出。','mc-muted'));if(text)content.append(node('blockquote',text));files.forEach(f=>content.append(node('p',f.name)));const actions=node('div',undefined,'mc-dialog-actions');actions.append(button('取消',closeSheet),button('确认发送',event=>{if(!event.isTrusted)return;confirmationResolve=null;sheet.hidden=true;resolve(true);},'mc-primary'));content.append(actions);openSheet('核对收件人和内容',content);confirmationResolve=resolve;});}
  function setTab(tab){if(!clearDetails())return;if(!sheet.hidden)closeSheet();state.tab=tab;center.querySelectorAll('[data-mc-tab]').forEach(b=>{const active=b.dataset.mcTab===tab;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;});for(const [key,id] of [['messages','mcMessages'],['reading','mcReading'],['people','mcPeople'],['settings','mcSettings']])byId(id).hidden=key!==tab;if(tab==='people')loadPeople().catch(e=>notice(e.message,true));window.dispatchEvent(new CustomEvent('lka-message-center-view',{detail:{open:state.open,tab}}));}
  async function open(){
    const context=window.LkaChatContext?.get();
    if(context&&!context.workMode){const url=new URL('./chat.html',window.location.href);url.search='?mode=work&panel=messages&backend='+encodeURIComponent(context.backend)+(context.sessionId?'&session_id='+encodeURIComponent(context.sessionId):'');if(window.petBridge?.openExternalUrl)window.petBridge.openExternalUrl(url.href);else window.open(url.href,'_blank','noopener');return;}
    if(state.open)return;const previousSelection=state.selected?.conversation_key;state.lastFocus=document.activeElement;state.open=true;center.hidden=false;byId('mcClose').focus();
    const settled=await Promise.allSettled([loadStatus(),loadConversations(false)]);if(previousSelection&&state.selected?.conversation_key===previousSelection)await Promise.allSettled([loadMessages(false),loadAttachments()]);if(!state.open)return;settled.forEach(r=>{if(r.status==='rejected')notice(r.reason.message,true);});
    window.dispatchEvent(new CustomEvent('lka-message-center-view',{detail:{open:true,tab:state.tab}}));clearInterval(state.timer);state.timer=setInterval(()=>{if(!state.open||document.hidden)return;loadStatus().catch(()=>{});if(!detailStack.length&&state.tab==='messages'&&!state.searching&&state.selected)loadMessages(false,true);},15000);
  }
  function close(){if(!clearDetails())return;if(!sheet.hidden)closeSheet();if(state.selected)getDraft().text=byId('mcDraft').value;state.open=false;state.generation++;state.listGeneration++;state.peopleGeneration++;state.infoGeneration++;clearInterval(state.timer);center.hidden=true;window.dispatchEvent(new CustomEvent('lka-message-center-view',{detail:{open:false,tab:state.tab}}));if(state.lastFocus?.isConnected)state.lastFocus.focus();}
  byId('mcClose').addEventListener('click',close);['openMessagesButton','openMessageCenterButton'].forEach(id=>byId(id)?.addEventListener('click',open));
  center.querySelectorAll('[data-mc-tab]').forEach(b=>b.addEventListener('click',()=>setTab(b.dataset.mcTab)));
  center.querySelector('.mc-tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const buttons=Array.from(center.querySelectorAll('[data-mc-tab]')),index=buttons.indexOf(document.activeElement);const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:buttons.length-1))%buttons.length;buttons[next].focus();setTab(buttons[next].dataset.mcTab);});
  byId('mcConversationSearch').addEventListener('input',renderConversations);byId('mcResolve').addEventListener('click',()=>resolveConversation().catch(e=>notice(e.message,true)));
  byId('mcMoreConversations').addEventListener('click',()=>loadConversations(true).catch(e=>notice(e.message,true)));
  byId('mcRefresh').addEventListener('click',()=>{loadStatus().catch(e=>notice(e.message,true));loadConversations(false).catch(e=>notice(e.message,true));if(state.selected)loadMessages(false,true);});
  byId('mcRename').addEventListener('click',()=>showRename().catch(e=>notice(e.message,true)));
  byId('mcDetails').addEventListener('click',()=>showInfo().catch(e=>notice(e.message,true)));
  byId('mcSearchForm').addEventListener('submit',event=>{event.preventDefault();if(!byId('mcQuery').value.trim()){notice('请输入原文关键词。',true);return;}state.generation++;state.searching=true;byId('mcClearSearch').hidden=false;loadMessages(false);});
  byId('mcClearSearch').addEventListener('click',()=>{state.generation++;state.searching=false;byId('mcQuery').value='';byId('mcClearSearch').hidden=true;loadMessages(false);});
  byId('mcNewMessages').addEventListener('click',()=>{byId('mcTimeline').scrollTop=byId('mcTimeline').scrollHeight;byId('mcNewMessages').hidden=true;});
  byId('mcDraft').addEventListener('input',()=>{getDraft().text=byId('mcDraft').value;updateSend();});
  byId('mcDraft').addEventListener('keydown',event=>{if(document.body.classList.contains('mobile-workbench')&&window.matchMedia('(pointer: coarse)').matches&&!event.ctrlKey&&!event.metaKey)return;if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(!byId('mcSend').disabled)byId('mcComposer').requestSubmit();}});
  byId('mcComposer').addEventListener('submit',send);
  [['mcAddImage','image'],['mcAddVideo','video'],['mcAddSticker','sticker']].forEach(([id,kind])=>byId(id).addEventListener('click',()=>chooseFile(kind)));
  byId('mcFavorites').addEventListener('click',()=>favorites().catch(e=>notice(e.message,true)));byId('mcFile').addEventListener('change',onFile);
  document.addEventListener('keydown',event=>{if(!state.open)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(!sheet.hidden)closeSheet();else if(detailStack.length)backDetail();else close();return;}if(event.key!=='Tab')return;const root=sheet.hidden?center:sheet;const values=Array.from(root.querySelectorAll('button,input,textarea,select,summary,[tabindex="0"]')).filter(n=>!n.disabled&&n.getClientRects().length);if(!values.length)return;const first=values[0],last=values[values.length-1];if(event.shiftKey&&(document.activeElement===first||!root.contains(document.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||!root.contains(document.activeElement))){event.preventDefault();first.focus();}},true);
  const history=byId('messageHistoryPanel'),reading=document.querySelector('.message-reading');
  if(reading){byId('mcReading').append(reading);const management=reading.querySelector(':scope > details');if(management){management.classList.add('mc-reading-settings');byId('mcSettings').append(management);}}
  if(history){byId('mcSettings').append(history);history.open=false;}
  window.LkaMessages={conversationLabel:title,open,close,isOpen:()=>state.open,view:()=>state.open?state.tab:null,request:api.backend,openDetail,backDetail,openContext:showContext,openConversation,notify:notice,updateDetail:(content,patch)=>{const frame=detailStack.find(v=>v.content===content);if(frame){Object.assign(frame,patch);if(frame===detailStack.at(-1)){byId('mcDetailTitle').textContent=frame.title;byId('mcDetailTitle').title=frame.title;}}},hasDetail:()=>!!detailStack.length};
  window.addEventListener('pagehide',()=>{clearInterval(state.timer);});
  if(new URLSearchParams(window.location.search).get('panel')==='messages')open();
}());
