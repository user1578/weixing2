<script setup>
import { computed, onMounted, ref } from "vue";

const SESSION_TOKEN_KEY = "securitySessionToken";
const apiBaseUrl = (import.meta.env.VITE_SECURITY_API_BASE_URL || "").replace(/\/+$/, "");

const loginName = ref("");
const password = ref("");
const profile = ref(null);
const loading = ref(false);
const message = ref("");
const isAuthenticated = computed(() => profile.value !== null);

const CODE_MESSAGES = {
  INVALID_INPUT: "请输入有效的登录名和密码。",
  AUTH_FAILED: "登录名或密码不正确。",
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

function requireApiBaseUrl() {
  if (apiBaseUrl) return true;
  message.value = "未配置服务地址，请联系管理员。";
  return false;
}

async function readApiResponse(response) {
  const payload = await response.json().catch(() => ({ code: "INTERNAL_ERROR" }));
  if (!response.ok || payload.ok !== true) {
    throw new ApiError(payload.code || "INTERNAL_ERROR");
  }
  return payload;
}

async function loadSession() {
  const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
  if (!token || !requireApiBaseUrl()) return;

  loading.value = true;
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
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    profile.value = null;
    message.value = messageFor(error instanceof ApiError ? error.code : "INTERNAL_ERROR");
  } finally {
    loading.value = false;
  }
}

async function login() {
  if (loading.value || !requireApiBaseUrl()) return;

  loading.value = true;
  message.value = "";
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
    profile.value = null;
    message.value = messageFor(error instanceof ApiError ? error.code : "INTERNAL_ERROR");
  } finally {
    loading.value = false;
  }
}

function logout() {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  profile.value = null;
  password.value = "";
  message.value = "已退出登录。";
}

onMounted(() => {
  void loadSession();
});
</script>

<template>
  <main class="page-shell">
    <section class="auth-card" aria-labelledby="page-title">
      <p class="eyebrow">校园反诈安全管理系统</p>
      <h1 id="page-title">保卫处登录</h1>

      <form v-if="!isAuthenticated" class="login-form" @submit.prevent="login">
        <label>
          登录名
          <input v-model="loginName" name="loginName" autocomplete="username" required :disabled="loading" />
        </label>

        <label>
          密码
          <input
            v-model="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            :disabled="loading"
          />
        </label>

        <button type="submit" :disabled="loading">
          {{ loading ? "登录中…" : "登录" }}
        </button>
      </form>

      <section v-else class="session-panel" aria-live="polite">
        <h2>会话已确认</h2>
        <dl>
          <div>
            <dt>姓名</dt>
            <dd>{{ profile.name }}</dd>
          </div>
          <div>
            <dt>角色</dt>
            <dd>{{ profile.role }}</dd>
          </div>
        </dl>
        <button type="button" class="secondary-button" @click="logout">退出登录</button>
      </section>

      <p v-if="message" class="message" role="status">{{ message }}</p>
    </section>
  </main>
</template>
