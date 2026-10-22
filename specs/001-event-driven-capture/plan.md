# Implementation Plan: 时间分配一目了然与可复用 SOP

**Branch**: `001-event-driven-capture` | **Date**: 2026-10-15 | **Spec**: [spec.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/spec.md)
**Input**: `/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/spec.md`

**Status**: 基座及A的采集、AX/OCR、模型配置/独立授权/队列与活动校正已有实现，单机受控窗口真实链路通过；B时间回顾正在并行接入，普通桌面覆盖层及双机验收仍待补。完成状态见tasks.md和docs/acceptance/gates.md；历史原型和上游编译不计One Room运行验收。

## Summary

用独立 Electron + React/TypeScript 工程交付 macOS 个人工作时间记忆。小型 Swift helper 提供窗口事件、获准可见窗口截图、AX 正文和 Vision OCR；先保存证据与事实，再异步总结。主体验为 Screenpipe 式带文字游标的真实时间轴、四类周期总结、自动日/月缩放和日报周报入口；已采到的短切换保持独立连续片段，不设 30 秒合并规则。

逻辑工作实例允许 A→B→A 续接，检测 worker 自注册并只生成提示。其次覆盖日报/周报/普通文档更新 Skill，经输入确认调用本机 Codex 生成结构化提案，人工看差异后由应用写回核验。最后交付配券/策略检测与预览，不真实发券投放。Claude 可见但禁用。用户已允许自用项目直接适配MemoryLane GPL代码，和Screenpipe MIT一并保留出处/许可；不引入Rust或Pi。

依据：[research.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/research.md)、[data-model.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/data-model.md)、[逐项对照](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/checklists/product-alignment.md)。

## Technical Context

**Language/Version**: TypeScript 5.9.3; Swift 5 language mode; build Node.js 22.22.2 and npm 10.9.7
**Primary Dependencies**: Electron 42.11.14, React 18.3.1, electron-vite 5.0.0, Vite 7.3.7, electron-builder 26.15.3, better-sqlite3 12.11.1, Zod 4.1.13, diff 8.0.4
**Storage**: SQLite 3.53.2 with WAL, FTS5 and synchronous FULL; private screenshot blobs and per-observation expiring evidence references
**Testing**: Vitest 3.2.7; Playwright 1.64.1; Swift helper fixtures; two-Mac packaged acceptance
**Target Platform**: macOS 14+ Apple Silicon; Swift deployment target 14.0; developer Xcode Command Line Tools; end user requires no compiler
**Project Type**: desktop-app
**Performance Goals**: SC-001: each Mac 19/20 stable switches captured within 3s; SC-004: local positioning p95 <=1s, month p95 <=2s; screenshot persistence does not await OCR/model
**Constraints**: no Rust; local-first evidence; screenshots expire after 30 days without deleting text/history; separate persistent text-analysis consent; Codex CLI 0.144.1 capability gate and per-run input/diff approval; no real coupon/strategy writes
**Scale/Scope**: one local user/database per installation; two target Macs independently installed, no sync; 30-day navigation benchmark with 100000 observations and 10000 periods, not a retention cap on text/history

React DOM 同为 18.3.1，React Vite plugin 4.7.0。Electron 内嵌 Node 24.19.0 / ABI 146，与开发 Node 不同；当前固定组合已安装，并已在 Electron arm64 内实际加载 SQLite、打包启动和关闭。支持分支升级、原生重建和许可证审计随版本维护，不把固定版本视作长期免维护版本。

## Constitution Check

读取了 `/Users/huangzhidong/work/one-room/tianmu-hackthon-15/.specify/memory/constitution.md`：仍为未填写模板，无批准日期或有效原则。**宪法核对为 N/A（未制定），不是 PASS，也不虚构豁免。** 本轮不替用户制定宪法；未来正式制定后须重检。该模板未定义当前必须失败的门禁，规划继续。

以下检查来自用户已确认的项目与功能规格，不冒充宪法条款：

| 约束 | Phase 0 前核对 | Phase 1 后复核 |
| --- | --- | --- |
| P0 时间分配优先，文档 SOP 次之，配券/策略后序 | 明确 | 阶段和 SC 映射保持此顺序 |
| 独立 TS/Electron、小型 Swift，无 Rust；允许 MIT/GPL 源码适配 | 用户实施前更新 | 单工程、固定来源、完整许可及改动声明保留 |
| 可见获准窗口、AX 优先/OCR 补充、事实先存 | 明确 | 原生身份/可见性/失败状态，异步文本与模型 |
| 30 天仅删截图；手动删除传播来源失效 | 明确 | 每观察 Evidence、独立 blob、source generation/清理事务 |
| 后台模型与 Codex 单次授权分开 | 明确 | 派发/提交双检查，输入和差异各确认，撤销丢迟到 |
| A→B→A 同实例，通用 worker 不直接写入 | 明确 | 关联修订、distinct instanceId、状态/去重事务 |
| Codex 只提案，应用审核写回；Claude 禁用 | 明确 | 能力 gate、schema、hash/operation 恢复 |
| 三指必须真机；替代控件不算专项通过 | 明确 | BrowserWindow swipe 先行验证，两机 SC-015 独立记录 |

