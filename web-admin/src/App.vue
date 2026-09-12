<script setup>
import { computed, onMounted, ref } from "vue";

const SESSION_TOKEN_KEY = "securitySessionToken";
const apiBaseUrl = (import.meta.env.VITE_SECURITY_API_BASE_URL || "").replace(/\/+$/, "");

const FRAUD_TYPES = [
  { value: "part_time_scam", label: "刷单兼职诈骗" },
  { value: "impersonate_public", label: "冒充公检法" },
  { value: "fake_loan", label: "虚假贷款" },
  { value: "fake_refund", label: "虚假退款" },
  { value: "other", label: "其他" },
];
const FRAUD_TYPE_LABELS = Object.fromEntries(FRAUD_TYPES.map(({ value, label }) => [value, label]));
const RISK_LEVEL_LABELS = { low: "低风险", medium: "中风险", high: "高风险" };
const STATUS_LABELS = {
  pending_dispatch: "待下发", sent: "已下发", pending_security_verify: "待保卫处核验",
  in_process: "处理中", closed: "已结案", viewed: "已查看", following_up: "跟进中",
};
const TOKEN_ERROR_CODES = new Set(["TOKEN_MISSING", "TOKEN_INVALID", "TOKEN_EXPIRED"]);
const IDENTITY_ROLE_LABELS = { student: "学生", counselor: "辅导员" };
const IDENTITY_BIND_STATUS_LABELS = { bound: "已绑定", unbound: "未绑定" };
const IDENTITY_STATUS_LABELS = { active: "正常", suspended: "已停用" };
const COLLEGE_STATUS_LABELS = { active: "启用", disabled: "已停用" };

const loginName = ref("");
const password = ref("");
const profile = ref(null);
const loginLoading = ref(false);
const sessionLoading = ref(false);
const createLoading = ref(false);
const dispatchLoading = ref(false);
const message = ref("");
const successMessage = ref("");
const createdAlert = ref(null);
const dashboard = ref(null);
const dashboardLoading = ref(false);
const studentNo = ref("");
const fraudType = ref("part_time_scam");
const content = ref("");
const sourceReference = ref("");
const activeView = ref("dashboard");
const identities = ref([]);
const colleges = ref([]);
const identitiesLoading = ref(false);
const identitySaving = ref(false);
const identityActionLoading = ref("");
const showIdentityCreatePanel = ref(false);
const identityForm = ref({ name: "", role: "student", identityNo: "", collegeId: "" });
const managedColleges = ref([]);
const collegesLoading = ref(false);
const collegeSaving = ref(false);
const collegeActionLoading = ref("");
const showCollegeCreatePanel = ref(false);
const collegeName = ref("");
const reportQueues = ref({ pendingSecurityVerify: [], inProcess: [], closed: [] });
const reportsLoading = ref(false);
const activeReportTab = ref("pendingSecurityVerify");
const selectedReport = ref(null);
const reportDetailLoading = ref(false);
const reportActionLoading = ref(false);
const reportActionMode = ref("");
const reportActionForm = ref({ actionContent: "", verificationResult: "suspected", returnReason: "", finalOutcome: "loss_no_loss", confirmedLossAmount: "0", closeReason: "" });
const isAuthenticated = computed(() => profile.value !== null);
const canDispatch = computed(() => createdAlert.value?.status === "pending_dispatch");
const identityNoHint = computed(() => identityForm.value.role === "student" ? "身份编号填写学号" : "身份编号填写工号");

const CODE_MESSAGES = {
  INVALID_INPUT: "输入内容不符合要求。",
  AUTH_FAILED: "登录名或密码不正确。",
  NOT_FOUND: "未找到对应学生或预警。",
  CONFLICT: "数据状态已变化，请刷新后重新操作。",
  TOKEN_MISSING: "登录状态不存在，请重新登录。",
  TOKEN_INVALID: "登录状态无效，请重新登录。",
  TOKEN_EXPIRED: "登录状态已过期，请重新登录。",
  ACCOUNT_DISABLED: "该账号当前不可用。",
  FORBIDDEN: "当前账号无权访问保卫处系统。",
  INTERNAL_ERROR: "服务暂时不可用，请稍后重试。",
};

class ApiError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function messageFor(code) {
  return CODE_MESSAGES[code] || CODE_MESSAGES.INTERNAL_ERROR;
}

function setError(code) {
  successMessage.value = "";
  message.value = messageFor(code);
}

function clearSession() {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  profile.value = null;
  createdAlert.value = null;
  identities.value = [];
  colleges.value = [];
  dashboard.value = null;
  managedColleges.value = [];
  reportQueues.value = { pendingSecurityVerify: [], inProcess: [], closed: [] };
  selectedReport.value = null;
  reportActionMode.value = "";
  activeView.value = "dashboard";
  showIdentityCreatePanel.value = false;
  showCollegeCreatePanel.value = false;
}

function handleApiError(error) {
  const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
  if (TOKEN_ERROR_CODES.has(code)) {
    clearSession();
  }
  setError(code);
}

function requireApiBaseUrl() {
  if (apiBaseUrl) return true;
  successMessage.value = "";
  message.value = "未配置服务地址，请联系管理员。";
  return false;
}

function currentToken() {
  const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) {
    throw new ApiError("TOKEN_MISSING");
  }
  return token;
}

async function readApiResponse(response) {
  const payload = await response.json().catch(() => ({ code: "INTERNAL_ERROR" }));
  if (!response.ok || payload.ok !== true) {
    throw new ApiError(payload.code || "INTERNAL_ERROR");
  }
  return payload;
}

function isCreatedAlert(alert) {
  return Boolean(alert) &&
    typeof alert.alertId === "string" && alert.alertId &&
    typeof alert.fraudType === "string" &&
    typeof alert.riskLevel === "string" &&
    Array.isArray(alert.riskReasons) &&
    typeof alert.status === "string" &&
    Number.isSafeInteger(alert.version);
}

function isDispatchedAlert(alert) {
  return Boolean(alert) &&
    typeof alert.status === "string" &&
    Number.isSafeInteger(alert.version);
}

function alertProjection(alert) {
  return {
    alertId: alert.alertId,
    fraudType: alert.fraudType,
    riskLevel: alert.riskLevel,
    riskReasons: alert.riskReasons,
    status: alert.status,
    version: alert.version,
  };
}

