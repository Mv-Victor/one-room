# One Room 复用记录

日期：2026-10-15。本文件记录实际源码采用范围和来源检查，不将小块迁入当作完整任务或产品验收通过。固定版本、SHA256 与许可证以 `specs/001-event-driven-capture/source-lock.json`、`licenses/` 和 `THIRD_PARTY_NOTICES.md` 为准。

| 来源 | 本地采用 | 调整与当前证明范围 |
| --- | --- | --- |
| MemoryLane v1.5.10，`f3157d54524e647d32f7decd186ee00cac9f72d5`，GPL-3.0-or-later；app-watcher.swift L22–79 | `native/WindowContext.swift` | AX 聚焦窗口/几何辅助；权限预检、CF 类型检查与窗口前后验证由本项目补充 |
| 同版本 app-watcher.swift L285–465 | `native/WindowListener.swift` | NSWorkspace/AXObserver 生命周期；加应用范围、JSONL、心跳和锁屏/休眠信号。实际触发与 TCC 边界仍需真机验证 |
| 同版本 screenshot.swift L87–115 | `native/WindowCapture.swift` | PNG 编码小块；改指定窗口单次截图、前后身份/可见性和 token staging。不是上游整套截屏器迁移或真机捕获验收 |
| 同版本 ocr.swift L28–54 | `native/VisionOCR.swift` | Vision 请求/结果小块；原图 token、中英 accurate、文字限额、结构化状态。准确性仍需真实文本样例 |
| 同版本 native-screenshot.ts L123–172 | `src/services/capture/helper-client.ts` | 子进程 spawn/stdin/error 生命周期；只读 hello/shutdown、严格身份、有界输出与超时 |
| 同版本 vendor-credentials-manager.ts L8–12、L123–133、L263–277 | `src/services/model/config-store.ts` | safeStorage 注入、base64 密文及解密；移除多 vendor、迁移、环境 Key、明文缓存和日志；不等同后台文字发送授权 |
| Screenpipe v2.2.243，`1b3e4186ec5a624b95a581c7187c1d48284bea9a`，MIT，不含 ee/；timeline-controls.tsx L145–173 | `src/renderer/timeline/TimelineControls.tsx` | 前后日导航与未来日期限制，使用本地上海日键 |
| 同版本 use-frame-loading.ts L314–351、L466–502 | `src/renderer/timeline/hooks/use-evidence-image.ts`、`use-contained-image-layout.ts` | 预载/取消、ResizeObserver/contain/RAF 清理；使用受控 evidence URL，gap 或失效时清图 |
| 同版本 use-scroll-zoom.ts L78–92 | `src/renderer/timeline/hooks/use-smooth-zoom.ts` | RAF 插值小块；时间跨度与 reduced-motion 适配。合成 wheel 或此 hook 都不证明物理三指手势可用 |
| 同版本 timeline.tsx L619–706 | `src/renderer/timeline/group-period-runs.ts` | 连续分组/flush 小块；加时间连续、对象/主题与 gap 条件，保留输入周期。B 的周期生成/汇总仍独立验收 |

Screenpipe 事件参数与 AX→OCR 判定的 SP-1/SP-2，以及图片预载 SP-3 为保留的原文研究摘录；Rust 引擎和 Pi 没有迁入运行时。当前实现仍采用 Electron/TypeScript 与小型 Swift helper。

本轮执行 `node scripts/verify-upstream.mjs --offline --json`：25 个锁定文件、3 段精确摘录、2 份原始许可证通过；新增凭据源文件 SHA256 为 `19aeb8f6685120f1401c8d771209a4c9a0d355187f5728805fc58c5b06c2911b`。所有列出的新增原生适配文件均有 GPL/固定 commit 注释，Screenpipe 辅助文件均有 MIT/固定 commit 来源注释。

来源检查不覆盖系统权限、真实截图与文本、两台 Mac 安装、性能、手势、Codex 或文档写回。T058/T063 及其他任务是否完成，由对应实现与验收证据另行判定；本次文档更新不增加完成勾选。

B 回顾模块补充：R1-R4 已用于当前时间线。新增 7 个工作回顾核心单测及 2 条 Playwright 流程验证连续分组、区间并集、取消/过期/删除清图、含 10 秒 Kim 的轨道比例、日月导航和窄窗；受控图片是合成 PNG。直接运行依赖的锁定版本与 license 表已追加 THIRD_PARTY_NOTICES.md。A已核对本轮新候选包：声明位于ASAR内，包外两份源许可与仓库逐字节一致；见package.md。此检查只证明来源随包存在，不证明完整产品验收。
