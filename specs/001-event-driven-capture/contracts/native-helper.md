# 原生采集契约

状态：核心协议与 listener/capture/extract/ocr 已实现，单机受控窗口通过生产 TypeScript/Zod 到 SQLite 的完整链路；普通桌面覆盖层和完整双机验收尚未通过。适用 macOS 14+ Apple Silicon、Electron 主进程与随包分发的 Swift helper。产品约束见 [规格](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/spec.md)，选型及出处见 [研究 R3](/Users/huangzhidong/work/one-room/tianmu-hackthon-15/specs/001-event-driven-capture/research.md)。

本轮实际 wire schema 以 `src/shared/schemas.ts` 为准：hello 可带私有目录 `stagingRoot`，图片 token 为 UUID；observe 必带 allowedBundleIds/excludedBundleIds；新增 heartbeat 与 system.state。capture 返回 outputToken/hash/尺寸/字节/前后窗口，extract 与 ocr 返回各自独立文本。失败完整性存为 unknown，不冒充 empty。窗口可见性证明当前依赖 Screen Recording 和 AX 两项权限；缺 AX 时阻断新截图，OCR 只读取已有获准截图。正文提取独立串行有界队列，截图提交后不会等待 AX/OCR；AX 与 OCR 分别可终止，超时后 OCR 使用新进程及原图。

当前一次请求不重发；失败只在后续事件/获准检查点重新观察。每次事件观察均保留时间及独立图片引用，hash 仅复用文件。3 秒视觉/降级检查点、500ms 输入停顿、300ms 滚动停止和250ms最小采图间隔仍需实际应用校准。前台事件排队携带 PID/contextRevision，执行及提交前丢弃过期上下文，避免把前一窗口的输入时序贴给新窗口。受控单机结果见 `docs/acceptance/capture.md`，以下完整退出条件仍保留。

## 1. 所有权与进程边界

- Electron main 的 CaptureCoordinator 拥有采集开关、允许应用、排除规则、generation、队列、截止时间、文件路径及持久化决策。renderer 只能请求既定操作和读取脱敏状态，不获得路径、原生句柄或进程接口。
- listener 是长驻事件进程，负责 NSWorkspace、AXObserver 通知和心跳，不遍历 AX 正文，不等待 OCR、模型或数据库。需要解析窗口上下文的系统调用交给可终止的采集/提取执行单元；通知本身不证明编辑、保存或业务完成。
- capture、extract、ocr 在可终止的 Swift 执行进程中执行，可复用有界执行池。AX 同步 IPC 卡住时 main 能结束该执行进程、撤销本次请求并重建，不阻塞 listener、UI 或其他任务。listener 心跳失联同样产生 gap 并重建，不能承诺系统回调永不阻塞。
- helper 不调用模型、不访问业务接口、不直接修改数据库、不启动任意命令。首版无音频。Swift 可执行文件位于 ASAR 外，随应用嵌套签名、公证；用户无需安装开发工具或参考应用。

## 2. JSONL v1

stdin/stdout 为 UTF-8 JSONL，一行一个完整对象，stdout 不输出日志或非协议文本。stderr 仅记录 requestId、阶段、错误码和耗时，不记录标题、URL、正文、截图或凭证。main/helper 均校验消息 schema、长度和枚举；单行上限初始为 1 MiB，超限返回 `PAYLOAD_TOO_LARGE`，不可静默截断 JSON。文本截断须在合法 payload 内标记 `completeness: partial`。

每条消息都携带 protocolVersion、helperSessionId、kind、method、requestId、generation、observationId、pid、windowId；不适用的身份字段明确为 null，不省略。command 携带 issuedAt/deadlineAt，result 携带 startedAt/finishedAt/status，event 携带 observedAt/sequence/state。

```json
{
  "protocolVersion": 1,
  "helperSessionId": "uuid",
  "kind": "command",
  "method": "capture",
  "requestId": "uuid",
  "generation": 7,
  "observationId": "uuid",
  "pid": 812,
  "windowId": 9231,
  "issuedAt": 1792022400000,
  "deadlineAt": 1792022403000,
  "payload": {
    "policyRevision": 4,
    "contextRevision": 19,
    "trigger": "click",
    "outputToken": "main-allocated-token"
  }
}
```