function riskLevelLabel(value) {
  return RISK_LEVEL_LABELS[value] || value;
}

function statusLabel(value) {
  return STATUS_LABELS[value] || value;
}

function collegeStatusLabel(value) {
  return COLLEGE_STATUS_LABELS[value] || value;
}

function displayDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
  });
}

function fraudTypeLabel(value) {
  return FRAUD_TYPE_LABELS[value] || value;
}

function identityRoleLabel(value) {
  return IDENTITY_ROLE_LABELS[value] || value;
}

function identityBindStatusLabel(value) {
  return IDENTITY_BIND_STATUS_LABELS[value] || value;
}

function identityStatusLabel(value) {
  return IDENTITY_STATUS_LABELS[value] || value;
}

function isIdentityListItem(identity) {
  return Boolean(identity) &&
    typeof identity.userId === "string" && identity.userId &&
    (identity.role === "student" || identity.role === "counselor") &&
    typeof identity.name === "string" &&
    typeof identity.collegeId === "string" &&
    typeof identity.collegeName === "string" &&
    typeof identity.identityNoMasked === "string" &&
    (identity.bindStatus === "bound" || identity.bindStatus === "unbound") &&
    (identity.status === "active" || identity.status === "suspended") &&
    Number.isSafeInteger(identity.version) && identity.version > 0;
}

function isCollegeOption(college) {
  return Boolean(college) && typeof college.collegeId === "string" && college.collegeId &&
    typeof college.name === "string" && college.name;
}

function isManagedCollege(college) {
  return Boolean(college) && typeof college.collegeId === "string" && college.collegeId &&
    typeof college.name === "string" && college.name &&
    (college.status === "active" || college.status === "disabled") &&
    Number.isSafeInteger(college.identityCount) && college.identityCount >= 0 &&
    Number.isSafeInteger(college.activeIdentityCount) && college.activeIdentityCount >= 0;
}

function isDashboardItem(item, idField) {
  return Boolean(item) && typeof item[idField] === "string" && item[idField] &&
    typeof item.fraudType === "string" && typeof item.riskLevel === "string" &&
    typeof item.status === "string" && typeof item.collegeName === "string" && item.createdAt;
}

function isDashboardPayload(payload) {
  const metricKeys = ["pendingSecurityVerifyCount", "inProcessCount", "closedCount", "todayNewReportCount"];
  const identityKeys = ["studentCount", "counselorCount", "boundCount", "unboundCount"];
  return payload.code === "DASHBOARD_LOADED" && payload.metrics && payload.identitySummary && payload.collegeSummary &&
    metricKeys.every((key) => Number.isSafeInteger(payload.metrics[key]) && payload.metrics[key] >= 0) &&
    identityKeys.every((key) => Number.isSafeInteger(payload.identitySummary[key]) && payload.identitySummary[key] >= 0) &&
    Number.isSafeInteger(payload.collegeSummary.activeCount) && Number.isSafeInteger(payload.collegeSummary.totalCount) &&
    Array.isArray(payload.pendingReports) && payload.pendingReports.length <= 5 && payload.pendingReports.every((item) => isDashboardItem(item, "reportId")) &&
    Array.isArray(payload.recentAlerts) && payload.recentAlerts.length <= 5 && payload.recentAlerts.every((item) => isDashboardItem(item, "alertId"));
}

function isReportListItem(report) {
  return Boolean(report) && typeof report.reportId === "string" && report.reportId &&
    typeof report.fraudType === "string" && typeof report.riskLevel === "string" &&
    typeof report.status === "string" && typeof report.collegeName === "string" &&
    Number.isSafeInteger(report.version) && report.version > 0 && typeof report.hasLoss === "boolean";
}

function isReportQueuesPayload(payload) {
  const queues = payload?.queues;
  return payload?.code === "REPORTS_LOADED" && queues && ["pendingSecurityVerify", "inProcess", "closed"].every((key) =>
    Array.isArray(queues[key]) && queues[key].length <= 50 && queues[key].every(isReportListItem));
}

function isReportDetailPayload(payload) {
  return payload?.code === "REPORT_DETAIL_LOADED" && payload.report && typeof payload.report.reportId === "string" &&
    Number.isSafeInteger(payload.report.version) && payload.student && typeof payload.student.name === "string" &&
    Array.isArray(payload.followups) && Array.isArray(payload.dispositions);
}

function resetIdentityForm() {
  identityForm.value = { name: "", role: "student", identityNo: "", collegeId: colleges.value[0]?.collegeId || "" };
}

function openIdentityCreatePanel() {
  resetIdentityForm();
  showIdentityCreatePanel.value = true;
}

function closeIdentityCreatePanel() {
  if (!identitySaving.value) showIdentityCreatePanel.value = false;
}

function selectNavigation(view) {
  activeView.value = view;
  successMessage.value = "";
  message.value = "";
  if (view === "dashboard") void loadDashboard();
  if (view === "reports") void loadReports();
  if (view === "identities") void loadIdentities();
  if (view === "colleges") void loadColleges();
}

async function loadReports() {
  if (reportsLoading.value || !isAuthenticated.value || !requireApiBaseUrl()) return;
  reportsLoading.value = true;
  try {
    const response = await fetch(`${apiBaseUrl}/security/reports`, { method: "GET", headers: { Authorization: `Bearer ${currentToken()}` } });
    const payload = await readApiResponse(response);
    if (!isReportQueuesPayload(payload)) throw new ApiError("INTERNAL_ERROR");
    reportQueues.value = {
      pendingSecurityVerify: payload.queues.pendingSecurityVerify.map((report) => ({ ...report })),
      inProcess: payload.queues.inProcess.map((report) => ({ ...report })),
      closed: payload.queues.closed.map((report) => ({ ...report })),
    };
    message.value = "";
  } catch (error) { handleApiError(error); }
  finally { reportsLoading.value = false; }
}

async function loadReportDetail(reportId) {
  if (!reportId || reportDetailLoading.value || !requireApiBaseUrl()) return;
  reportDetailLoading.value = true;
  try {
    const response = await fetch(`${apiBaseUrl}/security/reports/${encodeURIComponent(reportId)}`, { method: "GET", headers: { Authorization: `Bearer ${currentToken()}` } });
    const payload = await readApiResponse(response);
    if (!isReportDetailPayload(payload)) throw new ApiError("INTERNAL_ERROR");
    selectedReport.value = {
      report: { ...payload.report }, student: { name: payload.student.name, studentNo: payload.student.studentNo },
      followups: payload.followups.map((followup) => ({ ...followup })), dispositions: payload.dispositions.map((disposition) => ({ ...disposition })),
    };
    reportActionMode.value = "";
    message.value = "";
  } catch (error) { handleApiError(error); }
  finally { reportDetailLoading.value = false; }
}

