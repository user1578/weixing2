# 校园反诈安全管理系统软件需求规格说明书（SRS v0.2）

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 系统名称 | 校园反诈安全管理系统 |
| 版本 | v0.2（已确认设计稿） |
| 前置条件 | 微信小程序已与 CloudBase 环境 `aa-d4gvb4o3t50fc94f8` 完成真实联通测试 |
| 文档范围 | 第一版业务闭环、逻辑集合、字段、权限与状态设计；本文不创建集合、云函数、页面或后台 |
| 与 v0.1 的关系 | v0.1 保留不覆盖；本版本吸收已确认的产品与 CloudBase 技术决策 |

## 1. 项目背景与目标

校园反诈工作目前依赖群消息转发、人工联系和线下统计，预警来源、学生反馈、院系跟进、保卫处处置之间缺少统一状态和完整留痕。本系统以微信小程序服务学生与辅导员，以 Web 管理后台服务保卫处/反诈专班，第一版必须跑通：

`预警下发 → 学生上报 / 辅导员跟进 → 保卫处核验 → 处置 → 结案 → 留痕`

第一版以真实数据演示闭环为目标，只实现可解释的基础规则和人工业务操作；不引入机器学习、自动化外部预警接入、OCR、文件上传或复杂规则引擎。

### 1.1 第一版范围与非目标

- 范围：预警人工录入和下发、学生上报、学院内辅导员跟进、保卫处核验处置、反诈文章与自测、基础统计、敏感信息脱敏和审计。
- 非目标：96110 真实接口、SSO/企业微信登录、Excel 导入工具、聊天截图/证据图片/附件上传、OCR、大模型识别、安全态势大屏、数据库或云函数的实际创建。
- 预警全部由保卫处人工录入；`sourceReference` 仅用于记录 96110 编号或其他来源参考号，不表示系统已接入外部平台。

## 2. 系统总体架构与 CloudBase 访问原则

### 2.1 逻辑架构

| 层级 | 组件 | 职责 |
| --- | --- | --- |
| 微信小程序 | 学生端、辅导员端 | 微信身份绑定后的本人/本学院业务展示和受控操作 |
| Web 管理后台 | 保卫处端 | 账号密码登录、预警人工下发、风险规则管理、核验处置、统计和审计查询 |
| 服务端业务层 | 后续 CloudBase 云函数 | 身份绑定、登录校验、RBAC、学院隔离、状态迁移、风险计算、脱敏、审计写入 |
| 逻辑数据层 | 后续 CloudBase 数据库 | 保存第 8 章定义的集合；本次仅设计，未创建任何集合 |

### 2.2 强制访问原则

核心业务集合原则上禁止客户端直接写入。身份、角色、学院归属、状态流转、风险等级、辅导员学院隔离、保卫处处置、敏感字段展示和审计日志均必须经过服务端校验。

服务端不得信任客户端提交的 `userId`、`studentId`、`role`、`collegeId`、`riskLevel`、`handlerId`、`operatorId`。服务端必须从微信上下文或 Web 登录会话取得操作者身份，再从 `users` 读取其角色和学院范围。

## 3. 身份、登录与三类角色

### 3.1 统一身份主键

- `users._id` 是系统内部唯一用户主键，格式建议 `usr_xxxxxx`，由服务端生成。
- `wxOpenId` 仅是微信身份绑定字段，不能作为业务主键。
- `studentId`、`counselorId`、`operatorId`、`actorId`、`issuedBy` 等所有用户外键均引用 `users._id`。
- 业务集合的自身主键使用各集合 `_id`；不再并存 `userId`、`alertId`、`reportId` 等重复主键字段。

### 3.2 登录与首次绑定

| 角色 | 登录方式 | 首次使用绑定流程 |
| --- | --- | --- |
| `student` | 微信小程序登录 | 服务端从微信上下文取得 OPENID；学生输入学号；服务端匹配预置的 `users` 演示人员档案，完成 `wxOpenId` 绑定 |
| `counselor` | 微信小程序登录 | 服务端从微信上下文取得 OPENID；辅导员输入工号；服务端匹配预置档案，完成 `wxOpenId` 绑定 |
| `security` | Web 账号密码登录 | 服务端校验 `loginName` 与安全哈希后的 `passwordHash`；该角色不要求 `wxOpenId` |

第一版的学院和人员使用演示主数据初始化：预置学生、辅导员、保卫处用户记录和学院记录，不开发 Excel 导入工具。客户端不得自行指定或更新 `role`、`collegeId`、`_id`、`wxOpenId`。

### 3.3 角色体系

业务角色严格只有以下三类，不新增 `security_admin`、`security_operator` 或其他业务角色：

| 角色 | 端 | 数据范围 | 主要职责 |
| --- | --- | --- | --- |
| `student` | 微信小程序 | 本人 | 查看本人预警/风险告知与工单进度，提交上报，学习和自测 |
| `counselor` | 微信小程序 | 本学院 | 查看学院预警和上报，创建跟进，标记重点关注，依规则结案或转保卫处 |
| `security` | Web 管理后台 | 全校 | 管理人工预警和风险规则，核验、处置、结案，查看全校统计和审计 |

## 4. 学生端功能需求

### 4.1 我的预警与风险告知

