'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const securityAuth = require('../../cloudfunctions/securityAuthHttp');

const { createHttpHandler, createSecurityReportManagementService } = securityAuth.__testables;
const security = { _id: 'security_1', role: 'security', status: 'active', wxOpenId: null, bindStatus: 'not_applicable', name: '保卫处' };
const counselor = { _id: 'counselor_1', role: 'counselor', status: 'active', collegeId: 'college_a' };
const student = { _id: 'student_1', role: 'student', name: '学生甲', studentNo: '20260001', wxOpenId: 'secret-openid', wxIdentityKey: 'openid:secret-openid', passwordHash: 'never-return' };
const baseReport = { _id: 'report_1', studentId: 'student_1', collegeId: 'college_a', fraudType: 'fake_loan', riskLevel: 'high', status: 'pending_security_verify', submittedAt: '2026-09-12T10:00:00.000Z', version: 2, hasLoss: true, currentHandlerId: 'counselor_1', incidentNarrative: '敏感经过', suspiciousAccount: '敏感账号', contactPhone: '13800138000', studentRemark: '学生补充', riskReasons: ['has_loss'] };

function createDb({ users = [security, counselor, student], reports = [baseReport] } = {}) {
  const state = { users: structuredClone(users), reports: structuredClone(reports), colleges: [{ _id: 'college_a', name: '计算机学院' }], followups: [], dispositions: [], audits: [], transactionCalls: 0 };
  const rows = (name) => ({ users: state.users, fraud_reports: state.reports, colleges: state.colleges, counselor_followups: state.followups, security_dispositions: state.dispositions, audit_logs: state.audits })[name];
  const matching = (list, query) => list.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
  const snapshot = () => structuredClone({ users: state.users, reports: state.reports, colleges: state.colleges, followups: state.followups, dispositions: state.dispositions, audits: state.audits });
  const restore = (saved) => Object.keys(saved).forEach((key) => state[key].splice(0, state[key].length, ...saved[key]));
  function collection(name) { return {
    doc(id) { return { get: async () => { const found = rows(name).find((row) => row._id === id); return { data: found ? [structuredClone(found)] : [] }; } }; },
    where(query) { const get = async () => ({ data: structuredClone(matching(rows(name), query)) }); return {
      get, limit() { return { get }; }, orderBy() { return { limit() { return { get }; } }; },
      async update(data) { const found = matching(rows(name), query); found.forEach((row) => Object.assign(row, structuredClone(data))); return { updated: found.length, stats: { updated: found.length } }; },
    }; },
    limit() { return { get: async () => ({ data: structuredClone(rows(name)) }) }; },
    async add(document) { rows(name).push(structuredClone(document)); return { id: document._id }; },
  }; }
  return { state, db: { collection, async runTransaction(callback) { state.transactionCalls += 1; const saved = snapshot(); try { return await callback({ collection }); } catch (error) { restore(saved); throw error; } } } };
}

function service(options = {}) {
  const mock = createDb(options);
  let sequence = 0;
  const authService = options.authService || { async authenticateSecuritySession() { return { ok: true, user: structuredClone(security) }; } };
  return { ...mock, service: createSecurityReportManagementService({ authService, db: mock.db, serverDate: () => ({ $serverDate: ++sequence }), createRequestId: () => `req_${++sequence}`, createAuditId: () => `audit_${++sequence}`, createFollowupId: () => `followup_${++sequence}`, createDispositionId: () => `disposition_${++sequence}`, logger: { error() {} }, configured: true }) };
}

test('保卫处三队列只返回最小列表字段，不泄露学生或正文', async () => {
  const { service: target } = service({ reports: [baseReport, { ...baseReport, _id: 'processing', status: 'in_process' }, { ...baseReport, _id: 'closed', status: 'closed' }] });
  const result = await target.list('Bearer token');
  assert.equal(result.code, 'REPORTS_LOADED');
  assert.deepEqual(Object.keys(result.queues).sort(), ['closed', 'inProcess', 'pendingSecurityVerify']);
  assert.equal(result.queues.pendingSecurityVerify[0].collegeName, '计算机学院');
  for (const forbidden of ['studentId', 'incidentNarrative', 'suspiciousAccount', 'contactPhone', 'currentHandlerId']) assert.equal(JSON.stringify(result).includes(forbidden), false, forbidden);
});

test('保卫处详情记录敏感查看审计，响应不包含 OPENID 或密码', async () => {
  const fixture = service();
  const result = await fixture.service.detail('Bearer token', 'report_1');
  assert.equal(result.code, 'REPORT_DETAIL_LOADED');
  assert.equal(result.report.incidentNarrative, '敏感经过');
  assert.deepEqual(result.student, { name: '学生甲', studentNo: '20260001' });
  assert.equal(fixture.state.audits[0].action, 'report.view_sensitive');
  for (const forbidden of ['wxOpenId', 'wxIdentityKey', 'passwordHash', 'secret-openid']) assert.equal(JSON.stringify(result).includes(forbidden), false, forbidden);
});

