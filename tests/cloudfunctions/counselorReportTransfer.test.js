'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const transferModule = require('../../cloudfunctions/transferCounselorReportToSecurity/index.js');

const trustedContext = { OPENID: 'trusted-counselor-openid', APPID: 'wxe262970211858262' };
const CONTACTED_AT = new Date('2026-09-11T09:00:00.000Z');

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function baseCounselor(overrides = {}) {
  return { _id: 'usr_counselor_001', wxIdentityKey: `openid:${trustedContext.OPENID}`, wxOpenId: trustedContext.OPENID,
    bindStatus: 'bound', role: 'counselor', status: 'active', collegeId: 'college_cs', version: 1, ...overrides };
}
function baseReport(overrides = {}) {
  return { _id: 'report_001', studentId: 'usr_student_001', collegeId: 'college_cs', status: 'pending_counselor_verify',
    version: 2, currentHandlerId: 'usr_counselor_001', riskLevel: 'medium', riskReasons: ['repeat_alert'],
    riskRuleId: 'rule_default', hasLoss: false, involvedAmount: 0, confirmedLossAmount: null, finalOutcome: null,
    closeReason: null, closedAt: null, sourceAlertId: 'alert_001', sourceAlertKey: 'alert:alert_001',
    submittedAt: new Date('2026-09-11T08:00:00.000Z'), createdAt: new Date('2026-09-11T08:00:00.000Z'),
    updatedAt: new Date('2026-09-11T08:00:00.000Z'), ...overrides };
}
function baseFollowup(overrides = {}) {
  return { _id: 'followup_001', businessType: 'report', businessId: 'report_001', studentId: 'usr_student_001',
    collegeId: 'college_cs', counselorId: 'usr_counselor_001', status: 'in_progress', opinion: '学生已完成沟通',
    contactedAt: CONTACTED_AT, contactMethod: 'wechat', focusFlag: false, focusReason: null,
    transferToSecurity: false, transferReason: null, version: 2,
    createdAt: new Date('2026-09-11T08:30:00.000Z'), updatedAt: new Date('2026-09-11T09:00:00.000Z'), ...overrides };
}
function validEvent(overrides = {}) {
  return { followupId: ' followup_001 ', expectedFollowupVersion: 2, expectedReportVersion: 2,
    verificationResult: 'suspected', transferReason: ' 建议保卫处进一步核验 ', ...overrides };
}
function matches(row, query) { return Object.entries(query).every(([key, value]) => row[key] === value); }

function createMockDb({ users = [baseCounselor()], reports = [baseReport()], followups = [baseFollowup()], ...options } = {}) {
  const state = {
    users: clone(users), reports: clone(reports), followups: clone(followups), audits: [], dispositions: [], logs: [],
    transactionCalls: 0, transactionDocReads: [], conditionalUpdates: [], writes: [],
  };
  const rowsFor = (name) => ({
    users: state.users, fraud_reports: state.reports, counselor_followups: state.followups,
    audit_logs: state.audits, security_dispositions: state.dispositions,
  }[name]);
  const collection = (name, transactional = false) => ({
    where(query) {
      const selected = () => rowsFor(name).filter((row) => matches(row, query));
      return {
        limit(limit) { return { get: async () => ({ data: selected().slice(0, limit).map(clone) }) }; },
        get: async () => ({ data: selected().map(clone) }),
        async update({ data }) {
          state.conditionalUpdates.push({ collection: name, query: clone(query), data: clone(data) });
          if (!transactional || !['counselor_followups', 'fraud_reports'].includes(name)) throw new Error('unexpected conditional update');
          if (options.updateZero || (name === 'counselor_followups' && options.followupUpdateZero) ||
            (name === 'fraud_reports' && options.reportUpdateZero)) return { stats: { updated: 0 } };
          const rows = selected(); rows.forEach((row) => Object.assign(row, clone(data)));
          state.writes.push(name); return { stats: { updated: rows.length } };
        },
      };
    },
    doc(id) {
      return { get: async () => {
        if (transactional) state.transactionDocReads.push({ collection: name, id });
        return { data: clone(rowsFor(name).find((row) => row._id === id)) };
      } };
    },
    async add({ data }) {
      if (name !== 'audit_logs') throw new Error('unexpected collection add');
      if (options.auditFailure) throw new Error('audit unavailable');
      state.audits.push(clone(data)); state.writes.push(name); return { id: data._id };
    },
  });
  const snapshot = () => clone({ reports: state.reports, followups: state.followups, audits: state.audits,
    dispositions: state.dispositions, conditionalUpdates: state.conditionalUpdates, writes: state.writes });
  const restore = (saved) => {
    for (const name of ['reports', 'followups', 'audits', 'dispositions', 'conditionalUpdates', 'writes']) {
      state[name].splice(0, state[name].length, ...saved[name]);
    }
  };
  const db = {
    collection: (name) => collection(name, false),
    async runTransaction(callback) {
      state.transactionCalls += 1;
      if (typeof options.beforeTransaction === 'function') options.beforeTransaction(state);
      const saved = snapshot();
      try { return await callback({ collection: (name) => collection(name, true) }); }
      catch (error) { restore(saved); throw error; }
    },
  };
  return { db, state };
}

