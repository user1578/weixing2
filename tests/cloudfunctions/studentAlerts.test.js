const assert = require('node:assert/strict');
const test = require('node:test');

const listAlerts = require('../../cloudfunctions/getStudentAlerts');
const alertDetail = require('../../cloudfunctions/getStudentAlertDetail');

const trustedContext = { OPENID: 'trusted-openid', APPID: 'wxe262970211858262' };

function clone(value) {
  if (!value) return value;
  const copied = { ...value };
  if (Array.isArray(value.riskReasons)) copied.riskReasons = [...value.riskReasons];
  if (value.beforeSummary) copied.beforeSummary = { ...value.beforeSummary };
  if (value.afterSummary) copied.afterSummary = { ...value.afterSummary };
  return copied;
}

function baseStudent(overrides = {}) {
  return {
    _id: 'usr_student_001',
    wxIdentityKey: 'openid:trusted-openid',
    wxOpenId: 'trusted-openid',
    role: 'student',
    name: '张三',
    collegeId: 'college_cs',
    bindStatus: 'bound',
    status: 'active',
    version: 1,
    ...overrides,
  };
}

function baseAlert(overrides = {}) {
  return {
    _id: 'alert_001',
    sourceType: 'manual',
    sourceReference: '96110-sensitive-reference',
    studentId: 'usr_student_001',
    collegeId: 'college_cs',
    fraudType: 'part_time_scam',
    content: '请勿向陌生账号转账，谨防刷单返利诈骗。',
    riskLevel: 'high',
    riskReasons: ['repeat_alert_count>=3'],
    riskRuleId: 'rule_default',
    status: 'sent',
    issuedBy: 'usr_security_001',
    issuedAt: '2026-09-08T09:00:00.000Z',
    version: 1,
    createdAt: '2026-09-08T08:00:00.000Z',
    updatedAt: '2026-09-08T08:00:00.000Z',
    ...overrides,
  };
}

function matches(document, query) {
  return Object.entries(query).every(([key, value]) => document[key] === value);
}

function createMockDb(users = [], alerts = [], options = {}) {
  const state = {
    users: users.map(clone),
    alerts: alerts.map(clone),
    audits: [],
    queryTrace: [],
    conditionalUpdates: [],
    transactionCalls: 0,
  };
  let transactionQueue = Promise.resolve();

  const collectionDocuments = (name) => {
    if (name === 'users') return state.users;
    if (name === 'alerts') return state.alerts;
    return [];
  };

  const makeCollection = (name) => ({
    where(query) {
      const getDocuments = () => collectionDocuments(name).filter((document) => matches(document, query));
      const get = async (limit, orderBy) => {
        const documents = getDocuments().map(clone);
        if (orderBy) {
          const { field, direction } = orderBy;
          documents.sort((left, right) => {
            if (left[field] === right[field]) return 0;
            const comparison = left[field] > right[field] ? 1 : -1;
            return direction === 'desc' ? -comparison : comparison;
          });
        }
        state.queryTrace.push({ collection: name, query: { ...query }, limit, orderBy: orderBy ? { ...orderBy } : null });
        return { data: documents.slice(0, limit).map(clone) };
      };
      return {
        limit(limit) {
          return { get: () => get(limit, null) };
        },
        orderBy(field, direction) {
          return {
            limit(limit) {
              return { get: () => get(limit, { field, direction }) };
            },
          };
        },
        async update({ data }) {
          const documents = getDocuments();
          state.conditionalUpdates.push({ collection: name, query: { ...query }, data: { ...data } });
          if (options.conditionUpdateZero) {
            if (typeof options.onConditionUpdateZero === 'function') options.onConditionUpdateZero(state);
            return { stats: { updated: 0 } };
          }
          documents.forEach((document) => Object.assign(document, data));
          return { stats: { updated: documents.length } };
        },
      };
    },
    async add({ data }) {
      if (options.auditFailure) throw new Error('audit unavailable');
      if (name === 'audit_logs') state.audits.push(clone(data));
      return { id: data._id };
    },
  });

  const snapshot = () => ({
    users: state.users.map(clone),
    alerts: state.alerts.map(clone),
    audits: state.audits.map(clone),
  });
  const restore = (saved) => {
    state.users.splice(0, state.users.length, ...saved.users);
    state.alerts.splice(0, state.alerts.length, ...saved.alerts);
    state.audits.splice(0, state.audits.length, ...saved.audits);
  };

  const db = {
    collection: makeCollection,
    runTransaction(callback) {
      const transactionWork = transactionQueue.then(async () => {
        state.transactionCalls += 1;
        if (options.transactionConflict) {
          if (typeof options.onTransactionConflict === 'function') options.onTransactionConflict(state);
          throw new Error('transaction conflict');
        }
        const saved = snapshot();
        try {
          return await callback({ collection: makeCollection });
        } catch (error) {
          if (!options.preserveConflictMutation) restore(saved);
          throw error;
        }
      });
      transactionQueue = transactionWork.catch(() => undefined);
      return transactionWork;
    },
  };
  return { db, state };
}

