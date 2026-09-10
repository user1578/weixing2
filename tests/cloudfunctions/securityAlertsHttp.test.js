'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const bcrypt = require('../../cloudfunctions/securityAuthHttp/node_modules/bcryptjs');
const securityAuth = require('../../cloudfunctions/securityAuthHttp');

const {
  SESSION_TTL_SECONDS,
  createAuthService,
  createDefaultHandler,
  createHttpHandler,
  createSecurityAlertService,
} = securityAuth.__testables;

const PASSWORD = 'security-alerts-test-password';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ALLOWED_ORIGIN = 'https://security.example.edu';
const passwordHashPromise = bcrypt.hash(PASSWORD, 4);

function clone(value) {
  return structuredClone(value);
}

function normalizeWrite(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 1 && Object.hasOwn(value, 'data')) {
    return value.data;
  }
  return value;
}

function equals(left, right) {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  return left === right;
}

function matches(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    const actual = document[key];
    if (expected && expected.__mockOperator === 'in') {
      return expected.values.some((value) => equals(actual, value));
    }
    if (expected && expected.__mockOperator === 'gte') {
      return actual instanceof Date && expected.value instanceof Date
        ? actual.getTime() >= expected.value.getTime()
        : actual >= expected.value;
    }
    return equals(actual, expected);
  });
}

function documentResult(document) {
  // CloudBase's Node SDK returns an array for doc().get().  Copying fields onto
  // it also makes this fixture tolerant of an internal helper that reads data
  // directly as an object.
  const data = document ? [clone(document)] : [];
  if (document) Object.assign(data, clone(document));
  return { data };
}

