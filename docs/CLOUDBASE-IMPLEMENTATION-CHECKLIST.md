# CloudBase 实施检查表

> 这是未来实施顺序，不是本次执行指令。当前阶段不得创建任何 CloudBase 资源；每组全部验收且获得明确继续授权后，才可进入下一组。

## 0. 每组的共同前置检查

- [ ] 已阅读 `SRS-v0.2.md`、`DATABASE-DESIGN-v0.2.md` 与 `CLOUDBASE-DEVELOPMENT-GUARDRAILS.md`
- [ ] 已记录 `git status`，无无关修改
- [ ] 目标环境为 `aa-d4gvb4o3t50fc94f8`，所有 CLI 命令显式指定该 envId
- [ ] 操作范围仅限当前组的集合和索引，且已有用户授权
- [ ] 不会写入或提交 `.env`、`cloudbaserc.json`、`project.private.config.json`、`.workbuddy/`、Token、Secret、真实密码或真实 OPENID
- [ ] 已写明最小验证、预期结果与停止/回滚方案；未授权不得删除已有资源

每组验收记录必须包含：日期、操作者、envId、执行命令、控制台结果、最小测试输入、实际输出和最终 `git status`。

## A 组：主数据与风险规则

### A.1 范围

`colleges`、`users`、`risk_rules`

### A.2 创建前

- [ ] 确认 `colleges._id` 为稳定学院 ID，`users._id` 为服务端 ID，`risk_rules._id` 固定为 `rule_default`
- [ ] 确认角色仅 `student`、`counselor`、`security`
- [ ] 确认 `identityKey`、`wxIdentityKey` 非空；不为 `studentNo`、`staffNo`、`loginName`、`wxOpenId` 建 UNIQUE
- [ ] 确认 `risk_rules` 只允许固定单例，不创建第二条 enabled 规则
- [ ] 确认演示数据虚构，真实密码不出现在文档、命令、日志或 Git

### A.3 创建集合、索引与安全规则

- [ ] 按 `DATABASE-DESIGN-v0.2.md` 创建 `colleges`、`users`、`risk_rules`，不增字段
- [ ] 创建 `users.identityKey` UNIQUE
- [ ] 创建 `users.wxIdentityKey` UNIQUE
- [ ] 创建 `users(collegeId, focusFlag, status)` 组合索引
- [ ] 不为 `colleges`、`risk_rules` 创建额外索引；A 组索引总数应为 3
- [ ] 三个集合客户端 read/write 全部拒绝

### A.4 初始化与验证

- [ ] 初始化学院、未绑定的 student/counselor 演示用户、security 强哈希账号和唯一 `rule_default`
- [ ] 验证 `identityKey` UNIQUE、`wxIdentityKey` UNIQUE 和空替身键均正确生效
- [ ] 验证第二条 `rule_default` 不能存在，且安全账号查询不返回 `passwordHash`
- [ ] 验证客户端直连读写被拒绝，受控服务端最小读取正常
- [ ] 在 CLI 和控制台核对集合、字段、索引属性与目标环境

### A.5 A 组验收

- [ ] 字段、3 个索引、安全规则、初始化数据和最小读写测试全部通过
- [ ] UNIQUE 冲突、空键处理与客户端直连拒绝均有证据
- [ ] 已检查 Git 状态；用户明确同意进入 B 组

## B 组：预警、工单、跟进与处置

### B.1 范围

`alerts`、`fraud_reports`、`counselor_followups`、`security_dispositions`

### B.2 创建前

- [ ] 确认 `alerts.status` 和 `fraud_reports.status` 是唯一当前状态来源
- [ ] 确认 followup/disposition 仅是追加历史，不能反推当前状态
- [ ] 确认关联上报使用 `sourceAlertKey=alert:<sourceAlertId>`，独立上报使用 `standalone:<reportId>`
- [ ] 确认学院授权使用可信 `users.collegeId`，业务 `collegeId` 仅为历史快照
- [ ] 确认所有状态修改使用事务、期望状态和 version，禁止页面直改 status

### B.3 创建集合与索引

- [ ] 创建 `alerts`，包含 version/riskReasons，不创建 `reportIds` 数组
- [ ] 创建 `fraud_reports`，包含 sourceAlertId/sourceAlertKey，不增加附件字段
- [ ] 创建 `counselor_followups` 和唯一 `security_dispositions` 历史集合
- [ ] alerts 索引：`(studentId, issuedAt desc)`、`(collegeId, status, issuedAt desc)`、`(status, riskLevel, issuedAt desc)`
- [ ] fraud_reports 索引：`sourceAlertKey` UNIQUE、`(studentId, submittedAt desc)`、`(collegeId, status, submittedAt desc)`、`(status, riskLevel, submittedAt desc)`、`(status, closedAt desc)`、`(collegeId, status, closedAt desc)`
- [ ] counselor_followups 索引：`(businessType, businessId, createdAt desc)`、`(studentId, createdAt desc)`
- [ ] security_dispositions 索引：`(reportId, createdAt desc)`
- [ ] B 组每集合索引数不超过 6；不建 sourceType、金额、长文本、数组索引

