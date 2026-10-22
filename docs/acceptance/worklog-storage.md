# 工作回顾存储验收

日期：2026-10-15。当前生产 main/preload 已接入 timeline/cursor/calendar/report/history，单连接 SQLite worker 使用 schema 3。这里记录存储与领域服务检查，不表示完整产品、真实业务语义或双机硬件验收通过。

## 已执行

根检查 `npm run check` 已通过：TypeScript、ESLint、20 个单元测试，以及下面三组 Electron/SQLite smoke。所有样本使用独立临时目录与合成 PNG/文本，不读取真实桌面或调用外部模型。

| 入口 | 已验证范围 |
| --- | --- |
| `tests/integration/foundation-smoke.ts` | Electron SQLite ABI；WAL/FULL/FK/FTS5；事实、图片引用、来源、变更同事务；同图多观察；逐引用 30 天到期；共享 blob、重复清理；设置重启保留及重启暂停 |
| `tests/integration/capture-analysis-smoke.ts` | 新库与旧库升级；AX/OCR 分来源与 FTS；分析派发/提交授权复核；人工修订保留观察事实；活动映射、gap/查询裁剪、逐图过期与文字/活动保留；旧 generation 拒绝；重启授权保留、采集暂停 |
| `tests/integration/worklog-storage-smoke.ts` | 3 条观察聚合为 2 个连续周期，全部观察继续进入 report_sources；正文 FTS 与两字中文包含检索；完整上海日报保存、幂等重试与旧 revision 拒绝；人工校正使旧报告失效；图片到期仍保留报告；删除来源、正文、FTS、活动历史副本及报告快照；共享 blob 保留和最后引用清理；报告重启读取、删除回执跨重启重放与 key 冲突拒绝 |

## 事务边界

`worklog.read` 同事务读取 dataRevision、事实、缺口、图片状态、活动语义、正文匹配与报告状态。周期可以合并相邻观察，但保留逐观察证据身份和 displayUntil；游标不会跨缺口或借用另一观察的图片。活动只到已提交 endTs 或同一 session/generation 的下一观察，不延伸到当前时间。

报告生成固定完整上海日或周一开始的一周，忽略浏览器临时筛选。生成和保存都使用同一个 generatedAt/asOf，让开放 gap 在保存复核期间保持相同边界；该冻结不授予活动额外覆盖时长。保存时同时复核全局 sourceRevision、规范快照和来源关系。聚合周期的全部观察与选中文本、活动来源分别入表，图片自然到期不作为报告失效条件。

schema 3 持久化报告、来源关系、报告幂等身份、删除预览及删除回执。报告 get/receipt 检查来源版本；人工校正或删除后返回 invalidated 与空报告正文。删除时保留报告 ID、范围和失效元数据，清除快照内容。

历史删除先检查有期限预览和当前 revision，再在单事务内提升 source/capture/consent generation、失效类型化来源、清正文及搜索、清活动历史快照和持久周期索引、清关联报告副本。主进程取消模型队列并静止采集，事务后清理无有效引用的图片文件、完成回执并恢复采集。pending 状态可通过同一幂等请求重试；重复请求跨重启读取同一回执。

截图自然到期只失效该图片引用，保留文字、活动、周期及报告。主动删除把所选图片引用改为 deleted；存在其它有效引用时，共享 blob 不删除。两条路径已在上述合成存储检查中分别覆盖。

## 仍待验证

- 最新生产 Electron 报告/删除界面的完整操作链和截图，以 [timeline.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/docs/acceptance/timeline.md) 的实际记录为准；存储 smoke 不能替代 UI 检查。
- 导航基准已新增 `scripts/benchmark-navigation.mjs` 与 `tests/integration/navigation-benchmark.ts`，本记录尚不宣称已运行或达到 p95 门槛；即使通过也仅覆盖服务往返，不包括浏览器图片解码和真实三指手势。
- 普通应用与真实四类工作活动的语义质量、两台 Mac 的长期采集/权限/手势、schema 3 重新打包与第二机安装、Developer ID/公证仍按各自验收门禁推进。
- 报告不写外部日报/周报文件；SOP、Skill 与 Codex 的输入审核、diff 审核及文件事务不在这次存储验收范围。
