const FRAUD_TYPE_LABELS = Object.freeze({
  part_time_scam: "刷单返利诈骗",
  impersonate_public: "冒充公检法诈骗",
  fake_loan: "虚假贷款诈骗",
  fake_refund: "冒充客服退款",
  other: "其他诈骗",
});

const RISK_LEVEL_LABELS = Object.freeze({
  low: "低风险",
  medium: "中风险",
  high: "高风险",
});

const COUNSELOR_STATUS_LABELS = Object.freeze({
  pending_counselor_verify: "待核验",
  pending_security_verify: "已转保卫处",
  in_process: "跟进中",
  closed: "已完成",
});

const ERROR_MESSAGES = Object.freeze({
  UNBOUND: "请先完成辅导员身份绑定。",
  FORBIDDEN: "当前身份无权查看辅导员工单。",
  ACCOUNT_DISABLED: "当前账号不可用。",
  INTERNAL_ERROR: "工单加载失败，请稍后重试。",
});

function textFor(labels, value, fallback) {
  return labels[value] || fallback;
}

function toReportView(report = {}) {
  return {
    reportId: typeof report.reportId === "string" ? report.reportId : "",
    fraudTypeText: textFor(FRAUD_TYPE_LABELS, report.fraudType, "未知诈骗类型"),
    riskText: textFor(RISK_LEVEL_LABELS, report.riskLevel, "风险待评估"),
    riskClass: RISK_LEVEL_LABELS[report.riskLevel] ? `risk-${report.riskLevel}` : "risk-unknown",
    statusText: textFor(COUNSELOR_STATUS_LABELS, report.status, "状态待更新"),
  };
}

function messageFor(code) {
  return ERROR_MESSAGES[code] || ERROR_MESSAGES.INTERNAL_ERROR;
}

const pageDefinition = {
  data: {
    reports: [],
    loading: false,
    loaded: false,
    errorMessage: "",
  },

  onShow() {
    this.loadReports();
  },

  onPullDownRefresh() {
    this.loadReports(true);
  },

  async loadReports(fromPullDown = false) {
    if (this.data.loading) {
      if (fromPullDown) wx.stopPullDownRefresh();
      return;
    }
    this.setData({ loading: true, loaded: false, errorMessage: "" });
    try {
      const response = await wx.cloud.callFunction({ name: "getCounselorReports", data: {} });
      const result = response.result || {};
      const code = result.code || "INTERNAL_ERROR";
      if (!result.ok) {
        this.setData({ reports: [], loaded: true, errorMessage: messageFor(code) });
        return;
      }
      const reports = (Array.isArray(result.reports) ? result.reports : [])
        .map(toReportView)
        .filter((report) => report.reportId);
      this.setData({ reports, loaded: true });
    } catch (error) {
      this.setData({ reports: [], loaded: true, errorMessage: ERROR_MESSAGES.INTERNAL_ERROR });
    } finally {
      this.setData({ loading: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },
};

Page(pageDefinition);

if (typeof module !== "undefined") {
  module.exports = { __testables: { messageFor, pageDefinition, toReportView } };
}
