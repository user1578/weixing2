'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const ACCEPTED_EVENT_KEYS = new Set(['followupId', 'expectedVersion', 'contactedAt', 'contactMethod', 'userInfo', 'tcbContext']);
const CONTACT_METHODS = new Set(['phone', 'wechat', 'in_person', 'other']);
const FOLLOWUP_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const MAX_FUTURE_CONTACT_MS = 5 * 60 * 1000;
const ISO_8601_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

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

function parseContactedAt(value, now) {
  if (typeof value !== 'string' || !isValidDate(now)) return null;
  const normalized = value.trim();
  const match = ISO_8601_PATTERN.exec(normalized);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return null;
  const contactedAt = new Date(normalized);
  if (!isValidDate(contactedAt) || contactedAt.getTime() > now.getTime() + MAX_FUTURE_CONTACT_MS) return null;
  return contactedAt;
}

function validateInput(event, now) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key))) return null;
  if (typeof event.followupId !== 'string' || !Number.isSafeInteger(event.expectedVersion) || event.expectedVersion < 1 ||
    typeof event.contactMethod !== 'string' || !CONTACT_METHODS.has(event.contactMethod)) return null;
  const followupId = event.followupId.trim();
  if (!followupId || followupId.length > 128) return null;
  const contactedAt = parseContactedAt(event.contactedAt, now);
  return contactedAt ? { followupId, expectedVersion: event.expectedVersion, contactedAt, contactMethod: event.contactMethod } : null;
}

function hasCollegeId(user) { return user && typeof user.collegeId === 'string' && user.collegeId.trim().length > 0; }

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
    _id: createAuditId(), actorId: user._id, actorRole: user.role, actorCollegeId: hasCollegeId(user) ? user.collegeId : null,
    action: 'access.denied', resourceType, resourceId, result: 'failure', failureReason: code, requestId, createdAt: serverDate(),
  };
}

