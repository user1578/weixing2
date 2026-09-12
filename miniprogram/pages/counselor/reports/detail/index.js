const FRAUD_TYPES = Object.freeze({ part_time_scam: "刷单返利诈骗", impersonate_public: "冒充公检法诈骗", fake_loan: "虚假贷款诈骗", fake_refund: "冒充客服退款", other: "其他诈骗" });
const RISKS = Object.freeze({ low: "低风险", medium: "中风险", high: "高风险" });
const STATUSES = Object.freeze({ pending_counselor_verify: "待核验", pending_security_verify: "已转保卫处", in_process: "处理中", closed: "已结案" });
const RESULTS = ["confirmed", "suspected", "misreport", "consultation", "not_fraud"];
function dateText(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(); }
function reportView(report = {}) { return { ...report, fraudTypeText: FRAUD_TYPES[report.fraudType] || "未知诈骗类型", riskText: RISKS[report.riskLevel] || "风险待评估", statusText: STATUSES[report.status] || "状态待更新", incidentAtText: dateText(report.incidentAt), submittedAtText: dateText(report.submittedAt), hasLossText: report.hasLoss ? "是" : "否" }; }
function responseError(result) { return result && result.message ? result.message : "操作未完成，请刷新后重试。"; }

const pageDefinition = {
  data: { report: null, workflow: null, loading: false, errorMessage: "", actionMode: "", saving: false, resultOptions: RESULTS, form: { opinion: "", contactedAt: new Date().toISOString(), contactMethod: "phone", verificationResult: "suspected", transferReason: "", closeReason: "" } },
  onLoad(query) { this.reportId = query && typeof query.reportId === "string" ? query.reportId : ""; this.loadDetail(); },
  onShow() { if (this.reportId) this.loadDetail(); },
  async loadDetail() {
    if (!this.reportId || this.data.loading) return;
    this.setData({ loading:true, errorMessage:"" });
    try { const response=await wx.cloud.callFunction({name:"getCounselorReportDetail",data:{reportId:this.reportId}}); const result=response.result||{}; if (!result.ok || !result.report) { this.setData({report:null,workflow:null,errorMessage:responseError(result)}); return; } this.setData({report:reportView(result.report),workflow:result.workflow||null,actionMode:""}); }
    catch(error) { this.setData({errorMessage:"工单详情加载失败，请稍后重试。"}); }
    finally { this.setData({loading:false}); }
  },
  chooseAction(event) { this.setData({ actionMode:event.currentTarget.dataset.mode || "", errorMessage:"" }); },
  cancelAction() { if (!this.data.saving) this.setData({actionMode:""}); },
  updateField(event) { const key=event.currentTarget.dataset.key; if (key) this.setData({[`form.${key}`]:event.detail.value}); },
  selectContactMethod(event) { const values = ["phone", "wechat", "in_person", "other"]; this.setData({"form.contactMethod": values[Number(event.detail.value)] || "phone"}); },
  selectResult(event) { const index=Number(event.detail.value); this.setData({"form.verificationResult": RESULTS[index] || RESULTS[0]}); },
  async callAction(name, data) { if (this.data.saving) return; this.setData({saving:true,errorMessage:""}); try { const response=await wx.cloud.callFunction({name,data}); const result=response.result||{}; if (!result.ok) { this.setData({errorMessage:responseError(result)}); return; } wx.showToast({title:"操作成功",icon:"success"}); await this.loadDetail(); } catch(error) { this.setData({errorMessage:"操作失败，请稍后重试。"}); } finally {this.setData({saving:false});} },
  startFollowup() { const report=this.data.report; if (!report || !this.data.workflow || !this.data.workflow.canStartFollowup) return; this.callAction("startCounselorReportFollowup",{reportId:report.reportId,expectedVersion:report.version,opinion:this.data.form.opinion}); },
  recordContact() { const workflow=this.data.workflow; if (!workflow || workflow.followupStatus!=="pending") return; this.callAction("progressCounselorFollowup",{followupId:workflow.followupId,expectedVersion:workflow.followupVersion,contactedAt:this.data.form.contactedAt,contactMethod:this.data.form.contactMethod}); },
  transferToSecurity() { const report=this.data.report, workflow=this.data.workflow; if (!report || !workflow || workflow.followupStatus!=="in_progress") return; this.callAction("transferCounselorReportToSecurity",{followupId:workflow.followupId,expectedFollowupVersion:workflow.followupVersion,expectedReportVersion:report.version,verificationResult:this.data.form.verificationResult,transferReason:this.data.form.transferReason}); },
  closeReport() { const report=this.data.report, workflow=this.data.workflow; if (!report || !workflow || workflow.followupStatus!=="in_progress") return; this.callAction("closeCounselorReport",{followupId:workflow.followupId,expectedFollowupVersion:workflow.followupVersion,expectedReportVersion:report.version,verificationResult:this.data.form.verificationResult,closeReason:this.data.form.closeReason}); },
};
Page(pageDefinition);
if (typeof module !== "undefined") module.exports={__testables:{RESULTS,pageDefinition,reportView,responseError}};
