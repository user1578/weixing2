const CODE_MESSAGES = {
  UNBOUND: "当前微信尚未绑定演示身份",
  BOUND: "当前微信已绑定演示身份",
  ALREADY_BOUND: "当前微信已绑定演示身份",
  BINDING_DISABLED: "当前环境未开启演示身份绑定",
  INVALID_INPUT: "请输入有效的角色、身份编号和姓名",
  IDENTITY_NOT_FOUND: "未找到对应的演示身份档案",
  IDENTITY_MISMATCH: "身份信息不匹配",
  ACCOUNT_DISABLED: "账号当前不可用",
  ACCOUNT_ALREADY_BOUND: "该身份档案已绑定其他微信",
  CONFLICT: "身份状态已变化，请刷新后重试",
  WECHAT_ALREADY_BOUND: "当前微信已绑定其他身份",
  FORBIDDEN: "当前操作不被允许",
  INTERNAL_ERROR: "服务暂时不可用，请稍后重试",
};

function messageFor(code) {
  return CODE_MESSAGES[code] || "操作未完成，请稍后重试";
}

function toProfile(profile = {}) {
  return {
    userId: profile.userId,
    role: profile.role,
    name: profile.name,
    collegeId: profile.collegeId,
    focusFlag: profile.focusFlag,
  };
}

Page({
  data: {
    pingResult: null,
    pingError: null,
    sessionLoading: false,
    bindLoading: false,
    sessionCode: "",
    profile: null,
    bindCode: "",
    message: "",
    role: "student",
    roleIndex: 0,
    roleOptions: ["student", "counselor"],
    identityNo: "",
    name: "",
  },

  onLoad() {
    this.checkIdentityStatus();
  },

  testCloudbaseConnection() {
    wx.showLoading({ title: "连接中", mask: true });
    wx.cloud.callFunction({ name: "ping" })
      .then((response) => {
        const { ok, message, envId } = response.result || {};
        this.setData({ pingResult: { ok, message, envId }, pingError: null });
      })
      .catch((error) => {
        this.setData({ pingResult: null, pingError: { errCode: error.errCode, errMsg: error.errMsg } });
      })
      .finally(() => wx.hideLoading());
  },

  async checkIdentityStatus() {
    if (this.data.sessionLoading) return;
    this.setData({ sessionLoading: true, sessionCode: "", profile: null, message: "正在检查身份状态" });
    try {
      const response = await wx.cloud.callFunction({ name: "getMiniProgramSession" });
      const result = response.result || {};
      const code = result.code || "INTERNAL_ERROR";
      this.setData({ sessionCode: code, profile: code === "BOUND" ? toProfile(result.profile) : null, message: messageFor(code) });
    } catch (error) {
      this.setData({ sessionCode: "INTERNAL_ERROR", profile: null, message: messageFor("INTERNAL_ERROR") });
    } finally {
      this.setData({ sessionLoading: false });
    }
  },

  onRoleChange(event) {
    const roleIndex = Number(event.detail.value);
    this.setData({ roleIndex, role: this.data.roleOptions[roleIndex] });
  },

  onIdentityNoInput(event) {
    this.setData({ identityNo: event.detail.value });
  },

  onNameInput(event) {
    this.setData({ name: event.detail.value });
  },

  async bindIdentity() {
    if (this.data.bindLoading || this.data.sessionLoading) return;
    const role = this.data.role;
    const identityNo = this.data.identityNo.trim();
    const name = this.data.name.trim();
    if (!identityNo || !name) {
      this.setData({ bindCode: "INVALID_INPUT", message: messageFor("INVALID_INPUT") });
      return;
    }

    this.setData({ bindLoading: true, bindCode: "", message: "正在绑定演示身份" });
    try {
      const response = await wx.cloud.callFunction({ name: "bindMiniProgramIdentity", data: { role, identityNo, name } });
      const result = response.result || {};
      const code = result.code || "INTERNAL_ERROR";
      this.setData({ bindCode: code, message: messageFor(code) });
      if (code === "BOUND" || code === "ALREADY_BOUND") await this.checkIdentityStatus();
    } catch (error) {
      this.setData({ bindCode: "INTERNAL_ERROR", message: messageFor("INTERNAL_ERROR") });
    } finally {
      this.setData({ bindLoading: false });
    }
  },
});
