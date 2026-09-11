'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const switchModule = require('../../cloudfunctions/switchDemoMiniProgramIdentity/index.js');

const trustedContext = { OPENID: 'demo-trusted-openid', APPID: 'wxe262970211858262' };

const DISABLED_RESPONSE = Object.freeze({
  ok: false,
  code: 'SWITCH_DISABLED',
  message: '身份切换功能已停用',
});

test('0. 真实 main 对空输入固定 fail closed，且不触发历史数据库路径', async () => {
  assert.deepEqual(await switchModule.main(), DISABLED_RESPONSE);
  const source = fs.readFileSync(path.join(__dirname, '../../cloudfunctions/switchDemoMiniProgramIdentity/index.js'), 'utf8');
  const mainAssignment = source.match(/exports\.main\s*=\s*createDisabledHandler\(\);/);
  assert.ok(mainAssignment);
  assert.equal(mainAssignment[0].includes('createDefaultHandler'), false);
});

test('0. 真实 main 传 student 仍固定拒绝', async () => {
  assert.deepEqual(await switchModule.main({ targetRole: 'student' }), DISABLED_RESPONSE);
});

test('0. 真实 main 传 counselor 仍固定拒绝', async () => {
  assert.deepEqual(await switchModule.main({ targetRole: 'counselor' }), DISABLED_RESPONSE);
});

test('0. 真实 main 忽略伪造身份字段且不读取输入', async () => {
  const poisonedEvent = new Proxy({ userId: 'usr_attacker', role: 'security', openid: 'spoofed-openid' }, {
    get() { throw new Error('disabled main must not read event fields'); },
    ownKeys() { throw new Error('disabled main must not enumerate event fields'); },
  });
  assert.deepEqual(await switchModule.main(poisonedEvent), DISABLED_RESPONSE);
});

test('0. 小程序全目录不保留 switch 云函数调用、targetRole 或身份切换入口', () => {
  const miniProgramRoot = path.join(__dirname, '../../miniprogram');
  const sourceFiles = [];
  const collect = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(entryPath);
      else if (/\.(?:js|json|wxml|wxss)$/.test(entry.name)) sourceFiles.push(entryPath);
    }
  };
  collect(miniProgramRoot);
  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(source.includes('switchDemoMiniProgramIdentity'), false, file);
    assert.equal(source.includes('targetRole'), false, file);
    assert.equal(source.includes('切换身份'), false, file);
    assert.equal(source.includes('切换演示身份'), false, file);
  }
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function baseStudent(overrides = {}) {
  return {
    _id: 'usr_student_demo_001',
    role: 'student',
    name: '演示学生',
    collegeId: 'college_cs',
    focusFlag: false,
    studentNo: '20260001',
    staffNo: null,
    mobile: '13800138000',
    status: 'active',
    bindStatus: 'bound',
    wxOpenId: trustedContext.OPENID,
    wxIdentityKey: `openid:${trustedContext.OPENID}`,
    version: 3,
    ...overrides,
  };
}

function baseCounselor(overrides = {}) {
  return {
    _id: 'usr_counselor_demo_001',
    role: 'counselor',
    name: '演示辅导员',
    collegeId: 'college_cs',
    focusFlag: false,
    studentNo: null,
    staffNo: 'T0001',
    mobile: '13900139000',
    status: 'active',
    bindStatus: 'unbound',
    wxOpenId: null,
    wxIdentityKey: 'unbound:usr_counselor_demo_001',
    version: 7,
    ...overrides,
  };
}

function activeCounselorUsers() {
  return [
    baseStudent({ bindStatus: 'unbound', wxOpenId: null, wxIdentityKey: 'unbound:usr_student_demo_001' }),
    baseCounselor({ bindStatus: 'bound', wxOpenId: trustedContext.OPENID, wxIdentityKey: `openid:${trustedContext.OPENID}` }),
  ];
}

function matches(document, query) {
  return Object.entries(query).every(([key, value]) => document[key] === value);
}

