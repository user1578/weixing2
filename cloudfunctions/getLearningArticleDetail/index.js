'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const ACCEPTED_EVENT_KEYS = new Set(['articleId', 'userInfo', 'tcbContext']);

function success(code, payload = {}) { return { ok: true, code, ...payload }; }
function failure(code, message) { return { ok: false, code, message }; }
function getAppId(context) { return context && (context.APPID || context.appId); }
function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key)) || typeof event.articleId !== 'string') return null;
  const articleId = event.articleId.trim();
  return articleId && articleId.length <= 128 ? { articleId } : null;
}
function hasTrustedBinding(user, openId) { return Boolean(user) && user.role === 'student' && user.status === 'active' && user.bindStatus === 'bound' && typeof user._id === 'string' && user._id && user.wxOpenId === openId && user.wxIdentityKey === `openid:${openId}`; }
async function findUserByWxIdentityKey(db, wxIdentityKey) { const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get(); return Array.isArray(result.data) && result.data.length ? result.data[0] : null; }
async function getById(db, collection, id) { const result = await db.collection(collection).doc(id).get(); return result && result.data ? (Array.isArray(result.data) ? result.data[0] || null : result.data) : null; }
function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId, resourceId = user._id }) { return { _id: createAuditId(), actorId: user._id, actorRole: user.role, actorCollegeId: user.collegeId || null, action: 'access.denied', resourceType: 'learning_article', resourceId, result: 'failure', failureReason: code, requestId, createdAt: serverDate() }; }
function toDetail(article, completed) { return { articleId: article._id, title: article.title, summary: article.summary, content: article.content, category: article.category, publishedAt: article.publishedAt, completed }; }

function createHandler({ db, getWXContext, serverDate, logger = console, createRequestId = () => crypto.randomUUID(), createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}` }) {
  if (!db || typeof db.collection !== 'function' || typeof getWXContext !== 'function' || typeof serverDate !== 'function') throw new Error('getLearningArticleDetail dependencies are incomplete');
  return async function getLearningArticleDetail(event) {
    const requestId = createRequestId();
    const denied = async (user, code, message, resourceId) => {
      try { await db.collection('audit_logs').add({ data: createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId, resourceId }) }); return failure(code, message); }
      catch (error) { logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: user._id, stage: 'getLearningArticleDetailDeniedAudit' }); return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试'); }
    };
    try {
      const input = validateInput(event);
      if (!input) return failure('INVALID_INPUT', '请求参数无效');
      const context = getWXContext() || {};
      if (getAppId(context) && getAppId(context) !== EXPECTED_APP_ID) return failure('FORBIDDEN', '调用来源不被允许');
      if (!context.OPENID) return failure('INTERNAL_ERROR', '身份上下文不可用，请稍后重试');
      const student = await findUserByWxIdentityKey(db, `openid:${context.OPENID}`);
      if (!student) return failure('UNBOUND', '当前微信尚未绑定学生身份');
      if (!hasTrustedBinding(student, context.OPENID)) {
        const code = student.role !== 'student' ? 'FORBIDDEN' : student.status !== 'active' ? 'ACCOUNT_DISABLED' : 'INTERNAL_ERROR';
        return denied(student, code, code === 'FORBIDDEN' ? '当前身份无权查看安全学习内容' : '账号当前不可用', input.articleId);
      }
      const article = await getById(db, 'learning_articles', input.articleId);
      if (!article || article.publishStatus !== 'published') return failure('NOT_FOUND', '文章不存在或暂不可查看');
      const recordResult = await db.collection('learning_records').where({ studentId: student._id, articleId: article._id }).limit(1).get();
      const completed = Array.isArray(recordResult.data) && recordResult.data.length > 0;
      return success('LEARNING_ARTICLE_DETAIL_LOADED', { article: toDetail(article, completed) });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'getLearningArticleDetail' });
      return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
    }
  };
}

function createDefaultHandler(cloud = require('wx-server-sdk')) { cloud.init({ env: TARGET_ENV_ID }); const db = cloud.database(); return createHandler({ db, getWXContext: () => cloud.getWXContext(), serverDate: () => db.serverDate() }); }
exports.main = async (event) => createDefaultHandler()(event);
exports.__testables = { ACCEPTED_EVENT_KEYS, EXPECTED_APP_ID, TARGET_ENV_ID, createAccessDeniedAuditLog, createDefaultHandler, createHandler, findUserByWxIdentityKey, getById, hasTrustedBinding, toDetail, validateInput };
