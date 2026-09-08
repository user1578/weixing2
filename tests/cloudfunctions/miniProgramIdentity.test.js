'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const session = require('../../cloudfunctions/getMiniProgramSession');
const binding = require('../../cloudfunctions/bindMiniProgramIdentity');

function baseUser(overrides = {}) {
  return {
    _id: 'usr_student_001',
    identityKey: 'student:20230001',
    wxIdentityKey: 'unbound:usr_student_001',
    role: 'student',
    name: '张三',
    collegeId: 'college_cs',
    studentNo: '20230001',
    staffNo: null,
    wxOpenId: null,
    bindStatus: 'unbound',
    status: 'active',
    focusFlag: false,
    version: 1,
    ...overrides,
  };
}

function createMockDb(users = [], options = {}) {
  const state = {
    users: users.map((user) => ({ ...user })),
    audits: [],
    transactionCalls: 0,
    conditionalUpdates: [],
  };
  const clone = (value) => (value ? { ...value } : value);
  const matches = (document, query) => Object.entries(query).every(([key, value]) => document[key] === value);
  const readCollection = (collection, transaction) => ({
    where(query) {
      return {
        limit() {
          return {
            async get() {
              const documents = collection === 'users' ? state.users.filter((user) => matches(user, query)).map(clone) : [];
              return { data: documents.slice(0, 1) };
            },
          };
        },
        async update({ data }) {
          state.conditionalUpdates.push({ collection, query: { ...query }, data: { ...data } });
          if (options.uniqueConflict) {
            throw new Error('E11000 duplicate key');
          }
          if (options.conditionUpdateZero) {
            return { stats: { updated: 0 } };
          }
          const documents = collection === 'users'
            ? state.users.filter((user) => matches(user, query))
            : [];
          documents.forEach((document) => Object.assign(document, data));
          return { stats: { updated: documents.length } };
        },
      };
    },
    doc(id) {
      return {
        async get() {
          const document = transaction && options.transactionReadUser && options.transactionReadUser._id === id
            ? options.transactionReadUser
            : state.users.find((user) => user._id === id);
          return { data: clone(document) };
        },
        async update({ data }) {
          if (options.uniqueConflict) {
            throw new Error('E11000 duplicate key');
          }
          const target = state.users.find((user) => user._id === id);
          Object.assign(target, data);
          return { updated: 1 };
        },
      };
    },
    async add({ data }) {
      if (options.auditFailure) {
        throw new Error('audit unavailable');
      }
      state.audits.push({ ...data });
      return { id: data._id };
    },
  });
  const db = {
    collection(name) {
      return readCollection(name, false);
    },
    async runTransaction(callback) {
      state.transactionCalls += 1;
      if (options.transactionConflict) {
        throw new Error('transaction conflict');
      }
      const usersBefore = state.users.map(clone);
      const auditsBefore = state.audits.map(clone);
      try {
        return await callback({ collection: (name) => readCollection(name, true) });
      } catch (error) {
        state.users.splice(0, state.users.length, ...usersBefore);
        state.audits.splice(0, state.audits.length, ...auditsBefore);
        throw error;
      }
    },
  };
  return { db, state };
}

function makeSession(users, wxContext, options = {}) {
  const { db, state } = createMockDb(users, options);
  const logs = [];
  return {
    state,
    logs,
    handler: session.__testables.createHandler({
      db,
      getWXContext: () => wxContext,
      serverDate: () => ({ $serverDate: true }),
      logger: { error: (entry) => logs.push(entry) },
      createRequestId: () => 'req-session',
      createAuditId: () => 'audit_session_001',
    }),
  };
}

function makeBinding(users, wxContext, options = {}) {
  const mock = createMockDb(users, options);
  const logs = [];
  return {
    ...mock,
    logs,
    handler: binding.__testables.createHandler({
      db: mock.db,
      getWXContext: () => wxContext,
      bindingMode: () => options.mode === undefined ? 'demo' : options.mode,
      serverDate: () => ({ $serverDate: true }),
      createRequestId: () => 'req-bind',
      createAuditId: () => 'audit_test_001',
      logger: { error: (entry) => logs.push(entry) },
    }),
  };
}

