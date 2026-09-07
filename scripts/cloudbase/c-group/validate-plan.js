'use strict';

const fs = require('fs');
const path = require('path');

const ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const COLLECTIONS = ['learning_articles', 'quiz_questions', 'quiz_attempts', 'learning_records', 'audit_logs'];
const APPEND_ONLY = ['quiz_attempts', 'learning_records', 'audit_logs'];
const VERSIONED = ['learning_articles', 'quiz_questions'];
const FIELDS = {
  learning_articles: ['_id', 'title', 'category', 'summary', 'content', 'fraudTags', 'publishStatus', 'authorId', 'publishedAt', 'version', 'createdAt', 'updatedAt'],
  quiz_questions: ['_id', 'questionType', 'stem', 'options', 'correctOptionIds', 'explanation', 'fraudTags', 'status', 'version', 'createdAt', 'updatedAt'],
  quiz_attempts: ['_id', 'studentId', 'answers', 'score', 'totalScore', 'submittedAt', 'createdAt'],
  learning_records: ['_id', 'studentId', 'articleId', 'completedAt', 'createdAt'],
  audit_logs: ['_id', 'actorId', 'actorRole', 'actorCollegeId', 'action', 'resourceType', 'resourceId', 'result', 'failureReason', 'beforeSummary', 'afterSummary', 'requestId', 'createdAt']
};
const REQUIRED = {
  learning_articles: ['_id', 'title', 'category', 'summary', 'content', 'fraudTags', 'publishStatus', 'authorId', 'version', 'createdAt', 'updatedAt'],
  quiz_questions: ['_id', 'questionType', 'stem', 'options', 'correctOptionIds', 'explanation', 'fraudTags', 'status', 'version', 'createdAt', 'updatedAt'],
  quiz_attempts: ['_id', 'studentId', 'answers', 'score', 'totalScore', 'submittedAt', 'createdAt'],
  learning_records: ['_id', 'studentId', 'articleId', 'completedAt', 'createdAt'],
  audit_logs: ['_id', 'actorId', 'actorRole', 'action', 'resourceType', 'resourceId', 'result', 'requestId', 'createdAt']
};
const NULLABLE = {
  learning_articles: ['publishedAt'], quiz_questions: [], quiz_attempts: [], learning_records: [],
  audit_logs: ['actorCollegeId', 'failureReason', 'beforeSummary', 'afterSummary']
};
const CONDITIONAL = {
  learning_articles: { publishedAt: 'when publishStatus=published' }, quiz_questions: {}, quiz_attempts: {}, learning_records: {},
  audit_logs: { failureReason: 'when result=failure' }
};
const DATES = {
  learning_articles: ['publishedAt', 'createdAt', 'updatedAt'], quiz_questions: ['createdAt', 'updatedAt'],
  quiz_attempts: ['submittedAt', 'createdAt'], learning_records: ['completedAt', 'createdAt'], audit_logs: ['createdAt']
};
const FIELD_SOURCES = {
  learning_articles: { clientInputFields: ['title', 'category', 'summary', 'content', 'fraudTags'], serverDerivedFields: ['authorId'], serverControlledFields: ['_id', 'publishStatus', 'publishedAt', 'version', 'createdAt', 'updatedAt'] },
  quiz_questions: { clientInputFields: ['questionType', 'stem', 'options', 'correctOptionIds', 'explanation', 'fraudTags'], serverDerivedFields: [], serverControlledFields: ['_id', 'status', 'version', 'createdAt', 'updatedAt'] },
  quiz_attempts: { clientInputFields: [], serverDerivedFields: ['studentId', 'answers', 'score', 'totalScore'], serverControlledFields: ['_id', 'submittedAt', 'createdAt'] },
  learning_records: { clientInputFields: ['articleId'], serverDerivedFields: ['studentId'], serverControlledFields: ['_id', 'completedAt', 'createdAt'] },
  audit_logs: { clientInputFields: [], serverDerivedFields: ['actorId', 'actorRole', 'actorCollegeId'], serverControlledFields: ['_id', 'action', 'resourceType', 'resourceId', 'result', 'failureReason', 'beforeSummary', 'afterSummary', 'requestId', 'createdAt'] }
};
const ENUMS = {
  learning_articles: { category: ['case', 'knowledge'], publishStatus: ['draft', 'published', 'disabled'] },
  quiz_questions: { questionType: ['single', 'multiple', 'boolean'], status: ['enabled', 'disabled'] },
  quiz_attempts: {}, learning_records: {}, audit_logs: { result: ['success', 'failure'] }
};
const FOREIGN_KEYS = {
  learning_articles: { authorId: 'users._id' }, quiz_questions: {},
  quiz_attempts: { studentId: 'users._id', 'answers[].questionId': 'quiz_questions._id' },
  learning_records: { studentId: 'users._id', articleId: 'learning_articles._id' },
  audit_logs: { actorId: 'users._id', actorCollegeId: 'colleges._id' }
};
const INDEXES = {
  learning_articles: ['publishStatus:asc|publishedAt:desc'], quiz_questions: ['status:asc'],
  quiz_attempts: ['studentId:asc|submittedAt:desc', 'submittedAt:desc'],
  learning_records: ['studentId:asc:unique|articleId:asc:unique', 'studentId:asc|completedAt:desc', 'completedAt:desc'],
  audit_logs: ['actorId:asc|createdAt:desc', 'resourceType:asc|resourceId:asc|createdAt:desc', 'action:asc|createdAt:desc']
};

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function equal(actual, expected, label) { assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
function same(actual, expected, label) { assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} differs from frozen design`); }
function readPlan() { return JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8')); }
function byName(plan, name) { const value = plan.collections.find((item) => item.collectionName === name); assert(value, `Missing collection ${name}`); return value; }
function indexSignature(index) { return index.fields.map((field) => `${field.field}:${field.order}${index.unique ? ':unique' : ''}`).join('|'); }
function assertFieldPartition(item, name) {
  const sources = FIELD_SOURCES[name];
  for (const key of Object.keys(sources)) same(item[key], sources[key], `${name}.${key}`);
  const listed = [...item.clientInputFields, ...item.serverDerivedFields, ...item.serverControlledFields].sort();
  same(listed, FIELDS[name].slice().sort(), `${name} field-source partition`);
}
function assertNoSensitiveMaterial(plan) {
  const text = JSON.stringify(plan).toLowerCase();
  for (const pattern of ['wxopenid', 'passwordhash', 'openid', 'token', 'secret', 'demo_password_placeholder']) assert(!text.includes(pattern), `Plan must not include sensitive real material or credentials (${pattern})`);
}
function validateCollection(item, name) {
  same(item.fields, FIELDS[name], `${name}.fields`);
  same(item.requiredFields, REQUIRED[name], `${name}.requiredFields`);
  same(item.nullableFields, NULLABLE[name], `${name}.nullableFields`);
  same(item.conditionalRequiredFields, CONDITIONAL[name], `${name}.conditionalRequiredFields`);
  same(item.dateFields, DATES[name], `${name}.dateFields`);
  same(item.serverTimestampFields, DATES[name], `${name}.serverTimestampFields`);
  same(item.foreignKeys, FOREIGN_KEYS[name], `${name}.foreignKeys`);
  assertFieldPartition(item, name);
  same(item.enums, ENUMS[name], `${name}.enums`);
  equal(item.expectedDocumentCount, 0, `${name}.expectedDocumentCount`);
  assert(item.securityPolicy.clientRead === false && item.securityPolicy.clientWrite === false && item.securityPolicy.cloudBaseAcl === 'ADMINONLY', `${name} must be ADMINONLY`);
  assert(Array.isArray(item.seedData.documents) && item.seedData.documents.length === 0, `${name}.seedData.documents must be empty`);
  same(item.indexes.map(indexSignature), INDEXES[name], `${name}.indexes`);
  for (const index of item.indexes) assert(index.unique === false || name === 'learning_records', `${name} must not have a UNIQUE index`);
  if (APPEND_ONLY.includes(name)) {
    assert(item.appendOnly === true, `${name}.appendOnly must be true`);
    same(item.version, { present: false, createDefault: null, immutableAfterCreate: true }, `${name}.version`);
  } else {
    assert(!Object.prototype.hasOwnProperty.call(item, 'appendOnly'), `${name} must not be append-only`);
    same(item.version, { present: true, createDefault: 1, updateCondition: ['_id', 'version'] }, `${name}.version`);
  }
}
function validatePlan(plan = readPlan()) {
  equal(plan.envId, ENV_ID, 'envId'); equal(plan.group, 'C', 'group'); equal(plan.serverTimestampMarker, 'serverTimestamp', 'serverTimestampMarker');
  same(plan.allowedCollections, COLLECTIONS, 'allowedCollections'); same(plan.creationOrder, COLLECTIONS, 'creationOrder');
  same(plan.cloudBaseCollectionModel, { hasFixedPhysicalFieldSchema: false, physicalResources: ['collection', 'indexes', 'acl'], staticContracts: ['fields', 'requiredness', 'Date', 'fieldSources', 'enums', 'version', 'appendOnly', 'responseSecurity'] }, 'cloudBaseCollectionModel');
  same(plan.implementationStatus, { status: 'PREPARED', scope: 'Static implementation preparation only; no CloudBase resource has been operated by this plan.', currentCloudBaseState: null }, 'implementationStatus');
  same(plan.idempotencyPolicy, { existingExactMatch: 'verify_and_skip', existingMismatch: 'stop_and_report', missingDuringImplementation: 'create_after_read_only_check', missingDuringAcceptance: 'fail', forbiddenProbeCollectionNames: ['__probe__', 'probe', 'test', 'temp'] }, 'idempotencyPolicy');
  assert(Array.isArray(plan.initializationPolicy.documents) && plan.initializationPolicy.documents.length === 0, 'initializationPolicy.documents must be empty');
  same(plan.initializationPolicy.deferredApprovedScope, ['learning_articles', 'quiz_questions'], 'deferredApprovedScope');
  assert(plan.collections.length === COLLECTIONS.length, 'C group must contain exactly five collections');
  for (const name of COLLECTIONS) validateCollection(byName(plan, name), name);
  const articles = byName(plan, 'learning_articles');
  equal(articles.sensitiveConstraints.authorId, 'server-derived security users._id; never trust client input', 'learning_articles authorId constraint');
  const questions = byName(plan, 'quiz_questions');
  same(questions.responseSecurity, { studentExcludedFields: ['correctOptionIds'], answerPhaseExcludedFields: ['explanation'] }, 'quiz_questions.responseSecurity');
  const attempts = byName(plan, 'quiz_attempts');
  same(attempts.answerContract, { storedFields: ['questionId', 'selectedOptionIds', 'isCorrect'], storageRule: 'server validates submitted answers before persisting' }, 'quiz_attempts.answerContract');
  const records = byName(plan, 'learning_records');
  same(records.controlledClientInputFields, { articleId: 'allowlisted cloud-function input; server verifies article exists and is learnable' }, 'learning_records controlled input');
  same(records.uniqueRules, [{ fields: ['studentId', 'articleId'], requiredNonNull: true, forbiddenSingleFieldUnique: ['studentId', 'articleId'] }], 'learning_records.uniqueRules');
  const audit = byName(plan, 'audit_logs');
  same(audit.actionDictionary, { status: 'not_frozen', reason: 'DATABASE-DESIGN-v0.2 does not define a complete action enum; only its stated audit action semantics may be used.' }, 'audit_logs.actionDictionary');
  equal(audit.sensitiveConstraints.actorCollegeId, 'event snapshot; null for security', 'audit_logs actorCollegeId constraint');
  const totalIndexes = plan.collections.reduce((sum, item) => sum + item.indexes.length, 0);
  equal(totalIndexes, 10, 'C-group custom index count');
  const uniqueIndexes = plan.collections.flatMap((item) => item.indexes.filter((index) => index.unique).map((index) => `${item.collectionName}:${indexSignature(index)}`));
  same(uniqueIndexes, ['learning_records:studentId:asc:unique|articleId:asc:unique'], 'C-group UNIQUE indexes');
  assertNoSensitiveMaterial(plan);
  return plan;
}

if (require.main === module) {
  try { validatePlan(); console.log('C-group static plan validation passed'); }
  catch (error) { console.error(`C-group plan validation failed: ${error.message}`); process.exit(1); }
}
module.exports = { validatePlan, ENV_ID, COLLECTIONS, INDEXES };
