'use strict';

const fs = require('fs');
const path = require('path');
const { validatePlan } = require('./validate-plan');

const PLAN_PATH = path.join(__dirname, 'plan.json');
const OUTPUT_PATH = path.join(__dirname, 'WORKBUDDY-B-GROUP.txt');

function formatIndex(index) {
  return `${index.unique ? 'UNIQUE ' : ''}${index.name}: ${index.fields.map((field) => `${field.field} ${field.order}`).join(', ')}`;
}
function buildInstructions(plan) {
  const implementationStatus = plan.implementationStatus;
  const cloudState = implementationStatus.currentCloudBaseState;
  const lines = [
    'B-GROUP CLOUDBASE IMPLEMENTATION INSTRUCTIONS',
    '',
    `Only permitted environment: ${plan.envId}`,
    `Current deployment status: ${implementationStatus.status}.`,
    'This material is for idempotent recovery and read-only re-verification.',
    'B group has been formally implemented. Do not deploy cloud functions and do not enter C group.',
    'Never create probe, test, temp, or other out-of-plan collections.',
    'CloudBase collections have no fixed physical field schema. Do not claim to create or verify a field schema in an empty collection.',
    'Read-only re-verification checks only: collection existence, indexes, ACL, and documentCount. Fields, requiredness, Date, version, and state machines are static source/plan contracts validated by validate-plan.js.',
    'Before every target collection: read its existence, indexes, ACL, and documentCount only. Do not insert a probe, test, or temporary document.',
    'Every subsequent run must start with read-only verification. Existing and exact: verify then SKIP. Existing but different or missing: STOP and report. Do not recreate or overwrite.',
    'Client read=false and client write=false are mandatory for every B-group collection.',
    `Recorded PASSED state: alerts=${cloudState.alerts}; fraud_reports=${cloudState.fraud_reports}; counselor_followups=${cloudState.counselor_followups}; security_dispositions=${cloudState.security_dispositions}; customIndexCount=${cloudState.customIndexCount}.`,
    'No B-group business records are initialized or inserted by this material. Final B-group acceptance requires documentCount=0 for every collection. If any count is nonzero, STOP and report; never delete data to make acceptance pass.',
    'Any future approved seed requires a separate authorization and validation plan; do not add one here.',
    ''
  ];
  for (const name of plan.creationOrder) {
    const item = plan.collections.find((entry) => entry.collectionName === name);
    lines.push(`COLLECTION: ${name}`);
    lines.push(`Static contract only (not a CloudBase physical schema): fields=${item.fields.join(', ')}`);
    lines.push(`Static Dates=${item.dateFields.join(', ')}; server timestamps=${item.serverTimestampFields.join(', ')}`);
    lines.push(`Static client inputs=${item.clientInputFields.join(', ')}`);
    lines.push(`Static server-derived=${item.serverDerivedFields.join(', ')}`);
    lines.push(`Static server-controlled=${item.serverControlledFields.join(', ')}`);
    lines.push(`Indexes (exact): ${item.indexes.map(formatIndex).join(' | ')}`);
    lines.push(`ACL: clientRead=${item.securityPolicy.clientRead}; clientWrite=${item.securityPolicy.clientWrite}`);
    lines.push(`Final acceptance documentCount: ${item.expectedDocumentCount}.`);
    if (item.version.present) lines.push(`Version: create at 1; normal updates require ${item.version.updateCondition.join(' + ')}; state updates require ${item.version.stateUpdateCondition.join(' + ')}.`);
    else lines.push('Lifecycle: append-only history; no version; update/delete are forbidden after creation.');
    if (item.stateMachine) lines.push(`State machine: initial=${item.stateMachine.initial}; ${item.stateMachine.transitions.join('; ')}. Terminal: ${item.stateMachine.terminal.join(', ')}.`);
    if (item.uniqueRules) lines.push('UNIQUE: sourceAlertKey is non-null; linked=alert:<sourceAlertId>; standalone=standalone:<reportId>; never build UNIQUE on sourceAlertId.');
    lines.push('');
  }
  lines.push('Read-only re-verification must validate only this env and these four collections: existence, documentCount=0, exact index count/order and UNIQUE, and ACL. It may proceed only while implementationStatus is PASSED.');
  lines.push('Do not create a probe record to test fields, Date, version, or state logic. If read-only evidence is insufficient, STOP and report the unknown capability.');
  return `${lines.join('\n')}\n`;
}
function generate() {
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  validatePlan(plan);
  fs.writeFileSync(OUTPUT_PATH, buildInstructions(plan), 'utf8');
  console.log('B-group instructions generated');
}
if (require.main === module) {
  try { generate(); } catch (error) { console.error(`B-group instruction generation failed: ${error.message}`); process.exit(1); }
}
module.exports = { buildInstructions, generate };
