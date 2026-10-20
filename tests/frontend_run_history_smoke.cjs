'use strict';
// Replay public durable events only. No personal services, model calls, or task controls.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const ROOT=path.resolve(__dirname,'../app/web/pet'),requests=[],errors=[],stamp=new Date().toISOString();
const session={session_id:'history-session',kind:'ordinary',title:'运行过程回看',created_at:stamp,updated_at:stamp,metadata:{},workspace:{path:'/synthetic/history'}};
const answers=[['第一轮答复','run-one'],['第二轮答复','run-two'],['旧版答复',''],['缺失记录答复','run-missing'],['空记录答复','run-empty'],['重试记录答复','run-retry']];
const messages=answers.flatMap(([content,run],i)=>[{message_id:'q'+i,role:'user',content:'问题'+i,payload:{}},{message_id:'a'+i,role:'assistant',content,payload:{run_id:run,trace_id:i===2?'legacy-trace':'trace-'+i,log_path:'/private/internal/run.json'}}]);
let retryFailure=true,held=null,holdOne=false;
function events(run){let sequence=0;const rows=[],event=(type,message='',payload={})=>rows.push({run_id:run,sequence:++sequence,type,message,payload,created_at:stamp});
 event('run_started');event('llm_delta','',{display_target:'agent_process',delta:'{"reason":"PRIVATE_CONTROL_JSON"}'});
 event('assistant_message','先**查找资料**。',{metadata:{step_index:1}});
 event('tool_started','',{tool_name:'filesystem.read_file'});event('tool_completed','',{tool_name:'filesystem.read_file',status:'completed'});
 event('assistant_message','资料已读，接下来核对。',{metadata:{step_index:2}});
 event('tool_started','',{tool_name:'web.search'});event('tool_failed','',{tool_name:'web.search',status:'failed'});
 if(run==='run-two')for(let i=0;i<115;i++){event('assistant_message','逐项核对 '+i,{metadata:{step_index:10+i}});event('tool_completed','',{tool_name:'tool-'+i,status:'completed'});}
 event('final_answer','',{metadata:{answer:'最终答复'}});event('run_completed');return rows;
}
function json(res,n,x){res.writeHead(n,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(x));}
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://fixture'),p=u.pathname.replace(/^\/mock/,'');
 if(!u.pathname.startsWith('/mock')){
  if(u.pathname==='/font'){res.writeHead(200,{'content-type':'font/collection'});return fs.createReadStream('/mnt/c/Windows/Fonts/msyh.ttc').pipe(res);}
  const f=path.resolve(ROOT,'.'+u.pathname);if(f.startsWith(ROOT+path.sep)&&fs.existsSync(f)&&fs.statSync(f).isFile()){res.writeHead(200,{'content-type':f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});return fs.createReadStream(f).pipe(res);}return json(res,404,{});
 }
 requests.push({p,method:req.method,query:u.searchParams.toString()});
 if(/^\/agent\/runs\/[^/]+\/events$/.test(p)){
  assert.equal(req.method,'GET');assert.equal(u.searchParams.get('after_sequence'),'0');const id=p.split('/')[3];
  if(id==='run-missing')return json(res,404,{});if(id==='run-retry'&&retryFailure){retryFailure=false;return json(res,503,{});}
  const release=()=>json(res,200,{run_id:id,events:id==='run-empty'?[]:events(id)});if(id==='run-one'&&holdOne){holdOne=false;held=release;return;}release();return;
 }
 if(p==='/health')return json(res,200,{status:'ok'});
 if(p==='/agent/ui-defaults')return json(res,200,{configured:false,defaults:{}});
 if(p==='/agent/models')return json(res,200,{clients:[]});
 if(p==='/agent/safety-reviews')return json(res,200,{reviews:[]});
 if(p==='/managers/default')return json(res,409,{detail:'management_disabled'});
 if(p==='/sessions')return json(res,200,{sessions:[session]});
 if(p==='/sessions/history-session')return json(res,200,{session,messages});
 if(p==='/sessions/history-session/runs')return json(res,200,{session_id:session.session_id,runs:u.searchParams.get('offset')==='100'?[{run_id:'run-legacy',trace_id:'legacy-trace',session_id:session.session_id,status:'completed'}]:[],next_offset:u.searchParams.get('offset')==='100'?null:100});
 if(p.endsWith('/files'))return json(res,200,{entries:[]});
 if(p==='/projects')return json(res,200,{projects:[]});
 return json(res,404,{});
});
(async()=>{let browser;try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox']});
 for(const mode of ['work','quick']){
  const page=await browser.newPage({viewport:mode==='work'?{width:1440,height:950}:{width:460,height:720}});page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const url=origin+'/chat.html?mode='+mode+'&session_id=history-session&backend='+encodeURIComponent(origin+'/mock');
  const count=()=>requests.filter(r=>r.p.endsWith('/events')).length;const start=count();
  await page.goto(url);await page.locator('.message.assistant').filter({hasText:'第一轮答复'}).waitFor();assert.equal(count(),start,'history is lazy');
  const detail=title=>page.locator('.message.assistant').filter({hasText:title}).locator('.agent-run-details');
  holdOne=true;await detail('第一轮答复').locator('summary').click();for(let i=0;i<100&&!held;i++)await page.waitForTimeout(10);assert(held);
  await detail('第二轮答复').locator('summary').click();await detail('第二轮答复').locator('.run-process-model').last().waitFor();
  assert.equal(await detail('第二轮答复').locator('.run-process-tool').count(),117,'all tool calls survive beyond 100 entries');
  assert.equal(await detail('第二轮答复').locator('.run-process-model').count(),117,'all model messages survive');
  held();held=null;await detail('第一轮答复').locator('.run-process-model strong').waitFor();
  assert.equal(await detail('第一轮答复').locator('.run-process-tool').count(),2);assert.equal(await detail('第一轮答复').locator('.run-process-state').allTextContents().then(a=>a.join(',')),'完成,失败');
  const content=await detail('第一轮答复').innerText();assert(content.indexOf('查找资料')<content.indexOf('filesystem.read_file'));assert(content.indexOf('filesystem.read_file')<content.indexOf('资料已读'));
  assert(!content.includes('PRIVATE_CONTROL_JSON'));assert(!content.includes('/private/'));assert(!content.includes('trace='));assert(!content.includes('log='));
  const before=count();await detail('第一轮答复').locator('summary').click();await detail('第一轮答复').locator('summary').click();assert.equal(count(),before,'completed record cached');
  await detail('旧版答复').locator('summary').click();await detail('旧版答复').locator('.run-process-model').first().waitFor();assert.equal(await detail('旧版答复').getAttribute('data-run-id'),'run-legacy');
  assert(requests.some(r=>r.p==='/sessions/history-session/runs'&&r.query.includes('offset=100')),'legacy trace discovery paginated');
  await detail('缺失记录答复').locator('summary').click();await detail('缺失记录答复').getByText('这次运行的事件记录已不可用。').waitFor();
  await detail('空记录答复').locator('summary').click();await detail('空记录答复').getByText('这次运行没有保存可回看的事件。').waitFor();
  retryFailure=true;await detail('重试记录答复').locator('summary').click();await detail('重试记录答复').getByRole('button',{name:'重试'}).click();await detail('重试记录答复').locator('.run-process-model').first().waitFor();
  await page.reload();await detail('第一轮答复').locator('summary').click();await detail('第一轮答复').locator('.run-process-model').first().waitFor();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4')).find(s=>s.id==='history-session').messages.find(m=>m.text==='第一轮答复').runId),'run-one','run association persisted');
  if(mode==='work'){
   await page.setViewportSize({width:390,height:740});if(await page.locator('#chatShell').evaluate(n=>n.classList.contains('sidebar-open')))await page.locator('#toggleSidebarButton').click();
   await page.addStyleTag({content:"@font-face{font-family:Smoke;src:url('/font')}body{font-family:Smoke,sans-serif!important}"});await page.evaluate(()=>document.fonts.ready);
   await detail('第一轮答复').scrollIntoViewIfNeeded();assert(await detail('第一轮答复').evaluate(n=>n.scrollWidth<=n.clientWidth));await page.screenshot({path:'/tmp/lka-run-history-mobile.png'});
  }
  await page.close();
 }
 assert(!requests.some(r=>r.method!=='GET'&&r.p!=='/managers/default'),'replay never executes or changes a task');assert.deepEqual(errors,[]);
 console.log('PASS durable run history: lazy SSE replay, matching live model/tool rendering, >100 entries, run isolation, trace pagination, reload, cache, retry, missing/empty records and quick/mobile layouts');
 }finally{if(held)held();if(browser)await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
