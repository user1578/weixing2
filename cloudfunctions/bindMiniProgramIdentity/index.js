'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const ALLOWED_ROLES = new Set(['student', 'counselor']);
const ALLOWED_INPUT_KEYS = new Set(['role', 'identityNo', 'name']);

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

function businessError(code, message) {
  const error = new Error(message);
  error.isBusinessError = true;
  error.businessCode = code;
  return error;
}

function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return null;
  }
  if (Object.keys(event).some((key) => !ALLOWED_INPUT_KEYS.has(key))) {
    return null;
  }
  if (!ALLOWED_ROLES.has(event.role)) {
    return null;
  }
  if (typeof event.identityNo !== 'string' || typeof event.name !== 'string') {
    return null;
  }

  const identityNo = event.identityNo.trim();
  const name = event.name.trim();
  if (!identityNo || !name) {
    return null;
  }
  return { role: event.role, identityNo, name };
}

function getAppId(wxContext) {
  return wxContext && (wxContext.APPID || wxContext.appId);
}

function isNull(value) {
  return value === null || typeof value === 'undefined';
}

async function findOne(dbOrTransaction, query) {
  const result = await dbOrTransaction.collection('users').where(query).limit(1).get();
  return Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
}

async function findById(transaction, userId) {
  const result = await transaction.collection('users').doc(userId).get();
  return result && result.data ? result.data : null;
}

function validateTargetForBinding(user, input, expectedWxIdentityKey) {
  if (!user) {
    return failure('IDENTITY_NOT_FOUND', '未找到对应的演示身份档案');
  }
  if (user.role !== input.role || user.name !== input.name) {
    return failure('IDENTITY_MISMATCH', '身份信息不匹配');
  }
  if (user.status !== 'active') {
    return failure('ACCOUNT_DISABLED', '账号当前不可用');
  }
  if (user.bindStatus === 'bound') {
    return failure('ACCOUNT_ALREADY_BOUND', '该身份档案已经绑定其他微信');
  }
  if (
    user.bindStatus !== 'unbound' ||
    !isNull(user.wxOpenId) ||
    user.wxIdentityKey !== `unbound:${user._id}`
  ) {
    return failure('CONFLICT', '身份档案状态异常，请联系管理员');
  }
  if (user.wxIdentityKey === expectedWxIdentityKey) {
    return failure('WECHAT_ALREADY_BOUND', '当前微信已被绑定');
  }
  return null;
}

function validateExistingBinding(user, expectedWxIdentityKey) {
  if (user.role === 'security' || !ALLOWED_ROLES.has(user.role)) {
    return failure('FORBIDDEN', '该账号不能通过小程序登录');
  }
  if (user.status !== 'active') {
    return failure('ACCOUNT_DISABLED', '账号当前不可用');
  }
  if (
    user.bindStatus !== 'bound' ||
    !user.wxOpenId ||
    user.wxIdentityKey !== expectedWxIdentityKey
  ) {
    return failure('INTERNAL_ERROR', '账号绑定状态异常，请联系管理员');
  }
  return success('ALREADY_BOUND', { profile: toProfile(user) });
}

function createAuditLog({ user, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId: user._id,
    actorRole: user.role,
    actorCollegeId: user.collegeId || null,
    action: 'identity.bind',
    resourceType: 'user',
    resourceId: user._id,
    result: 'success',
    afterSummary: { bindStatus: 'bound' },
    requestId,
    createdAt: serverDate(),
  };
}

function isUniqueConflict(error) {
  const value = `${error && error.code ? error.code : ''} ${error && error.errCode ? error.errCode : ''} ${error && error.message ? error.message : ''}`.toLowerCase();
  return value.includes('e11000') || value.includes('duplicate') || value.includes('unique');
}

function isTransactionConflict(error) {
  const value = `${error && error.code ? error.code : ''} ${error && error.errCode ? error.errCode : ''} ${error && error.message ? error.message : ''}`.toLowerCase();
  return value.includes('transaction') || value.includes('conflict') || value.includes('write conflict');
}

