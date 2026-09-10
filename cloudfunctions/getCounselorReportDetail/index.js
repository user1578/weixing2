'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const MAX_REPORT_ID_LENGTH = 128;
const ACCEPTED_EVENT_KEYS = new Set(['reportId', 'userInfo', 'tcbContext']);

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
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key))) return null;
  if (typeof event.reportId !== 'string') return null;
  const reportId = event.reportId.trim();
  return reportId && reportId.length <= MAX_REPORT_ID_LENGTH ? { reportId } : null;
}

function hasCollegeId(user) {
  return typeof user.collegeId === 'string' && user.collegeId.trim().length > 0;
}

function isBoundToTrustedOpenId(user, trustedOpenId) {
  return user && user.bindStatus === 'bound' &&
    typeof user.wxOpenId === 'string' && user.wxOpenId.length > 0 &&
    user.wxOpenId === trustedOpenId &&
    user.wxIdentityKey === `openid:${trustedOpenId}`;
}

function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId, resourceType = 'user', resourceId = user._id }) {
  return {
    _id: createAuditId(),
    actorId: user._id,
    actorRole: user.role,
    actorCollegeId: hasCollegeId(user) ? user.collegeId : null,
    action: 'access.denied',
    resourceType,
    resourceId,
    result: 'failure',
    failureReason: code,
    requestId,
    createdAt: serverDate(),
  };
}

function createSensitiveViewAuditLog({ counselor, report, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId: counselor._id,
    actorRole: 'counselor',
    actorCollegeId: counselor.collegeId,
    action: 'report.view_sensitive',
    resourceType: 'fraud_report',
    resourceId: report._id,
    result: 'success',
    requestId,
    createdAt: serverDate(),
  };
}

function nullable(value) {
  return value === undefined ? null : value;
}

function toDetail(report, student) {
  return {
    reportId: report._id,
    fraudType: nullable(report.fraudType),
    incidentAt: nullable(report.incidentAt),
    involvedAmount: nullable(report.involvedAmount),
    hasLoss: nullable(report.hasLoss),
    incidentNarrative: nullable(report.incidentNarrative),
    suspiciousPlatform: nullable(report.suspiciousPlatform),
    suspiciousAccount: nullable(report.suspiciousAccount),
    stillContacting: nullable(report.stillContacting),
    contactPhone: nullable(report.contactPhone),
    studentRemark: nullable(report.studentRemark),
    riskLevel: nullable(report.riskLevel),
    riskReasons: Array.isArray(report.riskReasons) ? report.riskReasons : [],
    status: nullable(report.status),
    submittedAt: nullable(report.submittedAt),
    version: nullable(report.version),
    sourceAlertId: nullable(report.sourceAlertId),
    student: {
      name: nullable(student.name),
      studentNo: nullable(student.studentNo),
      focusFlag: nullable(student.focusFlag),
    },
  };
}

async function findUserByWxIdentityKey(db, wxIdentityKey) {
  const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get();
  return Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
}

async function findById(db, collection, id) {
  const result = await db.collection(collection).doc(id).get();
  return result && result.data ? result.data : null;
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
    throw new Error('getCounselorReportDetail dependencies are incomplete');
  }

  return async function getCounselorReportDetail(event) {
    const requestId = createRequestId();
    const auditedIdentityFailure = async (user, code, message, stage, resourceType, resourceId) => {
      try {
        await db.collection('audit_logs').add({
          data: createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId, resourceType, resourceId }),
        });
        return failure(code, message);
      } catch (error) {
        logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: resourceId || user._id, stage });
        return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
      }
    };

    try {
      const input = validateInput(event);
      if (!input) return failure('INVALID_INPUT', '请求参数无效');

      const wxContext = getWXContext() || {};
      const appId = getAppId(wxContext);
      if (appId && appId !== EXPECTED_APP_ID) return failure('FORBIDDEN', '调用来源不被允许');
      if (!wxContext.OPENID) return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');

      const counselor = await findUserByWxIdentityKey(db, `openid:${wxContext.OPENID}`);
      if (!counselor) return failure('UNBOUND', '当前微信尚未绑定辅导员身份');
      if (counselor.role !== 'counselor') {
        return auditedIdentityFailure(counselor, 'FORBIDDEN', '当前账号不能查看辅导员工单', 'counselorReportDetailRole');
      }
      if (counselor.status !== 'active') {
        return auditedIdentityFailure(counselor, 'ACCOUNT_DISABLED', '账号当前不可用', 'counselorReportDetailStatus');
      }
      if (!isBoundToTrustedOpenId(counselor, wxContext.OPENID) || !hasCollegeId(counselor)) {
        return auditedIdentityFailure(counselor, 'INTERNAL_ERROR', '账号绑定状态异常，请联系管理员', 'counselorReportDetailBindingConsistency');
      }

      const report = await findById(db, 'fraud_reports', input.reportId);
      if (!report) return failure('NOT_FOUND', '未找到工单');
      if (report.collegeId !== counselor.collegeId) {
        return auditedIdentityFailure(counselor, 'FORBIDDEN', '无权查看其他学院工单', 'counselorReportDetailCollegeScope', 'fraud_report', report._id);
      }

      const student = await findById(db, 'users', report.studentId);
      if (!student) return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');

      try {
        await db.collection('audit_logs').add({
          data: createSensitiveViewAuditLog({ counselor, report, requestId, serverDate, createAuditId }),
        });
      } catch (error) {
        logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: report._id, stage: 'counselorReportDetailAudit' });
        return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
      }

      return success('COUNSELOR_REPORT_DETAIL_LOADED', { report: toDetail(report, student) });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'getCounselorReportDetail' });
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
  ACCEPTED_EVENT_KEYS,
  EXPECTED_APP_ID,
  MAX_REPORT_ID_LENGTH,
  TARGET_ENV_ID,
  createAccessDeniedAuditLog,
  createDefaultHandler,
  createHandler,
  createSensitiveViewAuditLog,
  findById,
  findUserByWxIdentityKey,
  hasCollegeId,
  isBoundToTrustedOpenId,
  nullable,
  toDetail,
  validateInput,
};
