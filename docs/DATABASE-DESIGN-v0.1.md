# 校园反诈安全管理系统 · 数据库设计 v0.1

> 本文档为**逻辑设计稿**，仅定义集合结构、字段类型、索引、权限约束与初始化数据方案。
> 本阶段**不创建任何 CloudBase 集合、索引或数据**，所有创建动作须由后续开发阶段按 §13 顺序执行。

| 项目 | 内容 |
| --- | --- |
| 系统名称 | 校园反诈安全管理系统 |
| 文档版本 | DATABASE-DESIGN v0.1（设计稿） |
| 需求基线 | SRS-v0.2（已锁定决策 13 条） |
| 目标环境 | CloudBase 文档型数据库，环境 ID `aa-d4gvb4o3t50fc94f8` |
| 关联小程序 | AppID `wxe262970211858262` |
| 与 SRS 关系 | 本文档是 SRS-v0.2 在数据库层的细化；与 SRS 冲突时以 SRS v0.2 §17 决策为准 |

---

## 1. 设计目标

1. 把 SRS-v0.2 §8 给出的 12 个集合完整落地为 CloudBase 文档结构，确定字段类型、默认值、敏感标记与索引。
2. 在不动 CloudBase 资源的前提下，输出**可执行**的数据库设计：
   - `_id` 命名规则、Date 字段类型、敏感字段清单
   - 12 集合的字段表与索引表
   - 数据权限矩阵和访问原则
   - 演示初始化数据方案
3. 显式区分"云函数 RBAC"与"CloudBase 数据库安全规则"两层防线；本设计以云函数为权威防线，数据库安全规则仅兜底。
4. 不引入 SRS-v0.2 §16 排除项（附件、OCR、大模型、SSO 等）；不新增集合。

---

## 2. CloudBase 数据库设计原则

### 2.1 集合边界
- **业务主表承载"当前状态"**（`users.status / focusFlag`、`alerts.status`、`fraud_reports.status`）
- **追加历史表承载"事件流"**（`counselor_followups`、`security_dispositions`、`audit_logs`）
- **配置表承载"运行时阈值"**（`risk_rules`）
- **内容表承载"展示素材"**（`learning_articles`、`quiz_questions`）
- **行为表承载"统计源"**（`quiz_attempts`、`learning_records`）

任何字段不允许多个集合同时充当同一"当前状态"的权威来源——所有权威字段在 §10 显式列出。

### 2.2 命名与编码
- 集合名：`snake_case`，复数语义（集合不叫 `user`、`alert`）
- 字段名：`camelCase`（与 SRS 字段名保持一致）
- 状态枚举：`snake_case` 的稳定英文值（`pending_dispatch`、`pending_counselor_verify` 等）
- 业务动作：`dot.notation`（如 `report.transfer_to_security`）

### 2.3 物理删除策略
**第一版原则上不物理删除业务数据。**
- 学生上报、跟进、处置、审计、答题记录：仅追加与状态变更，不允许物理删除
- 文章/题目：可由 `status` / `publishStatus` 字段禁用即可
- 用户档案：使用 `status ∈ {active, graduated, suspended, withdrawn}` 区分；不物理删除
- 演示初始化数据在第一版系统内可用 `status=disabled` 标记后保留

### 2.4 CloudBase 类型映射
| 类型 | 用法 |
|---|---|
| `String` | 主键、枚举、文本字段 |
| `Number` | 金额、计数、SLA 小时数、阈值 |
| `Boolean` | 标记位（`focusFlag`、`hasLoss`、`stillContacting`） |
| `Date` | 所有时间字段（`createdAt`、`updatedAt`、`issuedAt`、`closedAt` 等），**禁止字符串存时间** |
| `Array` | 集合型字段（`role`、`roleCodes`、`keyFraudTypes`、`answers`） |
| `Object` | 结构化复合字段（`grading`、`answers` 元素、`beforeSummary`、`afterSummary`） |

> 本设计不引入 `GeoPoint` 类型。无定位需求。

### 2.5 服务端权威字段
下列字段**严禁客户端传入**，必须由云函数按业务规则赋值：

```
userId, role, collegeId, riskLevel, riskReasons, riskRuleId,
handlerId, operatorId, actorId, currentHandlerId, assignedCounselorId,
issuedBy, createdBy, updatedBy, status (除 status=disabled 的后台显式修改),
closedBy, createdAt, updatedAt
```

客户端可提交的字段集合由各云函数签名定义，超出集合必抛 403。

---

## 3. ID 与时间字段规范

### 3.1 `_id` 命名规则（统一前缀）
所有业务 `_id` 由**云函数服务端**使用 `crypto.randomUUID()` 或等效安全随机源生成，拼接为 `<prefix>_<12 位 base36>`（或更短，由云函数运行时确定），保证全局唯一且不可枚举。

| 集合 | `_id` 格式 | 示例 |
|---|---|---|
| `users` | `usr_` + 12 位 | `usr_a1b2c3d4e5f7` |
| `colleges` | `college_` + 8 位 | `college_cs` |
| `risk_rules` | `rule_` + 8 位 | `rule_default` |
| `alerts` | `alt_` + 12 位 | `alt_a1b2c3d4e5f7` |
| `fraud_reports` | `rpt_` + 12 位 | `rpt_a1b2c3d4e5f7` |
| `counselor_followups` | `flw_` + 12 位 | `flw_a1b2c3d4e5f7` |
| `security_dispositions` | `dsp_` + 12 位 | `dsp_a1b2c3d4e5f7` |
| `learning_articles` | `art_` + 12 位 | `art_a1b2c3d4e5f7` |
| `quiz_questions` | `qst_` + 12 位 | `qst_a1b2c3d4e5f7` |
| `quiz_attempts` | `qat_` + 12 位 | `qat_a1b2c3d4e5f7` |
| `learning_records` | `lrn_` + 12 位 | `lrn_a1b2c3d4e5f7` |
| `audit_logs` | `aud_` + 12 位 | `aud_a1b2c3d4e5f7` |

**禁止**：自增整数、纯时间戳、`openid` 嵌入、雪花 ID 嵌入业务前缀。

> 说明：`colleges` 与 `risk_rules` 为静态演示数据，`_id` 由初始化脚本硬编码（`college_cs`、`college_math`、`rule_default`），仍满足可读且唯一。

### 3.2 时间字段

所有业务集合统一包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `createdAt` | `Date` | 集合创建时间，由服务端写入 |
| `updatedAt` | `Date` | 最近一次更新时间，服务端在每次写操作完成后刷新 |

业务事件时间字段（每个集合各自定义）：
`issuedAt`, `viewedAt`, `closedAt`, `submittedAt`, `completedAt`, `answeredAt`, `publishedAt`, `lastLoginAt`, `readAt` 等统一为 `Date` 类型。

**禁止**：将时间存为 `String`（ISO 字符串也不行），存为 `Number`（毫秒时间戳也不行）。

---

## 4. 集合关系总览

```
                        ┌───────────────────────────┐
                        │       users (usr_xx)     │ ← 唯一身份主键源
                        │  role ∈ {student,counselor,security}
                        └──────────┬────────────────┘
                                   │  collegeId
                                   ▼
                        ┌───────────────────────────┐
                        │      colleges (college_xx)│
                        └──────────┬────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
  alerts (alt_xx)            fraud_reports (rpt_xx)    learning_records (lrn_xx)
  targetStudentId            reporterId                 userId
  collegeId                  collegeId                  articleId ──┐
  issuedBy                   sourceAlertId (单向→alerts)              │
  status (权威: 当前预警状态) status (权威: 当前工单状态)                ▼
        │                          │                       learning_articles (art_xx)
        │                          │                       learning_records 与 quiz_attempts
        │                          │                       学生 ID 并集去重 = 参与学习人数
        │                          │
        │              ┌───────────┴────────────┐
        │              ▼                        ▼
        │     counselor_followups (flw_xx)   security_dispositions (dsp_xx)
        │     businessType=alert|report       reportId
        │     counselorId                    operatorId
        │     (追加历史, 不权威)              (追加历史, 不权威)
        │
        ▼
risk_rules (rule_xx)
  riskRuleId (被 alerts/fraud_reports 引用为风险计算的快照源)
```

**关键不变量**：
- `users._id` 是所有业务外键的唯一引用源；不引用 `wxOpenId`
- `alerts.status` 是预警当前状态权威，`fraud_reports.status` 是工单当前状态权威
- `counselor_followups` / `security_dispositions` 永远不充当"当前状态"权威
- `risk_rules` 当前启用版本通过 `risk_rules.status=enabled` 决定，云函数取最新启用版；业务表的 `riskRuleId` 字段保存触发时使用的版本快照（用于审计回放）

---

## 5. 12 个集合详细设计

> 每个集合的字段表统一列：字段名 · CloudBase 类型 · 是否必填 · 默认值 · 示例 · 说明 · 是否敏感 · 数据来源 · 是否允许客户端传入 · 是否建立索引 · 关联对象。
> "数据来源"枚举：`server`（服务端）/`client`（客户端）/`seed`（初始化脚本）/`derived`（服务端派生）。

### 5.1 `users`

**作用**：所有人员档案的唯一身份主键源。覆盖学生、辅导员、保卫处三类业务角色。

| 字段名 | 类型 | 必填 | 默认值 | 示例 | 说明 | 敏感 | 数据来源 | 客户端允许 | 索引 | 关联 |
|---|---|---|---|---|---|---|---|---|---|---|
| `_id` | String | 是 | — | `usr_a1b2c3d4e5f7` | 业务主键，云端生成 | 否 | server | 否 | 唯一主键 | — |
| `identityKey` | String | 是 | — | `student:2023123456` | **登录/绑定身份统一唯一键**；格式 `<role>:<登录标识>`，三角色各异：`student:<studentNo>` / `counselor:<staffNo>` / `security:<username>`；由 `bindStudentIdentity` / `bindCounselorIdentity` / `createSecurityAccount` 服务端生成 | 否 | server | 否 | **UNIQUE（唯一）** | — |
| `role` | String | 是 | — | `student` | 业务角色：`student` / `counselor` / `security`；一个用户一个主角色 | 否 | server | 否 | 是 | — |
| `name` | String | 是 | — | `张三` | 真实姓名 | 是 | client（首次绑定时）/ seed | 是（仅当前用户） | 否 | — |
| `collegeId` | String | 条件必填 | — | `college_cs` | 学生/辅导员必填；security 可空 | 否 | seed / server | 否 | 是（组合） | `colleges._id` |
| `studentNo` | String | 条件必填 | — | `2023123456` | 学号；student 必填；其他角色可空 | 是 | client（首次绑定）/ seed | 仅首次绑定 | 单字段（非唯一） | — |
| `staffNo` | String | 条件必填 | — | `T00128` | 工号；counselor 必填 | 是 | client（首次绑定）/ seed | 仅首次绑定 | 单字段（非唯一） | — |
| `wxOpenId` | String | 条件必填 | `null` | `oAbcDefGhiJkl` | 微信 OPENID 绑定值；security 必为 `null`；**仅作身份记录字段，不再作为唯一性查询键** | 是 | server（绑定时） | 否（绑定前由 client 上送 code → 云函数解析） | 否（取消单字段索引，登录查询转用 `wxIdentityKey`） | — |
| `wxIdentityKey` | String | 是 | — | `openid:oAbcDefGhiJkl` / `unbound:usr_xxx` | **微信身份统一唯一键**；未绑定：`unbound:<users._id>`；已绑定：`openid:<wxOpenId>`；由 `bindWxOpenId` 服务端生成；**DB UNIQUE 唯一索引**，承担"一个 OPENID 最多绑定一个 users"的并发唯一性兜底 | 是 | server | 否 | **UNIQUE（数据库级）** | — |
| `bindStatus` | String | 是 | `unbound` | `bound` | 微信绑定状态：`unbound` / `bound` | 否 | server | 否 | 否 | — |
| `username` | String | 条件必填 | — | `security01` | Web 登录名；security 必填 | 是 | seed / server | 否 | 单字段（非唯一） | — |
| `passwordHash` | String | 条件必填 | `null` | `DEMO_PASSWORD_PLACEHOLDER` | Web 密码的 bcrypt/argon2 安全哈希；**绝不存明文**；security 必填 | 是 | seed / server | 否 | 否 | — |
| `mobile` | String | 否 | `null` | `13800138000` | 联系电话 | 是 | client（首次绑定）/ seed | 是（仅本人修改） | 否 | — |
| `focusFlag` | Boolean | 是 | `false` | `true` | **当前重点关注标记权威源** | 否 | server（基于 counselor_followups 重算） | 否 | 是 | — |
| `focusReason` | String | 否 | `null` | `仍在联系可疑人员` | 重点关注原因；`focusFlag=true` 时必填 | 是 | server | 否 | 否 | — |
| `status` | String | 是 | `active` | `active` | 账号状态：`active` / `graduated` / `suspended` / `withdrawn` | 否 | server | 否 | 是 | — |
| `lastLoginAt` | Date | 否 | `null` | `2026-09-06T08:00:00.000Z` | 最近一次登录时间 | 否 | server | 否 | 否 | — |
| `createdAt` | Date | 是 | — | `Date(...)` | 创建时间 | 否 | server | 否 | 否 | — |
| `updatedAt` | Date | 是 | — | `Date(...)` | 更新时间 | 否 | server | 否 | 否 | — |

