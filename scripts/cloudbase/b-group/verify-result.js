'use strict';

const fs = require('fs');
const path = require('path');
const { validatePlan } = require('./validate-plan');

const PLAN_PATH = path.join(__dirname, 'plan.json');
const ENV_ID = 'aa-d4gvb4o3t50fc94f8';

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
function snapshotArgument(argumentsList) {
  const index = argumentsList.indexOf('--snapshot');
  if (index < 0 || !argumentsList[index + 1]) fail('Usage: node verify-result.js --snapshot <read-only-inventory.json>');
  return argumentsList[index + 1];
}
function isDateMarker(value) {
  return value && typeof value === 'object' && value.$type === 'Date' && typeof value.value === 'string' && !Number.isNaN(Date.parse(value.value));
}
function exactKeys(document, fields, label) {
  const actual = Object.keys(document).sort();
  const expected = [...fields].sort();
  assert(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${label} fields differ from plan.json`);
}
function canonicalIndexes(indexes) {
  return indexes.map((index) => index.fields.map((field) => `${field.field}:${field.order}${index.unique ? ':unique' : ''}`).join('|'));
}
function collectionByName(snapshot, name) {
  const item = snapshot.collections.find((collection) => collection.collectionName === name);
  assert(item, `Snapshot is missing ${name}`);
  return item;
}
function verifyRecord(document, planCollection, label) {
  exactKeys(document, planCollection.fields, label);
  for (const field of planCollection.dateFields) {
    if (document[field] !== null && document[field] !== undefined) assert(isDateMarker(document[field]), `${label}.${field} must be a Date marker`);
  }
  if (planCollection.version.present) assert(document.version === 1 || (Number.isInteger(document.version) && document.version > 1), `${label}.version must be a positive integer`);
  else assert(!Object.prototype.hasOwnProperty.call(document, 'version'), `${label} must not contain version`);
  if (planCollection.collectionName === 'fraud_reports') {
    assert(typeof document.sourceAlertKey === 'string' && document.sourceAlertKey.length > 0, `${label}.sourceAlertKey must be non-empty`);
    const linked = document.sourceAlertId !== null && document.sourceAlertId !== undefined;
    assert(linked ? document.sourceAlertKey === `alert:${document.sourceAlertId}` : document.sourceAlertKey === `standalone:${document._id}`, `${label}.sourceAlertKey format is invalid`);
  }
}
function verifySnapshot(snapshot, plan) {
  assert(snapshot.envId === ENV_ID && plan.envId === ENV_ID, `Snapshot envId must be ${ENV_ID}`);
  assert(Array.isArray(snapshot.collections) && snapshot.collections.length === plan.allowedCollections.length, 'Snapshot must contain exactly four B-group collections');
  for (const name of plan.allowedCollections) {
    const expected = plan.collections.find((collection) => collection.collectionName === name);
    const actual = collectionByName(snapshot, name);
    assert(actual.exists === true, `${name} must exist`);
    assert(actual.securityPolicy && actual.securityPolicy.clientRead === false && actual.securityPolicy.clientWrite === false, `${name} ACL must deny client read/write`);
    assert(JSON.stringify(canonicalIndexes(actual.indexes)) === JSON.stringify(canonicalIndexes(expected.indexes)), `${name} indexes or field order differ from frozen design`);
    assert(Array.isArray(actual.sampleDocuments), `${name}.sampleDocuments must be an array`);
    actual.sampleDocuments.forEach((document, index) => verifyRecord(document, expected, `${name}.sampleDocuments[${index}]`));
  }
  const report = collectionByName(snapshot, 'fraud_reports');
  const uniqueIndexes = report.indexes.filter((index) => index.unique === true);
  assert(uniqueIndexes.length === 1 && uniqueIndexes[0].fields.length === 1 && uniqueIndexes[0].fields[0].field === 'sourceAlertKey', 'fraud_reports must have only sourceAlertKey UNIQUE');
  return true;
}
function main() {
  const plan = validatePlan(readJson(PLAN_PATH));
  const snapshot = readJson(snapshotArgument(process.argv.slice(2)));
  verifySnapshot(snapshot, plan);
  console.log('B-group read-only snapshot verification passed');
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(`B-group verification failed: ${error.message}`); process.exit(1); }
}
module.exports = { verifySnapshot };
