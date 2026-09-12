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
const REPORT_CLOSE_INPUT_KEYS = new Set([
  'version',
  'verificationResult',
  'finalOutcome',
  'confirmedLossAmount',
  'closeReason',
  'actionContent',
]);
const REPORT_RETURN_INPUT_KEYS = new Set(['version', 'verificationResult', 'returnReason', 'actionContent']);
const IDENTITY_CREATE_INPUT_KEYS = new Set(['role', 'identityNo', 'name', 'collegeId']);
const IDENTITY_UNBIND_INPUT_KEYS = new Set(['version']);
const IDENTITY_STATUS_INPUT_KEYS = new Set(['version', 'status']);
const COLLEGE_CREATE_INPUT_KEYS = new Set(['name']);
const COLLEGE_STATUS_INPUT_KEYS = new Set(['status']);
const MANAGEABLE_IDENTITY_ROLES = new Set(['student', 'counselor']);
const MANAGEABLE_IDENTITY_STATUSES = new Set(['active', 'suspended']);
const COLLEGE_STATUSES = new Set(['active', 'disabled']);
const DASHBOARD_REPORT_STATUSES = new Set(['pending_security_verify', 'in_process']);
const ALLOWED_REPORT_CLOSE_VERIFICATION_RESULTS = new Set([
  'confirmed',
  'suspected',
  'misreport',
  'consultation',
  'not_fraud',
]);
const ALLOWED_REPORT_CLOSE_FINAL_OUTCOMES = new Set([
  'loss_confirmed',
  'loss_no_loss',
  'misreport',
  'consultation',
]);
const REPORT_CLOSE_SOURCE_STATUSES = new Set(['pending_security_verify', 'in_process']);
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
const MAX_CLOSE_REASON_LENGTH = 1000;
const MAX_RETURN_REASON_LENGTH = 1000;
const MAX_RETURN_ACTION_CONTENT_LENGTH = 2000;
const SECURITY_REPORT_QUEUE_LIMIT = 50;
const SECURITY_REPORT_DETAIL_FOLLOWUP_LIMIT = 100;
const SECURITY_REPORT_DETAIL_DISPOSITION_LIMIT = 100;
const MAX_IDENTITY_NO_LENGTH = 64;
const MAX_IDENTITY_NAME_LENGTH = 64;
const MAX_COLLEGE_ID_LENGTH = 64;
const MAX_COLLEGE_NAME_LENGTH = 64;
const DASHBOARD_LIST_READ_LIMIT = 100;
const DASHBOARD_COLLEGE_READ_LIMIT = 500;

