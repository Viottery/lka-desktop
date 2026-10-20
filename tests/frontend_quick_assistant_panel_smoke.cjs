'use strict';
// Synthetic panel/API fixture; real quick session lifecycle is tested separately.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const ROOT=path.resolve(__dirname,'../app/web/pet'),requests=[],errors=[];
let revision=1,status='paused',conflict=true,needsAnswer=true;
const state=()=>({session:{session_id:'manager_fixture',kind:'manager'},controller:{default_execution_workspace:{path:'/synthetic/tasks',platform:'linux',backend_path:'/synthetic/tasks'},session_id:'manager_fixture',revision,status}});
const json=(res,s,v)=>{res.writeHead(s,{'content-type':'application/json'});res.end(JSON.stringify(v));};
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://fixture');
 if(u.pathname==='/panel.html') {res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end('<body class="quick-mode"><main class="chat-main"><div id="messages"></div><button id="openGlobalAssistantQuick">真理</button></main><script>window.view={kind:"manager",sessionId:"manager_fixture"};window.refreshes=0;window.homes=0;window.LkaChatContext={get:()=>view,assistantState:()=>({loading:false,manager:'+JSON.stringify(state())+'}),refreshConversation:async()=>{refreshes++;return true},openAssistant:async()=>{homes++;return '+JSON.stringify(state())+'}};window.LkaMatterHost={backend:location.origin,request:async(p,m,b)=>{const r=await fetch(p,{method:m||"GET",body:b?JSON.stringify(b):undefined});const d=await r.json();if(!r.ok){let e=new Error("synthetic");e.status=r.status;e.detail=d.detail;throw e;}return d;}};</script><script src="/quick-assistant.js"></script>');}
 if(u.pathname==='/quick-assistant.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(fs.readFileSync(path.join(ROOT,'quick-assistant.js')));}
 let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};requests.push({path:u.pathname,query:u.search,method:req.method,body});
 if(u.pathname==='/managers/manager_fixture'){
  if(req.method==='PATCH'){if(conflict){conflict=false;revision++;return json(res,409,{detail:'management_revision_conflict'});}assert.equal(body.expected_revision,revision);status=body.status;revision++;}
  return json(res,200,state());
 }
 if(u.pathname.endsWith('/events'))return json(res,200,{events:Number(u.searchParams.get('after')||0)===0?[{event_id:1,kind:'timer',payload:{task_waiting:true,run_id:'run_fixture',status:'waiting_user'}}]:[],next_after:null});
 if(u.pathname.endsWith('/deliveries'))return json(res,200,{deliveries:Number(u.searchParams.get('after')||0)===0?[{cursor:1,run_id:'delivery_run'}]:[],next_after:null});
 if(u.pathname==='/agent/runs/run_fixture')return json(res,200,{run_id:'run_fixture',session_id:'task_fixture',parent_run_id:null,status:needsAnswer?'waiting_user':'completed'});
 return json(res,404,{detail:'missing'});
});
(async()=>{let browser;try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox']});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/panel.html');
 await page.locator('#quickAssistantAttention:not([hidden])').waitFor();assert.equal(await page.locator('#qaMode').innerText(),'对话与跟进','late-installed panel replays latest manager state');
 await page.waitForFunction(()=>refreshes>0);await page.locator('#qaManage').click();await page.getByText('管理状态已变化，请核对最新状态后重试。',{exact:true}).waitFor();
 assert.equal(requests.filter(r=>r.method==='PATCH').length,1);await page.locator('#qaManage').click();assert.equal(status,'active');await page.getByText('管理已启用',{exact:true}).waitFor();
 const popupPromise=page.waitForEvent('popup');await page.locator('#qaOpenTask').click();const popup=await popupPromise;await popup.waitForLoadState();assert.equal(new URL(popup.url()).searchParams.get('session_id'),'task_fixture');assert.equal(new URL(popup.url()).searchParams.get('run_id'),'run_fixture');await popup.close();
 needsAnswer=false;await page.evaluate(()=>dispatchEvent(new CustomEvent('lka-agent-turn-finished')));await page.locator('#quickAssistantAttention[hidden]').waitFor({state:'attached'});assert.ok(requests.some(r=>r.path.endsWith('/events')&&r.query.includes('after=1')));
 await page.evaluate(()=>{view={kind:'ordinary',sessionId:'ordinary_fixture'};dispatchEvent(new CustomEvent('lka-session-context'));});assert.equal(await page.locator('#qaMode').innerText(),'独立任务');assert.equal(await page.locator('#qaManage').isVisible(),false);
 await page.evaluate(()=>dispatchEvent(new CustomEvent('lka-quick-assistant-state',{detail:{loading:false,error:'助手未连接'}})));await page.locator('#qaRetry:not([hidden])').waitFor();assert.equal(await page.locator('#qaNotice').innerText(),'助手未连接');
 await page.locator('#qaRetry').click();assert.equal(await page.evaluate(()=>homes),1);assert.deepEqual(errors,[]);console.log('PASS quick assistant panel: late state replay, explicit CAS management, current waiting reminder, original task link, cursor, ordinary mode and retry');
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