function createMockDb({ users = [], riskRules = [], alerts = [], options = {} } = {}) {
  const state = {
    users: users.map(clone),
    riskRules: riskRules.map(clone),
    alerts: alerts.map(clone),
    audits: [],
    authAudits: [],
    queryTrace: [],
    conditionalUpdates: [],
    writes: [],
    transactionCalls: 0,
  };

  function documents(name) {
    if (name === 'users') return state.users;
    if (name === 'risk_rules') return state.riskRules;
    if (name === 'alerts') return state.alerts;
    if (name === 'audit_logs') return state.audits;
    throw new Error(`Unexpected collection: ${name}`);
  }

  function snapshot() {
    return {
      users: state.users.map(clone),
      riskRules: state.riskRules.map(clone),
      alerts: state.alerts.map(clone),
      audits: state.audits.map(clone),
    };
  }

  function restore(saved) {
    state.users.splice(0, state.users.length, ...saved.users.map(clone));
    state.riskRules.splice(0, state.riskRules.length, ...saved.riskRules.map(clone));
    state.alerts.splice(0, state.alerts.length, ...saved.alerts.map(clone));
    state.audits.splice(0, state.audits.length, ...saved.audits.map(clone));
  }

  function makeCollection(name, inTransaction = false) {
    function writeDocuments(query, rawUpdate) {
      if (options.rejectDirectBusinessWrites && !inTransaction && (name === 'alerts' || name === 'audit_logs')) {
        throw new Error('Business writes must use a transaction handle');
      }
      const update = normalizeWrite(rawUpdate);
      const matched = documents(name).filter((document) => matches(document, query));
      state.conditionalUpdates.push({ collection: name, query: clone(query), data: clone(update), inTransaction });
      state.writes.push({ collection: name, operation: 'update', inTransaction });
      if (options.conditionUpdateZero && name === 'alerts') {
        return { updated: 0, updatedCount: 0, stats: { updated: 0 } };
      }
      matched.forEach((document) => Object.assign(document, clone(update)));
      return { updated: matched.length, updatedCount: matched.length, stats: { updated: matched.length } };
    }

    function query(query) {
      const select = () => documents(name).filter((document) => matches(document, query));
      return {
        async get() {
          const found = select().map(clone);
          state.queryTrace.push({ collection: name, operation: 'get', query: clone(query), limit: null });
          return { data: found };
        },
        limit(limit) {
          return {
            async get() {
              const found = select().slice(0, limit).map(clone);
              state.queryTrace.push({ collection: name, operation: 'get', query: clone(query), limit });
              return { data: found };
            },
          };
        },
        async count() {
          const total = select().length;
          state.queryTrace.push({ collection: name, operation: 'count', query: clone(query), limit: null });
          return { total };
        },
        async update(rawUpdate) {
          return writeDocuments(query, rawUpdate);
        },
      };
    }

    return {
      where: query,
      doc(id) {
        return {
          async get() {
            const document = documents(name).find((item) => item._id === id) || null;
            state.queryTrace.push({ collection: name, operation: 'doc.get', query: { _id: id }, limit: 1 });
            return documentResult(document);
          },
          async update(rawUpdate) {
            return writeDocuments({ _id: id }, rawUpdate);
          },
        };
      },
      async add(rawDocument) {
        if (options.rejectDirectBusinessWrites && !inTransaction && (name === 'alerts' || name === 'audit_logs')) {
          throw new Error('Business writes must use a transaction handle');
        }
        const document = normalizeWrite(rawDocument);
        if (name === 'audit_logs' && options.auditFailure) {
          throw new Error('audit unavailable');
        }
        if (name === 'alerts' && options.alertResultFailure) {
          return { code: 'ALERT_INSERT_FAILED' };
        }
        if (name === 'audit_logs' && options.auditResultFailure) {
          return { code: 'AUDIT_INSERT_FAILED' };
        }
        documents(name).push(clone(document));
        state.writes.push({ collection: name, operation: 'add', inTransaction });
        return { id: document._id };
      },
    };
  }

  const db = {
    command: {
      in: (values) => ({ __mockOperator: 'in', values: [...values] }),
      gte: (value) => ({ __mockOperator: 'gte', value: clone(value) }),
    },
    serverDate: () => ({ $serverDate: true }),
    collection: (name) => makeCollection(name, false),
    async runTransaction(callback) {
      state.transactionCalls += 1;
      const saved = snapshot();
      try {
        const result = await callback({ collection: (name) => makeCollection(name, true) });
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
  };
  return { db, state };
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

function studentUser(overrides = {}) {
  return {
    _id: 'usr_student_001',
    identityKey: 'student:20260001',
    role: 'student',
    name: '学生测试账号',
    collegeId: 'college_cs',
    focusFlag: false,
    status: 'active',
    bindStatus: 'bound',
    wxOpenId: 'student-openid-not-exposed',
    version: 1,
    ...overrides,
  };
}

function defaultRule(overrides = {}) {
  return {
    _id: 'rule_default',
    status: 'enabled',
    highAmount: 5000,
    midAmountMin: 1,
    repeatAlertWindowDays: 30,
    highAlertRepeatCount: 3,
    midAlertRepeatCount: 2,
    slaFirstFollowHours: 48,
    keyFraudTypes: ['part_time_scam', 'impersonate_public', 'fake_loan', 'fake_refund'],
    updatedBy: 'usr_security_001',
    version: 1,
    ...overrides,
  };
}

function existingAlert(overrides = {}) {
  return {
    _id: 'alert_existing',
    sourceType: 'manual',
    studentId: 'usr_student_001',
    collegeId: 'college_cs',
    fraudType: 'other',
    content: '已有预警',
    riskLevel: 'low',
    riskReasons: [],
    riskRuleId: 'rule_default',
    status: 'sent',
    issuedBy: 'usr_security_001',
    issuedAt: new Date(NOW.getTime() - DAY),
    version: 1,
    createdAt: new Date(NOW.getTime() - DAY),
    updatedAt: new Date(NOW.getTime() - DAY),
    ...overrides,
  };
}

function pendingAlert(overrides = {}) {
  const alert = existingAlert({ status: 'pending_dispatch', ...overrides });
  delete alert.issuedBy;
  delete alert.issuedAt;
  return alert;
}

async function createFixture({ users, alerts, rule, options = {} } = {}) {
  const security = await securityUser(options.securityUser);
  const mock = createMockDb({
    users: users || [security, studentUser()],
    riskRules: rule === null ? [] : [rule || defaultRule()],
    alerts: alerts || [],
    options,
  });
  const logs = [];
  let serverDateSequence = 0;
  let alertSequence = 0;
  let auditSequence = 0;
  let requestSequence = 0;
  let currentNowSeconds = Math.floor(NOW.getTime() / 1000);
  const serverDate = () => ({ $serverDate: ++serverDateSequence });
  const userRepository = {
    async findByIdentityKey(identityKey) {
      const user = mock.state.users.find((item) => item.identityKey === identityKey);
      return user ? clone(user) : null;
    },
    async findById(userId) {
      const user = mock.state.users.find((item) => item._id === userId);
      return user ? clone(user) : null;
    },
  };
  const auditRepository = {
    async appendAudit(audit) {
      mock.state.authAudits.push(clone(audit));
    },
  };
  const authService = createAuthService({
    userRepository,
    auditRepository,
    bcrypt,
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
    serverDate,
    nowSeconds: () => currentNowSeconds,
    createRequestId: () => `req_auth_${++requestSequence}`,
    createAuditId: () => `audit_auth_${++auditSequence}`,
    createJti: () => 'jti_security_alerts_test',
    logger: { error: (entry) => logs.push(entry) },
    configured: true,
  });
  const alertService = createSecurityAlertService({
    authService,
    db: mock.db,
    serverDate,
    createAlertId: () => `alert_created_${++alertSequence}`,
    createAuditId: () => `audit_alert_${++auditSequence}`,
    createRequestId: () => `req_alert_${++requestSequence}`,
    now: () => new Date(NOW.getTime()),
    logger: { error: (entry) => logs.push(entry) },
    configured: true,
  });
  const handler = createHttpHandler({
    authService,
    alertService,
    allowedOrigins: ALLOWED_ORIGIN,
    logger: { error: (entry) => logs.push(entry) },
  });
  const loginResult = await authService.login(JSON.stringify({ loginName: 'security01', password: PASSWORD }));
  assert.equal(loginResult.code, 'AUTHENTICATED');

  return {
    ...mock,
    authService,
    alertService,
    handler,
    logs,
    token: loginResult.token,
    setNowSeconds: (next) => { currentNowSeconds = next; },
  };
}

async function request(handler, { method, path, body, headers = {} }) {
  const response = await handler({ httpMethod: method, path, body, headers });
  return { ...response, json: response.body ? JSON.parse(response.body) : null };
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

function createBody(overrides = {}) {
  return {
    studentNo: ' 20260001 ',
    fraudType: 'other',
    content: ' 请及时提高警惕，避免向陌生账号转账。 ',
    ...overrides,
  };
}

async function createAlert(fixture, body = createBody(), headers = authHeaders(fixture.token)) {
  return request(fixture.handler, {
    method: 'POST',
    path: '/alerts',
    headers,
    body: JSON.stringify(body),
  });
}

async function dispatchAlert(fixture, alertId = 'alert_existing', body = { version: 1 }, headers = authHeaders(fixture.token)) {
  return request(fixture.handler, {
    method: 'POST',
    path: `/alerts/${alertId}/dispatch`,
    headers,
    body: JSON.stringify(body),
  });
}

function assertNoAlertMutation(state) {
  assert.equal(state.alerts.length, 0);
  assert.equal(state.audits.length, 0);
}

test('1. 无 session token 不能创建或下发预警', async () => {
  const fixture = await createFixture({ alerts: [existingAlert()] });
  const createResponse = await createAlert(fixture, createBody(), {});
  const dispatchResponse = await dispatchAlert(fixture, 'alert_existing', { version: 1 }, {});

  assert.equal(createResponse.statusCode, 401);
  assert.equal(createResponse.json.code, 'TOKEN_MISSING');
  assert.equal(dispatchResponse.statusCode, 401);
  assert.equal(dispatchResponse.json.code, 'TOKEN_MISSING');
  assert.equal(fixture.state.alerts[0].status, 'sent');
  assert.equal(fixture.state.audits.length, 0);
});

test('2. 创建 body 严格拒绝所有伪造身份、状态和风险字段', async () => {
  const prohibited = {
    studentId: 'usr_attacker',
    userId: 'usr_attacker',
    collegeId: 'college_attacker',
    role: 'security',
    riskLevel: 'high',
    riskReasons: ['forged'],
    riskRuleId: 'rule_attacker',
    status: 'sent',
    issuedBy: 'usr_attacker',
    issuedAt: '2026-09-09T12:00:00.000Z',
    version: 99,
    actorId: 'usr_attacker',
    operatorId: 'usr_attacker',
  };

  for (const [key, value] of Object.entries(prohibited)) {
    const fixture = await createFixture();
    const response = await createAlert(fixture, createBody({ [key]: value }));
    assert.equal(response.statusCode, 400, key);
    assert.equal(response.json.code, 'INVALID_INPUT', key);
    assertNoAlertMutation(fixture.state);
  }
});

test('3. 创建只接受合法枚举和长度受限的输入', async () => {
  const invalidBodies = [
    createBody({ fraudType: 'made_up_type' }),
    createBody({ content: ' ' }),
    createBody({ content: 'x'.repeat(1001) }),
    createBody({ sourceReference: 'x'.repeat(129) }),
    createBody({ studentNo: ' ' }),
    createBody({ studentNo: 'x'.repeat(65) }),
    createBody({ extraField: 'not permitted' }),
  ];

  for (const body of invalidBodies) {
    const fixture = await createFixture();
    const response = await createAlert(fixture, body);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json.code, 'INVALID_INPUT');
    assertNoAlertMutation(fixture.state);
  }

  for (const sourceReference of [null, '   ']) {
    const fixture = await createFixture();
    const response = await createAlert(fixture, createBody({ sourceReference }));
    assert.equal(response.statusCode, 200);
    assert.equal(Object.hasOwn(fixture.state.alerts[0], 'sourceReference'), false);
  }
});

test('4. 目标学生从规范化 student identityKey 解析，绝不把 studentNo 写为外键', async () => {
  const fixture = await createFixture();
  const response = await createAlert(fixture, createBody({ sourceReference: '  ref-96110-1  ' }));
  const alert = fixture.state.alerts[0];

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.code, 'ALERT_CREATED');
  assert.equal(alert.studentId, 'usr_student_001');
  assert.equal(alert.collegeId, 'college_cs');
  assert.equal(alert.sourceReference, 'ref-96110-1');
  assert.equal(alert.content, '请及时提高警惕，避免向陌生账号转账。');
  assert.equal(Object.hasOwn(alert, 'studentNo'), false);
  assert.equal(fixture.state.queryTrace.some((entry) => entry.collection === 'users' &&
    entry.query.identityKey === 'student:20260001'), true);
});

test('5. 非 student、inactive 或无学院的目标均以安全业务错误拒绝', async () => {
  const targetVariants = [
    studentUser({ role: 'counselor' }),
    studentUser({ status: 'disabled' }),
    studentUser({ collegeId: ' ' }),
  ];

  for (const target of targetVariants) {
    const fixture = await createFixture({ users: [await securityUser(), target] });
    const response = await createAlert(fixture);
    assert.equal(response.statusCode, 404);
    assert.equal(response.json.code, 'NOT_FOUND');
    assertNoAlertMutation(fixture.state);
  }
});

test('6. 缺失或禁用的 rule_default fail closed，且不会创建第二条规则', async () => {
  for (const rule of [null, defaultRule({ status: 'disabled' })]) {
    const fixture = await createFixture({ rule });
    const response = await createAlert(fixture);
    assert.equal(response.statusCode, 500);
    assert.equal(response.json.code, 'INTERNAL_ERROR');
    assertNoAlertMutation(fixture.state);
    assert.equal(fixture.state.riskRules.length, rule === null ? 0 : 1);
  }
});

test('7. 无风险命中时创建 LOW 预警且原因为空', async () => {
  const fixture = await createFixture();
  const response = await createAlert(fixture);

  assert.equal(response.json.alert.riskLevel, 'low');
  assert.deepEqual(response.json.alert.riskReasons, []);
  assert.equal(fixture.state.alerts[0].riskLevel, 'low');
  assert.deepEqual(fixture.state.alerts[0].riskReasons, []);
});

test('8. keyFraudType 命中时服务端计算 MEDIUM', async () => {
  const fixture = await createFixture();
  const response = await createAlert(fixture, createBody({ fraudType: 'part_time_scam' }));

  assert.equal(response.json.alert.riskLevel, 'medium');
  assert.deepEqual(response.json.alert.riskReasons, ['key_fraud_type']);
});

test('9. focusFlag 命中时服务端计算 MEDIUM', async () => {
  const fixture = await createFixture({ users: [await securityUser(), studentUser({ focusFlag: true })] });
  const response = await createAlert(fixture);

  assert.equal(response.json.alert.riskLevel, 'medium');
  assert.deepEqual(response.json.alert.riskReasons, ['focus_flag']);
});

test('10. 活动预警数量达到 mid 阈值时计算 MEDIUM', async () => {
  const fixture = await createFixture({ alerts: [existingAlert()] });
  const response = await createAlert(fixture);

  assert.equal(response.json.alert.riskLevel, 'medium');
  assert.deepEqual(response.json.alert.riskReasons, ['repeat_alert_count>=2']);
});

test('11. 活动预警数量达到 high 阈值时计算 HIGH', async () => {
  const fixture = await createFixture({ alerts: [
    existingAlert({ _id: 'alert_existing_1' }),
    existingAlert({ _id: 'alert_existing_2' }),
  ] });
  const response = await createAlert(fixture);

  assert.equal(response.json.alert.riskLevel, 'high');
  assert.deepEqual(response.json.alert.riskReasons, ['repeat_alert_count>=3']);
});

test('12. focusFlag 与 mid 重复预警共同命中时计算 HIGH', async () => {
  const fixture = await createFixture({
    users: [await securityUser(), studentUser({ focusFlag: true })],
    alerts: [existingAlert()],
  });
  const response = await createAlert(fixture);

  assert.equal(response.json.alert.riskLevel, 'high');
  assert.equal(response.json.alert.riskReasons.includes('focus_flag'), true);
  assert.equal(response.json.alert.riskReasons.includes('repeat_alert_count>=2'), true);
});

test('13. 仅统计窗口内 sent/viewed/following_up 的已有活动预警', async () => {
  const fixture = await createFixture({ alerts: [
    existingAlert({ _id: 'alert_sent', status: 'sent', issuedAt: new Date(NOW.getTime() - 30 * DAY) }),
    existingAlert({ _id: 'alert_viewed', status: 'viewed' }),
    existingAlert({ _id: 'alert_following', status: 'following_up' }),
    existingAlert({ _id: 'alert_pending', status: 'pending_dispatch' }),
    existingAlert({ _id: 'alert_closed', status: 'closed' }),
    existingAlert({ _id: 'alert_old', issuedAt: new Date(NOW.getTime() - 31 * DAY) }),
  ] });
  const response = await createAlert(fixture);

  assert.equal(response.json.alert.riskLevel, 'high');
  assert.deepEqual(response.json.alert.riskReasons, ['repeat_alert_count>=3']);
  const activeQuery = fixture.state.queryTrace.find((entry) => entry.collection === 'alerts' && entry.operation === 'count');
  assert.equal(activeQuery.query.studentId, 'usr_student_001');
  assert.equal(activeQuery.query.status.__mockOperator, 'in');
  assert.deepEqual(activeQuery.query.status.values, ['sent', 'viewed', 'following_up']);
  assert.equal(activeQuery.query.issuedAt.__mockOperator, 'gte');
  assert.equal(activeQuery.query.issuedAt.value.getTime(), NOW.getTime() - 30 * DAY);
});

test('14. 创建写入严格的 pending_dispatch/version=1 服务端快照', async () => {
  const fixture = await createFixture();
  const response = await createAlert(fixture, createBody({ sourceReference: null }));
  const alert = fixture.state.alerts[0];

  assert.equal(alert._id, 'alert_created_1');
  assert.equal(alert.sourceType, 'manual');
  assert.equal(alert.riskRuleId, 'rule_default');
  assert.equal(alert.status, 'pending_dispatch');
  assert.equal(alert.version, 1);
  assert.equal(alert.createdAt.$serverDate > 0, true);
  assert.equal(alert.updatedAt.$serverDate > 0, true);
  for (const forbidden of ['issuedBy', 'issuedAt', 'readAt', 'closedAt', 'closeReason', 'studentNo']) {
    assert.equal(Object.hasOwn(alert, forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(response.json.alert).sort(), [
    'alertId', 'fraudType', 'riskLevel', 'riskReasons', 'status', 'version',
  ]);
});

test('15. create alert 与最小审计写入位于同一事务且不泄露敏感输入', async () => {
  const fixture = await createFixture({ options: { rejectDirectBusinessWrites: true } });
  const sensitiveContent = '敏感提醒正文-不应进入审计';
  const sensitiveReference = 'sensitive-source-reference';
  const response = await createAlert(fixture, createBody({ content: sensitiveContent, sourceReference: sensitiveReference }));
  const audit = fixture.state.audits[0];

  assert.equal(response.json.code, 'ALERT_CREATED');
  assert.equal(fixture.state.transactionCalls, 1);
  assert.equal(fixture.state.writes.every((write) => write.inTransaction), true);
  assert.deepEqual({
    actorId: audit.actorId,
    actorRole: audit.actorRole,
    actorCollegeId: audit.actorCollegeId,
    action: audit.action,
    resourceType: audit.resourceType,
    resourceId: audit.resourceId,
    result: audit.result,
    afterSummary: audit.afterSummary,
  }, {
    actorId: 'usr_security_001',
    actorRole: 'security',
    actorCollegeId: null,
    action: 'alert.create',
    resourceType: 'alert',
    resourceId: 'alert_created_1',
    result: 'success',
    afterSummary: { status: 'pending_dispatch', riskLevel: 'low' },
  });
  const auditJson = JSON.stringify(audit);
  const logJson = JSON.stringify(fixture.logs);
  for (const secret of ['20260001', sensitiveContent, sensitiveReference, 'student-openid-not-exposed', 'student:20260001', PASSWORD]) {
    assert.equal(auditJson.includes(secret), false, secret);
    assert.equal(logJson.includes(secret), false, secret);
  }
  assert.equal(response.body.includes(sensitiveContent), false);
  assert.equal(response.body.includes(sensitiveReference), false);
});

test('16. 创建写入失败（抛错或 SDK 错误返回）时事务整体回滚且错误不泄露底层细节', async () => {
  for (const options of [
    { auditFailure: true },
    { auditResultFailure: true },
    { alertResultFailure: true },
  ]) {
    const fixture = await createFixture({ options });
    const response = await createAlert(fixture);

    assert.equal(response.statusCode, 500);
    assert.equal(response.json.code, 'INTERNAL_ERROR');
    assertNoAlertMutation(fixture.state);
    assert.equal(response.body.includes('audit unavailable'), false);
    assert.equal(response.body.includes('AUDIT_INSERT_FAILED'), false);
  }
});

test('17. 两个业务路由都重读 security 用户，伪造、过期或失权 session 不能写入', async () => {
  const fixture = await createFixture();
  const [version, payload, signature] = fixture.token.split('.');
  const forged = `${version}.${payload}.${Buffer.from(`${signature}x`).toString('base64url')}`;
  const forgedResponse = await createAlert(fixture, createBody(), authHeaders(forged));
  const forgedDispatchResponse = await dispatchAlert(fixture, 'alert_missing', { version: 1 }, authHeaders(forged));
  assert.equal(forgedResponse.statusCode, 401);
  assert.equal(forgedResponse.json.code, 'TOKEN_INVALID');
  assert.equal(forgedDispatchResponse.statusCode, 401);
  assert.equal(forgedDispatchResponse.json.code, 'TOKEN_INVALID');

  const cases = [
    {
      name: 'expired',
      prepare: (current) => current.setNowSeconds(Math.floor(NOW.getTime() / 1000) + SESSION_TTL_SECONDS),
      code: 'TOKEN_EXPIRED',
      statusCode: 401,
    },
    {
      name: 'missing user',
      prepare: (current) => current.state.users.splice(0, 1),
      code: 'TOKEN_INVALID',
      statusCode: 401,
    },
    {
      name: 'disabled user',
      prepare: (current) => { current.state.users[0].status = 'suspended'; },
      code: 'ACCOUNT_DISABLED',
      statusCode: 403,
    },
    {
      name: 'changed role',
      prepare: (current) => { current.state.users[0].role = 'student'; },
      code: 'FORBIDDEN',
      statusCode: 403,
    },
    {
      name: 'wxOpenId attached',
      prepare: (current) => { current.state.users[0].wxOpenId = 'unexpected-web-binding'; },
      code: 'FORBIDDEN',
      statusCode: 403,
    },
    {
      name: 'bindStatus changed',
      prepare: (current) => { current.state.users[0].bindStatus = 'bound'; },
      code: 'FORBIDDEN',
      statusCode: 403,
    },
  ];
  for (const scenario of cases) {
    const current = await createFixture({ alerts: [pendingAlert()] });
    scenario.prepare(current);
    const createResponse = await createAlert(current);
    const dispatchResponse = await dispatchAlert(current);
    assert.equal(createResponse.statusCode, scenario.statusCode, scenario.name);
    assert.equal(createResponse.json.code, scenario.code, scenario.name);
    assert.equal(dispatchResponse.statusCode, scenario.statusCode, scenario.name);
    assert.equal(dispatchResponse.json.code, scenario.code, scenario.name);
    assert.equal(current.state.alerts[0].status, 'pending_dispatch', scenario.name);
    assert.equal(current.state.audits.length, 0, scenario.name);
  }
});

test('18. dispatch body 只允许正安全整数 version 与唯一白名单字段', async () => {
  const invalidBodies = [
    {}, { version: 0 }, { version: -1 }, { version: 1.5 }, { version: '1' },
    { version: Number.MAX_SAFE_INTEGER + 1 }, { version: 1, status: 'sent' },
    { version: 1, issuedBy: 'usr_attacker' }, { version: 1, studentId: 'usr_attacker' },
    { version: 1, collegeId: 'college_attacker' }, { version: 1, riskLevel: 'high' },
    { version: 1, actorId: 'usr_attacker' }, { version: 1, operatorId: 'usr_attacker' },
  ];

  for (const body of invalidBodies) {
    const fixture = await createFixture({ alerts: [pendingAlert()] });
    const response = await dispatchAlert(fixture, 'alert_existing', body);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json.code, 'INVALID_INPUT');
    assert.equal(fixture.state.alerts[0].status, 'pending_dispatch');
    assert.equal(fixture.state.alerts[0].version, 1);
    assert.equal(fixture.state.audits.length, 0);
  }
});

test('19. dispatch 只允许 pending_dispatch 且 alert 必须存在', async () => {
  const missingFixture = await createFixture();
  const missing = await dispatchAlert(missingFixture, 'alert_missing');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json.code, 'NOT_FOUND');

  const sentFixture = await createFixture({ alerts: [existingAlert({ status: 'sent', version: 4 })] });
  const sent = await dispatchAlert(sentFixture, 'alert_existing', { version: 4 });
  assert.equal(sent.statusCode, 409);
  assert.equal(sent.json.code, 'CONFLICT');
  assert.equal(sentFixture.state.alerts[0].version, 4);
  assert.equal(sentFixture.state.audits.length, 0);
});

test('20. dispatch 需要精确匹配客户端版本', async () => {
  const fixture = await createFixture({ alerts: [pendingAlert({ version: 5 })] });
  const response = await dispatchAlert(fixture, 'alert_existing', { version: 4 });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'CONFLICT');
  assert.equal(fixture.state.alerts[0].status, 'pending_dispatch');
  assert.equal(fixture.state.alerts[0].version, 5);
  assert.equal(fixture.state.audits.length, 0);
});

test('21. dispatch 条件更新必须匹配 _id、pending_dispatch 与 expected version', async () => {
  const fixture = await createFixture({ alerts: [pendingAlert({ version: 7 })] });
  const response = await dispatchAlert(fixture, 'alert_existing', { version: 7 });

  assert.equal(response.json.ok, true);
  assert.deepEqual(fixture.state.conditionalUpdates[0].query, {
    _id: 'alert_existing',
    status: 'pending_dispatch',
    version: 7,
  });
  assert.equal(fixture.state.conditionalUpdates[0].data.version, 8);
});

test('22. dispatch 条件更新 0 条时返回 CONFLICT 且事务回滚', async () => {
  const fixture = await createFixture({
    alerts: [pendingAlert()],
    options: { conditionUpdateZero: true },
  });
  const response = await dispatchAlert(fixture);

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.code, 'CONFLICT');
  assert.equal(fixture.state.alerts[0].status, 'pending_dispatch');
  assert.equal(fixture.state.alerts[0].version, 1);
  assert.equal(fixture.state.audits.length, 0);
});

