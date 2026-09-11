'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const bcrypt = require('../../cloudfunctions/securityAuthHttp/node_modules/bcryptjs');
const securityAuth = require('../../cloudfunctions/securityAuthHttp');

const {
  createAuthService,
  createHttpHandler,
  createSecurityReportProcessingService,
} = securityAuth.__testables;

const PASSWORD = 'security-report-processing-test-password';
const ALLOWED_ORIGIN = 'https://security.example.edu';
const passwordHashPromise = bcrypt.hash(PASSWORD, 4);

function clone(value) {
  return structuredClone(value);
}

function equals(left, right) {
  return left instanceof Date && right instanceof Date ? left.getTime() === right.getTime() : left === right;
}

function matches(document, condition) {
  return Object.entries(condition).every(([key, expected]) => equals(document[key], expected));
}

function documentResult(document) {
  const data = document ? [clone(document)] : [];
  if (document) Object.assign(data, clone(document));
  return { data };
}

function createMockDb({ users = [], reports = [], options = {} } = {}) {
  const state = {
    users: users.map(clone),
    reports: reports.map(clone),
    dispositions: [],
    audits: [],
    followups: [],
    authAudits: [],
    writes: [],
    conditionalUpdates: [],
    queryTrace: [],
    transactionCalls: 0,
  };

  function rowsFor(name) {
    const rows = {
      users: state.users,
      fraud_reports: state.reports,
      security_dispositions: state.dispositions,
      audit_logs: state.audits,
      counselor_followups: state.followups,
    }[name];
    if (!rows) throw new Error(`Unexpected collection: ${name}`);
    return rows;
  }

  function snapshot() {
    return {
      users: state.users.map(clone),
      reports: state.reports.map(clone),
      dispositions: state.dispositions.map(clone),
      audits: state.audits.map(clone),
      followups: state.followups.map(clone),
    };
  }

  function restore(saved) {
    for (const [key, rows] of Object.entries(saved)) {
      state[key].splice(0, state[key].length, ...rows.map(clone));
    }
  }

  function collection(name, inTransaction) {
    return {
      doc(id) {
        return {
          async get() {
            const document = rowsFor(name).find((row) => row._id === id) || null;
            state.queryTrace.push({ collection: name, operation: 'doc.get', id, inTransaction });
            return documentResult(document);
          },
        };
      },
      where(condition) {
        return {
          async update(rawData) {
            if (!inTransaction && options.rejectDirectBusinessWrites) {
              throw new Error('Business writes must use a transaction handle');
            }
            const data = rawData;
            state.conditionalUpdates.push({ collection: name, condition: clone(condition), data: clone(data), inTransaction });
            state.writes.push({ collection: name, operation: 'where.update', inTransaction, data: clone(data) });
            if (name === 'fraud_reports' && typeof options.beforeReportConditionalUpdate === 'function') {
              options.beforeReportConditionalUpdate(state);
            }
            const matched = rowsFor(name).filter((row) => matches(row, condition));
            matched.forEach((row) => Object.assign(row, clone(data)));
            return { updated: matched.length, stats: { updated: matched.length } };
          },
        };
      },
      async add(document) {
        if (!inTransaction && options.rejectDirectBusinessWrites) {
          throw new Error('Business writes must use a transaction handle');
        }
        if (name === 'security_dispositions' && options.dispositionFailure) {
          throw new Error('disposition unavailable');
        }
        if (name === 'security_dispositions' && options.dispositionResultFailure) {
          return { code: 'DISPOSITION_INSERT_FAILED' };
        }
        if (name === 'audit_logs' && options.auditFailure) {
          throw new Error('audit unavailable');
        }
        if (name === 'audit_logs' && options.auditResultFailure) {
          return { code: 'AUDIT_INSERT_FAILED' };
        }
        rowsFor(name).push(clone(document));
        state.writes.push({ collection: name, operation: 'add', inTransaction, data: clone(document) });
        return { id: document._id };
      },
    };
  }

  return {
    state,
    db: {
      serverDate: () => ({ $serverDate: true }),
      collection: (name) => collection(name, false),
      async runTransaction(callback) {
        state.transactionCalls += 1;
        const saved = snapshot();
        try {
          if (typeof options.beforeTransaction === 'function') {
            options.beforeTransaction(state);
          }
          const result = await callback({ collection: (name) => collection(name, true) });
          if (options.transactionConflict) {
            const error = new Error('write conflict');
            error.code = 'DATABASE_TRANSACTION_CONFLICT';
            throw error;
          }
          return result;
        } catch (error) {
          restore(saved);
          throw error;
        }
      },
    },
  };
}