function createMockDb(users, options = {}) {
  const state = {
    users: clone(users),
    audits: [],
    transactionCalls: 0,
    transactionDocReads: [],
    conditionalUpdates: [],
  };
  const collection = (name, transactional = false) => ({
    where(query) {
      return {
        limit(limit) {
          return {
            get: async () => ({
              data: (name === 'users' ? state.users : []).filter((user) => matches(user, query)).slice(0, limit).map(clone),
            }),
          };
        },
        async update({ data }) {
          state.conditionalUpdates.push({ collection: name, query: clone(query), data: clone(data) });
          if (!transactional || name !== 'users') throw new Error('unexpected non-transactional update');
          if (options.sourceUpdateThrow && query._id === 'usr_student_demo_001') throw new Error('storage unavailable');
          if (options.sourceUpdateZero && query._id === 'usr_student_demo_001') return { stats: { updated: 0 } };
          if (options.targetUpdateZero && query._id === 'usr_counselor_demo_001') return { stats: { updated: 0 } };
          const documents = state.users.filter((user) => matches(user, query));
          documents.forEach((user) => Object.assign(user, data));
          return { stats: { updated: documents.length } };
        },
      };
    },
    doc(id) {
      return {
        get: async () => {
          if (transactional) state.transactionDocReads.push(id);
          return { data: clone((name === 'users' ? state.users : []).find((user) => user._id === id)) };
        },
      };
    },
    async add({ data }) {
      if (name !== 'audit_logs') throw new Error(`unexpected write to ${name}`);
      if (options.auditFailure) throw new Error('audit unavailable');
      state.audits.push(clone(data));
      return { id: data._id };
    },
  });
  const db = {
    collection: (name) => collection(name, false),
    runTransaction: async (callback) => {
      state.transactionCalls += 1;
      if (typeof options.beforeTransaction === 'function') options.beforeTransaction(state);
      const snapshot = clone({ users: state.users, audits: state.audits, conditionalUpdates: state.conditionalUpdates });
      try {
        return await callback({ collection: (name) => collection(name, true) });
      } catch (error) {
        state.users.splice(0, state.users.length, ...snapshot.users);
        state.audits.splice(0, state.audits.length, ...snapshot.audits);
        state.conditionalUpdates.splice(0, state.conditionalUpdates.length, ...snapshot.conditionalUpdates);
        throw error;
      }
    },
  };
  return { db, state };
}

function makeSwitch({ users = [baseStudent(), baseCounselor()], wxContext = trustedContext, bindingMode = 'demo', switchEnabled = 'true', ...options } = {}) {
  const mock = createMockDb(users, options);
  const logs = [];
  let dateSequence = 0;
  let auditSequence = 0;
  const handler = switchModule.__testables.createHandler({
    db: mock.db,
    getWXContext: () => wxContext,
    bindingMode: () => bindingMode,
    switchEnabled: () => switchEnabled,
    serverDate: () => ({ $serverDate: ++dateSequence }),
    logger: { error: (entry) => logs.push(entry) },
    createRequestId: () => 'req-demo-switch',
    createAuditId: () => `audit_demo_switch_${++auditSequence}`,
  });
  return { ...mock, handler, logs };
}

test('1. demo 模式未开启时返回 SWITCH_DISABLED 且零写入', async () => {
  const { handler, state } = makeSwitch({ bindingMode: 'production' });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'SWITCH_DISABLED');
  assert.equal(state.transactionCalls, 0);
  assert.equal(state.audits.length, 0);
});

test('2. 两个开关只开一个时均返回 SWITCH_DISABLED', async () => {
  for (const config of [{ bindingMode: 'demo', switchEnabled: 'false' }, { bindingMode: 'other', switchEnabled: 'true' }]) {
    const { handler, state } = makeSwitch(config);
    assert.equal((await handler({ targetRole: 'counselor' })).code, 'SWITCH_DISABLED');
    assert.equal(state.transactionCalls, 0);
  }
});

test('3. targetRole 非法时返回 INVALID_INPUT', async () => {
  const { handler } = makeSwitch();
  for (const event of [{}, { targetRole: 'security' }, { targetRole: ' counselor ' }, null, []]) {
    assert.equal((await handler(event)).code, 'INVALID_INPUT');
  }
});

