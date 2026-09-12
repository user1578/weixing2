const ROLE_LABELS = Object.freeze({
  student: "学生",
  counselor: "辅导员",
});

const SESSION_MESSAGES = Object.freeze({
  UNBOUND: "当前微信尚未绑定身份，请验证管理员预分配的身份后继续。",
  FORBIDDEN: "当前身份不能使用小程序工作台。",
  ACCOUNT_DISABLED: "当前账号不可用，请联系管理员。",
  INTERNAL_ERROR: "身份信息加载失败，请稍后重试。",
});

// UI-only labels from the reviewed colleges seed. Authorization always uses the
// server-resolved collegeId and never this display mapping.
const COLLEGE_DISPLAY_NAMES = Object.freeze({
  college_cs: "计算机科学学院",
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

const ACTIVE_REPORT_STATUSES = new Set([
  "pending_counselor_verify",
  "pending_security_verify",
  "in_process",
]);

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
    : (COLLEGE_DISPLAY_NAMES[collegeId] || "");
  return {
    userId: profile.userId,
    role: profile.role,
    roleText: ROLE_LABELS[profile.role],
    name: profile.name.trim(),
    collegeId,
    collegeName,
  };
}

function sameProfile(left, right) {
  return Boolean(left) && Boolean(right) && left.userId === right.userId && left.role === right.role;
}

function buildStudentSummary(alerts, reports = []) {
  const rows = Array.isArray(alerts) ? alerts.filter((alert) => alert && typeof alert === "object") : [];
  const reportRows = Array.isArray(reports) ? reports.filter((report) => report && typeof report === "object") : [];
  const activeReportCount = reportRows.filter((report) => ACTIVE_REPORT_STATUSES.has(report.status)).length;
  return {
    highRiskCount: rows.filter((alert) => alert.riskLevel === "high").length,
    pendingAlertCount: rows.filter((alert) => alert.status === "sent").length,
    followingAlertCount: rows.filter((alert) => alert.status === "following_up").length,
    reportCountText: String(reportRows.length),
    activeReportCountText: String(activeReportCount),
    reportHint: "当前仍在处理中的工单",
  };
}

function buildCounselorSummary(reports, following = [], history = []) {
  const rows = Array.isArray(reports) ? reports.filter((report) => report && typeof report === "object") : [];
  const followingRows = Array.isArray(following) ? following.filter((report) => report && typeof report === "object") : [];
  const historyRows = Array.isArray(history) ? history.filter((report) => report && typeof report === "object") : [];
  return {
    pendingVerifyCount: rows.length,
    highRiskCount: rows.filter((report) => report.riskLevel === "high").length,
    followingCountText: String(followingRows.length),
    recordCountText: String(historyRows.length),
    unavailableHint: `工单记录 ${historyRows.length} 项`,
  };
}

function statusTextForStudent(status) {
  return REPORT_STATUS_LABELS[status] || "状态待更新";
}

function statusTextForCounselor(status) {
  return COUNSELOR_STATUS_LABELS[status] || "状态待更新";
}

const pageDefinition = {
  data: {
    sessionLoading: false,
    sessionCode: "",
    profile: null,
    message: "",
    workbenchLoading: false,
    workbenchNotice: "",
    studentSummary: buildStudentSummary([]),
    counselorSummary: buildCounselorSummary([]),
    studentStatusPreview: "待同步",
    counselorProgressStatus: statusTextForCounselor("in_process"),
  },

  onShow() {
    return this.refreshSession();
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
      });
      await this.loadWorkbenchData(profile);
      return sameProfile(this.data.profile, profile);
    } catch (error) {
      this.setData({
        sessionCode: "INTERNAL_ERROR",
        profile: null,
        message: SESSION_MESSAGES.INTERNAL_ERROR,
        studentSummary: buildStudentSummary([]),
        counselorSummary: buildCounselorSummary([]),
      });
      return false;
    } finally {
      this.setData({ sessionLoading: false });
    }
  },

  async loadWorkbenchData(profile) {
    if (!profile || !ROLE_LABELS[profile.role]) return;
    this.setData({ workbenchLoading: true, workbenchNotice: "" });
    try {
      const responses = profile.role === "student"
        ? await Promise.all([wx.cloud.callFunction({ name: "getStudentAlerts", data: {} }), wx.cloud.callFunction({ name: "getStudentReports", data: {} })])
        : await Promise.all([
          wx.cloud.callFunction({ name: "getCounselorReports", data: { scope: "pending" } }),
          wx.cloud.callFunction({ name: "getCounselorReports", data: { scope: "following" } }),
          wx.cloud.callFunction({ name: "getCounselorReports", data: { scope: "history" } }),
        ]);
      const results = responses.map((response) => response.result || {});
      if (results.some((result) => !result.ok) || !sameProfile(this.data.profile, profile)) {
        if (sameProfile(this.data.profile, profile)) this.setData({ workbenchNotice: "工作台数据暂时无法加载，请下拉刷新重试。" });
        return;
      }
      if (profile.role === "student") {
        this.setData({ studentSummary: buildStudentSummary(results[0].alerts, results[1].reports) });
      } else {
        this.setData({ counselorSummary: buildCounselorSummary(results[0].reports, results[1].reports, results[2].reports) });
      }
    } catch (error) {
      if (sameProfile(this.data.profile, profile)) this.setData({ workbenchNotice: "工作台数据暂时无法加载，请下拉刷新重试。" });
    } finally {
      if (sameProfile(this.data.profile, profile)) this.setData({ workbenchLoading: false });
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

  goToStudentReports() {
    if (!this.data.profile || this.data.profile.role !== "student") return;
    wx.navigateTo({ url: "/pages/reports/mine/index" });
  },

  goToLearning() {
    if (!this.data.profile || this.data.profile.role !== "student") return;
    wx.navigateTo({ url: "/pages/learning/index/index" });
  },

  goToQuiz() {
    if (!this.data.profile || this.data.profile.role !== "student") return;
    wx.navigateTo({ url: "/pages/quiz/index/index" });
  },

  goToCounselorReports(event) {
    if (!this.data.profile || this.data.profile.role !== "counselor") return;
    const scope = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.scope : "pending";
    wx.navigateTo({ url: `/pages/counselor/reports/index?scope=${scope === "following" || scope === "history" ? scope : "pending"}` });
  },

  goToCounselorFocus() {
    if (!this.data.profile || this.data.profile.role !== "counselor") return;
    wx.navigateTo({ url: "/pages/counselor/focus/index" });
  },

  goToBinding() {
    wx.navigateTo({ url: "/pages/bind/index" });
  },

};

Page(pageDefinition);

if (typeof module !== "undefined") {
  module.exports = {
    __testables: {
      REPORT_STATUS_LABELS,
      ACTIVE_REPORT_STATUSES,
      COUNSELOR_STATUS_LABELS,
      buildCounselorSummary,
      buildStudentSummary,
      normalizeProfile,
      COLLEGE_DISPLAY_NAMES,
      pageDefinition,
      sameProfile,
      statusTextForCounselor,
      statusTextForStudent,
    },
  };
}
