# One Room 双人开发交接

更新：2026-10-16。已交付基座、记录识别、生产时间回顾、独立日报周报/HTML 导出、历史删除，以及受控文档 SOP 服务与审核界面；完整 M0/P0、真实 Codex 执行和正式分发验收仍待完成。完整要求仍以 [spec.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/spec.md) 和 [tasks.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/tasks.md) 为准。

## 当前能做什么

**schema 6 整合更新**：日轴/游标/图片状态、日月导航、月格、独立报告和主动删除已接生产 SQLite worker/main/preload，模块接口见 [WORKLOG_B_HANDOFF.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/docs/WORKLOG_B_HANDOFF.md)。同事务读取事实、活动与证据；报告快照、全观察来源关联和幂等回执跨重启保留，删除清理文字/FTS/摘要任务及报告副本。schema 6 新增文档目标、不可变 Skill 版本、运行/提案、持久操作与回执；见 [存储验收](acceptance/worklog-storage.md)、[周期总结检查](acceptance/period-summary.md) 和 [文档 SOP 检查](acceptance/document-sop.md)。

- Electron 窗口、隔离 preload、严格 IPC、设置页和时间轴外壳已建立。应用范围可保存并跨重启读取；后台文字分析默认关闭。
- SQLite 由一个 worker 独占，使用 WAL、FULL、外键和带 checksum 的迁移。观察、图片引用、来源引用和持久变更序号有同事务提交入口。
- CaptureCoordinator 已连接真实事件与指定窗口截图，截图先经 EvidenceStore 持久化，再异步执行独立 AX/OCR 队列。按 hash 复用文件，每个观察独立 30 天到期，文字/活动不随截图到期删除。
- Swift helper 支持 JSONL v1 listener/executor、NSWorkspace/AXObserver、输入类别时序、锁屏/睡眠和心跳、SCScreenshotManager、可见 AX 正文和中英 Vision OCR；不读取按键正文或剪贴板。
- 模型配置支持 baseUrl/model/API Key、系统安全加密/清除及纯合成连接测试；后台文字授权独立默认关闭，派发和数据库提交均复核来源及授权。活动校正已接 `activity.query/review`，人工修订保留事实及原文。
- 连续同窗口、同对象/主题/行为/依据的观察可聚合，周期 ID 为第一条观察 ID，保留每条观察到周期及原始 displayUntil 的映射。短 A→B→A、gap 和人工依据边界保留。schema 5 已接关闭周期的持久分块/归并总结、授权双验、人工锁、跨午夜投影及报告失效，见 [周期总结检查](acceptance/period-summary.md)；四类真实真值仍待验收。
- 时间回顾支持连续滚轮/触控板平移、居中时间标记、合并图片查询和 320ms 日/月平面淡出倾斜/淡入进入；日报周报无需关联外部文档，可查看时间分配、节奏、来源片段与关键时刻，审阅后导出无远程资源的离线 HTML。报告不附截图或原窗口标题，不从时长推断成果、情绪或加班，详见 [报告检查](acceptance/reports.md)。
- 已保留可注册发现规则、候选持久化、发现提示与 Skill 编辑；操作流程和文档更新在“流程”中分别展示。通用实例续接与受限 worker 的完整契约仍待补齐。确认的浏览器录制可经固定 OpenAdapt Flow 本地运行，原生应用执行未开放；本包未准备外部 runtime，流程执行禁用、相关检查跳过。产品要求配券/策略仅预览，手工录制通用 workflow 仍需补齐额外业务范围限制，不能声称全部执行路径已受限。
- Codex 固定参数/最小环境、JSONL/预算/取消和合成能力矩阵、冻结完整输入、精确 diff 双审核及 durable 本地 Markdown 操作已实现。T049/T050 已完成实现和受控检查；生产默认 `IsolationVerifier` 尚无可信证据，G4 和真实业务派发保持阻断，不能据模拟通过声称真实 Codex 写回成功。详见 [文档 SOP 检查](acceptance/document-sop.md)。
- 单 Mac 的自建 Cocoa 测试窗口已走通真实截图→AX/OCR→数据库→活动，模型调用零。普通桌面被透明全屏工具窗覆盖时严格拒绝截图；两机/60 分钟、正式签名和完整中文场景验收仍未通过，见 `docs/acceptance/capture.md`。

