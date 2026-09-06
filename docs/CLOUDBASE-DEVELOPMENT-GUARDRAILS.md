# CloudBase 开发约束手册

> 本手册适用于本项目后续所有 Codex、WorkBuddy 和人工开发操作。若与临时实现便利冲突，以本手册和 `DATABASE-DESIGN-v0.2.md` 为准。

## 1. 环境安全

- 唯一允许操作的 CloudBase 环境：`aa-d4gvb4o3t50fc94f8`。
- 禁止创建、查询、修改、部署或删除其他 CloudBase 环境的资源。
- 所有 CLI/SDK 管理命令必须显式指定该 `envId`；命令执行前先显示目标环境和目标资源名。
- 任何集合、索引、云函数、安全规则或数据写操作都必须先对照 `CLOUDBASE-IMPLEMENTATION-CHECKLIST.md`，并保留验证证据。

## 2. Git 规则

- `main` 是正式分支；未经明确授权不得创建分支、提交或推送。
- 禁止提交：`.env`、`project.private.config.json`、`cloudbaserc.json`、`.workbuddy/`、Token、Secret、私钥、密码、真实 OPENID、真实个人信息和未脱敏日志。
- 执行 Git 操作前检查 `git status`；暂存时仅添加明确指定路径；提交前扫描敏感模式并检查暂存清单。

## 3. 身份信任边界

- `users._id` 是唯一业务用户主键。所有业务用户外键引用它，禁止用 OPENID、学号、工号或登录名作业务主键。
- 小程序身份仅能在**小程序专用**云函数入口从服务端微信上下文/安全上下文解析 OPENID；禁止接受客户端 OPENID、`userId`、`studentId`、`role`、`collegeId`、`operatorId`、`actorId`、`currentHandlerId` 或 `assignedCounselorId` 作为可信身份。
- Web 保卫处身份仅能从服务端验证后的 Web 会话取得；Web 函数禁止复用小程序 OPENID 上下文。
- 因云函数实例复用，混合小程序/Web/HTTP 入口不得依赖残留环境变量读取 OPENID；按调用来源物理分离身份函数或使用安全上下文解析。
- 首次学号/工号绑定仅是演示方案。真实上线前必须补充独立身份验证机制，不能把可猜测的学号/工号当密码。

## 4. 数据库直连规则

- `users`、`colleges`、`risk_rules`、`alerts`、`fraud_reports`、`counselor_followups`、`security_dispositions`、`learning_articles`、`quiz_questions`、`quiz_attempts`、`learning_records`、`audit_logs` 的客户端直读和直写均禁止。
- 所有业务请求必须经云函数；云函数负责字段白名单、角色、资源归属、状态机、脱敏和审计。
- `audit_logs` 客户端永远禁止 read/create/update/delete；仅 security 通过受控云函数查询脱敏审计内容。
- `quiz_questions.correctOptionIds`、`users.passwordHash`、`users.wxOpenId`、身份替身键及内部处置说明不得出现在 student/counselor 的响应中。

## 5. UNIQUE 与 ID 规则

- 所有 `_id` 由服务端安全随机生成；`colleges._id` 和 `risk_rules._id=rule_default` 是受控静态 ID。禁止自增数字、客户端指定 ID。
- 禁止对可空或可能缺失字段直接建 UNIQUE。CloudBase 会将缺失字段按 `null` 参与唯一性判断。
- 最终 UNIQUE 仅为：`users.identityKey`、`users.wxIdentityKey`、`fraud_reports.sourceAlertKey`、`learning_records(studentId, articleId)`。
- `identityKey`、`wxIdentityKey`、`sourceAlertKey` 均必须有值；禁止在 API 响应或日志中返回它们。
- 预检查询只用于友好提示；**DB UNIQUE 才是并发唯一性的最终兜底**。任何“先查后写”不得被描述为唯一性保证，必须捕获 UNIQUE 冲突并返回统一业务错误。
- 不物理删除用户或业务历史，避免旧 identity/openid/source key 被错误复用。第一版不开放用户自助换绑或解绑；如未来增加，必须由受控服务端事务、唯一键冲突处理和审计共同实现。

## 6. 状态机与并发规则

- 任何 `alerts.status`、`fraud_reports.status`、`counselor_followups.status` 修改必须调用统一云函数；页面禁止直接 update 状态。
- 严格执行 `DATABASE-DESIGN-v0.2.md` 中的状态转移图；禁止自行添加、重命名、重开或跳过状态。
- `alerts`、`fraud_reports`、`users`、`risk_rules`、`counselor_followups`、`learning_articles`、`quiz_questions` 使用 `version` 乐观锁。更新必须同时校验 `_id + version`；状态更新还必须校验期望旧状态。
- 状态主表更新、跟进/处置历史追加和审计日志追加必须位于同一个服务端数据库事务。发生冲突或审计失败时整体回滚并返回可重试冲突错误。
- `security_dispositions`、`quiz_attempts`、`learning_records`、`audit_logs` 创建后不可 update/delete；它们不可以成为当前状态来源。

## 7. 风险规则

