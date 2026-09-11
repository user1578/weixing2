'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const bcrypt = require('../../cloudfunctions/securityAuthHttp/node_modules/bcryptjs');
const securityAuth = require('../../cloudfunctions/securityAuthHttp');

const {
  createAuthService,
  createHttpHandler,
  createSecurityReportClosingService,
  parseReportCloseBody,
} = securityAuth.__testables;

const PASSWORD = 'security-report-closing-test-password';
const ALLOWED_ORIGIN = 'https://security.example.edu';
const SESSION_TTL_SECONDS = 2 * 60 * 60;
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
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
            if (!isPlainObject(rawData) || Object.hasOwn(rawData, 'data')) {
              throw new Error('CloudBase where.update requires a raw update object');
            }
            state.conditionalUpdates.push({ collection: name, condition: clone(condition), data: clone(rawData), inTransaction });
            state.writes.push({ collection: name, operation: 'where.update', inTransaction, data: clone(rawData) });
            if (name === 'fraud_reports' && typeof options.beforeReportConditionalUpdate === 'function') {
              options.beforeReportConditionalUpdate(state);
            }
            const matched = rowsFor(name).filter((row) => matches(row, condition));
            matched.forEach((row) => Object.assign(row, clone(rawData)));
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
    incidentNarrative: '敏感事件经过',
    suspiciousAccount: '敏感账号',
    contactPhone: '13800138000',
    studentRemark: '敏感补充说明',
    status: 'in_process',
    currentHandlerId: 'usr_security_previous',
    confirmedLossAmount: null,
    finalOutcome: null,
    closeReason: null,
    closedAt: null,
    version: 3,
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
  let nowSeconds = 1_780_000_000;
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
    nowSeconds: () => nowSeconds,
    createRequestId: () => `req_auth_${++requestSequence}`,
    createAuditId: () => `audit_auth_${++auditSequence}`,
    createJti: () => 'jti_security_report_closing',
    logger: { error: (entry) => logs.push(entry) },
    configured: true,
  });
  const reportClosingService = createSecurityReportClosingService({
    authService,
    db: mock.db,
    serverDate,
    createDispositionId: () => `disposition_${++dispositionSequence}`,
    createAuditId: () => `audit_close_${++auditSequence}`,
    createRequestId: () => `req_close_${++requestSequence}`,
    logger: { error: (entry) => logs.push(entry) },
    configured: true,
  });
  const handler = createHttpHandler({
    authService,
    reportClosingService,
    allowedOrigins: ALLOWED_ORIGIN,
    logger: { error: (entry) => logs.push(entry) },
  });
  const login = await authService.login(JSON.stringify({ loginName: 'security01', password: PASSWORD }));
  assert.equal(login.code, 'AUTHENTICATED');
  return {
    ...mock,
    handler,
    logs,
    token: login.token,
    setNowSeconds: (value) => { nowSeconds = value; },
  };
}