function makeHandler(options = {}) {
  const mock = createMockDb(options); let auditNumber = 0; let dateNumber = 0;
  const handler = transferModule.__testables.createHandler({
    db: mock.db, getWXContext: () => options.wxContext || trustedContext,
    serverDate: () => ({ $serverDate: ++dateNumber }), logger: { error: (entry) => mock.state.logs.push(entry) },
    createRequestId: () => 'req-report-transfer', createAuditId: () => `audit_${++auditNumber}`,
  });
  return { ...mock, handler };
}

test('1. 非法 event 与多余字段拒绝', async () => {
  assert.equal((await makeHandler().handler(null)).code, 'INVALID_INPUT');
  assert.equal((await makeHandler().handler(validEvent({ reportId: 'spoofed' }))).code, 'INVALID_INPUT');
});
test('2. followupId 与版本字段严格校验', async () => {
  for (const event of [validEvent({ followupId: ' ' }), validEvent({ followupId: 'x'.repeat(129) }),
    validEvent({ expectedFollowupVersion: 0 }), validEvent({ expectedFollowupVersion: 1.5 }),
    validEvent({ expectedReportVersion: 0 }), validEvent({ expectedReportVersion: Number.MAX_SAFE_INTEGER + 1 })]) {
    assert.equal((await makeHandler().handler(event)).code, 'INVALID_INPUT');
  }
});
test('3. verificationResult 与 transferReason 严格校验', async () => {
  for (const event of [validEvent({ verificationResult: 'other' }), validEvent({ transferReason: ' ' }),
    validEvent({ transferReason: 'x'.repeat(501) })]) assert.equal((await makeHandler().handler(event)).code, 'INVALID_INPUT');
});
test('4. userInfo 和 tcbContext 伪造身份完全无效', async () => {
  assert.equal((await makeHandler().handler(validEvent({ userInfo: { OPENID: 'spoofed', role: 'security' },
    tcbContext: { OPENID: 'spoofed', collegeId: 'college_other' } }))).code, 'COUNSELOR_REPORT_TRANSFERRED');
});
test('5. 缺失 OPENID 与错误 APPID 拒绝', async () => {
  assert.equal((await makeHandler({ wxContext: { APPID: trustedContext.APPID } }).handler(validEvent())).code, 'INTERNAL_ERROR');
  assert.equal((await makeHandler({ wxContext: { ...trustedContext, APPID: 'wrong' } }).handler(validEvent())).code, 'FORBIDDEN');
});
test('6. 未绑定、非辅导员、禁用和绑定不一致拒绝', async () => {
  assert.equal((await makeHandler({ users: [] }).handler(validEvent())).code, 'UNBOUND');
  assert.equal((await makeHandler({ users: [baseCounselor({ role: 'student' })] }).handler(validEvent())).code, 'FORBIDDEN');
  assert.equal((await makeHandler({ users: [baseCounselor({ status: 'disabled' })] }).handler(validEvent())).code, 'ACCOUNT_DISABLED');
  assert.equal((await makeHandler({ users: [baseCounselor({ wxOpenId: 'other' })] }).handler(validEvent())).code, 'INTERNAL_ERROR');
});
test('7. 可信身份拒绝写最小 access.denied 审计', async () => {
  const { handler, state } = makeHandler({ users: [baseCounselor({ role: 'student' })] });
  await handler(validEvent());
  assert.deepEqual({ action: state.audits[0].action, resourceType: state.audits[0].resourceType, resourceId: state.audits[0].resourceId },
    { action: 'access.denied', resourceType: 'user', resourceId: 'usr_counselor_001' });
});
test('8. followup 不存在或非 report 拒绝', async () => {
  assert.equal((await makeHandler({ followups: [] }).handler(validEvent())).code, 'NOT_FOUND');
  assert.equal((await makeHandler({ followups: [baseFollowup({ businessType: 'alert' })] }).handler(validEvent())).code, 'INVALID_STATE');
});
test('9. followup 跨学院或非本人拒绝并审计', async () => {
  const crossCollege = makeHandler({ followups: [baseFollowup({ collegeId: 'college_other' })] });
  assert.equal((await crossCollege.handler(validEvent())).code, 'FORBIDDEN');
  assert.deepEqual([crossCollege.state.audits[0].resourceType, crossCollege.state.audits[0].resourceId], ['counselor_followup', 'followup_001']);
  assert.equal((await makeHandler({ followups: [baseFollowup({ counselorId: 'usr_other' })] }).handler(validEvent())).code, 'FORBIDDEN');
});
test('10. report 不存在、跨学院或处理人不符拒绝', async () => {
  assert.equal((await makeHandler({ reports: [] }).handler(validEvent())).code, 'NOT_FOUND');
  assert.equal((await makeHandler({ reports: [baseReport({ collegeId: 'college_other' })] }).handler(validEvent())).code, 'FORBIDDEN');
  assert.equal((await makeHandler({ reports: [baseReport({ currentHandlerId: 'usr_other' })] }).handler(validEvent())).code, 'CONFLICT');
});
test('11. 状态、联系信息与意见前置条件严格校验', async () => {
  for (const options of [
    { followups: [baseFollowup({ status: 'pending' })] }, { followups: [baseFollowup({ status: 'other' })] },
    { reports: [baseReport({ status: 'pending_security_verify' })] }, { followups: [baseFollowup({ contactedAt: null })] },
    { followups: [baseFollowup({ contactedAt: '2026-09-11T09:00:00.000Z' })] },
    { followups: [baseFollowup({ contactMethod: 'email' })] }, { followups: [baseFollowup({ opinion: ' ' })] },
  ]) assert.equal((await makeHandler(options).handler(validEvent())).code, 'INVALID_STATE');
});
test('12. 新迁移路径双版本冲突拒绝', async () => {
  assert.equal((await makeHandler({ followups: [baseFollowup({ version: 3 })] }).handler(validEvent())).code, 'CONFLICT');
  assert.equal((await makeHandler({ reports: [baseReport({ version: 3 })] }).handler(validEvent())).code, 'CONFLICT');
});
test('13. 成功后的相同请求在旧双版本下幂等返回', async () => {
  const completed = baseFollowup({ status: 'completed', version: 3, transferToSecurity: true,
    verificationResult: 'suspected', transferReason: ' 建议保卫处进一步核验 ' });
  const report = baseReport({ status: 'pending_security_verify', version: 3 });
  const { handler, state } = makeHandler({ followups: [completed], reports: [report] });
  const response = await handler(validEvent({ expectedFollowupVersion: 2, expectedReportVersion: 2 }));
  assert.deepEqual(response, { ok: true, code: 'REPORT_ALREADY_TRANSFERRED',
    followup: { followupId: 'followup_001', status: 'completed', version: 3 },
    report: { reportId: 'report_001', status: 'pending_security_verify', version: 3 } });
  assert.equal(state.transactionCalls, 0); assert.equal(state.conditionalUpdates.length, 0);
  assert.equal(state.audits.length, 0); assert.equal(state.dispositions.length, 0);
});
test('14. completed 非匹配结果、原因、转交标记或 report 状态均不伪装幂等', async () => {
  const cases = [
    { followups: [baseFollowup({ status: 'completed', transferToSecurity: true, verificationResult: 'confirmed', transferReason: '建议保卫处进一步核验' })], reports: [baseReport({ status: 'pending_security_verify' })] },
    { followups: [baseFollowup({ status: 'completed', transferToSecurity: true, verificationResult: 'suspected', transferReason: '不同原因' })], reports: [baseReport({ status: 'pending_security_verify' })] },
    { followups: [baseFollowup({ status: 'completed', transferToSecurity: false, verificationResult: 'suspected', transferReason: '建议保卫处进一步核验' })], reports: [baseReport({ status: 'pending_security_verify' })] },
    { followups: [baseFollowup({ status: 'completed', transferToSecurity: true, verificationResult: 'suspected', transferReason: '建议保卫处进一步核验' })], reports: [baseReport()] },
  ];
  for (const options of cases) assert.equal((await makeHandler(options).handler(validEvent())).code, 'CONFLICT');
});
test('15. 事务内重读 counselor、followup 和 report', async () => {
  const { handler, state } = makeHandler(); await handler(validEvent());
  for (const collection of ['users', 'counselor_followups', 'fraud_reports']) {
    assert.ok(state.transactionDocReads.some((entry) => entry.collection === collection), collection);
  }
});
test('16. 事务内身份、followup 和 report 变化均整体回滚', async () => {
  const mutations = [
    (state) => { state.users[0].status = 'disabled'; },
    (state) => { state.followups[0].status = 'completed'; },
    (state) => { state.followups[0].version = 3; },
    (state) => { state.followups[0].businessId = 'report_other'; },
    (state) => { state.reports[0].status = 'pending_security_verify'; },
    (state) => { state.reports[0].version = 3; },
    (state) => { state.reports[0].currentHandlerId = 'usr_other'; },
  ];
  for (const beforeTransaction of mutations) {
    const { handler, state } = makeHandler({ beforeTransaction });
    assert.equal((await handler(validEvent())).code, 'CONFLICT');
    assert.equal(state.audits.length, 0); assert.equal(state.dispositions.length, 0);
  }
});
test('17. followup 条件更新失败整体回滚', async () => {
  const { handler, state } = makeHandler({ followupUpdateZero: true });
  assert.equal((await handler(validEvent())).code, 'CONFLICT');
  assert.equal(state.followups[0].status, 'in_progress'); assert.equal(state.reports[0].status, 'pending_counselor_verify');
  assert.equal(state.audits.length, 0);
});
test('18. report 条件更新失败整体回滚', async () => {
  const { handler, state } = makeHandler({ reportUpdateZero: true });
  assert.equal((await handler(validEvent())).code, 'CONFLICT');
  assert.equal(state.followups[0].status, 'in_progress'); assert.equal(state.reports[0].status, 'pending_counselor_verify');
  assert.equal(state.audits.length, 0);
});
test('19. 审计写失败整体回滚', async () => {
  const { handler, state } = makeHandler({ auditFailure: true });
  assert.equal((await handler(validEvent())).code, 'INTERNAL_ERROR');
  assert.equal(state.followups[0].status, 'in_progress'); assert.equal(state.reports[0].status, 'pending_counselor_verify');
  assert.equal(state.audits.length, 0);
});
test('20. 成功完成 followup，仅更新允许字段', async () => {
  const { handler, state } = makeHandler(); const before = clone(state.followups[0]);
  const response = await handler(validEvent());
  assert.equal(response.code, 'COUNSELOR_REPORT_TRANSFERRED');
  assert.deepEqual(response.followup, { followupId: 'followup_001', status: 'completed', version: 3 });
  assert.deepEqual(response.report, { reportId: 'report_001', status: 'pending_security_verify', version: 3 });
  const followup = state.followups[0];
  assert.deepEqual([followup.status, followup.version, followup.verificationResult, followup.transferToSecurity, followup.transferReason],
    ['completed', 3, 'suspected', true, '建议保卫处进一步核验']);
  assert.ok(followup.updatedAt && followup.completedAt);
  for (const key of ['contactedAt', 'contactMethod', 'opinion', 'focusFlag', 'focusReason', 'studentId', 'collegeId', 'counselorId', 'businessType', 'businessId', 'createdAt']) {
    assert.deepEqual(followup[key], before[key], key);
  }
});
test('21. 成功迁移 report，不清空 currentHandlerId 且不改风险或结案字段', async () => {
  const { handler, state } = makeHandler(); const before = clone(state.reports[0]); await handler(validEvent());
  const report = state.reports[0];
  assert.deepEqual([report.status, report.version, report.currentHandlerId], ['pending_security_verify', 3, 'usr_counselor_001']);
  assert.ok(report.updatedAt);
  for (const key of ['studentId', 'collegeId', 'riskLevel', 'riskReasons', 'riskRuleId', 'hasLoss', 'involvedAmount',
    'confirmedLossAmount', 'finalOutcome', 'closeReason', 'closedAt', 'sourceAlertId', 'sourceAlertKey', 'submittedAt', 'createdAt']) {
    assert.deepEqual(report[key], before[key], key);
  }
});
test('22. 成功仅追加一条最小化转交审计，且不创建 security_dispositions', async () => {
  const { handler, state } = makeHandler(); await handler(validEvent());
  assert.equal(state.dispositions.length, 0); assert.equal(state.audits.length, 1);
  assert.deepEqual(state.audits[0], {
    _id: 'audit_1', actorId: 'usr_counselor_001', actorRole: 'counselor', actorCollegeId: 'college_cs',
    action: 'report.transfer_to_security', resourceType: 'fraud_report', resourceId: 'report_001', result: 'success',
    beforeSummary: { status: 'pending_counselor_verify', followupStatus: 'in_progress' },
    afterSummary: { status: 'pending_security_verify', followupStatus: 'completed' }, requestId: 'req-report-transfer',
    createdAt: { $serverDate: 4 },
  });
});
test('23. 成功响应、审计和日志不泄露敏感字段', async () => {
  const { handler, state } = makeHandler({ auditFailure: true });
  const response = await handler(validEvent({ transferReason: '敏感转交原因' }));
  for (const key of ['studentId', 'collegeId', 'counselorId', 'currentHandlerId', 'opinion', 'contactedAt',
    'verificationResult', 'transferReason', 'wxOpenId', 'wxIdentityKey', 'OPENID']) assert.equal(JSON.stringify(response).includes(key), false, key);
  assert.ok(state.logs.length > 0);
  for (const entry of state.logs) assert.deepEqual(Object.keys(entry).sort(), ['code', 'requestId', 'resourceId', 'stage']);
});
test('24. 固定目标环境正确', () => {
  const environments = [];
  const db = { serverDate: () => ({}), collection: () => ({}), runTransaction: async () => ({}) };
  transferModule.__testables.createDefaultHandler({ init: ({ env }) => environments.push(env), database: () => db,
    getWXContext: () => trustedContext });
  assert.deepEqual(environments, ['aa-d4gvb4o3t50fc94f8']);
});
