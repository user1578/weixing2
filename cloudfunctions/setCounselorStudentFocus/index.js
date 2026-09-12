'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const ACCEPTED_EVENT_KEYS = new Set(['studentId', 'focusFlag', 'focusReason', 'expectedVersion', 'userInfo', 'tcbContext']);

function success(code, payload = {}) { return { ok: true, code, ...payload }; }
function failure(code, message) { return { ok: false, code, message }; }
function businessError(code, message) { const error = new Error(message); error.isBusinessError = true; error.businessCode = code; return error; }
function getAppId(context) { return context && (context.APPID || context.appId); }
function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key)) || typeof event.studentId !== 'string' || typeof event.focusFlag !== 'boolean' || !Number.isSafeInteger(event.expectedVersion) || event.expectedVersion < 1) return null;
  const studentId = event.studentId.trim();
  const rawReason = typeof event.focusReason === 'string' ? event.focusReason.trim() : '';
  if (!studentId || studentId.length > 128) return null;
  if (event.focusFlag && (!rawReason || rawReason.length > 500)) return null;
  if (!event.focusFlag && event.focusReason !== undefined && event.focusReason !== null && rawReason) return null;
  return { studentId, focusFlag: event.focusFlag, focusReason: event.focusFlag ? rawReason : null, expectedVersion: event.expectedVersion };
}
function hasCollegeId(user) { return Boolean(user) && typeof user.collegeId === 'string' && Boolean(user.collegeId.trim()); }
function isTrustedActiveCounselor(user, openId) { return Boolean(user) && user.role === 'counselor' && user.status === 'active' && user.bindStatus === 'bound' && hasCollegeId(user) && user.wxOpenId === openId && user.wxIdentityKey === `openid:${openId}`; }
function updateCount(result) { return result && result.stats && Number.isInteger(result.stats.updated) ? result.stats.updated : 0; }
function isConflict(error) { return /transaction|conflict|duplicate|unique|already exists/i.test(`${error && error.code || ''} ${error && error.errCode || ''} ${error && error.message || ''}`); }
async function findUserByWxIdentityKey(db, wxIdentityKey) { const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get(); return Array.isArray(result.data) && result.data.length ? result.data[0] : null; }
async function getById(db, collection, id) { const result = await db.collection(collection).doc(id).get(); return result && result.data ? (Array.isArray(result.data) ? result.data[0] || null : result.data) : null; }
function createAccessDeniedAuditLog({ counselor, code, resourceId, requestId, serverDate, createAuditId }) { return { _id: createAuditId(), actorId: counselor._id, actorRole: 'counselor', actorCollegeId: counselor.collegeId, action: 'access.denied', resourceType: 'user', resourceId, result: 'failure', failureReason: code, requestId, createdAt: serverDate() }; }
function createFocusAuditLog({ counselor, student, beforeFocusFlag, afterFocusFlag, requestId, serverDate, createAuditId }) { return { _id: createAuditId(), actorId: counselor._id, actorRole: 'counselor', actorCollegeId: counselor.collegeId, action: 'student.focus_update', resourceType: 'user', resourceId: student._id, result: 'success', beforeSummary: { focusFlag: beforeFocusFlag }, afterSummary: { focusFlag: afterFocusFlag }, requestId, createdAt: serverDate() }; }

function createHandler({ db, getWXContext, serverDate, logger = console, createRequestId = () => crypto.randomUUID(), createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}` }) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function' || typeof getWXContext !== 'function' || typeof serverDate !== 'function') throw new Error('setCounselorStudentFocus dependencies are incomplete');
  return async function setCounselorStudentFocus(event) {
    const requestId = createRequestId();
    const denied = async (counselor, code, message, resourceId = counselor._id) => {
      try { await db.collection('audit_logs').add({ data: createAccessDeniedAuditLog({ counselor, code, resourceId, requestId, serverDate, createAuditId }) }); return failure(code, message); }
      catch (error) { logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId, stage: 'setCounselorStudentFocusDeniedAudit' }); return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试'); }
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
        return denied(counselor, code, code === 'FORBIDDEN' ? '当前身份无权管理重点关注学生' : '账号当前不可用');
      }
      const target = await getById(db, 'users', input.studentId);
      if (!target) return failure('NOT_FOUND', '学生不存在');
      if (target.role !== 'student' || target.collegeId !== counselor.collegeId) return denied(counselor, 'FORBIDDEN', '不能操作其他学院学生', input.studentId);
      if (target.version !== input.expectedVersion) return failure('CONFLICT', '学生信息已变化，请刷新后重试');
      try {
        await db.runTransaction(async (transaction) => {
          const currentCounselor = await getById(transaction, 'users', counselor._id);
          if (!isTrustedActiveCounselor(currentCounselor, context.OPENID)) throw businessError('CONFLICT', '辅导员身份已变化');
          const currentStudent = await getById(transaction, 'users', input.studentId);
          if (!currentStudent || currentStudent.role !== 'student' || currentStudent.collegeId !== currentCounselor.collegeId || currentStudent.version !== input.expectedVersion) throw businessError('CONFLICT', '学生信息已变化，请刷新后重试');
          const update = await transaction.collection('users').where({ _id: currentStudent._id, role: 'student', collegeId: currentCounselor.collegeId, version: input.expectedVersion }).update({ data: { focusFlag: input.focusFlag, focusReason: input.focusReason, version: input.expectedVersion + 1, updatedAt: serverDate() } });
          if (updateCount(update) !== 1) throw businessError('CONFLICT', '学生信息已变化，请刷新后重试');
          await transaction.collection('audit_logs').add({ data: createFocusAuditLog({ counselor: currentCounselor, student: currentStudent, beforeFocusFlag: currentStudent.focusFlag === true, afterFocusFlag: input.focusFlag, requestId, serverDate, createAuditId }) });
        });
      } catch (error) {
        if (error && error.isBusinessError) return failure(error.businessCode, error.message);
        if (isConflict(error)) return failure('CONFLICT', '学生信息已变化，请刷新后重试');
        throw error;
      }
      return success('COUNSELOR_STUDENT_FOCUS_UPDATED', { student: { studentId: input.studentId, focusFlag: input.focusFlag, focusReason: input.focusReason, version: input.expectedVersion + 1 } });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'setCounselorStudentFocus' });
      return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
    }
  };
}

function createDefaultHandler(cloud = require('wx-server-sdk')) { cloud.init({ env: TARGET_ENV_ID }); const db = cloud.database(); return createHandler({ db, getWXContext: () => cloud.getWXContext(), serverDate: () => db.serverDate() }); }
exports.main = async (event) => createDefaultHandler()(event);
exports.__testables = { ACCEPTED_EVENT_KEYS, EXPECTED_APP_ID, TARGET_ENV_ID, businessError, createAccessDeniedAuditLog, createDefaultHandler, createFocusAuditLog, createHandler, findUserByWxIdentityKey, getById, hasCollegeId, isConflict, isTrustedActiveCounselor, updateCount, validateInput };
