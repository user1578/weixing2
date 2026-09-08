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
  INVALID_INPUT: "预警信息无效",
  NOT_FOUND: "未找到该预警或暂无查看权限",
  UNBOUND: "请先完成身份绑定后再查看预警",
  FORBIDDEN: "当前身份无权查看该预警",
  ACCOUNT_DISABLED: "账号当前不可用",
  INTERNAL_ERROR: "预警详情加载失败，请稍后重试",
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
    fraudTypeText: textFor(FRAUD_TYPE_LABELS, alert.fraudType, "未知诈骗类型"),
    riskLevelText: textFor(RISK_LEVEL_LABELS, alert.riskLevel, "未知风险"),
    riskClass: knownClass("risk", alert.riskLevel, RISK_LEVEL_LABELS),
    statusText: textFor(ALERT_STATUS_LABELS, alert.status, "未知状态"),
    statusClass: knownClass("status", alert.status, ALERT_STATUS_LABELS),
    content: typeof alert.content === "string" && alert.content.trim() ? alert.content.trim() : "暂无预警内容",
    issuedAtText: formatDateTime(alert.issuedAt),
  };
}

function messageFor(code) {
  return ERROR_MESSAGES[code] || "预警详情加载失败，请稍后重试";
}

Page({
  data: {
    alert: null,
    loading: false,
    errorMessage: "",
  },

  onLoad(options = {}) {
    this.alertId = typeof options.alertId === "string" ? options.alertId : "";
    this.loadAlert();
  },

  async loadAlert() {
    if (this.data.loading) return;
    if (!this.alertId) {
      this.setData({ alert: null, errorMessage: messageFor("INVALID_INPUT") });
      return;
    }

    this.setData({ loading: true, alert: null, errorMessage: "" });
    try {
      const response = await wx.cloud.callFunction({ name: "getStudentAlertDetail", data: { alertId: this.alertId } });
      const result = response.result || {};
      const code = result.code || "INTERNAL_ERROR";
      if (!result.ok || !result.alert) {
        this.setData({ alert: null, errorMessage: messageFor(code) });
        return;
      }

      this.setData({ alert: toAlertView(result.alert) });
    } catch (error) {
      this.setData({ alert: null, errorMessage: messageFor("INTERNAL_ERROR") });
    } finally {
      this.setData({ loading: false });
    }
  },
});
