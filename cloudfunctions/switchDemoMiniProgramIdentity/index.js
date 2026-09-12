'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const DEMO_STUDENT_ID = 'usr_student_demo_001';
const DEMO_COUNSELOR_ID = 'usr_counselor_demo_001';
const DEMO_COLLEGE_ID = 'college_cs';
const TARGET_ID_BY_ROLE = Object.freeze({
  student: DEMO_STUDENT_ID,
  counselor: DEMO_COUNSELOR_ID,
});
const EXPECTED_ROLE_BY_ID = Object.freeze({
  [DEMO_STUDENT_ID]: 'student',
  [DEMO_COUNSELOR_ID]: 'counselor',
});
const ACCEPTED_EVENT_KEYS = new Set(['targetRole', 'userInfo', 'tcbContext']);

function success(code, payload = {}) {
  return { ok: true, code, ...payload };
}

function failure(code, message) {
  return { ok: false, code, message };
}

function businessError(code, message) {
  const error = new Error(message);
  error.isBusinessError = true;
  error.businessCode = code;
  return error;
}

function getAppId(wxContext) {
  return wxContext && (wxContext.APPID || wxContext.appId);
}

function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key))) return null;
  return Object.prototype.hasOwnProperty.call(TARGET_ID_BY_ROLE, event.targetRole)
    ? { targetRole: event.targetRole, targetId: TARGET_ID_BY_ROLE[event.targetRole] }
    : null;
}

function toProfile(user) {
  return {
    userId: user._id,
    role: user.role,
    name: user.name,
    collegeId: user.collegeId,
  };
}

function isExpectedDemoUser(user) {
  return user && EXPECTED_ROLE_BY_ID[user._id] === user.role && user.collegeId === DEMO_COLLEGE_ID;
}

function hasValidVersion(user) {
  return user && Number.isSafeInteger(user.version) && user.version > 0;
}

function actorCollegeId(current) {
  if (!current || current.role === 'security') return null;
  if ((current.role === 'student' || current.role === 'counselor') &&
    typeof current.collegeId === 'string' && current.collegeId.trim().length > 0) {
    return current.collegeId;
  }
  return null;
}

function isBoundToTrustedOpenId(user, trustedOpenId) {
  return user && user.bindStatus === 'bound' &&
    typeof user.wxOpenId === 'string' && user.wxOpenId.length > 0 &&
    user.wxOpenId === trustedOpenId &&
    user.wxIdentityKey === `openid:${trustedOpenId}`;
}

function isExpectedUnboundDemoUser(user, targetRole) {
  return isExpectedDemoUser(user) && user.role === targetRole && user.status === 'active' &&
    user.bindStatus === 'unbound' && user.wxOpenId === null &&
    user.wxIdentityKey === `unbound:${user._id}`;
}

function validateCurrentUser(user, trustedOpenId) {
  if (!user) return failure('UNBOUND', '当前微信尚未绑定演示身份');
  if (!isExpectedDemoUser(user)) return failure('FORBIDDEN', '当前账号不允许使用演示身份切换');
  if (user.status !== 'active') return failure('ACCOUNT_DISABLED', '账号当前不可用');
  if (!hasValidVersion(user)) return failure('INTERNAL_ERROR', '账号档案状态异常，请联系管理员');
  if (!isBoundToTrustedOpenId(user, trustedOpenId)) {
    return failure('INTERNAL_ERROR', '账号绑定状态异常，请联系管理员');
  }
  return null;
}

function validateTargetUser(user, targetRole) {
  if (!user) return failure('NOT_FOUND', '未找到目标演示身份');
  if (!isExpectedDemoUser(user) || user.role !== targetRole) {
    return failure('INTERNAL_ERROR', '目标身份档案状态异常，请联系管理员');
  }
  if (user.status !== 'active') return failure('ACCOUNT_DISABLED', '目标账号当前不可用');
  if (!hasValidVersion(user)) return failure('INTERNAL_ERROR', '目标身份档案状态异常，请联系管理员');
  if (user.bindStatus !== 'unbound' || user.wxOpenId !== null || user.wxIdentityKey !== `unbound:${user._id}`) {
    return failure('CONFLICT', '目标身份档案当前不可切换');
  }
  return null;
}

