# 桌面 IPC 契约

状态：设计待实现。Electron renderer 通过 preload 暴露的 `window.oneRoom` 访问下列领域方法；不暴露原始 ipcRenderer、SQL、FS、进程或凭证。数据及状态依据 [data-model.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/data-model.md)，执行接口细节依据 [codex-document.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/codex-document.md)。

## 1. 信封、身份与失败

```ts
type Request<T> = { requestId: string; payload: T };
type Reply<T> =
  | { requestId: string; ok: true; data: T; dataRevision: number }
  | { requestId: string; ok: false; error: {
      code: ErrorCode; detailCode?: string; message: string; retryable: boolean
    } };
type ErrorCode =
  | 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'STALE_REVISION'
  | 'PERMISSION_DENIED' | 'CONSENT_REQUIRED' | 'SOURCE_INVALIDATED'
  | 'CAPABILITY_BLOCKED' | 'CONFLICT' | 'AUTH_REQUIRED'
  | 'TIMEOUT' | 'CANCELED' | 'BUSY' | 'INTERNAL';
```

main 校验可信 WebContents、主 frame、固定本地 origin、方法白名单及完整 payload schema，拒绝额外字段。设置 `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`；新窗口/导航默认拒绝，外链需用户动作并经 URL 白名单校验。页面 CSP 禁止远程脚本；Markdown 禁止执行 HTML。确认页必须属于同一可信窗口，不能仅凭 `confirmed:true` 认定授权。

实体 ID 为 UUID，workerId/ruleId、sectionRef 和其他明确的不透明协议标识采用各自格式；时间为 UTC epoch ms，revision/generation 为正安全整数。`requestId` 只追踪请求，不充当幂等键。可编辑实体的变更命令带 `expectedRevision`；同资源旧 revision 返回 STALE_REVISION 与可重新读取的资源 ID，不静默覆盖。run 命令使用 Codex 契约中完整的 hash/generation/approval 绑定，不能额外要求其未定义的 expectedRevision。创建任务/应用等带 `idempotencyKey`，同 key/同 payload 返回原结果，异 payload 返回 `CONFLICT/IDEMPOTENCY_CONFLICT`。路径、正文和 CLI stderr 不进入错误消息或日志。

斜线写法表示 `code/detailCode`，不是第二套错误枚举。例如目标变更 `CONFLICT/TARGET_CONFLICT`，无效 Agent 结果 `INTERNAL/INVALID_AGENT_OUTPUT`，未安装 `CAPABILITY_BLOCKED/AGENT_NOT_INSTALLED`，Claude 禁用 `CAPABILITY_BLOCKED/PROVIDER_DISABLED`，格式不支持 `INVALID_ARGUMENT/UNSUPPORTED_FORMAT`，取消文件事务 `BUSY/CANCEL_NOT_ALLOWED`。详细映射见执行契约；Native/worker 内部诊断经 main 映射后才进入 IPC。未知异常为 `INTERNAL`，内部阶段单独记录，不能假定可重试。

## 2. 状态、权限与数据生命周期

| 方法 | payload | data 与约束 |
| --- | --- | --- |
| `app.getStatus` | `{}` | app/schema 版本、采集状态、最近成功时间、队列、存储/worker/Agent 能力；无正文和路径 |
| `permissions.get` | `{}` | screen/accessibility/inputMonitoring 的 `unknown|not_determined|granted|denied|restricted|not_required`、实际负责进程及降级说明 |
| `permissions.openSettings` | `{kind}` | 打开对应系统设置页的结果；不伪造授权完成，随后重新检测 |
| `capture.pause` / `capture.resume` | `{expectedRevision}` | 当前采集状态/revision；pause 提升 captureGeneration、关闭事实区间并建 gap；resume 重新核对前台/权限 |
| `settings.get` | `{}` | 允许/排除应用、文字分析开关/范围、授权 revision、截图保留天数 30；不返回 Key |
| `settings.updateCaptureScope` | `{expectedRevision, allowedBundleIds, excludedBundleIds}` | 冲突时排除优先，收窄立即失效对应采集任务；不能扩大既有后台模型授权 |
| `settings.updateTextConsent` | `{expectedRevision, enabled, allowedBundleIds, confirmed}` | 单独可见的文字发送授权，默认 off，跨重启持久；撤销/缩小范围取消未发送任务并丢弃迟到结果 |
| `history.previewDelete` | `{rangeStart, rangeEnd, bundleIds?}` | 先持久暂停采集并收敛提取/模型队列，再返回有期限的 deletionRef、观察/周期/报告数量；此时无删除，预览后保持暂停直到用户恢复 |
| `history.delete` | `{deletionRef, expectedRevision, confirmed:true, idempotencyKey}` | 提交来源失效及内容清理任务，返回 cleanup 状态；旧 UI/受控证据访问立即被拒绝 |

