# 架构设计

## 核心原则

本项目的测试执行策略是：**Content Script 只观察，CDP 负责所有写操作**。

也就是说，页面状态可以通过 DOM 快照、只读 `evalInPage`、截图和网络记录观察；但点击、输入、滚动、悬停、拖拽、按键、下拉选择等用户行为必须通过 `chrome.debugger` 的 CDP `Input.*` 命令执行。CDP 附加失败时直接失败，不使用 `el.click()`、`dispatchEvent()`、修改 `value/checked/selected` 等脚本动作兜底。

## 扩展形态

Chrome Manifest V3 + Side Panel。

```
权限设计
- sidePanel + tabs      选择目标标签页并打开侧边栏
- scripting + activeTab 注入观察脚本，并在主世界只读检查页面状态
- storage               保存 API URL、Key、模型配置和用户输入
- host_permissions      允许 Side Panel fetch 用户配置的 AI 端点
- debugger              CDP 截图、真实鼠标键盘、滚轮、网络录制
```

`debugger` 权限是成熟自动化能力的核心。它会让 Chrome 显示“该扩展程序正在调试此浏览器”的提示，这是真实 CDP 控制的正常表现。测试结束或中止后会自动分离。

## 文件结构

```
aututest/
├── manifest.json
├── sidepanel/
│   ├── sidepanel.html
│   ├── sidepanel.css
│   └── sidepanel.js             # UI 和编排入口
├── background/
│   └── service-worker.js        # 生命周期、Side Panel、CDP 清理
├── content/
│   └── content.js               # DOM 快照、导航提取、选择器生成
├── core/
│   ├── agent-loop.js            # 主执行循环和工具分发
│   ├── action-templates.js      # 下拉、多选、表单、按钮等确定性模板
│   ├── visual-controller.js     # CDP 截图、鼠标、键盘、滚轮、拖拽
│   ├── network-recorder.js      # CDP Network 请求/响应记录
│   ├── prompt-builder.js        # system prompt 和 tools schema
│   ├── ai-client.js             # OpenAI 兼容 API 调用
│   ├── source-reader.js         # 用户上传源码索引和检索
│   ├── source-analyzer.js       # 源码结构分析
│   ├── interaction-contract.js   # 源码交互契约匹配
│   ├── test-scheduler.js         # 共享 setup 的场景编排
│   ├── redaction.js              # 错误诊断导出脱敏
│   ├── diagnostic-store.js        # 错误诊断本地存储容量控制
│   ├── test-report.js              # 结构化测试报告与 Markdown 导出
│   ├── run-history.js               # 有容量上限的报告历史
│   ├── tab-eligibility.js            # 目标页面资格判断
│   ├── progress-guard.js              # 基于页面进展的交互停滞熔断
│   ├── config-validator.js       # API 端点配置校验
│   ├── project-analyzer.js      # 项目架构分析
│   └── test-summary-cache.js    # 用例间摘要缓存
└── devtools/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png             # manifest 图标资源
```

## 执行上下文

### Side Panel

Side Panel 是唯一编排者：

- 调用 AI API。
- 读取用户上传源码。
- 通过 `chrome.scripting.executeScript` 做只读页面检查。
- 通过 `chrome.debugger` 执行 CDP 真实输入、截图和网络录制。
- 运行 `agent-loop.js`，聚合日志、断言和测试结果。

### Content Script

Content Script 是观察层：

- 生成 DOM 快照。
- 提取可交互元素、文本、控件值、导航信息。
- 生成候选 selector。
- 响应 `AIFT_SNAPSHOT`、`AIFT_GET_NAVIGATION`、`AIFT_PING`。

Content Script 不执行测试动作，不接收 API Key，不调用 AI。

### Background Service Worker

Background 只做辅助：

- 管理 Side Panel 打开行为。
- 在 tab 关闭或 Side Panel 断开时清理可能残留的 CDP debugger。

## 数据流

```mermaid
flowchart TB
    User["用户"] --> Panel["Side Panel"]
    Panel --> AI["AI API"]
    Panel --> Source["上传源码索引"]
    Panel --> CS["Content Script 观察层"]
    Panel --> CDP["Chrome Debugger / CDP"]
    CS --> Page["被测页面 DOM"]
    CDP --> Page
    CDP --> Network["Network 请求/响应"]
    CDP --> Shot["截图"]
```

## Agent Loop

```mermaid
flowchart TB
    S["开始/继续测试"] --> C["收集上下文：源码 + DOM 快照 + 网络摘要 + 截图"]
    C --> P["构造 prompt + tools"]
    P --> A["调用 AI"]
    A --> T{"tool_calls?"}
    T -->|动作工具| E["CDP 执行真实操作"]
    T -->|观察工具| O["只读检查/截图/网络查询"]
    T -->|assert| R["记录断言"]
    E --> V["动作后验证和页面状态采集"]
    O --> C
    V --> C
    R --> C
```

关键约束：

- AI 不允许通过 `eval_in_page` 模拟用户操作。
- 基础 `click/type/press/scroll/hover` 均走 CDP。
- `select_option/select_multi/fill_input/click_button/toggle_switch` 等模板内部先只读定位，再用 CDP 操作，最后验证结果。
- 源码契约存在时，模板先使用其触发、展开、激活和提交关系；没有契约时，从当前 DOM 节点的标准语义（checkbox/radio/ARIA state）解析实际激活目标，避免把展示文字当作点击点。
- 如果 CDP attach 失败，测试不能继续宣称“真实用户行为”。

