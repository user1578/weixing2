'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const bcrypt = require('../../cloudfunctions/securityAuthHttp/node_modules/bcryptjs');
const securityAuth = require('../../cloudfunctions/securityAuthHttp');

const {
  createAuthService,
  createHttpHandler,
  createSecurityCollegeManagementService,
  createSecurityDashboardService,
  collegeIdForName,
} = securityAuth.__testables;

const PASSWORD = 'security-dashboard-college-test-password';
const passwordHashPromise = bcrypt.hash(PASSWORD, 4);

function clone(value) {
  return structuredClone(value);
}

function matches(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (expected && expected.__mockOperator === 'in') return expected.values.includes(document[key]);
    if (expected && expected.__mockOperator === 'gte') return new Date(document[key]).getTime() >= expected.value.getTime();
    return document[key] === expected;
  });
}

function createMockDb({ users = [], colleges = [], reports = [], alerts = [], options = {} } = {}) {
  const state = {
    users: users.map(clone), colleges: colleges.map(clone), reports: reports.map(clone), alerts: alerts.map(clone), audits: [],
    reads: [], writes: [], conditionalUpdates: [], transactionCalls: 0,
  };
  const documents = (name) => ({
    users: state.users, colleges: state.colleges, fraud_reports: state.reports, alerts: state.alerts, audit_logs: state.audits,
  }[name]);
  const snapshot = () => ({
    users: state.users.map(clone), colleges: state.colleges.map(clone), reports: state.reports.map(clone), alerts: state.alerts.map(clone), audits: state.audits.map(clone),
  });
  const restore = (saved) => {
    state.users.splice(0, state.users.length, ...saved.users.map(clone));
    state.colleges.splice(0, state.colleges.length, ...saved.colleges.map(clone));
    state.reports.splice(0, state.reports.length, ...saved.reports.map(clone));
    state.alerts.splice(0, state.alerts.length, ...saved.alerts.map(clone));
    state.audits.splice(0, state.audits.length, ...saved.audits.map(clone));
  };
  const makeCollection = (name, inTransaction) => {
    const source = documents(name);
    if (!source) throw new Error(`Unexpected collection: ${name}`);
    const read = (query, limit) => async () => {
      state.reads.push({ name, query: clone(query), inTransaction });
      const selected = query ? source.filter((item) => matches(item, query)) : source;
      return { data: selected.slice(0, limit || selected.length).map(clone) };
    };
    const update = async (query, data) => {
      state.conditionalUpdates.push({ name, query: clone(query), update: clone(data), inTransaction });
      state.writes.push({ name, operation: 'where.update', inTransaction });
      if (options.collegeUpdateZero && name === 'colleges') return { updated: 0, stats: { updated: 0 } };
      const selected = source.filter((item) => matches(item, query));
      selected.forEach((item) => Object.assign(item, clone(data)));
      return { updated: selected.length, stats: { updated: selected.length } };
    };
    return {
      doc(id) { return { get: async () => ({ data: source.filter((item) => item._id === id).map(clone) }) }; },
      where(query) {
        return {
          get: read(query),
          limit(limit) { return { get: read(query, limit) }; },
          count: async () => ({ total: source.filter((item) => matches(item, query)).length }),
          update: (data) => update(query, data),
        };
      },
      limit(limit) { return { get: read(null, limit) }; },
      orderBy(field, direction) {
        return { limit(limit) { return { get: async () => ({ data: source.slice().sort((left, right) => {
          const difference = new Date(left[field]).getTime() - new Date(right[field]).getTime();
          return direction === 'desc' ? -difference : difference;
        }).slice(0, limit).map(clone) }) }; } };
      },
      count: async () => ({ total: source.length }),
      async add(document) {
        state.writes.push({ name, operation: 'add', inTransaction });
        if (name === 'audit_logs' && options.auditFailure) throw new Error('audit unavailable');
        if (name === 'colleges' && (options.duplicateCollegeInsert || source.some((item) => item._id === document._id))) {
          const error = new Error('duplicate key');
          error.code = 'DUPLICATE_KEY';
          throw error;
        }
        source.push(clone(document));
        return { id: document._id };
      },
    };
  };
  return {
    state,
    db: {
      command: {
        in: (values) => ({ __mockOperator: 'in', values: [...values] }),
        gte: (value) => ({ __mockOperator: 'gte', value }),
      },
      collection: (name) => makeCollection(name, false),
      async runTransaction(callback) {
        state.transactionCalls += 1;
        const saved = snapshot();
        try { return await callback({ collection: (name) => makeCollection(name, true) }); }
        catch (error) { restore(saved); throw error; }
      },
    },
  };
}

