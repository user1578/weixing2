'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '../../web-admin/src/App.vue'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '../../web-admin/src/style.css'), 'utf8');

test('1. Web 后台包含可扩展左侧导航及身份管理入口', () => {
  for (const label of ['工作台', '预警管理', '工单管理', '身份管理']) {
    assert.match(appSource, new RegExp(`>${label}<`));
  }
  assert.match(appSource, /功能完善中/);
  assert.match(appSource, /欢迎回来/);
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
