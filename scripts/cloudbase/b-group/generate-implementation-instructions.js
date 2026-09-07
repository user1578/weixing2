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
  const lines = [
    'B-GROUP CLOUDBASE IMPLEMENTATION INSTRUCTIONS',
    '',
    `Only permitted environment: ${plan.envId}`,
    'This material is a plan only. Do not deploy cloud functions and do not enter C group.',
    'Never create probe, test, temp, or other out-of-plan collections.',
    'Before every target collection: read its existence, fields, indexes, ACL, and existing records.',
    'Existing and exact: verify then SKIP. Existing but different: STOP and report. Missing: create exactly from this plan.',
    'Client read=false and client write=false are mandatory for every B-group collection.',
    'No B-group business records are initialized by this plan. Do not invent test records.',
    'Any future approved seed must reference existing users/colleges, contain no real personal data or OPENID, and convert serverTimestamp markers to CloudBase server Date values.',
    ''
  ];
  for (const name of plan.creationOrder) {
    const item = plan.collections.find((entry) => entry.collectionName === name);
    lines.push(`COLLECTION: ${name}`);
    lines.push(`Fields (exact): ${item.fields.join(', ')}`);
    lines.push(`Dates: ${item.dateFields.join(', ')}`);
    lines.push(`Server timestamps: ${item.serverTimestampFields.join(', ')}`);
    lines.push(`Client inputs only: ${item.clientInputFields.join(', ')}`);
    lines.push(`Server-derived: ${item.serverDerivedFields.join(', ')}`);
    lines.push(`Server-controlled: ${item.serverControlledFields.join(', ')}`);
    lines.push(`Indexes (exact): ${item.indexes.map(formatIndex).join(' | ')}`);
    lines.push(`ACL: clientRead=${item.securityPolicy.clientRead}; clientWrite=${item.securityPolicy.clientWrite}`);
    if (item.version.present) lines.push('Version: create at 1; every update requires _id + version; state updates also require expected status.');
    else lines.push('Lifecycle: append-only history; no version; update/delete are forbidden after creation.');
    if (item.stateMachine) lines.push(`State machine: ${item.stateMachine.transitions.join('; ')}. Terminal: ${item.stateMachine.terminal.join(', ')}.`);
    if (item.uniqueRules) lines.push('UNIQUE: sourceAlertKey is non-null; linked=alert:<sourceAlertId>; standalone=standalone:<reportId>; never build UNIQUE on sourceAlertId.');
    lines.push('');
  }
  lines.push('Read-only verification must validate only this env and these four collections: fields/records, Date types, version/lifecycle, exact index order and UNIQUE, and ACL.');
  lines.push('Do not create a probe record to test capability. If read-only evidence is insufficient, STOP and report the unknown capability.');
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
