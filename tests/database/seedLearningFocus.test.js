'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const seed = require('../../database/seed-learning-focus');

test('学习 seed 使用冻结字段，并包含五篇文章', () => {
  const articles = seed.buildLearningArticles('usr_security_001');
  assert.equal(articles.length, 5);
  for (const article of articles) {
    assert.equal(article.publishStatus, 'published');
    assert.equal(['knowledge', 'case'].includes(article.category), true);
    assert.equal(article.authorId, 'usr_security_001');
    assert.ok(article.content.length > 80);
    assert.match(article._id, /^art_seed_/);
    assert.equal(Object.hasOwn(article, 'status'), false);
  }
});

test('学习 seed 通过固定 _id set 幂等写入，且不会自行连接真实环境', async () => {
  const rows = { learning_articles: new Map() };
  const db = { collection: (name) => ({ doc: (id) => ({ set: async ({ data }) => { rows[name].set(id, structuredClone(data)); return { id }; } }) }) };
  assert.equal(seed.applyLearningFocusSeed.length, 1);
  assert.deepEqual(await seed.applyLearningFocusSeed(db, { authorId: 'usr_security_001' }), { learningArticles: 5 });
  assert.deepEqual(await seed.applyLearningFocusSeed(db, { authorId: 'usr_security_001' }), { learningArticles: 5 });
  assert.equal(rows.learning_articles.size, 5);
});
