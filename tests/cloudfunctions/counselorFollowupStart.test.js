'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const followupModule = require('../../cloudfunctions/startCounselorReportFollowup/index.js');

const trustedContext = { OPENID: 'trusted-counselor-openid', APPID: 'wxe262970211858262' };

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function baseCounselor(overrides = {}) {
  return { _id: 'usr_counselor_001', wxIdentityKey: `openid:${trustedContext.OPENID}`, wxOpenId: trustedContext.OPENID,
    bindStatus: 'bound', role: 'counselor', status: 'active', collegeId: 'college_cs', version: 1, ...overrides };
}
function baseReport(overrides = {}) {
  return { _id: 'report_001', studentId: 'usr_student_001', collegeId: 'college_cs', status: 'pending_counselor_verify',
    version: 1, currentHandlerId: null, riskLevel: 'high', riskReasons: ['has_loss'], sourceAlertId: 'alert_001',
    confirmedLossAmount: null, ...overrides };
}
function validEvent(overrides = {}) { return { reportId: ' report_001 ', expectedVersion: 1, opinion: ' 已联系学生，等待后续核实 ', ...overrides }; }
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => value === null
    ? (row[key] === null || row[key] === undefined) : row[key] === value);
}

function createMockDb({ users = [baseCounselor()], reports = [baseReport()], followups = [], ...options } = {}) {
  const state = {
    users: clone(users), reports: clone(reports), followups: clone(followups), audits: [], logs: [],
    transactionCalls: 0, transactionDocReads: [], conditionalUpdates: [], writes: [],
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
          if (!transactional || name !== 'fraud_reports') throw new Error('unexpected conditional update');
          if (options.updateZero) return { stats: { updated: 0 } };
          const rows = selected();
          rows.forEach((row) => Object.assign(row, clone(data)));
          state.writes.push('fraud_reports');
          return { stats: { updated: rows.length } };
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
      if (options.followupFailure && name === 'counselor_followups') throw new Error('followup unavailable');
      if (options.auditFailure && name === 'audit_logs') throw new Error('audit unavailable');
      if (name === 'counselor_followups') state.followups.push(clone(data));
      else if (name === 'audit_logs') state.audits.push(clone(data));
      else throw new Error('unexpected collection add');
      state.writes.push(name);
      return { id: data._id };
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
  const mock = createMockDb(options);
  let auditNumber = 0;
  let dateNumber = 0;
  const handler = followupModule.__testables.createHandler({
    db: mock.db, getWXContext: () => options.wxContext || trustedContext,
    serverDate: () => ({ $serverDate: ++dateNumber }), logger: { error: (entry) => mock.state.logs.push(entry) },
    createRequestId: () => 'req-followup-start', createFollowupId: () => 'followup_fixed', createAuditId: () => `audit_${++auditNumber}`,
  });
  return { ...mock, handler };
}

test('1. 非法 event 安全失败', async () => assert.equal((await makeHandler().handler(null)).code, 'INVALID_INPUT'));
test('2. 多余字段拒绝', async () => assert.equal((await makeHandler().handler(validEvent({ userId: 'spoofed' }))).code, 'INVALID_INPUT'));
test('3. reportId 非法', async () => assert.equal((await makeHandler().handler(validEvent({ reportId: ' ' }))).code, 'INVALID_INPUT'));
test('4. expectedVersion 非法', async () => assert.equal((await makeHandler().handler(validEvent({ expectedVersion: 0 }))).code, 'INVALID_INPUT'));
test('5. opinion 为空', async () => assert.equal((await makeHandler().handler(validEvent({ opinion: ' ' }))).code, 'INVALID_INPUT'));
test('6. opinion 过长', async () => assert.equal((await makeHandler().handler(validEvent({ opinion: 'x'.repeat(1001) }))).code, 'INVALID_INPUT'));
test('7. 无 OPENID', async () => assert.equal((await makeHandler({ wxContext: { APPID: trustedContext.APPID } }).handler(validEvent())).code, 'INTERNAL_ERROR'));
test('8. 错误 APPID', async () => assert.equal((await makeHandler({ wxContext: { ...trustedContext, APPID: 'wrong' } }).handler(validEvent())).code, 'FORBIDDEN'));
test('9. 未绑定', async () => assert.equal((await makeHandler({ users: [] }).handler(validEvent())).code, 'UNBOUND'));
test('10. 非 counselor 角色拒绝', async () => {
  const { handler, state } = makeHandler({ users: [baseCounselor({ role: 'student' })] });
  assert.equal((await handler(validEvent())).code, 'FORBIDDEN'); assert.equal(state.audits[0].action, 'access.denied');
});
test('11. inactive 拒绝', async () => assert.equal((await makeHandler({ users: [baseCounselor({ status: 'disabled' })] }).handler(validEvent())).code, 'ACCOUNT_DISABLED'));
test('12. 绑定不一致拒绝', async () => assert.equal((await makeHandler({ users: [baseCounselor({ wxOpenId: 'other' })] }).handler(validEvent())).code, 'INTERNAL_ERROR'));
test('13. 工单不存在', async () => assert.equal((await makeHandler({ reports: [] }).handler(validEvent())).code, 'NOT_FOUND'));
test('14. 跨学院拒绝', async () => assert.equal((await makeHandler({ reports: [baseReport({ collegeId: 'college_other' })] }).handler(validEvent())).code, 'FORBIDDEN'));
test('15. 跨学院写 access.denied', async () => {
  const { handler, state } = makeHandler({ reports: [baseReport({ collegeId: 'college_other' })] }); await handler(validEvent());
  assert.deepEqual({ action: state.audits[0].action, resourceType: state.audits[0].resourceType, resourceId: state.audits[0].resourceId }, { action: 'access.denied', resourceType: 'fraud_report', resourceId: 'report_001' });
});
test('16. 非待辅导员核实状态拒绝', async () => assert.equal((await makeHandler({ reports: [baseReport({ status: 'in_process' })] }).handler(validEvent())).code, 'INVALID_STATE'));
test('17. expectedVersion 冲突', async () => assert.equal((await makeHandler({ reports: [baseReport({ version: 2 })] }).handler(validEvent())).code, 'CONFLICT'));
test('18. 他人已占用处理人', async () => assert.equal((await makeHandler({ reports: [baseReport({ currentHandlerId: 'usr_other' })] }).handler(validEvent())).code, 'CONFLICT'));
test('19. pending followup 幂等', async () => {
  const { handler, state } = makeHandler({ reports: [baseReport({ currentHandlerId: 'usr_counselor_001', version: 2 })], followups: [{ _id: 'followup_old', businessType: 'report', businessId: 'report_001', counselorId: 'usr_counselor_001', status: 'pending' }] });
  assert.equal((await handler(validEvent())).code, 'FOLLOWUP_ALREADY_STARTED');
  assert.equal(state.transactionCalls, 0); assert.equal(state.followups.length, 1); assert.equal(state.conditionalUpdates.length, 0); assert.equal(state.audits.length, 0);
});
test('20. in_progress followup 幂等', async () => {
  const { handler } = makeHandler({ reports: [baseReport({ currentHandlerId: 'usr_counselor_001', version: 2 })], followups: [{ _id: 'followup_old', businessType: 'report', businessId: 'report_001', counselorId: 'usr_counselor_001', status: 'in_progress' }] });
  assert.equal((await handler(validEvent())).code, 'FOLLOWUP_ALREADY_STARTED');
});
test('21. 幂等调用零新增 followup', async () => {
  const { handler, state } = makeHandler({ reports: [baseReport({ currentHandlerId: 'usr_counselor_001', version: 2 })], followups: [{ _id: 'old', businessType: 'report', businessId: 'report_001', counselorId: 'usr_counselor_001', status: 'pending' }] }); await handler(validEvent()); assert.equal(state.followups.length, 1);
});
test('22. 幂等调用零 report 更新', async () => {
  const { handler, state } = makeHandler({ reports: [baseReport({ currentHandlerId: 'usr_counselor_001', version: 2 })], followups: [{ _id: 'old', businessType: 'report', businessId: 'report_001', counselorId: 'usr_counselor_001', status: 'pending' }] }); await handler(validEvent()); assert.equal(state.conditionalUpdates.length, 0);
});
test('23. 幂等调用零成功审计', async () => {
  const { handler, state } = makeHandler({ reports: [baseReport({ currentHandlerId: 'usr_counselor_001', version: 2 })], followups: [{ _id: 'old', businessType: 'report', businessId: 'report_001', counselorId: 'usr_counselor_001', status: 'pending' }] }); await handler(validEvent()); assert.equal(state.audits.length, 0); assert.equal(state.transactionCalls, 0);
});
test('24. 当前辅导员无 followup 时失败', async () => assert.equal((await makeHandler({ reports: [baseReport({ currentHandlerId: 'usr_counselor_001' })] }).handler(validEvent())).code, 'INTERNAL_ERROR'));
test('25. 多条未完成 followup 时失败', async () => assert.equal((await makeHandler({ reports: [baseReport({ currentHandlerId: 'usr_counselor_001' })], followups: [{ _id: 'a', businessType: 'report', businessId: 'report_001', counselorId: 'usr_counselor_001', status: 'pending' }, { _id: 'b', businessType: 'report', businessId: 'report_001', counselorId: 'usr_counselor_001', status: 'in_progress' }] }).handler(validEvent())).code, 'INTERNAL_ERROR'));
test('26. 事务内重新读取 counselor', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.ok(state.transactionDocReads.some((entry) => entry.collection === 'users' && entry.id === 'usr_counselor_001')); });
test('27. 事务内重新读取 report', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.ok(state.transactionDocReads.some((entry) => entry.collection === 'fraud_reports' && entry.id === 'report_001')); });
test('28. 事务内 counselor 状态变化整体失败', async () => { const { handler, state } = makeHandler({ beforeTransaction: (value) => { value.users[0].status = 'disabled'; } }); assert.equal((await handler(validEvent())).code, 'CONFLICT'); assert.equal(state.followups.length, 0); });
test('29. 事务内 report version 变化返回冲突', async () => assert.equal((await makeHandler({ beforeTransaction: (value) => { value.reports[0].version = 2; } }).handler(validEvent())).code, 'CONFLICT'));
test('30. 事务内 report 状态变化失败', async () => assert.equal((await makeHandler({ beforeTransaction: (value) => { value.reports[0].status = 'in_process'; } }).handler(validEvent())).code, 'CONFLICT'));
test('31. 成功创建 pending followup', async () => { const { handler, state } = makeHandler(); assert.equal((await handler(validEvent())).code, 'COUNSELOR_FOLLOWUP_STARTED'); assert.equal(state.followups[0].status, 'pending'); });
test('32. followup businessType 为 report', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.followups[0].businessType, 'report'); });
test('33. studentId 和 collegeId 来自 report', async () => { const { handler, state } = makeHandler({ reports: [baseReport({ studentId: 'usr_other', collegeId: 'college_cs' })] }); await handler(validEvent()); assert.deepEqual([state.followups[0].studentId, state.followups[0].collegeId], ['usr_other', 'college_cs']); });
test('34. counselorId 来自可信身份', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.followups[0].counselorId, 'usr_counselor_001'); });
test('35. opinion 使用 trim 后输入', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.followups[0].opinion, '已联系学生，等待后续核实'); });
test('36. followup version 为 1', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.followups[0].version, 1); });
test('37. transferToSecurity 为 false', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.followups[0].transferToSecurity, false); });
test('38. 成功设置 currentHandlerId', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.reports[0].currentHandlerId, 'usr_counselor_001'); });
test('39. report version 加 1', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.reports[0].version, 2); });
test('40. report status 保持原值', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.reports[0].status, 'pending_counselor_verify'); });
test('41. report 其他业务字段不变', async () => { const report = baseReport({ riskLevel: 'high', sourceAlertId: 'alert_keep', confirmedLossAmount: null }); const { handler, state } = makeHandler({ reports: [report] }); await handler(validEvent()); assert.equal(state.reports[0].sourceAlertId, 'alert_keep'); assert.equal(state.reports[0].riskLevel, 'high'); });
test('42. 条件更新 0 条整体回滚', async () => { const { handler, state } = makeHandler({ updateZero: true }); assert.equal((await handler(validEvent())).code, 'CONFLICT'); assert.equal(state.followups.length, 0); assert.equal(state.audits.length, 0); });
test('43. followup 写入失败整体回滚', async () => { const { handler, state } = makeHandler({ followupFailure: true }); assert.equal((await handler(validEvent())).code, 'INTERNAL_ERROR'); assert.equal(state.reports[0].currentHandlerId, null); });
test('44. audit 写入失败整体回滚', async () => { const { handler, state } = makeHandler({ auditFailure: true }); assert.equal((await handler(validEvent())).code, 'INTERNAL_ERROR'); assert.equal(state.followups.length, 0); assert.equal(state.reports[0].currentHandlerId, null); });
test('45. 成功只写一条 followup', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.followups.length, 1); });
test('46. 成功只写一条 report 更新', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.writes.filter((name) => name === 'fraud_reports').length, 1); });
test('47. 成功只写一条开始审计', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.equal(state.audits.filter((row) => row.action === 'report.followup_start').length, 1); });
test('48. 审计 actor 正确', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.deepEqual([state.audits[0].actorId, state.audits[0].actorRole, state.audits[0].actorCollegeId], ['usr_counselor_001', 'counselor', 'college_cs']); });
test('49. 审计 summary 严格最小化', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); assert.deepEqual(state.audits[0].beforeSummary, { status: 'pending_counselor_verify', currentHandlerAssigned: false }); assert.deepEqual(state.audits[0].afterSummary, { status: 'pending_counselor_verify', currentHandlerAssigned: true, followupStatus: 'pending' }); });
test('50. 审计不含敏感字段', async () => { const { handler, state } = makeHandler(); await handler(validEvent()); for (const key of ['wxOpenId', 'wxIdentityKey', 'studentId', 'counselorId', 'opinion']) assert.equal(key in state.audits[0], false, key); });
test('51. 响应不含敏感字段', async () => { const { handler } = makeHandler(); const response = await handler(validEvent()); for (const key of ['studentId', 'collegeId', 'counselorId', 'currentHandlerId', 'opinion']) assert.equal(JSON.stringify(response).includes(key), false, key); });
test('52. userInfo 和 tcbContext 完全忽略', async () => { const { handler } = makeHandler(); assert.equal((await handler(validEvent({ userInfo: { OPENID: 'spoofed' }, tcbContext: { OPENID: 'spoofed' } }))).code, 'COUNSELOR_FOLLOWUP_STARTED'); });
test('53. 日志只含安全字段', async () => { const { handler, state } = makeHandler({ followupFailure: true }); await handler(validEvent({ opinion: '敏感意见' })); assert.ok(state.logs.length > 0); for (const entry of state.logs) assert.deepEqual(Object.keys(entry).sort(), ['code', 'requestId', 'resourceId', 'stage']); });
test('54. TARGET_ENV_ID 固定正确', () => {
  const environments = [];
  const db = { serverDate: () => ({}), collection: () => ({}), runTransaction: async () => ({}) };
  followupModule.__testables.createDefaultHandler({ init: ({ env }) => environments.push(env), database: () => db, getWXContext: () => trustedContext });
  assert.deepEqual(environments, ['aa-d4gvb4o3t50fc94f8']);
});
test('55. 空处理人遇到旧版本仍返回 CONFLICT', async () => {
  assert.equal((await makeHandler({ reports: [baseReport({ version: 2, currentHandlerId: null })] }).handler(validEvent())).code, 'CONFLICT');
});
test('56. 他人处理时即使版本不一致也不返回幂等成功', async () => {
  const { handler, state } = makeHandler({ reports: [baseReport({ version: 2, currentHandlerId: 'usr_other' })], followups: [{ _id: 'old', businessType: 'report', businessId: 'report_001', counselorId: 'usr_counselor_001', status: 'pending' }] });
  assert.equal((await handler(validEvent())).code, 'CONFLICT'); assert.equal(state.transactionCalls, 0);
});
