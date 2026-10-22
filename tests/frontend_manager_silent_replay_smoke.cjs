'use strict';
// Isolated saved-run replay: synthetic loopback fixture, no personal services.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const ROOT=process.env.FRONTEND_ROOT||path.resolve(__dirname,'../app/web/pet');
const sid='manager-silent-replay',runId='silent-replay',stamp=new Date().toISOString();
const errors=[],emitted=[];let completed=false;
const session={session_id:sid,kind:'manager',title:'Synthetic manager',created_at:stamp,updated_at:stamp,metadata:{},workspace:null};
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const server=http.createServer(async(req,res)=>{
 const route=new URL(req.url,'http://fixture').pathname;
 if(route==='/fixture'){res.writeHead(200,{'content-type':'text/html'});return res.end('<iframe></iframe>');}
 const file=path.resolve(ROOT,'.'+route);
 if(file.startsWith(ROOT+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
  res.writeHead(200,{'content-type':route.endsWith('.js')?'text/javascript':route.endsWith('.css')?'text/css':'text/html'});return fs.createReadStream(file).pipe(res);
 }
 if(route==='/agent/ui-defaults')return json(res,200,{configured:true,defaults:{stream:true}});
 if(route==='/agent/models')return json(res,200,{clients:[]});
 if(route==='/agent/safety-reviews')return json(res,200,{reviews:[]});
 if(route==='/knowledge/file-types')return json(res,200,{file_types:[]});
 if(route==='/sessions')return json(res,200,{sessions:[session]});
 if(route==='/sessions/deleted')return json(res,200,{sessions:[]});
 if(route==='/managers/default')return json(res,200,{session,controller:{session_id:sid,status:'active',revision:1,default_execution_workspace:{path:'/synthetic/tasks',platform:'linux',backend_path:'/synthetic/tasks'}}});
 if(route==='/sessions/'+sid)return json(res,200,{session,messages:[]});
 if(route==='/sessions/'+sid+'/runs')return json(res,200,{session_id:sid,runs:[{run_id:runId,session_id:sid,parent_run_id:null,status:completed?'completed':'running',created_at:stamp}],next_offset:null});
 if(route==='/managers/'+sid)return json(res,200,{session,controller:{session_id:sid,status:'active',revision:1,default_execution_workspace:{path:'/synthetic/tasks',platform:'linux',backend_path:'/synthetic/tasks'}}});
 if(route==='/agent/runs/'+runId+'/stream'){
  res.writeHead(200,{'content-type':'text/event-stream'});
  const events=[['run_started','Started',{}],['assistant_message','SILENT_REPLAY_PROCESS',{metadata:{user_visible:false}}],['llm_delta','SILENT_REPLAY_DELTA',{display_target:'assistant_answer',delta:'SILENT_REPLAY_DELTA',user_visible:false}],['final_answer','SILENT_REPLAY_FINAL',{metadata:{answer:'SILENT_REPLAY_FINAL',user_visible:false}}],['run_completed','Completed',{user_visible:false}]];
  events.forEach(([type,message,payload],index)=>{const event={run_id:runId,sequence:index+1,message,payload};emitted.push({type,...event});res.write('id: '+runId+':'+event.sequence+'\nevent: '+type+'\ndata: '+JSON.stringify(event)+'\n\n');});
  completed=true;return res.end();
 }
 if(route==='/agent/runs/'+runId)return json(res,200,{run_id:runId,session_id:sid,status:completed?'completed':'running'});
 if(route==='/agent/runs/'+runId+'/snapshot')return json(res,200,{run_id:runId,children:[]});
 if(route.endsWith('/goals'))return json(res,200,{goals:[],next_offset:null});
 if(route.endsWith('/events'))return json(res,200,{events:[],next_after:null});
 if(route.endsWith('/deliveries'))return json(res,200,{deliveries:[],next_after:null});
 return json(res,404,{detail:'unmocked'});
});
(async()=>{let browser;try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/tmp/lka-playwright-browsers/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']});
 const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin+'/chat.html?mode=work&backend='+encodeURIComponent(origin)+'&session_id='+sid+'&run_id='+runId);
 await page.waitForFunction(id=>(JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4'))||[]).find(item=>item.id===id)?.runControlStatus==='completed'&&JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4-run-cursor-'+id))?.sequence===5,sid);
 const result=await page.evaluate(id=>({session:JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4')).find(item=>item.id===id),cursor:JSON.parse(localStorage.getItem('agentic-rag-pet-chat-sessions-v4-run-cursor-'+id)),body:document.body.textContent,live:document.querySelectorAll('.agent-live-output').length}),sid);
 assert.equal(result.cursor.sequence,5);assert.equal(result.cursor.run_id,runId);
 assert.equal(result.session.multiAgentSequence,5);assert.equal(result.session.timelineState,'completed');
 assert(result.session.timelineEvents.some(event=>event.type==='run_started'));
 assert(result.session.timelineEvents.some(event=>event.type==='run_completed'));
 assert(!/SILENT_REPLAY_|本轮完成。/.test(result.body),'hidden saved content and fallback answer never render');
 assert(!/SILENT_REPLAY_/.test(JSON.stringify(result.session.messages)+JSON.stringify(result.session.timelineEvents)));
 assert.equal(result.live,0,'silent replay leaves no live answer bubble');
 assert.equal(emitted.find(event=>event.type==='final_answer').payload.metadata.answer,'SILENT_REPLAY_FINAL','transport retains the raw final event');
 assert.deepEqual(errors,[]);console.log('PASS silent manager replay: hidden process/delta/final, completed lifecycle, cursor=5, no answer bubble, raw final event retained');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}})().catch(error=>{console.error(error);process.exitCode=1});
