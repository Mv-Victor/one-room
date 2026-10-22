# SOP Discovery and Agent Execution

## 通用行为 SOP 与本机自动操作

当前交付扩展了原有文档流程，旧版验收记录保留在下方。

- 识别范围：通用编辑、筛选、导出、上传、发送等操作，不再要求包含日报、周报或策略关键词。
  ML 读取真实 MemoryLane sightings/cluster 配方；两分支共享有序步骤匹配及跨应用操作序列探查器。
  模型同义归并依赖现有语义分析/上游聚类；本地序列规则不是通用视觉 Agent，不能声称识别任何相似行为。
- 独立实例必须有事实来源。交叠证据、同一对象短时间切换返回和被动浏览不作为额外实例。
  确认候选后可选择本机流程；公司文档 Codex 执行仍受本分支现有能力门禁限制，Claude 仍置灰。
- 真实引擎为 `openadapt-flow[browser]==2.0.0`。不是模拟 Agent，也不是坐标脚本示意。
  用公开的 InteractiveRecorder、compile_recording 和 replay 入口，保留其 DOM/视觉定位与失败停止行为。
- 录制打开 One Room 独立浏览器配置目录。用户先登录，再点击“开始记录操作”；普通桌面采集不新增键盘/剪贴板监听。
  录制是单独明确授权的浏览器输入及截图采集。不要录制登录或敏感字段，密码与声明敏感字段沿用上游遮罩，含秘密参数的流程拒绝发布。
- 发布锁定录制文件及所有定位素材的 SHA-256；更改素材必须重新录制、发布新版本。
  运行只能替换声明参数，不能任意替换目标页面。录制与执行串行，不共享个人 Chrome 配置。
- 点击复用后填写参数并确认执行。没有结果核验接口时，即使重放完成也只报告“结果待核验”。
  配置同源只读 JSON 接口及 JSON Pointer / 参数映射后，比较执行前后的实际状态；只有完整重放且回读匹配才报告成功。
  初始状态已经满足全部条件时不执行，返回“无需修改”。回读失败、中断或结果不符不自动重试写入。
  “核验实际结果”只执行 GET，读取上次运行请求，不会重放操作。
  没有核验接口的本机流程可由用户检查实际系统后点击“人工核验”；记录为“已人工核验”，不冒充自动核验成功，并释放目标运行锁。
- 所有工作流、浏览器会话、截图、参数与回执留在本机用户数据目录 `agent-runs/workflows/`。
  本地流程引擎不需要 Codex 登录，不发起 OpenAdapt Cloud 或模型请求。涉及公司系统的授权仍由用户和原系统管理。
- 当前自动操作仅覆盖浏览器单个页面/同源导航。跨多个原生 Mac 应用、自动处理验证码和任意弹窗未实现，不能用本地表单验收代替这些能力。
  公司策略/配券生产写入不在本次授权和验收范围，原策略预览保持不变。

### 本轮追加验收（2026-10-16）

本轮新增的流程录制、SOP 发布、参数执行和人工核验已使用中文。ML 的侧栏、采集控制、活动记录及行为模式常用状态也已中文化；原有部分高级配置仍保留英文，不宣称全量汉化。

- ML 离线回归：1,652 项通过、34 项跳过；继续排除依赖缺失模型素材的两个 embedding 测试文件。这不是无限制全套测试通过。
- 001 合并同事最新文档、报告及时间线集成提交后：93 项单元测试通过、1 项真实引擎测试默认跳过；数据库工作线程及文档运行集成冒烟通过。
- 共享复用模块在显式启用真实引擎后：37 项通过，包含实际 OpenAdapt 录制、编译、参数化执行、只读回读、目标已满足时不写入、后台拒绝写入时不假报成功，以及取消前置保护。
- 两分支均通过真实打包 `.app` 验收：独立 Python / Chromium 启动、7 步录制、中文参数自动写入实际本机表单并回读、无接口时保持待核验、显式人工确认不重放、应用重启后版本与回执仍在。
- 原有桌面 SOP 验收仍通过：受控来源驱动主动提示、候选确认、非法目标拒绝、不可变版本、策略预览、Claude 置灰、最小宽度布局和重启持久化。
- 001 额外覆盖历史删除：执行中拒绝删除关联来源，停止后清理关联版本和新旧运行目录，不删除无关记录。
- 类型检查、两分支打包、001 全量 lint 和 ML 本次修改代码 lint 通过；ML 存在原有 SQLite 导入警告。

上述自动操作只发生在隔离的本机 HTTP 表单，没有公司文档或后台写入。候选验收使用受控事实，不能代替真实 OCR、语义质量、跨原生应用、第二台 Mac 或签名公证验收。Codex 登录与公司文档真实执行仍按用户要求跳过。

中文使用步骤见 [本机流程使用指南](LOCAL_WORKFLOW_GUIDE.md)。打包验收脚本为 `scripts/verify-workflow-desktop.mjs` 和 `scripts/verify-sop-desktop.mjs`，截图与 JSON 回执保存在忽略的 `.desktop-acceptance/`。

