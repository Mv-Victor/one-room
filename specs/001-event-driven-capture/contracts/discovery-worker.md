# 发现 Worker 契约

状态：Phase 1 设计，尚未实现。覆盖内置检测规则的注册、输入、受限执行、状态与提示生命周期。产品要求见 [规格 FR-014/018/020/021/022](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/spec.md)，实例及宿主边界见 [技术设计](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/docs/TECHNICAL_DESIGN.md)，决策见 [研究 R5](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/research.md)。

## 1. 模块注册与执行所有权

DiscoveryWorker 是随应用发布的逻辑检测模块，可共享有界后台宿主；不要求每种提示独立常驻进程。内置模块启动时自注册，新增模块只改装配/注册，不改 CaptureService、Timeline 或公共分发条件。首版不加载用户下载脚本、外部插件或任意可执行规则。

```ts
type WorkerRegistration = {
  workerId: string;
  version: number;
  definitionHash: string;
  inputs: readonly ('activity.committed' | 'instance.revised')[];
  rules: readonly RuleDefinition[];
  evaluate(input: DetectionInput, ctx: DetectionContext): Promise<DetectionResult>;
};
type RuleDefinition = {
  ruleId: string;
  configurationRevision: number;
  analysisPolicy: 'local_only' | 'authorized_text';
  outputKinds: readonly string[];
};
```

workerId、ruleId 是稳定机器标识；version 是正整数代码/状态版本，configurationRevision 独立表示参数变更。相同 workerId/version/definitionHash 重复注册幂等；相同 id/version 的不同定义、重复 ruleId 或未知输入类型报 `REGISTRATION_CONFLICT`，不能以注册顺序覆盖。版本升级必须提供显式 state migration 或指定受影响范围重放，失败保持该规则 failed/disabled，不能清库重建以掩盖错误。

规则触发、计次门槛和业务步骤属于各模块，不写死在 DiscoveryHost。宿主负责输入分发、授权、预算、取消、游标、提交、来源校验、去重及提示状态。逻辑模块限制是内置代码的接口约束，不宣称受限 context 本身能沙箱恶意 Node 代码；通过静态依赖检查与评审禁止绕过，未来外部代码需要另行隔离设计。

## 2. 输入快照与受限 Context

```ts
type DetectionInput = {
  evaluationId: string;
  workerId: string;
  workerVersion: number;
  ruleId: string;
  ruleConfigurationRevision: number;
  generation: number;
  inputs: readonly CommittedInputRef[];
  cursor: Cursor;
  stateRevision: number;
  state: unknown;
  sourceSnapshot: readonly SourceRevisionRef[];
  consentRevision: number;
  associationRevision: number;
};
type DetectionResult = {
  nextCursor: Cursor;
  nextState: unknown;
  findings: readonly FindingDraft[];
};
```

input 只引用已提交且仍有效的 ActivityEvent、Period、WorkInstance 和证据；不读取 capture staging 或尚未提交的模型输出。cursor 为宿主持久化变更日志位置，含可比较 sequence；不能用业务时间戳代替，避免相同时刻或迟到修订被跳过。state 按 worker/rule 独立、可序列化且有大小上限，不包含凭证、绝对路径、任意可执行内容或无来源的大段复制正文。

sourceSnapshot 记录本次所有读取来源的 id/revision/lifecycle；associationRevision 固定 Period 与 WorkInstance 关联版本；consentRevision 固定分析授权与应用范围。ctx 后续查询返回的新来源必须加入读取集合，提交前一并核对，不允许只校验初始输入。

DetectionContext 仅提供：

- `signal`、deadline 与输入/输出大小、查询次数等有界执行预算。
- 在宿主确定的来源、应用、时间和数量范围内查询已提交活动/实例的只读方法；返回内容带 sourceRef/revision/basis，不提供任意 SQL。
- 经统一 ModelJobs 的文字分析入口；其派发和返回均复核来源及独立文字授权，不向 worker 暴露 URL、Key、认证文件或裸网络句柄。
- 使用同一输入快照生成稳定去重身份所需的规范化对象线索及已确认 targetId/alias 查询。

ctx 不提供任意文件系统、网络、数据库连接、进程/shell、Codex、DocumentConnector 或业务写入接口。worker 只能返回 FindingDraft 与自身 state，不能创建/应用 Proposal、写 Skill 文件、修改目标文档、发券/投放或发送消息。可用动作由宿主枚举分发，不接受脚本、路径或命令字符串。

