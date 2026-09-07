'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { validatePlan } = require('./validate-plan');
const { buildInstructions } = require('./generate-implementation-instructions');
const { verifySnapshot } = require('./verify-result');

const ROOT = __dirname;
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'plan.json'), 'utf8'));

function copyPlan() {
  return JSON.parse(JSON.stringify(plan));
}

function collection(targetPlan, name) {
  return targetPlan.collections.find((item) => item.collectionName === name);
}

function moveField(item, field, from, to) {
  const index = item[from].indexOf(field);
  assert.notEqual(index, -1, `${field} must start in ${from}`);
  item[from].splice(index, 1);
  item[to].push(field);
}

function assertPlanRejected(mutator) {
  const mutated = copyPlan();
  mutator(mutated);
  assert.throws(() => validatePlan(mutated));
}

function validSnapshot() {
  return {
    envId: plan.envId,
    collections: plan.collections.map((item) => ({
      collectionName: item.collectionName,
      exists: true,
      documentCount: 0,
      indexes: item.indexes,
      securityPolicy: { clientRead: false, clientWrite: false }
    }))
  };
}

test('1. alerts.riskLevel 不能从服务端派生字段移到客户端输入', () => {
  assertPlanRejected((mutated) => moveField(collection(mutated, 'alerts'), 'riskLevel', 'serverDerivedFields', 'clientInputFields'));
});

test('2. fraud_reports.sourceAlertKey 不能从服务端派生字段移到客户端输入', () => {
  assertPlanRejected((mutated) => moveField(collection(mutated, 'fraud_reports'), 'sourceAlertKey', 'serverDerivedFields', 'clientInputFields'));
});

test('3. counselor_followups.counselorId 不能从服务端派生字段移到客户端输入', () => {
  assertPlanRejected((mutated) => moveField(collection(mutated, 'counselor_followups'), 'counselorId', 'serverDerivedFields', 'clientInputFields'));
});

test('4. security_dispositions.operatorId 不能从服务端派生字段移到客户端输入', () => {
  assertPlanRejected((mutated) => moveField(collection(mutated, 'security_dispositions'), 'operatorId', 'serverDerivedFields', 'clientInputFields'));
});

test('5. 删除 requiredFields 项必须失败', () => {
  assertPlanRejected((mutated) => collection(mutated, 'alerts').requiredFields.pop());
});

test('6. 错误 dateFields 必须失败', () => {
  assertPlanRejected((mutated) => { collection(mutated, 'fraud_reports').dateFields[0] = 'notADate'; });
});

test('7. 错误 foreignKeys 必须失败', () => {
  assertPlanRejected((mutated) => { collection(mutated, 'counselor_followups').foreignKeys.counselorId = 'alerts._id'; });
});

test('8. 增加 closed->reopen 迁移必须失败', () => {
  assertPlanRejected((mutated) => collection(mutated, 'alerts').stateMachine.transitions.push('closed->reopen'));
});

test('9. 增加 closed->sent 迁移必须失败', () => {
  assertPlanRejected((mutated) => collection(mutated, 'fraud_reports').stateMachine.transitions.push('closed->sent'));
});

test('10. stateUpdateCondition 缺少 _id 必须失败', () => {
  assertPlanRejected((mutated) => { collection(mutated, 'counselor_followups').version.stateUpdateCondition = ['expectedStatus', 'version']; });
});

test('11. security_dispositions 添加虚假 stateMachine 必须失败', () => {
  assertPlanRejected((mutated) => { collection(mutated, 'security_dispositions').stateMachine = { initial: 'pending' }; });
});

test('12. security_dispositions appendOnly=false 必须失败', () => {
  assertPlanRejected((mutated) => { collection(mutated, 'security_dispositions').appendOnly = false; });
});

test('13. snapshot documentCount 非零必须失败', () => {
  const snapshot = validSnapshot();
  snapshot.collections[0].documentCount = 1;
  assert.throws(() => verifySnapshot(snapshot, plan));
});

test('14. snapshot 少一个索引必须失败', () => {
  const snapshot = validSnapshot();
  snapshot.collections[1].indexes = snapshot.collections[1].indexes.slice(0, -1);
  assert.throws(() => verifySnapshot(snapshot, plan));
});

test('15. snapshot ACL 错误必须失败', () => {
  const snapshot = validSnapshot();
  snapshot.collections[2].securityPolicy.clientWrite = true;
  assert.throws(() => verifySnapshot(snapshot, plan));
});

test('16. snapshot 正确的空集合验收通过', () => {
  assert.equal(verifySnapshot(validSnapshot(), plan), true);
});

test('17. 生成说明与已生成文件字节一致', () => {
  const generated = buildInstructions(plan);
  const current = fs.readFileSync(path.join(ROOT, 'WORKBUDDY-B-GROUP.txt'), 'utf8');
  assert.equal(current, generated);
});

test('18. implementationStatus.status=PARTIAL 必须失败', () => {
  assertPlanRejected((mutated) => { mutated.implementationStatus.status = 'PARTIAL'; });
});

test('19. implementationStatus.remediationRequired=true 必须失败', () => {
  assertPlanRejected((mutated) => { mutated.implementationStatus.remediationRequired = true; });
});

test('20. implementationStatus.blockNextGroup=true 必须失败', () => {
  assertPlanRejected((mutated) => { mutated.implementationStatus.blockNextGroup = true; });
});

test('21. implementationStatus.knownIssue 非 null 必须失败', () => {
  assertPlanRejected((mutated) => { mutated.implementationStatus.knownIssue = 'pending remediation'; });
});

test('22. implementationStatus 任一集合 count 非零必须失败', () => {
  assertPlanRejected((mutated) => { mutated.implementationStatus.currentCloudBaseState.alerts = 1; });
});

test('23. implementationStatus.customIndexCount 非 12 必须失败', () => {
  assertPlanRejected((mutated) => { mutated.implementationStatus.currentCloudBaseState.customIndexCount = 11; });
});

test('24. 非 PASSED plan 不得进入快照验收', () => {
  const partialPlan = copyPlan();
  partialPlan.implementationStatus.status = 'PARTIAL';
  assert.throws(() => verifySnapshot(validSnapshot(), partialPlan));
});
