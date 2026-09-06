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
const bcrypt = require('bcryptjs');

const PLAN_PATH = path.join(__dirname, 'plan.json');
const RUNTIME_DIRECTORY = path.join(__dirname, '.runtime');
const RUNTIME_SEED_PATH = path.join(RUNTIME_DIRECTORY, 'security-seed.json');
const SECURITY_USER_ID = 'usr_security_demo_001';
const PASSWORD_ENVIRONMENT_VARIABLE = 'DEMO_SECURITY_PASSWORD';
const PASSWORD_HASH_COST = 12;

function fail(message) {
  throw new Error(message);
}

function readPlan() {
  return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
}

function getUsersCollection(plan) {
  const users = plan.collections.find((collection) => collection.collectionName === 'users');
  if (!users) {
    fail('users collection is missing from plan.json');
  }
  return users;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    fail('DEMO_SECURITY_PASSWORD must contain at least 12 characters');
  }
  const passwordBytes = Buffer.byteLength(password, 'utf8');
  if (passwordBytes > 72) {
    fail('DEMO_SECURITY_PASSWORD must not exceed 72 UTF-8 bytes for bcrypt');
  }
  const normalized = password.toLowerCase();
  for (const forbiddenValue of ['password', '123456', 'demo_password_placeholder']) {
    if (normalized.includes(forbiddenValue)) {
      fail('DEMO_SECURITY_PASSWORD contains a prohibited placeholder value');
    }
  }
}

function assertExactFields(document, expectedFields) {
  const actualFields = Object.keys(document).sort();
  const expected = [...expectedFields].sort();
  if (actualFields.length !== expected.length || actualFields.some((field, index) => field !== expected[index])) {
    fail('Runtime security seed fields must exactly match the users design');
  }
}

async function prepareSecuritySeed() {
  const password = process.env[PASSWORD_ENVIRONMENT_VARIABLE];
  if (!password) {
    fail('DEMO_SECURITY_PASSWORD is required');
  }
  validatePassword(password);

  const plan = readPlan();
  const users = getUsersCollection(plan);
  const runtime = users.seedData.runtimePasswordInitialization;
  if (!runtime || runtime.passwordHashLibrary !== 'bcryptjs' || runtime.passwordHashAlgorithm !== 'bcrypt' || runtime.passwordHashCost !== PASSWORD_HASH_COST) {
    fail('plan.json must require bcryptjs with cost factor 12');
  }
  if (runtime.securityAccountDocument._id !== SECURITY_USER_ID || runtime.sourceEnvironmentVariable !== PASSWORD_ENVIRONMENT_VARIABLE) {
    fail('plan.json security runtime configuration is invalid');
  }

  const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_COST);
  const seed = {
    ...runtime.securityAccountDocument,
    passwordHash
  };
  assertExactFields(seed, users.fields);
  if (seed.role !== 'security' || seed.identityKey !== `security:${seed.loginName}` || seed.wxOpenId !== null || seed.wxIdentityKey !== `unbound:${SECURITY_USER_ID}` || seed.bindStatus !== 'not_applicable' || seed.status !== 'active' || seed.version !== 1) {
    fail('Runtime security seed violates the frozen user design');
  }

  fs.mkdirSync(RUNTIME_DIRECTORY, { recursive: true });
  fs.writeFileSync(RUNTIME_SEED_PATH, `${JSON.stringify(seed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log('Runtime security seed prepared');
}

if (require.main === module) {
  prepareSecuritySeed().catch((error) => {
    console.error(`Failed to prepare runtime security seed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  prepareSecuritySeed,
  validatePassword
};
