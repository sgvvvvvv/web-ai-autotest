# AI 前端自动化测试浏览器扩展

> 一个 Chrome Side Panel 扩展：让 AI 读取前端项目源码、观察真实页面，并通过 CDP 真实鼠标键盘执行自动化测试。

## 项目简介

传统 AI 前端测试常常割裂成两类能力：

- 能读源码的 AI 编程助手，通常不能直接操作浏览器验证页面行为。
- 能操作浏览器的自动化工具，通常不了解项目源码和业务意图，只能在 DOM 上猜。

本项目把这两部分接起来：用户在扩展侧边栏上传源码、填写需求和测试用例，AI 会结合源码结构、DOM 快照、截图、网络响应和 CDP 真实输入来完成测试。

核心原则是：**Content Script 只负责观察，所有写操作都由 Chrome Debugger / CDP 执行。**

## 当前能力

- 选择目标标签页并在 Side Panel 中编排测试。
- 执行前校验目标 tab 是否可注入观察器，提前识别 Chrome 内部页、已关闭标签页和本地文件权限问题。
- 配置 OpenAI 兼容接口：`API URL`、`API Key`、`model`、上下文大小。
- 可选启用视觉模型能力：截图理解、标注截图、UI 验证截图。
- 可选启用模型 thinking 参数。
- 上传项目源码目录，支持 `.js`、`.vue`、`.ts`、`.jsx`、`.tsx`、`.css`、`.json`；每轮按当前页面、DOM 和 TC 召回相关文件，而非按上传顺序注入。
- 对上传源码做项目架构分析，并支持缓存、导入、导出。
- 基于「原始需求 + 架构分析」生成测试用例，并支持导出。
- 运行 AI 测试 Agent，支持中止、继续和运行中人工插话。
- 通过 CDP 执行点击、输入、滚动、按键、悬停、拖拽、截图和网络录制。
- 默认按测试环境执行：测试用例要求的新增、编辑、保存、提交、删除、确认删除、上传和下载都会通过真实 UI 执行；写操作后结合页面刷新和网络响应验证结果。
- 内置常见控件模板：下拉、多选、表单填写、按钮点击、弹窗、表格操作、Tab 切换、开关等。源码能从 `data-testid`、ARIA、placeholder、id/name 等稳定语义推导交互契约，优先点击实际承载状态变化的控件，而不是选项文字。
- 使用加载生命周期和页面状态稳定性等待，减少固定延迟造成的误判。
- 对同一 TC 的失败动作观察页面进展；同一目标持续失败且页面未变时自动熔断并记录诊断，避免几十轮重复尝试。
- 基础元素操作绑定到最新 DOM 快照引用或显式查找结果，阻止模型臆造 selector；断言只能归属当前执行中的 TC，编号不一致会被拒绝。
- 为 Canvas、SVG 与其他自绘交互面提供基于实时边界的相对坐标点击/拖拽，避免滚动、缩放或响应式布局导致坐标失准。
- 将相邻、同页面且只读的 TC 编为共享 setup 场景；会筛选、提交、翻页等改变状态的用例保持隔离。
- 记录测试断言、执行日志、AI 思考/响应流和测试结果；失败可导出脱敏后的决策轨迹、DOM 前后快照和工具诊断。

## 使用方式

### 1. 加载扩展

1. 打开 Chrome，进入 `chrome://extensions/`。
2. 开启「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本项目目录：`web-ai-autotest`。
5. 点击扩展图标打开 Side Panel。

本项目是原生 Manifest V3 扩展，目前没有构建步骤，不需要先运行 `npm install` 或打包命令。

### 2. 配置 AI

在侧边栏填写：

- `API URL`：例如 `https://api.openai.com/v1`，也可以是兼容 OpenAI Chat Completions 的本地或云端服务。
- `API Key`：仅保存在扩展本地存储中。
- `模型`：填写服务端支持的模型名。
- `上下文大小 (K)`：用于控制源码和上下文注入规模。
- `模型支持图片`：模型支持多模态图片输入时勾选。
- `启用深度思考模式`：仅在目标模型支持 `thinking` 参数时勾选。

### 3. 执行测试流程

1. 打开被测页面。
2. 在扩展侧边栏选择目标标签页。
3. 填写要测试的原始需求。
4. 上传项目源码目录，通常上传 `src` 即可。上传只读取支持的文本源码，并会使旧架构分析失效，避免跨项目复用上下文。
5. 点击「分析架构」，生成或导入架构分析。
6. 点击「AI 生成（基于需求+架构）」生成测试用例，或手动填写用例。
7. 点击「运行 AI 测试」。
8. 根据需要在运行中使用输入框追加指令，例如“跳过当前用例”“检查弹窗”“换一种方式”。

## 文件结构