async function request(handler, { method, path, body, headers = {} }) {
  const response = await handler({ httpMethod: method, path, body, headers });
  return { ...response, json: response.body ? JSON.parse(response.body) : null };
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

function validBody(overrides = {}) {
  return {
    version: 3,
    verificationResult: 'confirmed',
    finalOutcome: 'loss_confirmed',
    confirmedLossAmount: 1200.5,
    closeReason: ' 已完成保卫处核验并结案 ',
    actionContent: ' 已核验材料、完成风险提示并协助后续处置 ',
    ...overrides,
  };
}

async function closeReport(fixture, body = validBody(), headers = authHeaders(fixture.token), reportId = 'report_001', rawBody = false) {
  return request(fixture.handler, {
    method: 'POST',
    path: `/reports/${reportId}/close`,
    headers,
    body: rawBody ? body : JSON.stringify(body),
  });
}

function assertNoCloseMutation(fixture, before) {
  assert.deepEqual(fixture.state.reports, before);
  assert.equal(fixture.state.dispositions.length, 0);
  assert.equal(fixture.state.audits.length, 0);
  assert.equal(fixture.state.followups.length, 0);
}

test('1. in_process 可结案：同一事务完成条件更新、处置和最小审计', async () => {
  const fixture = await createFixture({ options: { rejectDirectBusinessWrites: true } });
  const before = clone(fixture.state.reports);
  const response = await closeReport(fixture);
  const updated = fixture.state.reports[0];
  const disposition = fixture.state.dispositions[0];
  const audit = fixture.state.audits[0];
  const conditionalUpdate = fixture.state.conditionalUpdates[0];

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, {
    ok: true,
    code: 'REPORT_CLOSED',
    report: { reportId: 'report_001', status: 'closed', version: 4 },
  });
  assert.deepEqual(conditionalUpdate.condition, { _id: 'report_001', status: 'in_process', version: 3 });
  assert.deepEqual(Object.keys(conditionalUpdate.data).sort(), [
    'closeReason', 'closedAt', 'confirmedLossAmount', 'currentHandlerId', 'finalOutcome', 'status', 'updatedAt', 'version',
  ]);
  assert.equal(Object.hasOwn(conditionalUpdate.data, 'data'), false);
  assert.deepEqual({
    status: updated.status,
    currentHandlerId: updated.currentHandlerId,
    finalOutcome: updated.finalOutcome,
    confirmedLossAmount: updated.confirmedLossAmount,
    closeReason: updated.closeReason,
    version: updated.version,
  }, {
    status: 'closed',
    currentHandlerId: 'usr_security_001',
    finalOutcome: 'loss_confirmed',
    confirmedLossAmount: 1200.5,
    closeReason: '已完成保卫处核验并结案',
    version: 4,
  });
  assert.equal(updated.closedAt.$serverDate > 0, true);
  assert.equal(updated.updatedAt.$serverDate > 0, true);
  assert.equal(Object.hasOwn(updated, 'data'), false);
  for (const key of ['studentId', 'collegeId', 'sourceAlertId', 'sourceAlertKey', 'fraudType', 'incidentNarrative',
    'suspiciousAccount', 'contactPhone', 'studentRemark', 'createdAt']) {
    assert.deepEqual(updated[key], before[0][key], key);
  }
  assert.deepEqual(disposition, {
    _id: 'disposition_1',
    reportId: 'report_001',
    operatorId: 'usr_security_001',
    action: 'close',
    statusAfter: 'closed',
    verificationResult: 'confirmed',
    actionContent: '已核验材料、完成风险提示并协助后续处置',
    confirmedLossAmount: 1200.5,
    finalOutcome: 'loss_confirmed',
    createdAt: disposition.createdAt,
  });
  for (const key of ['returnReason', 'externalReferenceNo', 'nextActionAt']) {
    assert.equal(Object.hasOwn(disposition, key), false, key);
  }
  assert.deepEqual(audit, {
    _id: 'audit_close_2',
    actorId: 'usr_security_001',
    actorRole: 'security',
    actorCollegeId: null,
    action: 'report.close',
    resourceType: 'fraud_report',
    resourceId: 'report_001',
    result: 'success',
    beforeSummary: { status: 'in_process' },
    afterSummary: { status: 'closed' },
    requestId: audit.requestId,
    createdAt: audit.createdAt,
  });
  assert.equal(typeof audit.requestId, 'string');
  assert.equal(audit.requestId.length > 0, true);
  assert.equal(fixture.state.transactionCalls, 1);
  assert.deepEqual(fixture.state.writes.map((write) => [write.collection, write.operation, write.inTransaction]), [
    ['fraud_reports', 'where.update', true],
    ['security_dispositions', 'add', true],
    ['audit_logs', 'add', true],
  ]);
  assert.equal(fixture.state.queryTrace.some((entry) => entry.collection === 'fraud_reports' &&
    entry.operation === 'doc.get' && entry.id === 'report_001' && entry.inTransaction), true);
  assert.equal(fixture.state.followups.length, 0);
});