function makeHandlers(users = [baseStudent()], alerts = [], wxContext = trustedContext, options = {}) {
  const mock = createMockDb(users, alerts, options);
  const logs = [];
  let auditSequence = 0;
  let dateSequence = 0;
  const dependencies = {
    db: mock.db,
    getWXContext: () => wxContext,
    serverDate: () => ({ $serverDate: ++dateSequence }),
    logger: { error: (entry) => logs.push(entry) },
    createRequestId: () => 'req-student-alert',
    createAuditId: () => `audit_student_alert_${++auditSequence}`,
  };
  return {
    ...mock,
    logs,
    listHandler: listAlerts.__testables.createHandler(dependencies),
    detailHandler: alertDetail.__testables.createHandler(dependencies),
  };
}

test('1. student 只获得自己的预警且按 issuedAt 倒序', async () => {
  const alerts = [
    baseAlert({ _id: 'alert_old', issuedAt: '2026-09-07T09:00:00.000Z' }),
    baseAlert({ _id: 'alert_new', issuedAt: '2026-09-08T10:00:00.000Z', status: 'viewed' }),
    baseAlert({ _id: 'alert_other', studentId: 'usr_student_002', issuedAt: '2026-09-09T10:00:00.000Z' }),
  ];
  const { listHandler, state } = makeHandlers([baseStudent()], alerts);
  const response = await listHandler({});
  assert.equal(response.code, 'OK');
  assert.deepEqual(response.alerts.map((alert) => alert.alertId), ['alert_new', 'alert_old']);
  assert.deepEqual(state.queryTrace.at(-1), {
    collection: 'alerts',
    query: { studentId: 'usr_student_001' },
    limit: 50,
    orderBy: { field: 'issuedAt', direction: 'desc' },
  });
});

test('2. student 列表不返回 pending_dispatch', async () => {
  const alerts = [
    baseAlert({ _id: 'alert_pending', status: 'pending_dispatch', issuedAt: '2026-09-09T09:00:00.000Z' }),
    baseAlert({ _id: 'alert_sent', status: 'sent' }),
    baseAlert({ _id: 'alert_following', status: 'following_up' }),
    baseAlert({ _id: 'alert_closed', status: 'closed' }),
  ];
  const { listHandler } = makeHandlers([baseStudent()], alerts);
  const response = await listHandler({});
  assert.deepEqual(response.alerts.map((alert) => alert.alertId), ['alert_sent', 'alert_following', 'alert_closed']);
  assert.equal(response.alerts.some((alert) => alert.status === 'pending_dispatch'), false);
});

test('3. student 列表仅返回安全投影与固定长度摘要', async () => {
  const content = 'a'.repeat(81);
  const { listHandler } = makeHandlers([baseStudent()], [baseAlert({ content, closeReason: '内部关闭说明' })]);
  const response = await listHandler({});
  assert.deepEqual(Object.keys(response.alerts[0]).sort(), ['alertId', 'contentSummary', 'fraudType', 'issuedAt', 'riskLevel', 'status']);
  assert.equal(response.alerts[0].contentSummary, `${'a'.repeat(80)}…`);
  const responseJson = JSON.stringify(response);
  for (const secret of ['studentId', 'collegeId', 'issuedBy', 'sourceReference', 'riskReasons', 'riskRuleId', 'closeReason', 'version', 'trusted-openid', 'wxIdentityKey']) {
    assert.equal(responseJson.includes(secret), false);
  }
});

test('4. student 列表零输入可正常读取', async () => {
  const { listHandler } = makeHandlers([baseStudent()], [baseAlert()]);
  assert.equal((await listHandler()).code, 'OK');
});

test('5. list 忽略平台注入 userInfo 和 tcbContext 内容', async () => {
  const { listHandler, logs } = makeHandlers([baseStudent()], [baseAlert()]);
  const response = await listHandler({
    userInfo: { openId: 'spoofed-openid' },
    tcbContext: { OPENID: 'spoofed-openid-uppercase', appId: 'wrong-appid' },
  });
  assert.equal(response.code, 'OK');
  assert.deepEqual(logs, []);
});