## 双人领取

| 工程师 | 负责范围 | 下一批任务 | 首个交付点 |
| --- | --- | --- | --- |
| A：记录识别与文档执行 | `native/`、capture、模型配置/队列、活动校正；main/DB/证据/打包；Codex、本地文档事务与运行审核 | 记录识别、T045–T047/T049–T050、schema 6 本机包检查已完成；继续 G2 普通窗口/两机、T014–T016 生命周期/输入验收与 T059 正式签名/第二机；T048 补可信隔离/G4，配合 B 补 T037 的实例/worker 存储 | 受控截图→AX/OCR→入库、冻结输入→双审核→合成本地写入及新包启动/依赖闭包已通过；下一步普通桌面、真实 Codex 与正式分发门槛 |
| B：时间回顾与发现/Skill | 周期、查询、日轴/月历、报告和总结；共享 DTO；通用实例/worker、发现提示与 Skill | T030/T035/T065/T066 已实现并有核心检查；继续 T034/T036 真实语义/物理手势及双机回顾；P1 按 T038–T044 补实例续接、受限 worker/来源重验和发现规则，补 T051 的发现矩阵 | A→10 秒 Kim→A、日/月/图片、独立日报周报/HTML、重启/删除已在合成生产历史通过；下一步使用真实语义样本校验对象/主题和通用发现计次 |

T004 已勾选实施完成；T009 仍未勾选，已有统一 fixture 和单机原生证据，不代表第二台安装、全部真实捕获边界或三指信号通过。两路集成须使用默认桌面数据源，不把 fixture 灌进应用库。

按功能闭环分工，每人负责各自功能的服务、UI 与核心检查。A 的 `activity-events.ts`、`EventReview.tsx`、`ModelSettings.tsx`、`AgentSettings.tsx`、`RunReview.tsx` 是明确文件归属；它们虽位于 worklog/renderer，仍不转给 B。B 的时间回顾模块使用 A 提供的提取/活动/模型接口。

同文件只保留一个负责人：A 单写 `package.json`、lockfile、main 装配、数据库迁移与 worker 命令；B 维护共享 DTO，A 的新接口先对齐 schema。B 先定义工作回顾查询及所需命令的输入/输出，与 A 对齐后由 A 接入 worker；renderer 和工作回顾服务不得再创建 SQLite 连接。修改既有迁移会触发 checksum 失败，新增表或字段应新增迁移。

并行顺序：A 优先普通桌面/生命周期及正式签名/第二机安装，B 优先真实同源语义、时间回顾与物理三指验收。文档目标、文件事务、Codex 协议和 T049/T050 审核链已汇合；后续 A 处理 T048 的可信隔离与真实执行门槛，B 补 T038–T044 实例/发现契约，两路汇合 T051/T052 真实发现→确认→复用验收。T037 仍有实例/worker 存储待补，不因文档表已实现而整体完成。总任务数现为 66，新增 T065 平滑时间轴/切层动画和 T066 独立报告回顾；完整 P0 仍未验收。

## 模块与接入点

