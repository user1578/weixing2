'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const bcrypt = require('../../cloudfunctions/securityAuthHttp/node_modules/bcryptjs');
const securityAuth = require('../../cloudfunctions/securityAuthHttp');

const {
  SESSION_TTL_SECONDS,
  TARGET_ENV_ID,
  createAuthService,
  createDefaultDependencies,
  createHttpHandler,
} = securityAuth.__testables;

const TEST_PASSWORD = crypto.randomBytes(24).toString('base64url');
const WRONG_PASSWORD = crypto.randomBytes(24).toString('base64url');
const passwordHashPromise = bcrypt.hash(TEST_PASSWORD, 12);

async function passwordHash() {
  return passwordHashPromise;
}

async function securityUser(overrides = {}) {
  return {
    _id: 'usr_security_001',
    identityKey: 'security:security01',
    role: 'security',
    name: '保卫处演示账号',
    passwordHash: await passwordHash(),
    wxOpenId: null,
    bindStatus: 'not_applicable',
    status: 'active',
    ...overrides,
  };
}

function createRepositories(users = [], options = {}) {
  const state = {
    users: users.map((user) => ({ ...user })),
    audits: [],
    identityKeys: [],
    readIds: [],
  };
  return {
    state,
    userRepository: {
      async findByIdentityKey(identityKey) {
        state.identityKeys.push(identityKey);
        return state.users.find((user) => user.identityKey === identityKey) || null;
      },
      async findById(userId) {
        state.readIds.push(userId);
        return state.users.find((user) => user._id === userId) || null;
      },
    },
    auditRepository: {
      async appendAudit(audit) {
        if (options.auditFailure) {
          throw new Error('audit unavailable');
        }
        state.audits.push({ ...audit });
      },
    },
  };
}

function createFixture(users = [], options = {}) {
  const repositories = createRepositories(users, options);
  const logs = [];
  let now = options.now === undefined ? 1_780_000_000 : options.now;
  let jtiCalls = 0;
  const sessionSecret = options.sessionSecret === undefined ? crypto.randomBytes(48).toString('base64url') : options.sessionSecret;
  const service = createAuthService({
    userRepository: repositories.userRepository,
    auditRepository: repositories.auditRepository,
    bcrypt: options.bcrypt || bcrypt,
    sessionSecret,
    serverDate: () => ({ $serverDate: true }),
    nowSeconds: () => now,
    createRequestId: () => 'req_security_test',
    createAuditId: () => 'audit_security_test',
    createJti: () => {
      jtiCalls += 1;
      return `jti_security_${jtiCalls}`;
    },
    logger: { error: (entry) => logs.push(entry) },
    configured: options.configured === undefined ? true : options.configured,
  });
  const handler = createHttpHandler({
    authService: service,
    allowedOrigins: options.allowedOrigins || 'https://security.example.edu',
    logger: { error: (entry) => logs.push(entry) },
  });
  return {
    ...repositories,
    logs,
    handler,
    sessionSecret,
    getNow: () => now,
    setNow: (next) => { now = next; },
    getJtiCalls: () => jtiCalls,
  };
}

async function request(handler, { method, path, body, headers = {} }) {
  const response = await handler({ httpMethod: method, path, body, headers });
  return { ...response, json: response.body ? JSON.parse(response.body) : null };
}

async function login(handler, loginName = 'security01', password = TEST_PASSWORD, headers = {}) {
  return request(handler, {
    method: 'POST',
    path: '/login',
    headers,
    body: JSON.stringify({ loginName, password }),
  });
}

async function authenticatedFixture(options = {}) {
  const fixture = createFixture([await securityUser()], options);
  const response = await login(fixture.handler);
  assert.equal(response.json.code, 'AUTHENTICATED');
  return { fixture, token: response.json.token, loginResponse: response };
}

function decodeClaims(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

test('1. 正确 security 账号和密码返回 AUTHENTICATED', async () => {
  const fixture = createFixture([await securityUser()]);
  const response = await login(fixture.handler);

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.code, 'AUTHENTICATED');
  assert.deepEqual(response.json.profile, {
    userId: 'usr_security_001',
    role: 'security',
    name: '保卫处演示账号',
  });
});

