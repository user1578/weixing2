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
const OUTPUT_PATH = path.join(__dirname, 'WORKBUDDY-A-GROUP.txt');
const REMEDIATION_OUTPUT_PATH = path.join(__dirname, 'WORKBUDDY-A-GROUP-REMEDIATE.txt');

function readPlan() {
  return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
}

function formatValue(value) {
  return JSON.stringify(value, null, 2);
}

function formatIndexes(collection) {
  const lines = [];
  for (const index of collection.uniqueIndexes) {
    lines.push(`- UNIQUE ${index.name}: ${index.fields.join(', ')}; every field is required, non-null, and non-empty.`);
  }
  for (const index of collection.indexes) {
    const fields = index.fields.map((field) => `${field.field} ${field.order}`).join(', ');
    lines.push(`- ${index.name}: ${fields}.`);
  }
  return lines.length > 0 ? lines.join('\n') : '- No additional indexes.';
}

function formatSeedData(collection) {
  const documents = collection.seedData.documents || [];
  const lines = documents.map((document) => formatValue(document));
  if (collection.collectionName === 'users') {
    const runtime = collection.seedData.runtimePasswordInitialization;
    lines.push(formatValue({
      securityAccountDocument: runtime.securityAccountDocument,
      requiredFieldsAtWriteTime: runtime.requiredFieldsAtWriteTime,
      requiresRuntimePasswordInitialization: runtime.requiresRuntimePasswordInitialization,
      runtimeSeedPath: runtime.runtimeSeedPath,
      passwordHashLibrary: runtime.passwordHashLibrary,
      passwordHashAlgorithm: runtime.passwordHashAlgorithm,
      passwordHashCost: runtime.passwordHashCost,
      failureBehavior: runtime.failureBehavior
    }));
  }
  return lines.join('\n');
}

function buildInstructions(plan) {
  const sections = [
    'A-GROUP CLOUDBASE IMPLEMENTATION INSTRUCTIONS',
    '',
    `Only permitted environment: ${plan.envId}`,
    `Current deployment status: ${plan.implementationStatus.status} / remediation required`,
    `Known issue: ${plan.implementationStatus.knownIssue}`,
    'Do not mark A group as passed and do not enter B group until remediation and read-only verification succeed.',
    'Do not run any command against another environment.',
    'Do not change the frozen design, collection names, fields, indexes, seed data, or security requirements.',
    'Do not add or remove collections or indexes.',
    'Never create collections named __probe__, test, temp, or probe, and never create any A-group-external collection to test CloudBase capabilities.',
    'Capability validation may only be non-destructive against existing A-group resources. If that is not possible, STOP and report the capability as unknown.',
    'On any failure: STOP. Do not improvise a substitute and do not continue to the next collection.',
    '',
    'Required execution order:',
    ...plan.executionSequence.map((step) => `${step.step}. ${step.operation}`),
    '',
    'For each collection, complete every step in this order before continuing:',
    '1. Create the collection in the permitted environment.',
    '2. Create exactly the listed indexes.',
    '3. Set the listed security policy: client read=false and client write=false.',
    '4. Initialize exactly the listed data, using CloudBase server Date/serverDate for every serverTimestamp marker.',
    '5. Query the collection to verify the inserted data.',
    '6. Check the document count, index definitions, and all key fields.',
    '7. Continue only after all checks succeed.',
    ''
  ];

  for (const collectionName of plan.creationOrder) {
    const collection = plan.collections.find((item) => item.collectionName === collectionName);
    sections.push(`COLLECTION: ${collection.collectionName}`);
    sections.push(`Fields: ${collection.fields.join(', ')}`);
    sections.push('Indexes:');
    sections.push(formatIndexes(collection));
    sections.push('Security policy:');
    sections.push(`- Client read: ${collection.securityPolicy.clientRead}`);
    sections.push(`- Client write: ${collection.securityPolicy.clientWrite}`);
    sections.push(`- ${collection.securityPolicy.requirement}`);
    sections.push('Initialization data:');
    sections.push(formatSeedData(collection));
    sections.push('Validation after initialization:');
    sections.push(`- Query ${collection.collectionName}; confirm each listed document and required field.`);
    sections.push(`- Confirm client read and client write are both denied for ${collection.collectionName}.`);
    if (collection.collectionName === 'users') {
      sections.push('- Confirm identityKey and wxIdentityKey are non-null, non-empty, unique, and match their required formats.');
      sections.push('- Do not create UNIQUE indexes for wxOpenId, studentNo, staffNo, or loginName.');
      sections.push('- Create the security account only from .runtime/security-seed.json after prepare-security-seed.js completes successfully.');
      sections.push('- Before inserting users/usr_security_demo_001, convert createdAt and updatedAt serverTimestamp markers to CloudBase Date/current server time. Never write the literal string serverTimestamp to CloudBase.');
      sections.push('- The supplied passwordHash must use bcryptjs with cost factor 12; do not store clear-text credentials or a sample hash.');
    }
    if (collection.collectionName === 'risk_rules') {
      sections.push('- Before initializing rule_default in a new environment, query users and confirm users._id=usr_security_demo_001 exists and role=security.');
      sections.push('- If the runtime security seed is missing, invalid, or not present in users, A group is INCOMPLETE: STOP and do not write risk_rules.');
      sections.push('- rule_default.updatedBy must equal usr_security_demo_001 and reference that existing security user.');
      sections.push('- Confirm exactly one document exists and its _id is rule_default.');
      sections.push('- Confirm all six numeric defaults and all four keyFraudTypes exactly match the initialization data.');
    }
    sections.push('');
  }

  sections.push('Final A-group verification:');
  sections.push('- Confirm the current result is not marked passed until the missing security user exists and read-only reference verification succeeds.');
  sections.push('- Confirm exactly these three A-group collections were handled: colleges, users, risk_rules.');
  sections.push('- Confirm the A-group index total is exactly 3, all on users.');
  sections.push('- Run the supplied read-only verification script in an authenticated environment.');
  return `${sections.join('\n')}\n`;
}