`authorized_text` 规则在授权缺失时进入 waiting_authorization，不发送模型请求、不伪造分析成功；游标不越过尚未完成输入，授权恢复后可重放。`local_only` 规则可在其已授权的本地读取范围运行。模型迟到、撤销、输入来源删除及关联修订均按过期结果处理，不能以模型调用完成作为提交成功。

## 3. Finding 与稳定身份

```ts
type FindingDraft = {
  kind: string;
  ruleId: string;
  findingKey: string;
  subjectKey: string;
  targetId?: string;
  sourceEventRefs: readonly string[];
  instanceRefs: readonly string[];
  basis: 'observed' | 'inferred' | 'confirmed';
  reason: string;
  pendingConfirmations: readonly string[];
  actions: readonly ('review' | 'review_skill' | 'dismiss' | 'snooze')[];
};
```

宿主从 input 补充 workerId、workerVersion、来源版本和审计时间，不信任 worker 自报这些字段。kind 必须属于已注册 outputKinds；每个引用必须可从本次读取集合追溯，不能引用未来事件、无效证据或不在范围的其他对象。reason 明示事实、推断和待确认项，不把相同标题、正文变化或输入停顿写成已确认编辑/保存。

唯一身份是 `(workerId, ruleId, findingKey)`。findingKey 表示同一发现/业务模式的稳定身份，不能包含 evaluationId、重试次数、每次输入 batch、运行时间或 workerVersion。新增支持证据、重放、版本升级及实例关联修正应更新既有候选；确属不同业务目标/轮次的发现才使用不同 key。单次事件提示可使用稳定事件标识；重复模式不以“当前刚好够门槛的两/三个 instanceId 集合”作为会随新证据变化的新通知 key。

subjectKey 在发现阶段可为未注册对象的稳定线索，targetId 可缺失；不得要求预先选择本地文件。相同窗口标题不足以确定 subjectKey/targetId 相同；弱线索保留待确认，不强制合并。用户确认 targetId 时，宿主事务更新 alias、合并同一发现及其抑制记录，禁止因临时 subjectKey 变成 targetId 再提醒一次。

通用 Finding 允许 `instanceRefs: []`，例如一个事件触发的查看提醒；公共宿主不得强制“两次实例”或“生成 Skill”。支持证据必须足够解释该提醒，空实例不意味着可无来源。

## 4. 内置规则语义

| 模块/规则 | 判定和输出 |
| --- | --- |
| DocumentUpdateWorker: daily / weekly / document | 三类各自按 `distinct instanceId >= 2` 的疑似更新实例提示重复候选；列出证据及待确认身份/编辑行为，不以截图数、Period 数或返回次数计次 |
| SopSequenceWorker: coupon_strategy | 至少三个不同、内部步骤有序且对象/业务轮次和可见结果相符的 SOP 实例；只提示沉淀/预览，不触发真实业务写入 |
| 其他内置单次提示 | 可由一次活动触发，无需关联 WorkInstance 或生成 Skill，但仍服从来源、授权与去重规则 |

WorkInstance 表示一次业务目标，不等于连续 Period。A 10 分钟 -> B 5 分钟 -> A 15 分钟若证据支持续接，则 A 的两个 Period 属于同一实例，重复计数仍为 1；A 时长取片段区间并集，不取首次到末次的 30 分钟。不同日期块/业务目标可产生新实例，证据不足保留关联待确认。固定静置时间、切窗或 gap 不能直接完成/新建实例，gap 也不补计时长。

配券/策略 SOP 的三个实例必须分别符合已配置的步骤和结果判据。允许挂起续接，但不得把 B 的操作拼入 A 的本轮流程，不把三个孤立步骤当三个实例。未定义步骤或来源不足保持 unknown。发现阶段的跨应用对象身份与执行阶段的已注册 connector 目标分别保存。

接受文档/SOP 候选只创建可追溯草稿；人工确认实例、目标、格式及更新范围后才可形成就绪 Skill。target 或编辑身份未解决时保持草稿。接受、保存或导出 Skill 均不授予 Codex 输入或目标写入权限。

## 5. 调度、事务与恢复

