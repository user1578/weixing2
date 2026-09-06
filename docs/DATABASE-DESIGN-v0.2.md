# 校园反诈安全管理系统数据库设计 v0.2

> 本文是 `docs/SRS-v0.2.md` 的数据库与服务端实现基线，也是后续 WorkBuddy 创建 CloudBase 资源时唯一可执行的数据库依据。本文只做设计，不创建集合、索引、数据或云函数。

## 1. 审查结论与 CloudBase 已验证约束

### 1.1 本版本结论

- 采用 12 个集合，不新增业务实体，不设计 `handling_records`。
- 用户、预警、工单等当前态只在其主表保存；跟进、处置、审计均为历史记录，不能反向推导或覆盖当前态。
- `identityKey`、`wxIdentityKey`、`sourceAlertKey` 是必要的非空替身唯一键，用于规避可空业务字段的 UNIQUE 索引冲突。
- `risk_rules` 第一版固定仅有 `_id = rule_default` 的一条文档；不采用“多版本 + 多条 enabled + 事务切换”。
- 最终索引总数为 **25**（含 4 个 UNIQUE），任一集合最多 6 个，低于官方系统限制中“单集合 20 个索引”。
- `version` 用于可被并发更新的权威当前态文档；关键状态动作使用“期望状态 + version”条件更新，并与历史/审计写入放在服务端事务中。

### 1.2 官方能力依据与实施前验证项

| 主题 | 已核对结论 | 设计落点 |
| --- | --- | --- |
| UNIQUE 与空字段 | 字段缺失会按 `null` 参与唯一索引；两个缺失/空值会冲突 | 不对 `studentNo`、`staffNo`、`loginName`、`wxOpenId`、`sourceAlertId` 直接建 UNIQUE |
| 组合索引 | 只可利用索引前缀，字段顺序和排序方向影响命中 | 第 6 章从真实查询倒推索引 |
| 索引数量 | 当前系统限制文档列出单集合最多 20 个；数据库 FAQ 存在 100 个的旧/差异口径 | 本设计任一集合不超过 6 个；实施 A 组须实际验证控制台可建索引数量 |
| 事务 | 仅服务端 SDK 支持；具备 ACID 与快照隔离，写冲突需捕获 | 状态变更 + 历史 + 审计必须服务端事务处理并重试/返回冲突 |
| 单文档更新 | 局部 `update` 与 `inc` 可原子更新指定字段 | version 使用条件匹配 + 原子递增；不可用“先查后写”替代并发控制 |
| 安全规则 | 客户端规则可拦截直连，但复杂 update 规则不能替代业务字段校验 | 全集合客户端直读直写拒绝；云函数为唯一业务入口 |
| OPENID | 小程序调用的专用云函数可从服务端上下文获得；混合来源函数不得直接复用该动态身份 | 小程序身份函数与 Web 保卫处函数物理分离，均不接受客户端 OPENID |
| 时间/对象/数组 | 使用 CloudBase `Date/serverDate`；Object 和 Array 是原生数据类型 | 所有服务器时间使用 `serverDate`；数组/对象只用于本设计明确字段 |

实施者应在 A 组先做一次“UNIQUE、组合 UNIQUE、条件更新、事务写冲突、索引限制”的最小验证。若 CloudBase 当前环境的实际能力与上述官方说明不同，停止后续组别并记录“需要实际 CloudBase 验证”，不得自行替换一致性方案。