**子约束**
- `student`：种子阶段 `wxIdentityKey = unbound:<users._id>`、`wxOpenId = null`、`bindStatus = unbound`、`status = active`；通过小程序首次绑定后由 `bindWxOpenId` 更新为 `wxIdentityKey = openid:<OPENID>`、`wxOpenId = <OPENID>`、`bindStatus = bound`；激活状态以 `wxIdentityKey` 前缀是否为 `openid:` 为准
- `counselor`：同上生命周期；额外要求 `collegeId` 必填
- `security`：`wxIdentityKey = unbound:<users._id>`、`wxOpenId = null`、`bindStatus = unbound`、`username`、`passwordHash` 同时必填；security **永远不绑定**微信
- `identityKey` 创后**原则上不可由普通业务流程修改**。如果人员身份标识发生变化（如工号/学号调整），必须由受控的管理操作显式更新并写 `audit_logs.action=user.identity_key_change`；客户端任何修改请求一律拒绝
- `wxIdentityKey` 修改受同等受控：首次绑定、换绑、解绑必须由服务端 `bindWxOpenId` / `rebindWxOpenId` / `unbindWxOpenId` 云函数执行，写 `audit_logs.action=identity.bind` / `identity.rebind` / `identity.unbind`；**DB UNIQUE 索引是并发唯一性的最终兜底**（参见下方"wxIdentityKey 微信绑定流程"）
- `users.focusFlag` 是当前状态的**唯一权威源**；`counselor_followups.focusFlag` 仅作历史事件流，不参与 UI 当前态读取
- 角色变更（如学生毕业后身份变更）由 security 在 Web 后台以"创建新 _id + 老档案 status=graduated"方式实现，不直接改 `role`

**`identityKey` / `wxIdentityKey` 双重唯一性与服务端校验的角色定位**

`users` 集合在第一版中有**两个数据库级 UNIQUE 字段**（参见 §8.2），各自承担不同身份维度的唯一性：

| 唯一键 | 业务含义 | 兜底对象 | 对应"业务字段" |
|---|---|---|---|
| `identityKey` UNIQUE | "业务身份" 唯一：保证 `studentNo / staffNo / username` 不被重复登记 | `studentNo` / `staffNo` / `username` 不重复 | `studentNo` / `staffNo` / `username`（不再为它们建 DB UNIQUE） |
| `wxIdentityKey` UNIQUE | "微信身份" 唯一：保证一个 `wxOpenId` 最多绑定一个 `users` 文档 | `wxOpenId` 不重复绑定 | `wxOpenId`（不再为它建 DB UNIQUE） |

**两个唯一键对每个 `users` 文档都必有值**，不会因为 null 触发 CloudBase UNIQUE 索引的歧义；同时它们的前缀命名空间不重叠（`student:` / `counselor:` / `security:` 之间不会冲突；`unbound:` / `openid:` 之间也不会冲突）。

每个唯一键的服务端校验流程都遵循同一原则：**服务端 `where` 查询用于业务校验与友好提示；DB UNIQUE 索引负责最终并发唯一性保证**。"先查后写"在 CloudBase 事务快照隔离下并非绝对并发安全（两个并发事务可能各自读到对方尚未提交的写入），因此即便服务端做了 `count()` 检查，**仍以 DB UNIQUE 冲突为兜底**：

| 场景 | 服务端校验云函数 | 服务端预检（友好提示） | DB UNIQUE 兜底 |
|---|---|---|---|
| 学生绑定 | `bindStudentIdentity` | `users.where({identityKey: "student:<studentNo>"}).count()` 为 0 时继续 | `identityKey` UNIQUE 冲突 → "该学号已被绑定" |
| 辅导员绑定 | `bindCounselorIdentity` | `users.where({identityKey: "counselor:<staffNo>"}).count()` 为 0 | `identityKey` UNIQUE 冲突 → "该工号已被绑定" |
| 保卫处账号创建 | `createSecurityAccount` | `users.where({identityKey: "security:<username>"}).count()` 为 0 | `identityKey` UNIQUE 冲突 → "该登录名已被占用" |
| 微信首次绑定 | `bindWxOpenId` | 从微信上下文拿真实 OPENID；`users.where({wxIdentityKey: "openid:<OPENID>"}).count()` 为 0 | `wxIdentityKey` UNIQUE 冲突 → "该微信身份已被绑定" |
| 微信换绑 | `rebindWxOpenId` | 同上预检；同时校验 `users._id` 等于当前操作者 | `wxIdentityKey` UNIQUE 冲突 → "目标微信身份已被绑定" |
| 微信解绑 | `unbindWxOpenId` | 仅本人；目标账号未绑定则报错 | `wxIdentityKey = unbound:<users._id>` 重新写入；UNIQUE 仅约束不出现第二条同名标识 |

任何"先查后写"的服务端预检都**只是友好提示**；真正的并发唯一性由 UNIQUE 冲突决定，预检失败时返回业务文案，预检通过但 UNIQUE 冲突时返回通用文案（不向客户端泄露具体冲突值）。

> **关于 `wxOpenId` 普通索引的取消**：`wxIdentityKey` 已经承担"OPENID → users"的等值查询主键角色，第一版**不为** `users.wxOpenId` 建单字段索引。`wxOpenId` 仍保留作为身份记录字段；任何需要查看原始 OPENID 的服务端需求由 `users.where({_id: <id>}).get()` 直接读取，无需索引。
>
> **关于 `studentNo / staffNo / username` 普通索引**：保留作查询辅助键，便于后台模糊搜索；唯一性兜底由 `identityKey` UNIQUE 承担，不再依赖服务端 `count()` 的"先查后写"。

**`wxIdentityKey` 微信绑定流程（小程序首次登录）**

1. 服务端从微信上下文（`cloud.getWXContext()`）取得真实 `OPENID`，**不接受客户端传入 OPENID**
2. 计算新值：`wxIdentityKey_new = "openid:" + OPENID`
3. 单文档事务：
   - 校验 `users._id = session.userId`（不能绑他人）
   - `wxIdentityKey_new` 写入；同步写 `wxOpenId = OPENID`、`bindStatus = bound`、`updatedAt = Date.now()`
   - DB UNIQUE 若冲突 → 捕获异常 → 返回 `"该微信身份已经绑定其他账号"`；事务回滚
4. 写审计：`audit_logs.action = identity.bind`
5. 前端服务端预检 `users.where({wxIdentityKey: wxIdentityKey_new}).count() === 0` 在第 3 步前执行；**仅用于友好提示**，DB UNIQUE 才是兜底

**小程序后续登录查询**

```
const doc = await db.collection('users')
  .where({ wxIdentityKey: 'openid:' + openid })
  .get();
```

`wxIdentityKey` 上的 DB UNIQUE + 单字段索引（隐含于 UNIQUE）足以支撑等值查询；无需另为 `wxOpenId` 建索引。

**`wxIdentityKey` 在 security 角色上的形态**

security 不要求绑定微信，初始化与创建后 `wxIdentityKey` 始终为 `"unbound:<users._id>"`。多个 security 账号的 unbound marker 因各自 `_id` 不同而不重复，**永远不会因为多个 `null` 触发 UNIQUE 冲突**。

---

### 5.2 `colleges`

**作用**：学院字典。供所有业务表的 `collegeId` 外键引用与初始化数据创建。

| 字段名 | 类型 | 必填 | 默认值 | 示例 | 说明 | 敏感 | 数据来源 | 客户端允许 | 索引 | 关联 |
|---|---|---|---|---|---|---|---|---|---|---|
| `_id` | String | 是 | — | `college_cs` | 学院业务主键（硬编码于初始化脚本） | 否 | seed | 否 | 唯一主键 | — |
| `name` | String | 是 | — | `计算机学院` | 学院全称 | 否 | seed | 否 | 否 | — |
| `shortName` | String | 否 | `null` | `计院` | 简称 | 否 | seed | 否 | 否 | — |
| `aliases` | Array | 否 | `[]` | `["计算机","计院"]` | 历史名称或别名 | 否 | seed | 否 | 否 | — |
| `status` | String | 是 | `active` | `active` | 学院状态：`active` / `disabled` | 否 | server | 否 | 是 | — |
| `createdAt` | Date | 是 | — | `Date(...)` | 创建时间 | 否 | seed | 否 | 否 | — |
| `updatedAt` | Date | 是 | — | `Date(...)` | 更新时间 | 否 | server | 否 | 否 | — |

**子约束**
- `_id` 一旦在初始化脚本中确定，业务表 `collegeId` 快照需保留业务学期内的可追溯性；学院合并/改名仅改 `name`，不改 `_id`
- `status=disabled` 时，新业务不再产生该 `collegeId` 引用；旧业务记录保留

---

### 5.3 `risk_rules`

**作用**：风险评级阈值与重点类型的运行时配置。第一版仅需一条 `status=enabled` 的默认记录。

| 字段名 | 类型 | 必填 | 默认值 | 示例 | 说明 | 敏感 | 数据来源 | 客户端允许 | 索引 | 关联 |
|---|---|---|---|---|---|---|---|---|---|---|
| `_id` | String | 是 | — | `rule_default` | 规则标识（硬编码） | 否 | seed | 否 | 唯一主键 | — |
| `name` | String | 是 | — | `第一版默认风险规则` | 人类可读名称 | 否 | seed / server | 否 | 否 | — |
| `version` | String | 是 | `v1` | `v1` | 语义化版本号；与 `_id` 共同唯一 | 否 | seed / server | 否 | 是 | — |
| `status` | String | 是 | `enabled` | `enabled` | 启用状态：`enabled` / `disabled`；第一版只允许一条 `enabled` | 否 | server | 否 | 是 | — |
| `highAmount` | Number | 是 | `5000` | `5000` | 高风险金额阈值（元） | 否 | seed / server | 否 | 否 | — |
| `midAmountMin` | Number | 是 | `1` | `1` | 中风险最小金额（元） | 否 | seed / server | 否 | 否 | — |
| `repeatAlertWindowDays` | Number | 是 | `30` | `30` | 重复预警统计窗口（天） | 否 | seed / server | 否 | 否 | — |
| `highAlertRepeatCount` | Number | 是 | `3` | `3` | 高风险重复预警次数阈值 | 否 | seed / server | 否 | 否 | — |
| `midAlertRepeatCount` | Number | 是 | `2` | `2` | 中风险重复预警次数阈值 | 否 | seed / server | 否 | 否 | — |
| `slaFirstFollowHours` | Number | 是 | `48` | `48` | 首次跟进 SLA（小时） | 否 | seed / server | 否 | 否 | — |
| `keyFraudTypes` | Array | 是 | — | `["part_time_scam","impersonate_public","fake_loan","fake_refund"]` | 重点诈骗类型枚举数组 | 否 | seed / server | 否 | 否 | — |
| `updatedBy` | String | 是 | — | `usr_sec_001` | 最近更新者 | 是 | server | 否 | 否 | `users._id` |
| `createdAt` | Date | 是 | — | `Date(...)` | 创建时间 | 否 | seed | 否 | 否 | — |
| `updatedAt` | Date | 是 | — | `Date(...)` | 更新时间 | 否 | server | 否 | 否 | — |

**枚举（`keyFraudTypes` 稳定英文值）**
| 中文 | 枚举值 |
|---|---|
| 刷单返利 | `part_time_scam` |
| 冒充公检法 | `impersonate_public` |
| 虚假贷款 | `fake_loan` |
| 冒充客服退款 | `fake_refund` |
| 杀猪盘 | `pig_butchering` |
| 虚假投资 | `fake_investment` |
| 其他 | `other` |

**子约束**
- 第一版**只允许一条 `status=enabled` 记录**；新增启用版本时，调用 `updateRiskRule` 云函数在事务内将旧版置 `disabled`、新版置 `enabled`
- `risk_rules` 第一版**不开放客户端直读**，全部由 `getRiskRule` / `updateRiskRule` 云函数中介；列表展示可通过云函数取值
- 业务表（`alerts`、`fraud_reports`）的 `riskRuleId` 保存触发时的规则 `_id`，作为审计快照

---

### 5.4 `alerts`

**作用**：保卫处人工创建的预警主表。`alerts.status` 是预警当前状态权威源。