test('4. 任何多余字段均返回 INVALID_INPUT', async () => {
  const { handler } = makeSwitch();
  for (const key of ['targetUserId', 'userId', 'OPENID', 'wxOpenId', 'role', 'collegeId', 'actorId']) {
    assert.equal((await handler({ targetRole: 'counselor', [key]: 'spoofed' })).code, 'INVALID_INPUT');
  }
});

test('5. 错误 APPID 返回 FORBIDDEN', async () => {
  const { handler } = makeSwitch({ wxContext: { ...trustedContext, APPID: 'wrong-appid' } });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'FORBIDDEN');
});

test('6. 无 OPENID 返回 INTERNAL_ERROR', async () => {
  const { handler } = makeSwitch({ wxContext: { APPID: trustedContext.APPID } });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'INTERNAL_ERROR');
});

test('7. 当前 OPENID 无绑定时返回 UNBOUND', async () => {
  const { handler } = makeSwitch({ users: [baseStudent({ wxOpenId: null, wxIdentityKey: 'unbound:usr_student_demo_001', bindStatus: 'unbound' }), baseCounselor()] });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'UNBOUND');
});

test('8. 非固定 demo 账号不能取得切换能力且审计保留真实学院', async () => {
  const attacker = baseStudent({ _id: 'usr_attacker', collegeId: 'college_other', wxIdentityKey: `openid:${trustedContext.OPENID}`, wxOpenId: trustedContext.OPENID });
  const { handler, state } = makeSwitch({ users: [attacker, baseCounselor()] });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'FORBIDDEN');
  assert.equal(state.audits[0].result, 'failure');
  assert.equal(state.audits[0].actorId, 'usr_attacker');
  assert.equal(state.audits[0].actorCollegeId, 'college_other');
});

test('9. student 可原子切换为 counselor，平台注入字段被忽略', async () => {
  const { handler, state } = makeSwitch();
  const response = await handler({ targetRole: 'counselor', userInfo: { OPENID: 'spoofed' }, tcbContext: { OPENID: 'spoofed' } });
  assert.equal(response.code, 'IDENTITY_SWITCHED');
  assert.equal(response.profile.role, 'counselor');
  assert.equal(state.transactionCalls, 1);
});

test('10. counselor 可原子切换为 student', async () => {
  const { handler } = makeSwitch({ users: activeCounselorUsers() });
  const response = await handler({ targetRole: 'student' });
  assert.equal(response.code, 'IDENTITY_SWITCHED');
  assert.equal(response.profile.role, 'student');
});

test('11. 已是目标身份返回 ALREADY_ACTIVE 且零写入', async () => {
  const { handler, state } = makeSwitch();
  const response = await handler({ targetRole: 'student' });
  assert.equal(response.code, 'ALREADY_ACTIVE');
  assert.equal(state.transactionCalls, 0);
  assert.equal(state.conditionalUpdates.length, 0);
  assert.equal(state.audits.length, 0);
});

test('12. 目标用户不存在时安全失败', async () => {
  const { handler, state } = makeSwitch({ users: [baseStudent()] });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'NOT_FOUND');
  assert.equal(state.audits[0].result, 'failure');
});

test('13. 目标角色异常时安全失败', async () => {
  const { handler } = makeSwitch({ users: [baseStudent(), baseCounselor({ role: 'student' })] });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'INTERNAL_ERROR');
});

test('14. 目标 inactive 时拒绝', async () => {
  const { handler } = makeSwitch({ users: [baseStudent(), baseCounselor({ status: 'disabled' })] });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'ACCOUNT_DISABLED');
});

test('15. 目标学院异常时安全失败', async () => {
  const { handler } = makeSwitch({ users: [baseStudent(), baseCounselor({ collegeId: 'college_other' })] });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'INTERNAL_ERROR');
});

test('16. 目标并非 unbound 时返回 CONFLICT', async () => {
  const { handler } = makeSwitch({ users: [baseStudent(), baseCounselor({ bindStatus: 'bound', wxOpenId: 'other', wxIdentityKey: 'openid:other' })] });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'CONFLICT');
});

