const CATEGORY_LABELS = Object.freeze({ case: "案例警示", knowledge: "防诈知识" });

function dateText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function viewOf(article = {}) {
  return {
    articleId: typeof article.articleId === "string" ? article.articleId : "",
    title: typeof article.title === "string" ? article.title : "",
    summary: typeof article.summary === "string" ? article.summary : "",
    categoryText: CATEGORY_LABELS[article.category] || "安全知识",
    publishedAtText: dateText(article.publishedAt),
    completed: article.completed === true,
  };
}

function errorText(code) {
  return ({ UNBOUND: "请先完成学生身份绑定。", FORBIDDEN: "当前身份无权查看安全学习内容。", ACCOUNT_DISABLED: "当前账号不可用。" })[code] || "学习内容加载失败，请稍后重试。";
}

const pageDefinition = {
  data: { articles: [], loading: false, loaded: false, errorMessage: "" },
  onShow() { this.loadArticles(); },
  onPullDownRefresh() { this.loadArticles(true); },
  async loadArticles(fromPullDown = false) {
    if (this.data.loading) { if (fromPullDown) wx.stopPullDownRefresh(); return; }
    this.setData({ loading: true, loaded: false, errorMessage: "" });
    try {
      const response = await wx.cloud.callFunction({ name: "getLearningArticles", data: {} });
      const result = response.result || {};
      if (!result.ok) { this.setData({ articles: [], loaded: true, errorMessage: errorText(result.code) }); return; }
      this.setData({ articles: (Array.isArray(result.articles) ? result.articles : []).map(viewOf).filter((article) => article.articleId && article.title), loaded: true });
    } catch (error) {
      this.setData({ articles: [], loaded: true, errorMessage: "学习内容加载失败，请稍后重试。" });
    } finally {
      this.setData({ loading: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },
  openDetail(event) {
    const articleId = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.articleId : "";
    if (typeof articleId === "string" && articleId) wx.navigateTo({ url: `/pages/learning/detail/index?articleId=${encodeURIComponent(articleId)}` });
  },
};

Page(pageDefinition);
if (typeof module !== "undefined") module.exports = { __testables: { CATEGORY_LABELS, dateText, errorText, pageDefinition, viewOf } };
