'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const moduleUnderTest = require('../../cloudfunctions/closeCounselorReport');

const context = { OPENID: 'counselor-openid', APPID: 'wxe262970211858262' };
const counselor = { _id: 'counselor_1', role: 'counselor', status: 'active', collegeId: 'college_a', bindStatus: 'bound', wxOpenId: 'counselor-openid', wxIdentityKey: 'openid:counselor-openid' };
const report = { _id: 'report_1', studentId: 'student_1', collegeId: 'college_a', status: 'pending_counselor_verify', currentHandlerId: 'counselor_1', riskLevel: 'low', hasLoss: false, version: 3 };
const followup = { _id: 'followup_1', businessType: 'report', businessId: 'report_1', counselorId: 'counselor_1', collegeId: 'college_a', status: 'in_progress', version: 2 };

function createMockDb({ users = [counselor], reports = [report], followups = [followup] } = {}) {
  const state = { users: structuredClone(users), reports: structuredClone(reports), followups: structuredClone(followups), audits: [], dispositions: [], transactionCalls: 0 };
  const rows = (name) => ({ users: state.users, fraud_reports: state.reports, counselor_followups: state.followups, audit_logs: state.audits, security_dispositions: state.dispositions })[name];
  const snapshot = () => structuredClone({ users: state.users, reports: state.reports, followups: state.followups, audits: state.audits, dispositions: state.dispositions });
  const restore = (saved) => Object.keys(saved).forEach((key) => state[key].splice(0, state[key].length, ...saved[key]));
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
  const collection = (name) => ({
    where(query) { const found = () => rows(name).filter((row) => matches(row, query)); return {
      limit() { return { get: async () => ({ data: structuredClone(found()) }) }; },
      update: async ({ data }) => { const targets = found(); targets.forEach((row) => Object.assign(row, structuredClone(data))); return { stats: { updated: targets.length } }; },
    }; },
    doc(id) { return { get: async () => ({ data: structuredClone(rows(name).find((row) => row._id === id)) }) }; },
    async add({ data }) { rows(name).push(structuredClone(data)); return { id: data._id }; },
  });
  return { state, db: { collection: (name) => collection(name), async runTransaction(callback) { state.transactionCalls += 1; const saved = snapshot(); try { return await callback({ collection: (name) => collection(name) }); } catch (error) { restore(saved); throw error; } } } };
}

function createHandler(options = {}) {
  const mock = createMockDb(options);
  return { ...mock, handler: moduleUnderTest.__testables.createHandler({ db: mock.db, getWXContext: () => options.context || context, serverDate: () => ({ $serverDate: true }), logger: { error() {} }, createRequestId: () => 'req_close', createAuditId: () => 'audit_close' }) };
}
function event(overrides = {}) { return { followupId: 'followup_1', expectedFollowupVersion: 2, expectedReportVersion: 3, verificationResult: 'misreport', closeReason: '已联系核验，为误报。', ...overrides }; }

test('低风险且无损失的本人 in_progress 跟进可事务内直接结案，不创建 security disposition', async () => {
  const { handler, state } = createHandler();
  const result = await handler(event());
  assert.equal(result.code, 'COUNSELOR_REPORT_CLOSED');
  assert.equal(state.transactionCalls, 1);
  assert.deepEqual({ status: state.reports[0].status, version: state.reports[0].version, finalOutcome: state.reports[0].finalOutcome, confirmedLossAmount: state.reports[0].confirmedLossAmount, currentHandlerId: state.reports[0].currentHandlerId }, { status: 'closed', version: 4, finalOutcome: 'misreport', confirmedLossAmount: 0, currentHandlerId: 'counselor_1' });
  assert.deepEqual({ status: state.followups[0].status, version: state.followups[0].version }, { status: 'completed', version: 3 });
  assert.equal(state.dispositions.length, 0);
  assert.equal(state.audits[0].action, 'report.counselor_close');
});

test('中高风险或存在损失的工单不能由辅导员直接结案', async () => {
  for (const changes of [{ riskLevel: 'medium' }, { riskLevel: 'high' }, { hasLoss: true }]) {
    const { handler, state } = createHandler({ reports: [{ ...report, ...changes }] });
    assert.equal((await handler(event())).code, 'INVALID_STATE');
    assert.equal(state.transactionCalls, 0);
  }
});

test('直接结案严格校验核验结果、版本及跟进所有权', async () => {
  const invalidResult = createHandler();
  assert.equal((await invalidResult.handler(event({ verificationResult: 'confirmed' }))).code, 'INVALID_INPUT');
  const stale = createHandler();
  assert.equal((await stale.handler(event({ expectedReportVersion: 2 }))).code, 'CONFLICT');
  const other = createHandler({ followups: [{ ...followup, counselorId: 'counselor_2' }] });
  assert.equal((await other.handler(event())).code, 'FORBIDDEN');
});