- 仅展示当前 `users._id` 对应的预警：内容、风险等级、下发时间和状态。
- 首次打开“已下发”预警时，由服务端执行幂等迁移为“已查看”。
- 学生可由预警发起关联上报；服务端将预警 `_id` 写入新工单的 `sourceAlertId`。
- 学生仅可查看本人真实个人业务信息和对学生公开的进度/结论，不展示内部跟进意见、处置详情或来源参考号。

### 4.2 一键上报

- 必填字段：诈骗类型、涉及金额、事件经过、发生时间、是否已产生实际经济损失。
- 可选字段：涉及平台、可疑账号或网址、是否仍与可疑方联系、回访联系电话、补充说明。
- 第一版不提供聊天截图、证据图片或任何附件上传入口，也不保存附件字段。
- 服务端生成工单 `_id`、写入 `studentId` 与 `collegeId` 快照、计算 `riskLevel` 与 `riskReasons`，初始状态为 `pending_counselor_verify`。
- 客户端防连点；服务端对同学生、相近时间、相同类型和金额的重复请求进行幂等/重复提示，不能静默丢弃。

### 4.3 反诈学堂与自测

- 仅展示已发布且已去标识化的文章；文章由保卫处在 Web 后台维护。
- 用户主动完成文章学习后，由服务端创建一条 `learning_records` 记录。
- 自测支持单选、多选、判断题。答卷提交后由服务端判分并创建 `quiz_attempts` 记录；正确答案不得在答题前下发。

## 5. 辅导员端功能需求

### 5.1 学院看板与数据边界

- 展示本学院的待处理预警、待辅导员核实工单、高风险/重点关注学生。
- 服务端以当前辅导员档案的 `collegeId` 强制过滤列表与详情；修改请求中的学院参数不得改变数据范围。
- 列表默认按风险等级、等待时长排序，且默认脱敏联系方式、金额和可疑账号。

### 5.2 跟进与重点关注

- 辅导员可针对本学院预警或上报新增一条 `counselor_followups` 跟进记录，填写联系时间、联系方法、意见和初步核实结论。
- 可标记重点关注，必须填写原因；服务端重算关联预警/工单的风险等级并写入新的 `riskReasons` 快照。
- 跟进状态是独立记录状态；需要再次跟进时新增一条记录，不重新打开既有跟进记录。

### 5.3 工单转交与直接结案

- 中风险、高风险或已造成实际经济损失的工单必须转保卫处，辅导员无权结案。
- 辅导员仅能将满足全部条件的工单直接结案：低风险、明确误报或纯咨询、未产生实际经济损失。
- 直接结案必须同时填写结案原因、创建“已完成”跟进记录，并由服务端写入审计日志。
- 转交保卫处时必须填写转交原因；保卫处退回补充时，辅导员新增一条跟进记录处理。

## 6. 保卫处 Web 后台功能需求

### 6.1 人工预警与风险规则

- 保卫处人工创建预警，填写目标学生、风险类型、提醒内容和可选 `sourceReference`。`sourceType` 固定为 `manual`。
- 服务端从目标学生、重点关注标记、近 30 天活动预警、诈骗类型和规则配置计算最终 `riskLevel` 与 `riskReasons`；Web 客户端不能提交最终等级。
- 保卫处可维护一个或多个 `risk_rules` 配置版本；第一版只使用启用中的默认规则，不接入关键词自动命中和外部预警接口。
- 下发前校验目标学生有效且已具备学院归属；下发、关闭均写审计日志。

### 6.2 核验、处置与结案

- 后台提供“待保卫处核验”“处置中”“已结案”队列。
- 每次核验、退回、处置、结案均追加一条 `security_dispositions` 记录，不能覆盖历史处置记录。
- 退回辅导员补充时，必须填写退回原因，并将工单状态改回 `pending_counselor_verify`。
- 结案时必须记录结案结论、确认损失金额和处置说明；保卫处可在“待核验”阶段对误报/无需处置事项直接结案。

### 6.3 统计与审计

- 支持按日期、学院、诈骗类型和风险等级筛选预警、上报、处置和学习统计。
- 支持按操作者、资源、动作、结果、日期查看审计记录。保卫处列表默认脱敏，处理具体事件或查看敏感详情时按最小必要原则显示真实字段并额外审计。

## 7. 核心业务流程

### 7.1 人工预警闭环

1. `security` 人工创建预警，服务端生成预警 `_id`，计算风险等级并保存风险原因快照，状态为“待下发”。
2. `security` 下发后，学生在小程序收到“已下发”预警；首次查看变为“已查看”。
3. 学生可创建一张关联工单；辅导员也可对预警创建跟进。每条预警最多关联一张直接工单。
4. 预警/工单经辅导员跟进后，符合转交条件的进入保卫处核验和处置。
5. 保卫处确认关联事项结束或无需继续关注后关闭预警；“已关闭”为终态，不支持重新激活。新的风险事件必须创建新的预警。

### 7.2 学生上报闭环

1. 学生提交上报，服务端写入身份/学院快照，计算风险，状态设为“待辅导员核实”。
2. 本学院辅导员创建跟进并核实：低风险误报/纯咨询且无损失可直接结案；其他工单转保卫处。
3. `security` 核验后进入处置中并最终结案，或退回辅导员补充。
4. 服务端对下发、查看、上报、敏感详情查看、跟进、转交、退回、核验、处置和结案均写入 `audit_logs`。

