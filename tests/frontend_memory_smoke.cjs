// Isolated browser smoke test for app/web/pet memory UI. No backend or user data.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const ROOT = process.env.FRONTEND_PET_ROOT || 'D:/agent-bot-frontend/app/web/pet';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.SMOKE_ARTIFACT_DIR || '/tmp/frontend-memory-smoke';
fs.mkdirSync(OUT, { recursive: true });
const requests = [];
const state = { memories: [], page: 0, jobs: [], revision: 3, lastPatch: null, tokenRequired: false, imports: 0,
  policies: { global: true, project: false }, projectId: 'project-demo', exportedPages: 0, fileEdits: [], configConflict: false };
const stamp = '2026-10-01T10:00:00+00:00';
function record(id, content, status='active', version=1, scope='global') {
  return { memory_id:id, content, status, version, scope, project_id:scope==='project'?'project-demo':null,
    memory_type:'preference', sensitivity:'normal', confidence:0.9, source_ids:['src-'+id], expires_at:null,
    supersedes_id:null, created_at:stamp, updated_at:stamp, metadata:{} };
}
state.memories = [record('mem-xss', '<img src=x onerror=alert(1)>'), record('mem-candidate','Please be concise','candidate')];
state.memories.push(...Array.from({length:50}, (_,i)=>record('mem-'+i,'Preference '+i)));
const exportRows=Array.from({length:501},(_,i)=>record('export-'+i,'Export '+i));
state.jobs = [ {job_id:'job-retry',kind:'memory_extract',status:'failed',scope_id:'session-demo',attempts:3,max_attempts:3,updated_at:stamp,error_class:'provider_timeout'},
 {job_id:'job-cancel',kind:'context_compact',status:'queued',scope_id:'session-demo',attempts:0,max_attempts:3,updated_at:stamp} ];