开启模型发送必须在设置页展示文字范围并由用户操作，系统录屏/AX 权限不能代替该确认。截图自然到期由本地清理任务执行，不调用 history.delete；仅图片 evidence 失效，文字/周期/时间分配/报告保留。主动删除按照预览范围清理派生正文、快照、搜索和缓存；不可变版本也不能藏有可恢复的已删正文。已实际写入的用户目标文件不自动回滚，显示实际回执并禁止继续复用失效来源。

### 模型配置与凭证（T064，规划接口）

本地AX/UI树和Apple Vision OCR不需要API Key/Secret；以下配置仅用于T021的后台文字模型。首版为OpenAI兼容文字接口，配置页、服务与安全存储由A负责；与本机Codex CLI的安装/认证分开，不将摘要Key当Codex登录。新增契约不表示接口已实现。

```ts
type ModelSettings = {
  revision: number;
  baseUrl: string; // not configured: ""
  model: string;   // not configured: ""
  hasCredential: boolean;
  encryptionAvailable: boolean;
  lastTest: null | {
    status: 'never' | 'passed' | 'failed';
    testedAt: number;
    latencyMs: number;
    reason: string | null;
  };
};
```

| 方法 | payload | data 与约束 |
| --- | --- | --- |
| `model.getConfig` | `{}` | `ModelSettings`；只返回hasCredential，不返回Key、密文或安全存储引用 |
| `model.saveConfig` | `{expectedRevision, baseUrl, model, apiKey?}` | 更新后的`ModelSettings`；省略apiKey保留原凭证，删除走独立接口；地址不含内嵌凭证；安全加密不可用时明确失败，不落盘明文 |
| `model.clearCredential` | `{expectedRevision}` | 更新后的`ModelSettings`，hasCredential=false，旧测试状态失效；清除不自动扩大/重置文字授权，模型调度须重新校验配置 |
| `model.testConnection` | `{expectedRevision}` | `{settings:ModelSettings, ok:boolean, latencyMs:number, message:string}`；只测试已保存的对应revision，用户显式触发、有截止时间，仅发送固定合成文字，不发轨迹/截图/文档 |

配置元数据保存在应用私有目录，凭证通过Electron safeStorage所接入的系统安全能力加密，读取/解密只发生在main或受控服务。用户输入的Key仅通过保存动作交给main，不进入日志、SQLite明文字段、错误、fixture或任务材料。字段及错误均做完整schema校验，测试错误只返回脱敏原因，不返回服务原文。

保存/清除提升配置revision；派发与提交同时检查配置、独立文字授权与来源。旧revision的测试或模型结果不能覆盖新配置状态。连接测试成功只说明合成文字通路可用，不开启`settings.updateTextConsent`，不批准任何Codex输入，不证明OCR/AX准确性。其它需要Key+Secret的认证协议须有明确provider adapter，不能把额外Secret拼入URL或沿用未定义字段。

## 3. 时间导航与查询

查询 `rangeStart < rangeEnd`；一次不超过 31 个本地日。分页 `limit` 默认 100、上限 500，cursor 不透明且绑定查询参数、排序及 dataRevision；快照已失效返回 `STALE_REVISION/QUERY_SNAPSHOT_CHANGED`，客户端重查。游标请求的 queryRevision 就是最近 timeline.query 返回的 dataRevision，并传递同一组完整 bundleIds/query；main 在该 revision 重算筛选及证据归属，不把 revision 当作筛选参数本身。按 `(startTs,id)` 稳定排序，文本搜索另返回受限匹配段。读取不因截图到期而遗漏周期。

