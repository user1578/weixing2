'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const MAX_FOLLOWUP_ID_LENGTH = 128;
const MAX_TRANSFER_REASON_LENGTH = 500;
const ACCEPTED_EVENT_KEYS = new Set([
  'followupId', 'expectedFollowupVersion', 'expectedReportVersion',
  'verificationResult', 'transferReason', 'userInfo', 'tcbContext',
]);
const CONTACT_METHODS = new Set(['phone', 'wechat', 'in_person', 'other']);
const VERIFICATION_RESULTS = new Set(['confirmed', 'suspected', 'misreport', 'consultation', 'not_fraud']);

function success(code, payload = {}) { return { ok: true, code, ...payload }; }
function failure(code, message) { return { ok: false, code, message }; }

function businessError(code, message) {
  const error = new Error(message);
  error.isBusinessError = true;
  error.businessCode = code;
  return error;
}

function getAppId(wxContext) { return wxContext && (wxContext.APPID || wxContext.appId); }

function isValidDate(value) { return value instanceof Date && !Number.isNaN(value.getTime()); }

function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key))) return null;
  if (typeof event.followupId !== 'string' || typeof event.transferReason !== 'string' ||
    !Number.isSafeInteger(event.expectedFollowupVersion) || event.expectedFollowupVersion < 1 ||
    !Number.isSafeInteger(event.expectedReportVersion) || event.expectedReportVersion < 1 ||
    typeof event.verificationResult !== 'string' || !VERIFICATION_RESULTS.has(event.verificationResult)) return null;
  const followupId = event.followupId.trim();
  const transferReason = event.transferReason.trim();
  if (!followupId || followupId.length > MAX_FOLLOWUP_ID_LENGTH ||
    !transferReason || transferReason.length > MAX_TRANSFER_REASON_LENGTH) return null;
  return {
    followupId,
    expectedFollowupVersion: event.expectedFollowupVersion,
    expectedReportVersion: event.expectedReportVersion,
    verificationResult: event.verificationResult,
    transferReason,
  };
}

function hasCollegeId(user) {
  return user && typeof user.collegeId === 'string' && user.collegeId.trim().length > 0;
}

function isBoundToTrustedOpenId(user, trustedOpenId) {
  return user && user.bindStatus === 'bound' && typeof user.wxOpenId === 'string' && user.wxOpenId.length > 0 &&
    user.wxOpenId === trustedOpenId && user.wxIdentityKey === `openid:${trustedOpenId}`;
}

function isTrustedActiveCounselor(user, trustedOpenId) {
  return user && user.role === 'counselor' && user.status === 'active' &&
    isBoundToTrustedOpenId(user, trustedOpenId) && hasCollegeId(user);
}

function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId, resourceType = 'user', resourceId = user._id }) {
  return {
    _id: createAuditId(), actorId: user._id, actorRole: user.role,
    actorCollegeId: hasCollegeId(user) ? user.collegeId : null,
    action: 'access.denied', resourceType, resourceId, result: 'failure', failureReason: code,
    requestId, createdAt: serverDate(),
  };
}

function createTransferAuditLog({ counselor, report, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(), actorId: counselor._id, actorRole: 'counselor', actorCollegeId: counselor.collegeId,
    action: 'report.transfer_to_security', resourceType: 'fraud_report', resourceId: report._id, result: 'success',
    beforeSummary: { status: 'pending_counselor_verify', followupStatus: 'in_progress' },
    afterSummary: { status: 'pending_security_verify', followupStatus: 'completed' },
    requestId, createdAt: serverDate(),
  };
}

async function findUserByWxIdentityKey(db, wxIdentityKey) {
  const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get();
  return Array.isArray(result.data) && result.data.length ? result.data[0] : null;
}

async function getById(dbOrTransaction, collection, id) {
  const result = await dbOrTransaction.collection(collection).doc(id).get();
  return result && result.data ? result.data : null;
}

function updateCount(result) {
  return result && result.stats && Number.isInteger(result.stats.updated) ? result.stats.updated : 0;
}

function isFollowupReadyForTransfer(followup) {
  return followup && followup.status === 'in_progress' && isValidDate(followup.contactedAt) &&
    CONTACT_METHODS.has(followup.contactMethod) && typeof followup.opinion === 'string' && followup.opinion.trim().length > 0;
}

