'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '../app/web/pet/message-names.js'), 'utf8');
function harness(backend) {
  const window = {LkaMessageApi: {backend}};
  vm.runInNewContext(source, {window, encodeURIComponent});
  return window.LkaMessageNames;
}
function httpError(status) { return Object.assign(new Error('HTTP ' + status), {status}); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

const item = {conversation_key: 'key/1', platform: 'qq', account_id: '100',
  conversation_type: 'group', conversation_id: '200'};

async function main() {
  const labels = harness(async () => ({}));
  assert.equal(labels.label(item, {user_alias: '  我的备注  ', display_name: '群名'}), '我的备注');
  assert.equal(labels.label(item, {manual_display_name: '  手工名称 ', display_name: '策略名'}), '手工名称');
  assert.equal(labels.label(item, {user_alias: ' ', display_name: '  群名称  '}), '群名称');
  assert.equal(labels.label(item, {qq_group_name:'QQ 自动群名',display_name:'旧显示名称'}),'QQ 自动群名');
  assert.equal(labels.label(item, {user_alias:'我的备注',qq_group_name:'QQ 自动群名'}),'我的备注');
  assert.equal(labels.label(item, {manual_display_name:'手动名称',qq_group_name:'QQ 自动群名'}),'手动名称');
  assert.equal(labels.label(item, {display_name: '200'}), '未命名群聊');
  assert.equal(labels.label({...item, conversation_type: 'private'}, {display_name: ' '}), '未命名私聊');

  assert.equal(labels.personLabel({sender_id:'123',sender_name:'昵称甲'}),'昵称甲');
  assert.equal(labels.personLabel({sender_id:'123',card:'群名片',nickname:'昵称'}),'群名片');
  assert.equal(labels.personLabel({sender_id:'123',sender_name:'123'}),'未获取昵称');
  assert.equal(labels.personIdentity({sender_id:'123'}),'QQ 123');

  const calls = [];
  const legacy = harness(async (...args) => {
    calls.push(args);
    if (args[0].endsWith('/metadata')) throw httpError(404);
    if (args[0] === '/messages/policies' && args[1] !== 'PUT') return {policies: [{...item, revision: 8,
      min_interval_seconds: 300, max_wait_seconds: 900, record_enabled: true, analysis_enabled: true,
      media_enabled: true, batch_size: 17, max_batch_messages: 45, auto_analyze: false}]};
    return {policy: {...item, display_name: args[2].display_name, revision: 9}};
  });
  const updated = await legacy.rename(item, ' 新名字 ');
  assert.equal(updated.display_name, '新名字');
  assert.equal(updated.manual_display_name, '新名字');
  assert.equal(calls[0][0], '/messages/conversations/key%2F1/metadata');
  assert.equal(calls[1][0], '/messages/policies');
  assert.deepEqual(plain(calls[2][2]), {platform: 'qq', account_id: '100', conversation_type: 'group',
    conversation_id: '200', display_name: '新名字', expected_revision: 8,
    min_interval_seconds: 300, max_wait_seconds: 900});
  assert.equal('start_from_now' in calls[2][2], false);
  assert.equal('analysis_enabled' in calls[2][2], false);
  assert.equal('record_enabled' in calls[2][2], false);
  assert.equal('media_enabled' in calls[2][2], false);
  assert.equal('batch_size' in calls[2][2], false);
  assert.equal('max_batch_messages' in calls[2][2], false);
  assert.equal('auto_analyze' in calls[2][2], false);

  const modernCalls = [];
  const modern = harness(async (...args) => {
    modernCalls.push(args);
    if (args[1] === 'PATCH') return {user_alias: '备注', display_name: '备注', revision: 4};
    return {revision: 3};
  });
  await modern.rename(item, '备注');
  assert.equal(modernCalls.length, 2);
  assert.deepEqual(plain(modernCalls[1][2]), {expected_revision: 3, user_alias: '备注'});

  const conflict = harness(async (_path, method) => {
    if (method === 'PATCH') throw httpError(409);
    return {revision: 2};
  });
  await assert.rejects(conflict.rename(item, '改名'), error => error.status === 409);

  const deniedCalls = [];
  const denied = harness(async (...args) => {
    deniedCalls.push(args);
    throw httpError(403);
  });
  await assert.rejects(denied.rename(item, '改名'), error => error.status === 403);
  assert.equal(deniedCalls.length, 1);

  let absentCalls = 0;
  const absent = harness(async path => {
    absentCalls++;
    if (path.endsWith('/metadata')) throw httpError(404);
    return {policies: []};
  });
  await assert.rejects(absent.rename(item, '改名'), /找不到该会话/);
  assert.equal(absentCalls, 2);
  await assert.rejects(legacy.rename(item, '  '), /1 至 512/);
  await assert.rejects(legacy.rename(item, 'x'.repeat(513)), /1 至 512/);
  process.stdout.write('frontend message names contract tests passed\n');
}

main().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
