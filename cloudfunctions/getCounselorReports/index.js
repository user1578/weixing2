'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const MAX_REPORTS = 100;
const ACCEPTED_EVENT_KEYS = new Set(['scope', 'userInfo', 'tcbContext']);
const REPORT_SCOPES = new Set(['pending', 'following', 'history']);
const RISK_PRIORITY = { high: 0, medium: 1, low: 2 };

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
  if (event === undefined || event === null) return 'pending';
  if (typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key))) return null;
  if (!Object.hasOwn(event, 'scope')) return 'pending';
  return typeof event.scope === 'string' && REPORT_SCOPES.has(event.scope) ? event.scope : null;
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

function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId: user._id,
    actorRole: user.role,
    actorCollegeId: hasCollegeId(user) ? user.collegeId : null,
    action: 'access.denied',
    resourceType: 'user',
    resourceId: user._id,
    result: 'failure',
    failureReason: code,
    requestId,
    createdAt: serverDate(),
  };
}

function toListItem(report, workflow = null) {
  const item = {
    reportId: report._id,
    fraudType: report.fraudType,
    riskLevel: report.riskLevel,
    status: report.status,
    submittedAt: report.submittedAt,
    hasSourceAlert: Boolean(report.sourceAlertId),
  };
  if (workflow) {
    item.followupId = workflow._id;
    item.followupStatus = workflow.status;
    item.followupVersion = workflow.version;
    item.reportVersion = report.version;
  }
  return item;
}

function compareReports(left, right) {
  const riskDifference = (RISK_PRIORITY[left.riskLevel] ?? Number.MAX_SAFE_INTEGER) -
    (RISK_PRIORITY[right.riskLevel] ?? Number.MAX_SAFE_INTEGER);
  if (riskDifference !== 0) return riskDifference;

  const leftTime = new Date(left.submittedAt).getTime();
  const rightTime = new Date(right.submittedAt).getTime();
  const normalizedLeftTime = Number.isNaN(leftTime) ? Number.MAX_SAFE_INTEGER : leftTime;
  const normalizedRightTime = Number.isNaN(rightTime) ? Number.MAX_SAFE_INTEGER : rightTime;
  if (normalizedLeftTime !== normalizedRightTime) return normalizedLeftTime - normalizedRightTime;
  return String(left._id).localeCompare(String(right._id));
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
    throw new Error('getCounselorReports dependencies are incomplete');
  }

  return async function getCounselorReports(event) {
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
      const scope = validateInput(event);
      if (!scope) return failure('INVALID_INPUT', '请求参数无效');

      const wxContext = getWXContext() || {};
      const appId = getAppId(wxContext);
      if (appId && appId !== EXPECTED_APP_ID) return failure('FORBIDDEN', '调用来源不被允许');
      if (!wxContext.OPENID) return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');

      const counselor = await findUserByWxIdentityKey(db, `openid:${wxContext.OPENID}`);
      if (!counselor) return failure('UNBOUND', '当前微信尚未绑定辅导员身份');
      if (counselor.role !== 'counselor') {
        return auditedIdentityFailure(counselor, 'FORBIDDEN', '当前账号不能查看辅导员工单', 'counselorReportsRole');
      }
      if (counselor.status !== 'active') {
        return auditedIdentityFailure(counselor, 'ACCOUNT_DISABLED', '账号当前不可用', 'counselorReportsStatus');
      }
      if (!isBoundToTrustedOpenId(counselor, wxContext.OPENID) || !hasCollegeId(counselor)) {
        return auditedIdentityFailure(counselor, 'INTERNAL_ERROR', '账号绑定状态异常，请联系管理员', 'counselorReportsBindingConsistency');
      }

      let reports = [];
      if (scope === 'pending') {
        const result = await db.collection('fraud_reports').where({
          collegeId: counselor.collegeId,
          status: 'pending_counselor_verify',
        }).orderBy('submittedAt', 'desc').limit(MAX_REPORTS).get();
        reports = (Array.isArray(result.data) ? result.data : []).sort(compareReports).map(toListItem);
      } else if (scope === 'following') {
        const [reportsResult, followupsResult] = await Promise.all([
          db.collection('fraud_reports').where({ collegeId: counselor.collegeId, currentHandlerId: counselor._id, status: 'pending_counselor_verify' })
            .orderBy('submittedAt', 'desc').limit(MAX_REPORTS).get(),
          db.collection('counselor_followups').where({ businessType: 'report', counselorId: counselor._id, collegeId: counselor.collegeId }).limit(MAX_REPORTS).get(),
        ]);
        const activeFollowups = new Map((Array.isArray(followupsResult.data) ? followupsResult.data : [])
          .filter((followup) => followup && (followup.status === 'pending' || followup.status === 'in_progress'))
          .map((followup) => [followup.businessId, followup]));
        reports = (Array.isArray(reportsResult.data) ? reportsResult.data : [])
          .filter((report) => activeFollowups.has(report._id)).sort(compareReports)
          .map((report) => toListItem(report, activeFollowups.get(report._id)));
      } else {
        const statuses = ['pending_security_verify', 'in_process', 'closed'];
        const resultSets = await Promise.all(statuses.map((status) => db.collection('fraud_reports').where({
          collegeId: counselor.collegeId, status,
        }).orderBy('submittedAt', 'desc').limit(MAX_REPORTS).get()));
        reports = resultSets.flatMap((result) => Array.isArray(result.data) ? result.data : [])
          .sort((left, right) => {
            const leftTime = new Date(left.submittedAt).getTime() || 0;
            const rightTime = new Date(right.submittedAt).getTime() || 0;
            return rightTime - leftTime || String(left._id).localeCompare(String(right._id));
          }).slice(0, MAX_REPORTS).map(toListItem);
      }
      return success('COUNSELOR_REPORTS_LOADED', { reports });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'getCounselorReports' });
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
  MAX_REPORTS,
  RISK_PRIORITY,
  REPORT_SCOPES,
  TARGET_ENV_ID,
  compareReports,
  createAccessDeniedAuditLog,
  createDefaultHandler,
  createHandler,
  findUserByWxIdentityKey,
  hasCollegeId,
  isBoundToTrustedOpenId,
  toListItem,
  validateInput,
};
