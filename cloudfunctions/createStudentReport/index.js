'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const FRAUD_TYPES = new Set(['part_time_scam', 'impersonate_public', 'fake_loan', 'fake_refund', 'other']);
const LINKABLE_ALERT_STATUSES = new Set(['sent', 'viewed', 'following_up']);
const ACTIVE_ALERT_STATUSES = new Set(['sent', 'viewed', 'following_up']);
const ACCEPTED_EVENT_KEYS = new Set([
  'sourceAlertId', 'fraudType', 'incidentAt', 'involvedAmount', 'hasLoss', 'incidentNarrative',
  'suspiciousPlatform', 'suspiciousAccount', 'stillContacting', 'contactPhone', 'studentRemark',
  'userInfo', 'tcbContext',
]);
const OPTIONAL_STRING_LIMITS = {
  suspiciousPlatform: 100,
  suspiciousAccount: 300,
  contactPhone: 32,
  studentRemark: 500,
};

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

function normalizeOptionalString(value, maximumLength) {
  if (value === undefined || value === null) return { valid: true, value: undefined };
  if (typeof value !== 'string') return { valid: false };
  const normalized = value.trim();
  if (!normalized) return { valid: true, value: undefined };
  if (normalized.length > maximumLength) return { valid: false };
  return { valid: true, value: normalized };
}

function parseIncidentAt(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(normalized)) return null;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key))) return null;
  if (!FRAUD_TYPES.has(event.fraudType)) return null;
  const incidentAt = parseIncidentAt(event.incidentAt);
  if (!incidentAt || typeof event.involvedAmount !== 'number' || !Number.isFinite(event.involvedAmount) || event.involvedAmount < 0) return null;
  if (typeof event.hasLoss !== 'boolean' || typeof event.incidentNarrative !== 'string') return null;
  const incidentNarrative = event.incidentNarrative.trim();
  if (!incidentNarrative || incidentNarrative.length > 2000) return null;
  let sourceAlert = { valid: true, value: undefined };
  if (event.sourceAlertId !== undefined && event.sourceAlertId !== null) {
    if (typeof event.sourceAlertId !== 'string') return null;
    const normalizedSourceAlertId = event.sourceAlertId.trim();
    if (!normalizedSourceAlertId || normalizedSourceAlertId.length > 128) return null;
    sourceAlert = { valid: true, value: normalizedSourceAlertId };
  }
  if (event.stillContacting !== undefined && typeof event.stillContacting !== 'boolean') return null;

  const input = {
    sourceAlertId: sourceAlert.value,
    fraudType: event.fraudType,
    incidentAt,
    involvedAmount: event.involvedAmount,
    hasLoss: event.hasLoss,
    incidentNarrative,
    stillContacting: event.stillContacting === undefined ? false : event.stillContacting,
  };
  for (const [field, maximumLength] of Object.entries(OPTIONAL_STRING_LIMITS)) {
    const normalized = normalizeOptionalString(event[field], maximumLength);
    if (!normalized.valid) return null;
    if (normalized.value !== undefined) input[field] = normalized.value;
  }
  return input;
}

function isBoundToTrustedOpenId(user, trustedOpenId) {
  return user && user.bindStatus === 'bound' && typeof user.wxOpenId === 'string' && user.wxOpenId.length > 0 &&
    user.wxOpenId === trustedOpenId && user.wxIdentityKey === `openid:${trustedOpenId}`;
}

function hasStudentCollege(user) {
  return user && typeof user.collegeId === 'string' && user.collegeId.trim().length > 0;
}

function isTrustedActiveStudent(user, trustedOpenId) {
  return user && user.role === 'student' && user.status === 'active' &&
    isBoundToTrustedOpenId(user, trustedOpenId) && hasStudentCollege(user);
}

function validRiskRule(rule) {
  return rule && rule._id === 'rule_default' && rule.status === 'enabled' && Number.isInteger(rule.version) && rule.version > 0 &&
    typeof rule.highAmount === 'number' && Number.isFinite(rule.highAmount) && rule.highAmount > 0 &&
    typeof rule.midAmountMin === 'number' && Number.isFinite(rule.midAmountMin) && rule.midAmountMin >= 0 &&
    Number.isInteger(rule.repeatAlertWindowDays) && rule.repeatAlertWindowDays > 0 &&
    Number.isInteger(rule.highAlertRepeatCount) && rule.highAlertRepeatCount > 0 &&
    Number.isInteger(rule.midAlertRepeatCount) && rule.midAlertRepeatCount > 0 && Array.isArray(rule.keyFraudTypes);
}

function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(), actorId: user._id, actorRole: user.role, actorCollegeId: hasStudentCollege(user) ? user.collegeId : null,
    action: 'access.denied', resourceType: 'user', resourceId: user._id, result: 'failure', failureReason: code,
    requestId, createdAt: serverDate(),
  };
}

