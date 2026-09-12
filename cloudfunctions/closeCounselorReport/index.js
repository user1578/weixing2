'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const ACCEPTED_EVENT_KEYS = new Set(['followupId', 'expectedFollowupVersion', 'expectedReportVersion', 'verificationResult', 'closeReason', 'userInfo', 'tcbContext']);
const ALLOWED_RESULTS = new Set(['misreport', 'consultation', 'not_fraud']);

function success(code, payload = {}) { return { ok: true, code, ...payload }; }
function failure(code, message) { return { ok: false, code, message }; }
function businessError(code, message) { const error = new Error(message); error.isBusinessError = true; error.businessCode = code; return error; }
function getAppId(context) { return context && (context.APPID || context.appId); }

function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key))) return null;
  if (typeof event.followupId !== 'string' || typeof event.closeReason !== 'string' || typeof event.verificationResult !== 'string' ||
    !Number.isSafeInteger(event.expectedFollowupVersion) || event.expectedFollowupVersion < 1 ||
    !Number.isSafeInteger(event.expectedReportVersion) || event.expectedReportVersion < 1 || !ALLOWED_RESULTS.has(event.verificationResult)) return null;
  const followupId = event.followupId.trim();
  const closeReason = event.closeReason.trim();
  return followupId && followupId.length <= 128 && closeReason && closeReason.length <= 1000
    ? { followupId, expectedFollowupVersion: event.expectedFollowupVersion, expectedReportVersion: event.expectedReportVersion, verificationResult: event.verificationResult, closeReason }
    : null;
}

function hasCollegeId(user) { return Boolean(user) && typeof user.collegeId === 'string' && Boolean(user.collegeId.trim()); }
function isTrustedActiveCounselor(user, openId) {
  return Boolean(user) && user.role === 'counselor' && user.status === 'active' && hasCollegeId(user) && user.bindStatus === 'bound' &&
    user.wxOpenId === openId && user.wxIdentityKey === `openid:${openId}`;
}
function finalOutcomeFor(result) { return result === 'consultation' ? 'consultation' : 'misreport'; }
function updateCount(result) { return result && result.stats && Number.isInteger(result.stats.updated) ? result.stats.updated : 0; }
function isConflict(error) { return /transaction|conflict|duplicate|unique|already exists/i.test(`${error && error.code || ''} ${error && error.errCode || ''} ${error && error.message || ''}`); }

async function findUserByWxIdentityKey(db, wxIdentityKey) {
  const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get();
  return Array.isArray(result.data) && result.data.length ? result.data[0] : null;
}
async function getById(db, collection, id) {
  const result = await db.collection(collection).doc(id).get();
  return result && result.data ? (Array.isArray(result.data) ? result.data[0] || null : result.data) : null;
}
function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId, resourceType = 'user', resourceId = user._id }) {
  return { _id: createAuditId(), actorId: user._id, actorRole: user.role, actorCollegeId: hasCollegeId(user) ? user.collegeId : null,
    action: 'access.denied', resourceType, resourceId, result: 'failure', failureReason: code, requestId, createdAt: serverDate() };
}
function createCloseAuditLog({ counselor, report, requestId, serverDate, createAuditId }) {
  return { _id: createAuditId(), actorId: counselor._id, actorRole: 'counselor', actorCollegeId: counselor.collegeId,
    action: 'report.counselor_close', resourceType: 'fraud_report', resourceId: report._id, result: 'success',
    beforeSummary: { status: 'pending_counselor_verify', followupStatus: 'in_progress' },
    afterSummary: { status: 'closed', followupStatus: 'completed' }, requestId, createdAt: serverDate() };
}

