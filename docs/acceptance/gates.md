# 实施与验收记录

更新：2026-10-16。隔离工作树的 schema 6 源码已完成最新全套检查、E2E、时间范围版界面基准和本机开发包检查；运行代码基于 `dbefbcd`，与主分支 `d2c4e47` 对齐。不代表完整 P0 或正式分发验收。环境：macOS 15.6.1（24G90）、arm64，Apple M4 Pro/24GiB；开发 Node.js 22.22.2/npm 10.9.7，Electron 42.11.14。合成观察、模拟模型和受控窗口结果分别列出，不扩展为真实桌面或真实 Codex 通过。项目 constitution 仍为未批准模板，检查为 N/A。

## 已执行

| 检查 | 实际结果与证据 |
| --- | --- |
| TypeScript/ESLint/单测 | 最新完整 `npm run check` 通过：95 项单测、19 个测试文件通过；另 1 项依赖外部 OpenAdapt runtime 的 workflow 集成检查跳过。报告 8 项含真实生成/裁剪链回归，整体覆盖契约、采集/活动/模型、周期总结、导航、Codex 协议及本地 Markdown；跳过项不算通过 |
| Electron/SQLite | 最新六组 SQLite 集成 smoke 通过，运行于 Electron 42.11.14、Node 24.19.0、ABI 146。schema 6 新增文档执行状态/不可变版本/操作回执，保留已有迁移；SQLite 3.53.2、WAL/FULL/FK/FTS5 通过 |
| 持久化与证据 | 设置重启保留；事实/evidence/source/change 原子提交；同图保留两条观察；30 天引用独立到期且重复清理有效；重启暂停。入口：`tests/integration/foundation-smoke.ts`，该存储测试的 PNG 为合成 1x1 图片 |
| 原生 helper（历史） | Swift 5 模式/macOS 14 arm64 编译及本地 ad-hoc 签名、`native:smoke` hello/shutdown 已通过；本轮源码检查不等于再次完成原生真机验收 |
| 受控窗口真实链路 | 本轮隔离树 `tests/integration/native-capture-smoke.ts` 完整通过：三个自行创建并允许的 Cocoa fixture 的 AX complete/empty/thin、中英 OCR、1 条真实观察/证据/活动、时间线/游标、日报、暂停重启和删除失效；文字授权关闭，模型调用 0。普通桌面当前受 Firezyl/Dock 覆盖检查阻断（`VISIBILITY_UNVERIFIED`），physical monitor=false，详见 [capture.md](capture.md) |
| 模型配置与授权 | 本机打包应用使用合成 API Key 验证真实 Electron safeStorage 加密、文件无明文、解密相等、关闭重启保留及清除，网络请求 0。注入加密接口/本机 HTTP 另验证合成连接测试、严格文本结果、串行有界队列与撤权后丢弃。真实 Electron 验证文字授权默认关闭、范围确认、开启/重启保留/关闭；外部提供方尚未验收。保存模型与测试连接不代替授权，无自动截图上传 |
| 生产回顾与持久写入 | 同事务事实/活动/图片读取，连续语义周期保留所有观察来源；正文FTS和短中文检索、schema 3报告/来源/回执、主动删除及共享blob清理通过。开放gap以同一asOf读取和提交，25ms延迟保存回归通过。截图到期不使报告文字失效，见worklog-storage.md |
| 持久周期总结 | schema 5 的分块/归并任务树、单并发队列、派发/提交授权双验、人工锁、重启恢复、跨午夜投影、删除重建及报告失效通过；246 条合成观察中长周期 240 条文本均进入总结，外部模型调用 0，详见 period-summary.md |
| 桌面与回顾核心流程 | 最新 `test:e2e` 共 13/13 通过：生产 Electron bridge、范围/授权/重启、空历史、SQLite 非空 A→Kim→A 日月/图片/日报周报/删除、报告回顾及 HTML 导出、文档版本发布与冻结输入审核，以及隔离 fixture 的滚动/切层/密集月格/过期 revision 恢复和三分钟跨午夜截图像素变化。输入仍为合成观察，真实捕获到完整 UI 主链待验 |
| 关闭异常回归 | 截图中的 `Object has been destroyed` 来自 closed 回调读取已销毁 BrowserWindow；改为保存 WebContents 引用，重建后关闭/重启通过 |
| SQLite 关闭回归 | 生产 worker 关闭后强制 terminate 原生 SQLite addon 可复现 SIGSEGV；改为端口关闭并等待自然退出，最小对照连续 50 次、四组完整 smoke 连续 10 次退出 0 |
| 界面 | 1440x1000/390x844 CSS viewport 无页面错误或横向溢出；真实桌面截图在被 Git 忽略的 `artifacts/acceptance/desktop-{empty,settings,narrow,narrow-timeline}.png`，回顾 fixture 与合成图证截图为 `b-*.png`。活动校正另以合成非空数据验证修改/确认/刷新，截图为`a-event-review-{desktop,narrow}.png`，不代表真实业务活动语义验收 |
| 固定上游 | 上游离线校验：25 个文件指纹、3 处精确研究摘录、2 份原始许可字节通过；实际迁入范围见 `THIRD_PARTY_NOTICES.md` |
| 导航服务性能 | `benchmark:navigation` 在30天/100000观察/10000周期/1000合成PNG样本通过：100次定位p95=40.57ms、20次日/月查询p95=1172.74ms，正文FTS/短中文与旧分页拒绝通过；不含renderer/图片解码/物理手势，详见navigation-performance.md |
| 导航完整界面性能 | 最新 schema 6 `dbefbcd` 时间范围版（2026-10-16 01:57:34.577，Asia/Shanghai）：100 次游标 p95=99.04ms；20 次日/月切层含完整 320ms 动画，p95=442.27ms、最大 1060.49ms。初始跨度预热至 24 小时后计时；第 334 项刷新后精确跳转、1440/390px、中心时间可见、无溢出/页面异常均通过。详见 [navigation-performance.md](navigation-performance.md) |
| 独立日报/周报 | 未关联外部文档也可生成时间分配、节奏、来源片段和关键时刻回顾，审核后导出离线 HTML；已通过报告单测、生产 E2E、前轮真实下载和 390px 浏览器检查。报告不附截图或原窗口标题，不据时长推断绩效/情绪/加班，详见 [reports.md](reports.md) |
| 文档 SOP | Codex 固定参数/JSONL/预算/合成能力检查、本地 Markdown 双审核和持久操作已实现；12 项 Markdown、11 项 Codex 单测及真实 SQLite 集成覆盖并发幂等、撤权、恢复、冲突与源删除。生产默认隔离验证仍缺失，真实 Codex 派发未通过，详见 [document-sop.md](document-sop.md) |
| 本地开发包 | schema 6 `dbefbcd` 包通过 `package:mac` / `package-smoke`：真实包 IPC/SQLite/WAL/schema、paused、文字授权 off、helper、报告持久化/删除幂等、safeStorage 加密/重启解密/清除，网络尝试和采集均为 0，无页面异常。ASAR SHA-256 为 `6b4df09f88c0f1b1d678e9f2096093bb8a54d4bf667e07b3b8a2e7e738d9cd34`，详见 [package.md](package.md)；schema 5 SOP 界面检查仅保留为历史 |
| 包内容与隔离 | 本地 `npm ci` 修复 symlink 漏传递依赖，新增四项 runtime 依赖断言；包内许可、fixture/smoke 排除、ASAR 外 helper 和 ad-hoc 签名检查通过。OpenAdapt runtime 未准备，操作流程执行禁用；Developer ID、公证、第二台 Mac 安装未执行 |