test('退回辅导员在同一事务更新工单、新建 pending 跟进、处置及审计', async () => {
  const fixture = service();
  const result = await fixture.service.returnToCounselor('Bearer token', 'report_1', JSON.stringify({ version: 2, verificationResult: 'suspected', returnReason: '请补充联系核验结果', actionContent: '退回补充材料' }));
  assert.equal(result.code, 'REPORT_RETURNED_TO_COUNSELOR');
  assert.equal(fixture.state.transactionCalls, 1);
  assert.deepEqual({ status: fixture.state.reports[0].status, version: fixture.state.reports[0].version, currentHandlerId: fixture.state.reports[0].currentHandlerId }, { status: 'pending_counselor_verify', version: 3, currentHandlerId: 'counselor_1' });
  assert.equal(fixture.state.followups[0].status, 'pending');
  assert.equal(fixture.state.followups[0].opinion, '保卫处退回补充');
  assert.equal(fixture.state.dispositions[0].action, 'return');
  assert.equal(fixture.state.audits[0].action, 'report.return');
});

test('原辅导员不可用时退回拒绝且事务回滚', async () => {
  const fixture = service({ users: [security, { ...counselor, status: 'suspended' }, student] });
  const result = await fixture.service.returnToCounselor('Bearer token', 'report_1', { version: 2, verificationResult: 'suspected', returnReason: '补充', actionContent: '说明' });
  assert.equal(result.code, 'CONFLICT');
  assert.equal(fixture.state.reports[0].status, 'pending_security_verify');
  assert.equal(fixture.state.followups.length, 0);
  assert.equal(fixture.state.dispositions.length, 0);
});

test('受保护 return 在空 body 前优先鉴权，已登录用户的空 body 才返回 INVALID_INPUT', async () => {
  const authenticationCalls = [];
  const unauthorized = service({ authService: {
    async authenticateSecuritySession(authorization) {
      authenticationCalls.push(authorization);
      return { ok: false, result: { ok: false, code: 'TOKEN_MISSING' } };
    },
  } });
  const unauthenticatedHandler = createHttpHandler({
    authService: { async login() { return { ok: true, code: 'AUTHENTICATED' }; }, async session() { return { ok: true, code: 'SESSION_VALID' }; } },
    reportManagementService: unauthorized.service,
    allowedOrigins: 'https://security.example.edu', logger: { error() {} },
  });
  const missing = await unauthenticatedHandler({ httpMethod: 'POST', path: '/reports/report_1/return', body: '{}', headers: {} });
  assert.equal(missing.statusCode, 401);
  assert.equal(JSON.parse(missing.body).code, 'TOKEN_MISSING');
  assert.deepEqual(authenticationCalls, [undefined]);
  assert.equal(unauthorized.state.transactionCalls, 0);

  const authorized = service();
  const invalid = await authorized.service.returnToCounselor('Bearer token', 'report_1', '{}');
  assert.equal(invalid.code, 'INVALID_INPUT');
  assert.equal(authorized.state.transactionCalls, 0);
});

test('HTTP 内部 reports 路由、CORS 及既有 start-process/close 路由保持精确匹配', async () => {
  const calls = [];
  const handler = createHttpHandler({
    authService: { async login() { return { ok: true, code: 'AUTHENTICATED' }; }, async session() { return { ok: true, code: 'SESSION_VALID' }; } },
    reportManagementService: {
      async list(token) { calls.push(['list', token]); return { ok: true, code: 'REPORTS_LOADED', queues: {} }; },
      async detail(token, reportId) { calls.push(['detail', token, reportId]); return { ok: true, code: 'REPORT_DETAIL_LOADED' }; },
      async returnToCounselor(token, reportId, body) { calls.push(['return', token, reportId, body]); return { ok: true, code: 'REPORT_RETURNED_TO_COUNSELOR' }; },
    },
    reportProcessingService: { async startProcess(token, reportId) { calls.push(['start', token, reportId]); return { ok: true, code: 'REPORT_PROCESSING_STARTED' }; } },
    reportClosingService: { async close(token, reportId) { calls.push(['close', token, reportId]); return { ok: true, code: 'REPORT_CLOSED' }; } },
    allowedOrigins: 'https://security.example.edu', logger: { error() {} },
  });
  const request = (httpMethod, path, body) => handler({ httpMethod, path, body, headers: { origin: 'https://security.example.edu', authorization: 'Bearer token' } });
  assert.equal(JSON.parse((await request('GET', '/reports')).body).code, 'REPORTS_LOADED');
  assert.equal(JSON.parse((await request('GET', '/reports/report_1')).body).code, 'REPORT_DETAIL_LOADED');
  assert.equal(JSON.parse((await request('POST', '/reports/report_1/return', '{"version":2}')).body).code, 'REPORT_RETURNED_TO_COUNSELOR');
  assert.equal(JSON.parse((await request('POST', '/reports/report_1/start-process')).body).code, 'REPORT_PROCESSING_STARTED');
  assert.equal(JSON.parse((await request('POST', '/reports/report_1/close')).body).code, 'REPORT_CLOSED');
  for (const [path, methods] of [['/reports', 'GET, OPTIONS'], ['/reports/report_1', 'GET, OPTIONS'], ['/reports/report_1/return', 'POST, OPTIONS']]) {
    const response = await request('OPTIONS', path);
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['Access-Control-Allow-Methods'], methods);
  }
  const legacy = await request('GET', '/security/reports');
  assert.equal(legacy.statusCode, 404);
  assert.deepEqual(calls.map(([name]) => name), ['list', 'detail', 'return', 'start', 'close']);
});
