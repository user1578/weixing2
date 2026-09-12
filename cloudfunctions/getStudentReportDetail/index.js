'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const ACCEPTED_EVENT_KEYS = new Set(['reportId', 'userInfo', 'tcbContext']);

function success(code, payload = {}) { return { ok: true, code, ...payload }; }
function failure(code, message) { return { ok: false, code, message }; }
function getAppId(context) { return context && (context.APPID || context.appId); }
function nullable(value) { return value === undefined ? null : value; }

function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key))) return null;
  const reportId = typeof event.reportId === 'string' ? event.reportId.trim() : '';
  return reportId && reportId.length <= 128 ? { reportId } : null;
}

function isTrustedActiveStudent(user, openId) {
  return Boolean(user) && user.role === 'student' && user.status === 'active' && user.bindStatus === 'bound' &&
    typeof user._id === 'string' && user._id && user.wxOpenId === openId && user.wxIdentityKey === `openid:${openId}`;
}

async function findUserByWxIdentityKey(db, wxIdentityKey) {
  const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get();
  return Array.isArray(result.data) && result.data.length ? result.data[0] : null;
}

async function findById(db, collection, id) {
  const result = await db.collection(collection).doc(id).get();
  return result && result.data ? (Array.isArray(result.data) ? result.data[0] || null : result.data) : null;
}

function studentReportProjection(report) {
  return {
    reportId: report._id, fraudType: nullable(report.fraudType), incidentAt: nullable(report.incidentAt),
    involvedAmount: nullable(report.involvedAmount), hasLoss: nullable(report.hasLoss),
    incidentNarrative: nullable(report.incidentNarrative), suspiciousPlatform: nullable(report.suspiciousPlatform),
    suspiciousAccount: nullable(report.suspiciousAccount), stillContacting: nullable(report.stillContacting),
    contactPhone: nullable(report.contactPhone), studentRemark: nullable(report.studentRemark),
    riskLevel: nullable(report.riskLevel), riskReasons: Array.isArray(report.riskReasons) ? report.riskReasons : [],
    status: nullable(report.status), submittedAt: nullable(report.submittedAt), hasSourceAlert: Boolean(report.sourceAlertId),
    finalOutcome: nullable(report.finalOutcome), confirmedLossAmount: nullable(report.confirmedLossAmount), closedAt: nullable(report.closedAt),
  };
}

function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId, resourceType = 'user', resourceId = user._id }) {
  return { _id: createAuditId(), actorId: user._id, actorRole: user.role, actorCollegeId: user.collegeId || null,
    action: 'access.denied', resourceType, resourceId, result: 'failure', failureReason: code, requestId, createdAt: serverDate() };
}

function createHandler({ db, getWXContext, serverDate, logger = console, createRequestId = () => crypto.randomUUID(), createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}` }) {
  if (!db || typeof db.collection !== 'function' || typeof getWXContext !== 'function' || typeof serverDate !== 'function') throw new Error('getStudentReportDetail dependencies are incomplete');
  return async function getStudentReportDetail(event) {
    const requestId = createRequestId();
    const denied = async (user, code, message, resourceType, resourceId) => {
      try {
        await db.collection('audit_logs').add({ data: createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId, resourceType, resourceId }) });
        return failure(code, message);
      } catch (error) {
        logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: resourceId || user._id, stage: 'studentReportDetailDeniedAudit' });
        return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
      }
    };
    try {
      const input = validateInput(event);
      if (!input) return failure('INVALID_INPUT', '请求参数无效');
      const context = getWXContext() || {};
      if (getAppId(context) && getAppId(context) !== EXPECTED_APP_ID) return failure('FORBIDDEN', '调用来源不被允许');
      if (!context.OPENID) return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      const student = await findUserByWxIdentityKey(db, `openid:${context.OPENID}`);
      if (!student) return failure('UNBOUND', '当前微信尚未绑定学生身份');
      if (!isTrustedActiveStudent(student, context.OPENID)) {
        const code = student.role !== 'student' ? 'FORBIDDEN' : student.status !== 'active' ? 'ACCOUNT_DISABLED' : 'INTERNAL_ERROR';
        return denied(student, code, code === 'FORBIDDEN' ? '当前身份无权查看学生工单' : '账号当前不可用', 'user', student._id);
      }
      const report = await findById(db, 'fraud_reports', input.reportId);
      if (!report) return failure('NOT_FOUND', '未找到工单');
      if (report.studentId !== student._id) return denied(student, 'FORBIDDEN', '无权查看该工单', 'fraud_report', report._id);
      return success('STUDENT_REPORT_DETAIL_LOADED', { report: studentReportProjection(report) });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'getStudentReportDetail' });
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
exports.__testables = { ACCEPTED_EVENT_KEYS, EXPECTED_APP_ID, TARGET_ENV_ID, createAccessDeniedAuditLog, createDefaultHandler, createHandler, findById, findUserByWxIdentityKey, isTrustedActiveStudent, nullable, studentReportProjection, validateInput };