function createHandler({
  db,
  getWXContext,
  bindingMode = () => process.env.MINIPROGRAM_BINDING_MODE,
  serverDate,
  createRequestId = () => crypto.randomUUID(),
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
  logger = console,
}) {
  if (!db || typeof db.runTransaction !== 'function' || typeof getWXContext !== 'function' || typeof serverDate !== 'function') {
    throw new Error('bindMiniProgramIdentity dependencies are incomplete');
  }

  return async function bindMiniProgramIdentity(event) {
    const requestId = createRequestId();
    let resourceId = null;
    try {
      if (bindingMode() !== 'demo') {
        return failure('BINDING_DISABLED', '当前环境未开启演示身份绑定');
      }

      const input = validateInput(event);
      if (!input) {
        return failure('INVALID_INPUT', '请输入有效的角色、学号或工号及姓名');
      }

      const wxContext = getWXContext() || {};
      const appId = getAppId(wxContext);
      if (appId && appId !== EXPECTED_APP_ID) {
        return failure('FORBIDDEN', '调用来源不被允许');
      }
      if (!wxContext.OPENID) {
        return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      }

      const expectedWxIdentityKey = `openid:${wxContext.OPENID}`;
      const existingBinding = await findOne(db, { wxIdentityKey: expectedWxIdentityKey });
      if (existingBinding) {
        resourceId = existingBinding._id;
        return validateExistingBinding(existingBinding, expectedWxIdentityKey);
      }

      const identityKey = `${input.role === 'student' ? 'student' : 'counselor'}:${input.identityNo}`;
      const target = await findOne(db, { identityKey });
      const targetFailure = validateTargetForBinding(target, input, expectedWxIdentityKey);
      if (targetFailure) {
        resourceId = target && target._id;
        return targetFailure;
      }
      resourceId = target._id;

      const profile = await db.runTransaction(async (transaction) => {
        const current = await findById(transaction, target._id);
        const transactionFailure = validateTargetForBinding(current, input, expectedWxIdentityKey);
        if (transactionFailure) {
          throw businessError(transactionFailure.code, transactionFailure.message);
        }
        if (current.version !== target.version) {
          throw businessError('CONFLICT', '身份档案已被更新，请重试');
        }

        const updatedUser = {
          ...current,
          wxOpenId: wxContext.OPENID,
          wxIdentityKey: expectedWxIdentityKey,
          bindStatus: 'bound',
          version: current.version + 1,
          updatedAt: serverDate(),
        };

        await transaction.collection('users').doc(current._id).update({
          data: {
            wxOpenId: updatedUser.wxOpenId,
            wxIdentityKey: updatedUser.wxIdentityKey,
            bindStatus: updatedUser.bindStatus,
            version: updatedUser.version,
            updatedAt: updatedUser.updatedAt,
          },
        });
        await transaction.collection('audit_logs').add({
          data: createAuditLog({
            user: current,
            requestId,
            serverDate,
            createAuditId,
          }),
        });
        return toProfile(updatedUser);
      });

      return success('BOUND', { needsBinding: false, profile });
    } catch (error) {
      if (error && error.isBusinessError) {
        return failure(error.businessCode, error.message);
      }
      const code = isUniqueConflict(error)
        ? 'WECHAT_ALREADY_BOUND'
        : isTransactionConflict(error)
          ? 'CONFLICT'
          : 'INTERNAL_ERROR';
      logger.error({ requestId, code, resourceId });
      return failure(code, code === 'INTERNAL_ERROR' ? '服务暂时不可用，请稍后重试' : '操作未完成，请重试');
    }
  };
}

function createDefaultHandler() {
  // 此验证方式仅供课程演示；真实上线必须替换为可信身份核验方案。
  // DEPLOYMENT BLOCKED UNTIL audit_logs EXISTS.
  const cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
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
  createHandler,
  createAuditLog,
  validateInput,
  toProfile,
  EXPECTED_APP_ID,
};
