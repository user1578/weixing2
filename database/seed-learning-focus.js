'use strict';

// This module intentionally does not initialize CloudBase or execute on import.
// WorkBuddy must pass a reviewed CloudBase db instance and an existing security user ID.

const ARTICLE_SEEDS = Object.freeze([
  {
    _id: 'art_seed_rebate_001', title: '刷单返利诈骗识别', category: 'knowledge', fraudTags: ['part_time_scam'],
    summary: '凡是要求先垫资、完成任务后返利的兼职，都要高度警惕。',
    content: '刷单返利诈骗通常以“在家兼职、轻松赚钱”为诱饵。对方先让受害者完成小额任务并返还少量佣金，再以任务升级、账户冻结或操作失误为由，要求持续转账垫资。\n\n请记住：正规平台不会要求你先交钱再领取报酬。看到群聊晒单、陌生链接或客服催促时，不点击、不转账，并保留聊天记录向学校或警方核实。',
  },
  {
    _id: 'art_seed_public_001', title: '冒充公检法诈骗防范', category: 'case', fraudTags: ['impersonate_public'],
    summary: '公检法机关不会通过电话或网络要求转账，更不会索要验证码。',
    content: '骗子会冒充公安、检察院或法院工作人员，声称你涉嫌洗钱、违法或账户异常，并展示伪造的证件和通缉令。他们常用“保密办案”“安全账户”等说法制造恐慌，催促你立即转账。\n\n遇到这类电话，应先挂断，再通过官方公开号码或线下窗口独立核验。不要相信来电显示，不要把身份证照片、银行卡信息、验证码或屏幕共享权限交给陌生人。',
  },
  {
    _id: 'art_seed_loan_001', title: '虚假贷款常见套路', category: 'knowledge', fraudTags: ['fake_loan'],
    summary: '放款前以手续费、解冻费等名义收费的贷款，大多是诈骗。',
    content: '虚假贷款广告常承诺“低门槛、秒到账、无抵押”。申请后，对方会以征信不足、银行卡填写错误或需要会员认证为由，要求缴纳保证金、手续费或解冻费。转账后，对方还会继续编造新理由索款。\n\n有资金需求时，应选择正规金融机构的官方渠道。任何贷款在到账前要求个人转账、购买虚拟币或提供验证码的情况，都应立即停止并核验。',
  },
  {
    _id: 'art_seed_refund_001', title: '冒充客服退款诈骗', category: 'case', fraudTags: ['fake_refund'],
    summary: '退款应在原订单平台完成，陌生客服发来的链接和屏幕共享邀请不要接受。',
    content: '骗子会以商品质量问题、快递丢失或会员扣费为由，自称平台客服并承诺双倍退款。他们随后诱导受害者点击钓鱼链接、下载会议软件或开启屏幕共享，从而窃取支付密码和验证码。\n\n处理退款时，只在原购物平台的订单页面操作，并通过平台官方客服渠道确认。不要向任何人提供验证码，也不要因“指导退款”而开启屏幕共享。',
  },
  {
    _id: 'art_seed_account_001', title: '校园账号与个人信息安全', category: 'knowledge', fraudTags: ['other'],
    summary: '账号、密码和验证码是个人安全边界，不能借给他人或在陌生页面填写。',
    content: '校园账号可能关联课程、缴费、身份认证等重要信息。弱密码、多个平台共用密码，或把验证码发给陌生人，都会扩大账号被盗和信息泄露的风险。\n\n建议为重要账号设置独立且较长的密码，开启平台提供的二次验证，不在公共设备保存登录状态。收到“账号异常”通知时，直接从官方应用进入核验，不点击短信或聊天中的陌生链接。',
  },
]);