### 构建与验收

开发构建先准备运行时（Apple Silicon Mac，需要构建机安装 uv）：

```sh
npm run workflow:prepare
```

该命令将独立 Python 3.12、锁定的 Python 包、Chromium 和本机桥接代码放到忽略的
`build/openadapt/`。electron-builder 将它们作为 extraResources 放入 `.app`；最终用户无需另外安装 Python、pip、OpenAdapt 或浏览器。
运行时包含依赖原始 dist-info 许可文件。未准备运行时的应用不会伪报引擎已连接。

真实本机引擎验收使用 `src/services/reuse/workflow.integration.test.ts`，显式设置
`ONE_ROOM_WORKFLOW_INTEGRATION=1` 和 `ONE_ROOM_PLAYWRIGHT_MODULE`，在隔离 HTTP 表单及本地存储上记录并执行真实点击。
无公司文档或公司后台写入。Codex 登录与真实公司文档验收按用户要求继续跳过。

The discovery and workbench modules adapt the shared `ml-one-room` implementation.
Integration adapters and activation gates differ because the applications have
different capture schemas and execution contracts. Do not merge the entire
applications to synchronize this feature.

## Extensible Reminder Workers

`WorkerRegistry<TFact, TFinding>` is the generic, local host. Rules register
themselves through `register({ id, version, evaluate })`; registration returns
an unregister function. A host-owned validator checks findings. Each evaluation
receives at most 5,000 structured-cloned, recursively frozen facts. A worker can
emit at most 100 findings; exceptions and invalid findings are isolated, with
worker identity/version attached to accepted results.

Example of a non-SOP reminder (not enabled as a product feature):

```ts
const reminders = new WorkerRegistry<Task, Reminder>((finding, facts) =>
  facts.some((task) => task.id === finding.sourceId),
)
reminders.register({
  id: 'overdue-task',
  version: 1,
  evaluate: (facts) =>
    facts
      .filter((task) => task.overdue)
      .map((task) => ({
        sourceId: task.id,
        title: task.title,
      })),
})
```

`DiscoveryRegistry` specializes this host for SOPs; built-ins register document
and strategy detectors. Future reminders can use different fact/finding types
without depending on Skills, the document executor or strategy configuration.

These are trusted shipped synchronous rules, not arbitrary downloaded plugins.
They are not sandboxed OS workers, and a hung trusted rule cannot be interrupted.
Untrusted or asynchronous rules require a process host, deadline and cancellation
protocol before support can be claimed. On 001 the adapter already executes in
the existing SQLite worker; ML uses the existing application service. Neither
rule receives a DB handle, model credentials or an execution API.

## Currently Implemented

- Daily, weekly and ordinary document updates: group by normalized corporate
  Docs URL, falling back to an observed object label when no URL is available.
  A real target URL and source/scope must be confirmed before saving a Skill.
- Coupon/strategy operations: reuse upstream cluster recipes when available;
  otherwise require at least two normalized ordered steps, shared app context
  and at least 75% ordered-step similarity.
- Count independent task instances, not screenshots. Merge same-object returns
  within 30 minutes on the same Shanghai day. Different strategy objects may
  repeat within minutes. Viewing-only and unsupported recipes are excluded.
- ML combines upstream sightings/cluster membership with the live period
  adapter, so discovery need not wait for the nightly task miner. 001 consumes
  non-deleted activity/capture rows. Detection is local and does not upload OCR.
- Candidate persistence preserves user status and prunes findings whose sources
  no longer qualify. Starting a saved candidate-derived Skill refreshes detection;
  missing candidates prevent execution.
- A global in-app notice checks every 15 seconds while the main renderer is
  mounted. The workbench refreshes every 3 seconds. No system notification or
  tray-only background discovery is claimed.

## Execution Contract

Saving a Skill stores target, scope, format, variables, sources, deduplication
and success rules. Saving a revision does not mutate earlier versions. Discovery
and Skill/rule editing are enabled; corporate Docs execution remains gated. Explicitly confirmed local browser workflows use the new OpenAdapt path above.
The existing [Codex document contract](../specs/001-event-driven-capture/contracts/codex-document.md)
remains the implementation baseline. This integration does not replace its
synthetic capability gate, frozen input review, exact diff review or host-controlled
document application requirements.

Codex detection checks installation, `exec` flags, existing login, `kcli docs-cli`
and its local Skill. Finder-launched macOS apps resolve the login-shell PATH with
bounded timeouts. Detection is informational: the production worker always returns
`enabled: false` for Codex/Claude and rejects non-workflow `reuse.run` and `reuse.verify` with `CAPABILITY_BLOCKED`
and `EXECUTION_CONTRACT_PENDING`. Claude remains visible and disabled.