const trustedContext = { OPENID: 'trusted-openid', APPID: 'wxe262970211858262' };

test('1. 无匹配用户返回 UNBOUND', async () => {
  const { handler } = makeSession([], trustedContext);
  assert.deepEqual(await handler({ openid: 'spoofed' }), { ok: true, code: 'UNBOUND', needsBinding: true });
});

test('2. 已绑定 student 返回 BOUND', async () => {
  const user = baseUser({ wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler } = makeSession([user], trustedContext);
  assert.equal((await handler()).code, 'BOUND');
});

test('3. 已绑定 counselor 返回 BOUND', async () => {
  const user = baseUser({ _id: 'usr_counselor_001', role: 'counselor', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler } = makeSession([user], trustedContext);
  assert.equal((await handler()).code, 'BOUND');
});

test('4. security 账号不能作为小程序用户登录', async () => {
  const user = baseUser({ role: 'security', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler } = makeSession([user], trustedContext);
  assert.equal((await handler()).code, 'FORBIDDEN');
});

test('5. suspended 用户返回 ACCOUNT_DISABLED', async () => {
  const user = baseUser({ status: 'suspended', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler } = makeSession([user], trustedContext);
  assert.equal((await handler()).code, 'ACCOUNT_DISABLED');
});

test('6. 会话响应不泄露敏感字段', async () => {
  const user = baseUser({ wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound', passwordHash: 'secret', mobile: '13800138000' });
  const { handler } = makeSession([user], trustedContext);
  const response = await handler();
  assert.equal(JSON.stringify(response).includes('trusted-openid'), false);
  assert.equal(JSON.stringify(response).includes('passwordHash'), false);
  assert.equal(JSON.stringify(response).includes('13800138000'), false);
});

test('7. APPID 不匹配返回 FORBIDDEN', async () => {
  const { handler } = makeSession([], { OPENID: 'trusted-openid', APPID: 'wrong-appid' });
  assert.equal((await handler()).code, 'FORBIDDEN');
});

test('8. 不一致绑定状态返回 INTERNAL_ERROR，不能降级为 UNBOUND', async () => {
  const user = baseUser({ wxIdentityKey: 'openid:trusted-openid', wxOpenId: null, bindStatus: 'unbound' });
  const { handler } = makeSession([user], trustedContext);
  assert.equal((await handler()).code, 'INTERNAL_ERROR');
});

test('9. 会话命中 wxIdentityKey 但 wxOpenId 不一致时返回 INTERNAL_ERROR', async () => {
  const user = baseUser({ wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'other-openid', bindStatus: 'bound' });
  const { handler } = makeSession([user], trustedContext);
  assert.equal((await handler()).code, 'INTERNAL_ERROR');
});

test('10. demo 模式未开启时拒绝绑定', async () => {
  const { handler } = makeBinding([], trustedContext, { mode: 'production' });
  assert.equal((await handler({})).code, 'BINDING_DISABLED');
});

test('11. 非法 role 返回 INVALID_INPUT', async () => {
  const { handler } = makeBinding([], trustedContext);
  assert.equal((await handler({ role: 'security', identityNo: '1', name: '张三' })).code, 'INVALID_INPUT');
});

test('12. 空 identityNo 返回 INVALID_INPUT', async () => {
  const { handler } = makeBinding([], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: ' ', name: '张三' })).code, 'INVALID_INPUT');
});

test('13. 空 name 返回 INVALID_INPUT', async () => {
  const { handler } = makeBinding([], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: ' ' })).code, 'INVALID_INPUT');
});

test('14. 未找到身份档案返回 IDENTITY_NOT_FOUND', async () => {
  const { handler } = makeBinding([], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'IDENTITY_NOT_FOUND');
});

test('15. 姓名不精确匹配返回 IDENTITY_MISMATCH', async () => {
  const { handler } = makeBinding([baseUser()], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '李四' })).code, 'IDENTITY_MISMATCH');
});

