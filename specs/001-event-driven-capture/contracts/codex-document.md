# Codex 与本地文档更新契约

**Status**: Phase 1 设计，尚未执行真实推理或文档写回验收。对应 [spec.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/spec.md) 的 FR-012/013/019、SC-016；技术依据见 [research.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/research.md) 的 R6/R7，领域关系见 [data-model.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/data-model.md)。本契约的接口经 main 的类型化 IPC 暴露；renderer、模型和检测 worker 均不能直接传文件路径或执行命令。

## 1. Provider 与兼容门槛

Codex 是默认且唯一可执行 provider。Claude 返回 `disabled`，入口可见且置灰为“暂未接入”；不得启动探测进程、模型调用或任务。摘要模型的后台文字授权与本契约逐次输入确认相互独立。

首版基线为本机已核对 help 的 `codex-cli 0.144.1`。其他版本必须重新通过兼容矩阵，不能按版本大小自动判定兼容。预检只读取 binary/version/help 和认证元状态，不读取、复制或向 renderer 返回凭证正文，不自动登录、安装或改全局配置。`authState` 为 `ready | missing | unknown`；不能确认时显示待验证，不能用摘要 API key 冒充 Codex 认证。

在发送任何业务材料前，受控合成 fixture 必须证明：参数受支持；只读限制有效；最终消息符合 schema；没有额外 MCP/Apps/插件/命令等外部工具启动；超时和取消有效。检测到外部工具启动或无法证明无启动时进入 `capability_blocked`，停止进程，禁止发送业务输入，不自动放宽权限。该验证是执行能力门槛，不是一次普通业务推理的副作用；首次验证使用无业务数据的材料，结果按 binary/version、平台和有效配置指纹保存，相关环境变化后失效。配置指纹不保存凭证或原文。

`--ignore-user-config` 只跳过 `$CODEX_HOME/config.toml`，认证仍使用 CODEX_HOME；它不证明系统/托管/项目配置、技能或 MCP 全部隔离。`--ignore-rules` 只针对 execpolicy `.rules`。`read-only` 约束模型执行的命令，不是所有文件读取、MCP、Apps 或模型鉴权流量的统一边界。cwd 和提示词都不是权限隔离。不得仅以 `features.unified_exec=false` 禁命令，也不得假设 `mcp_servers={}` 清空所有配置层。能力门槛不通过时保持阻断。

## 2. 进程与输入协议

main/utilityProcess 解析并固定获准 binary 的绝对路径，使用 `spawn(binaryPath, argv, { shell: false, cwd: runDir, ... })`。不拼 shell 字符串，不接受 renderer 提供的 executable、argv、env 或 cwd。下列是可读参数数组，`RUN_DIR` 和 `SCHEMA_PATH` 由 main 生成，不能作为 shell 命令执行：

```json
[
  "-a", "never", "exec",
  "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
  "--sandbox", "read-only", "--skip-git-repo-check",
  "--cd", "RUN_DIR", "--output-schema", "SCHEMA_PATH",
  "-c", "features.shell_tool=false",
  "-c", "features.apps=false",
  "-c", "features.hooks=false",
  "-c", "features.remote_plugin=false",
  "-c", "web_search=\"disabled\"",
  "-c", "project_doc_max_bytes=0",
  "-"
]
```

`runDir` 是应用受控的每次任务目录，置于项目检出之外，不含用户 `.codex`、AGENTS 或整库副本；该目录本身仍不构成沙箱。目录只含审核过的任务材料和固定 schema，不包含真实目标文件或路径、聊天全量记录、截图、数据库、用户目录或 auth 文件。清理目录不等于清理 CLI 全部日志；`--ephemeral` 仅承诺不保存 session rollout。保留最小必要进程环境，日志仅记录状态、耗时、大小、版本和错误码，不回显输入、JSONL 原文或凭证。

