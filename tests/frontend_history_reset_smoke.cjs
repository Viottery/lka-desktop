'use strict';
// Local synthetic backend only; no personal services or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = path.resolve(__dirname, '../app/web/pet');
const stamp = new Date().toISOString(), requests = [], errors = [], streams = new Map();
let historyResetAt = '', heldHistory;
let activeRun = null, paused = false, holdPost, holdUpload, holdGet, probeFailures = 0, resumeRun = 3, failNext = false, dropNext = false;
const runStatuses = new Map([['root-1', 'running']]);
let receipts = [{ input_id:'i0', client_message_id:'initial', message_id:'m0', sequence:1, status:'running', run_id:'root-1' }];
let history = [{ message_id:'m0', role:'user', content:'原来的任务', payload:{client_message_id:'initial'} }];
const ordinaryHistory = [{message_id:'ordinary-answer',role:'agent',content:'普通会话已有回答',payload:{}}];
function detail(id = 'manager-queue', kind = 'manager') { return {session:{session_id:id,kind,title:'合成会话',created_at:stamp,updated_at:stamp,metadata:{source_frontend:'windows-pet',history_reset_at:historyResetAt},workspace:null},messages:kind === 'manager' ? history : ordinaryHistory}; }
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
 if(route.endsWith('/runs'))return json(res,200,{session_id:route.split('/')[2],runs:activeRun?[{run_id:activeRun,parent_run_id:null,status:runStatuses.get(activeRun)||'running',created_at:stamp}]:[],next_offset:null});
 if(route==='/sessions/manager-queue'){if(heldHistory){const saved=JSON.parse(JSON.stringify(detail()));const hold=heldHistory;heldHistory=null;hold.release=()=>json(res,200,saved);return;}return json(res,200,detail());}
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
  receipts[0].status='completed';
  history.push({message_id:'kept-answer',role:'agent',content:'应保留的完成回复',payload:{}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/tmp/lka-playwright-browsers/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']});
  const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const url=origin+'/chat.html?mode=work&assistant=global&backend='+encodeURIComponent(origin);
  await page.goto(url);await page.locator('#chatForm[data-input-mode=continuous]').waitFor();
  failNext=true;await page.locator('#questionInput').fill('待撤回的未知提交');await page.locator('#sendButton').click();
  await page.locator('.message.user[data-input-status=submission_failed]').waitFor();
  await page.locator('#questionInput').fill('独立的新草稿');
  // An unmarked sync keeps the failed local message, as before.
  await page.evaluate(()=>LkaChatContext.refreshConversation());
  assert.equal(await page.locator('.message.user').filter({hasText:'待撤回的未知提交'}).count(),1);
  const posted=requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').length;
  // Keep a pre-reset history response in flight while a newer snapshot arrives.
  const stale={};heldHistory=stale;
  await page.evaluate(()=>{window.staleRefresh=LkaChatContext.refreshConversation();});await wait(()=>stale.release);
  historyResetAt=new Date(Date.now()+1000).toISOString();
  await page.evaluate(detail=>LkaChatContext.acceptSession(detail),detail());
  assert.equal(await page.locator('.message.user').filter({hasText:'待撤回的未知提交'}).count(),0);
  assert.equal(await page.locator('.message.assistant').filter({hasText:'应保留的完成回复'}).count(),1);
  stale.release();await page.evaluate(()=>window.staleRefresh);
  assert.equal(await page.locator('.message.user').filter({hasText:'待撤回的未知提交'}).count(),0,'stale history cannot revive removed input');
  assert.equal(await page.locator('#questionInput').inputValue(),'独立的新草稿');
  await page.reload();await page.locator('#chatForm[data-input-mode=continuous]').waitFor();
  assert.equal(await page.locator('.message.user').filter({hasText:'待撤回的未知提交'}).count(),0,'reset survives localStorage reload');
  assert.equal(await page.locator('#questionInput').inputValue(),'独立的新草稿');
  assert.equal(requests.filter(r=>r.route.endsWith('/inputs')&&r.method==='POST').length,posted,'unknown old POST is never automatically retried');
  // Reset a live subscription as well: old cursor and transient answer cannot
  // reconnect after reload, and later discovery uses the current queue state.
  activeRun='root-1';receipts[0].status='running';receipts[0].run_id=activeRun;
  await wait(()=>streams.has('root-1'));
  event('root-1','llm_delta',{display_target:'assistant_answer',delta:'待撤回的流式回答'});
  await page.locator('#messages').filter({hasText:'待撤回的流式回答'}).waitFor();
  activeRun=null;receipts[0].status='completed';runStatuses.set('root-1','completed');
  historyResetAt=new Date(Date.now()+1500).toISOString();
  await page.evaluate(()=>LkaChatContext.refreshConversation());
  assert.equal(await page.locator('#messages').filter({hasText:'待撤回的流式回答'}).count(),0);
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.includes('run-cursor-')).length),0);
  const oldSubscriptions=requests.filter(r=>r.route==='/agent/runs/root-1/stream').length;
  await page.reload();await page.locator('#chatForm[data-input-mode=continuous]').waitFor();
  assert.equal(requests.filter(r=>r.route==='/agent/runs/root-1/stream').length,oldSubscriptions,'old run does not reconnect');
  // A second reset can clear all durable history, and stale marker snapshots
  // cannot replace it even via generic session synchronization.
  const oldDetail=detail();history=[];receipts=[];historyResetAt=new Date(Date.now()+2000).toISOString();
  await page.evaluate(()=>LkaChatContext.refreshConversation());
  assert.equal(await page.locator('.message.assistant').filter({hasText:'应保留的完成回复'}).count(),0,'empty backend history also resets cache');
  await page.evaluate(detail=>LkaChatContext.acceptSession(detail),oldDetail);
  assert.equal(await page.locator('.message.assistant').filter({hasText:'应保留的完成回复'}).count(),0,'older marker rejected by generic merge');
  await page.reload();await page.locator('#chatForm[data-input-mode=continuous]').waitFor();
  assert.equal(await page.locator('.message.assistant').filter({hasText:'应保留的完成回复'}).count(),0);
  assert.deepEqual(errors,[]);console.log('PASS history reset: optimistic cache removal, completed reply/draft preservation, stale GET/marker rejection, empty history, reload, no automatic resend');
 } finally {if(browser)await browser.close();for(const res of streams.values())res.destroy();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
