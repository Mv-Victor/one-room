# 技术方案 v0.2

2026-10-15 采集方案细化见 [事件捕获规格](../specs/001-event-driven-capture/spec.md) 与 [固定版本源码调研](../specs/001-event-driven-capture/research.md)：采用 MemoryLane 式 Electron/TypeScript 主体与小型 Swift helper，借鉴 Screenpipe 的事件触发、AX 正文优先/OCR 补充及时间线体验，不引入 Rust。以下采集细节按新规格收敛，尚未实现。

交付顺序：P0时间分配一目了然（游标、周期总结、日/月回顾与报告入口），P1日报/周报/普通文档更新SOP与Codex复用，P2配券/策略SOP。架构扩展和源码调研不能替代P0业务语义验收。

正式实施基线和更细契约见[实施规划](../specs/001-event-driven-capture/plan.md)、[数据模型](../specs/001-event-driven-capture/data-model.md)及[接口契约](../specs/001-event-driven-capture/contracts/desktop-ipc.md)。本文件为模块总览；Phase 0的版本/ABI、Codex能力门槛与来源生命周期决策见research第7节。当前工程基座和启动脚本已创建，实际交接见DEVELOPMENT_HANDOFF.md；历史原型不作为产品验收。

正式应用的实现契约；历史HTML仅为模拟说明，当前检出未含该原型。Electron/SQLite 基座已创建，真实采集、模型、Codex及文档写回尚未实现。旧版Playwright浏览器重放改为后续方案，不在MVP安装包引入Chromium worker。所有时间UTC epoch ms落库，界面按Asia/Shanghai显示，dateKey只作分组。

## 1. 模块、边界与目录

Electron + React/TypeScript + 受限preload；contextIsolation=true、nodeIntegration=false、sandbox=true。Renderer无文件、数据库、凭证和任意进程权限。主进程只开放白名单方法，校验sender、输入和响应。模块目标目录如下，当前仅落地基座所需子集：

```text
src/shared/        contracts.ts, schemas.ts, errors.ts
src/main/          app.ts, ipc.ts, permissions.ts
src/services/      capture/, evidence/, worklog/, discovery/, skills/, documents/, agents/
src/workers/       database.ts, model.ts, discovery.ts, codex.ts
src/renderer/      timeline/, calendar/, discoveries/, skills/, runs/, reports/, settings/
native/           最小Swift helper（窗口事件、截图、AX正文、Vision OCR）
tests/             fixtures/, integration/, e2e/
```

| 模块 / Owner | 输入 → 输出 | 约束与生命周期 |
| --- | --- | --- |
| CaptureService / A | Swift窗口事件/截图/AX + TS调度 → Event/Gap | 权限+白名单，有界调度与补采，暂停丢在途结果，退出flush；窗口API降级需实测 |
| EvidenceStore / A | 图像 → ID/相对路径/hash | userData私有目录，受控evidence协议按ID读，不暴露任意路径 |
| DatabaseWorker / A | 校验后的操作 → SQLite结果 | better-sqlite3串行，WAL/FTS5，迁移事务与删除；不阻塞UI |
| Segmentation / B | 有序Event/Gap → Period+Summary | A供观察/缺口/活动及模型服务，B负责周期、对象/主题总结与人工锁 |
| TimelineQuery / B | 时间范围/过滤/LOD → 周期/月份聚合 | 日月同源，截图按游标懒加载，陈旧请求丢弃；DB命令由A接唯一worker |
| ActivityEvents / A | 窗口/控件/输入时序/文本 → 有来源的活动与人工修订 | T020依赖文本、模型队列和B的周期DTO；变化不直接证明本人编辑/保存 |
| ModelConfig / A | 地址/模型名/用户输入Key → 安全配置与hasCredential | T064包含配置UI、加密存储/清除/合成测试；不返回Key，测试不授权后台文字发送 |
| ModelJobs / A | 授权可见文本 → schema结果 | T021依赖T019/T064；独立持久授权、范围检查、撤销及派发/提交双验；并发1，不自动发图 |
| WorkInstanceTracker / B | 活动事件、周期 → 工作实例/关联修订 | 多片段挂起/续接，保留推断依据；不以切窗或静置直接完成实例 |
| DiscoveryHost / B | 已提交活动事件、实例修订 → 发现提示 | worker自注册，统一调度/授权/游标/去重；业务条件由检测器声明，不执行写入 |
| SkillService / B | 确认规则 → 不可变SkillVersion | 草稿独立，导出SKILL.md与manifest，不安装进全局Agent配置 |
| DocumentConnector / A | 用户选目标 → snapshot/apply/verify | MVP本地Markdown，目标注册ID，不接受renderer任意path |
| CodexAdapter / A | 固定Skill+输入快照 → Proposal | T047含连接状态UI，T048实现进程adapter；固定binary/args/JSONL，不开放shell拼接 |
| RunCoordinator / A | Proposal+确认 → 应用/回执 | 连同输入/diff审核UI形成执行闭环；应用由connector写回，冲突/幂等/核验 |