async function securityUser(overrides = {}) {
  return {
    _id: 'usr_security_001',
    identityKey: 'security:security01',
    role: 'security',
    name: '保卫处测试账号',
    passwordHash: await passwordHashPromise,
    wxOpenId: null,
    bindStatus: 'not_applicable',
    status: 'active',
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    _id: 'report_001',
    studentId: 'usr_student_001',
    collegeId: 'college_cs',
    sourceAlertId: 'alert_001',
    sourceAlertKey: 'alert:alert_001',
    fraudType: 'part_time_scam',
    incidentAt: new Date('2026-09-10T08:00:00.000Z'),
    involvedAmount: 3000,
    hasLoss: true,
    incidentNarrative: '敏感事件经过',
    suspiciousPlatform: '敏感平台',
    suspiciousAccount: '敏感账号',
    contactPhone: '13800138000',
    studentRemark: '敏感补充说明',
    riskLevel: 'high',
    riskReasons: ['has_loss'],
    riskRuleId: 'rule_default',
    status: 'pending_security_verify',
    currentHandlerId: 'usr_counselor_001',
    confirmedLossAmount: null,
    finalOutcome: null,
    closeReason: null,
    closedAt: null,
    version: 3,
    submittedAt: new Date('2026-09-10T08:00:00.000Z'),
    createdAt: new Date('2026-09-10T08:00:00.000Z'),
    updatedAt: new Date('2026-09-10T08:00:00.000Z'),
    ...overrides,
  };
}

async function createFixture({ reports = [report()], options = {} } = {}) {
  const security = await securityUser(options.securityUser);
  const mock = createMockDb({ users: [security], reports, options });
  const logs = [];
  let requestSequence = 0;
  let auditSequence = 0;
  let dispositionSequence = 0;
  const serverDate = () => ({ $serverDate: ++requestSequence });
  const authService = createAuthService({
    userRepository: {
      async findByIdentityKey(identityKey) {
        const user = mock.state.users.find((row) => row.identityKey === identityKey);
        return user ? clone(user) : null;
      },
      async findById(userId) {
        const user = mock.state.users.find((row) => row._id === userId);
        return user ? clone(user) : null;
      },
    },
    auditRepository: {
      async appendAudit(audit) {
        mock.state.authAudits.push(clone(audit));
      },
    },
    bcrypt,
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
    serverDate,
    nowSeconds: () => 1_780_000_000,
    createRequestId: () => `req_auth_${++requestSequence}`,
    createAuditId: () => `audit_auth_${++auditSequence}`,
    createJti: () => 'jti_security_report_processing',
    logger: { error: (entry) => logs.push(entry) },
    configured: true,
  });
  const reportProcessingService = createSecurityReportProcessingService({
    authService,
    db: mock.db,
    serverDate,
    createDispositionId: () => `disposition_${++dispositionSequence}`,
    createAuditId: () => `audit_report_${++auditSequence}`,
    createRequestId: () => `req_report_${++requestSequence}`,
    logger: { error: (entry) => logs.push(entry) },
    configured: true,
  });
  const handler = createHttpHandler({
    authService,
    reportProcessingService,
    allowedOrigins: ALLOWED_ORIGIN,
    logger: { error: (entry) => logs.push(entry) },
  });
  const login = await authService.login(JSON.stringify({ loginName: 'security01', password: PASSWORD }));
  assert.equal(login.code, 'AUTHENTICATED');
  return { ...mock, authService, handler, logs, token: login.token };
}

