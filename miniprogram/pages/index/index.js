const ROLE_LABELS = Object.freeze({
  student: "学生",
  counselor: "辅导员",
});

const SESSION_MESSAGES = Object.freeze({
  UNBOUND: "当前微信尚未绑定身份，请完成演示身份绑定后继续。",
  FORBIDDEN: "当前身份不能使用小程序工作台。",
  ACCOUNT_DISABLED: "当前账号不可用，请联系管理员。",
  INTERNAL_ERROR: "身份信息加载失败，请稍后重试。",
});

const SWITCH_MESSAGES = Object.freeze({
  SWITCH_DISABLED: "当前环境未开启演示身份切换。",
  INVALID_INPUT: "可切换身份无效。",
  UNBOUND: "当前微信尚未绑定演示身份。",
  FORBIDDEN: "当前身份不允许演示切换。",
  ACCOUNT_DISABLED: "目标账号当前不可用。",
  NOT_FOUND: "未找到目标演示身份。",
  CONFLICT: "身份状态已变化，请刷新后重试。",
  INTERNAL_ERROR: "身份切换失败，请稍后重试。",
});

const DEMO_IDENTITIES = Object.freeze({
  student: Object.freeze({ userId: "usr_student_demo_001", collegeId: "college_cs" }),
  counselor: Object.freeze({ userId: "usr_counselor_demo_001", collegeId: "college_cs" }),
});

// UI-only labels from the reviewed demo colleges seed. Authorization always uses the
// server-resolved collegeId and never this display mapping.
const DEMO_COLLEGE_DISPLAY_NAMES = Object.freeze({
  college_cs: "计算机学院",
});

const REPORT_STATUS_LABELS = Object.freeze({
  pending_counselor_verify: "待辅导员核实",
  pending_security_verify: "待保卫处核验",
  in_process: "处理中",
  closed: "已结案",
});

const COUNSELOR_STATUS_LABELS = Object.freeze({
  pending_counselor_verify: "待核验",
  pending_security_verify: "已转保卫处",
  in_process: "跟进中",
  closed: "已完成",
});

function messageFor(messages, code, fallback) {
  return messages[code] || fallback;
}

function normalizeProfile(profile = {}) {
  if (!profile || typeof profile !== "object" || !ROLE_LABELS[profile.role] ||
    typeof profile.userId !== "string" || !profile.userId ||
    typeof profile.name !== "string" || !profile.name.trim()) {
    return null;
  }
  const collegeId = typeof profile.collegeId === "string" && profile.collegeId.trim() ? profile.collegeId.trim() : "";
  const collegeName = typeof profile.collegeName === "string" && profile.collegeName.trim()
    ? profile.collegeName.trim()
    : (DEMO_COLLEGE_DISPLAY_NAMES[collegeId] || "");
  return {
    userId: profile.userId,
    role: profile.role,
    roleText: ROLE_LABELS[profile.role],
    name: profile.name.trim(),
    collegeId,
    collegeName,
    focusFlag: profile.focusFlag === true,
  };
}

function isDemoIdentityCandidate(profile) {
  if (!profile || !DEMO_IDENTITIES[profile.role]) return false;
  const expected = DEMO_IDENTITIES[profile.role];
  return profile.userId === expected.userId && profile.collegeId === expected.collegeId;
}

function sameProfile(left, right) {
  return Boolean(left) && Boolean(right) && left.userId === right.userId && left.role === right.role;
}

function buildStudentSummary(alerts) {
  const rows = Array.isArray(alerts) ? alerts.filter((alert) => alert && typeof alert === "object") : [];
  return {
    highRiskCount: rows.filter((alert) => alert.riskLevel === "high").length,
    pendingAlertCount: rows.filter((alert) => alert.status === "sent").length,
    followingAlertCount: rows.filter((alert) => alert.status === "following_up").length,
    reportCountText: "—",
    reportHint: "现有服务暂未提供我的工单汇总",
  };
}

function buildCounselorSummary(reports) {
  const rows = Array.isArray(reports) ? reports.filter((report) => report && typeof report === "object") : [];
  return {
    pendingVerifyCount: rows.length,
    highRiskCount: rows.filter((report) => report.riskLevel === "high").length,
    followingCountText: "—",
    recordCountText: "—",
    unavailableHint: "现有服务暂未提供聚合数据",
  };
}

