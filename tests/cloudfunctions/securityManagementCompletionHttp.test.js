'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const bcrypt = require('../../cloudfunctions/securityAuthHttp/node_modules/bcryptjs');
const securityAuth = require('../../cloudfunctions/securityAuthHttp');

const {
  createAuthService,
  createHttpHandler,
  createSecurityAlertService,
  createSecurityAuditLogService,
  createSecurityRiskRuleManagementService,
  createSecurityStatisticsService,
} = securityAuth.__testables;

const PASSWORD = 'security-management-completion-password';
const NOW = new Date('2026-09-12T04:00:00.000Z');
const ORIGIN = 'https://security.example.edu';
const passwordHashPromise = bcrypt.hash(PASSWORD, 4);

function clone(value) { return structuredClone(value); }
function dateValue(value) { const parsed = new Date(value).getTime(); return Number.isNaN(parsed) ? 0 : parsed; }

function matches(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    const actual = document[key];
    if (expected && expected.__operator === 'in') return expected.values.includes(actual);
    if (expected && expected.__operator === 'gte') return dateValue(actual) >= dateValue(expected.value);
    return actual === expected;
  });
}

function createMockDb({ users = [], colleges = [], reports = [], alerts = [], rules = [], audits = [], options = {} } = {}) {
  const state = {
    users: users.map(clone), colleges: colleges.map(clone), reports: reports.map(clone), alerts: alerts.map(clone),
    rules: rules.map(clone), audits: audits.map(clone), writes: [], conditionalUpdates: [], transactionCalls: 0,
  };
  const documents = (name) => ({
    users: state.users, colleges: state.colleges, fraud_reports: state.reports, alerts: state.alerts,
    risk_rules: state.rules, audit_logs: state.audits,
  })[name];
  const snapshot = () => clone({ users: state.users, colleges: state.colleges, reports: state.reports, alerts: state.alerts, rules: state.rules, audits: state.audits });
  const restore = (saved) => {
    state.users.splice(0, state.users.length, ...saved.users); state.colleges.splice(0, state.colleges.length, ...saved.colleges);
    state.reports.splice(0, state.reports.length, ...saved.reports); state.alerts.splice(0, state.alerts.length, ...saved.alerts);
    state.rules.splice(0, state.rules.length, ...saved.rules); state.audits.splice(0, state.audits.length, ...saved.audits);
  };
  function collection(name, inTransaction = false) {
    if (!documents(name)) throw new Error(`unexpected collection ${name}`);
    const read = (query = null, limit = null, orderBy = null) => {
      let rows = documents(name).filter((row) => !query || matches(row, query));
      if (orderBy) rows = rows.slice().sort((left, right) => (orderBy.direction === 'desc' ? -1 : 1) * (dateValue(left[orderBy.field]) - dateValue(right[orderBy.field])));
      return (limit === null ? rows : rows.slice(0, limit)).map(clone);
    };
    const update = async (query, data) => {
      const selected = documents(name).filter((row) => matches(row, query));
      state.conditionalUpdates.push({ name, query: clone(query), data: clone(data), inTransaction });
      state.writes.push({ name, operation: 'update', inTransaction });
      if (options.updateZero || (options.alertUpdateZero && name === 'alerts') || (options.ruleUpdateZero && name === 'risk_rules')) return { updated: 0, stats: { updated: 0 } };
      selected.forEach((row) => Object.assign(row, clone(data)));
      return { updated: selected.length, stats: { updated: selected.length } };
    };
    const where = (query) => ({
      get: async () => ({ data: read(query) }),
      limit: (limit) => ({ get: async () => ({ data: read(query, limit) }) }),
      count: async () => ({ total: read(query).length }),
      update: (data) => update(query, data),
    });
    return {
      doc: (id) => ({ get: async () => ({ data: read({ _id: id }) }) }),
      where,
      count: async () => ({ total: documents(name).length }),
      limit: (limit) => ({ get: async () => ({ data: read(null, limit) }) }),
      orderBy: (field, direction) => ({ limit: (limit) => ({ get: async () => ({ data: read(null, limit, { field, direction }) }) }) }),
      add: async (data) => {
        if (name === 'audit_logs' && options.auditFailure) throw new Error('audit unavailable');
        documents(name).push(clone(data)); state.writes.push({ name, operation: 'add', inTransaction }); return { id: data._id };
      },
    };
  }
  return {
    state,
    db: {
      command: { in: (values) => ({ __operator: 'in', values: [...values] }), gte: (value) => ({ __operator: 'gte', value: clone(value) }) },
      collection: (name) => collection(name, false),
      runTransaction: async (callback) => {
        state.transactionCalls += 1; const saved = snapshot();
        try { return await callback({ collection: (name) => collection(name, true) }); }
        catch (error) { restore(saved); throw error; }
      },
    },
  };
}

