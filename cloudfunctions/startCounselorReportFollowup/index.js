'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const ACCEPTED_EVENT_KEYS = new Set(['reportId', 'expectedVersion', 'opinion', 'userInfo', 'tcbContext']);
const PENDING_FOLLOWUP_STATUSES = new Set(['pending', 'in_progress']);

function success(code, payload = {}) { return { ok: true, code, ...payload }; }
function failure(code, message) { return { ok: false, code, message }; }

function businessError(code, message) {
  const error = new Error(message);
  error.isBusinessError = true;
  error.businessCode = code;
  return error;
}

function getAppId(wxContext) { return wxContext && (wxContext.APPID || wxContext.appId); }

function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key))) return null;
  if (typeof event.reportId !== 'string' || typeof event.opinion !== 'string') return null;
  const reportId = event.reportId.trim();
  const opinion = event.opinion.trim();
  if (!reportId || reportId.length > 128 || !opinion || opinion.length > 1000) return null;
  if (!Number.isSafeInteger(event.expectedVersion) || event.expectedVersion < 1) return null;
  return { reportId, expectedVersion: event.expectedVersion, opinion };
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

function createFollowupStartAuditLog({ counselor, report, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(), actorId: counselor._id, actorRole: 'counselor', actorCollegeId: counselor.collegeId,
    action: 'report.followup_start', resourceType: 'fraud_report', resourceId: report._id, result: 'success',
    beforeSummary: { status: 'pending_counselor_verify', currentHandlerAssigned: false },
    afterSummary: { status: 'pending_counselor_verify', currentHandlerAssigned: true, followupStatus: 'pending' },
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

async function findUnfinishedFollowups(db, reportId, counselorId) {
  const result = await db.collection('counselor_followups').where({
    businessType: 'report', businessId: reportId, counselorId,
  }).get();
  return (Array.isArray(result.data) ? result.data : []).filter((followup) => followup && PENDING_FOLLOWUP_STATUSES.has(followup.status));
}

function updateCount(result) {
  return result && result.stats && Number.isInteger(result.stats.updated) ? result.stats.updated : 0;
}

function makeFollowup({ followupId, report, counselor, opinion, serverDate }) {
  return {
    _id: followupId, businessType: 'report', businessId: report._id,
    studentId: report.studentId, collegeId: report.collegeId, counselorId: counselor._id,
    status: 'pending', opinion, contactedAt: null, contactMethod: null,
    focusFlag: false, transferToSecurity: false, version: 1,
    createdAt: serverDate(), updatedAt: serverDate(),
  };
}

function isConflict(error) {
  const text = `${error && error.code ? error.code : ''} ${error && error.errCode ? error.errCode : ''} ${error && error.message ? error.message : ''}`.toLowerCase();
  return text.includes('transaction') || text.includes('conflict') || text.includes('duplicate') || text.includes('unique') || text.includes('already exists');
}

function createHandler({
  db, getWXContext, serverDate, logger = console,
  createRequestId = () => crypto.randomUUID(),
  createFollowupId = () => `followup_${crypto.randomUUID().replace(/-/g, '')}`,
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function' ||
    typeof getWXContext !== 'function' || typeof serverDate !== 'function') {
    throw new Error('startCounselorReportFollowup dependencies are incomplete');
  }
  return async function startCounselorReportFollowup(event) {
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
      if (counselor.role !== 'counselor') return denied(counselor, 'FORBIDDEN', '当前账号不能开始辅导员跟进', 'counselorRole');
      if (counselor.status !== 'active') return denied(counselor, 'ACCOUNT_DISABLED', '账号当前不可用', 'counselorStatus');
      if (!isBoundToTrustedOpenId(counselor, trustedOpenId) || !hasCollegeId(counselor)) {
        return denied(counselor, 'INTERNAL_ERROR', '账号绑定状态异常，请联系管理员', 'counselorBindingConsistency');
      }

      const report = await getById(db, 'fraud_reports', input.reportId);
      if (!report) return failure('NOT_FOUND', '工单不存在');
      if (report.collegeId !== counselor.collegeId) {
        return denied(counselor, 'FORBIDDEN', '无权操作其他学院工单', 'reportCollegeScope', 'fraud_report', report._id);
      }
      if (report.status !== 'pending_counselor_verify') return failure('INVALID_STATE', '当前工单状态不能开始跟进');
      if (report.version !== input.expectedVersion) return failure('CONFLICT', '工单已变化，请刷新后重试');
      if (report.currentHandlerId !== undefined && report.currentHandlerId !== null && report.currentHandlerId !== counselor._id) {
        return failure('CONFLICT', '工单已由其他辅导员跟进');
      }
      if (report.currentHandlerId === counselor._id) {
        const existing = await findUnfinishedFollowups(db, report._id, counselor._id);
        if (existing.length === 1) return success('FOLLOWUP_ALREADY_STARTED', { followup: {
          followupId: existing[0]._id, status: existing[0].status, reportId: report._id,
        } });
        return failure('INTERNAL_ERROR', '工单跟进数据异常，请联系管理员');
      }

      const followupId = createFollowupId();
      try {
        await db.runTransaction(async (transaction) => {
          const currentCounselor = await getById(transaction, 'users', counselor._id);
          if (!isTrustedActiveCounselor(currentCounselor, trustedOpenId)) throw businessError('CONFLICT', '辅导员身份已变化');
          const currentReport = await getById(transaction, 'fraud_reports', input.reportId);
          if (!currentReport || currentReport.collegeId !== currentCounselor.collegeId ||
            currentReport.status !== 'pending_counselor_verify' || currentReport.version !== input.expectedVersion ||
            (currentReport.currentHandlerId !== undefined && currentReport.currentHandlerId !== null)) {
            throw businessError('CONFLICT', '工单已变化');
          }
          const followup = makeFollowup({ followupId, report: currentReport, counselor: currentCounselor, opinion: input.opinion, serverDate });
          await transaction.collection('counselor_followups').add({ data: followup });
          const updateResult = await transaction.collection('fraud_reports').where({
            _id: currentReport._id, version: input.expectedVersion, status: 'pending_counselor_verify', currentHandlerId: null,
          }).update({ data: { currentHandlerId: currentCounselor._id, version: input.expectedVersion + 1, updatedAt: serverDate() } });
          if (updateCount(updateResult) !== 1) throw businessError('CONFLICT', '工单已变化');
          await transaction.collection('audit_logs').add({ data: createFollowupStartAuditLog({
            counselor: currentCounselor, report: currentReport, requestId, serverDate, createAuditId,
          }) });
        });
      } catch (error) {
        if (error && error.isBusinessError) return failure(error.businessCode, error.message);
        if (isConflict(error)) return failure('CONFLICT', '数据已变化，请刷新后重试');
        throw error;
      }
      return success('COUNSELOR_FOLLOWUP_STARTED', {
        followup: { followupId, reportId: report._id, status: 'pending' },
        report: { reportId: report._id, status: 'pending_counselor_verify', version: input.expectedVersion + 1 },
      });
    } catch (error) {
      log('INTERNAL_ERROR', null, 'startCounselorReportFollowup');
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
  ACCEPTED_EVENT_KEYS, EXPECTED_APP_ID, TARGET_ENV_ID, PENDING_FOLLOWUP_STATUSES,
  createAccessDeniedAuditLog, createDefaultHandler, createFollowupStartAuditLog, createHandler,
  findUnfinishedFollowups, findUserByWxIdentityKey, getById, hasCollegeId, isBoundToTrustedOpenId,
  isConflict, isTrustedActiveCounselor, makeFollowup, updateCount, validateInput,
};