function createProgressAuditLog({ counselor, followup, contactMethod, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(), actorId: counselor._id, actorRole: 'counselor', actorCollegeId: counselor.collegeId,
    action: 'followup.progress', resourceType: 'counselor_followup', resourceId: followup._id, result: 'success',
    beforeSummary: { status: 'pending' }, afterSummary: { status: 'in_progress', contactMethod },
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

function toMillis(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? Number.NaN : parsed.getTime();
  }
  return Number.NaN;
}

function hasSameContact(followup, input) {
  return followup && followup.contactMethod === input.contactMethod && toMillis(followup.contactedAt) === input.contactedAt.getTime();
}

function isConflict(error) {
  const text = `${error && error.code ? error.code : ''} ${error && error.errCode ? error.errCode : ''} ${error && error.message ? error.message : ''}`.toLowerCase();
  return text.includes('transaction') || text.includes('conflict') || text.includes('duplicate') || text.includes('unique') || text.includes('already exists');
}

function createHandler({
  db, getWXContext, serverDate, now = () => new Date(), logger = console,
  createRequestId = () => crypto.randomUUID(), createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function' ||
    typeof getWXContext !== 'function' || typeof serverDate !== 'function' || typeof now !== 'function') {
    throw new Error('progressCounselorFollowup dependencies are incomplete');
  }
  return async function progressCounselorFollowup(event) {
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
      const requestNow = now();
      if (!isValidDate(requestNow)) throw new Error('invalid server time');
      const input = validateInput(event, requestNow);
      if (!input) return failure('INVALID_INPUT', '请求参数无效');
      const wxContext = getWXContext() || {};
      const appId = getAppId(wxContext);
      if (appId && appId !== EXPECTED_APP_ID) return failure('FORBIDDEN', '调用来源不被允许');
      const trustedOpenId = wxContext.OPENID;
      if (!trustedOpenId) return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      const counselor = await findUserByWxIdentityKey(db, `openid:${trustedOpenId}`);
      if (!counselor) return failure('UNBOUND', '当前微信尚未绑定辅导员身份');
      if (counselor.role !== 'counselor') return denied(counselor, 'FORBIDDEN', '当前账号不能推进辅导员跟进', 'counselorRole');
      if (counselor.status !== 'active') return denied(counselor, 'ACCOUNT_DISABLED', '账号当前不可用', 'counselorStatus');
      if (!isBoundToTrustedOpenId(counselor, trustedOpenId) || !hasCollegeId(counselor)) {
        return denied(counselor, 'INTERNAL_ERROR', '账号绑定状态异常，请联系管理员', 'counselorBindingConsistency');
      }

      const followup = await getById(db, 'counselor_followups', input.followupId);
      if (!followup) return failure('NOT_FOUND', '跟进记录不存在');
      if (followup.businessType !== 'report') return failure('INVALID_STATE', '当前跟进记录不能推进');
      if (followup.collegeId !== counselor.collegeId || followup.counselorId !== counselor._id) {
        return denied(counselor, 'FORBIDDEN', '无权操作该跟进记录', 'followupOwnership', 'counselor_followup', followup._id);
      }
      const report = await getById(db, 'fraud_reports', followup.businessId);
      if (!report) return failure('NOT_FOUND', '关联工单不存在');
      if (report.collegeId !== counselor.collegeId) {
        return denied(counselor, 'FORBIDDEN', '无权操作其他学院工单', 'reportCollegeScope', 'fraud_report', report._id);
      }
      if (report.currentHandlerId !== counselor._id) return failure('CONFLICT', '工单处理人已变化，请刷新后重试');
      if (report.status !== 'pending_counselor_verify') return failure('INVALID_STATE', '当前工单状态不能推进跟进');

      if (followup.status === 'in_progress') {
        if (hasSameContact(followup, input)) return success('FOLLOWUP_ALREADY_IN_PROGRESS', { followup: {
          followupId: followup._id, reportId: followup.businessId, status: 'in_progress', version: followup.version,
        } });
        return failure('CONFLICT', '跟进记录已变化，请刷新后重试');
      }
      if (followup.status === 'completed' || !FOLLOWUP_STATUSES.has(followup.status)) return failure('INVALID_STATE', '当前跟进状态不能推进');
      if (followup.version !== input.expectedVersion) return failure('CONFLICT', '跟进记录已变化，请刷新后重试');

      try {
        await db.runTransaction(async (transaction) => {
          const currentCounselor = await getById(transaction, 'users', counselor._id);
          if (!isTrustedActiveCounselor(currentCounselor, trustedOpenId)) throw businessError('CONFLICT', '辅导员身份已变化');
          const currentFollowup = await getById(transaction, 'counselor_followups', input.followupId);
          if (!currentFollowup || currentFollowup.businessType !== 'report' || currentFollowup.counselorId !== currentCounselor._id ||
            currentFollowup.collegeId !== currentCounselor.collegeId || currentFollowup.status !== 'pending' ||
            currentFollowup.version !== input.expectedVersion) throw businessError('CONFLICT', '跟进记录已变化');
          const currentReport = await getById(transaction, 'fraud_reports', currentFollowup.businessId);
          if (!currentReport || currentReport.collegeId !== currentCounselor.collegeId ||
            currentReport.currentHandlerId !== currentCounselor._id || currentReport.status !== 'pending_counselor_verify') {
            throw businessError('CONFLICT', '关联工单已变化');
          }
          const updateResult = await transaction.collection('counselor_followups').where({
            _id: currentFollowup._id, businessType: 'report', businessId: currentReport._id, counselorId: currentCounselor._id,
            collegeId: currentCounselor.collegeId, status: 'pending', version: input.expectedVersion,
          }).update({ data: {
            status: 'in_progress', contactedAt: input.contactedAt, contactMethod: input.contactMethod,
            version: input.expectedVersion + 1, updatedAt: serverDate(),
          } });
          if (updateCount(updateResult) !== 1) throw businessError('CONFLICT', '跟进记录已变化');
          await transaction.collection('audit_logs').add({ data: createProgressAuditLog({
            counselor: currentCounselor, followup: currentFollowup, contactMethod: input.contactMethod, requestId, serverDate, createAuditId,
          }) });
        });
      } catch (error) {
        if (error && error.isBusinessError) return failure(error.businessCode, error.message);
        if (isConflict(error)) return failure('CONFLICT', '数据已变化，请刷新后重试');
        throw error;
      }
      return success('COUNSELOR_FOLLOWUP_IN_PROGRESS', { followup: {
        followupId: followup._id, reportId: followup.businessId, status: 'in_progress', version: input.expectedVersion + 1,
      } });
    } catch (error) {
      log('INTERNAL_ERROR', null, 'progressCounselorFollowup');
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
  ACCEPTED_EVENT_KEYS, CONTACT_METHODS, EXPECTED_APP_ID, FOLLOWUP_STATUSES, ISO_8601_PATTERN, MAX_FUTURE_CONTACT_MS, TARGET_ENV_ID,
  createAccessDeniedAuditLog, createDefaultHandler, createHandler, createProgressAuditLog, findUserByWxIdentityKey, getById,
  hasCollegeId, hasSameContact, isBoundToTrustedOpenId, isConflict, isTrustedActiveCounselor, parseContactedAt, toMillis, updateCount, validateInput,
};