async function securityUser(overrides = {}) {
  return {
    _id: 'usr_security_001', identityKey: 'security:security01', role: 'security', name: '保卫处测试账号',
    passwordHash: await passwordHashPromise, wxOpenId: null, bindStatus: 'not_applicable', status: 'active', ...overrides,
  };
}

function identity(overrides = {}) {
  return {
    _id: 'usr_student_001', role: 'student', status: 'active', bindStatus: 'bound', collegeId: 'college_cs',
    name: '不应返回的姓名', studentNo: '20260001', wxOpenId: 'not-returned', ...overrides,
  };
}

function college(overrides = {}) {
  return { _id: 'college_cs', name: '计算机科学学院', status: 'active', aliases: [], ...overrides };
}

function report(overrides = {}) {
  return {
    _id: 'report_001', fraudType: 'part_time_scam', riskLevel: 'medium', status: 'pending_security_verify', collegeId: 'college_cs',
    createdAt: new Date('2026-09-11T17:00:00.000Z'), studentId: 'usr_student_001', incidentNarrative: '敏感工单正文', contactPhone: '13800138000', ...overrides,
  };
}

function alert(overrides = {}) {
  return {
    _id: 'alert_001', fraudType: 'fake_loan', riskLevel: 'high', status: 'sent', collegeId: 'college_cs',
    createdAt: new Date('2026-09-12T01:00:00.000Z'), studentId: 'usr_student_001', sourceReference: '敏感来源', content: '敏感预警正文', ...overrides,
  };
}

async function createFixture({ users, colleges, reports, alerts, options = {}, now = new Date('2026-09-12T04:00:00.000Z') } = {}) {
  const security = await securityUser();
  const mock = createMockDb({ users: users || [security], colleges: colleges || [college()], reports, alerts, options });
  let auditIndex = 0;
  const authService = createAuthService({
    userRepository: {
      async findByIdentityKey(identityKey) { return mock.state.users.find((user) => user.identityKey === identityKey) || null; },
      async findById(userId) { return mock.state.users.find((user) => user._id === userId) || null; },
    },
    auditRepository: { async appendAudit() {} }, bcrypt,
    sessionSecret: crypto.randomBytes(48).toString('base64url'), serverDate: () => ({ $serverDate: true }), nowSeconds: () => 1_780_000_000,
    createRequestId: () => 'req_dashboard_college', createAuditId: () => `audit_auth_${++auditIndex}`, createJti: () => 'jti_dashboard_college', logger: { error() {} }, configured: true,
  });
  const collegeManagementService = createSecurityCollegeManagementService({
    authService, db: mock.db, serverDate: () => ({ $serverDate: true }), createRequestId: () => 'req_college',
    createAuditId: () => `audit_college_${++auditIndex}`, logger: { error() {} }, configured: true,
  });
  const dashboardService = createSecurityDashboardService({
    authService, db: mock.db, now: () => now, createRequestId: () => 'req_dashboard', logger: { error() {} }, configured: true,
  });
  const handler = createHttpHandler({ authService, collegeManagementService, dashboardService, allowedOrigins: 'https://security.example.edu', logger: { error() {} } });
  const login = await authService.login({ loginName: 'security01', password: PASSWORD });
  assert.equal(login.code, 'AUTHENTICATED');
  return { ...mock, handler, token: login.token };
}

async function request(fixture, method, path, body, headers = {}) {
  const response = await fixture.handler({ httpMethod: method, path, body, headers });
  return { ...response, json: response.body ? JSON.parse(response.body) : null };
}

function authorization(fixture) {
  return { Authorization: `Bearer ${fixture.token}` };
}

test('1. dashboard 无 token 和失去 security 角色时被拒绝', async () => {
  const fixture = await createFixture();
  assert.equal((await request(fixture, 'GET', '/dashboard')).json.code, 'TOKEN_MISSING');
  fixture.state.users[0].role = 'student';
  assert.equal((await request(fixture, 'GET', '/dashboard', undefined, authorization(fixture))).json.code, 'FORBIDDEN');
});

