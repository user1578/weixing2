'use strict';

const crypto = require('crypto');
const http = require('http');

const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const SESSION_TTL_SECONDS = 2 * 60 * 60;
const LOCAL_DEVELOPMENT_ORIGIN = 'http://localhost:5173';
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const LOGIN_INPUT_KEYS = new Set(['loginName', 'password']);
const TOKEN_CLAIM_KEYS = ['exp', 'iat', 'jti', 'role', 'sub'];
const ALERT_CREATE_INPUT_KEYS = new Set(['studentNo', 'fraudType', 'content', 'sourceReference']);
const ALERT_CREATE_REQUIRED_INPUT_KEYS = new Set(['studentNo', 'fraudType', 'content']);
const ALERT_DISPATCH_INPUT_KEYS = new Set(['version']);
const REPORT_START_PROCESS_INPUT_KEYS = new Set(['version', 'actionContent']);
const ALLOWED_FRAUD_TYPES = new Set([
  'part_time_scam',
  'impersonate_public',
  'fake_loan',
  'fake_refund',
  'other',
]);
const ACTIVE_ALERT_STATUSES = ['sent', 'viewed', 'following_up'];
const MAX_STUDENT_NO_LENGTH = 64;
const MAX_ALERT_CONTENT_LENGTH = 1000;
const MAX_SOURCE_REFERENCE_LENGTH = 128;
const MAX_ACTION_CONTENT_LENGTH = 1000;

const ERROR_MESSAGES = {
  INVALID_INPUT: '请求内容无效',
  AUTH_FAILED: '登录凭据无效',
  TOKEN_MISSING: '缺少会话凭据',
  TOKEN_INVALID: '会话凭据无效',
  TOKEN_EXPIRED: '会话已过期',
  ACCOUNT_DISABLED: '账号当前不可用',
  FORBIDDEN: '当前账号无权访问',
  CONFLICT: '资源状态已变化，请刷新后重试',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试',
  NOT_FOUND: '接口不存在',
};

function success(code, payload = {}) {
  return { ok: true, code, ...payload };
}

function failure(code) {
  return { ok: false, code, message: ERROR_MESSAGES[code] || ERROR_MESSAGES.INTERNAL_ERROR };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeLoginName(loginName) {
  return typeof loginName === 'string' ? loginName.trim() : null;
}

function parseLoginBody(body) {
  let parsed = body;
  if (typeof body === 'string') {
    if (!body.trim()) {
      return null;
    }
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      return null;
    }
  }

  if (!isPlainObject(parsed)) {
    return null;
  }
  const keys = Object.keys(parsed);
  if (keys.length !== LOGIN_INPUT_KEYS.size || keys.some((key) => !LOGIN_INPUT_KEYS.has(key))) {
    return null;
  }

  const loginName = normalizeLoginName(parsed.loginName);
  if (!loginName || typeof parsed.password !== 'string' || !parsed.password || Buffer.byteLength(parsed.password, 'utf8') > 72) {
    return null;
  }
  return { loginName, password: parsed.password };
}

function parseJsonObjectBody(body) {
  let parsed = body;
  if (typeof body === 'string') {
    if (!body.trim()) {
      return null;
    }
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      return null;
    }
  }
  return isPlainObject(parsed) ? parsed : null;
}

function hasOnlyAllowedKeys(value, allowedKeys, requiredKeys = new Set()) {
  const keys = Object.keys(value);
  return keys.every((key) => allowedKeys.has(key)) &&
    [...requiredKeys].every((key) => Object.hasOwn(value, key));
}

function normalizeRequiredString(value, maximumLength) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function parseAlertCreateBody(body) {
  const parsed = parseJsonObjectBody(body);
  if (!parsed || !hasOnlyAllowedKeys(parsed, ALERT_CREATE_INPUT_KEYS, ALERT_CREATE_REQUIRED_INPUT_KEYS)) {
    return null;
  }

  const studentNo = normalizeRequiredString(parsed.studentNo, MAX_STUDENT_NO_LENGTH);
  const content = normalizeRequiredString(parsed.content, MAX_ALERT_CONTENT_LENGTH);
  if (!studentNo || !content || typeof parsed.fraudType !== 'string' || !ALLOWED_FRAUD_TYPES.has(parsed.fraudType)) {
    return null;
  }

  let sourceReference;
  if (Object.hasOwn(parsed, 'sourceReference') && parsed.sourceReference !== null) {
    if (typeof parsed.sourceReference !== 'string') {
      return null;
    }
    sourceReference = parsed.sourceReference.trim();
    if (sourceReference.length > MAX_SOURCE_REFERENCE_LENGTH) {
      return null;
    }
    if (!sourceReference) {
      sourceReference = undefined;
    }
  }

  return { studentNo, fraudType: parsed.fraudType, content, sourceReference };
}