function isAlreadyTransferred(followup, report, input) {
  return followup && report && followup.status === 'completed' && followup.transferToSecurity === true &&
    followup.verificationResult === input.verificationResult && typeof followup.transferReason === 'string' &&
    followup.transferReason.trim() === input.transferReason && report.status === 'pending_security_verify';
}

function isConflict(error) {
  const text = `${error && error.code ? error.code : ''} ${error && error.errCode ? error.errCode : ''} ${error && error.message ? error.message : ''}`.toLowerCase();
  return text.includes('transaction') || text.includes('conflict') || text.includes('duplicate') || text.includes('unique') || text.includes('already exists');
}

function createHandler({
  db, getWXContext, serverDate, logger = console,
  createRequestId = () => crypto.randomUUID(), createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function' ||
    typeof getWXContext !== 'function' || typeof serverDate !== 'function') {
    throw new Error('transferCounselorReportToSecurity dependencies are incomplete');
  }

  return async function transferCounselorReportToSecurity(event) {
    const requestId = createRequestId();
    const log = (code, resourceId, stage) => logger.error({ requestId, code, resourceId: resourceId || null, stage });
    const denied = async (user, code, message, stage, resourceType, resourceId) => {
      try {
        await db.collection('audit_logs').add({ data: createAccessDeniedAuditLog({
          user, code, requestId, serverDate, createAuditId, resourceType, resourceId,
        }) });
        return failure(code, message);
      } catch (error) {
        log('INTERNAL_ERROR', resourceId || user._id, stage);
        return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
      }
    };

    try {
      const input = validateInput(event);
      if (!input) return failure('INVALID_INPUT', '请求参数无效');
      const wxContext = getWXContext() || {};
      const appId = getAppId(wxContext);
      if (appId && appId !== EXPECTED_APP_ID) return failure('FORBIDDEN', '调用来源不被允许');
      const trustedOpenId = wxContext.OPENID;
      if (!trustedOpenId) return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      const counselor = await findUserByWxIdentityKey(db, `openid:${trustedOpenId}`);
      if (!counselor) return failure('UNBOUND', '当前微信尚未绑定辅导员身份');
      if (counselor.role !== 'counselor') {
        return denied(counselor, 'FORBIDDEN', '当前账号不能转交辅导员工单', 'counselorRole');
      }
      if (counselor.status !== 'active') {
        return denied(counselor, 'ACCOUNT_DISABLED', '账号当前不可用', 'counselorStatus');
      }
      if (!isBoundToTrustedOpenId(counselor, trustedOpenId) || !hasCollegeId(counselor)) {
        return denied(counselor, 'INTERNAL_ERROR', '账号绑定状态异常，请联系管理员', 'counselorBindingConsistency');
      }

      const followup = await getById(db, 'counselor_followups', input.followupId);
      if (!followup) return failure('NOT_FOUND', '跟进记录不存在');
      if (followup.businessType !== 'report') return failure('INVALID_STATE', '当前跟进记录不能转交');
      if (followup.collegeId !== counselor.collegeId || followup.counselorId !== counselor._id) {
        return denied(counselor, 'FORBIDDEN', '无权操作该跟进记录', 'followupOwnership', 'counselor_followup', followup._id);
      }
      const report = await getById(db, 'fraud_reports', followup.businessId);
      if (!report) return failure('NOT_FOUND', '关联工单不存在');
      if (report.collegeId !== counselor.collegeId) {
        return denied(counselor, 'FORBIDDEN', '无权操作其他学院工单', 'reportCollegeScope', 'fraud_report', report._id);
      }
      if (report.currentHandlerId !== counselor._id) return failure('CONFLICT', '工单处理人已变化，请刷新后重试');

      if (isAlreadyTransferred(followup, report, input)) {
        return success('REPORT_ALREADY_TRANSFERRED', {
          followup: { followupId: followup._id, status: 'completed', version: followup.version },
          report: { reportId: report._id, status: 'pending_security_verify', version: report.version },
        });
      }
      if (followup.status === 'completed') return failure('CONFLICT', '跟进记录已变化，请刷新后重试');
      if (!isFollowupReadyForTransfer(followup)) return failure('INVALID_STATE', '当前跟进记录未满足转交条件');
      if (report.status !== 'pending_counselor_verify') return failure('INVALID_STATE', '当前工单状态不能转交');
      if (followup.version !== input.expectedFollowupVersion || report.version !== input.expectedReportVersion) {
        return failure('CONFLICT', '数据已变化，请刷新后重试');
      }

      try {
        await db.runTransaction(async (transaction) => {
          const currentCounselor = await getById(transaction, 'users', counselor._id);
          if (!isTrustedActiveCounselor(currentCounselor, trustedOpenId)) throw businessError('CONFLICT', '辅导员身份已变化');
          const currentFollowup = await getById(transaction, 'counselor_followups', input.followupId);
          if (!currentFollowup || currentFollowup.businessType !== 'report' ||
            currentFollowup.counselorId !== currentCounselor._id || currentFollowup.collegeId !== currentCounselor.collegeId ||
            currentFollowup.businessId !== report._id || !isFollowupReadyForTransfer(currentFollowup) ||
            currentFollowup.version !== input.expectedFollowupVersion) {
            throw businessError('CONFLICT', '跟进记录已变化');
          }
          const currentReport = await getById(transaction, 'fraud_reports', report._id);
          if (!currentReport || currentReport.collegeId !== currentCounselor.collegeId ||
            currentReport.currentHandlerId !== currentCounselor._id || currentReport.status !== 'pending_counselor_verify' ||
            currentReport.version !== input.expectedReportVersion) {
            throw businessError('CONFLICT', '关联工单已变化');
          }

          const followupUpdate = await transaction.collection('counselor_followups').where({
            _id: currentFollowup._id, businessType: 'report', businessId: currentReport._id,
            counselorId: currentCounselor._id, collegeId: currentCounselor.collegeId,
            status: 'in_progress', version: input.expectedFollowupVersion,
          }).update({ data: {
            status: 'completed', verificationResult: input.verificationResult, transferToSecurity: true,
            transferReason: input.transferReason, version: input.expectedFollowupVersion + 1,
            updatedAt: serverDate(), completedAt: serverDate(),
          } });
          if (updateCount(followupUpdate) !== 1) throw businessError('CONFLICT', '跟进记录已变化');

          const reportUpdate = await transaction.collection('fraud_reports').where({
            _id: currentReport._id, collegeId: currentCounselor.collegeId, currentHandlerId: currentCounselor._id,
            status: 'pending_counselor_verify', version: input.expectedReportVersion,
          }).update({ data: {
            status: 'pending_security_verify', version: input.expectedReportVersion + 1, updatedAt: serverDate(),
          } });
          if (updateCount(reportUpdate) !== 1) throw businessError('CONFLICT', '关联工单已变化');
          await transaction.collection('audit_logs').add({ data: createTransferAuditLog({
            counselor: currentCounselor, report: currentReport, requestId, serverDate, createAuditId,
          }) });
        });
      } catch (error) {
        if (error && error.isBusinessError) return failure(error.businessCode, error.message);
        if (isConflict(error)) return failure('CONFLICT', '数据已变化，请刷新后重试');
        throw error;
      }
      return success('COUNSELOR_REPORT_TRANSFERRED', {
        followup: { followupId: followup._id, status: 'completed', version: input.expectedFollowupVersion + 1 },
        report: { reportId: report._id, status: 'pending_security_verify', version: input.expectedReportVersion + 1 },
      });
    } catch (error) {
      log('INTERNAL_ERROR', null, 'transferCounselorReportToSecurity');
      return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
    }
  };
}

function createDefaultHandler(cloud = require('wx-server-sdk')) {
  cloud.init({ env: TARGET_ENV_ID });
  const db = cloud.database();
  return createHandler({ db, getWXContext: () => cloud.getWXContext(), serverDate: () => db.serverDate(), logger: console });
}

exports.main = async (event) => createDefaultHandler()(event);
exports.__testables = {
  ACCEPTED_EVENT_KEYS, CONTACT_METHODS, EXPECTED_APP_ID, MAX_FOLLOWUP_ID_LENGTH, MAX_TRANSFER_REASON_LENGTH,
  TARGET_ENV_ID, VERIFICATION_RESULTS, createAccessDeniedAuditLog, createDefaultHandler, createHandler,
  createTransferAuditLog, findUserByWxIdentityKey, getById, hasCollegeId, isAlreadyTransferred,
  isBoundToTrustedOpenId, isConflict, isFollowupReadyForTransfer, isTrustedActiveCounselor, isValidDate,
  updateCount, validateInput,
};
