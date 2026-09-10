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
const isAuthenticated = computed(() => profile.value !== null);
const canDispatch = computed(() => createdAlert.value?.status === "pending_dispatch");

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
    message.value = "";
  } catch (error) {
    handleApiError(error);
  } finally {
    sessionLoading.value = false;
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

    <section v-else class="workbench" aria-labelledby="page-title">
      <header class="workbench-header">
        <div>
          <p class="eyebrow">校园反诈安全管理系统</p>
          <h1 id="page-title">保卫处工作台</h1>
        </div>
        <div class="user-actions">
          <p class="current-user">当前用户：{{ profile.name }}（{{ profile.role }}）</p>
          <button type="button" class="secondary-button" @click="logout">退出登录</button>
        </div>
      </header>

      <p v-if="message" class="message workbench-message" role="status">{{ message }}</p>
      <p v-if="successMessage" class="success-message" role="status">{{ successMessage }}</p>

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
          <div>
            <dt>预警 ID</dt>
            <dd class="breakable">{{ createdAlert.alertId }}</dd>
          </div>
          <div>
            <dt>诈骗类型</dt>
            <dd>{{ fraudTypeLabel(createdAlert.fraudType) }}</dd>
          </div>
          <div>
            <dt>风险等级</dt>
            <dd>{{ riskLevelLabel(createdAlert.riskLevel) }}</dd>
          </div>
          <div>
            <dt>风险原因</dt>
            <dd>
              <span v-if="createdAlert.riskReasons.length === 0">无</span>
              <ul v-else class="reason-list">
                <li v-for="reason in createdAlert.riskReasons" :key="reason">{{ reason }}</li>
              </ul>
            </dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{{ statusLabel(createdAlert.status) }}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>{{ createdAlert.version }}</dd>
          </div>
        </dl>
      </section>
    </section>
  </main>
</template>