function parseAlertDispatchBody(body) {
  const parsed = parseJsonObjectBody(body);
  if (!parsed || !hasOnlyAllowedKeys(parsed, ALERT_DISPATCH_INPUT_KEYS, ALERT_DISPATCH_INPUT_KEYS) ||
    !Number.isSafeInteger(parsed.version) || parsed.version <= 0) {
    return null;
  }
  return { version: parsed.version };
}

function parseReportStartProcessBody(body) {
  const parsed = parseJsonObjectBody(body);
  if (!parsed || !hasOnlyAllowedKeys(parsed, REPORT_START_PROCESS_INPUT_KEYS, REPORT_START_PROCESS_INPUT_KEYS) ||
    !Number.isSafeInteger(parsed.version) || parsed.version <= 0) {
    return null;
  }
  const actionContent = normalizeRequiredString(parsed.actionContent, MAX_ACTION_CONTENT_LENGTH);
  return actionContent ? { version: parsed.version, actionContent } : null;
}

function businessError(code) {
  const error = new Error(code);
  error.isBusinessError = true;
  error.businessCode = code;
  return error;
}

function isTransactionConflict(error) {
  const value = `${error && error.code ? error.code : ''} ${error && error.errCode ? error.errCode : ''} ${error && error.message ? error.message : ''}`.toLowerCase();
  return value.includes('transaction_conflict') ||
    value.includes('transaction conflict') ||
    value.includes('write conflict') ||
    value.includes('database_transaction_conflict');
}

function updatedCount(result) {
  if (result && typeof result.updated === 'number') {
    return result.updated;
  }
  if (result && result.stats && typeof result.stats.updated === 'number') {
    return result.stats.updated;
  }
  return 0;
}

function ensureDatabaseResult(result) {
  if (!result || result.code) {
    throw new Error('Database operation failed');
  }
  return result;
}

function ensureSuccessfulInsert(result) {
  ensureDatabaseResult(result);
  if ((typeof result.inserted === 'number' && result.inserted !== 1) ||
    (typeof result.ok === 'number' && result.ok !== 1)) {
    throw new Error('Database insert did not affect one document');
  }
  return result;
}

function firstRecord(result) {
  ensureDatabaseResult(result);
  if (!Object.hasOwn(result, 'data')) {
    return null;
  }
  if (Array.isArray(result.data)) {
    return result.data[0] || null;
  }
  return result.data || null;
}

function safeLog(logger, entry) {
  try {
    if (logger && typeof logger.error === 'function') {
      logger.error(entry);
    }
  } catch (error) {
    // Logging failures must not change authentication responses.
  }
}

function createLoginAudit({ user, result, failureReason, requestId, serverDate, createAuditId }) {
  const audit = {
    _id: createAuditId(),
    actorId: user._id,
    actorRole: 'security',
    actorCollegeId: null,
    action: 'security.login',
    resourceType: 'user',
    resourceId: user._id,
    result,
    requestId,
    createdAt: serverDate(),
  };
  if (failureReason) {
    audit.failureReason = failureReason;
  }
  return audit;
}

function isConfiguredSecret(secret) {
  return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 32;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid base64url value');
  }
  return Buffer.from(value, 'base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function hasExpectedClaimKeys(claims) {
  return isPlainObject(claims) && Object.keys(claims).sort().join(',') === TOKEN_CLAIM_KEYS.join(',');
}

function mintSessionToken({ userId, secret, issuedAt, createJti }) {
  const claims = {
    sub: userId,
    role: 'security',
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
    jti: createJti(),
  };
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `v1.${payload}`;
  return {
    token: `${signingInput}.${sign(signingInput, secret)}`,
    claims,
  };
}

function verifySessionToken(token, secret, nowSeconds) {
  if (!isConfiguredSecret(secret) || typeof token !== 'string') {
    return { ok: false, code: 'TOKEN_INVALID' };
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    return { ok: false, code: 'TOKEN_INVALID' };
  }

  let receivedSignature;
  try {
    receivedSignature = base64UrlDecode(parts[2]);
  } catch (error) {
    return { ok: false, code: 'TOKEN_INVALID' };
  }
  const expectedSignature = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret), 'base64url');
  if (receivedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(receivedSignature, expectedSignature)) {
    return { ok: false, code: 'TOKEN_INVALID' };
  }

  let claims;
  try {
    claims = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  } catch (error) {
    return { ok: false, code: 'TOKEN_INVALID' };
  }
  if (!hasExpectedClaimKeys(claims) ||
    typeof claims.sub !== 'string' || !claims.sub ||
    claims.role !== 'security' ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    !Number.isSafeInteger(nowSeconds) ||
    claims.exp !== claims.iat + SESSION_TTL_SECONDS ||
    typeof claims.jti !== 'string' || !claims.jti) {
    return { ok: false, code: 'TOKEN_INVALID' };
  }
  if (claims.exp <= nowSeconds) {
    return { ok: false, code: 'TOKEN_EXPIRED' };
  }
  return { ok: true, claims };
}

function isWebSecurityRecord(user) {
  return Boolean(user) &&
    user.role === 'security' &&
    user.wxOpenId === null &&
    user.bindStatus === 'not_applicable' &&
    typeof user.passwordHash === 'string' &&
    user.passwordHash.length > 0;
}