function createHandler({ db, getWXContext, serverDate, logger = console, createRequestId = () => crypto.randomUUID(), createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}` }) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function' || typeof getWXContext !== 'function' || typeof serverDate !== 'function') throw new Error('closeCounselorReport dependencies are incomplete');
  return async function closeCounselorReport(event) {
    const requestId = createRequestId();
    const log = (stage, resourceId = null) => logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId, stage });
    const denied = async (user, code, message, resourceType, resourceId) => {
      try {
        await db.collection('audit_logs').add({ data: createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId, resourceType, resourceId }) });
        return failure(code, message);
      } catch (error) { log('closeCounselorReportDeniedAudit', resourceId || user._id); return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试'); }
    };
    try {
      const input = validateInput(event);
      if (!input) return failure('INVALID_INPUT', '请求参数无效');
      const context = getWXContext() || {};
      if (getAppId(context) && getAppId(context) !== EXPECTED_APP_ID) return failure('FORBIDDEN', '调用来源不被允许');
      if (!context.OPENID) return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      const counselor = await findUserByWxIdentityKey(db, `openid:${context.OPENID}`);
      if (!counselor) return failure('UNBOUND', '当前微信尚未绑定辅导员身份');
      if (!isTrustedActiveCounselor(counselor, context.OPENID)) {
        const code = counselor.role !== 'counselor' ? 'FORBIDDEN' : counselor.status !== 'active' ? 'ACCOUNT_DISABLED' : 'INTERNAL_ERROR';
        return denied(counselor, code, code === 'FORBIDDEN' ? '当前身份无权结案' : '账号当前不可用', 'user', counselor._id);
      }
      const followup = await getById(db, 'counselor_followups', input.followupId);
      if (!followup) return failure('NOT_FOUND', '跟进记录不存在');
      if (followup.businessType !== 'report' || followup.counselorId !== counselor._id || followup.collegeId !== counselor.collegeId) return denied(counselor, 'FORBIDDEN', '无权操作该跟进记录', 'counselor_followup', followup._id);
      const report = await getById(db, 'fraud_reports', followup.businessId);
      if (!report) return failure('NOT_FOUND', '关联工单不存在');
      if (report.collegeId !== counselor.collegeId || report.currentHandlerId !== counselor._id) return failure('CONFLICT', '工单处理人已变化，请刷新后重试');
      if (report.status !== 'pending_counselor_verify' || followup.status !== 'in_progress' || report.version !== input.expectedReportVersion || followup.version !== input.expectedFollowupVersion) return failure('CONFLICT', '数据已变化，请刷新后重试');
      if (report.riskLevel !== 'low' || report.hasLoss !== false) return failure('INVALID_STATE', '当前工单不满足辅导员直接结案条件');
      try {
        await db.runTransaction(async (transaction) => {
          const currentCounselor = await getById(transaction, 'users', counselor._id);
          if (!isTrustedActiveCounselor(currentCounselor, context.OPENID)) throw businessError('CONFLICT', '辅导员身份已变化');
          const currentFollowup = await getById(transaction, 'counselor_followups', input.followupId);
          if (!currentFollowup || currentFollowup.businessType !== 'report' || currentFollowup.counselorId !== currentCounselor._id || currentFollowup.collegeId !== currentCounselor.collegeId || currentFollowup.status !== 'in_progress' || currentFollowup.version !== input.expectedFollowupVersion) throw businessError('CONFLICT', '跟进记录已变化');
          const currentReport = await getById(transaction, 'fraud_reports', currentFollowup.businessId);
          if (!currentReport || currentReport.collegeId !== currentCounselor.collegeId || currentReport.currentHandlerId !== currentCounselor._id || currentReport.status !== 'pending_counselor_verify' || currentReport.version !== input.expectedReportVersion || currentReport.riskLevel !== 'low' || currentReport.hasLoss !== false) throw businessError('CONFLICT', '工单已变化');
          const followupUpdate = await transaction.collection('counselor_followups').where({ _id: currentFollowup._id, businessType: 'report', businessId: currentReport._id, counselorId: currentCounselor._id, collegeId: currentCounselor.collegeId, status: 'in_progress', version: input.expectedFollowupVersion }).update({ data: {
            status: 'completed', verificationResult: input.verificationResult, completedAt: serverDate(), updatedAt: serverDate(), version: input.expectedFollowupVersion + 1,
          } });
          if (updateCount(followupUpdate) !== 1) throw businessError('CONFLICT', '跟进记录已变化');
          const reportUpdate = await transaction.collection('fraud_reports').where({ _id: currentReport._id, collegeId: currentCounselor.collegeId, currentHandlerId: currentCounselor._id, status: 'pending_counselor_verify', version: input.expectedReportVersion }).update({ data: {
            status: 'closed', finalOutcome: finalOutcomeFor(input.verificationResult), confirmedLossAmount: 0, closeReason: input.closeReason, closedAt: serverDate(), updatedAt: serverDate(), version: input.expectedReportVersion + 1,
          } });
          if (updateCount(reportUpdate) !== 1) throw businessError('CONFLICT', '工单已变化');
          await transaction.collection('audit_logs').add({ data: createCloseAuditLog({ counselor: currentCounselor, report: currentReport, requestId, serverDate, createAuditId }) });
        });
      } catch (error) {
        if (error && error.isBusinessError) return failure(error.businessCode, error.message);
        if (isConflict(error)) return failure('CONFLICT', '数据已变化，请刷新后重试');
        throw error;
      }
      return success('COUNSELOR_REPORT_CLOSED', { report: { reportId: report._id, status: 'closed', version: input.expectedReportVersion + 1 }, followup: { followupId: followup._id, status: 'completed', version: input.expectedFollowupVersion + 1 } });
    } catch (error) { log('closeCounselorReport'); return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试'); }
  };
}

function createDefaultHandler(cloud = require('wx-server-sdk')) {
  cloud.init({ env: TARGET_ENV_ID }); const db = cloud.database();
  return createHandler({ db, getWXContext: () => cloud.getWXContext(), serverDate: () => db.serverDate() });
}
exports.main = async (event) => createDefaultHandler()(event);
exports.__testables = { ACCEPTED_EVENT_KEYS, ALLOWED_RESULTS, EXPECTED_APP_ID, TARGET_ENV_ID, createAccessDeniedAuditLog, createCloseAuditLog, createDefaultHandler, createHandler, finalOutcomeFor, findUserByWxIdentityKey, getById, hasCollegeId, isConflict, isTrustedActiveCounselor, updateCount, validateInput };
