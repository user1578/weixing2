'use strict';

const crypto = require('crypto');

const EXPECTED_APP_ID = 'wxe262970211858262';
const TARGET_ENV_ID = 'aa-d4gvb4o3t50fc94f8';
const MAX_QUESTIONS = 10;
const ACCEPTED_EVENT_KEYS = new Set(['answers', 'userInfo', 'tcbContext']);
const ANSWER_KEYS = new Set(['questionId', 'answer']);

function success(code, payload = {}) { return { ok: true, code, ...payload }; }
function failure(code, message) { return { ok: false, code, message }; }
function getAppId(context) { return context && (context.APPID || context.appId); }
function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some((key) => !ACCEPTED_EVENT_KEYS.has(key)) || !Array.isArray(event.answers) || !event.answers.length || event.answers.length > MAX_QUESTIONS) return null;
  const answers = [];
  const questionIds = new Set();
  for (const item of event.answers) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !ANSWER_KEYS.has(key)) || typeof item.questionId !== 'string' || typeof item.answer !== 'string') return null;
    const questionId = item.questionId.trim();
    const answer = item.answer.trim();
    if (!questionId || questionId.length > 128 || !answer || answer.length > 32 || questionIds.has(questionId)) return null;
    questionIds.add(questionId);
    answers.push({ questionId, answer });
  }
  return { answers };
}
function hasTrustedBinding(user, openId) { return Boolean(user) && user.role === 'student' && user.status === 'active' && user.bindStatus === 'bound' && typeof user._id === 'string' && user._id && user.wxOpenId === openId && user.wxIdentityKey === `openid:${openId}`; }
async function findUserByWxIdentityKey(db, wxIdentityKey) { const result = await db.collection('users').where({ wxIdentityKey }).limit(1).get(); return Array.isArray(result.data) && result.data.length ? result.data[0] : null; }
async function getById(db, collection, id) { const result = await db.collection(collection).doc(id).get(); return result && result.data ? (Array.isArray(result.data) ? result.data[0] || null : result.data) : null; }
function createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }) { return { _id: createAuditId(), actorId: user._id, actorRole: user.role, actorCollegeId: user.collegeId || null, action: 'access.denied', resourceType: 'quiz', resourceId: 'current', result: 'failure', failureReason: code, requestId, createdAt: serverDate() }; }
function validOptionIds(question) { return new Set((Array.isArray(question.options) ? question.options : []).filter((option) => option && typeof option.id === 'string').map((option) => option.id)); }
function gradeQuestion(question, answer) {
  if (!question || question.status !== 'enabled' || question.questionType !== 'single') return { error: 'INVALID_QUESTION' };
  const options = validOptionIds(question);
  if (!options.has(answer)) return { error: 'INVALID_ANSWER' };
  const correctOptionIds = Array.isArray(question.correctOptionIds) ? question.correctOptionIds.filter((optionId) => typeof optionId === 'string') : [];
  if (correctOptionIds.length !== 1 || !options.has(correctOptionIds[0])) return { error: 'INVALID_QUESTION' };
  const correct = answer === correctOptionIds[0];
  return { correct, answerRecord: { questionId: question._id, selectedOptionIds: [answer], isCorrect: correct }, result: { questionId: question._id, correct, correctAnswer: correctOptionIds[0], explanation: typeof question.explanation === 'string' ? question.explanation : '' } };
}

function createHandler({ db, getWXContext, serverDate, logger = console, createRequestId = () => crypto.randomUUID(), createAttemptId = () => `qat_${crypto.randomUUID().replace(/-/g, '')}`, createAuditId = () => `audit_${crypto.randomUUID().replace(/-/g, '')}` }) {
  if (!db || typeof db.collection !== 'function' || typeof getWXContext !== 'function' || typeof serverDate !== 'function') throw new Error('submitQuiz dependencies are incomplete');
  return async function submitQuiz(event) {
    const requestId = createRequestId();
    const denied = async (user, code, message) => {
      try { await db.collection('audit_logs').add({ data: createAccessDeniedAuditLog({ user, code, requestId, serverDate, createAuditId }) }); return failure(code, message); }
      catch (error) { logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: user._id, stage: 'submitQuizDeniedAudit' }); return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试'); }
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
        return denied(student, code, code === 'FORBIDDEN' ? '当前身份无权提交安全自测' : '账号当前不可用');
      }
      const questions = await Promise.all(input.answers.map(({ questionId }) => getById(db, 'quiz_questions', questionId)));
      const grades = questions.map((question, index) => gradeQuestion(question, input.answers[index].answer));
      const invalid = grades.find((grade) => grade.error);
      if (invalid) return failure(invalid.error, invalid.error === 'INVALID_ANSWER' ? '答案不属于该题选项' : '题目不存在或当前不可用');
      const correctCount = grades.filter((grade) => grade.correct).length;
      const totalCount = grades.length;
      const now = serverDate();
      await db.collection('quiz_attempts').add({ data: { _id: createAttemptId(), studentId: student._id, answers: grades.map((grade) => grade.answerRecord), score: correctCount, totalScore: totalCount, submittedAt: now, createdAt: now } });
      return success('QUIZ_SUBMITTED', { score: correctCount, totalScore: totalCount, scorePercent: Math.round((correctCount / totalCount) * 100), correctCount, totalCount, questions: grades.map((grade) => grade.result) });
    } catch (error) {
      logger.error({ requestId, code: 'INTERNAL_ERROR', resourceId: null, stage: 'submitQuiz' });
      return failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
    }
  };
}

function createDefaultHandler(cloud = require('wx-server-sdk')) { cloud.init({ env: TARGET_ENV_ID }); const db = cloud.database(); return createHandler({ db, getWXContext: () => cloud.getWXContext(), serverDate: () => db.serverDate() }); }
exports.main = async (event) => createDefaultHandler()(event);
exports.__testables = { ACCEPTED_EVENT_KEYS, ANSWER_KEYS, EXPECTED_APP_ID, MAX_QUESTIONS, TARGET_ENV_ID, createAccessDeniedAuditLog, createDefaultHandler, createHandler, findUserByWxIdentityKey, getById, gradeQuestion, hasTrustedBinding, validOptionIds, validateInput };