function hasActiveSecuritySessionAccess(user) {
  return Boolean(user) &&
    user.role === 'security' &&
    user.status === 'active' &&
    user.wxOpenId === null &&
    user.bindStatus === 'not_applicable';
}

function toProfile(user) {
  return { userId: user._id, role: 'security', name: user.name };
}

function createAuthService({
  userRepository,
  auditRepository,
  bcrypt,
  sessionSecret,
  serverDate,
  nowSeconds = () => Math.floor(Date.now() / 1000),
  createRequestId = () => crypto.randomUUID(),
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
  createJti = () => crypto.randomUUID(),
  logger = console,
  configured = true,
}) {
  const dependenciesReady = configured &&
    userRepository && typeof userRepository.findByIdentityKey === 'function' && typeof userRepository.findById === 'function' &&
    auditRepository && typeof auditRepository.appendAudit === 'function' &&
    bcrypt && typeof bcrypt.compare === 'function' &&
    typeof serverDate === 'function' &&
    isConfiguredSecret(sessionSecret);

  function internalFailure(requestId, stage, resourceId = null) {
    safeLog(logger, { requestId, code: 'INTERNAL_ERROR', resourceId, stage });
    return failure('INTERNAL_ERROR');
  }

  async function appendMatchedLoginAudit(user, result, failureReason, requestId) {
    const audit = createLoginAudit({ user, result, failureReason, requestId, serverDate, createAuditId });
    await auditRepository.appendAudit(audit);
  }

  async function login(body) {
    const requestId = createRequestId();
    const input = parseLoginBody(body);
    if (!input) {
      return failure('INVALID_INPUT');
    }
    if (!dependenciesReady) {
      return internalFailure(requestId, 'securityLoginConfiguration');
    }

    let user;
    try {
      user = await userRepository.findByIdentityKey(`security:${input.loginName}`);
    } catch (error) {
      return internalFailure(requestId, 'securityLoginLookup');
    }
    if (!user) {
      safeLog(logger, { requestId, code: 'AUTH_FAILED', resourceId: null, stage: 'securityLoginUnknownAccount' });
      return failure('AUTH_FAILED');
    }
    if (!isWebSecurityRecord(user)) {
      safeLog(logger, { requestId, code: 'AUTH_FAILED', resourceId: user._id || null, stage: 'securityLoginRejectedAccount' });
      return failure('AUTH_FAILED');
    }

    let passwordMatches;
    try {
      passwordMatches = await bcrypt.compare(input.password, user.passwordHash);
    } catch (error) {
      return internalFailure(requestId, 'securityLoginPasswordCheck', user._id);
    }
    if (!passwordMatches) {
      try {
        await appendMatchedLoginAudit(user, 'failure', 'AUTH_FAILED', requestId);
        return failure('AUTH_FAILED');
      } catch (error) {
        return internalFailure(requestId, 'securityLoginFailureAudit', user._id);
      }
    }
    if (user.status !== 'active') {
      try {
        await appendMatchedLoginAudit(user, 'failure', 'ACCOUNT_DISABLED', requestId);
        return failure('ACCOUNT_DISABLED');
      } catch (error) {
        return internalFailure(requestId, 'securityLoginFailureAudit', user._id);
      }
    }

    let session;
    try {
      const issuedAt = nowSeconds();
      session = mintSessionToken({ userId: user._id, secret: sessionSecret, issuedAt, createJti });
    } catch (error) {
      return internalFailure(requestId, 'securityLoginTokenMint', user._id);
    }
    try {
      await appendMatchedLoginAudit(user, 'success', null, requestId);
    } catch (error) {
      return internalFailure(requestId, 'securityLoginSuccessAudit', user._id);
    }

    return success('AUTHENTICATED', {
      token: session.token,
      expiresAt: new Date(session.claims.exp * 1000).toISOString(),
      profile: toProfile(user),
    });
  }

  async function authenticateSecuritySession(authorization) {
    const requestId = createRequestId();
    if (typeof authorization !== 'string' || !authorization) {
      return { ok: false, result: failure('TOKEN_MISSING') };
    }
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
    if (!match) {
      return { ok: false, result: failure('TOKEN_INVALID') };
    }
    if (!dependenciesReady) {
      return { ok: false, result: internalFailure(requestId, 'securitySessionConfiguration') };
    }

    const verified = verifySessionToken(match[1], sessionSecret, nowSeconds());
    if (!verified.ok) {
      return { ok: false, result: failure(verified.code) };
    }
    let user;
    try {
      user = await userRepository.findById(verified.claims.sub);
    } catch (error) {
      return { ok: false, result: internalFailure(requestId, 'securitySessionLookup', verified.claims.sub) };
    }
    if (!user) {
      return { ok: false, result: failure('TOKEN_INVALID') };
    }
    if (user.role !== 'security') {
      return { ok: false, result: failure('FORBIDDEN') };
    }
    if (user.status !== 'active') {
      return { ok: false, result: failure('ACCOUNT_DISABLED') };
    }
    if (!hasActiveSecuritySessionAccess(user)) {
      return { ok: false, result: failure('FORBIDDEN') };
    }
    return { ok: true, user, requestId };
  }

  async function session(authorization) {
    const authenticated = await authenticateSecuritySession(authorization);
    if (!authenticated.ok) {
      return authenticated.result;
    }
    return success('SESSION_VALID', { profile: toProfile(authenticated.user) });
  }

  return { login, session, authenticateSecuritySession };
}