test('17. 当前绑定一致性异常时拒绝并审计失败', async () => {
  const { handler, state } = makeSwitch({ users: [baseStudent({ wxOpenId: 'other-openid' }), baseCounselor()] });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'INTERNAL_ERROR');
  assert.equal(state.audits[0].failureReason, 'INTERNAL_ERROR');
});

test('18. 事务内重新 doc 读取当前与目标用户', async () => {
  const { handler, state } = makeSwitch();
  await handler({ targetRole: 'counselor' });
  assert.deepEqual(state.transactionDocReads, ['usr_student_demo_001', 'usr_counselor_demo_001']);
});

test('19. source version 冲突时不发生半完成切换', async () => {
  const { handler, state } = makeSwitch({ beforeTransaction: (currentState) => { currentState.users[0].version += 1; } });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'CONFLICT');
  assert.equal(state.users[0].bindStatus, 'bound');
  assert.equal(state.users[1].bindStatus, 'unbound');
  assert.equal(state.audits.length, 0);
});

test('20. target version 冲突时不发生半完成切换', async () => {
  const { handler, state } = makeSwitch({ beforeTransaction: (currentState) => { currentState.users[1].version += 1; } });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'CONFLICT');
  assert.equal(state.users[0].bindStatus, 'bound');
  assert.equal(state.users[1].bindStatus, 'unbound');
  assert.equal(state.audits.length, 0);
});

test('21. source 条件更新失败时整体回滚', async () => {
  const { handler, state } = makeSwitch({ sourceUpdateZero: true });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'CONFLICT');
  assert.equal(state.users[0].bindStatus, 'bound');
  assert.equal(state.users[1].bindStatus, 'unbound');
});

test('22. target 条件更新失败时整体回滚', async () => {
  const { handler, state } = makeSwitch({ targetUpdateZero: true });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'CONFLICT');
  assert.equal(state.users[0].bindStatus, 'bound');
  assert.equal(state.users[1].bindStatus, 'unbound');
  assert.equal(state.audits.length, 0);
});

test('23. 成功后 source 变为严格 unbound 状态', async () => {
  const { handler, state } = makeSwitch();
  await handler({ targetRole: 'counselor' });
  assert.deepEqual({ bindStatus: state.users[0].bindStatus, wxOpenId: state.users[0].wxOpenId, wxIdentityKey: state.users[0].wxIdentityKey },
    { bindStatus: 'unbound', wxOpenId: null, wxIdentityKey: 'unbound:usr_student_demo_001' });
});

test('24. 成功后 target 变为严格 bound 状态', async () => {
  const { handler, state } = makeSwitch();
  await handler({ targetRole: 'counselor' });
  assert.deepEqual({ bindStatus: state.users[1].bindStatus, wxOpenId: state.users[1].wxOpenId, wxIdentityKey: state.users[1].wxIdentityKey },
    { bindStatus: 'bound', wxOpenId: trustedContext.OPENID, wxIdentityKey: `openid:${trustedContext.OPENID}` });
});

test('25. 成功切换时两边 version 均加一', async () => {
  const { handler, state } = makeSwitch();
  await handler({ targetRole: 'counselor' });
  assert.equal(state.users[0].version, 4);
  assert.equal(state.users[1].version, 8);
});

test('26. 两个 users.updatedAt 都来自 serverDate', async () => {
  const { handler, state } = makeSwitch();
  await handler({ targetRole: 'counselor' });
  assert.deepEqual(state.users[0].updatedAt, { $serverDate: 1 });
  assert.deepEqual(state.users[1].updatedAt, { $serverDate: 2 });
});

test('27. 成功后 OPENID 只存在于目标用户', async () => {
  const { handler, state } = makeSwitch();
  await handler({ targetRole: 'counselor' });
  assert.deepEqual(state.users.filter((user) => user.wxOpenId === trustedContext.OPENID).map((user) => user._id), ['usr_counselor_demo_001']);
});

test('28. wxIdentityKey 唯一键随身份原子迁移', async () => {
  const { handler, state } = makeSwitch();
  await handler({ targetRole: 'counselor' });
  assert.deepEqual(state.users.filter((user) => user.wxIdentityKey === `openid:${trustedContext.OPENID}`).map((user) => user._id), ['usr_counselor_demo_001']);
});

