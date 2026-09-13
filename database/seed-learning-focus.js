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

function buildLearningArticles(authorId) {
  if (typeof authorId !== 'string' || !authorId.trim()) throw new Error('A reviewed security authorId is required');
  return ARTICLE_SEEDS.map((article, index) => ({ ...article, authorId: authorId.trim(), publishStatus: 'published', publishedAt: new Date(Date.UTC(2026, 8, 1 + index, 8, 0, 0)), version: 1, createdAt: new Date(Date.UTC(2026, 8, 1 + index, 8, 0, 0)), updatedAt: new Date(Date.UTC(2026, 8, 1 + index, 8, 0, 0)) }));
}

async function applyLearningFocusSeed(db, { authorId } = {}) {
  if (!db || typeof db.collection !== 'function') throw new Error('A CloudBase db instance is required');
  const articles = buildLearningArticles(authorId);
  for (const article of articles) await db.collection('learning_articles').doc(article._id).set({ data: article });
  return { learningArticles: articles.length };
}

module.exports = { ARTICLE_SEEDS, applyLearningFocusSeed, buildLearningArticles };
