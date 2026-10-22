# 开发与验收入口

日期：2026-10-15。实施分支 `001-event-driven-capture`，计划见 [plan.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/plan.md)。**基座、采集/AX/OCR/模型/活动及生产时间回顾、持久报告和历史删除已实现。受控窗口单机链路通过；普通桌面覆盖层、真实采集后的非空回顾完整 UI 主链和双机验收待补，尚未完成 M0/P0。** 两人领取和模块边界见 [DEVELOPMENT_HANDOFF.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/docs/DEVELOPMENT_HANDOFF.md)。

## 1. 阅读顺序与环境

1. [spec.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/spec.md)：P0→P1→P2、FR/SC 与已确认澄清。
2. [research.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/research.md)：固定上游及第 7 节选型/证据等级。
3. [data-model.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/data-model.md)和 [IPC](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/desktop-ipc.md)、[UI](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/ui-behavior.md)、[Native](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/native-helper.md)、[Worker](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/discovery-worker.md)、[Codex](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/codex-document.md)契约。
4. 按 [tasks.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/tasks.md) 和交接表领取：A 继续 G2 普通窗口/两机检查与 T016；B 继续完整总结、真实同源回顾及手势/性能验收。T004 已勾选实施完成，T009 仍未勾选；受控窗口或 fixture 不代替剩余真机门槛。

功能闭环分工：A 已实现真实采集、AX/OCR、活动事件、模型配置/队列及对应 UI，并接通生产 reader 和 T020 周期关联，继续质量/真机验收，再接文档/Codex 及输入/diff 审核（T045–T050）；B 的时间回顾、报告/删除服务及 UI 已接生产，继续完整总结与真实回顾验收（T030、T034–T036），再接实例/发现/Skill（T038–T044）。T037 迁移仍由 A 合并。任务共 64 项，原 M0 的 29 项保留，任务完成状态以 tasks.md 为准。

开发机要求 macOS 14+ Apple Silicon、Xcode Command Line Tools，构建 Node 22.22.2/npm 10.9.7；Swift 用 5 语言模式、deployment target 14.0。最终用户安装签名 arm64 应用，不需要 Node、Rust、Xcode 或参考产品即可使用 P0；P1 的 Codex 执行另需安装并认证受支持的本机 Codex CLI，其运行前提单独引导。第二台 Mac 独立数据库，无同步要求。

依赖基线为 Electron 42.11.14（Node 24.19.0/ABI146）、React/react-dom 18.3.1、TypeScript 5.9.3、electron-vite 5.0.0、Vite 7.3.7、plugin-react 4.7.0、electron-builder 26.15.3、better-sqlite3 12.11.1、Zod 4.1.13、diff 8.0.4、Vitest 3.2.7、Playwright 1.64.1，以现有 package/lockfile 固定版本安装。Electron 原生模块须用实际应用 ABI 检查，不能以构建 Node 的加载结果替代。

## 2. 当前可运行的命令

| 脚本 | 当前责任与范围 |
| --- | --- |
| `npm ci` | 按现有 lockfile 安装，并为 Electron 重建原生依赖 |
| `npm run native:build` | 编译 arm64 Swift 5 运行 helper 到 ASAR 外的 resources/native；默认本机临时签名，不是正式签名公证 |
| `npm run native:smoke` | hello/shutdown/协议检查，不申请权限、不截图；真实监听/提取验证使用独立受控窗口入口，见下文 |
| `npm run dev` | 启动独立 Electron 工程；不默认开启采集或模型发送 |
| `npm run typecheck` / `npm run lint` | 共享 schema、所有 main/preload/worker/renderer 类型与静态依赖检查 |
| `npm run test:unit` | 当前 20 个核心检查：共享契约/fixture、活动依据、模型配置/队列、周期/查询/导航、隔离报告/删除和连续摘要 |
| `npm run test:integration` | 自动构建后以实际 Electron 运行三组临时 DB/图片：WAL/FULL/FK/FTS5、事实提交、独立到期、授权/活动、持久报告/删除/共享 blob、重启/幂等/asOf |
| `npm run check` | 依次 typecheck、lint、unit、integration；不包含 native/e2e/上游或真机验收 |
| `npm run build` / `npm run preview` | 前者构建，后者启动已构建的桌面应用；真实采集须显式配置范围并开始，默认暂停 |
| `npm run test:e2e` | 运行前须先 build；当前 6 个通过，覆盖 Electron bridge/范围/重启/独立文字授权、生产空历史报告/删除、隔离日月与图片、已知活动/月格定位和合成 swipe 作用域；使用临时 userData 或内存 fixture 并保存截图 |
| `npm run verify:upstream` | 锁定上游文件、精确摘录及保留许可的来源校验 |
| `npm run package:mac` | 编译 helper、构建应用并产出 arm64 .app 目录；当前配置无正式签名、公证与第二台安装保证 |

首次启动：

```sh
npm ci
npm run native:build
npm run native:smoke
npm run dev
```

