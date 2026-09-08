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

const ALERT_STATUS_LABELS = Object.freeze({
  pending_dispatch: "待下发",
  sent: "已下发",
  viewed: "已查看",
  following_up: "跟进中",
  closed: "已关闭",
});

const ERROR_MESSAGES = Object.freeze({
  UNBOUND: "请先完成身份绑定后再查看预警",
  FORBIDDEN: "当前身份无权查看预警",
  ACCOUNT_DISABLED: "账号当前不可用",
  INTERNAL_ERROR: "预警加载失败，请稍后重试",
});

function textFor(labels, value, fallback) {
  return labels[value] || fallback;
}

function dateFrom(value) {
  if (value && typeof value.toDate === "function") return value.toDate();
  if (value && typeof value === "object" && value.$date) return new Date(value.$date);
  return new Date(value);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDateTime(value) {
  if (!value) return "暂无时间";
  const date = dateFrom(value);
  if (Number.isNaN(date.getTime())) return "暂无时间";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function knownClass(prefix, value, labels) {
  return labels[value] ? `${prefix}-${value}` : `${prefix}-unknown`;
}

function toAlertView(alert = {}) {
  return {
    alertId: typeof alert.alertId === "string" ? alert.alertId : "",
    fraudTypeText: textFor(FRAUD_TYPE_LABELS, alert.fraudType, "未知诈骗类型"),
    riskLevelText: textFor(RISK_LEVEL_LABELS, alert.riskLevel, "未知风险"),
    riskClass: knownClass("risk", alert.riskLevel, RISK_LEVEL_LABELS),
    statusText: textFor(ALERT_STATUS_LABELS, alert.status, "未知状态"),
    statusClass: knownClass("status", alert.status, ALERT_STATUS_LABELS),
    contentSummary: typeof alert.contentSummary === "string" && alert.contentSummary.trim() ? alert.contentSummary.trim() : "暂无预警摘要",
    issuedAtText: formatDateTime(alert.issuedAt),
  };
}

function messageFor(code) {
  return ERROR_MESSAGES[code] || "预警加载失败，请稍后重试";
}

Page({
  data: {
    alerts: [],
    loading: false,
    loaded: false,
    errorMessage: "",
  },

  onShow() {
    this.loadAlerts();
  },

  onPullDownRefresh() {
    this.loadAlerts(true);
  },

  async loadAlerts(fromPullDown = false) {
    if (this.data.loading) {
      if (fromPullDown) wx.stopPullDownRefresh();
      return;
    }

    this.setData({ loading: true, loaded: false, errorMessage: "" });
    try {
      const response = await wx.cloud.callFunction({ name: "getStudentAlerts", data: {} });
      const result = response.result || {};
      const code = result.code || "INTERNAL_ERROR";
      if (!result.ok) {
        this.setData({ alerts: [], loaded: true, errorMessage: messageFor(code) });
        return;
      }

      const alerts = (Array.isArray(result.alerts) ? result.alerts : [])
        .map((alert) => toAlertView(alert))
        .filter((alert) => alert.alertId);
      this.setData({ alerts, loaded: true });
    } catch (error) {
      this.setData({ alerts: [], loaded: true, errorMessage: messageFor("INTERNAL_ERROR") });
    } finally {
      this.setData({ loading: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },

  openAlert(event) {
    const alertId = event.currentTarget.dataset.alertId;
    if (typeof alertId !== "string" || !alertId) return;
    wx.navigateTo({ url: `/pages/alerts/detail/index?alertId=${encodeURIComponent(alertId)}` });
  },
});
