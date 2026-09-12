function studentView(student = {}) {
  return { studentId: typeof student.studentId === "string" ? student.studentId : "", name: typeof student.name === "string" ? student.name : "", studentNo: typeof student.studentNo === "string" ? student.studentNo : "", focusFlag: student.focusFlag === true, focusReason: typeof student.focusReason === "string" ? student.focusReason : "", version: Number.isSafeInteger(student.version) ? student.version : 0 };
}
function errorText(code) { return ({ UNBOUND: "请先完成辅导员身份绑定。", FORBIDDEN: "当前身份无权管理重点关注学生。", ACCOUNT_DISABLED: "当前账号不可用。", CONFLICT: "学生信息已变化，请刷新后重试。", NOT_FOUND: "学生不存在。" })[code] || "操作失败，请稍后重试。"; }

const pageDefinition = {
  data: { keyword: "", searchResults: [], focusedStudents: [], selectedStudent: null, focusReason: "", loading: false, searching: false, saving: false, errorMessage: "" },
  onShow() { this.loadFocusedStudents(); },
  onPullDownRefresh() { this.loadFocusedStudents(true); },
  async loadFocusedStudents(fromPullDown = false) {
    if (this.data.loading) { if (fromPullDown) wx.stopPullDownRefresh(); return; }
    this.setData({ loading: true, errorMessage: "" });
    try {
      const response = await wx.cloud.callFunction({ name: "getCounselorFocusStudents", data: {} });
      const result = response.result || {};
      if (!result.ok) { this.setData({ focusedStudents: [], errorMessage: errorText(result.code) }); return; }
      this.setData({ focusedStudents: (Array.isArray(result.students) ? result.students : []).map((student) => ({ ...studentView(student), focusFlag: true })).filter((student) => student.studentId), errorMessage: "" });
    } catch (error) { this.setData({ focusedStudents: [], errorMessage: "重点关注学生加载失败，请稍后重试。" }); }
    finally { this.setData({ loading: false }); if (fromPullDown) wx.stopPullDownRefresh(); }
  },
  inputKeyword(event) { const keyword = event && event.detail ? event.detail.value : ""; this.setData({ keyword: typeof keyword === "string" ? keyword : "" }); },
  inputReason(event) { const focusReason = event && event.detail ? event.detail.value : ""; this.setData({ focusReason: typeof focusReason === "string" ? focusReason : "" }); },
  async searchStudents() {
    const keyword = this.data.keyword.trim();
    if (!keyword || this.data.searching) { if (!keyword) wx.showToast({ title: "请输入姓名或学号", icon: "none" }); return; }
    this.setData({ searching: true, searchResults: [] });
    try {
      const response = await wx.cloud.callFunction({ name: "searchCounselorStudents", data: { keyword } });
      const result = response.result || {};
      if (!result.ok) { wx.showToast({ title: errorText(result.code), icon: "none" }); return; }
      this.setData({ searchResults: (Array.isArray(result.students) ? result.students : []).map(studentView).filter((student) => student.studentId) });
    } catch (error) { wx.showToast({ title: "搜索失败，请稍后重试", icon: "none" }); }
    finally { this.setData({ searching: false }); }
  },
  selectStudent(event) {
    const studentId = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.studentId : "";
    const student = this.data.searchResults.find((item) => item.studentId === studentId) || this.data.focusedStudents.find((item) => item.studentId === studentId);
    if (!student) return;
    this.setData({ selectedStudent: student, focusReason: student.focusReason || "" });
  },
  async saveFocus() {
    const student = this.data.selectedStudent;
    const focusReason = this.data.focusReason.trim();
    if (!student || this.data.saving) return;
    if (!focusReason) { wx.showToast({ title: "请填写关注原因", icon: "none" }); return; }
    this.setData({ saving: true });
    try {
      const response = await wx.cloud.callFunction({ name: "setCounselorStudentFocus", data: { studentId: student.studentId, focusFlag: true, focusReason, expectedVersion: student.version } });
      const result = response.result || {};
      if (!result.ok) { wx.showToast({ title: errorText(result.code), icon: "none" }); return; }
      wx.showToast({ title: "已保存重点关注", icon: "success" });
      this.setData({ selectedStudent: null, focusReason: "", searchResults: [] });
      await this.loadFocusedStudents();
    } catch (error) { wx.showToast({ title: "保存失败，请稍后重试", icon: "none" }); }
    finally { this.setData({ saving: false }); }
  },
  cancelFocus() {
    const student = this.data.selectedStudent;
    if (!student || !student.focusFlag || this.data.saving) return;
    wx.showModal({ title: "取消重点关注", content: `确认取消对“${student.name}”的重点关注吗？`, success: async (modal) => { if (!modal.confirm) return; await this.updateFocusToFalse(student); } });
  },
  async updateFocusToFalse(student) {
    this.setData({ saving: true });
    try {
      const response = await wx.cloud.callFunction({ name: "setCounselorStudentFocus", data: { studentId: student.studentId, focusFlag: false, focusReason: "", expectedVersion: student.version } });
      const result = response.result || {};
      if (!result.ok) { wx.showToast({ title: errorText(result.code), icon: "none" }); return; }
      wx.showToast({ title: "已取消重点关注", icon: "success" });
      this.setData({ selectedStudent: null, focusReason: "", searchResults: [] });
      await this.loadFocusedStudents();
    } catch (error) { wx.showToast({ title: "操作失败，请稍后重试", icon: "none" }); }
    finally { this.setData({ saving: false }); }
  },
};

Page(pageDefinition);
if (typeof module !== "undefined") module.exports = { __testables: { errorText, pageDefinition, studentView } };
