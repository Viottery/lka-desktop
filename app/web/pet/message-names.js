/* Conversation labels and backward-compatible manual renaming. */
(function () {
  'use strict';

  const api = () => {
    if (!window.LkaMessageApi || typeof window.LkaMessageApi.backend !== 'function') {
      throw new Error('消息服务尚未就绪。');
    }
    return window.LkaMessageApi;
  };
  const text = value => typeof value === 'string' ? value.trim() : '';
  const identity = item => item && [item.platform, item.account_id, item.conversation_type, item.conversation_id];
  const sameIdentity = (left, right) => {
    const a = identity(left), b = identity(right);
    return !!a && !!b && a.every((value, index) => value === b[index]);
  };
  const label = (item, metadata) => {
    if (!item) return '未命名会话';
    const id = text(item.conversation_id);
    const candidates = metadata ? [metadata.user_alias, metadata.manual_display_name,
      metadata.qq_group_name, metadata.cached_display_name, metadata.display_name] : [];
    candidates.push(item.display_name);
    for (const value of candidates) {
      const name = text(value);
      if (name && name !== id) return name;
    }
    return ({group:'未命名群聊',private:'未命名私聊',channel:'未命名频道'})[item.conversation_type]||'未命名会话';
  };
  const path = item => '/messages/conversations/' + encodeURIComponent(item.conversation_key) + '/metadata';
  const fail = message => { throw new Error(message); };

  async function rename(item, value) {
    const name = text(value);
    if (!item || !item.conversation_key || !identity(item).every(part => typeof part === 'string' && part.trim())) {
      fail('会话信息不完整，无法重命名。');
    }
    if (!name || name.length > 512) fail('名称须为 1 至 512 个字符。');
    const client = api();
    let current;
    try {
      current = await client.backend(path(item));
    } catch (error) {
      if (!error || error.status !== 404) throw error;
      const listing = await client.backend('/messages/policies');
      const policies = Array.isArray(listing && listing.policies) ? listing.policies : [];
      const policy = policies.find(candidate => sameIdentity(candidate, item));
      if (!policy) fail('找不到该会话的现有策略，无法重命名。');
      if (!Number.isInteger(policy.revision) || !Number.isInteger(policy.min_interval_seconds) ||
          !Number.isInteger(policy.max_wait_seconds)) {
        fail('会话策略缺少安全更新所需的版本或调度字段。');
      }
      const saved = await client.backend('/messages/policies', 'PUT', {
        platform: item.platform,
        account_id: item.account_id,
        conversation_type: item.conversation_type,
        conversation_id: item.conversation_id,
        display_name: name,
        expected_revision: policy.revision,
        min_interval_seconds: policy.min_interval_seconds,
        max_wait_seconds: policy.max_wait_seconds
      });
      const updated = saved && saved.policy;
      if (!updated) fail('策略更新没有返回会话信息。');
      return {
        conversation_key: item.conversation_key,
        platform: item.platform,
        account_id: item.account_id,
        conversation_type: item.conversation_type,
        conversation_id: item.conversation_id,
        user_alias: null,
        manual_display_name: name,
        label_source: 'policy',
        display_name: name,
        revision: updated.revision,
        updated_at: updated.updated_at
      };
    }
    if (!current || !Number.isInteger(current.revision)) fail('会话备注缺少版本号，无法安全更新。');
    return await client.backend(path(item), 'PATCH', {
      expected_revision: current.revision,
      user_alias: name
    });
  }

  const personLabel = item => {
    const id=text(item?.sender_id)||text(item?.sender);
    for(const value of [item?.sender_name,item?.card,item?.nickname]){
      const name=text(value);if(name&&name!==id)return name;
    }
    return '未获取昵称';
  };
  const personIdentity = item => {
    const id=text(item?.sender_id)||text(item?.sender);
    return id ? (/^[0-9]+$/.test(id)?'QQ ':'人物 ID ')+id : '人物标识未知';
  };
  window.LkaMessageNames = {label, rename, personLabel, personIdentity};
}());