| 字段名 | 类型 | 必填 | 默认值 | 示例 | 说明 | 敏感 | 数据来源 | 客户端允许 | 索引 | 关联 |
|---|---|---|---|---|---|---|---|---|---|---|
| `_id` | String | 是 | — | `alt_a1b2c3d4e5f7` | 预警主键 | 否 | server | 否 | 唯一主键 | — |
| `targetStudentId` | String | 是 | — | `usr_a1b2c3d4e5f7` | 目标学生 | 是 | server（从 students 表取） | 否 | 是（组合） | `users._id` |
| `collegeId` | String | 是 | — | `college_cs` | 学院快照，下发时写入 | 否 | server | 否 | 是（组合） | `colleges._id` |
| `title` | String | 是 | — | `警惕刷单返利联系` | 预警标题（小程序展示用） | 否 | server（Web 端提交） | 否 | 否 | — |
| `content` | String | 是 | — | `请勿向陌生账号转账…` | 提醒内容 | 是 | server | 否 | 否 | — |
| `sourceType` | String | 是 | `manual` | `manual` | 来源类型；第一版固定 `manual` | 否 | server | 否 | 是 | — |
| `sourceReference` | String | 否 | `null` | `96110-20260906-01` | 来源参考号（人工填） | 是 | server | 否 | 否 | — |
| `riskLevel` | String | 是 | — | `high` | 服务端计算：`low` / `medium` / `high` | 否 | derived | 否 | 是 | — |
| `riskReasons` | Array | 是 | `[]` | `["has_loss","amount>=high"]` | 触发因素快照（字符串枚举数组） | 否 | derived | 否 | 否 | — |
| `riskRuleId` | String | 是 | — | `rule_default` | 计算时使用的 `risk_rules._id` 快照 | 否 | derived | 否 | 是 | `risk_rules._id` |
| `status` | String | 是 | `pending_dispatch` | `sent` | 预警当前状态权威 | 否 | server | 否 | 是（组合） | — |
| `issuedBy` | String | 条件必填 | — | `usr_sec_001` | 下发人；`status >= sent` 时必有 | 是 | server | 否 | 是 | `users._id` |
| `issuedAt` | Date | 条件必填 | — | `Date(...)` | 下发时间 | 否 | server | 否 | 是（组合） | — |
| `viewedAt` | Date | 条件必填 | — | `Date(...)` | 学生首次查看时间（幂等） | 否 | server | 否 | 否 | — |
| `closedAt` | Date | 条件必填 | — | `Date(...)` | 关闭时间；`status=closed` 时必有 | 否 | server | 否 | 是（组合） | — |
| `closeReason` | String | 条件必填 | — | `关联事项已结案` | 关闭原因；`status=closed` 时必填 | 是 | server | 否 | 否 | — |
| `createdAt` | Date | 是 | — | `Date(...)` | 创建时间 | 否 | server | 否 | 否 | — |
| `updatedAt` | Date | 是 | — | `Date(...)` | 更新时间 | 否 | server | 否 | 否 | — |

**状态枚举（`status`）**
| 中文 | 枚举值 |
|---|---|
| 待下发 | `pending_dispatch` |
| 已下发 | `sent` |
| 已查看 | `viewed` |
| 跟进中 | `following_up` |
| 已关闭 | `closed` |

> §10.1 状态机：`pending_dispatch → sent → viewed → following_up → closed`；`closed` 为终态，不可重回激活。

**子约束**
- 不存 `reportIds[]` 数组；与工单的单向关联由 `fraud_reports.sourceAlertId` 完成
- 一条预警最多被一张工单以 `sourceAlertId` 引用（业务约束由 `fraud_reports.sourceAlertKey` DB UNIQUE 兜底，详见 §10.3；`alerts` 本集合不参与该 UNIQUE，本字段不写库端反向索引）

---

### 5.5 `fraud_reports`

**作用**：学生上报工单主表。`fraud_reports.status` 是工单当前状态权威源。

| 字段名 | 类型 | 必填 | 默认值 | 示例 | 说明 | 敏感 | 数据来源 | 客户端允许 | 索引 | 关联 |
|---|---|---|---|---|---|---|---|---|---|---|
| `_id` | String | 是 | — | `rpt_a1b2c3d4e5f7` | 工单主键 | 否 | server | 否 | 唯一主键 | — |
| `reporterId` | String | 是 | — | `usr_a1b2c3d4e5f7` | 上报学生 | 是 | derived（= session.userId） | 否（不能写自己以外的 ID） | 是（组合） | `users._id` |
| `collegeId` | String | 是 | — | `college_cs` | 提交时学院快照 | 否 | derived（= users.collegeId） | 否 | 是（组合） | `colleges._id` |
| `sourceAlertId` | String | 否 | `null` | `alt_a1b2c3d4e5f7` | 关联预警 `_id`（单向）；可空，独立上报时为 `null` | 否 | client（可选，但由服务端校验存在性和唯一性）/ null | 是（仅在创建时） | 是（单字段非唯一） | `alerts._id` |
| `sourceAlertKey` | String | 是 | — | `alert:alt_a1b2c3d4e5f7` / `standalone:rpt_xxx` | **"预警→直接工单" 数据库级唯一约束键**：由预警产生 → `alert:<sourceAlertId>`；独立上报 → `standalone:<reportId>`。该字段始终存在不为 null，承担"一条预警最多一张工单"的并发唯一性兜底（DB UNIQUE） | 否 | server | 否 | **UNIQUE（数据库级）** | — |
| `fraudType` | String | 是 | — | `part_time_scam` | 诈骗类型（见下方枚举） | 否 | client | 是（仅创建时） | 是 | — |
| `incidentAt` | Date | 是 | — | `Date(...)` | 诈骗事件发生时间 | 否 | client | 是（仅创建时） | 是（组合） | — |
| `hasLoss` | Boolean | 是 | — | `true` | 是否已造成实际损失 | 是 | client | 是（仅创建时） | 是 | — |
| `involvedAmount` | Number | 是 | — | `3500` | 涉及金额（学生填报，参与风险研判，不参与损失统计） | 是 | client | 是（仅创建时） | 是 | — |
| `stillContacting` | Boolean | 否 | `false` | `true` | 是否仍与可疑方联系 | 是 | client | 是（仅创建时） | 是 | — |
| `platform` | String | 否 | `null` | `QQ` | 涉及平台 | 是 | client | 是（仅创建时） | 否 | — |
| `suspiciousAccount` | String | 否 | `null` | `12345678` | 可疑账号或网址 | 是 | client | 是（仅创建时） | 否 | — |
| `narrative` | String | 是 | — | `收到刷单返利链接后转账` | 事件经过 | 是 | client | 是（仅创建时） | 否 | — |
| `contactMobile` | String | 否 | `null` | `13800138000` | 回访联系电话 | 是 | client | 是（仅创建时） | 否 | — |
| `studentRemark` | String | 否 | `null` | `已停止转账` | 学生补充说明 | 是 | client | 是（仅创建时） | 否 | — |
| `riskLevel` | String | 是 | — | `high` | 服务端计算：`low` / `medium` / `high` | 否 | derived | 否 | 是（组合） | — |
| `riskReasons` | Array | 是 | `[]` | `["has_loss"]` | 触发因素快照 | 否 | derived | 否 | 否 | — |
| `riskRuleId` | String | 是 | — | `rule_default` | 计算时使用的 `risk_rules._id` | 否 | derived | 否 | 否 | `risk_rules._id` |
| `status` | String | 是 | `pending_counselor_verify` | `pending_security_verify` | 工单当前状态权威 | 否 | server | 否 | 是（组合） | — |
| `currentHandlerId` | String | 否 | `null` | `usr_c_001` | 当前责任人 | 是 | derived（按状态机迁移时设置） | 否 | 否 | `users._id` |
| `assignedCounselorId` | String | 否 | `null` | `usr_c_001` | 学院指派/首次核实的辅导员 | 是 | derived | 否 | 是（组合） | `users._id` |
| `returnReason` | String | 条件必填 | `null` | `需补充联系情况` | 保卫处退回原因；`security_dispositions.action=return` 时由处置表承担 | 是 | server（仅保卫处写入） | 否 | 否 | — |
| `finalOutcome` | String | 条件必填 | `null` | `loss_confirmed` | 保卫处最终结论；`status=closed` 时必填 | 否 | server | 否 | 否 | — |
| `confirmedLossAmount` | Number | 条件必填 | `null` | `3500` | **保卫处确认损失金额**；与 `involvedAmount` 区分；统计口径 | 是 | server | 否 | 否 | — |
| `closedBy` | String | 条件必填 | `null` | `usr_c_001` | 结案人；辅导员或保卫处 | 是 | server | 否 | 否 | `users._id` |
| `submittedAt` | Date | 是 | — | `Date(...)` | 提交时间 | 否 | server | 否 | 是（组合） | — |
| `closedAt` | Date | 条件必填 | — | `Date(...)` | 结案时间；`status=closed` 时必有 | 否 | server | 否 | 是（组合） | — |
| `createdAt` | Date | 是 | — | `Date(...)` | 创建时间 | 否 | server | 否 | 否 | — |
| `updatedAt` | Date | 是 | — | `Date(...)` | 更新时间 | 否 | server | 否 | 否 | — |

**`fraudType` 枚举（与 `risk_rules.keyFraudTypes` 共享）**
```
part_time_scam, impersonate_public, fake_loan, fake_refund,
pig_butchering, fake_investment, other
```

**`finalOutcome` 枚举**
| 中文 | 枚举值 |
|---|---|
| 损失已确认 | `loss_confirmed` |
| 损失未遂 | `loss_no_loss` |
| 误报 | `misreport` |
| 纯咨询 | `consultation` |
| 需进一步调查 | `under_investigation` |

> §5.3 提到的 misreport / consultation / normal_case 区分：通过 `finalOutcome` 即可区分（`misreport` / `consultation` / `loss_confirmed` 等）。**第一版不引入复杂分案标签字段。**

**状态枚举（`status`）**
| 中文 | 枚举值 |
|---|---|
| 待辅导员核实 | `pending_counselor_verify` |
| 待保卫处核验 | `pending_security_verify` |
| 处置中 | `in_process` |
| 已结案 | `closed` |

> §10.2 状态机：`pending_counselor_verify → pending_security_verify → in_process → closed`；允许 `pending_counselor_verify → closed`（辅导员直接结案受限路径）；允许 `pending_security_verify → pending_counselor_verify`（保卫处退回）。

**子约束**
- `involvedAmount` 与 `confirmedLossAmount` 在文档内**严格区分**：前者是学生填报的"涉及金额"，后者是保卫处结案时确认的"实际损失"。统计受骗金额以 `confirmedLossAmount` 为准。
- 第一版不设 `withdrawn` 状态；不允许学生撤回（参见 SRS §17.7）。
- 第一版不增加附件字段或上传入口（参见 SRS §17.11）。

**`sourceAlertKey` 与 `sourceAlertId` 的职责分离**
- `sourceAlertId`：**业务字段**，描述"该工单由哪条预警产生"，可空（独立上报时为 `null`）；不建 DB UNIQUE
- `sourceAlertKey`：**一致性辅助字段**，承担"一条预警最多一张直接工单"的并发唯一性兜底；**永不为 `null`**（两条取值路径见下）

`sourceAlertKey` 在创建工单时由服务端生成：
| 来源 | `sourceAlertId` | `sourceAlertKey` |
|---|---|---|
| 由预警产生 | `<alertId>` | `alert:<alertId>` |
| 独立上报 | `null` | `standalone:<reportId>` |

`alert:` 与 `standalone:` 前缀命名空间互不重叠；同一 `users` 不可能对同一 `alert` 跨前缀冲突，因此 DB UNIQUE 索引不会误拦合法独立上报。

权威关系保持：业务查询、UI 展示、统计全部使用 `fraud_reports.sourceAlertId`；`sourceAlertKey` 仅为 DB 一致性服务，不暴露给前端 UI、不替代 `sourceAlertId`、不出现在 API 响应字段中（仅供内部维护时审计）。`alerts` 仍不增 `reportIds` 数组。

**`submitReport` 并发处理流程（服务端）**

```
1. 服务端生成 reportId = util.generateId("rpt_")
2. 接收 event = { fraudType, incidentAt, ... , sourceAlertId? }
3. if event.sourceAlertId:
     a. 校验 alerts._id == event.sourceAlertId 存在
     b. 校验 alerts.targetStudentId == session.userId（不能代他人提交）
     c. 计算 sourceAlertKey_new = "alert:" + event.sourceAlertId
     d. 预检（友好提示）fraud_reports.where({sourceAlertKey: sourceAlertKey_new}).count() === 0
        - 不为 0 → 返回 "该预警已经提交过关联工单"，不写入
   else:
     a. 计算 sourceAlertKey_new = "standalone:" + reportId
4. 写入 fraud_reports（包含 sourceAlertKey_new）
5. if 写入触发 sourceAlertKey UNIQUE 冲突：
   - 捕获异常 → 返回 "该预警已经提交过关联工单"（不向客户端泄露冲突值）
6. 写 audit_logs.action = report.create
```

关键：**CloudBase 事务使用快照隔离**，第 3.d 步的 `count()===0` 检查**仅作友好提示**，并发下两个不同工单都通过预检仍可能。**最终并发兜底是第 5 步捕获 `sourceAlertKey` DB UNIQUE 冲突**——预检失败返回业务文案，预检通过但 UNIQUE 冲突时返回通用文案（同 §5.1 wxIdentityKey 模式）。

---

### 5.6 `counselor_followups`

