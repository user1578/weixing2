'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const progressModule = require('../../cloudfunctions/progressCounselorFollowup/index.js');

const trustedContext = { OPENID: 'trusted-counselor-openid', APPID: 'wxe262970211858262' };
const NOW = new Date('2026-09-11T10:00:00.000Z');
const CONTACTED_AT = '2026-09-11T09:00:00.000Z';

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function baseCounselor(overrides = {}) {
  return { _id: 'usr_counselor_001', wxIdentityKey: `openid:${trustedContext.OPENID}`, wxOpenId: trustedContext.OPENID,
    bindStatus: 'bound', role: 'counselor', status: 'active', collegeId: 'college_cs', version: 1, ...overrides };
}
function baseReport(overrides = {}) {
  return { _id: 'report_001', studentId: 'usr_student_001', collegeId: 'college_cs', status: 'pending_counselor_verify',
    version: 2, currentHandlerId: 'usr_counselor_001', riskLevel: 'high', sourceAlertKey: 'alert:001', ...overrides };
}
function baseFollowup(overrides = {}) {
  return { _id: 'followup_001', businessType: 'report', businessId: 'report_001', studentId: 'usr_student_001', collegeId: 'college_cs',
    counselorId: 'usr_counselor_001', status: 'pending', opinion: '初始跟进意见', contactedAt: null, contactMethod: null,
    focusFlag: false, focusReason: null, transferToSecurity: false, transferReason: null, version: 1,
    createdAt: new Date('2026-09-11T08:00:00.000Z'), updatedAt: new Date('2026-09-11T08:00:00.000Z'), ...overrides };
}
function validEvent(overrides = {}) { return { followupId: ' followup_001 ', expectedVersion: 1, contactedAt: CONTACTED_AT, contactMethod: 'phone', ...overrides }; }
function matches(row, query) { return Object.entries(query).every(([key, value]) => row[key] === value); }

function createMockDb({ users = [baseCounselor()], reports = [baseReport()], followups = [baseFollowup()], ...options } = {}) {
  const state = {
    users: clone(users), reports: clone(reports), followups: clone(followups), audits: [], logs: [], transactionCalls: 0,
    transactionDocReads: [], conditionalUpdates: [], writes: [],
  };
  const rowsFor = (name) => ({ users: state.users, fraud_reports: state.reports, counselor_followups: state.followups, audit_logs: state.audits }[name]);
  const collection = (name, transactional = false) => ({
    where(query) {
      const selected = () => rowsFor(name).filter((row) => matches(row, query));
      return {
        limit(limit) { return { get: async () => ({ data: selected().slice(0, limit).map(clone) }) }; },
        get: async () => ({ data: selected().map(clone) }),
        async update({ data }) {
          state.conditionalUpdates.push({ collection: name, query: clone(query), data: clone(data) });
          if (!transactional || name !== 'counselor_followups') throw new Error('unexpected conditional update');
          if (options.updateZero) return { stats: { updated: 0 } };
          const rows = selected(); rows.forEach((row) => Object.assign(row, clone(data)));
          state.writes.push('counselor_followups'); return { stats: { updated: rows.length } };
        },
      };
    },
    doc(id) {
      return { get: async () => {
        if (transactional) state.transactionDocReads.push({ collection: name, id });
        return { data: clone(rowsFor(name).find((row) => row._id === id)) };
      } };
    },
    async add({ data }) {
      if (name !== 'audit_logs') throw new Error('unexpected collection add');
      if (options.auditFailure) throw new Error('audit unavailable');
      state.audits.push(clone(data)); state.writes.push('audit_logs'); return { id: data._id };
    },
  });
  const snapshot = () => clone({ reports: state.reports, followups: state.followups, audits: state.audits, conditionalUpdates: state.conditionalUpdates, writes: state.writes });
  const restore = (saved) => {
    for (const name of ['reports', 'followups', 'audits', 'conditionalUpdates', 'writes']) state[name].splice(0, state[name].length, ...saved[name]);
  };
  const db = {
    collection: (name) => collection(name, false),
    async runTransaction(callback) {
      state.transactionCalls += 1;
      if (typeof options.beforeTransaction === 'function') options.beforeTransaction(state);
      const saved = snapshot();
      try { return await callback({ collection: (name) => collection(name, true) }); }
      catch (error) { restore(saved); throw error; }
    },
  };
  return { db, state };
}

function makeHandler(options = {}) {
  const mock = createMockDb(options); let auditNumber = 0; let dateNumber = 0;
  const handler = progressModule.__testables.createHandler({
    db: mock.db, getWXContext: () => options.wxContext || trustedContext, now: () => options.now || NOW,
    serverDate: () => ({ $serverDate: ++dateNumber }), logger: { error: (entry) => mock.state.logs.push(entry) },
    createRequestId: () => 'req-followup-progress', createAuditId: () => `audit_${++auditNumber}`,
  });
  return { ...mock, handler };
}