同一 workerId/ruleId 的求值串行，不同规则独立。宿主可共享有界执行池，但不能用一个永不结束的 async 调用阻断采集或其他规则。deadline 到期或计算卡死时终止相应可终止执行单元、丢弃结果，重建后从上个已提交 cursor 恢复；affected rules 标记 interrupted/failed。队列、每次读取和输出均有上限，积压可见，不静默丢输入。

提交必须是一次数据库事务：

1. 校验 worker/version/规则配置仍有效、规则未 disabled、generation 未改变、stateRevision/cursor 仍与读取基线一致。
2. 重验整个读取集合的 source revision/lifecycle、consentRevision 与应用范围，以及 associationRevision；任一不匹配则回滚，安排当前快照重算。
3. 校验 Finding schema、稳定身份与引用集合，按唯一键 upsert；同一发现的 dismissed/snoozed/accepted 状态不被 worker 覆盖。
4. 写 nextState、nextCursor 和新 stateRevision；记录该次已提交求值及必要的通知待办。任一步失败整体回滚，不能只推进 cursor 或只提交候选。

UI 仅呈现已提交 findings。通知待办与发现同事务持久化，按稳定候选及通知代数去重；崩溃重放不能让同一发现反复弹出。协议保证发现提交可重放且界面身份稳定，不声称操作系统通知系统提供跨崩溃严格 exactly-once。

单规则失败保留 cursor/state，持久化错误码、阶段和重试次数，有限退避后保留可见 failed 状态；其他规则和采集继续。disabled 阻止新分发、提升规则 generation 并撤销在途提交；恢复从最后已提交游标继续。进程重启把未提交 running 标 interrupted 后重放，不把它当已处理。

## 6. 修订、删除与抑制

- `instance.revised` 或人工对象/行为更正写入新的持久输入序列。宿主按受影响来源定位 state/findings 并安排重算；不得因旧 cursor 已过业务时间而跳过修订。
- 实例合并/拆分后重算 distinct instanceId 和顺序；门槛不再满足时失效候选并解释原因，不保留错误重复计数。原始观察不改写，关联 revision 递增。
- 主动删除来源在数据库事务中先失效相关发现、规则/Skill 来源与任务，再安排重算/幂等文件清理；查询和提交均拒绝已失效来源，不等待下一轮扫描才拦截。仍有效的其他来源若独立满足规则，可重新证明同一发现，但保留它的抑制身份。
- 30 天图片引用到期只使原图不可看；仍保留的文字、实例和周期可继续按授权使用，不能误当主动删除全部来源。依赖已过期图像的专项判据须标证据不足。
- consent 撤销/缩小范围阻止新模型请求、取消未发送任务并丢弃迟到结果；宿主重验本地读取及模型处理各自权限，不把授权变更误作新发现。
- 重复提示使用 24 小时冷却；dismiss、restore、snooze 及 snoozedUntil 持久化。worker upsert 只能更新依据和内容，不能清除用户抑制；restore 是明确宿主动作，snooze 到期重新出现仍沿用同一候选身份。
- workerVersion 或规则配置升级必须保留同一发现的抑制状态。若 findingKey 算法改变，提供显式 key/alias migration，不能通过全量新 key 重新通知。
- 临时身份确认到 targetId 时事务合并候选、来源和抑制记录；保留 accepted/Skill 关系及更长的有效稍后期限。冲突身份不得自动合并；已有 Skill 对应的是版本更新建议，不再弹出同模式全新候选。

## 7. 契约验收

使用未预注册文件的跨应用输入，分别验证日报、周报、普通文档两个不同实例提示与 A -> B -> A 只计一次；只读滚动、刷新、协作变化、同名不同文档不被声称已确认更新。配券/策略三个完整有序实例可提示，乱序/跨轮拼接与单次浏览不得冒充重复 SOP。

注册一个无实例单次提示模块验证宿主通用性；重复注册冲突、输入重放、事务中断、进程重启、超时、单规则失败/禁用/恢复、授权撤销迟到、来源删除、关联拆合、目标身份确认及 worker 升级逐项验证。候选、state/cursor 不出现部分提交，用户抑制不丢失，不因重试/升级/确认目标再通知。检测全程不能访问任意 FS/network/process 或产生文档/业务写入，所有模型调用由 ModelJobs 统一审查。