**作用**：辅导员对预警或工单的追加跟进记录。不充当"当前状态"权威。

| 字段名 | 类型 | 必填 | 默认值 | 示例 | 说明 | 敏感 | 数据来源 | 客户端允许 | 索引 | 关联 |
|---|---|---|---|---|---|---|---|---|---|---|
| `_id` | String | 是 | — | `flw_a1b2c3d4e5f7` | 跟进记录主键 | 否 | server | 否 | 唯一主键 | — |
| `businessType` | String | 是 | — | `report` | 跟进对象类型：`alert` / `report` | 否 | derived | 否 | 是（组合） | — |
| `businessId` | String | 是 | — | `rpt_a1b2c3d4e5f7` | 跟进对象 `_id` | 否 | derived | 否 | 是（组合） | `alerts._id` 或 `fraud_reports._id` |
| `studentId` | String | 是 | — | `usr_a1b2c3d4e5f7` | 关联学生 | 是 | derived | 否 | 是（组合） | `users._id` |
| `collegeId` | String | 是 | — | `college_cs` | 学院快照 | 否 | derived | 否 | 是 | `colleges._id` |
| `counselorId` | String | 是 | — | `usr_c_001` | 实际跟进辅导员 | 是 | derived（= session.userId） | 否 | 是（组合） | `users._id` |
| `status` | String | 是 | `pending` | `completed` | 本次跟进的完成状态：`pending` / `in_progress` / `completed` | 否 | server | 否 | 是（组合） | — |
| `actionType` | String | 是 | — | `contact` | 动作类型枚举（见下方） | 否 | client | 是（创建时） | 否 | — |
| `content` | String | 是 | — | `已电话联系学生本人` | 跟进内容/意见 | 是 | client | 是（创建时） | 否 | — |
| `focusFlag` | Boolean | 否 | `false` | `true` | 本次跟进是否标记重点关注；**仅事件流**，非权威源 | 是 | client | 是（创建时） | 否 | — |
| `focusReason` | String | 条件必填 | `null` | `仍有联系风险` | 重点关注原因；`focusFlag=true` 时必填 | 是 | client | 是（创建时） | 否 | — |
| `transferReason` | String | 条件必填 | `null` | `已造成实际损失` | 转保卫处/退回补充原因；`actionType=transfer_to_security` 时必填 | 是 | client | 是（创建时） | 否 | — |
| `contactedAt` | Date | 否 | `null` | `Date(...)` | 实际联系时间 | 否 | client | 是（创建时） | 否 | — |
| `contactMethod` | String | 否 | `null` | `phone` | 联系方式：`phone` / `wechat` / `in_person` / `other` | 否 | client | 是（创建时） | 否 | — |
| `verificationResult` | String | 条件必填 | `null` | `misreport` | 初步核实结论（见下方枚举） | 否 | client | 是（创建时） | 否 | — |
| `createdAt` | Date | 是 | — | `Date(...)` | 创建时间 | 否 | server | 否 | 否 | — |
| `updatedAt` | Date | 是 | — | `Date(...)` | 更新时间 | 否 | server | 否 | 否 | — |
| `completedAt` | Date | 条件必填 | `null` | `Date(...)` | 本次跟进完成时间；`status=completed` 时必填 | 否 | server | 否 | 是（组合） | — |

**`actionType` 枚举**
| 中文 | 枚举值 |
|---|---|
| 首次联系 | `contact` |
| 核实信息 | `verify_info` |
| 标记重点关注 | `mark_focus` |
| 取消重点关注 | `unmark_focus` |
| 转保卫处 | `transfer_to_security` |
| 接收退回补充 | `receive_return` |
| 直接结案 | `close_locally` |
| 补充说明 | `note` |

**`verificationResult` 枚举**
| 中文 | 枚举值 |
|---|---|
| 初步属实 | `confirmed` |
| 疑似但待核 | `suspected` |
| 误报 | `misreport` |
| 纯咨询 | `consultation` |
| 非涉诈 | `not_fraud` |

**`status` 枚举**
| 中文 | 枚举值 |
|---|---|
| 待跟进 | `pending` |
| 跟进中 | `in_progress` |
| 已完成 | `completed` |

**子约束**
- 同一 `(businessType, businessId)` 可有多条追加记录，每次新跟进创建新 `_id`，**不 reopen 旧记录**（SRS §10.3、§17.9）
- 本集合内的 `focusFlag` 字段仅作"事件流"，不参与 UI 当前重点关注态读取；当前态来源是 `users.focusFlag`

---

### 5.7 `security_dispositions`

**作用**：保卫处对工单的追加处置记录（核验、开始处置、退回、结案）。不充当"工单当前状态"权威。

| 字段名 | 类型 | 必填 | 默认值 | 示例 | 说明 | 敏感 | 数据来源 | 客户端允许 | 索引 | 关联 |
|---|---|---|---|---|---|---|---|---|---|---|
| `_id` | String | 是 | — | `dsp_a1b2c3d4e5f7` | 处置记录主键 | 否 | server | 否 | 唯一主键 | — |
| `reportId` | String | 是 | — | `rpt_a1b2c3d4e5f7` | 对应工单 | 否 | derived | 否 | 是（组合） | `fraud_reports._id` |
| `studentId` | String | 是 | — | `usr_a1b2c3d4e5f7` | 关联学生 | 是 | derived | 否 | 是（组合） | `users._id` |
| `collegeId` | String | 是 | — | `college_cs` | 学院快照 | 否 | derived | 否 | 是（组合） | `colleges._id` |
| `operatorId` | String | 是 | — | `usr_sec_001` | 保卫处操作者 | 是 | derived（= session.userId） | 否 | 是（组合） | `users._id` |
| `action` | String | 是 | — | `verify` | 动作类型（见下方枚举） | 否 | client | 是（创建时） | 是 | — |
| `content` | String | 是 | — | `已电话确认并指导止损` | 处置/核验/退回说明 | 是 | client | 是（创建时） | 否 | — |
| `verificationResult` | String | 条件必填 | `null` | `confirmed` | 核验结论（见下方枚举） | 否 | client | 是（创建时） | 否 | — |
| `reportStatusBefore` | String | 是 | — | `pending_security_verify` | 操作前工单状态（快照） | 否 | derived | 否 | 否 | — |
| `reportStatusAfter` | String | 是 | — | `in_process` | 操作后工单状态（快照） | 否 | derived | 否 | 否 | — |
| `returnReason` | String | 条件必填 | `null` | `需补充联系情况` | 退回辅导员原因；`action=return` 时必填 | 是 | client | 是（创建时） | 否 | — |
| `confirmedLossAmount` | Number | 条件必填 | `null` | `3500` | 本次处置时确认损失金额；最终值由结案动作承担 | 是 | client | 是（创建时） | 否 | — |
| `finalOutcome` | String | 条件必填 | `null` | `loss_confirmed` | 最终结论；`action=close` 时必填 | 否 | client | 是（创建时） | 否 | — |
| `externalReferenceNo` | String | 否 | `null` | `CASE-2026-001` | 外部协作参考号 | 是 | client | 是（创建时） | 否 | — |
| `nextActionAt` | Date | 否 | `null` | `Date(...)` | 下一步计划时间 | 否 | client | 是（创建时） | 否 | — |
| `createdAt` | Date | 是 | — | `Date(...)` | 操作时间 | 否 | server | 否 | 是（组合） | — |
| `updatedAt` | Date | 是 | — | `Date(...)` | 更新时间 | 否 | server | 否 | 否 | — |

**`action` 枚举**
| 中文 | 枚举值 | 触发 |
|---|---|---|
| 核验 | `verify` | `pending_security_verify` |
| 开始处置 | `start_process` | `pending_security_verify → in_process` |
| 退回 | `return` | `pending_security_verify → pending_counselor_verify` |
| 结案 | `close` | `in_process → closed` 或 `pending_security_verify → closed`（误报快速结案） |

**`verificationResult` 枚举**（与 §5.6 共享语义）
`confirmed` / `suspected` / `misreport` / `consultation` / `not_fraud`

**`finalOutcome` 枚举**（与 `fraud_reports.finalOutcome` 同）

**子约束**
- 不创建 `handling_records`；本集合即为唯一处置历史
- `fraud_reports.status` 才是工单当前状态权威；本集合的 `reportStatusBefore/After` 仅作操作上下文快照

---

### 5.8 `learning_articles`

**作用**：反诈文章与案例展示的内容表。

| 字段名 | 类型 | 必填 | 默认值 | 示例 | 说明 | 敏感 | 数据来源 | 客户端允许 | 索引 | 关联 |
|---|---|---|---|---|---|---|---|---|---|---|
| `_id` | String | 是 | — | `art_a1b2c3d4e5f7` | 文章主键 | 否 | server | 否 | 唯一主键 | — |
| `title` | String | 是 | — | `警惕刷单返利诈骗` | 标题 | 否 | server（Web 后台） | 否 | 否 | — |
| `summary` | String | 是 | — | `先垫付后返利均有风险` | 摘要 | 否 | server | 否 | 否 | — |
| `content` | String | 是 | — | `…长文本…` | 正文 | 否（案例必须去标识化，由发布流程把关） | server | 否 | 否 | — |
| `category` | String | 是 | — | `case` | 文章类型：`case` / `knowledge` / `tip` | 否 | server | 否 | 是（组合） | — |
| `fraudTags` | Array | 是 | `[]` | `["part_time_scam"]` | 诈骗类型标签（与风险规则枚举共享） | 否 | server | 否 | 否 | — |
| `publishStatus` | String | 是 | `draft` | `published` | 发布状态：`draft` / `published` / `disabled` | 否 | server | 否 | 是（组合） | — |
| `publishedAt` | Date | 条件必填 | `null` | `Date(...)` | 发布时间；`publishStatus=published` 时必有 | 否 | server | 否 | 是（组合） | — |
| `createdBy` | String | 是 | — | `usr_sec_001` | 发布人 | 是 | derived（= session.userId） | 否 | 否 | `users._id` |
| `createdAt` | Date | 是 | — | `Date(...)` | 创建时间 | 否 | server | 否 | 否 | — |
| `updatedAt` | Date | 是 | — | `Date(...)` | 更新时间 | 否 | server | 否 | 否 | — |

**子约束**
- 第一版不设附件字段（参见 SRS §17.11）
- 案例类文章的发布前脱敏责任在数据初始化与运维流程，**第一版不设计 in-DB 审核流字段**

---

### 5.9 `quiz_questions`

**作用**：自测题目库。`grading` 子对象是**服务端敏感字段**，学生取题接口严禁返回。

| 字段名 | 类型 | 必填 | 默认值 | 示例 | 说明 | 敏感 | 数据来源 | 客户端允许 | 索引 | 关联 |
|---|---|---|---|---|---|---|---|---|---|---|
| `_id` | String | 是 | — | `qst_a1b2c3d4e5f7` | 题目主键 | 否 | server | 否 | 唯一主键 | — |
| `questionType` | String | 是 | — | `single_choice` | 题型；第一版只允许 `single_choice` | 否 | server | 否 | 否 | — |
| `stem` | String | 是 | — | `陌生人要求先转账再返利，应如何做？` | 题干 | 否 | server | 否 | 否 | — |
| `options` | Array | 是 | — | `[{id:"A",text:"拒绝转账并报警"}, {id:"B",text:"按指示转账"}]` | 面向客户端的选项 | 否 | server | 否 | 否 | — |
| `grading` | Object | 是 | — | `{correctOptionId:"A",score:1,explanation:"先转账即高风险"}` | **服务端敏感**：正确答案、分数、解析 | 是 | server | **否（仅服务端读取）** | 否 | — |
| `fraudTags` | Array | 是 | `[]` | `["part_time_scam"]` | 题目标签 | 否 | server | 否 | 否 | — |
| `status` | String | 是 | `enabled` | `enabled` | 启用状态：`enabled` / `disabled` | 否 | server | 否 | 是 | — |
| `createdAt` | Date | 是 | — | `Date(...)` | 创建时间 | 否 | server | 否 | 否 | — |
| `updatedAt` | Date | 是 | — | `Date(...)` | 更新时间 | 否 | server | 否 | 否 | — |

**`grading` 子结构**
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `correctOptionId` | String | 是 | 正确答案 id |
| `score` | Number | 是 | 本题得分 |
| `explanation` | String | 是 | 答案解析 |

**子约束**
- `grading` 字段整体在 `getQuizQuestions` 云函数返回时被剥离；服务端判分仅在内部使用
- 第一版题型严格只允许 `single_choice`；多选/判断在第二版再加

---

### 5.10 `quiz_attempts`

**作用**：学生一次完整答卷的记录（按 SRS v0.2 §8.10 整张答卷一条记录模型；不采用"每题一条"）。

