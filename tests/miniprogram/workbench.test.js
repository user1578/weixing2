'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

global.Page = () => {};

const workbench = require('../../miniprogram/pages/index/index.js').__testables;
const counselorReports = require('../../miniprogram/pages/counselor/reports/index.js').__testables;

const STUDENT = {
  userId: 'usr_student_001', role: 'student', name: '学生甲', collegeId: 'college_cs', focusFlag: false,
};
const COUNSELOR = {
  userId: 'usr_counselor_001', role: 'counselor', name: '辅导员乙', collegeId: 'college_cs', focusFlag: false,
};
const DEMO_STUDENT = {
  userId: 'usr_student_demo_001', role: 'student', name: '演示学生', collegeId: 'college_cs', focusFlag: false,
};
const DEMO_COUNSELOR = {
  userId: 'usr_counselor_demo_001', role: 'counselor', name: '演示辅导员', collegeId: 'college_cs', focusFlag: true,
};

function createPageInstance(definition, data = {}) {
  const instance = {
    ...definition,
    data: structuredClone({ ...definition.data, ...data }),
    setData(update) {
      Object.assign(this.data, update);
    },
  };
  return instance;
}

function createWx({ sessions = [], switches = [], studentAlerts = [], counselorReportLists = [] } = {}) {
  const calls = [];
  const toasts = [];
  const navigations = [];
  return {
    calls,
    toasts,
    navigations,
    cloud: {
      async callFunction(request) {
        calls.push(request);
        if (request.name === 'getMiniProgramSession') return { result: sessions.shift() || { ok: false, code: 'INTERNAL_ERROR' } };
        if (request.name === 'switchDemoMiniProgramIdentity') return { result: switches.shift() || { ok: false, code: 'SWITCH_DISABLED' } };
        if (request.name === 'getStudentAlerts') return { result: studentAlerts.shift() || { ok: true, alerts: [] } };
        if (request.name === 'getCounselorReports') return { result: counselorReportLists.shift() || { ok: true, reports: [] } };
        throw new Error(`Unexpected function: ${request.name}`);
      },
    },
    showToast(value) { toasts.push(value); },
    navigateTo(value) { navigations.push(value); },
    stopPullDownRefresh() {},
  };
}

test('1. 学生工作台只使用可信 session，并由已加载预警计算风险摘要', async () => {
  global.wx = createWx({
    sessions: [{ ok: true, code: 'BOUND', profile: STUDENT }],
    studentAlerts: [{ ok: true, alerts: [
      { riskLevel: 'high', status: 'sent' },
      { riskLevel: 'medium', status: 'sent' },
      { riskLevel: 'low', status: 'following_up' },
    ] }],
  });
  const instance = createPageInstance(workbench.pageDefinition);
  const loaded = await instance.refreshSession();

  assert.equal(loaded, true);
  assert.equal(instance.data.profile.role, 'student');
  assert.deepEqual(instance.data.studentSummary, {
    highRiskCount: 1, pendingAlertCount: 2, followingAlertCount: 1,
    reportCountText: '—', reportHint: '现有服务暂未提供我的工单汇总',
  });
  assert.equal(instance.data.demoSwitchAvailable, false);
  assert.deepEqual(global.wx.calls.map((call) => call.name).sort(), ['getMiniProgramSession', 'getStudentAlerts']);
});

test('2. 辅导员工作台只调用既有学院工单查询，并计算待核验和高风险数', async () => {
  global.wx = createWx({
    sessions: [{ ok: true, code: 'BOUND', profile: COUNSELOR }],
    counselorReportLists: [{ ok: true, reports: [
      { riskLevel: 'high', status: 'pending_counselor_verify' },
      { riskLevel: 'low', status: 'pending_counselor_verify' },
    ] }],
  });
  const instance = createPageInstance(workbench.pageDefinition);
  await instance.refreshSession();

  assert.equal(instance.data.profile.role, 'counselor');
  assert.deepEqual(instance.data.counselorSummary, {
    pendingVerifyCount: 2, highRiskCount: 1, followingCountText: '—', recordCountText: '—',
    unavailableHint: '现有服务暂未提供聚合数据',
  });
  assert.equal(global.wx.calls.some((call) => call.name === 'getStudentAlerts'), false);
  assert.equal(global.wx.calls.some((call) => call.name === 'getCounselorReports'), true);
});

test('3. demo 入口仅在固定 demo 身份通过同角色 ALREADY_ACTIVE 验证后显示', async () => {
  global.wx = createWx({
    sessions: [{ ok: true, code: 'BOUND', profile: DEMO_STUDENT }],
    switches: [{ ok: true, code: 'ALREADY_ACTIVE', profile: DEMO_STUDENT }],
    studentAlerts: [{ ok: true, alerts: [] }],
  });
  const instance = createPageInstance(workbench.pageDefinition);
  await instance.refreshSession();

  const probe = global.wx.calls.find((call) => call.name === 'switchDemoMiniProgramIdentity');
  assert.equal(instance.data.demoSwitchAvailable, true);
  assert.deepEqual(probe.data, { targetRole: 'student' });
  assert.deepEqual(Object.keys(probe.data), ['targetRole']);
  assert.equal(workbench.isSwitchTarget('security'), false);
  assert.equal(workbench.isDemoIdentityCandidate({ ...DEMO_STUDENT, collegeId: 'college_other' }), false);
});

