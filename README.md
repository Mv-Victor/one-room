# One Room

**让时间分配一目了然，让重复经验成为下一次行动。**

开源仓库：[Mv-Victor/one-room](https://github.com/Mv-Victor/one-room)。macOS Apple Silicon 测试包可从 [Releases](https://github.com/Mv-Victor/one-room/releases) 下载；测试包尚未做 Developer ID 签名与公证。

## 当前工程

2026-10-15：A 的记录识别链路已实现：前台事件、指定窗口截图、先落事实、AX 正文优先/本地 Vision OCR 回退、独立文字授权、模型配置/安全凭证和活动校正。保留 Electron/React/TypeScript、小型 Swift helper 与单 SQLite worker。

默认暂停采集、关闭模型文字分析；在设置中保存允许应用并授权系统权限后手动开始。日轴/月历已接真实读取，包含行为、对象、主题、连续周期摘要和正文检索；事实日报周报、主动删除已接生产 SQLite/main/preload，并通过持久化集成检查。SOP/Codex 保留 P1 依赖，完整 M0/P0 尚未完成。严格可见性会拒绝被浮层遮挡的窗口，本机普通桌面受到透明全屏工具窗影响，详见验收记录。

历史[线上原型 v0.2](https://one-room-workspace.modest-lamp-8884.chatgpt.site)仅为模拟体验，不代表桌面成品。

## 启动

开发环境：macOS 14+ Apple Silicon、Node.js 22.22.2、npm 10.9.7、Xcode Command Line Tools。

```sh
npm ci
npm run native:build
npm run dev
```

`npm ci` 会为 Electron 重建 SQLite 原生模块。开发服务器占用端口时 Vite 会选择空闲端口，以终端显示为准。仅看 UI 样例可打开开发地址并加 `?fixture=1`，该模式标记测试数据且不写本机历史；发布构建剔除 fixture 实现。

```sh
npm run check
npm run native:smoke
npm run verify:upstream
npm run test:e2e
npm run benchmark:navigation
npm run package:mac
node scripts/package-smoke.mjs
```

`test:e2e` 使用最近一次 `build` 产物；`check` 已包含构建和 Electron 内的数据库集成检查。打包产物为 `release/mac-arm64/One Room.app`，已完成本机启动/SQLite/helper/真实系统凭据加密复测，详见[包检查](docs/acceptance/package.md)。尚未做 Developer ID 签名、公证或第二台 Mac 安装验收。日常运行通过 Electron 的 `userData` 存储；测试使用独立临时目录。

`benchmark:navigation` 在隔离的 30 天/10 万观察库上检查 worker 与回顾服务，先执行 `build`；不包含浏览器图片解码和物理手势。测量见[性能记录](docs/acceptance/navigation-performance.md)。当前发布的是 `001-event-driven-capture` 实现，另一套 MemoryLane 基线尚未合并。

## 并行开发

A负责记录识别功能闭环：采集、AX/OCR、活动事件、模型配置/队列及对应UI；后续负责文档/Codex连接、输入/diff审核和应用核验。B负责时间回顾功能闭环：周期/查询、时间轴、缩放、月历、总结和报告及UI；后续负责实例、发现和Skill。package/lockfile、main注册与迁移入口由A合并，shared schema由B维护。具体入口、依赖和已验证范围见[开发交接](docs/DEVELOPMENT_HANDOFF.md)与[基座验收记录](docs/acceptance/gates.md)。

任务共64项，T064 已实现模型地址/模型名/API Key配置、安全保存/清除及合成连接测试。本地AX/UI树与Vision OCR无需API Key；Codex使用本机CLI登录，与摘要模型配置分开。连接测试成功不启用后台文字授权。M0仍29项，实际勾选与剩余门槛以任务和验收记录为准。

已实际适配 MemoryLane 的窗口定位/监听、截图编码、Vision OCR 与 helper 通信，以及 Screenpipe 的时间线辅助代码，保留固定版本与许可，见[第三方声明](THIRD_PARTY_NOTICES.md)。不需要 Rust 或 Pi。

## 开源许可

Copyright (C) 2026 One Room contributors. One Room 按 [GNU GPL v3 或更新版本](LICENSE)（`GPL-3.0-or-later`）发布。

MemoryLane v1.5.10 的 [GPL 原文](specs/001-event-driven-capture/licenses/memorylane-GPL-3.0.txt)与 Screenpipe v2.2.243 的 [MIT 原文及版权声明](specs/001-event-driven-capture/licenses/screenpipe-MIT.txt)完整保留。采用的源码、固定提交与改动说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；未采用 Screenpipe 的 `ee/` 企业版代码。第三方组件保留各自许可证。

| 文档 | 用途 |
| --- | --- |
| [PROJECT.md](PROJECT.md) | 愿景、优先级、比赛故事、成品标准与分工 |
| [MVP.md](docs/MVP.md) | P0/P1、任务ID、已实现/模拟/待验证状态 |
| [产品规格](docs/PRODUCT_SPEC.md) | 日轴/月历、周期、发现、Skill和执行状态 |
| [技术方案](docs/TECHNICAL_DESIGN.md) | 实体/IPC、分段、缩放、Codex adapter、文档事务与复用依赖 |
| [实现计划](docs/IMPLEMENTATION_PLAN.md) | 两位工程师按功能分工、依赖、联调与验收 |
| [边界决策](docs/BOUNDARIES.md) | 三指手势、首个文档connector、配券权限等默认边界 |
| [原型验收](docs/PROTOTYPE_ACCEPTANCE.md) | 当前测试与未验证能力 |

当前实施任务以 [tasks.md](specs/001-event-driven-capture/tasks.md) 为准；原型验收记录属于历史模拟范围。比赛提交须分别披露真实实现、开发 fixture、未验证能力及 AI 辅助。
