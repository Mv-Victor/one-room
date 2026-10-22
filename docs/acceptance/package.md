# 本机开发包检查

## 当前目录权限申请修复

2026-10-16，macOS 15.6.1 arm64，当前分支 `001-event-driven-capture` 的产物为 `/Users/huangzhidong/work/one-room/tianmu-hackthon-15/release/mac-arm64/One Room.app`，版本 0.1.0、schema 6。此包替换了原先只打开系统设置的权限按钮：先由实际采集助手显式申请所选权限，再打开对应面板。只读权限探测不弹窗，申请过程不启动录制、输入监听或模型。

原包保留 Electron 的 linker-only 签名，签名标识为 `Electron`，Info.plist 未绑定。现以 `identity: '-'` 完整 ad-hoc 签名，`codesign --verify --deep --strict` 通过，标识为 `local.one-room.desktop`，Info.plist 与资源封装均绑定。此签名用于本机开发，不等于 Developer ID、公证或跨构建 TCC 连续性保证。

Computer Use 已通过屏幕录制面板的“在访达中显示”核对当前包的实际路径。系统中还存在其他工作树的同名应用，旧辅助功能记录指向隔离验收目录；TCC 日志确认相同 bundle ID 的旧签名要求与当前构建不匹配。不能仅凭列表显示“One Room”认定当前包已授权。最终屏幕录制与辅助功能授权仍待确认，未将此检查记为录制恢复或普通桌面采集通过。

本次验证：typecheck、lint、native build/smoke、100 项单测（另 1 项可选集成跳过）、foundation E2E（1 项）、mac 打包与 package-smoke 均通过。新增 5 项权限测试覆盖所选权限请求、旧 helper 提示和失败清理；package-smoke 新增完整签名及 bundle 标识断言，其余 SQLite、IPC、重启、报告/删除回执、safeStorage 检查继续通过。自动测试不申请真实 TCC 权限、不采集桌面、不发送网络请求。

`Contents/Resources/app.asar` SHA-256：

```text
7647c45a552f547887ee5dac2bba090f2a326201ed34e9d9542758cf720dc203
```

## 先前隔离目录候选

2026-10-16，macOS 15.6.1 arm64。先前 schema 6 候选产物：`/Users/huangzhidong/.codex/worktrees/one-room-verification/tianmu-hackthon-15/release/mac-arm64/One Room.app`，版本 0.1.0。基于隔离工作树 `dbefbcd` 构建，运行代码与主分支 `d2c4e47` 对齐，含 `85fd5fb` 时间范围及 `ac86614` 报告修复。`npm run package:mac` 和 `node scripts/package-smoke.mjs` 已通过；不是正式分发验收。

主目录便于访问的副本为 `/Users/huangzhidong/work/one-room/tianmu-hackthon-15/release/verified-6b4df09/One Room.app`，复制后已重新核对 ASAR 哈希，与下列隔离树产物一致；未覆盖其他构建目录。

`Contents/Resources/app.asar` SHA-256：

```text
6b4df09f88c0f1b1d678e9f2096093bb8a54d4bf667e07b3b8a2e7e738d9cd34
```

隔离工作树最初使用指向原目录的 `node_modules` 符号链接，导致 `bindings` 等传递依赖未进入包；现已用本地 `npm ci` 安装并重新构建。smoke 新增 `bindings`、`file-uri-to-path`、`scheduler`、`loose-envify` 四项运行依赖断言与失败诊断。脚本使用独立临时 userData，结束后关闭自建进程并清理测试数据，不开启采集、不发送模型请求。

## 已通过

- Swift5/macOS14 arm64 helper编译、ASAR外可执行资源、helper本地ad-hoc签名及`codesign --verify --strict`。
- Playwright `_electron.launch` 实际启动包内可执行文件，使用独立临时 userData。读取 schemaVersion=6、WAL、capture=paused、独立文字授权 off；SQLite worker/IPC 和包内 helper 握手可用，关闭及重启正常。
- 生产 `report.generate/get` 的空历史日报生成、重启后ID和幂等回执保留；`history.previewDelete/delete` 的空历史预览/删除、同进程与重启后回执重放通过，采集始终暂停。非空来源删除由独立 SQLite smoke 覆盖，不把此包检查扩展为真实捕获完整 UI 主链通过。
- 使用合成API Key保存配置，公开回复和磁盘JSON均不含明文；通过真实Electron safeStorage解密比对成功。关闭重启后凭据仍在，清除后密文字段为空。未执行连接测试，网络请求为0。
- ASAR含main/database/preload和第三方声明；排除两个smoke及navigationBenchmark入口，renderer无fixture chunk/factory/专属数据ID和版本。状态文案中的 `DEVELOPMENT_FIXTURE` 枚举不代表包含fixture实现。MemoryLane GPL与Screenpipe MIT许可副本逐字节一致，声明与源码字节一致。
- 实际 Electron ABI146 下的 SQLite 3.53.2、WAL/FULL/FK/FTS5 及 v1 升级由独立临时库集成检查通过；schema 4 保留已发布 SOP 迁移，schema 5 增周期总结，schema 6 增文档版本/运行/持久操作。最新 95 项单测、六组 SQLite smoke 和 13/13 E2E 结果见 [gates.md](gates.md)；源码检查与包检查分别记录。
- schema 6 的 package-smoke 退出 0、无页面异常，main/renderer 网络尝试均为 0，采集始终关闭；不包含真实业务材料或截图上传。脚本的 `node --check`、定向 ESLint 和 `git diff --check` 通过。

## 未完成

本包未执行 `workflow:prepare`，缺少外部 OpenAdapt runtime，操作流程执行保持禁用，未执行真实浏览器/公司业务操作。产品要求配券/策略仅预览；手工录制的通用 workflow 仍需额外业务范围限制，此包检查不证明该限制已覆盖全部执行路径。Codex 默认可信隔离门槛仍阻断，未通过真实 Codex 文档执行。

应用使用默认图标，未做 Developer ID 签名或公证，也未在第二台 Mac 安装验证。包启动及只读权限探测不证明普通窗口可捕获；当前覆盖层限制和受控窗口测试见 [capture.md](capture.md)。真实普通桌面采集后的非空时间线→报告→删除完整 UI 主链、物理三指及完整 P0 仍待，T059 保持未勾选。

## 历史候选

schema 5 的 `a355576` 包曾通过本机 package-smoke 和 `verify-sop-desktop` 的发现/Skill 版本/策略预览/窄屏弹窗/重启检查，不执行模型或公司文档写入。其 ASAR SHA-256 为 `76804ba68e63176f37aeda29e40c60714980a7a00ddc9fab14063dd280d532b3`，该 SOP 界面结果不扩展为本轮 schema 6 包已重复执行相同检查。

更早 schema 3 包的 SHA-256 为 `bb4796e4a52b9ad70ac6650b35312c7e5b5d244bce69d5cfd660c821cc06927f`，schema 2 为 `228f62d18d72e976ab17fdf90e7aba1408a83ecdd23d91dc5dccb4ab4ab144f5`，仅作历史记录。