function createSwitchAuditLog({ current, target, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId: current._id,
    actorRole: current.role,
    actorCollegeId: actorCollegeId(current),
    action: 'identity.demo_switch',
    resourceType: 'user',
    resourceId: target._id,
    result: 'success',
    beforeSummary: { activeRole: current.role },
    afterSummary: { activeRole: target.role },
    requestId,
    createdAt: serverDate(),
  };
}

function createFailureAuditLog({ current, code, resourceId, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId: current._id,
    actorRole: current.role,
    actorCollegeId: actorCollegeId(current),
    action: 'identity.demo_switch',
    resourceType: 'user',
    resourceId: resourceId || current._id,
    result: 'failure',
    failureReason: code,
    requestId,
    createdAt: serverDate(),
  };
}

function updatedCount(result) {
  if (result && typeof result.updated === 'number') return result.updated;
  if (result && result.stats && typeof result.stats.updated === 'number') return result.stats.updated;
  return 0;
}

function isUniqueConflict(error) {
  const value = `${error && error.code ? error.code : ''} ${error && error.errCode ? error.errCode : ''} ${error && error.message ? error.message : ''}`.toLowerCase();
  return value.includes('e11000') || value.includes('duplicate') || value.includes('unique');
}

function isTransactionConflict(error) {
  const value = `${error && error.code ? error.code : ''} ${error && error.errCode ? error.errCode : ''} ${error && error.message ? error.message : ''}`.toLowerCase();
  return value.includes('transaction') || value.includes('conflict') || value.includes('write conflict');
}

async function findUserByWxIdentityKey(db, wxIdentityKey) {
  const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get();
  return Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
}

async function findById(dbOrTransaction, userId) {
  const result = await dbOrTransaction.collection('users').doc(userId).get();
  return result && result.data ? result.data : null;
}