test('23. 耗尽重试后的 CloudBase 事务冲突统一返回 CONFLICT 且回滚', async () => {
  const createFixtureWithConflict = await createFixture({ options: { transactionConflict: true } });
  const createResponse = await createAlert(createFixtureWithConflict);
  assert.equal(createResponse.statusCode, 409);
  assert.equal(createResponse.json.code, 'CONFLICT');
  assertNoAlertMutation(createFixtureWithConflict.state);

  const dispatchFixtureWithConflict = await createFixture({
    alerts: [pendingAlert()],
    options: { transactionConflict: true },
  });
  const dispatchResponse = await dispatchAlert(dispatchFixtureWithConflict);
  assert.equal(dispatchResponse.statusCode, 409);
  assert.equal(dispatchResponse.json.code, 'CONFLICT');
  assert.equal(dispatchFixtureWithConflict.state.alerts[0].status, 'pending_dispatch');
  assert.equal(dispatchFixtureWithConflict.state.audits.length, 0);
});

test('24. dispatch 写入可信 security issuedBy、serverDate issuedAt 和 version+1', async () => {
  const fixture = await createFixture({ alerts: [pendingAlert({ version: 2 })] });
  const response = await dispatchAlert(fixture, 'alert_existing', { version: 2 });
  const alert = fixture.state.alerts[0];

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.ok, true);
  assert.equal(alert.status, 'sent');
  assert.equal(alert.issuedBy, 'usr_security_001');
  assert.equal(alert.issuedAt.$serverDate > 0, true);
  assert.equal(alert.updatedAt.$serverDate > 0, true);
  assert.equal(alert.version, 3);
});

