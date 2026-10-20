'use strict';
// Held synthetic requests reproduce slow polls and stale snapshots without personal services.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const ROOT=path.resolve(__dirname,'../app/web/pet'),requests=[],errors=[],stamp=new Date().toISOString();
const item=id=>({review_id:id,status:'pending',mode:'manual',tool_name:'filesystem.read_file',tool_risk:'low',reason:'合成操作'});
let reviews=[item('review-1'),item('review-2')],holdSnapshots=false,snapshots=[],decisions=[],decisionStatus=200;
const session={session_id:'approval-session',kind:'ordinary',title:'审批交互',created_at:stamp,updated_at:stamp,metadata:{},workspace:{path:'/synthetic/approval'}};
function json(res,n,x){res.writeHead(n,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(x));}
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://fixture'),p=u.pathname.replace(/^\/mock/,'');
 if(!u.pathname.startsWith('/mock')&&u.pathname!=='/pet/session-workspace'){
  const f=path.resolve(ROOT,'.'+u.pathname);if(f.startsWith(ROOT+path.sep)&&fs.existsSync(f)&&fs.statSync(f).isFile()){res.writeHead(200,{'content-type':f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html'});return fs.createReadStream(f).pipe(res);}return json(res,404,{});
 }
 let raw='';for await(const d of req)raw+=d;const b=raw?JSON.parse(raw):{};requests.push({p,method:req.method,b});
 if(p==='/agent/safety-reviews'){
  const snapshot=structuredClone(reviews),release=()=>json(res,200,{reviews:snapshot});
  if(holdSnapshots)snapshots.push(release);else release();return;
 }
 if(p.endsWith('/decision')){
  const id=p.split('/')[3],status=decisionStatus;
  decisions.push(()=>{if(status===200)reviews=reviews.filter(r=>r.review_id!==id);json(res,status,status===200?{review:{...item(id),status:b.decision==='approve'?'approved':'rejected'}}:{detail:'synthetic_failure'});});return;
 }
 if(p==='/health')return json(res,200,{status:'ok'});
 if(p==='/agent/ui-defaults')return json(res,200,{configured:true,defaults:{llm_client:'alpha',llm_model:'m1',safety_mode:'manual',stream:true}});
 if(p==='/agent/models')return json(res,200,{clients:[{name:'alpha',models:['m1'],default_model:'m1'}]});
 if(p==='/managers/default')return json(res,409,{detail:'management_disabled'});
 if(p==='/sessions')return json(res,200,{sessions:[session]});
 if(p==='/sessions/approval-session')return json(res,200,{session,messages:[]});
 if(p.endsWith('/runs'))return json(res,200,{runs:[]});
 if(p.endsWith('/files'))return json(res,200,{entries:[]});
 if(p.endsWith('/workspace'))return json(res,200,{project_id:'synthetic'});
 if(p==='/pet/session-workspace')return json(res,200,{path:'/synthetic/approval'});
 if(p==='/projects')return json(res,200,{projects:[]});
 return json(res,404,{});
});
(async()=>{let browser;try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox']});
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await page.waitForTimeout(10);}throw Error('timed out waiting for held request');};
 await page.goto(origin+'/chat.html?mode=work&session_id=approval-session&backend='+encodeURIComponent(origin+'/mock'));
 const approve=()=>page.locator('#approvalQueueStatus button').first();await approve().waitFor();await page.waitForTimeout(100);
 await approve().focus();await page.evaluate(()=>window.originalApprovalButton=document.activeElement);
 // Focus refresh starts a long GET. A known pending decision remains clickable.
 holdSnapshots=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await wait(()=>snapshots.length);
 assert(await approve().isEnabled(),'background refresh must not block approval');
 assert(await page.evaluate(()=>document.activeElement===window.originalApprovalButton&&window.originalApprovalButton.isConnected),'poll preserves focus and button identity');
 await approve().click();await wait(()=>decisions.length);assert(await approve().isDisabled(),'one decision in flight');
 await page.evaluate(()=>document.querySelector('#approvalQueueStatus button').click());assert.equal(decisions.length,1,'duplicate submission suppressed');
 decisions.shift()();await page.waitForFunction(()=>!document.getElementById('approvalQueueStatus').textContent.includes('正在提交'));
 assert(await approve().isEnabled(),'next approval does not wait for slow GET');
 // The outstanding old snapshot includes review-1. It must never resurrect it.
 snapshots.shift()();await wait(()=>snapshots.length);assert(await approve().isEnabled());
 await approve().click();await wait(()=>decisions.length);
 assert.equal(requests.filter(r=>r.p.endsWith('/decision')).at(-1).p,'/agent/safety-reviews/review-2/decision','confirmed head was removed before next GET');
 // Failure retains the item until a fresh authoritative snapshot arrives.
 decisions.shift()();await page.waitForFunction(()=>document.getElementById('approvalQueueStatus').hidden);
 holdSnapshots=false;while(snapshots.length)snapshots.shift()();await page.waitForTimeout(50);
 reviews=[item('review-failure')];decisionStatus=500;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await approve().waitFor();await approve().click();await wait(()=>decisions.length);decisions.shift()();
 await page.locator('.approval-queue-notice').filter({hasText:'审批提交失败'}).waitFor();assert(await approve().isEnabled(),'failed item remains retryable after revalidation');
 // Another terminal updates FIFO first: 409 refreshes instead of approving a new item implicitly.
 decisionStatus=409;await approve().click();await wait(()=>decisions.length);reviews=[item('review-new-head')];decisions.shift()();
 await page.locator('.approval-queue-notice').filter({hasText:'顺序已变化'}).waitFor();await page.waitForTimeout(50);
 decisionStatus=200;await approve().click();await wait(()=>decisions.length);assert.equal(requests.filter(r=>r.p.endsWith('/decision')).at(-1).p,'/agent/safety-reviews/review-new-head/decision');decisions.shift()();
 await page.waitForFunction(()=>document.getElementById('approvalQueueStatus').hidden);
 assert.deepEqual(errors,[]);console.log('PASS approval responsiveness: clickable/stable background polls, immediate acknowledged removal, stale snapshot fence, duplicate suppression, failure retry and FIFO conflict');
 }finally{if(browser)await browser.close();for(const release of snapshots)release();for(const release of decisions)release();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