## 8. 建议逻辑集合与字段设计

以下仅为未来集合草案。所有集合主键均为 `_id`；除 `colleges._id` 外，主键由服务端生成。第一版建议只使用本节列出的 12 个集合，不重复设计 `handling_records`，处置历史统一使用 `security_dispositions`。

### 8.1 `users`

预置演示人员档案和登录绑定信息；学生/辅导员首次绑定更新 `wxOpenId`，保卫处使用 Web 凭据。

| 字段名 | 含义 | 类型 | 必填 | 示例 | 敏感 |
| --- | --- | --- | --- | --- | --- |
| `_id` | 系统用户主键 | string | 是 | `usr_000001` | 否 |
| `role` | 严格三类业务角色 | enum | 是 | `student` | 否 |
| `name` | 姓名 | string | 是 | `张三` | 是 |
| `collegeId` | 所属学院，引用 `colleges._id` | string | 学生/辅导员是 | `college_cs` | 否 |
| `studentNo` | 学号 | string | 学生是 | `2023123456` | 是 |
| `staffNo` | 工号 | string | 辅导员是 | `T00128` | 是 |
| `wxOpenId` | 微信绑定标识 | string | 小程序角色绑定后是 | `oAbc...` | 是 |
| `bindStatus` | 是否完成微信绑定 | enum | 学生/辅导员是 | `bound` | 否 |
| `loginName` | Web 登录名 | string | `security` 是 | `security01` | 是 |
| `passwordHash` | 密码安全哈希 | string | `security` 是 | `bcrypt...` | 是 |
| `mobile` | 联系电话 | string | 否 | `13800138000` | 是 |
| `focusFlag` | 当前重点关注标记 | boolean | 学生是 | `false` | 否 |
| `focusReason` | 重点关注原因 | string | `focusFlag=true` 时是 | `仍在联系可疑人员` | 是 |
| `status` | 账号状态 | enum | 是 | `active` | 否 |
| `createdAt` / `updatedAt` | 创建/更新时间 | datetime | 是 | `2026-09-06T10:00:00Z` | 否 |

### 8.2 `colleges`

学院主数据由演示数据初始化。`_id` 即学院业务标识，所有 `collegeId` 外键引用此字段。

| 字段名 | 含义 | 类型 | 必填 | 示例 | 敏感 |
| --- | --- | --- | --- | --- | --- |
| `_id`（`collegeId`） | 学院唯一标识 | string | 是 | `college_cs` | 否 |
| `name` | 学院名称 | string | 是 | `计算机学院` | 否 |
| `status` | 启用状态 | enum | 是 | `active` | 否 |
| `aliases` | 历史或简称 | string array | 否 | `[计算机, 计院]` | 否 |
| `createdAt` / `updatedAt` | 创建/更新时间 | datetime | 是 | `2026-09-06T10:00:00Z` | 否 |

### 8.3 `risk_rules`

风险规则由 `security` 在 Web 后台配置，服务端读取启用规则计算等级。客户端不能提交等级、阈值或原因。

| 字段名 | 含义 | 类型 | 必填 | 示例 | 敏感 |
| --- | --- | --- | --- | --- | --- |
| `_id` | 规则标识 | string | 是 | `rule_default_v1` | 否 |
| `name` | 规则名称 | string | 是 | `第一版默认风险规则` | 否 |
| `status` | 是否启用 | enum | 是 | `enabled` | 否 |
| `highAmount` | 高风险金额阈值（元） | number | 是 | `5000` | 否 |
| `midAmountMin` | 中风险最小金额（元） | number | 是 | `1` | 否 |
| `repeatAlertWindowDays` | 重复预警统计窗口（天） | number | 是 | `30` | 否 |
| `highAlertRepeatCount` | 高风险重复预警次数 | number | 是 | `3` | 否 |
| `midAlertRepeatCount` | 中风险重复预警次数 | number | 是 | `2` | 否 |
| `slaFirstFollowHours` | 首次跟进 SLA（小时） | number | 是 | `48` | 否 |
| `keyFraudTypes` | 重点诈骗类型 | enum array | 是 | `[part_time_scam]` | 否 |
| `createdBy` / `updatedBy` | 配置操作者，引用 `users._id` | string | 是 | `usr_sec_001` | 是 |
| `createdAt` / `updatedAt` | 创建/更新时间 | datetime | 是 | `2026-09-06T10:00:00Z` | 否 |

默认配置：`highAmount=5000`、`midAmountMin=1`、`repeatAlertWindowDays=30`、`highAlertRepeatCount=3`、`midAlertRepeatCount=2`、`slaFirstFollowHours=48`；重点类型为刷单返利、冒充公检法、虚假贷款、冒充客服退款。

### 8.4 `alerts`

预警完全由保卫处人工创建。预警与工单采用单向关联：本集合不保存 `reportIds` 或其他工单数组。