test('1. 非法 event 安全失败', async () => assert.equal((await makeHandler().handler(null)).code, 'INVALID_INPUT'));
test('2. 多余字段拒绝', async () => assert.equal((await makeHandler().handler(validEvent({ reportId: 'spoofed' }))).code, 'INVALID_INPUT'));
test('3. followupId 非法', async () => assert.equal((await makeHandler().handler(validEvent({ followupId: ' ' }))).code, 'INVALID_INPUT'));
test('4. expectedVersion 非法', async () => assert.equal((await makeHandler().handler(validEvent({ expectedVersion: 0 }))).code, 'INVALID_INPUT'));
test('5. contactedAt 非法', async () => assert.equal((await makeHandler().handler(validEvent({ contactedAt: '2026-02-30T09:00:00Z' }))).code, 'INVALID_INPUT'));
test('6. contactedAt 超过未来五分钟', async () => assert.equal((await makeHandler().handler(validEvent({ contactedAt: '2026-09-11T10:05:00.001Z' }))).code, 'INVALID_INPUT'));
test('7. contactMethod 非法', async () => assert.equal((await makeHandler().handler(validEvent({ contactMethod: 'email' }))).code, 'INVALID_INPUT'));
test('8. userInfo 与 tcbContext 伪造无效', async () => assert.equal((await makeHandler().handler(validEvent({ userInfo: { OPENID: 'spoofed' }, tcbContext: { OPENID: 'spoofed' } }))).code, 'COUNSELOR_FOLLOWUP_IN_PROGRESS'));
test('9. 无 OPENID', async () => assert.equal((await makeHandler({ wxContext: { APPID: trustedContext.APPID } }).handler(validEvent())).code, 'INTERNAL_ERROR'));
test('10. 错误 APPID', async () => assert.equal((await makeHandler({ wxContext: { ...trustedContext, APPID: 'wrong' } }).handler(validEvent())).code, 'FORBIDDEN'));
test('11. 未绑定', async () => assert.equal((await makeHandler({ users: [] }).handler(validEvent())).code, 'UNBOUND'));
test('12. 非 counselor 拒绝', async () => assert.equal((await makeHandler({ users: [baseCounselor({ role: 'student' })] }).handler(validEvent())).code, 'FORBIDDEN'));
test('13. inactive 拒绝', async () => assert.equal((await makeHandler({ users: [baseCounselor({ status: 'disabled' })] }).handler(validEvent())).code, 'ACCOUNT_DISABLED'));
test('14. 绑定不一致拒绝', async () => assert.equal((await makeHandler({ users: [baseCounselor({ wxOpenId: 'other' })] }).handler(validEvent())).code, 'INTERNAL_ERROR'));
test('15. followup 不存在', async () => assert.equal((await makeHandler({ followups: [] }).handler(validEvent())).code, 'NOT_FOUND'));
test('16. businessType 不是 report', async () => assert.equal((await makeHandler({ followups: [baseFollowup({ businessType: 'alert' })] }).handler(validEvent())).code, 'INVALID_STATE'));
test('17. followup 跨学院拒绝', async () => assert.equal((await makeHandler({ followups: [baseFollowup({ collegeId: 'college_other' })] }).handler(validEvent())).code, 'FORBIDDEN'));
test('18. 非本人 followup 拒绝', async () => assert.equal((await makeHandler({ followups: [baseFollowup({ counselorId: 'usr_other' })] }).handler(validEvent())).code, 'FORBIDDEN'));
test('19. access.denied 审计正确', async () => { const { handler, state } = makeHandler({ followups: [baseFollowup({ counselorId: 'usr_other' })] }); await handler(validEvent()); assert.deepEqual({ action: state.audits[0].action, resourceType: state.audits[0].resourceType, resourceId: state.audits[0].resourceId }, { action: 'access.denied', resourceType: 'counselor_followup', resourceId: 'followup_001' }); });
test('20. 关联 report 不存在', async () => assert.equal((await makeHandler({ reports: [] }).handler(validEvent())).code, 'NOT_FOUND'));
test('21. report 跨学院', async () => assert.equal((await makeHandler({ reports: [baseReport({ collegeId: 'college_other' })] }).handler(validEvent())).code, 'FORBIDDEN'));
test('22. report 当前处理人不是当前辅导员', async () => assert.equal((await makeHandler({ reports: [baseReport({ currentHandlerId: 'usr_other' })] }).handler(validEvent())).code, 'CONFLICT'));
test('23. report 状态错误', async () => assert.equal((await makeHandler({ reports: [baseReport({ status: 'pending_security_verify' })] }).handler(validEvent())).code, 'INVALID_STATE'));
test('24. completed 不能重新进入处理中', async () => assert.equal((await makeHandler({ followups: [baseFollowup({ status: 'completed', version: 2 })] }).handler(validEvent({ expectedVersion: 1 }))).code, 'INVALID_STATE'));
test('25. 非法 followup 状态拒绝', async () => assert.equal((await makeHandler({ followups: [baseFollowup({ status: 'other' })] }).handler(validEvent())).code, 'INVALID_STATE'));
test('26. pending 版本冲突', async () => assert.equal((await makeHandler({ followups: [baseFollowup({ version: 2 })] }).handler(validEvent())).code, 'CONFLICT'));
test('27. in_progress 相同联系信息幂等成功', async () => assert.equal((await makeHandler({ followups: [baseFollowup({ status: 'in_progress', version: 2, contactedAt: new Date(CONTACTED_AT), contactMethod: 'phone' })] }).handler(validEvent({ expectedVersion: 2 }))).code, 'FOLLOWUP_ALREADY_IN_PROGRESS'));
test('28. 幂等允许旧 expectedVersion', async () => assert.equal((await makeHandler({ followups: [baseFollowup({ status: 'in_progress', version: 2, contactedAt: new Date(CONTACTED_AT), contactMethod: 'phone' })] }).handler(validEvent({ expectedVersion: 1 }))).code, 'FOLLOWUP_ALREADY_IN_PROGRESS'));
test('29. 幂等零事务', async () => { const { handler, state } = makeHandler({ followups: [baseFollowup({ status: 'in_progress', version: 2, contactedAt: new Date(CONTACTED_AT), contactMethod: 'phone' })] }); await handler(validEvent()); assert.equal(state.transactionCalls, 0); });
test('30. 幂等零 followup 更新', async () => { const { handler, state } = makeHandler({ followups: [baseFollowup({ status: 'in_progress', version: 2, contactedAt: new Date(CONTACTED_AT), contactMethod: 'phone' })] }); await handler(validEvent()); assert.equal(state.conditionalUpdates.length, 0); });
test('31. 幂等零 audit', async () => { const { handler, state } = makeHandler({ followups: [baseFollowup({ status: 'in_progress', version: 2, contactedAt: new Date(CONTACTED_AT), contactMethod: 'phone' })] }); await handler(validEvent()); assert.equal(state.audits.length, 0); });
test('32. in_progress 参数不同返回 CONFLICT', async () => assert.equal((await makeHandler({ followups: [baseFollowup({ status: 'in_progress', version: 2, contactedAt: new Date(CONTACTED_AT), contactMethod: 'phone' })] }).handler(validEvent({ contactMethod: 'wechat' }))).code, 'CONFLICT'));
test('33. 事务内重新读取 counselor', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.ok(state.transactionDocReads.some((row) => row.collection === 'users')); });
test('34. 事务内重新读取 followup', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.ok(state.transactionDocReads.some((row) => row.collection === 'counselor_followups')); });
test('35. 事务内重新读取 report', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.ok(state.transactionDocReads.some((row) => row.collection === 'fraud_reports')); });
test('36. 事务内 counselor 状态变化失败', async () => assert.equal((await makeHandler({ beforeTransaction: (state) => { state.users[0].status = 'disabled'; } }).handler(validEvent())).code, 'CONFLICT'));
test('37. 事务内 followup 状态变化失败', async () => assert.equal((await makeHandler({ beforeTransaction: (state) => { state.followups[0].status = 'in_progress'; } }).handler(validEvent())).code, 'CONFLICT'));
test('38. 事务内 followup 版本变化失败', async () => assert.equal((await makeHandler({ beforeTransaction: (state) => { state.followups[0].version = 2; } }).handler(validEvent())).code, 'CONFLICT'));
test('39. 事务内 report 状态变化失败', async () => assert.equal((await makeHandler({ beforeTransaction: (state) => { state.reports[0].status = 'pending_security_verify'; } }).handler(validEvent())).code, 'CONFLICT'));
test('40. 事务内 handler 变化失败', async () => assert.equal((await makeHandler({ beforeTransaction: (state) => { state.reports[0].currentHandlerId = 'usr_other'; } }).handler(validEvent())).code, 'CONFLICT'));
test('41. 成功 pending 到 in_progress', async () => { const { handler, state } = makeHandler(); assert.equal((await handler(validEvent())).code, 'COUNSELOR_FOLLOWUP_IN_PROGRESS'); assert.equal(state.followups[0].status, 'in_progress'); });
test('42. contactedAt 正确写入', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.followups[0].contactedAt.getTime(), new Date(CONTACTED_AT).getTime()); });
test('43. contactMethod 正确写入', async () => { const { handler, state } = makeHandler(); await handler(validEvent({ contactMethod: 'wechat' })); assert.equal(state.followups[0].contactMethod, 'wechat'); });
test('44. followup version 加一', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.followups[0].version, 2); });
test('45. updatedAt 更新', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.deepEqual(state.followups[0].updatedAt, { $serverDate: 1 }); });
test('46. opinion 不变', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.followups[0].opinion, '初始跟进意见'); });
test('47. verificationResult 不变或未新增', async () => { const { handler, state } = makeHandler({ followups: [baseFollowup({ verificationResult: 'suspected' })] }); await handler(validEvent()); assert.equal(state.followups[0].verificationResult, 'suspected'); });
test('48. focus 字段不变', async () => { const { handler, state } = makeHandler({ followups: [baseFollowup({ focusFlag: true, focusReason: '原始原因' })] }); await handler(validEvent()); assert.deepEqual([state.followups[0].focusFlag, state.followups[0].focusReason], [true, '原始原因']); });
test('49. transfer 字段不变', async () => { const { handler, state } = makeHandler({ followups: [baseFollowup({ transferToSecurity: true, transferReason: '原始转交原因' })] }); await handler(validEvent()); assert.deepEqual([state.followups[0].transferToSecurity, state.followups[0].transferReason], [true, '原始转交原因']); });
test('50. completedAt 不写', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal('completedAt' in state.followups[0], false); });
test('51. report 零更新', async () => { const { handler, state } = makeHandler(); const before = clone(state.reports[0]); await handler(validEvent()); assert.deepEqual(state.reports[0], before); });
test('52. 成功只更新一条 followup', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.writes.filter((name) => name === 'counselor_followups').length, 1); });
test('53. 条件更新零条整体回滚', async () => { const { handler, state } = makeHandler({ updateZero: true }); assert.equal((await handler(validEvent())).code, 'CONFLICT'); assert.equal(state.followups[0].status, 'pending'); assert.equal(state.audits.length, 0); });
test('54. audit 失败整体回滚', async () => { const { handler, state } = makeHandler({ auditFailure: true }); assert.equal((await handler(validEvent())).code, 'INTERNAL_ERROR'); assert.equal(state.followups[0].status, 'pending'); assert.equal(state.reports[0].currentHandlerId, 'usr_counselor_001'); });
test('55. 成功只新增一条 followup.progress 审计', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.audits.filter((row) => row.action === 'followup.progress').length, 1); });
test('56. audit actor 正确', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.deepEqual([state.audits[0].actorId, state.audits[0].actorRole, state.audits[0].actorCollegeId], ['usr_counselor_001', 'counselor', 'college_cs']); });
test('57. audit resource 正确', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.deepEqual([state.audits[0].resourceType, state.audits[0].resourceId], ['counselor_followup', 'followup_001']); });
test('58. summary 最小化', async () => { const { handler, state } = makeHandler(); await handler(validEvent({ contactMethod: 'other' })); assert.deepEqual(state.audits[0].beforeSummary, { status: 'pending' }); assert.deepEqual(state.audits[0].afterSummary, { status: 'in_progress', contactMethod: 'other' }); });
test('59. audit 不含敏感字段', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); for (const key of ['wxOpenId', 'wxIdentityKey', 'studentId', 'counselorId', 'opinion', 'contactedAt', 'verificationResult', 'sourceAlertKey']) assert.equal(key in state.audits[0], false, key); });
test('60. 返回不含敏感字段', async () => { const { handler } = makeHandler(); const response = await handler(validEvent()); for (const key of ['studentId', 'collegeId', 'counselorId', 'opinion', 'contactedAt', 'currentHandlerId']) assert.equal(JSON.stringify(response).includes(key), false, key); });
test('61. 日志仅安全字段', async () => { const { handler, state } = makeHandler({ auditFailure: true }); await handler(validEvent()); assert.ok(state.logs.length > 0); for (const entry of state.logs) assert.deepEqual(Object.keys(entry).sort(), ['code', 'requestId', 'resourceId', 'stage']); });
test('62. TARGET_ENV_ID 固定正确', () => { const environments = []; const db = { serverDate: () => ({}), collection: () => ({}), runTransaction: async () => ({}) }; progressModule.__testables.createDefaultHandler({ init: ({ env }) => environments.push(env), database: () => db, getWXContext: () => trustedContext }); assert.deepEqual(environments, ['aa-d4gvb4o3t50fc94f8']); });