test('6. list 拒绝伪造身份字段且不查询 alerts', async () => {
  const { listHandler, state } = makeHandlers([baseStudent()], [baseAlert()]);
  for (const key of ['OPENID', 'userId', 'studentId', 'role', 'collegeId', 'wxOpenId', 'wxIdentityKey']) {
    const response = await listHandler({ [key]: 'forged' });
    assert.equal(response.code, 'INVALID_INPUT');
  }
  assert.equal(state.queryTrace.some((entry) => entry.collection === 'alerts'), false);
});

test('7. counselor 调用列表返回 FORBIDDEN 并审计拒绝', async () => {
  const counselor = baseStudent({ _id: 'usr_counselor_001', role: 'counselor' });
  const { listHandler, state } = makeHandlers([counselor], [baseAlert()]);
  assert.equal((await listHandler({})).code, 'FORBIDDEN');
  assert.deepEqual(state.audits[0].action, 'access.denied');
  assert.equal(state.audits[0].failureReason, 'FORBIDDEN');
});

test('8. security 调用列表返回 FORBIDDEN', async () => {
  const security = baseStudent({ _id: 'usr_security_001', role: 'security', collegeId: null });
  const { listHandler } = makeHandlers([security], [baseAlert()]);
  assert.equal((await listHandler({})).code, 'FORBIDDEN');
});

test('9. inactive student 调用列表返回 ACCOUNT_DISABLED', async () => {
  const { listHandler } = makeHandlers([baseStudent({ status: 'disabled' })], [baseAlert()]);
  assert.equal((await listHandler({})).code, 'ACCOUNT_DISABLED');
});

test('10. 未绑定微信调用列表返回 UNBOUND', async () => {
  const { listHandler } = makeHandlers([], [baseAlert()]);
  assert.equal((await listHandler({})).code, 'UNBOUND');
});

test('11. 绑定一致性异常的 student 调用列表返回 INTERNAL_ERROR', async () => {
  const inconsistent = baseStudent({ bindStatus: 'bound', wxOpenId: 'other-openid' });
  const { listHandler } = makeHandlers([inconsistent], [baseAlert()]);
  assert.equal((await listHandler({})).code, 'INTERNAL_ERROR');
});

test('12. list AppID 不匹配返回 FORBIDDEN', async () => {
  const { listHandler } = makeHandlers([baseStudent()], [baseAlert()], { OPENID: 'trusted-openid', APPID: 'wrong-appid' });
  assert.equal((await listHandler({})).code, 'FORBIDDEN');
});

test('13. detail 缺失、空或非字符串 alertId 返回 INVALID_INPUT', async () => {
  const { detailHandler } = makeHandlers([baseStudent()], [baseAlert()]);
  for (const event of [{}, { alertId: ' ' }, { alertId: 1 }, null, []]) {
    assert.equal((await detailHandler(event)).code, 'INVALID_INPUT');
  }
});

test('14. detail 忽略平台 userInfo 和 tcbContext，仍只使用 trusted OPENID', async () => {
  const { detailHandler, state, logs } = makeHandlers([baseStudent()], [baseAlert()]);
  const response = await detailHandler({
    alertId: 'alert_001',
    userInfo: { openId: 'spoofed-openid' },
    tcbContext: { openId: 'spoofed-openid', OPENID: 'spoofed-openid-uppercase', appId: 'wrong-appid' },
  });
  assert.equal(response.code, 'OK');
  assert.equal(state.alerts[0].status, 'viewed');
  assert.equal(state.alerts[0].studentId, 'usr_student_001');
  assert.deepEqual(logs, []);
});

test('15. detail 拒绝伪造身份字段且不查询 alerts', async () => {
  const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert()]);
  for (const key of ['OPENID', 'userId', 'studentId', 'role', 'collegeId', 'wxOpenId', 'wxIdentityKey']) {
    assert.equal((await detailHandler({ alertId: 'alert_001', [key]: 'forged' })).code, 'INVALID_INPUT');
  }
  assert.equal(state.queryTrace.some((entry) => entry.collection === 'alerts'), false);
});

test('16. detail 查询同时限定 _id 与可信 studentId，别人的 alertId 统一 NOT_FOUND', async () => {
  const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert({ _id: 'alert_other', studentId: 'usr_student_002' })]);
  const response = await detailHandler({ alertId: 'alert_other' });
  assert.equal(response.code, 'NOT_FOUND');
  const alertQueries = state.queryTrace.filter((entry) => entry.collection === 'alerts');
  assert.deepEqual(alertQueries[0].query, { _id: 'alert_other', studentId: 'usr_student_001' });
});

