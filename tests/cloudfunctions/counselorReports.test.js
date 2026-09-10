'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const reportsModule = require('../../cloudfunctions/getCounselorReports/index.js');
const detailModule = require('../../cloudfunctions/getCounselorReportDetail/index.js');

const trustedContext = { OPENID: 'trusted-counselor-openid', APPID: 'wxe262970211858262' };

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function baseCounselor(overrides = {}) {
  return {
    _id: 'usr_counselor_001',
    wxIdentityKey: 'openid:trusted-counselor-openid',
    wxOpenId: 'trusted-counselor-openid',
    bindStatus: 'bound',
    role: 'counselor',
    status: 'active',
    collegeId: 'college_cs',
    ...overrides,
  };
}

function baseStudent(overrides = {}) {
  return {
    _id: 'usr_student_001',
    role: 'student',
    status: 'active',
    collegeId: 'college_cs',
    name: '张三',
    studentNo: '20260001',
    focusFlag: false,
    wxOpenId: 'student-openid',
    wxIdentityKey: 'openid:student-openid',
    ...overrides,
  };
}

function baseReport(overrides = {}) {
  return {
    _id: 'report_001',
    studentId: 'usr_student_001',
    collegeId: 'college_cs',
    sourceAlertId: 'alert_001',
    sourceAlertKey: 'alert:alert_001',
    fraudType: 'part_time_scam',
    incidentAt: '2026-09-08T08:00:00.000Z',
    involvedAmount: 3500,
    hasLoss: true,
    incidentNarrative: '敏感事件经过',
    suspiciousPlatform: 'QQ',
    suspiciousAccount: '123456',
    stillContacting: true,
    contactPhone: '13800138000',
    studentRemark: '敏感补充说明',
    riskLevel: 'high',
    riskReasons: ['has_loss'],
    status: 'pending_counselor_verify',
    submittedAt: '2026-09-08T09:00:00.000Z',
    version: 1,
    currentHandlerId: 'usr_internal',
    confirmedLossAmount: 12,
    ...overrides,
  };
}

function matches(row, query) {
  return Object.entries(query).every(([key, value]) => row[key] === value);
}

function createMockDb({ users = [baseCounselor(), baseStudent()], reports = [], auditFailure = false } = {}) {
  const state = {
    users: clone(users),
    reports: clone(reports),
    audits: [],
    queryTrace: [],
    docTrace: [],
    writes: [],
  };
  const rowsFor = (name) => ({ users: state.users, fraud_reports: state.reports, audit_logs: state.audits }[name]);
  const collection = (name) => ({
    where(query) {
      const get = async () => {
        state.queryTrace.push({ collection: name, query: clone(query), limit: null });
        return { data: rowsFor(name).filter((row) => matches(row, query)).map(clone) };
      };
      return {
        limit(limit) {
          return {
            get: async () => {
              state.queryTrace.push({ collection: name, query: clone(query), limit });
              return { data: rowsFor(name).filter((row) => matches(row, query)).slice(0, limit).map(clone) };
            },
          };
        },
        get,
      };
    },
    doc(id) {
      return {
        get: async () => {
          state.docTrace.push({ collection: name, id });
          return { data: clone(rowsFor(name).find((row) => row._id === id)) };
        },
      };
    },
    async add({ data }) {
      if (name !== 'audit_logs') throw new Error(`unexpected write to ${name}`);
      if (auditFailure) throw new Error('audit unavailable');
      state.writes.push(name);
      state.audits.push(clone(data));
      return { id: data._id };
    },
  });
  return { db: { collection }, state };
}

function makeHandlers(options = {}) {
  const mock = createMockDb(options);
  const logs = [];
  let auditNumber = 0;
  const dependencies = {
    db: mock.db,
    getWXContext: () => options.wxContext || trustedContext,
    serverDate: () => ({ $serverDate: true }),
    logger: { error: (entry) => logs.push(entry) },
    createRequestId: () => 'req-counselor-reports',
    createAuditId: () => `audit_counselor_${++auditNumber}`,
  };
  return {
    ...mock,
    logs,
    listHandler: reportsModule.__testables.createHandler(dependencies),
    detailHandler: detailModule.__testables.createHandler(dependencies),
  };
}

test('1. 无 OPENID 时两个函数均安全失败', async () => {
  const { listHandler, detailHandler } = makeHandlers({ wxContext: { APPID: trustedContext.APPID } });
  assert.equal((await listHandler({})).code, 'INTERNAL_ERROR');
  assert.equal((await detailHandler({ reportId: 'report_001' })).code, 'INTERNAL_ERROR');
});