test('2. pending_security_verify 可结案，条件更新使用事务内当前状态', async () => {
  const fixture = await createFixture({ reports: [report({ status: 'pending_security_verify' })] });
  const response = await closeReport(fixture, validBody({
    verificationResult: 'not_fraud',
    finalOutcome: 'consultation',
    confirmedLossAmount: 0,
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.code, 'REPORT_CLOSED');
  assert.deepEqual(fixture.state.conditionalUpdates[0].condition, {
    _id: 'report_001', status: 'pending_security_verify', version: 3,
  });
  assert.equal(fixture.state.reports[0].status, 'closed');
  assert.equal(fixture.state.reports[0].finalOutcome, 'consultation');
  assert.equal(fixture.state.dispositions[0].verificationResult, 'not_fraud');
  assert.deepEqual(fixture.state.audits[0].beforeSummary, { status: 'pending_security_verify' });
});

test('3. 缺少 Authorization 被拒绝且不进入事务', async () => {
  const fixture = await createFixture();
  const before = clone(fixture.state.reports);
  const response = await closeReport(fixture, validBody(), {});

  assert.equal(response.statusCode, 401);
  assert.equal(response.json.code, 'TOKEN_MISSING');
  assert.equal(fixture.state.transactionCalls, 0);
  assertNoCloseMutation(fixture, before);
});

test('4. 非法、过期 token 和非 security 用户均不能结案', async () => {
  const invalidFixture = await createFixture();
  const invalid = await closeReport(invalidFixture, validBody(), { Authorization: 'Bearer invalid.token.value' });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.json.code, 'TOKEN_INVALID');

  const expiredFixture = await createFixture();
  expiredFixture.setNowSeconds(1_780_000_000 + SESSION_TTL_SECONDS);
  const expired = await closeReport(expiredFixture);
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.json.code, 'TOKEN_EXPIRED');

  const forbiddenFixture = await createFixture();
  forbiddenFixture.state.users[0].role = 'student';
  const forbidden = await closeReport(forbiddenFixture);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json.code, 'FORBIDDEN');
  assert.equal(forbiddenFixture.state.transactionCalls, 0);
  assert.equal(forbiddenFixture.state.dispositions.length, 0);
});

test('5. body 严格白名单拒绝多余字段和客户端伪造身份、状态字段', async () => {
  const forbiddenFields = {
    status: 'closed', currentHandlerId: 'usr_attacker', operatorId: 'usr_attacker', actorId: 'usr_attacker',
    actorRole: 'security', collegeId: 'college_attacker', closedAt: '2026-09-11T08:00:00.000Z',
    updatedAt: '2026-09-11T08:00:00.000Z', reportId: 'report_attacker', statusAfter: 'closed', action: 'close',
    createdAt: '2026-09-11T08:00:00.000Z', unexpected: true,
  };
  for (const [key, value] of Object.entries(forbiddenFields)) {
    const fixture = await createFixture();
    const response = await closeReport(fixture, validBody({ [key]: value }));
    assert.equal(response.statusCode, 400, key);
    assert.equal(response.json.code, 'INVALID_INPUT', key);
    assert.equal(fixture.state.transactionCalls, 0, key);
    assert.equal(fixture.state.reports[0].status, 'in_process', key);
  }
});

test('6. verificationResult 与 finalOutcome 仅接受文档列出的枚举值', async () => {
  for (const body of [
    validBody({ verificationResult: 'invalid' }),
    validBody({ finalOutcome: 'invalid' }),
    validBody({ verificationResult: null }),
    validBody({ finalOutcome: null }),
  ]) {
    const fixture = await createFixture();
    const response = await closeReport(fixture, body);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json.code, 'INVALID_INPUT');
    assert.equal(fixture.state.transactionCalls, 0);
  }
});