app.ready初始化DB/权限，后台摘要消费已提交事件；退出取消推理、停止采集、等待本地事务。恢复时扫描未终态Job/Run，标interrupted并核验是否已应用，不自动重写。首版不运行远端分享服务，后续仅发布报告投影。

## 2. 数据模型

实体UUID，版本递增；示例短ID只供文档/原型。foreign_keys=ON、WAL、busy_timeout=5000、synchronous=FULL；schema_migrations逐次事务，升级前用SQLite backup API备份DB，失败保留原库只读，不自动降级。图片blob可按hash复用，但每次观察的Evidence引用分别按观察时间30天到期；旧引用不因新观察复用图片而复活。

| 表 / 实体 | 必要字段与关联 |
| --- | --- |
| capture_events | id, commitSequence, observedAt, endTs?, bundleId, appName, pid, windowId, windowTitle?, visibleUrl?, trigger, sessionId, captureGeneration, pairingStatus, visibilityStatus, revision |
| text_evidence | id, captureEventId, method(accessibility/ocr), content?, status, completeness, fallbackReason?, revision；混合结果保留两条来源 |
| capture_gaps | id, startTs, endTs?, reason, sessionId, captureGeneration, revision |
| evidence / evidence_blobs | 每观察独立evidence引用含observedAt/expiresAt/status；blob含hash/相对路径/尺寸与清理状态，不能用新引用复活过期ID |
| periods | id, startTs, endTs?, appBundleId, activityType, objectKey?, objectLabel?, topic?, summary?, result?, basis, confidence?, revision, summaryStatus, manuallyLocked |
| source_refs / period_sources | 类型化实体外键及revision；来源按消费者真实join关联，不能仅存JSON数组 |
| document_targets | id, connector(local_markdown), opaqueRef, displayName, fileIdentity, authorizationAt, status, revision；路径只在main |
| activity_events | id, observationRefs, startTs, endTs, action, objectHints, basis(observed/inferred/confirmed), revision；通用事件关联文字/控件/输入时序，不存键盘字符 |
| work_instances | id, kind, observedObjectKey, goalKey?, targetId?, status(active/suspended/completed), firstSeenAt, lastSeenAt, completionBasis?, identityBasis, confirmationStatus, revision；发现时可无已注册targetId |
| work_instance_periods | instanceId, periodId, associationBasis, associationStatus, revision；一个实例可关联非连续周期，同周期至多一个主要时长归属，未确认可不关联 |
| discovery_worker_states | workerId, version, ruleId, cursor, state, status, lastError?；各规则处理进度/状态独立 |
| discoveries | id, workerId, workerVersion, ruleId, kind, findingKey, subjectKey, targetId?, sourceEventRefs[], instanceRefs[], reason, actions[], priority, status, snoozedUntil?, dismissedAt?, relatedSkillId?；类型可扩展 |
| skills / skill_versions | 草稿独立；skill_versions.id为不可变UUID，UNIQUE(skillId,version)，含目标/格式/范围/输入/校验规则及来源join |
| runs / proposals | runs引用skillVersionId UUID、输入/目标hash和generation；Proposal八字段契约见下文，来源通过run_sources关联 |
| document_operations | 写前intent、before/after hash、文件identity、阶段及幂等键；同target串行，恢复不自动重写 |
| receipts | runId, stage, startTs, endTs, outcome, errorCode?, artifactRef?, beforeHash?, afterHash? |
| reports | id, kind, rangeStart/end, body, timelineSnapshot, coverage, sourceRevision, revision, linkedTargetId?；首版仅本地，无publication服务 |
| jobs | id, kind, sourceRevision, status, attempt, inputRef, resultRef?, errorCode?, canceledAt? |
| domain_changes | 持久sequence、类型化实体引用及revision；与领域修改同事务，worker不按观察时间消费 |