test('2. 错误 APPID 时两个函数均拒绝', async () => {
  const { listHandler, detailHandler } = makeHandlers({ wxContext: { ...trustedContext, APPID: 'wrong-appid' } });
  assert.equal((await listHandler({})).code, 'FORBIDDEN');
  assert.equal((await detailHandler({ reportId: 'report_001' })).code, 'FORBIDDEN');
});

test('3. 未绑定微信身份返回 UNBOUND', async () => {
  const { listHandler } = makeHandlers({ users: [baseStudent()] });
  assert.equal((await listHandler({})).code, 'UNBOUND');
});

test('4. student 角色不能访问且写 access.denied', async () => {
  const { listHandler, state } = makeHandlers({ users: [baseCounselor({ role: 'student' })] });
  assert.equal((await listHandler({})).code, 'FORBIDDEN');
  assert.equal(state.audits[0].action, 'access.denied');
});

test('5. security 角色不能访问', async () => {
  const { listHandler } = makeHandlers({ users: [baseCounselor({ role: 'security', collegeId: null })] });
  assert.equal((await listHandler({})).code, 'FORBIDDEN');
});

test('6. inactive 账号拒绝且写 access.denied', async () => {
  const { listHandler, state } = makeHandlers({ users: [baseCounselor({ status: 'disabled' })] });
  assert.equal((await listHandler({})).code, 'ACCOUNT_DISABLED');
  assert.equal(state.audits[0].failureReason, 'ACCOUNT_DISABLED');
});

test('7. 绑定不一致或学院为空安全失败并审计', async () => {
  for (const counselor of [baseCounselor({ wxOpenId: 'other' }), baseCounselor({ collegeId: ' ' })]) {
    const { listHandler, state } = makeHandlers({ users: [counselor] });
    assert.equal((await listHandler({})).code, 'INTERNAL_ERROR');
    assert.equal(state.audits[0].action, 'access.denied');
  }
});

test('8. 伪造 collegeId 输入被拒绝且不读取工单', async () => {
  const { listHandler, state } = makeHandlers();
  assert.equal((await listHandler({ collegeId: 'college_other' })).code, 'INVALID_INPUT');
  assert.equal(state.queryTrace.some((entry) => entry.collection === 'fraud_reports'), false);
});

test('9. 列表查询固定使用可信学院', async () => {
  const { listHandler, state } = makeHandlers({ reports: [baseReport()] });
  await listHandler({});
  const query = state.queryTrace.find((entry) => entry.collection === 'fraud_reports');
  assert.equal(query.query.collegeId, 'college_cs');
});

test('10. 列表查询固定只使用 pending_counselor_verify', async () => {
  const { listHandler, state } = makeHandlers({ reports: [baseReport()] });
  await listHandler({});
  const query = state.queryTrace.find((entry) => entry.collection === 'fraud_reports');
  assert.deepEqual(query.query, { collegeId: 'college_cs', status: 'pending_counselor_verify' });
});

test('11. 列表不返回跨学院记录', async () => {
  const { listHandler } = makeHandlers({ reports: [baseReport({ _id: 'other', collegeId: 'college_other' })] });
  assert.deepEqual((await listHandler({})).reports, []);
});

test('12. 列表不返回其他状态记录', async () => {
  const { listHandler } = makeHandlers({ reports: [baseReport({ status: 'security_verifying' })] });
  assert.deepEqual((await listHandler({})).reports, []);
});

test('13. high 风险优先于 medium 和 low', async () => {
  const { listHandler } = makeHandlers({ reports: [
    baseReport({ _id: 'low', riskLevel: 'low' }), baseReport({ _id: 'medium', riskLevel: 'medium' }), baseReport({ _id: 'high', riskLevel: 'high' }),
  ] });
  assert.deepEqual((await listHandler({})).reports.map((report) => report.reportId), ['high', 'medium', 'low']);
});

test('14. 同风险按 submittedAt 从早到晚排序', async () => {
  const { listHandler } = makeHandlers({ reports: [
    baseReport({ _id: 'new', submittedAt: '2026-09-09T09:00:00.000Z' }),
    baseReport({ _id: 'old', submittedAt: '2026-09-08T09:00:00.000Z' }),
  ] });
  assert.deepEqual((await listHandler({})).reports.map((report) => report.reportId), ['old', 'new']);
});

