const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/tmp/lka-browser-check/node_modules/playwright-core');
const root = path.resolve(__dirname, '../app/web/pet');
(async () => {
 const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/tmp/lka-playwright-browsers/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell', headless:true, args:['--no-sandbox'] });
 try {
  const page = await browser.newPage({viewport:{width:1240,height:900},timezoneId:'Asia/Shanghai'});
  await page.setContent('<style>body{margin:0;font:14px/1.5 Arial,sans-serif;color:#22363b;background:#f7f9fa}#calendar{margin:30px;padding:24px;background:white;border-radius:14px}button,input,select{box-sizing:border-box}</style><div id="calendar"></div>');
  await page.addStyleTag({path:path.join(root,'matter-calendar.css')});
  await page.addScriptTag({path:path.join(root,'matter-calendar.js')});
  await page.evaluate(() => {
   const c=window.LkaMatterCalendar; window.anchor=c.dayKey(new Date());
   window.records=Array.from({length:205},(_,i)=>({matter_id:'task'+i,title:'整理研究资料 '+i,kind:'task',status:'open'}));
   records[0].scheduled_on=anchor;records[0].due_at=anchor;
   for(let i=1;i<9;i++)records[i].scheduled_on=anchor;
   records[9].scheduled_start=anchor+'T09:00:00+08:00';records[9].scheduled_end=anchor+'T10:00:00+08:00';
   window.show=(mode)=>c.render(document.getElementById('calendar'),{mode,anchor,records,onSelect:id=>window.selected=id});show('month');
  });
  assert.match(await page.locator('.mc-toolbar strong').textContent(),/\d{4}年\d{1,2}月/);
  assert.equal(await page.locator('.mc-weekdays>span').count(),7);
  assert.equal(await page.locator('.mc-date[aria-current=date]').count(),1);
  const day = page.locator('.mc-month .mc-today');
  assert.equal(await day.locator('[data-mc-id=task0]').count(),1,'same-day deadline and schedule combine');
  assert.match(await day.locator('[data-mc-id=task0]').textContent(),/全天 · 截止/);
  assert.equal(await day.locator('.mc-overflow').count(),1);
  await day.locator('.mc-overflow>summary').click();await day.locator('[data-mc-id=task8]').click();
  assert.equal(await page.evaluate(()=>window.selected),'task8','overflow remains accessible');
  await page.locator('.mc-tray-search').fill('204');assert.equal(await page.locator('.mc-tray-items [data-mc-id]:visible').count(),1);
  const tray=await page.locator('.mc-tray-items').boundingBox();assert(tray.height<=421,'200 task tray stays bounded');
  fs.mkdirSync('/tmp/matter-polish-calendar',{recursive:true});await page.screenshot({path:'/tmp/matter-polish-calendar/month.png'});
  await page.evaluate(()=>show('week'));
  assert.equal(await page.locator('.mc-content').count(),1,'single calendar board');
  assert.equal(await page.locator('[data-mc-time]').count(),168,'hour controls preserved');
  const ys=await page.locator('.mc-week .mc-hours').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().y));
  assert(ys.every(y=>y===ys[0]),'all-day counts cannot misalign time columns');
  const sizes=await page.locator('.mc-week-scroll').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth}));assert(sizes.scroll<=sizes.width+1,'all seven days fit desktop');
  await page.evaluate(()=>document.querySelector('.mc-week-scroll').scrollTop=400);
  await page.screenshot({path:'/tmp/matter-polish-calendar/week.png'});
  // Parent owns redraw and scroll restoration: internal draw must not overwrite it.
  await page.evaluate(()=>LkaMatterCalendar.render(document.getElementById('calendar'),{mode:'week',anchor,records,onNavigate:()=>{window.navCalls=(window.navCalls||0)+1;document.getElementById('calendar').innerHTML='<div id="parent-render">parent restored scroll</div>';}}));
  await page.locator('[data-mc-nav="1"]').click();assert.equal(await page.locator('#parent-render').count(),1);assert.equal(await page.evaluate(()=>navCalls),1);
  await page.evaluate(()=>LkaMatterCalendar.render(document.getElementById('calendar'),{mode:'week',anchor,records,onModeChange:()=>{document.getElementById('calendar').innerHTML='<div id="parent-mode">parent render</div>';}}));
  await page.locator('[data-mc-mode=month]').click();assert.equal(await page.locator('#parent-mode').count(),1);
  await page.setViewportSize({width:430,height:850});await page.evaluate(()=>show('agenda'));
  assert.equal(await page.locator('.mc-tray').getAttribute('open'),null,'narrow tray starts folded');
  await page.screenshot({path:'/tmp/matter-polish-calendar/narrow-agenda.png'});
  console.log('PASS calendar polish: month labels/today/aggregation/overflow, tray search and bounds, 168 hour controls, aligned seven days, parent render ownership, narrow tray');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
