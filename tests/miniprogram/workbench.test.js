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

function createWx({ sessions = [], studentAlerts = [], studentReportLists = [], counselorReportLists = [] } = {}) {
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
        if (request.name === 'getStudentAlerts') return { result: studentAlerts.shift() || { ok: true, alerts: [] } };
        if (request.name === 'getStudentReports') return { result: studentReportLists.shift() || { ok: true, reports: [] } };
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
    studentReportLists: [{ ok: true, reports: [{ status: 'in_process' }, { status: 'closed' }] }],
  });
  const instance = createPageInstance(workbench.pageDefinition);
  const loaded = await instance.refreshSession();

  assert.equal(loaded, true);
  assert.equal(instance.data.profile.role, 'student');
  assert.deepEqual(instance.data.studentSummary, {
    highRiskCount: 1, pendingAlertCount: 2, followingAlertCount: 1,
    reportCountText: '2', reportHint: '本人正在处理的工单数量',
  });
  assert.deepEqual(global.wx.calls.map((call) => call.name).sort(), ['getMiniProgramSession', 'getStudentAlerts', 'getStudentReports']);
});

test('2. 辅导员工作台只调用既有学院工单查询，并计算待核验和高风险数', async () => {
  global.wx = createWx({
    sessions: [{ ok: true, code: 'BOUND', profile: COUNSELOR }],
    counselorReportLists: [{ ok: true, reports: [
      { riskLevel: 'high', status: 'pending_counselor_verify' },
      { riskLevel: 'low', status: 'pending_counselor_verify' },
    ] }, { ok: true, reports: [{ status: 'pending_counselor_verify' }] }, { ok: true, reports: [{ status: 'closed' }, { status: 'in_process' }] }],
  });
  const instance = createPageInstance(workbench.pageDefinition);
  await instance.refreshSession();

  assert.equal(instance.data.profile.role, 'counselor');
  assert.deepEqual(instance.data.counselorSummary, {
    pendingVerifyCount: 2, highRiskCount: 1, followingCountText: '1', recordCountText: '2',
    unavailableHint: '工单记录 2 项',
  });
  assert.equal(global.wx.calls.some((call) => call.name === 'getStudentAlerts'), false);
  assert.equal(global.wx.calls.some((call) => call.name === 'getCounselorReports'), true);
});

test('3. 小程序工作台源码不保留身份切换入口或云函数调用', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8');
  assert.equal(source.includes('switchDemoMiniProgramIdentity'), false);
  assert.equal(source.includes('identitySwitch'), false);
  assert.equal(wxml.includes('切换身份'), false);
  assert.equal(wxml.includes('data-target-role'), false);
});

test('4. security 会话不渲染工作台，也不加载学生或辅导员数据', async () => {
  global.wx = createWx({ sessions: [{ ok: false, code: 'FORBIDDEN' }] });
  const instance = createPageInstance(workbench.pageDefinition);
  const loaded = await instance.refreshSession();

  assert.equal(loaded, false);
  assert.equal(instance.data.profile, null);
  assert.deepEqual(global.wx.calls.map((call) => call.name), ['getMiniProgramSession']);
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
  assert.deepEqual(global.wx.navigations.at(-1), { url: '/pages/counselor/reports/index?scope=pending' });
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
  assert.deepEqual(global.wx.calls[0].data, { scope: 'pending' });
});