test('2. 密码通过 bcryptjs 校验且读取 passwordHash', async () => {
  const user = await securityUser();
  const calls = [];
  const fixture = createFixture([user], {
    bcrypt: {
      compare: async (password, hash) => {
        calls.push([password, hash]);
        return bcrypt.compare(password, hash);
      },
    },
  });
  const response = await login(fixture.handler);

  assert.equal(response.json.code, 'AUTHENTICATED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], TEST_PASSWORD);
  assert.equal(calls[0][1], user.passwordHash);
  assert.match(user.passwordHash, /^\$2[aby]\$12\$/);
});

test('3. 登录名仅去除首尾空白后构造 security identityKey', async () => {
  const fixture = createFixture([await securityUser()]);
  const response = await login(fixture.handler, '  security01  ');

  assert.equal(response.json.code, 'AUTHENTICATED');
  assert.deepEqual(fixture.state.identityKeys, ['security:security01']);
});

test('4. 不存在账号统一返回 AUTH_FAILED', async () => {
  const fixture = createFixture([]);
  const response = await login(fixture.handler, 'missing');

  assert.equal(response.statusCode, 401);
  assert.equal(response.json.code, 'AUTH_FAILED');
});

test('5. 错误密码统一返回 AUTH_FAILED', async () => {
  const fixture = createFixture([await securityUser()]);
  const response = await login(fixture.handler, 'security01', WRONG_PASSWORD);

  assert.equal(response.statusCode, 401);
  assert.equal(response.json.code, 'AUTH_FAILED');
});

test('6. student 账号不能通过 Web 登录', async () => {
  const fixture = createFixture([await securityUser({ role: 'student', identityKey: 'security:student01' })]);
  const response = await login(fixture.handler, 'student01');

  assert.equal(response.json.code, 'AUTH_FAILED');
  assert.equal(fixture.state.audits.length, 0);
});

test('7. counselor 账号不能通过 Web 登录', async () => {
  const fixture = createFixture([await securityUser({ role: 'counselor', identityKey: 'security:counselor01' })]);
  const response = await login(fixture.handler, 'counselor01');

  assert.equal(response.json.code, 'AUTH_FAILED');
  assert.equal(fixture.state.audits.length, 0);
});

test('8. inactive security 账号返回 ACCOUNT_DISABLED 并写失败审计', async () => {
  const fixture = createFixture([await securityUser({ status: 'suspended' })]);
  const response = await login(fixture.handler);

  assert.equal(response.statusCode, 403);
  assert.equal(response.json.code, 'ACCOUNT_DISABLED');
  assert.equal(fixture.state.audits[0].result, 'failure');
  assert.equal(fixture.state.audits[0].failureReason, 'ACCOUNT_DISABLED');
});

test('9. security 记录带 wxOpenId 时不签发 Web token', async () => {
  const fixture = createFixture([await securityUser({ wxOpenId: 'not-trusted-here' })]);
  const response = await login(fixture.handler);

  assert.equal(response.json.code, 'AUTH_FAILED');
  assert.equal(response.json.token, undefined);
});

test('10. security 记录 bindStatus 异常时不签发 Web token', async () => {
  const fixture = createFixture([await securityUser({ bindStatus: 'bound' })]);
  const response = await login(fixture.handler);

  assert.equal(response.json.code, 'AUTH_FAILED');
  assert.equal(response.json.token, undefined);
});

test('11. 登录 body 仅允许 loginName 和 password', async () => {
  const fixture = createFixture([await securityUser()]);
  const response = await request(fixture.handler, {
    method: 'POST',
    path: '/login',
    body: JSON.stringify({ loginName: 'security01', password: TEST_PASSWORD, role: 'security' }),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json.code, 'INVALID_INPUT');
  assert.equal(fixture.state.identityKeys.length, 0);
});

test('12. 非法 JSON、缺字段和数组 body 均返回 INVALID_INPUT', async () => {
  const fixture = createFixture([await securityUser()]);
  const malformed = await request(fixture.handler, { method: 'POST', path: '/login', body: '{' });
  const missing = await request(fixture.handler, { method: 'POST', path: '/login', body: JSON.stringify({ loginName: 'security01' }) });
  const array = await request(fixture.handler, { method: 'POST', path: '/login', body: JSON.stringify(['security01', TEST_PASSWORD]) });

  assert.equal(malformed.json.code, 'INVALID_INPUT');
  assert.equal(missing.json.code, 'INVALID_INPUT');
  assert.equal(array.json.code, 'INVALID_INPUT');
});

test('13. 超过 bcrypt 72 UTF-8 字节的密码被拒绝', async () => {
  const fixture = createFixture([await securityUser()]);
  const response = await login(fixture.handler, 'security01', 'a'.repeat(73));

  assert.equal(response.json.code, 'INVALID_INPUT');
});

test('14. 成功登录写入最小 success audit', async () => {
  const fixture = createFixture([await securityUser()]);
  await login(fixture.handler);

  assert.deepEqual(fixture.state.audits, [{
    _id: 'audit_security_test',
    actorId: 'usr_security_001',
    actorRole: 'security',
    actorCollegeId: null,
    action: 'security.login',
    resourceType: 'user',
    resourceId: 'usr_security_001',
    result: 'success',
    requestId: 'req_security_test',
    createdAt: { $serverDate: true },
  }]);
});

test('15. success audit 写入失败时不签发 token', async () => {
  const fixture = createFixture([await securityUser()], { auditFailure: true });
  const response = await login(fixture.handler);

  assert.equal(response.statusCode, 500);
  assert.equal(response.json.code, 'INTERNAL_ERROR');
  assert.equal(response.json.token, undefined);
  assert.equal(fixture.getJtiCalls(), 1);
});

test('16. 密码、passwordHash 不进入 audit 或 logger', async () => {
  const user = await securityUser();
  const fixture = createFixture([user]);
  await login(fixture.handler);
  const captured = JSON.stringify({ audits: fixture.state.audits, logs: fixture.logs });

  assert.equal(captured.includes(TEST_PASSWORD), false);
  assert.equal(captured.includes(user.passwordHash), false);
});

test('17. passwordHash 不进入登录响应', async () => {
  const user = await securityUser();
  const fixture = createFixture([user]);
  const response = await login(fixture.handler);

  assert.equal(response.body.includes(user.passwordHash), false);
  assert.equal(Object.hasOwn(response.json, 'passwordHash'), false);
});

test('18. token claims 严格最小且有效期为两小时', async () => {
  const { token, fixture } = await authenticatedFixture();
  const claims = decodeClaims(token);

  assert.deepEqual(Object.keys(claims).sort(), ['exp', 'iat', 'jti', 'role', 'sub']);
  assert.equal(claims.sub, 'usr_security_001');
  assert.equal(claims.role, 'security');
  assert.equal(claims.exp - claims.iat, SESSION_TTL_SECONDS);
  assert.equal(claims.iat, fixture.getNow());
});

test('19. token 签名篡改返回 TOKEN_INVALID', async () => {
  const { fixture, token } = await authenticatedFixture();
  const [version, payload, signature] = token.split('.');
  const signatureBytes = Buffer.from(signature, 'base64url');
  signatureBytes[0] ^= 0x01;
  const tamperedSignature = signatureBytes.toString('base64url');
  const tampered = `${version}.${payload}.${tamperedSignature}`;
  const response = await request(fixture.handler, {
    method: 'GET', path: '/session', headers: { Authorization: `Bearer ${tampered}` },
  });

  assert.equal(response.json.code, 'TOKEN_INVALID');
});

test('20. token payload 篡改返回 TOKEN_INVALID', async () => {
  const { fixture, token } = await authenticatedFixture();
  const [version, payload, signature] = token.split('.');
  const alteredPayload = Buffer.from(`${Buffer.from(payload, 'base64url').toString('utf8')} `).toString('base64url');
  const response = await request(fixture.handler, {
    method: 'GET', path: '/session', headers: { Authorization: `Bearer ${version}.${alteredPayload}.${signature}` },
  });

  assert.equal(response.json.code, 'TOKEN_INVALID');
});

test('21. 过期 token 返回 TOKEN_EXPIRED', async () => {
  const { fixture, token } = await authenticatedFixture();
  fixture.setNow(fixture.getNow() + SESSION_TTL_SECONDS);
  const response = await request(fixture.handler, {
    method: 'GET', path: '/session', headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.json.code, 'TOKEN_EXPIRED');
});

test('22. 无 Authorization 返回 TOKEN_MISSING', async () => {
  const { fixture } = await authenticatedFixture();
  const response = await request(fixture.handler, { method: 'GET', path: '/session' });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json.code, 'TOKEN_MISSING');
});

test('23. Bearer 格式错误返回 TOKEN_INVALID', async () => {
  const { fixture } = await authenticatedFixture();
  const response = await request(fixture.handler, {
    method: 'GET', path: '/session', headers: { Authorization: 'Token malformed' },
  });

  assert.equal(response.json.code, 'TOKEN_INVALID');
});

test('24. 伪造 token role 不能绕过签名验证', async () => {
  const { fixture, token } = await authenticatedFixture();
  const claims = decodeClaims(token);
  claims.role = 'student';
  const forgedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const response = await request(fixture.handler, {
    method: 'GET', path: '/session', headers: { Authorization: `Bearer v1.${forgedPayload}.${token.split('.')[2]}` },
  });

  assert.equal(response.json.code, 'TOKEN_INVALID');
});

test('25. /session 按 sub 重新读取 users', async () => {
  const { fixture, token } = await authenticatedFixture();
  const response = await request(fixture.handler, {
    method: 'GET', path: '/session', headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.json.code, 'SESSION_VALID');
  assert.deepEqual(fixture.state.readIds, ['usr_security_001']);
});

test('26. token 有效但用户后来 inactive 返回 ACCOUNT_DISABLED', async () => {
  const { fixture, token } = await authenticatedFixture();
  fixture.state.users[0].status = 'suspended';
  const response = await request(fixture.handler, {
    method: 'GET', path: '/session', headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.json.code, 'ACCOUNT_DISABLED');
});

test('27. token 有效但用户角色变化返回 FORBIDDEN', async () => {
  const { fixture, token } = await authenticatedFixture();
  fixture.state.users[0].role = 'student';
  const response = await request(fixture.handler, {
    method: 'GET', path: '/session', headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.json.code, 'FORBIDDEN');
});

test('28. /session 只返回最小 profile', async () => {
  const { fixture, token } = await authenticatedFixture();
  const response = await request(fixture.handler, {
    method: 'GET', path: '/session', headers: { Authorization: `Bearer ${token}` },
  });

  assert.deepEqual(response.json, {
    ok: true,
    code: 'SESSION_VALID',
    profile: { userId: 'usr_security_001', role: 'security', name: '保卫处演示账号' },
  });
});

test('29. 白名单 Origin 获得精确 CORS 响应头', async () => {
  const fixture = createFixture([await securityUser()]);
  const response = await login(fixture.handler, 'security01', TEST_PASSWORD, { Origin: 'https://security.example.edu' });

  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://security.example.edu');
  assert.equal(response.headers.Vary, 'Origin');
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('30. 非白名单 Origin 不返回 CORS 允许头', async () => {
  const fixture = createFixture([await securityUser()]);
  const response = await login(fixture.handler, 'security01', TEST_PASSWORD, { Origin: 'https://untrusted.example' });

  assert.equal(response.headers['Access-Control-Allow-Origin'], undefined);
});

test('31. 白名单 OPTIONS 预检正确处理且不访问认证服务', async () => {
  const fixture = createFixture([await securityUser()]);
  const response = await request(fixture.handler, {
    method: 'OPTIONS', path: '/login', headers: { Origin: 'https://security.example.edu' },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://security.example.edu');
  assert.equal(response.headers['Access-Control-Allow-Headers'], 'Authorization, Content-Type');
  assert.equal(response.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(fixture.state.identityKeys.length, 0);
});

test('32. 非白名单 OPTIONS 不返回允许头', async () => {
  const fixture = createFixture([await securityUser()]);
  const response = await request(fixture.handler, {
    method: 'OPTIONS', path: '/login', headers: { Origin: 'https://untrusted.example' },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['Access-Control-Allow-Origin'], undefined);
});

test('33. 未知 loginName 不伪造 audit actor', async () => {
  const fixture = createFixture([]);
  await login(fixture.handler, 'unknown-account');

  assert.deepEqual(fixture.state.audits, []);
  assert.deepEqual(Object.keys(fixture.logs[0]).sort(), ['code', 'requestId', 'resourceId', 'stage']);
  assert.equal(fixture.logs[0].resourceId, null);
});

test('34. 已匹配账号错误密码写最小 failure audit', async () => {
  const fixture = createFixture([await securityUser()]);
  await login(fixture.handler, 'security01', WRONG_PASSWORD);

  assert.deepEqual(fixture.state.audits, [{
    _id: 'audit_security_test',
    actorId: 'usr_security_001',
    actorRole: 'security',
    actorCollegeId: null,
    action: 'security.login',
    resourceType: 'user',
    resourceId: 'usr_security_001',
    result: 'failure',
    failureReason: 'AUTH_FAILED',
    requestId: 'req_security_test',
    createdAt: { $serverDate: true },
  }]);
});

test('35. 已匹配失败登录的 audit 写入失败时返回 INTERNAL_ERROR', async () => {
  const fixture = createFixture([await securityUser()], { auditFailure: true });
  const response = await login(fixture.handler, 'security01', WRONG_PASSWORD);

  assert.equal(response.statusCode, 500);
  assert.equal(response.json.code, 'INTERNAL_ERROR');
});

test('36. audit 和 logger 不包含 token、secret 或 request headers', async () => {
  const fixture = createFixture([await securityUser()], { auditFailure: true });
  const privateHeader = crypto.randomBytes(16).toString('base64url');
  const response = await login(fixture.handler, 'security01', TEST_PASSWORD, { Authorization: privateHeader });
  const captured = JSON.stringify({ audits: fixture.state.audits, logs: fixture.logs, response: response.json });

  assert.equal(response.json.code, 'INTERNAL_ERROR');
  assert.equal(captured.includes(fixture.sessionSecret), false);
  assert.equal(captured.includes(privateHeader), false);
  assert.equal(captured.includes(TEST_PASSWORD), false);
  assert.equal(Object.hasOwn(response.json, 'token'), false);
});

test('37. 默认依赖通过固定环境和 CLOUDBASE_APIKEY 初始化服务端 SDK', async () => {
  const calls = [];
  const generatedApiKey = crypto.randomBytes(32).toString('base64url');
  const db = {
    serverDate: () => ({ $serverDate: true }),
    collection: () => ({
      where: () => ({ limit: () => ({ get: async () => ({ data: [] }) }) }),
      doc: () => ({ get: async () => ({ data: null }) }),
      add: async () => ({ id: 'audit' }),
    }),
  };
  const dependencies = createDefaultDependencies({
    cloudbase: {
      init: (configuration) => {
        calls.push(configuration);
        return { database: () => db };
      },
    },
    bcrypt: { compare: async () => false },
    environment: {
      CLOUDBASE_APIKEY: generatedApiKey,
      SECURITY_SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
    },
  });

  assert.equal(dependencies.configured, true);
  assert.deepEqual(calls, [{ env: TARGET_ENV_ID, accessKey: generatedApiKey }]);
  assert.equal(typeof dependencies.userRepository.findByIdentityKey, 'function');
});

test('38. 缺少服务端 session secret 时 fail closed', async () => {
  const fixture = createFixture([await securityUser()], { sessionSecret: '' });
  const response = await login(fixture.handler);

  assert.equal(response.statusCode, 500);
  assert.equal(response.json.code, 'INTERNAL_ERROR');
  assert.equal(fixture.state.identityKeys.length, 0);
});

test('39. wxIdentityKey 不参与 Web 登录凭据判断', async () => {
  const fixture = createFixture([await securityUser({ wxIdentityKey: 'unbound:unrelated-user' })]);
  const response = await login(fixture.handler);

  assert.equal(response.json.code, 'AUTHENTICATED');
  assert.deepEqual(fixture.state.identityKeys, ['security:security01']);
});

test('40. token 有效但用户后来绑定微信时拒绝会话', async () => {
  const { fixture, token } = await authenticatedFixture();
  fixture.state.users[0].wxOpenId = 'changed-after-login';
  const response = await request(fixture.handler, {
    method: 'GET', path: '/session', headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.json.code, 'FORBIDDEN');
});

test('41. token 有效但 bindStatus 改变时拒绝会话', async () => {
  const { fixture, token } = await authenticatedFixture();
  fixture.state.users[0].bindStatus = 'bound';
  const response = await request(fixture.handler, {
    method: 'GET', path: '/session', headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.json.code, 'FORBIDDEN');
});

test('42. localhost:5173 默认属于 CORS 白名单', async () => {
  const fixture = createFixture([await securityUser()], { allowedOrigins: '' });
  const response = await login(fixture.handler, 'security01', TEST_PASSWORD, { Origin: 'http://localhost:5173' });

  assert.equal(response.headers['Access-Control-Allow-Origin'], 'http://localhost:5173');
});

test('43. 缺少 CLOUDBASE_APIKEY 时默认依赖 fail closed 且不初始化 SDK', async () => {
  let initialized = false;
  const dependencies = createDefaultDependencies({
    cloudbase: {
      init: () => {
        initialized = true;
        return null;
      },
    },
    bcrypt: { compare: async () => false },
    environment: { SECURITY_SESSION_SECRET: crypto.randomBytes(48).toString('base64url') },
  });

  assert.equal(dependencies.configured, false);
  assert.equal(initialized, false);
});

test('44. 未知路由的 OPTIONS 不被当作有效预检', async () => {
  const fixture = createFixture([await securityUser()]);
  const response = await request(fixture.handler, {
    method: 'OPTIONS', path: '/other', headers: { Origin: 'https://security.example.edu' },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json.code, 'NOT_FOUND');
  assert.equal(response.headers['Access-Control-Allow-Methods'], undefined);
});
