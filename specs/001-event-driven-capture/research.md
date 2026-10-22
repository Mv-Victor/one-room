# One Room 最小外部借鉴方案

调研日期：2026-10-15。关联 [功能规格](spec.md)、[摘录](code-excerpts.md)、[来源锁定](source-lock.json)。原调研交付为规格与可审查的源码依据；当时尚未实现产品采集器。

当前实施决策（2026-10-15）：用户已明确允许为本项目私有使用直接复制和适配 MemoryLane 开源代码。保留固定版本、来源、实际改动与 GPL 原文即可在已授权范围内继续实施，不需要额外许可审批。该决策覆盖早期“仅作架构参考、不引入 GPL 产品源码”的限制。当前已适配 MemoryLane 的 AX 窗口定位、原生监听/PNG/OCR、子进程通信和安全凭据小块，以及 Screenpipe 的日期导航、图片加载/布局、平滑过渡和连续分组小块；具体范围见 [第三方声明](../../THIRD_PARTY_NOTICES.md)。源码迁入不等于对应产品故事已通过验收，其余候选仍按 One Room 契约逐模块接入。

## 1. 结论与版本

采用 MemoryLane 式 Electron + React/TypeScript 主体，macOS 能力收进小型 Swift helper；借鉴 Screenpipe 的事件触发、无障碍正文优先、OCR 补充及 Rewind 时间线交互。无需 Rust，也不同时运行两个参考项目。项目仍是独立 One Room 工程。

产品顺序以当前spec为准：P0首先让时间分配一目了然，包含游标标注、显著切换后的周期总结和自动日/月回顾；P1为日报/周报/普通文档SOP发现与Codex复用，P2为配券/策略SOP。调研和采集架构为这些体验提供依据，不代替业务场景验收。