```text
web-ai-autotest/
├── manifest.json
├── background/
│   └── service-worker.js        # Side Panel 行为、tab 关闭和 debugger 清理
├── content/
│   └── content.js               # DOM 快照、可交互元素、导航结构采集
├── core/
│   ├── agent-loop.js            # Agent 主循环、工具调度、防死循环
│   ├── ai-client.js             # OpenAI 兼容 Chat Completions 调用、流式输出、重试
│   ├── action-templates.js      # 常见控件的确定性操作模板
│   ├── network-recorder.js      # CDP Network 请求/响应记录
│   ├── project-analyzer.js      # 项目架构、路由、菜单、API、组件分析
│   ├── prompt-builder.js        # System Prompt、上下文和工具 schema
│   ├── source-analyzer.js       # 源码结构分析
│   ├── source-reader.js         # 上传源码索引和检索
│   ├── interaction-contract.js   # 源码交互契约匹配
│   ├── test-scheduler.js         # 共享 setup 的场景编排
│   ├── redaction.js              # 错误导出敏感信息脱敏
│   ├── diagnostic-store.js        # 错误诊断本地存储容量控制
│   ├── test-report.js              # 结构化测试报告与 Markdown 导出
│   ├── run-history.js               # 有容量上限的报告历史
│   ├── tab-eligibility.js            # 目标页面资格判断
│   ├── progress-guard.js              # 基于页面进展的交互停滞熔断
│   ├── config-validator.js       # API 端点与模型配置校验
│   ├── test-summary-cache.js    # 用例间摘要缓存
│   └── visual-controller.js     # CDP 截图、鼠标、键盘、滚轮、拖拽
├── sidepanel/
│   ├── sidepanel.html           # 侧边栏 UI
│   ├── sidepanel.css
│   └── sidepanel.js             # UI 状态、配置、源码上传、架构分析、测试编排
├── devtools/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
├── docs/
    ├── architecture.md
    └── feasibility-analysis.md
├── tests/
│   └── run-tests.js              # 无依赖回归测试
└── package.json                  # 静态检查与测试命令
```

## 架构说明

```mermaid
flowchart TB
    User["用户"] --> Panel["Side Panel"]
    Panel --> AI["OpenAI 兼容 API"]
    Panel --> Source["上传源码索引"]
    Panel --> CS["Content Script 观察层"]
    Panel --> CDP["Chrome Debugger / CDP"]
    CS --> Page["被测页面"]
    CDP --> Page
    CDP --> Network["Network 请求/响应"]
    CDP --> Shot["截图/视觉验证"]
```

各模块职责：

- **Side Panel**：唯一编排入口，负责读取配置、上传源码、调用 AI、运行 Agent Loop、展示日志和结果。
- **Content Script**：只观察页面，采集 DOM 快照、可交互元素、页面文本和运行时导航。
- **Chrome Debugger / CDP**：执行真实鼠标、键盘、滚轮、截图、拖拽和网络监听。
- **Background Service Worker**：处理侧边栏打开行为，并在 tab 关闭或侧边栏断开时清理 debugger。

## Agent 工具能力

AI 在测试过程中可调用的工具主要包括：

- 基础操作：`click`、`type`、`press`、`scroll`、`hover`。`click`/`type`/元素滚动/悬停优先使用 DOM 快照中的 `elementRef`，也只接受已观察到的 selector。
- 视觉/坐标操作：`screenshot`、`verify_ui`、`visual_click`、`visual_type`、`visual_scroll`、`visual_drag`、`visual_press`
- 自绘交互：`surface_interact`，对 Canvas、SVG、视频或其他自绘表面按实时元素边界执行相对坐标点击或拖拽。
- 智能定位：`find_element`、`smart_click`、`smart_type`
- 预设模板：`select_option`、`select_multi`、`fill_input`、`fill_form`、`click_button`、`close_dialog`、`table_action`、`switch_tab`、`confirm_dialog`、`toggle_switch`
- 状态读取：`eval_in_page`、`read_source`、`get_network_responses`
- 测试结果：`assert`、`finish`、`wait`

其中 `eval_in_page` 只用于读取页面状态，不能用于模拟用户操作。

## 安全与边界

- API Key 只保存在 `chrome.storage.local`，由 Side Panel 读取。
- API Key 不传给 Content Script，不注入被测页面，也不进入 prompt。
- 非本机 HTTP API 地址会给出传输安全警告；生产服务建议使用 HTTPS。错误导出会隐藏 Key、Token、Cookie 和 Bearer 凭据。
- 错误记录可在侧边栏直接查看 AI 推理、工具轨迹、DOM 前后快照；本地记录有数量和体积上限，旧记录会优先压缩而非影响执行。
- 测试完成后可导出 JSON 或 Markdown 报告，包含用例状态、断言、AI 总结及本次运行关联的错误诊断。
- 最近测试报告会保存在扩展本地，可重新查看或再次导出；历史只保留有限条目和摘要，完整诊断仍由错误记录管理。
- 上传源码只在扩展侧本地索引，并按上下文需要提供给 AI。
- 写操作不使用 `el.click()`、`dispatchEvent()`、直接修改 `value` 等脚本模拟兜底。
- 如果 CDP attach 失败，测试会失败或提示环境不可用，而不是降级成不真实的脚本操作。

## 已知限制

- Chrome 同一 tab 只能有一个 debugger 连接。打开 DevTools 或其他自动化工具时可能导致 CDP attach 失败。
- 原生文件选择器、系统级弹窗、真实硬件输入等场景仍需要额外能力。
- 跨域 iframe、封闭 Shadow DOM、Canvas/WebGL 内部对象通常需要视觉坐标或业务源码辅助；可用 `surface_interact` 以相对坐标执行真实输入，结果仍需通过 DOM、截图或网络响应验证。
- 视觉能力依赖所配置模型是否真正支持图片输入。
- 浏览器交互仍需在加载扩展后手动验收；仓库提供纯 Node 回归测试和 JavaScript 静态语法检查。

## 文档索引

- [架构设计](docs/architecture.md)
- [可行性分析](docs/feasibility-analysis.md)

## 开发备注

- 修改扩展代码后，在 `chrome://extensions/` 中点击刷新扩展，再重新打开 Side Panel。
- 调试时建议先关闭目标页面 DevTools，避免占用 `chrome.debugger`。
- 如果测试中断或页面关闭，Background 和 Side Panel 会尝试自动分离 debugger。
- 修改后可运行 `npm test` 和 `npm run check`；两者均无需安装依赖。