| 方法 | payload | data 与约束 |
| --- | --- | --- |
| `timeline.query` | `{rangeStart, rangeEnd, bundleIds?, query?, cursor?, limit?}` | 周期页、gap、覆盖区间、筛选后的区间并集时长、nextCursor、dataRevision、recordingRange |
| `timeline.resolveCursor` | `{cursorTs, queryRevision, bundleIds?, query?}` | `cursorTs, period?, observation?, evidence?, label, gap?, dataRevision`；与时间线使用同一完整筛选，不允许跨 gap/排除/筛选借图 |
| `calendar.query` | `{month:"YYYY-MM", bundleIds?, query?, cursor?, limit?}` | 按本地日分组的同源周期摘要页、覆盖及报告引用；继续分页补全密集日，不加载整月图片 |
| `period.get` | `{periodId}` | 事实区间、摘要状态、对象/主题、basis、来源引用及人工修订 |
| `period.correct` | `{periodId, expectedRevision, objectLabel?, topic?, activityType?, reason}` | 新 revision/人工锁；不改源观察或用模型重写事实时间 |
| `activity.correct` | `{activityEventId, expectedRevision, action, objectHints, reason}` | 新 revision、来源及待重算状态；允许确认疑似行为，不凭正文变化自动确认保存 |
| `instance.get` | `{instanceId}` | 实例、片段关联/修订、区间并集时长及身份/完成依据 |
| `instance.reassociate` | `{instanceIds, expectedRevisions, assignments, reason, idempotencyKey}` | 人工续接/合并/拆分后的实例/关联 revision；校验每段至多一个主要归属，原子重算并通知检测 |
| `search.query` | `{rangeStart, rangeEnd, text, bundleIds?, cursor?, limit?}` | 文字/标题/摘要匹配与来源状态；中文 trigram，短查询受限 LIKE，不泄露已删内容 |

`resolveCursor` 的 evidence 为 `{evidenceId,status,observedAt,displayUntil,requestToken}`，状态 `available|expired|deleted|missing|none`。displayUntil 仅到已确认覆盖边界；图片是 observedAt 的证据，不能宣称像素恰好发生于任意 cursorTs。main 返回受控 `one-room-evidence:` URL 或等价句柄，按调用窗口、evidence ID 与当前生命周期每次校验；不暴露文件路径。renderer 在游标变化时先清旧图，载入结果还须匹配本次 requestToken、选择和 revision；删除通知也须清理已解码缓存。

筛选是临时查询条件，时长按筛选后的真实区间重算。缺口和被筛掉的时段保留真实时间位置，不挤压成连续工作。所有日/月查询固定 Asia/Shanghai、周一周首；完整日报/周报不会暗中沿用软件/搜索筛选。

`recordingRange: {rangeStart,rangeEnd}|null` 为同一事务读取的全局未删除录制边界，与本页范围、软件/文字筛选无关；仅以 capture_events 的已知时间确定，不把开放尾部或暂停补至现在。原图到期保留该边界，主动删除重算；无观察为 null。渲染器按游标附近范围预载，日期投影不限制连续轨道的跨日平移。

## 4. 报告、发现、Skill 与目标

| 方法 | payload | data 与约束 |
| --- | --- | --- |
| `report.get` | `{kind:"daily"|"weekly", dateKey}` | 完整日/该周的报告、覆盖、sourceRevision；不存在返回 `status:"absent"` 与生成/配置动作 |
| `report.generate` | `{kind, dateKey, expectedDataRevision, idempotencyKey}` | reportId/jobId；固定全日/全周来源，无模型授权可生成事实型日志，推断主题保持未知 |
| `discovery.list` / `discovery.get` | `{status?, cursor?, limit?}` / `{discoveryId}` | 已提交提示、worker/rule/version、证据/实例、basis、待确认项及可用动作 |
| `discovery.act` | `{discoveryId, expectedRevision, action, snoozedUntil?, idempotencyKey}` | `review|review_skill|dismiss|snooze|restore`；review 打开确认流程，review_skill 进入关联草稿/版本；默认稍后 24h |
| `worker.list` | `{}` | 各 ruleId 启停/等待授权/故障/积压/版本与最后成功；一个规则故障不隐藏其他规则 |
| `worker.setEnabled` | `{workerId, ruleId, expectedRevision, enabled}` | 提升规则 generation、取消在途提交；重启保留状态和抑制 |
| `skill.get` / `skill.list` | `{skillId}` / `{cursor?,limit?}` | 草稿、就绪状态及不可变版本索引；失效来源明确标记 |
| `skill.saveDraft` | `{skillId?, expectedRevision?, draft, idempotencyKey}` | schema 校验的草稿；未确认对象/实例/范围不得 ready |
| `skill.publishVersion` | `{skillId, expectedRevision, confirmations, idempotencyKey}` | 创建不可变 `skillVersionId` UUID 与业务 version；不批准执行，配券/策略仅预览/导出 |
| `skill.export` | `{skillVersionId}` | 主进程保存对话框，导出选定版本与来源说明；不接受任意目标路径 |
| `target.pickLocalMarkdown` | `{}` | 用户系统文件选择后返回 targetId、displayName、revision、支持状态；取消返回 `selected:false` |
| `target.inspect` | `{targetId}` | 现文允许范围预览、targetSnapshotHash、可唯一定位的 sectionRefs、格式问题和可写模式；路径仅 main 持有 |
| `target.confirmExclusiveEditing` | `{targetId, expectedRevision, confirmed:true}` | 记录本次独占编辑声明；本地 hash/rename 无跨进程强 CAS，无法独占时只导出补丁 |

