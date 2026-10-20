'use strict';
// Isolated layout/state regression. Every browser request is fulfilled locally.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const MODULE = path.resolve(__dirname, '../app/web/pet/conversation-position.js');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const html = `<!doctype html><style>
body{margin:0}#messages{position:relative;box-sizing:border-box;overflow:auto;width:390px;height:260px;padding:12px;border:1px solid #ddd;scroll-behavior:auto}
.message{box-sizing:border-box;min-height:80px;margin:0 0 8px;padding:8px;background:#eef6f3}.message-content{margin:0}
</style><div id="messages"></div><script>
window.sid='ordinary-a';window.host='https://synthetic-backend.test/8765';window.surface='work';
window.container=document.getElementById('messages');
window.renderRows=function(count,prefix){container.textContent='';for(let i=0;i<count;i++){const row=document.createElement('article');row.className='message '+(i%2?'assistant':'user');row.dataset.messageId=(prefix||'msg')+'-'+i;row.innerHTML='<p class="message-content">Synthetic private content '+i+'</p>';container.appendChild(row);}};
window.make=function(){window.position=LkaConversationPosition.create({container,namespace:host,surface,getSessionId:()=>sid});};
window.point=function(){const y=container.getBoundingClientRect().top+container.clientTop;const row=[...container.children].find(row=>row.getBoundingClientRect().bottom>y+1);return {id:row&&row.dataset.messageId,text:row&&row.textContent,offset:row?row.getBoundingClientRect().top-y:0,top:container.scrollTop,max:container.scrollHeight-container.clientHeight,bottom:position.isFollowingLatest()};};
window.change=function(id,count=40,prefix='msg'){position.beforeRender();sid=id;renderRows(count,prefix);position.afterRender();};
window.settle=function(){return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,30))));};
</script>`;
(async () => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    async function initialize() { await page.goto('https://conversation-position.test/fixture'); await page.addScriptTag({ path: MODULE }); }
    async function settle() { await page.evaluate(() => settle()); }
    async function point() { return page.evaluate(() => window.point()); }
    async function scroll(top) { await page.evaluate(top => { container.scrollTop = top; }, top); await settle(); }
    async function expectAnchor(saved, label) {
      await settle(); const actual = await point(); assert.equal(actual.id, saved.id, label + ': message'); assert.equal(actual.text, saved.text, label + ': body identity'); assert(Math.abs(actual.offset - saved.offset) <= 2, label + ': offset');
    }
    await initialize();
    await page.evaluate(() => { renderRows(40); make(); position.afterRender(); }); await settle();
    assert.equal((await point()).top, (await point()).max, 'first visit opens latest messages');
    await scroll(721); const original = await point(); assert.equal(original.bottom, false);
    await page.evaluate(() => { position.beforeRender(); renderRows(40); position.afterRender(); });
    await expectAnchor(original, 'same session rerender preserves reading anchor');
    await page.evaluate(() => change('manager-b')); await settle();
    assert.equal((await point()).top, (await point()).max, 'first manager visit also opens latest');
    await scroll(1090); const managerReading = await point();
    await page.evaluate(() => change('ordinary-a')); await expectAnchor(original, 'ordinary position restored after leaving manager');
    await page.evaluate(() => change('manager-b')); await expectAnchor(managerReading, 'manager position restored independently');
    // Rebuilt history can prepend messages; stable identity wins over its old index.
    await page.evaluate(() => {
      position.beforeRender(); renderRows(40);
      for(let i=2;i>=0;i--){const row=document.createElement('article');row.className='message user';row.dataset.messageId='older-'+i;row.innerHTML='<p class="message-content">Older</p>';container.prepend(row);}
      position.afterRender();
    }); await expectAnchor(managerReading, 'prepended history');
    await page.evaluate(() => { container.firstElementChild.style.height='230px'; });
    await expectAnchor(managerReading, 'image/font/layout growth above reader');
    await page.evaluate(() => { container.style.height='210px'; }); await expectAnchor(managerReading, 'viewport resize');
    const beforeAppend = await point();
    await page.evaluate(() => { const row=document.createElement('article');row.className='message assistant';row.dataset.messageId='new-delivery';row.innerHTML='<p class="message-content">New background delivery</p>';container.appendChild(row);position.followLatest(); });
    await expectAnchor(beforeAppend, 'new delivery never drags old-message reader to bottom');
    await page.evaluate(() => position.followLatest({force:true})); await settle();
    assert.equal((await point()).top, (await point()).max, 'explicit latest opts back into following');
    await page.evaluate(() => { container.lastElementChild.style.height='300px'; }); await settle();
    assert.equal((await point()).top, (await point()).max, 'following reader stays at latest while answer grows');
    await scroll(940); const persisted = await point();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await initialize(); await page.evaluate(() => { sid='manager-b';renderRows(40);make();position.restore(sid); });
    await expectAnchor(persisted, 'pagehide persists reading across reload');
    // The quick surface and backend namespaces cannot overwrite workbench state.
    await page.evaluate(() => { position.dispose();surface='quick';make();position.restore(sid); }); await settle();
    assert.equal((await point()).top, (await point()).max, 'quick surface starts independently');
    await scroll(555); const quickReading = await point();
    await page.evaluate(() => { position.capture();position.dispose();surface='work';make();position.restore(sid); });
    await expectAnchor(persisted, 'quick position does not overwrite workbench');
    await page.evaluate(() => { position.dispose();host='https://other-backend.test/8765';make();position.restore(sid); }); await settle();
    assert.equal((await point()).top, (await point()).max, 'other backend starts independently');
    await page.evaluate(() => { position.dispose();host='https://synthetic-backend.test/8765';surface='quick';make();position.restore(sid); });
    await expectAnchor(quickReading, 'quick position restored in original namespace');
    // Quick layout adds a tail after measurement; afterRender reconciles the
    // shared position instead of competing with it in a second scroll RAF.
    await page.evaluate(() => { container.style.setProperty('--tail','170px');const style=document.createElement('style');style.textContent='#messages::after{content:"";display:block;height:var(--tail,0px)}';document.head.appendChild(style);position.afterRender(); });
    await expectAnchor(quickReading, 'quick tail layout preserves old-message reading');
    await page.evaluate(() => { position.followLatest({force:true}); }); await settle();
    assert.equal((await point()).top,(await point()).max,'quick following includes its measured tail');
    // No record is lost when a remembered conversation temporarily renders empty.
    await scroll(640); const beforeEmpty = await point();
    await page.evaluate(() => { position.capture();position.beforeRender();container.textContent='';position.afterRender();position.beforeRender();renderRows(40);position.afterRender(); });
    await expectAnchor(beforeEmpty, 'empty loading render does not destroy stored anchor');
    await page.evaluate(() => { change('fingerprint-fallback');[...container.children].forEach(row=>row.removeAttribute('data-message-id'));position.afterRender(); });
    await scroll(830); const fingerprintReading = await point();
    await page.evaluate(() => { position.beforeRender();renderRows(40);[...container.children].forEach(row=>row.removeAttribute('data-message-id'));const older=document.createElement('article');older.className='message user';older.textContent='Prepended without ID';container.prepend(older);position.afterRender(); });
    await expectAnchor(fingerprintReading, 'body fingerprint anchors backend history without stable IDs');
    await page.evaluate(() => { change('explicit-quick-send',2);position.focusRow(container.firstElementChild); });
    await settle(); assert.equal((await point()).bottom,false,'explicit question focus stays unpinned even before the short reply overflows');
    await page.evaluate(() => { container.lastElementChild.style.height='1200px'; });await settle();
    assert.equal((await point()).top,0,'growing long reply stays at the focused question rather than chasing its end');
    const repeated = await page.evaluate(async () => {
      function drawRepeated() {
        renderRows(6);[...container.children].forEach((row,index)=>{row.removeAttribute('data-message-id');row.querySelector('.message-content').textContent=index%2?'short answer '+index:'repeat the same question';});
      }
      position.beforeRender();sid='repeated-quick-question';container.style.height='340px';container.style.setProperty('--tail','0px');drawRepeated();position.afterRender();
      position.focusRow(container.querySelectorAll('.message.user')[2]);
      const desired=position.capture();
      position.beforeRender();drawRepeated();position.afterRender();const redrawn=position.capture();
      container.style.setProperty('--tail','220px');position.afterRender();await settle();
      const c=container.getBoundingClientRect(),row=container.querySelectorAll('.message.user')[2];
      return {desired,redrawn,actual:position.capture(),rowOffset:row.getBoundingClientRect().top-c.top-container.clientTop,padding:parseFloat(getComputedStyle(container).paddingTop)};
    });
    assert.equal(repeated.desired.anchor.index,4,'temporarily constrained focus retains the third repeated question identity');
    assert.equal(repeated.redrawn.anchor.occurrence,2,'immediate redraw retains the third repeated question occurrence');
    assert(Math.abs(repeated.rowOffset-repeated.padding)<2,'new quick tail makes the original desired anchor reachable');
    assert.equal(repeated.actual.bottom,false,'constrained question focus never opts into follow-bottom');
    await page.evaluate(() => { container.style.setProperty('--tail','0px');position.focusRow(container.querySelectorAll('.message.user')[2]); });
    await settle();await scroll(50);const changedIntent=await point();
    await page.evaluate(() => { container.style.setProperty('--tail','220px');position.afterRender(); });
    await expectAnchor(changedIntent,'user scroll overrides temporarily constrained focus intent');
    await page.evaluate(() => { change('synchronous-layout',40);container.style.width='290px';[...container.children].forEach(row=>{row.style.minHeight='0';row.style.height='auto';row.querySelector('.message-content').textContent+=' long wrapping content '.repeat(20);});position.afterRender(); });
    await scroll(await page.evaluate(()=>container.children[8].offsetTop+20));const beforeSyncLayout=await point();
    await page.evaluate(() => { container.style.width='390px';position.beforeRender();position.afterRender(); });
    await expectAnchor(beforeSyncLayout,'synchronous width reflow captured before ResizeObserver preserves old anchor');
    const beforeRealScroll=await page.evaluate(() => { window.realPositionScrolls=[];container.addEventListener('scroll',event=>{if(event.isTrusted)realPositionScrolls.push(container.scrollTop);});position.restore(sid);container.scrollTop=600;position.afterRender();return realPositionScrolls.length; });
    await settle();assert.equal((await point()).top,600,'same-frame restore then user scroll survives an immediate layout callback');
    assert.equal((await point()).bottom,false,'same-frame actual scroll records reading intent');
    assert(await page.evaluate(before=>realPositionScrolls.length>before,beforeRealScroll),'browser dispatches a genuine scroll event after same-frame restore');
    await page.evaluate(() => { for(let i=0;i<125;i++){change('bounded-'+i);position.capture();} });
    const stored = await page.evaluate(() => localStorage.getItem('lka-conversation-positions-v1'));
    assert(Object.keys(JSON.parse(stored)).length <= 100, 'storage is bounded');
    assert(!stored.includes('Synthetic private content') && !stored.includes('synthetic-backend.test'), 'storage contains no message bodies or backend URL');
    await page.evaluate(() => {
      position.dispose();Storage.prototype.getItem=function(){throw new Error('storage disabled');};Storage.prototype.setItem=function(){throw new Error('quota');};
      sid='storage-unavailable';renderRows(40);make();position.restore(sid);
    }); await scroll(777); const fallback = await point();
    await page.evaluate(() => { position.capture();position.dispose();make();position.restore(sid); });
    await expectAnchor(fallback, 'unavailable storage falls back to bounded in-memory positions');
    await page.evaluate(() => position.dispose());
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS conversation position: ordinary/manager, rerender/prepend/resize, delayed layout, new delivery reading/following, reload, namespace/surface isolation, quick tail, empty render, bounded private storage and storage failure');
  } finally { await browser?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