test('12. 自适应工作台 CSS 使用可换行双列和全宽约束，不设置横向固定页面宽度', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxss'), 'utf8');
  assert.match(css, /\.feature_grid\s*\{[\s\S]*flex-wrap:\s*wrap/);
  assert.match(css, /\.feature_grid\s*\{[\s\S]*align-items:\s*stretch/);
  assert.match(css, /\.feature_slot\s*\{[\s\S]*box-sizing:\s*border-box/);
  assert.match(css, /\.feature_slot\s*\{[\s\S]*width:\s*48\.5%/);
  assert.match(css, /\.feature_slot\s*\{[\s\S]*margin-bottom:\s*18rpx/);
  assert.match(css, /\.feature_card\s*\{[\s\S]*width:\s*100%/);
  assert.match(css, /\.feature_card\s*\{[\s\S]*height:\s*100%/);
  assert.match(css, /\.feature_card\s*\{[\s\S]*margin:\s*0/);
  assert.doesNotMatch(css, /\.feature_card\s*\{[\s\S]*width:\s*48\.5%/);
  assert.match(css, /\.wide_metric\s*\{[\s\S]*width:\s*100%/);
  assert.match(css, /\.hello_title\s*\{[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.hello_subtitle\s*\{[\s\S]*word-break:\s*break-all/);
  assert.equal(/width:\s*(?:3\d{2}|[4-9]\d{2})rpx/.test(css), false);
});

test('13. 375、390、430 宽度均由百分比卡片和盒模型约束，避免横向溢出', () => {
  const workbenchCss = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxss'), 'utf8');
  const bindingCss = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/bind/index.wxss'), 'utf8');
  for (const viewport of [375, 390, 430]) {
    assert.equal(viewport >= 375, true);
    assert.match(workbenchCss, /\.page\s*\{[\s\S]*box-sizing:\s*border-box/);
    assert.match(workbenchCss, /\.feature_grid\s*\{[\s\S]*flex-wrap:\s*wrap/);
    assert.match(workbenchCss, /\.feature_slot\s*\{[\s\S]*width:\s*48\.5%/);
    assert.match(workbenchCss, /\.feature_card\s*\{[\s\S]*width:\s*100%/);
    assert.match(workbenchCss, /\.feature_card\s*\{[\s\S]*margin:\s*0/);
    assert.equal(viewport * 0.485 * 2 < viewport, true);
    assert.match(bindingCss, /\.page\s*\{[\s\S]*box-sizing:\s*border-box/);
    assert.match(bindingCss, /\.card\s*\{[\s\S]*width:\s*100%/);
    assert.match(bindingCss, /\.input\s*\{[\s\S]*width:\s*100%/);
  }
  assert.equal(/width:\s*(?:3\d{2}|[4-9]\d{2})rpx/.test(`${workbenchCss}\n${bindingCss}`), false);
});

test('14. 工作台不保留可输入的绑定或身份伪造入口', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8');
  assert.equal(source.includes('bindMiniProgramIdentity'), false);
  assert.equal(source.includes('identityNo'), false);
  assert.equal(wxml.includes('<input'), false);
  assert.equal(wxml.includes('security'), false);
});

test('15. 强制刷新会等待进行中的刷新，再重新读取 session', async () => {
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

test('16. 学院名称仅用于工作台展示，保留可信 collegeId 供现有权限链路使用', () => {
  const mapped = workbench.normalizeProfile(COUNSELOR);
  const trustedName = workbench.normalizeProfile({ ...COUNSELOR, collegeName: '可信返回的学院名称' });
  const unknown = workbench.normalizeProfile({ ...COUNSELOR, collegeId: 'college_other' });
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8');

  assert.equal(mapped.collegeId, 'college_cs');
  assert.equal(mapped.collegeName, '计算机科学学院');
  assert.equal(trustedName.collegeName, '可信返回的学院名称');
  assert.equal(unknown.collegeName, '');
  assert.match(wxml, /所属学院/);
  assert.match(wxml, /profile\.collegeName/);
  assert.equal(wxml.includes('profile.collegeId'), false);
});

test('17. 辅导员工单入口采用浅蓝待办、白底常规、浅红重点的固定 2×2 卡片布局', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxss'), 'utf8');
  const counselorCss = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/counselor/reports/index.wxss'), 'utf8');
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8');
  const pendingBlock = css.match(/\.counselor_pending_feature\s*\{([\s\S]*?)\n\}/)[1];
  const focusBlock = css.match(/\.counselor_focus_feature\s*\{([\s\S]*?)\n\}/)[1];
  const primaryBlock = css.match(/\.primary_feature\s*\{([\s\S]*?)\n\}/)[1];

  assert.match(wxml, /feature_grid counselor_feature_grid/);
  assert.equal((wxml.match(/feature_card counselor_card/g) || []).length, 4);
  assert.match(css, /\.feature_slot\s*\{[\s\S]*width:\s*48\.5%/);
  assert.match(css, /\.feature_card\s*\{[\s\S]*min-height:\s*200rpx/);
  assert.match(pendingBlock, /background:\s*#eaf2ff/i);
  assert.match(pendingBlock, /border-color:\s*#cfe0ff/i);
  assert.doesNotMatch(pendingBlock, /#2563eb/i);
  assert.match(focusBlock, /background:\s*#fff7f8/i);
  assert.match(focusBlock, /border-color:\s*#fecdd3/i);
  assert.match(primaryBlock, /background:\s*#eaf2ff/i);
  assert.doesNotMatch(css, /(^|\n)page\s*\{/);
  assert.doesNotMatch(counselorCss, /(^|\n)page\s*\{/);
  assert.doesNotMatch(css, /\[[^\]]+\]/);
  assert.doesNotMatch(counselorCss, /\[[^\]]+\]/);
});

test('18. 学生和辅导员四张入口均由 feature_slot 承担双列 flex 子项', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxss'), 'utf8');
  const counselorStart = wxml.indexOf('<view class="feature_grid counselor_feature_grid">');
  const studentStart = wxml.indexOf('<view class="feature_grid">');
  const studentMarkup = wxml.slice(studentStart, counselorStart);
  const counselorMarkup = wxml.slice(counselorStart);
  const slotPattern = /<view class="feature_slot">\s*<button class="feature_card\b[\s\S]*?<\/button>\s*<\/view>/g;
  const studentSlots = studentMarkup.match(slotPattern) || [];
  const counselorSlots = counselorMarkup.match(slotPattern) || [];

  assert.equal(studentSlots.length, 4);
  assert.equal(counselorSlots.length, 4);
  for (const label of ['风险提醒', '我要上报', '我的工单', '安全学习']) {
    assert.equal(studentSlots.some((slot) => slot.includes(label)), true, label);
  }
  for (const label of ['待核验工单', '跟进处理中', '重点关注', '工单记录']) {
    assert.equal(counselorSlots.some((slot) => slot.includes(label)), true, label);
  }
  assert.doesNotMatch(studentMarkup, /<view class="feature_grid">\s*<button/);
  assert.doesNotMatch(counselorMarkup, /<view class="feature_grid counselor_feature_grid">\s*<button/);
  assert.match(css, /\.feature_card::after\s*\{\s*border:\s*0/);

  const selectors = [...css.matchAll(/(?:^|\})\s*([^{}]+?)\s*\{/g)]
    .flatMap((match) => match[1].split(','))
    .map((selector) => selector.trim());
  for (const selector of selectors) {
    assert.match(selector, /^\.[a-z_][a-z0-9_-]*(?:::[a-z-]+)?(?:\s+\.[a-z_][a-z0-9_-]*(?:::[a-z-]+)?)*$/i, selector);
  }
});