| 字段 | 契约 |
| --- | --- |
| protocolVersion | 固定为 `1`；主版本不兼容即 `PROTOCOL_UNSUPPORTED`，不得继续采集 |
| helperSessionId | main 为每个新进程实例分配，hello 确认；旧进程输出不得被新进程会话接纳 |
| kind / method | `command / result / event`；method 使用下表白名单 |
| requestId | main 分配；响应原样回传。持续事件引用 `observe` 的 requestId，并有单调 sequence；hello 之前的 fatal 消息可为 null |
| generation | main 维护的会话代数；暂停、停止、锁屏、睡眠、范围变化及重启使旧代失效，helper 不自行提升 |
| observationId | capture/extract/ocr 必须属于同一已分配观察；hello、控制消息及尚未分配观察的窗口事件为 null |
| pid / windowId | 观察命令必须明确；控制消息为 null。事件尚不能确认窗口时可为 null，但不得被主进程接纳为已配对观察 |
| issuedAt / deadlineAt | command 必填；UTC epoch ms，由 main 控制截止时间，不以 helper 自报未超时为准 |
| startedAt / finishedAt | result 必填，UTC epoch ms；采集结果另带观察时点和前后身份。持续时长用单调时钟计算，不能把墙钟倒退当负工作时间 |
| sequence | 每个 helper 启动实例内事件递增；与 helperSessionId 共同检测断流及重启，不充当业务时间 |
| status | result 终态为 `ok / partial / failed / canceled / timeout / discarded`；可先发送非终态 `accepted`，每个请求至多一个可接纳终态 |

同一 requestId 与相同 payload 的重发为幂等，返回已知状态或原结果，不再次创建观察；相同 requestId 配不同 payload 返回 `REQUEST_CONFLICT`。main 保持本代请求登记表；helper 重启后不自动重放采集，重新确认上下文再创建新观察。任何未知、已取消、已超时或旧 generation 的结果均不能落库。

## 3. 方法与阶段

| 方法 | 方向 | 输入及结果 |
| --- | --- | --- |
| hello | main -> helper -> result | main 指定角色、protocolVersion、helperSessionId 与受控 staging 配置；返回 capabilities、构建版本、支持系统版本、权限状态，不弹授权框 |
| permissions.request | main -> executor -> result | 仅在用户点击对应权限按钮时发送 `kind=screen/accessibility/inputMonitoring`，由实际采集助手调用对应 TCC 请求 API；返回 kind/requested/granted。请求不采集窗口、不启动监听或模型，随后 main 打开对应系统设置并清空权限缓存；hello/status 仍只读 |
| observe | main -> listener -> result | 建立本 generation 的事件订阅，包含 policyRevision、允许的触发类型与心跳要求；重复订阅幂等 |
| window.changed | listener -> main event | sequence、`trigger=app_switch|window_focus|window_title|content_changed`、已知 pid/windowId、contextRevision、observedAt；只报告实际可观察通知，main 判断是否安排观察，事件不直接创建已确认编辑 |
| input.timing | listener -> main event | `trigger=click|typing_pause|scroll_stop`、输入活动区间/静默时长及其 contextRevision；仅发送下述时序白名单，不发送字符、按键或剪贴板正文 |
| capture | main -> executor -> result | 指定观察身份、policy/context revision、outputToken；返回图像元数据、内容 hash、前后身份与可见性判定，不返回任意文件路径 |
| extract | main -> executor -> result | 已提交观察和预期窗口身份；返回该获准窗口的 AX 文本、正文质量、可见节点范围、来源及失败/补充原因 |
| ocr | main -> executor -> result | 同一观察的获准 screenshot inputToken、语言配置；只用本地 Vision，返回文本、识别配置、来源、完整性和错误 |
| cancel | main -> helper -> result | 引用 targetRequestId 和 generation；立即撤销接纳资格，能合作停止则停止，否则 main 终止执行进程；不撤回已提交且仍有效的截图 |
| shutdown | main -> helper -> result | 停止订阅、拒绝新任务、清理未提交 staging；到截止时间仍未退出则 main 终止进程 |

`capabilities` 必须分别报告 `windowEvents`、`windowCapture`、`accessibilityText`、`visionOcr`、`inputTiming` 的 supported/permission/state/reason。某项可用不推导其他项可用；不支持的命令返回 `CAPABILITY_UNAVAILABLE`。不在 hello 启动任何屏幕采集。

`input.timing` 使用同一事件 envelope，requestId 指向当前 observe 订阅，observationId 为 null，observedAt 为本通知产生时刻；payload 仅允许以下字段：

```ts
type InputTimingPayload = {
  trigger: 'click' | 'typing_pause' | 'scroll_stop';
  contextRevision: number | null;
  activityStartedAt: number;
  activityEndedAt: number;
  quietDurationMs: number;
};
```