function openReport(reportId) {
  activeView.value = "reports";
  successMessage.value = "";
  message.value = "";
  void loadReports();
  void loadReportDetail(reportId);
}

function resetReportActionForm() {
  reportActionForm.value = { actionContent: "", verificationResult: "suspected", returnReason: "", finalOutcome: "loss_no_loss", confirmedLossAmount: "0", closeReason: "" };
}

function openReportAction(mode) {
  resetReportActionForm();
  reportActionMode.value = mode;
}

function closeReportAction() {
  if (!reportActionLoading.value) reportActionMode.value = "";
}

async function runReportAction() {
  const detail = selectedReport.value;
  if (!detail || reportActionLoading.value || !requireApiBaseUrl()) return;
  const report = detail.report;
  const form = reportActionForm.value;
  let path = "";
  let body = null;
  if (reportActionMode.value === "start") {
    if (!form.actionContent.trim() || form.actionContent.trim().length > 1000) return setError("INVALID_INPUT");
    path = `/reports/${encodeURIComponent(report.reportId)}/start-process`;
    body = { version: report.version, actionContent: form.actionContent.trim() };
  } else if (reportActionMode.value === "return") {
    if (!form.returnReason.trim() || form.returnReason.trim().length > 1000 || !form.actionContent.trim() || form.actionContent.trim().length > 2000) return setError("INVALID_INPUT");
    path = `/security/reports/${encodeURIComponent(report.reportId)}/return`;
    body = { version: report.version, verificationResult: form.verificationResult, returnReason: form.returnReason.trim(), actionContent: form.actionContent.trim() };
  } else if (reportActionMode.value === "close") {
    const confirmedLossAmount = Number(form.confirmedLossAmount);
    const validOutcome = ["loss_confirmed", "loss_no_loss", "misreport", "consultation"].includes(form.finalOutcome);
    if (!validOutcome || !Number.isFinite(confirmedLossAmount) || confirmedLossAmount < 0 || !form.closeReason.trim() || form.closeReason.trim().length > 1000 || !form.actionContent.trim() || form.actionContent.trim().length > 1000 ||
      (form.finalOutcome === "loss_confirmed" ? confirmedLossAmount <= 0 : confirmedLossAmount !== 0)) return setError("INVALID_INPUT");
    path = `/reports/${encodeURIComponent(report.reportId)}/close`;
    body = { version: report.version, verificationResult: form.verificationResult, finalOutcome: form.finalOutcome, confirmedLossAmount, closeReason: form.closeReason.trim(), actionContent: form.actionContent.trim() };
  } else return;
  reportActionLoading.value = true;
  message.value = "";
  successMessage.value = "";
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentToken()}` }, body: JSON.stringify(body) });
    const payload = await readApiResponse(response);
    if (!["REPORT_PROCESSING_STARTED", "REPORT_RETURNED_TO_COUNSELOR", "REPORT_CLOSED"].includes(payload.code)) throw new ApiError("INTERNAL_ERROR");
    successMessage.value = "工单操作已完成，已重新加载真实状态。";
    reportActionMode.value = "";
    await loadReports();
    await loadReportDetail(report.reportId);
  } catch (error) { handleApiError(error); }
  finally { reportActionLoading.value = false; }
}

async function loadSession() {
  const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (!token || !requireApiBaseUrl()) return;

  sessionLoading.value = true;
  try {
    const response = await fetch(`${apiBaseUrl}/session`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await readApiResponse(response);
    const sessionProfile = payload.profile;
    if (!sessionProfile || typeof sessionProfile.name !== "string" || sessionProfile.role !== "security") {
      throw new ApiError("TOKEN_INVALID");
    }
    profile.value = {
      userId: sessionProfile.userId,
      role: sessionProfile.role,
      name: sessionProfile.name,
    };
    activeView.value = "dashboard";
    message.value = "";
    await loadDashboard();
  } catch (error) {
    handleApiError(error);
  } finally {
    sessionLoading.value = false;
  }
}

async function loadDashboard() {
  if (dashboardLoading.value || !isAuthenticated.value || !requireApiBaseUrl()) return;
  dashboardLoading.value = true;
  try {
    const response = await fetch(`${apiBaseUrl}/dashboard`, {
      method: "GET", headers: { Authorization: `Bearer ${currentToken()}` },
    });
    const payload = await readApiResponse(response);
    if (!isDashboardPayload(payload)) throw new ApiError("INTERNAL_ERROR");
    dashboard.value = {
      metrics: { ...payload.metrics }, identitySummary: { ...payload.identitySummary },
      collegeSummary: { ...payload.collegeSummary },
      pendingReports: payload.pendingReports.map((item) => ({ ...item })),
      recentAlerts: payload.recentAlerts.map((item) => ({ ...item })),
    };
    message.value = "";
  } catch (error) {
    handleApiError(error);
  } finally {
    dashboardLoading.value = false;
  }
}

async function loadIdentities() {
  if (identitiesLoading.value || !isAuthenticated.value || !requireApiBaseUrl()) return;

  identitiesLoading.value = true;
  try {
    const response = await fetch(`${apiBaseUrl}/identities`, {
      method: "GET",
      headers: { Authorization: `Bearer ${currentToken()}` },
    });
    const payload = await readApiResponse(response);
    if (payload.code !== "IDENTITIES_LOADED" || !Array.isArray(payload.identities) || !Array.isArray(payload.colleges) ||
      !payload.identities.every(isIdentityListItem) || !payload.colleges.every(isCollegeOption)) {
      throw new ApiError("INTERNAL_ERROR");
    }
    identities.value = payload.identities.map((identity) => ({
      userId: identity.userId,
      role: identity.role,
      name: identity.name,
      collegeId: identity.collegeId,
      collegeName: identity.collegeName,
      identityNoMasked: identity.identityNoMasked,
      bindStatus: identity.bindStatus,
      status: identity.status,
      version: identity.version,
    }));
    colleges.value = payload.colleges.map((college) => ({ collegeId: college.collegeId, name: college.name }));
    message.value = "";
  } catch (error) {
    handleApiError(error);
  } finally {
    identitiesLoading.value = false;
  }
}

async function loadColleges() {
  if (collegesLoading.value || !isAuthenticated.value || !requireApiBaseUrl()) return;
  collegesLoading.value = true;
  try {
    const response = await fetch(`${apiBaseUrl}/colleges`, {
      method: "GET", headers: { Authorization: `Bearer ${currentToken()}` },
    });
    const payload = await readApiResponse(response);
    if (payload.code !== "COLLEGES_LOADED" || !Array.isArray(payload.colleges) || !payload.colleges.every(isManagedCollege)) {
      throw new ApiError("INTERNAL_ERROR");
    }
    managedColleges.value = payload.colleges.map((college) => ({ ...college }));
    message.value = "";
  } catch (error) {
    handleApiError(error);
  } finally {
    collegesLoading.value = false;
  }
}

function openCollegeCreatePanel() {
  collegeName.value = "";
  showCollegeCreatePanel.value = true;
}

function closeCollegeCreatePanel() {
  if (!collegeSaving.value) showCollegeCreatePanel.value = false;
}

async function createCollege() {
  const name = collegeName.value.trim();
  if (collegeSaving.value || !requireApiBaseUrl()) return;
  if (!name || name.length > 64) {
    setError("INVALID_INPUT");
    return;
  }
  collegeSaving.value = true;
  message.value = "";
  successMessage.value = "";
  try {
    const response = await fetch(`${apiBaseUrl}/colleges`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentToken()}` },
      body: JSON.stringify({ name }),
    });
    const payload = await readApiResponse(response);
    if (payload.code !== "COLLEGE_CREATED") throw new ApiError("INTERNAL_ERROR");
    showCollegeCreatePanel.value = false;
    activeView.value = "identities";
    successMessage.value = "学院已创建，可继续新增身份。";
    await loadIdentities();
  } catch (error) {
    handleApiError(error);
  } finally {
    collegeSaving.value = false;
  }
}

