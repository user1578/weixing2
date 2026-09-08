'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const ACCEPTED_EVENT_KEYS = new Set(['alertId', 'userInfo', 'tcbContext']);
const STUDENT_VISIBLE_ALERT_STATUSES = new Set(['sent', 'viewed', 'following_up', 'closed']);

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
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return null;
  }
  if (Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key))) {
    return null;
  }
  if (typeof event.alertId !== 'string' || !event.alertId.trim()) {
    return null;
  }
  return { alertId: event.alertId.trim() };
}

function isBoundToTrustedOpenId(user, trustedOpenId) {
  return user &&
    user.bindStatus === 'bound' &&
    typeof user.wxOpenId === 'string' &&
    user.wxOpenId.length > 0 &&
    user.wxOpenId === trustedOpenId &&
    user.wxIdentityKey === `openid:${trustedOpenId}`;
}

function isStudentVisibleAlert(alert) {
  return alert && STUDENT_VISIBLE_ALERT_STATUSES.has(alert.status);
}

function updatedCount(result) {
  if (result && typeof result.updated === 'number') {
    return result.updated;
  }
  if (result && result.stats && typeof result.stats.updated === 'number') {
    return result.stats.updated;
  }
  return 0;
}

function isTransactionConflict(error) {
  const value = `${error && error.code ? error.code : ''} ${error && error.errCode ? error.errCode : ''} ${error && error.message ? error.message : ''}`.toLowerCase();
  return value.includes('transaction') || value.includes('conflict') || value.includes('write conflict');
}

function toDetail(alert) {
  return {
    alertId: alert._id,
    fraudType: alert.fraudType,
    riskLevel: alert.riskLevel,
    status: alert.status,
    content: alert.content,
    issuedAt: alert.issuedAt,
  };
}

function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(),
    actorId: user._id,
    actorRole: user.role,
    actorCollegeId: user.collegeId || null,
    action: 'access.denied',
    resourceType: 'user',
    resourceId: user._id,
    result: 'failure',
    failureReason: code,
    requestId,
    createdAt: serverDate(),
  };
}

function createViewAuditLog({ student, alert, requestId, serverDate, createAuditId, beforeStatus, afterStatus }) {
  const auditLog = {
    _id: createAuditId(),
    actorId: student._id,
    actorRole: 'student',
    actorCollegeId: student.collegeId || null,
    action: 'alert.view',
    resourceType: 'alert',
    resourceId: alert._id,
    result: 'success',
    requestId,
    createdAt: serverDate(),
  };
  if (beforeStatus && afterStatus) {
    auditLog.beforeSummary = { status: beforeStatus };
    auditLog.afterSummary = { status: afterStatus };
  }
  return auditLog;
}

async function findUserByWxIdentityKey(db, wxIdentityKey) {
  const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get();
  return Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
}

async function findStudentAlert(dbOrTransaction, alertId, studentId) {
  const result = await dbOrTransaction.collection('alerts').where({ _id: alertId, studentId }).limit(1).get();
  return Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
}