stdin 使用一次性、已冻结的 UTF-8 输入快照：固定任务指令、不可变 SkillVersion、用户选定来源的文字、目标章节及已批准的必要结构上下文、run/generation/hash/reference 绑定。业务文本作为不可信数据，不能变成 shell 参数、工具配置或额外指令。业务输入总量最多 2 MiB；超限要求缩小范围，不静默截断来源。写入 stdin 后关闭输入；不使用 resume，不在同一进程继续塞入未确认内容。

stdout 按 UTF-8 流增量解码并按行解析 JSONL：单行最多 4 MiB，累计 stdout 最多 16 MiB，stderr 最多 1 MiB；超限、坏 JSON 或不完整终止行均终止，错误为 `{code:"INTERNAL", detailCode:"INVALID_AGENT_OUTPUT"}`。未知非终态元数据事件可忽略；命令、文件变更、MCP、Apps 或其他工具活动事件一律视为能力违约而终止，不因先前预检通过而放行。JSONL 原文仅在有界内存中处理，不直接持久化到日志。

必须同时满足进程正常退出、成功 turn 终态、恰好一个最终 `agent_message` 中可解析的 Proposal、独立 schema/领域校验成功，才进入审核。exit 0、`turn.completed`、JSON 可解析各自都不足以证明成功；error、turn.failed、多个最终提案、工具事件或非 JSON 最终文本均失败。流中的 reasoning/进度不能作为提案或回执。将来事件结构变化先更新版本矩阵，不猜测最终消息字段。

从进程启动开始硬截止 120 秒。用户取消或超时后先使 generation 失效，再发送 SIGTERM，宽限 2 秒后终止仍存活的受控进程组；取消后到达的 stdout、退出回调及模型结果按 `runId + generation` 丢弃，不能恢复旧状态或进入 apply。`run.cancel` 幂等；`applying/verifying` 阶段不可强制中断文件事务，返回 `{code:"BUSY", detailCode:"CANCEL_NOT_ALLOWED"}` 并继续恢复/核验。

## 3. 接口与两次确认

下列输入均由 schema 验证，拒绝额外字段；所有 ID 是不透明引用。`skillVersionId` 是不可变 `skill_versions.id` 版本记录的 UUID 主键，不能传 `1.0.0` 等语义版本字符串；同一 Skill 的版本序号仍由 `UNIQUE(skillId,version)` 管理。runId、preparedRunId、targetId、operationId 为 UUID；generation 是大于零的安全整数；hash 是小写 SHA-256 hex。接口调用权限只授予已验证的应用窗口，不能仅信任 `confirmed: true` 字段。

| 接口 | 请求 | 返回与约束 |
| --- | --- | --- |
| `run.prepare` | `{provider:"codex", skillVersionId, targetId, sectionRef, sourceRefs, idempotencyKey}` | main 完整读取当前目标并解析范围，冻结输入后返回 `{preparedRunId, runId, generation, inputSnapshotHash, targetSnapshotHash, inputPreview, expiresAt, state:"awaiting_input_confirmation"}`；内部准备期间为 `preparing`，不启动业务模型进程 |
| `run.propose` | `{preparedRunId, expectedInputHash, confirmed:true, idempotencyKey}` | 输入审核页确认后调用，核对未过期快照、权限/来源/规则/目标及能力门槛；成功返回 `{runId, generation, state:"generating"}`，使用 prepare 已存字节而非重新拼接上下文 |
| `run.get` | `{runId}` | 返回当前状态、generation、可公开的故障码；审核态另返回 validated Proposal、main 算出的 proposalHash、diff、targetSnapshotHash、approvalRef 与 expiry；不返回真实路径/凭证/原始 stderr |
| `run.cancel` | `{runId, expectedGeneration}` | 仅 `preparing/awaiting_input_confirmation/generating/awaiting_review` 允许取消，失效 generation 及相关批准后返回 `canceled`；重复取消同一 generation 返回原结果，旧 generation 不得取消新的运行。`applying/verifying` 返回 `BUSY` 和 `detailCode:CANCEL_NOT_ALLOWED` |
| `run.apply` | `{runId, expectedGeneration, proposalHash, expectedTargetHash, inputSnapshotHash, skillVersionId, sourceRefs, approvalRef, confirmed:true, idempotencyKey}` | diff 审核页明确批准后调用；全部字段须与 main 保存的审核快照严格一致，sourceRefs 比较规范化 ID 集合；返回 `{operationId, runId, state:"applying"}` 或已存在的同一 operation 回执 |
| `run.exportPatch` | `{runId, expectedGeneration, proposalHash, idempotencyKey}` | 仅当前有效 awaiting_review 提案，重验绑定/来源后由 main 打开保存对话框导出完整差异；返回 `{exported, receiptId?}`，取消对话框为 exported:false。不接收任意路径；patch仅含必要显示名，不含私有绝对路径；不写目标、不创建apply operation、不改变为成功状态 |

