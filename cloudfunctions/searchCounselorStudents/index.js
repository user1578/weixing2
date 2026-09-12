'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const MAX_RESULTS = 20;
const MAX_CANDIDATES = 1000;
const ACCEPTED_EVENT_KEYS = new Set(['keyword', 'userInfo', 'tcbContext']);

function success(code, payload = {}) { return { ok: true, code, ...payload }; }
function failure(code, message) { return { ok: false, code, message }; }
function getAppId(context) { return context && (context.APPID || context.appId); }
function validateInput(event) { if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key)) || typeof event.keyword !== 'string') return null; const keyword = event.keyword.trim(); return keyword && keyword.length <= 64 ? { keyword } : null; }
function hasCollegeId(user) { return Boolean(user) && typeof user.collegeId === 'string' && Boolean(user.collegeId.trim()); }
function isTrustedActiveCounselor(user, openId) { return Boolean(user) && user.role === 'counselor' && user.status === 'active' && user.bindStatus === 'bound' && hasCollegeId(user) && user.wxOpenId === openId && user.wxIdentityKey === `openid:${openId}`; }
async function findUserByWxIdentityKey(db, wxIdentityKey) { const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get(); return Array.isArray(result.data) && result.data.length ? result.data[0] : null; }
function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }) { return { _id: createAuditId(), actorId: user._id, actorRole: user.role, actorCollegeId: hasCollegeId(user) ? user.collegeId : null, action: 'access.denied', resourceType: 'user', resourceId: user._id, result: 'failure', failureReason: code, requestId, createdAt: serverDate() }; }
function matchesKeyword(student, keyword) { const lowerKeyword = keyword.toLowerCase(); return [student.name, student.studentNo].some((value) => typeof value === 'string' && value.toLowerCase().includes(lowerKeyword)); }
function toStudent(student) { return { studentId: student._id, name: student.name, studentNo: student.studentNo, focusFlag: student.focusFlag === true, focusReason: typeof student.focusReason === 'string' ? student.focusReason : null, version: student.version }; }

function createHandler({ db, getWXContext, serverDate, logger = console, createRequestId = () => crypto.randomUUID(), createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}` }) {
  if (!db || typeof db.collection !== 'function' || typeof getWXContext !== 'function' || typeof serverDate !== 'function') throw new Error('searchCounselorStudents dependencies are incomplete');
  return async function searchCounselorStudents(event) {
    const requestId = createRequestId();
    const denied = async (user, code, message) => {
      try { await db.collection('audit_logs').add({ data: createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }) }); return failure(code, message); }
      catch (error) { logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: user._id, stage: 'searchCounselorStudentsDeniedAudit' }); return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试'); }
    };
    try {
      const input = validateInput(event);
      if (!input) return failure('INVALID_INPUT', '请输入 1 至 64 个字符的姓名或学号');
      const context = getWXContext() || {};
      if (getAppId(context) && getAppId(context) !== EXPECTED_APP_ID) return failure('FORBIDDEN', '调用来源不被允许');
      if (!context.OPENID) return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      const counselor = await findUserByWxIdentityKey(db, `openid:${context.OPENID}`);
      if (!counselor) return failure('UNBOUND', '当前微信尚未绑定辅导员身份');
      if (!isTrustedActiveCounselor(counselor, context.OPENID)) {
        const code = counselor.role !== 'counselor' ? 'FORBIDDEN' : counselor.status !== 'active' ? 'ACCOUNT_DISABLED' : 'INTERNAL_ERROR';
        return denied(counselor, code, code === 'FORBIDDEN' ? '当前身份无权搜索学生' : '账号当前不可用');
      }
      const result = await db.collection('users').where({ collegeId: counselor.collegeId, role: 'student' }).limit(MAX_CANDIDATES).get();
      const students = (Array.isArray(result.data) ? result.data : []).filter((student) => matchesKeyword(student, input.keyword)).slice(0, MAX_RESULTS).map(toStudent);
      return success('COUNSELOR_STUDENTS_FOUND', { students });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'searchCounselorStudents' });
      return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
    }
  };
}

function createDefaultHandler(cloud = require('wx-server-sdk')) { cloud.init({ env: TARGET_ENV_ID }); const db = cloud.database(); return createHandler({ db, getWXContext: () => cloud.getWXContext(), serverDate: () => db.serverDate() }); }
exports.main = async (event) => createDefaultHandler()(event);
exports.__testables = { ACCEPTED_EVENT_KEYS, EXPECTED_APP_ID, MAX_CANDIDATES, MAX_RESULTS, TARGET_ENV_ID, createAccessDeniedAuditLog, createDefaultHandler, createHandler, findUserByWxIdentityKey, hasCollegeId, isTrustedActiveCounselor, matchesKeyword, toStudent, validateInput };
