'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const reportModule = require('../../cloudfunctions/createStudentReport/index.js');

const trustedContext = { OPENID: 'trusted-openid', APPID: 'wxe262970211858262' };

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function baseStudent(overrides = {}) {
  return {
    _id: 'usr_student_001', wxIdentityKey: 'openid:trusted-openid', wxOpenId: 'trusted-openid', bindStatus: 'bound',
    role: 'student', status: 'active', collegeId: 'college_cs', focusFlag: false, version: 1, ...overrides,
  };
}

function baseRule(overrides = {}) {
  return {
    _id: 'rule_default', status: 'enabled', version: 1, highAmount: 5000, midAmountMin: 1,
    repeatAlertWindowDays: 30, highAlertRepeatCount: 3, midAlertRepeatCount: 2,
    keyFraudTypes: ['part_time_scam', 'fake_loan'], ...overrides,
  };
}

function baseAlert(overrides = {}) {
  return {
    _id: 'alert_001', studentId: 'usr_student_001', status: 'sent', version: 1,
    issuedAt: new Date('2026-09-08T12:00:00.000Z'), ...overrides,
  };
}

function validEvent(overrides = {}) {
  return {
    fraudType: 'other', incidentAt: '2026-09-09T10:00:00.000Z', involvedAmount: 0, hasLoss: false,
    incidentNarrative: '收到可疑消息，前来咨询。', ...overrides,
  };
}

function queryMatches(document, query) {
  return Object.entries(query).every(([key, wanted]) => {
    if (wanted && wanted.$in) return wanted.$in.includes(document[key]);
    if (wanted && wanted.$gte) return new Date(document[key]).getTime() >= wanted.$gte.getTime();
    return document[key] === wanted;
  });
}

function createMockDb({ users = [baseStudent()], alerts = [], reports = [], rule = baseRule(), options = {} } = {}) {
  const state = { users: clone(users), alerts: clone(alerts), reports: clone(reports), rules: rule ? [clone(rule)] : [], audits: [], queries: [], transactionCalls: 0, transactionWhereCalls: 0 };
  const rowsFor = (name) => ({ users: state.users, alerts: state.alerts, fraud_reports: state.reports, risk_rules: state.rules, audit_logs: state.audits }[name]);
  const collection = (name, transactional = false) => ({
    where(query) {
      if (transactional) {
        state.transactionWhereCalls += 1;
        throw new Error('transactions must not use where');
      }
      state.queries.push({ collection: name, query: clone(query) });
      const get = async () => ({ data: rowsFor(name).filter((row) => queryMatches(row, query)).map(clone) });
      return { get, limit: () => ({ get }) };
    },
    doc(id) {
      return { get: async () => ({ data: clone(rowsFor(name).find((row) => row._id === id)) }) };
    },
    async add({ data }) {
      if (name === 'audit_logs' && options.auditFailure) throw new Error('audit unavailable');
      if (name === 'fraud_reports' && options.uniqueConflict) throw new Error('sourceAlertKey duplicate unique index');
      rowsFor(name).push(clone(data));
      return { id: data._id };
    },
  });
  const db = {
    command: { in: (values) => ({ $in: values }), gte: (value) => ({ $gte: value }) },
    collection: (name) => collection(name),
    async runTransaction(callback) {
      state.transactionCalls += 1;
      if (typeof options.beforeTransaction === 'function') options.beforeTransaction(state);
      if (options.transactionConflict) throw new Error('transaction conflict');
      const backup = clone({ reports: state.reports, audits: state.audits });
      try {
        return await callback({ collection: (name) => collection(name, true) });
      } catch (error) {
        state.reports.splice(0, state.reports.length, ...backup.reports);
        state.audits.splice(0, state.audits.length, ...backup.audits);
        throw error;
      }
    },
  };
  return { db, state };
}

function makeHandler(config = {}) {
  const mock = createMockDb(config);
  const logs = [];
  let ids = 0;
  return {
    ...mock, logs,
    handler: reportModule.__testables.createHandler({
      db: mock.db, getWXContext: () => config.wxContext || trustedContext,
      serverDate: () => ({ $serverDate: ++ids }), now: config.now || (() => new Date('2026-09-10T00:00:00.000Z')),
      createRequestId: () => 'req_report', createReportId: () => 'report_fixed', createAuditId: () => `audit_${++ids}`,
      logger: { error: (entry) => logs.push(entry) },
    }),
  };
}

