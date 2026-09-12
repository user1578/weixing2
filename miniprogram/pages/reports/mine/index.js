const FRAUD_TYPES = Object.freeze({ part_time_scam: "刷单返利诈骗", impersonate_public: "冒充公检法诈骗", fake_loan: "虚假贷款诈骗", fake_refund: "冒充客服退款", other: "其他诈骗" });
const RISKS = Object.freeze({ low: "低风险", medium: "中风险", high: "高风险" });
const STATUSES = Object.freeze({ pending_counselor_verify: "待辅导员核验", pending_security_verify: "待保卫处核验", in_process: "处理中", closed: "已结案" });

function dateText(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; }
function viewOf(report = {}) { return { reportId: typeof report.reportId === "string" ? report.reportId : "", fraudTypeText: FRAUD_TYPES[report.fraudType] || "未知诈骗类型", riskText: RISKS[report.riskLevel] || "风险待评估", statusText: STATUSES[report.status] || "状态待更新", submittedAtText: dateText(report.submittedAt), hasLossText: report.hasLoss ? "存在损失" : "暂无损失" }; }
function errorText(code) { return ({ UNBOUND: "请先完成学生身份绑定。", FORBIDDEN: "当前身份无权查看学生工单。", ACCOUNT_DISABLED: "当前账号不可用。" })[code] || "工单加载失败，请稍后重试。"; }

const pageDefinition = {
  data: { reports: [], loading: false, loaded: false, errorMessage: "" },
  onShow() { this.loadReports(); },
  onPullDownRefresh() { this.loadReports(true); },
  async loadReports(fromPullDown = false) {
    if (this.data.loading) { if (fromPullDown) wx.stopPullDownRefresh(); return; }
    this.setData({ loading: true, loaded: false, errorMessage: "" });
    try {
      const response = await wx.cloud.callFunction({ name: "getStudentReports", data: {} });
      const result = response.result || {};
      if (!result.ok) { this.setData({ reports: [], loaded: true, errorMessage: errorText(result.code) }); return; }
      this.setData({ reports: (Array.isArray(result.reports) ? result.reports : []).map(viewOf).filter((item) => item.reportId), loaded: true });
    } catch (error) { this.setData({ reports: [], loaded: true, errorMessage: "工单加载失败，请稍后重试。" }); }
    finally { this.setData({ loading: false }); if (fromPullDown) wx.stopPullDownRefresh(); }
  },
  openDetail(event) {
    const reportId = event.currentTarget.dataset.reportId;
    if (typeof reportId === "string" && reportId) wx.navigateTo({ url: `/pages/reports/detail/index?reportId=${encodeURIComponent(reportId)}` });
  },
};
Page(pageDefinition);
if (typeof module !== "undefined") module.exports = { __testables: { STATUSES, dateText, errorText, pageDefinition, viewOf } };
