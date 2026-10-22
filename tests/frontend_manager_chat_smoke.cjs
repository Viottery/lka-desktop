'use strict';
// Synthetic local fixture only: no personal service, model calls or account data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = process.env.FRONTEND_ROOT || path.resolve(__dirname,'../app/web/pet');
const requests=[], errors=[];
let managerWorkspace=null, managerRevision=1, parentFails=false;
const extraManagerWorkspaces=new Map();
const dispatchedTask='在自己的工作区内创建 `hello.py`，内容为 `print("hello world")`。\n完成后报告路径与文件内容。';
let ordinaryMessages=[{message_id:'dispatch-first',role:'tool',content:'内部来源 secret-source 与调试 secret-debug',payload:{input_origin:'manager',input_envelope:{origin:'manager',purpose:dispatchedTask,input_id:'secret-id',debug_info:{private:'secret-debug'}}}},{role:'tool',content:'ordinary internal dispatch',payload:{input_origin:'manager'}},{role:'assistant',content:'ordinary initial answer'}];
let holdOrdinaryRefresh=false,releaseOrdinaryRefresh,onOrdinaryHeld;
let managerMessages=[], holdSessionRefresh=false, heldSessionResponse, onHeldSession, finishBusy, finishSilent;
function silentEvents(res,runId,hold=false){
 res.writeHead(200,{'content-type':'text/event-stream'});
 function emit(type,sequence,message,payload={}){res.write('id: '+runId+':'+sequence+'\nevent: '+type+'\ndata: '+JSON.stringify({run_id:runId,sequence,message,payload})+'\n\n');}
 emit('run_started',1,'Started');
 emit('assistant_message',2,'SILENT_PROCESS_SECRET',{metadata:{user_visible:false}});
 emit('llm_delta',3,'SILENT_DELTA_SECRET',{display_target:'assistant_answer',delta:'SILENT_DELTA_SECRET',user_visible:false});
 const finish=()=>{emit('final_answer',4,'SILENT_FINAL_SECRET',{metadata:{answer:'SILENT_FINAL_SECRET',user_visible:false}});emit('run_completed',5,'Completed',{user_visible:false});res.end();};
 if(hold)finishSilent=finish;else finish();
}
const stamp=new Date().toISOString();
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
function detail(id,kind='manager'){return {session:{session_id:id,kind,title:kind==='manager'?'真理':'普通会话',created_at:stamp,updated_at:stamp,metadata:{source_frontend:'windows-pet'},workspace:kind==='manager'?null:{path:'/synthetic/work'},management:{status:'paused'}},messages:[]};}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture'), route=url.pathname;
 if(route==='/fixture'){res.writeHead(200,{'content-type':'text/html'});return res.end('<body><script>window.messages=[];addEventListener("message",e=>messages.push(e.data));</script><iframe id="assistant"></iframe></body>');}
 const file=path.resolve(ROOT,'.'+route);
 if(file.startsWith(ROOT+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
  res.writeHead(200,{'content-type':route.endsWith('.js')?'text/javascript':route.endsWith('.css')?'text/css':'text/html'});return fs.createReadStream(file).pipe(res);
 }
 let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw||'{}');}catch{body={};}
 requests.push({route,method:req.method,body});
 if(route==='/agent/ui-defaults'){await new Promise(r=>setTimeout(r,180));return json(res,200,{configured:true,defaults:{llm_client:'ordinary-provider',llm_model:'ordinary-model',stream:true}});}
 if(route==='/agent/models')return json(res,200,{clients:[]});
 if(route==='/knowledge/file-types')return json(res,200,{file_types:[{extensions:['.txt'],index_supported:true}]});
 if(route==='/sessions/deleted')return json(res,200,{sessions:[]});
 if(route==='/sessions'&&req.method==='GET')return json(res,200,{sessions:[detail('manager-empty').session,detail('ordinary','ordinary').session]});
 if(route==='/sessions/manager-fail')return json(res,503,{detail:'synthetic_unavailable'});
 if(route==='/sessions/not-manager')return json(res,200,detail('not-manager','ordinary'));
 if(route==='/sessions/manager-runs-fail/runs')return json(res,503,{detail:'synthetic_runs_unavailable'});
 if(route.endsWith('/runs'))return json(res,200,{session_id:route.split('/')[2],runs:route.includes('manager-restore')?[{run_id:'restored-root',session_id:'manager-restore',parent_run_id:null,status:'paused',created_at:stamp}]:[],next_offset:null});
 if(/^\/agent\/runs\//.test(route)){const id=route.split('/')[3];if(route.endsWith('/stream')){res.writeHead(200,{'content-type':'text/event-stream'});return res.end('event: run_paused\ndata: '+JSON.stringify({run_id:id,status:'paused'})+'\n\n');}return json(res,200,{run_id:id,status:'paused'});}
 if(/^\/sessions\/manager/.test(route)&&!route.endsWith('/attachments')){
  const data=detail(route.split('/')[2]);if(route==='/sessions/manager-default')data.messages=managerMessages.slice();
  if(route==='/sessions/manager-default'&&holdSessionRefresh){holdSessionRefresh=false;heldSessionResponse=()=>json(res,200,data);onHeldSession();return;}
  await new Promise(r=>setTimeout(r,250));return json(res,200,data);
 }
 if(route==='/sessions/ordinary'){
  const data={...detail('ordinary','ordinary'),messages:ordinaryMessages.slice()};
  if(holdOrdinaryRefresh){holdOrdinaryRefresh=false;releaseOrdinaryRefresh=()=>json(res,200,data);onOrdinaryHeld();return;}
  return json(res,200,data);
 }
 if(route.endsWith('/attachments')&&req.method==='POST')return json(res,201,{attachment_id:'att_0123456789abcdef0123456789abcdef',kind:'document',filename:'synthetic.txt',media_type:'text/plain',size_bytes:5});
 if(route==='/managers/default'||route==='/managers/manager-default'){
  if(req.method==='PATCH'){
   assert.equal(body.expected_revision,managerRevision);
   assert.deepEqual(body.default_execution_workspace,{path:'/synthetic/tasks',platform:'linux'});
   managerWorkspace={...body.default_execution_workspace,backend_path:'/synthetic/tasks'};managerRevision++;
  }
  return json(res,200,{session:detail('manager-default').session,controller:{session_id:'manager-default',revision:managerRevision,status:'paused',default_execution_workspace:managerWorkspace}});
 }
 if(/^\/managers\/[^/]+$/.test(route)){
  const id=route.split('/')[2];
  if(req.method==='PATCH'){assert.equal(body.expected_revision,extraManagerWorkspaces.has(id)?2:1);extraManagerWorkspaces.set(id,{...body.default_execution_workspace,backend_path:body.default_execution_workspace.path});}
  const workspace=extraManagerWorkspaces.get(id)||(id.startsWith('manager-unconfigured')||id==='manager-explicit-failure'?null:{path:'/synthetic/tasks',platform:'linux',backend_path:'/synthetic/tasks'});
  return json(res,200,{session:detail(id).session,controller:{session_id:id,revision:workspace?2:1,status:'paused',default_execution_workspace:workspace}});
 }
 if(route.endsWith('/goals'))return json(res,200,{goals:[],next_offset:null});
 if(route.endsWith('/events'))return json(res,200,{events:[],next_after:null});
 if(route.endsWith('/deliveries'))return json(res,200,{deliveries:[],next_after:null});
 if(route==='/pet/session-workspace-parent')return json(res,parentFails?503:200,parentFails?{detail:'synthetic_parent_failure'}:{path:'/synthetic/tasks',platform:'linux'});
 if(route==='/pet/session-workspace')return json(res,200,{path:'/synthetic/work'});
 if(route.endsWith('/workspace'))return json(res,200,{project_id:'synthetic-project'});
 if(route==='/openapi.json')return json(res,200,{paths:{'/sessions/{session_id}':{delete:{parameters:[{name:'only_if_empty'}]}}}});
 if(route==='/agent/turn/stream'){
  if(body.user_input==='静默管理处理测试')return silentEvents(res,'silent-active',true);
  if(body.session_id==='ordinary')ordinaryMessages=ordinaryMessages.concat([{role:'user',content:body.user_input},{role:'assistant',content:'合成管理回复'}]);
  if(body.session_id==='manager-conflict')return json(res,409,{detail:'manager_run_already_active',session_id:'manager-conflict',run_id:'existing-root'});
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: llm_started\ndata: {"stage":"synthetic"}\n\n');
  if(body.user_input==='持续生成测试'){
   res.write('event: llm_delta\ndata: '+JSON.stringify({payload:{display_target:'assistant_answer',delta:'持续生成中的正文'}})+'\n\n');
   finishBusy=()=>{managerMessages=managerMessages.concat([{role:'assistant',content:'持续生成中的正文已完成'}]);res.write('event: final_answer\ndata: '+JSON.stringify({payload:{metadata:{answer:'持续生成中的正文已完成'}}})+'\n\n');res.end('event: run_completed\ndata: {}\n\n');};return;
  }
  res.write('event: final_answer\ndata: {"payload":{"metadata":{"answer":"合成管理回复"}}}\n\n');return res.end('event: run_completed\ndata: {}\n\n');
 }
 if(route.endsWith('/files'))return json(res,200,{entries:[]});
 return json(res,404,{detail:'unmocked'});
});
(async()=>{
 let browser;
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/tmp/lka-playwright-browsers/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']});
  const context=await browser.newContext();context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  const page=await context.newPage();await page.goto(origin+'/fixture');
  const settings={llmClient:'saved-ordinary',llmModel:'saved-model',workspace:'/must-not-use',stream:true};
  await page.evaluate(settings=>{localStorage.setItem('agentic-rag-pet-run-settings-v1',JSON.stringify(settings));localStorage.setItem('agentic-rag-pet-chat-sessions-v4-draft-ordinary','保留普通草稿');},settings);
  const base=origin+'/chat.html?mode=work&embedded=matter&assistant=global&backend='+encodeURIComponent(origin)+'&session_id=';
  await page.locator('iframe').evaluate((node,url)=>node.src=url,base+'manager-default');
  const frame=await page.locator('iframe').contentFrame();
  await frame.locator('#sendButton').waitFor();assert(await frame.locator('#sendButton').isDisabled(),'startup send locked until backend kind verified');
  await page.waitForFunction(()=>messages.some(m=>m.type==='lka-matter-assistant-ready'));
  assert.equal(await frame.locator('#questionInput').getAttribute('placeholder'),'和真理聊聊目标、进展或下一步…');
  assert.equal(await frame.locator('.welcome h1').textContent(),'把事情交给真理');
  const child=page.frames().find(f=>f.url().includes('session_id=manager-default'));
  assert.deepEqual(await child.evaluate(()=>({kind:LkaChatContext.get().kind,id:LkaChatContext.get().sessionId,workspace:LkaChatContext.get().workspace})),{kind:'manager',id:'manager-default',workspace:''});
  assert.equal(await child.evaluate(()=>LkaChatContext.prepareAttachments('manager-default')),'manager-default');
  assert.match(await child.evaluate(()=>LkaChatContext.prepareWorkspace('manager-default').then(()=>'',e=>e.message)),/不绑定工作目录/);
  const attach=await frame.locator('input[type=file]').count();assert(attach>0,'existing attachment chooser remains');
  await frame.locator('#cachedFileInput').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('hello')});
  await frame.locator('#questionInput').fill('暂停管理时查询进展');await frame.locator('#sendButton').click();
  await page.waitForFunction(()=>document.querySelector('iframe').contentDocument.querySelector('#messages').textContent.includes('合成管理回复'));
  const turn=requests.find(r=>r.route==='/agent/turn/stream');assert(turn);assert.equal(turn.body.session_id,'manager-default');assert.equal(turn.body.llm.client_name,undefined);assert.equal(turn.body.llm.model,undefined);
  assert.deepEqual(turn.body.attachment_ids,['att_0123456789abcdef0123456789abcdef']);
  assert(requests.some(r=>r.route==='/sessions/manager-default/attachments'&&r.method==='POST'));
  assert(!requests.some(r=>r.route==='/pet/session-workspace'||r.route.endsWith('/workspace')||r.route.endsWith('/files')||r.route==='/sessions'));
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('agentic-rag-pet-run-settings-v1')).llmModel),'saved-model');
  assert.equal(await page.evaluate(()=>localStorage.getItem('agentic-rag-pet-chat-sessions-v4-draft-ordinary')),'保留普通草稿');
  assert.equal(await child.evaluate(()=>JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4'))[0].kind),'manager','kind survives sanitize/persistence after turn');
  // Background deliveries update the same manager conversation without touching drafts.
  managerMessages=[{role:'user',content:'暂停管理时查询进展'},
   {role:'tool',content:'内部后台输入不得冒充真理',payload:{input_origin:'background'}},
   {role:'tool',content:'内部主管派发不得冒充真理',payload:{input_envelope:{origin:'manager'}}},
   {role:'tool',content:'内部任务报告不得冒充真理',payload:{input_origin:'task_report'}},
   {role:'assistant',content:'SILENT_HISTORY_SECRET',payload:{user_visible:false}},
   {role:'agent',content:'SILENT_HISTORY_TOP_SECRET',user_visible:false},
   {role:'assistant',content:'合成管理回复'},
   {role:'assistant',content:'后台自主交付正文',payload:{input_origin:'background'}}];
  await frame.locator('#questionInput').fill('尚未发送的本地草稿');
  await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'lka-global-assistant-refresh',sessionId:'manager-default'},location.origin));
  await frame.locator('#messages').filter({hasText:'后台自主交付正文'}).waitFor();
  assert.equal(await frame.locator('#questionInput').inputValue(),'尚未发送的本地草稿');
  assert.equal(await frame.locator('#messages').getByText('内部后台输入不得冒充真理').count(),0);
  assert.equal(await frame.locator('#messages').getByText('内部主管派发不得冒充真理').count(),0);
  assert.equal(await frame.locator('#messages').getByText('内部任务报告不得冒充真理').count(),0);
  assert(!/SILENT_HISTORY/.test(await frame.locator('#messages').textContent()),'explicitly hidden historical answers never become bubbles');
  await child.evaluate(()=>LkaChatContext.refreshConversation());
  assert.equal(await frame.locator('#messages').getByText('后台自主交付正文',{exact:true}).count(),1,'delivery refresh never appends duplicates');
  const delivered=managerMessages;
  managerMessages=[{role:'tool',content:'仅有内部唤醒',payload:{input_origin:'background'}}];
  await child.evaluate(()=>LkaChatContext.refreshConversation());
  assert(!(await frame.locator('#messages').textContent()).includes('后台自主交付正文'),'filtered history can also clear stale bubbles without inventing a new reply');
  assert(!(await frame.locator('#messages').textContent()).includes('仅有内部唤醒'));
  managerMessages=delivered;await child.evaluate(()=>LkaChatContext.refreshConversation());
  // A response that began while idle must also be rejected if a turn starts before it returns.
  const arrival=new Promise(resolve=>onHeldSession=resolve);holdSessionRefresh=true;
  await child.evaluate(()=>{window.pendingConversationRefresh=LkaChatContext.refreshConversation();});await arrival;
  await frame.locator('#questionInput').fill('持续生成测试');await frame.locator('#sendButton').click();
  await frame.locator('#messages').filter({hasText:'持续生成中的正文'}).waitFor();
  heldSessionResponse();assert.equal(await child.evaluate(()=>window.pendingConversationRefresh),false,'in-flight idle refresh cannot overwrite a newly started turn');
  const readsBefore=requests.filter(r=>r.route==='/sessions/manager-default'&&r.method==='GET').length;
  assert.equal(await child.evaluate(()=>LkaChatContext.refreshConversation()),false,'busy direct refresh is refused');
  await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'lka-global-assistant-refresh',sessionId:'manager-default'},location.origin));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(requests.filter(r=>r.route==='/sessions/manager-default'&&r.method==='GET').length,readsBefore,'busy parent refresh performs no history request');
  assert((await frame.locator('#messages').textContent()).includes('持续生成中的正文'),'busy output remains visible');
  finishBusy();await frame.locator('#messages').filter({hasText:'持续生成中的正文已完成'}).waitFor();
  // A fresh iframe recovers the persisted root run without submitting a new turn.
  await page.locator('iframe').evaluate((node,url)=>node.src=url,base+'manager-restore');
  await frame.locator('#sendButton[data-run-state=paused]').waitFor();
  const restored=page.frames().find(f=>f.url().includes('session_id=manager-restore'));
  assert.equal(await restored.evaluate(()=>JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4'))[0].multiAgentRunId),'restored-root');
  assert.equal(requests.filter(r=>r.route==='/agent/turn/stream').length,2,'restoration does not create a new turn');
  // A competing root appearing after bootstrap returns 409: keep draft and reconnect, never replace.
  await page.locator('iframe').evaluate((node,url)=>node.src=url,base+'manager-conflict');
  await page.waitForFunction(()=>document.querySelector('iframe').contentWindow.LkaChatContext?.get().sessionId==='manager-conflict');
  await frame.locator('#sendButton:not([disabled])').waitFor();
  await frame.locator('#questionInput').fill('必须保留的并发草稿');await frame.locator('#sendButton').click();
  await frame.locator('#sendButton[data-run-state=paused]').waitFor();
  assert.equal(await frame.locator('#questionInput').inputValue(),'必须保留的并发草稿');
  assert.equal(requests.filter(r=>r.route==='/agent/turn/stream'&&r.body.session_id==='manager-conflict').length,1);
  assert(!requests.some(r=>r.method==='POST'&&/existing-root\/(replace|resume|interrupt)/.test(r.route)));
  // Failed or wrong-kind bootstrap never creates a replacement ordinary session.
  for(const id of ['manager-fail','manager-runs-fail','not-manager']){
   const before=requests.length;await page.locator('iframe').evaluate((node,url)=>node.src=url,base+id);
   await frame.locator('#runStatus').filter({hasText:/真理载入失败/}).waitFor();assert(await frame.locator('#sendButton').isDisabled());
   assert(!requests.slice(before).some(r=>r.route==='/sessions'||r.route==='/pet/session-workspace'||r.route.endsWith('/workspace')));
  }
  // Ordinary workbench retains its workspace behavior and excludes managers from recents/cleanup.
  const ordinary=await context.newPage();await ordinary.goto(origin+'/chat.html?mode=work&backend='+encodeURIComponent(origin));
  await ordinary.waitForFunction(()=>!!window.LkaChatContext?.get().sessionId);await ordinary.locator('[data-session-id="ordinary"]').first().waitFor();
  assert.equal(await ordinary.locator('[data-session-id="manager-empty"]').count(),0);
  assert(!requests.some(r=>r.route==='/sessions/manager-empty'&&r.method==='DELETE'));
  await ordinary.waitForTimeout(300);
  assert(!requests.some(r=>r.route==='/pet/session-workspace'),'an untouched ordinary task defers its workspace until first use');
  // A stale ordinary history response arrives after a complete new local turn.
  await ordinary.evaluate(()=>LkaChatContext.openSession('ordinary'));
  await ordinary.locator('#messages').filter({hasText:'ordinary initial answer'}).waitFor();
  async function assertDispatchVisible(){
   const instruction=ordinary.locator('.message[data-message-kind="manager_instruction"]');
   assert.equal(await instruction.count(),1,'first supervisor instruction is visible exactly once');
   assert.equal(await instruction.getAttribute('class'),'message user','delegation appears on the input side');
   assert.equal(await instruction.locator('strong').first().textContent(),'真理派发的任务');
   assert.equal(await instruction.evaluate(node=>getComputedStyle(node).alignItems),'flex-end','instruction uses the workbench input alignment');
   await ordinary.evaluate(()=>document.body.classList.add('quick-mode'));
   assert(await instruction.locator('strong').first().isVisible(),'delegation sender is also visible in quick mode');
   await ordinary.evaluate(()=>document.body.classList.remove('quick-mode'));
   assert.equal(await instruction.locator('.markdown-body code').first().textContent(),'hello.py','task formatting survives the side change');
   const reply=ordinary.locator('#messages .message.assistant').filter({hasText:'ordinary initial answer'});
   assert.equal(await reply.count(),1,'execution reply remains on the assistant side');
   assert.equal(await reply.locator('strong').first().textContent(),'真理');
   assert((await instruction.textContent()).includes('hello.py'));
   assert((await instruction.textContent()).includes('完成后报告路径与文件内容。'));
   assert.equal(await ordinary.locator('#messages .message.user:not([data-message-kind="manager_instruction"])').count(),0,'dispatch never impersonates human input');
   assert(!/secret-source|secret-debug|secret-id|ordinary internal dispatch/.test(await ordinary.locator('#messages').textContent()));
   const cached=await ordinary.evaluate(()=>JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4')).find(s=>s.id==='ordinary'));
   assert.equal(cached.messages[0].messageKind,'manager_instruction','sender survives cache sanitization');
   assert.notEqual(cached.messages[0].role,'user','input-side rendering does not make delegation a human message');
   assert.equal(cached.messages[0].text,dispatchedTask);
  }
  await assertDispatchVisible();
  await ordinary.goto(origin+'/chat.html?mode=work&backend='+encodeURIComponent(origin)+'&session_id=ordinary');
  await ordinary.locator('#messages').filter({hasText:'ordinary initial answer'}).waitFor();
  await assertDispatchVisible();
  const oldHistoryArrived=new Promise(resolve=>onOrdinaryHeld=resolve);holdOrdinaryRefresh=true;
  await ordinary.evaluate(()=>dispatchEvent(new Event('focus')));await oldHistoryArrived;
  await ordinary.locator('#questionInput').fill('已完成的新用户指令');await ordinary.locator('#sendButton').click();
  await ordinary.locator('#messages').filter({hasText:'合成管理回复'}).waitFor();
  await ordinary.locator('#sendButton:not([disabled])').waitFor();
  releaseOrdinaryRefresh();await ordinary.waitForTimeout(250);
  assert((await ordinary.locator('#messages').textContent()).includes('已完成的新用户指令'),'late filtered history preserves a completed user turn');
  assert.equal(await ordinary.locator('#messages .message.user').filter({hasText:'已完成的新用户指令'}).locator('strong').first().textContent(),'你','human intervention retains its own sender');
  assert((await ordinary.locator('#messages').textContent()).includes('合成管理回复'),'late filtered history preserves its real assistant answer');
  // Internal rounds preserve run lifecycle/cursors without projecting hidden content.
  const silentContext=await browser.newContext();silentContext.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  const silent=await silentContext.newPage();
  await silent.goto(origin+'/chat.html?mode=work&embedded=matter&assistant=global&backend='+encodeURIComponent(origin)+'&session_id=manager-silent-active');
  await silent.locator('#sendButton:not([disabled])').waitFor();
  await silent.locator('#questionInput').fill('静默管理处理测试');await silent.locator('#sendButton').click();
  await silent.waitForFunction(()=>JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4-run-cursor-manager-silent-active'))?.sequence>=3);
  assert(!/SILENT_/.test(await silent.locator('body').textContent()),'hidden process and delta content never renders while streaming');
  finishSilent();
  await silent.waitForFunction(()=>JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4')).find(s=>s.id==='manager-silent-active')?.runControlStatus==='completed');
  await silent.locator('#sendButton:not([disabled])').waitFor();
  let silentState=await silent.evaluate(()=>JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4')).find(s=>s.id==='manager-silent-active'));
  assert.equal(silentState.multiAgentSequence,5,'hidden events still advance the durable cursor');
  assert.equal(silentState.timelineState,'completed','silent completion preserves lifecycle');
  assert(!/SILENT_|本轮没有生成可显示的回答/.test(await silent.locator('body').textContent()),'silent completion does not invent a fallback answer');
  assert(!/SILENT_/.test(JSON.stringify(silentState.messages)+JSON.stringify(silentState.timelineEvents)),'silent content stays out of conversation and timeline caches');
  await silent.evaluate(()=>__petChatReceive({session_id:'manager-silent-active',answer:'SILENT_DIRECT_SECRET',user_visible:false}));
  assert(!/SILENT_DIRECT/.test(await silent.locator('body').textContent()),'nonstream final commits obey explicit visibility');
  await silent.evaluate(()=>__petChatReceive({session_id:'manager-silent-active',answer:'LEGACY_VISIBLE_ANSWER',progress_events:[{type:'assistant_message',message:'SILENT_PROGRESS_SECRET',metadata:{user_visible:false}}]}));
  assert.equal(await silent.locator('#messages').getByText('LEGACY_VISIBLE_ANSWER',{exact:true}).count(),1,'missing visibility remains compatible');
  assert(!/SILENT_PROGRESS/.test(await silent.locator('body').textContent()),'visible answers do not expose hidden progress details');
  await silent.close();await silentContext.close();
  // Explicit manager links initialize that exact controller, including embedded views.
  for(const embedded of [false,true]){
   const id='manager-unconfigured-'+(embedded?'embedded':'explicit'),linked=await context.newPage(),before=requests.length;
   await linked.addInitScript(()=>{window.fixtureLinkedManagerIds=[];addEventListener('lka-session-context',()=>{const view=window.LkaChatContext?.get();if(view?.kind==='manager')fixtureLinkedManagerIds.push(view.sessionId);});});
   await linked.goto(origin+'/chat.html?mode=work&backend='+encodeURIComponent(origin)+'&session_id='+id+(embedded?'&embedded=matter&assistant=global':''));
   await linked.locator('#sendButton:not([disabled])').waitFor();
   assert(extraManagerWorkspaces.has(id),'explicit original manager received the parent configuration');
   assert.equal(await linked.evaluate(()=>LkaChatContext.get().sessionId),id,'background preparation never replaces the explicit manager');
   assert((await linked.evaluate(()=>fixtureLinkedManagerIds)).every(selected=>selected===id),'every published manager selection retains the explicit identity');
   const workspacePatches=requests.slice(before).filter(r=>r.method==='PATCH'&&r.body.default_execution_workspace);
   assert(workspacePatches.length>0);assert(workspacePatches.every(r=>r.route==='/managers/'+id&&r.body.expected_revision===1),'workspace CAS changes only the original controller');
   assert(!requests.slice(before).some(r=>r.route==='/sessions'&&r.method==='POST'),'explicit manager creates no ordinary session');
   assert(!requests.slice(before).some(r=>r.route==='/pet/session-workspace'),'explicit manager creates no ordinary directory');
   await linked.close();
  }
  const launchContext=await browser.newContext(), launcher=await launchContext.newPage();
  const workspaceBefore=requests.filter(r=>r.route==='/pet/session-workspace').length;
  const defaultsLoaded=launcher.waitForResponse(r=>new URL(r.url()).pathname==='/agent/ui-defaults');
  await launcher.goto(origin+'/chat.html?mode=work&assistant=global&backend='+encodeURIComponent(origin));
  await defaultsLoaded;await launcher.waitForFunction(()=>LkaChatContext.get().kind==='manager');assert.equal(managerWorkspace.path,'/synthetic/tasks');assert.equal(managerRevision,2);assert(requests.some(r=>r.route==='/pet/session-workspace-parent'));await launcher.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(requests.filter(r=>r.route==='/pet/session-workspace').length,workspaceBefore,'top-level global launcher creates no unused workspace');
  await launchContext.close();
  // A parent resolution failure is visible and never presents a ready assistant.
  managerWorkspace=null;parentFails=true;
  const explicitFailure=await context.newPage();await explicitFailure.goto(origin+'/chat.html?mode=work&embedded=matter&assistant=global&backend='+encodeURIComponent(origin)+'&session_id=manager-explicit-failure');
  await explicitFailure.locator('#runStatus').filter({hasText:'默认任务目录准备失败'}).waitFor();assert(await explicitFailure.locator('#sendButton').isDisabled());await explicitFailure.close();
  const failed=await context.newPage();await failed.goto(origin+'/chat.html?mode=work&assistant=global&backend='+encodeURIComponent(origin));
  await failed.locator('#gaConnectionText').filter({hasText:'默认任务目录准备失败'}).waitFor();assert(await failed.locator('#sendButton').isDisabled());await failed.close();
  assert.deepEqual(errors,[]);
  console.log('PASS manager chat: verified kind and delayed bootstrap, paused chat, isolated model/drafts, original-session attachment upload, delivery refresh and generation/busy guards, fail-closed initialization, manager cleanup/recent exclusions, ordinary workspace behavior, hidden history/active SSE/final commit with lifecycle and cursor preservation');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