FTS5 trigram索引标题/正文/摘要，1–2字查询走有范围和上限的LIKE。时间区间半开[start,end)，跨零点分日投影但源事件不丢。空白单独查询，不填充业务。主动删除轨迹清理相关正文/快照/索引并使来源、候选、Skill和报告失效；执行需重新选择可用来源，已写用户文件不自动回滚。截图满30天到期仅清理图片，文字、周期与报告保留，图片引用标过期，文字来源仍可用。

```ts
type Basis = 'observed' | 'inferred' | 'confirmed';
type Activity = 'direct_chat' | 'group_chat' | 'meeting' | 'document' | 'business' | 'unknown';
type SkillVersion = {
  id: string; skillId: string; version: number;
  kind: 'daily'|'weekly'|'document'|'coupon_strategy';
  targetId?: string;
  sectionRule: { mode:'dated_block'|'marked_section'; marker:string };
  formatRules: string[]; inputSchema: object;
  checks: ('outsideUnchanged'|'dateUnique'|'headingsPreserved'|'sourcesValid')[];
};
type Proposal = {
  runId: string; generation: number; skillVersionId: string;
  inputSnapshotHash: string; targetSnapshotHash: string; sectionRef: string;
  sourceRefs: string[]; replacementMarkdown: string;
};
```

历史原型s1/e1对应Period/Evidence，docSkill对应草稿，documentTarget是模拟文本；当前检出无这些文件，不提供其启动命令。正式DB迁移独立，不把历史原型样例或localStorage灌作真实历史。完整字段、约束与事务以data-model.md为准。

## 3. IPC与任务协议

统一 `{requestId,payload}` → `{requestId,ok:true,data,dataRevision}` 或 `{requestId,ok:false,error:{code,detailCode?,message,retryable}}`。写操作单独idempotencyKey，同key不同payload为CONFLICT/IDEMPOTENCY_CONFLICT；编辑用expectedRevision。订阅含streamId/sequence/revision，跳号或重启重新查询；它不代替持久domain_changes。完整参数以[Desktop IPC](../specs/001-event-driven-capture/contracts/desktop-ipc.md)为准，下表仅列模块入口。

