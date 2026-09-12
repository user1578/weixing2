const QUIZ_RESULT_STORAGE_KEY = "campusAntiFraudQuizResult";

function viewOf(question = {}, index = 0) {
  const options = Array.isArray(question.options) ? question.options.filter((option) => option && typeof option.id === "string" && typeof option.text === "string").map((option) => ({ id: option.id, text: option.text })) : [];
  return { questionId: typeof question.questionId === "string" ? question.questionId : "", question: typeof question.question === "string" ? question.question : "", number: index + 1, options };
}
function errorText(code) { return ({ UNBOUND: "请先完成学生身份绑定。", FORBIDDEN: "当前身份无权进行安全自测。", ACCOUNT_DISABLED: "当前账号不可用。" })[code] || "题目加载失败，请稍后重试。"; }

const pageDefinition = {
  data: { questions: [], answers: {}, loading: false, submitting: false, loaded: false, errorMessage: "" },
  onShow() { if (!this.data.questions.length && !this.data.loading) this.loadQuiz(); },
  async loadQuiz() {
    this.setData({ loading: true, loaded: false, errorMessage: "", answers: {} });
    try {
      const response = await wx.cloud.callFunction({ name: "getQuiz", data: {} });
      const result = response.result || {};
      if (!result.ok) { this.setData({ questions: [], loaded: true, errorMessage: errorText(result.code) }); return; }
      const questions = (Array.isArray(result.questions) ? result.questions : []).map(viewOf).filter((question) => question.questionId && question.question && question.options.length >= 2);
      this.setData({ questions, loaded: true, errorMessage: questions.length ? "" : "暂时没有可用的自测题。" });
    } catch (error) { this.setData({ questions: [], loaded: true, errorMessage: "题目加载失败，请稍后重试。" }); }
    finally { this.setData({ loading: false }); }
  },
  selectAnswer(event) {
    const questionId = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.questionId : "";
    const answer = event && event.detail ? event.detail.value : "";
    if (typeof questionId !== "string" || !questionId || typeof answer !== "string" || !answer) return;
    const answers = Object.assign({}, this.data.answers);
    answers[questionId] = answer;
    this.setData({ answers });
  },
  async submitQuiz() {
    if (this.data.submitting || !this.data.questions.length) return;
    const allAnswered = this.data.questions.every((question) => typeof this.data.answers[question.questionId] === "string" && this.data.answers[question.questionId]);
    if (!allAnswered) { wx.showToast({ title: "请完成全部题目后再提交", icon: "none" }); return; }
    const answers = this.data.questions.map((question) => ({ questionId: question.questionId, answer: this.data.answers[question.questionId] }));
    this.setData({ submitting: true });
    try {
      const response = await wx.cloud.callFunction({ name: "submitQuiz", data: { answers } });
      const result = response.result || {};
      if (!result.ok) { wx.showToast({ title: errorText(result.code), icon: "none" }); return; }
      wx.setStorageSync(QUIZ_RESULT_STORAGE_KEY, result);
      wx.redirectTo({ url: "/pages/quiz/result/index" });
    } catch (error) { wx.showToast({ title: "提交失败，请稍后重试", icon: "none" }); }
    finally { this.setData({ submitting: false }); }
  },
};

Page(pageDefinition);
if (typeof module !== "undefined") module.exports = { __testables: { QUIZ_RESULT_STORAGE_KEY, errorText, pageDefinition, viewOf } };