function isActiveStudentTarget(user) {
  return Boolean(user) &&
    user.role === 'student' &&
    user.status === 'active' &&
    typeof user.collegeId === 'string' &&
    Boolean(user.collegeId.trim());
}

function isEnabledDefaultRiskRule(rule) {
  return Boolean(rule) &&
    rule._id === 'rule_default' &&
    rule.status === 'enabled' &&
    Number.isSafeInteger(rule.version) && rule.version > 0 &&
    Number.isSafeInteger(rule.repeatAlertWindowDays) && rule.repeatAlertWindowDays > 0 &&
    Number.isSafeInteger(rule.highAlertRepeatCount) && rule.highAlertRepeatCount > 0 &&
    Number.isSafeInteger(rule.midAlertRepeatCount) && rule.midAlertRepeatCount > 0 &&
    Array.isArray(rule.keyFraudTypes);
}

function hasSameVersion(current, preRead) {
  return Boolean(current) && Boolean(preRead) &&
    Number.isSafeInteger(current.version) &&
    current.version === preRead.version;
}

function calculateManualAlertRisk({ fraudType, focusFlag, activeAlertCount, rule }) {
  const keyFraudType = rule.keyFraudTypes.includes(fraudType);
  const isFocused = focusFlag === true;
  const reachesHighRepeat = activeAlertCount >= rule.highAlertRepeatCount;
  const reachesMidRepeat = activeAlertCount >= rule.midAlertRepeatCount;
  const highBecauseFocusAndRepeat = isFocused && reachesMidRepeat;
  const riskReasons = [];

  if (keyFraudType) {
    riskReasons.push('key_fraud_type');
  }
  if (isFocused) {
    riskReasons.push('focus_flag');
  }
  if (reachesHighRepeat) {
    riskReasons.push(`repeat_alert_count>=${rule.highAlertRepeatCount}`);
  } else if (reachesMidRepeat) {
    riskReasons.push(`repeat_alert_count>=${rule.midAlertRepeatCount}`);
  }

  if (reachesHighRepeat || highBecauseFocusAndRepeat) {
    return { riskLevel: 'high', riskReasons };
  }
  if (keyFraudType || reachesMidRepeat || isFocused) {
    return { riskLevel: 'medium', riskReasons };
  }
  return { riskLevel: 'low', riskReasons };
}

async function findRecordById(dbOrTransaction, collectionName, id) {
  return firstRecord(await dbOrTransaction.collection(collectionName).doc(id).get());
}

async function findRecordByQuery(db, collectionName, query) {
  return firstRecord(await db.collection(collectionName).where(query).limit(1).get());
}

function createAlertCreateAudit({ alertId, actorId, riskLevel, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId,
    actorRole: 'security',
    actorCollegeId: null,
    action: 'alert.create',
    resourceType: 'alert',
    resourceId: alertId,
    result: 'success',
    afterSummary: { status: 'pending_dispatch', riskLevel },
    requestId,
    createdAt: serverDate(),
  };
}

function createAlertDispatchAudit({ alertId, actorId, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId,
    actorRole: 'security',
    actorCollegeId: null,
    action: 'alert.dispatch',
    resourceType: 'alert',
    resourceId: alertId,
    result: 'success',
    beforeSummary: { status: 'pending_dispatch' },
    afterSummary: { status: 'sent' },
    requestId,
    createdAt: serverDate(),
  };
}

function createReportStartProcessAudit({ reportId, actorId, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId,
    actorRole: 'security',
    actorCollegeId: null,
    action: 'report.start_process',
    resourceType: 'fraud_report',
    resourceId: reportId,
    result: 'success',
    beforeSummary: { status: 'pending_security_verify' },
    afterSummary: { status: 'in_process' },
    requestId,
    createdAt: serverDate(),
  };
}

