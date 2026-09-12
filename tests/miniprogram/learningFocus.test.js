'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

global.Page = () => {};

const workbench = require('../../miniprogram/pages/index/index.js').__testables;
const learning = require('../../miniprogram/pages/learning/index/index.js').__testables;
const detail = require('../../miniprogram/pages/learning/detail/index.js').__testables;
const quiz = require('../../miniprogram/pages/quiz/index/index.js').__testables;
const quizResult = require('../../miniprogram/pages/quiz/result/index.js').__testables;
const focus = require('../../miniprogram/pages/counselor/focus/index.js').__testables;

test('学生首页安全学习和安全自测均为真实入口，且不再显示或携带重点关注状态', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8');
  const sessionSource = fs.readFileSync(path.join(__dirname, '../../cloudfunctions/getMiniProgramSession/index.js'), 'utf8');
  const profile = workbench.normalizeProfile({ userId: 'usr_student', role: 'student', name: '学生甲', collegeId: 'college_cs', focusFlag: true });
  assert.match(source, /goToLearning/);
  assert.match(source, /goToQuiz/);
  assert.equal(source.includes('showUnavailable'), false);
  assert.match(wxml, /安全学习/);
  assert.match(wxml, /安全自测/);
  assert.equal(wxml.includes('profile.focusFlag'), false);
  assert.equal(Object.hasOwn(profile, 'focusFlag'), false);
  assert.equal(sessionSource.includes('focusFlag: user.focusFlag'), false);
});

test('学习、自测和重点关注页面已注册，页面模型只使用安全展示字段', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../../miniprogram/app.json'), 'utf8'));
  for (const page of ['pages/learning/index/index', 'pages/learning/detail/index', 'pages/quiz/index/index', 'pages/quiz/result/index', 'pages/counselor/focus/index']) assert.equal(app.pages.includes(page), true, page);
  assert.deepEqual(learning.viewOf({ articleId: 'art_1', title: '标题', summary: '摘要', category: 'knowledge', completed: true }), { articleId: 'art_1', title: '标题', summary: '摘要', categoryText: '防诈知识', publishedAtText: '', completed: true });
  assert.deepEqual(detail.viewOf({ articleId: 'art_1', title: '标题', content: '正文', completed: false }), { articleId: 'art_1', title: '标题', summary: '', content: '正文', completed: false });
  assert.deepEqual(quiz.viewOf({ questionId: 'q_1', question: '题干', options: [{ id: 'A', text: '选项' }], correctOptionIds: ['A'] }), { questionId: 'q_1', question: '题干', number: 1, options: [{ id: 'A', text: '选项' }] });
  assert.equal(JSON.stringify(quiz.viewOf({ questionId: 'q_1', question: '题干', options: [], correctOptionIds: ['A'] })).includes('correctOptionIds'), false);
  assert.deepEqual(focus.studentView({ studentId: 'usr_1', name: '张三', studentNo: '20260001', focusFlag: true, focusReason: '需联系', version: 1 }), { studentId: 'usr_1', name: '张三', studentNo: '20260001', focusFlag: true, focusReason: '需联系', version: 1 });
});

test('自测结果仅在提交后读取存储结果并展示答案解析', () => {
  const result = quizResult.resultOf({ correctCount: 1, totalCount: 2, scorePercent: 50, questions: [{ correct: false, correctAnswer: 'B', explanation: '答案解析' }] });
  assert.deepEqual(result, { correctCount: 1, totalCount: 2, scorePercent: 50, questions: [{ number: 1, correct: false, correctText: '需要复习', correctAnswer: 'B', explanation: '答案解析' }] });
  const quizSource = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/quiz/index/index.js'), 'utf8');
  assert.match(quizSource, /setStorageSync/);
  assert.match(quizSource, /全部题目后再提交/);
});

test('所有小程序 setData 均避免动态 computed 字段写法，辅导员重点关注不是占位入口', () => {
  const root = path.join(__dirname, '../../miniprogram');
  const files = [];
  const collect = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(fullPath);
      else if (entry.name.endsWith('.js')) files.push(fullPath);
    }
  };
  collect(root);
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /setData\s*\(\s*\{\s*\[/, file);
  const home = fs.readFileSync(path.join(root, 'pages/index/index.wxml'), 'utf8');
  assert.match(home, /bindtap="goToCounselorFocus"/);
  assert.equal(home.includes('将在后续完善'), false);
});
