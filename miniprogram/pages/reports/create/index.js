const FRAUD_TYPES = Object.freeze([
  { value: "part_time_scam", label: "刷单返利诈骗" },
  { value: "impersonate_public", label: "冒充公检法诈骗" },
  { value: "fake_loan", label: "虚假贷款诈骗" },
  { value: "fake_refund", label: "冒充客服退款" },
  { value: "other", label: "其他诈骗" },
]);

const FRAUD_TYPE_LABELS = Object.freeze(Object.fromEntries(FRAUD_TYPES.map((item) => [item.value, item.label])));
const RISK_LEVEL_LABELS = Object.freeze({ low: "低风险", medium: "中风险", high: "高风险" });
const ERROR_MESSAGES = Object.freeze({
  INVALID_INPUT: "请检查填写内容是否完整正确",
  UNBOUND: "请先完成身份绑定",
  FORBIDDEN: "当前身份无权提交学生上报",
  ACCOUNT_DISABLED: "当前账号不可用",
  NOT_FOUND: "关联预警不存在或当前不可关联",
  CONFLICT: "该预警可能已经提交过上报，或数据已发生变化",
  INTERNAL_ERROR: "上报提交失败，请稍后重试",
});
const OPTIONAL_LIMITS = Object.freeze({ suspiciousPlatform: 100, suspiciousAccount: 300, contactPhone: 32, studentRemark: 500 });

function pad(value) {
  return String(value).padStart(2, "0");
}

function localDateParts(date = new Date()) {
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

function trimOptional(value, maximumLength) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= maximumLength ? normalized : null;
}

function parseAmount(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!normalized || !/^(?:\d+|\d*\.\d+)$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function buildIncidentIso(dateValue, timeValue) {
  if (typeof dateValue !== "string" || typeof timeValue !== "string") return null;
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!dateMatch || !timeMatch) return null;
  const [year, month, day, hour, minute] = [...dateMatch.slice(1), ...timeMatch.slice(1)].map(Number);
  const localDate = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (localDate.getFullYear() !== year || localDate.getMonth() !== month - 1 || localDate.getDate() !== day || localDate.getHours() !== hour || localDate.getMinutes() !== minute) return null;
  return localDate.toISOString();
}

function buildSubmitData(form = {}, sourceAlertId) {
  if (!FRAUD_TYPE_LABELS[form.fraudType] || typeof form.hasLoss !== "boolean" || typeof form.stillContacting !== "boolean") return null;
  const incidentAt = buildIncidentIso(form.incidentDate, form.incidentTime);
  const involvedAmount = parseAmount(form.involvedAmount);
  if (!incidentAt || involvedAmount === null || typeof form.incidentNarrative !== "string") return null;
  const incidentNarrative = form.incidentNarrative.trim();
  if (!incidentNarrative || incidentNarrative.length > 2000) return null;
  const data = { fraudType: form.fraudType, incidentAt, involvedAmount, hasLoss: form.hasLoss, incidentNarrative, stillContacting: form.stillContacting };
  if (typeof sourceAlertId === "string" && sourceAlertId.trim()) data.sourceAlertId = sourceAlertId.trim();
  for (const [field, maximumLength] of Object.entries(OPTIONAL_LIMITS)) {
    const value = trimOptional(form[field], maximumLength);
    if (value === null) return null;
    if (value !== undefined) data[field] = value;
  }
  return data;
}

function dateFrom(value) {
  if (value && typeof value.toDate === "function") return value.toDate();
  if (value && typeof value === "object" && value.$date) return new Date(value.$date);
  return new Date(value);
}

function formatDateTime(value) {
  const date = dateFrom(value);
  if (Number.isNaN(date.getTime())) return "暂无时间";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function mapReportResult(result = {}) {
  if (!result.ok || result.code !== "REPORT_SUBMITTED" || !result.report || typeof result.report.reportId !== "string") return null;
  const report = result.report;
  return {
    reportId: report.reportId,
    fraudTypeText: FRAUD_TYPE_LABELS[report.fraudType] || "未知诈骗类型",
    riskLevelText: RISK_LEVEL_LABELS[report.riskLevel] || "未知风险",
    riskClass: RISK_LEVEL_LABELS[report.riskLevel] ? `risk-${report.riskLevel}` : "risk-unknown",
    statusText: "待辅导员核实",
    submittedAtText: formatDateTime(report.submittedAt),
  };
}

function messageFor(code) {
  return ERROR_MESSAGES[code] || "上报提交失败，请稍后重试";
}

const defaultDateTime = localDateParts();
const pageDefinition = {
  data: {
    fraudTypes: FRAUD_TYPES,
    fraudTypeIndex: 0,
    fraudType: FRAUD_TYPES[0].value,
    incidentDate: defaultDateTime.date,
    incidentTime: defaultDateTime.time,
    involvedAmount: "",
    hasLoss: false,
    incidentNarrative: "",
    suspiciousPlatform: "",
    suspiciousAccount: "",
    stillContacting: false,
    contactPhone: "",
    studentRemark: "",
    sourceAlertId: "",
    submitting: false,
    submitted: false,
    errorMessage: "",
    report: null,
  },

  onLoad(options = {}) {
    const sourceAlertId = typeof options.sourceAlertId === "string" ? options.sourceAlertId.trim() : "";
    this.setData({ sourceAlertId });
  },

  onFraudTypeChange(event) {
    const fraudTypeIndex = Number(event.detail.value);
    const fraudType = FRAUD_TYPES[fraudTypeIndex] ? FRAUD_TYPES[fraudTypeIndex].value : FRAUD_TYPES[0].value;
    this.setData({ fraudTypeIndex, fraudType });
  },

  onFieldInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!Object.prototype.hasOwnProperty.call(this.data, field)) return;
    this.setData({ [field]: event.detail.value });
  },

  onHasLossChange(event) {
    this.setData({ hasLoss: event.detail.value === true });
  },

  onStillContactingChange(event) {
    this.setData({ stillContacting: event.detail.value === true });
  },

  async submitReport() {
    if (this.data.submitting || this.data.submitted) return;
    const data = buildSubmitData(this.data, this.data.sourceAlertId);
    if (!data) {
      this.setData({ errorMessage: messageFor("INVALID_INPUT") });
      return;
    }
    this.setData({ submitting: true, errorMessage: "" });
    try {
      const response = await wx.cloud.callFunction({ name: "createStudentReport", data });
      const result = response.result || {};
      const report = mapReportResult(result);
      if (!report) {
        this.setData({ errorMessage: messageFor(result.code || "INTERNAL_ERROR") });
        return;
      }
      this.setData({ submitted: true, report, errorMessage: "" });
    } catch (error) {
      this.setData({ errorMessage: "网络或服务异常，请稍后重试" });
    } finally {
      this.setData({ submitting: false });
    }
  },

  returnHome() {
    wx.reLaunch({ url: "/pages/index/index" });
  },

  returnToAlert() {
    if (!this.data.sourceAlertId) return;
    wx.navigateBack({ delta: 1, fail: () => wx.reLaunch({ url: "/pages/alerts/index/index" }) });
  },
};

if (typeof Page === "function") Page(pageDefinition);

if (typeof module !== "undefined") {
  module.exports = { __testables: { buildIncidentIso, buildSubmitData, formatDateTime, localDateParts, mapReportResult, messageFor, parseAmount, trimOptional, pageDefinition } };
}