function createSecurityAlertService({
  authService,
  db,
  serverDate,
  createAlertId = () => `alert_${crypto.randomUUID().replace(/-/g, '')}`,
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
  createRequestId = () => crypto.randomUUID(),
  now = () => new Date(),
  logger = console,
  configured = true,
} = {}) {
  const dependenciesReady = configured &&
    authService && typeof authService.authenticateSecuritySession === 'function' &&
    db && typeof db.runTransaction === 'function' && typeof db.collection === 'function' &&
    db.command && typeof db.command.in === 'function' && typeof db.command.gte === 'function' &&
    typeof serverDate === 'function';

  function internalFailure(requestId, stage, resourceId = null) {
    safeLog(logger, { requestId, code: 'INTERNAL_ERROR', resourceId, stage });
    return failure('INTERNAL_ERROR');
  }

  async function authenticate(authorization, requestId, stage) {
    try {
      return await authService.authenticateSecuritySession(authorization);
    } catch (error) {
      return { ok: false, result: internalFailure(requestId, stage) };
    }
  }

  async function create(authorization, body) {
    const requestId = createRequestId();
    const input = parseAlertCreateBody(body);
    if (!input) {
      return failure('INVALID_INPUT');
    }
    if (!dependenciesReady) {
      return internalFailure(requestId, 'securityAlertCreateConfiguration');
    }

    const authenticated = await authenticate(authorization, requestId, 'securityAlertCreateAuthentication');
    if (!authenticated.ok) {
      return authenticated.result;
    }

    let requestNow;
    try {
      requestNow = now();
      if (!(requestNow instanceof Date) || Number.isNaN(requestNow.getTime())) {
        throw new Error('Invalid server clock');
      }
    } catch (error) {
      return internalFailure(requestId, 'securityAlertCreateClock');
    }

    const targetIdentityKey = `student:${input.studentNo}`;
    let preReadTargetStudent;
    let preReadRule;
    let activeAlertCount;
    try {
      preReadTargetStudent = await findRecordByQuery(db, 'users', { identityKey: targetIdentityKey });
      if (!isActiveStudentTarget(preReadTargetStudent)) {
        return failure('NOT_FOUND');
      }

      preReadRule = await findRecordById(db, 'risk_rules', 'rule_default');
      if (!isEnabledDefaultRiskRule(preReadRule)) {
        return internalFailure(requestId, 'securityAlertCreateRulePreRead');
      }
      const windowStart = new Date(requestNow.getTime() - (preReadRule.repeatAlertWindowDays * 24 * 60 * 60 * 1000));
      const countResult = ensureDatabaseResult(await db.collection('alerts').where({
        studentId: preReadTargetStudent._id,
        status: db.command.in(ACTIVE_ALERT_STATUSES),
        issuedAt: db.command.gte(windowStart),
      }).count());
      if (!Number.isSafeInteger(countResult.total) || countResult.total < 0) {
        return internalFailure(requestId, 'securityAlertCreateActiveAlertCount');
      }
      activeAlertCount = countResult.total + 1;
    } catch (error) {
      return internalFailure(requestId, 'securityAlertCreatePreRead');
    }

    const alertId = createAlertId();
    const auditId = createAuditId();
    try {
      const alert = await db.runTransaction(async (transaction) => {
        const targetStudent = await findRecordById(transaction, 'users', preReadTargetStudent._id);
        if (!isActiveStudentTarget(targetStudent) ||
          targetStudent._id !== preReadTargetStudent._id ||
          targetStudent.identityKey !== targetIdentityKey ||
          !hasSameVersion(targetStudent, preReadTargetStudent)) {
          throw businessError('CONFLICT');
        }

        const rule = await findRecordById(transaction, 'risk_rules', 'rule_default');
        if (!isEnabledDefaultRiskRule(rule)) {
          throw businessError('INTERNAL_ERROR');
        }
        if (!hasSameVersion(rule, preReadRule)) {
          throw businessError('CONFLICT');
        }

        const risk = calculateManualAlertRisk({
          fraudType: input.fraudType,
          focusFlag: targetStudent.focusFlag,
          activeAlertCount,
          rule,
        });
        const createdAlert = {
          _id: alertId,
          sourceType: 'manual',
          studentId: targetStudent._id,
          collegeId: targetStudent.collegeId,
          fraudType: input.fraudType,
          content: input.content,
          riskLevel: risk.riskLevel,
          riskReasons: risk.riskReasons,
          riskRuleId: 'rule_default',
          status: 'pending_dispatch',
          version: 1,
          createdAt: serverDate(),
          updatedAt: serverDate(),
        };
        if (input.sourceReference) {
          createdAlert.sourceReference = input.sourceReference;
        }

        ensureSuccessfulInsert(await transaction.collection('alerts').add(createdAlert));
        ensureSuccessfulInsert(await transaction.collection('audit_logs').add(createAlertCreateAudit({
          alertId,
          actorId: authenticated.user._id,
          riskLevel: risk.riskLevel,
          requestId,
          serverDate,
          createAuditId: () => auditId,
        })));
        return {
          alertId,
          fraudType: createdAlert.fraudType,
          riskLevel: createdAlert.riskLevel,
          riskReasons: createdAlert.riskReasons,
          status: createdAlert.status,
          version: createdAlert.version,
        };
      });
      return success('ALERT_CREATED', { alert });
    } catch (error) {
      if (error && error.isBusinessError) {
        return failure(error.businessCode);
      }
      if (isTransactionConflict(error)) {
        return failure('CONFLICT');
      }
      return internalFailure(requestId, 'securityAlertCreateTransaction', alertId);
    }
  }

  async function dispatch(authorization, alertId, body) {
    const requestId = createRequestId();
    const input = parseAlertDispatchBody(body);
    if (!input) {
      return failure('INVALID_INPUT');
    }
    if (!dependenciesReady) {
      return internalFailure(requestId, 'securityAlertDispatchConfiguration', alertId || null);
    }

    const authenticated = await authenticate(authorization, requestId, 'securityAlertDispatchAuthentication');
    if (!authenticated.ok) {
      return authenticated.result;
    }

    const auditId = createAuditId();
    try {
      const alert = await db.runTransaction(async (transaction) => {
        const currentAlert = await findRecordById(transaction, 'alerts', alertId);
        if (!currentAlert) {
          throw businessError('NOT_FOUND');
        }
        if (currentAlert.status !== 'pending_dispatch' || currentAlert.version !== input.version) {
          throw businessError('CONFLICT');
        }
        if (typeof currentAlert.studentId !== 'string' || !currentAlert.studentId) {
          throw businessError('CONFLICT');
        }

        const targetStudent = await findRecordById(transaction, 'users', currentAlert.studentId);
        if (!isActiveStudentTarget(targetStudent) || targetStudent.collegeId !== currentAlert.collegeId) {
          throw businessError('CONFLICT');
        }

        const updateResult = ensureDatabaseResult(await transaction.collection('alerts').doc(currentAlert._id).update({
          status: 'sent',
          issuedBy: authenticated.user._id,
          issuedAt: serverDate(),
          updatedAt: serverDate(),
          version: input.version + 1,
        }));
        if (updatedCount(updateResult) !== 1) {
          throw businessError('CONFLICT');
        }

        ensureSuccessfulInsert(await transaction.collection('audit_logs').add(createAlertDispatchAudit({
          alertId: currentAlert._id,
          actorId: authenticated.user._id,
          requestId,
          serverDate,
          createAuditId: () => auditId,
        })));
        return {
          alertId: currentAlert._id,
          status: 'sent',
          version: input.version + 1,
        };
      });
      return success('ALERT_DISPATCHED', { alert });
    } catch (error) {
      if (error && error.isBusinessError) {
        return failure(error.businessCode);
      }
      if (isTransactionConflict(error)) {
        return failure('CONFLICT');
      }
      return internalFailure(requestId, 'securityAlertDispatchTransaction', alertId || null);
    }
  }

  return { create, dispatch };
}

