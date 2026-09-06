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
const { validatePlan } = require('./validate-plan');

const PLAN_PATH = path.join(__dirname, 'plan.json');
const RUNTIME_SEED_PATH = path.join(__dirname, '.runtime', 'security-seed.json');
const ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/;

function fail(message) {
  throw new Error(message);
}

function loadPlan() {
  return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
}

function loadRuntimeSecuritySeed() {
  if (!fs.existsSync(RUNTIME_SEED_PATH)) {
    fail('Runtime security seed is required at .runtime/security-seed.json');
  }
  return JSON.parse(fs.readFileSync(RUNTIME_SEED_PATH, 'utf8'));
}

function collectionByName(plan, name) {
  const collection = plan.collections.find((item) => item.collectionName === name);
  if (!collection) {
    fail(`Missing ${name} from plan.json`);
  }
  return collection;
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function documentCount(collection) {
  return collection.seedData.documents.length;
}

function expectedUsers(users, runtimeSecuritySeed) {
  return [
    ...users.seedData.documents,
    runtimeSecuritySeed
  ];
}

async function verifyCollectionExists(db, name) {
  try {
    await db.collection(name).limit(1).get();
  } catch (error) {
    fail(`Collection ${name} is unavailable: ${error.message}`);
  }
}

async function verifyCount(db, name, expectedCount) {
  const result = await db.collection(name).count();
  assert(result.total === expectedCount, `${name} count must be ${expectedCount}; received ${result.total}`);
}

async function verifyByIds(db, name, documents) {
  for (const expected of documents) {
    const result = await db.collection(name).doc(expected._id).get();
    const actual = result.data && result.data[0];
    assert(actual, `${name}.${expected._id} is missing`);
    for (const [field, value] of Object.entries(expected)) {
      if (field === 'createdAt' || field === 'updatedAt' || field === 'passwordHash') {
        continue;
      }
      assert(JSON.stringify(actual[field]) === JSON.stringify(value), `${name}.${expected._id}.${field} differs from plan.json`);
    }
  }
}

async function verifyUsers(db, users, runtimeSecuritySeed) {
  const expected = expectedUsers(users, runtimeSecuritySeed);
  await verifyCount(db, 'users', expected.length);
  await verifyByIds(db, 'users', expected);

  const result = await db.collection('users').get();
  const documents = result.data || [];
  const identityKeys = documents.map((document) => document.identityKey);
  const wxIdentityKeys = documents.map((document) => document.wxIdentityKey);
  assert(identityKeys.every((value) => typeof value === 'string' && value.length > 0), 'All users.identityKey values must be non-empty');
  assert(wxIdentityKeys.every((value) => typeof value === 'string' && value.length > 0), 'All users.wxIdentityKey values must be non-empty');
  assert(new Set(identityKeys).size === identityKeys.length, 'users.identityKey values must be unique');
  assert(new Set(wxIdentityKeys).size === wxIdentityKeys.length, 'users.wxIdentityKey values must be unique');
  assert(documents.every((document) => document.wxOpenId === null), 'A-group demo users must not contain bound wxOpenId values');
  const securityUser = documents.find((document) => document._id === 'usr_security_demo_001');
  assert(securityUser && securityUser.role === 'security', 'users/usr_security_demo_001 must exist with role=security');
  assert(typeof securityUser.passwordHash === 'string' && BCRYPT_HASH_PATTERN.test(securityUser.passwordHash), 'security passwordHash must be a bcrypt cost-12 hash');
  return securityUser;
}

async function verifyRiskRules(db, riskRules, securityUser) {
  await verifyCount(db, 'risk_rules', documentCount(riskRules));
  const result = await db.collection('risk_rules').doc('rule_default').get();
  const rule = result.data && result.data[0];
  assert(rule, 'risk_rules.rule_default is missing');
  const expected = riskRules.seedData.documents[0];
  for (const [field, value] of Object.entries(expected)) {
    if (field === 'createdAt' || field === 'updatedAt') {
      continue;
    }
    assert(JSON.stringify(rule[field]) === JSON.stringify(value), `risk_rules.rule_default.${field} differs from plan.json`);
  }
  assert(rule.updatedBy === securityUser._id, 'risk_rules.rule_default.updatedBy must reference users/usr_security_demo_001');
  assert(securityUser.role === 'security', 'risk_rules.rule_default.updatedBy target must have role=security');
}

async function main() {
  const plan = loadPlan();
  const runtimeSecuritySeed = loadRuntimeSecuritySeed();
  validatePlan(plan, { runtimeSecuritySeed, requireRuntimeSecuritySeed: true });
  const envId = process.argv[2] || plan.envId;
  assert(envId === ENV_ID, `envId must be ${ENV_ID}`);
  assert(plan.envId === ENV_ID, `plan.json envId must be ${ENV_ID}`);

  let cloudbase;
  try {
    cloudbase = require('@cloudbase/node-sdk');
  } catch (error) {
    fail('The read-only verifier requires @cloudbase/node-sdk in an authenticated runtime. No credentials are stored by this script.');
  }

  const app = cloudbase.init({ env: envId });
  const db = app.database();
  const colleges = collectionByName(plan, 'colleges');
  const users = collectionByName(plan, 'users');
  const riskRules = collectionByName(plan, 'risk_rules');

  for (const name of ['colleges', 'users', 'risk_rules']) {
    await verifyCollectionExists(db, name);
  }
  await verifyCount(db, 'colleges', documentCount(colleges));
  await verifyByIds(db, 'colleges', colleges.seedData.documents);
  const securityUser = await verifyUsers(db, users, runtimeSecuritySeed);
  await verifyRiskRules(db, riskRules, securityUser);
  console.log('A-group deployment verification passed');
}

main().catch((error) => {
  console.error(`A-group deployment verification failed: ${error.message}`);
  process.exit(1);
});