test('2. dashboard 统计真实数据、按 UTC+8 计算今天，并排除 security 身份', async () => {
  const fixture = await createFixture({
    users: [await securityUser(), identity(), identity({ _id: 'usr_counselor_001', role: 'counselor', bindStatus: 'unbound', collegeId: 'college_math' }), identity({ _id: 'usr_suspended_001', status: 'suspended', bindStatus: 'unbound' })],
    colleges: [college(), college({ _id: 'college_math', name: '数学学院', status: 'disabled' })],
    reports: [
      report(), report({ _id: 'report_process', status: 'in_process', riskLevel: 'high', createdAt: new Date('2026-09-11T16:00:00.000Z') }),
      report({ _id: 'report_closed', status: 'closed', createdAt: new Date('2026-09-11T15:59:59.000Z') }),
    ],
    alerts: [alert()],
  });
  const response = await request(fixture, 'GET', '/dashboard', undefined, authorization(fixture));

  assert.equal(response.json.code, 'DASHBOARD_LOADED');
  assert.deepEqual(response.json.metrics, { pendingSecurityVerifyCount: 1, inProcessCount: 1, closedCount: 1, todayNewReportCount: 2 });
  assert.deepEqual(response.json.identitySummary, { studentCount: 2, counselorCount: 1, boundCount: 1, unboundCount: 2 });
  assert.deepEqual(response.json.collegeSummary, { activeCount: 1, totalCount: 2 });
});

test('3. dashboard 待办和预警最多各五条，排序与安全字段均符合约束', async () => {
  const reports = [
    report({ _id: 'old-high', riskLevel: 'high', createdAt: new Date('2026-09-11T18:00:00.000Z') }),
    report({ _id: 'new-high', riskLevel: 'high', createdAt: new Date('2026-09-11T19:00:00.000Z') }),
    report({ _id: 'process-high', status: 'in_process', riskLevel: 'high' }),
    ...Array.from({ length: 5 }, (_, index) => report({ _id: `report_${index}`, riskLevel: 'low', createdAt: new Date(`2026-09-11T2${index % 4}:00:00.000Z`) })),
  ];
  const alerts = Array.from({ length: 7 }, (_, index) => alert({ _id: `alert_${index}`, createdAt: new Date(`2026-09-12T0${index}:00:00.000Z`) }));
  const fixture = await createFixture({ reports, alerts });
  const response = await request(fixture, 'GET', '/dashboard', undefined, authorization(fixture));
  const captured = JSON.stringify(response.json);

  assert.equal(response.json.pendingReports.length, 5);
  assert.equal(response.json.pendingReports[0].reportId, 'old-high');
  assert.equal(response.json.pendingReports.at(-1).status, 'pending_security_verify');
  assert.equal(response.json.recentAlerts.length, 5);
  assert.equal(response.json.recentAlerts[0].alertId, 'alert_6');
  for (const secret of ['studentId', '不应返回的姓名', '敏感工单正文', '13800138000', '敏感来源', '敏感预警正文', 'sourceReference']) {
    assert.equal(captured.includes(secret), false, secret);
  }
});

test('4. GET colleges 只返回学院统计投影，且需要 security 会话', async () => {
  const fixture = await createFixture({ users: [await securityUser(), identity(), identity({ _id: 'usr_inactive', role: 'counselor', status: 'suspended' })] });
  assert.equal((await request(fixture, 'GET', '/colleges')).json.code, 'TOKEN_MISSING');
  const response = await request(fixture, 'GET', '/colleges', undefined, authorization(fixture));
  assert.deepEqual(response.json.colleges, [{ collegeId: 'college_cs', name: '计算机科学学院', status: 'active', identityCount: 2, activeIdentityCount: 1 }]);
  for (const forbidden of ['name":"不应返回的姓名', 'studentNo', 'wxOpenId', 'passwordHash', 'identityKey']) {
    assert.equal(JSON.stringify(response.json).includes(forbidden), false, forbidden);
  }
});