- 第一版仅有 `risk_rules._id = rule_default` 一条规则文档，`status` 固定为 `enabled`。禁止创建第二条规则、版本切换或多个 enabled。
- 风险等级只能为 `low`、`medium`、`high`，仅由服务端按规则计算。
- 服务端必须写入 `riskLevel`、`riskReasons`、`riskRuleId`；客户端提交的同名字段一律忽略并审计为非法输入。
- 不得自行修改默认阈值或重点诈骗类型。修改 `rule_default` 需 security 权限、version 校验、事务和 `risk_rule.update` 审计。

## 8. 权限与学院隔离

- 授权范围以当前 `users.collegeId` 为准；业务记录的 `collegeId` 是历史快照，用于查询限定、展示和审计，不得作为认证身份来源。
- student 只能按当前会话的 `users._id` 读取本人资源。
- counselor 每次读取、写入、转交、重点标记和直接结案前，必须比较可信当前学院与资源快照学院；不匹配立即拒绝并写 `access.denied` 审计。
- security 才可管理预警、风险规则、处置、全校统计与审计。
- counselor 直接结案只能在低风险、明确误报或纯咨询、`hasLoss=false` 且已有完成跟进时执行；其他情况必须转 security。

## 9. 审计与敏感数据

- 以下动作必须审计：绑定、登录失败、权限拒绝、敏感详情查看、预警创建/下发/查看/关闭、工单创建、跟进、重点标记、转交、退回、核验、处置、结案、角色/学院调整、风险规则调整、内容发布、数据导出。
- 读取敏感详情先授权后写审计；审计失败则不返回敏感值。核心写操作审计失败则事务回滚。
- 手机号、可疑账号/网址、OPENID、identityKey、wxIdentityKey、passwordHash、涉及金额、确认损失金额、内部处置说明和审计摘要均为敏感数据。
- 列表默认脱敏：手机号中间四位隐藏、学号中间位隐藏、账号只留后四位、金额显示区间或掩码。student 可看本人真实业务信息；security 仅在具体处理时按最小必要看真实字段。
- 审计摘要禁止复制完整事件经过、手机号、账号、密码哈希或 OPENID；审计逻辑保留 1 年，第一版不开发自动删除。

## 10. 密码、时间与日志

- 第一版 `security` Web 密码哈希统一使用 `bcryptjs`，cost factor 固定为 `12`；数据库只存 `passwordHash`。
- 密码哈希只能在受控运行期生成；禁止将明文密码写入 JSON、Markdown、Git 或日志，禁止明文、可逆加密或演示占位符充当真实哈希。
- 所有审计/创建/状态时间使用 CloudBase `Date/serverDate`。客户端时间只能作为事件事实字段（如 `incidentAt`），不得作为审计或状态迁移时间。
- 日志不得记录完整 event、OPENID、密码、Token、敏感正文或完整审计摘要。错误日志只记录请求 ID、资源 ID 和脱敏错误码。

## 11. 索引规则

- 仅按 `DATABASE-DESIGN-v0.2.md` 第 6 章创建 25 个索引；任何新增索引必须先在设计文档中写明对应的真实查询、过滤条件、排序和字段顺序。
- UNIQUE 索引优先验证所有历史/初始化数据均无冲突后再创建。
- 禁止为长文本、数组、固定常量、未来可能使用或客户端搜索方便而建索引。
- 不得同时创建被 UNIQUE 或组合索引完全覆盖的重复单字段索引。
- 若控制台显示的索引数量上限与文档不一致，记录实际结果并停止后续索引扩张；不得通过删除未知索引或绕过限制继续。

## 12. 云函数最低模板

每个业务云函数都必须按以下顺序执行：

1. 确认调用来源与目标 `envId=aa-d4gvb4o3t50fc94f8`。
2. 获取服务端可信身份；拒绝任何客户端伪造身份字段。
3. 校验角色。
4. 校验目标资源、学院归属和脱敏范围。
5. 对输入做字段白名单、类型、枚举、长度和金额范围校验。
6. 校验状态机与 version。
7. 使用单文档原子更新或服务端事务写业务数据。
8. 写审计日志；审计失败按第 6、9 章规则回滚或拒绝返回。
9. 返回统一的业务错误码和脱敏响应，禁止透传底层 DB/UNIQUE 细节。

## 13. CloudBase 写操作检查表

每次 WorkBuddy 或其他代理准备创建/修改 CloudBase 资源前，必须逐项确认：

- [ ] `envId` 明确且为 `aa-d4gvb4o3t50fc94f8`
- [ ] 集合名和字段符合 `DATABASE-DESIGN-v0.2.md`
- [ ] 索引符合最终 25 个索引清单
- [ ] 不存在 nullable UNIQUE
- [ ] 不依赖客户端身份字段
- [ ] 状态修改走统一服务端函数
- [ ] 业务写和审计写有事务/回滚方案
- [ ] 不修改 SRS 范围外功能
- [ ] 有最小验证步骤和预期结果
- [ ] 有失败回滚方案，且未授权时不删除集合、索引或数据

## 14. 禁止事项

- 不允许自行扩展集合、字段、角色、状态、风险阈值或重点诈骗类型。
- 不允许为了开发方便让客户端直接 update 数据库。
- 不允许绕过审计、脱敏、学院隔离、UNIQUE 冲突处理或 version 控制。
- 不允许把环境切换到其他项目环境。
- 不允许未经明确确认删除集合、索引、数据、历史记录或安全规则。
- 不允许将 `ping` 云函数作为业务身份、数据库写入或权限验证入口。