function createSubmitAuditLog({ student, reportId, riskLevel, requestId, serverDate, createAuditId }) {
  return {
    _id: createAuditId(), actorId: student._id, actorRole: 'student', actorCollegeId: student.collegeId,
    action: 'report.submit', resourceType: 'fraud_report', resourceId: reportId, result: 'success', requestId,
    createdAt: serverDate(), afterSummary: { status: 'pending_counselor_verify', riskLevel },
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

async function findExistingReport(db, sourceAlertKey) {
  const result = await db.collection('fraud_reports').where({ sourceAlertKey }).limit(1).get();
  return Array.isArray(result.data) && result.data.length ? result.data[0] : null;
}

function toIssuedAtMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).getTime();
  return Number.NaN;
}

async function countActiveAlerts(db, studentId, rule, now, command) {
  const windowStart = new Date(now.getTime() - rule.repeatAlertWindowDays * 24 * 60 * 60 * 1000);
  const query = command && typeof command.in === 'function' && typeof command.gte === 'function'
    ? { studentId, status: command.in([...ACTIVE_ALERT_STATUSES]), issuedAt: command.gte(windowStart) }
    : { studentId };
  const result = await db.collection('alerts').where(query).get();
  return (Array.isArray(result.data) ? result.data : []).filter((alert) =>
    alert && alert.studentId === studentId && ACTIVE_ALERT_STATUSES.has(alert.status) && toIssuedAtMillis(alert.issuedAt) >= windowStart.getTime()
  ).length;
}

function calculateRisk({ input, student, rule, activeAlertCount }) {
  const keyFraudType = rule.keyFraudTypes.includes(input.fraudType);
  const highAmount = input.involvedAmount >= rule.highAmount;
  const midAmount = input.involvedAmount >= rule.midAmountMin;
  const highRepeat = activeAlertCount >= rule.highAlertRepeatCount;
  const midRepeat = activeAlertCount >= rule.midAlertRepeatCount;
  const high = input.hasLoss || highAmount || (input.stillContacting && keyFraudType) || highRepeat ||
    (student.focusFlag === true && input.stillContacting) || (student.focusFlag === true && midRepeat);
  const medium = !high && (midAmount || input.stillContacting || keyFraudType || midRepeat || student.focusFlag === true);
  const riskReasons = [];
  if (input.hasLoss) riskReasons.push('has_loss');
  if (highAmount) riskReasons.push(`involved_amount>=${rule.highAmount}`);
  else if (midAmount) riskReasons.push(`involved_amount>=${rule.midAmountMin}`);
  if (input.stillContacting) riskReasons.push('still_contacting');
  if (keyFraudType) riskReasons.push('key_fraud_type');
  if (student.focusFlag === true) riskReasons.push('focus_flag');
  if (highRepeat) riskReasons.push(`repeat_alert_count>=${rule.highAlertRepeatCount}`);
  else if (midRepeat) riskReasons.push(`repeat_alert_count>=${rule.midAlertRepeatCount}`);
  return { riskLevel: high ? 'high' : (medium ? 'medium' : 'low'), riskReasons };
}

function makeReport({ reportId, student, input, sourceAlertKey, risk, serverDate }) {
  const submittedAt = serverDate();
  const report = {
    _id: reportId, studentId: student._id, collegeId: student.collegeId, sourceAlertKey,
    fraudType: input.fraudType, incidentAt: input.incidentAt, involvedAmount: input.involvedAmount, hasLoss: input.hasLoss,
    incidentNarrative: input.incidentNarrative, stillContacting: input.stillContacting,
    riskLevel: risk.riskLevel, riskReasons: risk.riskReasons, riskRuleId: 'rule_default',
    status: 'pending_counselor_verify', confirmedLossAmount: null, version: 1,
    submittedAt, createdAt: serverDate(), updatedAt: serverDate(),
  };
  if (input.sourceAlertId) report.sourceAlertId = input.sourceAlertId;
  for (const field of Object.keys(OPTIONAL_STRING_LIMITS)) if (input[field] !== undefined) report[field] = input[field];
  return report;
}

function isConflict(error) {
  const text = `${error && error.code ? error.code : ''} ${error && error.errCode ? error.errCode : ''} ${error && error.message ? error.message : ''}`.toLowerCase();
  return text.includes('transaction') || text.includes('conflict') || text.includes('duplicate') || text.includes('unique') || text.includes('already exists');
}