test('25. dispatch 与最小 alert.dispatch 审计同事务完成', async () => {
  const fixture = await createFixture({
    alerts: [pendingAlert()],
    options: { rejectDirectBusinessWrites: true },
  });
  const response = await dispatchAlert(fixture);
  const audit = fixture.state.audits[0];

  assert.equal(response.json.ok, true);
  assert.equal(fixture.state.transactionCalls, 1);
  assert.equal(fixture.state.writes.every((write) => write.inTransaction), true);
  assert.deepEqual({
    actorId: audit.actorId,
    actorRole: audit.actorRole,
    actorCollegeId: audit.actorCollegeId,
    action: audit.action,
    resourceType: audit.resourceType,
    resourceId: audit.resourceId,
    result: audit.result,
    beforeSummary: audit.beforeSummary,
    afterSummary: audit.afterSummary,
  }, {
    actorId: 'usr_security_001',
    actorRole: 'security',
    actorCollegeId: null,
    action: 'alert.dispatch',
    resourceType: 'alert',
    resourceId: 'alert_existing',
    result: 'success',
    beforeSummary: { status: 'pending_dispatch' },
    afterSummary: { status: 'sent' },
  });
  const auditJson = JSON.stringify(audit);
  for (const secret of ['已有预警', 'student-openid-not-exposed', 'student:20260001', 'college_cs']) {
    assert.equal(auditJson.includes(secret), false, secret);
  }
});

