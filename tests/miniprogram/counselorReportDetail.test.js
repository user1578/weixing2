'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

global.Page = () => {};
const detail = require('../../miniprogram/pages/counselor/reports/detail/index.js').__testables;

function page(data = {}) {
  const instance = { ...detail.pageDefinition, data: structuredClone({ ...detail.pageDefinition.data, ...data }) };
  instance.setData = (update) => {
    for (const [key, value] of Object.entries(update)) {
      const parts = key.split('.');
      let target = instance.data;
      while (parts.length > 1) { const part = parts.shift(); target[part] ||= {}; target = target[part]; }
      target[parts[0]] = value;
    }
  };
  return instance;
}

function input(key, value) { return { currentTarget: { dataset: { key } }, detail: { value } }; }
const activeData = { report: { reportId: 'report_1', version: 3 }, workflow: { followupId: 'followup_1', followupVersion: 2, followupStatus: 'in_progress' } };

test('辅导员详情页没有动态计算属性 setData 或 Babel runtime 依赖', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/counselor/reports/detail/index.js'), 'utf8');
  assert.doesNotMatch(source, /\[\s*`form\./);
  assert.doesNotMatch(source, /toPropertyKey/);
});

test('详情表单仅显式更新允许字段，非法 key 被忽略', () => {
  const instance = page();
  instance.updateField(input('opinion', '初步意见'));
  instance.updateField(input('contactedAt', '2026-09-12T10:00:00+08:00'));
  instance.updateField(input('transferReason', '疑似诈骗，转保卫处'));
  instance.updateField(input('closeReason', '已核验为误报'));
  const before = structuredClone(instance.data.form);
  instance.updateField(input('actorId', 'bad'));
  assert.deepEqual(instance.data.form, { ...before, opinion: '初步意见', contactedAt: '2026-09-12T10:00:00+08:00', transferReason: '疑似诈骗，转保卫处', closeReason: '已核验为误报' });
});

test('转保卫处保留完整结果集并以 suspected 为默认值', () => {
  const instance = page();
  instance.chooseAction({ currentTarget: { dataset: { mode: 'transfer' } } });
  assert.equal(instance.data.form.verificationResult, 'suspected');
  assert.equal(detail.TRANSFER_RESULTS.includes('confirmed'), true);
  assert.equal(detail.TRANSFER_RESULTS.includes('suspected'), true);
  instance.selectTransferResult({ detail: { value: 0 } });
  assert.equal(instance.data.form.verificationResult, 'confirmed');
});

test('直接结案只显示允许结果、默认 misreport，并拒绝发送 confirmed/suspected', () => {
  const instance = page(activeData);
  const calls = [];
  instance.callAction = (name, payload) => calls.push({ name, payload });
  instance.chooseAction({ currentTarget: { dataset: { mode: 'close' } } });
  assert.equal(instance.data.form.verificationResult, 'misreport');
  assert.deepEqual(detail.CLOSE_RESULTS, ['misreport', 'consultation', 'not_fraud']);
  assert.equal(detail.CLOSE_RESULTS.includes('confirmed'), false);
  assert.equal(detail.CLOSE_RESULTS.includes('suspected'), false);
  instance.setData({ 'form.verificationResult': 'confirmed' });
  instance.closeReport();
  assert.equal(calls.length, 0);
  instance.selectCloseResult({ detail: { value: 2 } });
  instance.closeReport();
  assert.deepEqual(calls[0], { name: 'closeCounselorReport', payload: { followupId: 'followup_1', expectedFollowupVersion: 2, expectedReportVersion: 3, verificationResult: 'not_fraud', closeReason: '' } });
});

test('转保卫处仍可发送 confirmed，两个 picker 使用不同结果集', () => {
  const instance = page(activeData);
  const calls = [];
  instance.callAction = (name, payload) => calls.push({ name, payload });
  instance.chooseAction({ currentTarget: { dataset: { mode: 'transfer' } } });
  instance.selectTransferResult({ detail: { value: 0 } });
  instance.transferToSecurity();
  assert.equal(calls[0].name, 'transferCounselorReportToSecurity');
  assert.equal(calls[0].payload.verificationResult, 'confirmed');
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/counselor/reports/detail/index.wxml'), 'utf8');
  assert.match(wxml, /range="\{\{transferResults\}\}"/);
  assert.match(wxml, /range="\{\{closeResults\}\}"/);
});
