'use strict';

const fs = require('fs');
const path = require('path');
const { validatePlan } = require('./validate-plan');
const PLAN_PATH = path.join(__dirname, 'plan.json');
const OUTPUT_PATH = path.join(__dirname, 'WORKBUDDY-C-GROUP.txt');
function formatIndex(index) { return `${index.unique ? 'UNIQUE ' : ''}${index.name}: ${index.fields.map((field) => `${field.field} ${field.order}`).join(', ')}`; }
function buildInstructions(plan) {
  const lines = [
    'C-GROUP CLOUDBASE IMPLEMENTATION INSTRUCTIONS', '', `Only permitted environment: ${plan.envId}.`,
    `Current deployment status: ${plan.implementationStatus.status}.`,
    'This material is for idempotent recovery and read-only re-verification only; it is not an initial implementation instruction.',
    'Scope is strictly and only: learning_articles, quiz_questions, quiz_attempts, learning_records, audit_logs.',
    'Before re-verification, use read-only inventory to confirm A group remains: colleges, users, risk_rules; and B group remains: alerts, fraud_reports, counselor_followups, security_dispositions.',
    'Do not modify any A- or B-group collection, indexes, ACL, data, function, or identity deployment.',
    'Do not deploy cloud functions. Do not enter production identity deployment. Do not create probe, test, temp resources, documents, collections, or indexes.',
    'CloudBase has no fixed physical field schema for empty collections. Fields, Date, version, append-only, and response-security rules are static plan contracts; never use a document to probe them.',
    'For each collection, first read only its existence, indexes, ACL, and documentCount. If existing and exact, verify then SKIP. If existing but different, STOP and report. If missing, STOP and report. Never recreate, overwrite, or repair a missing resource automatically.',
    'No initialization data in this round: all five collections must remain documentCount=0. Do not delete records if a nonzero count is found; STOP and report. De-identified article/question seeds are a later separately approved scope only.', ''
  ];
  for (const name of plan.creationOrder) {
    const item = plan.collections.find((entry) => entry.collectionName === name);
    lines.push(`FROZEN COLLECTION ${plan.creationOrder.indexOf(name) + 1}: ${name}`);
    lines.push(`Static fields (not physical schema): ${item.fields.join(', ')}`);
    lines.push(`Required: ${item.requiredFields.join(', ') || '(none)'}; nullable: ${item.nullableFields.join(', ') || '(none)'}; conditional: ${JSON.stringify(item.conditionalRequiredFields)}.`);
    lines.push(`Date: ${item.dateFields.join(', ')}; serverTimestamp: ${item.serverTimestampFields.join(', ')}.`);
    lines.push(`Inputs: ${item.clientInputFields.join(', ') || '(none)'}; derived: ${item.serverDerivedFields.join(', ') || '(none)'}; server-controlled: ${item.serverControlledFields.join(', ')}.`);
    lines.push(`Indexes (exact): ${item.indexes.map(formatIndex).join(' | ')}.`);
    lines.push(`ACL: clientRead=false, clientWrite=false, CloudBase ACL=ADMINONLY.`);
    if (item.version.present) lines.push(`Version contract: create default 1; updates require ${item.version.updateCondition.join(' + ')}.`);
    else lines.push('Lifecycle: append-only; no version; update and delete forbidden after create.');
    if (item.uniqueRules) lines.push('UNIQUE: exactly (studentId, articleId), in that order; do not create standalone studentId or articleId UNIQUE.');
    if (name === 'quiz_questions') lines.push('Response safety: correctOptionIds is server-only for scoring and must be omitted from student question responses; explanation is returned only after answering.');
    if (name === 'audit_logs') lines.push('Audit contract: actorId is server-derived; actorCollegeId is nullable and null for security; only result=success/failure; failureReason only for failures; summaries are minimum state only and must never contain full sensitive text; no complete action enum is invented.');
    lines.push('');
  }
  lines.push('audit_logs is formally present, but never insert an audit record manually. Acceptance is read-only: verify this env, exactly these five collections, existence, documentCount=0, exact index field order/UNIQUE, and ADMINONLY ACL. A missing collection at acceptance is a failure. Never rely on sampleDocuments or add them.');
  return `${lines.join('\n')}\n`;
}
function generate() { const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8')); validatePlan(plan); fs.writeFileSync(OUTPUT_PATH, buildInstructions(plan), 'utf8'); console.log('C-group instructions generated'); }
if (require.main === module) { try { generate(); } catch (error) { console.error(`C-group instruction generation failed: ${error.message}`); process.exit(1); } }
module.exports = { buildInstructions, generate };
