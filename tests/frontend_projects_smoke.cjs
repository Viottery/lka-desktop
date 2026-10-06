// Isolated Chrome smoke test for the project picker. All API calls are mocked.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const ROOT = process.env.FRONTEND_PET_ROOT || 'D:/agent-bot-frontend/app/web/pet';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.SMOKE_ARTIFACT_DIR || '/tmp/frontend-projects-smoke';
fs.mkdirSync(OUT, { recursive: true });

const requests = [];
const blockedRoutes = [];
const stamp = '2026-10-02T10:00:00+00:00';
const state = {
  projects: Array.from({length: 53}, (_, i) => ({
    project_id: `project-${i}`, name: i === 0 ? '<img src=x onerror=alert(1)>' : `Project ${String(i).padStart(2,'0')}`,
    revision: 1, workspace_path: `C:/isolated/project-${i}`, session_count: 3,
    created_at: stamp, updated_at: stamp,
  })),
  selected: null, projectPageCalls: 0, sessionPageCalls: 0, patchConflict: true,
  lastPatch: null, lastCreate: null, sessions: [], createdId: 0, gateCreate: false,
  allowWorkspaceBinding: false, lastWorkspaceBinding: null,
};

function send(res, code, data, headers={}) {
  res.writeHead(code, {'content-type':'application/json; charset=utf-8', ...headers});
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}
function filterProjects(q) {
  if (!q) return state.projects;
  // Match the API's literal substring search, including % and _.
  return state.projects.filter(p => `${p.name} ${p.project_id}`.toLowerCase().includes(q.toLowerCase()));
}