test('16. 停用身份档案返回 ACCOUNT_DISABLED', async () => {
  const { handler } = makeBinding([baseUser({ status: 'suspended' })], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'ACCOUNT_DISABLED');
});

test('17. 已被其他微信绑定的目标返回 ACCOUNT_ALREADY_BOUND', async () => {
  const { handler } = makeBinding([baseUser({ bindStatus: 'bound', wxOpenId: 'other-openid', wxIdentityKey: 'openid:other-openid' })], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'ACCOUNT_ALREADY_BOUND');
});

test('18. 当前微信已有合法绑定返回 ALREADY_BOUND', async () => {
  const user = baseUser({ wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler } = makeBinding([user], trustedContext);
  const response = await handler({ role: 'student', identityNo: '20230001', name: '张三' });
  assert.equal(response.code, 'ALREADY_BOUND');
  assert.equal(response.profile.userId, user._id);
});

test('19. 正常 student 绑定在同一事务写入用户与审计', async () => {
  const { handler, state } = makeBinding([baseUser()], trustedContext);
  const response = await handler({ role: 'student', identityNo: ' 20230001 ', name: ' 张三 ' });
  assert.equal(response.code, 'BOUND');
  assert.equal(state.transactionCalls, 1);
  assert.equal(state.users[0].bindStatus, 'bound');
  assert.equal(state.users[0].version, 2);
  assert.equal(state.audits.length, 1);
  assert.deepEqual(state.conditionalUpdates[0].query, {
    _id: 'usr_student_001',
    version: 1,
    bindStatus: 'unbound',
    wxOpenId: null,
    wxIdentityKey: 'unbound:usr_student_001',
  });
});

test('20. 正常 counselor 绑定', async () => {
  const counselor = baseUser({ _id: 'usr_counselor_001', identityKey: 'counselor:T001', role: 'counselor', staffNo: 'T001', studentNo: null, wxIdentityKey: 'unbound:usr_counselor_001', name: '王老师' });
  const { handler } = makeBinding([counselor], trustedContext);
  assert.equal((await handler({ role: 'counselor', identityNo: 'T001', name: '王老师' })).code, 'BOUND');
});

test('21. 事务冲突返回 CONFLICT', async () => {
  const { handler } = makeBinding([baseUser()], trustedContext, { transactionConflict: true });
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'CONFLICT');
});

test('22. wxIdentityKey UNIQUE 冲突返回 WECHAT_ALREADY_BOUND', async () => {
  const { handler } = makeBinding([baseUser()], trustedContext, { uniqueConflict: true });
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'WECHAT_ALREADY_BOUND');
});

test('23. OPENID 只取服务端上下文，忽略 event.openid', async () => {
  const { handler, state } = makeBinding([baseUser()], trustedContext);
  const response = await handler({ role: 'student', identityNo: '20230001', name: '张三', openid: 'spoofed' });
  assert.equal(response.code, 'INVALID_INPUT');
  assert.equal(state.users[0].wxOpenId, null);
});

test('24. 审计 payload 不含 OPENID 等敏感字段', async () => {
  const { handler, state } = makeBinding([baseUser()], trustedContext);
  await handler({ role: 'student', identityNo: '20230001', name: '张三' });
  const auditJson = JSON.stringify(state.audits[0]);
  assert.equal(auditJson.includes('trusted-openid'), false);
  assert.equal(auditJson.includes('identityKey'), false);
  assert.equal(auditJson.includes('wxOpenId'), false);
  assert.equal(auditJson.includes('studentNo'), false);
});

test('25. 审计失败使绑定事务返回 INTERNAL_ERROR', async () => {
  const { handler, state } = makeBinding([baseUser()], trustedContext, { auditFailure: true });
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'INTERNAL_ERROR');
  assert.equal(state.transactionCalls, 1);
  assert.equal(state.users[0].bindStatus, 'unbound');
  assert.equal(state.audits.length, 0);
});

test('26. existing binding 命中当前微信但 wxOpenId 不一致时返回 INTERNAL_ERROR', async () => {
  const user = baseUser({ wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'other-openid', bindStatus: 'bound' });
  const { handler } = makeBinding([user], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'INTERNAL_ERROR');
});