function createSecurityReportProcessingService({
  authService,
  db,
  serverDate,
  createDispositionId = () => `disposition_${crypto.randomUUID().replace(/-/g, '')}`,
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
  createRequestId = () => crypto.randomUUID(),
  logger = console,
  configured = true,
} = {}) {
  const dependenciesReady = configured &&
    authService && typeof authService.authenticateSecuritySession === 'function' &&
    db && typeof db.runTransaction === 'function' && typeof db.collection === 'function' &&
    typeof serverDate === 'function';

  function internalFailure(requestId, stage, resourceId = null) {
    safeLog(logger, { requestId, code: 'INTERNAL_ERROR', resourceId, stage });
    return failure('INTERNAL_ERROR');
  }

  async function authenticate(authorization, requestId) {
    try {
      return await authService.authenticateSecuritySession(authorization);
    } catch (error) {
      return { ok: false, result: internalFailure(requestId, 'securityReportStartProcessAuthentication') };
    }
  }

  async function startProcess(authorization, reportId, body) {
    const requestId = createRequestId();
    const input = parseReportStartProcessBody(body);
    if (!input) {
      return failure('INVALID_INPUT');
    }
    if (!dependenciesReady) {
      return internalFailure(requestId, 'securityReportStartProcessConfiguration', reportId || null);
    }

    const authenticated = await authenticate(authorization, requestId);
    if (!authenticated.ok) {
      return authenticated.result;
    }

    const dispositionId = createDispositionId();
    const auditId = createAuditId();
    try {
      const report = await db.runTransaction(async (transaction) => {
        const currentReport = await findRecordById(transaction, 'fraud_reports', reportId);
        if (!currentReport) {
          throw businessError('NOT_FOUND');
        }
        if (currentReport.status !== 'pending_security_verify' || currentReport.version !== input.version) {
          throw businessError('CONFLICT');
        }

        const updateResult = ensureDatabaseResult(await transaction.collection('fraud_reports').doc(currentReport._id).update({
          status: 'in_process',
          currentHandlerId: authenticated.user._id,
          updatedAt: serverDate(),
          version: input.version + 1,
        }));
        if (updatedCount(updateResult) !== 1) {
          throw businessError('CONFLICT');
        }

        ensureSuccessfulInsert(await transaction.collection('security_dispositions').add({
          _id: dispositionId,
          reportId: currentReport._id,
          operatorId: authenticated.user._id,
          action: 'start_process',
          statusAfter: 'in_process',
          actionContent: input.actionContent,
          createdAt: serverDate(),
        }));
        ensureSuccessfulInsert(await transaction.collection('audit_logs').add(createReportStartProcessAudit({
          reportId: currentReport._id,
          actorId: authenticated.user._id,
          requestId,
          serverDate,
          createAuditId: () => auditId,
        })));
        return {
          reportId: currentReport._id,
          status: 'in_process',
          version: input.version + 1,
        };
      });
      return success('REPORT_PROCESSING_STARTED', { report });
    } catch (error) {
      if (error && error.isBusinessError) {
        return failure(error.businessCode);
      }
      if (isTransactionConflict(error)) {
        return failure('CONFLICT');
      }
      return internalFailure(requestId, 'securityReportStartProcessTransaction', reportId || null);
    }
  }

  return { startProcess };
}

