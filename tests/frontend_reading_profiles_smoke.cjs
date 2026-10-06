// Isolated DOM/fetch simulation: no browser, backend, QQ or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.value = ''; this.checked = false; this._text = ''; this.classList = {toggle() {}}; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  append(...nodes) { nodes.forEach(n => { n.parent = this; this.children.push(n); }); }
  insertBefore(n) { this.append(n); }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  get childElementCount() { return this.children.length; }
  setAttribute(k,v) { this.attributes[k] = v; }
  addEventListener(k,f) { (this.listeners[k] ||= []).push(f); }
  async emit(k, trusted=true) { for (const fn of this.listeners[k] || []) await fn({isTrusted:trusted, preventDefault() {}}); }
  remove() { this.parent.children = this.parent.children.filter(n => n !== this); }
}
const host = new Element('details'), policy = new Element('form'), requests = [];
const document = {getElementById:id => id === 'messageHistoryPanel' ? host : policy, createElement:t => new Element(t), createTextNode:t => {const e = new Element('#text'); e.textContent = t; return e;}, addEventListener() {}, hidden:false};
const window = {location:{href:'http://127.0.0.1/chat.html'}, addEventListener() {}, confirm:() => true};
let participantRevision=2, focusRevision=4, conflict=true, sourcePage=0, participantStatus='hot';
const fetch = async (url, options) => {
  const p = url.pathname.replace('/plugins/message-reading',''), body = options.body ? JSON.parse(options.body) : null;
  requests.push({p, query:url.search, method:options.method, body}); let value={}, code=200;
  if (p === '/messages/reading/participants') value={participants:[{conversation_key:'conv',sender_id:'platform:张三',sender_name:'群名片张三',summary:'<img src=x onerror=alert(1)>',status:'hot'}]};
  else if (p.endsWith('/sources')) { sourcePage++; value={sources:[{message_id:'evidence-'+sourcePage,text:'<script>unsafe()</script>',sender_id:'123'}],next_cursor:sourcePage===1?'opaque':null}; }
  else if (p.endsWith('/control')) { if(conflict) code=409; else {participantRevision++; if(body.action==='hide')participantStatus='hidden'; if(body.action==='unhide')participantStatus='hot';} }
  else if (p.startsWith('/messages/reading/participants/')) value={sender_name:'更新后的昵称',revision:participantRevision,status:participantStatus,summary:'candidate summary',claims:[{status:'candidate',text:'candidate'},{status:'stale',text:'stale'},{status:'contested',text:'contested'}],coverage:{screened_seq:9,generation_published_seq:6,coverage_mode:'selected',model_seen_count:2,selected_out_count:7,pending_messages:3}};
  else if (p.startsWith('/messages/reading/focus/')) { if(options.method==='PUT') {if(conflict) code=409; else focusRevision++;} else value={mode:'auto',revision:focusRevision,focus:[{label:'general'}],fallback:true}; }
  return {status:code,text:async () => JSON.stringify(value)};
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/web/pet/message-names.js'),'utf8'),{window,encodeURIComponent});
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/web/pet/message-content.js'),'utf8'),{document,window,URL});
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/web/pet/message-reading.js'),'utf8'), {document,window,fetch,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,console});
const all = (node=host) => [node,...node.children.flatMap(n => all(n))];
const find = text => { const result = all().find(n => n.tagName==='button' && n.textContent===text); assert(result,'Missing button '+text); return result; };
const settle = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  await find('参与者').emit('click'); await settle();
  assert(host.textContent.includes('<img src=x onerror=alert(1)>'));
  assert(all().some(n=>n.tagName==='strong'&&n.textContent==='群名片张三'));
  assert(!all().some(n => n.tagName==='img' || n.tagName==='script'));
  await find('查看画像与证据').emit('click');
  assert(all().some(n=>n.tagName==='h4'&&n.textContent==='更新后的昵称'));
  assert(requests.some(r => r.p.includes('platform%3A%E5%BC%A0%E4%B8%89')),'sender safely URL encoded');
  assert(host.textContent.includes('候选画像') && host.textContent.includes('画像已过时') && host.textContent.includes('画像存在争议'));
  assert(host.textContent.includes('筛选到 9') && host.textContent.includes('发布到 6') && host.textContent.includes('模型见过 2'));
  await find('继续查看证据').emit('click'); assert.equal(sourcePage,2);
  const summary=all().find(n => n.name==='participant_summary'); summary.value='retained correction'; await summary.emit('input');
  const count=requests.length; await find('保存人工更正').emit('click',false); assert.equal(requests.length,count,'synthetic write blocked');
  await find('保存人工更正').emit('click'); assert.equal(summary.value,'retained correction');
  assert.equal(requests.at(-1).body.expected_revision,2); assert.equal(requests.at(-1).body.action,'correct');
  participantRevision=3; await find('载入最新版本并保留更正').emit('click'); assert.equal(all().find(n => n.name==='participant_summary').value,'retained correction');
  conflict=false; await find('保存人工更正').emit('click'); assert(requests.some(r => r.body?.expected_revision===3 && r.body.summary==='retained correction'));
  await find('置顶').emit('click'); await find('取消置顶').emit('click');
  const beforeHide=sourcePage; await find('隐藏').emit('click'); assert.equal(sourcePage,beforeHide,'hidden evidence must not be fetched');
  await find('取消隐藏').emit('click'); await find('删除画像').emit('click');
  for(const action of ['pin','unpin','hide','unhide','delete']) assert(requests.some(r => r.body?.action===action && typeof r.body.expected_revision==='number'));
  await find('群关注').emit('click'); all().find(n => n.attributes?.['aria-label']==='阅读会话').value='conv'; await find('查看群关注重点').emit('click');
  const mode=all().find(n => n.tagName==='select' && n.parent?._text==='关注方式'); mode.value='manual'; await mode.emit('change');
  conflict=true; await find('保存群关注重点').emit('click'); assert.equal(mode.value,'manual'); assert.equal(requests.at(-1).body.expected_revision,4);
  focusRevision=5; await find('载入最新版本并保留选择').emit('click'); assert.equal(all().find(n => n.tagName==='select' && n.parent?._text==='关注方式').value,'manual');
  conflict=false; await find('保存群关注重点').emit('click'); assert(requests.some(r => r.method==='PUT' && r.body.expected_revision===5 && r.body.labels.includes('general')));
  console.log('reading participant/focus mocked UI checks passed');
})().catch(error => {console.error(error); process.exitCode=1;});
