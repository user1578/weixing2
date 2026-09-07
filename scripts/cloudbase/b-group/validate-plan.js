'use strict';

const fs = require('fs');
const path = require('path');

const PLAN_PATH = path.join(__dirname, 'plan.json');
const ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const COLLECTIONS = ['alerts', 'fraud_reports', 'counselor_followups', 'security_dispositions'];
const CUSTOM_INDEX_COUNT = 12;
const FRAUD_TYPES = ['part_time_scam', 'impersonate_public', 'fake_loan', 'fake_refund', 'other'];
const RISK_LEVELS = ['low', 'medium', 'high'];
const FROZEN_IMPLEMENTATION_STATUS = {
  status: 'PASSED',
  remediationRequired: false,
  blockNextGroup: false,
  knownIssue: null,
  currentCloudBaseState: {
    alerts: 0,
    fraud_reports: 0,
    counselor_followups: 0,
    security_dispositions: 0,
    customIndexCount: CUSTOM_INDEX_COUNT
  }
};
const FROZEN_FIELDS = {
  alerts: ['_id', 'sourceType', 'sourceReference', 'studentId', 'collegeId', 'fraudType', 'content', 'riskLevel', 'riskReasons', 'riskRuleId', 'status', 'issuedBy', 'issuedAt', 'readAt', 'closedAt', 'closeReason', 'version', 'createdAt', 'updatedAt'],
  fraud_reports: ['_id', 'studentId', 'collegeId', 'sourceAlertId', 'sourceAlertKey', 'fraudType', 'incidentAt', 'involvedAmount', 'hasLoss', 'incidentNarrative', 'suspiciousPlatform', 'suspiciousAccount', 'stillContacting', 'contactPhone', 'studentRemark', 'riskLevel', 'riskReasons', 'riskRuleId', 'status', 'currentHandlerId', 'finalOutcome', 'confirmedLossAmount', 'closeReason', 'submittedAt', 'closedAt', 'version', 'createdAt', 'updatedAt'],
  counselor_followups: ['_id', 'businessType', 'businessId', 'studentId', 'collegeId', 'counselorId', 'status', 'contactedAt', 'contactMethod', 'opinion', 'verificationResult', 'focusFlag', 'focusReason', 'transferToSecurity', 'transferReason', 'version', 'createdAt', 'updatedAt', 'completedAt'],
  security_dispositions: ['_id', 'reportId', 'operatorId', 'action', 'statusAfter', 'verificationResult', 'actionContent', 'returnReason', 'confirmedLossAmount', 'externalReferenceNo', 'nextActionAt', 'finalOutcome', 'createdAt']
};
const FROZEN_FIELD_CONTRACTS = {
  alerts: {
    requiredFields: ['_id', 'sourceType', 'studentId', 'collegeId', 'fraudType', 'content', 'riskLevel', 'riskReasons', 'riskRuleId', 'status', 'version', 'createdAt', 'updatedAt'],
    nullableFields: ['sourceReference', 'issuedBy', 'issuedAt', 'readAt', 'closedAt', 'closeReason'],
    conditionalRequiredFields: { issuedBy: 'after dispatch', issuedAt: 'after dispatch', readAt: 'after first read', closedAt: 'when status=closed', closeReason: 'when status=closed' },
    dateFields: ['issuedAt', 'readAt', 'closedAt', 'createdAt', 'updatedAt'],
    serverTimestampFields: ['issuedAt', 'readAt', 'closedAt', 'createdAt', 'updatedAt'],
    foreignKeys: { studentId: 'users._id', collegeId: 'colleges._id', riskRuleId: 'risk_rules._id', issuedBy: 'users._id' },
    clientInputFields: ['sourceReference', 'fraudType', 'content', 'closeReason'],
    serverDerivedFields: ['studentId', 'collegeId', 'riskLevel', 'riskReasons', 'riskRuleId', 'issuedBy'],
    serverControlledFields: ['_id', 'sourceType', 'status', 'issuedAt', 'readAt', 'closedAt', 'version', 'createdAt', 'updatedAt'],
    enums: { sourceType: ['manual'], fraudType: FRAUD_TYPES, riskLevel: RISK_LEVELS, status: ['pending_dispatch', 'sent', 'viewed', 'following_up', 'closed'] }
  },
  fraud_reports: {
    requiredFields: ['_id', 'studentId', 'collegeId', 'sourceAlertKey', 'fraudType', 'incidentAt', 'involvedAmount', 'hasLoss', 'incidentNarrative', 'stillContacting', 'riskLevel', 'riskReasons', 'riskRuleId', 'status', 'version', 'submittedAt', 'createdAt', 'updatedAt'],
    nullableFields: ['sourceAlertId', 'suspiciousPlatform', 'suspiciousAccount', 'contactPhone', 'studentRemark', 'currentHandlerId', 'finalOutcome', 'confirmedLossAmount', 'closeReason', 'closedAt'],
    conditionalRequiredFields: { finalOutcome: 'when status=closed', confirmedLossAmount: 'security close; otherwise null', closeReason: 'when status=closed', closedAt: 'when status=closed' },
    dateFields: ['incidentAt', 'submittedAt', 'closedAt', 'createdAt', 'updatedAt'],
    serverTimestampFields: ['submittedAt', 'closedAt', 'createdAt', 'updatedAt'],
    foreignKeys: { studentId: 'users._id', collegeId: 'colleges._id', sourceAlertId: 'alerts._id', riskRuleId: 'risk_rules._id', currentHandlerId: 'users._id' },
    clientInputFields: ['sourceAlertId', 'fraudType', 'incidentAt', 'involvedAmount', 'hasLoss', 'incidentNarrative', 'suspiciousPlatform', 'suspiciousAccount', 'stillContacting', 'contactPhone', 'studentRemark'],
    serverDerivedFields: ['studentId', 'collegeId', 'sourceAlertKey', 'riskLevel', 'riskReasons', 'riskRuleId', 'currentHandlerId', 'finalOutcome', 'confirmedLossAmount'],
    serverControlledFields: ['_id', 'status', 'closeReason', 'submittedAt', 'closedAt', 'version', 'createdAt', 'updatedAt'],
    enums: { fraudType: FRAUD_TYPES, riskLevel: RISK_LEVELS, status: ['pending_counselor_verify', 'pending_security_verify', 'in_process', 'closed'], finalOutcome: ['loss_confirmed', 'loss_no_loss', 'misreport', 'consultation'] }
  },
  counselor_followups: {
    requiredFields: ['_id', 'businessType', 'businessId', 'studentId', 'collegeId', 'counselorId', 'status', 'opinion', 'focusFlag', 'transferToSecurity', 'version', 'createdAt', 'updatedAt'],
    nullableFields: ['contactedAt', 'contactMethod', 'verificationResult', 'focusReason', 'transferReason', 'completedAt'],
    conditionalRequiredFields: { verificationResult: 'when status=completed', focusReason: 'when focusFlag=true', transferReason: 'when transferToSecurity=true', completedAt: 'when status=completed' },
    dateFields: ['contactedAt', 'createdAt', 'updatedAt', 'completedAt'],
    serverTimestampFields: ['createdAt', 'updatedAt', 'completedAt'],
    foreignKeys: { businessId: 'alerts._id or fraud_reports._id', studentId: 'users._id', collegeId: 'colleges._id', counselorId: 'users._id' },
    clientInputFields: ['contactedAt', 'contactMethod', 'opinion', 'verificationResult', 'focusFlag', 'focusReason', 'transferToSecurity', 'transferReason'],
    serverDerivedFields: ['businessType', 'businessId', 'studentId', 'collegeId', 'counselorId'],
    serverControlledFields: ['_id', 'status', 'version', 'createdAt', 'updatedAt', 'completedAt'],
    enums: { businessType: ['alert', 'report'], status: ['pending', 'in_progress', 'completed'], contactMethod: ['phone', 'wechat', 'in_person', 'other'], verificationResult: ['confirmed', 'suspected', 'misreport', 'consultation', 'not_fraud'] }
  },
  security_dispositions: {
    requiredFields: ['_id', 'reportId', 'operatorId', 'action', 'statusAfter', 'actionContent', 'createdAt'],
    nullableFields: ['verificationResult', 'returnReason', 'confirmedLossAmount', 'externalReferenceNo', 'nextActionAt', 'finalOutcome'],
    conditionalRequiredFields: { verificationResult: 'for verify, return, or close', returnReason: 'when action=return', confirmedLossAmount: 'when action=close', finalOutcome: 'when action=close' },
    dateFields: ['nextActionAt', 'createdAt'],
    serverTimestampFields: ['createdAt'],
    foreignKeys: { reportId: 'fraud_reports._id', operatorId: 'users._id' },
    clientInputFields: ['action', 'verificationResult', 'actionContent', 'returnReason', 'externalReferenceNo', 'nextActionAt', 'finalOutcome'],
    serverDerivedFields: ['reportId', 'operatorId', 'statusAfter', 'confirmedLossAmount'],
    serverControlledFields: ['_id', 'createdAt'],
    enums: { action: ['verify', 'start_process', 'return', 'close'], verificationResult: ['confirmed', 'suspected', 'misreport', 'consultation', 'not_fraud'], finalOutcome: ['loss_confirmed', 'loss_no_loss', 'misreport', 'consultation'] }
  }
};
const FROZEN_STATE_MACHINES = {
  alerts: { currentStateField: 'status', initial: 'pending_dispatch', transitions: ['pending_dispatch->sent', 'sent->viewed', 'sent->following_up', 'viewed->following_up', 'sent->closed', 'viewed->closed', 'following_up->closed'], terminal: ['closed'] },
  fraud_reports: { currentStateField: 'status', initial: 'pending_counselor_verify', transitions: ['pending_counselor_verify->pending_security_verify', 'pending_counselor_verify->closed', 'pending_security_verify->in_process', 'pending_security_verify->pending_counselor_verify', 'pending_security_verify->closed', 'in_process->closed'], terminal: ['closed'] },
  counselor_followups: { currentStateField: 'status', initial: 'pending', transitions: ['pending->in_progress', 'in_progress->completed'], terminal: ['completed'] }
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
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => ({ ...result, [key]: canonical(value[key]) }), {});
}
function sameObject(actual, expected, label) {
  assert(JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected)), `${label} differs from frozen design`);
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
function validateFieldContract(item) {
  const contract = FROZEN_FIELD_CONTRACTS[item.collectionName];
  assert(contract, `${item.collectionName} is not a B-group field contract`);
  sameArray(item.requiredFields, contract.requiredFields, `${item.collectionName}.requiredFields`);
  sameArray(item.nullableFields, contract.nullableFields, `${item.collectionName}.nullableFields`);
  sameObject(item.conditionalRequiredFields, contract.conditionalRequiredFields, `${item.collectionName}.conditionalRequiredFields`);
  sameArray(item.dateFields, contract.dateFields, `${item.collectionName}.dateFields`);
  sameArray(item.serverTimestampFields, contract.serverTimestampFields, `${item.collectionName}.serverTimestampFields`);
  sameObject(item.foreignKeys, contract.foreignKeys, `${item.collectionName}.foreignKeys`);
  sameArray(item.clientInputFields, contract.clientInputFields, `${item.collectionName}.clientInputFields`);
  sameArray(item.serverDerivedFields, contract.serverDerivedFields, `${item.collectionName}.serverDerivedFields`);
  sameArray(item.serverControlledFields, contract.serverControlledFields, `${item.collectionName}.serverControlledFields`);
  sameObject(item.enums, contract.enums, `${item.collectionName}.enums`);
}
function validateStateMachine(item) {
  const frozen = FROZEN_STATE_MACHINES[item.collectionName];
  if (!frozen) {
    assert(!Object.prototype.hasOwnProperty.call(item, 'stateMachine'), 'security_dispositions must not define a stateMachine');
    return;
  }
  sameObject(item.stateMachine, frozen, `${item.collectionName}.stateMachine`);
}
function validateVersion(item) {
  if (item.collectionName === 'security_dispositions') {
    sameObject(item.version, { present: false, createDefault: null, immutableAfterCreate: true }, 'security_dispositions.version');
    equal(item.appendOnly, true, 'security_dispositions.appendOnly');
    assert(!item.fields.includes('version'), 'security_dispositions must not contain version');
    return;
  }
  sameObject(item.version, {
    present: true,
    createDefault: 1,
    updateCondition: ['_id', 'version'],
    stateUpdateCondition: ['_id', 'expectedStatus', 'version']
  }, `${item.collectionName}.version`);
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
function validateImplementationStatus(plan) {
  sameObject(plan.implementationStatus, FROZEN_IMPLEMENTATION_STATUS, 'implementationStatus');
  const state = plan.implementationStatus.currentCloudBaseState;
  for (const name of COLLECTIONS) {
    equal(state[name], 0, `implementationStatus.currentCloudBaseState.${name}`);
    equal(state[name], collection(plan, name).expectedDocumentCount, `implementationStatus count for ${name}`);
  }
  const indexCount = plan.collections.reduce((total, item) => total + item.indexes.length, 0);
  equal(indexCount, CUSTOM_INDEX_COUNT, 'B-group custom index count');
  equal(state.customIndexCount, CUSTOM_INDEX_COUNT, 'implementationStatus.currentCloudBaseState.customIndexCount');
  equal(state.customIndexCount, indexCount, 'implementationStatus index count');
}
function validatePlan(plan = readPlan()) {
  equal(plan.envId, ENV_ID, 'envId');
  equal(plan.group, 'B', 'group');
  equal(plan.serverTimestampMarker, 'serverTimestamp', 'serverTimestampMarker');
  sameObject(plan.cloudBaseCollectionModel, {
    hasFixedPhysicalFieldSchema: false,
    physicalResources: ['collection', 'indexes', 'acl'],
    staticContracts: ['fields', 'requiredness', 'Date', 'version', 'stateMachine']
  }, 'cloudBaseCollectionModel');
  sameArray(plan.allowedCollections, COLLECTIONS, 'allowedCollections');
  sameArray(plan.creationOrder, COLLECTIONS, 'creationOrder');
  assert(plan.collections.length === COLLECTIONS.length, 'B group must contain exactly four collections');
  equal(plan.idempotencyPolicy.existingExactMatch, 'verify_and_skip', 'existingExactMatch');
  equal(plan.idempotencyPolicy.existingMismatch, 'stop_and_report', 'existingMismatch');
  equal(plan.idempotencyPolicy.missing, 'stop_and_report', 'missing');
  for (const name of plan.idempotencyPolicy.forbiddenProbeCollectionNames) assert(['__probe__', 'probe', 'test', 'temp'].includes(name), 'Only forbidden probe names may be listed');
  assert(Array.isArray(plan.initializationPolicy.documents) && plan.initializationPolicy.documents.length === 0, 'B group must not initialize business records');

  for (const name of COLLECTIONS) {
    const item = collection(plan, name);
    sameArray(item.fields, FROZEN_FIELDS[name], `${name}.fields`);
    equal(item.expectedDocumentCount, 0, `${name}.expectedDocumentCount`);
    assert(item.securityPolicy.clientRead === false && item.securityPolicy.clientWrite === false, `${name} ACL must deny client read/write`);
    assert(Array.isArray(item.seedData.documents) && item.seedData.documents.length === 0, `${name} must not contain seed records`);
    sameArray(normalizedIndexes(item).map((index) => index.join('|')), FROZEN_INDEXES[name].map((index) => index.join('|')), `${name}.indexes`);
    validateFieldContract(item);
    validatePartition(item);
    validateVersion(item);
    validateEnums(item);
    validateStateMachine(item);
    if (name !== 'security_dispositions') assert(!Object.prototype.hasOwnProperty.call(item, 'appendOnly'), `${name} must not be appendOnly history`);
  }
  validateImplementationStatus(plan);
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

module.exports = { validatePlan, FROZEN_FIELDS, FROZEN_FIELD_CONTRACTS, FROZEN_INDEXES, FROZEN_STATE_MACHINES, FROZEN_IMPLEMENTATION_STATUS };