test('4. 正式模式或未启用 demo 时不显示切换入口', async () => {
  global.wx = createWx({
    sessions: [{ ok: true, code: 'BOUND', profile: DEMO_STUDENT }],
    switches: [{ ok: false, code: 'SWITCH_DISABLED' }],
    studentAlerts: [{ ok: true, alerts: [] }],
  });
  const instance = createPageInstance(workbench.pageDefinition);
  await instance.refreshSession();

  assert.equal(instance.data.demoSwitchAvailable, false);
  assert.equal(instance.data.switchSheetVisible, false);
});

test('5. 学生切换到辅导员后必须重新读取真实 session 才切换工作台', async () => {
  global.wx = createWx({
    sessions: [
      { ok: true, code: 'BOUND', profile: DEMO_STUDENT },
      { ok: true, code: 'BOUND', profile: DEMO_COUNSELOR },
    ],
    switches: [
      { ok: true, code: 'ALREADY_ACTIVE' },
      { ok: true, code: 'IDENTITY_SWITCHED', profile: DEMO_COUNSELOR },
      { ok: true, code: 'ALREADY_ACTIVE' },
    ],
    studentAlerts: [{ ok: true, alerts: [] }],
    counselorReportLists: [{ ok: true, reports: [] }],
  });
  const instance = createPageInstance(workbench.pageDefinition);
  await instance.refreshSession();
  await instance.switchDemoIdentity({ currentTarget: { dataset: { targetRole: 'counselor' } } });

  const switchCalls = global.wx.calls.filter((call) => call.name === 'switchDemoMiniProgramIdentity');
  assert.equal(instance.data.profile.role, 'counselor');
  assert.equal(global.wx.calls.filter((call) => call.name === 'getMiniProgramSession').length, 2);
  assert.deepEqual(switchCalls[1].data, { targetRole: 'counselor' });
  assert.equal(global.wx.toasts.at(-1).title, '身份切换成功');
});

test('6. 辅导员切换到学生后必须重新读取真实 session 才切换工作台', async () => {
  global.wx = createWx({
    sessions: [
      { ok: true, code: 'BOUND', profile: DEMO_COUNSELOR },
      { ok: true, code: 'BOUND', profile: DEMO_STUDENT },
    ],
    switches: [
      { ok: true, code: 'ALREADY_ACTIVE' },
      { ok: true, code: 'IDENTITY_SWITCHED', profile: DEMO_STUDENT },
      { ok: true, code: 'ALREADY_ACTIVE' },
    ],
    counselorReportLists: [{ ok: true, reports: [] }],
    studentAlerts: [{ ok: true, alerts: [] }],
  });
  const instance = createPageInstance(workbench.pageDefinition);
  await instance.refreshSession();
  await instance.switchDemoIdentity({ currentTarget: { dataset: { targetRole: 'student' } } });

  assert.equal(instance.data.profile.role, 'student');
  assert.equal(global.wx.calls.filter((call) => call.name === 'getMiniProgramSession').length, 2);
});

test('7. 后端切换明确失败时保留当前已确认 session，不乐观篡改角色', async () => {
  global.wx = createWx({
    sessions: [{ ok: true, code: 'BOUND', profile: DEMO_STUDENT }],
    switches: [{ ok: true, code: 'ALREADY_ACTIVE' }, { ok: false, code: 'FORBIDDEN' }],
    studentAlerts: [{ ok: true, alerts: [] }],
  });
  const instance = createPageInstance(workbench.pageDefinition);
  await instance.refreshSession();
  const before = structuredClone(instance.data.profile);
  await instance.switchDemoIdentity({ currentTarget: { dataset: { targetRole: 'counselor' } } });

  assert.deepEqual(instance.data.profile, before);
  assert.equal(global.wx.calls.filter((call) => call.name === 'getMiniProgramSession').length, 1);
  assert.equal(global.wx.toasts.at(-1).title, '当前身份不允许演示切换。');
});

test('8. 切换成功但重取 session 未确认目标角色时不伪造目标工作台', async () => {
  global.wx = createWx({
    sessions: [
      { ok: true, code: 'BOUND', profile: DEMO_STUDENT },
      { ok: true, code: 'BOUND', profile: DEMO_STUDENT },
    ],
    switches: [
      { ok: true, code: 'ALREADY_ACTIVE' },
      { ok: true, code: 'IDENTITY_SWITCHED' },
      { ok: true, code: 'ALREADY_ACTIVE' },
    ],
    studentAlerts: [{ ok: true, alerts: [] }, { ok: true, alerts: [] }],
  });
  const instance = createPageInstance(workbench.pageDefinition);
  await instance.refreshSession();
  await instance.switchDemoIdentity({ currentTarget: { dataset: { targetRole: 'counselor' } } });

  assert.equal(instance.data.profile.role, 'student');
  assert.equal(global.wx.toasts.at(-1).title, '身份更新未确认，请重新进入工作台');
});

