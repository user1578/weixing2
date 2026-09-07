'use strict';

const EXPECTED_APP_ID = 'wxe262970211858262';
const MINI_PROGRAM_ROLES = new Set(['student', 'counselor']);

function success(code, payload = {}) {
  return { ok: true, code, ...payload };
}

function failure(code, message) {
  return { ok: false, code, message };
}

function toProfile(user) {
  return {
    userId: user._id,
    role: user.role,
    name: user.name,
    collegeId: user.collegeId,
    focusFlag: user.focusFlag,
  };
}

async function findUserByWxIdentityKey(db, wxIdentityKey) {
  const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get();
  return Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
}

function getAppId(wxContext) {
  return wxContext && (wxContext.APPID || wxContext.appId);
}

function createHandler({ db, getWXContext, logger = console, createRequestId = () => 'session' }) {
  if (!db || typeof getWXContext !== 'function') {
    throw new Error('getMiniProgramSession dependencies are incomplete');
  }

  return async function getMiniProgramSession() {
    const requestId = createRequestId();
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
        return failure('FORBIDDEN', '该账号不能通过小程序登录');
      }
      if (!MINI_PROGRAM_ROLES.has(user.role)) {
        return failure('FORBIDDEN', '账号角色不被允许');
      }
      if (user.status !== 'active') {
        return failure('ACCOUNT_DISABLED', '账号当前不可用');
      }
      if (
        user.bindStatus !== 'bound' ||
        !user.wxOpenId ||
        user.wxIdentityKey !== expectedWxIdentityKey
      ) {
        logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: user._id });
        return failure('INTERNAL_ERROR', '账号绑定状态异常，请联系管理员');
      }

      return success('BOUND', {
        needsBinding: false,
        profile: toProfile(user),
      });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null });
      return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
    }
  };
}

function createDefaultHandler() {
  // Delayed loading keeps node:test independent from the CloudBase runtime package.
  const cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  const db = cloud.database();
  return createHandler({
    db,
    getWXContext: () => cloud.getWXContext(),
    logger: console,
    createRequestId: () => require('crypto').randomUUID(),
  });
}

exports.main = async () => createDefaultHandler()();
exports.__testables = { createHandler, toProfile, EXPECTED_APP_ID };
