'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

global.Page = () => {};

const bindingPage = require('../../miniprogram/pages/bind/index.js').__testables;

function createPageInstance(definition, data = {}) {
  return {
    ...definition,
    data: structuredClone({ ...definition.data, ...data }),
    setData(update) {
      Object.assign(this.data, update);
    },
  };
}

test('1. 绑定请求仅包含 identityNo 和 name，并去除首尾空白', () => {
  assert.deepEqual(bindingPage.buildBindingData(' 20230001 ', ' 张三 '), {
    identityNo: '20230001',
    name: '张三',
  });
  assert.equal(bindingPage.buildBindingData(' ', '张三'), null);
  assert.equal(bindingPage.buildBindingData('20230001', ' '), null);
});

test('2. 绑定页不提交角色且成功后返回工作台', async () => {
  const calls = [];
  const relaunches = [];
  global.wx = {
    cloud: {
      async callFunction(request) {
        calls.push(request);
        return { result: { ok: true, code: 'BOUND' } };
      },
    },
    reLaunch(request) {
      relaunches.push(request);
    },
  };
  const instance = createPageInstance(bindingPage.pageDefinition, { identityNo: ' 20230001 ', name: ' 张三 ' });
  await instance.submitBinding();

  assert.deepEqual(calls, [{ name: 'bindMiniProgramIdentity', data: { identityNo: '20230001', name: '张三' } }]);
  assert.deepEqual(relaunches, [{ url: '/pages/index/index' }]);
});

test('3. 绑定页不含角色选择器或角色字段', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/bind/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/bind/index.wxml'), 'utf8');
  assert.equal(source.includes('role'), false);
  assert.equal(wxml.includes('picker'), false);
  assert.equal(wxml.includes('学生'), false);
  assert.equal(wxml.includes('辅导员'), false);
});