## 产品门槛

| Gate | 当前状态 | 后续责任 |
| --- | --- | --- |
| G1 Native/package | 源码 ABI/SQLite 与 schema 6 本机开发包检查通过；Developer ID、公证与第二台安装未执行，正式分发门槛未完成 | A，T004/T059 |
| G2 Capture/visibility | 仅受控窗口单机部分通过：真实截图/AX/OCR/持久化已验证；普通桌面被全屏覆盖层遮挡时严格拒绝，普通应用覆盖、两机各 60 分钟及完整生命周期真值未通过 | A，T004/T016 与 G2 剩余真机检查 |
| G3 Gesture | 物理三指未执行：隔离 fixture 的按钮/标准 wheel 日月跨层通过，不证明两台 Mac 原始三指信号或系统设置兼容 | B，T031–T034；A 协助 main 事件 |
| G4 Codex | 安装/认证检测、合成协议门禁、冻结输入/精确 diff 双审核、本地持久操作已实现并经模拟验证；默认 `IsolationVerifier` 仍无可信证据，生产派发保持阻断，真实 Codex 执行未验收，Claude 灰态 | A，P1 T047–T050 与可信隔离验证 |

T004 已勾选实施完成；T009 仍未勾选，虽已有隔离 fixture 和单机原生证据，G2/G3 缺项尚未通过。A 继续普通窗口可见性与真机门槛；生产 WorklogReader 和 T020 活动周期关联已接入。开发与联调放行不等于以上门槛通过。

生产日轴/月历、报告、删除与 T030 持久周期总结已接入；删除预览先暂停采集并固定版本，取消后仍暂停。来源手动删除会清理关联派生内容与文档运行来源。操作流程与文档更新保留各自工作台；外部 OpenAdapt runtime 未准备的集成测试保持跳过，本包流程执行禁用，真实浏览器/原生业务执行不计入通过。产品要求配券/策略仅预览，手工录制通用 workflow 的额外业务范围限制仍待补齐。T035 的单机受控负载通过；普通窗口、两机各 60 分钟、四类真实语义、物理三指及完整 SC 矩阵仍待，完整 P0 不标完成。