官方参考：[索引管理](https://cloud.tencent.com/document/product/876/19371)、[系统限制](https://cloud.tencent.com/document/product/876/47177)、[数据库事务](https://cloud.tencent.com/document/product/876/48442)、[数据类型](https://cloud.tencent.com/document/product/876/19365)、[安全规则](https://cloud.tencent.com/document/product/876/41802)。

## 2. 总体规范

### 2.1 12 个最终集合

```text
users
colleges
risk_rules
alerts
fraud_reports
counselor_followups
security_dispositions
learning_articles
quiz_questions
quiz_attempts
learning_records
audit_logs
```

### 2.2 主键、外键与删除

- 每个集合使用自定义 `_id`。`users._id` 由服务端生成，格式 `usr_<随机值>`；其他非静态集合的 `_id` 也由服务端安全随机生成，禁止自增 ID、客户端指定 ID 或 OPENID 作为 ID。
- `colleges._id` 是稳定学院 ID，例如 `college_cs`；`risk_rules._id` 固定为 `rule_default`。
- 所有 `studentId`、`counselorId`、`operatorId`、`actorId`、`authorId`、`issuedBy`、`currentHandlerId` 仅引用 `users._id`。
- `collegeId` 是**历史业务快照**，写入时从 `users.collegeId` 派生；当前学院归属权限判断永远读取 `users.collegeId`，不得把历史快照当作当前授权来源。
- 第一版不物理删除 `users`、业务主表、历史表和审计表。用户/学院/文章/题目通过状态禁用；保留键避免旧身份被重占用。

### 2.3 字段来源标记

| 标记 | 含义 |
| --- | --- |
| `server` | 云函数生成或从可信会话、数据库记录派生；客户端不可传 |
| `input` | 可作为云函数白名单输入；云函数仍必须校验格式、范围与归属 |
| `derived` | 服务端根据可信数据计算，客户端不可传 |
| `seed` | 仅初始化演示数据阶段由受控脚本写入 |

所有 `createdAt`、`updatedAt`、`submittedAt`、`issuedAt`、`readAt`、`closedAt`、`completedAt`、`publishedAt` 均为 CloudBase `Date`；审计时间和状态时间必须使用服务端 `serverDate`，不采用客户端时间。

### 2.4 角色与可信身份

业务角色仅为 `student`、`counselor`、`security`。

- 小程序专用云函数从服务端微信上下文取得 OPENID，查 `users.wxIdentityKey = 'openid:' + OPENID` 得到用户。函数不得同时对 Web/HTTP 开放；混合来源函数须使用明确的服务端会话上下文解析，不能读取残留运行时 OPENID。
- `security` 通过 Web 账号密码登录。仅保存强哈希 `passwordHash`（bcrypt 或 Argon2），不保存、返回、记录或提交明文密码。
- 初次“小程序 + 学号/工号”绑定只适用于演示主数据。学号/工号本身不是生产级身份凭据；真实上线前必须另行确认可验证的绑定证明（例如校内统一认证、一次性激活码或人工核验）。这不阻塞 A 组数据库创建，但阻塞真实学生自助绑定上线。

## 3. 关键不变量与保证机制

分类：①DB 主键；②DB UNIQUE；③单文档原子条件更新；④数据库事务；⑤云函数服务端校验；⑥云函数 + DB UNIQUE；⑦仅业务约定，无法严格保证；⑧不需要强一致。

| 不变量 | 最终保证分类 | 具体保证 |
| --- | --- | --- |
| `users._id` 唯一 | ① | CloudBase `_id` 主键；服务端生成且插入冲突失败 |
| 学号唯一 | ⑥ | `identityKey='student:<规范化学号>'` 非空 UNIQUE；原 `studentNo` 不建 UNIQUE |
| 工号唯一 | ⑥ | `identityKey='counselor:<规范化工号>'` 非空 UNIQUE |
| Web 登录名唯一 | ⑥ | `identityKey='security:<规范化loginName>'` 非空 UNIQUE |
| `wxOpenId` 最多绑定一个用户 | ⑥ | `wxIdentityKey='openid:<OPENID>'` 非空 UNIQUE；OPENID 仅由服务端上下文取得 |
| `identityKey` 唯一 | ② | `users.identityKey` 单字段 UNIQUE |
| `wxIdentityKey` 唯一 | ② | `users.wxIdentityKey` 单字段 UNIQUE |
| 一条预警最多一张直接工单 | ⑥ | `sourceAlertKey='alert:<sourceAlertId>'` 非空 UNIQUE；独立工单为 `standalone:<reportId>` |
| 同一学生不能重复完成同一文章 | ⑥ | `(studentId, articleId)` 均必填的复合 UNIQUE，冲突转为幂等成功响应 |
| 同时多条风险规则 enabled | ① | 第一版只有 `risk_rules._id='rule_default'`；不存在多文档 enabled 竞争 |
| 工单非法跨状态更新 | ④ | 云函数校验转移图 + 期望 `status/version` + 事务写工单、历史和审计 |
| 已关闭工单被普通流程修改 | ④ | `closed` 不允许业务状态再迁移；仅受控更正动作可追加审计，不改核心结案事实 |
| 已关闭预警重新流转 | ④ | `alerts.status=closed` 为终态；服务端条件更新拒绝任何后继状态 |
| 辅导员处理其他学院数据 | ⑤ | 资源历史快照用于记录；授权始终比对可信 `users.collegeId` 与资源 `collegeId` |
| 学生查看其他学生数据 | ⑤ | 小程序身份映射到当前 `users._id` 后固定按本人 ID 查询 |
| 前端伪造 role/collegeId/riskLevel | ⑤ | 所有这些字段从服务端会话、用户档案、规则计算派生 |
| 前端伪造 actorId/operatorId/handlerId | ⑤ | 由会话身份和状态转移服务端写入 |
| `audit_logs` 被客户端伪造 | ⑤ | 客户端数据库 read/write 全拒绝；仅服务端内部审计写入器可 create |
| 密码明文存储 | ⑤ | 登录/初始化服务只接受明文到内存后立即强哈希；持久层只允许 `passwordHash` |
| 正确答案发送给学生 | ⑤ | 学生题目接口投影剥离 `correctOptionIds`；判分只在服务端执行 |
| `confirmedLossAmount` 非法写入 | ④ | 仅 `security` 结案事务写入；合法 `status`、结案结论、金额校验同时满足 |
| `users.focusFlag` 为当前权威状态 | ④ | 跟进记录是历史；标记/取消通过事务更新 `users` 与新增跟进/审计 |
| `counselor_followups` 只保存历史 | ⑤ | 不允许删除；完成后禁止 reopen；不作为当前态读取来源 |
| `fraud_reports.status` 为工单权威状态 | ⑤ | 所有当前队列与权限判断读取主表，处置表只保存快照 |
| `alerts.status` 为预警权威状态 | ⑤ | 所有当前队列读取主表，跟进表不复制预警当前态 |
| `security_dispositions` 不是当前状态来源 | ⑤ | 只追加历史；其 `statusAfter` 仅为操作快照 |

`where().count()`、先查后写或仅靠前端禁用按钮都不构成并发唯一性保证，只能用于友好提示。

## 4. 并发、事务与状态控制

### 4.1 `version` 字段

以下可变的权威文档必须含 `version: Number`，创建默认 `1`，每次成功更新递增 `1`：

`users`、`risk_rules`、`alerts`、`fraud_reports`、`counselor_followups`、`learning_articles`、`quiz_questions`。

追加式且创建后不可更新的 `security_dispositions`、`quiz_attempts`、`learning_records`、`audit_logs` 不加 `version`。`colleges` 第一版是稳定演示主数据，修改仅限受控维护，可使用 `updatedAt` 记录且不开放并发编辑界面。

### 4.2 写入规则

- 普通单文档、非状态字段更新：云函数以 `{_id, version}` 为条件更新，写入 `version = version + 1` 和 `updatedAt = serverDate()`；影响条数为 0 时返回 `CONFLICT`，客户端刷新后重试。
- 状态迁移：云函数以 `{_id, expectedStatus, version}` 为前提，在**一个服务端事务**中读取/校验并完成主表状态更新、追加跟进或处置历史、追加审计日志。发生写冲突则整个事务失败，不产生半条历史。
- 创建工单、首次微信绑定、学习完成：服务端预检仅为提示；最终由 UNIQUE 冲突兜底。需要审计时，业务插入与审计插入在同一事务中。
- 查看敏感详情：先确认授权，再在同一服务端调用中写审计；审计写入失败时不返回敏感详情。

### 4.3 状态迁移表

| 主表 | 合法迁移 | 角色 | 事务内同时写入 |
| --- | --- | --- | --- |
| `alerts` | `pending_dispatch→sent` | security | alert + audit |
| `alerts` | `sent→viewed` | 对应 student | alert + audit |
| `alerts` | `sent/viewed→following_up` | 对应 counselor 或 security | alert + followup + audit |
| `alerts` | `sent/viewed/following_up→closed` | security | alert + audit |
| `fraud_reports` | `pending_counselor_verify→pending_security_verify` | 本学院 counselor | report + completed followup + audit |
| `fraud_reports` | `pending_counselor_verify→closed` | 本学院 counselor，限低风险误报/咨询且无损失 | report + completed followup + audit |
| `fraud_reports` | `pending_security_verify→in_process` | security | report + disposition + audit |
| `fraud_reports` | `pending_security_verify→pending_counselor_verify` | security，退回原因必填 | report + disposition + new pending followup + audit |
| `fraud_reports` | `pending_security_verify/in_process→closed` | security | report + disposition + audit |
| `counselor_followups` | `pending→in_progress→completed` | 记录所属 counselor | followup + audit；每次再次跟进创建新记录 |

`closed` 不是可重开状态。后续事实补充只能新增历史/更正审计；不得把已关闭预警或工单改回处理中。

## 5. 最终字段设计

“客户端可传”仅指可作为云函数白名单输入，**不是**客户端可直连数据库写入。

### 5.1 `users`

| 字段 | 类型 | 必填/默认 | 来源；客户端可传 | 敏感 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `_id` | String | 是；服务端生成 | server；否 | 否 | `usr_<随机值>` 主键 |
| `identityKey` | String | 是；无默认 | server；否 | 是 | `student:<学号>` / `counselor:<工号>` / `security:<loginName>`，UNIQUE |
| `wxIdentityKey` | String | 是；无默认 | server；否 | 是 | `openid:<OPENID>` 或 `unbound:<users._id>`，UNIQUE |
| `role` | String | 是 | seed/server；否 | 否 | `student` / `counselor` / `security` |
| `name` | String | 是 | seed；否 | 是 | 演示人员档案姓名 |
| `collegeId` | String | 学生/辅导员必填；security 为 null | seed/server；否 | 否 | 当前学院，不是历史快照 |
| `studentNo` | String | student 必填；其他为 null | seed；首次绑定仅输入比对 | 是 | 原值不建 UNIQUE |
| `staffNo` | String | counselor 必填；其他为 null | seed；首次绑定仅输入比对 | 是 | 原值不建 UNIQUE |
| `loginName` | String | security 必填；其他为 null | seed/server；否 | 是 | 原值不建 UNIQUE |
| `passwordHash` | String | security 必填；其他为 null | seed/server；否 | 是 | bcrypt/Argon2 哈希，绝不保存明文 |
| `wxOpenId` | String | 小程序绑定后必填；security 为 null | server；否 | 是 | 原值不建 UNIQUE，不能用于客户端授权 |
| `bindStatus` | String | 小程序角色 `unbound`；security `not_applicable` | server；否 | 否 | `unbound` / `bound` / `not_applicable` |
| `mobile` | String | 可空 | seed；本人通过受控接口可更新 | 是 | 列表默认脱敏 |
| `focusFlag` | Boolean | 是；false | derived；否 | 否 | 当前权威状态 |
| `focusReason` | String | `focusFlag=true` 时必填 | derived；否 | 是 | 当前标记理由 |
| `status` | String | 是；`active` | seed/server；否 | 否 | `active` / `graduated` / `suspended` |
| `version` | Number | 是；1 | server；否 | 否 | 乐观锁 |
| `createdAt` / `updatedAt` | Date | 是 | server/seed；否 | 否 | 服务端时间 |

### 5.2 `colleges`

| 字段 | 类型 | 必填/默认 | 来源；客户端可传 | 敏感 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `_id` | String | 是；固定 | seed；否 | 否 | 例如 `college_cs`，即所有 `collegeId` 外键值 |
| `name` | String | 是 | seed；否 | 否 | 学院名称 |
| `status` | String | 是；`active` | seed/server；否 | 否 | `active` / `disabled` |
| `aliases` | Array<String> | 是；`[]` | seed/server；否 | 否 | 简称/旧名称 |
| `createdAt` / `updatedAt` | Date | 是 | seed/server；否 | 否 | 服务端时间 |

### 5.3 `risk_rules`

本集合**只允许一条** `_id='rule_default'` 文档。保留 `status='enabled'` 是为与 SRS 字段一致；第一版不允许新增第二条规则或将默认规则禁用。

| 字段 | 类型 | 必填/默认 | 来源；客户端可传 | 敏感 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `_id` | String | 是；`rule_default` | seed；否 | 否 | DB 主键保证单例 |
| `name` | String | 是；`第一版默认风险规则` | seed/server；否 | 否 | 固定名称 |
| `status` | String | 是；`enabled` | server；否 | 否 | 第一版唯一值 `enabled` |
| `highAmount` | Number | 是；5000 | seed/server；否 | 否 | 人民币元 |
| `midAmountMin` | Number | 是；1 | seed/server；否 | 否 | 人民币元 |
| `repeatAlertWindowDays` | Number | 是；30 | seed/server；否 | 否 | 天 |
| `highAlertRepeatCount` | Number | 是；3 | seed/server；否 | 否 | 次数 |
| `midAlertRepeatCount` | Number | 是；2 | seed/server；否 | 否 | 次数 |
| `slaFirstFollowHours` | Number | 是；48 | seed/server；否 | 否 | 小时 |
| `keyFraudTypes` | Array<String> | 是 | seed/server；否 | 否 | `part_time_scam`、`impersonate_public`、`fake_loan`、`fake_refund` |
| `updatedBy` | String | 是 | derived；否 | 是 | `users._id`，必须是 security |
| `version` | Number | 是；1 | server；否 | 否 | 并发更新控制 |
| `createdAt` / `updatedAt` | Date | 是 | seed/server；否 | 否 | 服务端时间 |

### 5.4 `alerts`

| 字段 | 类型 | 必填/默认 | 来源；客户端可传 | 敏感 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `_id` | String | 是 | server；否 | 否 | 预警主键 |
| `sourceType` | String | 是；`manual` | server；否 | 否 | 第一版固定人工录入 |
| `sourceReference` | String | 可空 | input；是 | 是 | 96110 等参考号，不是外部接口 |
| `studentId` | String | 是 | derived；否 | 是 | 目标学生 `users._id` |
| `collegeId` | String | 是 | derived；否 | 否 | 下发时学院快照 |
| `fraudType` | String | 是 | input；是 | 否 | 见第 7 章枚举 |
| `content` | String | 是 | input；是 | 是 | 风险提醒正文 |
| `riskLevel` | String | 是 | derived；否 | 否 | 服务端计算 |
| `riskReasons` | Array<String> | 是；`[]` | derived；否 | 否 | 评级原因快照 |
| `riskRuleId` | String | 是；`rule_default` | derived；否 | 否 | 规则引用快照 |
| `status` | String | 是；`pending_dispatch` | server；否 | 否 | 当前预警权威状态 |
| `issuedBy` | String | 下发后必填 | derived；否 | 是 | security 的 `users._id` |
| `issuedAt` / `readAt` / `closedAt` | Date | 条件必填 | server；否 | 否 | 分别对应下发/首次读/关闭 |
| `closeReason` | String | closed 时必填 | input；是 | 是 | 关闭说明 |
| `version` | Number | 是；1 | server；否 | 否 | 乐观锁 |
| `createdAt` / `updatedAt` | Date | 是 | server；否 | 否 | 服务端时间 |

### 5.5 `fraud_reports`

| 字段 | 类型 | 必填/默认 | 来源；客户端可传 | 敏感 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `_id` | String | 是 | server；否 | 否 | 工单主键 |
| `studentId` | String | 是 | derived；否 | 是 | 当前学生会话的 `users._id` |
| `collegeId` | String | 是 | derived；否 | 否 | 提交时学院快照 |
| `sourceAlertId` | String | 可空 | input；仅创建 | 否 | 单向关联；服务端校验归属 |
| `sourceAlertKey` | String | 是 | server；否 | 否 | `alert:<id>` 或 `standalone:<reportId>`，UNIQUE |
| `fraudType` | String | 是 | input；仅创建 | 否 | 诈骗类型 |
| `incidentAt` | Date | 是 | input；仅创建 | 否 | 客观发生时间，可由学生提供 |
| `involvedAmount` | Number | 是；0 | input；仅创建 | 是 | 学生填“涉及金额”，非统计损失 |
| `hasLoss` | Boolean | 是 | input；仅创建 | 是 | 是否已造成实际损失 |
| `incidentNarrative` | String | 是 | input；仅创建 | 是 | 事件经过 |
| `suspiciousPlatform` | String | 可空 | input；仅创建 | 是 | 涉及平台 |
| `suspiciousAccount` | String | 可空 | input；仅创建 | 是 | 可疑账号/网址 |
| `stillContacting` | Boolean | 是；false | input；仅创建 | 是 | 是否仍在联系 |
| `contactPhone` | String | 可空 | input；仅创建 | 是 | 回访电话 |
| `studentRemark` | String | 可空 | input；仅创建 | 是 | 补充说明 |
| `riskLevel` / `riskReasons` / `riskRuleId` | String / Array / String | 是 | derived；否 | 否 | 服务端风险快照 |
| `status` | String | 是；`pending_counselor_verify` | server；否 | 否 | 工单当前权威状态 |
| `currentHandlerId` | String | 可空 | derived；否 | 是 | 当前责任人 `users._id` |
| `finalOutcome` | String | closed 时必填 | server；否 | 否 | 结案结论 |
| `confirmedLossAmount` | Number | security 结案时必填；否则 null | server；否 | 是 | 统计唯一金额口径 |
| `closeReason` | String | closed 时必填 | server；否 | 是 | 学生可见结案摘要，不能写内部明细 |
| `submittedAt` / `closedAt` | Date | 提交/结案时必填 | server；否 | 否 | 服务端时间 |
| `version` | Number | 是；1 | server；否 | 否 | 乐观锁 |
| `createdAt` / `updatedAt` | Date | 是 | server；否 | 否 | 服务端时间 |

### 5.6 `counselor_followups`

| 字段 | 类型 | 必填/默认 | 来源；客户端可传 | 敏感 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `_id` | String | 是 | server；否 | 否 | 跟进记录主键 |
| `businessType` / `businessId` | String / String | 是 | derived；否 | 否 | `alert` 或 `report` 及对应 `_id` |
| `studentId` / `collegeId` | String / String | 是 | derived；否 | 是/否 | 对象学生与历史学院快照 |
| `counselorId` | String | 是 | derived；否 | 是 | 当前辅导员会话 ID |
| `status` | String | 是；`pending` | server；否 | 否 | 仅本条记录状态 |
| `contactedAt` | Date | 可空 | input；是 | 否 | 实际联系时间，不是审计时间 |
| `contactMethod` | String | 可空 | input；是 | 否 | `phone` / `wechat` / `in_person` / `other` |
| `opinion` | String | 是 | input；是 | 是 | 跟进意见 |
| `verificationResult` | String | 完成时必填 | input；是 | 否 | 初步核实结果 |
| `focusFlag` / `focusReason` | Boolean / String | 是；false / 条件必填 | input；是 | 是 | 仅历史事件；主表权威态在 users |
| `transferToSecurity` | Boolean | 是；false | input；是 | 否 | 是否请求转交 |
| `transferReason` | String | 转交时必填 | input；是 | 是 | 转交原因 |
| `version` | Number | 是；1 | server；否 | 否 | 本条状态乐观锁 |
| `createdAt` / `updatedAt` / `completedAt` | Date | 创建必填；完成条件必填 | server；否 | 否 | 服务端时间 |

### 5.7 `security_dispositions`

| 字段 | 类型 | 必填/默认 | 来源；客户端可传 | 敏感 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `_id` | String | 是 | server；否 | 否 | 处置记录主键 |
| `reportId` | String | 是 | derived；否 | 否 | `fraud_reports._id` |
| `operatorId` | String | 是 | derived；否 | 是 | security 会话 ID |
| `action` | String | 是 | input；是 | 否 | `verify` / `start_process` / `return` / `close` |
| `statusAfter` | String | 是 | derived；否 | 否 | 操作后的工单状态快照 |
| `verificationResult` | String | 核验/退回/结案时必填 | input；是 | 否 | 核验结论 |
| `actionContent` | String | 是 | input；是 | 是 | 内部核验/处置说明 |
| `returnReason` | String | `action=return` 时必填 | input；是 | 是 | 退回辅导员原因 |
| `confirmedLossAmount` | Number | `action=close` 时必填 | derived；否 | 是 | 与工单结案值同事务写入 |
| `externalReferenceNo` | String | 可空 | input；是 | 是 | 外部协作参考号 |
| `nextActionAt` | Date | 处置中可空 | input；是 | 否 | 下一步计划时间 |
| `finalOutcome` | String | `action=close` 时必填 | input；是 | 否 | 最终结论 |
| `createdAt` | Date | 是 | server；否 | 否 | 追加时间；创建后不可更新 |

### 5.8 `learning_articles`

| 字段 | 类型 | 必填/默认 | 来源；客户端可传 | 敏感 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `_id` | String | 是 | server；否 | 否 | 文章主键 |
| `title` | String | 是 | input；是 | 否 | 标题 |
| `category` | String | 是 | input；是 | 否 | `case` / `knowledge` |
| `summary` / `content` | String / String | 是 | input；是 | 否 | 案例须发布前去标识化 |
| `fraudTags` | Array<String> | 是；`[]` | input；是 | 否 | 诈骗类型标签 |
| `publishStatus` | String | 是；`draft` | server；否 | 否 | `draft` / `published` / `disabled` |
| `authorId` | String | 是 | derived；否 | 是 | security 用户 ID |
| `publishedAt` | Date | published 时必填 | server；否 | 否 | 服务端时间 |
| `version` | Number | 是；1 | server；否 | 否 | 乐观锁 |
| `createdAt` / `updatedAt` | Date | 是 | server；否 | 否 | 服务端时间 |

### 5.9 `quiz_questions`

| 字段 | 类型 | 必填/默认 | 来源；客户端可传 | 敏感 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `_id` | String | 是 | server；否 | 否 | 题目主键 |
| `questionType` | String | 是 | input；是 | 否 | `single` / `multiple` / `boolean` |
| `stem` | String | 是 | input；是 | 否 | 题干 |
| `options` | Array<Object> | 是 | input；是 | 否 | 每项仅 `id`、`text` |
| `correctOptionIds` | Array<String> | 是 | input；是 | 是 | 仅服务端读取和判分，学生响应剥离 |
| `explanation` | String | 是 | input；是 | 否 | 答后才返回 |
| `fraudTags` | Array<String> | 是；`[]` | input；是 | 否 | 类型标签 |
| `status` | String | 是；`enabled` | server；否 | 否 | `enabled` / `disabled` |
| `version` | Number | 是；1 | server；否 | 否 | 乐观锁 |
| `createdAt` / `updatedAt` | Date | 是 | server；否 | 否 | 服务端时间 |

### 5.10 `quiz_attempts`

| 字段 | 类型 | 必填/默认 | 来源；客户端可传 | 敏感 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `_id` | String | 是 | server；否 | 否 | 答卷主键 |
| `studentId` | String | 是 | derived；否 | 是 | 当前学生会话 ID |
| `answers` | Array<Object> | 是 | derived；否 | 否 | 服务端验证后保存 `{questionId, selectedOptionIds, isCorrect}` |
| `score` / `totalScore` | Number / Number | 是 | derived；否 | 否 | 服务端判分总分/满分 |
| `submittedAt` / `createdAt` | Date | 是 | server；否 | 否 | 服务端时间；创建后不可更新 |

### 5.11 `learning_records`

| 字段 | 类型 | 必填/默认 | 来源；客户端可传 | 敏感 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `_id` | String | 是 | server；否 | 否 | 学习记录主键 |
| `studentId` | String | 是 | derived；否 | 是 | 当前学生会话 ID |
| `articleId` | String | 是 | input；是 | 否 | 已发布文章 ID，服务端校验 |
| `completedAt` / `createdAt` | Date | 是 | server；否 | 否 | 服务端时间；创建后不可更新 |

### 5.12 `audit_logs`

| 字段 | 类型 | 必填/默认 | 来源；客户端可传 | 敏感 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `_id` | String | 是 | server；否 | 否 | 审计主键 |
| `actorId` / `actorRole` | String / String | 是 | derived；否 | 是/否 | 事件时身份快照 |
| `actorCollegeId` | String | 可空 | derived；否 | 否 | 事件时学院快照；security 为 null |
| `action` | String | 是 | server；否 | 否 | 第 8 章动作字典 |
| `resourceType` / `resourceId` | String / String | 是 | server；否 | 否 | 被操作资源 |
| `result` | String | 是 | server；否 | 否 | `success` / `failure` |
| `failureReason` | String | failure 时必填 | server；否 | 否 | 失败原因 |
| `beforeSummary` / `afterSummary` | Object | 可空 | server；否 | 是 | 仅最小状态摘要，不存完整敏感文本 |
| `requestId` | String | 是 | server；否 | 否 | 服务端请求追踪号 |
| `createdAt` | Date | 是 | server；否 | 否 | 追加时间；禁止 update/delete |

## 6. 最终索引设计（25 个）

仅创建下列索引；`_id` 原生主键索引不计入。UNIQUE 同时承担相应等值查询，无需再建重复单字段索引。

| 集合 | 索引 | 类型 | 对应第一版查询 |
| --- | --- | --- | --- |
| users | `identityKey` | UNIQUE | 学号/工号/登录名身份匹配 |
| users | `wxIdentityKey` | UNIQUE | 小程序 OPENID 登录映射 |
| users | `(collegeId, focusFlag, status)` | 组合 | 辅导员学院重点关注学生 |
| alerts | `(studentId, issuedAt desc)` | 组合 | 学生“我的预警” |
| alerts | `(collegeId, status, issuedAt desc)` | 组合 | 辅导员本学院预警待办；保卫处按学院筛选 |
| alerts | `(status, riskLevel, issuedAt desc)` | 组合 | 保卫处状态队列及风险筛选 |
| fraud_reports | `sourceAlertKey` | UNIQUE | 一条预警仅一张直接工单 |
| fraud_reports | `(studentId, submittedAt desc)` | 组合 | 学生“我的工单” |
| fraud_reports | `(collegeId, status, submittedAt desc)` | 组合 | 辅导员本学院工单待办 |
| fraud_reports | `(status, riskLevel, submittedAt desc)` | 组合 | 保卫处工单状态队列及风险筛选 |
| fraud_reports | `(status, closedAt desc)` | 组合 | 全校已结案时间范围/统计 |
| fraud_reports | `(collegeId, status, closedAt desc)` | 组合 | 按学院已结案统计 |
| counselor_followups | `(businessType, businessId, createdAt desc)` | 组合 | 某预警/工单跟进历史 |
| counselor_followups | `(studentId, createdAt desc)` | 组合 | 某学生跟进历史 |
| security_dispositions | `(reportId, createdAt desc)` | 组合 | 某工单处置历史 |
| learning_articles | `(publishStatus, publishedAt desc)` | 组合 | 已发布文章列表 |
| quiz_questions | `status` | 单字段 | 有效题目列表 |
| quiz_attempts | `(studentId, submittedAt desc)` | 组合 | 学生答题历史 |
| quiz_attempts | `(submittedAt desc)` | 单字段 | 正确率时间范围统计 |
| learning_records | `(studentId, articleId)` | 复合 UNIQUE | 防重复完成同一文章 |
| learning_records | `(studentId, completedAt desc)` | 组合 | 学生学习记录 |
| learning_records | `(completedAt desc)` | 单字段 | 学习参与人数时间范围统计 |
| audit_logs | `(actorId, createdAt desc)` | 组合 | 按操作者审计 |
| audit_logs | `(resourceType, resourceId, createdAt desc)` | 组合 | 按资源审计 |
| audit_logs | `(action, createdAt desc)` | 组合 | 按动作/时间审计 |

| 集合 | 索引数 |
| --- | ---: |
| users | 3 |
| colleges | 0 |
| risk_rules | 0 |
| alerts | 3 |
| fraud_reports | 6 |
| counselor_followups | 2 |
| security_dispositions | 1 |
| learning_articles | 1 |
| quiz_questions | 1 |
| quiz_attempts | 2 |
| learning_records | 3 |
| audit_logs | 3 |
| **总计** | **25** |

不建索引：长文本、`riskReasons` 数组、`sourceType`（第一版固定 manual）、密码哈希、OPENID 原值、金额、备注、外部参考号，以及仅“以后可能需要”的字段。

## 7. 最终枚举与数据权威来源

| 字段 | 最终枚举/规则 | 权威来源 |
| --- | --- | --- |
| role | `student` / `counselor` / `security` | users.role |
| alert.status | `pending_dispatch` / `sent` / `viewed` / `following_up` / `closed` | alerts.status |
| report.status | `pending_counselor_verify` / `pending_security_verify` / `in_process` / `closed` | fraud_reports.status |
| followup.status | `pending` / `in_progress` / `completed` | 每条 counselor_followups 文档 |
| disposition 行为 | `verify` / `start_process` / `return` / `close` | security_dispositions.action |
| riskLevel | `low` / `medium` / `high` | 服务端风险计算结果 |
| fraudType | `part_time_scam` / `impersonate_public` / `fake_loan` / `fake_refund` / `other` | 工单/预警/内容输入校验 |
| verificationResult | `confirmed` / `suspected` / `misreport` / `consultation` / `not_fraud` | 历史记录 |
| finalOutcome | `loss_confirmed` / `loss_no_loss` / `misreport` / `consultation` | 已关闭工单 |

`involvedAmount` 是学生提交的涉诈涉及金额，仅用于风险研判；`confirmedLossAmount` 是 security 在合法结案事务中写入的实际确认损失，是所有受骗金额统计的唯一口径。

## 8. RBAC、安全规则与审计

### 8.1 数据库直连

12 个集合全部设置为**客户端 read=false、write=false**。客户端必须通过云函数获取经过角色、资源归属、字段白名单与脱敏处理的响应。

| 角色 | 可信身份 | 服务端数据范围 |
| --- | --- | --- |
| student | 小程序专用函数解析到的 OPENID → users._id | 本人预警、工单、学习、答题；本人真实字段 |
| counselor | 小程序专用函数解析到的 OPENID → users._id | 当前 `users.collegeId` 对应学院；业务表 `collegeId` 仅用于限定历史记录 |
| security | 服务端 Web 会话 → users._id | 全校；列表默认脱敏，具体受理事件按最小必要显示 |

### 8.2 审计规则

- `audit_logs` 只追加，禁止 update、delete 和客户端直接 create。
- 绑定、登录失败、敏感详情查看、工单创建、跟进、重点标记、转交、退回、核验、处置、结案、角色/学院调整均必须写审计。
- 核心写操作的审计写入失败，事务必须回滚核心操作；敏感详情审计失败时拒绝返回敏感详情。
- `actorRole` 与 `actorCollegeId` 是事件快照，后续用户角色/学院变化不回写历史。
- 审计逻辑保留 1 年，第一版不实现自动清理；届时清理须另行授权并记录审计。

## 9. 初始化数据与创建顺序

### 9.1 初始化范围

仅初始化演示主数据：学院、预置 student/counselor/security 用户、固定 `rule_default`、少量去标识化文章和题目。不得在文档、脚本、Git 或日志中写入真实 OPENID、真实手机号、真实密码、Token 或 Secret。

安全账号密码由实施时在受控环境输入，立即强哈希后存储；示例资料只能使用占位值，不能用 `DEMO_PASSWORD_PLACEHOLDER` 作为真实哈希值。

### 9.2 创建顺序

1. A 组：`colleges` → `users` → `risk_rules`，随后创建 A 组索引、安全规则、演示主数据并验证。
2. B 组：`alerts` → `fraud_reports` → `counselor_followups` → `security_dispositions`，逐集合创建索引/规则并做事务与状态机验证。
3. C 组：`learning_articles` → `quiz_questions` → `quiz_attempts` → `learning_records` → `audit_logs`，逐集合验证脱敏、UNIQUE 与审计追加性。

未通过当前组的集合、索引、安全规则和最小读写验证前，不得进入下一组。详细执行步骤见 `docs/CLOUDBASE-IMPLEMENTATION-CHECKLIST.md`。

## 10. 与 v0.1 的关键修订

1. 按 SRS 统一字段：`studentId`、`incidentNarrative`、`suspiciousPlatform`、`contactPhone`、`authorId`、`loginName`、`correctOptionIds`、`learning_records.articleId`，移除 v0.1 的同义字段混用。
2. 三个替身唯一键保留，但明确其必要性、非空约束、解绑策略、敏感性与 DB UNIQUE 的最终兜底职责。
3. `risk_rules` 从“多版本 status=enabled 的事务切换”简化为固定 `_id=rule_default` 单例，杜绝多条 enabled。
4. 删除无第一版查询支撑的单字段/组合索引，54 个索引收敛为 25 个。
5. 增加 `version` 与“期望状态 + version + 服务端事务”规则，避免并发状态覆盖；`updatedAt` 不再被当作唯一并发控制。
6. 明确 audit 写入失败必须回滚关键业务操作；敏感详情审计失败拒绝响应。
7. 取消附件、隐式上传、重复处置实体、客户端数据库直写和基于客户端身份字段的权限判断。

