'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

global.Page = () => {};
const create = require('../../miniprogram/pages/reports/create/index.js').__testables;
const detail = require('../../miniprogram/pages/alerts/detail/index.js').__testables;

function form(overrides = {}) {
  return { fraudType: 'other', incidentDate: '2026-09-10', incidentTime: '09:30', involvedAmount: '0', hasLoss: false, incidentNarrative: '  咨询可疑信息  ', stillContacting: false, ...overrides };
}

test('1. 关联上报带入 sourceAlertId，独立上报不携带', () => {
  assert.equal(create.buildSubmitData(form(), ' alert_001 ').sourceAlertId, 'alert_001');
  assert.equal('sourceAlertId' in create.buildSubmitData(form()), false);
});

test('2. 请求白名单不会携带伪造服务端字段', () => {
  const data = create.buildSubmitData(form({ studentId: 'spoofed', collegeId: 'spoofed', riskLevel: 'high', status: 'closed' }));
  for (const key of ['studentId', 'collegeId', 'riskLevel', 'status', 'actorId', 'currentHandlerId']) assert.equal(key in data, false);
});

test('3. 金额转换并拒绝空值、负数和非数字', () => {
  assert.equal(create.parseAmount('0'), 0);
  assert.equal(create.parseAmount('100.50'), 100.5);
  for (const value of ['', ' ', '-1', 'NaN', 'Infinity', 'abc']) assert.equal(create.parseAmount(value), null);
});

test('4. hasLoss 与 stillContacting 最终为 Boolean', () => {
  const data = create.buildSubmitData(form({ hasLoss: true, stillContacting: true }));
  assert.equal(data.hasLoss, true);
  assert.equal(data.stillContacting, true);
  assert.equal(create.buildSubmitData(form({ hasLoss: 'true' })), null);
});

test('5. 本地日期时间生成带时区的合法 ISO，非法日期时间拒绝', () => {
  const iso = create.buildIncidentIso('2026-09-10', '09:30');
  assert.ok(iso && !Number.isNaN(new Date(iso).getTime()));
  for (const [date, time] of [['2026-02-30', '09:30'], ['2026-09-10', '25:00'], ['bad', '09:30']]) assert.equal(create.buildIncidentIso(date, time), null);
});

test('6. 正文和可选字段会 trim，空白可选字段不发送', () => {
  const data = create.buildSubmitData(form({ suspiciousPlatform: ' QQ ', suspiciousAccount: ' ', contactPhone: ' 13800138000 ', studentRemark: ' note ' }));
  assert.equal(data.incidentNarrative, '咨询可疑信息');
  assert.equal(data.suspiciousPlatform, 'QQ');
  assert.equal(data.contactPhone, '13800138000');
  assert.equal(data.studentRemark, 'note');
  assert.equal('suspiciousAccount' in data, false);
});

test('7. 正文和可选字段前端限制生效', () => {
  assert.equal(create.buildSubmitData(form({ incidentNarrative: ' ' })), null);
  assert.equal(create.buildSubmitData(form({ incidentNarrative: 'x'.repeat(2001) })), null);
  assert.equal(create.buildSubmitData(form({ suspiciousPlatform: 'x'.repeat(101) })), null);
  assert.equal(create.buildSubmitData(form({ suspiciousAccount: 'x'.repeat(301) })), null);
  assert.equal(create.buildSubmitData(form({ contactPhone: 'x'.repeat(33) })), null);
  assert.equal(create.buildSubmitData(form({ studentRemark: 'x'.repeat(501) })), null);
});

test('8. 成功结果映射只保留展示字段', () => {
  const view = create.mapReportResult({ ok: true, code: 'REPORT_SUBMITTED', report: { reportId: 'report_001', fraudType: 'other', riskLevel: 'high', submittedAt: '2026-09-10T00:00:00.000Z', studentId: 'secret', collegeId: 'secret', sourceAlertKey: 'secret' } });
  assert.deepEqual(Object.keys(view).sort(), ['fraudTypeText', 'reportId', 'riskClass', 'riskLevelText', 'statusText', 'submittedAtText']);
  assert.equal(JSON.stringify(view).includes('secret'), false);
});

test('9. 错误码映射安全且 CONFLICT 中文提示正确', () => {
  assert.equal(create.messageFor('CONFLICT'), '该预警可能已经提交过上报，或数据已发生变化');
  assert.equal(create.messageFor('unknown'), '上报提交失败，请稍后重试');
});

test('10. 预警详情跳转编码 sourceAlertId 且 closed 不显示入口', () => {
  assert.equal(detail.buildReportUrl('alert a&b'), '/pages/reports/create/index?sourceAlertId=alert%20a%26b');
  assert.equal(detail.toAlertView({ status: 'closed' }).canReport, false);
  for (const status of ['sent', 'viewed', 'following_up']) assert.equal(detail.toAlertView({ status }).canReport, true);
});

