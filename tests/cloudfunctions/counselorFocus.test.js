'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const listModule = require('../../cloudfunctions/getCounselorFocusStudents');
const searchModule = require('../../cloudfunctions/searchCounselorStudents');
const setModule = require('../../cloudfunctions/setCounselorStudentFocus');

const trustedContext = { OPENID: 'counselor-openid', APPID: 'wxe262970211858262' };
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function counselor(overrides = {}) { return { _id: 'usr_counselor_001', role: 'counselor', status: 'active', bindStatus: 'bound', wxOpenId: 'counselor-openid', wxIdentityKey: 'openid:counselor-openid', collegeId: 'college_cs', version: 3, ...overrides }; }
function student(overrides = {}) { return { _id: 'usr_student_001', role: 'student', status: 'active', collegeId: 'college_cs', name: '张三', studentNo: '20260001', focusFlag: false, focusReason: null, version: 1, ...overrides }; }
function matches(row, query) { return Object.entries(query).every(([key, value]) => row[key] === value); }

function createMockDb({ users = [counselor(), student()], transactionConflict = false, auditFailure = false } = {}) {
  const state = { users: clone(users), audits: [], queries: [], updates: [], transactionCalls: 0 };
  const collection = (name, transactional = false) => ({
    where(query) {
      return {
        limit(limit) { return { get: async () => { state.queries.push({ collection: name, query: clone(query), limit }); return { data: state.users.filter((row) => name === 'users' && matches(row, query)).slice(0, limit).map(clone) }; } }; },
        async update({ data }) {
          if (!transactional || name !== 'users') throw new Error('unexpected update');
          state.updates.push({ query: clone(query), data: clone(data) });
          const rows = state.users.filter((row) => matches(row, query));
          rows.forEach((row) => Object.assign(row, clone(data)));
          return { stats: { updated: rows.length } };
        },
      };
    },
    doc(id) { return { get: async () => ({ data: clone(name === 'users' ? state.users.find((row) => row._id === id) : undefined) }) }; },
    async add({ data }) { if (name !== 'audit_logs') throw new Error('unexpected write'); if (auditFailure) throw new Error('audit unavailable'); state.audits.push(clone(data)); return { id: data._id }; },
  });
  const db = {
    collection: (name) => collection(name, false),
    runTransaction: async (callback) => {
      state.transactionCalls += 1;
      if (transactionConflict) throw new Error('transaction conflict');
      const snapshot = clone({ users: state.users, audits: state.audits, updates: state.updates });
      try { return await callback({ collection: (name) => collection(name, true) }); }
      catch (error) { state.users.splice(0, state.users.length, ...snapshot.users); state.audits.splice(0, state.audits.length, ...snapshot.audits); state.updates.splice(0, state.updates.length, ...snapshot.updates); throw error; }
    },
  };
  return { db, state };
}

function makeHandlers(options = {}) {
  const mock = createMockDb(options);
  const logs = [];
  const dependencies = { db: mock.db, getWXContext: () => options.wxContext || trustedContext, serverDate: () => ({ $serverDate: true }), logger: { error: (entry) => logs.push(entry) }, createRequestId: () => 'req-focus', createAuditId: () => 'audit_focus_001' };
  return { ...mock, logs, list: listModule.__testables.createHandler(dependencies), search: searchModule.__testables.createHandler(dependencies), set: setModule.__testables.createHandler(dependencies) };
}

function focusEvent(overrides = {}) { return { studentId: 'usr_student_001', focusFlag: true, focusReason: '需要持续联系', expectedVersion: 1, ...overrides }; }

test('重点关注：辅导员列表严格固定在当前学院且仅返回安全字段', async () => {
  const handler = makeHandlers({ users: [counselor(), student({ focusFlag: true, focusReason: '需关注' }), student({ _id: 'usr_other', collegeId: 'college_other', focusFlag: true, name: '李四', studentNo: '20260002' })] });
  const response = await handler.list({});
  assert.deepEqual(response.students, [{ studentId: 'usr_student_001', name: '张三', studentNo: '20260001', focusReason: '需关注', version: 1 }]);
  assert.deepEqual(handler.state.queries.find((query) => query.collection === 'users' && query.query.focusFlag === true).query, { collegeId: 'college_cs', role: 'student', focusFlag: true });
  assert.equal(JSON.stringify(response).includes('wxOpenId'), false);
});

