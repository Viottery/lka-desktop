'use strict';
// Local synthetic backend only; no personal services or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = process.env.FRONTEND_ROOT || path.resolve(__dirname, '../app/web/pet');
const stamp = new Date().toISOString(), requests = [], errors = [], streams = new Map();
let activeRun = 'root-1', paused = false, holdPost, holdUpload, holdGet, probeFailures = 0, resumeRun = 3, failNext = false, dropNext = false;
const runStatuses = new Map([['root-1', 'running']]);
let receipts = [{ input_id:'i0', client_message_id:'initial', message_id:'m0', sequence:1, status:'running', run_id:'root-1' }];
let history = [{ message_id:'m0', role:'user', content:'原来的任务', payload:{client_message_id:'initial'} }];
const ordinaryHistory = [{message_id:'ordinary-answer',role:'agent',content:'普通会话已有回答',payload:{}}];
function detail(id = 'manager-queue', kind = 'manager') { return {session:{session_id:id,kind,title:'合成会话',created_at:stamp,updated_at:stamp,metadata:{source_frontend:'windows-pet'},workspace:null},messages:kind === 'manager' ? history : ordinaryHistory}; }
const json = (res,status,value) => {res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const snapshot = () => ({inputs:receipts,paused,pending_count:receipts.filter(r=>['queued','running'].includes(r.status)).length,active_run_id:activeRun});
function event(run,name,payload={}) { const res=streams.get(run);assert(res,'stream '+run+' exists');res.write('event: '+name+'\ndata: '+JSON.stringify({run_id:run,payload})+'\n\n'); }
function finish(run,status,answer) {
 if(answer){history.push({message_id:'answer-'+run,role:'agent',content:answer,payload:{}});event(run,'final_answer',{metadata:{answer}});}
 event(run,status==='failed'?'run_failed':'run_completed');streams.get(run).end();streams.delete(run);
}
const server = http.createServer(async(req,res)=>{
 const route=new URL(req.url,'http://fixture').pathname;
 if(route==='/__quiet-font'&&fs.existsSync('/mnt/c/Windows/Fonts/msyh.ttc')){res.writeHead(200,{'content-type':'font/collection'});return fs.createReadStream('/mnt/c/Windows/Fonts/msyh.ttc').pipe(res);}
 const file=path.resolve(ROOT,'.'+route);
 if(file.startsWith(ROOT+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){res.writeHead(200,{'content-type':route.endsWith('.js')?'text/javascript':route.endsWith('.css')?'text/css':'text/html'});return fs.createReadStream(file).pipe(res);}
 let raw='';for await(const chunk of req)raw+=chunk;let body={};try{body=JSON.parse(raw||'{}');}catch{}
 requests.push({route,method:req.method,body});
 if(route==='/managers/default')return json(res,200,{...detail(),controller:{session_id:'manager-queue',revision:1,status:'paused',default_execution_workspace:{path:'/synthetic/work',platform:'linux'}}});
 if(route==='/agent/models')return json(res,200,{clients:[]});
 if(route==='/agent/ui-defaults')return json(res,200,{configured:true,defaults:{stream:true}});
 if(route==='/knowledge/file-types')return json(res,200,{file_types:[{extensions:['.txt'],index_supported:true}]});
 if(route==='/sessions/deleted')return json(res,200,{sessions:[]});
 if(route==='/sessions')return json(res,200,{sessions:[detail('ordinary','ordinary').session]});
 if(route==='/openapi.json')return json(res,200,{paths:{}});
 if(route==='/sessions/manager-queue/inputs/resume'){paused=false;activeRun='root-'+resumeRun++;runStatuses.set(activeRun,'running');receipts.find(r=>r.status==='queued').status='running';receipts.find(r=>r.status==='running').run_id=activeRun;return json(res,200,snapshot());}
 if(route==='/sessions/manager-queue/inputs'){
  if(req.method==='GET'){
   if(probeFailures){probeFailures--;return json(res,503,{detail:'synthetic_transient'});}
   if(holdGet){const saved=JSON.parse(JSON.stringify(snapshot()));holdGet.release=()=>json(res,200,saved);return;}
   return json(res,200,snapshot());
  }
  if(failNext){failNext=false;return json(res,409,{detail:'manager_delivery_disabled'});}
  const accept=()=>{
   let receipt=receipts.find(r=>r.client_message_id===body.client_message_id);
   if(!receipt){
    if(body.replace_run_id && (body.replace_run_id!==activeRun || runStatuses.get(activeRun)!=='paused'))return json(res,409,{detail:'paused_run_changed'});
    receipt={input_id:'i'+receipts.length,client_message_id:body.client_message_id,message_id:'m'+receipts.length,sequence:receipts.length+1,status:'queued',run_id:null};receipts.push(receipt);history.push({message_id:receipt.message_id,role:'user',content:body.user_input,payload:{client_message_id:receipt.client_message_id,attachment_ids:body.attachment_ids}});
    if(body.replace_run_id){runStatuses.set(activeRun,'cancelled');receipts.find(r=>r.run_id===activeRun).status='cancelled';activeRun='root-replacement';runStatuses.set(activeRun,'running');receipt.status='running';receipt.run_id=activeRun;paused=false;}
   }
   if(dropNext){dropNext=false;res.destroy();return;}
   json(res,202,{input:receipt,queue:{paused,pending_count:snapshot().pending_count,active_run_id:activeRun}});
  };
  if(holdPost){holdPost.release=accept;return;}accept();return;
 }
 if(route==='/sessions/manager-queue/attachments'){
  const send=()=>json(res,201,{attachment_id:'att_0123456789abcdef0123456789abcdef',kind:'document',filename:'synthetic.txt',media_type:'text/plain',size_bytes:5});
  if(holdUpload){holdUpload.release=send;return;}send();return;
 }
 if(route.endsWith('/runs')){const sessionId=route.split('/')[2],latestReceipt=[...receipts].reverse().find(r=>r.run_id),latestRunId=activeRun||(latestReceipt&&latestReceipt.run_id);return json(res,200,{session_id:sessionId,runs:sessionId==='manager-queue'&&latestRunId?[{run_id:latestRunId,session_id:sessionId,parent_run_id:null,status:runStatuses.get(latestRunId)||'completed',created_at:stamp}]:[],next_offset:null});}
 if(route==='/sessions/manager-queue')return json(res,200,detail());
 if(route==='/sessions/ordinary')return json(res,200,detail('ordinary','ordinary'));
 if(route==='/pet/session-workspace')return json(res,200,{path:'/synthetic/work'});
 if(route.endsWith('/workspace'))return json(res,200,{project_id:'synthetic-project'});
 if(route.endsWith('/files'))return json(res,200,{entries:[]});
 if(/^\/agent\/runs\//.test(route)){
  const id=route.split('/')[3];
  if(route.endsWith('/resume')&&req.method==='POST'){runStatuses.set(id,'running');return json(res,202,{run_id:id,status:'running',pause_requested:false});}
  if(route.endsWith('/stream')){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\n\n');streams.set(id,res);req.on('close',()=>{if(streams.get(id)===res)streams.delete(id);});return;}
  return json(res,200,{run_id:id,status:runStatuses.get(id)||(id===activeRun?'running':receipts.some(r=>r.run_id===id&&r.status==='failed')?'failed':'completed')});
 }
 return json(res,404,{detail:'unmocked'});
});
const wait = async predicate => {for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,25));}throw new Error('fixture condition timed out');};
(async()=>{
 let browser;
 try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/tmp/lka-playwright-browsers/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']});
  const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/chat.html?mode=work&assistant=global&backend='+encodeURIComponent(origin));
  await page.locator('#chatForm[data-input-mode=continuous]').waitFor();await wait(()=>streams.has('root-1'));
  event('root-1','llm_delta',{display_target:'assistant_answer',delta:'原任务仍在生成'});
  await page.locator('#messages').filter({hasText:'原任务仍在生成'}).waitFor();
  // Attachment preparation and POST ordering do not lock the next text send.
  holdUpload={};await page.locator('#cachedFileInput').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('hello')});await wait(()=>holdUpload.release);
  await page.locator('#questionInput').fill('带附件排队');await page.locator('#sendButton').click();
  await page.locator('#questionInput').fill('下一条文字');assert.equal(await page.locator('#sendButton').isDisabled(),false);await page.locator('#sendButton').click();
  await page.locator('#questionInput').fill('上传期间的新草稿');
  assert.equal(requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').length,0,'text send waits behind earlier attachment input');
  assert.equal(await page.evaluate(()=>LkaChatContext.refreshConversation()),true);
  assert.equal(await page.locator('.message.user').filter({hasText:'带附件排队'}).count(),1,'history refresh preserves local pending input');
  assert((await page.locator('#messages').textContent()).includes('原任务仍在生成'),'history refresh preserves live reply');
  holdPost={};holdUpload.release();holdUpload=null;await wait(()=>holdPost.release);
  assert.equal(requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').length,1);
  assert.equal(await page.locator('#questionInput').inputValue(),'上传期间的新草稿');
  const release=holdPost.release;holdPost=null;release();await wait(()=>receipts.length===3);
  await page.locator('[data-input-status=queued]').first().waitFor();
  const posts=requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST');assert.deepEqual(posts.map(r=>r.body.user_input),['带附件排队','下一条文字']);
  assert.deepEqual(posts[0].body.attachment_ids,['att_0123456789abcdef0123456789abcdef']);assert.deepEqual(posts[1].body.attachment_ids,[]);
  assert.equal(requests.filter(r=>r.route==='/agent/runs/root-1/stream').length,1,'enqueue never replaces existing SSE subscription');
  assert(!requests.some(r=>r.route==='/agent/turn/stream'),'no direct turn injection');
  assert.equal(await page.locator('#inputQueueControls,.input-queue-status').count(),0,'normal conversation has no queue bar or receipt labels');
  await page.evaluate(()=>LkaChatContext.refreshConversation());assert.equal(await page.locator('.message.user').filter({hasText:'带附件排队'}).count(),1,'durable message ID replaces optimistic bubble');
  // The next root is discovered after completion, and durable history has one answer.
  // root-1 completes and the backend activates root-2 while this same tab is
  // viewing an ordinary session. Background tracking must not steal its draft,
  // answer bubble, or selection, and returning must reuse one root-2 stream.
  receipts[0].status='completed';receipts[1].status='running';receipts[1].run_id='root-2';activeRun='root-2';runStatuses.set('root-1','completed');runStatuses.set('root-2','running');
  history.push({message_id:'answer-root-1',role:'agent',content:'原任务已完成',payload:{}});
  await page.evaluate(()=>LkaChatContext.openSession('ordinary'));
  await page.locator('#questionInput').fill('普通会话草稿');
  await wait(()=>streams.has('root-2'));
  assert.equal(await page.locator('#questionInput').inputValue(),'普通会话草稿');
  assert.equal(await page.locator('.message.assistant').filter({hasText:'普通会话已有回答'}).count(),1);
  assert.equal(await page.locator('.message.assistant').filter({hasText:'原任务仍在生成'}).count(),0,'manager output must not leak into ordinary view');
  assert.equal(requests.filter(r=>r.route==='/agent/runs/root-2/stream').length,1,'background discovery subscribes to root-2 once');
  await page.evaluate(()=>LkaChatContext.openSession('manager-queue'));
  assert.equal(await page.locator('#questionInput').inputValue(),'上传期间的新草稿');
  assert.equal(requests.filter(r=>r.route==='/agent/runs/root-2/stream').length,1,'returning to manager reuses the background subscription');
  await page.locator('.message.assistant').filter({hasText:'原任务已完成'}).waitFor();assert.equal(await page.locator('.message.assistant').filter({hasText:'原任务已完成'}).count(),1);
  // Failed execution pauses the FIFO; resuming follows the backend's new root.
  receipts[1].status='failed';activeRun=null;paused=true;runStatuses.set('root-2','failed');finish('root-2','failed');
  const priorDraft=await page.locator('#questionInput').inputValue();
  const pendingPosts=requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').length;
  await page.locator('#managerInputQueueNotice').waitFor();
  assert((await page.locator('#managerInputQueueNotice').textContent()).includes('上一轮未完成，消息已收到，等待继续'));
  assert.equal(await page.locator('#sendButton').getAttribute('data-action'),'send','draft keeps its send action');
  await page.evaluate(()=>LkaChatContext.openSession('ordinary'));
  await page.locator('#managerInputQueueNotice').waitFor({state:'hidden'});
  await page.evaluate(()=>LkaChatContext.openSession('manager-queue'));
  await page.locator('#managerInputQueueNotice').waitFor();
  const nextInput=receipts.filter(r=>r.status==='queued'&&!r.run_id).sort((a,b)=>a.sequence-b.sequence)[0].input_id;
  await page.locator('#managerInputQueueNotice').getByRole('button',{name:'改用推理模型继续',exact:true}).click();
  await wait(()=>requests.some(r=>r.route.endsWith('/inputs/resume')&&r.body.input_id===nextInput));
  assert.deepEqual(requests.filter(r=>r.route.endsWith('/inputs/resume')).at(-1).body,{input_id:nextInput,answer_client_name:null,answer_model:null});
  await wait(()=>streams.has('root-3'));runStatuses.set('root-3','running');
  assert.equal(await page.locator('#questionInput').inputValue(),priorDraft,'queue continuation preserves unsent draft');
  assert.equal(requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').length,pendingPosts,'continuation does not resend failed messages');
  await page.locator('#managerInputQueueNotice').waitFor({state:'hidden'});
  assert(requests.some(r=>r.route.endsWith('/inputs/resume')&&r.method==='POST'));
  // A rejected submission preserves later drafts and blocks later local sends.
  failNext=true;await page.locator('#questionInput').fill('需要重试');await page.locator('#sendButton').click();
  await page.locator('[data-input-status=submission_failed]').waitFor();assert.equal(await page.getByRole('button',{name:'重试发送',exact:true}).innerText(),'','send failure keeps an icon-only retry');const failedPost=requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').at(-1);
  assert.equal(await page.locator('#questionInput').inputValue(),'需要重试');
  await page.locator('#questionInput').fill('失败后的后续消息');await page.locator('#sendButton').click();await page.locator('#questionInput').fill('重试期间的新草稿');
  await new Promise(r=>setTimeout(r,150));assert.equal(requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').at(-1),failedPost,'later submission stays local until earlier retry');
  await page.getByRole('button',{name:'重试发送'}).click();await wait(()=>receipts.length===5);
  const retryPosts=requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST');assert.equal(retryPosts.at(-2).body.client_message_id,failedPost.body.client_message_id,'retry keeps original ID');assert.equal(retryPosts.at(-1).body.user_input,'失败后的后续消息');
  assert.equal(await page.locator('#questionInput').inputValue(),'重试期间的新草稿');
  // An accepted request whose response disappears is reconciled without duplicates.
  dropNext=true;await page.locator('#questionInput').fill('回执丢失');await page.locator('#sendButton').click();await wait(()=>receipts.length===6);
  await wait(()=>requests.some(r=>r.route.endsWith('/inputs')&&r.method==='POST'&&r.body.user_input==='回执丢失'));
  await page.locator('.message.user').filter({hasText:'回执丢失'}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.message.user[data-input-status=queued]').length>=3);
  await page.evaluate(()=>LkaChatContext.refreshConversation());assert.equal(await page.locator('.message.user').filter({hasText:'回执丢失'}).count(),1);
  // Reload retains stable IDs, reconnects the active root and preserves drafts.
  await page.locator('#questionInput').fill('刷新保留草稿');await page.reload();await page.locator('#chatForm[data-input-mode=continuous]').waitFor();
  assert.equal(await page.locator('#questionInput').inputValue(),'刷新保留草稿');assert.equal(await page.locator('.message.user').filter({hasText:'回执丢失'}).count(),1);
  // An unconfirmed local POST remains retryable after a full reload.
  holdPost={};await page.locator('#questionInput').fill('重开后核对发送');await page.locator('#sendButton').click();await wait(()=>holdPost.release);
  const missingPost=requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').at(-1),lateReply=holdPost.release;holdPost=null;
  await page.locator('#questionInput').fill('重开前的第二条');await page.locator('#sendButton').click();
  await page.reload();await page.locator('#chatForm[data-input-mode=continuous]').waitFor();
  await page.getByRole('button',{name:'重试发送'}).first().waitFor();
  const reloadBefore=requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').length;
  await page.locator('#questionInput').fill('重开后的第三条');await page.locator('#sendButton').click();
  await new Promise(r=>setTimeout(r,150));assert.equal(requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').length,reloadBefore,'new input stays behind both reloaded unconfirmed inputs');
  await page.getByRole('button',{name:'重试发送'}).first().click();
  await wait(()=>receipts.some(r=>r.client_message_id===missingPost.body.client_message_id));lateReply();
  assert.equal(requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').at(-1).body.client_message_id,missingPost.body.client_message_id,'reload retry keeps ID');
  await page.getByRole('button',{name:'重试发送'}).first().click();
  await wait(()=>history.some(m=>m.content==='重开后的第三条'));
  // An older GET resolving after resume cannot restore the old active root.
  receipts.find(r=>r.run_id==='root-3').status='failed';activeRun=null;paused=true;runStatuses.set('root-3','failed');finish('root-3','failed');
  await page.locator('#questionInput').fill('');await page.getByRole('button',{name:'继续处理消息',exact:true}).waitFor();holdGet={};await wait(()=>holdGet.release);
  const releaseOldGet=holdGet.release;holdGet=null;await page.getByRole('button',{name:'继续处理消息',exact:true}).click();await wait(()=>streams.has('root-4'));releaseOldGet();
  await new Promise(r=>setTimeout(r,100));assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4')).find(s=>s.kind==='manager').multiAgentRunId),'root-4');
  // A manager root first observed while ordinary is paused remains a background
  // status update; opening the manager later replays it without resuming it.
  await page.evaluate(()=>LkaChatContext.openSession('ordinary'));
  receipts.find(r=>r.run_id==='root-4').status='completed';runStatuses.set('root-4','completed');
  const pausedReceipt={input_id:'paused-input',client_message_id:'paused-input',message_id:'paused-message',sequence:receipts.length+1,status:'running',run_id:'root-5'};
  receipts.push(pausedReceipt);history.push({message_id:pausedReceipt.message_id,role:'user',content:'暂停中的新任务',payload:{client_message_id:pausedReceipt.client_message_id}});
  activeRun='root-5';paused=true;runStatuses.set('root-5','paused');finish('root-4','completed');
  await wait(()=>requests.some(r=>r.route==='/agent/runs/root-5'));
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4')).find(s=>s.kind==='manager').runControlStatus==='paused');
  assert.equal(requests.filter(r=>r.route==='/agent/runs/root-5/stream').length,0,'background discovery does not subscribe to a paused manager root');
  assert.equal(await page.locator('#questionInput').inputValue(),'普通会话草稿');
  await page.evaluate(()=>LkaChatContext.openSession('manager-queue'));
  await page.locator('#sendButton[data-action=resume]').waitFor();
  assert.equal(await page.locator('#sendButton').getAttribute('aria-label'),'继续任务');
  assert.equal(await page.locator('#managerInputQueueNotice button').first().isDisabled(),true,'queue continuation cannot resume an active paused root');
  assert(requests.some(r=>r.route==='/agent/runs/root-5/stream'),'opening the paused manager session replays its process read-only');
  assert(!requests.some(r=>r.route==='/agent/runs/root-5/resume'&&r.method==='POST'),'returning to paused root still does not resume it');
  // Empty resume preserves the original instruction/run. A new instruction
  // after another pause supersedes only that task, ahead of the saved backlog.
  const beforeResumePosts=requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').length;
  await page.locator('#sendButton').click();await wait(()=>streams.has('root-5'));
  assert(requests.some(r=>r.route==='/agent/runs/root-5/resume'&&r.method==='POST'));
  assert.equal(requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').length,beforeResumePosts);
  runStatuses.set('root-5','paused');event('root-5','run_paused');streams.get('root-5').end();streams.delete('root-5');
  await page.locator('#sendButton[data-action=resume]').waitFor();
  const backlog=receipts.filter(r=>r.status==='queued').map(r=>r.input_id);
  holdPost={};await page.locator('#questionInput').fill('改成先给我设计方案');
  assert.equal(await page.locator('#sendButton').getAttribute('aria-label'),'替换暂停任务');
  await page.locator('#sendButton').click();await wait(()=>holdPost.release);
  const replacementPost=requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').at(-1);
  assert.equal(replacementPost.body.replace_run_id,'root-5');
  await page.locator('#questionInput').fill('然后补充实现细节');await page.locator('#sendButton').click();
  const releaseReplacement=holdPost.release;holdPost=null;releaseReplacement();
  await wait(()=>streams.has('root-replacement'));
  await wait(()=>history.some(m=>m.content==='然后补充实现细节'));
  const followupPost=requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').at(-1);
  assert.equal(followupPost.body.user_input,'然后补充实现细节');assert.equal(followupPost.body.replace_run_id,undefined,'only first paused input replaces');
  assert.equal(runStatuses.get('root-5'),'cancelled');assert.equal(paused,false);
  assert.deepEqual(receipts.filter(r=>backlog.includes(r.input_id)).map(r=>r.input_id),backlog,'existing FIFO backlog retained');
  assert(history.some(m=>m.content==='暂停中的新任务'),'original instruction history retained');
  const ordinary=await context.newPage();await ordinary.goto(origin+'/chat.html?mode=work&session_id=ordinary&backend='+encodeURIComponent(origin));await ordinary.waitForFunction(()=>window.LkaChatContext?.get().sessionId==='ordinary');
  assert.equal(await ordinary.locator('#inputQueueControls').count(),0);assert(!requests.some(r=>r.route==='/sessions/ordinary/inputs'));
  // The native quick composer's generic bridge uses the same queued path.
  await page.close();await ordinary.close();
  const nativeContext=await browser.newContext(),native=await nativeContext.newPage();native.on('pageerror',e=>errors.push(e.message));
  probeFailures=1;holdGet={};await native.goto(origin+'/chat.html?assistant=quick&backend='+encodeURIComponent(origin));
  await native.locator('#runStatus').filter({hasText:'暂时无法核对消息队列'}).waitFor();
  await wait(()=>holdGet.release);
  await native.locator('#questionInput').fill('探测期间的草稿');assert.equal(await native.locator('#sendButton').isDisabled(),true,'unknown capability never falls back after transient failure');
  assert.equal(await native.evaluate(()=>__petChatSubmitText('探测期间的草稿')),false);
  const releaseProbe=holdGet.release;holdGet=null;releaseProbe();
  await native.locator('#chatForm[data-input-mode=continuous]').waitFor();
  await native.evaluate(()=>{
   window.nativeRequests=[];window.nativeDraft='';window.petBridge={setComposerBusy(){},setComposerAction(){},setQuickPanelHeight(){},focusComposer(){},setComposerDraft:text=>window.nativeDraft=text,
    requestMemory:raw=>{const r=JSON.parse(raw);nativeRequests.push(r);fetch(LkaChatContext.get().backend+r.path,{method:r.method,headers:{'Content-Type':'application/json'},body:r.body||undefined}).then(async response=>__lkaMemoryBridgeReceive(r.id,response.status,await response.text()));}};
   __petChatBridgeReady();
  });
  const nativeBefore=receipts.length;
  await native.evaluate(()=>{__petChatNativeDraftChanged('原生第一条');if(!__petChatSubmitText('原生第一条'))throw Error('first native send blocked');__petChatNativeDraftChanged('原生第二条');if(!__petChatSubmitText('原生第二条'))throw Error('second native send blocked');__petChatNativeDraftChanged('原生保留草稿');});
  await wait(()=>receipts.length===nativeBefore+2);
  assert.deepEqual(await native.evaluate(()=>nativeRequests.filter(r=>r.method==='POST'&&r.path.endsWith('/inputs')).map(r=>JSON.parse(r.body).user_input)),['原生第一条','原生第二条']);
  assert.equal(await native.evaluate(()=>localStorage.getItem('agentic-rag-pet-chat-sessions-v4-draft-manager-queue')),'原生保留草稿');
  // Empty text plus attachments is visible on a fresh cache/device as well.
  await native.evaluate(()=>{petBridge=null;document.body.classList.remove('native-composer');});
  await native.locator('#cachedFileInput').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('hello')});
  const attachmentBefore=receipts.length;await native.evaluate(()=>__petChatSubmitText(''));await wait(()=>receipts.length===attachmentBefore+1);
  await native.close();
  for(let i=0;i<24;i++)history.push({message_id:'old-'+i,role:'agent',content:'较早的阅读内容 '+i+'。'.repeat(18),payload:{}});
  const freshContext=await browser.newContext(),fresh=await freshContext.newPage();
  await fresh.goto(origin+'/chat.html?assistant=quick&backend='+encodeURIComponent(origin));await fresh.locator('#chatForm[data-input-mode=continuous]').waitFor();
  assert.equal(await fresh.locator('.message.user').filter({hasText:'[File input]'}).count(),1,'attachment-only history survives without local optimistic cache');
  assert.equal(await fresh.locator('.message.assistant').filter({hasText:'原任务已完成'}).count(),1,'actual backend agent-role answer survives fresh-cache history reload');
  // Native quick users may be reading old history when they explicitly send.
  // The newly queued question must become visible without waiting for a reply.
  await fresh.evaluate(()=>{
   window.petBridge={setComposerBusy(){},setComposerAction(){},setQuickPanelHeight(){},focusComposer(){},setComposerDraft(){},requestMemory:raw=>{const r=JSON.parse(raw);fetch(LkaChatContext.get().backend+r.path,{method:r.method,headers:{'Content-Type':'application/json'},body:r.body||undefined}).then(async response=>__lkaMemoryBridgeReceive(r.id,response.status,await response.text()));}};
   __petChatBridgeReady();
   const box=document.querySelector('#messages');box.scrollTop=0;
  });
  await fresh.waitForFunction(()=>document.querySelector('#messages').scrollHeight>document.querySelector('#messages').clientHeight);
  await fresh.evaluate(()=>{__petChatNativeDraftChanged('从旧阅读位置发送');if(!__petChatSubmitText('从旧阅读位置发送'))throw Error('native queued send was rejected');});
  await wait(()=>history.some(m=>m.content==='从旧阅读位置发送'));
  const latestQuestion=fresh.locator('.message.user').filter({hasText:'从旧阅读位置发送'}).last();await latestQuestion.waitFor();
  await fresh.waitForFunction(()=>{const box=document.querySelector('#messages'),row=Array.from(box.querySelectorAll('.message.user')).find(x=>x.textContent.includes('从旧阅读位置发送'));if(!row)return false;const b=box.getBoundingClientRect(),r=row.getBoundingClientRect();return r.bottom>b.top&&r.top<b.bottom;});
  // A persisted empty paused queue is quiet. Pending messages expose explicit
  // recovery while keeping the existing empty-composer continuation icon.
  await freshContext.close();receipts=[];history=[];activeRun=null;paused=true;
  const quietContext=await browser.newContext({viewport:{width:1280,height:800}}),quiet=await quietContext.newPage();quiet.on('pageerror',e=>errors.push(e.message));
  await quiet.goto(origin+'/chat.html?mode=work&assistant=global&backend='+encodeURIComponent(origin));
  await quiet.locator('#chatForm[data-input-mode=continuous]').waitFor();
  assert.equal(await quiet.locator('#inputQueueControls,.input-queue-status').count(),0,'paused empty queue creates no visible status UI');
  assert.equal(await quiet.locator('#managerInputQueueNotice').isVisible(),false,'empty queue has no recovery notice');
  assert.equal(await quiet.locator('#sendButton').getAttribute('data-action'),'send','nothing to resume when queue is empty');
  const resumedBefore=requests.filter(r=>r.route.endsWith('/inputs/resume')).length;
  receipts.push({input_id:'quiet-input',client_message_id:'quiet-input',message_id:'quiet-message',sequence:1,status:'queued',run_id:null});
  history.push({message_id:'quiet-message',role:'user',content:'仍需继续的消息',payload:{client_message_id:'quiet-input'}});
  await quiet.getByRole('button',{name:'继续处理消息',exact:true}).waitFor();
  assert.equal(await quiet.locator('#sendButton').innerText(),'','continuation uses the existing icon');
  await quiet.locator('#managerInputQueueNotice').waitFor();
  assert.equal(requests.filter(r=>r.route.endsWith('/inputs/resume')).length,resumedBefore,'no automatic continuation');
  await quiet.waitForTimeout(300);await quiet.getByRole('button',{name:'继续处理消息',exact:true}).click();
  await wait(()=>requests.filter(r=>r.route.endsWith('/inputs/resume')).length===resumedBefore+1);
  const screenshots=process.env.QUIET_CHAT_SCREENSHOTS;
  if(screenshots){
   fs.mkdirSync(screenshots,{recursive:true});
   if(fs.existsSync('/mnt/c/Windows/Fonts/msyh.ttc')){await quiet.addStyleTag({content:'@font-face{font-family:QuietChinese;src:url("'+origin+'/__quiet-font")}body,body *{font-family:QuietChinese,sans-serif!important}'});await quiet.evaluate(()=>document.fonts.ready);}
   await quiet.screenshot({path:path.join(screenshots,'desktop.png')});await quiet.setViewportSize({width:390,height:844});
   if(await quiet.evaluate(()=>document.getElementById('chatShell').classList.contains('sidebar-open')))await quiet.locator('#toggleSidebarButton').click();
   await quiet.screenshot({path:path.join(screenshots,'mobile.png')});
  }
  // Several durable receipts may share one execution. Keep individual user
  // messages, one subscription/answer, and leave later arrivals in the FIFO.
  await wait(()=>streams.has(activeRun));
  const priorQuietRun=activeRun;
  for(const text of ['合并请求一','合并请求二']){
   await quiet.locator('#questionInput').fill(text);await quiet.locator('#sendButton').click();
  }
  await wait(()=>history.some(m=>m.content==='合并请求二'));
  const batch=receipts.filter(r=>history.some(m=>m.message_id===r.message_id&&['合并请求一','合并请求二'].includes(m.content)));
  assert.equal(batch.length,2);assert.notEqual(batch[0].message_id,batch[1].message_id);
  receipts.find(r=>r.run_id===priorQuietRun).status='completed';runStatuses.set(priorQuietRun,'completed');
  activeRun='shared-batch';runStatuses.set(activeRun,'running');
  batch.forEach(r=>{r.run_id=activeRun;r.status='running';});finish(priorQuietRun,'completed','前一轮结束');
  await wait(()=>streams.has('shared-batch'));
  await quiet.waitForFunction(()=>['合并请求一','合并请求二'].every(text=>Array.from(document.querySelectorAll('.message.user')).some(m=>m.textContent.includes(text)&&m.dataset.inputStatus==='running')));
  assert.equal(requests.filter(r=>r.route==='/agent/runs/shared-batch/stream').length,1,'shared receipts open a single SSE');
  await quiet.locator('#questionInput').fill('运行中晚到的补充');await quiet.locator('#sendButton').click();
  await wait(()=>history.some(m=>m.content==='运行中晚到的补充'));
  const late=receipts.find(r=>history.some(m=>m.message_id===r.message_id&&m.content==='运行中晚到的补充'));
  assert.equal(late.run_id,null);assert.equal(late.status,'queued');
  batch.forEach(r=>{r.status='completed';});activeRun=null;runStatuses.set('shared-batch','completed');
  finish('shared-batch','completed','合并后的统一答复');
  await quiet.waitForFunction(()=>['合并请求一','合并请求二'].every(text=>Array.from(document.querySelectorAll('.message.user')).some(m=>m.textContent.includes(text)&&m.dataset.inputStatus==='completed')));
  await quiet.evaluate(()=>LkaChatContext.refreshConversation());
  assert.equal(await quiet.locator('.message.assistant').filter({hasText:'合并后的统一答复'}).count(),1);
  await quietContext.close();
  const batchContext=await browser.newContext(),batchPage=await batchContext.newPage();batchPage.on('pageerror',e=>errors.push(e.message));
  await batchPage.goto(origin+'/chat.html?mode=work&assistant=global&backend='+encodeURIComponent(origin));
  await batchPage.locator('#chatForm[data-input-mode=continuous]').waitFor();
  for(const text of ['合并请求一','合并请求二','运行中晚到的补充'])assert.equal(await batchPage.locator('.message.user').filter({hasText:text}).count(),1,'fresh history retains each original input');
  assert.equal(await batchPage.locator('.message.assistant').filter({hasText:'合并后的统一答复'}).count(),1,'fresh history keeps one batch answer');
  assert.equal(requests.filter(r=>r.route==='/agent/runs/shared-batch/stream').length,1,'completed batch does not reconnect from another cache');
  assert.deepEqual(errors,[]);console.log('PASS shared input batch + paused replacement + manager input queue: attachment FIFO, continuous sending, unchanged SSE, optimistic/durable reconciliation, next-root recovery, paused resume, stable retry, held failed sends, lost receipts, reload and ordinary gate');
 } finally { if(browser)await browser.close();for(const res of streams.values())res.destroy();await new Promise(r=>server.close(r)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
