# 文档 SOP 实际检查

2026-10-16，隔离工作树 `b995bad` / schema 6。以下是生产服务、SQLite 与合成 Agent 检查，不是真实 Codex 执行验收。

| 范围 | 实际结果 |
| --- | --- |
| Codex 协议 | 11 项 `tests/unit/codex-protocol.test.ts` 通过：固定 argv、最小环境、版本/登录/能力检测、有界 JSONL/超时/取消、唯一最终消息及来源/输入绑定；拒绝工具活动、越界输出、晚到结果和缺少隔离证据的业务派发 |
| 本地 Markdown | 12 项 `tests/unit/local-markdown.test.ts` 通过：明确选中文档章节，BOM/CRLF/章节外字节与权限保留、目标身份冲突、持久操作意图/哈希、重试幂等、独占编辑或导出 patch |
| 真实 SQLite 集成 | `document-operations-smoke.ts`、`document-runs-smoke.ts` 使用临时本地 Markdown 和合成 Agent，验证不可变 Skill 版本、冻结完整输入、审核后提案、精确 diff 二次审核、操作回执、重启不重放、冲突/取消/迟到输出、并发幂等、异步准备期间撤权，以及来源删除清理 |
| 生产 UI | 最新 12/12 E2E 中的文档用例通过真实 main/preload/SQLite：进入“流程 → 文档更新”、选择文档与章节、发布版本、选择来源并查看冻结输入；未自动发送模型内容。操作流程工作台单独保留 |

本地目标路径不进入冻结模型材料；材料仅包含确认的 Skill 版本、目标章节及所选来源。输入确认与精确 diff 确认是两次独立操作，应用写入由宿主持久事务执行。存在外部编辑竞争时不宣称本地 hash/rename 提供跨进程 CAS；需要独占编辑，否则导出 patch。

G4 仍未通过：生产默认 `IsolationVerifier` 无可信隔离证据，安装/登录检测不能替代它，真实 Codex 业务派发保持阻断。上述合成能力检查与本地写入不能证明真实 CLI 的完整运行路径；Claude 保持可见且禁用。保留的公司 Docs 执行器不满足此契约，生产 run/verify 仍阻断。配券/策略的产品约束为预览，手工录制通用 workflow 仍需补齐额外业务范围限制；schema 6 候选未准备 OpenAdapt runtime、流程执行禁用，未执行真实业务，也不计入本次文档写入验收。