test('1. 无 OPENID 返回 INTERNAL_ERROR', async () => {
  const { handler } = makeHandler({ wxContext: { APPID: trustedContext.APPID } });
  assert.equal((await handler(validEvent())).code, 'INTERNAL_ERROR');
});

test('2. 错误 APPID 返回 FORBIDDEN', async () => {
  const { handler } = makeHandler({ wxContext: { ...trustedContext, APPID: 'wrong' } });
  assert.equal((await handler(validEvent())).code, 'FORBIDDEN');
});

test('3. 未绑定用户返回 UNBOUND', async () => {
  const { handler } = makeHandler({ users: [] });
  assert.equal((await handler(validEvent())).code, 'UNBOUND');
});

test('4. 非 student 拒绝且写 access.denied 审计', async () => {
  const { handler, state } = makeHandler({ users: [baseStudent({ role: 'counselor' })] });
  assert.equal((await handler(validEvent())).code, 'FORBIDDEN');
  assert.equal(state.audits[0].action, 'access.denied');
});

test('5. inactive 用户拒绝且写 access.denied 审计', async () => {
  const { handler, state } = makeHandler({ users: [baseStudent({ status: 'suspended' })] });
  assert.equal((await handler(validEvent())).code, 'ACCOUNT_DISABLED');
  assert.equal(state.audits[0].failureReason, 'ACCOUNT_DISABLED');
});

test('6. 绑定不一致或学院为空安全失败并审计', async () => {
  for (const student of [baseStudent({ wxOpenId: 'other' }), baseStudent({ collegeId: ' ' })]) {
    const { handler, state } = makeHandler({ users: [student] });
    assert.equal((await handler(validEvent())).code, 'INTERNAL_ERROR');
    assert.equal(state.audits[0].action, 'access.denied');
  }
});

test('7. 伪造服务端字段全部拒绝', async () => {
  for (const key of ['studentId', 'userId', 'collegeId', 'role', 'riskLevel', 'riskReasons', 'riskRuleId', 'status', 'currentHandlerId', 'actorId', 'confirmedLossAmount', 'submittedAt', 'version']) {
    const { handler } = makeHandler();
    assert.equal((await handler(validEvent({ [key]: 'forged' }))).code, 'INVALID_INPUT', key);
  }
});

test('8. 诈骗类型、时间、金额、损失标识和正文输入均严格校验', async () => {
  const invalids = [
    validEvent({ fraudType: 'unknown' }), validEvent({ incidentAt: 'not-a-date' }), validEvent({ involvedAmount: '1' }),
    validEvent({ involvedAmount: -1 }), validEvent({ involvedAmount: NaN }), validEvent({ hasLoss: 'true' }),
    validEvent({ incidentNarrative: '   ' }), validEvent({ incidentNarrative: 'x'.repeat(2001) }),
  ];
  for (const event of invalids) assert.equal((await makeHandler().handler(event)).code, 'INVALID_INPUT');
});

test('9. 可选字段规范化，平台注入字段完全忽略', async () => {
  const { handler, state } = makeHandler();
  const response = await handler(validEvent({ suspiciousPlatform: ' QQ ', suspiciousAccount: ' ', contactPhone: null, studentRemark: ' note ', userInfo: { openid: 'fake' }, tcbContext: { OPENID: 'fake' } }));
  assert.equal(response.code, 'REPORT_SUBMITTED');
  assert.equal(state.reports[0].suspiciousPlatform, 'QQ');
  assert.equal(state.reports[0].studentRemark, 'note');
  assert.equal('suspiciousAccount' in state.reports[0], false);
  assert.equal('contactPhone' in state.reports[0], false);
});

test('10. 独立上报生成 standalone sourceAlertKey', async () => {
  const { handler, state } = makeHandler();
  await handler(validEvent());
  assert.equal(state.reports[0].sourceAlertKey, 'standalone:report_fixed');
  assert.equal('sourceAlertId' in state.reports[0], false);
});

test('11. 关联预警生成 alert sourceAlertKey', async () => {
  const { handler, state } = makeHandler({ alerts: [baseAlert()] });
  await handler(validEvent({ sourceAlertId: 'alert_001' }));
  assert.equal(state.reports[0].sourceAlertKey, 'alert:alert_001');
  assert.equal(state.reports[0].sourceAlertId, 'alert_001');
});