function readHeader(headers, name) {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  const foundKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  const value = foundKey ? headers[foundKey] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

function normalizePath(path) {
  if (typeof path !== 'string' || !path) {
    return '/';
  }
  const withoutQuery = path.split('?')[0];
  const normalized = withoutQuery.replace(/\/+$/, '');
  return normalized || '/';
}

function getHttpMethod(event) {
  return String((event && (event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method))) || '').toUpperCase();
}

function getHttpPath(event) {
  return normalizePath(event && (event.path || event.rawPath || (event.requestContext && event.requestContext.http && event.requestContext.http.path)));
}

function parseAllowedOrigins(value) {
  const origins = new Set([LOCAL_DEVELOPMENT_ORIGIN]);
  if (typeof value === 'string') {
    value.split(',').map((origin) => origin.trim()).filter(Boolean).forEach((origin) => origins.add(origin));
  }
  return origins;
}

function buildResponseHeaders(origin, allowedOrigins, preflight = false, allowedMethods = 'GET, POST, OPTIONS') {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (typeof origin === 'string' && allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
    if (preflight) {
      headers['Access-Control-Allow-Methods'] = allowedMethods;
      headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
      headers['Access-Control-Max-Age'] = '600';
    }
  }
  return headers;
}

function httpStatusFor(result) {
  if (result.ok) {
    return 200;
  }
  if (result.code === 'INVALID_INPUT') {
    return 400;
  }
  if (result.code === 'TOKEN_MISSING' || result.code === 'TOKEN_INVALID' || result.code === 'TOKEN_EXPIRED' || result.code === 'AUTH_FAILED') {
    return 401;
  }
  if (result.code === 'ACCOUNT_DISABLED' || result.code === 'FORBIDDEN') {
    return 403;
  }
  if (result.code === 'NOT_FOUND') {
    return 404;
  }
  if (result.code === 'CONFLICT') {
    return 409;
  }
  return 500;
}

function httpResponse(result, headers) {
  return {
    statusCode: httpStatusFor(result),
    headers,
    body: JSON.stringify(result),
  };
}

function getAlertDispatchId(path) {
  const match = /^\/alerts\/([^/]+)\/dispatch$/.exec(path);
  return match ? match[1] : null;
}

function getReportStartProcessId(path) {
  const match = /^\/reports\/([^/]+)\/start-process$/.exec(path);
  return match ? match[1] : null;
}

function createHttpHandler({ authService, alertService = null, reportProcessingService = null, allowedOrigins, logger = console }) {
  if (!authService || typeof authService.login !== 'function' || typeof authService.session !== 'function') {
    throw new Error('securityAuthHttp requires an authentication service');
  }
  const originWhitelist = parseAllowedOrigins(allowedOrigins);
  return async function handleHttpRequest(event) {
    const origin = readHeader(event && event.headers, 'origin');
    const method = getHttpMethod(event);
    const path = getHttpPath(event);
    if (method === 'OPTIONS') {
      const allowedMethods = path === '/login'
        ? 'POST, OPTIONS'
        : path === '/session'
          ? 'GET, OPTIONS'
          : (path === '/alerts' || getAlertDispatchId(path) || getReportStartProcessId(path))
            ? 'POST, OPTIONS'
            : null;
      if (!allowedMethods) {
        return httpResponse(failure('NOT_FOUND'), buildResponseHeaders(origin, originWhitelist));
      }
      return {
        statusCode: 204,
        headers: buildResponseHeaders(origin, originWhitelist, true, allowedMethods),
        body: '',
      };
    }

    try {
      if (method === 'POST' && path === '/login') {
        return httpResponse(await authService.login(event && event.body), buildResponseHeaders(origin, originWhitelist));
      }
      if (method === 'GET' && path === '/session') {
        return httpResponse(await authService.session(readHeader(event && event.headers, 'authorization')), buildResponseHeaders(origin, originWhitelist));
      }
      if (method === 'POST' && path === '/alerts') {
        if (!alertService || typeof alertService.create !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await alertService.create(
          readHeader(event && event.headers, 'authorization'),
          event && event.body,
        ), buildResponseHeaders(origin, originWhitelist));
      }
      const alertId = getAlertDispatchId(path);
      if (method === 'POST' && alertId) {
        if (!alertService || typeof alertService.dispatch !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await alertService.dispatch(
          readHeader(event && event.headers, 'authorization'),
          alertId,
          event && event.body,
        ), buildResponseHeaders(origin, originWhitelist));
      }
      const reportId = getReportStartProcessId(path);
      if (method === 'POST' && reportId) {
        if (!reportProcessingService || typeof reportProcessingService.startProcess !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await reportProcessingService.startProcess(
          readHeader(event && event.headers, 'authorization'),
          reportId,
          event && event.body,
        ), buildResponseHeaders(origin, originWhitelist));
      }
      return httpResponse(failure('NOT_FOUND'), buildResponseHeaders(origin, originWhitelist));
    } catch (error) {
      safeLog(logger, { requestId: crypto.randomUUID(), code: 'INTERNAL_ERROR', resourceId: null, stage: 'securityHttpRequest' });
      return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
    }
  };
}