test('17. pending_dispatch detail 对学生统一 NOT_FOUND 且不写 audit', async () => {
  const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert({ status: 'pending_dispatch' })]);
  assert.equal((await detailHandler({ alertId: 'alert_001' })).code, 'NOT_FOUND');
  assert.equal(state.conditionalUpdates.length, 0);
  assert.equal(state.audits.length, 0);
});

test('18. sent detail 在事务内变为 viewed 并 version 加一', async () => {
  const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert()]);
  const response = await detailHandler({ alertId: 'alert_001' });
  assert.equal(response.code, 'OK');
  assert.equal(response.alert.status, 'viewed');
  assert.equal(state.alerts[0].status, 'viewed');
  assert.equal(state.alerts[0].version, 2);
  assert.ok(state.alerts[0].readAt.$serverDate);
  assert.ok(state.alerts[0].updatedAt.$serverDate);
  assert.equal(state.transactionCalls, 1);
});

test('19. sent→viewed 条件更新校验 _id、studentId、status 与 version', async () => {
  const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert({ version: 7 })]);
  await detailHandler({ alertId: 'alert_001' });
  assert.deepEqual(state.conditionalUpdates[0].query, {
    _id: 'alert_001',
    studentId: 'usr_student_001',
    status: 'sent',
    version: 7,
  });
  assert.equal(state.conditionalUpdates[0].data.version, 8);
});

test('20. sent→viewed 与最小 alert.view 审计在同一事务完成', async () => {
  const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert()]);
  await detailHandler({ alertId: 'alert_001' });
  assert.equal(state.audits.length, 1);
  assert.deepEqual(state.audits[0], {
    _id: 'audit_student_alert_1',
    actorId: 'usr_student_001',
    actorRole: 'student',
    actorCollegeId: 'college_cs',
    action: 'alert.view',
    resourceType: 'alert',
    resourceId: 'alert_001',
    result: 'success',
    requestId: 'req-student-alert',
    createdAt: { $serverDate: 3 },
    beforeSummary: { status: 'sent' },
    afterSummary: { status: 'viewed' },
  });
});

test('21. sent→viewed 的 audit 失败时状态更新回滚且不返回详情', async () => {
  const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert()], trustedContext, { auditFailure: true });
  const response = await detailHandler({ alertId: 'alert_001' });
  assert.equal(response.code, 'INTERNAL_ERROR');
  assert.equal(state.alerts[0].status, 'sent');
  assert.equal(state.alerts[0].version, 1);
  assert.equal(state.audits.length, 0);
  assert.equal(response.alert, undefined);
});

test('22. 已 viewed 重复打开不改 version，但本次详情读取仍审计', async () => {
  const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert({ status: 'viewed', version: 4, readAt: '2026-09-08T09:01:00.000Z' })]);
  const first = await detailHandler({ alertId: 'alert_001' });
  const second = await detailHandler({ alertId: 'alert_001' });
  assert.equal(first.code, 'OK');
  assert.equal(second.code, 'OK');
  assert.equal(state.alerts[0].version, 4);
  assert.equal(state.conditionalUpdates.length, 0);
  assert.equal(state.audits.length, 2);
  assert.equal(state.audits.every((audit) => audit.beforeSummary === undefined && audit.afterSummary === undefined), true);
});

test('23. following_up 与 closed 详情正常返回且不发生状态更新', async () => {
  for (const status of ['following_up', 'closed']) {
    const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert({ status, version: 3 })]);
    const response = await detailHandler({ alertId: 'alert_001' });
    assert.equal(response.code, 'OK');
    assert.equal(response.alert.status, status);
    assert.equal(state.alerts[0].version, 3);
    assert.equal(state.conditionalUpdates.length, 0);
    assert.equal(state.audits.length, 1);
  }
});

test('24. 非 sent 详情读取 audit 失败时 fail closed', async () => {
  const { detailHandler } = makeHandlers([baseStudent()], [baseAlert({ status: 'viewed' })], trustedContext, { auditFailure: true });
  const response = await detailHandler({ alertId: 'alert_001' });
  assert.equal(response.code, 'INTERNAL_ERROR');
  assert.equal(response.alert, undefined);
});

test('25. counselor 和 security 调用 detail 均返回 FORBIDDEN', async () => {
  for (const user of [
    baseStudent({ _id: 'usr_counselor_001', role: 'counselor' }),
    baseStudent({ _id: 'usr_security_001', role: 'security', collegeId: null }),
  ]) {
    const { detailHandler } = makeHandlers([user], [baseAlert()]);
    assert.equal((await detailHandler({ alertId: 'alert_001' })).code, 'FORBIDDEN');
  }
});