test('27. bound 但 wxOpenId 为 null 的目标档案返回 CONFLICT', async () => {
  const user = baseUser({ bindStatus: 'bound', wxOpenId: null, wxIdentityKey: 'unbound:usr_student_001' });
  const { handler } = makeBinding([user], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'CONFLICT');
});

test('28. bound 但 wxIdentityKey 与 wxOpenId 不一致的目标档案返回 CONFLICT', async () => {
  const user = baseUser({ bindStatus: 'bound', wxOpenId: 'other-openid', wxIdentityKey: 'openid:not-the-same' });
  const { handler } = makeBinding([user], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'CONFLICT');
});

test('29. 事务内重新读取到 version drift 时返回 CONFLICT', async () => {
  const { handler, state } = makeBinding([baseUser()], trustedContext, {
    transactionReadUser: baseUser({ version: 2 }),
  });
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'CONFLICT');
  assert.equal(state.conditionalUpdates.length, 0);
});

test('30. 条件更新影响行数为零时返回 CONFLICT', async () => {
  const { handler, state } = makeBinding([baseUser()], trustedContext, { conditionUpdateZero: true });
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'CONFLICT');
  assert.equal(state.audits.length, 0);
});

test('31. bind APPID 不匹配返回 FORBIDDEN', async () => {
  const { handler } = makeBinding([baseUser()], { OPENID: 'trusted-openid', APPID: 'wrong-appid' });
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'FORBIDDEN');
});

test('32. 两个默认 handler 都固定使用 TARGET_ENV_ID', () => {
  const mock = createMockDb();
  const sessionCalls = [];
  const bindCalls = [];
  const sessionCloud = {
    init: (options) => sessionCalls.push(options),
    database: () => mock.db,
    getWXContext: () => trustedContext,
  };
  const bindCloud = {
    init: (options) => bindCalls.push(options),
    database: () => mock.db,
    getWXContext: () => trustedContext,
  };

  session.__testables.createDefaultHandler(sessionCloud);
  binding.__testables.createDefaultHandler(bindCloud);

  assert.deepEqual(sessionCalls, [{ env: session.__testables.TARGET_ENV_ID }]);
  assert.deepEqual(bindCalls, [{ env: binding.__testables.TARGET_ENV_ID }]);
  assert.equal(session.__testables.TARGET_ENV_ID, 'aa-d4gvb4o3t50fc94f8');
  assert.equal(binding.__testables.TARGET_ENV_ID, 'aa-d4gvb4o3t50fc94f8');
});

