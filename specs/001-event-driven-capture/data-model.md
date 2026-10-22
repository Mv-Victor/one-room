# 数据模型：时间分配与可复用 SOP

日期：2026-10-15。依据[功能规格](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/spec.md)、[Phase 0 决策](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/research.md)及[技术方案](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/docs/TECHNICAL_DESIGN.md)。本文是待实现的逻辑设计，不是已创建的 SQLite schema。

## 1. 通用规则与存储边界

- 单机 SQLite 由一个后台 DatabaseWorker 持有连接，以领域命令串行读写；Renderer 无 SQL、路径或数据库句柄。启用 WAL、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=FULL`。
- 业务实体使用 UUID；`revision` 为正整数，修改必须带 `expectedRevision`。检测分发另用递增 `commitSequence`，不能按可能迟到的观察时间充当消费游标。
- 所有时刻为 UTC epoch ms；区间为半开 `[startTs,endTs)`，已关闭区间满足 `endTs>startTs`。开放区间的 `endTs=NULL`，只能延续至已确认检查点，不推算到当前时刻。
- 展示时区固定 `Asia/Shanghai`，周一为周首。`dateKey` 是投影键，不替代真实时间；跨零点切分日投影，不修改源观察。日、月、报告读取同一已提交事实 revision。
- 技术触发与业务动作分离；统一 `basis=observed|inferred|confirmed`，未知对象/主题用空值及状态表示，不用旧标签填充。模型不能修改事实时间、软件和缺口。
- 原始观察及提取证据不被人工修订覆盖；派生周期、活动和实例关联保存修订。SkillVersion 和执行输入在确认后固定，后续编辑创建新版本。
- JSON 仅用于有 schema 的规则配置、有限状态及不可变展示快照。凡需要查找来源、撤销或删除传播的关系必须有带外键的关联行，不能只存 `sourceRefs[]` JSON。
- 截图和临时文档在受控 `userData` 子目录；数据库只保存相对路径或主进程私有目标引用。Renderer 仅用 ID 访问受控协议，日志只记 ID、阶段和错误码。

## 2. 观察、文字、截图与缺口

| 表 | 关键字段 | 关系与约束 |
| --- | --- | --- |
| `capture_events` | `id, commitSequence, sessionId, observedAt, endTs?, bundleId, appName, pid, windowId, windowTitle?, visibleUrl?, trigger, captureGeneration, pairingStatus, visibilityStatus, textStatus, revision, deletedAt?` | 一行是一项观察，不是业务事件；`pairingStatus=matched|uncertain`。只有确认前台、未最小化、on-screen 且可见范围获准时才能保存图文。无法确认窗口可见性时拒绝该图文并记录 gap，不把指定窗口的隐藏表面当作可见内容 |
| `text_evidence` | `id, captureEventId, method, content?, contentHash?, observedAt, status, completeness, fallbackReason?, errorCode?, revision, deletedAt?` | `method=accessibility|ocr` 分行保存；`status=ready|partial|empty|failed|excluded`与原生提取结果一致，`completeness=complete|thin|partial|empty|unknown`表示正文完整度：thin仅工具栏等无有效正文，partial为正文不完整，empty为无文字。失败/排除不能以empty冒充成功，excluded不含正文也不触发OCR绕过。混合结果由同观察的两条来源表达，不丢失各自正文及质量 |
| `evidence` | `id, captureEventId, blobId?, observedAt, expiresAt, status, revision, unavailableAt?, unavailableReason?` | 一观察至多一个截图引用，`UNIQUE(captureEventId)`；`expiresAt=observedAt+30*24*60*60*1000`，创建后不延长。`status=available|expired|deleted|missing`；每个引用独立判断有效性 |
| `evidence_blobs` | `id, sha256, relativePath, mime, width, height, byteSize, storageState, createdAt, lastError?` | `sha256` 唯一，复用同一文件；`storageState=ready|cleanup_pending|missing`。有效引用由 evidence 查询得到，不能只依赖易失真的内存引用计数 |
| `capture_gaps` | `id, sessionId, startTs, endTs?, reason, captureGeneration, revision` | `reason=paused|locked|sleep|permission|excluded|visibility_unknown|queue_overflow|capture_error|process_interrupted`。同一前台轨迹的有效区间与 gap 不重叠；缺口表示未记录，不表示未工作 |

截图先写受控临时文件、完成校验及原子落盘，再在同一事务创建 blob、evidence 引用和 capture_event。文件成功而事务失败产生的孤儿由恢复清理；事务已提交但文件后来丢失则标 `missing`，不显示旧图替代。文字任务可随后提交，不等待模型，文字失败不删除有效截图。

SHA256 去重只复用存储，不减少观察数、改变观察时间或周期计时。已有图像在第 31 天再次出现时，新引用有新的 30 天；第 1 天旧引用仍是 expired，即使同一个 blob 仍在磁盘也禁止通过旧 ID 读取。最后一个未到期、未删除且可用的引用消失后，blob 才进入文件清理。同一blob的新引用发布与unlink须经EvidenceStore的每blob锁串行；持锁复核引用并完成清理后才允许发布新引用，避免仅在unlink前查询一次造成竞态。重启发现cleanup_pending时先核对文件和引用，再恢复或重新落盘，不向缺失文件发布可用引用。

建议索引：`capture_events(observedAt,id)`、`capture_events(bundleId,observedAt)`、唯一 `commitSequence`、`text_evidence(captureEventId,method)`、`evidence(status,expiresAt)`、`evidence(blobId,status,expiresAt)`、`capture_gaps(startTs,endTs)`。

## 3. 周期、活动事件与工作实例

| 表 | 关键字段 | 关系与约束 |
| --- | --- | --- |
| `periods` | `id, startTs, endTs?, appBundleId, activityType, objectKey?, objectLabel?, topic?, summary?, result?, basis, confidence?, boundaryBasis, summaryStatus, manuallyLocked, revision, deletedAt?` | `activityType=direct_chat|group_chat|meeting|document|business|unknown`；`summaryStatus=not_authorized|pending|ready|failed|insufficient`。一个周期是连续片段，不跨 gap；同应用对象/主题切换可形成新周期。已采到的短片段无最小秒数过滤 |
| `period_sources` | `periodId, sourceRefId, sourceRevision, role` | 联合唯一；仅关联其观察、文字和截图证据。`role=boundary|content|image`。周期摘要引用的来源必须是提交给该任务的来源子集 |
| `activity_events` | `id, commitSequence, startTs, endTs, action, observedObjectKey?, objectHints, basis, confidence?, confirmationStatus, revision, deletedAt?` | `action=view|suspected_edit|context_switch|unknown`；保留对象线索，不将正文变化等同本人保存/提交。用户修正新建修订，不修改 capture_events |
| `activity_event_sources` | `activityEventId, sourceRefId, sourceRevision` | 关联观察、文本和周期，联合唯一；无有效来源不能成为确定的编辑事实 |
| `work_instances` | `id, kind, observedObjectKey?, goalKey?, targetId?, status, confirmationStatus, identityBasis, completionBasis?, firstSeenAt, lastSeenAt, revision, deletedAt?` | `kind=daily|weekly|document|coupon_strategy|other`；`status=active|suspended|completed`。发现时 `targetId` 可为空，目标标题相同不足以确认同一对象 |
| `work_instance_periods` | `instanceId, periodId, associationRole, associationBasis, confirmationStatus, revision, validFromSequence, validUntilSequence?` | `UNIQUE(instanceId,periodId,revision)`并保留关联修订；`associationRole=primary|supporting`。当前同一instance/period关系唯一，对仍有效的 `primary` 关联施加 periodId 部分唯一索引，单 period 至多一个主要时长归属；未确定可不归属 |
| `period_revisions` / `activity_event_revisions` / `work_instance_revisions` | `entityId, revision, previousRevision?, changedAt, changedBy, reason, snapshot` | 各表 `UNIQUE(entityId,revision)`；保存人工/算法修订依据。快照不替代 source 关联；删除处理见第 8 节 |

周期投影按起始时间排序，日格包含时间、软件、活动、对象/主题、摘要状态与覆盖；不加载整月截图。日轴缩小时精简标签，不删除片段；时间游标永远可查询完整当前标签。时长取真实半开区间并集，跨日按显示时区切投影，不能按截图数或 firstSeenAt 到 lastSeenAt 估算。

工作实例迁移：`active -> suspended -> active` 可重复；达到可追溯完成判据或用户确认才 `-> completed`。离开窗口、静置、gap 只结束连续片段或挂起实例，不自动完成。新日期/目标可新建实例，证据不足保留 `confirmationStatus=pending`；人工续接、合并或拆分关联后提升 revision、发布修订输入并重算检测。

A 10 分钟 -> B 5 分钟 -> A 15 分钟保留三个 period；两段 A 关联同一实例，累计 25 分钟、一次实例。B 为 5 分钟、一次实例。实例跨应用或跨 gap 续接不能补算中间时间。

建议索引：`periods(startTs,id)`、`periods(appBundleId,startTs)`、`activity_events(commitSequence)`、`work_instances(observedObjectKey,goalKey,lastSeenAt)`、各关联表双向外键索引。FTS5 trigram 索引可用正文、标题和摘要；1–2 字查询走有时间范围及结果上限的 LIKE。删除和修订在同事务更新索引，不让搜索返回失效内容。

## 4. 来源有效性与持久授权

| 表 | 关键字段 | 关系与约束 |
| --- | --- | --- |
| `source_refs` | `id, kind, captureEventId?, textEvidenceId?, evidenceId?, periodId?, activityEventId?, workInstanceId?, currentRevision, state, invalidatedAt?, reason?` | `kind` 对应且仅一个类型化外键非空，使用 CHECK 与各类型部分唯一索引。`state=valid|deleted|superseded|expired`；expired 仅用于截图。来源实际有效性还须检查实体与祖先来源，不能单靠引用行缓存 |
| `job_sources` / `discovery_sources` / `skill_version_sources` / `run_sources` / `report_sources` | `ownerId, sourceRefId, sourceRevision, purpose` | 各为有真实 owner 外键的独立关联表，联合唯一；其中skill_version_sources的ownerId引用skill_versions.id。固定本次消费的 revision，支持双向失效查找。不能使用无外键约束的多态 `ownerType+ownerId` 代替 |
| `settings` | `id=singleton, revision, captureEnabled, captureGeneration, backgroundTextEnabled, consentGeneration, sourceGeneration, timezone, screenshotRetentionDays, defaultAgent, updatedAt` | 后台文字分析默认 false、跨重启保存；时区 `Asia/Shanghai`、保留期固定 30、defaultAgent=codex。三类 generation 单调递增，不保存 API Key 或 Codex auth |
| `settings_allowed_apps` | `bundleId, captureAllowed, textAnalysisAllowed, revision` | 文字分析范围须是获准采集范围子集；移除应用使相应在途任务过期，不允许 OCR 或另一路采集绕过排除 |

`captureGeneration` 在暂停、权限/排除变化及重新建立采集会话时更新；`consentGeneration` 在文字发送授权或范围变化时更新；`sourceGeneration` 在主动删除等来源失效时更新。任务保存相关 generation 及逐来源 revision，派发与提交均复核。全局 sourceGeneration 变化后可重新验证不受影响的来源，不需要删除无关历史。

来源有效性按用途判定：截图作为可选图片证据到期，只影响该图片引用，不使仍有有效观察/正文的周期、活动、Skill文字来源或报告失效。主动删除则沿必须的事实/正文依赖传播；不能把“任一祖先图片已过期”误写成“整个周期来源已删除”。

对权限、可见范围或来源校验失败的任务不发送、不提交；未授权的周期保留事实并显示 not_authorized。授权关闭或范围缩小与模型派发由同一调度序列确定先后；取消未发送请求，已发送请求尝试取消且迟到结果不落地。不能承诺撤回已经发送的网络内容。后台开关永远不授权自动截图上传，也不替代 Codex 每次输入确认。

## 5. 检测 worker 与发现生命周期

| 表 | 关键字段 | 关系与约束 |
| --- | --- | --- |
| `discovery_worker_states` | `workerId, ruleId, workerVersion, ruleConfigRevision, enabled, status, cursor, stateSchemaVersion, state, revision, lastErrorCode?, lastSuccessAt?` | 主键 `(workerId,ruleId)`；`status=idle|running|waiting_authorization|failed|disabled|interrupted`，等待授权持久化且不推进未完成输入的cursor。各规则独立游标/状态，同规则串行；cursor 为已提交输入序号，不是“最后观察时间” |
| `discoveries` | `id, workerId, workerVersion, ruleId, findingKey, kind, subjectKey, targetId?, reason, priority, actions, status, snoozedUntil?, dismissedAt?, lastNotifiedAt?, relatedSkillId?, revision, createdAt, updatedAt` | `UNIQUE(workerId,ruleId,findingKey)`；版本留作追溯，不进入每次升级产生新通知的唯一键。`kind` 可扩展，公共层不强制重复次数和 Skill 动作 |
| `discovery_instances` | `discoveryId, instanceId, instanceRevision, ordinal?` | 联合唯一，记录参与计次和步骤顺序的实例；单次提示可为空。文档三类按两个不同更新实例，配券/策略按三个不同有序实例判断 |

候选 `status=open|snoozed|dismissed|accepted|invalidated`。snooze 默认 24 小时；dismiss 持久抑制同模式，restore 回 open；相同发现 24 小时不重复通知。文档重复或SOP沉淀类候选接受后进入Skill草稿，不能执行；通用单次提示按kind注册的动作查看或处理，不强制Skill、实例门槛或草稿。来源删除进入 invalidated；关联修订触发重算，不简单累加返回原工作的次数。

一个检测提交事务同时：核验输入/授权/来源/关联 revision，upsert findings 及来源/实例关联，更新有限状态，推进 cursor。失败全部回滚且 cursor 不前进；重放同输入不重复提示。upsert 不覆盖既有 accepted/dismissed/snoozed 状态。worker 升级迁移 state 或显式重放，保留稳定 findingKey 和抑制记录；同 id/version 重复注册相同定义幂等，定义冲突报错。

subjectKey 从暂定对象确认到 targetId 时，事务合并候选、来源和抑制状态，保留来源追踪；只凭同名不能自动合并。单规则失败/禁用不阻塞其他规则或采集，超时计算单元可被终止；数据库只保存状态，不加载外部可执行脚本。

建议索引：`discoveries(status,snoozedUntil,priority,updatedAt)`、`discoveries(subjectKey,ruleId)`、`discovery_instances(instanceId)`，以及来源表反向索引。

## 6. 目标文档、Skill 与 Codex 执行

| 表 | 关键字段 | 关系与约束 |
| --- | --- | --- |
| `document_targets` | `id, connector, opaqueRef, displayName, fileIdentity, authorizationAt, status, revision` | 首版 connector 仅 local_markdown。原始选择路径先 lstat 拒绝 symlink，再规范化并确认普通文件；UTF-8 Markdown 不超过 2MiB。真实路径只供 main 使用，renderer 不能自行传入路径 |
| `skills` | `id, title, kind, status, draft, draftRevision, currentVersion?, createdAt, updatedAt` | `status=draft|ready|source_deleted|archived`；draft 使用schema，只有目标、实例和规则确认后才能ready |
| `skill_versions` | `id, skillId, version, targetId?, formatRules, sectionRule, inputSchema, checks, contentHash, createdAt` | 主键id为不可变UUID，接口字段skillVersionId指向此id；保留`UNIQUE(skillId,version)`。保存后不可变，编辑另建草稿。可执行文档规则必须有确认 targetId；配券/策略只允许预览/导出，无真实业务 connector |
| `runs` | `id, skillVersionId, skillSnapshotHash, sourceGeneration, consentSnapshot, inputHash, targetId, targetBeforeHash, status, agent, generation, idempotencyKey, payloadHash, startedAt, endedAt?, appliedOperationId?` | skillVersionId外键引用skill_versions.id，skillId及版本号从该版本读取。首版 agent=codex，Claude不可创建run。输入确认固定材料、来源、Skill及目标快照；允许的用户取消递增run generation。幂等键同payload返回原run，异payload返回CONFLICT |
| `proposals` | `id, runId, proposalHash, baseHash, sectionRef, replacementMarkdown, expectedAfterHash, validationResult, createdAt, approvedAt?, approvalBinding?` | 每run一个有效proposal；批准绑定proposalHash、beforeHash、skillVersionId、输入hash和来源revision。模型返回sourceRefs必须是run_sources子集；解析失败或退出0无有效proposal均不进入审核成功 |
| `document_operations` | `id, runId, targetId, idempotencyKey, payloadHash, beforeHash, afterHash, fileIdentity, sectionRef, preservedOutsideHash, tempRef?, status, createdAt, updatedAt, errorCode?` | apply写前持久化intent；`UNIQUE(runId)`且目标写入串行。`status=intent|applying|verifying|applied|conflict|failed|interrupted` |
| `receipts` | `id, runId, operationId?, stage, startTs, endTs?, outcome, errorCode?, artifactRef?, beforeHash?, afterHash?` | 记录生成、审核、应用和核验阶段实际结果，不以进程退出0冒充成功。非正文审计元数据不包含Key、OCR或文件全文 |

文档 sectionRule 只接受可唯一定位日期块或标记章节；不能可靠定位时 UNSUPPORTED_FORMAT。目标快照保存 BOM、LF/CRLF、文件权限和原始字节hash，范围外必须字节一致，不用重新格式化整个文档。日期类现有日期更新同块，禁止重复追加；普通文档必须确认具体范围。

run 状态路径：`preparing -> awaiting_input_confirmation -> generating -> awaiting_review -> applying -> verifying -> succeeded|no_change`。故障/停止终态为 `failed|canceled|conflict|interrupted|capability_blocked|expired|source_invalidated`；仅核验通过可进入succeeded或no_change。输入或审核有效期结束进入expired，来源删除或失效进入source_invalidated；截图到期不使仍可用的文字来源失效。生成前Codex能力不满足时capability_blocked，不发送业务材料。

cancel仅在preparing、awaiting_input_confirmation、generating、awaiting_review允许；取消与进入applying在同一串行调度中裁定，取消先成立则禁止apply。进入applying或verifying后返回`CANCEL_NOT_ALLOWED`，不得转canceled；必须完成文件核验或进入interrupted恢复，不能宣称可能已写入的文件没有变化。终态重复取消不改变原结果。来源删除恰逢文件事务时仍须记录真实写入/核验结果，不自动回滚外部文档。

apply必须持有审核绑定和最新来源有效性，复读文件身份/hash；用户确认后目标变化则CONFLICT，重新读取、生成、审核。写前提交operation intent，使用同目录临时文件、fsync、保留权限、rename及目录fsync，再重读验证范围外字节、日期唯一、格式和afterHash。常规本地rename没有跨进程强CAS；MVP需目标独占编辑，否则只导出补丁，不宣称安全自动写回。

崩溃恢复：目标hash等于afterHash且验证通过，只补回执，不再次写；等于beforeHash时保留interrupted等待用户显式重试及重新校验；其他hash或身份改变进入conflict。写后异常不自动回滚外部已变更文件。重新执行相同幂等键不能创建第二个operation，也不能重复追加日期。

## 7. 报告、任务与版本快照

| 表 | 关键字段 | 关系与约束 |
| --- | --- | --- |
| `reports` | `id, kind, rangeStart, rangeEnd, timezone, weekStart, status, body?, timelineSnapshot, coverage, sourceRevision, revision, linkedTargetId?, createdAt, updatedAt` | `kind=daily|weekly`；`status=draft|ready|failed|invalidated`。日报/周报是本地时间记录投影，linkedTargetId可选，不等同SOP目标文档。报告入口打开完整日/周，不暗用当前临时软件筛选 |
| `jobs` | `id, kind, status, attempt, idempotencyKey, payloadHash, ownerRef, inputRef?, resultRef?, captureGeneration?, consentGeneration?, sourceGeneration, ownerRevision?, runGeneration?, createdAt, dispatchedAt?, endedAt?, errorCode?` | `kind=text_extract|period_summary|activity_analysis|discovery|report|evidence_cleanup`；`status=queued|running|succeeded|failed|canceled|interrupted|not_authorized`。来源通过job_sources，`ownerRef`为内部受限类型，不接受任意路径/SQL |
| `domain_changes` | `sequence, type, captureEventId?, periodId?, activityEventId?, workInstanceId?, entityRevision, committedAt` | `sequence`为数据库持久单调序号；type对应且仅一个类型化外键非空，与领域变更同事务追加。检测只消费其声明的activity.committed/instance.revised；迟到观察仍获得新提交序号，不会被时间游标遗漏 |
| `schema_migrations` | `version, checksum, appliedAt` | 版本递增且checksum不可变；升级前backup API，单次迁移事务。迁移失败阻断写入并保留原库，不静默删库或降级 |

报告snapshot固定时间、覆盖和来源revision，正文与snapshot不得在后台随着后续修订漂移；重新生成提升revision。无模型授权可给事实型工作日志，推断主题显示未授权/未知。缺口不计工作时长，记录分钟按事实区间并集；无采集不等同无工作。首版没有远端分享或 publication 服务，不建其运行依赖。

任务启动前写入可恢复状态；重启将未终态任务标 interrupted并按类型恢复。本地可重放计算经当前授权/来源校验后重新排队，Codex和外部文档写入不能自动重放。domain_changes按sequence顺序分页重放，不在全部启用规则游标通过之前清理所需输入；删除后保留事件ID及失效状态，重放时不能读回正文。数据库worker/整个进程崩溃不提供原生隔离保证；恢复以最后持久检查点结束事实区间并记录 process_interrupted gap。

## 8. 删除、到期与事务边界

| 操作 | 同一数据库事务中的必做项 | 事务外动作与恢复 |
| --- | --- | --- |
| 事实提交 | 新观察、截图引用、blob引用及commitSequence；核验captureGeneration | 已落盘文件的孤儿清理；文字/OCR及模型随后运行 |
| 周期/关联修订 | 新revision、来源关系、主要实例唯一性、投影/FTS更新、修订分发序号 | 按新revision重算摘要及检测，不覆盖人工锁 |
| 检测提交 | findings upsert、来源/实例关系、state与cursor推进、抑制状态保留 | 通知仅消费已提交发现，失败重放同findingKey |
| 关闭文字分析/缩小范围 | 设置、consentGeneration提升、未发任务取消 | 中止可取消请求，迟到结果提交重验并丢弃；本地采集独立继续 |
| 截图满30天 | 独立evidence引用expired、相关图片source_ref过期、无有效引用blob标cleanup_pending | 幂等unlink及失败重试；旧ID立即不可读；文字/周期/报告不变，不触发文字来源失效 |
| 主动删除轨迹 | sourceGeneration提升，所选观察/正文来源失效及正文清理，FTS清理，相关图片引用deleted，候选invalidated，Skill标source_deleted，未进入文件事务的run标source_invalidated、计算任务取消，报告invalidated | 清截图及任务输入缓存；撤销在途请求并拒绝迟到结果。已进入applying/verifying的文件操作须核验或恢复，不按取消处理。清理失败显示待清理且重试，不恢复可见性 |
| 人工批准apply | 审核绑定、当前来源与目标hash校验、operation intent及run状态 | 原子文件替换、重读核验、结果事务；跨SQLite与文件系统不能宣称原子提交 |

主动删除按所选时间/对象范围传播；仍被其他有效来源引用的数据只保留其获准部分。类型化来源关系用于查出全部受影响消费者；关联记录保留ID/hash/删除状态供解释，不能让历史snapshot成为已删除轨迹正文的隐藏副本。删除范围内的任务输入、提取正文及报告快照内容一并清理或按有效剩余来源重新生成；Skill的通用格式规则可保留，但旧来源不可执行，用户须重新选择并确认有效来源。已在应用外写入的目标文档不自动删除或回滚，应用明确披露该边界。

到期判断同时在定时清理、启动/唤醒恢复和读图入口执行；睡眠导致定时器未运行也不能延长30天可见期。blob物理删除仅在最后有效引用消失后执行；物理文件清理晚于引用失效，不代表用户仍能访问。SQLite逻辑删除不等同SSD安全擦除，操作系统备份不属于应用的原子删除范围。

## 9. 约束验证清单

- 捕获图文配对与可见性失败、暂停/排除、处理超时均不留下确定事实或旧图补缺口；事件和图片去重不删短片段。
- 两个相同blob引用分别跨30天边界，旧引用不可复活，新引用有效；重复清理和文件删除失败不影响文字、周期、报告。
- A->B->A及跨gap续接的区间并集、主要归属唯一性和distinct instance计数正确；同名不同对象不强制合并。
- 任一模型/检测提交与撤销、来源删除、人工revision竞争时，generation和逐源revision双重检查拒绝陈旧结果。
- findings/state/cursor事务失败后重放不丢抑制状态、不重复候选；单次提示无需实例和Skill。
- 文档审核绑定、范围外字节、同日期去重、幂等apply、hash冲突、intent前后崩溃及写后恢复均有真实文件验证；applying/verifying时取消返回CANCEL_NOT_ALLOWED，且不妨碍核验/恢复。
- WAL/FTS5、迁移失败、磁盘满、worker退出及30天数据量下的日/月查询验证在安装包内执行；本文不替代[规格验收](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/spec.md)及两台Mac真机结果。