test('26. inactive 或未绑定身份不能读取 detail', async () => {
  const inactiveRun = makeHandlers([baseStudent({ status: 'disabled' })], [baseAlert()]);
  assert.equal((await inactiveRun.detailHandler({ alertId: 'alert_001' })).code, 'ACCOUNT_DISABLED');
  const unboundRun = makeHandlers([], [baseAlert()]);
  assert.equal((await unboundRun.detailHandler({ alertId: 'alert_001' })).code, 'UNBOUND');
});

test('27. detail 响应和 audit 均不包含内部或身份敏感字段', async () => {
  const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert({ closeReason: '内部关闭说明' })]);
  const response = await detailHandler({ alertId: 'alert_001', tcbContext: { openId: 'spoofed-openid' } });
  assert.deepEqual(Object.keys(response.alert).sort(), ['alertId', 'content', 'fraudType', 'issuedAt', 'riskLevel', 'status']);
  const responseJson = JSON.stringify(response);
  const auditJson = JSON.stringify(state.audits[0]);
  for (const secret of ['studentId', 'collegeId', 'issuedBy', 'sourceReference', 'riskReasons', 'riskRuleId', 'closeReason', 'version', 'trusted-openid', 'spoofed-openid', 'wxIdentityKey', '张三']) {
    assert.equal(responseJson.includes(secret), false);
  }
  for (const secret of ['studentId', 'collegeId', 'issuedBy', 'sourceReference', 'riskReasons', 'riskRuleId', 'closeReason', 'version', 'trusted-openid', 'spoofed-openid', 'wxIdentityKey', '张三', '请勿向陌生账号转账']) {
    assert.equal(auditJson.includes(secret), false);
  }
});

test('28. 原生事务冲突后如最终已 viewed，按幂等详情返回', async () => {
  const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert()], trustedContext, {
    transactionConflict: true,
    onTransactionConflict(currentState) {
      Object.assign(currentState.alerts[0], { status: 'viewed', version: 2, readAt: { $serverDate: 'other-request' } });
    },
  });
  const response = await detailHandler({ alertId: 'alert_001' });
  assert.equal(response.code, 'OK');
  assert.equal(response.alert.status, 'viewed');
  assert.equal(state.alerts[0].version, 2);
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].beforeSummary, undefined);
});

test('29. 两个并发首次打开只发生一次 sent→viewed 迁移', async () => {
  const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert()]);
  const [first, second] = await Promise.all([
    detailHandler({ alertId: 'alert_001' }),
    detailHandler({ alertId: 'alert_001' }),
  ]);
  assert.equal(first.code, 'OK');
  assert.equal(second.code, 'OK');
  assert.equal(state.alerts[0].status, 'viewed');
  assert.equal(state.alerts[0].version, 2);
  assert.equal(state.conditionalUpdates.length, 1);
  assert.equal(state.audits.length, 2);
  assert.equal(state.audits.filter((audit) => audit.beforeSummary && audit.beforeSummary.status === 'sent').length, 1);
});

test('30. 条件更新竞争后如最终已 viewed，按幂等详情返回', async () => {
  const { detailHandler, state } = makeHandlers([baseStudent()], [baseAlert()], trustedContext, {
    conditionUpdateZero: true,
    preserveConflictMutation: true,
    onConditionUpdateZero(currentState) {
      Object.assign(currentState.alerts[0], { status: 'viewed', version: 2, readAt: { $serverDate: 'other-request' } });
    },
  });
  const response = await detailHandler({ alertId: 'alert_001' });
  assert.equal(response.code, 'OK');
  assert.equal(response.alert.status, 'viewed');
  assert.equal(state.alerts[0].version, 2);
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].beforeSummary, undefined);
});

test('31. list 不为正常读取制造 alert.view audit', async () => {
  const { listHandler, state } = makeHandlers([baseStudent()], [baseAlert()]);
  assert.equal((await listHandler({})).code, 'OK');
  assert.equal(state.audits.length, 0);
});

test('32. 两个默认 handler 均固定使用 TARGET_ENV_ID', async () => {
  const initializedEnvs = [];
  const cloud = {
    init: ({ env }) => initializedEnvs.push(env),
    database: () => ({
      serverDate: () => ({ $serverDate: true }),
      collection: () => ({}),
      runTransaction: async () => ({}),
    }),
    getWXContext: () => trustedContext,
  };
  listAlerts.__testables.createDefaultHandler(cloud);
  alertDetail.__testables.createDefaultHandler(cloud);
  assert.deepEqual(initializedEnvs, [
    listAlerts.__testables.TARGET_ENV_ID,
    alertDetail.__testables.TARGET_ENV_ID,
  ]);
});