async function changeCollegeStatus(college) {
  if (collegeActionLoading.value || !requireApiBaseUrl()) return;
  const nextStatus = college.status === "active" ? "disabled" : "active";
  if (nextStatus === "disabled" && !window.confirm(`确认停用“${college.name}”吗？`)) return;
  collegeActionLoading.value = college.collegeId;
  message.value = "";
  successMessage.value = "";
  try {
    const response = await fetch(`${apiBaseUrl}/colleges/${encodeURIComponent(college.collegeId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentToken()}` },
      body: JSON.stringify({ status: nextStatus }),
    });
    const payload = await readApiResponse(response);
    if (payload.code !== "COLLEGE_STATUS_UPDATED") throw new ApiError("INTERNAL_ERROR");
    successMessage.value = `学院已${nextStatus === "active" ? "启用" : "停用"}。`;
    await loadColleges();
  } catch (error) {
    if (error instanceof ApiError && error.code === "COLLEGE_IN_USE") {
      successMessage.value = "";
      message.value = "该学院仍有正常使用中的学生或辅导员身份，请先停用相关身份。";
    } else {
      handleApiError(error);
    }
  } finally {
    collegeActionLoading.value = "";
  }
}

function validateIdentityForm() {
  const form = identityForm.value;
  if ((form.role !== "student" && form.role !== "counselor") || !form.name.trim() || form.name.trim().length > 64 ||
    !form.identityNo.trim() || form.identityNo.trim().length > 64 || !form.collegeId || form.collegeId.length > 64 ||
    !colleges.value.some((college) => college.collegeId === form.collegeId)) {
    setError("INVALID_INPUT");
    return false;
  }
  return true;
}

async function createIdentity() {
  if (identitySaving.value || !requireApiBaseUrl() || !validateIdentityForm()) return;

  identitySaving.value = true;
  message.value = "";
  successMessage.value = "";
  try {
    const form = identityForm.value;
    const response = await fetch(`${apiBaseUrl}/identities`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentToken()}`,
      },
      body: JSON.stringify({
        role: form.role,
        identityNo: form.identityNo.trim(),
        name: form.name.trim(),
        collegeId: form.collegeId,
      }),
    });
    const payload = await readApiResponse(response);
    if (payload.code !== "IDENTITY_CREATED") throw new ApiError("INTERNAL_ERROR");
    showIdentityCreatePanel.value = false;
    successMessage.value = "身份已创建。";
    await loadIdentities();
  } catch (error) {
    handleApiError(error);
  } finally {
    identitySaving.value = false;
  }
}

async function unbindIdentity(identity) {
  if (identityActionLoading.value || identity.bindStatus !== "bound" || !requireApiBaseUrl()) return;
  if (!window.confirm("解除后，该微信将无法继续使用此身份，需要重新验证绑定。")) return;

  identityActionLoading.value = `${identity.userId}:unbind`;
  message.value = "";
  successMessage.value = "";
  try {
    const response = await fetch(`${apiBaseUrl}/identities/${encodeURIComponent(identity.userId)}/unbind`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentToken()}`,
      },
      body: JSON.stringify({ version: identity.version }),
    });
    const payload = await readApiResponse(response);
    if (payload.code !== "IDENTITY_UNBOUND") throw new ApiError("INTERNAL_ERROR");
    successMessage.value = "微信绑定已解除。";
    await loadIdentities();
  } catch (error) {
    handleApiError(error);
  } finally {
    identityActionLoading.value = "";
  }
}

async function changeIdentityStatus(identity) {
  if (identityActionLoading.value || !requireApiBaseUrl()) return;
  const nextStatus = identity.status === "active" ? "suspended" : "active";
  const actionLabel = nextStatus === "suspended" ? "停用" : "启用";
  if (!window.confirm(`确认${actionLabel}“${identity.name}”的身份吗？`)) return;

  identityActionLoading.value = `${identity.userId}:status`;
  message.value = "";
  successMessage.value = "";
  try {
    const response = await fetch(`${apiBaseUrl}/identities/${encodeURIComponent(identity.userId)}/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentToken()}`,
      },
      body: JSON.stringify({ version: identity.version, status: nextStatus }),
    });
    const payload = await readApiResponse(response);
    if (payload.code !== "IDENTITY_STATUS_UPDATED") throw new ApiError("INTERNAL_ERROR");
    successMessage.value = `身份已${actionLabel}。`;
    await loadIdentities();
  } catch (error) {
    handleApiError(error);
  } finally {
    identityActionLoading.value = "";
  }
}

