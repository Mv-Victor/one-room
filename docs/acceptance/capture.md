# 采集链路验收记录

2026-10-15，macOS 15.6.1 arm64 单机开发环境。以下使用自行创建的 Cocoa 窗口 `local.one-room.native-fixture`，只允许该 bundle ID；没有采集其他应用窗口，后台文字分析关闭，模型请求为零。临时数据库、截图和进程在结束后清理。

## 此前已通过的核心链路

执行入口：

```sh
npm run native:build
npm run build
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron out/main/nativeCaptureSmoke.js
```

生产 `NativeSession` 使用共享 Zod schema 解析真实 helper 输出，验证 hello、frontmost、指定窗口预检、截图、AX、OCR 及 listener 初始窗口事件/心跳。窗口标题在 frontmost 返回中为空；显式匹配窗口后才执行采集和提取。截图字节数和 SHA-256 均匹配；AX 正文完整，Vision OCR 同时识别测试窗口中的中文与英文。

随后使用生产 `CaptureCoordinator`、SQLite worker、`EvidenceStore` 和独立临时 userData，实际提交 1 条 observation、1 份 evidence、1 条 activity。活动选用 accessibility 文本且带来源引用，保存截图的哈希复核一致；所有观察的 bundle/pid/window ID 均匹配测试窗口。分析状态为 `not_authorized`，模型调用数为 0。暂停成功，关闭并重新打开数据库后，应用范围、关闭的文字授权、暂停状态和记录数量保持一致。

测试入口为 `tests/integration/native-capture-smoke.ts`。另有 `node scripts/native-smoke.mjs --fixture`，验证原生 JSONL 链路；该原生测试不替代以上生产 TypeScript/Zod 验证。

## 2026-10-15 扩展验证历史

同日新增普通层级、自建覆盖层、屏外/最小化、三个独立应用 AX/OCR 和真实采集接工作回顾/报告/删除的验证代码。下表保留当时实际执行结果；当时扩展脚本尚未完整通过，不将前述旧闭环扩大为新报告/删除链路已通过。后续重跑见下节。

| 检查 | 实际结果 |
| --- | --- |
| NativeSession 协议核心 | 使用独立 JSONL 子进程实际通过：`accepted` 等待终态、150ms 超时结束进程、16 个在途上限、错误 generation 拒收。此项不采屏 |
| 自建可见性负例 | 在锁屏前已通过不透明覆盖层、逐像素透明但整体 alpha=1 的覆盖层、屏外、最小化、拒绝后无暂存 PNG；整体 alpha=0 的覆盖层可通过预检。没有按 owner 或层级绕过 |
| 普通层级正例 | 未通过；本机既有覆盖层仍存在，一次预检还遇到 `CONTEXT_CHANGED`，保留实际阻断，未记为普通窗口采集成功 |
| 输入时序 | fixture 使用 `CGEvent.postToPid`，仅向自身投递固定事件类别；系统允许投递，但 helper 全局 NSEvent monitor 未观察到 click/typing_pause/scroll_stop。未改为全局键盘注入，此项不能证明全局监听或真实硬件输入正常，T014 保持未完成 |
| 锁屏 | 随后机器真实锁屏，helper 拒绝 `SCREEN_LOCKED`；只读复核为 `CGSSessionScreenIsLocked=true`、`onConsole=true`、前台 `com.apple.loginwindow`。测试没有调用锁屏、睡眠或解锁操作。这只证明一次锁屏拒绝，不等于完整生命周期矩阵 |
| 三应用 AX/OCR、新工作回顾链路 | 代码已补，因锁屏尚未运行完成：三个 bundle 的 complete/empty/thin 对照，以及 capture→timeline/cursor→日报→重启→删除/报告失效/截图清理，均待重跑 |
| 静态与构建 | 新 helper `native:build`/ad-hoc 签名、Swift fixture typecheck、TS typecheck、定向 ESLint、diff check 通过。失败退出后已核对无本次 fixture 进程残留 |