设计核对无需要例外的冲突；本机基座运行检查已执行，G1 部分通过，G2/G3/G4 和完整产品验收仍未通过，具体见 docs/acceptance/gates.md。

## Project Structure

### Documentation (this feature)

```text
/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/
  spec.md
  plan.md
  research.md
  data-model.md
  quickstart.md
  contracts/
    desktop-ipc.md
    ui-behavior.md
    native-helper.md
    discovery-worker.md
    codex-document.md
    proposal.schema.json
  source-lock.json
  code-excerpts.md
  licenses/screenpipe-MIT.txt
  checklists/requirements.md
  checklists/product-alignment.md
```

`tasks.md`已生成并记录实施进度；两人并行入口见docs/DEVELOPMENT_HANDOFF.md，依赖与验收以本计划和spec及用户最新范围为准。

### Source Code (repository root)

以下为单工程布局，基座已创建，业务模块按tasks继续：

```text
/Users/huangzhidong/work/one-room/tianmu-hackthon-15/
  package.json
  package-lock.json
  electron.vite.config.ts
  electron-builder.yml
  src/
    shared/       contracts.ts, schemas.ts, errors.ts
    main/         app.ts, ipc.ts, permissions.ts, preload.ts
    services/
      capture/    coordinator, authorization, helper-client
      evidence/   store, retention, controlled-protocol
      worklog/    periodizer, summaries, instances, reports, queries
      discovery/  host, registry, document-update, sop-sequence
      skills/     drafts, versions, export
      documents/  local-markdown, snapshots, operations
      agents/     codex, capability-check, runs
    workers/      database.ts, model.ts, discovery.ts, codex.ts
    renderer/     timeline, calendar, reports, discoveries, skills, runs, settings
  native/         Swift helper sources and developer build entry
  resources/      signed helper binaries, app icon, local UI assets
  scripts/        native-build, contract-check, fixture generation
  tests/          fixtures, unit, contract, integration, e2e
```

**Structure Decision**: 沿用现有责任边界，不拆前后端服务或第二套采集产品。renderer 无 Node/FS/SQL/凭证/进程权限；preload 仅白名单领域方法，main 校验 sender 和 payload。数据库 worker 独占 SQLite；模型、检测和 Codex 使用有界后台执行单元，避免同步计算堵 UI。Swift 事件监听与可终止提取执行分离，随同一个安装包分发；逻辑检测 worker 不等于每条规则一个 OS 进程。

## Phase 0: Research

已保留固定上游源码和摘录，追加运行时/ABI、数据库耐久、原生可见性与三指、时间投影/报告、实例/worker、Codex、文档事务、门槛八项 Decision/Rationale/Alternatives；没有待用户回答的技术选项。见 [research 第 7 节](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/research.md)。

未运行的验证按下表执行，不等同于未作出架构选择：

| Gate | 实施前/首个纵向闭环的证据 | 失败结果 |
| --- | --- | --- |
| G1 Native/package | Electron ABI146、SQLite/FTS5/WAL、签名 helper、第二台安装 | 阻断正式采集包，不拿开发 Node 或上游编译替代 |
| G2 Capture/visibility | TCC、前台配对、遮挡/屏外判定、中文 AX/OCR、暂停恢复 | 对应观察丢弃或 gap；授权内可 OCR 降级，不回退全屏/隐藏正文 |
| G3 Gesture | 两 Mac 原始 swipe 信号/系统配置、各 10 次放大缩小及日月跨层 | 三指专项受阻；备用可用仍不能计通过 |
| G4 Codex | 0.144.1 参数/认证、合成材料、禁额外工具、schema/取消/超时 | capability_blocked，不发业务材料、不放宽权限或换普通模型冒充 |
| G5 Document | 读取现文、范围外字节、独占编辑、冲突和写后恢复 | 不支持/冲突/仅导出补丁，不覆盖或假成功 |

## Phase 1: Design And Contracts

数据结构、状态与事务见 [data-model.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/data-model.md)。接口按所有权拆分：

| 契约 | 内容 |
| --- | --- |
| [Desktop IPC](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/desktop-ipc.md) | 白名单方法、revision、分页、订阅恢复、授权与删除 |
| [UI 行为](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/ui-behavior.md) | 游标/图片一致、窄片段、日月状态机、手势、报告与 Agent 状态 |
| [Native helper](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/native-helper.md) | JSONL、身份/可见性、分阶段捕获提取、权限与超时 |
| [Discovery worker](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/discovery-worker.md) | 自注册、受限上下文、事务游标、去重/抑制与失效 |
| [Codex/document](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/codex-document.md) | 能力门槛、双重确认、Proposal、字节级更新与恢复 |
| [Proposal JSON Schema](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/contracts/proposal.schema.json) | 最终结果约束，应用仍独立校验业务规则 |

