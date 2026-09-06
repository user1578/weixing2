/*
 * Source of truth:
 * - SRS-v0.2
 * - DATABASE-DESIGN-v0.2
 * - CLOUDBASE-DEVELOPMENT-GUARDRAILS
 *
 * Do not modify CloudBase schema outside the frozen design.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PLAN_PATH = path.join(__dirname, 'plan.json');
const RUNTIME_SEED_PATH = path.join(__dirname, '.runtime', 'security-seed.json');
const ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const EXPECTED_COLLECTIONS = ['colleges', 'users', 'risk_rules'];
const SERVER_TIMESTAMP = 'serverTimestamp';
const BCRYPT_COST = 12;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/;
const REQUIRED_RISK_DEFAULTS = {
  highAmount: 5000,
  midAmountMin: 1,
  repeatAlertWindowDays: 30,
  highAlertRepeatCount: 3,
  midAlertRepeatCount: 2,
  slaFirstFollowHours: 48
};
const REQUIRED_FRAUD_TYPES = [
  'part_time_scam',
  'impersonate_public',
  'fake_loan',
  'fake_refund'
];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function readPlan() {
  try {
    return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  } catch (error) {
    fail(`Unable to read plan.json: ${error.message}`);
  }
}

function readRuntimeSecuritySeed(required) {
  if (!fs.existsSync(RUNTIME_SEED_PATH)) {
    if (required) {
      fail('Runtime security seed is required at .runtime/security-seed.json');
    }
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_SEED_PATH, 'utf8'));
  } catch (error) {
    fail(`Unable to read runtime security seed: ${error.message}`);
  }
}

function collectionByName(plan, name) {
  const collection = plan.collections.find((item) => item.collectionName === name);
  if (!collection) {
    fail(`Missing required collection: ${name}`);
  }
  return collection;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} must be ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}`);
  }
}

function assertArrayEqual(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(`${label} does not match the frozen design`);
  }
}

function assertRequired(document, fields, label) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(document, field)) {
      fail(`${label}.${field} is required`);
    }
  }
}

function assertExactFields(document, fields, label) {
  const actual = Object.keys(document).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(`${label} must contain exactly the frozen design fields`);
  }
}

function assertServerTimestamps(document, fields, label) {
  for (const field of fields) {
    assertEqual(document[field], SERVER_TIMESTAMP, `${label}.${field}`);
  }
}

function assertNonEmpty(value, label) {
  if (value === null || value === undefined || value === '') {
    fail(`${label} must be present, non-null, and non-empty`);
  }
}

function assertNoDuplicate(values, label) {
  const seen = new Set();
  for (const value of values) {
    assertNonEmpty(value, label);
    if (seen.has(value)) {
      fail(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function assertNoSensitiveMaterial(value, location = 'plan') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveMaterial(item, `${location}[${index}]`));
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (/^(token|secret|privateKey)$/i.test(key)) {
      fail(`${childLocation} is prohibited in the implementation plan`);
    }
    if (/^password$/i.test(key)) {
      fail(`${childLocation} is prohibited in the implementation plan`);
    }
    if (typeof child === 'string' && /DEMO_PASSWORD_PLACEHOLDER/i.test(child)) {
      fail(`${childLocation} must not contain a password-hash placeholder`);
    }
    assertNoSensitiveMaterial(child, childLocation);
  }
}

function validateCollectionStructure(collection) {
  if (!Array.isArray(collection.indexes) || !Array.isArray(collection.uniqueIndexes)) {
    fail(`${collection.collectionName} must define indexes and uniqueIndexes arrays`);
  }
  if (!collection.securityPolicy || collection.securityPolicy.clientRead !== false || collection.securityPolicy.clientWrite !== false) {
    fail(`${collection.collectionName} must deny direct client read and write`);
  }

  for (const index of collection.uniqueIndexes) {
    if (!Array.isArray(index.fields) || index.fields.length === 0 || !Array.isArray(index.requiredNonNullFields)) {
      fail(`${collection.collectionName}.${index.name} must declare non-null UNIQUE fields`);
    }
    assertArrayEqual(index.requiredNonNullFields, index.fields, `${collection.collectionName}.${index.name}.requiredNonNullFields`);
  }
}

function validateColleges(colleges) {
  const documents = colleges.seedData.documents;
  if (!Array.isArray(documents) || documents.length === 0) {
    fail('colleges must include at least one seed document');
  }
  for (const document of documents) {
    assertRequired(document, colleges.validationRules.requiredFields, `colleges[${document._id || 'unknown'}]`);
    if (!/^college_[a-z0-9_]+$/.test(document._id)) {
      fail(`Invalid colleges._id: ${document._id}`);
    }
    if (!colleges.validationRules.statusEnum.includes(document.status)) {
      fail(`Invalid colleges.status: ${document.status}`);
    }
    if (!Array.isArray(document.aliases)) {
      fail(`colleges[${document._id}].aliases must be an array`);
    }
    assertServerTimestamps(document, colleges.validationRules.timeFields, `colleges[${document._id}]`);
  }
}

function validateUserRole(document) {
  const label = `users[${document._id || 'unknown'}]`;
  assertNonEmpty(document.identityKey, `${label}.identityKey`);
  assertNonEmpty(document.wxIdentityKey, `${label}.wxIdentityKey`);
  assertEqual(document.wxOpenId, null, `${label}.wxOpenId`);
  assertEqual(document.wxIdentityKey, `unbound:${document._id}`, `${label}.wxIdentityKey`);
  assertEqual(document.focusFlag, false, `${label}.focusFlag`);
  assertEqual(document.focusReason, null, `${label}.focusReason`);
  assertEqual(document.status, 'active', `${label}.status`);
  assertEqual(document.version, 1, `${label}.version`);

  if (document.role === 'student') {
    assertNonEmpty(document.studentNo, `${label}.studentNo`);
    assertEqual(document.identityKey, `student:${document.studentNo}`, `${label}.identityKey`);
    assertNonEmpty(document.collegeId, `${label}.collegeId`);
    assertEqual(document.staffNo, null, `${label}.staffNo`);
    assertEqual(document.loginName, null, `${label}.loginName`);
    assertEqual(document.passwordHash, null, `${label}.passwordHash`);
    assertEqual(document.bindStatus, 'unbound', `${label}.bindStatus`);
    return;
  }

  if (document.role === 'counselor') {
    assertNonEmpty(document.staffNo, `${label}.staffNo`);
    assertEqual(document.identityKey, `counselor:${document.staffNo}`, `${label}.identityKey`);
    assertNonEmpty(document.collegeId, `${label}.collegeId`);
    assertEqual(document.studentNo, null, `${label}.studentNo`);
    assertEqual(document.loginName, null, `${label}.loginName`);
    assertEqual(document.passwordHash, null, `${label}.passwordHash`);
    assertEqual(document.bindStatus, 'unbound', `${label}.bindStatus`);
    return;
  }

  if (document.role === 'security') {
    assertNonEmpty(document.loginName, `${label}.loginName`);
    assertEqual(document.identityKey, `security:${document.loginName}`, `${label}.identityKey`);
    assertEqual(document.collegeId, null, `${label}.collegeId`);
    assertEqual(document.studentNo, null, `${label}.studentNo`);
    assertEqual(document.staffNo, null, `${label}.staffNo`);
    assertEqual(document.bindStatus, 'not_applicable', `${label}.bindStatus`);
    return;
  }

  fail(`${label}.role is invalid`);
}

function validateSecurityRuntimeSeed(seed, users, runtime) {
  const label = 'runtime security seed';
  assertExactFields(seed, users.fields, label);
  assertRequired(seed, users.validationRules.requiredFields, label);
  validateUserRole(seed);
  assertServerTimestamps(seed, users.validationRules.timeFields, label);
  assertEqual(seed._id, runtime.securityAccountDocument._id, `${label}._id`);
  assertEqual(seed.identityKey, runtime.securityAccountDocument.identityKey, `${label}.identityKey`);
  assertEqual(seed.wxIdentityKey, runtime.securityAccountDocument.wxIdentityKey, `${label}.wxIdentityKey`);
  assert(typeof seed.passwordHash === 'string' && BCRYPT_HASH_PATTERN.test(seed.passwordHash), `${label}.passwordHash must be a bcrypt cost-12 hash`);
  if (/DEMO_PASSWORD_PLACEHOLDER/i.test(seed.passwordHash)) {
    fail(`${label}.passwordHash must not contain a placeholder`);
  }
}

function validateUsers(users, runtimeSecuritySeed) {
  const documents = users.seedData.documents;
  const runtime = users.seedData.runtimePasswordInitialization;
  if (!Array.isArray(documents) || !runtime) {
    fail('users seed data and runtime password initialization are required');
  }
  if (runtime.requiresRuntimePasswordInitialization !== true || runtime.runtimeSeedPath !== '.runtime/security-seed.json' || runtime.sourceEnvironmentVariable !== 'DEMO_SECURITY_PASSWORD') {
    fail('security password initialization must remain a required runtime operation');
  }
  if (!Array.isArray(runtime.requiredFieldsAtWriteTime) || !runtime.requiredFieldsAtWriteTime.includes('passwordHash')) {
    fail('security passwordHash must be required when writing the security account');
  }
  assertEqual(runtime.passwordHashAlgorithm, 'bcrypt', 'passwordHashAlgorithm');
  assertEqual(runtime.passwordHashLibrary, 'bcryptjs', 'passwordHashLibrary');
  assertEqual(runtime.passwordHashCost, BCRYPT_COST, 'passwordHashCost');

  const securityDocument = runtime.securityAccountDocument;
  if (Object.prototype.hasOwnProperty.call(securityDocument, 'passwordHash')) {
    fail('The security account template must not contain a passwordHash value');
  }
  const allDocuments = [...documents, securityDocument];
  if (allDocuments.length < 3) {
    fail('users must cover student, counselor, and security roles');
  }
  assertNoDuplicate(allDocuments.map((document) => document._id), 'users._id');
  assertNoDuplicate(allDocuments.map((document) => document.identityKey), 'users.identityKey');
  assertNoDuplicate(allDocuments.map((document) => document.wxIdentityKey), 'users.wxIdentityKey');

  const roleCounts = { student: 0, counselor: 0, security: 0 };
  for (const document of allDocuments) {
    const fields = document.role === 'security'
      ? users.validationRules.requiredFields.filter((field) => field !== 'passwordHash')
      : users.validationRules.requiredFields;
    assertRequired(document, fields, `users[${document._id || 'unknown'}]`);
    validateUserRole(document);
    assertServerTimestamps(document, users.validationRules.timeFields, `users[${document._id}]`);
    roleCounts[document.role] += 1;
  }
  for (const role of Object.keys(roleCounts)) {
    if (roleCounts[role] < 1) {
      fail(`users must include a ${role} demonstration account`);
    }
  }
  if (runtimeSecuritySeed) {
    validateSecurityRuntimeSeed(runtimeSecuritySeed, users, runtime);
  }
}

function validateRiskRules(riskRules, securityDocument) {
  const documents = riskRules.seedData.documents;
  if (!Array.isArray(documents) || documents.length !== 1) {
    fail('risk_rules must contain exactly one seed document');
  }
  const document = documents[0];
  assertRequired(document, riskRules.validationRules.requiredFields, 'risk_rules[0]');
  assertEqual(document._id, 'rule_default', 'risk_rules._id');
  assertEqual(document.name, '第一版默认风险规则', 'risk_rules.name');
  assertEqual(document.status, 'enabled', 'risk_rules.status');
  assertEqual(document.version, 1, 'risk_rules.version');
  for (const [field, expectedValue] of Object.entries(REQUIRED_RISK_DEFAULTS)) {
    assertEqual(document[field], expectedValue, `risk_rules.${field}`);
  }
  assertArrayEqual(document.keyFraudTypes, REQUIRED_FRAUD_TYPES, 'risk_rules.keyFraudTypes');
  assertNonEmpty(document.updatedBy, 'risk_rules.updatedBy');
  assert(securityDocument && securityDocument._id === document.updatedBy, 'risk_rules.updatedBy must reference an existing security user');
  assertEqual(securityDocument.role, 'security', 'risk_rules.updatedBy role');
  assertServerTimestamps(document, riskRules.validationRules.timeFields, 'risk_rules');
}

function validateIndexes(users) {
  const totalIndexes = users.indexes.length + users.uniqueIndexes.length;
  assertEqual(totalIndexes, 3, 'A-group index count');
  assertEqual(users.indexes.length, 1, 'users non-unique index count');
  const composite = users.indexes[0];
  assertEqual(composite.name, 'collegeId_focusFlag_status', 'users composite index name');
  assertArrayEqual(composite.fields.map((field) => field.field), ['collegeId', 'focusFlag', 'status'], 'users composite index fields');
  if (composite.fields.some((field) => field.order !== 'asc')) {
    fail('users composite index order must match the frozen design');
  }
  assertArrayEqual(users.uniqueIndexes.map((index) => index.name).sort(), ['identityKey_unique', 'wxIdentityKey_unique'], 'users UNIQUE index names');
}

function validateImplementationStatus(plan) {
  const status = plan.implementationStatus;
  const expectedSequence = [
    'create and initialize colleges',
    'initialize student and counselor users',
    'create runtime security user from .runtime/security-seed.json',
    'initialize risk_rules only after the security user exists and is verified'
  ];
  assertArrayEqual(plan.executionSequence.map((step) => step.operation), expectedSequence, 'executionSequence');

  if (!status || !status.currentCloudBaseState) {
    fail('A-group implementationStatus and currentCloudBaseState are required');
  }
  // Historical pre-remediation state support only; it is not the current A-group status.
  if (status.status === 'PARTIAL') {
    assertEqual(status.remediationRequired, true, 'PARTIAL remediationRequired');
    assertEqual(status.blockNextGroup, true, 'PARTIAL blockNextGroup');
    assertEqual(status.currentCloudBaseState.colleges, 1, 'PARTIAL colleges count');
    assertEqual(status.currentCloudBaseState.users, 2, 'PARTIAL users count');
    assertEqual(status.currentCloudBaseState.risk_rules, 1, 'PARTIAL risk_rules count');
    assert(typeof status.knownIssue === 'string' && status.knownIssue.includes('usr_security_demo_001'), 'PARTIAL known dangling updatedBy reference must be recorded');
    return;
  }
  if (status.status === 'PASSED') {
    assertEqual(status.remediationRequired, false, 'PASSED remediationRequired');
    assertEqual(status.blockNextGroup, false, 'PASSED blockNextGroup');
    assertEqual(status.currentCloudBaseState.colleges, 1, 'PASSED colleges count');
    assertEqual(status.currentCloudBaseState.users, 3, 'PASSED users count');
    assertEqual(status.currentCloudBaseState.risk_rules, 1, 'PASSED risk_rules count');
    assertEqual(status.knownIssue, null, 'PASSED knownIssue');
    return;
  }
  fail(`Unsupported A-group implementation status: ${status.status}`);
}

function validatePlan(plan = readPlan(), options = {}) {
  assertEqual(plan.envId, ENV_ID, 'envId');
  if (!Array.isArray(plan.collections) || plan.collections.length !== EXPECTED_COLLECTIONS.length) {
    fail('A group must contain exactly three collections');
  }
  assertArrayEqual(plan.creationOrder, EXPECTED_COLLECTIONS, 'creationOrder');
  assertArrayEqual(plan.collections.map((collection) => collection.collectionName).sort(), [...EXPECTED_COLLECTIONS].sort(), 'A-group collections');
  validateImplementationStatus(plan);
  plan.collections.forEach(validateCollectionStructure);

  const colleges = collectionByName(plan, 'colleges');
  const users = collectionByName(plan, 'users');
  const riskRules = collectionByName(plan, 'risk_rules');
  const runtimeSecuritySeed = Object.prototype.hasOwnProperty.call(options, 'runtimeSecuritySeed')
    ? options.runtimeSecuritySeed
    : options.requireRuntimeSecuritySeed === true
      ? readRuntimeSecuritySeed(true)
      : null;
  validateColleges(colleges);
  validateUsers(users, runtimeSecuritySeed);
  validateRiskRules(riskRules, runtimeSecuritySeed || users.seedData.runtimePasswordInitialization.securityAccountDocument);
  validateIndexes(users);
  assertNoSensitiveMaterial(plan);
  return plan;
}

if (require.main === module) {
  try {
    const requireRuntimeSecuritySeed = process.argv.includes('--require-runtime-security-seed');
    const plan = validatePlan(undefined, { requireRuntimeSecuritySeed });
    console.log(requireRuntimeSecuritySeed
      ? 'A-group runtime security seed validation passed'
      : `A-group static plan validation passed (${plan.implementationStatus.status})`);
  } catch (error) {
    console.error(`A-group plan validation failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  validatePlan
};
