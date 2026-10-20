'use strict';
// Exercise the exact shared history/turn normalizer and cache merge without a service or model.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app/web/pet/chat.js'), 'utf8');
function implementation(name) {
 const start = source.indexOf('  function ' + name + '(');
 assert(start >= 0, name);
 const end = source.indexOf('\n  function ', start + 1);
 return source.slice(start, end < 0 ? source.length : end);
}
const context = {
 safeText: v => v == null ? '' : String(v),
 buildAgentRunDetails: p => ({traceId:p.trace_id}),
 window:{LkaImageComposer:{fromIds: ids => ids || []}},
 sanitizeSession: value => value, timestampToMillis: v=>Date.parse(v),
 defaultGreetingMessage:()=>({role:'assistant',text:'greeting'}),
 sessions:[], managerPendingTurns:{}, managerInputQueues:{}, pendingState:null, renamingSessionId:'', applySessionTitle:()=>{},
 isManagerSession:s=>s?.kind==='manager'
};
context.getSessionById=id=>context.sessions.find(s=>s.id===id);
vm.createContext(context);
for (const name of ['truncateText','usefulBackendTitle','backendManagerInstruction','normalizeBackendRole','normalizeBackendMessages','sessionFromBackendDetail','sessionMessageSnapshot','queueEnabled','reconcileHistoryReset','mergeBackendSession']) vm.runInContext(implementation(name),context);
const records = [
 {role:'user',content:'输入类型：background；这是用户讨论的文字'},
 ...['manager','background','task_report','forwarded'].map(origin=>({role:'tool',content:'private '+origin,payload:{input_envelope:{origin}}})),
 {role:'user',content:'private metadata',payload:{input_origin:'manager'}},
 {role:'tool',content:'legacy visible tool'},
 {role:'assistant',content:'actual delivery',payload:{input_origin:'background',trace_id:'trace-delivery'}},
 {role:'user',content:'user input',payload:{input_origin:'user'}},
 {role:'system',content:'system prompt'}
];
const taskText='在工作区创建 `hello.py`。\n\n```python\nprint("hello world")\n```';
const task={message_id:'instruction-1',role:'tool',content:'发送方：管理会话 secret-source；调试信息 secret-debug',payload:{input_origin:'manager',trace_id:'private-trace',input_envelope:{origin:'manager',purpose:taskText,input_id:'secret-id',debug_info:{private:'secret-debug'}}}};
const projected=context.normalizeBackendMessages([task]);
assert.equal(projected[0].role,'assistant');
assert.equal(projected[0].messageKind,'manager_instruction');
assert.equal(projected[0].messageId,'instruction-1');
assert.equal(projected[0].text,taskText,'multiline task and code survive without the envelope');
assert.equal(projected[0].traceId,'','instructions do not acquire execution details');
assert(!JSON.stringify(projected).includes('secret-'));
for (const origin of ['background','task_report','user']) {
 const conflicting={...task,payload:{...task.payload,input_origin:origin}};
 assert(!context.normalizeBackendMessages([conflicting]).some(m=>m.messageKind==='manager_instruction'),'only explicit manager inputs become instructions');
}
assert.equal(context.normalizeBackendMessages([{...task,payload:{input_envelope:{origin:'manager',purpose:{invalid:true}}}}]).length,0);
assert.equal(context.normalizeBackendMessages([{...task,payload:{input_envelope:{origin:'manager',purpose:'   '}}}]).length,0);
assert.equal(context.normalizeBackendMessages([{...task,role:'assistant',content:'real answer'}])[0].text,'real answer');
const normalized=context.normalizeBackendMessages(records);
assert.deepEqual(Array.from(normalized,m=>m.text),[records[0].content,'legacy visible tool','actual delivery','user input']);
assert.equal(normalized[2].traceId,'trace-delivery');
for (const kind of ['ordinary','manager']) {
 const remote=context.sessionFromBackendDetail({session:{session_id:kind,kind,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},messages:records});
 assert.equal(remote.backendHistoryFiltered,true);
 assert.equal(remote.backendHistoryVersion,1);
 const cached={id:kind,kind,messages:records.map(r=>({role:r.role==='user'?'user':'assistant',text:r.content}))};
 context.sessions=[cached];context.mergeBackendSession(remote);
 assert.equal(cached.messages.length,4,'filtered shorter history removes old mislabeled cached bubbles');
 context.mergeBackendSession(remote);assert.equal(cached.messages.length,4,'delivery sync is idempotent');
 cached.messages=cached.messages.slice();
 const oldRequestSnapshot=context.sessionMessageSnapshot(kind);
 cached.messages.push({role:'user',text:'completed new question'},{role:'assistant',text:'completed new answer'});
 context.pendingState=null;context.mergeBackendSession(remote,oldRequestSnapshot);
 assert.equal(cached.messages.length,6,'late filtered history cannot delete an intervening completed turn');
 context.mergeBackendSession(remote,context.sessionMessageSnapshot(kind));
 assert.equal(cached.messages.length,4,'unchanged snapshot still repairs stale cache');
 const pending={role:'user',text:'new unsent-to-server turn'};cached.messages.push(pending);
 context.pendingState={conversationId:kind};context.mergeBackendSession(remote);
 assert(cached.messages.includes(pending),'active local turn is preserved');context.pendingState=null;
}
console.log('PASS backend messages: structured provenance in ordinary/manager history and turn normalization, legacy tool compatibility, answer preservation, shorter cache repair, duplicate-free refresh and busy guard');
