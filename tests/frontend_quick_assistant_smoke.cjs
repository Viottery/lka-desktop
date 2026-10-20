'use strict';
// Main-WebView quick manager fixture. Synthetic localhost only; no model or personal data.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const ROOT=process.env.FRONTEND_ROOT||path.resolve(__dirname,'../app/web/pet');
const requests=[],errors=[],holds=new Map(),live=new Map(),history=new Map(),statuses=new Map();
const stamp=new Date().toISOString(), sessionsKey='agentic-rag-pet-chat-sessions-v4';
function json(res,status,data){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));}
function session(phase,kind='manager'){return {session_id:(kind==='manager'?'manager-':'ordinary-')+phase,kind,title:kind==='manager'?'真理':'普通任务',created_at:stamp,updated_at:stamp,workspace:kind==='manager'?null:{path:'/synthetic/'+phase},metadata:{source_frontend:'windows-pet'}};}
function manager(phase){const s=session(phase);return {session:s,controller:{default_execution_workspace:{path:'/synthetic/tasks',platform:'linux',backend_path:'/synthetic/tasks'},session_id:s.session_id,status:'paused',revision:1}};}
function event(res,name,data){res.write('event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n');}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');let phase='frontend',route=url.pathname;
 if(route==='/__quick-font'&&fs.existsSync('/mnt/c/Windows/Fonts/msyh.ttc')){res.writeHead(200,{'content-type':'font/collection'});return fs.createReadStream('/mnt/c/Windows/Fonts/msyh.ttc').pipe(res);}
 const mock=route.match(/^\/mock\/([^/]+)(\/.*)$/);if(mock){phase=mock[1];route=mock[2];}
 if(!mock){const file=path.resolve(ROOT,'.'+url.pathname);if(file.startsWith(ROOT+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html','cache-control':'no-store'});return fs.createReadStream(file).pipe(res);}}
 let raw='';for await(const c of req)raw+=c;let body={};try{body=JSON.parse(raw||'{}');}catch{}
 requests.push({phase,route,method:req.method,body});
 if(route==='/managers/default'){
  if(phase.startsWith('held')){holds.set(phase,()=>json(res,200,manager(phase)));return;}
  if(phase==='failure')return json(res,503,{detail:'synthetic_manager_unavailable'});
  if(phase==='disabled')return json(res,409,{detail:'management_disabled'});
  if(phase==='invalid')return json(res,200,{...manager(phase),session:session(phase,'ordinary')});
  return json(res,200,manager(phase));
 }
 if(route==='/agent/ui-defaults')return json(res,200,{configured:true,defaults:{llm_client:'ordinary-client',llm_model:'ordinary-model',stream:true}});
 if(route==='/agent/models')return json(res,200,{clients:[]});
 if(route==='/sessions/deleted')return json(res,200,{sessions:[]});
 if(route==='/sessions'&&req.method==='GET')return json(res,200,{sessions:[session(phase,'ordinary'),session(phase)]});
 if(route==='/knowledge/file-types')return json(res,200,{file_types:[{extensions:['.txt'],index_supported:true}]});
 if(route==='/pet/session-workspace')return json(res,200,{path:'/synthetic/'+body.session_id});
 if(route.endsWith('/workspace'))return json(res,200,{project_id:'synthetic-project'});
 if(route.endsWith('/runs')){
  const status=statuses.get(phase)||(phase==='restored'?'paused':'');
  return json(res,200,{session_id:session(phase).session_id,runs:status&&status!=='completed'?[{run_id:'run-'+phase,session_id:session(phase).session_id,status,parent_run_id:null,created_at:stamp}]:[],next_offset:null});
 }
 if(/^\/managers\//.test(route)){
  if(route.endsWith('/events'))return json(res,200,{events:[],next_after:null});
  if(route.endsWith('/deliveries'))return json(res,200,{deliveries:[],next_after:null});
  return json(res,200,manager(phase));
 }
 if(/^\/sessions\/[^/]+\/attachments$/.test(route)&&req.method==='POST')return json(res,201,{attachment_id:'att_0123456789abcdef0123456789abcdef',kind:'document',filename:'synthetic.txt',size_bytes:5,media_type:'text/plain'});
 if(/^\/sessions\/[^/]+$/.test(route))return json(res,200,{session:route.includes('/ordinary-')?session(phase,'ordinary'):session(phase),messages:history.get(phase)||[]});
 if(route==='/agent/turn/stream'&&phase.startsWith('ordinary-browser-')){
  const sid=session(phase,'ordinary').session_id;
  assert.equal(body.session_id,sid);statuses.set(phase,'paused');
  if(phase==='ordinary-browser-foreign')return json(res,409,{detail:'session_busy',session_id:'ordinary-other-session',run_id:'foreign-run'});
  if(phase==='ordinary-browser-malformed')return json(res,409,{detail:'session_busy',session_id:sid,run_id:'../invalid-run'});
  return json(res,409,{detail:'session_busy',session_id:sid,run_id:'existing-'+phase});
 }
 if(route==='/agent/turn/stream'){
  assert.equal(body.session_id,session(phase).session_id);statuses.set(phase,'running');
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
  event(res,'run_started',{run_id:'run-'+phase,sequence:1,status:'running'});
  event(res,'llm_delta',{run_id:'run-'+phase,sequence:2,payload:{display_target:'assistant_answer',delta:'快速助手持续生成正文'}});
  const entry={res,closed:false};res.on('close',()=>entry.closed=true);live.set(phase,entry);return;
 }
 const run=route.match(/^\/agent\/runs\/([^/]+)(?:\/(stream|snapshot|events))?$/);
 if(run){
  const status=statuses.get(phase)||(phase==='restored'?'paused':'completed');
  if(run[2]==='stream'){
   res.writeHead(200,{'content-type':'text/event-stream'});
   if(status==='paused'){event(res,'run_paused',{run_id:run[1],status:'paused',sequence:3});return res.end();}
   if(status==='completed'){event(res,'run_completed',{run_id:run[1],status:'completed',sequence:3});return res.end();}
   event(res,'llm_delta',{run_id:run[1],sequence:2,payload:{display_target:'assistant_answer',delta:'恢复的快速助手正文'}});const entry={res,closed:false};res.on('close',()=>entry.closed=true);live.set(phase,entry);return;
  }
  if(run[2]==='snapshot')return json(res,200,{parent_run:{run_id:run[1],status},children:[],steps:[]});
  if(run[2]==='events')return json(res,200,{events:[]});
  return json(res,200,{run_id:run[1],status});
 }
 if(route==='/agent/safety-reviews')return json(res,200,{reviews:[]});
 if(route.endsWith('/files'))return json(res,200,{entries:[]});
 return json(res,404,{detail:'unmocked_synthetic_route'});
});
const tick=page=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
async function until(check){for(let i=0;i<300;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('synthetic fixture condition timed out');}
(async()=>{let browser;try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/tmp/lka-playwright-browsers/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']});
 async function open(phase,query='',sharedContext){
  const ctx=sharedContext||await browser.newContext({viewport:{width:460,height:780}}),page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.addInitScript(({key,phase})=>{localStorage.setItem(key,JSON.stringify([{id:'ordinary-'+phase,conversation_id:'ordinary-'+phase,kind:'ordinary',title:'缓存普通任务',created_at:Date.now(),updated_at:Date.now(),workspace:'',messages:[{role:'assistant',text:'把任务交给我。可以先从提问、查找资料或整理文件开始。'}]}]));localStorage.setItem('agentic-rag-pet-chat-active-session-v4','ordinary-'+phase);localStorage.setItem('agentic-rag-pet-run-settings-v1',JSON.stringify({llmClient:'saved-client',llmModel:'saved-model',stream:true}));},{key:sessionsKey,phase});
  await page.goto(origin+'/chat.html?mode=quick&assistant=quick&backend='+encodeURIComponent(origin+'/mock/'+phase)+query);
  await page.waitForFunction(()=>!!window.LkaChatContext);return {ctx,page};
 }
 const {ctx,page}=await open('success');
 await page.waitForFunction(()=>LkaChatContext.get().kind==='manager');
 const baseline=requests.length;assert.equal(await page.locator('iframe').count(),0,'manager uses main WebView, no iframe');
 assert(!requests.slice(0,baseline).some(r=>r.route==='/pet/session-workspace'||r.route.endsWith('/workspace')||r.route.endsWith('/files')),'boot does not create/read an unused ordinary workspace');
 assert.equal(await page.locator('#questionInput').getAttribute('placeholder'),'交给真理，或聊聊接下来的安排…');
 assert.equal(await page.evaluate(()=>LkaChatContext.assistantState().manager.session.kind),'manager','state getter replays successful bootstrap');
 await page.setViewportSize({width:390,height:720});
 if(fs.existsSync('/mnt/c/Windows/Fonts/msyh.ttc')){await page.addStyleTag({content:'@font-face{font-family:QuickSmokeChinese;src:url("'+origin+'/__quick-font")}body,body *{font-family:QuickSmokeChinese,sans-serif!important}'});await page.evaluate(()=>document.fonts.ready);}
 await page.waitForFunction(()=>document.getElementById('qaMode')?.textContent==='对话与跟进');
 fs.mkdirSync('/tmp/lka-quick-assistant-shots',{recursive:true});await page.screenshot({path:'/tmp/lka-quick-assistant-shots/quick-manager-390.png'});
 await page.locator('#questionInput').fill('管理草稿保留');
 const defaultsBefore=requests.filter(r=>r.route==='/managers/default').length;
 const reopened=await page.evaluate(()=>LkaChatContext.openAssistant());assert.equal(reopened.session.session_id,'manager-success');
 assert.equal(await page.locator('#questionInput').inputValue(),'管理草稿保留');assert.equal(requests.filter(r=>r.route==='/managers/default').length,defaultsBefore,'same manager reopen makes no bootstrap request');
 // Native composer remains in this WebView; attachments prepare against the manager ID.
 await page.evaluate(()=>{window.nativeHeights=[];window.petBridge={setQuickPanelHeight:n=>nativeHeights.push(n),setComposerBusy(){},setComposerAction(){},setComposerDraft:n=>window.nativeDraft=n,focusComposer(){},requestMemory:raw=>{var r=JSON.parse(raw);fetch(LkaChatContext.get().backend+r.path,{method:r.method,headers:{'Content-Type':'application/json'},body:r.body||undefined}).then(async response=>__lkaMemoryBridgeReceive(r.id,response.status,await response.text()));}};__petChatBridgeReady();});
 await page.locator('#cachedFileInput').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('hello')});
 await page.evaluate(()=>__petChatNativeDraftChanged('开始管理任务'));
 await page.evaluate(()=>__petChatSubmitText('开始管理任务'));
 await page.waitForFunction(()=>document.getElementById('messages').textContent.includes('快速助手持续生成正文'));
 const stream=live.get('success'),beforeOpen=requests.filter(r=>r.route==='/managers/default').length;
 await page.evaluate(()=>{__petChatNativeDraftChanged('生成期间草稿');return __petChatOpenAssistant();});
 assert.equal(stream.closed,false,'same-manager reopen preserves live SSE');assert.equal(requests.filter(r=>r.route==='/managers/default').length,beforeOpen);
 const turn=requests.find(r=>r.phase==='success'&&r.route==='/agent/turn/stream');assert.equal(turn.body.llm.model,undefined);assert.equal(turn.body.llm.client_name,undefined);assert.deepEqual(turn.body.attachment_ids,['att_0123456789abcdef0123456789abcdef']);
 assert.equal(await page.evaluate(()=>LkaChatContext.refreshConversation()),false,'live output blocks background history overwrite');
 // Explicit new task switches to ordinary; returning to the assistant preserves both drafts and restores root.
 await page.evaluate(()=>__petChatOpenFreshTask());await page.waitForFunction(()=>LkaChatContext.get().kind==='ordinary');
 const ordinaryId=await page.evaluate(()=>LkaChatContext.get().sessionId);assert.notEqual(ordinaryId,'manager-success');
 await page.evaluate(()=>__petChatNativeDraftChanged('普通任务草稿保留'));
 await page.evaluate(()=>__petChatOpenAssistant());await page.waitForFunction(()=>LkaChatContext.get().kind==='manager');
 assert.equal(await page.evaluate(()=>window.nativeDraft),'生成期间草稿');
 assert.equal(await page.evaluate(key=>localStorage.getItem(key),sessionsKey+'-draft-'+ordinaryId),'普通任务草稿保留');
 await page.evaluate(id=>LkaChatContext.openSession(id),ordinaryId);await page.waitForFunction(()=>LkaChatContext.get().kind==='ordinary');
 assert.equal(await page.evaluate(()=>window.nativeDraft),'普通任务草稿保留');
 assert.equal(await page.evaluate(()=>LkaChatContext.assistantState().manager),null,'ordinary selection clears connecting identity');
 await ctx.close();
 // Existing paused roots are restored without a fresh turn.
 const restored=await open('restored');await restored.page.waitForFunction(()=>document.getElementById('sendButton').dataset.runState==='paused');
 assert(!requests.some(r=>r.phase==='restored'&&r.route==='/agent/turn/stream'));await restored.ctx.close();
 // Initial failures never become ordinary automatically; explicit New task unlocks normal chat.
 for(const phase of ['failure','disabled','invalid']){
  const failed=await open(phase);await failed.page.waitForFunction(()=>!!LkaChatContext.assistantState().error);
  assert(await failed.page.locator('#sendButton').isDisabled());assert.equal(await failed.page.evaluate(()=>LkaChatContext.get().sessionId),'');
  assert((await failed.page.locator('#runStatus').textContent()).includes('真理连接失败'));
  if(phase==='failure')assert.equal(await failed.page.evaluate(()=>__petChatOpenAssistant()),null,'native bootstrap failures are reported through state without an unhandled rejection');
  assert(!requests.some(r=>r.phase===phase&&r.route==='/sessions'&&r.method==='POST'));
  await failed.page.locator('#questionInput').fill('失败连接期间先写的任务');
  await failed.page.evaluate(()=>__petChatOpenFreshTask());await failed.page.waitForFunction(()=>LkaChatContext.get().kind==='ordinary');
  assert.equal(await failed.page.locator('#questionInput').inputValue(),'失败连接期间先写的任务','failed unassigned input transfers to explicit new task');
  assert.equal(await failed.page.evaluate(()=>LkaChatContext.assistantState().error),undefined);assert.equal(await failed.page.locator('#sendButton').isDisabled(),false);
  await failed.ctx.close();
 }
 // A late default-manager response cannot steal a user's new task or explicit history selection.
 for(const phase of ['held-new','held-select']){
  const held=await open(phase);await until(()=>holds.has(phase));
  if(phase==='held-new'){await held.page.locator('#questionInput').fill('连接期间尚未归属的输入');await held.page.evaluate(()=>__petChatOpenFreshTask());assert.equal(await held.page.locator('#questionInput').inputValue(),'连接期间尚未归属的输入');}
  else await held.page.evaluate(id=>LkaChatContext.openSession(id),'ordinary-'+phase);
  await held.page.waitForFunction(()=>LkaChatContext.get().kind==='ordinary');const chosen=await held.page.evaluate(()=>LkaChatContext.get().sessionId);
  await held.page.locator('#questionInput').fill('迟到响应不能覆盖');holds.get(phase)();
  await held.page.waitForResponse(r=>r.url().endsWith('/managers/default'));await tick(held.page);
  assert.equal(await held.page.evaluate(()=>LkaChatContext.get().sessionId),chosen);assert.equal(await held.page.locator('#questionInput').inputValue(),'迟到响应不能覆盖');
  await held.page.waitForFunction(()=>LkaChatContext.assistantState().manager&&LkaChatContext.assistantState().manager.session.kind==='manager');
  assert.equal(await held.page.evaluate(()=>LkaChatContext.assistantState().loading),false);
  assert.equal(await held.page.evaluate(()=>LkaChatContext.get().sessionId),chosen,'background preparation never changes ordinary selection');
  const identityCount=()=>requests.filter(r=>r.phase===phase&&(r.route==='/managers/default'||r.route==='/sessions/manager-'+phase)).length;
  assert.equal(identityCount(),2,'one default request and one background detail bootstrap');
  await held.page.evaluate(()=>__petChatOpenAssistant());await held.page.waitForFunction(()=>LkaChatContext.get().kind==='manager');
  assert.equal(identityCount(),2,'explicit warm return reuses prepared identity and conversation');
  await held.page.evaluate(id=>LkaChatContext.openSession(id),chosen);
  assert.equal(await held.page.locator('#questionInput').inputValue(),'迟到响应不能覆盖');await held.ctx.close();
 }
 // Input entered before any session exists is merged once, including native IME drafts.
 const draftBoot=await open('held-draft');await until(()=>holds.has('held-draft'));
 await draftBoot.page.locator('#questionInput').fill('连接时输入的助手草稿');
 await draftBoot.page.evaluate(key=>dispatchEvent(new StorageEvent('storage',{key,newValue:localStorage.getItem(key)})),sessionsKey);
 assert.equal(await draftBoot.page.evaluate(()=>LkaChatContext.get().sessionId),'','storage sync cannot select hidden ordinary session during bootstrap');
 holds.get('held-draft')();
 await draftBoot.page.waitForFunction(()=>LkaChatContext.get().kind==='manager');assert.equal(await draftBoot.page.locator('#questionInput').inputValue(),'连接时输入的助手草稿');await draftBoot.ctx.close();
 const nativeBoot=await open('held-native-draft');await until(()=>holds.has('held-native-draft'));
 await nativeBoot.page.evaluate(key=>{localStorage.setItem(key,'已有管理草稿');window.petBridge={setComposerBusy(){},setComposerAction(){},focusComposer(){},setComposerDraft:text=>window.nativeDraft=text,setQuickPanelHeight(){}};__petChatBridgeReady();__petChatNativeDraftChanged('连接期间原生输入');},sessionsKey+'-draft-manager-held-native-draft');
 holds.get('held-native-draft')();await nativeBoot.page.waitForFunction(()=>LkaChatContext.get().kind==='manager');
 assert.equal(await nativeBoot.page.evaluate(()=>window.nativeDraft),'已有管理草稿\n连接期间原生输入');await nativeBoot.page.evaluate(()=>__petChatOpenAssistant());assert.equal(await nativeBoot.page.evaluate(()=>window.nativeDraft),'已有管理草稿\n连接期间原生输入');await nativeBoot.ctx.close();
 // Java's native transport wraps 409 as an error string: restore input/attachments and reconnect only.
 const nativeConflict=await open('native-conflict');await nativeConflict.page.waitForFunction(()=>LkaChatContext.get().kind==='manager');statuses.set('native-conflict','paused');
 await nativeConflict.page.evaluate(()=>{window.nativeSends=[];window.petBridge={setComposerBusy(){},setComposerAction(){},focusComposer(){},setQuickPanelHeight(){},setComposerDraft:text=>window.nativeDraft=text,requestMemory:raw=>{const r=JSON.parse(raw);fetch(LkaChatContext.get().backend+r.path,{method:r.method,headers:{'Content-Type':'application/json'},body:r.body||undefined}).then(async response=>__lkaMemoryBridgeReceive(r.id,response.status,await response.text()));},stream:raw=>{const body=JSON.parse(raw);nativeSends.push(body);queueMicrotask(()=>__petChatReceive({error:'HTTP 409: '+JSON.stringify({detail:'manager_run_already_active',session_id:body.conversation_id,run_id:'native-existing'})}));}};__petChatBridgeReady();});
 await nativeConflict.page.locator('#cachedFileInput').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('hello')});
 await nativeConflict.page.evaluate(()=>{__petChatNativeDraftChanged('原生冲突草稿必须保留');__petChatSubmitText('原生冲突草稿必须保留');});
 await nativeConflict.page.waitForFunction(()=>document.getElementById('sendButton').dataset.runState==='paused');
 assert.equal(await nativeConflict.page.evaluate(()=>window.nativeDraft),'原生冲突草稿必须保留');assert.equal(await nativeConflict.page.evaluate(()=>nativeSends.length),1);
 assert.equal(await nativeConflict.page.evaluate(()=>LkaImageComposer.hasAttachments(LkaChatContext.get().sessionId)),true);assert.equal(await nativeConflict.page.locator('.message.error').count(),0);
 assert(!requests.some(r=>r.phase==='native-conflict'&&r.method==='POST'&&(/\/(replace|resume|interrupt)$/.test(r.route)||r.route==='/agent/turn/stream')));
 await nativeConflict.page.evaluate(()=>{__petChatOpenFreshTask();window.normalNativeSends=[];petBridge.stream=raw=>normalNativeSends.push(JSON.parse(raw));__petChatNativeDraftChanged('独立任务正在处理');__petChatSubmitText('独立任务正在处理');});
 await nativeConflict.page.waitForFunction(()=>normalNativeSends.length===1&&LkaChatContext.get().busy);
 const newTaskId=await nativeConflict.page.evaluate(()=>LkaChatContext.get().sessionId);
 await nativeConflict.page.evaluate(()=>{__petChatNativeDraftChanged('新任务下一条草稿');__petChatReceive({error:'HTTP 409: '+JSON.stringify({session_id:'manager-native-conflict',run_id:'native-existing',detail:'manager_run_already_active'})});});
 assert.equal(await nativeConflict.page.evaluate(()=>LkaChatContext.get().sessionId),newTaskId);assert.equal(await nativeConflict.page.evaluate(()=>LkaChatContext.get().busy),true,'late manager 409 cannot clear the new ordinary pending turn');
 assert.equal(await nativeConflict.page.evaluate(key=>localStorage.getItem(key),sessionsKey+'-draft-'+newTaskId),'新任务下一条草稿');assert.equal(await nativeConflict.page.locator('.message.error').count(),0);
 await nativeConflict.page.evaluate(id=>__petChatReceive({session_id:id,answer:'独立任务正常返回'}),newTaskId);await nativeConflict.page.locator('#messages').filter({hasText:'独立任务正常返回'}).waitFor();await nativeConflict.ctx.close();
 // Ordinary sessions obey the same busy contract on browser and native transports.
 const ordinaryBrowser=await open('ordinary-browser-valid','&session_id=ordinary-ordinary-browser-valid');
 await ordinaryBrowser.page.waitForFunction(()=>LkaChatContext.get().sessionId==='ordinary-ordinary-browser-valid');
 await ordinaryBrowser.page.locator('#cachedFileInput').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('hello')});
 await ordinaryBrowser.page.locator('#questionInput').fill('普通会话浏览器冲突草稿');await ordinaryBrowser.page.locator('#sendButton').click();
 await ordinaryBrowser.page.waitForFunction(()=>document.getElementById('sendButton').dataset.runState==='paused');
 assert.equal(await ordinaryBrowser.page.locator('#questionInput').inputValue(),'普通会话浏览器冲突草稿');
 assert.equal(await ordinaryBrowser.page.evaluate(()=>LkaImageComposer.hasAttachments(LkaChatContext.get().sessionId)),true);
 assert.equal(await ordinaryBrowser.page.locator('.message.error').count(),0);
 assert(requests.some(r=>r.phase==='ordinary-browser-valid'&&r.route.startsWith('/agent/runs/existing-ordinary-browser-valid')));
 assert(!requests.some(r=>r.phase==='ordinary-browser-valid'&&r.method==='POST'&&/\/(replace|resume|interrupt)$/.test(r.route)));
 await ordinaryBrowser.ctx.close();
 for(const phase of ['ordinary-browser-foreign','ordinary-browser-malformed']){
  const invalid=await open(phase,'&session_id=ordinary-'+phase);await invalid.page.waitForFunction(id=>LkaChatContext.get().sessionId===id,'ordinary-'+phase);
  await invalid.page.locator('#questionInput').fill('不能连接其他会话');await invalid.page.locator('#sendButton').click();
  await invalid.page.locator('.message.error').waitFor();
  assert.equal(await invalid.page.evaluate(()=>LkaChatContext.get().sessionId),'ordinary-'+phase);
  assert(!requests.some(r=>r.phase===phase&&r.route.startsWith('/agent/runs/')),'foreign or malformed conflict cannot recover another root');
  await invalid.ctx.close();
 }
 const ordinaryNative=await open('ordinary-native-conflict','&session_id=ordinary-ordinary-native-conflict');
 await ordinaryNative.page.waitForFunction(()=>LkaChatContext.get().sessionId==='ordinary-ordinary-native-conflict');statuses.set('ordinary-native-conflict','paused');
 await ordinaryNative.page.evaluate(()=>{window.ordinarySends=[];window.petBridge={setComposerBusy(){},setComposerAction(){},focusComposer(){},setQuickPanelHeight(){},setComposerDraft:text=>window.nativeDraft=text,stream:raw=>ordinarySends.push(JSON.parse(raw))};__petChatBridgeReady();});
 await ordinaryNative.page.locator('#cachedFileInput').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('hello')});
 await ordinaryNative.page.evaluate(()=>{__petChatNativeDraftChanged('原生普通任务冲突草稿');__petChatSubmitText('原生普通任务冲突草稿');});
 await ordinaryNative.page.waitForFunction(()=>ordinarySends.length===1&&LkaChatContext.get().busy);
 const originalOrdinary=await ordinaryNative.page.evaluate(()=>LkaChatContext.get().sessionId);
 await ordinaryNative.page.evaluate(id=>__petChatReceive({error:'HTTP 409: '+JSON.stringify({session_id:id,run_id:'ordinary-existing-root',detail:'session_busy'})}),originalOrdinary);
 await ordinaryNative.page.waitForFunction(()=>document.getElementById('sendButton').dataset.runState==='paused');
 assert.equal(await ordinaryNative.page.evaluate(()=>window.nativeDraft),'原生普通任务冲突草稿');
 assert.equal(await ordinaryNative.page.evaluate(()=>LkaImageComposer.hasAttachments(LkaChatContext.get().sessionId)),true);
 assert.equal(await ordinaryNative.page.locator('.message.error').count(),0);
 await ordinaryNative.page.evaluate(()=>{__petChatOpenFreshTask();__petChatNativeDraftChanged('另一普通任务请求');__petChatSubmitText('另一普通任务请求');});
 await ordinaryNative.page.waitForFunction(()=>ordinarySends.length===2&&LkaChatContext.get().busy);
 const currentOrdinary=await ordinaryNative.page.evaluate(()=>LkaChatContext.get().sessionId);
 await ordinaryNative.page.evaluate(({oldId,newId})=>{
  __petChatNativeDraftChanged('当前普通任务下一条草稿');
  __petChatReceive({error:'HTTP 409: '+JSON.stringify({session_id:oldId,run_id:'late-ordinary-root',detail:'session_busy'})});
  __petChatReceive({error:'HTTP 409: '+JSON.stringify({session_id:'unknown-session',run_id:'foreign-root',detail:'session_busy'})});
  __petChatReceive({session_id:oldId,error:'HTTP 409: '+JSON.stringify({session_id:newId,run_id:'wrong-wrapper-root',detail:'session_busy'})});
 },{oldId:originalOrdinary,newId:currentOrdinary});
 assert.equal(await ordinaryNative.page.evaluate(()=>LkaChatContext.get().sessionId),currentOrdinary);
 assert.equal(await ordinaryNative.page.evaluate(()=>LkaChatContext.get().busy),true,'late/unknown/malformed native409 must preserve current ordinary pending');
 assert.equal(await ordinaryNative.page.evaluate(key=>localStorage.getItem(key),sessionsKey+'-draft-'+currentOrdinary),'当前普通任务下一条草稿');
 assert.equal(await ordinaryNative.page.locator('.message.error').count(),0);
 assert(!requests.some(r=>r.phase==='ordinary-native-conflict'&&r.method==='POST'&&(/\/(replace|resume|interrupt)$/.test(r.route)||r.route==='/agent/turn/stream')));
 // An attributable malformed busy response ends the rejected attempt, restores
 // both the sent text and later draft, and never attaches its invalid run id.
 await ordinaryNative.page.evaluate(id=>__petChatReceive({error:'HTTP 409: '+JSON.stringify({session_id:id,run_id:'../malformed',detail:'session_busy'})}),currentOrdinary);
 await ordinaryNative.page.waitForFunction(()=>!LkaChatContext.get().busy);
 assert.equal(await ordinaryNative.page.evaluate(()=>window.nativeDraft),'另一普通任务请求\n当前普通任务下一条草稿');
 assert((await ordinaryNative.page.locator('#runStatus').textContent()).includes('响应不完整'));
 assert(!requests.some(r=>r.phase==='ordinary-native-conflict'&&r.route.includes('malformed')));
 await ordinaryNative.ctx.close();
 const prepareFailure=await open('ordinary-prepare-rejection','&session_id=ordinary-ordinary-prepare-rejection');
 await prepareFailure.page.waitForFunction(()=>LkaChatContext.get().sessionId==='ordinary-ordinary-prepare-rejection');
 await prepareFailure.page.locator('#cachedFileInput').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('hello')});
 await prepareFailure.page.evaluate(()=>{LkaImageComposer.prepare=()=>new Promise((resolve,reject)=>{window.rejectPrepare=()=>reject(new Error('Synthetic input validation failure'));});});
 await prepareFailure.page.locator('#questionInput').fill('校验前已输入的文字');await prepareFailure.page.locator('#sendButton').click();
 await prepareFailure.page.waitForFunction(()=>!!window.rejectPrepare);await prepareFailure.page.locator('#questionInput').fill('校验期间写的下一条');
 await prepareFailure.page.evaluate(()=>rejectPrepare());await prepareFailure.page.locator('.message.error').waitFor();
 assert.equal(await prepareFailure.page.locator('#questionInput').inputValue(),'校验前已输入的文字\n校验期间写的下一条');
 assert.equal(await prepareFailure.page.evaluate(()=>LkaImageComposer.hasAttachments(LkaChatContext.get().sessionId)),true);
 assert.equal(await prepareFailure.page.locator('.message.user').filter({hasText:'校验前已输入的文字'}).count(),0);
 assert(!requests.some(r=>r.phase==='ordinary-prepare-rejection'&&r.method==='POST'&&(/\/(replace|resume|interrupt)$/.test(r.route)||r.route==='/agent/turn/stream'||r.route==='/agent/turn')));
 await prepareFailure.ctx.close();
 // Only selection is isolated: shared manager/session persistence cannot steal an ordinary workbench's draft.
 const shared=await browser.newContext(),workbench=await shared.newPage();
 await workbench.goto(origin+'/chat.html?mode=work&session_id=ordinary-selection&backend='+encodeURIComponent(origin+'/mock/selection'));
 await workbench.waitForFunction(()=>LkaChatContext.get().sessionId==='ordinary-selection');await workbench.locator('#questionInput').fill('工作台保持当前草稿');
 const selectedQuick=await open('selection','',shared);await selectedQuick.page.waitForFunction(()=>LkaChatContext.get().kind==='manager');await tick(workbench);
 assert.equal(await workbench.evaluate(()=>LkaChatContext.get().sessionId),'ordinary-selection');assert.equal(await workbench.locator('#questionInput').inputValue(),'工作台保持当前草稿');
 await selectedQuick.page.evaluate(()=>__petChatOpenFreshTask());await selectedQuick.page.waitForFunction(()=>LkaChatContext.get().kind==='ordinary');await selectedQuick.page.evaluate(()=>__petChatOpenAssistant());await tick(workbench);
 assert.equal(await workbench.evaluate(()=>LkaChatContext.get().sessionId),'ordinary-selection');assert.equal(await workbench.locator('#questionInput').inputValue(),'工作台保持当前草稿');
 assert.equal(await workbench.evaluate(()=>localStorage.getItem('agentic-rag-pet-chat-active-session-v4')),'ordinary-selection');assert.equal(await selectedQuick.page.evaluate(()=>localStorage.getItem('agentic-rag-pet-chat-active-session-v4-quick')),'manager-selection');await shared.close();
 const explicit=await open('explicit','&session_id=ordinary-explicit');await explicit.page.waitForFunction(()=>LkaChatContext.get().sessionId==='ordinary-explicit');await explicit.page.waitForFunction(()=>LkaChatContext.assistantState().manager);assert.equal(requests.filter(r=>r.phase==='explicit'&&r.route==='/managers/default').length,1,'explicit ordinary entry warms the manager once without changing selection');assert.equal(await explicit.page.evaluate(()=>LkaChatContext.get().sessionId),'ordinary-explicit');await explicit.ctx.close();
 assert.deepEqual(errors,[]);console.log('PASS quick assistant: main native WebView, manager boot/validation, no unused workspace, model isolation, attachments, idempotent SSE/drafts, ordinary/new-task return, root recovery, explicit failure recovery, cancelled bootstrap races, unassigned browser/native drafts, native 409 recovery, isolated ordinary workbench selection, explicit-session precedence');
 }finally{if(browser)await browser.close();for(const held of holds.values()){try{held();}catch{}}for(const entry of live.values()){try{entry.res.end();}catch{}}server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