activityStartedAt/activityEndedAt 为 UTC epoch ms；click 两者相等且 quietDurationMs=0，另外两类仅在连续输入/滚动活动结束并达到配置的静默间隔后发一次聚合通知。不得发送逐键时间序列、字符、keycode、键值、输入内容、剪贴板内容或额外可还原输入的字段。pid/windowId/contextRevision 是活动当时可确认的上下文，未知保持 null；它们不是触发时当前前台身份的证明。静默期间切窗或代数变化时不得将旧输入归因到新窗口。排除上下文不发送 input.timing，只发送关闭区间所需的最小状态。

main 以白名单 trigger 记录观察原因：上述窗口/输入事件，以及由 main 调度的 `checkpoint / visual_checkpoint / degraded_checkpoint / manual`。静态/空闲补采使用 checkpoint；无输入画面变化检查使用 visual_checkpoint；事件源或 inputTiming 不可用时使用 degraded_checkpoint，并保存 degradedReason 与失效能力。检查点频率、输入静默间隔和合并预算作为显式配置经真机校准；合并不能抹去已观察的对象切换，队列溢出产生 gap。检查点仍须执行完整授权、排除、generation、前台身份和可见性前后检查，不能复用旧窗口身份、隐藏表面或以全屏轮询绕过拒绝。视觉检查只比较本次获准窗口，不以截图相同删除观察时间；未触发新图像留存的检查也要记录已执行的检查点状态。

每次观察按以下顺序推进：

1. main 检查当前开关、应用允许范围、排除、权限及 generation，分配 observationId 和 capture requestId。
2. executor 在截图前再次确认身份及可见性，执行指定窗口截图，截图后复核同一上下文，输出到本次受控 staging。
3. main 重验结果、图像格式/尺寸/hash、当前 generation 和策略；完成文件落盘，再经数据库事务提交截图证据与观察事实。相同 hash 可复用 blob，但不能省略这次观察或刷新旧证据的到期时间。截图失败先提交明确缺图的观察状态及相应 gap；若 AX 仍获准、身份与可见范围可确认，可独立继续文字提取，不能声称截图成功。
4. 只有事实提交后 main 才派发 extract；AX 缺失、正文过薄、不完整或技术失败且图片仍获准时，按需派发 ocr。OCR 输入必须是这次已提交观察的原图，不能用后续窗口截图替代。
5. 文本结果独立提交并关联 observationId。AX/OCR/模型失败不删除已有效提交的截图；截图失败形成相应观察状态及 gap，不伪造原图。文字与模型处理不得延长未经再次观察的有效工作区间。

截图、AX 和 OCR 不是操作系统原子快照。结果携带 `contextBefore/contextAfter`、`observedAt` 及采集时间区间；不能确认同一窗口时返回 discarded，不能把配对不确定的文字提升为确定对象或已确认编辑。AX 在截图后窗口已变则舍弃本次 AX，可从仍获准的原图 OCR，不重读新窗口冒充旧观察。

## 4. 身份、可见范围与排除

窗口 identity 至少含 pid、windowId、bundleId、contextRevision；标题和几何只能作为匹配线索，同名窗口不是同一窗口。前台窗口无法唯一对应 SCWindow 时返回 `WINDOW_AMBIGUOUS`，不得随意选择同进程窗口。允许范围只按 main 的当前策略判断，helper 无权扩大。

可接纳 capture 必须在前后检查均满足 `frontmost=true`、`onScreen=true`、`minimized=false` 且可见范围已确认。ScreenCaptureKit 单窗口 filter 可能返回遮挡或屏幕外的完整表面，因此其成功回调不构成可见性证明。其他 Space、浮层、部分遮挡或几何歧义导致可见范围无法确认时，返回 `VISIBILITY_UNVERIFIED` 并 discarded，由 main 记录 gap；首版不捕获隐藏表面，不退回显示器或全屏截图。

AX 只读取本观察当前获准窗口的可见正文，过滤隐藏/安全角色，保留限深、限节点、限文本长度和 partial 原因。通知或输入停顿不证明正文被修改。明确排除与安全拒绝属于停止条件，禁止以 OCR、另一窗口或轮询绕过；对于已排除上下文，listener 仅发停止/缺口所需最小标识和原因，不发送其标题、URL 或正文。

文本结果保留 `source: accessibility / ocr / hybrid`、独立 AX/OCR 内容及各自 sourceRef、`completeness: complete / thin / partial / empty / unknown`、`fallbackReason`、`observedAt`、observationId。完整性和操作状态分开：

| completeness | 含义 |
| --- | --- |
| complete | 已定义可见范围内的正文提取完成；不保证识别应用隐藏内容或全部业务语义 |
| thin | 只有标题、工具栏等外壳文字，缺少可见正文，须判断 OCR 补充 |
| partial | 已取得部分可见正文，但因遍历/长度/时间预算或其他已知原因不完整 |
| empty | 成功检查后未取得文字，不等同技术错误或明确排除 |
| unknown | 未能评估完整性或提取不获准，须结合状态及原因解释 |

