'use strict';

const fs = require('fs');
const path = require('path');
const { validatePlan } = require('./validate-plan');

const PLAN_PATH = path.join(__dirname, 'plan.json');
const ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const REQUIRED_DOCUMENT_COUNT = 0;

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
function snapshotArgument(argumentsList) {
  const index = argumentsList.indexOf('--snapshot');
  if (index < 0 || !argumentsList[index + 1]) fail('Usage: node verify-result.js --snapshot <read-only-inventory.json>');
  return argumentsList[index + 1];
}
function canonicalIndexes(indexes) {
  return indexes.map((index) => index.fields.map((field) => `${field.field}:${field.order}${index.unique ? ':unique' : ''}`).join('|')).sort();
}
function collectionByName(snapshot, name) {
  const item = snapshot.collections.find((collection) => collection.collectionName === name);
  assert(item, `Snapshot is missing ${name}`);
  return item;
}
function assertPassedPlan(plan) {
  const status = plan.implementationStatus;
  assert(status.status === 'PASSED', 'Plan implementationStatus.status must be PASSED before read-only verification');
  assert(status.remediationRequired === false, 'Plan implementationStatus.remediationRequired must be false before read-only verification');
  assert(status.blockNextGroup === false, 'Plan implementationStatus.blockNextGroup must be false before read-only verification');
  assert(status.knownIssue === null, 'Plan implementationStatus.knownIssue must be null before read-only verification');
  for (const name of plan.allowedCollections) assert(status.currentCloudBaseState[name] === REQUIRED_DOCUMENT_COUNT, `Plan currentCloudBaseState.${name} must be ${REQUIRED_DOCUMENT_COUNT}`);
  assert(status.currentCloudBaseState.customIndexCount === 12, 'Plan currentCloudBaseState.customIndexCount must be 12');
}
function verifySnapshot(snapshot, plan) {
  const validatedPlan = validatePlan(plan);
  assertPassedPlan(validatedPlan);
  assert(snapshot.envId === ENV_ID && validatedPlan.envId === ENV_ID, `Snapshot envId must be ${ENV_ID}`);
  assert(Array.isArray(snapshot.collections) && snapshot.collections.length === validatedPlan.allowedCollections.length, 'Snapshot must contain exactly four B-group collections');
  assert(new Set(snapshot.collections.map((collection) => collection.collectionName)).size === validatedPlan.allowedCollections.length, 'Snapshot collections must not contain duplicates');
  for (const name of validatedPlan.allowedCollections) {
    const expected = validatedPlan.collections.find((collection) => collection.collectionName === name);
    const actual = collectionByName(snapshot, name);
    assert(actual.exists === true, `${name} must exist`);
    assert(actual.securityPolicy && actual.securityPolicy.clientRead === false && actual.securityPolicy.clientWrite === false, `${name} ACL must deny client read/write`);
    assert(JSON.stringify(canonicalIndexes(actual.indexes)) === JSON.stringify(canonicalIndexes(expected.indexes)), `${name} indexes or field order differ from frozen design`);
    assert(Number.isInteger(actual.documentCount), `${name}.documentCount must be an integer`);
    assert(actual.documentCount === REQUIRED_DOCUMENT_COUNT, `${name}.documentCount must be ${REQUIRED_DOCUMENT_COUNT}; STOP without deleting existing records`);
    assert(actual.documentCount === expected.expectedDocumentCount, `${name}.documentCount must be ${expected.expectedDocumentCount}; STOP without deleting existing records`);
    if (Object.prototype.hasOwnProperty.call(actual, 'sampleDocuments')) {
      assert(Array.isArray(actual.sampleDocuments) && actual.sampleDocuments.length === 0, `${name}.sampleDocuments must be empty when documentCount=0`);
    }
  }
  const report = collectionByName(snapshot, 'fraud_reports');
  const uniqueIndexes = report.indexes.filter((index) => index.unique === true);
  assert(uniqueIndexes.length === 1 && uniqueIndexes[0].fields.length === 1 && uniqueIndexes[0].fields[0].field === 'sourceAlertKey', 'fraud_reports must have only sourceAlertKey UNIQUE');
  const actualIndexCount = snapshot.collections.reduce((total, item) => total + item.indexes.length, 0);
  assert(actualIndexCount === 12, 'Snapshot must contain exactly 12 B-group custom indexes');
  assert(actualIndexCount === validatedPlan.implementationStatus.currentCloudBaseState.customIndexCount, 'Snapshot custom index count must match PASSED plan status');
  return true;
}
function main() {
  const plan = validatePlan(readJson(PLAN_PATH));
  const snapshot = readJson(snapshotArgument(process.argv.slice(2)));
  verifySnapshot(snapshot, plan);
  console.log('B-group empty-collection read-only snapshot verification passed');
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(`B-group verification failed: ${error.message}`); process.exit(1); }
}
module.exports = { verifySnapshot };