| 方法 | 输入 | 输出 / 行为 |
| --- | --- | --- |
| app.getStatus / capture.pause/resume | {} / {expectedRevision} | 状态/权限/最近成功；暂停提升generation并关闭区间 |
| timeline.query / timeline.resolveCursor | 时间范围及过滤 / {cursorTs,queryRevision,bundleIds?,query?} | 周期/gap/页或带requestToken的证据定位 |
| calendar.query | {month,bundleIds?,query?,cursor?,limit?} | 按日时序周期/覆盖/报告引用，同源分页 |
| period.correct / activity.correct / instance.reassociate | 实体ID、expectedRevision和确认依据 | 保留修订及原始事实，实例计数随关联重算 |
| discovery.list/get/act / worker.list/setEnabled | 提示/规则ID、revision及白名单动作 | 公共生命周期、独立启停；接受重复/SOP只建草稿 |
| target.pickLocalMarkdown / target.inspect | 用户文件选择 / {targetId} | 私有路径注册、现文hash/范围预览；独占声明后才允许写 |
| skill.saveDraft/publishVersion/export | schema草稿 / Skill及revision / skillVersionId | 草稿、不可变UUID版本与明确导出 |
| agent.getStatus/check | {} / {provider:codex} | 安装/认证/能力状态，不隐式业务推理 |
| run.prepare / run.propose | 固定SkillVersion/来源/目标 / preparedRunId和输入确认 | 先冻结并展示，再发送已确认字节 |
| run.get/cancel/apply | runId及generation / 批准绑定 | 生成/审核可取消；文件事务阶段BUSY；二次确认才apply |
| report.get/generate | {kind,dateKey,...} | 完整日/周报告，不暗中继承软件筛选 |
| settings.updateTextConsent / history.previewDelete/delete | revision及范围/确认 | 持久文字授权独立；主动删除清理及失效传播 |

全局错误码：INVALID_ARGUMENT、NOT_FOUND、STALE_REVISION、PERMISSION_DENIED、CONSENT_REQUIRED、SOURCE_INVALIDATED、CAPABILITY_BLOCKED、CONFLICT、AUTH_REQUIRED、TIMEOUT、CANCELED、BUSY、INTERNAL；细因放detailCode，见契约映射。错误日志只记ID/阶段，不带OCR、Key、文档正文。run统一为preparing→awaiting_input_confirmation→generating→awaiting_review→applying→verifying→succeeded|no_change，其余终态及恢复见Codex契约。

## 4. 采集到周期总结

1. Swift提供前台/窗口事件，TS合并点击、输入停顿、滚动停止等触发，并提供视觉补采及静态检查点；具体间隔待实测。截图与AX前后核对pid/windowId/generation，不一致丢弃或标不确定，不回退全屏。指定SCWindow也可能返回遮挡或屏外的完整窗口表面，须另验前台/on-screen/未最小化和可见范围；不确定则丢弃并gap，AX亦不读隐藏正文。事件监听与可终止提取进程分开，打包后分别验证helper实际TCC权限。锁屏/睡眠/暂停明确关闭区间。
2. 截图与观察事实先持久化，SHA256去重图像但不丢事件时间；优先使用当前窗口AX正文，缺失、过薄或失败时本地Vision OCR补充。保存accessibility/ocr/hybrid来源、完整性和回退原因；明确排除禁止回退。变化阈值用实测校准，只发送获准必要上下文给摘要模型。
3. bundle/window变化立即建立候选边界；同窗口聊天对象/群、会议、文档或持续主题变化结合有序观察确认语义边界，回溯到首次变化并标明观察精度。确认切换后前一周期进入总结队列；不确定边界保留unknown，不以固定两次3秒采样限制事件响应。
4. 原始事件仅延续到下次有效观察/明确gap；事件心跳、补采或处理超时按实测上限标gap。短切换参考固定Screenpipe的连续应用分组：已采到的A→B→A保留三段，不新增30秒折叠合并门槛；本项目继续细分对象/主题并按真实区间计时，不沿用上游帧宽或近似分钟估时。周期最长10分钟触发阶段摘要，不强制换业务主题；摘要队列可批处理，结果逐周期关联，不把应用分组当作上游已具备逐切换AI总结。
5. B摘要schema输出activityType/object/topic/summary/result/sourceIds/confidence；sourceIds须为输入集合，起止/时长/软件由A事实填充。私聊显示聊天对象及主题，群聊显示群名及主题，会议显示可见会议主题，编辑文档显示文档及编辑主题。Kim读取可见会话名，不把OCR出现的任意人名当聊天对象；权限不足写未知。会议无音频，只描述可见主题，不能声称获知会议结论。四类周期各用至少3个真值样例验证语义，不能仅验OCR来源或截图匹配。
6. summaryStatus=pending/ready/failed，失败保留事实标签，可重试；人工改动manuallyLocked，后续模型建议不覆盖。报告/月历取同一revision投影。