每条文本结果另保留 `status=ready|partial|empty|failed|excluded`，这是 payload 中的提取状态，不替代顶层请求 status。failed 必带 errorCode，excluded 不包含正文且禁止 OCR 绕过；不能以 completeness=empty 将两者冒充成功空正文。薄正文、部分正文及空正文分别保留具体 fallbackReason，混合结果不能拼接后丢失来源。

## 5. 路径、取消与失败

所有读写路径只能由 main 分配到本次受控 staging，协议使用 outputToken/inputToken 关联。helper 不接受 renderer 路径、任意 URL 或任意 cwd；main 拒绝越界、symlink 和非预期文件类型。OCR 需要原图时，由 main 将获准证据映射为本次只读 staging 输入。helper 仅能写分配的输出；最终文件移动、fsync、引用提交及孤立临时文件恢复清理由 main/数据库服务拥有。renderer 通过 evidenceId 读取受控媒体，不见 staging 或最终绝对路径。

main 以 deadlineAt 执行每个请求的超时，AX 单次 messaging timeout、节点预算和总预算同时适用；到期先废止请求，再取消或终止执行进程。late `ok` 不能覆盖 timeout。取消请求的成功回执仅表明目标已失去提交资格，不保证同步系统调用已经返回；进程是否退出单独记录。重建进程必须使用新 helperSessionId，结果不串入旧请求。

暂停、停止、锁屏、睡眠、排除、权限撤销及断流会结束有效区间，提升 generation 并取消在途任务。main 拒绝旧代截图和文字提交，删除未提交 staging，记录 `paused / locked / sleep / permission / excluded / error` gap；恢复必须重新观察，不沿用旧截图填空。恢复不自动撤销用户尚未关闭的独立模型文字授权，但任何模型请求仍须重新通过来源与授权检查。

错误至少包含 `code`、`stage`、`retryable`、requestId、generation；常见 code 为 `PERMISSION_SCREEN`、`PERMISSION_AX`、`PERMISSION_INPUT`、`WINDOW_AMBIGUOUS`、`CONTEXT_CHANGED`、`VISIBILITY_UNVERIFIED`、`EXCLUDED`、`TIMEOUT`、`CANCELED`、`IO_ERROR`、`PROTOCOL_UNSUPPORTED`。自动重试必须有界且先重验策略/身份；失败不是成功的空文本，也不能无限重试阻断观察。

## 6. 权限与输入、手势边界

- 屏幕、AX 和可能的 Input Monitoring 分别检查；Electron 主进程的状态不能代替 helper 实际 TCC 状态。仅用户主动进入授权流程时请求相应权限，hello/status 不弹窗。
- AX 拒绝且截图获准时允许标识清楚的 OCR 降级；屏幕拒绝不能伪造截图。每项最近成功时间、当前可用性及失败原因独立展示。
- `inputTiming` 只含点击/滚动/输入活动的时间、停顿与类别，不含键盘字符、keycode、剪贴板正文或可还原输入的序列；不得调用剪贴板正文读取接口。该能力不可用时使用标识清楚的上下文事件/检查点降级。
- 后台模型文字发送授权是独立、默认关闭且可持久保存的产品授权；原生系统权限不授予模型上传权限。此协议不发送模型请求或自动上传截图。
- 手势不属于 Swift helper capabilities。Electron main 接收 BrowserWindow `swipe`，仅在时间线焦点或命中范围转交方向信号，由 TS zoom adapter 围绕游标分级缩放并平滑过渡；不宣称 Swift 子进程拥有 Electron NSView 触点。
- SC-015 必须在两台目标 Mac 各记录系统/触控板设置、真实事件以及至少 10 次三指放大/缩小和日/月跨层结果。接不到三指信号记 blocked；pinch、按钮、脚本模拟与连续缩放逻辑验收独立记录，不能替代三指通过。

## 7. 实施退出条件

签名安装包在第二台无开发工具 Mac 上验证 TCC 归属、独立拒绝/撤销/恢复；快速切窗、同名多窗、遮挡、其他 Space、锁屏/睡眠均不保存错误或隐藏画面。AX 卡死/超时能被终止且 listener 继续；中文/英文正文、工具栏、空树、图像正文分别验证来源和回退。取消、暂停、进程重启后迟到结果零落地；staging 故障与崩溃恢复不生成悬空证据。未通过项按对应能力阻断或明确降级，不宣称已有真机验证。
