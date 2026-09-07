'use strict';

const fs = require('fs');
const path = require('path');
const { validatePlan, ENV_ID, COLLECTIONS } = require('./validate-plan');

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
function snapshotArgument(args) { const index = args.indexOf('--snapshot'); if (index < 0 || !args[index + 1]) fail('Usage: node verify-result.js --snapshot <read-only-inventory.json>'); return args[index + 1]; }
function signature(index) { return index.fields.map((field) => `${field.field}:${field.order}${index.unique ? ':unique' : ''}`).join('|'); }
function verifySnapshot(snapshot, suppliedPlan) {
  const plan = validatePlan(suppliedPlan);
  assert(snapshot.envId === ENV_ID, `Snapshot envId must be ${ENV_ID}`);
  assert(Array.isArray(snapshot.collections) && snapshot.collections.length === COLLECTIONS.length, 'Snapshot must contain exactly five planned C-group collections');
  assert(new Set(snapshot.collections.map((item) => item.collectionName)).size === COLLECTIONS.length, 'Snapshot collections must not contain duplicates');
  const names = snapshot.collections.map((item) => item.collectionName).sort();
  assert(JSON.stringify(names) === JSON.stringify(COLLECTIONS.slice().sort()), 'Snapshot contains a planned-external or missing C-group collection');
  for (const expected of plan.collections) {
    const actual = snapshot.collections.find((item) => item.collectionName === expected.collectionName);
    assert(actual && actual.exists === true, `${expected.collectionName} must exist during acceptance`);
    assert(Number.isInteger(actual.documentCount) && actual.documentCount === 0, `${expected.collectionName}.documentCount must be 0; STOP without deleting data`);
    assert(actual.securityPolicy && actual.securityPolicy.clientRead === false && actual.securityPolicy.clientWrite === false && actual.securityPolicy.cloudBaseAcl === 'ADMINONLY', `${expected.collectionName} ACL must be ADMINONLY`);
    assert(Array.isArray(actual.indexes), `${expected.collectionName}.indexes must be present in read-only inventory`);
    assert(JSON.stringify(actual.indexes.map(signature).sort()) === JSON.stringify(expected.indexes.map(signature).sort()), `${expected.collectionName} indexes, field order, or UNIQUE differ from frozen design`);
  }
  const actualIndexCount = snapshot.collections.reduce((sum, item) => sum + item.indexes.length, 0);
  assert(actualIndexCount === 10, 'Snapshot must contain exactly 10 C-group custom indexes');
  return true;
}
function main() { const plan = readJson(path.join(__dirname, 'plan.json')); const snapshot = readJson(snapshotArgument(process.argv.slice(2))); verifySnapshot(snapshot, plan); console.log('C-group empty-collection read-only snapshot verification passed'); }
if (require.main === module) { try { main(); } catch (error) { console.error(`C-group verification failed: ${error.message}`); process.exit(1); } }
module.exports = { verifySnapshot };