test('33. 可信 security session 失败写审计', async () => {
  const user = baseUser({ role: 'security', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler, state } = makeSession([user], trustedContext);
  assert.equal((await handler()).code, 'FORBIDDEN');
  assert.deepEqual(state.audits[0], { _id: 'audit_session_001', actorId: user._id, actorRole: 'security', actorCollegeId: null, action: 'identity.session', resourceType: 'user', resourceId: user._id, result: 'failure', failureReason: 'FORBIDDEN', requestId: 'req-session', createdAt: { $serverDate: true } });
});

test('34. 可信未知角色 session 失败写审计', async () => {
  const user = baseUser({ role: 'other', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler, state } = makeSession([user], trustedContext);
  assert.equal((await handler()).code, 'FORBIDDEN');
  assert.equal(state.audits[0].failureReason, 'FORBIDDEN');
});

test('35. 可信 inactive session 失败写审计', async () => {
  const user = baseUser({ status: 'suspended', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler, state } = makeSession([user], trustedContext);
  assert.equal((await handler()).code, 'ACCOUNT_DISABLED');
  assert.equal(state.audits[0].failureReason, 'ACCOUNT_DISABLED');
});

test('36. 可信绑定一致性异常 session 写 INTERNAL_ERROR 审计', async () => {
  const user = baseUser({ wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'other-openid', bindStatus: 'bound' });
  const { handler, state } = makeSession([user], trustedContext);
  assert.equal((await handler()).code, 'INTERNAL_ERROR');
  assert.equal(state.audits[0].failureReason, 'INTERNAL_ERROR');
});

test('37. session failure audit 不含 OPENID、替身键或完整用户', async () => {
  const user = baseUser({ role: 'security', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler, state } = makeSession([user], trustedContext);
  await handler();
  const auditJson = JSON.stringify(state.audits[0]);
  for (const secret of ['trusted-openid', 'wxOpenId', 'wxIdentityKey', 'identityKey', 'studentNo', '张三']) assert.equal(auditJson.includes(secret), false);
  assert.equal(state.audits[0].failureReason, 'FORBIDDEN');
  assert.equal(state.audits[0].requestId, 'req-session');
});

test('38. session 必须审计路径的 audit 写失败时 fail closed', async () => {
  const user = baseUser({ role: 'security', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler, state, logs } = makeSession([user], trustedContext, { auditFailure: true });
  assert.equal((await handler()).code, 'INTERNAL_ERROR');
  assert.equal(state.audits.length, 0);
  assert.deepEqual(logs[0], { requestId: 'req-session', code: 'INTERNAL_ERROR', resourceId: user._id, stage: 'sessionRole' });
});

test('39. session AppID 不匹配不写 audit', async () => {
  const { handler, state } = makeSession([], { OPENID: 'trusted-openid', APPID: 'wrong-appid' });
  assert.equal((await handler()).code, 'FORBIDDEN');
  assert.equal(state.audits.length, 0);
});

test('40. session OPENID 缺失不写 audit', async () => {
  const { handler, state } = makeSession([], { APPID: 'wxe262970211858262' });
  assert.equal((await handler()).code, 'INTERNAL_ERROR');
  assert.equal(state.audits.length, 0);
});

test('41. session 无用户 UNBOUND 不写 audit', async () => {
  const { handler, state } = makeSession([], trustedContext);
  assert.equal((await handler()).code, 'UNBOUND');
  assert.equal(state.audits.length, 0);
});

test('42. 正常 BOUND session 仍只返回最小 profile 且不写成功审计', async () => {
  const user = baseUser({ wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound', passwordHash: 'secret', mobile: '13800138000' });
  const { handler, state } = makeSession([user], trustedContext);
  const response = await handler();
  assert.deepEqual(Object.keys(response.profile).sort(), ['collegeId', 'focusFlag', 'name', 'role', 'userId']);
  assert.equal(JSON.stringify(response).includes('trusted-openid'), false);
  assert.equal(state.audits.length, 0);
});

test('43. 成功绑定保留用户更新与 success audit 的同一事务', async () => {
  const { handler, state } = makeBinding([baseUser()], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'BOUND');
  assert.equal(state.transactionCalls, 1);
  assert.equal(state.audits[0].action, 'identity.bind');
  assert.equal(state.audits[0].result, 'success');
  assert.deepEqual(state.audits[0].afterSummary, { bindStatus: 'bound' });
  assert.equal(JSON.stringify(state.audits[0]).includes('trusted-openid'), false);
});

test('44. 成功绑定 success audit 写失败时事务回滚', async () => {
  const { handler, state } = makeBinding([baseUser()], trustedContext, { auditFailure: true });
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'INTERNAL_ERROR');
  assert.equal(state.users[0].bindStatus, 'unbound');
  assert.equal(state.audits.length, 0);
});

test('45. existingBinding 可信 security 失败写审计', async () => {
  const user = baseUser({ role: 'security', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler, state } = makeBinding([user], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'FORBIDDEN');
  assert.equal(state.audits[0].action, 'identity.bind');
  assert.equal(state.audits[0].failureReason, 'FORBIDDEN');
  assert.equal(state.audits[0].actorCollegeId, null);
});

test('46. existingBinding inactive 失败写审计', async () => {
  const user = baseUser({ status: 'suspended', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler, state } = makeBinding([user], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'ACCOUNT_DISABLED');
  assert.equal(state.audits[0].failureReason, 'ACCOUNT_DISABLED');
});

test('47. existingBinding 绑定一致性异常写 INTERNAL_ERROR 审计', async () => {
  const user = baseUser({ wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'other-openid', bindStatus: 'bound' });
  const { handler, state } = makeBinding([user], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'INTERNAL_ERROR');
  assert.equal(state.audits[0].failureReason, 'INTERNAL_ERROR');
});

test('48. existingBinding failure audit 写失败时 fail closed', async () => {
  const user = baseUser({ role: 'security', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const { handler, state, logs } = makeBinding([user], trustedContext, { auditFailure: true });
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'INTERNAL_ERROR');
  assert.equal(state.audits.length, 0);
  assert.deepEqual(logs[0], { requestId: 'req-bind', code: 'INTERNAL_ERROR', resourceId: user._id, stage: 'existingBindingAudit' });
});

test('49. 首次绑定 IDENTITY_NOT_FOUND 不伪造 actor audit', async () => {
  const { handler, state } = makeBinding([], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'IDENTITY_NOT_FOUND');
  assert.equal(state.audits.length, 0);
});

test('50. 首次绑定 IDENTITY_MISMATCH 不把目标档案作为 actor audit', async () => {
  const { handler, state } = makeBinding([baseUser()], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '李四' })).code, 'IDENTITY_MISMATCH');
  assert.equal(state.audits.length, 0);
});

test('51. 目标已被其他微信绑定不把目标档案作为 actor audit', async () => {
  const target = baseUser({ bindStatus: 'bound', wxOpenId: 'other-openid', wxIdentityKey: 'openid:other-openid' });
  const { handler, state } = makeBinding([target], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'ACCOUNT_ALREADY_BOUND');
  assert.equal(state.audits.length, 0);
});

test('52. bind AppID 不匹配不写 actor audit', async () => {
  const { handler, state } = makeBinding([baseUser()], { OPENID: 'trusted-openid', APPID: 'wrong-appid' });
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三' })).code, 'FORBIDDEN');
  assert.equal(state.audits.length, 0);
});

test('53. event 中伪造身份字段不能影响 trusted context', async () => {
  const { handler, state } = makeBinding([baseUser()], trustedContext);
  const response = await handler({ role: 'student', identityNo: '20230001', name: '张三', openid: 'spoofed', userId: 'usr_attacker', actorId: 'usr_attacker' });
  assert.equal(response.code, 'INVALID_INPUT');
  assert.equal(state.users[0].wxOpenId, null);
  assert.equal(state.audits.length, 0);
});

test('54. runtime logger payload 不含 OPENID 或完整 event', async () => {
  const sessionUser = baseUser({ role: 'security', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const sessionRun = makeSession([sessionUser], trustedContext, { auditFailure: true });
  await sessionRun.handler({ openid: 'spoofed' });
  const bindingUser = baseUser({ role: 'security', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const bindingRun = makeBinding([bindingUser], trustedContext, { auditFailure: true });
  await bindingRun.handler({ role: 'student', identityNo: '20230001', name: '张三' });
  for (const entry of [...sessionRun.logs, ...bindingRun.logs]) {
    assert.deepEqual(Object.keys(entry).sort(), ['code', 'requestId', 'resourceId', 'stage']);
    const runtimeJson = JSON.stringify(entry);
    for (const secret of ['trusted-openid', 'openid', 'wxOpenId', 'identityNo', '张三']) assert.equal(runtimeJson.includes(secret), false);
  }
});

test('55. 平台注入 userInfo 时仍可完成正常绑定', async () => {
  const { handler, state } = makeBinding([baseUser()], trustedContext);
  const response = await handler({ role: 'student', identityNo: '20230001', name: '张三', userInfo: { nickName: '平台资料' } });
  assert.equal(response.code, 'BOUND');
  assert.equal(state.users[0].wxOpenId, trustedContext.OPENID);
  assert.equal(state.audits.length, 1);
});

test('56. userInfo 内伪造 openId 不能影响 trusted getWXContext OPENID', async () => {
  const { handler, state } = makeBinding([baseUser()], trustedContext);
  const response = await handler({ role: 'student', identityNo: '20230001', name: '张三', userInfo: { openId: 'spoofed-openid', appId: 'wrong-appid' } });
  assert.equal(response.code, 'BOUND');
  assert.equal(state.users[0].wxOpenId, trustedContext.OPENID);
  assert.notEqual(state.users[0].wxOpenId, 'spoofed-openid');
});

test('57. event 额外 openid 仍返回 INVALID_INPUT', async () => {
  const { handler } = makeBinding([baseUser()], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三', openid: 'spoofed' })).code, 'INVALID_INPUT');
});

test('58. event 额外 userId 仍返回 INVALID_INPUT', async () => {
  const { handler } = makeBinding([baseUser()], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三', userId: 'usr_attacker' })).code, 'INVALID_INPUT');
});

test('59. event 额外 actorId 仍返回 INVALID_INPUT', async () => {
  const { handler } = makeBinding([baseUser()], trustedContext);
  assert.equal((await handler({ role: 'student', identityNo: '20230001', name: '张三', actorId: 'usr_attacker' })).code, 'INVALID_INPUT');
});

test('60. userInfo 及其 openId 不进入 audit 或 runtime logger', async () => {
  const userInfo = { openId: 'spoofed-openid', nickName: '平台资料' };
  const successRun = makeBinding([baseUser()], trustedContext);
  await successRun.handler({ role: 'student', identityNo: '20230001', name: '张三', userInfo });
  const auditJson = JSON.stringify(successRun.state.audits[0]);
  assert.equal(auditJson.includes('userInfo'), false);
  assert.equal(auditJson.includes('spoofed-openid'), false);

  const existingUser = baseUser({ role: 'security', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound' });
  const failureRun = makeBinding([existingUser], trustedContext, { auditFailure: true });
  await failureRun.handler({ role: 'student', identityNo: '20230001', name: '张三', userInfo });
  const runtimeJson = JSON.stringify(failureRun.logs[0]);
  assert.equal(runtimeJson.includes('userInfo'), false);
  assert.equal(runtimeJson.includes('spoofed-openid'), false);
});

test('61. 未知顶层字段返回 INVALID_INPUT 并记录最小脱敏诊断', async () => {
  const { handler, logs } = makeBinding([baseUser()], trustedContext);
  const response = await handler({ role: 'student', identityNo: '20230001', name: '张三', _platformField: '不应记录的值' });
  assert.equal(response.code, 'INVALID_INPUT');
  assert.deepEqual(logs, [{
    requestId: 'req-bind',
    code: 'INVALID_INPUT',
    stage: 'validateInputUnknownKeys',
    unknownEventKeys: ['_platformField'],
  }]);
  assert.deepEqual(Object.keys(logs[0]).sort(), ['code', 'requestId', 'stage', 'unknownEventKeys']);
});

test('62. 未知顶层字段诊断只包含排序后的字段名', async () => {
  const { handler, logs } = makeBinding([baseUser()], trustedContext);
  await handler({ role: 'student', identityNo: '20230001', name: '张三', zPlatformField: 'z', _platformField: 'a' });
  assert.deepEqual(logs[0].unknownEventKeys, ['_platformField', 'zPlatformField']);
});

test('63. 合法 userInfo 不触发未知顶层字段诊断', async () => {
  const { handler, logs } = makeBinding([baseUser()], trustedContext);
  const response = await handler({ role: 'student', identityNo: '20230001', name: '张三', userInfo: { nickName: '平台资料' } });
  assert.equal(response.code, 'BOUND');
  assert.deepEqual(logs, []);
});

test('64. 未知顶层字段诊断日志不包含任何输入或身份上下文值', async () => {
  const { handler, logs } = makeBinding([baseUser()], trustedContext);
  await handler({
    role: 'student',
    identityNo: '20230001',
    name: '张三',
    userInfo: { openId: 'spoofed-openid', nickName: '不应记录的 userInfo 内容' },
    _platformField: '不应记录的字段值',
  });
  const runtimeJson = JSON.stringify(logs[0]);
  for (const secret of ['张三', '20230001', 'trusted-openid', 'spoofed-openid', '不应记录的 userInfo 内容', '不应记录的字段值']) {
    assert.equal(runtimeJson.includes(secret), false);
  }
});