后台摘要/事件分析的文字发送授权默认关闭，单独开启后持续处理获准应用，授权状态跨重启保存。派发前重验开关及应用范围，撤销或缩小范围时取消未发送任务，迟到结果按授权generation丢弃；未授权显示独立状态而非伪造摘要成功，不阻断本地采集/提取/回看。该授权不包含自动截图上传，也不代替Codex每次任务的输入确认与diff审核。

## 5. 时间导航实现

纯函数处理viewport{startTs,endTs,cursorTs,mode,selectedDate}。真实轨道宽度按时长，铆钉形游标附近就地显示时间、软件、活动、对象及主题；文字标签使用分行碰撞避让与当前标签区，不把标签挤进短色条，不依赖打开详情。拖游标用Pointer Events+pointer capture，平移仅轨道空区；rAF更新游标与标签，松手/防抖150ms查询证据，sequence丢弃迟到图像。

窄片段按显示宽度精简常驻标注，保留可命中范围及悬停/选中/放大入口，不按短时长删记录、不改变时间比例或吞并其他工作；当前游标标签始终就地可读。月格继续按时序列出短片段，密集内容滚动查看。具体上游分组及像素条件见research，不把其30px图标条件误写为30秒业务门槛。

日轴最小5分钟、默认全天；缩放锚在游标，范围限本日边界。缩小到全天后继续一个归一化缩放步才切月，跨层清累计并等待手势结束，返回日轴需反向新手势或显式选日，保留lastDayViewport。不要把普通纵向滚动变为缩放；完整状态机见UI行为契约。

macOS适配器归一化运行环境实际提供的缩放信号和按钮，去重避免同手势双触发；Safari专有gesture事件不能假定Electron/Chromium也提供。三指先验证Electron BrowserWindow的macOS swipe事件，其依赖系统“页面间轻扫”设置且只给方向，可映射分级缩放；仅在时间轴焦点/命中范围消费，不能据此宣称获得连续触点。两台Mac实测系统设置、原始信号及日/月跨层结果；标准Web API不给可靠手指数，额外原生桥接可行性在开工验证，不能假定独立Swift helper能直接读取Electron窗口触控点。系统拦截时保留替代操作且标三指受阻，控件通过不等于三指通过。Ctrl/Cmd +/-仅在时间轴焦点区，输入框不拦截。原型手势派发只验逻辑，非硬件通过。

月历查询仅加载周期摘要与覆盖状态，不加载整月图片。每个日格按起始时间列出时间范围、软件、活动、对象/主题；密集格内滚动，窄屏逐日列表。提供当日日报及所在周周报入口，无报告时进入生成或待配置；报告引用与SOP目标文档引用分开。同日不同软件过滤后聚合重新计算，不展示未过滤总数。无采集不等于未工作；已记录分钟为区间并集，不累加重叠。

## 6. 工作实例、主动提示与Skill生成

通用事件层关联a11y/OCR、窗口上下文、控件状态和输入时序，输出查看、疑似编辑、切换或未知及其basis/sourceRefs。发现时用observedObjectKey与对象线索关联，不要求先注册本地文件；身份优先可观察的稳定ID/规范URL，缺失时保留身份待确认，窗口同名不能当同文档。正文变化也可能由滚动、刷新或协作引起，单独不足以证明本人编辑、保存或提交。

