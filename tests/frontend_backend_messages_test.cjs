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
for (const name of ['normalizeBackendRole','normalizeBackendMessages','sessionFromBackendDetail','sessionMessageSnapshot','queueEnabled','mergeBackendSession']) vm.runInContext(implementation(name),context);
const records = [
 {role:'user',content:'输入类型：background；这是用户讨论的文字'},
 ...['manager','background','task_report','forwarded'].map(origin=>({role:'tool',content:'private '+origin,payload:{input_envelope:{origin}}})),
 {role:'user',content:'private metadata',payload:{input_origin:'manager'}},
 {role:'tool',content:'legacy visible tool'},
 {role:'assistant',content:'actual delivery',payload:{input_origin:'background',trace_id:'trace-delivery'}},
 {role:'user',content:'user input',payload:{input_origin:'user'}},
 {role:'system',content:'system prompt'}
];
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