| 字段名 | 类型 | 必填 | 默认值 | 示例 | 说明 | 敏感 | 数据来源 | 客户端允许 | 索引 | 关联 |
|---|---|---|---|---|---|---|---|---|---|---|
| `_id` | String | 是 | — | `qat_a1b2c3d4e5f7` | 答卷主键 | 否 | server | 否 | 唯一主键 | — |
| `userId` | String | 是 | — | `usr_a1b2c3d4e5f7` | 答题学生 | 是 | derived（= session.userId） | 否 | 是（组合） | `users._id` |
| `answers` | Array | 是 | — | `[{questionId:"qst_xxx",selectedOptionId:"A",isCorrect:true,score:1}]` | 每题作答明细 | 否 | server（判分后写入） | 否 | 否 | `quiz_questions._id` |
| `totalScore` | Number | 是 | — | `8` | 本次答卷总得分 | 否 | derived | 否 | 否 | — |
| `fullScore` | Number | 是 | — | `10` | 满分 | 否 | server | 否 | 否 | — |
| `submittedAt` | Date | 是 | — | `Date(...)` | 提交时间 | 否 | server | 否 | 是（组合） | — |
| `createdAt` | Date | 是 | — | `Date(...)` | 创建时间 | 否 | server | 否 | 否 | — |
| `updatedAt` | Date | 是 | — | `Date(...)` | 更新时间 | 否 | server | 否 | 否 | — |

**`answers[]` 子结构**
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `questionId` | String | 是 | 引用 `quiz_questions._id` |
| `selectedOptionId` | String | 是 | 学生选项 id |
| `isCorrect` | Boolean | 是 | 判分结果（服务端写入） |
| `score` | Number | 是 | 本题得分 |

**统计口径（与 SRS §12 一致）**
- 参与反诈学习人数 = `learning_records.userId ∪ quiz_attempts.userId` 去重
- 自测正确率 = `sum(answers[].isCorrect=true) / sum(answers[].length)` 在选定范围内

**子约束**
- 防重复写入：服务端在 `submitQuizAttempt` 中按 `(userId, submittedAt within 10s window)` 校验相同 `answers` 哈希，存在则拒绝并提示
- 第一版不引入"试卷实体"集合（参见 SRS v0.2 排除项）

---

### 5.11 `learning_records`

**作用**：学生完成一篇文章学习的事件记录。**自测行为由 `quiz_attempts` 承担，本集合不重复记录。**

| 字段名 | 类型 | 必填 | 默认值 | 示例 | 说明 | 敏感 | 数据来源 | 客户端允许 | 索引 | 关联 |
|---|---|---|---|---|---|---|---|---|---|---|
| `_id` | String | 是 | — | `lrn_a1b2c3d4e5f7` | 学习记录主键 | 否 | server | 否 | 唯一主键 | — |
| `userId` | String | 是 | — | `usr_a1b2c3d4e5f7` | 学生 | 是 | derived（= session.userId） | 否 | 是（唯一组合） | `users._id` |
| `contentType` | String | 是 | `article` | `article` | 学习内容类型；第一版只允许 `article` | 否 | server | 否 | 是（组合） | — |
| `contentId` | String | 是 | — | `art_a1b2c3d4e5f7` | 已学习内容 `_id` | 否 | derived | 否 | 是（唯一组合） | `learning_articles._id` |
| `completedAt` | Date | 是 | — | `Date(...)` | 完成时间 | 否 | server | 否 | 是（组合） | — |
| `createdAt` | Date | 是 | — | `Date(...)` | 创建时间 | 否 | server | 否 | 否 | — |

**子约束**
- `userId + contentType + contentId` 组合唯一约束，避免重复刷量
- 第一版**不**为自测单独建 learning 记录（参见 SRS §17.12）；统计并集来自 `learning_records` ∪ `quiz_attempts`

---

### 5.12 `audit_logs`

**作用**：所有受审计动作的留痕记录。**唯一写入源：服务端审计云函数；客户端禁止 create/update/delete。**

| 字段名 | 类型 | 必填 | 默认值 | 示例 | 说明 | 敏感 | 数据来源 | 客户端允许 | 索引 | 关联 |
|---|---|---|---|---|---|---|---|---|---|---|
| `_id` | String | 是 | — | `aud_a1b2c3d4e5f7` | 审计主键 | 否 | server | 否 | 唯一主键 | — |
| `actorId` | String | 是 | — | `usr_c_001` | 操作者 | 是 | derived（= session.userId） | 否 | 是（组合） | `users._id` |
| `actorRole` | String | 是 | — | `counselor` | 操作者角色（事件发生时的快照） | 否 | derived（= session.role） | 否 | 是 | — |
| `actorCollegeId` | String | 否 | `null` | `college_cs` | 当时学院范围快照 | 否 | derived | 否 | 是（组合） | `colleges._id` |
| `action` | String | 是 | — | `report.transfer_to_security` | 操作类型（见动作字典） | 否 | server | 否 | 是（组合） | — |
| `resourceType` | String | 是 | — | `fraud_report` | 操作资源类型 | 否 | server | 否 | 是（组合） | — |
| `resourceId` | String | 是 | — | `rpt_a1b2c3d4e5f7` | 资源 `_id` | 否 | server | 否 | 是（组合） | — |
| `targetUserId` | String | 否 | `null` | `usr_a1b2c3d4e5f7` | 关联受影响用户（如有） | 是 | derived | 否 | 否 | `users._id` |
| `sensitivityLevel` | String | 是 | `low` | `high` | 敏感度：`low` / `medium` / `high`，影响审计详情展示脱敏 | 否 | server | 否 | 否 | — |
| `result` | String | 是 | — | `success` | 成功/失败：`success` / `failure` | 否 | server | 否 | 是（组合） | — |
| `failureReason` | String | 条件必填 | `null` | `学院权限不足` | 失败原因；`result=failure` 时必填 | 否 | server | 否 | 否 | — |
| `ip` | String | 否 | `null` | `203.0.113.10` | 客户端 IP（可选，第一版可不采集） | 是 | server | 否 | 否 | — |
| `beforeSummary` | Object | 否 | `null` | `{status:"pending_counselor_verify"}` | 最小必要的变更前摘要（不复制敏感正文） | 是 | derived | 否 | 否 | — |
| `afterSummary` | Object | 否 | `null` | `{status:"pending_security_verify"}` | 最小必要的变更后摘要 | 是 | derived | 否 | 否 | — |
| `requestId` | String | 是 | — | `req_xxx` | 请求追踪号 | 否 | server | 否 | 否 | — |
| `createdAt` | Date | 是 | — | `Date(...)` | 写入时间 | 否 | server | 否 | 是（组合） | — |
| `updatedAt` | Date | 是 | — | `Date(...)` | 更新时间（本集合通常 = createdAt；保留以备未来审计回滚） | 否 | server | 否 | 否 | — |

**动作字典（`action`）—— 第一版完整列表**
| 集合/范围 | 动作字符串 |
|---|---|
| 身份 | `identity.bind_success`, `identity.bind_failure`, `identity.login_success`, `identity.login_failure` |
| 通用 | `access.denied`, `access.sensitive_view` |
| 预警 | `alert.create`, `alert.issue`, `alert.view`, `alert.close` |
| 工单 | `report.create`, `report.view`, `report.transfer_to_security`, `report.close_locally`, `report.close_security` |
| 跟进 | `counselor_followup.create`, `counselor_followup.mark_focus`, `counselor_followup.unmark_focus` |
| 处置 | `security_disposition.verify`, `security_disposition.start_process`, `security_disposition.return`, `security_disposition.close` |
| 风险规则 | `risk_rule.update` |
| 内容 | `learning_article.publish`, `learning_article.unpublish`, `quiz_attempt.submit` |
| 用户档案 | `user.update_role`, `user.update_college`, `user.suspend`, `user.withdraw` |
| 数据导出 | `data.export` |

**子约束**
- **唯一写入源是云函数 `writeAuditLog`**；客户端直连全部 deny（数据库安全规则兜底：`"write": false`）
- `actorRole` 是"事件发生时角色快照"——即使后续 `users.role` 变更，历史审计行的 `actorRole` 不跟随变化；这是**刻意冗余**，用于审计准确性
- 摘要字段（`beforeSummary` / `afterSummary`）只保存最小必要的变更点（如 `status`、`riskLevel`），不复制定长敏感文本（参见 SRS §14）
- 审计保留 1 年（参见 SRS §17.12），第一版**不实现自动清理任务**

---

## 6. 枚举字典

> 云函数必须将下表枚举作为受控字典使用；任何来自客户端的字段值都需对照本表校验。

### 6.1 角色
| 值 |
|---|
| `student` |
| `counselor` |
| `security` |

### 6.2 用户账号状态
| 中文 | 值 |
|---|---|
| 在校/在职 | `active` |
| 已毕业/已离校 | `graduated` |
| 已停用 | `suspended` |
| 已撤销 | `withdrawn` |

### 6.3 学院状态
| 中文 | 值 |
|---|---|
| 启用 | `active` |
| 停用 | `disabled` |

### 6.4 风险等级
| 中文 | 值 |
|---|---|
| 低风险 | `low` |
| 中风险 | `medium` |
| 高风险 | `high` |

### 6.5 预警状态
| 中文 | 值 |
|---|---|
| 待下发 | `pending_dispatch` |
| 已下发 | `sent` |
| 已查看 | `viewed` |
| 跟进中 | `following_up` |
| 已关闭 | `closed` |

### 6.6 工单状态
| 中文 | 值 |
|---|---|
| 待辅导员核实 | `pending_counselor_verify` |
| 待保卫处核验 | `pending_security_verify` |
| 处置中 | `in_process` |
| 已结案 | `closed` |

### 6.7 跟进状态
| 中文 | 值 |
|---|---|
| 待跟进 | `pending` |
| 跟进中 | `in_progress` |
| 已完成 | `completed` |

### 6.8 风险规则状态
| 中文 | 值 |
|---|---|
| 启用 | `enabled` |
| 停用 | `disabled` |

### 6.9 文章发布状态
| 中文 | 值 |
|---|---|
| 草稿 | `draft` |
| 已发布 | `published` |
| 停用 | `disabled` |

### 6.10 题目状态 / 题型
| 字段 | 中文 | 值 |
|---|---|---|
| 状态 | 启用 | `enabled` |
| 状态 | 停用 | `disabled` |
| 题型（第一版） | 单选 | `single_choice` |

### 6.11 审计动作（节选；完整列表见 §5.12）
参见 §5.12 动作字典。

### 6.12 诈骗类型（共享于 `risk_rules.keyFraudTypes` / `fraud_reports.fraudType` / `learning_articles.fraudTags` / `quiz_questions.fraudTags`）
```
part_time_scam       // 刷单返利
impersonate_public   // 冒充公检法
fake_loan            // 虚假贷款
fake_refund          // 冒充客服退款
pig_butchering       // 杀猪盘
fake_investment      // 虚假投资
other                // 其他
```

### 6.13 结案最终结论（`finalOutcome`）
| 中文 | 值 |
|---|---|
| 损失已确认 | `loss_confirmed` |
| 损失未遂 | `loss_no_loss` |
| 误报 | `misreport` |
| 纯咨询 | `consultation` |
| 需进一步调查 | `under_investigation` |

### 6.14 跟进 / 处置动作类型
参见 §5.6 `counselor_followups.actionType` 与 §5.7 `security_dispositions.action` 两表。

---

## 7. 集合关联关系（外键引用一览）

| 源集合.字段 | 引用目标 | 类型 |
|---|---|---|
| `users.collegeId` | `colleges._id` | 外键（可空，security 角色可空） |
| `alerts.targetStudentId` | `users._id` | 外键 |
| `alerts.collegeId` | `colleges._id` | 外键（快照） |
| `alerts.issuedBy` | `users._id` | 外键（可空，pending_dispatch 时为空） |
| `alerts.riskRuleId` | `risk_rules._id` | 外键 |
| `fraud_reports.reporterId` | `users._id` | 外键 |
| `fraud_reports.collegeId` | `colleges._id` | 外键（快照） |
| `fraud_reports.sourceAlertId` | `alerts._id` | 外键（可空，单向） |
| `fraud_reports.assignedCounselorId` | `users._id` | 外键（可空） |
| `fraud_reports.currentHandlerId` | `users._id` | 外键（可空） |
| `fraud_reports.closedBy` | `users._id` | 外键（可空） |
| `fraud_reports.riskRuleId` | `risk_rules._id` | 外键 |
| `counselor_followups.businessId` | `alerts._id` 或 `fraud_reports._id` | 外键（按 `businessType` 路由） |
| `counselor_followups.studentId` | `users._id` | 外键 |
| `counselor_followups.collegeId` | `colleges._id` | 外键（快照） |
| `counselor_followups.counselorId` | `users._id` | 外键 |
| `security_dispositions.reportId` | `fraud_reports._id` | 外键 |
| `security_dispositions.studentId` | `users._id` | 外键 |
| `security_dispositions.collegeId` | `colleges._id` | 外键（快照） |
| `security_dispositions.operatorId` | `users._id` | 外键 |
| `learning_articles.createdBy` | `users._id` | 外键 |
| `quiz_attempts.userId` | `users._id` | 外键 |
| `quiz_attempts.answers[].questionId` | `quiz_questions._id` | 外键 |
| `learning_records.userId` | `users._id` | 外键 |
| `learning_records.contentId` | `learning_articles._id` | 外键 |
| `audit_logs.actorId` | `users._id` | 外键 |
| `audit_logs.actorCollegeId` | `colleges._id` | 外键（可空） |
| `audit_logs.targetUserId` | `users._id` | 外键（可空） |