const server = http.createServer((req,res) => {
  const parsed = new URL(req.url, 'http://localhost'); const p = parsed.pathname; let body='';
  if (p === '/pet/session-workspace' || (/^\/sessions\/[^/]+\/workspace$/.test(p) && !state.allowWorkspaceBinding)) {
    blockedRoutes.push({path:p,method:req.method});
    req.resume(); return send(res,599,{detail:'legacy workspace binding is forbidden in this test'});
  }
  if (req.method === 'GET' && p !== '/projects' && !p.startsWith('/projects/') && p !== '/sessions' && !p.startsWith('/sessions/') && !p.startsWith('/agent/') && !p.startsWith('/pet/') && !p.startsWith('/background/')) {
    const rel = decodeURIComponent(p === '/' ? '/index.html' : p);
    const file = path.resolve(ROOT, '.' + rel);
    if (!file.startsWith(path.resolve(ROOT)+path.sep) && file !== path.resolve(ROOT)) {res.writeHead(403); return res.end('forbidden');}
    fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('missing '+rel);}const ext=path.extname(file);res.writeHead(200,{'content-type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[ext]||'application/octet-stream'});res.end(data);});
    return;
  }
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    if (p.startsWith('/projects') || p === '/sessions' || /^\/sessions\/[^/]+\/workspace$/.test(p)) requests.push({path:p+parsed.search,method:req.method,auth:req.headers.authorization||'',body});
    if (req.method === 'OPTIONS') return send(res,204,'');
    if (p === '/agent/ui-defaults' && req.method === 'GET') return send(res,200,{configured:false,defaults:{},updated_at:null});
    if (p === '/sessions' && req.method === 'GET') return send(res,200,{sessions:state.sessions.filter(x=>x.status!=='deleted')});
    if (/^\/sessions\/[^/]+\/workspace$/.test(p) && req.method === 'PUT') {
      state.lastWorkspaceBinding=JSON.parse(body);
      return send(res,200,{session_id:p.split('/')[2],workspace:{path:state.lastWorkspaceBinding.path,platform:'windows',backend_path:'C:/isolated/backend-new'},project_id:'new-project'});
    }
    if (p === '/projects' && req.method === 'GET') {
      state.projectPageCalls++;
      const all = filterProjects(parsed.searchParams.get('q') || '');
      const offset = Number(parsed.searchParams.get('offset') || 0), limit = Number(parsed.searchParams.get('limit') || 50);
      return send(res,200,{projects:all.slice(offset,offset+limit),next_offset:offset+limit<all.length?offset+limit:null});
    }
    if (p === '/projects' && req.method === 'POST') {
      const b=JSON.parse(body); const existing=state.projects.find(x=>x.workspace_path===b.path);
      if(existing) return send(res,200,existing);
      const profile={project_id:'project-new',name:b.name||'isolated',revision:1,workspace_path:b.path,session_count:0,created_at:stamp,updated_at:stamp};
      state.projects.unshift(profile);return send(res,201,profile);
    }
    const detail=p.match(/^\/projects\/([^/]+)$/);
    if(detail && req.method==='GET') {const found=state.projects.find(x=>x.project_id===detail[1]);return found?send(res,200,found):send(res,404,{detail:'project not found'});}
    if(detail && req.method==='PATCH') {
      const b=JSON.parse(body);state.lastPatch={path:p,body:b};
      const found=state.projects.find(x=>x.project_id===detail[1]);if(!found)return send(res,404,{});
      if(state.patchConflict){state.patchConflict=false;found.name='Concurrent latest';found.revision++;return send(res,409,{detail:'project_revision_conflict'});}
      if(b.expected_revision!==found.revision)return send(res,409,{detail:'project_revision_conflict'});
      found.name=b.name;found.revision++;found.updated_at=stamp;return send(res,200,found);
    }
    const projectSessions=p.match(/^\/projects\/([^/]+)\/sessions$/);
    if(projectSessions && req.method==='GET') {
      state.sessionPageCalls++;
      const offset=Number(parsed.searchParams.get('offset')||0),limit=Number(parsed.searchParams.get('limit')||50);
      const live=state.sessions.filter(x=>x.project_id===projectSessions[1]&&x.status!=='deleted');
      return send(res,200,{sessions:live.slice(offset,offset+limit)});
    }
    if(p==='/sessions' && req.method==='POST') {
      const b=JSON.parse(body);state.lastCreate=b;
      if(state.gateCreate){state.gateCreate=false;return send(res,409,{detail:'session busy'});}
      const project=state.projects.find(x=>x.project_id===b.project_id);if(!project)return send(res,404,{detail:'project not found'});
      const session={session_id:`session-created-${++state.createdId}`,title:b.title||'New session',status:'active',metadata:{project_id:b.project_id},project_id:b.project_id,
        workspace:{path:project.workspace_path,platform:'windows',backend_path:'/isolated/project'},created_at:stamp,updated_at:stamp};
      state.sessions.unshift(session);return send(res,200,{session,messages:[]});
    }
    return send(res,404,{detail:'unmocked endpoint '+req.method+' '+p});
  });
});