| 字段名 | 含义 | 类型 | 必填 | 示例 | 敏感 |
| --- | --- | --- | --- | --- | --- |
| `_id` | 预警主键 | string | 是 | `alert_001` | 否 |
| `sourceType` | 来源类型，第一版固定 | enum | 是 | `manual` | 否 |
| `sourceReference` | 96110 编号等参考号 | string | 否 | `96110-20260906-01` | 是 |
| `studentId` | 目标学生，引用 `users._id` | string | 是 | `usr_000001` | 是 |
| `collegeId` | 目标学院快照，引用 `colleges._id` | string | 是 | `college_cs` | 否 |
| `fraudType` | 风险/诈骗类型 | enum | 是 | `part_time_scam` | 否 |
| `content` | 风险提醒内容 | string | 是 | `请勿向陌生账号转账` | 是 |
| `riskLevel` | 服务端计算等级 | enum | 是 | `high` | 否 |
| `riskReasons` | 本次评级触发原因快照 | string array | 是 | `[repeat_alert_count>=3]` | 否 |
| `riskRuleId` | 使用的规则，引用 `risk_rules._id` | string | 是 | `rule_default_v1` | 否 |
| `status` | 预警状态 | enum | 是 | `sent` | 否 |
| `issuedBy` | 下发人，引用 `users._id` | string | 否 | `usr_sec_001` | 是 |
| `issuedAt` / `readAt` / `closedAt` | 下发/阅读/关闭时间 | datetime | 条件必填 | `2026-09-06T10:00:00Z` | 否 |
| `closeReason` | 关闭原因 | string | 关闭时必填 | `关联事项已结案` | 是 |
| `createdAt` / `updatedAt` | 创建/更新时间 | datetime | 是 | `2026-09-06T09:00:00Z` | 否 |

服务端校验：一条预警最多只能被一张 `fraud_reports` 以 `sourceAlertId` 引用；新的独立事件必须创建新的上报工单。

### 8.5 `fraud_reports`

学生上报工单。`sourceAlertId` 是唯一的预警关联字段；独立上报保持为空。

| 字段名 | 含义 | 类型 | 必填 | 示例 | 敏感 |
| --- | --- | --- | --- | --- | --- |
| `_id` | 工单主键 | string | 是 | `report_001` | 否 |
| `studentId` | 上报学生，引用 `users._id` | string | 是 | `usr_000001` | 是 |
| `collegeId` | 提交时学院快照，引用 `colleges._id` | string | 是 | `college_cs` | 否 |
| `sourceAlertId` | 单向关联的预警 `_id` | string | 否 | `alert_001` | 否 |
| `fraudType` | 诈骗类型 | enum | 是 | `part_time_scam` | 否 |
| `incidentAt` | 发生时间 | datetime | 是 | `2026-09-05T18:30:00+08:00` | 否 |
| `involvedAmount` | 涉及金额（元） | number | 是 | `3500` | 是 |
| `hasLoss` | 是否已造成实际损失 | boolean | 是 | `true` | 是 |
| `incidentNarrative` | 事件经过 | string | 是 | `收到刷单返利链接后转账` | 是 |
| `suspiciousPlatform` | 涉及平台 | string | 否 | `QQ` | 是 |
| `suspiciousAccount` | 可疑账号或网址 | string | 否 | `12345678` | 是 |
| `stillContacting` | 是否仍在联系 | boolean | 否 | `true` | 是 |
| `contactPhone` | 回访联系电话 | string | 否 | `13800138000` | 是 |
| `studentRemark` | 补充说明 | string | 否 | `已停止转账` | 是 |
| `riskLevel` | 服务端计算等级 | enum | 是 | `high` | 否 |
| `riskReasons` | 本次评级触发原因快照 | string array | 是 | `[has_loss]` | 否 |
| `riskRuleId` | 使用的规则，引用 `risk_rules._id` | string | 是 | `rule_default_v1` | 否 |
| `status` | 工单状态 | enum | 是 | `pending_counselor_verify` | 否 |
| `currentHandlerId` | 当前责任人，引用 `users._id` | string | 否 | `usr_c_001` | 是 |
| `submittedAt` / `closedAt` | 提交/结案时间 | datetime | 提交时必填 | `2026-09-06T09:00:00Z` | 否 |
| `closeReason` | 对学生可见的结案摘要 | string | 结案时必填 | `核验后已完成安全提醒` | 是 |
| `createdAt` / `updatedAt` | 创建/更新时间 | datetime | 是 | `2026-09-06T09:00:00Z` | 否 |

第一版不设计 `withdrawn` 状态，学生不能撤回工单；第一版也不设计附件字段或上传入口。

### 8.6 `counselor_followups`

同一对象可有多条追加式跟进记录；再次跟进创建新记录，而不是重新打开旧记录。

| 字段名 | 含义 | 类型 | 必填 | 示例 | 敏感 |
| --- | --- | --- | --- | --- | --- |
| `_id` | 跟进记录主键 | string | 是 | `followup_001` | 否 |
| `businessType` | 跟进对象类型 | enum | 是 | `report` | 否 |
| `businessId` | 预警或工单 `_id` | string | 是 | `report_001` | 否 |
| `studentId` | 关联学生，引用 `users._id` | string | 是 | `usr_000001` | 是 |
| `collegeId` | 学院快照，引用 `colleges._id` | string | 是 | `college_cs` | 否 |
| `counselorId` | 跟进人，引用 `users._id` | string | 是 | `usr_c_001` | 是 |
| `status` | 跟进状态 | enum | 是 | `completed` | 否 |
| `contactedAt` | 实际联系时间 | datetime | 否 | `2026-09-06T11:00:00Z` | 否 |
| `contactMethod` | 联系方式 | enum | 否 | `phone` | 否 |
| `opinion` | 跟进意见 | string | 是 | `学生已停止联系` | 是 |
| `verificationResult` | 初步核实结论 | enum | 是 | `misreport` | 否 |
| `focusFlag` / `focusReason` | 重点关注及原因 | boolean / string | 是/条件必填 | `true` / `仍有联系风险` | 是 |
| `transferToSecurity` | 是否转保卫处 | boolean | 是 | `true` | 否 |
| `transferReason` | 转交或退回补充说明 | string | 转交时必填 | `已造成实际损失` | 是 |
| `createdAt` / `completedAt` | 创建/完成时间 | datetime | 创建时必填 | `2026-09-06T12:00:00Z` | 否 |