> 所有外键仅云函数端做存在性校验；CloudBase 不支持外键级联，第一版**不**做级联物理删除。

---

## 8. 索引设计总表

> 索引策略原则：
> 1. 第一版只为本节列出的查询路径建索引；不为"以后可能用上"建索引
> 2. 唯一索引必须经过充分讨论；第一版的 DB UNIQUE 字段（`users.identityKey` / `users.wxIdentityKey` / `fraud_reports.sourceAlertKey` / `learning_records` 复合）全部以"替身字段承担业务唯一"为模式，详见 §5.1 / §5.5 / §8.2 / §10.3
> 3. 组合索引字段顺序遵从"等值 → 范围 / 时间倒序"原则

### 8.1 单字段索引

| 集合 | 字段 | 类型 | 说明 |
|---|---|---|---|
| `users` | `identityKey` | 单字段（非唯一，参见 §8.2 UNIQUE 说明） | 服务端绑定/校验时的等值查询加速键 |
| `users` | `wxIdentityKey` | 单字段（被 UNIQUE 覆盖，参见 §8.2） | 小程序登录 `wxIdentityKey = openid:<OPENID>` 等值查询主键；唯一索引已隐含 |
| `users` | `role` | 单字段 | 角色筛选、统计 |
| `users` | `collegeId` | 单字段 | 学院边界 |
| `users` | `status` | 单字段 | 账号状态筛选 |
| `users` | `studentNo` | 单字段（非唯一） | 学号查询 |
| `users` | `staffNo` | 单字段（非唯一） | 工号查询 |
| `users` | `username` | 单字段（非唯一） | Web 登录名查询 |
| `colleges` | `status` | 单字段 | 学院启用筛选 |
| `risk_rules` | `status` | 单字段 | 取启用版本 |
| `alerts` | `status` | 单字段 | 状态队列 |
| `alerts` | `riskLevel` | 单字段 | 风险筛选 |
| `alerts` | `sourceType` | 单字段 | 来源筛选 |
| `fraud_reports` | `status` | 单字段 | 工单队列 |
| `fraud_reports` | `riskLevel` | 单字段 | 风险筛选 |
| `fraud_reports` | `fraudType` | 单字段 | 类型筛选 |
| `counselor_followups` | `status` | 单字段 | 跟进状态筛选 |
| `security_dispositions` | `action` | 单字段 | 处置动作筛选 |
| `learning_articles` | `publishStatus` | 单字段 | 发布列表 |
| `learning_articles` | `category` | 单字段 | 分类筛选 |
| `quiz_questions` | `status` | 单字段 | 启用题筛选 |
| `audit_logs` | `actorRole` | 单字段 | 角色筛选 |
| `audit_logs` | `action` | 单字段 | 动作筛选 |
| `audit_logs` | `result` | 单字段 | 成功/失败筛选 |

### 8.2 唯一索引

| 集合 | 字段 | 唯一类型 | 说明 |
|---|---|---|---|
| `users` | `identityKey` | **UNIQUE（数据库级）** | "业务身份" 唯一键：兜底 `studentNo / staffNo / username` 不重复登记；三角色形成 `<role>:<登录标识>` 不重叠命名空间，不会出现"稀疏唯一索引将多个 null 视为重复"的歧义 |
| `users` | `wxIdentityKey` | **UNIQUE（数据库级）** | "微信身份" 唯一键：兜底 `wxOpenId` 不重复绑定；未绑定值 `unbound:<users._id>` 因 `_id` 唯一而不冲突；已绑定值 `openid:<OPENID>` 保证同一 OPENID 不绑多条 `users` 文档 |
| `fraud_reports` | `sourceAlertKey` | **UNIQUE（数据库级）** | "预警→直接工单" 唯一键：兜底 SRS §10.2"一条预警最多一张工单"的并发唯一性；`alert:<alertId>` 与 `standalone:<reportId>` 前缀命名空间互不重叠，永不为 null |
| `learning_records` | `userId + contentType + contentId` | 唯一（复合） | 防重复刷学习（用户/内容类型/内容 ID 都为必填，不存在 null 歧义） |

> **本设计的三类**"**业务唯一 + 替身 UNIQUE**"**模式共用同一原则**：
> 1. 业务原始字段（`wxOpenId / studentNo / staffNo / username / sourceAlertId`）均**不**建 DB 唯一索引（多文档 null 冲突）
> 2. 引入**替身字段**（`identityKey / wxIdentityKey / sourceAlertKey`），替身字段永不为 null，且通过前缀命名空间消除跨场景冲突
> 3. **DB UNIQUE 是最终并发兜底**；服务端 `where` 预检仅作友好提示

> **`users` 上唯一索引的合并策略**：`identityKey` 与 `wxIdentityKey` 各管一段，互相不重叠：
> - `identityKey` → "你是谁（业务身份）"
> - `wxIdentityKey` → "你从哪个微信进来"
> 
> 两个字段对每个文档都必有值，因此都可走 DB UNIQUE 索引兜底；服务端 `where` 查询仅用于友好提示，**不**作为并发唯一性最终保证。

> **`fraud_reports.sourceAlertId` 的处理**：保留为普通业务字段（可空），**不**参与 DB UNIQUE；其唯一性保证由同集合的 `sourceAlertKey` 兜底（详见 §10.3）。

> **`users` 上不为 `wxOpenId / studentNo / staffNo / username` 任何字段建立数据库唯一索引**。原因：
> - CloudBase 文档集合的 UNIQUE 索引对字段不存在/`null` 同样计入唯一性判断
> - `users` 是三角色共用集合（同一集合里同时存在 `student / counselor / security` 三类文档）
> - 多数业务唯一字段对其他角色的文档而言天然为 `null`，导致：①稀疏唯一索引将多个 `null` 等同视为同一值（约束失效）；②非稀疏唯一索引第二条 `counselor` 缺 `studentNo` 字段直接报错
> - 因此 `wxOpenId / studentNo / staffNo / username` 的"业务唯一"由各自**专属 DB UNIQUE 键**（`wxIdentityKey` / `identityKey`）兜底——即"业务原始字段不建 UNIQUE，**替身** 字段建 UNIQUE"。`替身字段`因前缀命名空间而永不 null，规避 CloudBase UNIQUE 的 null 歧义。

> 注：`risk_rules` 第一版允许 `_id+version` 复合唯一（业务上 `_id` 自带唯一性，可不再单独建唯一索引；不建议加 `version` 唯一，避免多版本并存时被误锁）。

### 8.3 组合索引（第一版核心，覆盖所有真实查询路径）

> 标记 ★ 的为"最重要的 5 个组合索引"，列于 §13。

| 集合 | 字段组合（顺序） | 用途（业务查询） |
|---|---|---|
| `users` | `(role, collegeId, status)` | 辅导员查找本学院活跃学生 |
| `alerts` | `(targetStudentId, status)` ★ | **学生"我的预警"** |
| `alerts` | `(collegeId, status, issuedAt desc)` ★ | **辅导员"本学院预警队列"** |
| `alerts` | `(status, riskLevel, issuedAt desc)` | 保卫处"全校预警按状态+风险筛选" |
| `alerts` | `(sourceType, status, issuedAt desc)` | 保卫处按来源筛选预警 |
| `alerts` | `(targetStudentId, status, issuedAt desc)` | 学生"我的预警"按时间倒序 |
| `fraud_reports` | `(reporterId, status)` ★ | **学生"我的工单"** |
| `fraud_reports` | `(collegeId, status, submittedAt desc)` ★ | **辅导员"本学院工单队列"** |
| `fraud_reports` | `(status, riskLevel, submittedAt desc)` | 保卫处"全校工单按状态+风险筛选" |
| `fraud_reports` | `(status, closedAt desc)` | 保卫处"全校结案工单统计" |
| `fraud_reports` | `(collegeId, closedAt desc)` | 保卫处"按学院结案统计" |
| `fraud_reports` | `(assignedCounselorId, status)` | 辅导员个人待办筛选 |
| `counselor_followups` | `(businessType, businessId, createdAt desc)` | 预警/工单详情页的跟进时间线 |
| `counselor_followups` | `(counselorId, createdAt desc)` | 辅导员个人工作量统计 |
| `counselor_followups` | `(collegeId, status, completedAt desc)` | 学院看板：48h 首次跟进率 |
| `security_dispositions` | `(reportId, createdAt desc)` | 工单详情的处置时间线 |
| `security_dispositions` | `(operatorId, createdAt desc)` | 保卫处个人工作量统计 |
| `security_dispositions` | `(collegeId, action, createdAt desc)` | 学院处置动作统计 |
| `quiz_attempts` | `(userId, submittedAt desc)` | 学生自测历史 |
| `learning_records` | `(userId, contentType, completedAt desc)` | 学生文章学习历史 |
| `learning_records` | `(contentType, completedAt desc)` | 全校学习参与统计 |
| `audit_logs` | `(actorId, createdAt desc)` | 单人操作历史 |
| `audit_logs` | `(resourceType, resourceId, createdAt desc)` | 单资源操作历史 |
| `audit_logs` | `(collegeId, createdAt desc)` | 学院审计 |
| `audit_logs` | `(action, createdAt desc)` | 动作类型筛选 |
| `audit_logs` | `(actorRole, result, createdAt desc)` | 角色 + 失败审计筛选 |

### 8.4 不建索引的字段（避免臃肿）
- 所有"主键" `_id` 已天然唯一索引，无需另建
- 长文本字段（`content` / `narrative` / `opinion`）：不建全文索引；如需全文搜索，第一版用前端筛 + 后端 like
- `riskReasons[]` 数组：CloudBase 数组可参与等值匹配但不建专门数组索引；通过 `riskLevel` 即可覆盖
- `createdBy`、`updatedBy`、`closedBy`：低频查询字段，不单独建索引；若需按创建人查，通过 `actorId` 走 `audit_logs` 反查

---

## 9. 数据权限与安全规则原则

### 9.1 两层防线
- **第一层（权威）**：服务端云函数。所有 `users / risk_rules / alerts / fraud_reports / counselor_followups / security_dispositions / quiz_questions / quiz_attempts / audit_logs` 的读写一律经云函数。
- **第二层（兜底）**：CloudBase 数据库安全规则。统一配置为"客户端无任何直读直写权限"，即使前端绕过云函数也不会产生数据泄露或篡改。

### 9.2 各集合访问原则

| 集合 | 客户端直读 | 客户端直写 | student（经云函数） | counselor（经云函数） | security（经云函数） |
|---|---|---|---|---|---|
| `users` | ❌ | ❌ | 仅 `getCurrentUser`（本人） | 仅 `getCollegeUserBrief`（本学院脱敏） | 全校，按脱敏规则 |
| `colleges` | ❌ | ❌ | 仅 `getCollegeName`（按需） | 仅 `getCollegeName` | 全 CRUD |
| `risk_rules` | ❌ | ❌ | 仅 `getRiskRule` 取当前启用版 | 仅 `getRiskRule` | 全 CRUD + 审计 |
| `alerts` | ❌ | ❌ | `listMyAlerts`、`getMyAlertDetail`、`markAlertViewed` | `listCollegeAlerts`、`getAlertDetail` | 全 CRUD |
| `fraud_reports` | ❌ | ❌ | `submitReport`、`listMyReports`、`getMyReportDetail` | `listCollegeQueue`、`getReportDetail`、`createFollowup`、`transferToSecurity`、`closeLocally` | 全 CRUD + 处置 |
| `counselor_followups` | ❌ | ❌ | 仅 `getMyFollowups`（按 `studentId` 过滤） | `listFollowups`（按 `businessId` 过滤） | `listFollowups`（只读） |
| `security_dispositions` | ❌ | ❌ | ❌ | ❌ | 全 CRUD + 退回 |
| `learning_articles` | ❌ | ❌ | `listPublishedArticles`、`getArticleDetail` | 同 student | 全 CRUD + 发布 |
| `quiz_questions` | ❌ | ❌ | `getQuizQuestions`（**剥离 `grading`**） | 同 student | 全 CRUD |
| `quiz_attempts` | ❌ | ❌ | `submitQuizAttempt`、`listMyAttempts` | ❌ | `listAllAttempts`（按权限脱敏） |
| `learning_records` | ❌ | ❌ | 服务端按 `userId` 写入 + 读取 | ❌ | `getAllLearningRecords`（聚合统计用） |
| `audit_logs` | ❌ | ❌ | ❌ | ❌ | `queryAuditLogs` |

### 9.3 CloudBase 数据库安全规则（兜底建议）

> 不替代云函数，仅在云函数被绕过时兜底；具体规则文本由 CloudBase CLI 在创建集合时下发。