function buildRemediationInstructions(plan) {
  const users = plan.collections.find((item) => item.collectionName === 'users');
  const runtime = users.seedData.runtimePasswordInitialization;
  const sections = [
    'A-GROUP REMEDIATION INSTRUCTIONS',
    '',
    `Only permitted environment: ${plan.envId}`,
    'Current status: PARTIAL / remediation required.',
    `Known dangling reference: ${plan.implementationStatus.knownIssue}`,
    'This remediation may only create the missing security user and perform read-only verification of risk_rules/rule_default.',
    'Do not update, delete, rebuild, or otherwise modify risk_rules/rule_default or any risk_rules field.',
    'Do not create __probe__, test, temp, probe, or any other collection. Do not test CloudBase capabilities by creating a collection.',
    'Do not modify colleges or the existing student/counselor users. If actual validation finds a conflict with DATABASE-DESIGN-v0.2, STOP and report it.',
    'On any failure: STOP.',
    '',
    `1. Confirm the environment is ${plan.envId}.`,
    `2. Read ${runtime.runtimeSeedPath}. Do not log its contents.`,
    '3. Create users/usr_security_demo_001 from that runtime seed only. Convert createdAt and updatedAt serverTimestamp markers to CloudBase Date/current server time before insertion; never write the literal string serverTimestamp.',
    '4. Query risk_rules/rule_default. Verify updatedBy=usr_security_demo_001 and every rule_default field matches plan.json. If any field differs, STOP and report it; do not modify risk_rules.',
    '5. Query users/usr_security_demo_001. Verify role=security, identityKey=security:security01, wxIdentityKey=unbound:usr_security_demo_001, wxOpenId=null, bindStatus=not_applicable, status=active, version=1, createdAt and updatedAt are CloudBase Date values, and passwordHash is a non-empty bcrypt cost-12 hash without a placeholder.',
    '6. After the database read validation succeeds, delete local .runtime/security-seed.json. The runtime seed must not be retained for final verification.',
    '7. Query users and verify count=3.',
    '8. Query risk_rules and verify count=1.',
    '9. Verify rule_default.updatedBy references the existing users/usr_security_demo_001 document and that its role is security.',
    '10. Run the final read-only verification after runtime seed cleanup. Perform no operation on any other collection.',
    '11. Record the result as remediation complete only after every verification succeeds; otherwise retain PARTIAL / remediation required.'
  ];
  return `${sections.join('\n')}\n`;
}

function generate() {
  const plan = readPlan();
  validatePlan(plan);
  fs.writeFileSync(OUTPUT_PATH, buildInstructions(plan), 'utf8');
  fs.writeFileSync(REMEDIATION_OUTPUT_PATH, buildRemediationInstructions(plan), 'utf8');
  console.log('A-group instructions generated');
}

if (require.main === module) {
  try {
    generate();
  } catch (error) {
    console.error(`Failed to generate A-group instructions: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildInstructions,
  buildRemediationInstructions,
  generate
};
