// Isolated checks against the frontend's real event handling functions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.FRONTEND_CHAT_SOURCE || path.join(__dirname, '../app/web/pet/chat.js'), 'utf8');
function extract(name) {
  const start = source.indexOf('  function ' + name + '(');
  assert(start >= 0, name);
  const tail = source.slice(start + 2);
  const end = tail.slice(1).search(/\n  (?:async )?function /);
  assert(end >= 0, name + ' boundary');
  return tail.slice(0, end + 1);
}
const live = { id: 's', timelineEvents: [] };
const statuses = [];
const context = {
  runProcesses: {}, activeSessionId: 's', Date, Array, Number, String, isFinite,
  safeText: value => value == null ? '' : String(value),
  getSessionById: () => live, renderRunTimeline: () => {}, persistSessions: () => {},
  setRunStatus: (message, status) => statuses.push({message, status}),
};
vm.createContext(context);
for (const name of ['truncateText', 'eventMessage', 'timelineText', 'processEventTime', 'recordProcessOutput', 'renderProcessEntry', 'recordRunEvent']) {
  vm.runInContext(extract(name), context);
}
const reason = '请明确授权工作区外文件。' + '详细理由'.repeat(100) + '<img src=x onerror=alert(1)>';
const denied = { run_id: 'r', sequence: 1, payload: { review: {
  tool_name: 'filesystem.read_file', mode: 'llm', status: 'rejected', decision_reason: reason,
}}};
assert(context.timelineText('safety_review_decided', denied).includes(reason));
context.recordRunEvent(live, 'safety_review_decided', denied);
assert.equal(live.timelineEvents.length, 1);
assert(live.timelineEvents[0].message.includes(reason));
assert.equal(context.runProcesses.s.entries[0].kind, 'review');
assert.equal(statuses[0].status, 'error');
assert(statuses[0].message.includes('下一条消息中明确授权'));
const item = {setAttribute: () => {}};
context.renderProcessEntry(item, context.runProcesses.s.entries[0]);
assert(item.textContent.includes(reason)); // source text is assigned as text, never HTML
assert.equal(context.recordProcessOutput(live, 'safety_review_decided', denied), false);
const approved = {run_id: 'r', sequence: 2, payload: {review: {
  tool_name: 'filesystem.read_file', mode: 'llm', status: 'approved', decision_reason: '用户已明确授权此文件',
}}};
context.recordRunEvent(live, 'safety_review_decided', approved);
assert(context.runProcesses.s.entries[1].message.includes('安全审批通过'));
assert(context.runProcesses.s.entries[1].message.includes('用户已明确授权此文件'));
assert(!statuses[1].message.includes('下一条消息'));
console.log('Safety review feedback checks passed.');