开发与验证入口见 [quickstart.md](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/quickstart.md)。本轮运行 update-agent-context.sh codex 同步 AGENTS.md，记录规划栈与限制，默认命令不代表当前工程已存在。

## Phase 2: Delivery Sequence

此处定义纵向交付与依赖，细项由 `$speckit-tasks` 生成。按功能闭环分工：A负责记录/识别（采集、AX/OCR、活动、模型配置/授权/队列及对应UI），后续负责文档/Codex及输入/diff审核执行；B负责时间回顾（周期、查询、时间线/月历/报告/总结及UI），后续负责实例/发现/Skill。main与迁移由A合并，共享DTO由B维护，真值/第二台/材料由两人分担，不假定额外PMO。先共定契约和隔离fixture，再按阶段解锁，P1不代替P0验收。

T064模型配置、T021文字模型队列及T020活动校正已完成核心实现，并接入基于同一事务快照的时间线查询。配置读取仅返回hasCredential，合成连接测试不授予后台文字发送权限；本地AX和Vision OCR无需API Key。Codex沿用本机CLI安装/认证，不复用摘要模型凭证，仍属尚未开始的P1。任务共64项，M0仍29项；完成勾选及真机限制见tasks.md。

| 阶段 | 交付与依赖 | 退出条件 |
| --- | --- | --- |
| 0 基线 | 单工程、preload、schema、DB、helper/client、版本和 gate spike | G1/G2 有真实最小结果，G3/G4 各有可用/受阻证据 |
| 1 P0 事实时间线 | 前台事件、截图先存、AX/OCR、gap、带标签游标和真实时间映射 | SC-001/002/003/004/008/009/010，图片与文字失败分别可见 |
| 2 P0 回顾 | 四类周期、自动日月切换、月格顺序、完整日/周报告、两机手势 | SC-013/014/015，含 10 秒插入与未知对照；核心未过如实披露 |
| 3 P1 文档 SOP | 实例/关联修订、三类文档 worker、去重、Skill、目标读取 | SC-005/011/012 的文档及扩展部分，无需预注册文件发现 |
| 4 P1 复用 | G4/G5 通过后接 Codex，输入确认→提案→差异确认→应用核验 | SC-006/016 三类文档真实闭环；Claude 禁用，失败/冲突不写 |
| 5 P2 业务 SOP | 三个不同有序实例、变量/审批/草稿和预览 | SC-012/016 业务部分，不发真实业务请求 |
| 6 交付核验 | 依赖/许可、来源指纹、打包/第二台恢复、指标与限制 | SC-007及所有承诺故事，P0/P1/P2 分别披露 |

比赛日期沿用项目文档，执行时按实际剩余工时重排，不把文档时间节点当作已完成事项；到期有缺项则记录未完成，不降格定义验收通过。

## Verification Strategy

1. 契约与纯函数：状态机、schema、半开区间、投影、缺口、短活动、实例关联及 distinct 计次；不写镜像实现的低价值测试。
2. 集成：SQLite 事务/迁移/故障、来源删除与图片到期区分、共享 blob 引用、授权撤销各时点、worker 重放/升级/禁用、文档冲突/幂等/崩溃恢复。
3. UI：Playwright 检查桌面 1440×1000 和窄屏 390×844 的标签、密集月格、控制状态，100 次定位及 20 次日月切换；合成数据明确标识。脚本派发手势只验逻辑。
4. 真机：两 Mac 各至少 60 分钟、20 次稳定切换，四类周期各 3 个真值、三指各 10 次、三类文档至少各 1 个真实复用用例；记录 OS/硬件/设置、权限归属、Codex 版本与失败结果。
5. 性能：30 天、100000 观察、10000 周期和 1000 可控图片 blob 的标注数据集验 SC-004；记录机器、冷热缓存及分布，不将此规模当作保留上限或任意负载承诺。CPU/内存/耗电测量披露，不虚构未规定阈值。

当前只验证规划文件、链接、schema JSON 与一致性；实现检查均待后续开发，不在本轮声称通过。

2026-10-15 规划校验结果：16 份 Markdown 的围栏与 60 个本地文件链接有效，3 个 JSON 示例可解析；Proposal 八字段示例满足当前 schema 所用约束，4 个无效反例被拒绝（不代表 Codex CLI 子集兼容已通过）。25 条 FR 和 16 条 SC 均映射至 quickstart 验收；无计划占位或空白错误。上游 24/24 文件指纹及行数、3 段摘录和 MIT 许可副本一致。已运行 agent-context 脚本并补充 AGENTS.md 的当前状态；未配置 before/after_plan 扩展 hook，未生成 tasks.md。

## Complexity Tracking

没有需要豁免的有效原则冲突。单数据库 worker、有界后台执行和 Swift helper 由 UI 响应、平台权限和可终止提取需求直接产生；不引入第二数据库、微服务、向量平台、外部 worker 脚本或通用自动化引擎。宪法未制定状态已显式披露。
