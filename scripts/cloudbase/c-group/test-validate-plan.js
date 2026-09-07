'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { validatePlan } = require('./validate-plan');
const { verifySnapshot } = require('./verify-result');
const { buildInstructions } = require('./generate-implementation-instructions');
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8'));
function copyPlan() { return JSON.parse(JSON.stringify(plan)); }
function collection(target, name) { return target.collections.find((item) => item.collectionName === name); }
function reject(mutator) { const candidate = copyPlan(); mutator(candidate); assert.throws(() => validatePlan(candidate)); }
function move(item, field, from, to) { item[from].splice(item[from].indexOf(field), 1); item[to].push(field); }
function validSnapshot() { return { envId: plan.envId, collections: plan.collections.map((item) => ({ collectionName: item.collectionName, exists: true, documentCount: 0, indexes: JSON.parse(JSON.stringify(item.indexes)), securityPolicy: { clientRead: false, clientWrite: false, cloudBaseAcl: 'ADMINONLY' } })) }; }
test('1. 正确 plan 通过', () => assert.equal(validatePlan(plan), plan));
test('2. learning_articles.authorId 改为 clientInput 失败', () => reject((p) => move(collection(p, 'learning_articles'), 'authorId', 'serverDerivedFields', 'clientInputFields')));
test('3. correctOptionIds 改为 serverDerived 失败', () => reject((p) => move(collection(p, 'quiz_questions'), 'correctOptionIds', 'clientInputFields', 'serverDerivedFields')));
test('4. 删除题目响应安全契约失败', () => reject((p) => delete collection(p, 'quiz_questions').responseSecurity));
test('5. quiz_attempts 添加 version 失败', () => reject((p) => { collection(p, 'quiz_attempts').version.present = true; }));
test('6. learning_records 删除 appendOnly 失败', () => reject((p) => { collection(p, 'learning_records').appendOnly = false; }));
test('7. learning_records 改为单字段 UNIQUE 失败', () => reject((p) => { collection(p, 'learning_records').indexes[0].fields.splice(1, 1); }));
test('8. learning_records 组合 UNIQUE 顺序错误失败', () => reject((p) => { collection(p, 'learning_records').indexes[0].fields.reverse(); }));
test('9. audit_logs.actorId 改为 clientInput 失败', () => reject((p) => move(collection(p, 'audit_logs'), 'actorId', 'serverDerivedFields', 'clientInputFields')));
test('10. audit_logs 缺 requestId 失败', () => reject((p) => { const audit = collection(p, 'audit_logs'); audit.fields.splice(audit.fields.indexOf('requestId'), 1); }));
test('11. audit_logs 添加 version 失败', () => reject((p) => { collection(p, 'audit_logs').version.present = true; }));
test('12. audit_logs appendOnly=false 失败', () => reject((p) => { collection(p, 'audit_logs').appendOnly = false; }));
test('13. audit_logs.result 增加未知枚举失败', () => reject((p) => collection(p, 'audit_logs').enums.result.push('unknown')));
test('14. audit_logs 索引缺失失败', () => reject((p) => collection(p, 'audit_logs').indexes.pop()));
test('15. 总索引数非 10 失败', () => reject((p) => collection(p, 'quiz_questions').indexes.push({ name: 'extra', fields: [{ field: 'stem', order: 'asc' }], unique: false })));
test('16. seedData 出现文档失败', () => reject((p) => collection(p, 'learning_articles').seedData.documents.push({ title: 'x' })));
test('17. snapshot 任一 documentCount 非零失败', () => { const snapshot = validSnapshot(); snapshot.collections[0].documentCount = 1; assert.throws(() => verifySnapshot(snapshot, plan)); });
test('18. snapshot ACL 开放失败', () => { const snapshot = validSnapshot(); snapshot.collections[1].securityPolicy.clientRead = true; assert.throws(() => verifySnapshot(snapshot, plan)); });
test('19. snapshot learning_records UNIQUE 错误失败', () => { const snapshot = validSnapshot(); snapshot.collections[3].indexes[0] = { name: 'studentId_unique', fields: [{ field: 'studentId', order: 'asc' }], unique: true }; assert.throws(() => verifySnapshot(snapshot, plan)); });
test('20. snapshot 多出计划外 C 组集合失败', () => { const snapshot = validSnapshot(); snapshot.collections.push({ collectionName: 'unexpected', exists: true, documentCount: 0, indexes: [], securityPolicy: { clientRead: false, clientWrite: false, cloudBaseAcl: 'ADMINONLY' } }); assert.throws(() => verifySnapshot(snapshot, plan)); });
test('21. 正确空集合 snapshot 通过', () => assert.equal(verifySnapshot(validSnapshot(), plan), true));
test('22. snapshot 独立索引列表重新排序仍通过', () => { const snapshot = validSnapshot(); collection(snapshot, 'learning_records').indexes.reverse(); assert.equal(verifySnapshot(snapshot, plan), true); });
test('23. snapshot 组合 UNIQUE 内部字段重新排序失败', () => { const snapshot = validSnapshot(); collection(snapshot, 'learning_records').indexes[0].fields.reverse(); assert.throws(() => verifySnapshot(snapshot, plan)); });
test('24. 生成说明与文件字节一致', () => assert.equal(fs.readFileSync(path.join(__dirname, 'WORKBUDDY-C-GROUP.txt'), 'utf8'), buildInstructions(plan)));
test('25. 正确 PASSED implementationStatus 通过', () => assert.equal(validatePlan(plan), plan));
test('26. implementationStatus.status=PREPARED 失败', () => reject((p) => { p.implementationStatus.status = 'PREPARED'; }));
test('27. remediationRequired=true 失败', () => reject((p) => { p.implementationStatus.remediationRequired = true; }));
test('28. blockNextGroup=true 失败', () => reject((p) => { p.implementationStatus.blockNextGroup = true; }));
test('29. knownIssue 非 null 失败', () => reject((p) => { p.implementationStatus.knownIssue = 'pending remediation'; }));
test('30. currentCloudBaseState.learning_articles=1 失败', () => reject((p) => { p.implementationStatus.currentCloudBaseState.learning_articles = 1; }));
test('31. currentCloudBaseState.audit_logs=1 失败', () => reject((p) => { p.implementationStatus.currentCloudBaseState.audit_logs = 1; }));
test('32. currentCloudBaseState.customIndexCount=9 失败', () => reject((p) => { p.implementationStatus.currentCloudBaseState.customIndexCount = 9; }));
test('33. PASSED 状态下 missing=create_after_read_only_check 失败', () => reject((p) => { p.idempotencyPolicy.missing = 'create_after_read_only_check'; }));
test('34. 非 PASSED plan 不得进入快照验收', () => { const prepared = copyPlan(); prepared.implementationStatus.status = 'PREPARED'; assert.throws(() => verifySnapshot(validSnapshot(), prepared)); });
