'use strict';
// Synthetic HTTP and browser only. No personal services, model requests or production settings.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const ROOT=path.resolve(__dirname,'../app/web/pet'),requests=[],errors=[],stamp=new Date().toISOString();
let revision=1,model='legacy-manager',client='alpha',conflict=false,rejectDefaults=false,holdPatch=null,holdNext=false;
let defaults={llm_client:'alpha',llm_model:'m1',safety_mode:'backend',stream:true,workspace_parent:''};
const manager={session_id:'manager-settings',kind:'manager',title:'真理',created_at:stamp,updated_at:stamp,metadata:{},workspace:null};
const ordinary={...manager,session_id:'ordinary-settings',kind:'ordinary',title:'独立任务',workspace:{path:'/synthetic/settings'}};
const state=()=>({session:manager,controller:{default_execution_workspace:{path:'/synthetic/tasks',platform:'linux',backend_path:'/synthetic/tasks'},session_id:manager.session_id,status:'paused',revision,llm_client_name:client,llm_model:model}});
function send(res,n,x){res.writeHead(n,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(x));}
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://fixture');if(!u.pathname.startsWith('/mock')&&u.pathname!=='/pet/session-workspace'){
  if(u.pathname==='/font'){res.writeHead(200,{'content-type':'font/collection'});return fs.createReadStream('/mnt/c/Windows/Fonts/msyh.ttc').pipe(res);}
  const f=path.resolve(ROOT,'.'+u.pathname.replace(/^\/desktop-pet/,''));if(f.startsWith(ROOT+path.sep)&&fs.existsSync(f)&&fs.statSync(f).isFile()){res.writeHead(200,{'content-type':f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});return fs.createReadStream(f).pipe(res);}return send(res,404,{});
 }
 let raw='';for await(const d of req)raw+=d;const b=raw?JSON.parse(raw):{},p=u.pathname.replace(/^\/mock/,'');requests.push({p,method:req.method,b});
 if(p==='/health')return send(res,200,{status:'ok'});
 if(p==='/agent/ui-defaults'){if(req.method==='PUT'){if(rejectDefaults)return send(res,503,{detail:'synthetic_failure'});defaults=b;}return send(res,200,{configured:true,defaults});}
 if(p==='/agent/models')return send(res,200,{clients:[{name:'alpha',models:['m1','m2'],default_model:'m1'}]});
 if(p==='/managers/default')return send(res,200,state());
 if(p==='/managers/manager-settings'){
  if(req.method==='PATCH'){
   if(conflict){conflict=false;revision++;return send(res,409,{detail:'management_revision_conflict'});}
   assert.equal(b.expected_revision,revision);assert(!('status'in b),'model save cannot enable management');
   const finish=()=>{client=b.llm_client_name;model=b.llm_model;revision++;send(res,200,state());};
   if(holdNext){holdNext=false;holdPatch=finish;return;}finish();return;
  }return send(res,200,state());
 }
 if(p.endsWith('/goals'))return send(res,200,{goals:[],next_offset:null});
 if(p.endsWith('/events'))return send(res,200,{events:[],next_after:null});
 if(p.endsWith('/deliveries'))return send(res,200,{deliveries:[],next_after:null});
 if(p.endsWith('/runs'))return send(res,200,{session_id:p.split('/')[2],runs:[],next_offset:null});
 if(p==='/sessions')return send(res,200,{sessions:[manager,ordinary],next_offset:null});
 if(p==='/sessions/deleted')return send(res,200,{sessions:[]});
 if(/^\/sessions\/[^/]+$/.test(p))return send(res,200,{session:p.endsWith('manager-settings')?manager:ordinary,messages:[]});
 if(p.endsWith('/workspace'))return send(res,200,{project_id:'synthetic-project'});
 if(p.endsWith('/files'))return send(res,200,{entries:[]});
 if(p==='/pet/session-workspace')return send(res,200,{path:'/synthetic/'+b.session_id});
 if(p==='/projects')return send(res,200,{projects:[]});
 if(p==='/agent/safety-reviews')return send(res,200,{reviews:[]});
 return send(res,404,{});
});
(async()=>{let browser;try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:460,height:680}});page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR:',e.message);});
 await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 await page.goto(origin+'/chat.html?mode=quick&assistant=quick&backend='+encodeURIComponent(origin+'/mock'));
 await page.waitForFunction(()=>LkaChatContext.get().kind==='manager'&&typeof LkaChatContext.quickSettings==='function').catch(async e=>{console.error(await page.evaluate(()=>({state:LkaChatContext.get(),assistant:LkaChatContext.assistantState(),settings:typeof LkaChatContext.quickSettings,status:document.getElementById('runStatus').textContent})));console.error(requests.map(r=>r.p));throw e;});
 await page.locator('#toggleSettingsButton').click();await page.waitForFunction(()=>!document.getElementById('qsApply').disabled);
 assert.equal(await page.locator('#quickSettings #qsScope').innerText(),'真理模型');
 assert.equal(await page.locator('#qsModel').inputValue(),JSON.stringify(['alpha','legacy-manager']));
 assert.equal(await page.locator('#openGlobalAssistantQuick').innerText(),'');assert.equal(await page.locator('#newQuickSessionButton').innerText(),'');
 assert.equal(await page.locator('#openGlobalAssistantQuick').getAttribute('aria-label'),'和真理聊聊');assert.equal(await page.locator('#newQuickSessionButton').getAttribute('aria-label'),'新任务');
 await page.locator('#qsModel').selectOption(JSON.stringify(['alpha','m1']));
 assert.equal(requests.filter(r=>r.method==='PATCH').length,0,'selecting does not apply');
 await page.locator('#qsApply').click();await page.locator('#qsStatus').filter({hasText:'已保存'}).waitFor();
 assert.equal(model,'m1');assert.equal(await page.evaluate(()=>LkaChatContext.assistantState().manager.controller.llm_model),'m1','identity bar uses the new controller revision immediately');assert.equal(requests.filter(r=>r.p==='/agent/ui-defaults'&&r.method==='PUT').length,0,'manager model never writes ordinary defaults');
 conflict=true;await page.locator('#qsModel').selectOption(JSON.stringify(['alpha','m2']));await page.locator('#qsApply').click();
 await page.locator('#qsStatus').filter({hasText:'其他窗口'}).waitFor();assert.equal(await page.locator('#qsModel').inputValue(),JSON.stringify(['alpha','m2']));
 const patchCount=requests.filter(r=>r.method==='PATCH').length;await page.waitForTimeout(150);assert.equal(requests.filter(r=>r.method==='PATCH').length,patchCount,'conflict never retries automatically');
 await page.locator('#qsApply').click();await page.locator('#qsStatus').filter({hasText:'已保存'}).waitFor();assert.equal(model,'m2');
 await page.locator('#qsModel').selectOption('');await page.locator('#qsApply').click();await page.locator('#qsStatus').filter({hasText:'已保存'}).waitFor();
 assert.equal(model,null);assert.equal(client,null,'default resets both manager fields');
 client='alpha';model=null;revision++;
 await page.evaluate(()=>LkaChatContext.refreshQuickSettings());
 assert.equal(await page.locator('#qsModel').inputValue(),JSON.stringify(['alpha','']),'provider-only default remains distinct from backend default');
 await page.locator('#qsModel').selectOption('');await page.locator('#qsApply').click();await page.locator('#qsStatus').filter({hasText:'已保存'}).waitFor();
 assert.equal(client,null,'backend default can clear a provider-only override');
 await page.locator('#qsSafety').selectOption('manual');await page.locator('#qsStream').uncheck();await page.locator('#qsApply').click();await page.locator('#qsStatus').filter({hasText:'已保存'}).waitFor();
 assert.equal(defaults.llm_model,'m1');assert.equal(defaults.safety_mode,'manual');assert.equal(defaults.stream,false);
 await page.keyboard.press('Escape');assert(await page.locator('#quickSettings').isHidden());assert.equal(await page.evaluate(()=>document.activeElement.id),'toggleSettingsButton');
 // Native UI consumes the exact same state and save functions; no second model logic.
 await page.evaluate(()=>{window.settingSnapshots=[];window.petBridge={setQuickSettingsState:raw=>settingSnapshots.push(JSON.parse(raw))};});
 await page.evaluate(()=>LkaChatContext.refreshQuickSettings());assert.equal(await page.evaluate(()=>settingSnapshots.at(-1).scopeLabel),'真理模型');
 const beforeRefresh=requests.filter(r=>r.p==='/agent/models').length;await page.evaluate(()=>LkaChatContext.refreshQuickSettings(true));assert(requests.filter(r=>r.p==='/agent/models').length>beforeRefresh);
 // A completed save in the old manager cannot overwrite a newly selected task.
 holdNext=true;await page.evaluate(()=>{window.oldSave=LkaChatContext.updateQuickSettings({modelValue:JSON.stringify(['alpha','m1'])});});
 for(let i=0;i<100&&!holdPatch;i++)await page.waitForTimeout(10);assert(holdPatch);
 await page.evaluate(()=>__petChatOpenFreshTask());await page.waitForFunction(()=>LkaChatContext.get().kind==='ordinary');holdPatch();await page.evaluate(()=>window.oldSave);
 assert.equal(await page.evaluate(()=>LkaChatContext.quickSettings().kind),'ordinary');assert.equal(await page.evaluate(()=>LkaChatContext.quickSettings().busy),false);
 await page.locator('#toggleSettingsButton').click();await page.waitForFunction(()=>!document.getElementById('qsApply').disabled);
 assert.equal(await page.locator('#qsScope').innerText(),'独立任务默认模型');assert.equal(await page.locator('#qsModel').inputValue(),JSON.stringify(['alpha','m1']));
 rejectDefaults=true;await page.locator('#qsModel').selectOption(JSON.stringify(['alpha','m2']));await page.locator('#qsSafety').selectOption('llm');await page.locator('#qsApply').click();
 await page.locator('#qsStatus.qs-error').waitFor();assert.equal(await page.locator('#qsModel').inputValue(),JSON.stringify(['alpha','m2']));
 rejectDefaults=false;await page.locator('#qsApply').click();await page.locator('#qsStatus').filter({hasText:'已保存'}).waitFor();assert.equal(defaults.llm_model,'m2');assert.equal(defaults.safety_mode,'llm');
 await page.setViewportSize({width:340,height:450});await page.addStyleTag({content:"@font-face{font-family:Smoke;src:url('/font')} .qs-panel{font-family:Smoke,sans-serif}"});await page.evaluate(()=>document.fonts.ready);
 assert(await page.evaluate(()=>{const p=document.getElementById('quickSettings'),b=p.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.bottom<=innerHeight&&p.scrollWidth<=p.clientWidth;}));
 await page.locator('#qsApply').scrollIntoViewIfNeeded();assert(await page.locator('#qsApply').isVisible());
 await page.screenshot({path:'/tmp/lka-quick-settings-browser.png'});
 assert(!requests.some(r=>r.p.startsWith('/agent/turn')),'settings never starts a task');assert.deepEqual(errors,[]);
 console.log('PASS quick settings: icon labels, manager-owned model/CAS/reset, ordinary defaults/retry, shared safety/stream, native snapshots, stale save isolation, keyboard and narrow viewport');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