运行时数据留在 Electron 的 userData；两人可分别设置 `ONE_ROOM_USER_DATA=/tmp/one-room-a`、`/tmp/one-room-b` 后启动，使用独立数据库。开发 renderer 默认地址为 `http://127.0.0.1:5173/`，以实际日志为准；附加 `?fixture=1` 可在浏览器独立查看测试数据，仅 DEV 构建有效。统一 fixture 位于 [worklog.ts](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/src/shared/fixtures/worklog.ts)，固定 A10min→Kim10s→A15min→gap2min，含过期/迟到响应，不写生产数据库，不提供真实截图。普通浏览器的非 fixture 页面没有桌面 bridge。

`test:contract` 与 `check:codex` 尚无脚本，不能作为已有命令执行。Codex、发现 worker 与文档事务的验收在相应实现后增加；当前快速验证优先使用已建立的核心检查。

受控窗口真实链路的已执行入口如下；它会启动自行创建的 Cocoa 测试窗口、临时数据库和真实 helper，只允许该测试应用，不采集其他窗口、不发送模型请求：

```sh
npm run native:build
npm run build
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron out/main/nativeCaptureSmoke.js
```

该入口修复测试窗口前台激活后复跑通过，验证生产 `NativeSession`/Zod、截图哈希、AX 优先/中英 OCR、监听/心跳及 `CaptureCoordinator` 入库/暂停/重启，共 1 条观察/图片/活动、模型调用 0。它不是普通桌面或两机产品验收，详见 [capture.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/docs/acceptance/capture.md)。

历史 schema 2 候选包已通过本机启动/helper/凭据加密及内容隔离检查；最新包、实际检查和 ASAR SHA-256 统一见 [package.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/docs/acceptance/package.md)。Developer ID、公证和第二台 Mac 安装尚未验证。

## 3. 首个闭环与运行门槛

当前链路为 renderer→OneRoomApi→可信 IPC→领域服务→DatabaseClient→单连接 worker。`inspectNativeHelper` 仅做只读握手；`NativeSession`/`CaptureCoordinator` 在用户显式开始后执行真实采集。先配置应用范围并授予 Screen Recording/AX；截图先持久化，后台文字默认关闭，模型配置保存/连接测试不会代替文字授权。共享工作回顾由B维护，main/worker和真实采集由A维护；单机受控结果不能代替完整门禁。

T064 模型地址/模型名/API Key 安全保存/清除与合成连接测试、T021 有界串行队列已实现。配置读取只返 `hasCredential`，测试连接不启用后台文字授权；派发与入库分别复核授权 generation 和来源 revision。真实 safeStorage 已以合成密钥在本机包中验证；模型请求仍仅以本机 HTTP 验证，外部提供方尚未验收。生产 WorklogReader 同事务读取事实、gap、图片和活动，连续同语义周期以首观察 ID 标识并保留每条观察映射，T020 关联完成；报告/删除已接持久存储，T030 完整总结队列及四类真值仍待。本地 AX/UI 树及 Vision OCR 无需 API Key；Codex 使用独立本机 CLI 登录态，其连接状态 UI 在 T047、adapter 在 T048、执行审核在 T049/T050，P1 均未接入。

1. **G1 包与数据库**：在实际 Electron ABI146 加载 better-sqlite3，验证 SQLite/FTS5、WAL、FULL、迁移/恢复；签名 helper 与第二台安装。Node REPL 可加载不算通过。
2. **G2 捕获边界**：确认实际负责进程的录屏/AX 权限；所选全局输入机制若需 Input Monitoring 单独验证。只记录获准可见前台窗口，遮挡/屏外/最小化/身份不确定则 discard/gap，不回退全屏。事实/图先存，AX 正文→不足再 Vision OCR；文字失败仍可看有效图。
3. **G3 手势**：先在两台 Mac 记录 BrowserWindow swipe 原始方向/系统配置，时间线焦点与命中区域有效；每台至少 10 次三指缩放，覆盖日/月跨层。标准 pinch、按钮及脚本不替代专项结果。
4. **G4 Codex**：支持基线 0.144.1，先只读版本/认证检查；合成输入证明额外命令/MCP/Apps/插件/网络工具没有启动，并验 schema 子集。任何能力不满足置 capability_blocked，禁止发送业务材料；不复制 auth、不改用户配置、不自动放宽沙箱。
5. **G5 文档**：用户选择临时 Markdown，读取现文并确认唯一章节和独占编辑；输入确认→提案→完整 diff→确认应用→重读。hash/rename 非跨进程强 CAS，无法独占时只导出补丁。

G1/G2 后先交付 P0 事实时间线，再完成四类总结与日/月/报告；文档三类 SOP 和 Codex 闭环随后，配券/策略最后只预览。没有模型授权时本地采集/提取/回看仍可用；后台文字授权单独默认 off，截图自动发送数量必须为零。

## 4. 验收样例与证据

