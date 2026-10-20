'use strict';
// Offline HTTP fixtures only. Never contacts personal services or models.
const assert = require('node:assert/strict'), http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = process.env.FRONTEND_PET_ROOT || path.resolve(__dirname, '../app/web/pet');
const FALLBACK = process.env.FRONTEND_PET_FALLBACK || '/mnt/d/lka-desktop/app/web/pet';
const OUT = process.env.SMOKE_ARTIFACT_DIR || '/tmp/lka-global-assistant-shots'; fs.mkdirSync(OUT, {recursive:true});
const requests = [], errors = [], stamp = new Date().toISOString();
let heldDefault = null, releaseHeldDefault = null, holdDefault = false;
let mode = 'ready', status = 'paused', revision = 1, conflict = false, waiting = true, crowded = false, replaced = false;
const session = { session_id:'manager_fixture',kind:'manager',title:'真理',status:'active',created_at:stamp,updated_at:stamp,metadata:{},workspace:null };
const response = () => ({session,controller:{default_execution_workspace:{path:'/synthetic/tasks',platform:'linux',backend_path:'/synthetic/tasks'},session_id:session.session_id,status,revision,llm_client_name:null,llm_model:null,created_at:stamp,updated_at:stamp}});
const ordinary = {session_id:'ordinary_fixture',kind:'ordinary',title:'原来的任务',status:'active',created_at:stamp,updated_at:stamp,metadata:{},workspace:{path:'/fixture/ordinary'}};
const send = (res,n,v) => {res.writeHead(n,{'content-type':'application/json'});res.end(JSON.stringify(v));};
const server = http.createServer((req,res) => {
 const u = new URL(req.url,'http://localhost');
 if (u.pathname === '/__smoke-font') { res.writeHead(200,{'content-type':'font/collection'}); return fs.createReadStream(process.env.SMOKE_FONT_PATH || (process.platform === 'win32' ? 'C:/Windows/Fonts/msyh.ttc' : '/mnt/c/Windows/Fonts/msyh.ttc')).pipe(res); }
 if (!u.pathname.startsWith('/mock') && u.pathname !== '/pet/session-workspace') {
  let relative = decodeURIComponent(u.pathname).replace(/^\/desktop-pet/,'');
  if (relative === '/') relative = '/chat.html';
  const file = [ROOT,FALLBACK].map(r => path.resolve(r,'.'+relative)).find(f=>[ROOT,FALLBACK].some(r=>f.startsWith(path.resolve(r)+path.sep))&&fs.existsSync(f));
  if (!file) {res.writeHead(404);return res.end();}
  res.writeHead(200,{'content-type':({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript'})[path.extname(file)]||'application/octet-stream'});return fs.createReadStream(file).pipe(res);
 }
 let text='';req.on('data',d=>text+=d);req.on('end',()=>{
  const body=text?JSON.parse(text):{}, p=u.pathname.replace(/^\/mock/,'');requests.push({path:p,query:u.search,method:req.method,body});
  if(p==='/health')return send(res,200,{status:'ok',service:'local-knowledge-agent-os'});
  if(p==='/agent/models')return send(res,200,{clients:[]});
  if(p==='/agent/ui-defaults')return send(res,200,{configured:true,defaults:{llm_client:'ordinary-provider',llm_model:'ordinary-model',stream:true}});
  if(p==='/agent/turn/stream'){res.writeHead(200,{'content-type':'text/event-stream'});return res.end('event: final_answer\ndata: {"payload":{"metadata":{"answer":"合成管理回复"}}}\n\nevent: run_completed\ndata: {}\n\n');}
  if(p==='/agent/safety-reviews')return send(res,200,{reviews:[]});
  if(p==='/sessions/deleted')return send(res,200,{sessions:[],next_offset:null});
  if(p==='/sessions')return send(res,200,{sessions:[session,ordinary],next_offset:null});
  if(p==='/sessions/manager_fixture'||p==='/sessions/manager_new')return send(res,200,{session:{...session,session_id:p.split('/').pop()},messages:[]});
  if(p==='/sessions/ordinary_fixture')return send(res,200,{session:ordinary,messages:[]});
  if(p.endsWith('/runs')&&p.startsWith('/sessions/'))return send(res,200,{session_id:p.split('/')[2],runs:[],next_offset:null});
  if(p.endsWith('/files'))return send(res,200,{entries:[],path:'',total:0});
  if(p==='/projects')return send(res,200,{projects:[],next_offset:null});
  if(p==='/openapi.json')return send(res,200,{paths:{}});
  if(p==='/managers/default'){
   if(holdDefault){releaseHeldDefault=()=>send(res,200,{...response(),session:{...session,session_id:'manager_new'},controller:{...response().controller,session_id:'manager_new'}});if(heldDefault)heldDefault();return;}
   if(mode==='disabled')return send(res,409,{detail:'management_disabled'});
   if(mode==='old')return send(res,404,{detail:'Not Found'});
   if(mode==='deleted'||mode==='native-deleted')return send(res,409,{detail:'default_manager_deleted'});
   if(mode==='raw-deleted')return send(res,409,{detail:'Default management session is unavailable; restore or explicitly replace it'});
   return send(res,200,replaced ? {...response(),session:{...session,session_id:'manager_new'},controller:{...response().controller,session_id:'manager_new'}} : response());
  }
  if(p==='/managers/manager_new')return send(res,200,{...response(),session:{...session,session_id:'manager_new'},controller:{...response().controller,session_id:'manager_new'}});
  if(p.startsWith('/managers/manager_new/'))return send(res,200,{goals:[],events:[],deliveries:[],next_offset:null,next_after:null});
  if(p==='/managers/manager_fixture'){
   if(req.method==='PATCH'){
    if(conflict){conflict=false;revision++;status='paused';return send(res,409,{detail:'management_revision_conflict'});}
    assert.equal(body.expected_revision,revision);status=body.status;revision++;
   }
   return send(res,200,response());
  }
  if(p==='/managers/manager_fixture/goals'){
   const offset=Number(u.searchParams.get('offset')||0);
   return send(res,200,{goals:offset===0?[{goal_id:'goal_fixture',objective:'持续跟进英语学习 <img src=x onerror=window.injected=1>',status:'active',matter_status:'done',revision:2,next_wake_at:stamp}]:[],next_offset:null});
  }
  if(p==='/managers/manager_fixture/events' && crowded){ const after=Number(u.searchParams.get('after')||0); return send(res,200,{events:Array.from({length:25},(_,i)=>({event_id:2+i,session_id:session.session_id,kind:'timer',payload:{task_waiting:true,run_id:'task_many_'+i,status:'waiting_confirmation'}})).filter(e=>e.event_id>after),next_after:null}); }
  if(p==='/managers/manager_fixture/events')return send(res,200,{events:Number(u.searchParams.get('after')||0)<1?[{event_id:1,session_id:session.session_id,kind:'timer',payload:{task_waiting:true,run_id:'task_fixture',status:'waiting_user',question_id:'question_fixture'}}]:[],next_after:null});
  if(p==='/managers/manager_fixture/deliveries')return send(res,200,{deliveries:Number(u.searchParams.get('after')||0)<1?[{cursor:1,delivery_id:'delivery_fixture',session_id:session.session_id,run_id:'delivery_run',created_at:stamp,message_id:'message_fixture'}]:[],next_after:null});
  if(p.startsWith('/agent/runs/task_many_'))return send(res,200,{run_id:p.split('/').pop(),session_id:ordinary.session_id,status:'waiting_confirmation',parent_run_id:null});
  if(p==='/agent/runs/task_fixture')return send(res,200,{run_id:'task_fixture',session_id:ordinary.session_id,status:waiting?'waiting_user':'completed',parent_run_id:null,pending_user_question:{question_id:'question_fixture',question:'每周计划投入多少小时？'}});
  if(p==='/pet/session-workspace')return send(res,200,{path:'/fixture/'+body.session_id});
  return send(res,404,{detail:'unhandled fixture '+p});
 });
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox']});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:960}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{const interval=window.setInterval;window.fixturePolls=[];window.setInterval=function(callback,delay){if(delay===8000){fixturePolls.push(callback);return interval(()=>{},delay);}return interval(callback,delay);};});
 // Switching the shared workbench retains each session's own draft.
 await page.goto(origin+'/chat.html?mode=work&session_id=ordinary_fixture&backend='+encodeURIComponent(origin+'/mock'));
 await page.waitForFunction(()=>window.LkaGlobalAssistant&&window.LkaChatContext);
 await page.addStyleTag({content:'@font-face{font-family:SmokeChinese;src:url(/__smoke-font)}body,.ga-workspace{font-family:SmokeChinese,sans-serif!important}'}); await page.evaluate(()=>document.fonts.ready);
 await page.waitForFunction(()=>document.querySelector('#gaUpdated').textContent.startsWith('更新于'));
 assert.equal(await page.evaluate(()=>LkaChatContext.get().sessionId),'ordinary_fixture','warm preparation preserves selected task');
 assert.equal(await page.evaluate(()=>LkaGlobalAssistant.isOpen()),false);
 assert.equal(await page.locator('#openGlobalAssistant strong').innerText(),'真理');
 assert.equal(requests.filter(r=>r.path==='/managers/default').length,1,'startup prepares exactly one default identity');
 const preparedDetails=requests.filter(r=>r.path==='/sessions/manager_fixture').length;
 assert.equal(preparedDetails,1,'startup bootstraps manager detail once');
 await page.locator('#questionInput').fill('普通任务未发送的草稿');
 const before=await page.evaluate(()=>({id:LkaChatContext.get().sessionId,draft:document.querySelector('#questionInput').value}));
 assert.equal(await page.locator('#sessionList [data-session-id="manager_fixture"]').count(),0);
 await page.locator('#openGlobalAssistant').click();
 await page.getByRole('link',{name:'打开原任务'}).waitFor();
 await page.waitForFunction(()=>LkaChatContext.get().kind==='manager'&&LkaChatContext.get().sessionId==='manager_fixture');
 assert.equal(await page.locator('iframe').count(),0);
 assert.equal(await page.locator('.ga-workspace[aria-modal],.ga-workspace[role="dialog"]').count(),0);
 assert.equal(await page.locator('#chatShell > aside.ga-workspace').count(),1);
 assert.equal(await page.locator('#openGlobalAssistant').getAttribute('aria-current'),'page');
 assert.equal(await page.locator('#chatShell[inert],.session-sidebar[inert]').count(),0);
 await page.locator('#gaToggle').click();assert.equal(status,'active');
 conflict=true;await page.locator('#gaToggle').click();await page.locator('#gaNotice').filter({hasText:'其他窗口'}).waitFor();assert.equal(await page.locator('#gaState').innerText(),'管理已暂停');
 await page.locator('#gaTab-goals').click();await page.getByText('持续跟进英语学习 <img', {exact:false}).waitFor();
 await page.getByText('事项已完成',{exact:true}).waitFor(); assert.equal(await page.locator('#gaRecords').innerText().then(t=>t.includes('下次跟进')),false);
 assert.equal(await page.locator('#gaRecords img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
 await page.getByRole('button',{name:'和真理讨论'}).click();
 await page.waitForFunction(()=>document.querySelector('#questionInput').value.includes('goal_fixture'));
 await page.locator('#gaRefresh').click();await page.waitForFunction(()=>!document.querySelector('#gaRefresh').disabled);
 assert.ok(requests.some(r=>r.path.endsWith('/events')&&r.query.includes('after=1')));
 assert.ok(requests.some(r=>r.path.endsWith('/deliveries')&&r.query.includes('after=1')));
 await page.locator('#gaTab-deliveries').click();const link=page.getByRole('link',{name:'查看本次对话记录'});assert.ok((await link.getAttribute('href')).includes('run_id=delivery_run'));
 waiting=false;await page.locator('#gaRefresh').click();await page.waitForFunction(()=>!document.querySelector('#gaRefresh').disabled);await page.locator('#gaTab-attention').click();await page.getByText('暂时不需要你处理').waitFor();
 // Repeated switches reuse identity, detail, root bootstrap and existing feed cursors.
 const managerDraft=await page.locator('#questionInput').inputValue();
 const bootstrapCount=()=>requests.filter(r=>r.path==='/managers/default'||r.path==='/sessions/manager_fixture'||r.path==='/sessions/manager_fixture/runs'||r.path==='/managers/manager_fixture'&&r.method==='GET').length;
 const beforeSwitches=bootstrapCount();
 for(let index=0;index<3;index++){
  await page.evaluate(()=>LkaChatContext.openSession('ordinary_fixture'));
  await page.waitForFunction(()=>LkaChatContext.get().sessionId==='ordinary_fixture'&&!LkaGlobalAssistant.isOpen());
  assert.equal(await page.locator('#questionInput').inputValue(),before.draft);
  assert.equal(await page.locator('#openGlobalAssistant').getAttribute('aria-current'),null);
  assert.equal(await page.locator('#chatShell').getAttribute('inert'),null);
  await page.locator('#openGlobalAssistant').click();
  await page.waitForFunction(()=>LkaChatContext.get().sessionId==='manager_fixture'&&LkaGlobalAssistant.isOpen());
  assert.equal(await page.locator('#questionInput').inputValue(),managerDraft);
  assert.equal(await page.locator('body.global-assistant-loading').count(),0,'warm entry needs no connecting screen');
 }
 assert.equal(bootstrapCount(),beforeSwitches,'switching does not reload default identity, session or root runs');
 await page.evaluate(()=>LkaChatContext.openSession('ordinary_fixture'));
 const pollResponse=page.waitForResponse(r=>r.url().includes('/manager_fixture/events?after=1'));
 await page.evaluate(()=>fixturePolls.forEach(callback=>callback())); await pollResponse;
 await page.waitForFunction(()=>!document.querySelector('#gaRefresh').disabled);
 assert.equal(await page.evaluate(()=>LkaChatContext.get().sessionId),'ordinary_fixture','background feed refresh preserves ordinary view');
 assert.equal(await page.locator('#questionInput').inputValue(),before.draft);
 await page.locator('#openGlobalAssistant').click();
 await page.waitForFunction(()=>LkaChatContext.get().sessionId==='manager_fixture');
 await page.locator('#questionInput').fill('合成验证'); await page.locator('#sendButton').click();
 await page.waitForFunction(()=>document.querySelector('#messages').textContent.includes('合成管理回复'));
 const turn=requests.find(r=>r.path==='/agent/turn/stream'); assert(turn); assert.equal(turn.body.session_id,'manager_fixture'); assert.equal(turn.body.llm.client_name,undefined); assert.equal(turn.body.llm.model,undefined);
 await page.locator('#questionInput').fill('帮我梳理这周的安排，先看看哪些事情需要我决定。');
 await page.locator('#gaTab-goals').click(); await page.screenshot({path:path.join(OUT,'global-desktop.png')});
 await page.setViewportSize({width:390,height:844});
 // The page sees the resize on its next frame; read panel state only after it has been applied.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 if(await page.locator('#toggleSidebarButton').getAttribute('aria-expanded')==='true')await page.locator('#toggleSidebarButton').click();
 await page.waitForFunction(()=>document.querySelector('#sessionSidebar').getBoundingClientRect().right<=0);
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.allSettled(document.getAnimations().map(animation=>animation.finished));});
 await page.screenshot({path:path.join(OUT,'global-mobile.png')});
 await page.locator('#toggleSettingsButton').click(); await page.locator('#gaTab-goals').waitFor({state:'visible'});
 await page.screenshot({path:path.join(OUT,'global-mobile-followup.png')});
 await page.locator('#toggleSettingsButton').click();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.setViewportSize({width:1440,height:960});
 assert.ok(!requests.some(r=>r.path.includes('manager_fixture/workspace')||r.path.includes('manager_fixture/files')||r.path==='/pet/session-workspace'&&r.body.session_id==='manager_fixture'));
 assert.ok(!requests.some(r=>r.path==='/sessions'&&r.method==='POST'));
 crowded=true; await page.locator('#gaRefresh').click(); await page.waitForFunction(()=>!document.querySelector('#gaRefresh').disabled); await page.locator('#gaTab-attention').click();
 await page.getByRole('button',{name:'继续核对等待提醒'}).waitFor(); assert.equal(await page.locator('#gaRecords .ga-record').count(),20);
 await page.getByRole('button',{name:'继续核对等待提醒'}).click(); await page.waitForFunction(()=>!document.querySelector('#gaRefresh').disabled); assert.equal(await page.locator('#gaRecords .ga-record').count(),25,'verified pending tasks survive batched checks');
 await page.setViewportSize({width:1440,height:960});
 replaced=true; await page.locator('#gaReconnect').click(); await page.waitForFunction(()=>LkaChatContext.get().sessionId==='manager_new'&&!document.body.classList.contains('global-assistant-loading'));
 await page.evaluate(()=>LkaChatContext.openSession('manager_fixture')); await page.waitForFunction(()=>LkaChatContext.get().sessionId==='manager_fixture');
 assert.equal(await page.locator('#questionInput').inputValue(),'帮我梳理这周的安排，先看看哪些事情需要我决定。'); replaced=false;
 // Background preparation survives view changes and is shared by later open requests.
 const heldPage=await browser.newPage({viewport:{width:1440,height:960}});heldPage.on('pageerror',e=>errors.push(e.message));
 const heldStarted=new Promise(resolve=>{heldDefault=resolve;}); holdDefault=true;
 const heldCount=requests.filter(r=>r.path==='/managers/default').length;
 await heldPage.goto(origin+'/chat.html?mode=work&session_id=ordinary_fixture&backend='+encodeURIComponent(origin+'/mock'));
 await heldStarted; await heldPage.waitForFunction(()=>LkaChatContext.get().sessionId==='ordinary_fixture');
 await heldPage.locator('#questionInput').fill('后台预连接期间的普通草稿');
 assert.equal(await heldPage.locator('body.global-assistant-loading').count(),0,'background preconnect does not block ordinary work');
 await heldPage.locator('#openGlobalAssistant').click();
 await heldPage.evaluate(()=>LkaChatContext.openSession('ordinary_fixture'));
 await heldPage.waitForFunction(()=>!document.body.classList.contains('global-assistant-loading'));
 await heldPage.locator('#openGlobalAssistant').click();
 assert.equal(requests.filter(r=>r.path==='/managers/default').length,heldCount+1,'all opens share the held startup preparation');
 holdDefault=false;releaseHeldDefault();
 await heldPage.waitForFunction(()=>LkaChatContext.get().sessionId==='manager_new'&&!document.body.classList.contains('global-assistant-loading'));
 await heldPage.locator('#questionInput').fill('真理独立草稿');
 await heldPage.evaluate(()=>LkaChatContext.openSession('ordinary_fixture'));
 assert.equal(await heldPage.locator('#questionInput').inputValue(),'后台预连接期间的普通草稿');
 await heldPage.close();
 const quick=await browser.newPage({viewport:{width:480,height:620}}); await quick.goto(origin+'/chat.html?mode=quick&backend='+encodeURIComponent(origin+'/mock')); await quick.waitForFunction(()=>window.LkaChatContext);
 await quick.locator('#openGlobalAssistantQuick').click(); await quick.waitForFunction(()=>LkaChatContext.get().kind==='manager');
 assert.equal(await quick.evaluate(()=>!!window.LkaGlobalAssistant),false,'quick entry uses its own shared-chat controller');
 assert.equal(await quick.locator('iframe').count(),0,'native-compatible quick assistant uses the main conversation'); await quick.close();
 for(const state of ['disabled','old','deleted','raw-deleted','native-deleted']){
  mode=state;const isolated=await browser.newPage({viewport:{width:1100,height:800}});isolated.on('pageerror',e=>errors.push(e.message));
  await isolated.goto(origin+'/chat.html?mode=work&assistant=global&backend='+encodeURIComponent(origin+'/mock'));
  if(state==='native-deleted'){
   // Native memory bridge forwards the backend's original detail without proxy normalization.
   await isolated.evaluate(()=>{window.petBridge={requestMemory:raw=>{const r=JSON.parse(raw);queueMicrotask(()=>__lkaMemoryBridgeReceive(r.id,409,JSON.stringify({detail:'Default management session is unavailable; restore or explicitly replace it'})));}};});
   await isolated.locator('#gaRetry').waitFor();await isolated.locator('#gaRetry').click();
  }
  await isolated.locator('#gaRetry').waitFor();assert.equal(await isolated.locator('iframe').count(),0); assert.equal(await isolated.locator('body.global-assistant-error').count(),1);
  await isolated.evaluate(()=>LkaChatContext.openSession('ordinary_fixture')); await isolated.waitForFunction(()=>!document.body.classList.contains('global-assistant-error')&&!document.body.classList.contains('global-assistant-loading'));
  const text=await isolated.locator('#gaConnectionText').innerText();assert.ok(text.includes(state==='disabled'?'尚未启用':state==='old'?'尚未提供':'已被删除'),text);
  await isolated.close();
 }
 mode='raw-deleted';const deletedQuick=await browser.newPage();
 await deletedQuick.goto(origin+'/chat.html?mode=quick&assistant=quick&backend='+encodeURIComponent(origin+'/mock'));
 await deletedQuick.waitForFunction(()=>LkaChatContext.assistantState().error);
 assert((await deletedQuick.locator('#runStatus').innerText()).includes('已被删除'));
 assert.equal(await deletedQuick.evaluate(()=>LkaChatContext.get().sessionId),'');
 assert(!requests.some(r=>r.method==='POST'&&r.path==='/sessions'),'no replacement ordinary session');
 await deletedQuick.close();
 mode='ready';const mobileLayout=await browser.newPage({viewport:{width:390,height:844}});mobileLayout.on('pageerror',e=>errors.push(e.message));
 await mobileLayout.goto(origin+'/chat.html?mode=work&layout=mobile&assistant=global&backend='+encodeURIComponent(origin+'/mock'));
 await mobileLayout.waitForFunction(()=>LkaChatContext.get().kind==='manager'&&!document.body.classList.contains('global-assistant-loading'));
 await mobileLayout.locator('#toggleSettingsButton').click();
 await mobileLayout.locator('#globalAssistantFollowup').waitFor({state:'visible'});
 const mobileBounds=await mobileLayout.locator('#globalAssistantFollowup').boundingBox();assert(mobileBounds.x>=0&&mobileBounds.x+mobileBounds.width<=391,'mobile layout follow-up drawer fits viewport');
 assert.equal(await mobileLayout.locator('iframe').count(),0);await mobileLayout.close();
 assert.deepEqual(errors,[]);console.log('Global assistant browser PASS; '+requests.length+' synthetic requests; screenshots '+OUT);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