test('7. confirmedLossAmount 拒绝负数、字符串、NaN 与 Infinity', async () => {
  for (const [body, rawBody] of [
    [validBody({ confirmedLossAmount: -1 }), false],
    [validBody({ confirmedLossAmount: '1200.5' }), false],
    [validBody({ confirmedLossAmount: NaN }), true],
    [validBody({ confirmedLossAmount: Infinity }), true],
  ]) {
    const fixture = await createFixture();
    const response = await closeReport(fixture, body, authHeaders(fixture.token), 'report_001', rawBody);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json.code, 'INVALID_INPUT');
    assert.equal(fixture.state.transactionCalls, 0);
  }
});

test('8. confirmedLossAmount 执行确定的 finalOutcome 金额语义校验', async () => {
  const zeroLoss = await createFixture();
  const zeroLossResponse = await closeReport(zeroLoss, validBody({ confirmedLossAmount: 0 }));
  assert.equal(zeroLossResponse.statusCode, 400);

  const lossConfirmed = await createFixture();
  const lossConfirmedResponse = await closeReport(lossConfirmed, validBody({ confirmedLossAmount: 1 }));
  assert.equal(lossConfirmedResponse.statusCode, 200);

  for (const finalOutcome of ['loss_no_loss', 'misreport', 'consultation']) {
    const fixture = await createFixture();
    const response = await closeReport(fixture, validBody({ finalOutcome, confirmedLossAmount: 1 }));
    assert.equal(response.statusCode, 400, finalOutcome);
    assert.equal(response.json.code, 'INVALID_INPUT', finalOutcome);
    assert.equal(fixture.state.transactionCalls, 0, finalOutcome);
  }
});

test('9. closeReason 和 actionContent 必须是 trim 后非空且不超过 1000 字符', async () => {
  for (const body of [
    validBody({ closeReason: ' ' }),
    validBody({ closeReason: 'x'.repeat(1001) }),
    validBody({ actionContent: ' ' }),
    validBody({ actionContent: 'x'.repeat(1001) }),
  ]) {
    const fixture = await createFixture();
    const response = await closeReport(fixture, body);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json.code, 'INVALID_INPUT');
    assert.equal(fixture.state.transactionCalls, 0);
  }
});

test('10. 不存在的 report 返回 NOT_FOUND', async () => {
  const fixture = await createFixture({ reports: [] });
  const response = await closeReport(fixture, validBody(), authHeaders(fixture.token), 'report_missing');

  assert.equal(response.statusCode, 404);
  assert.equal(response.json.code, 'NOT_FOUND');
  assert.equal(fixture.state.dispositions.length, 0);
  assert.equal(fixture.state.audits.length, 0);
});

test('11. pending_counselor_verify 不能由保卫处结案', async () => {
  const fixture = await createFixture({ reports: [report({ status: 'pending_counselor_verify' })] });
  const response = await closeReport(fixture);

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'CONFLICT');
  assert.equal(fixture.state.reports[0].status, 'pending_counselor_verify');
  assert.equal(fixture.state.dispositions.length, 0);
});

test('12. closed 是终态，不能再次结案', async () => {
  const fixture = await createFixture({ reports: [report({ status: 'closed', version: 4 })] });
  const response = await closeReport(fixture, validBody({ version: 4 }));

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'CONFLICT');
  assert.equal(fixture.state.reports[0].status, 'closed');
  assert.equal(fixture.state.dispositions.length, 0);
});

test('13. 输入 version 必须与事务内 report 版本精确匹配', async () => {
  const fixture = await createFixture({ reports: [report({ version: 4 })] });
  const response = await closeReport(fixture);

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'CONFLICT');
  assert.equal(fixture.state.transactionCalls, 1);
  assert.equal(fixture.state.conditionalUpdates.length, 0);
});

test('14. 事务读取后状态变化导致条件更新为 0 时回滚并返回 CONFLICT', async () => {
  const fixture = await createFixture({ options: {
    beforeReportConditionalUpdate: (state) => { state.reports[0].status = 'pending_counselor_verify'; },
  } });
  const before = clone(fixture.state.reports);
  const response = await closeReport(fixture);

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'CONFLICT');
  assert.deepEqual(fixture.state.conditionalUpdates[0].condition, {
    _id: 'report_001', status: 'in_process', version: 3,
  });
  assertNoCloseMutation(fixture, before);
});

