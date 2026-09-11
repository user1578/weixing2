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
const STATUS_LABELS = { pending_dispatch: "待下发", sent: "已下发" };
const TOKEN_ERROR_CODES = new Set(["TOKEN_MISSING", "TOKEN_INVALID", "TOKEN_EXPIRED"]);
const IDENTITY_ROLE_LABELS = { student: "学生", counselor: "辅导员" };
const IDENTITY_BIND_STATUS_LABELS = { bound: "已绑定", unbound: "未绑定" };
const IDENTITY_STATUS_LABELS = { active: "正常", suspended: "已停用" };

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
  activeView.value = "dashboard";
  showIdentityCreatePanel.value = false;
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
  if (view === "identities") void loadIdentities();
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
  } catch (error) {
    handleApiError(error);
  } finally {
    sessionLoading.value = false;
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

        <section v-if="activeView === 'dashboard'" class="panel welcome-panel" aria-labelledby="dashboard-title">
          <p class="eyebrow">工作台</p>
          <h2 id="dashboard-title">欢迎回来，{{ profile.name }}</h2>
          <p>从左侧导航进入预警、工单或身份管理。</p>
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

        <section v-else-if="activeView === 'reports'" class="panel welcome-panel" aria-labelledby="reports-title">
          <p class="eyebrow">工单管理</p>
          <h2 id="reports-title">功能完善中</h2>
          <p>本轮不展示或伪造任何工单数据。</p>
        </section>

        <section v-else class="identity-page" aria-labelledby="identities-title">
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
      </section>
    </section>
  </main>
</template>