test('5. 创建学院由服务端确定 ID，并在同一事务写入最小审计', async () => {
  const fixture = await createFixture();
  const response = await request(fixture, 'POST', '/colleges', JSON.stringify({ name: '  新学院  ' }), authorization(fixture));
  const collegeId = collegeIdForName('新学院');
  const created = fixture.state.colleges.find((item) => item._id === collegeId);

  assert.equal(response.json.code, 'COLLEGE_CREATED');
  assert.equal(created.name, '新学院');
  assert.equal(created.status, 'active');
  assert.equal(fixture.state.transactionCalls, 1);
  assert.deepEqual(fixture.state.audits.at(-1).afterSummary, { status: 'active' });
  assert.equal(fixture.state.audits.at(-1).action, 'college.create');
  assert.equal(fixture.state.writes.filter((item) => ['colleges', 'audit_logs'].includes(item.name)).every((item) => item.inTransaction), true);
});

test('6. 创建严格拒绝客户端伪造字段，并将同名或唯一键竞争映射为 CONFLICT', async () => {
  const fixture = await createFixture();
  for (const body of [{ name: '学院', _id: 'forged' }, { name: '学院', collegeId: 'forged' }, { name: '学院', status: 'disabled' }, { name: '学院', aliases: [] }]) {
    assert.equal((await request(fixture, 'POST', '/colleges', JSON.stringify(body), authorization(fixture))).json.code, 'INVALID_INPUT');
  }
  const created = await request(fixture, 'POST', '/colleges', JSON.stringify({ name: '同名学院' }), authorization(fixture));
  assert.equal(created.json.code, 'COLLEGE_CREATED');
  assert.equal((await request(fixture, 'POST', '/colleges', JSON.stringify({ name: ' 同名学院 ' }), authorization(fixture))).json.code, 'CONFLICT');
  const duplicate = await createFixture({ options: { duplicateCollegeInsert: true } });
  assert.equal((await request(duplicate, 'POST', '/colleges', JSON.stringify({ name: '竞争学院' }), authorization(duplicate))).json.code, 'CONFLICT');
});

test('7. 学院状态更新采用条件更新、无 data 包装并写正确审计', async () => {
  const fixture = await createFixture({ users: [await securityUser()] });
  const response = await request(fixture, 'POST', '/colleges/college_cs/status', JSON.stringify({ status: 'disabled' }), authorization(fixture));
  const update = fixture.state.conditionalUpdates.at(-1);
  const audit = fixture.state.audits.at(-1);

  assert.equal(response.json.code, 'COLLEGE_STATUS_UPDATED');
  assert.deepEqual(update.query, { _id: 'college_cs', status: 'active' });
  assert.equal(Object.hasOwn(update.update, 'data'), false);
  assert.equal(update.update.status, 'disabled');
  assert.deepEqual(audit.beforeSummary, { status: 'active' });
  assert.deepEqual(audit.afterSummary, { status: 'disabled' });
  assert.equal(audit.action, 'college.status_update');
});

test('8. 有有效身份的学院不能停用；停用后可重新启用；同状态和更新丢失均冲突', async () => {
  const inUse = await createFixture({ users: [await securityUser(), identity()] });
  assert.equal((await request(inUse, 'POST', '/colleges/college_cs/status', JSON.stringify({ status: 'disabled' }), authorization(inUse))).json.code, 'COLLEGE_IN_USE');
  assert.equal(inUse.state.colleges[0].status, 'active');

  const reenable = await createFixture({ users: [await securityUser()], colleges: [college({ status: 'disabled' })] });
  assert.equal((await request(reenable, 'POST', '/colleges/college_cs/status', JSON.stringify({ status: 'active' }), authorization(reenable))).json.code, 'COLLEGE_STATUS_UPDATED');
  assert.equal((await request(reenable, 'POST', '/colleges/college_cs/status', JSON.stringify({ status: 'active' }), authorization(reenable))).json.code, 'CONFLICT');

  const updateZero = await createFixture({ users: [await securityUser()], options: { collegeUpdateZero: true } });
  assert.equal((await request(updateZero, 'POST', '/colleges/college_cs/status', JSON.stringify({ status: 'disabled' }), authorization(updateZero))).json.code, 'CONFLICT');
});

test('9. colleges 路由仅开放预期方法，预检包含 GET/POST', async () => {
  const fixture = await createFixture();
  const options = await request(fixture, 'OPTIONS', '/colleges', undefined, { Origin: 'https://security.example.edu' });
  assert.equal(options.statusCode, 204);
  assert.equal(options.headers['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS');
  assert.equal((await request(fixture, 'DELETE', '/colleges/college_cs', undefined, authorization(fixture))).json.code, 'NOT_FOUND');
});