const ERROR_MESSAGES = {
  INVALID_INPUT: '请求内容无效',
  AUTH_FAILED: '登录凭据无效',
  TOKEN_MISSING: '缺少会话凭据',
  TOKEN_INVALID: '会话凭据无效',
  TOKEN_EXPIRED: '会话已过期',
  ACCOUNT_DISABLED: '账号当前不可用',
  FORBIDDEN: '当前账号无权访问',
  CONFLICT: '资源状态已变化，请刷新后重试',
  COLLEGE_IN_USE: '学院仍有关联的正常身份',
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

function parseReportCloseBody(body) {
  const parsed = parseJsonObjectBody(body);
  if (!parsed || !hasOnlyAllowedKeys(parsed, REPORT_CLOSE_INPUT_KEYS, REPORT_CLOSE_INPUT_KEYS) ||
    !Number.isSafeInteger(parsed.version) || parsed.version <= 0 ||
    typeof parsed.verificationResult !== 'string' || !ALLOWED_REPORT_CLOSE_VERIFICATION_RESULTS.has(parsed.verificationResult) ||
    typeof parsed.finalOutcome !== 'string' || !ALLOWED_REPORT_CLOSE_FINAL_OUTCOMES.has(parsed.finalOutcome) ||
    typeof parsed.confirmedLossAmount !== 'number' || !Number.isFinite(parsed.confirmedLossAmount) || parsed.confirmedLossAmount < 0) {
    return null;
  }

  if ((parsed.finalOutcome === 'loss_confirmed' && parsed.confirmedLossAmount <= 0) ||
    (parsed.finalOutcome !== 'loss_confirmed' && parsed.confirmedLossAmount !== 0)) {
    return null;
  }

  const closeReason = normalizeRequiredString(parsed.closeReason, MAX_CLOSE_REASON_LENGTH);
  const actionContent = normalizeRequiredString(parsed.actionContent, MAX_ACTION_CONTENT_LENGTH);
  return closeReason && actionContent ? {
    version: parsed.version,
    verificationResult: parsed.verificationResult,
    finalOutcome: parsed.finalOutcome,
    confirmedLossAmount: parsed.confirmedLossAmount,
    closeReason,
    actionContent,
  } : null;
}

function parseReportReturnBody(body) {
  const parsed = parseJsonObjectBody(body);
  if (!parsed || !hasOnlyAllowedKeys(parsed, REPORT_RETURN_INPUT_KEYS, REPORT_RETURN_INPUT_KEYS) ||
    !Number.isSafeInteger(parsed.version) || parsed.version <= 0 ||
    typeof parsed.verificationResult !== 'string' || !ALLOWED_REPORT_CLOSE_VERIFICATION_RESULTS.has(parsed.verificationResult)) {
    return null;
  }
  const returnReason = normalizeRequiredString(parsed.returnReason, MAX_RETURN_REASON_LENGTH);
  const actionContent = normalizeRequiredString(parsed.actionContent, MAX_RETURN_ACTION_CONTENT_LENGTH);
  return returnReason && actionContent ? { version: parsed.version, verificationResult: parsed.verificationResult, returnReason, actionContent } : null;
}

function parseIdentityCreateBody(body) {
  const parsed = parseJsonObjectBody(body);
  if (!parsed || !hasOnlyAllowedKeys(parsed, IDENTITY_CREATE_INPUT_KEYS, IDENTITY_CREATE_INPUT_KEYS) ||
    typeof parsed.role !== 'string' || !MANAGEABLE_IDENTITY_ROLES.has(parsed.role)) {
    return null;
  }
  const identityNo = normalizeRequiredString(parsed.identityNo, MAX_IDENTITY_NO_LENGTH);
  const name = normalizeRequiredString(parsed.name, MAX_IDENTITY_NAME_LENGTH);
  const collegeId = normalizeRequiredString(parsed.collegeId, MAX_COLLEGE_ID_LENGTH);
  return identityNo && name && collegeId ? { role: parsed.role, identityNo, name, collegeId } : null;
}

function parseIdentityUnbindBody(body) {
  const parsed = parseJsonObjectBody(body);
  if (!parsed || !hasOnlyAllowedKeys(parsed, IDENTITY_UNBIND_INPUT_KEYS, IDENTITY_UNBIND_INPUT_KEYS) ||
    !Number.isSafeInteger(parsed.version) || parsed.version <= 0) {
    return null;
  }
  return { version: parsed.version };
}

function parseIdentityStatusBody(body) {
  const parsed = parseJsonObjectBody(body);
  if (!parsed || !hasOnlyAllowedKeys(parsed, IDENTITY_STATUS_INPUT_KEYS, IDENTITY_STATUS_INPUT_KEYS) ||
    !Number.isSafeInteger(parsed.version) || parsed.version <= 0 ||
    typeof parsed.status !== 'string' || !MANAGEABLE_IDENTITY_STATUSES.has(parsed.status)) {
    return null;
  }
  return { version: parsed.version, status: parsed.status };
}

function parseCollegeCreateBody(body) {
  const parsed = parseJsonObjectBody(body);
  if (!parsed || !hasOnlyAllowedKeys(parsed, COLLEGE_CREATE_INPUT_KEYS, COLLEGE_CREATE_INPUT_KEYS)) {
    return null;
  }
  const name = normalizeRequiredString(parsed.name, MAX_COLLEGE_NAME_LENGTH);
  return name ? { name } : null;
}

function parseCollegeStatusBody(body) {
  const parsed = parseJsonObjectBody(body);
  if (!parsed || !hasOnlyAllowedKeys(parsed, COLLEGE_STATUS_INPUT_KEYS, COLLEGE_STATUS_INPUT_KEYS) ||
    typeof parsed.status !== 'string' || !COLLEGE_STATUSES.has(parsed.status)) {
    return null;
  }
  return { status: parsed.status };
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

function isUniqueConstraintConflict(error) {
  const value = `${error && error.code ? error.code : ''} ${error && error.errCode ? error.errCode : ''} ${error && error.message ? error.message : ''}`.toLowerCase();
  return value.includes('duplicate') || value.includes('unique') || value.includes('already exists');
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

function countTotal(result) {
  ensureDatabaseResult(result);
  return Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : null;
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

function createReportCloseAudit({ reportId, actorId, beforeStatus, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId,
    actorRole: 'security',
    actorCollegeId: null,
    action: 'report.close',
    resourceType: 'fraud_report',
    resourceId: reportId,
    result: 'success',
    beforeSummary: { status: beforeStatus },
    afterSummary: { status: 'closed' },
    requestId,
    createdAt: serverDate(),
  };
}

function createIdentityListAudit({ actorId, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId,
    actorRole: 'security',
    actorCollegeId: null,
    action: 'identity.list',
    resourceType: 'user',
    resourceId: actorId,
    result: 'success',
    requestId,
    createdAt: serverDate(),
  };
}

function createIdentityCreateAudit({ userId, actorId, role, collegeId, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId,
    actorRole: 'security',
    actorCollegeId: null,
    action: 'identity.create',
    resourceType: 'user',
    resourceId: userId,
    result: 'success',
    afterSummary: { role, collegeId, status: 'active', bindStatus: 'unbound' },
    requestId,
    createdAt: serverDate(),
  };
}

function createIdentityUnbindAudit({ userId, actorId, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId,
    actorRole: 'security',
    actorCollegeId: null,
    action: 'identity.unbind',
    resourceType: 'user',
    resourceId: userId,
    result: 'success',
    beforeSummary: { bindStatus: 'bound' },
    afterSummary: { bindStatus: 'unbound' },
    requestId,
    createdAt: serverDate(),
  };
}

function createIdentityStatusAudit({ userId, actorId, beforeStatus, afterStatus, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId,
    actorRole: 'security',
    actorCollegeId: null,
    action: 'identity.status_update',
    resourceType: 'user',
    resourceId: userId,
    result: 'success',
    beforeSummary: { status: beforeStatus },
    afterSummary: { status: afterStatus },
    requestId,
    createdAt: serverDate(),
  };
}

function maskIdentityNo(value) {
  if (typeof value !== 'string' || !value) {
    return '';
  }
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= 2) {
    return '*'.repeat(normalized.length);
  }
  if (normalized.length <= 4) {
    return `${normalized[0]}${'*'.repeat(normalized.length - 2)}${normalized.at(-1)}`;
  }
  return `${normalized.slice(0, 2)}${'*'.repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-2)}`;
}

function isManageableIdentity(user) {
  return Boolean(user) && MANAGEABLE_IDENTITY_ROLES.has(user.role);
}

function isActiveCollege(college) {
  return Boolean(college) && college.status === 'active';
}

function collegeIdForName(name) {
  return `college_${crypto.createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16)}`;
}

function toCollegeListItem(college, identityCounts) {
  const counts = identityCounts.get(college._id) || { identityCount: 0, activeIdentityCount: 0 };
  return {
    collegeId: college._id,
    name: college.name,
    status: college.status,
    identityCount: counts.identityCount,
    activeIdentityCount: counts.activeIdentityCount,
  };
}

function toDashboardItem(record, collegeNames, idField) {
  return {
    [idField]: record._id,
    fraudType: record.fraudType,
    riskLevel: record.riskLevel,
    status: record.status,
    collegeName: collegeNames.get(record.collegeId) || '',
    createdAt: record.createdAt,
  };
}

function dateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function shanghaiDayStart(now) {
  const shanghaiOffsetMilliseconds = 8 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + shanghaiOffsetMilliseconds);
  return new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - shanghaiOffsetMilliseconds);
}

function createCollegeCreateAudit({ collegeId, actorId, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId,
    actorRole: 'security',
    actorCollegeId: null,
    action: 'college.create',
    resourceType: 'college',
    resourceId: collegeId,
    result: 'success',
    afterSummary: { status: 'active' },
    requestId,
    createdAt: serverDate(),
  };
}

function createCollegeStatusAudit({ collegeId, actorId, beforeStatus, afterStatus, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId,
    actorRole: 'security',
    actorCollegeId: null,
    action: 'college.status_update',
    resourceType: 'college',
    resourceId: collegeId,
    result: 'success',
    beforeSummary: { status: beforeStatus },
    afterSummary: { status: afterStatus },
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
    if (!dependenciesReady) {
      return internalFailure(requestId, 'securityAlertCreateConfiguration');
    }

    const authenticated = await authenticate(authorization, requestId, 'securityAlertCreateAuthentication');
    if (!authenticated.ok) {
      return authenticated.result;
    }
    const input = parseAlertCreateBody(body);
    if (!input) {
      return failure('INVALID_INPUT');
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
    if (!dependenciesReady) {
      return internalFailure(requestId, 'securityAlertDispatchConfiguration', alertId || null);
    }

    const authenticated = await authenticate(authorization, requestId, 'securityAlertDispatchAuthentication');
    if (!authenticated.ok) {
      return authenticated.result;
    }
    const input = parseAlertDispatchBody(body);
    if (!input) {
      return failure('INVALID_INPUT');
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
    if (!dependenciesReady) {
      return internalFailure(requestId, 'securityReportStartProcessConfiguration', reportId || null);
    }

    const authenticated = await authenticate(authorization, requestId);
    if (!authenticated.ok) {
      return authenticated.result;
    }
    const input = parseReportStartProcessBody(body);
    if (!input) {
      return failure('INVALID_INPUT');
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

        const updateResult = ensureDatabaseResult(await transaction.collection('fraud_reports').where({
          _id: currentReport._id,
          status: 'pending_security_verify',
          version: input.version,
        }).update({
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

function createSecurityReportClosingService({
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
      return { ok: false, result: internalFailure(requestId, 'securityReportCloseAuthentication') };
    }
  }

  async function close(authorization, reportId, body) {
    const requestId = createRequestId();
    if (!dependenciesReady) {
      return internalFailure(requestId, 'securityReportCloseConfiguration', reportId || null);
    }

    const authenticated = await authenticate(authorization, requestId);
    if (!authenticated.ok) {
      return authenticated.result;
    }
    const input = parseReportCloseBody(body);
    if (!input) {
      return failure('INVALID_INPUT');
    }

    const dispositionId = createDispositionId();
    const auditId = createAuditId();
    try {
      const report = await db.runTransaction(async (transaction) => {
        const currentReport = await findRecordById(transaction, 'fraud_reports', reportId);
        if (!currentReport) {
          throw businessError('NOT_FOUND');
        }
        if (!REPORT_CLOSE_SOURCE_STATUSES.has(currentReport.status) || currentReport.version !== input.version) {
          throw businessError('CONFLICT');
        }

        const updateResult = ensureDatabaseResult(await transaction.collection('fraud_reports').where({
          _id: currentReport._id,
          status: currentReport.status,
          version: input.version,
        }).update({
          status: 'closed',
          currentHandlerId: authenticated.user._id,
          finalOutcome: input.finalOutcome,
          confirmedLossAmount: input.confirmedLossAmount,
          closeReason: input.closeReason,
          closedAt: serverDate(),
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
          action: 'close',
          statusAfter: 'closed',
          verificationResult: input.verificationResult,
          actionContent: input.actionContent,
          confirmedLossAmount: input.confirmedLossAmount,
          finalOutcome: input.finalOutcome,
          createdAt: serverDate(),
        }));
        ensureSuccessfulInsert(await transaction.collection('audit_logs').add(createReportCloseAudit({
          reportId: currentReport._id,
          actorId: authenticated.user._id,
          beforeStatus: currentReport.status,
          requestId,
          serverDate,
          createAuditId: () => auditId,
        })));
        return {
          reportId: currentReport._id,
          status: 'closed',
          version: input.version + 1,
        };
      });
      return success('REPORT_CLOSED', { report });
    } catch (error) {
      if (error && error.isBusinessError) {
        return failure(error.businessCode);
      }
      if (isTransactionConflict(error)) {
        return failure('CONFLICT');
      }
      return internalFailure(requestId, 'securityReportCloseTransaction', reportId || null);
    }
  }

  return { close };
}

function createReportSensitiveViewAudit({ reportId, actorId, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(), actorId, actorRole: 'security', actorCollegeId: null,
    action: 'report.view_sensitive', resourceType: 'fraud_report', resourceId: reportId,
    result: 'success', requestId, createdAt: serverDate(),
  };
}

function createReportReturnAudit({ reportId, actorId, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(), actorId, actorRole: 'security', actorCollegeId: null,
    action: 'report.return', resourceType: 'fraud_report', resourceId: reportId,
    result: 'success', beforeSummary: { status: 'pending_security_verify' },
    afterSummary: { status: 'pending_counselor_verify', followupStatus: 'pending' }, requestId, createdAt: serverDate(),
  };
}

function reportListItem(report, collegeNames) {
  return {
    reportId: report._id, fraudType: report.fraudType, riskLevel: report.riskLevel, status: report.status,
    collegeName: collegeNames.get(report.collegeId) || '', submittedAt: report.submittedAt,
    version: report.version, hasLoss: Boolean(report.hasLoss),
  };
}

function reportDetailProjection(report, collegeName) {
  return {
    reportId: report._id, fraudType: report.fraudType, incidentAt: report.incidentAt ?? null,
    involvedAmount: report.involvedAmount ?? null, hasLoss: report.hasLoss ?? null,
    incidentNarrative: report.incidentNarrative ?? null, suspiciousPlatform: report.suspiciousPlatform ?? null,
    suspiciousAccount: report.suspiciousAccount ?? null, stillContacting: report.stillContacting ?? null,
    contactPhone: report.contactPhone ?? null, studentRemark: report.studentRemark ?? null,
    riskLevel: report.riskLevel ?? null, riskReasons: Array.isArray(report.riskReasons) ? report.riskReasons : [],
    status: report.status ?? null, submittedAt: report.submittedAt ?? null, version: report.version ?? null,
    finalOutcome: report.finalOutcome ?? null, confirmedLossAmount: report.confirmedLossAmount ?? null,
    closeReason: report.closeReason ?? null, closedAt: report.closedAt ?? null, collegeName,
  };
}

function followupDetailProjection(followup) {
  return {
    followupId: followup._id, status: followup.status ?? null, contactedAt: followup.contactedAt ?? null,
    contactMethod: followup.contactMethod ?? null, verificationResult: followup.verificationResult ?? null,
    transferReason: followup.transferReason ?? null, createdAt: followup.createdAt ?? null, completedAt: followup.completedAt ?? null,
  };
}

function dispositionDetailProjection(disposition) {
  return {
    action: disposition.action ?? null, statusAfter: disposition.statusAfter ?? null,
    verificationResult: disposition.verificationResult ?? null, returnReason: disposition.returnReason ?? null,
    confirmedLossAmount: disposition.confirmedLossAmount ?? null, finalOutcome: disposition.finalOutcome ?? null,
    createdAt: disposition.createdAt ?? null,
  };
}

function createSecurityReportManagementService({
  authService, db, serverDate, createFollowupId = () => `followup_${crypto.randomUUID().replace(/-/g, '')}`,
  createDispositionId = () => `disposition_${crypto.randomUUID().replace(/-/g, '')}`,
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
  createRequestId = () => crypto.randomUUID(), logger = console, configured = true,
} = {}) {
  const dependenciesReady = configured && authService && typeof authService.authenticateSecuritySession === 'function' &&
    db && typeof db.collection === 'function' && typeof db.runTransaction === 'function' && typeof serverDate === 'function';
  const internalFailure = (requestId, stage, resourceId = null) => {
    safeLog(logger, { requestId, code: 'INTERNAL_ERROR', resourceId, stage });
    return failure('INTERNAL_ERROR');
  };
  async function authenticate(authorization, requestId, stage) {
    try { return await authService.authenticateSecuritySession(authorization); }
    catch (error) { return { ok: false, result: internalFailure(requestId, stage) }; }
  }
  async function loadCollegeNames() {
    const result = await db.collection('colleges').limit(DASHBOARD_COLLEGE_READ_LIMIT).get();
    ensureDatabaseResult(result);
    return new Map((Array.isArray(result.data) ? result.data : []).filter((college) => college && typeof college._id === 'string' && typeof college.name === 'string')
      .map((college) => [college._id, college.name.trim()]));
  }

  async function list(authorization) {
    const requestId = createRequestId();
    if (!dependenciesReady) return internalFailure(requestId, 'securityReportListConfiguration');
    const authenticated = await authenticate(authorization, requestId, 'securityReportListAuthentication');
    if (!authenticated.ok) return authenticated.result;
    try {
      const statuses = ['pending_security_verify', 'in_process', 'closed'];
      const [collegeNames, ...resultSets] = await Promise.all([
        loadCollegeNames(),
        ...statuses.map((status) => db.collection('fraud_reports').where({ status }).orderBy('submittedAt', 'desc').limit(SECURITY_REPORT_QUEUE_LIMIT).get()),
      ]);
      const queues = Object.fromEntries(statuses.map((status, index) => [
        status === 'pending_security_verify' ? 'pendingSecurityVerify' : status === 'in_process' ? 'inProcess' : 'closed',
        (Array.isArray(resultSets[index].data) ? resultSets[index].data : [])
          .filter((report) => report && report.status === status).slice(0, SECURITY_REPORT_QUEUE_LIMIT)
          .map((report) => reportListItem(report, collegeNames)),
      ]));
      return success('REPORTS_LOADED', { queues });
    } catch (error) { return internalFailure(requestId, 'securityReportListRead'); }
  }

  async function detail(authorization, reportId) {
    const requestId = createRequestId();
    if (!reportId || reportId.length > 128) return failure('INVALID_INPUT');
    if (!dependenciesReady) return internalFailure(requestId, 'securityReportDetailConfiguration', reportId || null);
    const authenticated = await authenticate(authorization, requestId, 'securityReportDetailAuthentication');
    if (!authenticated.ok) return authenticated.result;
    try {
      const report = await findRecordById(db, 'fraud_reports', reportId);
      if (!report) return failure('NOT_FOUND');
      const [student, college, followupsResult, dispositionsResult] = await Promise.all([
        findRecordById(db, 'users', report.studentId),
        findRecordById(db, 'colleges', report.collegeId),
        db.collection('counselor_followups').where({ businessType: 'report', businessId: report._id }).orderBy('createdAt', 'asc').limit(SECURITY_REPORT_DETAIL_FOLLOWUP_LIMIT).get(),
        db.collection('security_dispositions').where({ reportId: report._id }).orderBy('createdAt', 'asc').limit(SECURITY_REPORT_DETAIL_DISPOSITION_LIMIT).get(),
      ]);
      if (!student) return failure('NOT_FOUND');
      ensureDatabaseResult(followupsResult); ensureDatabaseResult(dispositionsResult);
      ensureSuccessfulInsert(await db.collection('audit_logs').add(createReportSensitiveViewAudit({
        reportId: report._id, actorId: authenticated.user._id, requestId, serverDate, createAuditId,
      })));
      return success('REPORT_DETAIL_LOADED', {
        report: reportDetailProjection(report, college && typeof college.name === 'string' ? college.name : ''),
        student: { name: student.name ?? null, studentNo: student.studentNo ?? null },
        followups: (Array.isArray(followupsResult.data) ? followupsResult.data : []).filter(Boolean).map(followupDetailProjection),
        dispositions: (Array.isArray(dispositionsResult.data) ? dispositionsResult.data : []).filter(Boolean).map(dispositionDetailProjection),
      });
    } catch (error) { return internalFailure(requestId, 'securityReportDetailRead', reportId); }
  }

  async function returnToCounselor(authorization, reportId, body) {
    const requestId = createRequestId();
    if (!dependenciesReady) return internalFailure(requestId, 'securityReportReturnConfiguration', reportId);
    const authenticated = await authenticate(authorization, requestId, 'securityReportReturnAuthentication');
    if (!authenticated.ok) return authenticated.result;
    const input = parseReportReturnBody(body);
    if (!input || !reportId || reportId.length > 128) return failure('INVALID_INPUT');
    const followupId = createFollowupId();
    const dispositionId = createDispositionId();
    const auditId = createAuditId();
    try {
      const result = await db.runTransaction(async (transaction) => {
        const actor = await findRecordById(transaction, 'users', authenticated.user._id);
        if (!hasActiveSecuritySessionAccess(actor)) throw businessError('CONFLICT');
        const report = await findRecordById(transaction, 'fraud_reports', reportId);
        if (!report) throw businessError('NOT_FOUND');
        if (report.status !== 'pending_security_verify' || report.version !== input.version || typeof report.currentHandlerId !== 'string' || !report.currentHandlerId) throw businessError('CONFLICT');
        const counselor = await findRecordById(transaction, 'users', report.currentHandlerId);
        if (!counselor || counselor.role !== 'counselor' || counselor.status !== 'active' || counselor.collegeId !== report.collegeId) throw businessError('CONFLICT');
        const reportUpdate = ensureDatabaseResult(await transaction.collection('fraud_reports').where({
          _id: report._id, status: 'pending_security_verify', version: input.version, currentHandlerId: counselor._id,
        }).update({
          status: 'pending_counselor_verify', currentHandlerId: counselor._id, version: input.version + 1, updatedAt: serverDate(),
        }));
        if (updatedCount(reportUpdate) !== 1) throw businessError('CONFLICT');
        ensureSuccessfulInsert(await transaction.collection('counselor_followups').add({
          _id: followupId, businessType: 'report', businessId: report._id, studentId: report.studentId, collegeId: report.collegeId,
          counselorId: counselor._id, status: 'pending', opinion: '保卫处退回补充', contactedAt: null, contactMethod: null,
          focusFlag: false, transferToSecurity: false, version: 1, createdAt: serverDate(), updatedAt: serverDate(),
        }));
        ensureSuccessfulInsert(await transaction.collection('security_dispositions').add({
          _id: dispositionId, reportId: report._id, operatorId: actor._id, action: 'return',
          statusAfter: 'pending_counselor_verify', verificationResult: input.verificationResult,
          actionContent: input.actionContent, returnReason: input.returnReason, createdAt: serverDate(),
        }));
        ensureSuccessfulInsert(await transaction.collection('audit_logs').add(createReportReturnAudit({
          reportId: report._id, actorId: actor._id, requestId, serverDate, createAuditId: () => auditId,
        })));
        return { reportId: report._id, status: 'pending_counselor_verify', version: input.version + 1 };
      });
      return success('REPORT_RETURNED_TO_COUNSELOR', { report: result });
    } catch (error) {
      if (error && error.isBusinessError) return failure(error.businessCode);
      if (isTransactionConflict(error)) return failure('CONFLICT');
      return internalFailure(requestId, 'securityReportReturnTransaction', reportId);
    }
  }
  return { list, detail, returnToCounselor };
}

function createSecurityIdentityManagementService({
  authService,
  db,
  serverDate,
  createUserId = () => `usr_${crypto.randomUUID().replace(/-/g, '')}`,
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
  createRequestId = () => crypto.randomUUID(),
  logger = console,
  configured = true,
} = {}) {
  const dependenciesReady = configured &&
    authService && typeof authService.authenticateSecuritySession === 'function' &&
    db && typeof db.runTransaction === 'function' && typeof db.collection === 'function' &&
    db.command && typeof db.command.in === 'function' &&
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

  function toIdentityListItem(user, collegeNames) {
    const identityNo = user.role === 'student' ? user.studentNo : user.staffNo;
    return {
      userId: user._id,
      role: user.role,
      name: typeof user.name === 'string' ? user.name : '',
      collegeId: typeof user.collegeId === 'string' ? user.collegeId : '',
      collegeName: collegeNames.get(user.collegeId) || '',
      identityNoMasked: maskIdentityNo(identityNo),
      bindStatus: user.bindStatus,
      status: user.status,
      version: user.version,
    };
  }

  async function list(authorization) {
    const requestId = createRequestId();
    if (!dependenciesReady) {
      return internalFailure(requestId, 'securityIdentityListConfiguration');
    }
    const authenticated = await authenticate(authorization, requestId, 'securityIdentityListAuthentication');
    if (!authenticated.ok) {
      return authenticated.result;
    }

    let users;
    let colleges;
    try {
      const [usersResult, collegesResult] = await Promise.all([
        db.collection('users').where({ role: db.command.in([...MANAGEABLE_IDENTITY_ROLES]) }).get(),
        db.collection('colleges').get(),
      ]);
      ensureDatabaseResult(usersResult);
      ensureDatabaseResult(collegesResult);
      users = Array.isArray(usersResult.data) ? usersResult.data : [];
      colleges = Array.isArray(collegesResult.data) ? collegesResult.data : [];
    } catch (error) {
      return internalFailure(requestId, 'securityIdentityListRead');
    }

    const validColleges = colleges
      .filter((college) => college && typeof college._id === 'string' && college._id && typeof college.name === 'string' && college.name.trim());
    const activeColleges = validColleges
      .filter((college) => isActiveCollege(college) && typeof college._id === 'string' && college._id && typeof college.name === 'string' && college.name.trim())
      .map((college) => ({ collegeId: college._id, name: college.name.trim() }));
    const collegeNames = new Map(validColleges.map((college) => [college._id, college.name.trim()]));
    const identities = users
      .filter(isManageableIdentity)
      .map((user) => toIdentityListItem(user, collegeNames));

    try {
      ensureSuccessfulInsert(await db.collection('audit_logs').add(createIdentityListAudit({
        actorId: authenticated.user._id,
        requestId,
        serverDate,
        createAuditId,
      })));
    } catch (error) {
      return internalFailure(requestId, 'securityIdentityListAudit', authenticated.user._id);
    }
    return success('IDENTITIES_LOADED', { identities, colleges: activeColleges });
  }

  async function create(authorization, body) {
    const requestId = createRequestId();
    if (!dependenciesReady) {
      return internalFailure(requestId, 'securityIdentityCreateConfiguration');
    }
    const authenticated = await authenticate(authorization, requestId, 'securityIdentityCreateAuthentication');
    if (!authenticated.ok) {
      return authenticated.result;
    }
    const input = parseIdentityCreateBody(body);
    if (!input) {
      return failure('INVALID_INPUT');
    }

    const userId = createUserId();
    const auditId = createAuditId();
    const identityKey = `${input.role}:${input.identityNo}`;
    try {
      const identity = await db.runTransaction(async (transaction) => {
        const college = await findRecordById(transaction, 'colleges', input.collegeId);
        if (!isActiveCollege(college) || college._id !== input.collegeId) {
          throw businessError('NOT_FOUND');
        }
        const [existingStudent, existingCounselor] = await Promise.all([
          firstRecord(await transaction.collection('users').where({ identityKey: `student:${input.identityNo}` }).get()),
          firstRecord(await transaction.collection('users').where({ identityKey: `counselor:${input.identityNo}` }).get()),
        ]);
        if (existingStudent || existingCounselor) {
          throw businessError('CONFLICT');
        }
        const createdUser = {
          _id: userId,
          identityKey,
          wxIdentityKey: `unbound:${userId}`,
          role: input.role,
          name: input.name,
          collegeId: input.collegeId,
          studentNo: input.role === 'student' ? input.identityNo : null,
          staffNo: input.role === 'counselor' ? input.identityNo : null,
          loginName: null,
          passwordHash: null,
          wxOpenId: null,
          bindStatus: 'unbound',
          mobile: null,
          focusFlag: false,
          focusReason: null,
          status: 'active',
          version: 1,
          createdAt: serverDate(),
          updatedAt: serverDate(),
        };
        ensureSuccessfulInsert(await transaction.collection('users').add(createdUser));
        ensureSuccessfulInsert(await transaction.collection('audit_logs').add(createIdentityCreateAudit({
          userId,
          actorId: authenticated.user._id,
          role: input.role,
          collegeId: input.collegeId,
          requestId,
          serverDate,
          createAuditId: () => auditId,
        })));
        return {
          userId,
          role: input.role,
          collegeId: input.collegeId,
          bindStatus: 'unbound',
          status: 'active',
          version: 1,
        };
      });
      return success('IDENTITY_CREATED', { identity });
    } catch (error) {
      if (error && error.isBusinessError) {
        return failure(error.businessCode);
      }
      if (isTransactionConflict(error) || isUniqueConstraintConflict(error)) {
        return failure('CONFLICT');
      }
      return internalFailure(requestId, 'securityIdentityCreateTransaction', userId);
    }
  }

  async function unbind(authorization, userId, body) {
    const requestId = createRequestId();
    if (!dependenciesReady) {
      return internalFailure(requestId, 'securityIdentityUnbindConfiguration', userId || null);
    }
    const authenticated = await authenticate(authorization, requestId, 'securityIdentityUnbindAuthentication');
    if (!authenticated.ok) {
      return authenticated.result;
    }
    const input = parseIdentityUnbindBody(body);
    if (!input || typeof userId !== 'string' || !userId) {
      return failure('INVALID_INPUT');
    }

    const auditId = createAuditId();
    try {
      const identity = await db.runTransaction(async (transaction) => {
        const current = await findRecordById(transaction, 'users', userId);
        if (!current) {
          throw businessError('NOT_FOUND');
        }
        if (!isManageableIdentity(current)) {
          throw businessError('FORBIDDEN');
        }
        if (current.bindStatus !== 'bound' || typeof current.wxOpenId !== 'string' || !current.wxOpenId ||
          current.wxIdentityKey !== `openid:${current.wxOpenId}` || current.version !== input.version) {
          throw businessError('CONFLICT');
        }
        const nextWxIdentityKey = `unbound:${current._id}`;
        const updateResult = ensureDatabaseResult(await transaction.collection('users').where({
          _id: current._id,
          version: input.version,
          bindStatus: 'bound',
          wxIdentityKey: current.wxIdentityKey,
        }).update({
          wxOpenId: null,
          wxIdentityKey: nextWxIdentityKey,
          bindStatus: 'unbound',
          version: input.version + 1,
          updatedAt: serverDate(),
        }));
        if (updatedCount(updateResult) !== 1) {
          throw businessError('CONFLICT');
        }
        ensureSuccessfulInsert(await transaction.collection('audit_logs').add(createIdentityUnbindAudit({
          userId: current._id,
          actorId: authenticated.user._id,
          requestId,
          serverDate,
          createAuditId: () => auditId,
        })));
        return { userId: current._id, bindStatus: 'unbound', version: input.version + 1 };
      });
      return success('IDENTITY_UNBOUND', { identity });
    } catch (error) {
      if (error && error.isBusinessError) {
        return failure(error.businessCode);
      }
      if (isTransactionConflict(error)) {
        return failure('CONFLICT');
      }
      return internalFailure(requestId, 'securityIdentityUnbindTransaction', userId);
    }
  }

  async function updateStatus(authorization, userId, body) {
    const requestId = createRequestId();
    if (!dependenciesReady) {
      return internalFailure(requestId, 'securityIdentityStatusConfiguration', userId || null);
    }
    const authenticated = await authenticate(authorization, requestId, 'securityIdentityStatusAuthentication');
    if (!authenticated.ok) {
      return authenticated.result;
    }
    const input = parseIdentityStatusBody(body);
    if (!input || typeof userId !== 'string' || !userId) {
      return failure('INVALID_INPUT');
    }

    const auditId = createAuditId();
    try {
      const identity = await db.runTransaction(async (transaction) => {
        const current = await findRecordById(transaction, 'users', userId);
        if (!current) {
          throw businessError('NOT_FOUND');
        }
        if (!isManageableIdentity(current)) {
          throw businessError('FORBIDDEN');
        }
        if (!MANAGEABLE_IDENTITY_STATUSES.has(current.status) || current.version !== input.version || current.status === input.status) {
          throw businessError('CONFLICT');
        }
        const updateResult = ensureDatabaseResult(await transaction.collection('users').where({
          _id: current._id,
          version: input.version,
          status: current.status,
        }).update({
          status: input.status,
          version: input.version + 1,
          updatedAt: serverDate(),
        }));
        if (updatedCount(updateResult) !== 1) {
          throw businessError('CONFLICT');
        }
        ensureSuccessfulInsert(await transaction.collection('audit_logs').add(createIdentityStatusAudit({
          userId: current._id,
          actorId: authenticated.user._id,
          beforeStatus: current.status,
          afterStatus: input.status,
          requestId,
          serverDate,
          createAuditId: () => auditId,
        })));
        return { userId: current._id, status: input.status, version: input.version + 1 };
      });
      return success('IDENTITY_STATUS_UPDATED', { identity });
    } catch (error) {
      if (error && error.isBusinessError) {
        return failure(error.businessCode);
      }
      if (isTransactionConflict(error)) {
        return failure('CONFLICT');
      }
      return internalFailure(requestId, 'securityIdentityStatusTransaction', userId);
    }
  }

  return { list, create, unbind, updateStatus };
}

function createSecurityCollegeManagementService({
  authService,
  db,
  serverDate,
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
  createRequestId = () => crypto.randomUUID(),
  logger = console,
  configured = true,
} = {}) {
  const dependenciesReady = configured &&
    authService && typeof authService.authenticateSecuritySession === 'function' &&
    db && typeof db.runTransaction === 'function' && typeof db.collection === 'function' &&
    db.command && typeof db.command.in === 'function' &&
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

  async function list(authorization) {
    const requestId = createRequestId();
    if (!dependenciesReady) return internalFailure(requestId, 'securityCollegeListConfiguration');
    const authenticated = await authenticate(authorization, requestId, 'securityCollegeListAuthentication');
    if (!authenticated.ok) return authenticated.result;

    try {
      const [collegesResult, usersResult] = await Promise.all([
        db.collection('colleges').limit(DASHBOARD_COLLEGE_READ_LIMIT).get(),
        db.collection('users').where({ role: db.command.in([...MANAGEABLE_IDENTITY_ROLES]) }).get(),
      ]);
      ensureDatabaseResult(collegesResult);
      ensureDatabaseResult(usersResult);
      const identityCounts = new Map();
      for (const user of (Array.isArray(usersResult.data) ? usersResult.data : [])) {
        if (!isManageableIdentity(user) || typeof user.collegeId !== 'string' || !user.collegeId) continue;
        const counts = identityCounts.get(user.collegeId) || { identityCount: 0, activeIdentityCount: 0 };
        counts.identityCount += 1;
        if (user.status === 'active') counts.activeIdentityCount += 1;
        identityCounts.set(user.collegeId, counts);
      }
      const colleges = (Array.isArray(collegesResult.data) ? collegesResult.data : [])
        .filter((college) => college && typeof college._id === 'string' && college._id &&
          typeof college.name === 'string' && college.name && COLLEGE_STATUSES.has(college.status))
        .map((college) => toCollegeListItem(college, identityCounts));
      return success('COLLEGES_LOADED', { colleges });
    } catch (error) {
      return internalFailure(requestId, 'securityCollegeListRead');
    }
  }

  async function create(authorization, body) {
    const requestId = createRequestId();
    if (!dependenciesReady) return internalFailure(requestId, 'securityCollegeCreateConfiguration');
    const authenticated = await authenticate(authorization, requestId, 'securityCollegeCreateAuthentication');
    if (!authenticated.ok) return authenticated.result;
    const input = parseCollegeCreateBody(body);
    if (!input) return failure('INVALID_INPUT');

    const collegeId = collegeIdForName(input.name);
    const auditId = createAuditId();
    try {
      const college = await db.runTransaction(async (transaction) => {
        const existing = await findRecordById(transaction, 'colleges', collegeId);
        if (existing) throw businessError('CONFLICT');
        const createdCollege = {
          _id: collegeId,
          name: input.name,
          status: 'active',
          aliases: [],
          createdAt: serverDate(),
          updatedAt: serverDate(),
        };
        ensureSuccessfulInsert(await transaction.collection('colleges').add(createdCollege));
        ensureSuccessfulInsert(await transaction.collection('audit_logs').add(createCollegeCreateAudit({
          collegeId,
          actorId: authenticated.user._id,
          requestId,
          serverDate,
          createAuditId: () => auditId,
        })));
        return { collegeId, name: createdCollege.name, status: createdCollege.status };
      });
      return success('COLLEGE_CREATED', { college });
    } catch (error) {
      if (error && error.isBusinessError) return failure(error.businessCode);
      if (isTransactionConflict(error) || isUniqueConstraintConflict(error)) return failure('CONFLICT');
      return internalFailure(requestId, 'securityCollegeCreateTransaction', collegeId);
    }
  }

  async function updateStatus(authorization, collegeId, body) {
    const requestId = createRequestId();
    if (!dependenciesReady) return internalFailure(requestId, 'securityCollegeStatusConfiguration', collegeId || null);
    const authenticated = await authenticate(authorization, requestId, 'securityCollegeStatusAuthentication');
    if (!authenticated.ok) return authenticated.result;
    const input = parseCollegeStatusBody(body);
    if (!input || typeof collegeId !== 'string' || !collegeId || collegeId.length > MAX_COLLEGE_ID_LENGTH) {
      return failure('INVALID_INPUT');
    }

    const auditId = createAuditId();
    try {
      const college = await db.runTransaction(async (transaction) => {
        const current = await findRecordById(transaction, 'colleges', collegeId);
        if (!current) throw businessError('NOT_FOUND');
        if (!COLLEGE_STATUSES.has(current.status) || current.status === input.status) throw businessError('CONFLICT');
        if (input.status === 'disabled') {
          const activeIdentityCount = countTotal(await transaction.collection('users').where({
            role: db.command.in([...MANAGEABLE_IDENTITY_ROLES]),
            collegeId: current._id,
            status: 'active',
          }).count());
          if (activeIdentityCount === null) throw businessError('INTERNAL_ERROR');
          if (activeIdentityCount > 0) throw businessError('COLLEGE_IN_USE');
        }
        const updateResult = ensureDatabaseResult(await transaction.collection('colleges').where({
          _id: current._id,
          status: current.status,
        }).update({
          status: input.status,
          updatedAt: serverDate(),
        }));
        if (updatedCount(updateResult) !== 1) throw businessError('CONFLICT');
        ensureSuccessfulInsert(await transaction.collection('audit_logs').add(createCollegeStatusAudit({
          collegeId: current._id,
          actorId: authenticated.user._id,
          beforeStatus: current.status,
          afterStatus: input.status,
          requestId,
          serverDate,
          createAuditId: () => auditId,
        })));
        return { collegeId: current._id, name: current.name, status: input.status };
      });
      return success('COLLEGE_STATUS_UPDATED', { college });
    } catch (error) {
      if (error && error.isBusinessError) return failure(error.businessCode);
      if (isTransactionConflict(error)) return failure('CONFLICT');
      return internalFailure(requestId, 'securityCollegeStatusTransaction', collegeId);
    }
  }

  return { list, create, updateStatus };
}

function createSecurityDashboardService({
  authService,
  db,
  createRequestId = () => crypto.randomUUID(),
  now = () => new Date(),
  logger = console,
  configured = true,
} = {}) {
  const dependenciesReady = configured &&
    authService && typeof authService.authenticateSecuritySession === 'function' &&
    db && typeof db.collection === 'function' && db.command &&
    typeof db.command.in === 'function' && typeof db.command.gte === 'function';

  function internalFailure(requestId, stage) {
    safeLog(logger, { requestId, code: 'INTERNAL_ERROR', resourceId: null, stage });
    return failure('INTERNAL_ERROR');
  }

  async function load(authorization) {
    const requestId = createRequestId();
    if (!dependenciesReady) return internalFailure(requestId, 'securityDashboardConfiguration');
    let authenticated;
    try {
      authenticated = await authService.authenticateSecuritySession(authorization);
    } catch (error) {
      return internalFailure(requestId, 'securityDashboardAuthentication');
    }
    if (!authenticated.ok) return authenticated.result;

    let currentTime;
    try {
      currentTime = now();
      if (!(currentTime instanceof Date) || Number.isNaN(currentTime.getTime())) throw new Error('Invalid clock');
    } catch (error) {
      return internalFailure(requestId, 'securityDashboardClock');
    }

    try {
      const todayStart = shanghaiDayStart(currentTime);
      const [pendingCount, inProcessCount, closedCount, todayCount, studentCount, counselorCount, boundCount, unboundCount, activeCollegeCount, totalCollegeCount, reportsResult, alertsResult, collegesResult] = await Promise.all([
        db.collection('fraud_reports').where({ status: 'pending_security_verify' }).count(),
        db.collection('fraud_reports').where({ status: 'in_process' }).count(),
        db.collection('fraud_reports').where({ status: 'closed' }).count(),
        db.collection('fraud_reports').where({ createdAt: db.command.gte(todayStart) }).count(),
        db.collection('users').where({ role: 'student' }).count(),
        db.collection('users').where({ role: 'counselor' }).count(),
        db.collection('users').where({ role: db.command.in([...MANAGEABLE_IDENTITY_ROLES]), bindStatus: 'bound' }).count(),
        db.collection('users').where({ role: db.command.in([...MANAGEABLE_IDENTITY_ROLES]), bindStatus: 'unbound' }).count(),
        db.collection('colleges').where({ status: 'active' }).count(),
        db.collection('colleges').count(),
        db.collection('fraud_reports').where({ status: db.command.in([...DASHBOARD_REPORT_STATUSES]) }).limit(DASHBOARD_LIST_READ_LIMIT).get(),
        db.collection('alerts').orderBy('createdAt', 'desc').limit(5).get(),
        db.collection('colleges').limit(DASHBOARD_COLLEGE_READ_LIMIT).get(),
      ]);
      const counts = [pendingCount, inProcessCount, closedCount, todayCount, studentCount, counselorCount, boundCount, unboundCount, activeCollegeCount, totalCollegeCount]
        .map(countTotal);
      if (counts.some((count) => count === null)) return internalFailure(requestId, 'securityDashboardCounts');
      ensureDatabaseResult(reportsResult);
      ensureDatabaseResult(alertsResult);
      ensureDatabaseResult(collegesResult);
      const collegeNames = new Map((Array.isArray(collegesResult.data) ? collegesResult.data : [])
        .filter((college) => college && typeof college._id === 'string' && typeof college.name === 'string' && college.name.trim())
        .map((college) => [college._id, college.name.trim()]));
      const riskPriority = { high: 0, medium: 1, low: 2 };
      const statusPriority = { pending_security_verify: 0, in_process: 1 };
      const pendingReports = (Array.isArray(reportsResult.data) ? reportsResult.data : [])
        .filter((report) => report && DASHBOARD_REPORT_STATUSES.has(report.status))
        .sort((left, right) => (statusPriority[left.status] - statusPriority[right.status]) ||
          ((riskPriority[left.riskLevel] ?? 3) - (riskPriority[right.riskLevel] ?? 3)) ||
          (dateValue(left.createdAt) - dateValue(right.createdAt)))
        .slice(0, 5)
        .map((report) => toDashboardItem(report, collegeNames, 'reportId'));
      const recentAlerts = (Array.isArray(alertsResult.data) ? alertsResult.data : [])
        .filter(Boolean)
        .sort((left, right) => dateValue(right.createdAt) - dateValue(left.createdAt))
        .slice(0, 5)
        .map((alert) => toDashboardItem(alert, collegeNames, 'alertId'));
      return success('DASHBOARD_LOADED', {
        metrics: {
          pendingSecurityVerifyCount: counts[0],
          inProcessCount: counts[1],
          closedCount: counts[2],
          todayNewReportCount: counts[3],
        },
        identitySummary: {
          studentCount: counts[4],
          counselorCount: counts[5],
          boundCount: counts[6],
          unboundCount: counts[7],
        },
        collegeSummary: { activeCount: counts[8], totalCount: counts[9] },
        pendingReports,
        recentAlerts,
      });
    } catch (error) {
      return internalFailure(requestId, 'securityDashboardRead');
    }
  }

  return { load };
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
  if (result.code === 'CONFLICT' || result.code === 'COLLEGE_IN_USE') {
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

function getReportCloseId(path) {
  const match = /^\/reports\/([^/]+)\/close$/.exec(path);
  return match ? match[1] : null;
}

function getReportDetailId(path) {
  const match = /^\/reports\/([^/]+)$/.exec(path);
  return match ? match[1] : null;
}

function getReportReturnId(path) {
  const match = /^\/reports\/([^/]+)\/return$/.exec(path);
  return match ? match[1] : null;
}

function getIdentityUnbindUserId(path) {
  const match = /^\/identities\/([^/]+)\/unbind$/.exec(path);
  return match ? match[1] : null;
}

function getIdentityStatusUserId(path) {
  const match = /^\/identities\/([^/]+)\/status$/.exec(path);
  return match ? match[1] : null;
}

function getCollegeStatusId(path) {
  const match = /^\/colleges\/([^/]+)\/status$/.exec(path);
  return match ? match[1] : null;
}

function createHttpHandler({
  authService,
  alertService = null,
  reportProcessingService = null,
  reportClosingService = null,
  reportManagementService = null,
  identityManagementService = null,
  collegeManagementService = null,
  dashboardService = null,
  allowedOrigins,
  logger = console,
}) {
  if (!authService || typeof authService.login !== 'function' || typeof authService.session !== 'function') {
    throw new Error('securityAuthHttp requires an authentication service');
  }
  const originWhitelist = parseAllowedOrigins(allowedOrigins);
  return async function handleHttpRequest(event) {
    const origin = readHeader(event && event.headers, 'origin');
    const method = getHttpMethod(event);
    const path = getHttpPath(event);
    if (method === 'OPTIONS') {
      const identityUnbindUserId = getIdentityUnbindUserId(path);
      const identityStatusUserId = getIdentityStatusUserId(path);
      const collegeStatusId = getCollegeStatusId(path);
      const reportDetailId = getReportDetailId(path);
      const reportReturnId = getReportReturnId(path);
      const allowedMethods = path === '/login'
        ? 'POST, OPTIONS'
        : path === '/session'
          ? 'GET, OPTIONS'
          : path === '/identities'
            ? 'GET, POST, OPTIONS'
            : path === '/colleges'
              ? 'GET, POST, OPTIONS'
              : (path === '/dashboard')
                ? 'GET, OPTIONS'
                : (path === '/reports' || reportDetailId)
                  ? 'GET, OPTIONS'
            : (identityUnbindUserId || identityStatusUserId || collegeStatusId || reportReturnId || path === '/alerts' || getAlertDispatchId(path) || getReportStartProcessId(path) || getReportCloseId(path))
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
      if (method === 'GET' && path === '/dashboard') {
        if (!dashboardService || typeof dashboardService.load !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await dashboardService.load(
          readHeader(event && event.headers, 'authorization'),
        ), buildResponseHeaders(origin, originWhitelist));
      }
      if (method === 'GET' && path === '/reports') {
        if (!reportManagementService || typeof reportManagementService.list !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await reportManagementService.list(
          readHeader(event && event.headers, 'authorization'),
        ), buildResponseHeaders(origin, originWhitelist));
      }
      const reportDetailId = getReportDetailId(path);
      if (method === 'GET' && reportDetailId) {
        if (!reportManagementService || typeof reportManagementService.detail !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await reportManagementService.detail(
          readHeader(event && event.headers, 'authorization'), reportDetailId,
        ), buildResponseHeaders(origin, originWhitelist));
      }
      if (method === 'GET' && path === '/colleges') {
        if (!collegeManagementService || typeof collegeManagementService.list !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await collegeManagementService.list(
          readHeader(event && event.headers, 'authorization'),
        ), buildResponseHeaders(origin, originWhitelist));
      }
      if (method === 'POST' && path === '/colleges') {
        if (!collegeManagementService || typeof collegeManagementService.create !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await collegeManagementService.create(
          readHeader(event && event.headers, 'authorization'),
          event && event.body,
        ), buildResponseHeaders(origin, originWhitelist));
      }
      const collegeStatusId = getCollegeStatusId(path);
      if (method === 'POST' && collegeStatusId) {
        if (!collegeManagementService || typeof collegeManagementService.updateStatus !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await collegeManagementService.updateStatus(
          readHeader(event && event.headers, 'authorization'),
          collegeStatusId,
          event && event.body,
        ), buildResponseHeaders(origin, originWhitelist));
      }
      if (method === 'GET' && path === '/identities') {
        if (!identityManagementService || typeof identityManagementService.list !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await identityManagementService.list(
          readHeader(event && event.headers, 'authorization'),
        ), buildResponseHeaders(origin, originWhitelist));
      }
      if (method === 'POST' && path === '/identities') {
        if (!identityManagementService || typeof identityManagementService.create !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await identityManagementService.create(
          readHeader(event && event.headers, 'authorization'),
          event && event.body,
        ), buildResponseHeaders(origin, originWhitelist));
      }
      const identityUnbindUserId = getIdentityUnbindUserId(path);
      if (method === 'POST' && identityUnbindUserId) {
        if (!identityManagementService || typeof identityManagementService.unbind !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await identityManagementService.unbind(
          readHeader(event && event.headers, 'authorization'),
          identityUnbindUserId,
          event && event.body,
        ), buildResponseHeaders(origin, originWhitelist));
      }
      const identityStatusUserId = getIdentityStatusUserId(path);
      if (method === 'POST' && identityStatusUserId) {
        if (!identityManagementService || typeof identityManagementService.updateStatus !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await identityManagementService.updateStatus(
          readHeader(event && event.headers, 'authorization'),
          identityStatusUserId,
          event && event.body,
        ), buildResponseHeaders(origin, originWhitelist));
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
      const closeReportId = getReportCloseId(path);
      if (method === 'POST' && closeReportId) {
        if (!reportClosingService || typeof reportClosingService.close !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await reportClosingService.close(
          readHeader(event && event.headers, 'authorization'),
          closeReportId,
          event && event.body,
        ), buildResponseHeaders(origin, originWhitelist));
      }
      const reportReturnId = getReportReturnId(path);
      if (method === 'POST' && reportReturnId) {
        if (!reportManagementService || typeof reportManagementService.returnToCounselor !== 'function') {
          return httpResponse(failure('INTERNAL_ERROR'), buildResponseHeaders(origin, originWhitelist));
        }
        return httpResponse(await reportManagementService.returnToCounselor(
          readHeader(event && event.headers, 'authorization'), reportReturnId, event && event.body,
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
    const reportClosingService = createSecurityReportClosingService({
      authService,
      db: dependencies.db,
      serverDate: dependencies.serverDate,
      logger,
      configured: dependencies.configured,
    });
    const reportManagementService = createSecurityReportManagementService({
      authService,
      db: dependencies.db,
      serverDate: dependencies.serverDate,
      logger,
      configured: dependencies.configured,
    });
    const identityManagementService = createSecurityIdentityManagementService({
      authService,
      db: dependencies.db,
      serverDate: dependencies.serverDate,
      logger,
      configured: dependencies.configured,
    });
    const collegeManagementService = createSecurityCollegeManagementService({
      authService,
      db: dependencies.db,
      serverDate: dependencies.serverDate,
      logger,
      configured: dependencies.configured,
    });
    const dashboardService = createSecurityDashboardService({
      authService,
      db: dependencies.db,
      logger,
      configured: dependencies.configured,
    });
    return createHttpHandler({
      authService,
      alertService,
      reportProcessingService,
      reportClosingService,
      reportManagementService,
      identityManagementService,
      collegeManagementService,
      dashboardService,
      allowedOrigins: environment.SECURITY_WEB_ALLOWED_ORIGINS,
      logger,
    });
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
  createSecurityCollegeManagementService,
  createSecurityDashboardService,
  createSecurityIdentityManagementService,
  createSecurityReportClosingService,
  createSecurityReportManagementService,
  createSecurityReportProcessingService,
  calculateManualAlertRisk,
  createLoginAudit,
  createReportCloseAudit,
  createReportStartProcessAudit,
  getAlertDispatchId,
  getCollegeStatusId,
  getIdentityStatusUserId,
  getIdentityUnbindUserId,
  getReportCloseId,
  getReportDetailId,
  getReportReturnId,
  getReportStartProcessId,
  createNodeServer,
  mintSessionToken,
  normalizeLoginName,
  parseAlertCreateBody,
  parseAlertDispatchBody,
  parseCollegeCreateBody,
  parseCollegeStatusBody,
  parseIdentityCreateBody,
  parseIdentityStatusBody,
  parseIdentityUnbindBody,
  parseReportCloseBody,
  parseReportReturnBody,
  parseReportStartProcessBody,
  parseAllowedOrigins,
  parseLoginBody,
  collegeIdForName,
  shanghaiDayStart,
  maskIdentityNo,
  verifySessionToken,
};