test('12. 不能关联他人、待下发或已关闭预警', async () => {
  for (const alert of [baseAlert({ studentId: 'usr_other' }), baseAlert({ status: 'pending_dispatch' }), baseAlert({ status: 'closed' })]) {
    const { handler } = makeHandler({ alerts: [alert] });
    assert.equal((await handler(validEvent({ sourceAlertId: 'alert_001' }))).code, 'NOT_FOUND');
  }
});

test('13. 已有关联工单的友好预检返回 CONFLICT', async () => {
  const { handler } = makeHandler({ alerts: [baseAlert()], reports: [{ _id: 'report_old', sourceAlertKey: 'alert:alert_001' }] });
  assert.equal((await handler(validEvent({ sourceAlertId: 'alert_001' }))).code, 'CONFLICT');
});

test('14. UNIQUE 竞态和事务冲突均转换为 CONFLICT', async () => {
  for (const options of [{ uniqueConflict: true }, { transactionConflict: true }]) {
    const { handler } = makeHandler({ alerts: [baseAlert()], options });
    assert.equal((await handler(validEvent({ sourceAlertId: 'alert_001' }))).code, 'CONFLICT');
  }
});

test('15. studentId 与 collegeId 始终来自可信用户', async () => {
  const { handler, state } = makeHandler();
  await handler(validEvent());
  assert.equal(state.reports[0].studentId, 'usr_student_001');
  assert.equal(state.reports[0].collegeId, 'college_cs');
});

test('16. LOW 风险条件正确', async () => {
  const response = await makeHandler().handler(validEvent());
  assert.equal(response.report.riskLevel, 'low');
  assert.deepEqual(response.report.riskReasons, []);
});

test('17. hasLoss 和 high 金额均为 HIGH', async () => {
  for (const event of [validEvent({ hasLoss: true }), validEvent({ involvedAmount: 5000 })]) {
    assert.equal((await makeHandler().handler(event)).report.riskLevel, 'high');
  }
});

test('18. 仍在联系且重点类型为 HIGH，记录实际因素', async () => {
  const response = await makeHandler().handler(validEvent({ fraudType: 'part_time_scam', stillContacting: true }));
  assert.equal(response.report.riskLevel, 'high');
  assert.deepEqual(response.report.riskReasons, ['still_contacting', 'key_fraud_type']);
});

test('19. 重复预警达到 high 阈值为 HIGH', async () => {
  const alerts = [0, 1, 2].map((number) => baseAlert({ _id: `alert_${number}`, status: 'viewed' }));
  const response = await makeHandler({ alerts }).handler(validEvent());
  assert.equal(response.report.riskLevel, 'high');
  assert.ok(response.report.riskReasons.includes('repeat_alert_count>=3'));
});

test('20. focus 加仍在联系、focus 加中等重复均为 HIGH', async () => {
  const first = await makeHandler({ users: [baseStudent({ focusFlag: true })] }).handler(validEvent({ stillContacting: true }));
  const alerts = [0, 1].map((number) => baseAlert({ _id: `alert_${number}` }));
  const second = await makeHandler({ users: [baseStudent({ focusFlag: true })], alerts }).handler(validEvent());
  assert.equal(first.report.riskLevel, 'high');
  assert.equal(second.report.riskLevel, 'high');
});

test('21. 中风险的金额、联系、重点类型、重复和关注规则正确', async () => {
  const cases = [
    makeHandler().handler(validEvent({ involvedAmount: 1 })),
    makeHandler().handler(validEvent({ stillContacting: true })),
    makeHandler().handler(validEvent({ fraudType: 'fake_loan' })),
    makeHandler({ alerts: [baseAlert({ _id: 'a1' }), baseAlert({ _id: 'a2' })] }).handler(validEvent()),
    makeHandler({ users: [baseStudent({ focusFlag: true })] }).handler(validEvent()),
  ];
  for (const result of await Promise.all(cases)) assert.equal(result.report.riskLevel, 'medium');
});

test('22. 活动预警统计只包含窗口内 sent/viewed/following_up', async () => {
  const alerts = [
    baseAlert({ _id: 'sent', status: 'sent' }), baseAlert({ _id: 'viewed', status: 'viewed' }), baseAlert({ _id: 'follow', status: 'following_up' }),
    baseAlert({ _id: 'pending', status: 'pending_dispatch' }), baseAlert({ _id: 'closed', status: 'closed' }),
    baseAlert({ _id: 'old', issuedAt: new Date('2026-07-01T00:00:00.000Z') }),
  ];
  const { handler, state } = makeHandler({ alerts });
  const response = await handler(validEvent());
  assert.equal(response.report.riskLevel, 'high');
  assert.equal(state.reports[0].riskReasons.includes('repeat_alert_count>=3'), true);
});