连续Period与WorkInstance分开：切换或静置关闭当前片段，将原工作实例挂起；回来后依据对象、业务目标（如日报日期块）、进展与已有确认关联续接。不同工作实例可交错存在，一个实例可跨应用包含多段活动。达到明确完成判据或用户确认才标completed；重新打开同对象时，若业务目标/新一轮操作不同则新建实例，证据不足保留关联待确认。静置时限用于调度或提示待确认，不直接创造完成事实或新实例。gap前后可以关联同一实例，但不填补gap内容或时长。

例如A前10分钟→B 5分钟→A后15分钟：时间轴保留三个Period，A的两个Period关联同一个instanceId，累计25分钟；B为5分钟。时长取各实例主要归属片段的区间并集，不能取firstSeenAt到lastSeenAt的跨度。用户续接/拆分产生关联revision并触发检测重算，不改写原始观察。

主动提示由DiscoveryHost分发给自注册的检测worker。worker是逻辑检测模块，可共享有界后台执行池；不要求每种提示都独立常驻进程。内置模块在启动时向registry注册，声明稳定id、version、订阅输入与规则配置。新增内置检测模块只需装配/注册，不改CaptureService、Timeline或主分发器。首版不加载外部下载脚本；数据库、模型凭证及任意文件/进程接口不暴露给检测上下文，模型调用走统一授权的ModelJobs。

规划接口示意（不是本轮已实现代码）：

```ts
type DiscoveryWorker = {
  id: string;
  version: number;
  subscriptions: readonly ('activity.committed'|'instance.revised')[];
  evaluate(input: DetectionInput, ctx: DetectionContext): Promise<{
    state: unknown;
    findings: FindingDraft[];
  }>;
};
type FindingDraft = {
  kind: string; ruleId: string; findingKey: string; subjectKey: string;
  sourceEventRefs: string[]; instanceRefs: string[];
  reason: string; actions: ('review'|'review_skill'|'dismiss'|'snooze')[];
};
registry.register(documentUpdateWorker);
registry.register(sopSequenceWorker);
```

DetectionInput为已提交活动、相关实例修订、ruleId及该规则的前次state/cursor；DetectionContext提供取消信号、受限来源查询和经过授权的分析入口。通用Finding允许instanceRefs为空，例如未来单次事件提醒；“至少两次”和“生成Skill草稿”只属于相关检测规则，不是所有提示的公共限制。通用动作由宿主白名单处理，不接收可执行脚本或任意命令。

P1内置DocumentUpdateWorker，装配日报/周报/普通文档三类更新规则，按distinct instanceId达到2个疑似更新实例形成候选，用户无需编写检测器；三类共用Markdown读取/格式保留/差异/核验能力，普通文档明确章节范围。P2的SopSequenceWorker按已配置步骤、对象/业务轮次与可见结果识别选定SOP，配券/策略仍按3个不同有序操作实例提示，仅沉淀/预览。SOP允许中断续接，其他工作的步骤不能拼入同一轮。未定义步骤或没有足够来源的流程保持未知，不宣称任意SOP已支持。

宿主按订阅增量分发，同一worker/rule串行处理，各自维护游标与状态；快照含来源/授权/关联revision，提交时重验。findings的upsert与state/cursor推进在同一DB事务中，失败回滚后可重放。候选唯一键为workerId+ruleId+findingKey，规则版本作追溯信息而非每次升级的新通知键；检测器必须为同一发现生成稳定findingKey。重复注册相同id/version为幂等，不同定义冲突要报错；升级显式迁移或重放状态，保留同一发现的抑制状态。

单规则失败不推进游标，记录可重试状态；超时任务在可终止的后台执行单元中隔离，宿主可重建执行单元并恢复未提交任务，采集与其他检测不被持续阻断。禁用或撤销授权使该规则在途结果失效。关联修订或来源删除触发候选重算/失效；图片到期仅影响图片引用，保留文字仍按授权可用。