const QUESTION_SEEDS = Object.freeze([
  { _id: 'qst_seed_001', fraudTags: ['part_time_scam'], stem: '陌生人邀请你做“先垫资、后返利”的刷单任务，最安全的做法是？', options: [['A', '先小额试一试'], ['B', '拒绝参与并核验信息'], ['C', '借钱完成高佣金任务'], ['D', '把验证码告诉对方']], correct: 'B', explanation: '正规兼职不会要求先垫资，先转账再返利是典型风险信号。' },
  { _id: 'qst_seed_002', fraudTags: ['part_time_scam'], stem: '刷单群中有人晒出到账截图，应该如何判断？', options: [['A', '立即跟投'], ['B', '认为群友一定真实'], ['C', '警惕截图和群聊可能由骗子操控'], ['D', '把银行卡交给群主']], correct: 'C', explanation: '诈骗团伙可伪造到账截图和群聊气氛，不能据此判断安全。' },
  { _id: 'qst_seed_003', fraudTags: ['impersonate_public'], stem: '“警方”来电称你涉嫌犯罪，要求转入安全账户，正确做法是？', options: [['A', '立即按要求转账'], ['B', '保持通话并共享屏幕'], ['C', '挂断后通过官方渠道独立核实'], ['D', '提供银行卡验证码']], correct: 'C', explanation: '公检法机关不会电话要求转账到所谓安全账户。' },
  { _id: 'qst_seed_004', fraudTags: ['impersonate_public'], stem: '接到自称公检法人员的电话时，以下哪项绝不能提供？', options: [['A', '公开办事窗口地址'], ['B', '短信验证码'], ['C', '官方热线号码'], ['D', '学校值班电话']], correct: 'B', explanation: '验证码可用于登录或支付验证，任何机构都不会电话索要。' },
  { _id: 'qst_seed_005', fraudTags: ['fake_loan'], stem: '贷款平台要求先支付“解冻费”才能放款，应当？', options: [['A', '立刻支付'], ['B', '分期支付'], ['C', '停止操作并通过正规渠道核验'], ['D', '向朋友借钱支付']], correct: 'C', explanation: '放款前收取解冻费、保证金等费用是虚假贷款常见套路。' },
  { _id: 'qst_seed_006', fraudTags: ['fake_loan'], stem: '有贷款需求时，优先应从哪里办理？', options: [['A', '陌生短信链接'], ['B', '正规金融机构官方渠道'], ['C', '社交群里的客服'], ['D', '来历不明的应用安装包']], correct: 'B', explanation: '官方渠道可降低钓鱼和虚假贷款风险。' },
  { _id: 'qst_seed_007', fraudTags: ['fake_refund'], stem: '陌生客服称可退款并要求开启屏幕共享，应该？', options: [['A', '开启共享方便操作'], ['B', '只共享支付页面'], ['C', '拒绝共享并从原订单平台核验'], ['D', '先告知支付密码']], correct: 'C', explanation: '屏幕共享可能泄露密码和验证码，退款应在原订单平台完成。' },
  { _id: 'qst_seed_008', fraudTags: ['fake_refund'], stem: '收到退款链接后，最安全的处理方式是？', options: [['A', '直接点击填写信息'], ['B', '转发给同学一起填写'], ['C', '只在原平台订单页发起退款'], ['D', '下载客服指定软件']], correct: 'C', explanation: '陌生退款链接可能是钓鱼页面，应从原平台独立进入。' },
  { _id: 'qst_seed_009', fraudTags: ['other'], stem: '下列哪项最能保护校园账号安全？', options: [['A', '多个平台共用简单密码'], ['B', '把验证码发给室友'], ['C', '设置独立强密码并开启二次验证'], ['D', '在公共电脑保存密码']], correct: 'C', explanation: '独立强密码和二次验证能显著降低账号被盗风险。' },
  { _id: 'qst_seed_010', fraudTags: ['other'], stem: '收到“校园账号异常”的短信链接时，应该？', options: [['A', '立刻点击登录'], ['B', '从官方应用或学校门户独立核验'], ['C', '把账号密码回复短信'], ['D', '把链接发到群里求助']], correct: 'B', explanation: '应避开短信中的陌生链接，直接从官方入口核验账号状态。' },
]);

function asOptions(options) { return options.map(([id, text]) => ({ id, text })); }

function buildLearningArticles(authorId) {
  if (typeof authorId !== 'string' || !authorId.trim()) throw new Error('A reviewed security authorId is required');
  return ARTICLE_SEEDS.map((article, index) => ({ ...article, authorId: authorId.trim(), publishStatus: 'published', publishedAt: new Date(Date.UTC(2026, 8, 1 + index, 8, 0, 0)), version: 1, createdAt: new Date(Date.UTC(2026, 8, 1 + index, 8, 0, 0)), updatedAt: new Date(Date.UTC(2026, 8, 1 + index, 8, 0, 0)) }));
}

function buildQuizQuestions() {
  return QUESTION_SEEDS.map((question, index) => ({ _id: question._id, questionType: 'single', stem: question.stem, options: asOptions(question.options), correctOptionIds: [question.correct], explanation: question.explanation, fraudTags: question.fraudTags, status: 'enabled', version: 1, createdAt: new Date(Date.UTC(2026, 8, 10, 8, index, 0)), updatedAt: new Date(Date.UTC(2026, 8, 10, 8, index, 0)) }));
}

async function applyLearningFocusSeed(db, { authorId } = {}) {
  if (!db || typeof db.collection !== 'function') throw new Error('A CloudBase db instance is required');
  const articles = buildLearningArticles(authorId);
  const questions = buildQuizQuestions();
  for (const article of articles) await db.collection('learning_articles').doc(article._id).set({ data: article });
  for (const question of questions) await db.collection('quiz_questions').doc(question._id).set({ data: question });
  return { learningArticles: articles.length, quizQuestions: questions.length };
}

module.exports = { ARTICLE_SEEDS, QUESTION_SEEDS, applyLearningFocusSeed, asOptions, buildLearningArticles, buildQuizQuestions };