test('23. 风险规则固定为 rule_default，客户端无法控制计算结果', async () => {
  const { handler, state } = makeHandler();
  const response = await handler(validEvent({ involvedAmount: 6000 }));
  assert.equal(response.report.riskLevel, 'high');
  assert.equal(state.reports[0].riskRuleId, 'rule_default');
});

test('24. 工单字段严格符合设计且不含处理/结案字段', async () => {
  const { handler, state } = makeHandler();
  await handler(validEvent());
  const report = state.reports[0];
  for (const key of ['_id', 'studentId', 'collegeId', 'sourceAlertKey', 'fraudType', 'incidentAt', 'involvedAmount', 'hasLoss', 'incidentNarrative', 'stillContacting', 'riskLevel', 'riskReasons', 'riskRuleId', 'status', 'confirmedLossAmount', 'version', 'submittedAt', 'createdAt', 'updatedAt']) assert.ok(key in report, key);
  for (const key of ['currentHandlerId', 'finalOutcome', 'closedAt', 'closeReason']) assert.equal(key in report, false, key);
  assert.equal(report.status, 'pending_counselor_verify');
  assert.equal(report.version, 1);
  assert.equal(report.confirmedLossAmount, null);
});

test('25. 工单和成功审计在同一事务，审计只含最小摘要', async () => {
  const { handler, state } = makeHandler();
  await handler(validEvent({ incidentNarrative: '敏感正文', involvedAmount: 33, hasLoss: true, contactPhone: '13800138000' }));
  assert.equal(state.transactionCalls, 1);
  assert.equal(state.audits.length, 1);
  const audit = state.audits[0];
  assert.deepEqual(audit.afterSummary, { status: 'pending_counselor_verify', riskLevel: 'high' });
  for (const secret of ['敏感正文', '33', '13800138000', 'sourceAlertId', 'wxOpenId', 'identityKey']) assert.equal(JSON.stringify(audit).includes(secret), false);
});

test('26. 审计失败时工单整体回滚', async () => {
  const { handler, state } = makeHandler({ options: { auditFailure: true } });
  assert.equal((await handler(validEvent())).code, 'INTERNAL_ERROR');
  assert.equal(state.reports.length, 0);
  assert.equal(state.audits.length, 0);
});

test('27. 事务内部不使用 where', async () => {
  const { handler, state } = makeHandler({ alerts: [baseAlert()] });
  assert.equal((await handler(validEvent({ sourceAlertId: 'alert_001' }))).code, 'REPORT_SUBMITTED');
  assert.equal(state.transactionWhereCalls, 0);
});

test('28. 学生、规则、预警预读后版本或状态变化均为 CONFLICT', async () => {
  const scenarios = [
    (state) => { state.users[0].version = 2; },
    (state) => { state.rules[0].version = 2; },
    (state) => { state.alerts[0].status = 'closed'; },
    (state) => { state.alerts[0].version = 2; },
  ];
  for (const beforeTransaction of scenarios) {
    const { handler } = makeHandler({ alerts: [baseAlert()], options: { beforeTransaction } });
    assert.equal((await handler(validEvent({ sourceAlertId: 'alert_001' }))).code, 'CONFLICT');
  }
});

test('29. 成功响应仅返回允许的最小字段', async () => {
  const response = await makeHandler().handler(validEvent());
  assert.deepEqual(Object.keys(response.report).sort(), ['fraudType', 'reportId', 'riskLevel', 'riskReasons', 'sourceAlertId', 'status', 'submittedAt', 'version']);
  for (const forbidden of ['studentId', 'collegeId', 'sourceAlertKey', 'incidentNarrative', 'involvedAmount', 'hasLoss', 'wxOpenId']) assert.equal(JSON.stringify(response).includes(forbidden), false);
});

test('30. 规则配置异常或缺失安全失败', async () => {
  assert.equal((await makeHandler({ rule: null }).handler(validEvent())).code, 'NOT_FOUND');
  assert.equal((await makeHandler({ rule: baseRule({ highAmount: 0 }) }).handler(validEvent())).code, 'INTERNAL_ERROR');
});

