'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const listModule = require('../../cloudfunctions/getStudentReports');
const detailModule = require('../../cloudfunctions/getStudentReportDetail');

const context = { OPENID: 'student-openid', APPID: 'wxe262970211858262' };
const student = { _id: 'student_1', role: 'student', status: 'active', bindStatus: 'bound', wxOpenId: 'student-openid', wxIdentityKey: 'openid:student-openid', collegeId: 'college_a', name: '学生甲' };
const report = { _id: 'report_1', studentId: 'student_1', fraudType: 'fake_loan', riskLevel: 'high', status: 'in_process', submittedAt: '2026-09-12T10:00:00.000Z', hasLoss: true, sourceAlertId: 'alert_1', incidentNarrative: '本人填写的经过', currentHandlerId: 'internal', closeReason: 'internal close reason', security_dispositions: 'never return' };

function mockDb({ users = [student], reports = [report] } = {}) {
  const state = { users: structuredClone(users), reports: structuredClone(reports), audits: [] };
  const rows = (name) => ({ users: state.users, fraud_reports: state.reports, audit_logs: state.audits })[name];
  const collection = (name) => ({
    where(query) { const found = rows(name).filter((row) => Object.entries(query).every(([key, value]) => row[key] === value)); return {
      limit() { return { get: async () => ({ data: structuredClone(found) }) }; },
      orderBy() { return { limit() { return { get: async () => ({ data: structuredClone(found) }) }; } }; },
    }; },
    doc(id) { return { get: async () => ({ data: structuredClone(rows(name).find((row) => row._id === id)) }) }; },
    async add({ data }) { state.audits.push(structuredClone(data)); return { id: data._id }; },
  });
  return { state, db: { collection } };
}

function handlers(options = {}) {
  const mock = mockDb(options);
  const dependencies = { db: mock.db, getWXContext: () => options.context || context, serverDate: () => ({ $serverDate: true }), logger: { error() {} }, createRequestId: () => 'req_student', createAuditId: () => 'audit_student' };
  return { ...mock, list: listModule.__testables.createHandler(dependencies), detail: detailModule.__testables.createHandler(dependencies) };
}

test('学生工单列表仅按可信 OPENID 对应的 studentId 查询，并返回最小字段', async () => {
  const { list } = handlers({ reports: [report, { ...report, _id: 'other', studentId: 'student_2', incidentNarrative: '他人正文' }] });
  const result = await list({});
  assert.equal(result.code, 'STUDENT_REPORTS_LOADED');
  assert.deepEqual(result.reports, [{ reportId: 'report_1', fraudType: 'fake_loan', riskLevel: 'high', status: 'in_process', submittedAt: report.submittedAt, hasLoss: true, hasSourceAlert: true }]);
  assert.equal(JSON.stringify(result).includes('incidentNarrative'), false);
  assert.equal(JSON.stringify(result).includes('currentHandlerId'), false);
});

test('学生详情只能读取本人工单，且不泄露处理人、处置或结案内部原因', async () => {
  const { detail, state } = handlers({ reports: [report, { ...report, _id: 'other', studentId: 'student_2' }] });
  const own = await detail({ reportId: 'report_1' });
  assert.equal(own.code, 'STUDENT_REPORT_DETAIL_LOADED');
  assert.equal(own.report.incidentNarrative, '本人填写的经过');
  for (const key of ['currentHandlerId', 'closeReason', 'security_dispositions', 'studentId', 'collegeId', 'sourceAlertId']) assert.equal(JSON.stringify(own).includes(key), false, key);
  const other = await detail({ reportId: 'other' });
  assert.equal(other.code, 'FORBIDDEN');
  assert.equal(state.audits.at(-1).action, 'access.denied');
});

test('学生接口拒绝客户端伪造身份字段和禁用身份', async () => {
  const forged = handlers();
  for (const key of ['studentId', 'userId', 'collegeId', 'role', 'OPENID']) assert.equal((await forged.list({ [key]: 'forged' })).code, 'INVALID_INPUT');
  const disabled = handlers({ users: [{ ...student, status: 'suspended' }] });
  assert.equal((await disabled.list({})).code, 'ACCOUNT_DISABLED');
  assert.equal(disabled.state.audits[0].action, 'access.denied');
});