async function request(handler, { method, path, body, headers = {} }) {
  const response = await handler({ httpMethod: method, path, body, headers });
  return { ...response, json: response.body ? JSON.parse(response.body) : null };
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

function validBody(overrides = {}) {
  return { version: 3, actionContent: ' 已完成保卫处初步核验，进入处理流程 ', ...overrides };
}

async function startProcess(fixture, body = validBody(), headers = authHeaders(fixture.token), reportId = 'report_001') {
  return request(fixture.handler, {
    method: 'POST',
    path: `/reports/${reportId}/start-process`,
    headers,
    body: JSON.stringify(body),
  });
}

test('1. 成功迁移只更新 report 一次，并新增一条 disposition 和一条最小审计', async () => {
  const fixture = await createFixture({ options: { rejectDirectBusinessWrites: true } });
  const before = clone(fixture.state.reports[0]);
  const response = await startProcess(fixture);
  const updated = fixture.state.reports[0];
  const disposition = fixture.state.dispositions[0];
  const audit = fixture.state.audits[0];

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, {
    ok: true,
    code: 'REPORT_PROCESSING_STARTED',
    report: { reportId: 'report_001', status: 'in_process', version: 4 },
  });
  assert.deepEqual([updated.status, updated.version, updated.currentHandlerId], ['in_process', 4, 'usr_security_001']);
  assert.equal(updated.updatedAt.$serverDate > 0, true);
  assert.equal(Object.hasOwn(updated, 'data'), false);
  for (const key of ['studentId', 'collegeId', 'sourceAlertId', 'sourceAlertKey', 'fraudType', 'incidentAt', 'involvedAmount',
    'hasLoss', 'incidentNarrative', 'suspiciousPlatform', 'suspiciousAccount', 'contactPhone', 'studentRemark', 'riskLevel',
    'riskReasons', 'riskRuleId', 'confirmedLossAmount', 'finalOutcome', 'closeReason', 'closedAt', 'submittedAt', 'createdAt']) {
    assert.deepEqual(updated[key], before[key], key);
  }
  assert.deepEqual(disposition, {
    _id: 'disposition_1',
    reportId: 'report_001',
    operatorId: 'usr_security_001',
    action: 'start_process',
    statusAfter: 'in_process',
    actionContent: '已完成保卫处初步核验，进入处理流程',
    createdAt: disposition.createdAt,
  });
  for (const key of ['verificationResult', 'externalReferenceNo', 'nextActionAt', 'returnReason', 'confirmedLossAmount', 'finalOutcome']) {
    assert.equal(Object.hasOwn(disposition, key), false, key);
  }
  assert.deepEqual(audit, {
    _id: 'audit_report_2',
    actorId: 'usr_security_001',
    actorRole: 'security',
    actorCollegeId: null,
    action: 'report.start_process',
    resourceType: 'fraud_report',
    resourceId: 'report_001',
    result: 'success',
    beforeSummary: { status: 'pending_security_verify' },
    afterSummary: { status: 'in_process' },
    requestId: 'req_report_3',
    createdAt: audit.createdAt,
  });
  const auditJson = JSON.stringify(audit);
  for (const sensitive of ['已完成保卫处初步核验，进入处理流程', '敏感事件经过', '13800138000', '敏感补充说明', '敏感账号']) {
    assert.equal(auditJson.includes(sensitive), false, sensitive);
  }
  assert.equal(fixture.state.transactionCalls, 1);
  assert.deepEqual(fixture.state.writes.map((write) => [write.collection, write.operation, write.inTransaction]), [
    ['fraud_reports', 'where.update', true],
    ['security_dispositions', 'add', true],
    ['audit_logs', 'add', true],
  ]);
  const conditionalUpdate = fixture.state.conditionalUpdates[0];
  assert.deepEqual(conditionalUpdate.condition, {
    _id: 'report_001',
    status: 'pending_security_verify',
    version: 3,
  });
  assert.deepEqual(Object.keys(conditionalUpdate.data).sort(), ['currentHandlerId', 'status', 'updatedAt', 'version']);
  assert.equal(conditionalUpdate.data.status, 'in_process');
  assert.equal(conditionalUpdate.data.currentHandlerId, 'usr_security_001');
  assert.equal(conditionalUpdate.data.updatedAt.$serverDate > 0, true);
  assert.equal(conditionalUpdate.data.version, 4);
  assert.equal(Object.hasOwn(conditionalUpdate.data, 'data'), false);
  assert.equal(fixture.state.followups.length, 0);
});

