'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const MAX_ALERTS = 50;
const IGNORED_PLATFORM_EVENT_KEYS = new Set(['userInfo', 'tcbContext']);
const STUDENT_VISIBLE_ALERT_STATUSES = new Set(['sent', 'viewed', 'following_up', 'closed']);

function success(code, payload = {}) {
  return { ok: true, code, ...payload };
}

function failure(code, message) {
  return { ok: false, code, message };
}

function getAppId(wxContext) {
  return wxContext && (wxContext.APPID || wxContext.appId);
}

function validateInput(event) {
  if (event === undefined || event === null) {
    return true;
  }
  if (typeof event !== 'object' || Array.isArray(event)) {
    return false;
  }
  return Object.keys(event).every((key) => IGNORED_PLATFORM_EVENT_KEYS.has(key));
}

function isBoundToTrustedOpenId(user, trustedOpenId) {
  return user &&
    user.bindStatus === 'bound' &&
    typeof user.wxOpenId === 'string' &&
    user.wxOpenId.length > 0 &&
    user.wxOpenId === trustedOpenId &&
    user.wxIdentityKey === `openid:${trustedOpenId}`;
}

function isStudentVisibleAlert(alert) {
  return alert && STUDENT_VISIBLE_ALERT_STATUSES.has(alert.status);
}

function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId: user._id,
    actorRole: user.role,
    actorCollegeId: user.collegeId || null,
    action: 'access.denied',
    resourceType: 'user',
    resourceId: user._id,
    result: 'failure',
    failureReason: code,
    requestId,
    createdAt: serverDate(),
  };
}

function toContentSummary(content) {
  if (typeof content !== 'string') {
    return '';
  }
  const normalized = content.trim();
  return normalized.length > 80 ? `${normalized.slice(0, 80)}…` : normalized;
}

function toListItem(alert) {
  return {
    alertId: alert._id,
    fraudType: alert.fraudType,
    riskLevel: alert.riskLevel,
    status: alert.status,
    contentSummary: toContentSummary(alert.content),
    issuedAt: alert.issuedAt,
  };
}

async function findUserByWxIdentityKey(db, wxIdentityKey) {
  const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get();
  return Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
}

function createHandler({
  db,
  getWXContext,
  serverDate,
  logger = console,
  createRequestId = () => crypto.randomUUID(),
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
}) {
  if (!db || typeof db.collection !== 'function' || typeof getWXContext !== 'function' || typeof serverDate !== 'function') {
    throw new Error('getStudentAlerts dependencies are incomplete');
  }

  return async function getStudentAlerts(event) {
    const requestId = createRequestId();
    const auditedIdentityFailure = async (user, code, message, stage) => {
      try {
        await db.collection('audit_logs').add({
          data: createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }),
        });
        return failure(code, message);
      } catch (error) {
        logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: user._id, stage });
        return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
      }
    };

    try {
      if (!validateInput(event)) {
        return failure('INVALID_INPUT', '请求参数无效');
      }

      const wxContext = getWXContext() || {};
      const appId = getAppId(wxContext);
      if (appId && appId !== EXPECTED_APP_ID) {
        return failure('FORBIDDEN', '调用来源不被允许');
      }
      if (!wxContext.OPENID) {
        return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      }

      const student = await findUserByWxIdentityKey(db, `openid:${wxContext.OPENID}`);
      if (!student) {
        return failure('UNBOUND', '当前微信尚未绑定学生身份');
      }
      if (student.role !== 'student') {
        return auditedIdentityFailure(student, 'FORBIDDEN', '当前账号不能查看学生预警', 'studentAlertsRole');
      }
      if (student.status !== 'active') {
        return auditedIdentityFailure(student, 'ACCOUNT_DISABLED', '账号当前不可用', 'studentAlertsStatus');
      }
      if (!isBoundToTrustedOpenId(student, wxContext.OPENID)) {
        return auditedIdentityFailure(student, 'INTERNAL_ERROR', '账号绑定状态异常，请联系管理员', 'studentAlertsBindingConsistency');
      }

      const result = await db.collection('alerts')
        .where({ studentId: student._id })
        .orderBy('issuedAt', 'desc')
        .limit(MAX_ALERTS)
        .get();
      const alerts = (Array.isArray(result.data) ? result.data : [])
        .filter(isStudentVisibleAlert)
        .map(toListItem);
      return success('OK', { alerts });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'getStudentAlerts' });
      return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
    }
  };
}

function createDefaultHandler(cloud = require('wx-server-sdk')) {
  cloud.init({ env: TARGET_ENV_ID });
  const db = cloud.database();
  return createHandler({
    db,
    getWXContext: () => cloud.getWXContext(),
    serverDate: () => db.serverDate(),
    logger: console,
  });
}

exports.main = async (event) => createDefaultHandler()(event);
exports.__testables = {
  createHandler,
  createDefaultHandler,
  createAccessDeniedAuditLog,
  findUserByWxIdentityKey,
  isBoundToTrustedOpenId,
  isStudentVisibleAlert,
  toContentSummary,
  toListItem,
  validateInput,
  EXPECTED_APP_ID,
  TARGET_ENV_ID,
};