function createHandler({
  db,
  getWXContext,
  bindingMode = () => process.env.MINIPROGRAM_BINDING_MODE,
  switchEnabled = () => process.env.DEMO_IDENTITY_SWITCH_ENABLED,
  serverDate,
  logger = console,
  createRequestId = () => crypto.randomUUID(),
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function' ||
    typeof getWXContext !== 'function' || typeof serverDate !== 'function') {
    throw new Error('switchDemoMiniProgramIdentity dependencies are incomplete');
  }

  return async function switchDemoMiniProgramIdentity(event) {
    const requestId = createRequestId();
    let resourceId = null;
    const auditedFailure = async (current, code, message, stage, rejectedResourceId) => {
      try {
        await db.collection('audit_logs').add({
          data: createFailureAuditLog({
            current,
            code,
            resourceId: rejectedResourceId,
            requestId,
            serverDate,
            createAuditId,
          }),
        });
        return failure(code, message);
      } catch (error) {
        logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: rejectedResourceId || current._id, stage });
        return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
      }
    };

    try {
      if (bindingMode() !== 'demo' || switchEnabled() !== 'true') {
        return failure('SWITCH_DISABLED', '当前环境未开启演示身份切换');
      }

      const input = validateInput(event);
      if (!input) return failure('INVALID_INPUT', '请求参数无效');

      const wxContext = getWXContext() || {};
      const appId = getAppId(wxContext);
      if (appId && appId !== EXPECTED_APP_ID) return failure('FORBIDDEN', '调用来源不被允许');
      if (!wxContext.OPENID) return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');

      const trustedOpenId = wxContext.OPENID;
      const current = await findUserByWxIdentityKey(db, `openid:${trustedOpenId}`);
      resourceId = current && current._id;
      const currentFailure = validateCurrentUser(current, trustedOpenId);
      if (currentFailure) {
        return current
          ? auditedFailure(current, currentFailure.code, currentFailure.message, 'switchCurrentValidation')
          : currentFailure;
      }

      if (current.role === input.targetRole) {
        return success('ALREADY_ACTIVE', { profile: toProfile(current) });
      }

      const target = await findById(db, input.targetId);
      resourceId = target ? target._id : input.targetId;
      const targetFailure = validateTargetUser(target, input.targetRole);
      if (targetFailure) {
        return auditedFailure(current, targetFailure.code, targetFailure.message, 'switchTargetValidation', resourceId);
      }

      const profile = await db.runTransaction(async (transaction) => {
        const transactionCurrent = await findById(transaction, current._id);
        const transactionTarget = await findById(transaction, target._id);
        const transactionCurrentFailure = validateCurrentUser(transactionCurrent, trustedOpenId);
        if (transactionCurrentFailure) throw businessError('CONFLICT', '当前身份档案已被更新，请重试');
        const transactionTargetFailure = validateTargetUser(transactionTarget, input.targetRole);
        if (transactionTargetFailure) throw businessError('CONFLICT', '目标身份档案已被更新，请重试');
        if (transactionCurrent.version !== current.version || transactionTarget.version !== target.version) {
          throw businessError('CONFLICT', '身份档案已被更新，请重试');
        }

        const currentUpdatedAt = serverDate();
        const releaseResult = await transaction.collection('users').where({
          _id: transactionCurrent._id,
          version: transactionCurrent.version,
          bindStatus: 'bound',
          wxOpenId: trustedOpenId,
          wxIdentityKey: `openid:${trustedOpenId}`,
        }).update({
          data: {
            wxOpenId: null,
            wxIdentityKey: `unbound:${transactionCurrent._id}`,
            bindStatus: 'unbound',
            version: transactionCurrent.version + 1,
            updatedAt: currentUpdatedAt,
          },
        });
        if (updatedCount(releaseResult) !== 1) {
          throw businessError('CONFLICT', '当前身份档案已被更新，请重试');
        }

        const targetUpdatedAt = serverDate();
        const bindResult = await transaction.collection('users').where({
          _id: transactionTarget._id,
          version: transactionTarget.version,
          bindStatus: 'unbound',
          wxOpenId: null,
          wxIdentityKey: `unbound:${transactionTarget._id}`,
        }).update({
          data: {
            wxOpenId: trustedOpenId,
            wxIdentityKey: `openid:${trustedOpenId}`,
            bindStatus: 'bound',
            version: transactionTarget.version + 1,
            updatedAt: targetUpdatedAt,
          },
        });
        if (updatedCount(bindResult) !== 1) {
          throw businessError('CONFLICT', '目标身份档案已被更新，请重试');
        }

        const updatedTarget = {
          ...transactionTarget,
          wxOpenId: trustedOpenId,
          wxIdentityKey: `openid:${trustedOpenId}`,
          bindStatus: 'bound',
          version: transactionTarget.version + 1,
          updatedAt: targetUpdatedAt,
        };
        await transaction.collection('audit_logs').add({
          data: createSwitchAuditLog({ current: transactionCurrent, target: transactionTarget, requestId, serverDate, createAuditId }),
        });
        return toProfile(updatedTarget);
      });

      return success('IDENTITY_SWITCHED', { profile });
    } catch (error) {
      if (error && error.isBusinessError) return failure(error.businessCode, error.message);
      const code = isUniqueConflict(error) || isTransactionConflict(error) ? 'CONFLICT' : 'INTERNAL_ERROR';
      logger.error({ requestId, code, resourceId, stage: 'demoIdentitySwitch' });
      return failure(code, code === 'CONFLICT' ? '身份档案已被更新，请重试' : '服务暂时不可用，请稍后重试');
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

function createDisabledHandler() {
  return async function switchDemoMiniProgramIdentityDisabled() {
    return failure('SWITCH_DISABLED', '身份切换功能已停用');
  };
}

// The historical demo implementation remains below testable helpers only. The deployed
// entry point intentionally has no CloudBase dependency or identity side effect.
exports.main = createDisabledHandler();
exports.__testables = {
  ACCEPTED_EVENT_KEYS,
  DEMO_COLLEGE_ID,
  DEMO_COUNSELOR_ID,
  DEMO_STUDENT_ID,
  EXPECTED_APP_ID,
  EXPECTED_ROLE_BY_ID,
  TARGET_ENV_ID,
  TARGET_ID_BY_ROLE,
  actorCollegeId,
  createDefaultHandler,
  createDisabledHandler,
  createFailureAuditLog,
  createHandler,
  createSwitchAuditLog,
  findById,
  findUserByWxIdentityKey,
  isBoundToTrustedOpenId,
  isExpectedDemoUser,
  isExpectedUnboundDemoUser,
  hasValidVersion,
  toProfile,
  updatedCount,
  validateCurrentUser,
  validateInput,
  validateTargetUser,
};
