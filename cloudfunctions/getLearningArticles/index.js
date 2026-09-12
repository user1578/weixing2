'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const MAX_ARTICLES = 100;
const MAX_RECORDS = 1000;
const ACCEPTED_EVENT_KEYS = new Set(['userInfo', 'tcbContext']);

function success(code, payload = {}) { return { ok: true, code, ...payload }; }
function failure(code, message) { return { ok: false, code, message }; }
function getAppId(context) { return context && (context.APPID || context.appId); }
function validateInput(event) { return event === undefined || event === null || (typeof event === 'object' && !Array.isArray(event) && Object.keys(event).every((key) => ACCEPTED_EVENT_KEYS.has(key))); }
function hasTrustedBinding(user, openId) { return Boolean(user) && user.role === 'student' && user.status === 'active' && user.bindStatus === 'bound' && typeof user._id === 'string' && user._id && user.wxOpenId === openId && user.wxIdentityKey === `openid:${openId}`; }

async function findUserByWxIdentityKey(db, wxIdentityKey) {
  const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get();
  return Array.isArray(result.data) && result.data.length ? result.data[0] : null;
}

function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }) {
  return { _id: createAuditId(), actorId: user._id, actorRole: user.role, actorCollegeId: user.collegeId || null,
    action: 'access.denied', resourceType: 'user', resourceId: user._id, result: 'failure', failureReason: code, requestId, createdAt: serverDate() };
}

function toArticleListItem(article, completedArticleIds) {
  return { articleId: article._id, title: article.title, summary: article.summary, category: article.category,
    publishedAt: article.publishedAt, completed: completedArticleIds.has(article._id) };
}

function createHandler({ db, getWXContext, serverDate, logger = console, createRequestId = () => crypto.randomUUID(), createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}` }) {
  if (!db || typeof db.collection !== 'function' || typeof getWXContext !== 'function' || typeof serverDate !== 'function') throw new Error('getLearningArticles dependencies are incomplete');
  return async function getLearningArticles(event) {
    const requestId = createRequestId();
    const denied = async (user, code, message) => {
      try {
        await db.collection('audit_logs').add({ data: createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }) });
        return failure(code, message);
      } catch (error) {
        logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: user._id, stage: 'getLearningArticlesDeniedAudit' });
        return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
      }
    };
    try {
      if (!validateInput(event)) return failure('INVALID_INPUT', '请求参数无效');
      const context = getWXContext() || {};
      if (getAppId(context) && getAppId(context) !== EXPECTED_APP_ID) return failure('FORBIDDEN', '调用来源不被允许');
      if (!context.OPENID) return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      const student = await findUserByWxIdentityKey(db, `openid:${context.OPENID}`);
      if (!student) return failure('UNBOUND', '当前微信尚未绑定学生身份');
      if (!hasTrustedBinding(student, context.OPENID)) {
        const code = student.role !== 'student' ? 'FORBIDDEN' : student.status !== 'active' ? 'ACCOUNT_DISABLED' : 'INTERNAL_ERROR';
        return denied(student, code, code === 'FORBIDDEN' ? '当前身份无权查看安全学习内容' : '账号当前不可用');
      }
      const articlesResult = await db.collection('learning_articles').where({ publishStatus: 'published' })
        .orderBy('publishedAt', 'desc').limit(MAX_ARTICLES).get();
      const recordsResult = await db.collection('learning_records').where({ studentId: student._id }).limit(MAX_RECORDS).get();
      const completedArticleIds = new Set((Array.isArray(recordsResult.data) ? recordsResult.data : [])
        .filter((record) => record && typeof record.articleId === 'string').map((record) => record.articleId));
      const articles = (Array.isArray(articlesResult.data) ? articlesResult.data : []).map((article) => toArticleListItem(article, completedArticleIds));
      return success('LEARNING_ARTICLES_LOADED', { articles });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'getLearningArticles' });
      return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
    }
  };
}

function createDefaultHandler(cloud = require('wx-server-sdk')) {
  cloud.init({ env: TARGET_ENV_ID });
  const db = cloud.database();
  return createHandler({ db, getWXContext: () => cloud.getWXContext(), serverDate: () => db.serverDate() });
}

exports.main = async (event) => createDefaultHandler()(event);
exports.__testables = { ACCEPTED_EVENT_KEYS, EXPECTED_APP_ID, MAX_ARTICLES, MAX_RECORDS, TARGET_ENV_ID, createAccessDeniedAuditLog, createDefaultHandler, createHandler, findUserByWxIdentityKey, hasTrustedBinding, toArticleListItem, validateInput };