test('26. dispatch 审计失败（抛错或 SDK 错误返回）时 alert 状态、版本和下发人全部回滚', async () => {
  for (const options of [{ auditFailure: true }, { auditResultFailure: true }]) {
    const fixture = await createFixture({
      alerts: [pendingAlert()],
      options,
    });
    const response = await dispatchAlert(fixture);
    const alert = fixture.state.alerts[0];

    assert.equal(response.statusCode, 500);
    assert.equal(response.json.code, 'INTERNAL_ERROR');
    assert.equal(alert.status, 'pending_dispatch');
    assert.equal(alert.version, 1);
    assert.equal(Object.hasOwn(alert, 'issuedBy'), false);
    assert.equal(Object.hasOwn(alert, 'issuedAt'), false);
    assert.equal(fixture.state.audits.length, 0);
    assert.equal(response.body.includes('AUDIT_INSERT_FAILED'), false);
  }
});

test('27. dispatch 前重新验证目标学生和学院快照，不静默改写 collegeId', async () => {
  const invalidTargets = [
    studentUser({ role: 'counselor' }),
    studentUser({ status: 'disabled' }),
    studentUser({ collegeId: ' ' }),
    studentUser({ collegeId: 'college_changed' }),
  ];

  for (const target of invalidTargets) {
    const fixture = await createFixture({
      users: [await securityUser(), target],
      alerts: [pendingAlert()],
    });
    const response = await dispatchAlert(fixture);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json.code, 'CONFLICT');
    assert.equal(fixture.state.alerts[0].status, 'pending_dispatch');
    assert.equal(fixture.state.alerts[0].collegeId, 'college_cs');
    assert.equal(fixture.state.audits.length, 0);
  }
});