worker 状态统一 `idle|running|waiting_authorization|failed|disabled|interrupted`。提示生命周期 `open|snoozed|dismissed|accepted|invalidated`；文档重复/SOP 类接受后在确认页调用保存草稿流程，保留 discovery/instance/source 关联；通用单次提醒按注册 kind 的白名单动作处理，不强制生成 Skill。接受不是执行许可。发现无需 targetId，执行文档 Skill 则必须确认本地目标。日报/周报报告引用与 SOP 的目标引用分开保存。

## 5. Agent 与执行

`agent.getStatus({})` 返回 Codex binary/version、认证、能力预检与故障；Claude 恒为 `enabled:false, reason:"not_integrated"`。`agent.check({provider:"codex"})` 只执行版本/认证只读检测；T047由A实现连接状态UI，分别展示未安装/版本不支持/未认证/待能力验证/能力受阻/可用及手动重新检查入口。运行合成能力测试有独立测试入口和结果，不能在状态刷新时隐式发送业务材料或触发登录，不复制auth。普通连接检查不等于T048的G4通过。

`run.prepare/propose/get/cancel/apply/exportPatch` 的全部输入、批准和幂等规则以 [Codex 契约](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/codex-document.md) 为唯一完整定义，使用本文件 Reply 信封。exportPatch 只导出已验证差异，不修改目标或将任务标为应用成功。统一状态：

```text
preparing -> awaiting_input_confirmation -> generating -> awaiting_review
          -> applying -> verifying -> succeeded | no_change
terminal: failed | canceled | conflict | interrupted | capability_blocked
          | expired | source_invalidated
```

`run.cancel` 带 expectedGeneration；applying/verifying 返回 `BUSY/CANCEL_NOT_ALLOWED` 并继续核验或恢复，不把已开始的文件事务标成无写入。生成/审核期可取消，失效 generation 后拒收迟到输出。重启不自动启动 Codex 或重放写入；操作 intent 按 before/after hash 恢复。成功仅在重读核验后显示。

## 6. 订阅与恢复

`events.subscribe({afterSequence?})` 返回订阅句柄及 `streamId,sequence`，preload 仅暴露取消订阅函数。事件 `{streamId,sequence,type,entityId,revision,runId?,generation?}` 不携带正文，type 白名单为 `capture.status|permissions.changed|settings.changed|timeline.changed|source.invalidated|evidence.expired|discovery.changed|worker.changed|skill.changed|run.changed|report.changed|storage.failed`。

sequence 只在本次 stream 内递增；renderer 丢弃旧 stream/旧 revision，发现跳号或缓冲已淘汰收到 resetRequired 后重新 get/query。订阅不是持久队列，也不代替数据库 worker 的 domain_changes 游标。窗口重新加载/进程重启先获取状态及新 stream，再做快照查询并重放快照后的通知；有竞态时重新查询。事件大小受限，不因 UI 未消费阻塞采集；只合并失效通知，不丢领域事实。

契约验证目标覆盖额外字段/不可信 sender/任意路径、revision 与幂等冲突、分页失效、迟到图片、授权撤销、截图到期与主动删除、失效 stream 恢复，以及所有 run 故障分支。当前已接入设置/权限/采集、模型配置、活动校正、时间线/游标/月历、持久报告和主动删除；周期增加可选action及not_configured状态。原生swipe走独立gestures.subscribe通道，不推进dataRevision；P1 run尚未接入。已执行检查与完整验收分列于docs/acceptance/。
