'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '../../web-admin/src/App.vue'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '../../web-admin/src/style.css'), 'utf8');

test('1. Web 后台包含工作台、身份管理和学院管理导航', () => {
  for (const label of ['工作台', '预警管理', '工单管理', '身份管理', '学院管理']) {
    assert.match(appSource, new RegExp(`>${label}<`));
  }
  assert.match(appSource, /功能完善中/);
  assert.match(appSource, /保卫处工作台/);
  assert.match(appSource, /校园反诈业务概览/);
  assert.match(styleSource, /\.sidebar\s*\{/);
  assert.match(styleSource, /\.side-nav\s*\{/);
});

test('2. 身份列表仅绑定后端允许的展示字段，不渲染 OPENID 或完整敏感用户字段', () => {
  for (const field of ['identity\.name', 'identity\.identityNoMasked', 'identity\.collegeName', 'identity\.bindStatus', 'identity\.status']) {
    assert.match(appSource, new RegExp(field));
  }
  for (const forbidden of ['wxOpenId', 'wxIdentityKey', 'identityKey', 'passwordHash', 'loginName', 'mobile', 'focusReason', 'studentNo', 'staffNo']) {
    assert.doesNotMatch(appSource, new RegExp(`identity\\.${forbidden}`), forbidden);
  }
});

test('3. 新增身份仅提交允许字段并使用 identities endpoint', () => {
  assert.match(appSource, /fetch\(`\$\{apiBaseUrl\}\/identities`,\s*\{\s*method: "POST"/);
  assert.match(appSource, /role:\s*form\.role/);
  assert.match(appSource, /identityNo:\s*form\.identityNo\.trim\(\)/);
  assert.match(appSource, /name:\s*form\.name\.trim\(\)/);
  assert.match(appSource, /collegeId:\s*form\.collegeId/);
  assert.match(appSource, /身份编号填写学号/);
  assert.match(appSource, /身份编号填写工号/);
});

test('4. unbind/status 均携带当前 version，成功后重新加载服务端列表', () => {
  assert.match(appSource, /\/identities\/\$\{encodeURIComponent\(identity\.userId\)\}\/unbind/);
  assert.match(appSource, /\/identities\/\$\{encodeURIComponent\(identity\.userId\)\}\/status/);
  assert.match(appSource, /body:\s*JSON\.stringify\(\{ version: identity\.version \}\)/);
  assert.match(appSource, /body:\s*JSON\.stringify\(\{ version: identity\.version, status: nextStatus \}\)/);
  assert.match(appSource, /解除后，该微信将无法继续使用此身份，需要重新验证绑定。/);
  assert.equal((appSource.match(/await loadIdentities\(\)/g) || []).length >= 3, true);
});

test('5. TOKEN 失效继续复用既有清 session 逻辑', () => {
  assert.match(appSource, /const TOKEN_ERROR_CODES = new Set\(\["TOKEN_MISSING", "TOKEN_INVALID", "TOKEN_EXPIRED"\]\)/);
  assert.match(appSource, /if \(TOKEN_ERROR_CODES\.has\(code\)\) \{\s*clearSession\(\);/);
});

test('6. 工作台通过 dashboard 接口显示真实指标与安全列表字段', () => {
  assert.match(appSource, /fetch\(`\$\{apiBaseUrl\}\/dashboard`/);
  for (const label of ['待保卫处核验', '处理中', '已结案', '今日新增', '待办工单', '最新预警', '人员与学院概览', '快捷操作']) {
    assert.match(appSource, new RegExp(label));
  }
  for (const forbidden of ['studentId', 'sourceReference', 'incidentNarrative', 'contactPhone', 'actionContent']) {
    assert.doesNotMatch(appSource, new RegExp(`(?:report|alert)\\.${forbidden}`), forbidden);
  }
  assert.doesNotMatch(appSource, /pendingSecurityVerifyCount:\s*\d+/);
});

test('7. 学院管理只调用受保护接口，新增表单不暴露学院编号', () => {
  assert.match(appSource, /fetch\(`\$\{apiBaseUrl\}\/colleges`/);
  assert.match(appSource, /\/colleges\/\$\{encodeURIComponent\(college\.collegeId\)\}\/status/);
  assert.match(appSource, /该学院仍有正常使用中的学生或辅导员身份，请先停用相关身份。/);
  assert.match(appSource, /body:\s*JSON\.stringify\(\{ name \}\)/);
  assert.doesNotMatch(appSource, /v-model="collegeId"/);
  assert.doesNotMatch(appSource, /college\.(?:wxOpenId|wxIdentityKey|passwordHash|identityKey)/);
});

test('8. 新增学院后进入身份管理并重新加载 active 学院下拉选项', () => {
  assert.match(appSource, /activeView\.value = "identities"/);
  assert.match(appSource, /await loadIdentities\(\)/);
  assert.match(appSource, /colleges\.value = payload\.colleges\.map/);
});