test('31. 默认 handler 固定初始化目标环境', () => {
  const environments = [];
  const cloud = { init: ({ env }) => environments.push(env), database: () => ({ command: {}, serverDate: () => ({}), collection: () => ({}), runTransaction: async () => ({}) }), getWXContext: () => trustedContext };
  reportModule.__testables.createDefaultHandler(cloud);
  assert.deepEqual(environments, ['aa-d4gvb4o3t50fc94f8']);
});

test('32. sourceAlertId 只能为非空且长度受限的字符串', async () => {
  for (const sourceAlertId of [1, '', ' ', 'x'.repeat(129)]) {
    assert.equal((await makeHandler().handler(validEvent({ sourceAlertId }))).code, 'INVALID_INPUT');
  }
});

test('33. stillContacting 必须为 Boolean，省略时固定 false', async () => {
  assert.equal((await makeHandler().handler(validEvent({ stillContacting: 'false' }))).code, 'INVALID_INPUT');
  const { handler, state } = makeHandler();
  await handler(validEvent());
  assert.equal(state.reports[0].stillContacting, false);
});

test('34. 可选字符串长度超限拒绝', async () => {
  for (const [key, value] of Object.entries({ suspiciousPlatform: 'x'.repeat(101), suspiciousAccount: 'x'.repeat(301), contactPhone: 'x'.repeat(33), studentRemark: 'x'.repeat(501) })) {
    assert.equal((await makeHandler().handler(validEvent({ [key]: value }))).code, 'INVALID_INPUT');
  }
});

test('35. 缺省 APPID 仍可使用可信 OPENID 调用', async () => {
  const { handler } = makeHandler({ wxContext: { OPENID: 'trusted-openid' } });
  assert.equal((await handler(validEvent())).code, 'REPORT_SUBMITTED');
});

test('36. access.denied 审计使用已确认 actor，且不含 OPENID', async () => {
  const { handler, state } = makeHandler({ users: [baseStudent({ role: 'security', collegeId: null })] });
  await handler(validEvent());
  assert.equal(state.audits[0].actorId, 'usr_student_001');
  assert.equal(JSON.stringify(state.audits[0]).includes('trusted-openid'), false);
});

test('37. 客户端不能传身份、处理人和结案相关字段', async () => {
  for (const key of ['OPENID', 'wxOpenId', 'wxIdentityKey', 'operatorId', 'finalOutcome', 'closeReason', 'closedAt']) {
    assert.equal((await makeHandler().handler(validEvent({ [key]: 'spoofed' }))).code, 'INVALID_INPUT');
  }
});

test('38. incidentAt 写入服务端解析出的 Date，而不是提交时间', async () => {
  const { handler, state } = makeHandler();
  await handler(validEvent({ incidentAt: '2026-09-09T10:00:00.000Z' }));
  assert.ok(state.reports[0].incidentAt instanceof Date);
  assert.notDeepEqual(state.reports[0].incidentAt, state.reports[0].submittedAt);
});

test('39. 金额为 0 且默认 midAmountMin 为 1 时保持 LOW', async () => {
  const response = await makeHandler({ rule: baseRule({ midAmountMin: 1 }) }).handler(validEvent({ involvedAmount: 0 }));
  assert.equal(response.report.riskLevel, 'low');
});

test('40. HIGH 金额原因使用稳定机器值', async () => {
  const response = await makeHandler().handler(validEvent({ involvedAmount: 5000 }));
  assert.deepEqual(response.report.riskReasons, ['involved_amount>=5000']);
});

test('41. MEDIUM 金额原因使用稳定机器值', async () => {
  const response = await makeHandler().handler(validEvent({ involvedAmount: 1 }));
  assert.deepEqual(response.report.riskReasons, ['involved_amount>=1']);
});

test('42. MEDIUM 重复预警原因使用中阈值', async () => {
  const alerts = [baseAlert({ _id: 'a1' }), baseAlert({ _id: 'a2' })];
  const response = await makeHandler({ alerts }).handler(validEvent());
  assert.deepEqual(response.report.riskReasons, ['repeat_alert_count>=2']);
});

test('43. focusFlag 的实际触发会进入风险原因', async () => {
  const response = await makeHandler({ users: [baseStudent({ focusFlag: true })] }).handler(validEvent());
  assert.deepEqual(response.report.riskReasons, ['focus_flag']);
});

test('44. 高风险重复预警不额外计算本次提交', async () => {
  const alerts = [baseAlert({ _id: 'a1' }), baseAlert({ _id: 'a2' })];
  const response = await makeHandler({ alerts }).handler(validEvent());
  assert.equal(response.report.riskLevel, 'medium');
});