function createCloudbaseRepositories(db) {
  return {
    userRepository: {
      async findByIdentityKey(identityKey) {
        const result = await db.collection('users').where({ identityKey }).limit(1).get();
        return result && Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
      },
      async findById(userId) {
        const result = await db.collection('users').doc(userId).get();
        if (!result || !result.data) {
          return null;
        }
        return Array.isArray(result.data) ? (result.data[0] || null) : result.data;
      },
    },
    auditRepository: {
      appendAudit(audit) {
        return db.collection('audit_logs').add(audit);
      },
    },
  };
}

function createDefaultDependencies({
  cloudbase = require('@cloudbase/node-sdk'),
  bcrypt = require('bcryptjs'),
  environment = process.env,
  logger = console,
} = {}) {
  const apiKey = environment.CLOUDBASE_APIKEY;
  const sessionSecret = environment.SECURITY_SESSION_SECRET;
  if (typeof apiKey !== 'string' || !apiKey || !isConfiguredSecret(sessionSecret)) {
    return { configured: false, bcrypt, sessionSecret, logger };
  }
  const app = cloudbase.init({ env: TARGET_ENV_ID, accessKey: apiKey });
  const db = app.database();
  const repositories = createCloudbaseRepositories(db);
  return {
    ...repositories,
    db,
    bcrypt,
    sessionSecret,
    serverDate: () => db.serverDate(),
    logger,
    configured: true,
  };
}

function createDefaultHandler(options = {}) {
  const environment = options.environment || process.env;
  const logger = options.logger || console;
  try {
    const dependencies = createDefaultDependencies({ ...options, environment, logger });
    const authService = createAuthService(dependencies);
    const alertService = createSecurityAlertService({
      authService,
      db: dependencies.db,
      serverDate: dependencies.serverDate,
      logger,
      configured: dependencies.configured,
    });
    const reportProcessingService = createSecurityReportProcessingService({
      authService,
      db: dependencies.db,
      serverDate: dependencies.serverDate,
      logger,
      configured: dependencies.configured,
    });
    return createHttpHandler({ authService, alertService, reportProcessingService, allowedOrigins: environment.SECURITY_WEB_ALLOWED_ORIGINS, logger });
  } catch (error) {
    const unavailableService = {
      login: async () => failure('INTERNAL_ERROR'),
      session: async () => failure('INTERNAL_ERROR'),
    };
    return createHttpHandler({ authService: unavailableService, allowedOrigins: environment.SECURITY_WEB_ALLOWED_ORIGINS, logger });
  }
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createNodeServer(handler) {
  return http.createServer(async (request, response) => {
    let result;
    try {
      const requestUrl = new URL(request.url || '/', 'http://localhost');
      const body = request.method === 'POST' ? await readRequestBody(request) : undefined;
      result = await handler({
        httpMethod: request.method,
        path: requestUrl.pathname,
        headers: request.headers,
        body,
      });
    } catch (error) {
      result = {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
        body: JSON.stringify(failure('INVALID_INPUT')),
      };
    }
    response.writeHead(result.statusCode, result.headers);
    response.end(result.body);
  });
}

function startServer() {
  const handler = createDefaultHandler();
  const server = createNodeServer(handler);
  server.listen(9000, '0.0.0.0');
  return server;
}

if (require.main === module) {
  startServer();
}

exports.__testables = {
  TARGET_ENV_ID,
  SESSION_TTL_SECONDS,
  createAuthService,
  createCloudbaseRepositories,
  createDefaultDependencies,
  createDefaultHandler,
  createHttpHandler,
  createSecurityAlertService,
  createSecurityReportProcessingService,
  calculateManualAlertRisk,
  createLoginAudit,
  createReportStartProcessAudit,
  getAlertDispatchId,
  getReportStartProcessId,
  createNodeServer,
  mintSessionToken,
  normalizeLoginName,
  parseAlertCreateBody,
  parseAlertDispatchBody,
  parseReportStartProcessBody,
  parseAllowedOrigins,
  parseLoginBody,
  verifySessionToken,
};