| 入口 | 当前职责与后续接法 |
| --- | --- |
| [schemas.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/shared/schemas.ts)、[contracts.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/shared/contracts.ts) | 严格 DTO、`inputSchemas`/`outputSchemas`、`OneRoomApi`、Native/worker/run 边界。新增 IPC 先在这里定义，再由 A 注册、preload 暴露 |
| [ipc.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/main/ipc.ts)、[preload.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/main/preload.ts) | 主 frame/来源校验与方法白名单；renderer 只用 `window.oneRoom`，不暴露原始 IPC、SQL、路径或进程 |
| [client.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/services/storage/client.ts)、[database.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/workers/database.ts)、[migrations.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/services/storage/migrations.ts) | 主进程异步 `DatabaseClient.call`；worker 独占连接。`capture.setEnabled`/`capture.commitObservation` 是内部命令，不向 renderer 注册 |
| [store.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/services/evidence/store.ts)、[protocol.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/services/storage/protocol.ts) | A 经 `EvidenceStore.publish(observation, png)` 提交已获准、已校验的事实。`observationInputSchema` 定义身份、触发与 generation；图片不交给 B 自行落盘 |
| [helper-client.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/services/capture/helper-client.ts)、[native-session.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/services/capture/native-session.ts)、[native/README.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/native/README.md) | `inspectNativeHelper` 保留有截止时间的只读握手；生产 `NativeSession`、listener/executor、staging 与 CaptureCoordinator 已实现。受控窗口真实截图/AX/OCR/事件及入库已通过，普通桌面可见性和两机仍待验 |
| [queries.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/services/worklog/queries.ts) | 生产 `registerWorklogServices` 使用 `createSnapshotQueries` 和事务型 `WorklogReader` 返回共享 TimelinePage/CursorResult/CalendarPage；单连接 worker/main 同事务读取事实、gap、图片和活动映射。`createWorklogQueries` 保留为独立包装入口。已有观察时返回真实数据，不能伪装为空历史 |
| [desktop.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/renderer/lib/desktop.ts)、[data-source.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/renderer/timeline/data-source.ts) | 默认通过桌面 bridge；仅开发模式并带 `?fixture=1` 时动态接入统一 fixture |
| [worklog.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/shared/fixtures/worklog.ts) | `createFixtureApi`、`WORKLOG_FIXTURE`、固定日期与范围。测试目录仅重导出；不灌入应用数据库 |
| [activity-events.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/services/worklog/activity-events.ts)、[EventReview.tsx](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/renderer/timeline/EventReview.tsx) | A 的本地推断与独立校正组件。`inferLocalActivity({trigger,current,previous})` 使用获准同窗口的正文和输入时序，只给出疑似编辑/切换/未知；组件通过 `activity.query/review` 读取文字与版本化人工修正，不直接访问数据库。活动按 observationId 关联观察；连续观察聚合后，周期 ID 使用首观察 ID，每条观察通过 assignments 映射到所属周期。T020 关联与 T030 持久总结已完成，四类真实语义质量仍待 T036 |
| [report-story.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/renderer/reports/report-story.ts)、[ReportView.tsx](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/renderer/reports/ReportView.tsx) | 从有效报告快照衍生时间分配/节奏/来源片段和时刻；回顾/事实视图及审阅后离线 HTML 导出。不上传截图，不把报告区间边界称实际开工或夜间记录 |
| [runs.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/services/agents/runs.ts)、[RunReview.tsx](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/renderer/runs/RunReview.tsx)、[DocumentWorkbench.tsx](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/renderer/skills/DocumentWorkbench.tsx) | 文档版本发布、冻结输入、确认后提案、精确 diff 确认及宿主 apply/exportPatch；持久状态/幂等/来源重验。生产 Codex 仍需可信隔离验证，不能绕过能力门禁 |
| [local-markdown.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/services/documents/local-markdown.ts)、[operations.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/services/documents/operations.ts) | 系统选择目标、严格编码/身份/章节、章节外字节保留、写前意图/哈希/回执和恢复；独占编辑才允许应用，否则导出 patch。本地 rename 不提供跨进程 CAS |

桌面已提供 `model.getConfig/saveConfig/testConnection/clearCredential`、`activity.query/review`、`report.get/generate`、`history.previewDelete/delete` 和 `run.prepare/propose/get/cancel/apply/exportPatch`。调用返回 `Reply<T>`，先判断 `ok`；不能把失败当空成功。`events.subscribe(listener)` 返回取消订阅函数。原生 swipe 经独立 `gestures.subscribe` 通道进入时间线，真实三指仍待验。后台文字开关独立、持久且默认关闭。