test('重点关注：student 账号不能调用，跨学院目标也被拒绝并审计', async () => {
  const studentCaller = makeHandlers({ users: [counselor({ role: 'student' })] });
  assert.equal((await studentCaller.list({})).code, 'FORBIDDEN');
  const crossCollege = makeHandlers({ users: [counselor(), student({ collegeId: 'college_other' })] });
  assert.equal((await crossCollege.set(focusEvent())).code, 'FORBIDDEN');
  assert.equal(crossCollege.state.audits[0].action, 'access.denied');
  assert.equal(crossCollege.state.updates.length, 0);
});

test('重点关注：搜索姓名、学号并且结果最多二十条', async () => {
  const rows = [counselor(), student(), student({ _id: 'usr_name', name: '张小三', studentNo: '20260002' }), student({ _id: 'usr_other', collegeId: 'college_other', name: '张三', studentNo: '20260001' })];
  for (let index = 0; index < 25; index += 1) rows.push(student({ _id: `usr_match_${index}`, name: `同学${index}`, studentNo: `2026MATCH${index}`, version: index + 1 }));
  const handler = makeHandlers({ users: rows });
  assert.deepEqual((await handler.search({ keyword: '张三' })).students.map((row) => row.studentId), ['usr_student_001']);
  assert.deepEqual((await handler.search({ keyword: '20260002' })).students.map((row) => row.studentId), ['usr_name']);
  assert.equal((await handler.search({ keyword: '2026MATCH' })).students.length, 20);
});

test('重点关注：原因必填且长度受限，版本冲突不产生更新', async () => {
  const handler = makeHandlers();
  assert.equal((await handler.set(focusEvent({ focusReason: '' }))).code, 'INVALID_INPUT');
  assert.equal((await handler.set(focusEvent({ focusReason: 'a'.repeat(501) }))).code, 'INVALID_INPUT');
  assert.equal((await handler.set(focusEvent({ expectedVersion: 2 }))).code, 'CONFLICT');
  assert.equal(handler.state.updates.length, 0);
});

test('重点关注：使用 student version 条件更新，开启和取消均写入最小审计摘要', async () => {
  const handler = makeHandlers();
  const enabled = await handler.set(focusEvent());
  assert.equal(enabled.code, 'COUNSELOR_STUDENT_FOCUS_UPDATED');
  assert.deepEqual(handler.state.updates[0].query, { _id: 'usr_student_001', role: 'student', collegeId: 'college_cs', version: 1 });
  assert.deepEqual({ focusFlag: handler.state.users[1].focusFlag, focusReason: handler.state.users[1].focusReason, version: handler.state.users[1].version }, { focusFlag: true, focusReason: '需要持续联系', version: 2 });
  const audit = handler.state.audits[0];
  assert.deepEqual({ action: audit.action, resourceType: audit.resourceType, beforeSummary: audit.beforeSummary, afterSummary: audit.afterSummary }, { action: 'student.focus_update', resourceType: 'user', beforeSummary: { focusFlag: false }, afterSummary: { focusFlag: true } });
  assert.equal(JSON.stringify(audit).includes('需要持续联系'), false);

  const disabled = await handler.set({ studentId: 'usr_student_001', focusFlag: false, focusReason: '', expectedVersion: 2 });
  assert.equal(disabled.code, 'COUNSELOR_STUDENT_FOCUS_UPDATED');
  assert.deepEqual({ focusFlag: handler.state.users[1].focusFlag, focusReason: handler.state.users[1].focusReason, version: handler.state.users[1].version }, { focusFlag: false, focusReason: null, version: 3 });
});