test('15. 列表最多返回 100 条', async () => {
  const reports = Array.from({ length: 101 }, (_, index) => baseReport({ _id: `report_${index}`, submittedAt: `2026-09-08T09:${String(index % 60).padStart(2, '0')}:00.000Z` }));
  const { listHandler, state } = makeHandlers({ reports });
  assert.equal((await listHandler({})).reports.length, 100);
  assert.equal(state.queryTrace.find((entry) => entry.collection === 'fraud_reports').limit, 100);
});

test('16. 列表不泄露 studentId', async () => {
  const response = await makeHandlers({ reports: [baseReport()] }).listHandler({});
  assert.equal(JSON.stringify(response).includes('studentId'), false);
});

test('17. 列表不泄露金额', async () => {
  const response = await makeHandlers({ reports: [baseReport()] }).listHandler({});
  assert.equal(JSON.stringify(response).includes('involvedAmount'), false);
});

test('18. 列表不泄露事件正文', async () => {
  const response = await makeHandlers({ reports: [baseReport()] }).listHandler({});
  assert.equal(JSON.stringify(response).includes('incidentNarrative'), false);
  assert.equal(JSON.stringify(response).includes('敏感事件经过'), false);
});

test('19. 列表不泄露联系方式', async () => {
  const response = await makeHandlers({ reports: [baseReport()] }).listHandler({});
  assert.equal(JSON.stringify(response).includes('contactPhone'), false);
  assert.equal(JSON.stringify(response).includes('13800138000'), false);
});

test('20. 列表成功不写审计', async () => {
  const { listHandler, state } = makeHandlers({ reports: [baseReport()] });
  assert.equal((await listHandler({})).code, 'COUNSELOR_REPORTS_LOADED');
  assert.equal(state.audits.length, 0);
});

test('21. detail 的 reportId 非法时拒绝', async () => {
  const { detailHandler } = makeHandlers();
  for (const event of [{}, { reportId: ' ' }, { reportId: 1 }, { reportId: 'x'.repeat(129) }, null, []]) {
    assert.equal((await detailHandler(event)).code, 'INVALID_INPUT');
  }
});

test('22. 不存在的 detail 返回 NOT_FOUND', async () => {
  const { detailHandler } = makeHandlers();
  assert.equal((await detailHandler({ reportId: 'missing' })).code, 'NOT_FOUND');
});

test('23. 跨学院 detail 返回 FORBIDDEN', async () => {
  const { detailHandler } = makeHandlers({ reports: [baseReport({ collegeId: 'college_other' })] });
  assert.equal((await detailHandler({ reportId: 'report_001' })).code, 'FORBIDDEN');
});

test('24. 跨学院拒绝写 access.denied', async () => {
  const { detailHandler, state } = makeHandlers({ reports: [baseReport({ collegeId: 'college_other' })] });
  await detailHandler({ reportId: 'report_001' });
  assert.deepEqual({ action: state.audits[0].action, resourceType: state.audits[0].resourceType, resourceId: state.audits[0].resourceId },
    { action: 'access.denied', resourceType: 'fraud_report', resourceId: 'report_001' });
});

test('25. 本学院 detail 可成功读取', async () => {
  const { detailHandler } = makeHandlers({ reports: [baseReport()] });
  assert.equal((await detailHandler({ reportId: 'report_001' })).code, 'COUNSELOR_REPORT_DETAIL_LOADED');
});

test('26. detail 的学生始终由 report.studentId 服务端查询', async () => {
  const report = baseReport({ studentId: 'usr_student_002' });
  const { detailHandler, state } = makeHandlers({ users: [baseCounselor(), baseStudent({ _id: 'usr_student_002', name: '李四', studentNo: '20260002' })], reports: [report] });
  const response = await detailHandler({ reportId: 'report_001' });
  assert.equal(response.report.student.name, '李四');
  assert.equal(state.docTrace.some((entry) => entry.collection === 'users' && entry.id === 'usr_student_002'), true);
});

test('27. detail 返回处理所需敏感业务字段', async () => {
  const response = await makeHandlers({ reports: [baseReport()] }).detailHandler({ reportId: 'report_001' });
  for (const key of ['incidentAt', 'involvedAmount', 'hasLoss', 'incidentNarrative', 'suspiciousPlatform', 'suspiciousAccount', 'stillContacting', 'contactPhone', 'studentRemark']) {
    assert.ok(key in response.report, key);
  }
});