T064 和 T021 已实现：模型地址、模型名和 API Key 配置/加密/清除，读取只返回 `hasCredential`；显式连接测试只发送合成文字，不修改独立授权。schema 6 本机包已用合成 API Key 验证真实 Electron safeStorage 加密、文件无明文、解密相等、关闭重启保留及清除，网络请求 0；请求测试仍使用本机 HTTP，外部提供方尚未验收。本地 AX/UI 树与 Vision OCR 不需要 API Key/Secret。Codex 使用本机 CLI 安装/登录状态，与此配置分开；安装/认证检测、合成能力验证协议、冻结输入及精确差异双审核已实现。默认可信隔离验证仍缺失，生产派发以 `CAPABILITY_BLOCKED` 阻断，T048/G4 保持未完成，Claude 可见且禁用。

数据库现为 v6：v2 增文本/FTS/活动/来源修订，v3 增报告和持久删除回执，v4 保留远程已发布的 SOP 表，v5 增周期总结任务树，v6 增文档目标/Skill UUID 版本/运行/提案/操作回执。后续增量从 v7 起，不改既有迁移 checksum。删除预览先持久暂停采集并等待在途任务收敛；取消预览或完成删除后保持暂停。删除同事务清理文字、FTS、活动修订、总结及报告副本并提升 generation，同时失效关联文档运行来源；主进程完成文件清理后持久记回执。报告以同一个 asOf 时刻读取/重验开放 gap，截图自然到期不使报告文字失效。worker 正常关闭等待消息端口自然退出，避免强制 terminate 原生 addon 的崩溃。

活动 DTO 定义于 `src/shared/activity-schemas.ts`。`activity.query({before?,limit?})` 返回 `{items,nextBefore}`，文字来源标记为 `accessibility/ocr/null`；`activity.review({id,expectedRevision,action,activityType,objectLabel,topic,confirmed:true})` 成功返回 `{revised:true}`。校正界面传入 `api={desktopApi().activity}`；窗口身份只能支持“疑似输入/编辑”，不能证明同一文档或保存成功。模型服务实际目录是 `src/services/model/`，配置存储在 `config-store.ts`，模型请求在 `openai-compatible.ts`，worker 入口为 `src/workers/model.ts`。

## 启动与检查

要求 macOS 14+ Apple Silicon、Xcode Command Line Tools，Node 22.22.2/npm 10.9.7。在仓库根目录运行：

```sh
npm ci
npm run native:build
npm run native:smoke
npm run dev
```

`native:build` 默认临时签名用于本机开发，输出 `resources/native/one-room-helper`。`dev` 启动 Electron 和 renderer；浏览器开发地址以终端实际输出为准，默认 `http://127.0.0.1:5173/`。该地址附加 `?fixture=1` 可独立查看开发示例，普通浏览器页面没有桌面 bridge。正式构建不会启用 fixture。

两人本机隔离调试可分别使用 `ONE_ROOM_USER_DATA=/tmp/one-room-a npm run dev` 与 `ONE_ROOM_USER_DATA=/tmp/one-room-b npm run dev`；不设置时使用 Electron 的 `userData`，不要将 fixture 写入该目录。示例固定为 2026-10-15 09:00：VS Code 10 分钟、Kim 10 秒、VS Code 15 分钟、暂停 2 分钟；Kim 图片过期，另一个游标响应可延迟，所有示例均不提供真实截图。