function statusTextForStudent(status) {
  return REPORT_STATUS_LABELS[status] || "状态待更新";
}

function statusTextForCounselor(status) {
  return COUNSELOR_STATUS_LABELS[status] || "状态待更新";
}

function isSwitchTarget(targetRole) {
  return targetRole === "student" || targetRole === "counselor";
}

const pageDefinition = {
  data: {
    sessionLoading: false,
    sessionCode: "",
    profile: null,
    message: "",
    demoSwitchAvailable: false,
    identitySwitchLoading: false,
    switchSheetVisible: false,
    workbenchLoading: false,
    workbenchNotice: "",
    studentSummary: buildStudentSummary([]),
    counselorSummary: buildCounselorSummary([]),
    studentStatusPreview: "待同步",
    counselorProgressStatus: statusTextForCounselor("in_process"),
  },

  onLoad() {
    this.refreshSession();
  },

  onPullDownRefresh() {
    this.refreshSession().finally(() => wx.stopPullDownRefresh());
  },

  refreshSession(options = {}) {
    const force = options && options.force === true;
    const activeRefresh = this._sessionRefreshPromise;
    if (activeRefresh && !force) return activeRefresh;

    const runRefresh = async () => {
      if (activeRefresh && force) {
        try {
          await activeRefresh;
        } catch (error) {
          // performSessionRefresh handles errors itself; keep a forced refresh independent.
        }
      }
      return this.performSessionRefresh();
    };
    const refreshPromise = runRefresh();
    this._sessionRefreshPromise = refreshPromise;
    return refreshPromise.finally(() => {
      if (this._sessionRefreshPromise === refreshPromise) this._sessionRefreshPromise = null;
    });
  },

  async performSessionRefresh() {
    this.setData({
      sessionLoading: true,
      sessionCode: "",
      message: "正在加载身份信息…",
      workbenchNotice: "",
    });
    try {
      const response = await wx.cloud.callFunction({ name: "getMiniProgramSession" });
      const result = response.result || {};
      const code = result.code || "INTERNAL_ERROR";
      const profile = code === "BOUND" ? normalizeProfile(result.profile) : null;
      if (!profile) {
        this.setData({
          sessionCode: code === "BOUND" ? "INTERNAL_ERROR" : code,
          profile: null,
          demoSwitchAvailable: false,
          switchSheetVisible: false,
          message: code === "BOUND" ? SESSION_MESSAGES.INTERNAL_ERROR : messageFor(SESSION_MESSAGES, code, SESSION_MESSAGES.INTERNAL_ERROR),
          studentSummary: buildStudentSummary([]),
          counselorSummary: buildCounselorSummary([]),
        });
        return false;
      }

      this.setData({
        sessionCode: "BOUND",
        profile,
        message: "",
        demoSwitchAvailable: false,
        switchSheetVisible: false,
      });
      await Promise.all([
        this.checkDemoSwitchAvailability(profile),
        this.loadWorkbenchData(profile),
      ]);
      return sameProfile(this.data.profile, profile);
    } catch (error) {
      this.setData({
        sessionCode: "INTERNAL_ERROR",
        profile: null,
        demoSwitchAvailable: false,
        switchSheetVisible: false,
        message: SESSION_MESSAGES.INTERNAL_ERROR,
        studentSummary: buildStudentSummary([]),
        counselorSummary: buildCounselorSummary([]),
      });
      return false;
    } finally {
      this.setData({ sessionLoading: false });
    }
  },

  async checkDemoSwitchAvailability(profile) {
    if (!isDemoIdentityCandidate(profile)) {
      if (sameProfile(this.data.profile, profile)) this.setData({ demoSwitchAvailable: false });
      return false;
    }
    try {
      // The same-role request is an existing, no-write ALREADY_ACTIVE verification path.
      const response = await wx.cloud.callFunction({
        name: "switchDemoMiniProgramIdentity",
        data: { targetRole: profile.role },
      });
      const result = response.result || {};
      const available = result.ok === true && result.code === "ALREADY_ACTIVE";
      if (sameProfile(this.data.profile, profile)) this.setData({ demoSwitchAvailable: available });
      return available;
    } catch (error) {
      if (sameProfile(this.data.profile, profile)) this.setData({ demoSwitchAvailable: false });
      return false;
    }
  },

  async loadWorkbenchData(profile) {
    if (!profile || !ROLE_LABELS[profile.role]) return;
    this.setData({ workbenchLoading: true, workbenchNotice: "" });
    const functionName = profile.role === "student" ? "getStudentAlerts" : "getCounselorReports";
    try {
      const response = await wx.cloud.callFunction({ name: functionName, data: {} });
      const result = response.result || {};
      if (!result.ok || !sameProfile(this.data.profile, profile)) {
        if (sameProfile(this.data.profile, profile)) this.setData({ workbenchNotice: "工作台数据暂时无法加载，请下拉刷新重试。" });
        return;
      }
      if (profile.role === "student") {
        this.setData({ studentSummary: buildStudentSummary(result.alerts) });
      } else {
        this.setData({ counselorSummary: buildCounselorSummary(result.reports) });
      }
    } catch (error) {
      if (sameProfile(this.data.profile, profile)) this.setData({ workbenchNotice: "工作台数据暂时无法加载，请下拉刷新重试。" });
    } finally {
      if (sameProfile(this.data.profile, profile)) this.setData({ workbenchLoading: false });
    }
  },

  openSwitchSheet() {
    if (!this.data.demoSwitchAvailable || !this.data.profile || this.data.identitySwitchLoading) return;
    this.setData({ switchSheetVisible: true });
  },

  closeSwitchSheet() {
    if (this.data.identitySwitchLoading) return;
    this.setData({ switchSheetVisible: false });
  },

  preventTap() {},

  async switchDemoIdentity(event) {
    const targetRole = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.targetRole;
    const previousProfile = this.data.profile;
    if (!isSwitchTarget(targetRole) || !previousProfile || !this.data.demoSwitchAvailable || this.data.identitySwitchLoading) return;

    this.setData({ identitySwitchLoading: true, switchSheetVisible: false });
    try {
      const response = await wx.cloud.callFunction({
        name: "switchDemoMiniProgramIdentity",
        data: { targetRole },
      });
      const result = response.result || {};
      if (!result.ok || (result.code !== "IDENTITY_SWITCHED" && result.code !== "ALREADY_ACTIVE")) {
        wx.showToast({ title: messageFor(SWITCH_MESSAGES, result.code, SWITCH_MESSAGES.INTERNAL_ERROR), icon: "none" });
        return;
      }

      const sessionLoaded = await this.refreshSession({ force: true });
      const targetConfirmed = sessionLoaded && this.data.profile && this.data.profile.role === targetRole;
      if (targetConfirmed) {
        wx.showToast({ title: result.code === "ALREADY_ACTIVE" ? "当前已是该身份" : "身份切换成功", icon: "success" });
      } else {
        wx.showToast({ title: "身份更新未确认，请重新进入工作台", icon: "none" });
      }
    } catch (error) {
      const sessionLoaded = await this.refreshSession({ force: true });
      wx.showToast({ title: sessionLoaded ? "切换结果未知，已刷新身份" : "切换状态未确认，请重新进入工作台", icon: "none" });
    } finally {
      this.setData({ identitySwitchLoading: false });
    }
  },

  goToStudentAlerts() {
    if (!this.data.profile || this.data.profile.role !== "student") return;
    wx.navigateTo({ url: "/pages/alerts/index/index" });
  },

  goToStudentReport() {
    if (!this.data.profile || this.data.profile.role !== "student") return;
    wx.navigateTo({ url: "/pages/reports/create/index" });
  },

  goToCounselorReports() {
    if (!this.data.profile || this.data.profile.role !== "counselor") return;
    wx.navigateTo({ url: "/pages/counselor/reports/index" });
  },

  showUnavailable() {
    wx.showToast({ title: "现有服务暂未提供该数据入口", icon: "none" });
  },

};

Page(pageDefinition);

if (typeof module !== "undefined") {
  module.exports = {
    __testables: {
      DEMO_IDENTITIES,
      REPORT_STATUS_LABELS,
      COUNSELOR_STATUS_LABELS,
      buildCounselorSummary,
      buildStudentSummary,
      isDemoIdentityCandidate,
      isSwitchTarget,
      normalizeProfile,
      DEMO_COLLEGE_DISPLAY_NAMES,
      pageDefinition,
      sameProfile,
      statusTextForCounselor,
      statusTextForStudent,
    },
  };
}