| 来源 | 固定发布与提交 | 许可与采用范围 |
| --- | --- | --- |
| [Screenpipe v2.2.243](https://github.com/screenpipe/screenpipe/releases/tag/v2.2.243) | `1b3e4186ec5a624b95a581c7187c1d48284bea9a`，2026-03-23 | 根目录 MIT，`ee/` 例外；本次选定文件均不在 `ee/`，保留原文摘录与完整声明 |
| [MemoryLane v1.5.10](https://github.com/deusXmachina-dev/memorylane/releases/tag/v1.5.10) | `f3157d54524e647d32f7decd186ee00cac9f72d5`，2026-09-30 | GPL-3.0-or-later；用户已授权私有使用直接适配，保留来源与 GPL 原文；实际迁入范围见第三方声明 |

两个版本均核对了发布页面、标签提交和本地源码。选择的是有发布记录、无 alpha 名称的固定候选，不代表已经证明在 One Room 场景稳定。当前 Screenpipe 主线及其他新版的商业许可不能被这个历史 MIT 许可覆盖；后续复制新修复须重新核验。

此前较早版本不足以支撑同样结论：Screenpipe v0.3.151 的部分事件驱动描述仍在设计文档中。本方案依据 v2.2.243 的实际代码，不把设计草案当作已实现功能。

MemoryLane 在所选版本的 macOS 构建路径使用 Swift；Rust 属于其 Windows 路径。直接适配其 macOS 实现并不要求团队掌握 Rust。早期调研选择仅分析架构；当前按用户已授权的私有使用范围复用适合的小块，继续保留 GPL-3.0-or-later 标识、完整许可和改动记录。

## 2. Screenpipe：最小可借鉴部分

以下链接全部锁定同一个提交；文件内容 SHA256 见 source-lock.json。

| 能力与源码 | 已存在的实现 | One Room 采用方式 |
| --- | --- | --- |
| [event_driven_capture.rs](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/crates/screenpipe-engine/src/event_driven_capture.rs#L30) | AppSwitch、WindowFocus、Click、TypingPause、ScrollStop、Clipboard、VisualChange、Idle、Manual 触发；配置默认值见 L94–107 | 摘录策略依据，调度器用 TS 实现；不引入 Rust crate。只取输入时序元数据，不取字符或剪贴板正文 |
| [paired_capture.rs](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/crates/screenpipe-engine/src/paired_capture.rs#L125) | 无 AX 正文、偏好 OCR 或正文过薄时 OCR；支持 accessibility/ocr/hybrid 来源 | 摘录判定依据；在 Swift/TS 适配，保留两条文本来源、状态与回退原因 |
| [tree/mod.rs](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/crates/screenpipe-a11y/src/tree/mod.rs) 与 [tree/macos.rs](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/crates/screenpipe-a11y/src/tree/macos.rs) | 聚焦窗口 AX 树、遍历限额、跳过安全角色 | Swift helper 适配候选，引用 MIT 来源；仅遍历获准的当前窗口，不把隐藏历史节点当可见正文 |
| [timeline.tsx](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/apps/screenpipe-app-tauri/components/rewind/timeline/timeline.tsx) 与 [timeline-controls.tsx](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/apps/screenpipe-app-tauri/components/rewind/timeline/timeline-controls.tsx) | 画面主视图、回放控制、底部轨道、范围选择及 AI 面板 | 采用体验结构，复用独立 React 逻辑需逐项拆依赖；不移植整个 Tauri/Next 页面 |
| [use-scroll-zoom.ts](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/apps/screenpipe-app-tauri/components/rewind/hooks/use-scroll-zoom.ts) | wheel 缩放、平滑更新、播放暂停配合 | TS 适配候选，事件限制在轨道范围，保留显式按钮和日/月定位 |
| [use-frame-loading.ts](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/apps/screenpipe-app-tauri/components/rewind/hooks/use-frame-loading.ts#L314) | 快照预加载、取消失效请求、加载状态 | 已摘录局部依据；替换 Tauri asset URL，进入 gap 必须清图 |
| [agents/mod.rs](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/crates/screenpipe-core/src/agents/mod.rs) 与 [connections-section.tsx](https://github.com/screenpipe/screenpipe/blob/1b3e4186ec5a624b95a581c7187c1d48284bea9a/apps/screenpipe-app-tauri/components/settings/connections-section.tsx) | executor 抽象、Pi 实现、Claude 连接配置等 | 参考任务状态及连接体验；Codex CLI adapter 按本项目契约独立实现 |

### 事件驱动不是完全没有轮询

所选实现的 `poll_activity`（L154–179）检查输入活动与空闲，主循环约 50ms；另有每 3 秒的视觉检查，用于发现无用户输入的画面变化。默认最小截图间隔 200ms、输入停顿 500ms、滚动停止 300ms、空闲检查点 30 秒。这些只是上游参数，不是已验收的 One Room 默认值。

One Room 保留“事件安排观察 + 变化合并 + 低频补采”组合。NSWorkspace/AXObserver 提供上下文事件，输入监听只提供点击、滚动、输入停顿的时序。权限不足要标降级；频繁事件进入有界队列，合并重复请求但不抹掉对象切换。队列溢出或采集失联产生 gap。

上游仍存在顺序等待截图与提取的路径，不能由其事件架构推导出全流程非阻塞。One Room 先提交截图和观察事实，再异步提取正文、OCR、摘要；摘要失败不影响证据留存。

### 无障碍优先需要判断正文是否可用

`paired_capture.rs` 的 `a11y_content_is_thin`（L424 起）结合应用/URL/标题及内容角色文本占比；只有工具栏文字也会触发 OCR 补充。混合来源应保留各自文本，避免拼接后失去来源。该启发式不能保证 Kim 或内部网页正文完整，必须用真机样例校准。

树配置提供深度 30、节点 5000、目标超时 250ms、单元素 200ms 等限制；同步系统 IPC 会影响实际耗时，不能宣称严格全局硬截止。helper 需可被主进程超时终止并报告 partial/timeout。

排除、安全角色、锁屏与技术失败分开处理：排除必须停止，不允许 OCR 绕过；技术失败而截图获准才能回退。上游可截显示器的路径不照搬，One Room 只截匹配的获准前台窗口，失败不回退全屏。截图与 AX 不是操作系统原子快照，需要前后核对 pid/windowId/generation，切换时舍弃或标不确定。

### 时间线与 Agent 的适配边界

Screenpipe 页面依赖 Tauri、Next、设置 store、localhost:3030、遥测及视频/音频逻辑。One Room 用 Electron 受限 IPC 和 evidence ID 协议替换它们。轨道按真实时长映射，不能直接沿用固定帧宽/帧索引作为时间比例。上游为减少闪烁会暂留旧图；本项目进入 gap、已删除证据或新日期时必须清除当前证据或明确标旧图，不能让其冒充当前时刻。

2026-10-15 第二轮澄清，用户指定短切换参考 Screenpipe。核对上述固定版本的 `timeline/timeline.tsx`：L619–706 按连续应用和日期分组，非空组即保留，没有最短秒数过滤；因此已采到的 A→B→A 不会因 B 短暂就合成一组。L946–948 的组宽依赖帧数与帧宽，L1375 仅在组宽超过 30px 时展示组图标，但 L1493 起仍逐帧绘制，L1572 起可交互查看；这里的 30 是像素，不是 30 秒。L1339–1340 的 `showLabel`/`showFullLabel` 仅声明未使用，不能据此宣称文字按该阈值显示。

One Room 沿用“保留已采片段、窄处精简标注、选中/悬停可查”的行为，不新增 30 秒折叠合并规则；月格仍按时序列出各片段，当前游标仍显示完整标签。按真实时长绘制、同应用对象/主题边界、未知不沿用前应用、缺口隔离及显著切换后的周期总结继续按本项目规格增强。上游这段分组/绘制代码未触发每次切换的 AI 总结，不把它当作 One Room 总结能力的现成实现；摘要任务可批处理，但结果须关联各自周期与来源。帧已采到才谈保留，不能由 UI 无最短时长过滤推导出所有瞬时切换均已捕获。

选定版本 `agents/mod.rs` 实际只导出 `pub mod pi;`。Pi 可选择 `openai-codex-responses` 是模型供应商接入，不等于运行本机 `codex exec`。Claude Desktop MCP 配置、Claude Code 的 MCP 安装指令，也不等于独立 CLI 执行器。三者必须分清：模型供应商负责推理、MCP 暴露上下文、CLI adapter 负责进程执行。

本项目首版仍只接本机 Codex：固定参数数组、shell=false、受限任务目录、只读生成结构化 Proposal、人工看 diff、DocumentConnector 应用并核验。CLI 参数以安装版本和官方文档验证；不搬 Pi，不复制认证文件，不修改全局 MCP。Claude 只留禁用入口。可复用的是“选择证据 → 展示来源 → 任务状态 → 审核结果”的体验。

## 3. MemoryLane：结构参考与必须调整之处

以下文件均在 [v1.5.10 固定源码](https://github.com/deusXmachina-dev/memorylane/tree/f3157d54524e647d32f7decd186ee00cac9f72d5) 下，完整文件清单及哈希见 source-lock.json。适合的小块可按当前授权直接适配；现有 code-excerpts.md 仍是原来的三段 MIT 研究摘录，实际产品迁入另记第三方声明。

| 文件（相对仓库根目录） | 借鉴依据 | 本项目调整 |
| --- | --- | --- |
| `src/main/recorder/native-screenshot.ts` | Node 子进程管理、JSONL 帧元数据、重启/停止 | 已适配 L123–172 的进程通信生命周期到 helper-client.ts，当前仅握手/关闭；后续补有界重启与迟到结果处理 |
| `src/main/recorder/swift/app-watcher.swift` | NSWorkspace 激活、AXObserver 聚焦窗口/标题通知及初始前台事件 | 已适配 L22–79 的 AX 聚焦窗口/几何函数到 WindowContext.swift，L285–465 的通知/观察器生命周期到 WindowListener.swift；回调只通知获准上下文变化，标题不等于稳定文档身份 |
| `src/main/recorder/swift/screenshot.swift` | ScreenCaptureKit 原生截图路径 | 已适配 L87–115 的 PNG 编码到 WindowCapture.swift；按获准窗口单次截图，补前后身份/可见性核对与 token staging，不沿用周期全屏路径 |
| `src/main/processor/swift/ocr.swift` | 小型 Vision OCR 工具即可服务 TS | 已适配 L28–54 的 Vision 请求/结果到 VisionOCR.swift；中文/英文 accurate、原图 token、文字限额及结构化状态，未以迁入代替真实 OCR 准确性验证 |
| `src/main/settings/vendor-credentials-manager.ts` | 注入 safeStorage、base64 密文落盘及解密 | 已适配 L8–12、L123–133、L263–277 到 src/services/model/config-store.ts；只保留单端点，不保留迁移、环境 Key、明文缓存和日志；补版本检查、私有权限与原子替换 |
| `src/main/activity/pipeline-harness.ts` | frame/event/activity 分层与 producer/extractor/sink 生命周期 | 内存缓冲不具崩溃持久性；先落截图和事实，后做语义任务 |
| `src/main/activity/event-capturer.ts` | 迟到事件容忍、排序、flush | 保留有界重排、退出 flush；缺失要明确记录 |
| `src/main/activity/activity-producer.ts` | 根据上下文对齐 frame，修剪越过应用切换的帧 | 不复制少于 3 秒直接丢弃策略；保留 One Room 短活动及切换证据 |
| `src/main/activity/activity-transformer.ts` | OCR、语义提取、持久化的阶段划分 | 上游可仅选一个靠后的帧 OCR，并在语义处理后持久化；改为事实先存、各变化帧按需提取，模型失败不阻塞 |
| `src/main/services/task-miner/run-detection.ts` | 从活动引用形成候选、去重与事务 | 只取状态与引用关系，采用同一文档两次独立更新门槛，不引向量发现引擎 |
| `src/shared/constants.ts` | 集中参数便于测试 | 不照搬 1 秒截图、最短 3 秒活动、200 活动检测门槛；按 One Room 实测定值 |
| `scripts/build-swift.sh` | 三个 Swift 可执行程序的简单编译路径 | 最终 helper 随签名安装包提供，不要求用户安装 Xcode |

上游处理完成后清截图的生命周期不符合 One Room 持续回看目标；debug retainScreenshots 也不等于有保留期和删除传播的产品机制。按 2026-10-15 澄清，截图保留 30 天，到期仅删截图；提取文字、周期摘要、时间分配和报告继续保留，候选与 Skill 持来源引用并区分图片过期与文字可用。无需音频、FFmpeg、向量库、云同步或额外 Screenpipe 服务。

## 4. 最小模块与数据流（规划输入）

```text
Swift helper: 前台/窗口事件、获准窗口截图、AX 正文、Vision OCR
  ↕ JSONL（requestId、generation、pid/windowId、时间、结果状态）
CaptureCoordinator (TS): 权限/排除 → 合并触发 → 身份核对
  → EvidenceStore + DatabaseWorker: 截图、观察事实、gap 先提交
  → TextJobs: AX 质量判断 → 按需 OCR → 独立文本来源
  → Periodizer + SummaryJobs: 周期与摘要，日轴/月历/报告同源
  → ActivityEvents + WorkInstanceTracker: 连续片段 → 可挂起/续接的逻辑实例
  → DiscoveryHost: 自注册worker订阅事件/实例修订 → 通用发现提示
    → DocumentUpdateWorker: 日报/周报/普通文档更新重复候选
    → SopSequenceWorker: 选定SOP候选
  → 按提示类型查看/确认；重复与SOP沉淀 → Skill；执行时选择受支持目标
Renderer: 选时间范围及证据 → CodexAdapter → Proposal/diff
  → 人工确认 → DocumentConnector → 重读核验/回执
```

CaptureCoordinator、小型native helper及文本任务明确采集边界；WorkInstanceTracker与DiscoveryHost收在既有worklog/discovery职责内，沿用EvidenceStore、DatabaseWorker、Period和RunCoordinator，不再引入平行存储。helper的能力可分阶段实现，但每项结果都要带观察身份、状态和错误，不能把失败当空正文成功。文件路径仅由主进程接收，renderer只用证据ID。

实现期需要补充可访问文字的 source、completeness、fallbackReason、observedAt 和 observationId；截图与文本可独立失败。图片哈希可去重文件，不得去重观察时间。事件监听不可用时进入已标识的轮询降级。暂停、删除和排除同时撤销相应 generation 的在途任务。

2026-10-15 澄清：发现阶段不依赖预注册Markdown或文件监控。a11y与OCR提供跨应用的观察输入，结合可编辑焦点、可用值变化和输入时序推断活动；滚动、刷新、协作变化同样会改变文字，不能只由文字变化声称本人已编辑或保存。事件保留observed/inferred/confirmed与来源；两个不同疑似更新工作实例可提示待确认候选，用户确认实例及目标身份后沉淀规则。可观察对象身份与执行connector目标分开记录，首版实际写回仍为本地Markdown。

One Room补充设计：连续Period与逻辑WorkInstance分离，A→B→A可续接同一A实例，时间及重复次数按实际关联片段和不同instanceId计算；不以应用切换或5分钟静置直接判定新一次工作。关联需结合对象、业务目标及进展，不确定时允许人工续接/拆分；gap不补算。通用主动提示由内置worker自注册，公共宿主负责输入游标、状态、授权、有界调度与事务去重；每个worker定义触发门槛和输出动作，未来单次提醒不强制先形成重复模式或Skill。首版只实现文档更新与选定SOP逻辑，接口和故障/重放约束见[技术方案第6节](../../docs/TECHNICAL_DESIGN.md)。这些是本项目新增约束，不作为上游原有能力宣称。

这比移植 Screenpipe Rust 引擎及数据库、再接 MemoryLane 第二套流水线更符合团队维护范围。TS/React 逻辑可以互通；Tauri bridge、系统捕获及存储契约需要适配，不能把框架相同当作组件可直接粘贴的证明。

## 5. 验证记录与实现阶段门槛

原调研检查点已完成：两个版本 release 页面与 tag/commit 核对；24 个选定文件 SHA256 记录；关键实现人工审阅；3 段 Screenpipe MIT 原文摘录及声明保存。MemoryLane 原件在本机执行 `bash scripts/build-swift.sh` 成功，生成 `ocr`、`app-watcher`、`screenshot` 三个二进制。

原调研检查点未完成：启动真实屏幕采集、系统权限流程、中文 OCR/AX 准确性、Kim 正文可见性、One Room helper 实现、上游完整测试、Electron 打包、两台 Mac 安装与持续运行、CPU/内存/耗电与延迟验收。当时没有安装上游 npm 依赖、构建 Rust、启动后台记录或发送模型请求。上游编译通过仅证明其 Swift 构建路径在本机可行。

第一批基座验证记录：One Room helper 使用 Swift 5 语言模式编译并本机签名，hello/shutdown 交互及主进程只读能力探测通过。当时未请求系统授权或采集屏幕；该记录不覆盖之后新增的监听、实际截图、AX 正文或 OCR 路径。

本轮来源追加记录：`source-lock.json` 已增加固定版本的凭据管理源文件，离线脚本通过 25 个文件、3 段原文摘录及两份原始许可证。已核对 WindowListener、WindowCapture、VisionOCR 和 Screenpipe 辅助 hook/分组文件的来源注释与实际小块；各自实际设备、周期集成与手势验收继续按任务记录，不由本段自动判为完成。增量采用清单见 [复用记录](../../docs/acceptance/reuse.md)。

进入实现后按以下顺序验证，不用研究摘录替代结果：

1. 原生 helper 在签名包中的权限、窗口身份与 AX 安全边界；Kim/内部网页“完整正文/工具栏/空/超时”的样例。
2. 密集事件、应用切换、视觉自动变化、迟到结果、暂停和进程退出；事实持久化与 gap 的正确性。
3. 轨道快速定位、按真实时间缩放、日/月切换及缺口清图；两台 Mac 的实际触控板事件。
4. Codex 安装版本的只读限制、结构化结果、取消/超时/认证失败；人工 diff、冲突及幂等核验。
5. 按 spec.md 的 SC-001 至 SC-016 进行产品验收，包含截图留存、通用事件/授权、交错续接及worker扩展，以及四类周期总结、游标标注、自动日/月导航、月格报告入口、三指真机和三类文档复用，再决定参数及可宣称的稳定性。

## 6. 二手材料与来源规则

用户提供的 [MemoryLane 技术方案深度解析与 Screenpipe 对比](https://chatgpt.com/space/page_f7be42e5bb5c8191ab0ff55c146c1999) 用作背景。文章使用的 MemoryLane alpha 快照及 Screenpipe 快照不同于本次发布候选；架构启发可以保留，许可与“已实现”结论以本次锁定源码为准。

`code-excerpts.md` 只保留原来的 MIT 小段原文，明确为局部研究摘录，不是可运行模块。实际移植继续保留出处、对应许可及改动。MemoryLane 按用户已允许的私有使用范围直接适配，不设额外许可审批；完整 GPL 原文已保存在 licenses/memorylane-GPL-3.0.txt。各迁入模块仍需符合 One Room 的接口和核心验收，已迁入与候选范围分别记入 THIRD_PARTY_NOTICES.md。

## 7. 实施规划决策（Phase 0）

以下保留 2026-10-15 Phase 0 原始规划记录：当时检出只有文档和来源记录，没有 `package.json`、`src/`、`native/`、`tests/`，README 提及的 `prototype/` 也未出现在检出。下面是当时待搭建的实施基线，不作为当前工程状态报告。来源版本继续有效；GPL 复用范围以本文件开头的当前实施决策为准。

### R1. 运行时与原生 ABI

**Decision**: 开发 Node `22.22.2` / npm `10.9.7`，Electron `42.11.14`、React/React DOM `18.3.1`、TypeScript `5.9.3`；小型 Swift helper 使用 Swift 5 语言模式、macOS 14 deployment target。首次搭建用精确版本及 `package-lock.json`，后续 `npm ci`。

| 构建/运行依赖 | 固定候选 |
| --- | --- |
| electron-vite / Vite / @vitejs/plugin-react | `5.0.0` / `7.3.7` / `4.7.0` |
| electron-builder / better-sqlite3 | `26.15.3` / `12.11.1` |
| Vitest / Playwright | `3.2.7` / `1.64.1` |
| Zod / diff | `4.1.13` / `8.0.4` |

**Rationale**: registry 的版本、engines 和 peerDependencies 已核对。Electron 42.11.14 内嵌 Node 24.19.0、ABI 146，better-sqlite3 12.11.1 有匹配的 `electron-v146-darwin-arm64` 发布资产。开发 Node 与 Electron 内嵌 Node 分开，不用开发机 Node 能加载模块代替打包验收。Electron 42 在本次调研时仍属最近三个受支持主版本，接近支持末端，升级时必须重验 ABI。

**Alternatives considered**: Electron 43/44 的 ABI 与上述 SQLite 资产不匹配，需额外源码重建验证；React 19 未提供本功能必需能力；整套迁入 Tauri/Rust 或另一个完整应用超出首版维护范围，采用可独立适配的小块。选定基线不等于无漏洞或已集成成功，首次构建仍检查许可证、依赖审计、原生加载和两机安装。

来源：[Electron 发布](https://github.com/electron/electron/releases/tag/v42.11.14)、[版本组成](https://releases.electronjs.org/releases.json)、[支持政策](https://github.com/electron/electron/blob/v42.11.14/docs/tutorial/electron-timelines.md)、[SQLite 模块发布资产](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1)。其他版本定位使用 `https://registry.npmjs.org/<package>/<version>` 的公开元数据。

### R2. 持久化与来源生命周期

**Decision**: 单个数据库 worker 持有 SQLite 连接，串行领域命令；启用 WAL、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=FULL`。迁移带 checksum，升级前用 backup API 备份，失败阻断写入。截图文件先完成受控落盘，再提交事实引用；崩溃遗留的无引用临时文件由恢复清理处理。

**Rationale**: better-sqlite3 12.11.1 的 SQLite 3.53.2 含 FTS5，但 WAL 默认同步为 NORMAL，需显式 FULL 支撑事实、授权及写前意图的耐久目标。图片可按 hash 复用 blob，每次观察的 Evidence 引用独立按 `observedAt + 30天` 到期；旧引用不能因同图再次出现而重新可见。图片到期只失效图片引用；主动删除在事务内传播文字/来源失效、FTS 清理、候选/Skill/任务失效及报告状态，再幂等清文件。派发和提交均复核 consent/source generation。

**Alternatives considered**: 主进程同步 SQL 会阻塞 UI；多写连接池、ORM、向量库增加首版复杂度；只删文件或重启时重建数据库不能保证授权和引用一致性。数据库 worker 不是原生崩溃隔离承诺，进程异常必须恢复为缺口/只读故障，不能伪造连续记录。

来源：[worker 模式](https://github.com/WiseLibs/better-sqlite3/blob/v12.11.1/docs/threads.md)、[WAL 耐久性](https://github.com/WiseLibs/better-sqlite3/blob/v12.11.1/docs/performance.md)、[SQLite 固定源码](https://github.com/WiseLibs/better-sqlite3/blob/v12.11.1/deps/sqlite3/sqlite3.h)、[FTS5](https://www.sqlite.org/fts5.html)。中文采用 trigram 子串索引；1–2 字查询使用有时间范围和结果上限的 LIKE，识别质量与检索质量分别验收。

### R3. 原生采集与三指输入

**Decision**: NSWorkspace/AXObserver 事件驱动加低频检查点，Swift helper 用 macOS 14+ 的 SCScreenshotManager 和指定 SCWindow 截获准前台窗口、AX 读取可见正文、Vision 补充 OCR；JSONL 带 requestId、generation、窗口身份和提取状态。先验证打包 helper 的权限归属和窗口配对，超时可终止并重建提取进程，事件监听不受同步 AX 卡死影响。无音频，不用截全屏回退获准窗口失败。

**Rationale**: 沿用已锁定上游的能力边界，截图/文字不是系统原子快照；前后身份核对及迟到丢弃必须在主调度实现。三指先试 Electron macOS `BrowserWindow` 的 `swipe` 事件：官方标为三指滑动，受“页面间轻扫”系统设置影响，只有方向没有连续缩放量，可映射为平滑的分级缩放。标准 pinch/wheel 本身不证明手指数，独立 Swift 子进程不能直接假定拥有 Electron 窗口的触点。

指定窗口捕获仍可能返回被遮挡、移出屏幕的完整窗口表面；单窗口 filter 不等于只含可见内容。请求前后须核对前台、on-screen、未最小化和可见范围，AX 也过滤隐藏节点；遮挡或其他 Space 导致可见性无法确认时丢弃并标缺口，不采用隐藏表面。helper 在 ASAR 外随包分发并嵌套签名、公证；Electron 进程的 AX/screen 状态不能代替 helper 的实际 TCC 权限。全局输入监听如需 Input Monitoring 单独检查，协议只含时序不含按键字符。

**Alternatives considered**: 不默认新增全局手势拦截或复杂原生 addon。先在两台 Mac 记录设置、原始信号、时间线焦点/命中范围及 SC-015 的实际结果；接不到或不能满足目标交互时标三指受阻，保留 pinch/按钮导航但不算三指通过。需要额外桥接时先证明可行性，不扩大已承诺语言范围。

来源：[Electron swipe](https://www.electronjs.org/docs/latest/api/browser-window#event-swipe-macos)、[wheel 事件](https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event)、[Apple 截图 API](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)、[窗口捕获可见性](https://developer.apple.com/videos/play/wwdc2022/10155/)、[Electron 权限](https://www.electronjs.org/docs/latest/api/system-preferences)及本文件固定版本原生源码。签名、公证、TCC、中文 AX/OCR 和三指输入仍是实现期真机门槛，不作为尚待用户决定的产品选项。

### R4. 时间投影与报告

**Decision**: UTC epoch ms 与半开区间落库，Asia/Shanghai 分日、周一为周首；跨零点仅切投影。timeline、month、report 共用已提交 Period/Gap revision；A→B→A 保留真实顺序和各自时长。窄片段仅简化标注，当前游标标签始终可读。月格内滚动，不加载整月截图。日轴从全天继续缩小自动进月历，反向/选日恢复位置，切换有滞回。

**Rationale**: 防止帧数冒充时间、过滤后合并隐藏活动、缺口被补算和迟到图像串位。日/月的视图筛选只影响当前浏览；日报/周报入口打开完整日/周范围的本地报告，生成前显示明确日期范围和覆盖说明，不静默把临时软件筛选当完整报告。报告与被 SOP 更新的外部目标文档分别保存引用。

**Alternatives considered**: 不按上游固定帧宽估时，不用固定短时长阈值删除片段，不让报告页面自动写外部文档。无模型授权时仍显示事实型工作日志，语义内容显示未授权/未知；有授权后可生成摘要，不能以 Codex 认证代替后台分析授权。

### R5. 逻辑工作实例与自注册检测

**Decision**: Period 与 WorkInstance 分离，关联带 revision/basis，按不同 instanceId 计次；公共 DiscoveryHost 提供有限输入、授权、游标、状态、去重与恢复，业务触发留在内置 worker。文档三类各两个不同更新实例；P2 配券/策略三个不同有序实例。单次提示 worker 可无实例门槛、无需生成 Skill。

**Rationale**: A→B→A 不是两次 A；同名不证明同一文档，正文变化不证明编辑/保存。每条规则的状态推进和 findings upsert 同事务，稳定 findingKey 不含容易导致重复通知的每次运行 ID；禁用、失败、重放和关联修订不能破坏忽略/稍后状态。

**Alternatives considered**: 不做每提示一个常驻进程，不加载外部可执行脚本，不把检测器直接连到文档/业务写入，不引入通用自动化平台。检测计算使用有界后台宿主，超时可终止；异步函数自身不构成故障隔离。

### R6. Codex 兼容与提案边界

**Decision**: 首版 adapter 锁兼容基线 `codex-cli 0.144.1`，能力验证后启用。固定参数数组 `shell=false`，stdin 输入全部经用户审核的材料；使用 `--json`、`--output-schema`、`--ephemeral`、`--ignore-user-config`、`--ignore-rules`、`--sandbox read-only`、`--skip-git-repo-check` 和隔离工作目录，顶层 `-a never`。逐项禁用 shell tool、Apps、hooks、remote_plugin 和 web search；不复制 auth，不更改全局配置，Claude 保持 disabled。

**Rationale**: 本机版本和 help 已核对，但尚未进行真实推理、沙箱或工具清单验收。`--ignore-user-config` 只说明跳过用户 config.toml，认证仍使用 CODEX_HOME；`read-only` 限制模型命令，不隔离所有读取、MCP/Apps 或模型鉴权网络。cwd 不是权限边界。实现前用合成材料证明无外部工具启动、结构化提案可校验、取消/超时有效；失败进入 capability_blocked，不向其发送业务材料，不自动放宽权限。

**Alternatives considered**: 不用 Pi 或普通 GPT 兼容端点冒充本机 Codex；不信任 prompt 限制写入，不靠 `features.unified_exec=false`（官方说明 opt-out 会被忽略）禁 shell，不假设 `mcp_servers={}` 能清空所有配置层。后续版本须重新通过能力矩阵。

来源：[非交互](https://developers.openai.com/codex/noninteractive/)、[配置参考](https://developers.openai.com/codex/config-reference/)、[配置层级](https://developers.openai.com/codex/config-basic/)。Proposal 绑定 run/generation、SkillVersion、输入和目标 hash、sectionRef、sourceRefs；进程退出 0 或 turn.completed 不等于业务成功。

### R7. 文档事务

**Decision**: main 用原始选择路径先 lstat，拒绝 symlink，再解析规范路径和文件身份；首版仅 UTF-8 Markdown、2MiB、唯一可定位日期块或章节。完整读取当前文件并保留 BOM/换行及范围外原始字节，Codex 仅给替换建议。人工审核的批准绑定 proposalHash、beforeHash、来源和规则版本；确认后文件变更须重新生成及审核。

**Rationale**: apply 按目标串行，复核身份/hash，在同目录写临时文件、fsync、保留权限、rename 及目录 fsync；写前持久化 operation intent，写后重读核验。恢复时 afterHash 匹配只补回执，beforeHash 匹配可显式重试，其他 hash 为冲突。路径不能先 realpath 再声称检测到了原路径 symlink。

**Alternatives considered**: 常规本地文件没有跨进程强 CAS；MVP 要求目标独占编辑，不满足时只导出补丁，不写文件。云文档需要条件版本更新，留作后续 connector。写后异常不盲目回滚可能已经被外部更新的文件；配券/策略只预览，不调用业务接口。

### R8. 门槛与当前证据

**Decision**: 未发现需新增用户产品决策的技术歧义；选择、失败状态与验证方法均已明确。未批准的宪法模板不产生有效原则，不能宣称“宪法通过”；以 spec 和用户已确认的项目约束做设计核对，未来有正式宪法后重检。所有未进行的真机、原生构建和模型验证均列成实施退出条件，而非已完成结果。

**Rationale**: 规划可完成而运行验收仍待执行。每一高风险边界在 quickstart 和 contracts 中都有阻断/降级结果，不能靠假数据、备用操作或依赖元数据越过验收。

**Alternatives considered**: 不自动替用户制定宪法，不把待实现的设备验证标成设计失败，也不把未测能力当作已具备。当前没有构建、采集或推理任务被本次规划启动。