| 集合 | read（client） | write（client） |
|---|---|---|
| `users` | `false` | `false` |
| `colleges` | `false` | `false` |
| `risk_rules` | `false` | `false` |
| `alerts` | `false` | `false` |
| `fraud_reports` | `false` | `false` |
| `counselor_followups` | `false` | `false` |
| `security_dispositions` | `false` | `false` |
| `learning_articles` | `false` | `false` |
| `quiz_questions` | `false` | `false` |
| `quiz_attempts` | `false` | `false` |
| `learning_records` | `false` | `false` |
| `audit_logs` | `false` | `false` |

> 即便将来需要某些集合向客户端开放"已发布文章列表"等直读，第一版也**统一走云函数**，等真实场景稳定后再评估下调。

---

## 10. 数据一致性与权威字段

### 10.1 权威字段一览

| 字段语义 | 权威来源 | 拷贝字段（仅作快照/冗余） |
|---|---|---|
| 当前用户身份 | `users._id` + `users.role` | `alerts.targetStudentId`、`fraud_reports.reporterId`、`audit_logs.actorId` 等外键 |
| 当前重点关注 | `users.focusFlag` | `counselor_followups.focusFlag`（仅事件流，不参与当前态读取） |
| 当前工单状态 | `fraud_reports.status` | `security_dispositions.reportStatusBefore/After`（快照） |
| 当前预警状态 | `alerts.status` | `counselor_followups.businessType=alert` 集合不复制预警状态 |
| 当前风险等级 | `fraud_reports.riskLevel`、`alerts.riskLevel` | 不拷贝至其他集合 |
| 当前风险规则 | `risk_rules.status=enabled` 最新记录 | 业务表 `riskRuleId` 字段保存快照 |
| 辅导员跟进历史 | `counselor_followups` | 不拷贝 |
| 保卫处处置历史 | `security_dispositions` | 不拷贝 |
| 审计 | `audit_logs` | 不拷贝 |
| 学院范围 | `users.collegeId` | `alerts.collegeId`、`fraud_reports.collegeId`、`counselor_followups.collegeId`、`security_dispositions.collegeId` 均为快照 |

### 10.2 关键不变量

1. **同一当前状态绝不被两个集合共同承担**：
   - 当前预警状态 = `alerts.status`，不由 `counselor_followups` 反映
   - 当前工单状态 = `fraud_reports.status`，不由 `security_dispositions` 反映
   - 当前重点关注 = `users.focusFlag`，不由 `counselor_followups.focusFlag` 反映
2. **`risk_rules._id` 快照不变更**：业务表 `riskRuleId` 是写入时的版本快照，永不被改写（即使后续规则被 `disabled`）。
3. **`audit_logs.actorRole` 永不变更**：刻意冗余，跨用户角色变更保留历史事实。
4. **`fraud_reports.involvedAmount` vs `confirmedLossAmount`**：前者是学生填报的涉及金额（参与风险研判），后者是保卫处结案时确认的损失（参与统计）。统计金额口径以 `confirmedLossAmount` 为准。
5. **辅导员能否结案的前置条件全部来自 `fraud_reports`**：`riskLevel=low` + `hasLoss=false` + `finalOutcome ∈ {misreport, consultation}` + 已有"已完成" `counselor_followups`。
6. **`users.identityKey` / `users.wxIdentityKey` / `fraud_reports.sourceAlertKey` 的三重替身 UNIQUE 兜底**：
   - `users.identityKey` UNIQUE：兜底 `studentNo / staffNo / username` 业务身份不重复
   - `users.wxIdentityKey` UNIQUE：兜底 `wxOpenId` 微信身份不重复绑定
   - `fraud_reports.sourceAlertKey` UNIQUE：兜底 "一条预警最多一张工单" 的并发唯一性（详见 §10.3）
   - 三个替身字段都**永不为 null**；服务端 `where().count() === 0` **仅作业务校验和友好提示**；**最终并发唯一性由 DB UNIQUE 冲突决定**
   - 所有"先查后写"流程（`bindWxOpenId` / `bindStudentIdentity` / `bindCounselorIdentity` / `createSecurityAccount` / `rebindWxOpenId` / `unbindWxOpenId` / `submitReport` 等）必须包在捕获 UNIQUE 冲突的 try/catch 中，预检失败返回业务文案，预检通过但 UNIQUE 冲突时返回通用文案

### 10.3 `sourceAlertId` ↔ `sourceAlertKey` 唯一性策略

SRS §10.2 / §15 规定：**一条预警最多直接关联一张工单**。

**第一版的实现策略**：用 `fraud_reports.sourceAlertKey`（DB UNIQUE）兜底"一条预警最多一张工单"的并发唯一性，`sourceAlertId` 维持普通字段（业务字段）。

#### 10.3.1 两个字段的职责分离

| 字段 | 性质 | 可空 | DB UNIQUE | 用作 |
|---|---|---|---|---|
| `fraud_reports.sourceAlertId` | 业务字段 | 是（独立上报时为 `null`） | 否 | UI 展示、查询关联预警 |
| `fraud_reports.sourceAlertKey` | 一致性辅助字段 | 否（由服务端生成） | **是** | 并发唯一性兜底 |

权威关系保持：业务查询、UI 展示、统计全部使用 `sourceAlertId`；`sourceAlertKey` 不暴露在前端 API 响应中，**仅供内部审计与 DB 一致性维护**。`alerts` 集合**不**增加 `reportIds[]` 数组。

#### 10.3.2 为什么不在 `sourceAlertId` 上加 DB UNIQUE

- `sourceAlertId` 在独立上报时为 `null`；多角色/多场景集合里多条 `null` 与"业务唯一"语义冲突
- 若使用稀疏 UNIQUE：与 wxOpenId 等历史场景相同，多个 `null` 等同视为同一值，约束失效
- 若使用全 UNIQUE（不忽略 null）：`sourceAlertId=null` 的合法独立上报之间互相冲突，第一笔后第二笔即报错

#### 10.3.3 `sourceAlertKey` 设计

服务端在 `submitReport` 创建工单前计算 `sourceAlertKey`：

| 来源场景 | `sourceAlertId` | `sourceAlertKey` |
|---|---|---|
| 由预警产生（关联上报） | `<alertId>` | `alert:<alertId>` |
| 独立上报 | `null` | `standalone:<reportId>` |

- 前缀命名空间：`alert:` 与 `standalone:` 互不重叠；一个 `alert` 不会与一个独立上报同一字符串冲突
- `standalone:<reportId>` 由于 `reportId` 本身唯一，多张独立上报之间也不会因前缀相同而冲突
- 因此 `sourceAlertKey` **永不为 `null`**且**对每个文档唯一**，DB UNIQUE 索引可安全生效

#### 10.3.4 `submitReport` 并发处理流程

```
1. 服务端生成 reportId = util.generateId("rpt_")
2. 接收 event = { ... , sourceAlertId? }
3. if event.sourceAlertId 非空:
     a. 校验 alerts._id == event.sourceAlertId 存在
     b. 校验 alerts.targetStudentId == session.userId（不能代他人提交）
     c. 计算 sourceAlertKey_new = "alert:" + event.sourceAlertId
     d. 预检（友好提示）：fraud_reports.where({sourceAlertKey: sourceAlertKey_new}).count() === 0
        - 不为 0 → 直接返回 "该预警已经提交过关联工单"，不写入
   else:
     a. 计算 sourceAlertKey_new = "standalone:" + reportId
4. 写入 fraud_reports（包含 sourceAlertKey_new）
5. if 写入触发 sourceAlertKey UNIQUE 冲突：
   - 捕获异常 → 返回 "该预警已经提交过关联工单"（不向客户端泄露具体冲突值）
6. 写 audit_logs.action = report.create
```

#### 10.3.5 关键不变式

- **服务端 `where().count() === 0` 仅作业务校验和友好提示**；CloudBase 事务使用快照隔离，"先查后写"在并发下不绝对安全——两个并发 `submitReport` 可能各自读到对方尚未提交的写入
- **最终并发唯一性由 `fraud_reports.sourceAlertKey` DB UNIQUE 决定**；预检失败返回业务文案，预检通过但 UNIQUE 冲突时返回通用文案（不暴露冲突值）
- `alerts` 集合**不**补加任何关于工单的反向索引；预警关闭时不校验工单状态（与 SRS §10.1 一致："学生提交关联上报不会自动关闭预警"）

#### 10.3.6 后续若 DB UNIQUE 失效的备选

极端情况下若 CloudBase UNIQUE 在该环境出现异常（如唯一索引被误删），服务端代码须保留 `where().count() === 0` 作为"业务告警"逻辑，但**不应将其作为唯一正确性来源**；同时触发 `audit_logs.action = data.integrity_warning` 由保卫处审计介入。所有并发唯一性的语义保证**必须**由 DB UNIQUE 兜底。

### 10.4 状态机一致性约束

| 状态机 | 关键不变式 |
|---|---|
| 预警 | `closed` 为终态，`updatedAt` 之后不再变化；`viewedAt` 单调（首次查看时间，不会回退） |
| 工单 | `closedAt` 与 `status=closed` 同步；`finalOutcome` 与 `status=closed` 同步 |
| 跟进 | 同一 `(businessType, businessId)` 允许多条 `completed`，但不允许从 `completed` 回到 `in_progress` |
| 处置 | `reportStatusAfter` 必须等于状态机定义的目标状态之一 |

---

## 11. 初始化数据设计

> 本节**只描述**初始化数据内容，**不执行写入**。所有密码统一占位为 `DEMO_PASSWORD_PLACEHOLDER`。

### 11.1 学院演示数据（`colleges`）

| `_id` | name | shortName | aliases | status |
|---|---|---|---|---|
| `college_cs` | 计算机学院 | 计院 | `["计算机","计院"]` | active |
| `college_math` | 数学与统计学院 | 数统 | `["数学","数统"]` | active |
| `college_econ` | 经济与管理学院 | 经管 | `["经济","经管"]` | active |
| `college_art` | 外国语学院 | 外院 | `["外语","外院"]` | active |

### 11.2 学生演示账号（`users.role=student`）

| `_id` | `identityKey` | `wxIdentityKey` | `wxOpenId` | name | collegeId | studentNo | bindStatus | focusFlag | status | passwordHash |
|---|---|---|---|---|---|---|---|---|---|---|
| `usr_stu_001` | `student:2023123456` | `openid:demo_openid_stu_001` | `demo_openid_stu_001` | 王同学 | `college_cs` | `2023123456` | bound | false | active | `null` |
| `usr_stu_002` | `student:2023123457` | `openid:demo_openid_stu_002` | `demo_openid_stu_002` | 李同学 | `college_cs` | `2023123457` | bound | false | active | `null` |
| `usr_stu_003` | `student:2023654321` | `openid:demo_openid_stu_003` | `demo_openid_stu_003` | 张同学 | `college_math` | `2023654321` | bound | true | active | `null` |
| `usr_stu_004` | `student:2023789012` | `openid:demo_openid_stu_004` | `demo_openid_stu_004` | 赵同学 | `college_econ` | `2023789012` | bound | false | active | `null` |
| `usr_stu_005` | `student:2023890123` | `openid:demo_openid_stu_005` | `demo_openid_stu_005` | 钱同学 | `college_art` | `2023890123` | bound | false | active | `null` |

> 初始化时由 `seed` 脚本写入。`identityKey` 与 `wxIdentityKey` 都受 DB UNIQUE 索引保护；seed 脚本需在导入前做"先查后写"避免与已存在账号冲突；`wxOpenId` 在演示数据中**直接填**演示 OPENID（避开真实 OPENID 真实性约束）。

### 11.3 辅导员演示账号（`users.role=counselor`）

| `_id` | `identityKey` | `wxIdentityKey` | `wxOpenId` | name | collegeId | staffNo | bindStatus | focusFlag | status | passwordHash |
|---|---|---|---|---|---|---|---|---|---|---|
| `usr_c_001` | `counselor:T00101` | `openid:demo_openid_c_001` | `demo_openid_c_001` | 王辅导员 | `college_cs` | `T00101` | bound | n/a | active | `null` |
| `usr_c_002` | `counselor:T00102` | `openid:demo_openid_c_002` | `demo_openid_c_002` | 李辅导员 | `college_math` | `T00102` | bound | n/a | active | `null` |
| `usr_c_003` | `counselor:T00103` | `openid:demo_openid_c_003` | `demo_openid_c_003` | 张辅导员 | `college_econ` | `T00103` | bound | n/a | active | `null` |
| `usr_c_004` | `counselor:T00104` | `openid:demo_openid_c_004` | `demo_openid_c_004` | 赵辅导员 | `college_art` | `T00104` | bound | n/a | active | `null` |

### 11.4 保卫处演示账号（`users.role=security`）

| `_id` | `identityKey` | `wxIdentityKey` | `wxOpenId` | name | collegeId | username | passwordHash | bindStatus | focusFlag | status |
|---|---|---|---|---|---|---|---|---|---|---|
| `usr_sec_001` | `security:security01` | `unbound:usr_sec_001` | `null` | 陈保卫 | `null` | `security01` | `DEMO_PASSWORD_PLACEHOLDER` | unbound | n/a | active |
| `usr_sec_002` | `security:security02` | `unbound:usr_sec_002` | `null` | 林专班 | `null` | `security02` | `DEMO_PASSWORD_PLACEHOLDER` | unbound | n/a | active |