async function securityUser(overrides = {}) {
  return {
    _id: 'usr_security_001', identityKey: 'security:security01', role: 'security', name: '保卫处',
    passwordHash: await passwordHashPromise, status: 'active', bindStatus: 'not_applicable', wxOpenId: null, ...overrides,
  };
}

function student(overrides = {}) { return { _id: 'usr_student_001', identityKey: 'student:20260001', role: 'student', name: '学生甲', studentNo: '20260001', collegeId: 'college_cs', status: 'active', ...overrides }; }
function counselor(overrides = {}) { return { _id: 'usr_counselor_001', identityKey: 'counselor:20260002', role: 'counselor', name: '辅导员乙', collegeId: 'college_cs', status: 'active', ...overrides }; }
function college(overrides = {}) { return { _id: 'college_cs', name: '计算机学院', status: 'active', ...overrides }; }
function rule(overrides = {}) { return { _id: 'rule_default', status: 'enabled', highAmount: 5000, midAmountMin: 1, repeatAlertWindowDays: 30, highAlertRepeatCount: 3, midAlertRepeatCount: 2, keyFraudTypes: ['part_time_scam', 'impersonate_public', 'fake_loan', 'fake_refund'], version: 1, ...overrides }; }
function alert(overrides = {}) { return { _id: 'alert_001', studentId: 'usr_student_001', collegeId: 'college_cs', fraudType: 'fake_loan', riskLevel: 'high', riskReasons: ['key_fraud_type'], status: 'sent', content: '预警敏感内容', sourceReference: '内部来源', createdAt: new Date('2026-09-12T02:00:00.000Z'), issuedAt: new Date('2026-09-12T02:01:00.000Z'), version: 3, ...overrides }; }
function report(overrides = {}) { return { _id: 'report_001', collegeId: 'college_cs', fraudType: 'fake_loan', riskLevel: 'high', status: 'pending_security_verify', createdAt: new Date('2026-09-12T01:00:00.000Z'), incidentNarrative: '敏感事件正文', contactPhone: '13800138000', ...overrides }; }

async function createFixture({ users, colleges, reports, alerts, rules, audits, options = {} } = {}) {
  const security = await securityUser();
  const mock = createMockDb({
    users: users || [security, student(), counselor()], colleges: colleges || [college()], reports: reports || [], alerts: alerts || [], rules: rules || [rule()], audits: audits || [], options,
  });
  let sequence = 0;
  const serverDate = () => ({ $serverDate: ++sequence });
  const authService = createAuthService({
    userRepository: {
      findByIdentityKey: async (identityKey) => clone(mock.state.users.find((user) => user.identityKey === identityKey) || null),
      findById: async (userId) => clone(mock.state.users.find((user) => user._id === userId) || null),
    },
    auditRepository: { appendAudit: async () => {} }, bcrypt, sessionSecret: crypto.randomBytes(48).toString('base64url'), serverDate,
    nowSeconds: () => Math.floor(NOW.getTime() / 1000), createRequestId: () => `req_auth_${++sequence}`,
    createAuditId: () => `audit_auth_${++sequence}`, createJti: () => 'jti_management_completion', logger: { error() {} }, configured: true,
  });
  const shared = { authService, db: mock.db, serverDate, createRequestId: () => `req_${++sequence}`, createAuditId: () => `audit_${++sequence}`, logger: { error() {} }, configured: true };
  const alertService = createSecurityAlertService({ ...shared, now: () => new Date(NOW) });
  const riskRuleManagementService = createSecurityRiskRuleManagementService(shared);
  const statisticsService = createSecurityStatisticsService({ authService, db: mock.db, now: () => new Date(NOW), createRequestId: () => `req_statistics_${++sequence}`, logger: { error() {} }, configured: true });
  const auditLogService = createSecurityAuditLogService({ authService, db: mock.db, createRequestId: () => `req_audit_${++sequence}`, logger: { error() {} }, configured: true });
  const handler = createHttpHandler({ authService, alertService, riskRuleManagementService, statisticsService, auditLogService, allowedOrigins: ORIGIN, logger: { error() {} } });
  const login = await authService.login({ loginName: 'security01', password: PASSWORD });
  assert.equal(login.code, 'AUTHENTICATED');
  return { ...mock, handler, token: login.token };
}