test('45. 不存在的关联预警返回 NOT_FOUND', async () => {
  const { handler } = makeHandler();
  assert.equal((await handler(validEvent({ sourceAlertId: 'missing' }))).code, 'NOT_FOUND');
});

test('46. sourceAlertKey 的预检不影响独立上报', async () => {
  const { handler } = makeHandler({ reports: [{ _id: 'old', sourceAlertKey: 'alert:alert_001' }] });
  assert.equal((await handler(validEvent())).code, 'REPORT_SUBMITTED');
});

test('47. 成功审计资源 ID 与工单 ID 一致', async () => {
  const { handler, state } = makeHandler();
  await handler(validEvent());
  assert.equal(state.audits[0].resourceId, state.reports[0]._id);
  assert.equal(state.audits[0].resourceType, 'fraud_report');
});

test('48. 成功审计保存可信身份和请求追踪号', async () => {
  const { handler, state } = makeHandler();
  await handler(validEvent());
  assert.deepEqual({ actorId: state.audits[0].actorId, actorRole: state.audits[0].actorRole, actorCollegeId: state.audits[0].actorCollegeId, requestId: state.audits[0].requestId },
    { actorId: 'usr_student_001', actorRole: 'student', actorCollegeId: 'college_cs', requestId: 'req_report' });
});

test('49. 规则在事务内禁用时返回 CONFLICT', async () => {
  const { handler } = makeHandler({ options: { beforeTransaction: (state) => { state.rules[0].status = 'disabled'; } } });
  assert.equal((await handler(validEvent())).code, 'CONFLICT');
});

test('50. 事务内学生绑定变化时返回 CONFLICT', async () => {
  const { handler } = makeHandler({ options: { beforeTransaction: (state) => { state.users[0].wxOpenId = 'other'; } } });
  assert.equal((await handler(validEvent())).code, 'CONFLICT');
});

test('51. 关联预警事务内归属变化时返回 CONFLICT', async () => {
  const { handler } = makeHandler({ alerts: [baseAlert()], options: { beforeTransaction: (state) => { state.alerts[0].studentId = 'other'; } } });
  assert.equal((await handler(validEvent({ sourceAlertId: 'alert_001' }))).code, 'CONFLICT');
});

test('52. 成功日志不输出，失败日志仅记录安全字段', async () => {
  const successful = makeHandler();
  await successful.handler(validEvent());
  assert.equal(successful.logs.length, 0);
  const failed = makeHandler({ options: { auditFailure: true } });
  await failed.handler(validEvent({ incidentNarrative: '不得记录的正文' }));
  assert.deepEqual(Object.keys(failed.logs[0]).sort(), ['code', 'requestId', 'resourceId', 'stage']);
  assert.equal(JSON.stringify(failed.logs[0]).includes('不得记录的正文'), false);
});

test('53. 成功响应 submittedAt 是可解析 ISO，数据库仍使用 serverDate', async () => {
  const requestNow = new Date('2026-09-10T08:09:10.000Z');
  const { handler, state } = makeHandler({ now: () => requestNow });
  const response = await handler(validEvent());
  assert.equal(typeof response.report.submittedAt, 'string');
  assert.equal(new Date(response.report.submittedAt).getTime(), requestNow.getTime());
  assert.deepEqual(state.reports[0].submittedAt, { $serverDate: 1 });
  assert.equal(typeof state.reports[0].submittedAt, 'object');
});

test('54. 无效可信服务端时间安全返回 INTERNAL_ERROR', async () => {
  for (const now of [() => new Date('invalid'), () => '2026-09-10T00:00:00.000Z']) {
    const { handler } = makeHandler({ now });
    assert.equal((await handler(validEvent())).code, 'INTERNAL_ERROR');
  }
});

test('55. 活动预警统计与响应提交时间使用同一次 requestNow', async () => {
  const requestNow = new Date('2026-09-10T12:00:00.000Z');
  let calls = 0;
  const { handler, state } = makeHandler({ now: () => { calls += 1; return requestNow; } });
  const response = await handler(validEvent());
  const alertsQuery = state.queries.find((entry) => entry.collection === 'alerts');
  assert.equal(calls, 1);
  assert.equal(response.report.submittedAt, requestNow.toISOString());
  assert.equal(alertsQuery.query.issuedAt.$gte.getTime(), new Date('2026-08-11T12:00:00.000Z').getTime());
});