function send(res, code, data, headers={}) { res.writeHead(code, {'content-type':'application/json; charset=utf-8', ...headers}); res.end(typeof data==='string'?data:JSON.stringify(data)); }
const server = http.createServer((req,res) => {
  const parsed = new URL(req.url, 'http://localhost'); const p=parsed.pathname; let body='';
  if (req.method==='GET' && !p.startsWith('/memories') && p!=='/projects' && !p.startsWith('/projects/') && !p.startsWith('/background') && !p.startsWith('/agent/') && !p.startsWith('/sessions/') && !p.startsWith('/pet/')) {
    const rel=decodeURIComponent(p==='/' ? '/index.html' : p);
    const file=path.resolve(ROOT, '.'+rel);
    if (!file.startsWith(path.resolve(ROOT)+path.sep) && file!==path.resolve(ROOT)) {res.writeHead(403);return res.end('forbidden');}
    fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end('missing '+rel);return;}const ext=path.extname(file);res.writeHead(200,{'content-type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[ext]||'application/octet-stream'});res.end(data);});
    return;
  }
  req.on('data',x=>body+=x); req.on('end',()=>{
    if (p.startsWith('/pet/session-workspace')) { requests.push({path:p, blocked:true}); return send(res,599,{detail:'workspace route must not be used'}); }
    if (p.startsWith('/memories') || p.startsWith('/background') || p==='/agent/models') requests.push({path:p+parsed.search,method:req.method,auth:req.headers.authorization||'',body});
    if (state.tokenRequired && (p.startsWith('/memories') || p.startsWith('/background')) && req.headers.authorization!=='Bearer smoke-token') return send(res,401,{detail:'required'});
    if (req.method==='OPTIONS') return send(res,204,'');
    if (p==='/projects' && req.method==='POST') return send(res,201,{project_id:'project-demo',name:'Demo',workspace_path:'C:/fake/project',revision:1,session_count:1});
    if (p==='/sessions' && req.method==='POST') {
      const b=JSON.parse(body);assert.equal(b.project_id,'project-demo');
      return send(res,200,{session:{session_id:'project-session-created',title:'新会话',status:'active',project_id:b.project_id,workspace:{path:'C:/fake/project',backend_path:'/mnt/c/fake/project',platform:'windows'},metadata:{},created_at:stamp,updated_at:stamp},messages:[]});
    }
    if (p==='/agent/ui-defaults' && req.method==='GET') return send(res,200,{configured:false,defaults:{},updated_at:null});
    if (p==='/agent/models') return send(res,200,{default_client:'local',clients:[{name:'local',default_model:'m-base',models:['m-base','m-configured','m-dynamic'],source:'provider'}]});
    if (p==='/sessions/demo/context-status') return send(res,200,{active_compaction_jobs:{},token_estimate:9,token_budget:500,recent_message_count:1});
    if (p==='/memories' && req.method==='GET') {
      if(parsed.searchParams.get('scope')==='project') return send(res,200,{memories:[],next_offset:null});
      const offset=Number(parsed.searchParams.get('offset')||0), limit=Number(parsed.searchParams.get('limit')||50);
      return send(res,200,{memories:state.memories.slice(offset,offset+limit),next_offset:offset+limit<state.memories.length?offset+limit:null});
    }
    if (p==='/memories/export') { const offset=Number(parsed.searchParams.get('offset')||0); state.exportedPages++; const page=exportRows.slice(offset,offset+500); return send(res,200,{version:1,scope:'global',memories:page,next_offset:offset+500<exportRows.length?offset+500:null}); }
    if (p==='/memories/learning' && req.method==='GET') {const s=parsed.searchParams.get('scope')||'global';return send(res,200,{scope:s,project_id:s==='project'?state.projectId:null,enabled:state.policies[s]});}
    if (p==='/memories/learning' && req.method==='PUT') {const b=JSON.parse(body);state.policies[b.scope]=b.enabled;return send(res,200,{...b,project_id:b.scope==='project'?state.projectId:null});}
    if (p==='/memories' && req.method==='POST') {const b=JSON.parse(body);const r=record('mem-created',b.content,'active',1,b.scope);state.memories.unshift(r);return send(res,201,{...r,memory_file_status:'synced'});}
    const memMatch=p.match(/^\/memories\/([^/]+)$/);
    if (memMatch && req.method==='GET') {const m=state.memories.find(x=>x.memory_id===memMatch[1]);return m?send(res,200,m):send(res,404,{detail:'missing'});}
    if (memMatch && req.method==='PATCH') {const b=JSON.parse(body);state.lastPatch=b;const old=state.memories.find(x=>x.memory_id===memMatch[1]);if (old && (old.version!==b.expected_version || old.forceConflict)) return send(res,409,{detail:'version'});if(!old)return send(res,404,{});const n=record('mem-confirmed-new',b.content,'active',1,old.scope);n.supersedes_id=old.memory_id;state.memories=state.memories.filter(x=>x!==old);state.memories.unshift(n);return send(res,200,{...n,memory_file_status:'synced'});}
    if (memMatch && req.method==='DELETE') {const m=state.memories.find(x=>x.memory_id===memMatch[1]);if(!m)return send(res,404,{});m.status='retracted';return send(res,200,{...m,memory_file_status:'synced'});}
    if (/^\/memories\/[^/]+\/sources$/.test(p)) return send(res,200,{sources:[{source_type:'user_api',source_ref:'manual:test',status:'active',created_at:stamp}]});
    if (p==='/background/jobs' && req.method==='GET') return send(res,200,{jobs:state.jobs,last_memory_file_error:null});
    if (p==='/background/health') return send(res,200,{queue_depth_by_status:{queued:1,running:0,failed:1},llm_workloads:{last_24h:[],cost_pricing_configured:false}});
    const job=p.match(/^\/background\/jobs\/([^/]+)\/(retry|cancel)$/);
    if(job && req.method==='POST') {const j=state.jobs.find(x=>x.job_id===job[1]);const b=JSON.parse(body);if(!j || b.expected_updated_at!==j.updated_at)return send(res,409,{detail:'conflict'});j.status=job[2]==='retry'?'queued':'cancelled';j.updated_at='2026-10-02T10:00:00+00:00';return send(res,200,j);}
    if (p==='/background/config' && req.method==='GET') {const active={enabled:true,background_enabled:true,allow_remote_extraction:false,background_worker_count:2,max_recalled_items:8,max_recalled_chars:2400,extraction_debounce_seconds:5,max_job_tokens:32768,generation_output_tokens:4096,recovery_output_tokens:8192,background_client_name:null,background_model:null};const bg={request_timeout_seconds:30,max_pending_jobs:1024,max_llm_concurrency:4,interactive_reserved:2,memory_concurrency:1,io_concurrency:1,hourly_token_limit:200000,daily_token_limit:1000000,daily_cost_limit:0,input_cost_per_million:0,output_cost_per_million:0};return send(res,200,{revision:state.revision,active:{memory:active,background:bg},desired:{memory:active,background:bg},restart_required:true,pending_restart_fields:['memory.enabled'],overrides:{}});}
    if (p==='/background/config/schema') {const props={};Object.entries({enabled:'boolean',background_enabled:'boolean',allow_remote_extraction:'boolean',background_worker_count:'integer',max_recalled_items:'integer',max_recalled_chars:'integer',extraction_debounce_seconds:'number',max_job_tokens:'integer',generation_output_tokens:'integer',recovery_output_tokens:'integer',background_client_name:'string',background_model:'string'}).forEach(([k,v])=>props[k]={type:v,minimum:0,maximum:2000000});const bprops={};Object.entries({request_timeout_seconds:'number',max_pending_jobs:'integer',max_llm_concurrency:'integer',interactive_reserved:'integer',memory_concurrency:'integer',io_concurrency:'integer',hourly_token_limit:'integer',daily_token_limit:'integer',daily_cost_limit:'number',input_cost_per_million:'number',output_cost_per_million:'number'}).forEach(([k,v])=>bprops[k]={type:v,minimum:0,maximum:2000000});return send(res,200,{memory:{properties:props},background:{properties:bprops}});}
    if (p==='/background/config' && req.method==='PATCH') {const b=JSON.parse(body);if(state.configConflict){state.configConflict=false;state.revision++;return send(res,409,{detail:'settings_revision_conflict'});}if(b.expected_revision!==state.revision)return send(res,409,{detail:'settings_revision_conflict'});state.revision++;return send(res,200,{revision:state.revision,restart_required:true,pending_restart_fields:['memory.allow_remote_extraction']});}
    if(p==='/memories/file/preview') return send(res,200,{path:'/isolated/MEMORY.md',generated_hash:'h',current_hash:'h2',edits:state.fileEdits});
    if(p==='/memories/file/import' && req.method==='POST'){state.imports++;return send(res,200,{changed:[]});}
    if(p==='/memories/file' && req.method==='GET')return send(res,200,{path:'/isolated/MEMORY.md',content:'isolated file'});
    if(p==='/memories/file/generate' && req.method==='POST')return send(res,200,{path:'/isolated/MEMORY.md',status:'synced'});
    if(p==='/memories/projects/project-demo/relocate' && req.method==='POST') return send(res,200,{});
    if(p==='/background/events') {res.writeHead(200,{'content-type':'text/event-stream'});res.end(': keepalive\n\n');return;}
    send(res,404,{detail:'unmocked endpoint '+p});
  });
});
function waitFor(p, ms=6000){return p.waitForTimeout(ms);}
(async()=>{
  let browser, page;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,executablePath:CHROME,args:['--no-sandbox']});
    page=await browser.newPage({viewport:{width:1050,height:820}});
    await page.route('http://127.0.0.1:8765/**',async route=>{const u=new URL(route.request().url());const mocked=await route.fetch({url:base+u.pathname+u.search});await route.fulfill({response:mocked});});
    await page.addInitScript(()=>{localStorage.setItem('agentic-rag-pet-chat-sessions-v4',JSON.stringify([{id:'demo',conversation_id:'demo',title:'Demo',workspace:'C:/fake/project',created_at:Date.now(),updated_at:Date.now(),messages:[{role:'assistant',text:'hello'}]}]));localStorage.setItem('agentic-rag-pet-chat-active-session-v4','demo');});
    await page.goto(base+'/chat.html?backend=http%3A%2F%2F127.0.0.1%3A8765&mode=work&session_id=demo');
    await page.evaluate(()=>window.LkaChatContext && window.LkaChatContext.get());
    await page.waitForTimeout(500);
    await page.locator('#openMemoryQuickButton').click();
    await page.locator('#memoryList .memory-entry').first().waitFor();
    assert.equal(await page.locator('#memoryList .memory-entry').count(),50,'first page should show 50');
    await page.locator('#memoryMore').click(); await page.locator('#memoryList .memory-entry').last().waitFor();
    assert.equal(await page.locator('#memoryList .memory-entry').count(),52,'pagination should append remaining entries');
    assert.equal(await page.locator('#memoryList img').count(),0,'memory content must be escaped');
    await page.locator('#memoryList .memory-entry').nth(2).click(); await page.waitForTimeout(100);
    await page.screenshot({path:path.join(OUT,'entries.png'),fullPage:true});
    await page.locator('#memoryScope').selectOption('project');
    assert.equal(await page.locator('#memoryScope').inputValue(),'project');
    assert(requests.some(x=>x.path.includes('scope=project')&&x.path.includes('C%3A%2Ffake%2Fproject')),'project requests must carry workspace path');
    await page.locator('#memoryScope').selectOption('global');
    await page.locator('#memoryMore').evaluate(e=>e.hidden=false);
    // Select candidate, preserve candidate ID/version and PATCH to confirm into a new active ID.
    const cand=page.locator('#memoryList .memory-entry').filter({hasText:'Please be concise'}); await cand.click();
    await page.locator('#memoryEdit').click(); await page.locator('#memoryEditorSave').click();
    await page.waitForFunction(()=>document.querySelector('#memoryEditorOverlay').hidden);
    assert.equal(state.lastPatch.expected_version,1);assert.equal(state.lastPatch.content,'Please be concise');
    assert(!state.memories.some(x=>x.memory_id==='mem-candidate'),'confirmed candidate is replaced');
    // New memory creation then correction, retract.
    await page.locator('#memoryAdd').click(); await page.locator('#memoryEditorText').fill('Keep this smoke memory'); await page.locator('#memoryEditorSave').click();
    await page.waitForFunction(()=>document.querySelector('#memoryEditorOverlay').hidden);
    let created=state.memories.find(x=>x.memory_id==='mem-created');assert(created);
    await page.locator('#memorySearch').fill('Keep this smoke memory'); await page.locator('#memoryList .memory-entry').first().click();
    await page.locator('#memoryEdit').click(); await page.locator('#memoryEditorText').fill('Corrected smoke memory'); state.memories.find(x=>x.memory_id==='mem-created').forceConflict=true; await page.locator('#memoryEditorSave').click(); await page.waitForFunction(()=>document.querySelector('#memoryEditorError').textContent.length>0);
    assert.equal(await page.locator('#memoryEditorText').inputValue(),'Corrected smoke memory','409 must preserve editor draft'); assert.equal(await page.locator('#memoryEditorReload').isHidden(),false);
    state.memories.find(x=>x.memory_id==='mem-created').forceConflict=false; await page.locator('#memoryEditorSave').click(); await page.waitForFunction(()=>document.querySelector('#memoryEditorOverlay').hidden);
    assert(state.memories.some(x=>x.memory_id==='mem-confirmed-new'&&x.content==='Corrected smoke memory'));
    await page.locator('#memorySearch').fill('Corrected smoke memory'); await page.locator('#memoryList .memory-entry').first().click(); await page.locator('#memoryRetract').click(); await page.locator('#memoryRetractYes').click(); await page.waitForTimeout(300);
    assert.equal(state.memories.find(x=>x.memory_id==='mem-confirmed-new').status,'retracted');
    // Learning checkbox.
    await page.locator('#memoryLearningGlobal').check(); assert.equal(state.policies.global,true);
    await page.locator('#memoryLearningGlobal').uncheck(); await page.waitForTimeout(100); assert.equal(state.policies.global,false);
    // New project session must inherit project workspace; intercept all workspace calls.
    const before=await page.evaluate(()=>window.LkaChatContext.get());assert.equal(before.workspace,'C:/fake/project');
    await page.evaluate(()=>window.LkaChatContext.newProjectSession()); await page.waitForTimeout(200);
    const after=await page.evaluate(()=>window.LkaChatContext.get());assert.equal(after.workspace,'C:/fake/project');
    assert.equal(after.sessionId,'project-session-created','project shortcut must actually adopt the backend-created session');
    assert(!requests.some(r=>r.blocked),'frontend must not call /pet/session-workspace');
    // jobs controls & config advanced tab
    await page.locator('#memoryOverlay').evaluate(e=>e.hidden=false); await page.locator('[data-memory-tab="jobs"]').click(); await page.locator('[data-job-action="retry"]').click(); await page.waitForTimeout(100);assert.equal(state.jobs[0].status,'queued');
    await page.locator('[data-job-action="cancel"]').nth(1).click(); await page.waitForTimeout(100);assert.equal(state.jobs[1].status,'cancelled');
    await page.locator('[data-memory-tab="config"]').click(); await page.locator('#memoryBackgroundClient').waitFor();
    assert.equal(await page.locator('#memoryBackgroundModel option').count(),2,'provider source should restrict to configured/default model plus blank');
    await page.locator('[data-config="memory.allow_remote_extraction"]').check(); state.configConflict=true; await page.locator('#memoryConfigForm [type="submit"]').click(); await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-config="memory.allow_remote_extraction"]').isChecked(),true,'409 must preserve unsaved config edit');
    await page.locator('#memoryConfigReload').click(); await page.locator('#memoryBackgroundClient').waitFor();
    await page.locator('[data-config="memory.allow_remote_extraction"]').check(); await page.locator('#memoryConfigForm [type="submit"]').click(); await page.waitForTimeout(500);
    assert(state.revision===5,'settings revision increments after fresh load actual='+state.revision+' requests='+JSON.stringify(requests.filter(r=>r.path==='/background/config')));assert.equal(await page.locator('.memory-restart').count(),1);
    // page export follows all pages, file preview with >1 edit cannot import
    await page.locator('[data-memory-tab="files"]').click(); await page.locator('#memoryExport').click(); await page.waitForTimeout(250);assert(state.exportedPages>=2,'export must follow next_offset through multiple pages');
    state.fileEdits=[{memory_id:'mem-created',content:'single edit'}]; await page.locator('#memoryFilePreview').click(); await page.waitForTimeout(100);assert.equal(await page.locator('#memoryFileImport').isDisabled(),false);
    await page.locator('#memoryFileImport').click(); await page.waitForTimeout(100);assert.equal(state.imports,1);assert.equal(await page.locator('#memoryFileImport').isDisabled(),true,'successful import disables stale preview');
    state.fileEdits=[{memory_id:'a',content:'a new'},{memory_id:'b',content:'b new'}]; await page.locator('#memoryFilePreview').click(); await page.waitForTimeout(100);assert.equal(await page.locator('#memoryFileImport').isDisabled(),true);assert.equal(state.imports,1);
    // Token 401 experience; input must not persist in URL or storage, request header must be used.
    state.tokenRequired=true; await page.locator('#memoryConnection summary').click(); await page.locator('#memoryTokenForm').locator('input').fill('smoke-token'); await page.locator('#memoryTokenForm button').click(); await page.waitForTimeout(100);
    await page.locator('[data-memory-tab="entries"]').click(); await page.waitForTimeout(200);
    assert(requests.some(r=>r.auth==='Bearer smoke-token'),'memory requests must send Bearer token');
    const stored=await page.evaluate(()=>JSON.stringify(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])));assert(!stored.includes('smoke-token'));
    await page.setViewportSize({width:430,height:680}); await page.screenshot({path:path.join(OUT,'mobile.png'),fullPage:true});
    assert(await page.locator('#memoryOverlay').evaluate(e=>getComputedStyle(e).position==='fixed'));
    const quick=await browser.newPage({viewport:{width:430,height:680}});
    await quick.addInitScript(()=>{localStorage.setItem('agentic-rag-pet-chat-sessions-v4',JSON.stringify([{id:'demo',conversation_id:'demo',title:'Demo',workspace:'C:/fake/project',created_at:Date.now(),updated_at:Date.now(),messages:[{role:'assistant',text:'hello'}]}]));localStorage.setItem('agentic-rag-pet-chat-active-session-v4','demo');});
    await quick.route('http://127.0.0.1:8765/**',async route=>{const u=new URL(route.request().url());const mocked=await route.fetch({url:base+u.pathname+u.search});await route.fulfill({response:mocked});});
    await quick.goto(base+'/chat.html?backend=http%3A%2F%2F127.0.0.1%3A8765&mode=quick&session_id=demo');await quick.locator('#openMemoryQuickButton').click();await quick.locator('#memoryList').waitFor();await quick.waitForTimeout(700);
    assert((await quick.locator('#memoryStatus').innerText()).length>0,'quick memory overlay should finish its initial load');
    assert.equal(await quick.locator('body').evaluate(e=>e.classList.contains('work-mode')),false,'quick layout must run outside work mode');
    await quick.screenshot({path:path.join(OUT,'quick-430x680.png'),fullPage:true});
    // A 404 from an older backend is rendered as graceful compatibility text.
    state.tokenRequired=false;
    await page.route('**/background/config',route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({detail:'not found'})}));
    await page.locator('[data-memory-tab="config"]').click(); await page.waitForTimeout(100);assert((await page.locator('#memoryStatus').innerText()).includes('新版记忆模块'));
    // Desktop bridge path uses the same method/path/body/token contract as fetch.
    await page.evaluate(()=>{window.__bridgePayloads=[];window.petBridge={requestMemory(raw){const p=JSON.parse(raw);window.__bridgePayloads.push(p);window.__lkaMemoryBridgeReceive(p.id,200,'{"memories":[],"next_offset":null}')}}});
    await page.locator('[data-memory-tab="entries"]').click(); await page.waitForTimeout(100);
    const bridge=await page.evaluate(()=>window.__bridgePayloads);
    assert(bridge.some(p=>p.method==='GET'&&p.path.startsWith('/memories?')&&p.token==='smoke-token'));
    console.log(JSON.stringify({result:'PASS', requests:requests.length, screenshots:[path.join(OUT,'entries.png'),path.join(OUT,'mobile.png'),path.join(OUT,'quick-430x680.png')],checks:['pagination','scope','XSS','candidate PATCH confirmation','create/edit/retract','409 draft preservation','learning','new project workspace preservation','job retry/cancel CAS','config revision/model filter and 409 preservation','multi-page export','single/multi MEMORY import guard','token header/no storage','quick 430x680 layout','404 compatibility','bridge method/path/body/token semantics']},null,2));
  } catch (e) { console.error(e.stack||e);process.exitCode=1; }
  finally {if(browser)await browser.close();server.close();}
})();