The retained executor adapts the existing ML One Room implementation. Its code runs
`codex exec --json --ephemeral --output-schema` in an isolated run directory,
uses the saved CLI identity and corporate Docs Skill, requests scoped JsonML
updates and actual read-back, and persists receipts/traces. The Codex sandbox
is not a remote Docs authorization boundary; target/scope adherence also depends
on the agent and corporate tool permissions. Concurrent remote editing is not
protected by strong compare-and-swap. This executor is not reachable from the
production run/verify routes. Its prompt-based target restrictions and receipt
inspection do not satisfy the current execution contract; it is retained for
implementation reference, not as a completed execution capability.

The retained executor's success checks include a clean CLI exit, initial document
read, write receipt and captured read-back. These checks do not prove exact content,
scope, concurrency safety or read-only verification. Strategy rules can be saved
and previewed only; no coupon/strategy production execution is exposed.

Manual history deletion removes affected candidates and their associated Skill
versions, rules and run records in the same SQLite transaction. Persisted deletion
receipts retain affected run UUIDs until the existing cleanup stage removes their
local task directories. Remaining observations may produce a new candidate that
requires confirmation again. Screenshot expiry does not invalidate this text data.
Manually authored Skills/rules without candidate provenance cannot be associated
with arbitrary history text; imported legacy execution artifacts are not a verified
source-tracked data path.

## Verification and Remaining Gates

Shared unit tests cover registered non-SOP reminders, mutation/failure isolation,
duplicate task detection, candidate status/persistence, invalidated sources,
Skill version immutability, CLI PATH/capabilities, receipts, cancellation and
interruption. 001 integration smoke covers the actual database worker and
persistent candidate/Skill/strategy contracts.

Tests use each branch's Electron Node runtime for SQLite ABI compatibility.
A passing fixture does not certify ordinary desktop capture, upstream semantic
quality, permissions, or real corporate Docs writes. Real Codex model execution
and corporate read/write/read-back remain an explicit end-to-end acceptance gate;
this development run does not write to a corporate document.

## Earlier Desktop Acceptance: 2026-10-16

The following record was imported with upstream commit `3896eb2`. It describes
that commit's test run, not acceptance of the current execution contract. The
current 001 branch retains the production run/verify block described above;
later merged checks and the current package hash are recorded in
`docs/DEVELOPMENT_HANDOFF.md` and `docs/acceptance/package.md`.

Both Apple Silicon macOS application bundles were rebuilt and tested as packaged
Electron applications, not only as browser pages. The test uses a temporary,
isolated user-data directory and seeds controlled document/strategy observations.
It does not change the normal profile, start desktop recording or write a company
document. Source fixtures verify the discovery-to-UI chain, not OCR accuracy.

Passed on both branches:

- Real packaged startup, preload and typed IPC.
- Proactive notice from two independent document updates and automatic strategy
  candidate generation from two similar procedures.
- Candidate-to-Skill prefill, target validation and successful correction after
  an invalid URL, immutable v1/v2 publication, strategy rule persistence/preview.
- Claude disabled; discovery and rule saving create no unattended execution.
- Modal bounds, scrolling and Escape at 1280px and the application's supported
  minimum width (720px for ML, 390px for 001).
- Restart persistence and no renderer exceptions during these scenarios.

Validation results:

- Both TypeScript checks and both packaging commands passed.
- Shared reuse tests: 26 passed in each branch.
- 001 full unit suite: 46 passed; integration smoke including the actual database
  worker passed; full lint passed.
- ML offline broad suite: 1,639 passed, 33 skipped. Run with `TZ=UTC` and exclude
  `src/main/processor/embedding.test.ts` and `embedding-bundle.test.ts`.
  Those two files require unavailable bundled/downloaded embedding model assets;
  the original unrestricted run also encountered an inherited upload test's
  local-midnight assumption. This is not an unrestricted full-suite pass.
- ML changed-code lint passed with existing better-sqlite3 import warnings.
  Repository-wide lint still has 46 inherited errors in unrelated reference and
  upstream files; these were not rewritten as part of SOP integration.

To repeat packaged acceptance, first build with `npm run package` on ML or
`npm run package:mac` on 001, then run:

```sh
node scripts/verify-sop-desktop.mjs
```

The script imports `@playwright/test`. When it is not installed in that checkout,
point `ONE_ROOM_PLAYWRIGHT_MODULE` to an existing Playwright ES module. Screenshots
are generated in ignored `.desktop-acceptance/`; the temporary fixture profile
path is printed for inspection.

In that upstream test run, Codex login, real model execution and corporate
Docs read/write/read-back were skipped. The local CLI was installed but was not
logged in; Mario's connected state does not substitute for CLI model login.
No Mario/Codex authentication or MCP configuration was changed.

These are locally runnable development bundles, without Developer ID signing
or notarization. ML packaging also reports absent embedding model assets, so
offline embedding/search availability is not certified. Ordinary desktop
capture/semantic quality, permissions, a second Mac, three-finger gestures and
distribution acceptance are separate outstanding product gates. Coupon/strategy
execution remains deliberately unavailable; this delivery supports preview only.