async function login() {
  if (loginLoading.value || !requireApiBaseUrl()) return;

  loginLoading.value = true;
  message.value = "";
  successMessage.value = "";
  try {
    const response = await fetch(`${apiBaseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loginName: loginName.value,
        password: password.value,
      }),
    });
    const payload = await readApiResponse(response);
    if (payload.code !== "AUTHENTICATED" || typeof payload.token !== "string" || !payload.token) {
      throw new ApiError("INTERNAL_ERROR");
    }

    sessionStorage.setItem(SESSION_TOKEN_KEY, payload.token);
    password.value = "";
    await loadSession();
  } catch (error) {
    if (error instanceof ApiError && error.code === "INVALID_INPUT") {
      successMessage.value = "";
      message.value = "请输入有效的登录名和密码。";
    } else {
      handleApiError(error);
    }
  } finally {
    loginLoading.value = false;
  }
}

function validateAlertForm() {
  if (!studentNo.value.trim() || studentNo.value.trim().length > 64 ||
    !content.value.trim() || content.value.trim().length > 1000 ||
    sourceReference.value.trim().length > 128) {
    setError("INVALID_INPUT");
    return false;
  }
  return true;
}

async function createAlert() {
  if (createLoading.value || !requireApiBaseUrl() || !validateAlertForm()) return;

  createLoading.value = true;
  message.value = "";
  successMessage.value = "";
  try {
    const body = {
      studentNo: studentNo.value.trim(),
      fraudType: fraudType.value,
      content: content.value.trim(),
    };
    const trimmedSourceReference = sourceReference.value.trim();
    if (trimmedSourceReference) {
      body.sourceReference = trimmedSourceReference;
    }
    const response = await fetch(`${apiBaseUrl}/alerts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentToken()}`,
      },
      body: JSON.stringify(body),
    });
    const payload = await readApiResponse(response);
    if (payload.code !== "ALERT_CREATED" || !isCreatedAlert(payload.alert)) {
      throw new ApiError("INTERNAL_ERROR");
    }
    createdAlert.value = alertProjection(payload.alert);
    successMessage.value = "预警创建成功";
  } catch (error) {
    handleApiError(error);
  } finally {
    createLoading.value = false;
  }
}

async function dispatchAlert() {
  const alert = createdAlert.value;
  if (dispatchLoading.value || !alert || !canDispatch.value || !requireApiBaseUrl()) return;

  dispatchLoading.value = true;
  message.value = "";
  successMessage.value = "";
  try {
    const response = await fetch(`${apiBaseUrl}/alerts/${encodeURIComponent(alert.alertId)}/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentToken()}`,
      },
      body: JSON.stringify({ version: alert.version }),
    });
    const payload = await readApiResponse(response);
    if (payload.code !== "ALERT_DISPATCHED" || !isDispatchedAlert(payload.alert)) {
      throw new ApiError("INTERNAL_ERROR");
    }
    createdAlert.value = {
      ...alert,
      status: payload.alert.status,
      version: payload.alert.version,
    };
    successMessage.value = "预警已成功下发";
  } catch (error) {
    handleApiError(error);
  } finally {
    dispatchLoading.value = false;
  }
}

function logout() {
  clearSession();
  password.value = "";
  successMessage.value = "";
  message.value = "已退出登录。";
}

onMounted(() => {
  void loadSession();
});
</script>

<template>
  <main class="page-shell">
    <section v-if="!isAuthenticated" class="auth-card" aria-labelledby="page-title">
      <p class="eyebrow">校园反诈安全管理系统</p>
      <h1 id="page-title">保卫处登录</h1>

      <form class="login-form" @submit.prevent="login">
        <label>
          登录名
          <input v-model="loginName" name="loginName" autocomplete="username" required :disabled="loginLoading || sessionLoading" />
        </label>

        <label>
          密码
          <input
            v-model="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            :disabled="loginLoading || sessionLoading"
          />
        </label>

        <button type="submit" :disabled="loginLoading || sessionLoading">
          {{ loginLoading ? "登录中…" : "登录" }}
        </button>
      </form>

      <p v-if="message" class="message" role="status">{{ message }}</p>
    </section>

    <section v-else class="admin-shell" aria-labelledby="page-title">
      <aside class="sidebar" aria-label="保卫处后台导航">
        <div class="sidebar-brand">
          <p class="eyebrow">校园反诈安全管理系统</p>
          <strong>保卫处后台</strong>
        </div>
        <nav class="side-nav">
          <button type="button" :class="{ active: activeView === 'dashboard' }" @click="selectNavigation('dashboard')">工作台</button>
          <button type="button" :class="{ active: activeView === 'alerts' }" @click="selectNavigation('alerts')">预警管理</button>
          <button type="button" :class="{ active: activeView === 'reports' }" @click="selectNavigation('reports')">工单管理</button>
          <button type="button" :class="{ active: activeView === 'identities' }" @click="selectNavigation('identities')">身份管理</button>
          <button type="button" :class="{ active: activeView === 'colleges' }" @click="selectNavigation('colleges')">学院管理</button>
        </nav>
        <div class="sidebar-footer">
          <p>当前用户：{{ profile.name }}</p>
          <button type="button" class="secondary-button" @click="logout">退出登录</button>
        </div>
      </aside>

      <section class="admin-content">
        <header class="admin-header">
          <div>
            <p class="eyebrow">安全管理中心</p>
            <h1 id="page-title">保卫处工作台</h1>
          </div>
          <p class="current-user">已登录为保卫处管理员</p>
        </header>

        <p v-if="message" class="message workbench-message" role="status">{{ message }}</p>
        <p v-if="successMessage" class="success-message" role="status">{{ successMessage }}</p>

        <section v-if="activeView === 'dashboard'" class="dashboard-page" aria-labelledby="dashboard-title">
          <header class="section-page-header dashboard-title-row">
            <div><h2 id="dashboard-title">保卫处工作台</h2><p>校园反诈业务概览</p></div>
            <button type="button" class="secondary-button" :disabled="dashboardLoading" @click="loadDashboard">{{ dashboardLoading ? "刷新中…" : "刷新数据" }}</button>
          </header>
          <p v-if="dashboardLoading && !dashboard" class="table-state">正在加载工作台数据…</p>
          <template v-else-if="dashboard">
            <section class="metric-grid" aria-label="工单统计">
              <article class="metric-card"><span>待保卫处核验</span><strong>{{ dashboard.metrics.pendingSecurityVerifyCount }}</strong></article>
              <article class="metric-card"><span>处理中</span><strong>{{ dashboard.metrics.inProcessCount }}</strong></article>
              <article class="metric-card"><span>已结案</span><strong>{{ dashboard.metrics.closedCount }}</strong></article>
              <article class="metric-card"><span>今日新增</span><strong>{{ dashboard.metrics.todayNewReportCount }}</strong></article>
            </section>

            <section class="dashboard-grid">
              <article class="panel dashboard-panel">
                <h3>待办工单</h3>
                <p v-if="dashboard.pendingReports.length === 0" class="table-state">当前暂无待处理工单</p>
                <div v-else class="table-scroll"><table class="dashboard-table"><thead><tr><th>诈骗类型</th><th>风险等级</th><th>状态</th><th>学院</th><th>时间</th></tr></thead><tbody><tr v-for="report in dashboard.pendingReports" :key="report.reportId" class="clickable-row" @click="openReport(report.reportId)"><td>{{ fraudTypeLabel(report.fraudType) }}</td><td>{{ riskLevelLabel(report.riskLevel) }}</td><td>{{ statusLabel(report.status) }}</td><td>{{ report.collegeName || "—" }}</td><td>{{ displayDate(report.createdAt) }}</td></tr></tbody></table></div>
              </article>
              <article class="panel dashboard-panel">
                <h3>最新预警</h3>
                <p v-if="dashboard.recentAlerts.length === 0" class="table-state">当前暂无最新预警</p>
                <div v-else class="table-scroll"><table class="dashboard-table"><thead><tr><th>诈骗类型</th><th>风险等级</th><th>状态</th><th>学院</th><th>时间</th></tr></thead><tbody><tr v-for="alert in dashboard.recentAlerts" :key="alert.alertId"><td>{{ fraudTypeLabel(alert.fraudType) }}</td><td>{{ riskLevelLabel(alert.riskLevel) }}</td><td>{{ statusLabel(alert.status) }}</td><td>{{ alert.collegeName || "—" }}</td><td>{{ displayDate(alert.createdAt) }}</td></tr></tbody></table></div>
              </article>
            </section>

            <section class="dashboard-grid dashboard-bottom-grid">
              <article class="panel dashboard-panel"><h3>人员与学院概览</h3><dl class="summary-list"><div><dt>学生身份</dt><dd>{{ dashboard.identitySummary.studentCount }}</dd></div><div><dt>辅导员身份</dt><dd>{{ dashboard.identitySummary.counselorCount }}</dd></div><div><dt>已绑定</dt><dd>{{ dashboard.identitySummary.boundCount }}</dd></div><div><dt>未绑定</dt><dd>{{ dashboard.identitySummary.unboundCount }}</dd></div><div><dt>启用学院</dt><dd>{{ dashboard.collegeSummary.activeCount }} / {{ dashboard.collegeSummary.totalCount }}</dd></div></dl></article>
              <article class="panel dashboard-panel"><h3>快捷操作</h3><div class="quick-actions"><button type="button" @click="selectNavigation('alerts')">新建预警</button><button type="button" class="secondary-button" @click="selectNavigation('identities')">身份管理</button><button type="button" class="secondary-button" @click="selectNavigation('colleges')">学院管理</button></div></article>
            </section>
          </template>
        </section>

        <template v-else-if="activeView === 'alerts'">
          <section class="panel" aria-labelledby="create-alert-title">
            <h2 id="create-alert-title">创建预警</h2>
            <form class="alert-form" @submit.prevent="createAlert">
              <label>
                学号
                <input v-model="studentNo" name="studentNo" type="text" maxlength="64" required :disabled="createLoading" />
              </label>

              <label>
                诈骗类型
                <select v-model="fraudType" name="fraudType" :disabled="createLoading">
                  <option v-for="item in FRAUD_TYPES" :key="item.value" :value="item.value">{{ item.label }}</option>
                </select>
              </label>

              <label>
                预警内容
                <textarea v-model="content" name="content" maxlength="1000" required :disabled="createLoading" />
              </label>

              <label>
                来源说明（选填）
                <input v-model="sourceReference" name="sourceReference" type="text" maxlength="128" :disabled="createLoading" />
              </label>

              <button type="submit" :disabled="createLoading">
                {{ createLoading ? "创建中…" : "创建预警" }}
              </button>
            </form>
          </section>

          <section v-if="createdAlert" class="panel result-panel" aria-labelledby="alert-result-title" aria-live="polite">
            <div class="result-header">
              <div>
                <p class="eyebrow">预警创建结果</p>
                <h2 id="alert-result-title">预警创建成功</h2>
              </div>
              <button v-if="canDispatch" type="button" :disabled="dispatchLoading" @click="dispatchAlert">
                {{ dispatchLoading ? "下发中…" : "下发预警" }}
              </button>
            </div>
            <dl class="result-list">
              <div><dt>预警 ID</dt><dd class="breakable">{{ createdAlert.alertId }}</dd></div>
              <div><dt>诈骗类型</dt><dd>{{ fraudTypeLabel(createdAlert.fraudType) }}</dd></div>
              <div><dt>风险等级</dt><dd>{{ riskLevelLabel(createdAlert.riskLevel) }}</dd></div>
              <div><dt>风险原因</dt><dd><span v-if="createdAlert.riskReasons.length === 0">无</span><ul v-else class="reason-list"><li v-for="reason in createdAlert.riskReasons" :key="reason">{{ reason }}</li></ul></dd></div>
              <div><dt>状态</dt><dd>{{ statusLabel(createdAlert.status) }}</dd></div>
              <div><dt>版本</dt><dd>{{ createdAlert.version }}</dd></div>
            </dl>
          </section>
        </template>

        <section v-else-if="activeView === 'reports'" class="reports-page" aria-labelledby="reports-title">
          <header class="section-page-header"><div><p class="eyebrow">工单管理</p><h2 id="reports-title">保卫处工单队列</h2><p>只展示已通过保卫处会话授权读取的真实工单。</p></div><button type="button" class="secondary-button" :disabled="reportsLoading" @click="loadReports">{{ reportsLoading ? '刷新中…' : '刷新队列' }}</button></header>
          <div class="report-tabs" role="tablist"><button type="button" :class="{ active: activeReportTab === 'pendingSecurityVerify' }" @click="activeReportTab = 'pendingSecurityVerify'">待核验（{{ reportQueues.pendingSecurityVerify.length }}）</button><button type="button" :class="{ active: activeReportTab === 'inProcess' }" @click="activeReportTab = 'inProcess'">处理中（{{ reportQueues.inProcess.length }}）</button><button type="button" :class="{ active: activeReportTab === 'closed' }" @click="activeReportTab = 'closed'">已结案（{{ reportQueues.closed.length }}）</button></div>
          <section class="panel identity-panel"><p v-if="reportsLoading" class="table-state">正在加载工单队列…</p><p v-else-if="reportQueues[activeReportTab].length === 0" class="table-state">当前队列暂无工单。</p><div v-else class="table-scroll"><table class="identity-table report-table"><thead><tr><th>风险等级</th><th>诈骗类型</th><th>学院</th><th>状态</th><th>提交时间</th><th>是否损失</th><th>操作</th></tr></thead><tbody><tr v-for="report in reportQueues[activeReportTab]" :key="report.reportId"><td>{{ riskLevelLabel(report.riskLevel) }}</td><td>{{ fraudTypeLabel(report.fraudType) }}</td><td>{{ report.collegeName || '—' }}</td><td>{{ statusLabel(report.status) }}</td><td>{{ displayDate(report.submittedAt) }}</td><td>{{ report.hasLoss ? '是' : '否' }}</td><td><button type="button" class="text-button" @click="loadReportDetail(report.reportId)">查看详情</button></td></tr></tbody></table></div></section>
          <section v-if="reportDetailLoading" class="panel table-state">正在加载工单详情…</section>
          <section v-else-if="selectedReport" class="panel report-detail" aria-live="polite"><header class="result-header"><div><p class="eyebrow">工单详情</p><h3>{{ fraudTypeLabel(selectedReport.report.fraudType) }}</h3></div><button type="button" class="secondary-button" @click="selectedReport = null">关闭详情</button></header><dl class="result-list"><div><dt>学生</dt><dd>{{ selectedReport.student.name }}（{{ selectedReport.student.studentNo }}）</dd></div><div><dt>学院</dt><dd>{{ selectedReport.report.collegeName || '—' }}</dd></div><div><dt>状态</dt><dd>{{ statusLabel(selectedReport.report.status) }}</dd></div><div><dt>风险等级</dt><dd>{{ riskLevelLabel(selectedReport.report.riskLevel) }}</dd></div><div><dt>事件时间</dt><dd>{{ displayDate(selectedReport.report.incidentAt) }}</dd></div><div><dt>涉及金额</dt><dd>{{ selectedReport.report.involvedAmount }}</dd></div><div><dt>是否损失</dt><dd>{{ selectedReport.report.hasLoss ? '是' : '否' }}</dd></div><div><dt>事件经过</dt><dd class="breakable">{{ selectedReport.report.incidentNarrative }}</dd></div><div><dt>可疑平台/账号</dt><dd class="breakable">{{ selectedReport.report.suspiciousPlatform || '—' }} / {{ selectedReport.report.suspiciousAccount || '—' }}</dd></div><div><dt>联系电话</dt><dd>{{ selectedReport.report.contactPhone || '—' }}</dd></div><div><dt>学生补充</dt><dd class="breakable">{{ selectedReport.report.studentRemark || '—' }}</dd></div><div><dt>结案结果</dt><dd>{{ selectedReport.report.finalOutcome || '—' }}</dd></div><div><dt>确认损失金额</dt><dd>{{ selectedReport.report.confirmedLossAmount ?? '—' }}</dd></div><div><dt>结案时间</dt><dd>{{ displayDate(selectedReport.report.closedAt) }}</dd></div></dl><div class="report-actions" v-if="selectedReport.report.status === 'pending_security_verify'"><button type="button" @click="openReportAction('return')">退回辅导员</button><button type="button" @click="openReportAction('start')">确认并开始处置</button><button type="button" class="secondary-button" @click="openReportAction('close')">直接结案</button></div><div class="report-actions" v-else-if="selectedReport.report.status === 'in_process'"><button type="button" @click="openReportAction('close')">结案</button></div><p v-else class="table-state">已结案工单仅可只读查看历史。</p><section class="workflow-history"><h4>辅导员跟进记录</h4><p v-if="selectedReport.followups.length === 0">暂无跟进记录。</p><ul v-else><li v-for="followup in selectedReport.followups" :key="followup.followupId">{{ followup.status }} · {{ followup.contactMethod || '未联系' }} · {{ displayDate(followup.contactedAt || followup.createdAt) }}</li></ul><h4>保卫处处置记录</h4><p v-if="selectedReport.dispositions.length === 0">暂无处置记录。</p><ul v-else><li v-for="(disposition, index) in selectedReport.dispositions" :key="`${disposition.action}-${index}`">{{ disposition.action }} · {{ disposition.statusAfter }} · {{ displayDate(disposition.createdAt) }}</li></ul></section></section>
          <div v-if="reportActionMode && selectedReport" class="modal-backdrop" @click.self="closeReportAction"><section class="identity-modal" role="dialog" aria-modal="true" aria-labelledby="report-action-title"><header class="modal-header"><div><h2 id="report-action-title">{{ reportActionMode === 'return' ? '退回辅导员' : reportActionMode === 'start' ? '确认并开始处置' : '结案' }}</h2><p>提交后以服务端事务结果为准。</p></div><button type="button" class="secondary-button" :disabled="reportActionLoading" @click="closeReportAction">关闭</button></header><form class="identity-form" @submit.prevent="runReportAction"><template v-if="reportActionMode === 'return'"><label>核验结果<select v-model="reportActionForm.verificationResult"><option value="confirmed">已确认</option><option value="suspected">疑似</option><option value="misreport">误报</option><option value="consultation">咨询</option><option value="not_fraud">非诈骗</option></select></label><label>退回原因<textarea v-model="reportActionForm.returnReason" maxlength="1000" required /></label></template><template v-if="reportActionMode === 'close'"><label>核验结果<select v-model="reportActionForm.verificationResult"><option value="confirmed">已确认</option><option value="suspected">疑似</option><option value="misreport">误报</option><option value="consultation">咨询</option><option value="not_fraud">非诈骗</option></select></label><label>结案结果<select v-model="reportActionForm.finalOutcome"><option value="loss_confirmed">确认损失</option><option value="loss_no_loss">未确认损失</option><option value="misreport">误报</option><option value="consultation">咨询</option></select></label><label>确认损失金额<input v-model="reportActionForm.confirmedLossAmount" type="number" min="0" step="0.01" required /></label><label>结案原因<textarea v-model="reportActionForm.closeReason" maxlength="1000" required /></label></template><label>处置说明<textarea v-model="reportActionForm.actionContent" :maxlength="reportActionMode === 'return' ? 2000 : 1000" required /></label><button type="submit" :disabled="reportActionLoading">{{ reportActionLoading ? '提交中…' : '确认提交' }}</button></form></section></div>
        </section>

        <section v-else-if="activeView === 'identities'" class="identity-page" aria-labelledby="identities-title">
          <header class="section-page-header">
            <div>
              <h2 id="identities-title">身份管理</h2>
              <p>统一维护学生和辅导员的小程序身份</p>
            </div>
            <button type="button" @click="openIdentityCreatePanel" :disabled="identitiesLoading">新增身份</button>
          </header>

          <section class="panel identity-panel">
            <p v-if="identitiesLoading" class="table-state">正在加载身份列表…</p>
            <p v-else-if="identities.length === 0" class="table-state">暂无学生或辅导员身份。</p>
            <div v-else class="table-scroll">
              <table class="identity-table">
                <thead>
                  <tr><th>姓名</th><th>身份编号</th><th>身份</th><th>学院</th><th>绑定状态</th><th>账号状态</th><th>操作</th></tr>
                </thead>
                <tbody>
                  <tr v-for="identity in identities" :key="identity.userId">
                    <td>{{ identity.name }}</td>
                    <td>{{ identity.identityNoMasked }}</td>
                    <td>{{ identityRoleLabel(identity.role) }}</td>
                    <td>{{ identity.collegeName || identity.collegeId }}</td>
                    <td><span class="status-pill" :class="identity.bindStatus">{{ identityBindStatusLabel(identity.bindStatus) }}</span></td>
                    <td><span class="status-pill" :class="identity.status">{{ identityStatusLabel(identity.status) }}</span></td>
                    <td class="identity-actions">
                      <button v-if="identity.bindStatus === 'bound'" type="button" class="text-button" :disabled="Boolean(identityActionLoading)" @click="unbindIdentity(identity)">解除微信绑定</button>
                      <button type="button" class="text-button" :disabled="Boolean(identityActionLoading)" @click="changeIdentityStatus(identity)">{{ identity.status === 'active' ? '停用' : '启用' }}</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <div v-if="showIdentityCreatePanel" class="modal-backdrop" @click.self="closeIdentityCreatePanel">
            <section class="identity-modal" role="dialog" aria-modal="true" aria-labelledby="identity-create-title">
              <header class="modal-header">
                <div><h2 id="identity-create-title">新增身份</h2><p>创建后身份和身份编号不可编辑。</p></div>
                <button type="button" class="secondary-button" :disabled="identitySaving" @click="closeIdentityCreatePanel">关闭</button>
              </header>
              <form class="identity-form" @submit.prevent="createIdentity">
                <label>姓名<input v-model="identityForm.name" name="identityName" maxlength="64" required :disabled="identitySaving" /></label>
                <label>身份<select v-model="identityForm.role" name="identityRole" :disabled="identitySaving"><option value="student">学生</option><option value="counselor">辅导员</option></select></label>
                <label>身份编号<input v-model="identityForm.identityNo" name="identityNo" maxlength="64" required :disabled="identitySaving" /><span class="field-hint">{{ identityNoHint }}</span></label>
                <label>学院<select v-model="identityForm.collegeId" name="identityCollege" required :disabled="identitySaving || colleges.length === 0"><option disabled value="">请选择学院</option><option v-for="college in colleges" :key="college.collegeId" :value="college.collegeId">{{ college.name }}</option></select></label>
                <button type="submit" :disabled="identitySaving || colleges.length === 0">{{ identitySaving ? '创建中…' : '创建身份' }}</button>
              </form>
            </section>
          </div>
        </section>

        <section v-else-if="activeView === 'colleges'" class="identity-page" aria-labelledby="colleges-title">
          <header class="section-page-header">
            <div><h2 id="colleges-title">学院管理</h2><p>维护学生和辅导员所属学院</p></div>
            <button type="button" :disabled="collegesLoading" @click="openCollegeCreatePanel">新增学院</button>
          </header>

          <section class="panel identity-panel">
            <p v-if="collegesLoading" class="table-state">正在加载学院列表…</p>
            <p v-else-if="managedColleges.length === 0" class="table-state">暂无学院。</p>
            <div v-else class="table-scroll">
              <table class="identity-table college-table"><thead><tr><th>学院名称</th><th>身份数量</th><th>有效身份</th><th>学院状态</th><th>操作</th></tr></thead><tbody>
                <tr v-for="college in managedColleges" :key="college.collegeId"><td>{{ college.name }}</td><td>{{ college.identityCount }}</td><td>{{ college.activeIdentityCount }}</td><td><span class="status-pill" :class="college.status">{{ collegeStatusLabel(college.status) }}</span></td><td class="identity-actions"><button type="button" class="text-button" :disabled="Boolean(collegeActionLoading)" @click="changeCollegeStatus(college)">{{ college.status === "active" ? "停用" : "启用" }}</button></td></tr>
              </tbody></table>
            </div>
          </section>

          <div v-if="showCollegeCreatePanel" class="modal-backdrop" @click.self="closeCollegeCreatePanel">
            <section class="identity-modal" role="dialog" aria-modal="true" aria-labelledby="college-create-title">
              <header class="modal-header"><div><h2 id="college-create-title">新增学院</h2><p>学院编号将由系统自动生成。</p></div><button type="button" class="secondary-button" :disabled="collegeSaving" @click="closeCollegeCreatePanel">关闭</button></header>
              <form class="identity-form" @submit.prevent="createCollege"><label>学院名称<input v-model="collegeName" name="collegeName" maxlength="64" required :disabled="collegeSaving" /></label><button type="submit" :disabled="collegeSaving">{{ collegeSaving ? "创建中…" : "创建学院" }}</button></form>
            </section>
          </div>
        </section>
      </section>
    </section>
  </main>
</template>