test('29. 成功仅写一条 identity.demo_switch 审计', async () => {
  const { handler, state } = makeSwitch();
  await handler({ targetRole: 'counselor' });
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].action, 'identity.demo_switch');
});

test('30. 成功审计 actor 是切换前的可信身份', async () => {
  const { handler, state } = makeSwitch();
  await handler({ targetRole: 'counselor' });
  assert.deepEqual({ actorId: state.audits[0].actorId, actorRole: state.audits[0].actorRole, actorCollegeId: state.audits[0].actorCollegeId },
    { actorId: 'usr_student_demo_001', actorRole: 'student', actorCollegeId: 'college_cs' });
});

test('31. 审计 before 和 after 摘要只包含 activeRole', async () => {
  const { handler, state } = makeSwitch();
  await handler({ targetRole: 'counselor' });
  assert.deepEqual(state.audits[0].beforeSummary, { activeRole: 'student' });
  assert.deepEqual(state.audits[0].afterSummary, { activeRole: 'counselor' });
});

test('32. 审计不含 OPENID、姓名、学号或工号', async () => {
  const { handler, state } = makeSwitch();
  await handler({ targetRole: 'counselor' });
  const serialized = JSON.stringify(state.audits[0]);
  for (const secret of [trustedContext.OPENID, 'wxOpenId', 'wxIdentityKey', '演示学生', '演示辅导员', '20260001', 'T0001', '13800138000']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('33. 返回 profile 不含身份或版本敏感字段', async () => {
  const { handler } = makeSwitch();
  const response = await handler({ targetRole: 'counselor' });
  assert.deepEqual(Object.keys(response.profile).sort(), ['collegeId', 'focusFlag', 'name', 'role', 'userId']);
  const serialized = JSON.stringify(response.profile);
  for (const secret of ['wxOpenId', 'wxIdentityKey', 'identityKey', 'studentNo', 'staffNo', 'version', trustedContext.OPENID]) assert.equal(serialized.includes(secret), false, secret);
});

test('34. 运行日志只保留安全字段', async () => {
  const { handler, logs } = makeSwitch({ sourceUpdateThrow: true });
  await handler({ targetRole: 'counselor', userInfo: { OPENID: 'spoofed' } });
  assert.deepEqual(Object.keys(logs[0]).sort(), ['code', 'requestId', 'resourceId', 'stage']);
  const serialized = JSON.stringify(logs[0]);
  for (const secret of [trustedContext.OPENID, 'spoofed', '演示学生', '20260001']) assert.equal(serialized.includes(secret), false, secret);
});

test('35. 默认 handler 固定使用 TARGET_ENV_ID', () => {
  const environments = [];
  const cloud = {
    init: ({ env }) => environments.push(env),
    database: () => ({ serverDate: () => ({}), collection: () => ({}), runTransaction: async () => ({}) }),
    getWXContext: () => trustedContext,
  };
  switchModule.__testables.createDefaultHandler(cloud);
  assert.deepEqual(environments, ['aa-d4gvb4o3t50fc94f8']);
});

test('36. 成功审计写入失败时两个用户更新整体回滚', async () => {
  const { handler, state } = makeSwitch({ auditFailure: true });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'INTERNAL_ERROR');
  assert.equal(state.users[0].bindStatus, 'bound');
  assert.equal(state.users[1].bindStatus, 'unbound');
  assert.equal(state.audits.length, 0);
});

test('37. 可信 security 用户被拒绝时失败审计学院为 null', async () => {
  const security = baseStudent({
    _id: 'usr_security_other',
    role: 'security',
    collegeId: 'college_other',
    wxIdentityKey: `openid:${trustedContext.OPENID}`,
    wxOpenId: trustedContext.OPENID,
  });
  const { handler, state } = makeSwitch({ users: [security, baseCounselor()] });
  assert.equal((await handler({ targetRole: 'counselor' })).code, 'FORBIDDEN');
  assert.equal(state.audits[0].actorId, 'usr_security_other');
  assert.equal(state.audits[0].actorCollegeId, null);
});