> 真密码在部署前由初始化脚本读取环境变量（如 `DEMO_SECURITY_PASSWORD`）后用 `bcrypt` 哈希入库；本设计不写入任何明文密码。
> `wxOpenId = null`、`bindStatus = unbound`、`collegeId = null` 对应 security 角色默认值。`wxIdentityKey = unbound:<users._id>` 因 `_id` 唯一，各 security 账号之间不冲突。
> **`identityKey` 与 `wxIdentityKey` 在 `users` 集合层面都被 DB UNIQUE 索引保护**；初始化脚本必须在导入前做"先查后写"避免与已存在账号冲突。

### 11.5 默认风险规则（`risk_rules`）

| `_id` | name | version | status | highAmount | midAmountMin | repeatAlertWindowDays | highAlertRepeatCount | midAlertRepeatCount | slaFirstFollowHours | keyFraudTypes | updatedBy |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `rule_default` | 第一版默认风险规则 | `v1` | enabled | 5000 | 1 | 30 | 3 | 2 | 48 | `["part_time_scam","impersonate_public","fake_loan","fake_refund"]` | `usr_sec_001` |

### 11.6 反诈文章示例（`learning_articles`）

| `_id` | title | category | publishStatus | fraudTags |
|---|---|---|---|---|
| `art_demo_001` | 警惕刷单返利诈骗 | knowledge | published | `["part_time_scam"]` |
| `art_demo_002` | 假冒公检法常用话术 | knowledge | published | `["impersonate_public"]` |
| `art_demo_003` | 案例：虚假贷款连环骗 | case | published | `["fake_loan"]` |
| `art_demo_004` | 冒充客服退款骗局 | knowledge | published | `["fake_refund"]` |

> 摘要与正文由初始化脚本填充；**所有 `case` 类文章必须在初始化前完成去标识化**（SRS §4.3）。

### 11.7 自测题目示例（`quiz_questions`）

| `_id` | questionType | stem | options | grading | fraudTags |
|---|---|---|---|---|---|
| `qst_demo_001` | single_choice | 陌生人要求先转账再返利，应如何做？ | `[{id:"A",text:"拒绝转账并报警"},{id:"B",text:"按指示转账"}]` | `{correctOptionId:"A",score:1,explanation:"先转账即高风险，应立即止损并报警"}` | `["part_time_scam"]` |
| `qst_demo_002` | single_choice | 接到自称公检法的电话要求转账"清查资产"，应如何处理？ | `[{id:"A",text:"挂断并报警"},{id:"B",text:"按对方指示操作"}]` | `{correctOptionId:"A",score:1,explanation:"公检法机关不会要求电话/线上转账"}` | `["impersonate_public"]` |
| `qst_demo_003` | single_choice | 网上贷款要求先交"手续费"才能放款，正常吗？ | `[{id:"A",text:"正常借贷流程"},{id:"B",text:"典型的虚假贷款"}]` | `{correctOptionId:"B",score:1,explanation:"正规放款不会在放款前收取费用"}` | `["fake_loan"]` |

### 11.8 演示预警与工单数据（用于演示闭环）

| 集合 | 内容要点 |
|---|---|
| `alerts` | 1~2 条预警，状态分布在 `pending_dispatch` / `sent` / `viewed` / `following_up` / `closed` |
| `fraud_reports` | 3~4 条工单，覆盖四个状态；其中至少 1 条带 `sourceAlertId` 关联预警 |
| `counselor_followups` | 2~3 条跟进记录，分别针对预警或工单 |
| `security_dispositions` | 1~2 条处置记录（核验 + 处置中） |
| `audit_logs` | 5~10 条审计样本，对应以上动作 |

> 这一层演示数据用于冒烟测试与现场演示；不在本设计阶段必须存在，由开发阶段临时注入。

### 11.9 不在初始化范围
- 不创建任何 CloudBase 索引；索引创建随集合创建流程（参见 §13）
- 不注入任何演示预警/工单数据；该层由冒烟脚本后续完成
- 不创建任何云函数或页面；与本文档完全解耦

---

## 12. 数据保留与删除策略

| 集合 | 保留策略 | 物理删除 |
|---|---|---|
| `users` | 学生毕业后 `status=graduated`，但记录永久保留；`status=withdrawn` 仍保留 | 否 |
| `colleges` | 永久保留；变更仅通过 `status=disabled` + 新增字段记录 | 否 |
| `risk_rules` | 永久保留；禁用规则保留以便审计追溯 | 否 |
| `alerts` | 永久保留；预警关闭后仅状态变更 | 否 |
| `fraud_reports` | 永久保留；结案后允许状态查询 | 否 |
| `counselor_followups` | 永久追加 | 否 |
| `security_dispositions` | 永久追加 | 否 |
| `learning_articles` | 永久保留；停用通过 `publishStatus=disabled` | 否 |
| `quiz_questions` | 永久保留；停用通过 `status=disabled` | 否 |
| `quiz_attempts` | 永久保留；不删除学生答题历史 | 否 |
| `learning_records` | 永久保留；唯一索引保证不重复 | 否 |
| `audit_logs` | 保留 **1 年**（SRS §17.12）；第一版**不**实现自动清理 | 第一版不实现自动清理 |

> 物理删除脚本第一版不开发；如确需历史清理，须经保卫处授权走 `data.purge` 审计与人工确认。

---

## 13. 后续数据库创建顺序

> 本节列出**开发阶段**真正在 CloudBase 上执行创建动作时的建议顺序，便于回滚与排错。**本设计阶段不执行。**

1. **创建 `ping` 测试函数与最小联通**（已完成，参见 §历史）
2. **创建静态主数据集合**（无外键依赖）：
   1. `colleges`
   2. `users`
3. **创建配置集合**：
   3. `risk_rules`
4. **创建业务主表**（按外键依赖序）：
   4. `alerts`
   5. `fraud_reports`
5. **创建事件流集合**：
   6. `counselor_followups`
   7. `security_dispositions`
6. **创建内容集合**：
   8. `learning_articles`
   9. `quiz_questions`
7. **创建行为记录集合**：
   10. `quiz_attempts`
   11. `learning_records`
8. **创建审计集合**（最后建，便于先行验证业务）：
   12. `audit_logs`
9. **创建索引**：按 §8 表分集合逐个建索引
10. **注入初始化数据**：按 §11 顺序

> 每个集合创建完成后立即冒烟自检：插入一条 → 主键索引 → 单字段/组合索引查询 → 删除冒烟数据（仅限静态演示主数据，事件流数据保留）。

---

## 14. 开发前风险检查（设计阶段自查表）

| # | 风险点 | 自查结论 |
|---|---|---|
| R1 | 12 集合互相引用是否一致 | ✅ 一致；§7 外键引用一览已穷举 |
| R2 | 角色 RBAC 在数据库设计中是否留有可被绕过的口子 | ✅ 所有"权威字段"和"客户端禁止直读直写"在 §5 / §9 已明确 |
| R3 | 状态机是否能完整流转（v0.2 §10） | ✅ §10.4 列示不变式；状态机已在 v0.2 §10 + 本文档 §6 枚举中固化 |
| R4 | `risk_rules` 配置化是否充分 | ✅ §5.3 + §11.5 已落地 |
| R5 | 敏感字段脱敏能否在云函数侧完成 | ✅ §5 / §6 / §9 显式列出；`grading`、`passwordHash`、`mobile` 等已在服务端读侧剥离或脱敏 |
| R6 | `audit_logs` 服务端唯一写入是否能强制 | ✅ §9 客户端全部 deny；§5.12 字段 `actorRole` 刻意冗余 |
| R7 | 小程序与 Web 共用 CloudBase 后端是否有阻塞 | ✅ `users` 单集合承担多端身份；身份唯一键收敛为 `identityKey`（§5.1 / §8.2 / §10.2.6） |
| R8 | `sourceAlertId` 唯一性的实现是否合理 | ✅ §10.3 用 `fraud_reports.sourceAlertKey` DB UNIQUE 兜底"一条预警最多一张工单"的并发唯一性；`sourceAlertId` 保留为普通业务字段；`alerts` 不增 `reportIds` 数组 |
| R9 | 索引是否覆盖所有第一版真实查询 | ✅ §8.3 表中每条组合索引均对应 §5 各集合的业务云函数 |
| R10 | 是否引入了 v0.2 排除项（附件、OCR、大模型等） | ✅ 仅保留反诈文章 + 单选自测；无附件字段 |
| R11 | 是否引入了新角色 | ✅ 严格三类；不新增 |
| R12 | 时间字段是否全部使用 Date | ✅ §2.4 / §3.2 强制约束 |
| R13 | `users.role` 单角色设定是否影响兼容性 | ✅ v0.2 §3.3 已决策；多角色需求如未来出现，新增 `roles: []` 字段即可 |
| R14 | 演示数据是否含真实个人敏感信息 | ✅ §11.2-§11.4 均为虚构学生姓名/学号/工号；非真实 |
| R15 | 是否误将 `passwordHash` 写入文档示例 | ✅ 示例文本统一为 `DEMO_PASSWORD_PLACEHOLDER`，杜绝明文 |
| R16 | **CloudBase 唯一索引对 `null` / 字段不存在的处理**：文档集合 UNIQUE 对 null 与对值同样计入唯一性判断；多角色共用 `users` 集合时 `wxOpenId / studentNo / staffNo / username` 对多数角色为 null，会与唯一约束冲突 | ✅ §5.1 + §8.2 + §10.2.6 已显式规避——`users` 上保留**两个** DB UNIQUE 字段：`identityKey`（业务身份唯一，替身 `studentNo/staffNo/username`）与 `wxIdentityKey`（微信身份唯一，替身 `wxOpenId`）；替身字段永远有值，规避 null 歧义 |
| R17 | **CloudBase 事务的快照隔离**：服务端 `where().count()===0` 在并发写入下不绝对安全（两个事务可能各自读到对方尚未提交的写入） | ✅ §5.1 + §5.5 + §8.2 + §10.2.6 + §10.3 已显式规避——服务端预检仅作友好提示；最终兜底由三个替身 DB UNIQUE 字段 `users.identityKey` / `users.wxIdentityKey` / `fraud_reports.sourceAlertKey` 承担；任何"先查后写"流程都必须包在捕获 UNIQUE 冲突的 try/catch 中 |

---

## 附录 A：与 SRS-v0.2 §17 决策的一致性核对

| SRS §17 决策项 | 本设计对应 | 一致？ |
|---|---|---|
| 1. `users._id` 系统主键；所有外键引用 | §3.1 / §7 / §5.1 | ✅ |
| 2. 三端登录（小程序 wxOpenId + 学/工号，Web 账号密码） | §5.1 子约束；双重 DB UNIQUE 唯一键：`identityKey`（业务身份）+ `wxIdentityKey`（微信身份，替身 wxOpenId）；见 §5.1 / §8.2 / §10.2.6 | ✅ |
| 3. 业务角色严格三类；学院与人员用演示主数据 | §6.1 / §11.1-§11.4；演示账号 `identityKey` 与 `wxIdentityKey` 见 §11.2-§11.4 | ✅ |
| 4. 12 集合固定 | §5 全列 | ✅ |
| 5. 预警人工录入；`sourceType=manual` | §5.4 `sourceType` 默认 `manual` + 索引 | ✅ |
| 6. 预警与工单单向关联（`sourceAlertId`） | §5.4 / §5.5；`alerts` 不存 `reportIds[]`；并发唯一性由 `fraud_reports.sourceAlertKey` DB UNIQUE 兜底（§10.3） | ✅ |
| 7. 预警已关闭不可激活；工单不设 `withdrawn` | §5.5；§10.2 状态机没有 `withdrawn` | ✅ |
| 8. 辅导员结案受限条件 | §5.5 / §10.2 | ✅ |
| 9. 保卫处可退回；跟进不 reopen | §5.6 / §10.3 | ✅ |
| 10. 风险等级三档；服务端计算；`riskReasons` 快照 | §5.4 / §5.5 / §5.3 | ✅ |
| 11. 不实现附件/图片/OCR | §5.4 / §5.5 / §5.8 不含附件字段 | ✅ |
| 12. 学习人数并集去重；审计保留 1 年 | §5.10 / §5.11 / §12 | ✅ |
| 13. 业务集合由服务端控制 | §9 / §10 | ✅ |

---

## 附录 B：文档与执行基线说明

- 本文档是"数据库层"的设计基线。下游产出的"云函数接口设计"必须把所有数据访问收敛到 §9.2 表中列出的云函数集合。
- 如需对本设计的偏离（例如新增字段、改动索引、引入新集合），必须先更新本文档且标注 v 版本号，再交给开发阶段执行。
- 本文档**不**自动启用任何 CloudBase 资源；所有 §11 与 §13 描述需在开发阶段另行评审。

---

_文档结束_
