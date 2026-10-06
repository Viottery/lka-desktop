// Isolated Chrome smoke test for QQ Reader status. All status responses are mocked.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = process.env.FRONTEND_PET_ROOT || 'D:/agent-bot-frontend/app/web/pet';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.SMOKE_ARTIFACT_DIR || 'D:/agent-bot-frontend/.runtime/qq-smoke';
fs.mkdirSync(OUT,{recursive:true});
const requests=[]; let index=0, notFound=false;
const stamp='2026-10-02T10:00:00+00:00';
const states=[
 {plugin_id:'qq_reader',enabled:false,connection_state:'disabled',sync_state:'not_configured',last_received_at:null,last_error:null},
 {plugin_id:'qq_reader',enabled:true,connection_state:'connected',sync_state:'idle',last_received_at:stamp,last_error:null},
 {plugin_id:'qq_reader',enabled:true,connection_state:'offline',sync_state:'offline',last_received_at:stamp,last_error:'websocket_error'},
 {plugin_id:'qq_reader',enabled:true,connection_state:'connected',sync_state:'idle',last_received_at:stamp,last_error:'<img src=x onerror=alert(1)> SECRET_TOKEN arbitrary-extra'},
];
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname==='/plugins/qq-reader/status'){
  requests.push({path:u.pathname+u.search,method:req.method,auth:req.headers.authorization||'',cookie:req.headers.cookie||'',host:req.headers.host||''});
  if(notFound){res.writeHead(404,{'content-type':'application/json'});return res.end(JSON.stringify({detail:'<script>malicious response</script>'}));}
  res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});return res.end(JSON.stringify(states[Math.min(index++,states.length-1)]));
 }
 if(req.method!=='GET'){res.writeHead(405);return res.end();}
 if(u.pathname==='/chat.html'){
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  return res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat.css"><link rel="stylesheet" href="/qq-reader.css"></head><body><main class="chat-shell settings-open"><aside class="context-rail"><div class="rail-panel settings-panel"><details class="qq-plugin" id="qqReaderPanel"><summary>QQ 只读接入 <span id="qqReaderBadge">可选插件</span></summary><dl aria-live="polite"><dt>启用</dt><dd id="qqReaderEnabled">待查询</dd><dt>连接</dt><dd id="qqReaderConnection">—</dd><dt>接收时间</dt><dd id="qqReaderReceived">—</dd><dt>同步</dt><dd id="qqReaderSync">—</dd><dt>提示</dt><dd id="qqReaderError">—</dd></dl><button id="qqReaderRefresh" class="text-action" type="button">刷新状态</button></details></div></aside></main><script src="/qq-reader.js"></script></body></html>`);
 }
 const rel=decodeURIComponent(u.pathname==='/'?'/chat.html':u.pathname), file=path.resolve(ROOT,'.'+rel);
 if(!file.startsWith(path.resolve(ROOT)+path.sep)){res.writeHead(403);return res.end('forbidden');}
 fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('missing '+rel);}const ext=path.extname(file);res.writeHead(200,{'content-type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[ext]||'application/octet-stream'});res.end(data);});
});
(async()=>{let browser;try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,executablePath:CHROME,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>console.error('PAGEERROR',e.message));const browserRequests=[];const sockets=[];page.on('request',r=>browserRequests.push({url:r.url(),method:r.method()}));page.on('websocket',ws=>sockets.push(ws.url()));
 await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 await page.goto(base+'/chat.html?backend=http%3A%2F%2Fexample.invalid:8765');
 const panel=page.locator('#qqReaderPanel');await panel.waitFor({state:'visible'});assert.equal(await panel.evaluate(e=>e.open),false);await page.waitForTimeout(200);assert.equal(requests.length,0,'collapsed panel makes no request');
 assert.equal(await page.locator('#qqReaderRefresh').getAttribute('type'),'button');
 await panel.locator('summary').click();await page.waitForFunction(()=>document.querySelector('#qqReaderEnabled').textContent==='未启用');
 assert.equal(requests.length,1);assert.equal(requests[0].path,'/plugins/qq-reader/status');assert.equal(requests[0].method,'GET');assert.equal(requests[0].auth,'');assert.equal(requests[0].cookie,'');assert.equal(requests[0].host,new URL(base).host,'status endpoint uses frontend origin');
 await page.locator('#qqReaderRefresh').click();await page.waitForFunction(()=>document.querySelector('#qqReaderConnection').textContent==='已连接');assert.equal(await page.locator('#qqReaderBadge').innerText(),'已启用');assert.equal(await page.locator('#qqReaderSync').innerText(),'已同步 / 等待新消息');
 await page.locator('#qqReaderRefresh').click();await page.waitForFunction(()=>document.querySelector('#qqReaderConnection').textContent==='断开，自动重连中');assert.equal(await page.locator('#qqReaderSync').innerText(),'后端不可用，消息保留在本机');
 await page.locator('#qqReaderRefresh').click();await page.waitForFunction(()=>document.querySelector('#qqReaderError').textContent==='Reader 状态异常，请检查本机配置');
 const visibleText=await panel.innerText();assert(!visibleText.includes('<img')&&!visibleText.includes('SECRET_TOKEN')&&!visibleText.includes('arbitrary-extra'));assert.equal(await panel.locator('img').count(),0);
 notFound=true;await page.locator('#qqReaderRefresh').click();await page.waitForFunction(()=>document.querySelector('#qqReaderError').textContent.includes('前端服务尚未加载 QQ 插件'));assert(!(await panel.innerText()).includes('malicious response'));
 notFound=false;await page.evaluate(()=>{window.__bridgeIds=[];window.petBridge={requestQQReaderStatus(id){window.__bridgeIds.push(id);}};});await page.locator('#qqReaderRefresh').click();await page.waitForFunction(()=>window.__bridgeIds?.length===1);
 const bridgeId=await page.evaluate(()=>window.__bridgeIds[0]);assert.match(bridgeId,/^qq-status-[a-z0-9]+-\d+$/);
 await page.evaluate(()=>window.__lkaQQStatusReceive('wrong-id',200,'{}'));assert.equal(await page.locator('#qqReaderRefresh').isDisabled(),true);
 await page.evaluate(id=>window.__lkaQQStatusReceive(id,200,JSON.stringify({plugin_id:'qq_reader',enabled:false,connection_state:'disabled',sync_state:'not_configured',last_received_at:null,last_error:null})),bridgeId);await page.waitForFunction(()=>document.querySelector('#qqReaderEnabled').textContent==='未启用');
 await panel.locator('summary').click();await page.waitForTimeout(180);assert.equal(requests.length,5,'bridge must not make HTTP request');
 await page.setViewportSize({width:430,height:680});await panel.locator('summary').click();await page.waitForTimeout(80);
 const dimensions=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,panel:document.querySelector('#qqReaderPanel').getBoundingClientRect().width}));assert(dimensions.scroll<=dimensions.client+1,`horizontal overflow ${JSON.stringify(dimensions)}`);
 assert.equal(sockets.length,0,'status panel must not open WebSockets');
 assert(browserRequests.every(r=>new URL(r.url).origin===base),'browser traffic stays inside the isolated frontend origin');
 assert(browserRequests.every(r=>['/chat.html','/chat.css','/qq-reader.css','/qq-reader.js','/plugins/qq-reader/status'].includes(new URL(r.url).pathname)),'no backend, workspace, or action endpoints are requested');
 await page.screenshot({path:path.join(OUT,'qq-reader-430x680.png'),fullPage:true});
 console.log(JSON.stringify({result:'PASS',requests:requests.length,screenshot:path.join(OUT,'qq-reader-430x680.png'),checks:['collapsed no request','same-origin GET without auth/cookies','disabled/connected/offline states','untrusted error and extra data rendered as fixed text','404 safe hint','matching Java bridge callback ID','bridge makes no HTTP call','430x680 overflow check']},null,2));
 }catch(e){console.error(e.stack||e);process.exitCode=1;}finally{if(browser)await browser.close();server.close();}})();
