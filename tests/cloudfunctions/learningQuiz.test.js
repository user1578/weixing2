'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const articlesModule = require('../../cloudfunctions/getLearningArticles');
const detailModule = require('../../cloudfunctions/getLearningArticleDetail');
const completeModule = require('../../cloudfunctions/completeLearningArticle');
const quizModule = require('../../cloudfunctions/getQuiz');
const submitModule = require('../../cloudfunctions/submitQuiz');

const trustedContext = { OPENID: 'student-openid', APPID: 'wxe262970211858262' };
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function student(overrides = {}) { return { _id: 'usr_student_001', role: 'student', status: 'active', bindStatus: 'bound', wxOpenId: 'student-openid', wxIdentityKey: 'openid:student-openid', collegeId: 'college_cs', ...overrides }; }
function article(overrides = {}) { return { _id: 'art_001', title: '识别刷单返利', summary: '不要垫资', content: '可读正文', category: 'knowledge', fraudTags: ['part_time_scam'], publishStatus: 'published', authorId: 'usr_security_001', publishedAt: '2026-09-01T00:00:00.000Z', version: 1, ...overrides }; }
function question(index = 1, overrides = {}) { return { _id: `qst_${index}`, questionType: 'single', stem: `题目 ${index}`, options: [{ id: 'A', text: '错误答案' }, { id: 'B', text: '正确答案' }, { id: 'C', text: '另一个答案' }, { id: 'D', text: '最后答案' }], correctOptionIds: ['B'], explanation: `解析 ${index}`, fraudTags: ['other'], status: 'enabled', createdAt: `2026-09-${String(index).padStart(2, '0')}T00:00:00.000Z`, version: 1, ...overrides }; }
function matches(row, query) { return Object.entries(query).every(([key, value]) => row[key] === value); }

function createMockDb({ users = [student()], articles = [], records = [], questions = [], attempts = [] } = {}) {
  const state = { users: clone(users), articles: clone(articles), records: clone(records), questions: clone(questions), attempts: clone(attempts), audits: [], queries: [], writes: [] };
  const rows = (name) => ({ users: state.users, learning_articles: state.articles, learning_records: state.records, quiz_questions: state.questions, quiz_attempts: state.attempts, audit_logs: state.audits }[name] || []);
  const collection = (name) => ({
    where(query) {
      const read = async ({ limit = null, orderBy = null } = {}) => {
        const found = rows(name).filter((row) => matches(row, query));
        if (orderBy) found.sort((left, right) => (left[orderBy.field] > right[orderBy.field] ? 1 : left[orderBy.field] < right[orderBy.field] ? -1 : 0) * (orderBy.direction === 'desc' ? -1 : 1));
        state.queries.push({ collection: name, query: clone(query), limit, orderBy: clone(orderBy) });
        return { data: (limit === null ? found : found.slice(0, limit)).map(clone) };
      };
      return { limit(limit) { return { get: () => read({ limit }) }; }, orderBy(field, direction) { return { limit(limit) { return { get: () => read({ limit, orderBy: { field, direction } }) }; } }; }, get: () => read() };
    },
    doc(id) { return { get: async () => ({ data: clone(rows(name).find((row) => row._id === id)) }) }; },
    async add({ data }) {
      state.writes.push({ collection: name, data: clone(data) });
      if (name === 'learning_records') {
        if (state.records.some((record) => record.studentId === data.studentId && record.articleId === data.articleId)) { const error = new Error('duplicate key'); error.code = 'DUPLICATE'; throw error; }
        state.records.push(clone(data));
      } else if (name === 'quiz_attempts') state.attempts.push(clone(data));
      else if (name === 'audit_logs') state.audits.push(clone(data));
      else throw new Error(`unexpected write ${name}`);
      return { id: data._id };
    },
  });
  return { db: { collection }, state };
}

function makeHandlers(options = {}) {
  const mock = createMockDb(options);
  const logs = [];
  const dependencies = { db: mock.db, getWXContext: () => options.wxContext || trustedContext, serverDate: () => ({ $serverDate: true }), logger: { error: (entry) => logs.push(entry) }, createRequestId: () => 'req-learning', createLearningId: () => 'lrn_test_001', createAttemptId: () => 'qat_test_001', createAuditId: () => 'audit_test_001' };
  return { ...mock, logs, articles: articlesModule.__testables.createHandler(dependencies), detail: detailModule.__testables.createHandler(dependencies), complete: completeModule.__testables.createHandler(dependencies), quiz: quizModule.__testables.createHandler(dependencies), submit: submitModule.__testables.createHandler(dependencies) };
}

test('学习：未绑定、非 student 均被拒绝，且不信任客户端 studentId', async () => {
  assert.equal((await makeHandlers({ users: [] }).articles({})).code, 'UNBOUND');
  const forbidden = makeHandlers({ users: [student({ role: 'counselor' })] });
  assert.equal((await forbidden.articles({})).code, 'FORBIDDEN');
  assert.equal(forbidden.state.audits[0].action, 'access.denied');
  const handler = makeHandlers({ articles: [article()] });
  assert.equal((await handler.complete({ articleId: 'art_001', studentId: 'usr_other' })).code, 'INVALID_INPUT');
  assert.equal(handler.state.records.length, 0);
});