### 8.7 `security_dispositions`

这是唯一的保卫处处置历史集合，不额外设计 `handling_records`。每次核验、退回、处置或结案均新增一条。

| 字段名 | 含义 | 类型 | 必填 | 示例 | 敏感 |
| --- | --- | --- | --- | --- | --- |
| `_id` | 处置记录主键 | string | 是 | `disposition_001` | 否 |
| `reportId` | 对应工单，引用 `fraud_reports._id` | string | 是 | `report_001` | 否 |
| `operatorId` | 保卫处操作者，引用 `users._id` | string | 是 | `usr_sec_001` | 是 |
| `action` | 动作类型 | enum | 是 | `verify` | 否 |
| `statusAfter` | 操作后工单状态 | enum | 是 | `in_process` | 否 |
| `verificationResult` | 核验结论 | enum | 核验/退回/结案时必填 | `confirmed` | 否 |
| `actionContent` | 核验/处置说明 | string | 是 | `已电话确认并指导止损` | 是 |
| `returnReason` | 退回辅导员原因 | string | `action=return` 时必填 | `需补充联系情况` | 是 |
| `confirmedLossAmount` | 确认损失金额（元） | number | 结案时必填 | `3500` | 是 |
| `externalReferenceNo` | 外部协作参考号 | string | 否 | `CASE-2026-001` | 是 |
| `nextActionAt` | 下一步计划时间 | datetime | 处置中可选 | `2026-09-07T09:00:00Z` | 否 |
| `finalOutcome` | 最终结论 | enum | 结案时必填 | `loss_confirmed` | 否 |
| `createdAt` | 操作时间 | datetime | 是 | `2026-09-06T12:30:00Z` | 否 |

### 8.8 `learning_articles`

| 字段名 | 含义 | 类型 | 必填 | 示例 | 敏感 |
| --- | --- | --- | --- | --- | --- |
| `_id` | 文章主键 | string | 是 | `article_001` | 否 |
| `title` | 标题 | string | 是 | `警惕刷单返利诈骗` | 否 |
| `category` | 案例或知识 | enum | 是 | `case` | 否 |
| `summary` / `content` | 摘要与正文 | string | 是 | `先垫付后返利均有风险` | 否（案例必须去标识化） |
| `fraudTags` | 诈骗类型标签 | enum array | 是 | `[part_time_scam]` | 否 |
| `publishStatus` | 发布状态 | enum | 是 | `published` | 否 |
| `authorId` | 发布人，引用 `users._id` | string | 是 | `usr_sec_001` | 是 |
| `publishedAt` | 发布时间 | datetime | 发布时必填 | `2026-09-06T10:00:00Z` | 否 |
| `createdAt` / `updatedAt` | 创建/更新时间 | datetime | 是 | `2026-09-06T09:00:00Z` | 否 |

### 8.9 `quiz_questions`

| 字段名 | 含义 | 类型 | 必填 | 示例 | 敏感 |
| --- | --- | --- | --- | --- | --- |
| `_id` | 题目主键 | string | 是 | `question_001` | 否 |
| `questionType` | 单选/多选/判断 | enum | 是 | `single` | 否 |
| `stem` | 题干 | string | 是 | `陌生人要求先转账再返利，应如何做？` | 否 |
| `options` | 面向客户端的选项 | object array | 是 | `[{id:A,text:拒绝}]` | 否 |
| `correctOptionIds` | 正确答案，仅服务端判分 | string array | 是 | `[A]` | 是 |
| `explanation` | 答案解析 | string | 是 | `先转账即高风险` | 否 |
| `fraudTags` | 题目标签 | enum array | 是 | `[part_time_scam]` | 否 |
| `status` | 启用状态 | enum | 是 | `enabled` | 否 |
| `createdAt` / `updatedAt` | 创建/更新时间 | datetime | 是 | `2026-09-06T09:00:00Z` | 否 |

### 8.10 `quiz_attempts`

每提交一份完整答卷创建一条记录；提交后由服务端判分。

| 字段名 | 含义 | 类型 | 必填 | 示例 | 敏感 |
| --- | --- | --- | --- | --- | --- |
| `_id` | 答卷主键 | string | 是 | `attempt_001` | 否 |
| `studentId` | 答题学生，引用 `users._id` | string | 是 | `usr_000001` | 是 |
| `answers` | 完整答卷（题目和选项） | object array | 是 | `[{questionId:q1,selectedOptionIds:[A]}]` | 否 |
| `score` | 服务端计算总分 | number | 是 | `8` | 否 |
| `totalScore` | 满分 | number | 是 | `10` | 否 |
| `submittedAt` | 提交时间 | datetime | 是 | `2026-09-06T13:00:00Z` | 否 |