test('15. 事务读取后版本变化导致条件更新为 0 时回滚并返回 CONFLICT', async () => {
  const fixture = await createFixture({ options: {
    beforeReportConditionalUpdate: (state) => { state.reports[0].version = 4; },
  } });
  const before = clone(fixture.state.reports);
  const response = await closeReport(fixture);

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'CONFLICT');
  assert.deepEqual(fixture.state.conditionalUpdates[0].condition, {
    _id: 'report_001', status: 'in_process', version: 3,
  });
  assertNoCloseMutation(fixture, before);
});

test('16. security_dispositions 写入失败时 report 与 audit 一并回滚', async () => {
  for (const options of [{ dispositionFailure: true }, { dispositionResultFailure: true }]) {
    const fixture = await createFixture({ options });
    const before = clone(fixture.state.reports);
    const response = await closeReport(fixture);
    assert.equal(response.statusCode, 500);
    assert.equal(response.json.code, 'INTERNAL_ERROR');
    assertNoCloseMutation(fixture, before);
  }
});

test('17. audit_logs 写入失败时 report 与 disposition 一并回滚', async () => {
  for (const options of [{ auditFailure: true }, { auditResultFailure: true }]) {
    const fixture = await createFixture({ options });
    const before = clone(fixture.state.reports);
    const response = await closeReport(fixture);
    assert.equal(response.statusCode, 500);
    assert.equal(response.json.code, 'INTERNAL_ERROR');
    assertNoCloseMutation(fixture, before);
  }
});

test('18. 同一 version 的重复结案请求第二次返回 CONFLICT', async () => {
  const fixture = await createFixture();
  const first = await closeReport(fixture);
  const second = await closeReport(fixture);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json.code, 'CONFLICT');
  assert.equal(fixture.state.dispositions.length, 1);
  assert.equal(fixture.state.audits.length, 1);
  assert.equal(fixture.state.reports[0].version, 4);
});

test('19. 审计不记录敏感结案字段或 report 正文', async () => {
  const fixture = await createFixture();
  const closeReason = '学生可见结案摘要-不得进入审计';
  const actionContent = '内部处置说明-不得进入审计';
  const response = await closeReport(fixture, validBody({ closeReason, actionContent }));
  const auditJson = JSON.stringify(fixture.state.audits[0]);

  assert.equal(response.statusCode, 200);
  for (const sensitive of [
    actionContent, closeReason, '1200.5', '敏感事件经过', '敏感补充说明', '13800138000', '敏感账号',
    'student-openid-not-exposed', 'token', 'password', 'OPENID', 'wxOpenId',
  ]) {
    assert.equal(auditJson.includes(sensitive), false, sensitive);
  }
});

test('20. close 路由沿用严格 CORS OPTIONS 行为', async () => {
  const fixture = await createFixture();
  const response = await request(fixture.handler, {
    method: 'OPTIONS',
    path: '/reports/report_001/close',
    headers: { Origin: ALLOWED_ORIGIN },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  assert.equal(response.headers['Access-Control-Allow-Origin'], ALLOWED_ORIGIN);
  assert.equal(response.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
});

test('21. parseReportCloseBody 不建立 verificationResult 与 finalOutcome 的额外映射', () => {
  assert.deepEqual(parseReportCloseBody(validBody({
    verificationResult: 'not_fraud',
    finalOutcome: 'loss_confirmed',
    confirmedLossAmount: 1,
  })), {
    version: 3,
    verificationResult: 'not_fraud',
    finalOutcome: 'loss_confirmed',
    confirmedLossAmount: 1,
    closeReason: '已完成保卫处核验并结案',
    actionContent: '已核验材料、完成风险提示并协助后续处置',
  });
});