test('28. 重复 dispatch 不会把 sent 重新写 sent', async () => {
  const fixture = await createFixture({ alerts: [pendingAlert()] });
  const first = await dispatchAlert(fixture);
  const second = await dispatchAlert(fixture, 'alert_existing', { version: 2 });

  assert.equal(first.json.ok, true);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json.code, 'CONFLICT');
  assert.equal(fixture.state.alerts[0].status, 'sent');
  assert.equal(fixture.state.alerts[0].version, 2);
  assert.equal(fixture.state.audits.length, 1);
});

test('29. /alerts OPTIONS 使用现有严格 CORS 逻辑', async () => {
  const fixture = await createFixture();
  const response = await request(fixture.handler, {
    method: 'OPTIONS',
    path: '/alerts',
    headers: { Origin: ALLOWED_ORIGIN },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  assert.equal(response.headers['Access-Control-Allow-Origin'], ALLOWED_ORIGIN);
  assert.equal(response.headers['Access-Control-Allow-Headers'], 'Authorization, Content-Type');
  assert.equal(response.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
});

test('30. /alerts/:alertId/dispatch OPTIONS 使用现有严格 CORS 逻辑', async () => {
  const fixture = await createFixture();
  const response = await request(fixture.handler, {
    method: 'OPTIONS',
    path: '/alerts/alert_existing/dispatch',
    headers: { Origin: ALLOWED_ORIGIN },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  assert.equal(response.headers['Access-Control-Allow-Origin'], ALLOWED_ORIGIN);
  assert.equal(response.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
});

test('31. 默认 handler 装配后仍以固定环境提供事务化预警路由', async () => {
  const security = await securityUser();
  const mock = createMockDb({
    users: [security, studentUser()],
    riskRules: [defaultRule()],
  });
  const handler = createDefaultHandler({
    cloudbase: {
      init: () => ({ database: () => mock.db }),
    },
    bcrypt,
    environment: {
      CLOUDBASE_APIKEY: crypto.randomBytes(32).toString('base64url'),
      SECURITY_SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
      SECURITY_WEB_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    },
    logger: { error: () => {} },
  });
  const login = await request(handler, {
    method: 'POST',
    path: '/login',
    body: JSON.stringify({ loginName: 'security01', password: PASSWORD }),
  });
  const create = await request(handler, {
    method: 'POST',
    path: '/alerts',
    headers: authHeaders(login.json.token),
    body: JSON.stringify(createBody()),
  });

  assert.equal(login.statusCode, 200);
  assert.equal(login.json.code, 'AUTHENTICATED');
  assert.equal(create.statusCode, 200);
  assert.equal(create.json.code, 'ALERT_CREATED');
  assert.equal(mock.state.alerts.length, 1);
  assert.equal(mock.state.alerts[0].studentId, 'usr_student_001');
  assert.equal(mock.state.writes.every((write) => write.inTransaction), false);
  assert.equal(mock.state.writes.filter((write) => write.collection === 'alerts').every((write) => write.inTransaction), true);
});

test('32. 原 /login 与 /session 行为经扩展 handler 保持可用', async () => {
  const fixture = await createFixture();
  const login = await request(fixture.handler, {
    method: 'POST',
    path: '/login',
    body: JSON.stringify({ loginName: 'security01', password: PASSWORD }),
  });
  const session = await request(fixture.handler, {
    method: 'GET',
    path: '/session',
    headers: authHeaders(login.json.token),
  });

  assert.equal(login.statusCode, 200);
  assert.equal(login.json.code, 'AUTHENTICATED');
  assert.equal(session.statusCode, 200);
  assert.deepEqual(session.json, {
    ok: true,
    code: 'SESSION_VALID',
    profile: { userId: 'usr_security_001', role: 'security', name: '保卫处测试账号' },
  });
});