(async()=>{
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,executablePath:CHROME,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    page.on('pageerror',e=>console.error('PAGEERROR',e.message));
    page.on('console',m=>{if(m.type()==='error')console.error('CONSOLE',m.text());});
    await page.route('http://127.0.0.1:8765/**',async route=>{const u=new URL(route.request().url());const mock=await route.fetch({url:base+u.pathname+u.search});await route.fulfill({response:mock});});
    await page.addInitScript(()=>{
      localStorage.setItem('agentic-rag-pet-chat-sessions-v4',JSON.stringify([{id:'demo',conversation_id:'demo',title:'Demo',workspace:'C:/fake/current',created_at:Date.now(),updated_at:Date.now(),messages:[{role:'assistant',text:'hello'}]}]));
      localStorage.setItem('agentic-rag-pet-chat-active-session-v4','demo');
    });
    await page.goto('http://127.0.0.1:8765/chat.html?backend=http%3A%2F%2F127.0.0.1%3A8765&mode=work&session_id=demo');
    await page.evaluate(()=>window.LkaChatContext&&window.LkaChatContext.get());
    assert(await page.evaluate(()=>!!window.LkaProjects),'project UI script should load');
    await page.locator('#openProjectsButton').click();
    await page.locator('#projectsOverlay').waitFor();
    await page.locator('#projectList [data-project-id]').first().waitFor();
    assert.equal(await page.locator('#projectList [data-project-id]').count(),50,'first project page uses backend page size');
    assert.equal(await page.locator('#projectList img').count(),0,'project names are rendered as text');
    await page.locator('#projectMore').click();
    await page.waitForFunction(()=>document.querySelectorAll('#projectList [data-project-id]').length===53);
    assert(requests.some(x=>x.path.startsWith('/projects?')&&x.path.includes('offset=50')),'project next_offset should be followed');

    // Search treats user input literally and HTML-like values stay escaped.
    await page.locator('#projectSearch').fill('%');
    await page.waitForTimeout(350);
    assert.equal(await page.locator('#projectList [data-project-id]').count(),0,'% is a literal substring');
    await page.locator('#projectSearch').fill('<img');
    await page.waitForTimeout(350);
    assert.equal(await page.locator('#projectList img').count(),0,'search result text cannot create markup');
    await page.locator('#projectSearch').fill('');
    await page.waitForTimeout(350);

    // Register same path twice: existing display name wins on the second request.
    await page.locator('#projectRegisterToggle').click();
    await page.locator('#projectRegisterName').fill('Smoke registered');
    await page.locator('#projectRegisterPath').fill('C:/isolated/register-me');
    await page.locator('#projectRegisterPlatform').selectOption('windows');
    await page.locator('#projectRegisterForm').locator('[type=submit]').click();
    await page.waitForTimeout(150);
    const registrations=requests.filter(x=>x.path==='/projects'&&x.method==='POST');
    assert.equal(registrations.length,1);
    assert.equal(JSON.parse(registrations[0].body).name,'Smoke registered');
    await page.locator('#projectRegisterToggle').click();
    await page.locator('#projectRegisterName').fill('Must not overwrite');
    await page.locator('#projectRegisterForm').locator('[type=submit]').click();
    await page.waitForTimeout(150);
    assert.equal(requests.filter(x=>x.path==='/projects'&&x.method==='POST').length,2);
    assert.equal(await page.locator('#projectDetail h3').first().innerText(),'Smoke registered','duplicate registration retains the original display name');

    // Select detail; 409 keeps the draft until explicit reload, then a fresh revision submits.
    await page.locator('#projectList [data-project-id="project-0"]').click();
    await page.locator('#projectRenameName').waitFor();
    await page.locator('#projectRenameName').fill('Draft survives conflict');
    await page.locator('#projectRenameForm').locator('[type=submit]').click();
    await page.waitForFunction(()=>!document.querySelector('#projectRenameReload').hidden);
    assert.equal(await page.locator('#projectRenameName').inputValue(),'Draft survives conflict');
    assert.equal(state.lastPatch.body.expected_revision,1);
    await page.locator('#projectRenameReload').click();
    await page.waitForFunction(()=>document.querySelector('#projectRenameStatus').textContent.includes('Concurrent latest'));
    assert.equal(await page.locator('#projectRenameName').inputValue(),'Draft survives conflict','reload updates the revision while retaining the user draft');
    await page.locator('#projectRenameName').fill('Renamed smoke project');
    await page.locator('#projectRenameForm').locator('[type=submit]').click();
    await page.waitForFunction(()=>{
      const row=document.querySelector('#projectList [data-project-id="project-0"]');
      return !!row && row.textContent.includes('Renamed smoke project');
    });
    assert.equal(state.lastPatch.body.expected_revision,2,'reload response supplies current revision');

    // Sessions paginate by `limit`: endpoint deliberately has no next_offset.
    const pid='project-0';
    state.sessions=Array.from({length:52},(_,i)=>({session_id:`ps-${i}`,title:`Session ${i}`,status:i===3?'deleted':'active',project_id:pid,metadata:{},workspace:null,created_at:stamp,updated_at:stamp}));
    await page.locator('#projectRefresh').click();
    await page.locator('[data-project-session]').first().waitFor();
    assert.equal(await page.locator('[data-project-session]').count(),50,'session list initially loads one page');
    assert.equal(await page.locator('[data-project-session="ps-3"]').count(),0,'deleted sessions stay out of project list');
    await page.locator('#projectSessionMore').click();
    await page.waitForFunction(()=>document.querySelectorAll('[data-project-session]').length===51);
    assert(requests.some(x=>x.path.includes('/projects/project-0/sessions?')&&x.path.includes('offset=50')),'session paging infers continuation from a full page');
    await page.evaluate(()=>{const content=document.querySelector('#projectsOverlay .memory-content');if(content)content.scrollTop=0;});
    await page.screenshot({path:path.join(OUT,'projects-wide.png'),fullPage:true});

    // New project session posts project_id directly, imports the current page and preserves workspace.
    const before=await page.evaluate(()=>window.LkaChatContext.get());
    assert.equal(before.workspace,'C:/fake/current');
    await page.locator('#projectNewSession').click();
    await page.waitForTimeout(150);
    assert(state.lastCreate,'create session request should reach isolated mock');
    assert.equal(state.lastCreate.project_id,pid);
    assert.equal(state.lastCreate.title,'新会话');
    assert.equal(blockedRoutes.length,0,'new session must not call workspace binding routes');
    assert(!requests.some(x=>x.path.includes('/pet/')&&x.method==='POST'),'project creation must not create a local folder');
    await page.waitForFunction(()=>window.LkaChatContext.get().sessionId==='session-created-1');
    assert.equal((await page.evaluate(()=>window.LkaChatContext.get())).workspace,'C:/isolated/project-0','created session is imported into the page');

    // A later workspace switch uses the session workspace API and persists both path and project identity.
    state.allowWorkspaceBinding=true;
    if (!await page.locator('#workspaceInput').isVisible()) await page.locator('#settingsTabButton').click();
    await page.locator('#workspaceInput').fill('C:/isolated/another-workspace');
    await page.locator('#workspaceInput').dispatchEvent('change');
    await page.waitForFunction(()=>window.LkaChatContext.get().workspace==='C:/isolated/another-workspace' && window.LkaChatContext.get().projectId==='new-project');
    assert.equal(state.lastWorkspaceBinding.path,'C:/isolated/another-workspace');
    assert.equal(state.lastWorkspaceBinding.platform,'windows');
    assert.equal(blockedRoutes.length,0,'workspace binding stays forbidden until the explicit directory switch');
    const persisted=await page.evaluate(()=>JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4')||'[]').find(x=>x.id==='session-created-1'));
    assert.equal(persisted.workspace,'C:/isolated/another-workspace');
    assert.equal(persisted.project_id,'new-project','project_id is persisted together with the switched workspace');

    // Busy state disables switching and creating a project session.
    await page.evaluate(()=>window.LkaProjects.open());
    await page.locator('[data-project-session="ps-0"]').waitFor();
    await page.evaluate(()=>window.dispatchEvent(new Event('lka-session-context')));
    // The real busy bit is owned by chat.js; run a short-lived pending request via the public state hook.
    await page.evaluate(()=>{window.__projectOriginalGet=window.LkaChatContext.get;window.LkaChatContext.get=function(){var s=window.__projectOriginalGet();s.busy=true;return s;};window.dispatchEvent(new Event('lka-session-context'));});
    assert.equal(await page.locator('#projectNewSession').isDisabled(),true,'busy run blocks project session creation');
    assert.equal(await page.locator('[data-project-session="ps-0"]').isDisabled(),true,'busy run blocks switching sessions');
    await page.evaluate(()=>{window.LkaChatContext.get=window.__projectOriginalGet;window.dispatchEvent(new Event('lka-session-context'));});

    // Token remains in page memory, is not persisted, and is reused by project calls.
    await page.locator('#projectConnection summary').click();
    await page.locator('#projectToken').fill('project-smoke-token');
    await page.locator('#projectTokenForm').locator('[type=submit]').click();
    await page.locator('#projectRefresh').click();
    await page.waitForTimeout(120);
    assert(requests.some(x=>x.auth==='Bearer project-smoke-token'),'project API request should reuse in-memory token');
    const storage=await page.evaluate(()=>JSON.stringify(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])));
    assert(!storage.includes('project-smoke-token'),'project token must not enter localStorage');

    if (await page.locator('#projectConnection').evaluate(e=>e.open)) await page.locator('#projectConnection summary').click();
    await page.setViewportSize({width:430,height:680});
    await page.screenshot({path:path.join(OUT,'projects-430x680-list.png'),fullPage:true});
    await page.locator('#projectDetail').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#projectDetail h3').first().innerText(),'Renamed smoke project');
    assert((await page.locator('#projectList [data-project-id]').count())>0,'mobile screenshot retains real project rows');
    await page.screenshot({path:path.join(OUT,'projects-430x680.png'),fullPage:true});

    // Older backend compatibility and native bridge request contract.
    await page.route('**/projects?*',route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({detail:'not found'})}));
    await page.locator('#projectRefresh').click(); await page.waitForTimeout(100);
    assert((await page.locator('#projectStatus').innerText()).length>0,'404 should render compatibility status');
    await page.evaluate(()=>{window.__projectBridge=[];window.petBridge={requestMemory(raw){const p=JSON.parse(raw);window.__projectBridge.push(p);window.__lkaMemoryBridgeReceive(p.id,200,'{"projects":[],"next_offset":null}')}}});
    await page.locator('#projectRefresh').click(); await page.waitForTimeout(120);
    await page.evaluate(()=>{window.petBridge.requestMemory=function(raw){const p=JSON.parse(raw);window.__projectBridge.push(p);const payload=p.method==='POST'?{project_id:'bridge-created',name:'Bridge write'}:{project_id:'project-0',name:'Bridge rename',revision:3};window.__lkaMemoryBridgeReceive(p.id,p.method==='POST'?201:200,JSON.stringify(payload));};});
    await page.evaluate(async()=>{
      await window.LkaMemory.request('/projects','POST',{path:'C:/isolated/bridge-created',name:'Bridge write',platform:'windows'});
      await window.LkaMemory.request('/projects/project-0','PATCH',{name:'Bridge rename',expected_revision:3});
    });
    const bridge=await page.evaluate(()=>window.__projectBridge);
    assert(bridge.some(p=>p.method==='GET'&&p.path.startsWith('/projects?')&&p.token==='project-smoke-token'),'bridge should use matching method/path/token envelope');
    assert(bridge.some(p=>p.method==='POST'&&p.path==='/projects'&&p.token==='project-smoke-token'&&JSON.parse(p.body).path==='C:/isolated/bridge-created'),'bridge writes include the same method/path/body/token contract');
    assert(bridge.some(p=>p.method==='PATCH'&&p.path==='/projects/project-0'&&JSON.parse(p.body).expected_revision===3),'bridge forwards rename CAS payload');

    assert.equal(await page.locator('#projectsOverlay').evaluate(e=>getComputedStyle(e).position),'fixed');
    await page.locator('#projectsClose').click();
    assert.equal(await page.locator('#projectsOverlay').isHidden(),true);
    console.log(JSON.stringify({result:'PASS',requests:requests.length,screenshots:[path.join(OUT,'projects-wide.png'),path.join(OUT,'projects-430x680-list.png'),path.join(OUT,'projects-430x680.png')],checks:['project paging','literal search and XSS escaping','register duplicate preserves name','rename 409 draft and reload','project session paging and deleted filtering','new session project_id/workspace preservation','busy interaction guard','explicit workspace switch persists workspace and project_id','in-memory token/no localStorage','404 compatibility','Java bridge read/write method/path/body/token contract','430x680 layout/close']},null,2));
  } catch(e) { console.error(e.stack||e); process.exitCode=1; }
  finally { if(browser) await browser.close(); server.close(); }
})();