test('9. 学生和辅导员入口只在当前角色匹配时导航到既有页面', () => {
  global.wx = createWx();
  const student = createPageInstance(workbench.pageDefinition, { profile: workbench.normalizeProfile(STUDENT) });
  student.goToStudentAlerts();
  student.goToStudentReport();
  student.goToCounselorReports();
  assert.deepEqual(global.wx.navigations, [
    { url: '/pages/alerts/index/index' },
    { url: '/pages/reports/create/index' },
  ]);

  const counselor = createPageInstance(workbench.pageDefinition, { profile: workbench.normalizeProfile(COUNSELOR) });
  counselor.goToCounselorReports();
  counselor.goToStudentReport();
  assert.deepEqual(global.wx.navigations.at(-1), { url: '/pages/counselor/reports/index' });
});

test('10. 状态展示统一中文文案，WXML 不包含内部状态枚举', () => {
  assert.equal(workbench.statusTextForStudent('pending_counselor_verify'), '待辅导员核实');
  assert.equal(workbench.statusTextForStudent('pending_security_verify'), '待保卫处核验');
  assert.equal(workbench.statusTextForStudent('in_process'), '处理中');
  assert.equal(workbench.statusTextForStudent('closed'), '已结案');
  assert.equal(workbench.statusTextForCounselor('pending_counselor_verify'), '待核验');
  assert.equal(workbench.statusTextForCounselor('pending_security_verify'), '已转保卫处');
  assert.equal(workbench.statusTextForCounselor('in_process'), '跟进中');
  assert.equal(workbench.statusTextForCounselor('closed'), '已完成');

  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8');
  for (const internalStatus of ['pending_counselor_verify', 'pending_security_verify', 'in_process', 'closed']) {
    assert.equal(wxml.includes(internalStatus), false, internalStatus);
  }
});

test('11. 辅导员工单页复用既有云函数并只展示安全的列表字段', async () => {
  global.wx = createWx({
    counselorReportLists: [{ ok: true, reports: [{
      reportId: 'report_001', fraudType: 'part_time_scam', riskLevel: 'high', status: 'pending_counselor_verify',
      incidentNarrative: '不应显示的敏感正文', contactPhone: '13800138000',
    }] }],
  });
  const instance = createPageInstance(counselorReports.pageDefinition);
  await instance.loadReports();

  assert.deepEqual(instance.data.reports, [{
    reportId: 'report_001', fraudTypeText: '刷单返利诈骗', riskText: '高风险', riskClass: 'risk-high', statusText: '待核验',
  }]);
  assert.equal(JSON.stringify(instance.data.reports).includes('敏感正文'), false);
  assert.equal(global.wx.calls[0].name, 'getCounselorReports');
  assert.deepEqual(global.wx.calls[0].data, {});
});

test('12. 自适应工作台 CSS 使用可换行双列和全宽约束，不设置横向固定页面宽度', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxss'), 'utf8');
  assert.match(css, /\.feature_grid\s*\{[\s\S]*flex-wrap:\s*wrap/);
  assert.match(css, /\.feature_card\s*\{[\s\S]*width:\s*48\.5%/);
  assert.match(css, /\.wide_metric\s*\{[\s\S]*width:\s*100%/);
  assert.match(css, /\.hello_title\s*\{[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.hello_subtitle\s*\{[\s\S]*word-break:\s*break-all/);
  assert.equal(/width:\s*(?:3\d{2}|[4-9]\d{2})rpx/.test(css), false);
});

test('13. 工作台不保留可输入的绑定或身份伪造入口', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8');
  assert.equal(source.includes('bindMiniProgramIdentity'), false);
  assert.equal(source.includes('identityNo'), false);
  assert.equal(wxml.includes('<input'), false);
  assert.equal(wxml.includes('security'), false);
});

test('14. 身份切换后的强制刷新会等待进行中的刷新，再重新读取 session', async () => {
  const instance = createPageInstance(workbench.pageDefinition);
  let resolveFirstRefresh;
  let refreshCount = 0;
  instance.performSessionRefresh = () => {
    refreshCount += 1;
    if (refreshCount === 1) {
      return new Promise((resolve) => { resolveFirstRefresh = resolve; });
    }
    return Promise.resolve(true);
  };

  const inFlightRefresh = instance.refreshSession();
  const forcedRefresh = instance.refreshSession({ force: true });
  await Promise.resolve();
  assert.equal(refreshCount, 1);

  resolveFirstRefresh(false);
  assert.equal(await inFlightRefresh, false);
  assert.equal(await forcedRefresh, true);
  assert.equal(refreshCount, 2);
});