test('11. submitting 或 submitted 时不发起第二次请求', async () => {
  const definition = create.pageDefinition;
  let calls = 0;
  global.wx = { cloud: { callFunction: async () => { calls += 1; return { result: { ok: true, code: 'REPORT_SUBMITTED', report: { reportId: 'report_001', fraudType: 'other', riskLevel: 'low', submittedAt: '2026-09-10T00:00:00.000Z' } } }; } } };
  const instance = { data: { ...definition.data, submitting: true }, setData(update) { Object.assign(this.data, update); } };
  await definition.submitReport.call(instance);
  instance.data.submitting = false; instance.data.submitted = true;
  await definition.submitReport.call(instance);
  assert.equal(calls, 0);
});

test('12. sourceAlertId 为空白时不写入请求', () => {
  assert.equal('sourceAlertId' in create.buildSubmitData(form(), '   '), false);
});

test('13. 不合法诈骗类型在前端拒绝', () => {
  assert.equal(create.buildSubmitData(form({ fraudType: 'unknown' })), null);
});

test('14. sourceAlertId 不从表单任意字段读取', () => {
  const data = create.buildSubmitData(form({ sourceAlertId: 'spoofed' }));
  assert.equal('sourceAlertId' in data, false);
});

test('15. 金额 Number 与非法类型的边界正确', () => {
  assert.equal(create.parseAmount(12), 12);
  assert.equal(create.parseAmount('.5'), 0.5);
  assert.equal(create.parseAmount({}), null);
});

test('16. 可选字段恰好最大长度可以提交', () => {
  const data = create.buildSubmitData(form({ suspiciousPlatform: 'a'.repeat(100), suspiciousAccount: 'a'.repeat(300), contactPhone: 'a'.repeat(32), studentRemark: 'a'.repeat(500) }));
  assert.ok(data);
});

test('17. trimOptional 对空白、非字符串和超长安全处理', () => {
  assert.equal(create.trimOptional('  ', 5), undefined);
  assert.equal(create.trimOptional(1, 5), null);
  assert.equal(create.trimOptional('abcdef', 5), null);
});

test('18. buildSubmitData 绝不透传表单中的版本或状态', () => {
  const data = create.buildSubmitData(form({ version: 99, status: 'closed', riskReasons: ['spoofed'] }));
  for (const key of ['version', 'status', 'riskReasons']) assert.equal(key in data, false);
});

test('19. 非成功结果不会映射为成功卡片', () => {
  assert.equal(create.mapReportResult({ ok: true, code: 'OTHER', report: {} }), null);
  assert.equal(create.mapReportResult({ ok: false, code: 'REPORT_SUBMITTED' }), null);
});

test('20. 已定义的安全错误码均有中文提示', () => {
  for (const code of ['INVALID_INPUT', 'UNBOUND', 'FORBIDDEN', 'ACCOUNT_DISABLED', 'NOT_FOUND', 'CONFLICT', 'INTERNAL_ERROR']) assert.notEqual(create.messageFor(code), '');
});

test('21. 详情页仅对三个可关联状态展示入口', () => {
  assert.equal(detail.toAlertView({ status: 'pending_dispatch' }).canReport, false);
  assert.equal(detail.toAlertView({ status: 'closed' }).canReport, false);
});

test('22. 表单 switch handler 保持 Boolean', () => {
  const definition = create.pageDefinition;
  const instance = { data: { ...definition.data }, setData(update) { Object.assign(this.data, update); } };
  definition.onHasLossChange.call(instance, { detail: { value: true } });
  definition.onStillContactingChange.call(instance, { detail: { value: false } });
  assert.equal(instance.data.hasLoss, true);
  assert.equal(instance.data.stillContacting, false);
});

test('23. onLoad 只保存 trim 后的内部 sourceAlertId', () => {
  const definition = create.pageDefinition;
  const instance = { data: { ...definition.data }, setData(update) { Object.assign(this.data, update); } };
  definition.onLoad.call(instance, { sourceAlertId: ' alert_001 ' });
  assert.equal(instance.data.sourceAlertId, 'alert_001');
  definition.onLoad.call(instance, { sourceAlertId: 1 });
  assert.equal(instance.data.sourceAlertId, '');
});

test('24. 正常提交调用固定云函数并仅发送构建数据', async () => {
  const definition = create.pageDefinition;
  let request;
  global.wx = { cloud: { callFunction: async (value) => {
    request = value;
    return { result: { ok: true, code: 'REPORT_SUBMITTED', report: { reportId: 'report_001', fraudType: 'other', riskLevel: 'low', submittedAt: '2026-09-10T00:00:00.000Z' } } };
  } } };
  const instance = { data: { ...definition.data, ...form(), sourceAlertId: 'alert_001', studentId: 'spoofed' }, setData(update) { Object.assign(this.data, update); } };
  await definition.submitReport.call(instance);
  assert.equal(request.name, 'createStudentReport');
  assert.equal(request.data.sourceAlertId, 'alert_001');
  assert.equal('studentId' in request.data, false);
  assert.equal(instance.data.submitted, true);
});

test('25. 网络异常显示安全提示并恢复 submitting', async () => {
  const definition = create.pageDefinition;
  global.wx = { cloud: { callFunction: async () => { throw new Error('network'); } } };
  const instance = { data: { ...definition.data, ...form() }, setData(update) { Object.assign(this.data, update); } };
  await definition.submitReport.call(instance);
  assert.equal(instance.data.errorMessage, '网络或服务异常，请稍后重试');
  assert.equal(instance.data.submitting, false);
});