prepare 与 apply 的确认分别代表“允许将这些文字发送给 Codex”和“允许按这份 diff 更新这份文件”，不能合并、默认勾选或由 worker 自动确认。更换来源、目标、规则、章节或任何输入字节必须重新 prepare 并确认。后台文字授权不替代这两次确认，接受 SOP 提示也不等于批准执行。

prepare/审核快照均在 15 分钟后失效，失效或冲突后重新生成并确认；期限内仍在 propose、apply 前复核来源及当前目标。`idempotencyKey` 按接口及资源作用域保存请求摘要；相同 key/相同请求返回原资源，相同 key/不同请求为 `{code:"CONFLICT", detailCode:"IDEMPOTENCY_CONFLICT"}`。重试不得创建新进程或重复写回。用户想重新运行已失败任务时应重新 prepare；旧输出不得复用为新 generation 的批准。

状态为 `preparing -> awaiting_input_confirmation -> generating -> awaiting_review -> applying -> verifying -> succeeded | no_change`。其他终态为 `failed | canceled | conflict | interrupted | capability_blocked | expired | source_invalidated`，按实际原因进入；`applying/verifying` 不允许取消或因审核快照自然到期停止文件事务，异常先按 operation 恢复，再到可证明的结果。生成中退出且无可信结果时为 `interrupted`，不得自动重发业务输入。`succeeded` 只在重读与业务校验成功后写入。相同日期内容已存在且无变更时可为 `no_change`，不得重复追加。截图自然到期不使仍保留的文字来源失效；用户主动删除来源则失效待执行任务、提案和批准。

## 4. Proposal 与批准绑定

机器契约为 [proposal.schema.json](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/proposal.schema.json)，JSON Schema draft 2020-12，顶层 `additionalProperties:false`。恰好包含以下八个字段：

```json
{
  "runId": "11111111-1111-4111-8111-111111111111",
  "generation": 1,
  "skillVersionId": "22222222-2222-4222-8222-222222222222",
  "inputSnapshotHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "targetSnapshotHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "sectionRef": "section:2026-10-15:worklog",
  "sourceRefs": ["33333333-3333-4333-8333-333333333333"],
  "replacementMarkdown": "## 2026-10-15\n\n- 完成日报格式核对。\n"
}
```

示例仅验证结构，不是已发生工作。本 schema 是标准领域契约，不宣称已经通过 Codex `--output-schema` 的结构化输出子集；正式启用前必须以该文件在固定 CLI/模型组合上运行无业务材料 fixture，拒绝 schema 或无法满足格式时返回 `CAPABILITY_BLOCKED`，不得把标准 JSON Schema 可解析等同于 CLI 支持。避免以未验证的关键字强制模型，来源唯一性交由 runtime 拒绝重复 ID；其余 schema 关键字同样属于实际兼容门槛，版本更新须重验。

schema 的字符串长度不等于 UTF-8 字节长度，运行时另验 replacement 和完整结果均不超过 2 MiB；来源 1–2000 个且唯一，不能包含快照以外的 ID。模型回填的 run、generation、SkillVersion、hash、sectionRef 必须与服务端冻结值相等；schema 通过不能替代来源存活、规则可执行及日期/格式/范围校验。`sectionRef` 只能引用 main 已解析并经用户确认的唯一字节区间，模型不能选择新位置。