function createHandler({
  db,
  getWXContext,
  serverDate,
  logger = console,
  createRequestId = () => crypto.randomUUID(),
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function' || typeof getWXContext !== 'function' || typeof serverDate !== 'function') {
    throw new Error('getStudentAlertDetail dependencies are incomplete');
  }

  return async function getStudentAlertDetail(event) {
    const requestId = createRequestId();
    const auditedIdentityFailure = async (user, code, message, stage) => {
      try {
        await db.collection('audit_logs').add({
          data: createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }),
        });
        return failure(code, message);
      } catch (error) {
        logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: user._id, stage });
        return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
      }
    };
    const addReadAudit = async (student, alert) => {
      await db.collection('audit_logs').add({
        data: createViewAuditLog({ student, alert, requestId, serverDate, createAuditId }),
      });
    };

    try {
      const input = validateInput(event);
      if (!input) {
        return failure('INVALID_INPUT', '请求参数无效');
      }

      const wxContext = getWXContext() || {};
      const appId = getAppId(wxContext);
      if (appId && appId !== EXPECTED_APP_ID) {
        return failure('FORBIDDEN', '调用来源不被允许');
      }
      if (!wxContext.OPENID) {
        return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      }

      const student = await findUserByWxIdentityKey(db, `openid:${wxContext.OPENID}`);
      if (!student) {
        return failure('UNBOUND', '当前微信尚未绑定学生身份');
      }
      if (student.role !== 'student') {
        return auditedIdentityFailure(student, 'FORBIDDEN', '当前账号不能查看学生预警', 'studentAlertDetailRole');
      }
      if (student.status !== 'active') {
        return auditedIdentityFailure(student, 'ACCOUNT_DISABLED', '账号当前不可用', 'studentAlertDetailStatus');
      }
      if (!isBoundToTrustedOpenId(student, wxContext.OPENID)) {
        return auditedIdentityFailure(student, 'INTERNAL_ERROR', '账号绑定状态异常，请联系管理员', 'studentAlertDetailBindingConsistency');
      }

      const initialAlert = await findStudentAlert(db, input.alertId, student._id);
      if (!isStudentVisibleAlert(initialAlert)) {
        return failure('NOT_FOUND', '未找到预警');
      }
      if (initialAlert.status !== 'sent') {
        await addReadAudit(student, initialAlert);
        return success('OK', { alert: toDetail(initialAlert) });
      }

      try {
        const outcome = await db.runTransaction(async (transaction) => {
          const current = await findStudentAlert(transaction, input.alertId, student._id);
          if (!isStudentVisibleAlert(current)) {
            throw businessError('NOT_FOUND', '未找到预警');
          }
          if (current.status !== 'sent') {
            return { alert: current, transitioned: false };
          }

          const nextVersion = current.version + 1;
          const readAt = serverDate();
          const updatedAt = serverDate();
          const updateResult = await transaction.collection('alerts').where({
            _id: current._id,
            studentId: student._id,
            status: 'sent',
            version: current.version,
          }).update({
            data: {
              status: 'viewed',
              version: nextVersion,
              readAt,
              updatedAt,
            },
          });
          if (updatedCount(updateResult) !== 1) {
            throw businessError('CONFLICT', '预警状态已变化，请刷新后重试');
          }

          const viewedAlert = {
            ...current,
            status: 'viewed',
            version: nextVersion,
            readAt,
            updatedAt,
          };
          await transaction.collection('audit_logs').add({
            data: createViewAuditLog({
              student,
              alert: current,
              requestId,
              serverDate,
              createAuditId,
              beforeStatus: 'sent',
              afterStatus: 'viewed',
            }),
          });
          return { alert: viewedAlert, transitioned: true };
        });

        if (!outcome.transitioned) {
          await addReadAudit(student, outcome.alert);
        }
        return success('OK', { alert: toDetail(outcome.alert) });
      } catch (error) {
        if (error && error.isBusinessError && error.businessCode === 'NOT_FOUND') {
          return failure('NOT_FOUND', '未找到预警');
        }
        if ((error && error.isBusinessError && error.businessCode === 'CONFLICT') || isTransactionConflict(error)) {
          const finalAlert = await findStudentAlert(db, input.alertId, student._id);
          if (isStudentVisibleAlert(finalAlert) && finalAlert.status !== 'sent') {
            await addReadAudit(student, finalAlert);
            return success('OK', { alert: toDetail(finalAlert) });
          }
          return failure('CONFLICT', '预警状态已变化，请刷新后重试');
        }
        throw error;
      }
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'getStudentAlertDetail' });
      return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
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

exports.main = async (event) => createDefaultHandler()(event);
exports.__testables = {
  createHandler,
  createDefaultHandler,
  createAccessDeniedAuditLog,
  createViewAuditLog,
  findStudentAlert,
  findUserByWxIdentityKey,
  isBoundToTrustedOpenId,
  isStudentVisibleAlert,
  isTransactionConflict,
  toDetail,
  updatedCount,
  validateInput,
  EXPECTED_APP_ID,
  TARGET_ENV_ID,
};