## 源码关联、场景与诊断

- 每一轮根据 URL、页面标题、DOM 文本和当前 TC 对上传文件排序，只给模型注入最相关的少量源码；需要更多上下文时仍可使用 `read_source`。
- 源码分析以 `data-testid`、ARIA、placeholder、id/name 等稳定属性产出框架无关的交互契约。专用组件解析只能提供额外精度，核心执行仍使用标准 DOM 语义和 CDP。
- DOM 快照中的可交互节点附带短引用；基础操作仅可使用该引用、显式查找结果或当前源码交互契约中的 selector，避免模型根据页面结构臆造选择器。
- `assert` 仅可提交给运行时状态机中的当前 TC。模型写错 TC 编号时，工具拒绝该断言而不切换、回退或覆盖其他用例。
- 调度器仅让相邻、同页面、共享前置条件且不改变页面状态的 TC 复用 setup。筛选、搜索、保存、分页等状态变更用例会隔离，且每个 TC 都必须独立断言。
- 工具失败、循环停滞和断言失败会保存最近决策轨迹、当前/前一份 DOM 摘要和相关交互契约；导出前会脱敏密钥、Token、Cookie 和 Bearer 值。
- Side Panel 可直接查看单条诊断详情；持久化层按数量和字节预算压缩旧记录，避免诊断数据撑满扩展存储。
- 测试结束时将用例状态、断言、总结和本次运行的诊断记录组成版本化报告，可导出为 JSON 或 Markdown 供缺陷跟踪和回归留档。
- 最近报告在扩展本地以数量和体积上限保存，可重新打开或再次导出；报告仅保留诊断摘要，详细轨迹仍存于错误记录。

## 视觉 + CDP

`visual-controller.js` 提供以下能力：

- `Page.captureScreenshot`：截图给视觉模型判断页面状态。
- `Input.dispatchMouseEvent`：真实鼠标移动、按下、释放、滚轮。
- `Input.dispatchKeyEvent` / `Input.insertText`：真实键盘和文本输入。
- `Page.getLayoutMetrics`：保证截图坐标和 CDP 坐标一致。

截图支持两种模式：

- `screenshot`：带可交互元素编号，帮助 AI 精确选择目标。
- `verify_ui`：无标注截图，专门用于布局、样式、视觉状态验证。

## 预设模板

预设模板用于减少 AI 在常见控件上的试错：

| 模板 | 目标 |
|---|---|
| `select_option` | 单选下拉，支持原生 select 和常见 UI 框架 |
| `select_multi` | 多选下拉/原生多选 |
| `fill_input` | 清空并输入，验证最终值 |
| `fill_form` | 批量填写表单，逐项验证 |
| `click_button` | 点击按钮，并可等待 loading/dialog/message/dropdown |
| `close_dialog` | 按钮、关闭图标、Escape 关闭弹窗 |
| `table_action` | 表格行内按钮操作 |
| `switch_tab` | Tab 切换 |
| `confirm_dialog` | 确认/取消弹窗 |
| `toggle_switch` | 开关、checkbox、radio 状态切换 |

模板设计原则：

- 页面内 JS 只用于定位和读取状态。
- 写操作全部由 CDP 完成。
- 有目标状态的操作必须验证。
- 失败时返回诊断信息，让 AI 能换策略。

## 网络录制

`network-recorder.js` 复用 `visual-controller.js` 的 CDP 连接，开启 Network 域：

- 记录 XHR/fetch 请求。
- 按 URL、方法、状态码、响应关键词过滤。
- 必要时通过 CDP 获取响应体。

测试断言应优先对比 API 响应和页面展示，避免只看 DOM 文本就误判。

## 安全边界

- API Key 只保存在扩展存储中，只由 Side Panel 读取。
- Key 不传给 Content Script，不注入被测页面，不进入 prompt。
- API URL 必须是 HTTP(S) 地址；非本机 HTTP 地址会显示传输安全警告，避免无意间用明文传输 API Key。
- 上传源码只用于本地索引和 AI 上下文，不写回页面。
- 源码上传按支持的文本后缀顺序读取并限制单文件读取量；成功替换源码时会使架构缓存失效，禁止新项目复用旧分析。
- CDP 连接在测试结束、用户中止、Side Panel 断开或 tab 关闭时清理。

## 已知限制

- `chrome.debugger` 同一 tab 只能有一个调试器连接。如果用户打开 DevTools 或其他工具占用 debugger，本产品会失败并提示，而不是降级成脚本模拟。
- 运行前会确认目标页面是可注入的 http(s)/file 页面，并注入观察器发送 PING；受限内部页和已关闭标签页会在 Agent 启动前失败。
- 交互失败轨迹同时记录目标和当前页面签名。相同目标在页面未变化时持续失败会先提示换策略，随后自动熔断并标记当前 TC 失败，避免无效轮次消耗。
- 原生浏览器下拉弹层不是 DOM 节点，模板通过 CDP 键盘路径处理原生 select。
- Canvas/WebGL 内部对象需要视觉坐标或业务源码辅助定位；`surface_interact` 先读取实时元素边界，再按 0-1 相对坐标发送 CDP 点击/拖拽，不依赖图表库或组件库。
- 封闭 Shadow DOM 只能通过视觉/CDP 坐标测试，无法通过普通 DOM 读取内部状态。