重复提示使用24小时冷却，dismiss/restore/snooze持久化；身份从临时subjectKey确认到targetId时，事务合并相关候选及抑制记录。已有Skill指向版本更新建议。弱线索不得合并为已确认身份；工作实例合并/拆分后重算distinct instanceId，不把同一次工作的返回当新增次数。

对重复/SOP沉淀类提示，接受仅创建草稿，需人工确认实例、目标身份、格式与更新区域；首版执行再选择本地Markdown目标，读取当前文档分析标题/日期块。未解决的实例或身份歧义阻止Skill就绪。保存Skill仅持有规则和来源，不是模型微调。导出SKILL.md和manifest.json，可供以后Agent加载；MVP通过任务上下文显式传入，避免依赖全局Skill安装与用户配置。未来其他提示类型可仅查看或处理提醒，不强制生成Skill。

## 7. Codex与文档事务

采用本机 `codex exec` adapter，初始兼容基线为已检查help的0.144.1：支持 `--json`、`--sandbox read-only`、`--output-schema`、`--ephemeral`、`--ignore-user-config`、`--ignore-rules`及stdin输入，实际推理与工具隔离尚未验收。忽略用户配置不等于全配置隔离，只读不限制所有MCP/Apps或读取路径；需逐项禁用shell/Apps/hooks/远程插件/搜索并用合成材料验证无额外工具启动，失败capability_blocked，禁止发送业务材料。官方来源：[非交互模式](https://developers.openai.com/codex/noninteractive/)与[配置参考](https://developers.openai.com/codex/config-reference/)（2026-10-15查阅）；不锁定未测模型、不把GPT兼容Key当Codex账户。安装包引导单独安装，不捆绑用户auth文件。Claude实现disabled adapter，不运行探测或收费请求。

执行分两层：Codex只生成结构化Proposal，应用的DocumentConnector负责写回，因而不能靠“prompt不要写别处”当权限控制。

1. 本地文件选择注册，main先lstat原选择路径拒绝symlink/非普通文件，再realpath解析及保存文件身份，限制2MiB；读取UTF-8、保留BOM和LF/CRLF原始字节，存hash和目标字节区间。首版支持Markdown明确日期块/标记章节，不可靠解析时返回UNSUPPORTED_FORMAT。
2. 每Run隔离工作目录，只放审核过的Skill、轨迹JSON和文档目标段；不复制整库/聊天或用户目录。固定参数数组spawn，shell=false，任务通过stdin，无任意命令输入。使用read-only sandbox、忽略规则及用户配置并显式禁用额外工具；只有能力门槛通过才发任务，不以提示词或cwd宣称读取/工具隔离，不自动放宽权限。认证沿用本机Codex，凭证不进Renderer或任务材料。
3. JSONL流解析大小限制与错误处理，stdout按行缓冲；最终Proposal经Zod/schema校验。进程退出0不等于业务成功，必须有有效proposal。默认120秒超时、用户取消SIGTERM后宽限2秒再kill进程组，迟到输出按run generation token丢弃；日志不显示敏感原文。
4. 只允许替换选定章节；验证来源ID、日期范围、标题结构，不允许删除非目标文本。按行diff用成熟diff库生成；awaiting_review展示目标、来源和变更，无人工确认不apply。
5. apply核对目标hash/文件身份，串行锁同target，生成完整新文件但确保范围外字节不变；同目录临时文件fsync再rename，失败保留原文。MVP要求该目标通过One Room独占编辑，二次hash/文件元数据检查防常见冲突；外部编辑器与本地rename之间仍有TOCTOU窗口，不能宣称跨进程强CAS。非独占场景仅导出补丁，云connector必须支持条件更新。
6. operation记录预期before/after hash，写前持久化意图，写后重读核验；若应用后崩溃，恢复比较hash，after匹配则补核验/回执，不再次写；before匹配以interrupted结束并等待重新prepare/确认，其他情况conflict。日期唯一、格式、来源通过才succeeded；已更新同日期显示no_change。applying/verifying不能取消文件事务，必须完成核验或恢复。

首版不让Codex自行调用真实配券/投放接口。之后若扩展浏览器，使用专用Playwright会话、明确DOM步骤和审批，不从截图直接无限坐标点击。

## 8. 依赖复用与打包

| 能力 | 采用 / 许可 | 接入与验证 |
| --- | --- | --- |
| 客户端/构建 | Electron、React、electron-vite、electron-builder / MIT | 新项目模块化；arm64包，Chromium第三方声明 |
| 前台窗口 | Swift NSWorkspace/AXObserver；get-windows / MIT作为降级候选 | 仅获准前台窗口；事件、打包资源与授权实测 |
| 图像/文本 | ScreenCaptureKit、Accessibility、Vision；Electron窗口截图作为降级候选 | 最小Swift helper，配对/正文质量实测，签名资源随包，不要求Xcode |
| DB | better-sqlite3 / MIT | 原生ABI/electron-rebuild、WAL、worker |
| 摘要 | OpenAI SDK / Apache-2.0；Zod / MIT | 自定义baseURL，图片/结构化能力先测，不默认支持 |
| 执行 | 用户安装Codex CLI / Apache-2.0代码许可另核对版本声明 | 子进程adapter，不引入整个其他产品；认证不进renderer |
| 文档 | diff、Markdown解析库按需 / 使用版本许可核对 | 只做必要区间diff/标题校验，不能执行HTML |
| UI图标 | Lucide / ISC；原型含第三方声明 | 本地素材，不依赖CDN |

开工兼容验证后锁lockfile及版本、许可清单，不依据最新分支直接用。Screenpipe采用固定历史MIT版本的事件捕获、正文提取及时间线依据，少量摘录已保留出处与完整声明，后续适配继续署名；不引入Rust引擎。按用户最新授权，MemoryLane可直接适配原生helper与流水线代码，保留GPL许可及来源/改动声明。采用范围与文件指纹见上述调研，不引入音频、商城、向量库或全MCP插件系统。

模型成本按事件合并→本地正文提取/按需OCR→变更筛选→周期批处理控制；计实际请求/token/耗时，UI显示pending与可重试，不预设虚假成本。Key使用OS安全存储，禁止入日志/Git。截图保留30天，到期仅删除截图，提取文字、周期摘要、时间分配和报告继续保留；主动删除轨迹按所选范围撤销任务/引用，后台清文件，失败可重试并显示待清理。SQLite逻辑删除不等于安全擦除，SSD备份另受系统策略管理。

## 9. 必测与限制

首小时验证：Kim对象识别、同窗口切群、截图窗口匹配、Vision、打包权限、两Mac三指输入信号/原生适配、Codex版本/认证/只读/结构化输出、真实Markdown读改写。未通过项阻断对应能力并披露，不用静态输出或备用操作冒充原能力通过。

集成测试：采集停摆gap、对象切换、A→B→A续接同实例及不同业务目标不误合并、实例修订后重算次数、worker注册/故障隔离/重放去重、单次事件测试提示、去重/候选抑制、日月同源、来源删除、截图30天到期仅删图且文字历史保留、无预注册文件的跨应用事件发现、滚动/刷新/协作变化不冒充已确认编辑、文字分析授权跨重启及撤销丢迟到、Codex退出0无有效JSON、超时/取消、hash冲突、两次apply、写后崩溃恢复和文档范围外字节一致。两台Mac实测性能、安装和触控板；HTML测试不能替代。

核心业务验收另按spec的SC-013/014/015覆盖四类周期总结、游标文字、日轴自动缩小到月历、月格时序、日报/周报入口及三指专项；P1按SC-016逐一完成日报/周报/普通文档的格式保留与Codex复用，P2配券/策略不产生真实写请求。

云Docs、三指手势、系统审批接口、真实发券、远端分享均未验证；决策见BOUNDARIES.md。
