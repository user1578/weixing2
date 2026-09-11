'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const bcrypt = require('../../cloudfunctions/securityAuthHttp/node_modules/bcryptjs');
const securityAuth = require('../../cloudfunctions/securityAuthHttp');

const {
  createAuthService,
  createHttpHandler,
  createSecurityIdentityManagementService,
  maskIdentityNo,
} = securityAuth.__testables;

const PASSWORD = 'security-identity-management-test-password';
const ALLOWED_ORIGIN = 'https://security.example.edu';
const passwordHashPromise = bcrypt.hash(PASSWORD, 4);

function clone(value) {
  return structuredClone(value);
}

function documentResult(document) {
  const data = document ? [clone(document)] : [];
  if (document) Object.assign(data, clone(document));
  return { data };
}

function matches(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (expected && expected.__mockOperator === 'in') {
      return expected.values.includes(document[key]);
    }
    return document[key] === expected;
  });
}

function createMockDb({ users = [], colleges = [], options = {} } = {}) {
  const state = {
    users: users.map(clone),
    colleges: colleges.map(clone),
    audits: [],
    authAudits: [],
    reads: [],
    writes: [],
    conditionalUpdates: [],
    transactionCalls: 0,
  };

  function documents(name) {
    if (name === 'users') return state.users;
    if (name === 'colleges') return state.colleges;
    if (name === 'audit_logs') return state.audits;
    throw new Error(`Unexpected collection: ${name}`);
  }

  function snapshot() {
    return {
      users: state.users.map(clone),
      colleges: state.colleges.map(clone),
      audits: state.audits.map(clone),
    };
  }

  function restore(saved) {
    state.users.splice(0, state.users.length, ...saved.users.map(clone));
    state.colleges.splice(0, state.colleges.length, ...saved.colleges.map(clone));
    state.audits.splice(0, state.audits.length, ...saved.audits.map(clone));
  }

  function makeCollection(name, inTransaction) {
    function select(query) {
      return documents(name).filter((document) => matches(document, query));
    }

    async function update(query, rawUpdate) {
      state.conditionalUpdates.push({ collection: name, query: clone(query), update: clone(rawUpdate), inTransaction });
      state.writes.push({ collection: name, operation: 'where.update', inTransaction });
      if (options.conditionUpdateZero && name === 'users') {
        return { updated: 0, stats: { updated: 0 } };
      }
      const matched = select(query);
      for (const document of matched) Object.assign(document, clone(rawUpdate));
      return { updated: matched.length, stats: { updated: matched.length } };
    }

    return {
      async get() {
        state.reads.push({ collection: name, operation: 'get', inTransaction });
        return { data: documents(name).map(clone) };
      },
      doc(id) {
        return {
          async get() {
            state.reads.push({ collection: name, operation: 'doc.get', id, inTransaction });
            return documentResult(documents(name).find((document) => document._id === id));
          },
        };
      },
      where(query) {
        return {
          async get() {
            state.reads.push({ collection: name, operation: 'where.get', query: clone(query), inTransaction });
            return { data: select(query).map(clone) };
          },
          async update(rawUpdate) {
            return update(query, rawUpdate);
          },
        };
      },
      async add(document) {
        state.writes.push({ collection: name, operation: 'add', inTransaction });
        if (name === 'audit_logs' && options.auditFailure) {
          throw new Error('audit unavailable');
        }
        if (name === 'users') {
          const duplicate = state.users.some((user) => user.identityKey === document.identityKey || user.wxIdentityKey === document.wxIdentityKey);
          if (duplicate || options.duplicateInsert) {
            const error = new Error('duplicate key');
            error.code = 'DUPLICATE_KEY';
            throw error;
          }
        }
        documents(name).push(clone(document));
        return { id: document._id };
      },
    };
  }

  return {
    state,
    db: {
      command: {
        in: (values) => ({ __mockOperator: 'in', values: [...values] }),
      },
      collection: (name) => makeCollection(name, false),
      async runTransaction(callback) {
        state.transactionCalls += 1;
        const saved = snapshot();
        try {
          if (typeof options.beforeTransaction === 'function') options.beforeTransaction(state);
          return await callback({ collection: (name) => makeCollection(name, true) });
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

function identityUser(overrides = {}) {
  return {
    _id: 'usr_student_001',
    identityKey: 'student:20260001',
    wxIdentityKey: 'openid:student-openid',
    role: 'student',
    name: '学生甲',
    collegeId: 'college_cs',
    studentNo: '20260001',
    staffNo: null,
    wxOpenId: 'student-openid',
    bindStatus: 'bound',
    status: 'active',
    version: 3,
    loginName: null,
    passwordHash: null,
    mobile: '13800138000',
    focusFlag: true,
    focusReason: '不得泄露',
    ...overrides,
  };
}

function activeCollege(overrides = {}) {
  return { _id: 'college_cs', name: '计算机科学学院', status: 'active', ...overrides };
}

async function createFixture({ users, colleges, options = {} } = {}) {
  const security = await securityUser();
  const mock = createMockDb({
    users: users || [security, identityUser()],
    colleges: colleges || [activeCollege()],
    options,
  });
  let auditIndex = 0;
  const authService = createAuthService({
    userRepository: {
      async findByIdentityKey(identityKey) {
        return mock.state.users.find((user) => user.identityKey === identityKey) || null;
      },
      async findById(userId) {
        return mock.state.users.find((user) => user._id === userId) || null;
      },
    },
    auditRepository: {
      async appendAudit(audit) {
        mock.state.authAudits.push(clone(audit));
      },
    },
    bcrypt,
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
    serverDate: () => ({ $serverDate: true }),
    nowSeconds: () => 1_780_000_000,
    createRequestId: () => 'req_identity_test',
    createAuditId: () => `audit_auth_${++auditIndex}`,
    createJti: () => 'jti_identity_test',
    logger: { error() {} },
    configured: true,
  });
  const identityManagementService = createSecurityIdentityManagementService({
    authService,
    db: mock.db,
    serverDate: () => ({ $serverDate: true }),
    createUserId: () => 'usr_created_001',
    createAuditId: () => `audit_identity_${++auditIndex}`,
    createRequestId: () => 'req_identity_test',
    logger: { error() {} },
    configured: true,
  });
  const handler = createHttpHandler({
    authService,
    identityManagementService,
    allowedOrigins: ALLOWED_ORIGIN,
    logger: { error() {} },
  });
  const authenticated = await authService.login({ loginName: 'security01', password: PASSWORD });
  assert.equal(authenticated.code, 'AUTHENTICATED');
  return { ...mock, handler, token: authenticated.token };
}

async function request(fixture, { method, path, body, headers = {} }) {
  const response = await fixture.handler({ httpMethod: method, path, body, headers });
  return { ...response, json: response.body ? JSON.parse(response.body) : null };
}

function authorization(token) {
  return { Authorization: `Bearer ${token}` };
}

test('1. GET identities 缺失或非法 token 被拒绝，且不读取身份数据', async () => {
  const fixture = await createFixture();
  const missing = await request(fixture, { method: 'GET', path: '/identities' });
  const invalid = await request(fixture, { method: 'GET', path: '/identities', headers: { Authorization: 'Bearer invalid.token.value' } });

  assert.equal(missing.json.code, 'TOKEN_MISSING');
  assert.equal(invalid.json.code, 'TOKEN_INVALID');
  assert.equal(fixture.state.reads.length, 0);
});

test('2. security 可读取脱敏 student/counselor 与 active colleges，列表不返回 security 或敏感字段', async () => {
  const counselor = identityUser({
    _id: 'usr_counselor_001', identityKey: 'counselor:T10001', wxIdentityKey: 'unbound:usr_counselor_001',
    role: 'counselor', name: '辅导员乙', studentNo: null, staffNo: 'T10001', wxOpenId: null, bindStatus: 'unbound', version: 1,
  });
  const security = await securityUser({ wxIdentityKey: 'unbound:usr_security_001' });
  const fixture = await createFixture({
    users: [security, identityUser(), counselor],
    colleges: [activeCollege(), activeCollege({ _id: 'college_math', name: '数学学院' }), activeCollege({ _id: 'college_old', status: 'disabled' })],
  });
  const response = await request(fixture, { method: 'GET', path: '/identities', headers: authorization(fixture.token) });
  const captured = JSON.stringify(response.json);

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.code, 'IDENTITIES_LOADED');
  assert.deepEqual(response.json.identities.map((identity) => identity.role).sort(), ['counselor', 'student']);
  assert.equal(response.json.identities.every((identity) => identity.identityNoMasked.includes('*')), true);
  assert.equal(response.json.colleges.some((college) => college.collegeId === 'college_old'), false);
  for (const secret of ['student-openid', 'student:20260001', '20260001', 'T10001', '13800138000', '不得泄露', 'passwordHash', 'wxOpenId', 'wxIdentityKey', 'identityKey']) {
    assert.equal(captured.includes(secret), false, secret);
  }
  assert.equal(fixture.state.audits.length, 1);
  assert.deepEqual(fixture.state.audits[0].action, 'identity.list');
  assert.equal(fixture.state.audits[0].resourceId, 'usr_security_001');
});

test('2a. 短身份编号不泄露完整值，长编号保持最小展示掩码', () => {
  assert.equal(maskIdentityNo('T01'), 'T*1');
  assert.equal(maskIdentityNo('T001'), 'T**1');
  assert.equal(maskIdentityNo('20260001'), '20****01');
  assert.notEqual(maskIdentityNo('T01'), 'T01');
  assert.notEqual(maskIdentityNo('T001'), 'T001');
});

test('2b. 停用学院不会出现在新增身份选项，但既有身份仍显示真实历史学院名称', async () => {
  const fixture = await createFixture({
    users: [await securityUser(), identityUser({ collegeId: 'college_old' })],
    colleges: [activeCollege({ _id: 'college_old', name: '历史学院', status: 'disabled' }), activeCollege()],
  });
  const response = await request(fixture, { method: 'GET', path: '/identities', headers: authorization(fixture.token) });

  assert.equal(response.json.code, 'IDENTITIES_LOADED');
  assert.equal(response.json.identities[0].collegeName, '历史学院');
  assert.equal(response.json.colleges.some((college) => college.collegeId === 'college_old'), false);
});

test('3. POST identities 可事务创建 student 与 counselor，服务端固定身份字段', async () => {
  const studentFixture = await createFixture();
  const student = await request(studentFixture, {
    method: 'POST', path: '/identities', headers: authorization(studentFixture.token),
    body: JSON.stringify({ role: 'student', identityNo: ' 20269999 ', name: ' 新学生 ', collegeId: 'college_cs' }),
  });
  const createdStudent = studentFixture.state.users.find((user) => user._id === 'usr_created_001');
  assert.equal(student.json.code, 'IDENTITY_CREATED');
  assert.equal(studentFixture.state.transactionCalls, 1);
  assert.deepEqual(createdStudent, {
    _id: 'usr_created_001', identityKey: 'student:20269999', wxIdentityKey: 'unbound:usr_created_001',
    role: 'student', name: '新学生', collegeId: 'college_cs', studentNo: '20269999', staffNo: null,
    loginName: null, passwordHash: null, wxOpenId: null, bindStatus: 'unbound', mobile: null,
    focusFlag: false, focusReason: null, status: 'active', version: 1,
    createdAt: { $serverDate: true }, updatedAt: { $serverDate: true },
  });
  assert.deepEqual(studentFixture.state.audits.at(-1).afterSummary, {
    role: 'student', collegeId: 'college_cs', status: 'active', bindStatus: 'unbound',
  });

  const counselorFixture = await createFixture();
  const counselor = await request(counselorFixture, {
    method: 'POST', path: '/identities', headers: authorization(counselorFixture.token),
    body: JSON.stringify({ role: 'counselor', identityNo: 'T20001', name: '辅导员新', collegeId: 'college_cs' }),
  });
  const createdCounselor = counselorFixture.state.users.find((user) => user._id === 'usr_created_001');
  assert.equal(counselor.json.code, 'IDENTITY_CREATED');
  assert.equal(createdCounselor.identityKey, 'counselor:T20001');
  assert.equal(createdCounselor.studentNo, null);
  assert.equal(createdCounselor.staffNo, 'T20001');
});

test('4. 创建严格拒绝 security、多余字段与伪造服务端字段', async () => {
  const fixture = await createFixture();
  for (const body of [
    { role: 'security', identityNo: 'security02', name: '非法', collegeId: 'college_cs' },
    { role: 'student', identityNo: '20269999', name: '非法', collegeId: 'college_cs', extra: true },
    { role: 'student', identityNo: '20269999', name: '非法', collegeId: 'college_cs', userId: 'forged' },
    { role: 'student', identityNo: '20269999', name: '非法', collegeId: 'college_cs', identityKey: 'security:x' },
    { role: 'student', identityNo: '20269999', name: '非法', collegeId: 'college_cs', wxOpenId: 'forged-openid' },
  ]) {
    const response = await request(fixture, { method: 'POST', path: '/identities', headers: authorization(fixture.token), body: JSON.stringify(body) });
    assert.equal(response.json.code, 'INVALID_INPUT');
  }
  assert.equal(fixture.state.transactionCalls, 0);
});

test('5. 创建拒绝不存在或停用学院，UNIQUE 冲突映射为 CONFLICT', async () => {
  const missingCollegeFixture = await createFixture();
  const missing = await request(missingCollegeFixture, {
    method: 'POST', path: '/identities', headers: authorization(missingCollegeFixture.token),
    body: JSON.stringify({ role: 'student', identityNo: '20269999', name: '新学生', collegeId: 'college_missing' }),
  });
  assert.equal(missing.json.code, 'NOT_FOUND');
  assert.equal(missingCollegeFixture.state.users.some((user) => user._id === 'usr_created_001'), false);

  const disabledCollegeFixture = await createFixture({ colleges: [activeCollege({ status: 'disabled' })] });
  const disabled = await request(disabledCollegeFixture, {
    method: 'POST', path: '/identities', headers: authorization(disabledCollegeFixture.token),
    body: JSON.stringify({ role: 'student', identityNo: '20269999', name: '新学生', collegeId: 'college_cs' }),
  });
  assert.equal(disabled.json.code, 'NOT_FOUND');

  const duplicateFixture = await createFixture();
  const duplicate = await request(duplicateFixture, {
    method: 'POST', path: '/identities', headers: authorization(duplicateFixture.token),
    body: JSON.stringify({ role: 'student', identityNo: '20260001', name: '重复身份', collegeId: 'college_cs' }),
  });
  assert.equal(duplicate.json.code, 'CONFLICT');
});

test('5a. 创建在事务内拒绝跨角色同身份编号，且不新增 users 或 audit', async () => {
  const studentFixture = await createFixture({
    users: [await securityUser(), identityUser({ identityKey: 'student:10001', studentNo: '10001' })],
  });
  const counselorConflict = await request(studentFixture, {
    method: 'POST', path: '/identities', headers: authorization(studentFixture.token),
    body: JSON.stringify({ role: 'counselor', identityNo: '10001', name: '辅导员冲突', collegeId: 'college_cs' }),
  });
  assert.equal(counselorConflict.json.code, 'CONFLICT');
  assert.equal(studentFixture.state.users.filter((user) => user._id === 'usr_created_001').length, 0);
  assert.equal(studentFixture.state.audits.length, 0);

  const counselorFixture = await createFixture({
    users: [await securityUser(), identityUser({
      _id: 'usr_counselor_001', identityKey: 'counselor:10001', role: 'counselor', studentNo: null, staffNo: '10001',
      wxIdentityKey: 'unbound:usr_counselor_001', wxOpenId: null, bindStatus: 'unbound',
    })],
  });
  const studentConflict = await request(counselorFixture, {
    method: 'POST', path: '/identities', headers: authorization(counselorFixture.token),
    body: JSON.stringify({ role: 'student', identityNo: '10001', name: '学生冲突', collegeId: 'college_cs' }),
  });
  assert.equal(studentConflict.json.code, 'CONFLICT');
  assert.equal(counselorFixture.state.users.filter((user) => user._id === 'usr_created_001').length, 0);
  assert.equal(counselorFixture.state.audits.length, 0);
});

test('5b. 不同编号的 student 与 counselor 仍可正常创建', async () => {
  const studentFixture = await createFixture();
  const student = await request(studentFixture, {
    method: 'POST', path: '/identities', headers: authorization(studentFixture.token),
    body: JSON.stringify({ role: 'student', identityNo: '20269999', name: '学生新', collegeId: 'college_cs' }),
  });
  assert.equal(student.json.code, 'IDENTITY_CREATED');

  const counselorFixture = await createFixture();
  const counselor = await request(counselorFixture, {
    method: 'POST', path: '/identities', headers: authorization(counselorFixture.token),
    body: JSON.stringify({ role: 'counselor', identityNo: 'T20001', name: '辅导员新', collegeId: 'college_cs' }),
  });
  assert.equal(counselor.json.code, 'IDENTITY_CREATED');
});

test('6. create 的 users 与 audit 同事务，审计不记录姓名、身份编号或 OPENID', async () => {
  const fixture = await createFixture();
  await request(fixture, {
    method: 'POST', path: '/identities', headers: authorization(fixture.token),
    body: JSON.stringify({ role: 'student', identityNo: '20269999', name: '新学生', collegeId: 'college_cs' }),
  });
  const writes = fixture.state.writes.filter((write) => write.collection === 'users' || write.collection === 'audit_logs');
  const audit = fixture.state.audits.at(-1);
  const captured = JSON.stringify(audit);

  assert.equal(writes.every((write) => write.inTransaction), true);
  assert.equal(audit.action, 'identity.create');
  for (const secret of ['新学生', '20269999', 'studentNo', 'staffNo', 'wxOpenId', 'identityKey', 'mobile']) {
    assert.equal(captured.includes(secret), false, secret);
  }
});

test('7. unbind 成功以直接顶层条件更新并追加最小审计', async () => {
  const fixture = await createFixture();
  const response = await request(fixture, {
    method: 'POST', path: '/identities/usr_student_001/unbind', headers: authorization(fixture.token), body: JSON.stringify({ version: 3 }),
  });
  const user = fixture.state.users.find((item) => item._id === 'usr_student_001');
  const update = fixture.state.conditionalUpdates.at(-1);
  const audit = fixture.state.audits.at(-1);

  assert.equal(response.json.code, 'IDENTITY_UNBOUND');
  assert.equal(user.wxOpenId, null);
  assert.equal(user.wxIdentityKey, 'unbound:usr_student_001');
  assert.equal(user.bindStatus, 'unbound');
  assert.equal(user.version, 4);
  assert.deepEqual(update.query, { _id: 'usr_student_001', version: 3, bindStatus: 'bound', wxIdentityKey: 'openid:student-openid' });
  assert.equal(Object.hasOwn(update.update, 'data'), false);
  assert.equal(update.update.wxOpenId, null);
  assert.deepEqual(audit.beforeSummary, { bindStatus: 'bound' });
  assert.deepEqual(audit.afterSummary, { bindStatus: 'unbound' });
  assert.equal(JSON.stringify(audit).includes('student-openid'), false);
});

test('8. unbind 拒绝未绑定、security、版本冲突和条件更新零条', async () => {
  const unboundFixture = await createFixture({ users: [await securityUser(), identityUser({ bindStatus: 'unbound', wxOpenId: null, wxIdentityKey: 'unbound:usr_student_001' })] });
  const unbound = await request(unboundFixture, {
    method: 'POST', path: '/identities/usr_student_001/unbind', headers: authorization(unboundFixture.token), body: JSON.stringify({ version: 3 }),
  });
  assert.equal(unbound.json.code, 'CONFLICT');

  const targetSecurity = await securityUser({ _id: 'usr_security_002', identityKey: 'security:security02', wxIdentityKey: 'openid:security-openid', wxOpenId: 'security-openid', bindStatus: 'bound', version: 3 });
  const securityFixture = await createFixture({ users: [await securityUser(), targetSecurity] });
  const security = await request(securityFixture, {
    method: 'POST', path: '/identities/usr_security_002/unbind', headers: authorization(securityFixture.token), body: JSON.stringify({ version: 3 }),
  });
  assert.equal(security.json.code, 'FORBIDDEN');

  const versionFixture = await createFixture();
  const version = await request(versionFixture, {
    method: 'POST', path: '/identities/usr_student_001/unbind', headers: authorization(versionFixture.token), body: JSON.stringify({ version: 2 }),
  });
  assert.equal(version.json.code, 'CONFLICT');

  const conditionalFixture = await createFixture({ options: { conditionUpdateZero: true } });
  const conditional = await request(conditionalFixture, {
    method: 'POST', path: '/identities/usr_student_001/unbind', headers: authorization(conditionalFixture.token), body: JSON.stringify({ version: 3 }),
  });
  assert.equal(conditional.json.code, 'CONFLICT');
  assert.equal(conditionalFixture.state.audits.length, 0);
});

test('9. status 可 active→suspended、suspended→active，使用直接顶层条件更新与审计', async () => {
  const suspendFixture = await createFixture();
  const suspended = await request(suspendFixture, {
    method: 'POST', path: '/identities/usr_student_001/status', headers: authorization(suspendFixture.token), body: JSON.stringify({ version: 3, status: 'suspended' }),
  });
  assert.equal(suspended.json.code, 'IDENTITY_STATUS_UPDATED');
  assert.equal(suspendFixture.state.users.find((user) => user._id === 'usr_student_001').status, 'suspended');
  const suspendedUpdate = suspendFixture.state.conditionalUpdates.at(-1);
  assert.deepEqual(suspendedUpdate.query, { _id: 'usr_student_001', version: 3, status: 'active' });
  assert.equal(Object.hasOwn(suspendedUpdate.update, 'data'), false);
  assert.deepEqual(suspendFixture.state.audits.at(-1).beforeSummary, { status: 'active' });
  assert.deepEqual(suspendFixture.state.audits.at(-1).afterSummary, { status: 'suspended' });

  const activeFixture = await createFixture({ users: [await securityUser(), identityUser({ status: 'suspended', version: 4 })] });
  const active = await request(activeFixture, {
    method: 'POST', path: '/identities/usr_student_001/status', headers: authorization(activeFixture.token), body: JSON.stringify({ version: 4, status: 'active' }),
  });
  assert.equal(active.json.code, 'IDENTITY_STATUS_UPDATED');
  assert.equal(activeFixture.state.users.find((user) => user._id === 'usr_student_001').status, 'active');
});

test('10. status 拒绝相同状态、security、版本冲突及条件更新零条', async () => {
  const sameFixture = await createFixture();
  const same = await request(sameFixture, {
    method: 'POST', path: '/identities/usr_student_001/status', headers: authorization(sameFixture.token), body: JSON.stringify({ version: 3, status: 'active' }),
  });
  assert.equal(same.json.code, 'CONFLICT');

  const targetSecurity = await securityUser({ _id: 'usr_security_002', identityKey: 'security:security02', version: 3 });
  const securityFixture = await createFixture({ users: [await securityUser(), targetSecurity] });
  const security = await request(securityFixture, {
    method: 'POST', path: '/identities/usr_security_002/status', headers: authorization(securityFixture.token), body: JSON.stringify({ version: 3, status: 'suspended' }),
  });
  assert.equal(security.json.code, 'FORBIDDEN');

  const versionFixture = await createFixture();
  const version = await request(versionFixture, {
    method: 'POST', path: '/identities/usr_student_001/status', headers: authorization(versionFixture.token), body: JSON.stringify({ version: 2, status: 'suspended' }),
  });
  assert.equal(version.json.code, 'CONFLICT');

  const conditionalFixture = await createFixture({ options: { conditionUpdateZero: true } });
  const conditional = await request(conditionalFixture, {
    method: 'POST', path: '/identities/usr_student_001/status', headers: authorization(conditionalFixture.token), body: JSON.stringify({ version: 3, status: 'suspended' }),
  });
  assert.equal(conditional.json.code, 'CONFLICT');
});

test('11. create、unbind、status 任一审计失败均回滚业务写入', async () => {
  const createFixtureWithAuditFailure = await createFixture({ options: { auditFailure: true } });
  const create = await request(createFixtureWithAuditFailure, {
    method: 'POST', path: '/identities', headers: authorization(createFixtureWithAuditFailure.token),
    body: JSON.stringify({ role: 'student', identityNo: '20269999', name: '新学生', collegeId: 'college_cs' }),
  });
  assert.equal(create.json.code, 'INTERNAL_ERROR');
  assert.equal(createFixtureWithAuditFailure.state.users.some((user) => user._id === 'usr_created_001'), false);

  const unbindFixtureWithAuditFailure = await createFixture({ options: { auditFailure: true } });
  const unbind = await request(unbindFixtureWithAuditFailure, {
    method: 'POST', path: '/identities/usr_student_001/unbind', headers: authorization(unbindFixtureWithAuditFailure.token), body: JSON.stringify({ version: 3 }),
  });
  assert.equal(unbind.json.code, 'INTERNAL_ERROR');
  assert.equal(unbindFixtureWithAuditFailure.state.users.find((user) => user._id === 'usr_student_001').bindStatus, 'bound');

  const statusFixtureWithAuditFailure = await createFixture({ options: { auditFailure: true } });
  const status = await request(statusFixtureWithAuditFailure, {
    method: 'POST', path: '/identities/usr_student_001/status', headers: authorization(statusFixtureWithAuditFailure.token), body: JSON.stringify({ version: 3, status: 'suspended' }),
  });
  assert.equal(status.json.code, 'INTERNAL_ERROR');
  assert.equal(statusFixtureWithAuditFailure.state.users.find((user) => user._id === 'usr_student_001').status, 'active');
});

test('12. identities 路由提供正确 CORS OPTIONS，既有 session 路由保持可用', async () => {
  const fixture = await createFixture();
  const listOptions = await request(fixture, { method: 'OPTIONS', path: '/identities', headers: { Origin: ALLOWED_ORIGIN } });
  const unbindOptions = await request(fixture, { method: 'OPTIONS', path: '/identities/usr_student_001/unbind', headers: { Origin: ALLOWED_ORIGIN } });
  const session = await request(fixture, { method: 'GET', path: '/session', headers: authorization(fixture.token) });

  assert.equal(listOptions.statusCode, 204);
  assert.equal(listOptions.headers['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS');
  assert.equal(unbindOptions.statusCode, 204);
  assert.equal(unbindOptions.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(session.json.code, 'SESSION_VALID');
});