test('2. 缺少 Authorization 返回 TOKEN_MISSING，且没有写入', async () => {
  const fixture = await createFixture();
  const before = clone(fixture.state.reports[0]);
  const response = await startProcess(fixture, validBody(), {});

  assert.equal(response.statusCode, 401);
  assert.equal(response.json.code, 'TOKEN_MISSING');
  assert.deepEqual(fixture.state.reports[0], before);
  assert.equal(fixture.state.dispositions.length, 0);
  assert.equal(fixture.state.audits.length, 0);
});

test('3. 无效 token、非 security 或失效会话均拒绝', async () => {
  const invalidFixture = await createFixture();
  const invalid = await startProcess(invalidFixture, validBody(), { Authorization: 'Bearer invalid.token.value' });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.json.code, 'TOKEN_INVALID');

  const forbiddenFixture = await createFixture();
  forbiddenFixture.state.users[0].role = 'student';
  const forbidden = await startProcess(forbiddenFixture);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json.code, 'FORBIDDEN');
  assert.equal(forbiddenFixture.state.dispositions.length, 0);
  assert.equal(forbiddenFixture.state.audits.length, 0);
});

test('4. body 严格白名单、version 和 actionContent 校验', async () => {
  const invalidBodies = [
    {}, { version: 3 }, { actionContent: '内容' }, { version: 0, actionContent: '内容' },
    { version: 3.5, actionContent: '内容' }, { version: '3', actionContent: '内容' },
    { version: 3, actionContent: ' ' }, { version: 3, actionContent: 'x'.repeat(1001) },
    { version: 3, actionContent: '内容', verificationResult: 'confirmed' },
    { version: 3, actionContent: '内容', externalReferenceNo: 'CASE-001' },
    { version: 3, actionContent: '内容', nextActionAt: '2026-09-12T08:00:00.000Z' },
  ];
  for (const body of invalidBodies) {
    const fixture = await createFixture();
    const response = await startProcess(fixture, body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(response.json.code, 'INVALID_INPUT', JSON.stringify(body));
    assert.equal(fixture.state.transactionCalls, 0, JSON.stringify(body));
    assert.equal(fixture.state.dispositions.length, 0, JSON.stringify(body));
  }
});

test('5. 客户端不能伪造操作者、处理人或角色字段', async () => {
  for (const [key, value] of Object.entries({
    actorId: 'usr_attacker', operatorId: 'usr_attacker', currentHandlerId: 'usr_attacker', role: 'security',
  })) {
    const fixture = await createFixture();
    const response = await startProcess(fixture, validBody({ [key]: value }));
    assert.equal(response.statusCode, 400, key);
    assert.equal(response.json.code, 'INVALID_INPUT', key);
    assert.equal(fixture.state.reports[0].currentHandlerId, 'usr_counselor_001', key);
    assert.equal(fixture.state.dispositions.length, 0, key);
  }
});

test('6. 工单不存在返回 NOT_FOUND', async () => {
  const fixture = await createFixture({ reports: [] });
  const response = await startProcess(fixture, validBody(), authHeaders(fixture.token), 'report_missing');

  assert.equal(response.statusCode, 404);
  assert.equal(response.json.code, 'NOT_FOUND');
  assert.equal(fixture.state.dispositions.length, 0);
  assert.equal(fixture.state.audits.length, 0);
});

test('7. 非 pending_security_verify 状态返回 CONFLICT', async () => {
  const fixture = await createFixture({ reports: [report({ status: 'in_process' })] });
  const response = await startProcess(fixture);

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'CONFLICT');
  assert.equal(fixture.state.reports[0].version, 3);
  assert.equal(fixture.state.dispositions.length, 0);
});