### 8.11 `learning_records`

学生主动完成阅读文章后创建的学习记录；自测学习参与由 `quiz_attempts` 记录，不在本集合重复写入。

| 字段名 | 含义 | 类型 | 必填 | 示例 | 敏感 |
| --- | --- | --- | --- | --- | --- |
| `_id` | 学习记录主键 | string | 是 | `learning_001` | 否 |
| `studentId` | 学生，引用 `users._id` | string | 是 | `usr_000001` | 是 |
| `articleId` | 已完成学习的文章，引用 `learning_articles._id` | string | 是 | `article_001` | 否 |
| `completedAt` | 完成时间 | datetime | 是 | `2026-09-06T13:20:00Z` | 否 |

### 8.12 `audit_logs`

审计日志只能由服务端写入；客户端禁止直接创建、修改和删除。

| 字段名 | 含义 | 类型 | 必填 | 示例 | 敏感 |
| --- | --- | --- | --- | --- | --- |
| `_id` | 审计主键 | string | 是 | `audit_001` | 否 |
| `actorId` | 操作者，引用 `users._id` | string | 是 | `usr_c_001` | 是 |
| `actorRole` | 操作者角色 | enum | 是 | `counselor` | 否 |
| `action` | 操作类型 | enum | 是 | `report.transfer_to_security` | 否 |
| `resourceType` / `resourceId` | 操作资源类型及 `_id` | enum / string | 是 | `fraud_report` / `report_001` | 否 |
| `collegeId` | 当时学院范围快照 | string | 否 | `college_cs` | 否 |
| `beforeSummary` / `afterSummary` | 最小必要变更摘要 | object | 否 | `{status:pending}` | 是 |
| `result` | 成功或失败 | enum | 是 | `success` | 否 |
| `failureReason` | 失败原因 | string | 否 | `学院权限不足` | 否 |
| `requestId` | 请求追踪号 | string | 是 | `req_xxx` | 否 |
| `createdAt` | 写入时间 | datetime | 是 | `2026-09-06T13:10:00Z` | 否 |

## 9. 数据权限设计

### 9.1 RBAC 权限矩阵

| 操作 | `student` | `counselor` | `security` |
| --- | --- | --- | --- |
| 读取用户资料 | 仅本人真实资料 | 仅本学院最小必要资料 | 全校，按脱敏规则 |
| 查看预警 | 仅本人 | 仅本学院 | 全校 |
| 创建学生上报 | 仅本人创建 | 否 | 可人工代录，需审计 |
| 查看工单 | 仅本人及公开进度 | 仅本学院 | 全校 |
| 创建辅导员跟进 | 否 | 仅本学院 | 可查看，不以辅导员身份写入 |
| 转保卫处 | 否 | 仅本学院，原因必填 | 否 |
| 直接结案 | 否 | 仅低风险 + 误报/纯咨询 + 无损失，原因/跟进/审计齐全 | 待核验或处置中按结案规则 |
| 退回补充 | 否 | 接收并新增跟进 | 是，原因必填 |
| 标记重点关注 | 否 | 仅本学院，原因必填 | 全校 |
| 管理人工预警和风险规则 | 否 | 否 | 是 |
| 查询统计与审计 | 否 | 仅本学院业务看板 | 全校 |

### 9.2 服务端校验规则

1. 学生读取、更新和提交均以服务端会话解析出的 `users._id` 为准，拒绝使用客户端传来的目标 ID。
2. 辅导员对每个资源进行 `collegeId` 比对；跨学院查询、详情、写入和结案全部拒绝并写失败审计。
3. 直接结案时，服务端必须同时校验 `riskLevel=low`、`hasLoss=false`、核实结论为 `misreport` 或 `consultation`，并验证已写入完成跟进记录及结案原因。
4. `security` 才能管理预警、规则、保卫处处置、全校统计和审计。查看敏感详情本身也必须写审计。
5. 角色、学院、微信绑定、密码哈希、风险等级、风险原因、当前责任人和业务状态仅能由服务端按业务流程写入。

## 10. 状态机设计

存储枚举使用英文值，展示使用中文。状态更新不覆盖历史；历史由 `counselor_followups`、`security_dispositions` 与 `audit_logs` 追加留存。

### 10.1 预警状态机

`待下发(pending_dispatch) → 已下发(sent) → 已查看(viewed) → 跟进中(following_up) → 已关闭(closed)`

- `security` 创建人工预警：进入 `pending_dispatch`。
- `security` 下发：`pending_dispatch → sent`；首次学生查看：`sent → viewed`。
- 辅导员开始跟进或关联工单开始处理：`sent/viewed → following_up`。
- `security` 在关联事项结案或确认无需继续关注后关闭：`sent/viewed/following_up → closed`，`closeReason` 必填。
- `closed` 是终态，禁止重新激活；新风险事件只能创建新的预警。

### 10.2 学生上报工单状态机

`待辅导员核实(pending_counselor_verify) → 待保卫处核验(pending_security_verify) → 处置中(in_process) → 已结案(closed)`