async function request(fixture, method, path, body, headers = {}) {
  const response = await fixture.handler({ httpMethod: method, path, body, headers });
  return { ...response, json: response.body ? JSON.parse(response.body) : null };
}
function authorized(fixture) { return { Authorization: `Bearer ${fixture.token}` }; }

test('1. 预警列表鉴权、最多 100 条、筛选与字段裁剪均正确', async () => {
  const alerts = Array.from({ length: 101 }, (_, index) => alert({ _id: `alert_${index}`, status: index % 2 ? 'sent' : 'closed', riskLevel: index % 3 ? 'medium' : 'high', createdAt: new Date(NOW.getTime() - (index * 1000)), version: index + 1 }));
  const fixture = await createFixture({ alerts });
  assert.equal((await request(fixture, 'GET', '/alerts')).json.code, 'TOKEN_MISSING');
  const response = await request(fixture, 'GET', '/alerts?status=sent&riskLevel=medium', undefined, authorized(fixture));
  assert.equal(response.json.code, 'ALERTS_LOADED');
  assert.equal(response.json.alerts.length <= 100, true);
  assert.equal(response.json.alerts.every((item) => item.status === 'sent' && item.riskLevel === 'medium'), true);
  for (const forbidden of ['studentId', '学生甲', 'studentNo', 'sourceReference', '内部来源', 'content', 'wxOpenId']) assert.equal(JSON.stringify(response.json).includes(forbidden), false, forbidden);
  const options = await request(fixture, 'OPTIONS', '/alerts', undefined, { Origin: ORIGIN });
  assert.equal(options.headers['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS');
});

test('2. 预警详情只在鉴权后返回允许字段并写敏感查看审计', async () => {
  const fixture = await createFixture({ alerts: [alert()] });
  const response = await request(fixture, 'GET', '/alerts/alert_001', undefined, authorized(fixture));
  assert.equal(response.json.code, 'ALERT_DETAIL_LOADED');
  assert.deepEqual(response.json.student, { name: '学生甲', studentNo: '20260001' });
  assert.equal(response.json.alert.content, '预警敏感内容');
  for (const forbidden of ['sourceReference', '内部来源', 'wxOpenId', 'identityKey', 'passwordHash']) assert.equal(JSON.stringify(response.json).includes(forbidden), false, forbidden);
  assert.equal(fixture.state.audits.at(-1).action, 'alert.view_sensitive');
});

test('3. close 仅允许活动预警、条件更新和最小审计，并在失败时回滚', async () => {
  const fixture = await createFixture({ alerts: [alert()] });
  assert.equal((await request(fixture, 'POST', '/alerts/alert_001/close', '{}')).json.code, 'TOKEN_MISSING');
  const success = await request(fixture, 'POST', '/alerts/alert_001/close', JSON.stringify({ version: 3, closeReason: '已完成跟进' }), authorized(fixture));
  assert.equal(success.json.code, 'ALERT_CLOSED');
  assert.deepEqual(fixture.state.conditionalUpdates.at(-1).query, { _id: 'alert_001', status: 'sent', version: 3 });
  assert.equal(fixture.state.alerts[0].status, 'closed');
  assert.equal(Object.hasOwn(fixture.state.alerts[0], 'closeReason'), false);
  assert.deepEqual(fixture.state.audits.at(-1).beforeSummary, { status: 'sent' });
  assert.deepEqual(fixture.state.audits.at(-1).afterSummary, { status: 'closed' });
  for (const invalidAlert of [alert({ _id: 'pending', status: 'pending_dispatch' }), alert({ _id: 'closed', status: 'closed' })]) {
    const invalid = await createFixture({ alerts: [invalidAlert] });
    assert.equal((await request(invalid, 'POST', `/alerts/${invalidAlert._id}/close`, JSON.stringify({ version: 3, closeReason: '原因' }), authorized(invalid))).json.code, 'CONFLICT');
  }
  const conflict = await createFixture({ alerts: [alert()] });
  assert.equal((await request(conflict, 'POST', '/alerts/alert_001/close', JSON.stringify({ version: 2, closeReason: '原因' }), authorized(conflict))).json.code, 'CONFLICT');
  const rollback = await createFixture({ alerts: [alert()], options: { auditFailure: true } });
  assert.equal((await request(rollback, 'POST', '/alerts/alert_001/close', JSON.stringify({ version: 3, closeReason: '原因' }), authorized(rollback))).json.code, 'INTERNAL_ERROR');
  assert.equal(rollback.state.alerts[0].status, 'sent');
});

test('4. 风险规则读取、更新、版本冲突和审计均受 security 会话保护', async () => {
  const fixture = await createFixture({ reports: [report()], alerts: [alert()] });
  assert.equal((await request(fixture, 'GET', '/risk-rules/default')).json.code, 'TOKEN_MISSING');
  const loaded = await request(fixture, 'GET', '/risk-rules/default', undefined, authorized(fixture));
  assert.equal(loaded.json.code, 'RISK_RULE_LOADED');
  assert.equal(loaded.json.rule.highAmount, 5000);
  const next = { ...loaded.json.rule, highAmount: 6000, keyFraudTypes: ['fake_loan', 'fake_refund'] };
  const updated = await request(fixture, 'POST', '/risk-rules/default', JSON.stringify(next), authorized(fixture));
  assert.equal(updated.json.code, 'RISK_RULE_UPDATED');
  assert.equal(updated.json.rule.version, 2);
  assert.equal(fixture.state.reports[0].riskLevel, 'high');
  assert.equal(fixture.state.alerts[0].riskLevel, 'high');
  assert.equal(fixture.state.audits.at(-1).action, 'risk_rule.update');
  assert.deepEqual(Object.keys(fixture.state.audits.at(-1).afterSummary).sort(), ['highAlertRepeatCount', 'highAmount', 'keyFraudTypes', 'midAlertRepeatCount', 'midAmountMin', 'repeatAlertWindowDays']);
  assert.equal((await request(fixture, 'POST', '/risk-rules/default', JSON.stringify(next), authorized(fixture))).json.code, 'CONFLICT');
});

test('5. 风险规则拒绝不安全阈值、非法类型、越界次数和非 security 会话', async () => {
  const fixture = await createFixture();
  const base = (await request(fixture, 'GET', '/risk-rules/default', undefined, authorized(fixture))).json.rule;
  for (const body of [
    { ...base, highAmount: 1, midAmountMin: 1 },
    { ...base, keyFraudTypes: ['other'] },
    { ...base, keyFraudTypes: ['fake_loan', 'fake_loan'] },
    { ...base, repeatAlertWindowDays: 366 },
    { ...base, highAlertRepeatCount: 0 },
  ]) assert.equal((await request(fixture, 'POST', '/risk-rules/default', JSON.stringify(body), authorized(fixture))).json.code, 'INVALID_INPUT');
  fixture.state.users[0].role = 'student';
  assert.equal((await request(fixture, 'POST', '/risk-rules/default', '{}', authorized(fixture))).json.code, 'FORBIDDEN');
});

test('6. 旧默认规则缺少 version 时安全以 0 读出并在首个成功更新后补齐 version', async () => {
  const legacy = rule(); delete legacy.version;
  const fixture = await createFixture({ rules: [legacy] });
  const loaded = await request(fixture, 'GET', '/risk-rules/default', undefined, authorized(fixture));
  assert.equal(loaded.json.rule.version, 0);
  const updated = await request(fixture, 'POST', '/risk-rules/default', JSON.stringify(loaded.json.rule), authorized(fixture));
  assert.equal(updated.json.code, 'RISK_RULE_UPDATED');
  assert.equal(fixture.state.rules[0].version, 1);
});

test('7. 统计中心返回真实聚合、包含 disabled 学院、以 Asia/Shanghai 计算最近七日且不泄露明细', async () => {
  const fixture = await createFixture({
    colleges: [college(), college({ _id: 'college_math', name: '数学学院', status: 'disabled' })],
    reports: [
      report({ _id: 'today', status: 'pending_counselor_verify', riskLevel: 'low', fraudType: 'other', createdAt: new Date('2026-09-11T16:00:00.000Z') }),
      report({ _id: 'yesterday', collegeId: 'college_math', status: 'closed', riskLevel: 'medium', fraudType: 'fake_refund', createdAt: new Date('2026-09-10T16:00:00.000Z') }),
      report({ _id: 'before_window', status: 'in_process', createdAt: new Date('2026-09-05T15:59:00.000Z') }),
    ],
    alerts: [alert(), alert({ _id: 'alert_math', collegeId: 'college_math', status: 'closed' })],
  });
  assert.equal((await request(fixture, 'GET', '/statistics')).json.code, 'TOKEN_MISSING');
  const response = await request(fixture, 'GET', '/statistics', undefined, authorized(fixture));
  assert.equal(response.json.code, 'STATISTICS_LOADED');
  assert.deepEqual(response.json.overview, { totalReports: 3, pendingCounselor: 1, pendingSecurity: 0, inProcess: 1, closed: 1, totalAlerts: 2, activeAlerts: 1, studentCount: 1, counselorCount: 1 });
  assert.deepEqual(response.json.riskDistribution, { low: 1, medium: 1, high: 1 });
  assert.equal(response.json.reportByFraudType.other, 1);
  assert.equal(response.json.reportByCollege.some((item) => item.collegeId === 'college_math' && item.reportCount === 1), true);
  assert.equal(response.json.alertByCollege.some((item) => item.collegeId === 'college_math' && item.alertCount === 1), true);
  assert.equal(response.json.dailyReports.at(-1).date, '2026-09-12');
  assert.equal(response.json.dailyReports.at(-1).count, 1);
  for (const forbidden of ['学生甲', '敏感事件正文', '13800138000', 'studentId', 'content', 'wxOpenId']) assert.equal(JSON.stringify(response.json).includes(forbidden), false, forbidden);
});

test('8. 审计记录 security only、按时间降序限制 200 条、可安全筛选且裁剪敏感摘要', async () => {
  const audits = Array.from({ length: 205 }, (_, index) => ({
    _id: `audit_${index}`, actorId: 'usr_security_001', actorRole: 'security', action: index % 2 ? 'alert.close' : 'risk_rule.update',
    resourceType: index % 2 ? 'alert' : 'risk_rule', resourceId: `resource_${index}`, result: index % 3 ? 'success' : 'failure',
    failureReason: index % 3 ? undefined : 'CONFLICT', beforeSummary: { status: 'sent', content: '不得返回正文' },
    afterSummary: { status: 'closed', closeReason: '不得返回原因' }, requestId: `req_${index}`, createdAt: new Date(NOW.getTime() - (index * 1000)), token: 'secret-token',
  }));
  const fixture = await createFixture({ audits });
  assert.equal((await request(fixture, 'GET', '/audit-logs')).json.code, 'TOKEN_MISSING');
  const response = await request(fixture, 'GET', '/audit-logs?action=alert.close&resourceType=alert&result=success', undefined, authorized(fixture));
  assert.equal(response.json.code, 'AUDIT_LOGS_LOADED');
  assert.equal(response.json.logs.length <= 200, true);
  assert.equal(response.json.logs.every((item) => item.action === 'alert.close' && item.resourceType === 'alert' && item.result === 'success'), true);
  assert.equal(dateValue(response.json.logs[0].createdAt) >= dateValue(response.json.logs.at(-1).createdAt), true);
  const serialized = JSON.stringify(response.json);
  for (const forbidden of ['secret-token', '不得返回正文', '不得返回原因', 'token', 'password', 'wxOpenId']) assert.equal(serialized.includes(forbidden), false, forbidden);
  const options = await request(fixture, 'OPTIONS', '/audit-logs', undefined, { Origin: ORIGIN });
  assert.equal(options.headers['Access-Control-Allow-Methods'], 'GET, OPTIONS');
});

test('9. 新增只读接口的非法筛选在认证后拒绝，且不产生业务写入', async () => {
  const fixture = await createFixture({ alerts: [alert()] });
  const badAlertQuery = await request(fixture, 'GET', '/alerts?studentId=usr_student_001', undefined, authorized(fixture));
  const badAuditQuery = await request(fixture, 'GET', '/audit-logs?token=forged', undefined, authorized(fixture));
  assert.equal(badAlertQuery.json.code, 'INVALID_INPUT');
  assert.equal(badAuditQuery.json.code, 'INVALID_INPUT');
  assert.equal(fixture.state.writes.length, 0);
});
