function viewOf(article = {}) {
  return { articleId: typeof article.articleId === "string" ? article.articleId : "", title: typeof article.title === "string" ? article.title : "", summary: typeof article.summary === "string" ? article.summary : "", content: typeof article.content === "string" ? article.content : "", completed: article.completed === true };
}
function errorText(code) { return ({ NOT_FOUND: "文章不存在或暂不可查看。", UNBOUND: "请先完成学生身份绑定。", FORBIDDEN: "当前身份无权查看安全学习内容。" })[code] || "文章加载失败，请稍后重试。"; }

const pageDefinition = {
  data: { articleId: "", article: null, loading: false, completing: false, errorMessage: "" },
  onLoad(options = {}) { const articleId = typeof options.articleId === "string" ? options.articleId.trim() : ""; this.setData({ articleId, errorMessage: articleId ? "" : "文章参数无效。" }); if (articleId) this.loadArticle(); },
  async loadArticle() {
    if (!this.data.articleId || this.data.loading) return;
    this.setData({ loading: true, errorMessage: "" });
    try {
      const response = await wx.cloud.callFunction({ name: "getLearningArticleDetail", data: { articleId: this.data.articleId } });
      const result = response.result || {};
      if (!result.ok) { this.setData({ article: null, errorMessage: errorText(result.code) }); return; }
      const article = viewOf(result.article);
      if (!article.articleId || !article.title || !article.content) { this.setData({ article: null, errorMessage: "文章内容暂不可用。" }); return; }
      this.setData({ article, errorMessage: "" });
    } catch (error) { this.setData({ article: null, errorMessage: "文章加载失败，请稍后重试。" }); }
    finally { this.setData({ loading: false }); }
  },
  async completeArticle() {
    if (!this.data.article || this.data.article.completed || this.data.completing) return;
    this.setData({ completing: true });
    try {
      const response = await wx.cloud.callFunction({ name: "completeLearningArticle", data: { articleId: this.data.article.articleId } });
      const result = response.result || {};
      if (!result.ok) { wx.showToast({ title: errorText(result.code), icon: "none" }); return; }
      const article = { ...this.data.article, completed: true };
      this.setData({ article });
      wx.showToast({ title: "已完成学习", icon: "success" });
    } catch (error) { wx.showToast({ title: "操作失败，请稍后重试", icon: "none" }); }
    finally { this.setData({ completing: false }); }
  },
};

Page(pageDefinition);
if (typeof module !== "undefined") module.exports = { __testables: { errorText, pageDefinition, viewOf } };