- 学生提交：进入 `pending_counselor_verify`。
- 辅导员转交：`pending_counselor_verify → pending_security_verify`，`transferReason` 必填。
- 保卫处核验需行动：`pending_security_verify → in_process`。
- 保卫处完成处置：`in_process → closed`。
- 保卫处退回补充：`pending_security_verify → pending_counselor_verify`，必须新增处置记录并填写 `returnReason`。
- 辅导员直接结案仅允许：`pending_counselor_verify → closed`，且必须满足低风险、明确误报或纯咨询、无实际损失、已完成跟进并填写原因。
- 保卫处可将待核验的误报/无需处置事项直接结案；第一版不支持学生撤回，不增加 `withdrawn` 状态。

### 10.3 辅导员跟进状态机

`待跟进(pending) → 跟进中(in_progress) → 已完成(completed)`

- 新预警、新工单或保卫处退回补充时创建待跟进记录。
- 辅导员记录首次联系或核实动作：`pending → in_progress`。
- 填写意见、核实结论，并完成转交或直接结案所需动作：`in_progress → completed`。
- 不增加 `reopened`。后续再次跟进必须新增一条记录，并从 `pending` 开始。

### 10.4 保卫处处置状态机

`待核验(pending_verify) → 处置中(in_process) → 已结案(closed)`

- 工单转交保卫处后，在保卫处队列表现为 `pending_verify`，对应工单状态 `pending_security_verify`。
- 保卫处核验需要行动：`pending_verify → in_process`，对应工单迁移至 `in_process`。
- 处置完成：`in_process → closed`，对应工单迁移至 `closed`。
- 保卫处可在 `pending_verify` 直接结案（误报/无需处置），或退回辅导员补充；退回不是新增保卫处状态，保卫处流程停止，工单返回辅导员核实。

## 11. 配置化风险评级规则

风险等级固定为 `low`、`medium`、`high`，只能由服务端使用启用的 `risk_rules` 计算。服务端将等级、使用规则和本次触发因素快照写入 `alerts` 与 `fraud_reports` 的 `riskLevel`、`riskRuleId`、`riskReasons`；客户端不能提交最终值。

### 11.1 风险输入

- `hasLoss`：是否已造成经济损失。
- `involvedAmount`：涉及金额。
- `stillContacting`：是否仍在联系可疑方。
- `fraudType`：是否命中 `keyFraudTypes`。
- `activeAlertCount`：近 `repeatAlertWindowDays` 天内未关闭预警数。
- `focusFlag`：是否被辅导员标记重点关注。

### 11.2 默认判定顺序

1. **高风险**：任一条件成立：`hasLoss=true`；`involvedAmount >= highAmount`；仍在联系且命中重点类型；未关闭预警数不少于 `highAlertRepeatCount`；重点关注且仍在联系，或重点关注且未关闭预警数不少于 `midAlertRepeatCount`。
2. **中风险**：未命中高风险，且任一条件成立：`involvedAmount >= midAmountMin`；仍在联系；命中重点类型；未关闭预警数不少于 `midAlertRepeatCount`；被重点关注。
3. **低风险**：其余情况，例如无损失、金额为 `0`、未持续联系、未命中重点类型且无重复预警的咨询或提醒。

默认规则参数：高风险金额 5,000 元；中风险最低金额 1 元；重复窗口 30 天；高风险重复次数 3；中风险重复次数 2；首次跟进 SLA 48 小时。金额单位为人民币元，`0` 表示无涉及金额或无损失。

## 12. 数据统计指标

| 指标 | 统计口径 |
| --- | --- |
| 预警数量 | 统计期内 `alerts.status` 曾成功进入 `sent` 的数量 |
| 上报数量 | 统计期内创建的 `fraud_reports` 数量 |
| 已处置数量 | 统计期内进入 `closed` 的工单数量 |
| 受骗金额 | 统计期内结案且结论为确认损失的 `confirmedLossAmount` 总和 |
| 处置时效 | 已结案工单 `closedAt - submittedAt` 的平均时长 |
| 累计受骗金额 | 系统启用以来确认损失金额累计 |
| 人均损失 | 确认损失金额 ÷ 有确认损失的去重学生数 |
| 参与反诈学习人数 | 统计期内 `learning_records.studentId` 与 `quiz_attempts.studentId` 的并集去重数 |
| 高危学生跟进率 | 统计期内高风险学生中，48 小时内存在已完成跟进记录的去重人数 ÷ 高风险学生去重人数 |

统计支持日期、学院、诈骗类型和风险等级筛选，默认只展示聚合数据。金额口径以保卫处结案确认值为准，学生填写的涉及金额只参与风险研判。

## 13. 敏感信息与脱敏规则

| 数据 | 学生 | 辅导员 | 保卫处 |
| --- | --- | --- | --- |
| 本人姓名、学号、手机号、本人上报金额 | 可查看本人真实值 | 本学院列表默认脱敏；处置所需详情按最小必要显示 | 列表默认脱敏；处理具体事件时可看必要真实值 |
| 可疑账号/网址、事件经过、回访电话 | 可查看本人提交内容 | 本学院处置必要时可看，默认掩码 | 具体处置必要时可看 |
| 来源参考号、外部协作参考号 | 不展示 | 原则上不展示 | 具体处置必要时可看 |
| 处置内部意见 | 仅展示可公开结案摘要 | 本学院协作所需范围 | 全校处置所需范围 |

