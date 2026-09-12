'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const MINI_PROGRAM_ROLES = new Set(['student', 'counselor']);

function success(code, payload = {}) {
  return { ok: true, code, ...payload };
}

function failure(code, message) {
  return { ok: false, code, message };
}

function toProfile(user, collegeName = '') {
  const profile = {
    userId: user._id,
    role: user.role,
    name: user.name,
    collegeId: user.collegeId,
  };
  if (typeof collegeName === 'string' && collegeName.trim()) {
    profile.collegeName = collegeName.trim();
  }
  return profile;
}

async function findUserByWxIdentityKey(db, wxIdentityKey) {
  const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get();
  return Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
}

async function findCollegeName(db, collegeId) {
  if (typeof collegeId !== 'string' || !collegeId.trim()) return '';
  const result = await db.collection('colleges').where({ _id: collegeId }).limit(1).get();
  const college = Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
  return college && typeof college.name === 'string' && college.name.trim() ? college.name.trim() : '';
}

function getAppId(wxContext) {
  return wxContext && (wxContext.APPID || wxContext.appId);
}

function isBoundToTrustedOpenId(user, trustedOpenId) {
  return user.bindStatus === 'bound' &&
    typeof user.wxOpenId === 'string' &&
    user.wxOpenId.length > 0 &&
    user.wxOpenId === trustedOpenId &&
    user.wxIdentityKey === `openid:${trustedOpenId}`;
}

function actorCollegeId(user) {
  return user.role === 'security' ? null : (user.collegeId || null);
}

function createFailureAuditLog({ user, code, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId: user._id,
    actorRole: user.role,
    actorCollegeId: actorCollegeId(user),
    action: 'identity.session',
    resourceType: 'user',
    resourceId: user._id,
    result: 'failure',
    failureReason: code,
    requestId,
    createdAt: serverDate(),
  };
}

function createHandler({
  db,
  getWXContext,
  serverDate,
  logger = console,
  createRequestId = () => crypto.randomUUID(),
  createAuditId = () => crypto.randomUUID(),
}) {
  if (!db || typeof getWXContext !== 'function' || typeof serverDate !== 'function') {
    throw new Error('getMiniProgramSession dependencies are incomplete');
  }

  return async function getMiniProgramSession() {
    const requestId = createRequestId();
    const auditedFailure = async (user, code, message, stage) => {
      try {
        await db.collection('audit_logs').add({
          data: createFailureAuditLog({ user, code, requestId, serverDate, createAuditId }),
        });
        return failure(code, message);
      } catch (error) {
        logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: user._id, stage });
        return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
      }
    };
    try {
      const wxContext = getWXContext() || {};
      const appId = getAppId(wxContext);
      if (appId && appId !== EXPECTED_APP_ID) {
        return failure('FORBIDDEN', '调用来源不被允许');
      }

      if (!wxContext.OPENID) {
        return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      }

      const expectedWxIdentityKey = `openid:${wxContext.OPENID}`;
      const user = await findUserByWxIdentityKey(db, expectedWxIdentityKey);
      if (!user) {
        return success('UNBOUND', { needsBinding: true });
      }

      if (user.role === 'security') {
        return auditedFailure(user, 'FORBIDDEN', '该账号不能通过小程序登录', 'sessionRole');
      }
      if (!MINI_PROGRAM_ROLES.has(user.role)) {
        return auditedFailure(user, 'FORBIDDEN', '账号角色不被允许', 'sessionRole');
      }
      if (user.status !== 'active') {
        return auditedFailure(user, 'ACCOUNT_DISABLED', '账号当前不可用', 'sessionStatus');
      }
      if (!isBoundToTrustedOpenId(user, wxContext.OPENID)) {
        return auditedFailure(user, 'INTERNAL_ERROR', '账号绑定状态异常，请联系管理员', 'sessionBindingConsistency');
      }

      const collegeName = await findCollegeName(db, user.collegeId);

      return success('BOUND', {
        needsBinding: false,
        profile: toProfile(user, collegeName),
      });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'session' });
      return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
    }
  };
}

function createDefaultHandler(cloud = require('wx-server-sdk')) {
  // Delayed loading keeps node:test independent from the CloudBase runtime package.
  // Deployment requires reviewed audit behavior and target audit_logs availability.
  // Before a trusted actor can be resolved, only the desensitized runtime log is permitted.
  cloud.init({ env: TARGET_ENV_ID });
  const db = cloud.database();
  return createHandler({
    db,
    getWXContext: () => cloud.getWXContext(),
    serverDate: () => db.serverDate(),
    logger: console,
    createRequestId: () => crypto.randomUUID(),
    createAuditId: () => crypto.randomUUID(),
  });
}

exports.main = async () => createDefaultHandler()();
exports.__testables = {
  createHandler,
  createDefaultHandler,
  createFailureAuditLog,
  findCollegeName,
  toProfile,
  EXPECTED_APP_ID,
  TARGET_ENV_ID,
};
