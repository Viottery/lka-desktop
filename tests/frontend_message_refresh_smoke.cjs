// Render against the actual UI with delayed synthetic read-only APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const ROOT = path.resolve(__dirname, '../app/web/pet');
const bootstrap = function () {
  const values=Array.from({length:55},(_,i)=>({conversation_key:'fresh_'+i,platform:'qq',account_id:'123456',conversation_type:'group',conversation_id:String(90000+i),display_name:'测试群 '+i,message_count:10,pending_count:8}));
  window.freshFixture={requests:[],delayed:[],pending:8,count:10,name:'新群名',stale:true,hold:true};
  window.LkaChatContext={get:()=>({workMode:true,sessionId:'',backend:'http://unused.invalid'})};
  window.__lkaMemoryBridgeReceive=()=>{};
  const f=window.freshFixture;
  window.LkaMessageApi={backend:async function(p){
    f.requests.push(p);
    if(p.startsWith('/messages/conversations?')){const q=new URLSearchParams(p.split('?')[1]),limit=Number(q.get('limit')),offset=Number(q.get('offset'));return {conversations:values.slice(offset,offset+limit).map(v=>({...v,message_count:f.count,pending_count:f.pending})),next_offset:offset+limit<55?offset+limit:null};}
    if(p.endsWith('/metadata')){
      if(f.hold)return new Promise(resolve=>f.delayed.push(()=>resolve({user_alias:null,display_name:'测试群',revision:1})));
      return {user_alias:null,revision:1};
    }
    if(p.endsWith('/history?limit=50'))return {messages:[{message_id:'synthetic_1',conversation_key:'fresh_0',seq:1,sender_name:'合成发送者',sender_id:'77777',text:'合成原文'}]};
    if(p.startsWith('/messages/attachments'))return {attachments:[]};
    if(p==='/messages/reading/overview'||p.startsWith('/messages/reading/overview?'))return {coverage:[{conversation_key:'fresh_0',pending_messages:f.pending}],unseen_count:0};
    if(p.startsWith('/messages/reading/topics?')){const more=new URLSearchParams(p.split('?')[1]).get('cursor');return {items:[{id:more?'topic_2':'topic_1',conversation_key:'fresh_0',title:more?'第二页主题':'第一页主题',summary:'合成摘要'}],next_cursor:more?null:'page_2'};}
    if(p==='/messages/policies')return {policies:[]};
    return {};
  },qq:async function(p){
    f.requests.push('qq:'+p);
    if(p==='/status')return {enabled:true,ready:false,send_enabled:false,reading_paired:true,account_id:'123456'};
    if(p==='/capabilities')return {};
    if(p.startsWith('/policies/'))return {receive_enabled:true,send_enabled:false};
    if(p.startsWith('/groups/')){const id=p.match(/\/groups\/([^?]+)/)[1];return {account_id:'123456',group_id:id,group_name:f.name+' '+id,stale:f.stale};}
    return {};
  }};
};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost'),file=path.resolve(ROOT,'.'+url.pathname);
 if(!file.startsWith(ROOT+path.sep)){res.writeHead(403);return res.end();}
 if(url.pathname==='/chat.html'){
  let text=fs.readFileSync(file,'utf8').replace(/<script src="\.\/(chat|memory|projects)\.js[^>]*><\/script>/g,'');
  text=text.replace(/<script src="\.\/message-ui-api\.js[^>]*><\/script>/,'<script>('+bootstrap.toString()+')();</script>');
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(text);
 }
 if(fs.existsSync(file)&&fs.statSync(file).isFile()){res.writeHead(200,{'content-type':({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream'});return fs.createReadStream(file).pipe(res);}
 res.writeHead(404);res.end();
});
(async()=>{
 let browser;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.clock.install();await page.goto(origin+'/chat.html?mode=work');
  await page.locator('#openMessagesButton').click();
  await page.locator('#mcTimeline').getByText('合成原文',{exact:true}).waitFor();
  await page.waitForFunction(()=>window.freshFixture.delayed.length===3);
  // One stuck metadata request cannot block other names or the reading view.
  await page.waitForFunction(()=>document.querySelector('#mcConversationTitle').textContent==='新群名 90000');
  await page.locator('[data-mc-tab=reading]').click();
  await page.locator('.reading-coverage').getByText('待处理 8 条', {exact:false}).first().waitFor();
  await page.evaluate(()=>{window.freshFixture.pending=5;window.freshFixture.count=15;});
  await page.clock.runFor(5100);
  await page.locator('.reading-coverage').getByText('待处理 5 条',{exact:false}).first().waitFor();
  await page.locator('#mcConversationList').getByText('群聊 · 15 条记录',{exact:true}).first().waitFor();
  await page.locator('#mcMoreConversations').click();
  await page.waitForFunction(()=>document.querySelector('#mcConversationCount').textContent==='55 个会话');
  await page.evaluate(()=>{const n=document.querySelector('#mcConversationList');n.scrollTop=450;document.querySelector('#mcDraft').value='保留消息草稿';});
  await page.evaluate(()=>{window.freshFixture.pending=3;window.freshFixture.count=19;});
  await page.clock.runFor(5100);
  await page.locator('.reading-coverage').getByText('待处理 3 条',{exact:false}).first().waitFor();
  assert.equal(await page.locator('#mcConversationCount').textContent(),'55 个会话','automatic refresh preserves loaded pages');
  assert(await page.locator('#mcConversationList').evaluate(n=>n.scrollTop)>400,'automatic refresh preserves sidebar scroll');
  assert.equal(await page.locator('#mcDraft').inputValue(),'保留消息草稿');
  await page.evaluate(()=>{window.freshFixture.pending=0;window.freshFixture.name='更新群名';window.freshFixture.stale=false;});
  await page.locator('#mcRefresh').click();
  await page.locator('.reading-coverage').getByText('待处理 0 条',{exact:false}).first().waitFor();
  await page.waitForFunction(()=>document.querySelector('#mcConversationTitle').textContent==='更新群名 90000');
  await page.locator('.reading-coverage > strong').getByText('更新群名 90000',{exact:false}).waitFor();
  await page.locator('.reading-tabs [data-tab=topics]').click();
  await page.locator('.reading-list').getByText('第一页主题',{exact:true}).waitFor();
  await page.locator('.reading-list').getByRole('button',{name:'加载下一页'}).click();
  await page.locator('.reading-list').getByText('第二页主题',{exact:true}).waitFor();
  const topicsBefore=await page.evaluate(()=>window.freshFixture.requests.filter(p=>p.includes('reading/topics')).length);
  await page.clock.runFor(5100);
  assert.equal(await page.evaluate(()=>window.freshFixture.requests.filter(p=>p.includes('reading/topics')).length),topicsBefore,'quiet polling does not discard extra reading pages');
  assert.equal(await page.locator('.reading-list').getByText('第二页主题',{exact:true}).count(),1);
  await page.locator('#mcRefresh').click();
  await page.waitForFunction(n=>window.freshFixture.requests.filter(p=>p.includes('reading/topics')).length>n,topicsBefore);
  await page.waitForFunction(()=>!document.querySelector('.reading-list').textContent.includes('第二页主题'));
  await page.locator('.reading-tabs [data-tab=overview]').click();
  await page.locator('.reading-coverage').getByText('待处理 0 条',{exact:false}).first().waitFor();
  const before=await page.evaluate(()=>window.freshFixture.requests.filter(p=>p.includes('reading/overview')).length);
  await page.locator('.reading-coverage').getByRole('button',{name:'展开该会话简报'}).click();
  await page.locator('#mcDetailPanel').waitFor();
  await page.clock.runFor(5100);
  assert.equal(await page.evaluate(()=>window.freshFixture.requests.filter(p=>p.includes('reading/overview')).length),before,'opened reading details are not overwritten');
  await page.locator('#mcDetailBack').click();
  await page.locator('#mcClose').click();
  await page.evaluate(()=>{window.freshFixture.hold=false;window.freshFixture.delayed.splice(0).forEach(fn=>fn());});
  await page.waitForTimeout(50);await page.clock.runFor(50);
  const closed=await page.evaluate(()=>window.freshFixture.requests.length);
  await page.clock.runFor(15000);
  assert.equal(await page.evaluate(()=>window.freshFixture.requests.length),closed,'closed center starts no polling or queued names');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',slowMetadataDoesNotBlock:true,liveCounts:true,manualReadingRefresh:true,staleNameRetry:true,paginationAndScroll:true,readingPaginationPreserved:true,draftPreserved:true,detailPreserved:true,closedIsolation:true}));
 }finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