手机号默认显示为 `138****8000`，学号显示为 `2023****3456`，账号默认仅保留后四位，金额列表显示区间或 `¥****`。敏感详情查看、敏感导出和全量展示均须服务端记录审计。文章案例必须去标识化。

## 14. 操作审计与留痕规则

- 审计逻辑保留期限为 1 年；第一版不开发自动删除任务。
- `audit_logs` 只能由服务端写入，客户端不能直接创建、修改或删除。
- 必审计动作：身份绑定、Web 登录成功/失败、权限拒绝、预警创建/下发/查看/关闭、学生上报、敏感详情查看、辅导员跟进/重点标记/转交/直接结案、保卫处核验/退回/处置/结案、风险规则变更、文章/题目发布、数据导出。
- 跟进和处置记录只追加不覆盖；结案后如需更正，新增更正动作与审计，不物理删除历史。
- 审计保存操作者、角色、时间、资源、动作、结果、请求追踪号及最小必要状态摘要；摘要应避免复制完整敏感文本。

## 15. 异常场景与边界条件

| 场景 | 处理原则 |
| --- | --- |
| 学号/工号未匹配预置用户或已绑定他人 OPENID | 拒绝绑定，记录失败审计，不由客户端补写角色或学院 |
| Web 密码校验失败 | 拒绝登录，记录审计；仅比较安全哈希，不保存或返回明文密码 |
| 辅导员访问其他学院数据 | 服务端拒绝并写审计，不依赖前端隐藏 |
| 重复提交/网络重试 | 客户端防连点，服务端进行幂等或明确提示可能重复 |
| 并发状态更新 | 使用版本/更新时间校验；冲突时返回最新状态，禁止覆盖 |
| 辅导员尝试结案中高风险或有损失工单 | 服务端拒绝并写失败审计，要求转保卫处 |
| 保卫处退回时未填原因 | 拒绝状态迁移 |
| 金额未知或无损失 | `involvedAmount` 填 `0`，`hasLoss=false`，不使用空字符串 |
| 预警已有关联工单 | 拒绝再以同一预警创建直接关联工单；独立事件新建工单 |
| 预警已关闭 | 不允许重新激活；后续风险创建新预警 |
| 未订阅通知 | 以小程序应用内预警列表为准；订阅消息不是第一版必需能力 |
| 需要图片或聊天证据 | 第一版不提供入口也不保存；后续附件能力单独评审 |

## 16. 后续扩展功能

以下不属于第一版，不影响本版本集合草案或状态机：

1. 聊天截图、证据图片与附件上传，以及对应受控文件存储、访问控制和 OCR 提取账号/网址/金额。
2. 大模型诈骗话术识别，仅作为人工研判辅助，不自动做处置结论。
3. 96110 或其他外部预警系统接口对接；接入后仍需保留人工审核与来源参考号。
4. 安全态势大屏，基于脱敏聚合指标展示趋势和分布。
5. SSO、企业微信登录、Excel 人员导入、订阅消息和规则版本的高级运营能力。

## 17. SRS v0.2已确认决策

以下决策已定稿，不再作为待确认项：

1. `users._id` 为服务端生成的 `usr_xxxxxx` 系统主键；`wxOpenId` 只用于微信绑定；所有用户外键均引用 `users._id`。
2. 学生使用微信登录加学号首次绑定，辅导员使用微信登录加工号首次绑定，保卫处使用 Web 账号密码登录且仅保存安全哈希。
3. 业务角色严格为 `student`、`counselor`、`security` 三类；学院与人员使用演示主数据初始化，不开发 Excel 导入。
4. 建议集合固定为：`users`、`colleges`、`risk_rules`、`alerts`、`fraud_reports`、`counselor_followups`、`security_dispositions`、`learning_articles`、`quiz_questions`、`quiz_attempts`、`learning_records`、`audit_logs`；不设计重复的 `handling_records`。
5. 预警均由保卫处人工录入，`sourceType=manual`；`sourceReference` 可记录 96110 等参考号，但不接真实接口。
6. 预警与工单单向关联：仅 `fraud_reports.sourceAlertId` 保存预警；每条预警最多关联一张直接工单。
7. 预警终态为已关闭且不可重新激活；新风险创建新预警。学生工单不支持撤回，不增加 `withdrawn`。
8. 辅导员仅能结案低风险、明确误报或纯咨询且无实际损失的工单；必须填写原因、完成跟进并审计。其余工单必须转保卫处。
9. 保卫处可将工单退回辅导员补充，退回原因必填；再次跟进新增记录，不设计跟进重开状态。
10. 风险等级只有 `low`、`medium`、`high`，由服务端按 `risk_rules` 配置计算；`riskReasons` 保存触发原因快照。默认阈值和重点诈骗类型以第 11 章为准。
11. 第一版完全不实现任何附件、聊天截图、证据图片、OCR 或可操作上传入口。
12. 学习人数对 `learning_records` 与 `quiz_attempts` 的学生 ID 做并集去重；审计逻辑保留 1 年，第一版不开发自动删除。
13. 核心业务集合和审计日志均由服务端控制，客户端不得直接写入或伪造身份、权限、学院、状态、风险等级与处理人。