安全修复包含：AX 明确报告上下文变化、不可见、锁屏/睡眠或权限失败时不再降级 OCR；NativeSession 不把 `accepted` 当完成，增加在途和消息限额；helper 对未知 cancel 不积累状态；listener 检查当前睡眠与输入授权。代码修复不替代尚未执行的真实权限撤销/睡醒/恢复验收。

公共系统元数据不能证明整体 alpha=1 的窗口逐像素透明。SDK `CGWindow.h` 将 `kCGWindowAlpha` 定义为整体 alpha fade，`SCWindow.onScreen/active` 也不证明无遮挡。锁定 Screenpipe 的按层级/名称过滤以及 MemoryLane 的显示器全屏捕获不满足本项目范围；当前继续保守阻断，没有读取真实覆盖工具的图像来探测透明度。

## 2026-10-16 扩展链路重跑

同一台 Mac 执行 `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron out/main/nativeCaptureSmoke.js`，进程退出码为 0，输出 `status: passed`。脚本在运行时重新编译并 ad-hoc 签名 Swift fixture。OCR-only fixture 原先仍暴露标题栏静态文字，返回 `thin`；清空该模式的窗口标题后，实际 AX 返回 `empty`。未放宽 helper 的可见性、上下文或权限检查。

| 检查 | 本次实际结果 |
| --- | --- |
| 协议与原生链路 | hello/schema、前台身份、截图 SHA-256、listener 事件/心跳通过；`accepted` 等终态、150ms 超时结束进程、16 个在途上限、错误 generation 拒收通过 |
| 三个隔离 fixture 应用 | `local.one-room.native-fixture` 的 AX 为 `complete`，`.ocr-only` 为 `empty`，`.thin-ax` 为 `thin`；三个窗口的 Vision OCR 均识别中文和英文。这是自建测试窗口对照，不代表三个真实业务应用的提取质量已验收 |
| 可见性负例 | 不透明覆盖层、逐像素透明但整体 alpha=1 的覆盖层、屏外、最小化、切换应用后的旧窗口身份均拒绝，且不留下暂存 PNG；整体 alpha=0 的覆盖层通过预检 |
| 普通层级窗口 | 仍以 `VISIBILITY_UNVERIFIED` 阻断，未记为普通窗口采集成功 |
| 真实采集与工作回顾 | 生产 coordinator 实际保存 1 条 observation、1 份 evidence、1 条 activity；AX 优先、截图哈希、获准 bundle/pid/window ID、时间线与游标证据通过，模型调用数为 0 |
| 报告、重启与删除 | 日报生成并包含真实采集周期；数据库重启后记录数量、暂停状态、关闭的文字授权及日报保持；删除使日报失效、时间线与活动清空、截图不可读、图像文件清除，清理回执为 `complete` |
| 输入时序 | `directedPostPermitted=true`，但 `monitorObserved=false`；仍未观察到全局 click/typing_pause/scroll_stop，未证明物理硬件输入正常 |

本次范围仅为单机、自建 Cocoa fixture 和独立临时数据；临时数据库、截图及进程由脚本清理。新加的精确空 AX 文本断言与错误诊断已通过定向 ESLint，本次执行使用的现有构建已包含相同的 `empty` 完整度断言；新增断言本身待下一次 TypeScript 构建执行。锁屏/睡眠/权限撤销矩阵、第二台 Mac、Developer ID/TCC 身份和物理三指仍未由本次重跑证明。

## 环境限制与未完成项

本机存在 Firezyl 全屏 layer 25、Dock 全屏 layer 20 等覆盖层。普通窗口会被严格可见性检查以 `VISIBILITY_UNVERIFIED / preflight_overlay` 拒绝；没有为这些覆盖层增加绕过规则。隔离测试窗口使用 `.screenSaver` 层级并避开鼠标位置，使实际待采集窗口完整可见。因此本次成功不能证明当前覆盖层环境下普通桌面应用可采集。

T016 保持未完成：尚未执行第二台 Mac、两机各 60 分钟持续运行、SC-001/003 真值样本与延迟统计。Developer ID/TCC 责任归属、发布签名/公证、第二机安装、真实输入时序和真实三指信号也未由本次验证证明。实际应用 AX/OCR 质量对照及完整 P0 语义验收需后续补齐。