以下为完整产品验收清单，尚未整体通过。20 个单元、三组 Electron/SQLite 集成、6 个 E2E 与受控窗口单机截图/AX/OCR 已通过各自范围，见 [gates.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/docs/acceptance/gates.md)；这些不能代替下表两机/真值/规模要求。结果分为通过/失败/受阻/未执行，分别记录构建、真机和产品层级。每台记录 OS/硬件、包/commit、权限负责进程、触控板设置和 Codex/依赖版本；仅留脱敏计数、阶段与必要图证，禁止在公共日志留原文/凭证。

| 场景 | 最低样例及断言 | 对应规格 |
| --- | --- | --- |
| 真实采集与配对 | 两机各 ≥60min、20 次保持 ≥5s 的切换，≥19 次在 3s 内正确留证据；同应用对象变化也覆盖 | SC-001，FR-001、FR-002、FR-004、FR-006、FR-017 |
| AX/OCR | 20 个标注场景：完整、空、工具栏、超时、混合；中文准确性另记，失败仍看图 | SC-002，FR-003、FR-005 |
| 停止/恢复与 gap | 暂停、锁屏、睡眠、撤权、排除、重启各 3 次；迟到丢弃，排除不留正文，静态阅读不直接离席 | SC-003，FR-007、FR-010 |
| 导航和性能 | 30 天合成数据：100000 观察、10000 周期、1000 可控 blob；100 次定位和 20 次日/月切换，p95 ≤1s/≤2s；记录冷热缓存 | SC-004，FR-009、FR-011 |
| 独立更新发现 | 未注册文件的日报/周报/普通文档各 2 个不同更新实例；滚动/自动刷新/协作/同名不同目标对照；来源/实例可审查 | SC-005、SC-009、SC-012，FR-014、FR-018、FR-021 |
| A→B→A | A10min、B5min、A15min：A 一个实例 25min、B 一个 5min；跨 gap 不补计，新日期/目标及拆合修订重算 | SC-011，FR-020 |
| Worker 通用性 | 单次事件规则不改主分发；重复注册/重放/重试/重启，忽略/稍后保留；失败/禁用隔离，无直接写入 | SC-012，FR-022 |
| 原图 30 天 | 可控时钟：到期前/后、相同 blob 新观察、重复清理；旧 ID 不可读，有效文字/周期/报告不变；主动删除另测传播 | SC-008，FR-015 |
| 模型授权 | 未授权/开启/重启/关闭/缩范围，派发及提交双验；截图零自动上传，Codex仍逐次确认 | SC-010，FR-019 |
| 周期增强 | 12 个真值周期：Kim私聊/群聊/会议/文档各 ≥3，含同应用对象/主题切换及未知对照 | SC-013，FR-023 |
| 游标/月历/报告 | ≥10 位置标签、≥10 次连续跨层；月格时序和日报/周报/不存在状态；A→10s Kim→A 三段不丢 | SC-014，FR-008/024 |
| 三指专项 | 两 Mac 各 ≥10 次，真实信号、设置和日/月跨层；系统拦截记受阻，替代流程另记 | SC-015，FR-024 |
| 文档执行 | 日报/周报/普通文档各 ≥1 真实用例；当前格式、范围外字节、日期不重复、Claude禁用；业务SOP预览零真实请求 | SC-016，FR-012、FR-013、FR-025 |
| 故障与恢复 | 取消/超时/认证/无效提案/目标冲突各 ≥1；同 key 重试、rename 前后退出、核验/来源删除，不误报成功 | SC-006，FR-013 |
| 上游来源 | 固定文件100%校验、摘录许可/来源齐全；用户已授权复用 MemoryLane GPL 代码，保留原许可与改动出处；无 Rust/Pi 产品依赖 | SC-007，FR-016 |

后续文档 fixtures 需覆盖 UTF-8/BOM/CRLF、同名标题/日期、symlink、2MiB、目标身份变化及并发；进程 fixtures 需覆盖 4MiB 行/16MiB stdout/1MiB stderr、坏JSONL、无最终提案、绑定不符和取消迟到。写后异常只记录实际阶段并恢复，不盲回滚外部文件；这些测试尚未建立。

## 5. 交付记录

实施阶段在仓库验收资料中保存脱敏结果、复现步骤、测量分布和明确限制；实际用户数据不进 Git。两台 Mac 分别记录独立安装和恢复，不要求用户开发环境。P0/P1/P2 分开报告完成度；三指受阻、Codex能力不满足或普通文档未跑通须明确列出，不用其他样例代替。

当前宪法仍未制定，核对为 N/A；正式制定后重跑原则检查。受控单机已证明指定测试窗口的真实截图、AX/OCR 与活动入库；普通窗口覆盖层仍受阻，第二台 Mac、两机 60 分钟、实际应用中文质量和真实三指未通过。生产 reader、活动周期映射、报告持久化与主动删除已接通；T030 完整总结、worker/SOP、Codex 和文档写回仍未完成。MemoryLane 与 Screenpipe 的实际适配及后续候选见 [THIRD_PARTY_NOTICES.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/THIRD_PARTY_NOTICES.md)，复用时继续保留固定版本、许可和来源。