`inputSnapshotHash` 是 main 已序列化并持久化的完整输入快照字节的 SHA-256；stdin 发送相同快照字节及固定绑定信封，hash 不递归包含自身。固定信封只携带 run/generation/hash/schema 协议和固定指令，不临时扩充业务材料。`targetSnapshotHash` 对当前完整文件原始字节计算，包含 BOM 和原换行。main 将校验后的 Proposal 按固定字段顺序序列化一次、存其原始字节并计算 proposalHash，所有后续批准和 apply 引用同一份存储字节，不对 renderer 提交的提案正文重新信任。

main 生成的一次性 approvalRef 绑定 proposalHash、目标 identity/hash、inputSnapshotHash、SkillVersion、sourceRefs 及来源有效性 revision、sectionRef、generation、expiry；renderer 不能扩大绑定范围。diff 从 main 保存的目标字节与候选结果生成，显示全部修改，不执行 Markdown HTML。确认后任何绑定变更均失效，必须展示新 diff 并重新批准，不能静默 rebase。

## 5. 本地 Markdown connector

目标由原生文件选择器注册成 targetId，路径仅 main 保存。先对原始选择路径 `lstat`，拒绝叶节点 symlink、目录及其他非普通文件，再 `realpath` 解析并记录规范路径、设备/文件 identity、size、mtime 等；祖先路径变化及目标替换在读取/apply 前重新核对，不能先 realpath 再宣称已检测原路径 symlink。注册不能把检测到的网页文档自动映射成同名本地文件。

首版只允许 `.md` / `.markdown`，完整文件最多 2 MiB，严格 UTF-8（可带 BOM）；无效编码、NUL、模糊重复标题、无法唯一定位的章节/日期块返回 `{code:"INVALID_ARGUMENT", detailCode:"UNSUPPORTED_FORMAT"}`。读取完整当前文档后，将用户确认的章节映射为原始字节区间 `[startByte,endByte)`，保存章节结构约束与原文。正文解析可以帮助定位，但不得重新序列化整个 Markdown。

Codex 仅输出替换章节。main 检查必需标题、日期唯一性、确认区域和格式规则，保留原 BOM、换行风格及非目标原始字节；混合换行且无法可靠保留时拒绝更新。新完整文件严格按 `originalBeforeBytes + replacementBytes + originalAfterBytes` 构造，非目标 bytes 必须逐字节一致。模型不得通过换标题、引入第二日期块或修改区间外语义绕过范围限制；不支持的结构请求人工选区或导出补丁。

本地更新要求用户确保目标在 One Room 中独占编辑。应用只保证自身同 target 串行，不能锁住外部编辑器；无法确认独占时只导出补丁，不调用写接口。常规 hash 检查与 rename 之间仍存在外部并发 TOCTOU，不宣称跨进程强 CAS。云 connector 后续必须具备条件版本更新，当前返回 `{code:"CAPABILITY_BLOCKED", detailCode:"CONNECTOR_UNAVAILABLE"}`。

## 6. 应用、核验与崩溃恢复

1. 在同 target 的串行锁内复核批准、generation、来源与规则，重新打开目标核对规范路径、文件身份及完整 beforeHash；不匹配为 `{code:"CONFLICT", detailCode:"TARGET_CONFLICT"}`，批准失效。
2. 生成候选完整字节、验证范围外字节/格式/日期，计算 afterHash。与 beforeHash 相同则记录 `no_change` 回执；不执行无意义重写。
3. 在 SQLite 提交 operation intent：operationId、idempotencyKey、run/generation、批准绑定、beforeHash、afterHash、目标 identity、候选字节引用及状态。intent 未持久化不得开始 rename。
4. 在目标同目录以排他创建临时文件，写完整候选、保留目标权限、fsync，rename 前再次核对目标身份/hash；失败清理临时文件并保留原文。rename 后 fsync 目录，不能把单纯 write 完成当持久化完成。
5. 重读目标，核对 afterHash、非目标字节、标题/日期与来源有效性；成功提交回执才为 `succeeded`。若写后收到来源删除，记录实际文件应用事实及 `source_invalidated`，禁止后续复用，不伪造未发生写入或自动回滚。
6. 启动恢复时逐条检查未完成 intent：仍为 `applying/verifying` 的任务，当前 afterHash 匹配则补核验/回执，不再次写；beforeHash 匹配则以 `interrupted` 结束该尝试，允许用户显式重试并重新 prepare/确认，旧 operation 幂等记录仍保留；其他值为 `conflict`。已结束的旧尝试不得静默恢复为新生成。临时文件/候选仅按对应 intent 清理，不删除用户文件。