| 命令 | 当前覆盖 |
| --- | --- |
| `npm run check` | 最新完整检查通过：类型、ESLint、95 项单测（19 个文件通过），另 1 项依赖外部 OpenAdapt runtime 的 workflow 集成检查跳过；实际 Electron ABI 下六组 SQLite smoke 通过，含文档操作与运行 |
| `npm run native:smoke` | 无交互 helper 握手与协议检查，不请求系统权限、不截图 |
| `npm run verify:upstream` | 固定上游文件、摘录与许可校验；不是产品功能验收 |
| `npm run build` / `npm run preview` | 前者构建，后者启动已构建的桌面应用；采集默认暂停，真实数据源接线状态按能力结果显示 |
| `npm run build` 后 `npm run test:e2e` | 最新 13/13 通过：Electron bridge/范围/重启/文字授权、生产非空日月/报告/HTML/删除、文档冻结输入审核、月格精确定位、合成 swipe/过期 revision 恢复，以及三分钟跨午夜证据像素变化；临时 userData 或内存 fixture，1440/390px 无横向溢出，不代替真实采集/物理手势 |
| `npm run build` 后 `npm run benchmark:navigation` | 30 天/100000 观察/10000 周期/1000 合成 PNG 的 worker/服务层性能，详见 `docs/acceptance/navigation-performance.md`；不含 renderer 解码/绘制 |
| `npm run build` 后 `npm run benchmark:renderer` | 最新 `dbefbcd` 时间范围版同规模生产界面基准：游标 p95 99.04ms，日月切层含完整 320ms 动画 p95 442.27ms；初始化预热至 24 小时后计时，密集月格刷新/第 334 项精确跳转、390px 中心时间可见、无溢出/页面异常通过，详见 [导航性能](acceptance/navigation-performance.md) |
| `npm run package:mac` | 构建 arm64 `.app` 目录；当前无正式签名、公证和第二台安装保证 |
| 打包后 `node scripts/package-smoke.mjs` | schema 6 候选已通过：独立 userData 的实际包启动/IPC/SQLite/WAL/helper、报告持久化/删除幂等、safeStorage 真实加密/重启解密/清除、包内容/许可/四项 runtime 依赖；无页面异常，网络尝试与采集均为 0 |
| 打包后 `node scripts/verify-sop-desktop.mjs` | schema 5 候选包的主动发现、Skill 版本/校验、策略预览、390/1280px 弹窗及重启通过；仅本地 CLI 状态检测，无模型执行或公司文档写入 |

`check` 不包含 E2E、native smoke、上游校验或两台真机验收。受控窗口额外执行 `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron out/main/nativeCaptureSmoke.js`；修复测试窗口前台激活后复跑通过，验证生产 NativeSession/Zod、真实截图/AX 优先/中英 OCR、CaptureCoordinator 入库共 1 条观察/图片/活动、暂停与重启，模型调用为零，详见 [capture.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/docs/acceptance/capture.md)。快速迭代只执行与改动相关的核心检查；受控单机通过不代替普通窗口、两机各 60 分钟或真实手势门槛。

schema 6 候选基于隔离工作树 `dbefbcd` 构建，已通过 `package:mac` 和 `package-smoke`；`node_modules` 符号链接漏传递依赖已用本地 `npm ci` 修复，并加入四项运行依赖断言。ASAR SHA-256 为 `6b4df09f88c0f1b1d678e9f2096093bb8a54d4bf667e07b3b8a2e7e738d9cd34`，产物位于隔离树 `release/mac-arm64/One Room.app`。schema 5 SOP 工作台检查仍只作为历史；本包未准备 OpenAdapt runtime，流程执行禁用，未执行真实业务。详情见 [package.md](acceptance/package.md)。Developer ID、公证和第二台安装仍未通过。

## 复用与完成标准

已根据用户授权适配 MemoryLane v1.5.10 的窗口 AX、监听生命周期、PNG 编码、Vision OCR、子进程通信及系统凭据加密小块，保留 GPL 标识、固定 commit 和许可正文，见 [THIRD_PARTY_NOTICES.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/THIRD_PARTY_NOTICES.md)。Screenpipe 的日期控制、图片加载取消/contain、平滑缩放和连续分组也已适配。继续优先复用锁定版本中可拆分的实现，不引入 Rust 或 Pi 运行时。

A/B 集成已覆盖获准观察、短切换、gap、旧代拒收、文字授权、日/月查询、持久周期总结、独立报告/HTML、删除持久化、本机界面性能和 schema 6 本机包。Codex 双确认、冻结输入和 durable 本地 Markdown 写回已实现并经合成 Agent/真实 SQLite 检查；普通窗口覆盖层、两机持续运行、完整四类语义、真实三指、完整实例/worker 发现契约、可信隔离/G4 和真实 Codex 写回、正式安装验收仍未完成。从零实现继续在 `001-event-driven-capture` 分支按验证后的功能提交；远程 `ml-one-room` 为另一套 MemoryLane 基线，本轮未合并或覆盖该分支。