test('8. version 不匹配返回 CONFLICT', async () => {
  const fixture = await createFixture({ reports: [report({ version: 4 })] });
  const response = await startProcess(fixture);

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'CONFLICT');
  assert.equal(fixture.state.reports[0].status, 'pending_security_verify');
  assert.equal(fixture.state.audits.length, 0);
});

test('9. status 在读后写前变化时条件更新零条，事务返回 CONFLICT 并回滚', async () => {
  const fixture = await createFixture({ options: {
    beforeReportConditionalUpdate: (state) => { state.reports[0].status = 'in_process'; },
  } });
  const before = clone(fixture.state.reports[0]);
  const response = await startProcess(fixture);

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'CONFLICT');
  assert.deepEqual(fixture.state.reports[0], before);
  assert.deepEqual(fixture.state.conditionalUpdates[0].condition, {
    _id: 'report_001', status: 'pending_security_verify', version: 3,
  });
  assert.equal(fixture.state.dispositions.length, 0);
  assert.equal(fixture.state.audits.length, 0);
});

test('10. version 在读后写前变化时条件更新零条，事务返回 CONFLICT 并回滚', async () => {
  const fixture = await createFixture({ options: {
    beforeReportConditionalUpdate: (state) => { state.reports[0].version = 4; },
  } });
  const before = clone(fixture.state.reports[0]);
  const response = await startProcess(fixture);

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'CONFLICT');
  assert.deepEqual(fixture.state.reports[0], before);
  assert.equal(fixture.state.dispositions.length, 0);
  assert.equal(fixture.state.audits.length, 0);
});

test('11. 事务写冲突统一返回 CONFLICT 且不留下半成功数据', async () => {
  const fixture = await createFixture({ options: { transactionConflict: true } });
  const before = clone(fixture.state.reports[0]);
  const response = await startProcess(fixture);

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'CONFLICT');
  assert.deepEqual(fixture.state.reports[0], before);
  assert.equal(fixture.state.dispositions.length, 0);
  assert.equal(fixture.state.audits.length, 0);
});

test('12. disposition 插入失败时 report 和 audit 一并回滚', async () => {
  for (const options of [{ dispositionFailure: true }, { dispositionResultFailure: true }]) {
    const fixture = await createFixture({ options });
    const before = clone(fixture.state.reports[0]);
    const response = await startProcess(fixture);
    assert.equal(response.statusCode, 500);
    assert.equal(response.json.code, 'INTERNAL_ERROR');
    assert.deepEqual(fixture.state.reports[0], before);
    assert.equal(fixture.state.dispositions.length, 0);
    assert.equal(fixture.state.audits.length, 0);
  }
});

test('13. audit 插入失败时 report 和 disposition 一并回滚', async () => {
  for (const options of [{ auditFailure: true }, { auditResultFailure: true }]) {
    const fixture = await createFixture({ options });
    const before = clone(fixture.state.reports[0]);
    const response = await startProcess(fixture);
    assert.equal(response.statusCode, 500);
    assert.equal(response.json.code, 'INTERNAL_ERROR');
    assert.deepEqual(fixture.state.reports[0], before);
    assert.equal(fixture.state.dispositions.length, 0);
    assert.equal(fixture.state.audits.length, 0);
  }
});

test('14. 同一 version 的第二次请求冲突，不会新增第二条 disposition 或 audit', async () => {
  const fixture = await createFixture();
  const first = await startProcess(fixture);
  const second = await startProcess(fixture);

  assert.equal(first.json.code, 'REPORT_PROCESSING_STARTED');
  assert.equal(second.statusCode, 409);
  assert.equal(second.json.code, 'CONFLICT');
  assert.equal(fixture.state.dispositions.length, 1);
  assert.equal(fixture.state.audits.length, 1);
});

test('15. start-process 路由使用既有严格 CORS OPTIONS 行为', async () => {
  const fixture = await createFixture();
  const response = await request(fixture.handler, {
    method: 'OPTIONS',
    path: '/reports/report_001/start-process',
    headers: { Origin: ALLOWED_ORIGIN },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  assert.equal(response.headers['Access-Control-Allow-Origin'], ALLOWED_ORIGIN);
  assert.equal(response.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
});