function createHandler({
  db, getWXContext, serverDate, command = db && db.command, now = () => new Date(), logger = console,
  createRequestId = () => crypto.randomUUID(), createReportId = () => `report_${crypto.randomUUID().replace(/-/g, '')}`,
  createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}`,
}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function' || typeof getWXContext !== 'function' || typeof serverDate !== 'function') {
    throw new Error('createStudentReport dependencies are incomplete');
  }
  return async function createStudentReport(event) {
    const requestId = createRequestId();
    const denied = async (user, code, message, stage) => {
      try {
        await db.collection('audit_logs').add({ data: createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }) });
        return failure(code, message);
      } catch (error) {
        logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: user._id, stage });
        return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
      }
    };
    try {
      const input = validateInput(event);
      if (!input) return failure('INVALID_INPUT', '请求参数无效');
      const wxContext = getWXContext() || {};
      const appId = getAppId(wxContext);
      if (appId && appId !== EXPECTED_APP_ID) return failure('FORBIDDEN', '调用来源不被允许');
      if (!wxContext.OPENID) return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      const student = await findUserByWxIdentityKey(db, `openid:${wxContext.OPENID}`);
      if (!student) return failure('UNBOUND', '当前微信尚未绑定学生身份');
      if (student.role !== 'student') return denied(student, 'FORBIDDEN', '当前账号不能提交学生上报', 'studentReportRole');
      if (student.status !== 'active') return denied(student, 'ACCOUNT_DISABLED', '账号当前不可用', 'studentReportStatus');
      if (!isBoundToTrustedOpenId(student, wxContext.OPENID) || !hasStudentCollege(student)) {
        return denied(student, 'INTERNAL_ERROR', '账号绑定状态异常，请联系管理员', 'studentReportBindingConsistency');
      }

      let sourceAlert = null;
      let sourceAlertKey;
      const reportId = createReportId();
      if (input.sourceAlertId) {
        sourceAlert = await getById(db, 'alerts', input.sourceAlertId);
        if (!sourceAlert || sourceAlert.studentId !== student._id || !LINKABLE_ALERT_STATUSES.has(sourceAlert.status)) {
          return failure('NOT_FOUND', '未找到可关联预警');
        }
        sourceAlertKey = `alert:${input.sourceAlertId}`;
        if (await findExistingReport(db, sourceAlertKey)) return failure('CONFLICT', '该预警已创建工单');
      } else {
        sourceAlertKey = `standalone:${reportId}`;
      }
      const rule = await getById(db, 'risk_rules', 'rule_default');
      if (!rule) return failure('NOT_FOUND', '风险规则不存在');
      if (!validRiskRule(rule)) return failure('INTERNAL_ERROR', '风险规则配置异常');
      const activeAlertCount = await countActiveAlerts(db, student._id, rule, now(), command);
      const risk = calculateRisk({ input, student, rule, activeAlertCount });
      const report = makeReport({ reportId, student, input, sourceAlertKey, risk, serverDate });

      try {
        await db.runTransaction(async (transaction) => {
          const currentStudent = await getById(transaction, 'users', student._id);
          if (!isTrustedActiveStudent(currentStudent, wxContext.OPENID)) throw businessError('CONFLICT', '学生身份已变化');
          if (currentStudent.version !== student.version) throw businessError('CONFLICT', '学生资料已变化');
          const currentRule = await getById(transaction, 'risk_rules', 'rule_default');
          if (!validRiskRule(currentRule)) throw businessError('CONFLICT', '风险规则已变化');
          if (currentRule.version !== rule.version) throw businessError('CONFLICT', '风险规则已变化');
          if (input.sourceAlertId) {
            const currentAlert = await getById(transaction, 'alerts', input.sourceAlertId);
            if (!currentAlert || currentAlert.studentId !== student._id || !LINKABLE_ALERT_STATUSES.has(currentAlert.status) || currentAlert.version !== sourceAlert.version) {
              throw businessError('CONFLICT', '关联预警已变化');
            }
          }
          await transaction.collection('fraud_reports').add({ data: report });
          await transaction.collection('audit_logs').add({ data: createSubmitAuditLog({ student, reportId, riskLevel: risk.riskLevel, requestId, serverDate, createAuditId }) });
        });
      } catch (error) {
        if ((error && error.isBusinessError) || isConflict(error)) return failure('CONFLICT', '数据已变化，请刷新后重试');
        throw error;
      }
      return success('REPORT_SUBMITTED', { report: {
        reportId, sourceAlertId: input.sourceAlertId || null, fraudType: report.fraudType, riskLevel: report.riskLevel,
        riskReasons: report.riskReasons, status: report.status, version: report.version, submittedAt: report.submittedAt,
      } });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'createStudentReport' });
      return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
    }
  };
}

function createDefaultHandler(cloud = require('wx-server-sdk')) {
  cloud.init({ env: TARGET_ENV_ID });
  const db = cloud.database();
  return createHandler({ db, getWXContext: () => cloud.getWXContext(), serverDate: () => db.serverDate(), command: db.command, logger: console });
}

exports.main = async (event) => createDefaultHandler()(event);
exports.__testables = {
  ACCEPTED_EVENT_KEYS, EXPECTED_APP_ID, TARGET_ENV_ID, calculateRisk, countActiveAlerts, createAccessDeniedAuditLog,
  createDefaultHandler, createHandler, createSubmitAuditLog, findExistingReport, findUserByWxIdentityKey, getById,
  hasStudentCollege, isBoundToTrustedOpenId, isConflict, isTrustedActiveStudent, makeReport, normalizeOptionalString,
  parseIncidentAt, validRiskRule, validateInput,
};