test('28. detail 不返回 studentId、collegeId 或 sourceAlertKey', async () => {
  const response = await makeHandlers({ reports: [baseReport()] }).detailHandler({ reportId: 'report_001' });
  const serialized = JSON.stringify(response);
  for (const key of ['studentId', 'collegeId', 'sourceAlertKey']) assert.equal(serialized.includes(key), false, key);
});

test('29. detail 不返回 OPENID 或 identityKey', async () => {
  const response = await makeHandlers({ reports: [baseReport()] }).detailHandler({ reportId: 'report_001' });
  const serialized = JSON.stringify(response);
  for (const key of ['trusted-counselor-openid', 'wxOpenId', 'wxIdentityKey', 'identityKey']) assert.equal(serialized.includes(key), false, key);
});

test('30. 成功 detail 写 report.view_sensitive 审计', async () => {
  const { detailHandler, state } = makeHandlers({ reports: [baseReport()] });
  await detailHandler({ reportId: 'report_001' });
  assert.equal(state.audits[0].action, 'report.view_sensitive');
});

test('31. 敏感详情审计使用可信辅导员 actor', async () => {
  const { detailHandler, state } = makeHandlers({ reports: [baseReport()] });
  await detailHandler({ reportId: 'report_001' });
  assert.deepEqual({ actorId: state.audits[0].actorId, actorRole: state.audits[0].actorRole, actorCollegeId: state.audits[0].actorCollegeId },
    { actorId: 'usr_counselor_001', actorRole: 'counselor', actorCollegeId: 'college_cs' });
});

test('32. 审计不包含敏感业务或身份字段', async () => {
  const { detailHandler, state } = makeHandlers({ reports: [baseReport()] });
  await detailHandler({ reportId: 'report_001' });
  const serialized = JSON.stringify(state.audits[0]);
  for (const secret of ['20260001', '张三', 'trusted-counselor-openid', '敏感事件经过', '3500', '13800138000', '123456', '敏感补充说明', 'sourceAlertKey']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('33. 审计写入失败时 detail 返回 INTERNAL_ERROR', async () => {
  const { detailHandler } = makeHandlers({ reports: [baseReport()], auditFailure: true });
  assert.equal((await detailHandler({ reportId: 'report_001' })).code, 'INTERNAL_ERROR');
});

test('34. 审计失败时敏感详情不进入响应', async () => {
  const { detailHandler } = makeHandlers({ reports: [baseReport()], auditFailure: true });
  const response = await detailHandler({ reportId: 'report_001' });
  assert.equal(response.report, undefined);
  assert.equal(JSON.stringify(response).includes('敏感事件经过'), false);
});

test('35. userInfo 与 tcbContext 完全忽略', async () => {
  const { listHandler, detailHandler } = makeHandlers({ reports: [baseReport()] });
  assert.equal((await listHandler({ userInfo: { OPENID: 'spoofed' }, tcbContext: { OPENID: 'spoofed' } })).code, 'COUNSELOR_REPORTS_LOADED');
  assert.equal((await detailHandler({ reportId: 'report_001', userInfo: { OPENID: 'spoofed' }, tcbContext: { OPENID: 'spoofed' } })).code, 'COUNSELOR_REPORT_DETAIL_LOADED');
});

test('36. 日志只含安全字段', async () => {
  const { detailHandler, logs } = makeHandlers({ reports: [baseReport()], auditFailure: true });
  await detailHandler({ reportId: 'report_001', userInfo: { phone: '13800138000' } });
  assert.deepEqual(Object.keys(logs[0]).sort(), ['code', 'requestId', 'resourceId', 'stage']);
  assert.equal(JSON.stringify(logs[0]).includes('13800138000'), false);
  assert.equal(JSON.stringify(logs[0]).includes('敏感事件经过'), false);
});

test('37. 默认 handler 固定初始化目标环境', () => {
  const environments = [];
  const cloud = {
    init: ({ env }) => environments.push(env),
    database: () => ({ serverDate: () => ({}), collection: () => ({}) }),
    getWXContext: () => trustedContext,
  };
  reportsModule.__testables.createDefaultHandler(cloud);
  detailModule.__testables.createDefaultHandler(cloud);
  assert.deepEqual(environments, ['aa-d4gvb4o3t50fc94f8', 'aa-d4gvb4o3t50fc94f8']);
});
