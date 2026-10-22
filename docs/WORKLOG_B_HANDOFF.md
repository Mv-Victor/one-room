# B 时间回顾模块交接

2026-10-15。生产时间线、游标、月历、报告和历史删除已接入 main/preload 与单连接 SQLite worker，当前数据库 schema 3。以下区分已实现链路与已执行检查，不代表 M0/P0 或完整真机验收通过。

## 已实现

- `periodizer.ts`：已确认的半开区间、gap 截断、跨日投影和真实区间并集；开放尾部不推算至当前时间。
- `queries.ts`：timeline/cursor/calendar 共用 `WorklogReader`，分页绑定范围、完整筛选和 revision；gap/筛掉的应用不借图，证据有独立 requestToken/displayUntil。
- `worklog-read.ts` / `summaries.ts`：同日、同 session/generation/window 且对象、主题、行为、依据、状态一致的连续观察合为周期，以首观察 ID 保持周期身份；全部观察继续分别保留，证据 displayUntil 不越过单次观察边界。活动语义和人工校正不会覆盖原窗口标题。
- 正文搜索：三字符及以上通过 FTS5 trigram 检索窗口标题和选中的 AX/OCR 正文，短中文通过本地包含匹配补足；命中的观察关联回所属聚合周期，覆盖统计仍基于全部事实。
- 时间线：图片预载/取消/contain，选择变化即清图，旧异步响应不回填；观察时间、未知对象/主题、短片段列表与放大、日期/当前/播放/平移/搜索/软件筛选和独立助手范围。
- `navigation.ts` / `MonthView.tsx`：5 分钟至全天、围绕游标缩放，全天额外一步入月，同手势不反复跨层；周一月格、密集日分页、窄窗逐日列表、日/周报告入口。接入按钮、ctrl/meta wheel 和受区域焦点/指针约束的 native swipe bridge，物理三指仍待验。
- `reports.ts` / `ReportView.tsx`：完整上海日/周一周范围持久快照，不继承浏览筛选；无模型结果或人工校正时保留对象/主题未知，外部目标单独保留空引用。生成与保存使用同一个 asOf/generatedAt 冻结开放 gap 的边界，避免两次读之间自然流逝的时间造成虚假来源冲突。
- `history-delete.ts` / `HistorySettings.tsx`：生产端使用 durable repository；预览、删除回执与幂等身份进入 schema 3，来源失效、正文/FTS/派生副本清理和 generation 变更在同一事务完成。
- 唯一 fixture 使用上述领域模块，不写生产库；示例报告和删除只存在当前内存会话。图片加载测试另用合成 PNG，不读取用户屏幕。

## 生产接线与所有权

1. `src/services/storage/worklog-read.ts` 在单一 worker 事务中返回 revision、周期、gap、全部 observation/evidence、正文匹配周期与报告状态索引；通过内部 `worklog.read` 调用，不向 renderer 暴露路径或连接。开放活动不延伸至当前时间，开放 gap 可延伸到读取时刻或报告固定的 asOf。
2. main 统一调用 `registerWorklogServices` 注册 timeline/cursor/calendar/report/history；preload 已暴露报告和历史领域方法。查询回复保留同一事务快照的 dataRevision。
3. `worklog-migration.ts` 的 schema 3 新增 reports、report_sources、report_receipts、history_delete_previews、history_delete_receipts。`worklog-commands.ts` 的报告保存重验 sourceRevision 和完整规范快照，并关联聚合周期内全部观察及文字、活动的类型化来源；不是只关联首观察。
4. 报告 get/receipt 会重验来源版本，人工校正使旧报告失效；删除时清快照正文并返回 `invalidated/report:null`，保留报告元数据。图片来源不进入事实报告的依赖关系，逐图 30 天自然到期不清文字、活动或报告。
5. 主进程在删除预览前持久暂停采集，取消模型任务并等待在途工作收敛；worker 事务重验预览 revision，提升 source/capture/consent generation，清观察标题、文字、活动历史版本、FTS、持久周期索引及关联报告副本。事务后只清无有效引用的 blob，共享图片仍可读；pending 回执支持重试完成清理。取消预览或清理后仍保持暂停，用户可在采集设置中恢复。
6. `report.get/generate` 返回本地报告，不写外部文档。删除通知包含 `source.invalidated`、`timeline.changed`、设置/采集及报告更新；截图自然到期仍使用独立 `evidence.expired` 路径。

共享入口、迁移总表、main/preload/package 继续由 A 单写；B 可独立维护回顾查询、周期/UI、报告、后续发现/Skill。未注入 reader 的独立调用仍保留 `WORKLOG_READER_NOT_CONNECTED` 保护。fixture 的报告/删除使用内存 repository，生产端使用持久 repository，两者不共享数据库。

## 验证与预览

本轮根检查 `npm run check` 通过：typecheck、lint、20 个单元测试，以及三组真实 Electron/SQLite worker smoke（基座/证据、采集文字分析、工作回顾存储）。这些数据库使用隔离的合成样本，不是用户屏幕历史。存储细项见 [worklog-storage.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/docs/acceptance/worklog-storage.md)。

```sh
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e -- tests/e2e/timeline.spec.ts
npm run verify:upstream -- --offline
```

UI 测试使用本机 Chrome，自动启动/关闭 5185 的独立 Vite；受控图片测试启动无采集的临时 Electron 窗口。桌面 1440x1000 / 窄窗 390x844 截图在 `artifacts/acceptance/b-*.png`，不入 Git。已检查轨道比例、短片段选择、过期/gap/迟到/删除清图、日月恢复、完整报告和窄窗无横向溢出。

本次预览服务：`http://127.0.0.1:5175/?fixture=1`，仅隔离开发示例。正常 Electron 路径继续使用桌面 bridge。

新增联调已验证：聚合后全部观察来源、三字符以上正文 FTS/两字中文检索、报告保存/版本复核/人工校正失效、报告重启读取、删除回执跨重启重放、正文和历史副本清理、共享 blob 保留及最后引用清理。动态 gap 使用 asOf 冻结，活动尾部仍不按墙钟增加时长。本机候选包和原生验证的历史范围以 package.md、capture.md 为准，旧 schema 2 包的检查不能替代 schema 3 新包检查。

生产空历史报告生成/重启/删除 bridge 已有 E2E 记录。30 天/10 万观察导航基准的 worker/服务层通过，定位 p95=40.57ms，日/月查询 p95=1172.74ms，详细机器与缓存口径见 [navigation-performance.md](acceptance/navigation-performance.md)；不包含浏览器解码或物理手势，T035 整体仍待。尚未验：真实捕获后的非空时间线→报告→删除完整生产 UI 主链、普通桌面应用与双机三指、四类真实业务活动语义质量、完整界面性能、第二机安装及比赛材料；最新本机包结果见 package.md。SOP worker、Skill、Codex 执行和后续 P1/P2 仍按既定依赖推进。
