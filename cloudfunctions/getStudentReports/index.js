'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const MAX_REPORTS = 100;
const ACCEPTED_EVENT_KEYS = new Set(['userInfo', 'tcbContext']);

function success(code, payload = {}) { return { ok: true, code, ...payload }; }
function failure(code, message) { return { ok: false, code, message }; }
function getAppId(context) { return context && (context.APPID || context.appId); }

function validateInput(event) {
  return (event === undefined || event === null) ||
    (typeof event === 'object' && !Array.isArray(event) && Object.keys(event).every((key) => ACCEPTED_EVENT_KEYS.has(key)));
}

function isTrustedActiveStudent(user, openId) {
  return Boolean(user) && user.role === 'student' && user.status === 'active' && user.bindStatus === 'bound' &&
    typeof user._id === 'string' && user._id && typeof user.wxOpenId === 'string' && user.wxOpenId === openId &&
    user.wxIdentityKey === `openid:${openId}`;
}

async function findUserByWxIdentityKey(db, wxIdentityKey) {
  const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get();
  return Array.isArray(result.data) && result.data.length ? result.data[0] : null;
}

function toListItem(report) {
  return {
    reportId: report._id,
    fraudType: report.fraudType,
    riskLevel: report.riskLevel,
    status: report.status,
    submittedAt: report.submittedAt,
    hasLoss: Boolean(report.hasLoss),
    hasSourceAlert: Boolean(report.sourceAlertId),
  };
}

function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(), actorId: user._id, actorRole: user.role, actorCollegeId: user.collegeId || null,
    action: 'access.denied', resourceType: 'user', resourceId: user._id, result: 'failure', failureReason: code,
    requestId, createdAt: serverDate(),
  };
}

function createHandler({
  db, getWXContext, serverDate, logger = console,
  createRequestId = () => crypto.randomUUID(),
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
}) {
  if (!db || typeof db.collection !== 'function' || typeof getWXContext !== 'function' || typeof serverDate !== 'function') {
    throw new Error('getStudentReports dependencies are incomplete');
  }
  return async function getStudentReports(event) {
    const requestId = createRequestId();
    try {
      if (!validateInput(event)) return failure('INVALID_INPUT', '请求参数无效');
      const context = getWXContext() || {};
      if (getAppId(context) && getAppId(context) !== EXPECTED_APP_ID) return failure('FORBIDDEN', '调用来源不被允许');
      if (!context.OPENID) return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      const student = await findUserByWxIdentityKey(db, `openid:${context.OPENID}`);
      if (!student) return failure('UNBOUND', '当前微信尚未绑定学生身份');
      if (!isTrustedActiveStudent(student, context.OPENID)) {
        const code = student.role !== 'student' ? 'FORBIDDEN' : student.status !== 'active' ? 'ACCOUNT_DISABLED' : 'INTERNAL_ERROR';
        try {
          await db.collection('audit_logs').add({ data: createAccessDeniedAuditLog({ user: student, code, requestId, serverDate, createAuditId }) });
        } catch (error) {
          logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: student._id, stage: 'studentReportsDeniedAudit' });
          return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
        }
        return failure(code, code === 'FORBIDDEN' ? '当前身份无权查看学生工单' : '账号当前不可用');
      }
      const result = await db.collection('fraud_reports').where({ studentId: student._id })
        .orderBy('submittedAt', 'desc').limit(MAX_REPORTS).get();
      return success('STUDENT_REPORTS_LOADED', {
        reports: (Array.isArray(result.data) ? result.data : []).map(toListItem),
      });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'getStudentReports' });
      return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
    }
  };
}

function createDefaultHandler(cloud = require('wx-server-sdk')) {
  cloud.init({ env: TARGET_ENV_ID });
  const db = cloud.database();
  return createHandler({ db, getWXContext: () => cloud.getWXContext(), serverDate: () => db.serverDate() });
}

exports.main = async (event) => createDefaultHandler()(event);
exports.__testables = { ACCEPTED_EVENT_KEYS, EXPECTED_APP_ID, MAX_REPORTS, TARGET_ENV_ID, createAccessDeniedAuditLog, createDefaultHandler, createHandler, findUserByWxIdentityKey, isTrustedActiveStudent, toListItem, validateInput };
