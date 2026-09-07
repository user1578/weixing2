'use strict';

const fs = require('fs');
const path = require('path');

const PLAN_PATH = path.join(__dirname, 'plan.json');
const ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const COLLECTIONS = ['alerts', 'fraud_reports', 'counselor_followups', 'security_dispositions'];
const FRAUD_TYPES = ['part_time_scam', 'impersonate_public', 'fake_loan', 'fake_refund', 'other'];
const RISK_LEVELS = ['low', 'medium', 'high'];
const FROZEN_FIELDS = {
  alerts: ['_id', 'sourceType', 'sourceReference', 'studentId', 'collegeId', 'fraudType', 'content', 'riskLevel', 'riskReasons', 'riskRuleId', 'status', 'issuedBy', 'issuedAt', 'readAt', 'closedAt', 'closeReason', 'version', 'createdAt', 'updatedAt'],
  fraud_reports: ['_id', 'studentId', 'collegeId', 'sourceAlertId', 'sourceAlertKey', 'fraudType', 'incidentAt', 'involvedAmount', 'hasLoss', 'incidentNarrative', 'suspiciousPlatform', 'suspiciousAccount', 'stillContacting', 'contactPhone', 'studentRemark', 'riskLevel', 'riskReasons', 'riskRuleId', 'status', 'currentHandlerId', 'finalOutcome', 'confirmedLossAmount', 'closeReason', 'submittedAt', 'closedAt', 'version', 'createdAt', 'updatedAt'],
  counselor_followups: ['_id', 'businessType', 'businessId', 'studentId', 'collegeId', 'counselorId', 'status', 'contactedAt', 'contactMethod', 'opinion', 'verificationResult', 'focusFlag', 'focusReason', 'transferToSecurity', 'transferReason', 'version', 'createdAt', 'updatedAt', 'completedAt'],
  security_dispositions: ['_id', 'reportId', 'operatorId', 'action', 'statusAfter', 'verificationResult', 'actionContent', 'returnReason', 'confirmedLossAmount', 'externalReferenceNo', 'nextActionAt', 'finalOutcome', 'createdAt']
};
const FROZEN_INDEXES = {
  alerts: [['studentId:asc', 'issuedAt:desc'], ['collegeId:asc', 'status:asc', 'issuedAt:desc'], ['status:asc', 'riskLevel:asc', 'issuedAt:desc']],
  fraud_reports: [['sourceAlertKey:asc:unique'], ['studentId:asc', 'submittedAt:desc'], ['collegeId:asc', 'status:asc', 'submittedAt:desc'], ['status:asc', 'riskLevel:asc', 'submittedAt:desc'], ['status:asc', 'closedAt:desc'], ['collegeId:asc', 'status:asc', 'closedAt:desc']],
  counselor_followups: [['businessType:asc', 'businessId:asc', 'createdAt:desc'], ['studentId:asc', 'createdAt:desc']],
  security_dispositions: [['reportId:asc', 'createdAt:desc']]
};

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function equal(actual, expected, label) { assert(actual === expected, `${label} must be ${JSON.stringify(expected)}`); }
function sameArray(actual, expected, label) {
  assert(Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]), `${label} differs from frozen design`);
}
function readPlan() { return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8')); }
function collection(plan, name) {
  const result = plan.collections.find((item) => item.collectionName === name);
  assert(result, `Missing collection ${name}`);
  return result;
}
function normalizedIndexes(item) {
  return item.indexes.map((index) => index.fields.map((field) => `${field.field}:${field.order}${index.unique ? ':unique' : ''}`));
}
function validateNoSensitiveMaterial(value, label = 'plan') {
  if (Array.isArray(value)) return value.forEach((item, index) => validateNoSensitiveMaterial(item, `${label}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(token|secret|password|privateKey|openid|wxOpenId)$/i.test(key)) fail(`${label}.${key} is prohibited`);
    if (typeof child === 'string' && /(DEMO_PASSWORD_PLACEHOLDER|\b1\d{10}\b|\bo[a-zA-Z0-9_-]{12,}\b)/.test(child)) fail(`${label}.${key} contains prohibited sensitive material`);
    validateNoSensitiveMaterial(child, `${label}.${key}`);
  }
}
function validatePartition(item) {
  const sources = [...item.clientInputFields, ...item.serverDerivedFields, ...item.serverControlledFields];
  sameArray([...new Set(sources)].sort(), [...item.fields].sort(), `${item.collectionName} field source partition`);
}
function validateVersion(item) {
  if (item.collectionName === 'security_dispositions') {
    equal(item.version.present, false, 'security_dispositions.version.present');
    equal(item.version.immutableAfterCreate, true, 'security_dispositions immutableAfterCreate');
    assert(!item.fields.includes('version'), 'security_dispositions must not contain version');
    return;
  }
  equal(item.version.present, true, `${item.collectionName}.version.present`);
  equal(item.version.createDefault, 1, `${item.collectionName}.version.createDefault`);
  sameArray(item.version.updateCondition, ['_id', 'version'], `${item.collectionName}.version.updateCondition`);
  sameArray(item.version.stateUpdateCondition, ['expectedStatus', 'version'], `${item.collectionName}.version.stateUpdateCondition`);
}
function validateEnums(item) {
  if (item.enums.fraudType) sameArray(item.enums.fraudType, FRAUD_TYPES, `${item.collectionName}.fraudType enum`);
  if (item.enums.riskLevel) sameArray(item.enums.riskLevel, RISK_LEVELS, `${item.collectionName}.riskLevel enum`);
  const expectedStatus = {
    alerts: ['pending_dispatch', 'sent', 'viewed', 'following_up', 'closed'],
    fraud_reports: ['pending_counselor_verify', 'pending_security_verify', 'in_process', 'closed'],
    counselor_followups: ['pending', 'in_progress', 'completed']
  };
  if (expectedStatus[item.collectionName]) sameArray(item.enums.status, expectedStatus[item.collectionName], `${item.collectionName}.status enum`);
  if (item.collectionName === 'security_dispositions') sameArray(item.enums.action, ['verify', 'start_process', 'return', 'close'], 'security_dispositions.action enum');
}
function validatePlan(plan = readPlan()) {
  equal(plan.envId, ENV_ID, 'envId');
  equal(plan.group, 'B', 'group');
  equal(plan.serverTimestampMarker, 'serverTimestamp', 'serverTimestampMarker');
  sameArray(plan.allowedCollections, COLLECTIONS, 'allowedCollections');
  sameArray(plan.creationOrder, COLLECTIONS, 'creationOrder');
  assert(plan.collections.length === COLLECTIONS.length, 'B group must contain exactly four collections');
  equal(plan.idempotencyPolicy.existingExactMatch, 'verify_and_skip', 'existingExactMatch');
  equal(plan.idempotencyPolicy.existingMismatch, 'stop_and_report', 'existingMismatch');
  equal(plan.idempotencyPolicy.missing, 'create_from_plan', 'missing');
  for (const name of plan.idempotencyPolicy.forbiddenProbeCollectionNames) assert(['__probe__', 'probe', 'test', 'temp'].includes(name), 'Only forbidden probe names may be listed');
  assert(Array.isArray(plan.initializationPolicy.documents) && plan.initializationPolicy.documents.length === 0, 'B group must not initialize business records');

  for (const name of COLLECTIONS) {
    const item = collection(plan, name);
    sameArray(item.fields, FROZEN_FIELDS[name], `${name}.fields`);
    assert(item.securityPolicy.clientRead === false && item.securityPolicy.clientWrite === false, `${name} ACL must deny client read/write`);
    assert(Array.isArray(item.seedData.documents) && item.seedData.documents.length === 0, `${name} must not contain seed records`);
    sameArray(normalizedIndexes(item).map((index) => index.join('|')), FROZEN_INDEXES[name].map((index) => index.join('|')), `${name}.indexes`);
    validatePartition(item);
    validateVersion(item);
    validateEnums(item);
  }
  const report = collection(plan, 'fraud_reports');
  assert(report.uniqueRules.length === 1, 'fraud_reports must have exactly one UNIQUE rule');
  const unique = report.uniqueRules[0];
  equal(unique.field, 'sourceAlertKey', 'fraud_reports UNIQUE field');
  equal(unique.requiredNonNull, true, 'sourceAlertKey requiredNonNull');
  equal(unique.linkedFormat, 'alert:<sourceAlertId>', 'sourceAlertKey linked format');
  equal(unique.standaloneFormat, 'standalone:<reportId>', 'sourceAlertKey standalone format');
  equal(unique.forbiddenDirectUniqueField, 'sourceAlertId', 'forbidden direct UNIQUE field');
  validateNoSensitiveMaterial(plan);
  return plan;
}

if (require.main === module) {
  try { validatePlan(); console.log('B-group static plan validation passed'); }
  catch (error) { console.error(`B-group plan validation failed: ${error.message}`); process.exit(1); }
}

module.exports = { validatePlan, FROZEN_FIELDS, FROZEN_INDEXES };
