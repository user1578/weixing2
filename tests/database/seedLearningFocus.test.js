'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const seed = require('../../database/seed-learning-focus');

test('学习与自测 seed 使用冻结字段，并包含五篇文章和十道单选题', () => {
  const articles = seed.buildLearningArticles('usr_security_001');
  const questions = seed.buildQuizQuestions();
  assert.equal(articles.length, 5);
  assert.equal(questions.length, 10);
  for (const article of articles) {
    assert.equal(article.publishStatus, 'published');
    assert.equal(article.authorId, 'usr_security_001');
    assert.ok(article.content.length > 80);
    assert.equal(Object.hasOwn(article, 'status'), false);
  }
  for (const question of questions) {
    assert.equal(question.status, 'enabled');
    assert.equal(question.questionType, 'single');
    assert.equal(question.options.length, 4);
    assert.equal(question.correctOptionIds.length, 1);
    assert.equal(Object.hasOwn(question, 'correctAnswer'), false);
  }
});

test('学习与自测 seed 通过固定 _id set 幂等写入，且不会自行连接真实环境', async () => {
  const rows = { learning_articles: new Map(), quiz_questions: new Map() };
  const db = { collection: (name) => ({ doc: (id) => ({ set: async ({ data }) => { rows[name].set(id, structuredClone(data)); return { id }; } }) }) };
  assert.equal(seed.applyLearningFocusSeed.length, 1);
  assert.deepEqual(await seed.applyLearningFocusSeed(db, { authorId: 'usr_security_001' }), { learningArticles: 5, quizQuestions: 10 });
  assert.deepEqual(await seed.applyLearningFocusSeed(db, { authorId: 'usr_security_001' }), { learningArticles: 5, quizQuestions: 10 });
  assert.equal(rows.learning_articles.size, 5);
  assert.equal(rows.quiz_questions.size, 10);
});