### B.4 安全规则与最小读写测试

- [ ] 四个集合客户端 read/write 全部拒绝
- [ ] 所有云函数输入均有白名单，拒绝 `studentId`、`collegeId`、`riskLevel`、`operatorId`、`currentHandlerId`
- [ ] 两个并发请求为同一 alert 创建直接工单时，最终最多一条成功
- [ ] 两个独立上报均可写入不同 `standalone:<reportId>`
- [ ] 验证 student 不能访问他人资源，counselor 不能跨学院读取、跟进、转交或结案
- [ ] 验证预警 closed 后不能流转；验证工单非法跳转被拒绝
- [ ] 验证合法转交、退回、结案原子写入主表 + 历史 + audit
- [ ] 两个旧 version 并发更新同一工单时，最多一条成功，另一条返回 CONFLICT
- [ ] 验证辅导员直接结案仅限低风险、误报/咨询、无损失、已有完成跟进
- [ ] 验证 confirmedLossAmount 仅能由 security 合法结案事务写入
- [ ] 验证 focusFlag 的主表更新、跟进与审计同成同败

### B.5 B 组验收

- [ ] 12 个 B 组索引、状态机、学院隔离、UNIQUE、version、事务和审计均通过
- [ ] CLI、控制台与最小读写测试结果已记录
- [ ] Git 状态已检查；用户明确同意进入 C 组

## C 组：内容、学习与审计

### C.1 范围

`learning_articles`、`quiz_questions`、`quiz_attempts`、`learning_records`、`audit_logs`

### C.2 创建前

- [ ] 确认文章案例已去标识化，第一版没有附件、OCR 或上传字段
- [ ] 确认 `correctOptionIds` 仅服务端可读，学生接口必须投影剥离
- [ ] 确认答卷、学习和审计均为追加式历史
- [ ] 确认学习人数按 learning_records 与 quiz_attempts 的 studentId 并集去重
- [ ] 确认 audit 逻辑保留 1 年，第一版不做自动清理

### C.3 创建集合与索引

- [ ] learning_articles：`(publishStatus, publishedAt desc)`
- [ ] quiz_questions：`status`
- [ ] quiz_attempts：`(studentId, submittedAt desc)`、`(submittedAt desc)`
- [ ] learning_records：UNIQUE `(studentId, articleId)`、`(studentId, completedAt desc)`、`(completedAt desc)`
- [ ] audit_logs：`(actorId, createdAt desc)`、`(resourceType, resourceId, createdAt desc)`、`(action, createdAt desc)`
- [ ] C 组索引总数应为 10，且不对正文、摘要、OPENID、哈希、数组建立索引
- [ ] 五个集合客户端 read/write 全部拒绝

### C.4 初始化与最小读写测试

- [ ] 初始化少量去标识化文章和有效题目；不初始化真实学习/答题/审计数据
- [ ] 学生题目响应不包含 `correctOptionIds` 或答案解析
- [ ] 同一学生两次完成同一文章：仅一条 learning_records；并发请求同样成立
- [ ] 完整答卷由服务端判分，student 只能读取自己的答卷历史
- [ ] 验证文章/题目 version 冲突；验证学生跨用户查询被拒绝
- [ ] 验证 audit_logs 客户端 read/create/update/delete 均拒绝
- [ ] 验证敏感详情审计失败不返回敏感值，核心操作审计失败整体回滚
- [ ] 验证文章发布时间、题目状态、答题/学习时间、审计资源/动作查询命中预定索引

### C.5 C 组验收

- [ ] 10 个 C 组索引、内容脱敏、答案隔离、学习 UNIQUE、审计追加性和统计基础均通过
- [ ] CLI、控制台与最小读写测试结果已记录
- [ ] 已检查 Git 状态，用户明确确认数据库实施完成

## 最终总验收

- [ ] 全部 12 个集合与 25 个索引和 `DATABASE-DESIGN-v0.2.md` 完全一致
- [ ] 所有集合客户端直连 read/write 均拒绝
- [ ] 每一项 UNIQUE、状态流转、权限拒绝、敏感审计、事务回滚均有可复现证据
- [ ] 未新增集合、角色、状态、风险阈值、外部环境或 SRS 范围外功能
- [ ] Git 中无密钥、凭据、本地配置或未批准云端导出数据