意外退出、目录 fsync 失败或写后校验失败不能盲目回滚，因为文件可能已被外部更新。保留 operation 实际阶段、before/after/observed hash 和有限诊断码，让用户查看差异。取消仅阻断尚未开始的 apply；已经进入文件事务必须完成上述恢复判断。

所有错误遵循全局 `{code, detailCode?, message, retryable}` 结构；`code` 只能是 `INVALID_ARGUMENT | NOT_FOUND | STALE_REVISION | PERMISSION_DENIED | CONSENT_REQUIRED | SOURCE_INVALIDATED | CAPABILITY_BLOCKED | CONFLICT | AUTH_REQUIRED | TIMEOUT | CANCELED | BUSY | INTERNAL`。细分原因放可选 detailCode，不扩大全局 code 枚举，也不把错误码直接当 run 状态。

| 全局 code | 本契约可选 detailCode 示例 |
| --- | --- |
| `INVALID_ARGUMENT` | `INPUT_TOO_LARGE`, `UNSUPPORTED_FORMAT` |
| `NOT_FOUND` | `RUN_NOT_FOUND`, `TARGET_NOT_FOUND`, `SKILL_VERSION_NOT_FOUND` |
| `STALE_REVISION` | `INPUT_EXPIRED`, `INPUT_CHANGED`, `GENERATION_MISMATCH` |
| `PERMISSION_DENIED` / `CONSENT_REQUIRED` | `WINDOW_NOT_AUTHORIZED` / `INPUT_CONFIRMATION_REQUIRED`, `APPLY_CONFIRMATION_REQUIRED` |
| `SOURCE_INVALIDATED` | `SOURCE_DELETED` |
| `CAPABILITY_BLOCKED` | `PROVIDER_DISABLED`, `AGENT_NOT_INSTALLED`, `SCHEMA_UNSUPPORTED`, `EXTERNAL_TOOL_STARTED`, `CONNECTOR_UNAVAILABLE` |
| `CONFLICT` | `TARGET_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `APPROVAL_MISMATCH` |
| `AUTH_REQUIRED` / `TIMEOUT` / `CANCELED` | `AGENT_AUTH_REQUIRED` / `AGENT_TIMEOUT` / `USER_CANCELED` |
| `BUSY` | `CANCEL_NOT_ALLOWED`, `TARGET_BUSY` |
| `INTERNAL` | `INVALID_AGENT_OUTPUT`, `WRITE_FAILED`, `VERIFY_FAILED` |

错误文案可读，诊断不携带原文。配券/策略只沉淀规则、参数与审批点并预览，不可经本接口发出真实发券/投放请求。

## 7. 契约验收

合成 adapter fixture 覆盖版本/参数不兼容、额外工具启动、坏/过大/截断 JSONL、退出 0 无提案、多个最终提案、schema 合法但绑定不符、取消与 120 秒截止/2 秒宽限、旧 generation 迟到。额外工具启动测试使用无业务数据，断言未发送业务 stdin。

connector 使用临时 Markdown fixture 覆盖日报/周报/普通文档、中文/UTF-8 BOM/CRLF、原路径 symlink、重复标题/日期、2 MiB 限制、非目标 bytes 不变、确认后修改、同 key 重试、同 target 并发、rename 前/后崩溃及 afterHash 回执恢复。真实 Codex 的三类文档复用、取消/认证与文件权限另按 [quickstart.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/quickstart.md) 和 SC-016 验收；本文件不能替代这些结果。