test('学习：列表只读取 published、字段裁剪并正确标记本人完成状态', async () => {
  const handler = makeHandlers({ articles: [article(), article({ _id: 'art_draft', title: '草稿', publishStatus: 'draft' })], records: [{ _id: 'lrn_001', studentId: 'usr_student_001', articleId: 'art_001' }] });
  const response = await handler.articles({});
  assert.equal(response.code, 'LEARNING_ARTICLES_LOADED');
  assert.deepEqual(response.articles.map((row) => row.articleId), ['art_001']);
  assert.equal(response.articles[0].completed, true);
  assert.deepEqual(Object.keys(response.articles[0]).sort(), ['articleId', 'category', 'completed', 'publishedAt', 'summary', 'title']);
  assert.deepEqual(handler.state.queries.find((row) => row.collection === 'learning_articles').query, { publishStatus: 'published' });
});

test('学习：草稿详情不可读，已发布详情只返回安全字段', async () => {
  const handler = makeHandlers({ articles: [article(), article({ _id: 'art_draft', publishStatus: 'draft' })] });
  assert.equal((await handler.detail({ articleId: 'art_draft' })).code, 'NOT_FOUND');
  const response = await handler.detail({ articleId: 'art_001' });
  assert.equal(response.code, 'LEARNING_ARTICLE_DETAIL_LOADED');
  assert.deepEqual(Object.keys(response.article).sort(), ['articleId', 'category', 'completed', 'content', 'publishedAt', 'summary', 'title']);
  assert.equal(JSON.stringify(response).includes('authorId'), false);
  assert.equal(JSON.stringify(response).includes('fraudTags'), false);
});

test('学习：完成记录只写本人且重复请求保持幂等', async () => {
  const handler = makeHandlers({ articles: [article()] });
  const first = await handler.complete({ articleId: 'art_001' });
  const second = await handler.complete({ articleId: 'art_001' });
  assert.equal(first.code, 'LEARNING_ARTICLE_COMPLETED');
  assert.equal(first.completed, true);
  assert.equal(second.code, 'LEARNING_ARTICLE_ALREADY_COMPLETED');
  assert.equal(handler.state.records.length, 1);
  assert.deepEqual({ studentId: handler.state.records[0].studentId, articleId: handler.state.records[0].articleId }, { studentId: 'usr_student_001', articleId: 'art_001' });
});

test('自测：仅下发 enabled single 题，最多十题且绝不包含答案或解析', async () => {
  const questions = Array.from({ length: 11 }, (_, index) => question(index + 1)).concat([question(20, { status: 'disabled' }), question(21, { questionType: 'multiple' })]);
  const handler = makeHandlers({ questions });
  const response = await handler.quiz({});
  assert.equal(response.code, 'QUIZ_LOADED');
  assert.equal(response.questions.length, 10);
  assert.deepEqual(Object.keys(response.questions[0]).sort(), ['options', 'question', 'questionId']);
  assert.equal(JSON.stringify(response).includes('correctOptionIds'), false);
  assert.equal(JSON.stringify(response).includes('explanation'), false);
  assert.deepEqual(handler.state.queries.find((row) => row.collection === 'quiz_questions').query, { status: 'enabled', questionType: 'single' });
});

test('自测：非 student 和带 studentId 的伪造输入均被拒绝', async () => {
  const forbidden = makeHandlers({ users: [student({ role: 'counselor' })], questions: [question()] });
  assert.equal((await forbidden.quiz({})).code, 'FORBIDDEN');
  const handler = makeHandlers({ questions: [question()] });
  assert.equal((await handler.submit({ answers: [{ questionId: 'qst_1', answer: 'B' }], studentId: 'usr_other' })).code, 'INVALID_INPUT');
  assert.equal(handler.state.attempts.length, 0);
});

test('自测：服务端重读题库判分，拒绝非法题目和非法选项，并写入答卷', async () => {
  const handler = makeHandlers({ questions: [question()] });
  assert.equal((await handler.submit({ answers: [{ questionId: 'missing', answer: 'A' }] })).code, 'INVALID_QUESTION');
  assert.equal((await handler.submit({ answers: [{ questionId: 'qst_1', answer: 'Z' }] })).code, 'INVALID_ANSWER');
  const response = await handler.submit({ answers: [{ questionId: 'qst_1', answer: 'A' }] });
  assert.deepEqual({ code: response.code, score: response.score, correctCount: response.correctCount, totalCount: response.totalCount, scorePercent: response.scorePercent }, { code: 'QUIZ_SUBMITTED', score: 0, correctCount: 0, totalCount: 1, scorePercent: 0 });
  assert.deepEqual(response.questions[0], { questionId: 'qst_1', correct: false, correctAnswer: 'B', explanation: '解析 1' });
  assert.equal(handler.state.attempts.length, 1);
  assert.deepEqual(handler.state.attempts[0].answers, [{ questionId: 'qst_1', selectedOptionIds: ['A'], isCorrect: false }]);
  assert.equal(handler.state.attempts[0].studentId, 'usr_student_001');
});
