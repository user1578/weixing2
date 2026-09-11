const ERROR_MESSAGES = Object.freeze({
  BINDING_DISABLED: "当前环境暂未开放身份绑定。",
  IDENTITY_NOT_FOUND: "未找到管理员预分配的身份档案。",
  IDENTITY_MISMATCH: "身份编号与姓名不匹配。",
  ACCOUNT_DISABLED: "该身份当前不可用，请联系管理员。",
  ACCOUNT_ALREADY_BOUND: "该身份已绑定其他微信。",
  WECHAT_ALREADY_BOUND: "当前微信已绑定其他身份。",
  CONFLICT: "身份状态已变化，请重新验证。",
  FORBIDDEN: "该身份不能使用小程序。",
  INTERNAL_ERROR: "身份验证失败，请稍后重试。",
});

function buildBindingData(identityNo, name) {
  if (typeof identityNo !== "string" || typeof name !== "string") return null;
  const normalizedIdentityNo = identityNo.trim();
  const normalizedName = name.trim();
  if (!normalizedIdentityNo || !normalizedName) return null;
  return { identityNo: normalizedIdentityNo, name: normalizedName };
}

function messageFor(code) {
  return ERROR_MESSAGES[code] || ERROR_MESSAGES.INTERNAL_ERROR;
}

const pageDefinition = {
  data: {
    identityNo: "",
    name: "",
    submitting: false,
    errorMessage: "",
  },

  onFieldInput(event) {
    const field = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.field;
    if (field !== "identityNo" && field !== "name") return;
    this.setData({ [field]: event.detail.value });
  },

  async submitBinding() {
    if (this.data.submitting) return;
    const data = buildBindingData(this.data.identityNo, this.data.name);
    if (!data) {
      this.setData({ errorMessage: "请填写身份编号和姓名。" });
      return;
    }

    this.setData({ submitting: true, errorMessage: "" });
    try {
      const response = await wx.cloud.callFunction({ name: "bindMiniProgramIdentity", data });
      const result = response.result || {};
      if (result.ok && (result.code === "BOUND" || result.code === "ALREADY_BOUND")) {
        wx.reLaunch({ url: "/pages/index/index" });
        return;
      }
      this.setData({ errorMessage: messageFor(result.code) });
    } catch (error) {
      this.setData({ errorMessage: ERROR_MESSAGES.INTERNAL_ERROR });
    } finally {
      this.setData({ submitting: false });
    }
  },
};

if (typeof Page === "function") Page(pageDefinition);

if (typeof module !== "undefined") {
  module.exports = { __testables: { buildBindingData, messageFor, pageDefinition } };
}
