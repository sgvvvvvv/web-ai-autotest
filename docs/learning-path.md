# AI 前端自动化测试 — 从 0 到 1 学习路径

> 本文档基于项目实际代码梳理，按**由浅入深、由核心到外围**的顺序组织。
> 每个阶段列出：学习目标、对应文件、核心概念、建议的 AI 对话问题。

---

## 目录

- [第 0 阶段：建立全局认知](#第-0-阶段建立全局认知)
- [第 1 阶段：Agent 的心脏 — 主循环](#第-1-阶段agent-的心脏--主循环)
- [第 2 阶段：Agent 的嘴和耳 — Prompt 与工具定义](#第-2-阶段agent-的嘴和耳--prompt-与工具定义)
- [第 3 阶段：Agent 的手脚 — 工具执行层](#第-3-阶段agent-的手脚--工具执行层)
- [第 4 阶段：Agent 的大脑 — AI 客户端与模型通信](#第-4-阶段agent-的大脑--ai-客户端与模型通信)
- [第 5 阶段：Agent 的眼睛 — 页面观察与上下文](#第-5-阶段agent-的眼睛--页面观察与上下文)
- [第 6 阶段：Agent 的护栏 — 安全与防死循环](#第-6-阶段agent-的护栏--安全与防死循环)
- [第 7 阶段：Agent 的记忆 — 上下文管理与编排](#第-7-阶段agent-的记忆--上下文管理与编排)
- [第 8 阶段：Agent 的输出 — 报告与诊断](#第-8-阶段agent-的输出--报告与诊断)
- [第 9 阶段：Chrome 扩展骨架](#第-9-阶段chrome-扩展骨架)
- [第 10 阶段：企业级 Agent 进阶](#第-10-阶段企业级-agent-进阶)

---

## 第 0 阶段：建立全局认知

**学习目标**：理解这个项目在做什么、为什么这样设计、整体数据怎么流转。

**阅读文件**：
- `README.md` — 项目全貌，功能列表，使用方式
- `docs/architecture.md` — 架构设计，核心原则，数据流图
- `manifest.json` — Chrome 扩展权限声明

**核心概念**：

| 概念 | 说明 |
|------|------|
| **核心原则** | Content Script 只观察，CDP 负责所有写操作 |
| **Side Panel** | 唯一编排入口，调用 AI、运行 Agent Loop、管理源码和工具 |
| **CDP** | Chrome DevTools Protocol，通过 `chrome.debugger` 实现真实鼠标/键盘/截图 |
| **Agent Loop** | 读上下文 → 调 AI → 执行工具 → 观察结果 → 循环 |
| **Function Calling** | 模型输出结构化的工具调用请求，外部代码执行后把结果返回给模型 |

**数据流**：
```
用户 → Side Panel → AI API（模型决定调什么工具）
                   ↓
           Content Script（观察 DOM）
           CDP（执行真实操作：点击/输入/截图）
                   ↓
           结果返回给模型 → 下一轮循环
```

**建议 AI 对话问题**：
- "这个项目的核心设计原则是什么？为什么 Content Script 只观察不写？"
- "Agent Loop 的整体流程是什么？一轮循环包含哪些步骤？"
- "CDP 是什么？为什么不用 `el.click()` 或 `dispatchEvent` 模拟用户操作？"
- "Function Calling 在这个项目中是怎么工作的？模型怎么知道有哪些工具可用？"

---

## 第 1 阶段：Agent 的心脏 — 主循环

**学习目标**：理解 Agent 主循环的每一行代码，知道一轮循环从开始到结束发生了什么。

**阅读文件**：
- `core/agent-loop.js` — **项目最核心的文件**，约 3800+ 行

**建议阅读方式**：这个文件很大，不要一次读完。按以下顺序分段：

### 1.1 循环常量与配置（第 1-76 行）

理解这些"旋钮"为什么这样设置：

| 常量 | 值 | 作用 |
|------|-----|------|
| `LOOP_GUARD` | 4 | 连续 4 轮相同动作无进展时收尾 |
| `MAX_TC_ROUNDS` | 30 | 单个测试用例最大执行轮数 |
| `DOOM_LOOP_THRESHOLD` | 5 | 连续 5 次完全相同的工具调用触发死循环 |
| `MAX_STEPS_BASE` | 50 | Agent 最大步数基础值 |
| `MAX_STEPS_PER_TC` | 30 | 每个测试用例额外步数 |

### 1.2 死循环检测（第 46-237 行）

三种检测机制，理解每种检测什么模式、为什么需要：

| 函数 | 检测什么 | 为什么需要 |
|------|---------|-----------|
| `detectDoomLoop` | 连续 N 次完全相同的工具调用 | 模型卡在同一动作反复执行 |
| `detectOscillation` | A→B→A→B 振荡模式 | 模型在两个动作间来回切换 |
| `detectAreaLoop` | 同一屏幕区域反复尝试不同工具 | 模型在同一位置换着工具试 |

### 1.3 Agent Loop 创建与主流程（第 257 行起 `createAgentLoop`）

这是最核心的部分。理解：
- 依赖注入模式：`deps` 参数传入了哪些能力
- 主循环 `run()` 方法：如何一轮一轮地调 AI、执行工具、收集结果
- 工具分发 `executeAction()`：根据工具名路由到不同的执行函数
- 每轮结束后的上下文更新：DOM 快照、截图、网络摘要、历史记录

### 1.4 工具执行（`executeAction` 内部）

理解每个工具是怎么执行的：
- `click` / `type` / `press` → 调 `visual-controller` 的 CDP 方法
- `select_option` 等模板 → 调 `action-templates` 的预设序列
- `assert` → 记录断言，更新测试用例状态
- `finish` → 暂停循环，等待用户指令
- `eval_in_page` → 在页面执行只读 JS
- `read_source` → 从上传源码中检索文件
- `get_network_responses` → 查询已捕获的网络请求

**建议 AI 对话问题**：
- "agent-loop.js 的主循环 run() 方法是怎么工作的？逐步解释每一轮的流程"
- "detectDoomLoop 检测的是什么模式？为什么 DOOM_LOOP_THRESHOLD 设为 5？"
- "createAgentLoop 的 deps 参数为什么用依赖注入？如果直接在内部 new 会怎样？"
- "executeAction 是怎么根据工具名分发到不同执行函数的？"
- "MAX_STEPS_BASE 和 MAX_STEPS_PER_TC 是怎么动态计算最大步数的？为什么需要上限？"
- "MAX_STEPS_PROMPT 是什么？达到最大步数后模型会收到什么指令？"

---

## 第 2 阶段：Agent 的嘴和耳 — Prompt 与工具定义

**学习目标**：理解如何构建 System Prompt、如何定义工具 Schema、如何组装每轮消息。

**阅读文件**：
- `core/prompt-builder.js` — 约 1200 行

**核心概念**：

### 2.1 System Prompt 分层结构

```
buildSystemPrompt(visionSupported)
  ├── buildEnvironmentContext()    — 环境信息（运行环境、操作方式、数据授权）
  ├── buildSystemPromptBase()       — 核心指令（角色、原则、工具使用、断言标准）
  └── SYSTEM_PROMPT_VISION          — 视觉能力补充指令（仅视觉模式）
```

借鉴了 OpenCode 的分层设计：环境信息与指令分离。

### 2.2 工具 Schema 定义（`buildTools` 函数，第 659 行起）

理解 OpenAI Function Calling 的工具定义格式：
```json
{
  "type": "function",
  "function": {
    "name": "click",
    "description": "点击元素...",
    "parameters": { "type": "object", "properties": {...}, "required": [...] }
  }
}
```

工具分为三大类：
- **基础操作**：click、type、press、scroll、hover、surface_interact、upload_file
- **预设模板**：select_option、select_multi、fill_input、fill_form、click_button、close_dialog、table_action、switch_tab、confirm_dialog、toggle_switch
- **观察与控制**：find_element、eval_in_page、read_source、get_network_responses、screenshot、verify_ui、assert、finish、wait

### 2.3 消息构建（`buildMessages` 函数）

理解首轮消息 vs 后续轮次消息的区别：
- **首轮**：System Prompt + 需求 + 用例 + 架构 + 源码 + DOM 快照 + 截图
- **后续轮**：重放对话历史 + 当前观察（最新快照 + 进度 + 网络 + 历史）
- **视觉模式**：多模态消息（文本 + 图片），历史消息中清除旧截图节省 token

### 2.4 上下文注入策略

理解每轮消息中注入了哪些上下文，以及为什么：
- 源码按需召回（`MAX_SOURCE_PER_MSG = 5`，`MAX_SOURCE_CHARS = 6000`）
- DOM 快照裁剪（`MAX_SNAPSHOT_NODES = 60`）
- 测试用例进度（当前用例、待执行用例、场景信息）
- 网络请求摘要（最近 15 条）
- 动作历史（最近 20 条）
- 收尾预算提醒（轮次快到上限时的警告）

**建议 AI 对话问题**：
- "buildSystemPrompt 为什么要分层？环境信息和指令为什么要分开？"
- "buildTools 定义了多少个工具？分几类？每类的用途是什么？"
- "首轮消息和后续轮次消息有什么区别？为什么要清除历史消息中的旧截图？"
- "MAX_SOURCE_PER_MSG 和 MAX_SOURCE_CHARS 是做什么的？为什么要限制？"
- "buildObservationMessage 是怎么构建每轮观察消息的？注入了哪些信息？"
- "anyOf 在工具 schema 中是什么意思？为什么 click 工具用 anyOf？"

---

## 第 3 阶段：Agent 的手脚 — 工具执行层

**学习目标**：理解工具定义之后，实际执行工具的代码是怎么工作的。

**阅读文件**：
- `core/visual-controller.js` — CDP 截图、鼠标、键盘、滚轮、拖拽
- `core/action-templates.js` — 预设操作模板（下拉、表单、按钮等）
- `core/network-recorder.js` — CDP 网络请求/响应录制

### 3.1 Visual Controller（CDP 执行层）

理解 CDP 的核心操作：
- `attach(tabId)` / `detach()` — 附加/分离 debugger
- `sendCommand(method, params)` — 发送 CDP 命令
- `Input.dispatchMouseEvent` — 真实鼠标移动、按下、释放
- `Input.dispatchKeyEvent` / `Input.insertText` — 真实键盘输入
- `Page.captureScreenshot` — 截图
- `Page.getLayoutMetrics` — 获取布局度量（保证坐标一致）

关键设计：
- 同一 tab 只能有一个 debugger 连接
- attach 失败直接报错，不降级为脚本模拟
- 截图分两种：`screenshot`（带标注）和 `verify_ui`（无标注）

### 3.2 Action Templates（预设模板）

理解为什么需要预设模板：
- AI 在简单交互上容易反复试错（比如下拉框选一个选项可能拆成多轮点击）
- 模板用确定性的 JS + CDP 序列一步完成，减少 AI 的决策负担

每个模板的设计模式：
1. 只读定位（JS 在页面内找到元素坐标和状态）
2. CDP 真实操作（鼠标点击、键盘输入）
3. 验证结果（检查状态是否已变更）

### 3.3 Network Recorder

理解网络录制的工作原理：
- 复用 `visual-controller` 的 CDP 连接
- 监听 `Network.requestWillBeSent` 和 `Network.responseReceived` 事件
- 记录 URL、method、status、请求体、响应体
- 提供 `searchResponses()` 供 AI 按关键词检索

**建议 AI 对话问题**：
- "visual-controller 的 attach 和 detach 是怎么工作的？为什么同一 tab 只能有一个 debugger？"
- "CDP 的 Input.dispatchMouseEvent 和 el.click() 有什么本质区别？"
- "action-templates 为什么要把操作封装成模板？不封装会怎样？"
- "select_option 模板内部的执行步骤是什么？它是怎么处理不同 UI 框架的？"
- "network-recorder 是怎么监听网络请求的？为什么要复用 visual-controller 的 CDP 连接？"
- "screenshot 和 verify_ui 有什么区别？为什么要分两种？"

---

## 第 4 阶段：Agent 的大脑 — AI 客户端与模型通信

**学习目标**：理解如何调用大模型 API、如何处理流式输出、如何做模型能力探测和降级。

**阅读文件**：
- `core/ai-client.js` — 约 1090 行

### 4.1 基础调用（`chat` 和 `chatStream`）

两个核心函数：
- `chat()` — 非流式调用，等待完整响应
- `chatStream()` — 流式调用，实时回调 delta

理解：
- 超时控制（`DEFAULT_TIMEOUT = 600000`，600 秒）
- 重试机制（`DEFAULT_MAX_RETRIES = 3`，指数退避 `2s → 4s → 8s`）
- 用户中止（`AbortController` + 外部 `signal`）
- 4xx 不重试（除 429）

### 4.2 流式 SSE 解析

理解 Server-Sent Events 的解析过程：
- 按 `\n` 分行，处理 `data:` 前缀
- 累积 `content`、`reasoning_content`、`tool_calls` 三种 delta
- 流结束时处理 buffer 中未完成的最后一行

### 4.3 流内死循环检测

这是 `ai-client.js` 最精妙的部分。理解三类检测：

| 检测类型 | 函数 | 触发条件 | 处理方式 |
|---------|------|---------|---------|
| 精确段落重复 | `detectRepeatedBlock` | 同一段落重复 N 次 | 抛 `ReasoningLoopError` |
| 模糊段落重复 | `detectFuzzyRepeatedBlock` | 高度相似段落重复 N 次 | 抛 `ReasoningLoopError` |
| 无动作长篇推理 | 字符数检查 | 有工具但持续只输出推理 | 抛 `ReasoningLoopError` |
| 推理超时 | 时间检查 | reasoning 持续超过 600 秒 | 优雅截断，抛 `ReasoningTimeoutError` |

关键设计：
- 滑动窗口（`REPEAT_WINDOW_SIZE = 4000`）：只检查最近 4000 字符，避免长文本中合理引用被误判
- 跳过数字密集段落：数据分析中反复引用相同数字是正常的
- 模糊检测提取特征签名：去掉标点/空格/数字后比对完整内容

### 4.4 模型能力探测与降级

理解运行时探测 + 缓存的降级策略：

**Function Calling 降级**：
1. 先查静态能力表（`models.dev` API）
2. 发送 `tools` + `tool_choice: "auto"`
3. 如果 4xx 且错误信息匹配"不支持函数调用" → 缓存结论，降级为文本协议
4. 文本协议：把工具 schema 转为文本说明，要求模型在正文输出 JSON

**Thinking 参数降级**：
1. 按模型家族选择初始格式（GLM 用 `thinking: {type:"enabled"}`，Qwen 用 `enable_thinking: true`）
2. 4xx 时级联降级：`glm → qwen → none`
3. "thinking + tools 组合被拒"时单独缓存，带 tools 时跳过 thinking

**采样参数**：
- 能力表明确不支持 `temperature` 时不发送
- 已知家族用调优值（如 Qwen 0.55，GLM-4.6 1.0）
- 其余默认 0.5

### 4.5 工具调用提取（`extractToolCalls`）

理解两种模式：
- **标准模式**：模型返回 `message.tool_calls` 数组
- **文本协议模式**：模型在 `message.content` 中输出 JSON，需要解析

文本协议的解析策略：
1. 先剥离 Markdown 代码块标记
2. 尝试严格 JSON.parse
3. 失败则用 `extractEmbeddedActionJson` 宽松提取（取第一个 `[`/`{` 到最后一个 `]`/`}`）

**建议 AI 对话问题**：
- "chat 和 chatStream 有什么区别？为什么需要两个？"
- "流式 SSE 是怎么解析的？为什么要处理 buffer 中未完成的行？"
- "detectRepeatedBlock 的滑动窗口是什么意思？为什么不用全量文本检测？"
- "detectFuzzyRepeatedBlock 和 detectRepeatedBlock 有什么区别？为什么要做模糊检测？"
- "模型不支持 Function Calling 时怎么降级？文本协议是怎么工作的？"
- "thinking 参数的 GLM 格式和 Qwen 格式有什么区别？为什么要级联降级？"
- "models.dev 是什么？为什么要拉取它？拉取失败会怎样？"
- "extractToolCalls 是怎么从文本中提取工具调用的？为什么要做宽松解析？"

---

## 第 5 阶段：Agent 的眼睛 — 页面观察与上下文

**学习目标**：理解 Agent 如何观察页面、如何管理源码上下文、如何从源码中提取交互信息。

**阅读文件**：
- `content/content.js` — DOM 快照采集、元素选择器生成
- `core/source-reader.js` — 上传源码索引和检索
- `core/source-analyzer.js` — 源码组件信息提取
- `core/interaction-contract.js` — 源码交互契约匹配
- `core/project-analyzer.js` — 项目架构分析

### 5.1 Content Script（页面观察层）

理解 Content Script 的职责边界：
- 采集 DOM 快照：可交互元素、文本、控件值、导航信息
- 生成候选 selector：为每个元素生成稳定的 CSS 选择器
- 采集浮层元素：下拉选项等挂载在 body 下的浮层
- 跨域 iframe：分别注入观察器，生成 frame 专属元素引用
- **不执行任何写操作**：不调用 `el.click()`、不修改 `value`

### 5.2 Source Reader（源码管理）

理解源码的存储和检索：
- 用户手动上传源码文件（`{ path: content }` 字典）
- 支持的文件类型：`.vue`、`.tsx`、`.jsx`、`.ts`、`.js`、`.json`
- 单文件最大 8000 字符（截断）
- `searchByKeywords`：按关键词检索相关文件

### 5.3 Source Analyzer（源码分析）

理解从源码中提取了什么结构化信息：
- `selectors` — 选择器信息（selector、type、label、options、currentValue）
- `options` — 选项列表（name、values、source）
- `bindings` — 元素绑定关系
- `forms` — 表单字段和提交按钮
- `tables` — 表格列和操作
- `interactions` — 交互契约（trigger、reveal、activation、apply）

### 5.4 Interaction Contract（交互契约）

理解交互契约的作用：
- 从源码分析中推导出"触发器 → 展开 → 激活 → 提交"的操作链
- 让模板知道该点哪里、怎么展开、怎么确认
- `match` 函数：根据 trigger 参数匹配对应的契约
- 匹配分数制：精确匹配 100 分，placeholder 模糊匹配 60 分
- 同分时不武断选择，回退到运行时语义解析

### 5.5 Project Analyzer（架构分析）

理解项目架构分析输出什么：
- 路由地图：React Router、Vue Router、Next.js 约定式路由
- 导航结构：菜单、侧边栏、Tab
- API 映射：接口调用与页面组件的对应关系
- 组件归属：页面用了哪些组件

**建议 AI 对话问题**：
- "Content Script 为什么只观察不写？如果让它也执行点击会怎样？"
- "DOM 快照是怎么生成的？可交互元素是怎么判断的？"
- "source-reader 的 searchByKeywords 是怎么排序的？为什么要按关键词召回？"
- "source-analyzer 从 Vue/React 源码中提取了哪些信息？为什么要提取？"
- "交互契约是什么？它是怎么从源码推导出来的？模板怎么使用它？"
- "project-analyzer 是怎么分析路由的？支持哪些框架？"

---

## 第 6 阶段：Agent 的护栏 — 安全与防死循环

**学习目标**：理解 Agent 的安全边界、防死循环机制、元素引用校验。

**阅读文件**：
- `core/agent-guard.js` — 元素引用校验、断言归属校验
- `core/progress-guard.js` — 基于页面进展的交互停滞熔断
- `core/redaction.js` — 敏感信息脱敏
- `core/config-validator.js` — API 配置校验
- `core/tab-eligibility.js` — 目标页面资格判断

### 6.1 Agent Guard（操作校验）

理解两层校验：
- **元素引用校验**（`resolveObservedTarget`）：模型只能操作已观察到的元素
  - 检查 `elementRef` 是否在最新快照中存在
  - 检查 `selector` 是否来自快照、`find_element` 结果或源码契约
  - 不允许模型臆造 selector
- **断言归属校验**（`validateAssertionForCurrent`）：断言只能归属当前用例
  - 检查描述中的 TC 编号是否与当前用例一致
  - 编号不一致时拒绝，不切换或覆盖其他用例

### 6.2 Progress Guard（进展熔断）

理解基于页面进展的停滞检测：
- `snapshotSignature`：对页面快照取签名（URL + 标题 + 元素数 + 文本哈希）
- `targetKey`：对操作目标取键（selector / trigger / point 坐标）
- 同一目标反复失败 + 页面未变化 → 熔断
- 被动工具（assert、wait、screenshot 等）不参与检测

### 6.3 安全边界

理解项目的安全设计：
- API Key 只存在 `chrome.storage.local`，不进 prompt，不传给 Content Script
- API URL 不允许嵌入用户名密码
- 导出诊断时脱敏：Bearer Token、sk- 密钥、Cookie、URL 中的密码参数
- `eval_in_page` 只用于读取状态，不能模拟操作
- 文件上传通过专用 `upload_file` 工具，不执行任意 JS

**建议 AI 对话问题**：
- "agent-guard 的 resolveObservedTarget 是怎么校验元素引用的？为什么要校验？"
- "如果模型臆造了一个不存在的 selector，会发生什么？"
- "progress-guard 是怎么检测交互停滞的？snapshotSignature 是什么？"
- "redaction.js 脱敏了哪些信息？为什么要脱敏？"
- "为什么 eval_in_page 只能读取不能操作？如果模型用它执行了 click 会怎样？"

---

## 第 7 阶段：Agent 的记忆 — 上下文管理与编排

**学习目标**：理解 Agent 如何管理上下文窗口、如何编排测试用例、如何在用例间传递摘要。

**阅读文件**：
- `core/test-scheduler.js` — 共享 setup 的场景编排
- `core/test-summary-cache.js` — 用例间摘要缓存
- `core/diagnostic-store.js` — 错误诊断存储容量控制
- `core/run-history.js` — 报告历史管理

### 7.1 Test Scheduler（测试编排）

理解场景编排策略：
- `isStateChanging`：判断用例是否会改变页面状态（筛选、搜索、新增、删除等）
- 只让**相邻、同页面、不改变状态**的用例复用 setup
- 状态变更用例独立隔离
- 每个 TC 必须独立 assert

### 7.2 Summary Cache（摘要缓存）

理解用例间的上下文传递：
- 每个用例完成后生成摘要
- 下一个用例开始前读取摘要，注入到初始消息中
- 缓存在 `chrome.storage.local`，`finish` 时清空

### 7.3 存储容量控制

理解为什么需要容量控制：
- `diagnostic-store`：诊断记录有数量和体积上限，旧记录优先压缩
- `run-history`：报告历史最多 20 条，最大 1MB，超限时从最旧的开始删除
- Chrome 扩展存储有配额限制，不控制会导致写入失败

**建议 AI 对话问题**：
- "test-scheduler 是怎么判断用例是否改变页面状态的？为什么要做场景编排？"
- "共享 setup 的用例和不共享的用例在执行时有什么区别？"
- "test-summary-cache 是怎么在用例间传递上下文的？为什么要传递？"
- "diagnostic-store 为什么要做容量控制？compactRecord 做了什么？"
- "run-history 的 trim 策略是什么？为什么要限制报告数量和体积？"

---

## 第 8 阶段：Agent 的输出 — 报告与诊断

**学习目标**：理解测试完成后如何生成报告、如何导出诊断信息。

**阅读文件**：
- `core/test-report.js` — 结构化测试报告与 Markdown 导出
- `core/diagnostic-store.js` — 错误诊断存储（第 7 阶段已涉及）

### 8.1 Test Report

理解报告包含什么：
- 统计信息：总数、通过、失败、待确认、跳过、通过率
- 用例详情：ID、标题、页面、步骤、预期、状态、断言
- 错误诊断摘要：关联的错误记录
- 导出格式：JSON 和 Markdown

### 8.2 断言格式化

理解断言的结构化处理：
- `formatAssertionDescription`：解析断言文本，提取编号、状态图标、内容
- `assertionOutcomeFromItems`：从分项内容自动推断 outcome（有 ❌ → failed，有 ❕ → inconclusive，全 ✅ → passed）

**建议 AI 对话问题**：
- "test-report 生成的报告包含哪些信息？"
- "assertionOutcomeFromItems 是怎么从断言文本自动推断结果的？"
- "为什么报告要关联错误诊断记录？"

---

## 第 9 阶段：Chrome 扩展骨架

**学习目标**：理解 Chrome Manifest V3 扩展的基础结构。

**阅读文件**：
- `manifest.json` — 扩展配置
- `background/service-worker.js` — 后台 Service Worker
- `sidepanel/sidepanel.html` — 侧边栏 UI
- `sidepanel/sidepanel.js` — UI 状态管理和编排入口
- `sidepanel/sidepanel.css` — 样式

### 9.1 Manifest V3

理解权限设计：
- `sidePanel` + `tabs`：选择目标标签页并打开侧边栏
- `scripting` + `activeTab`：注入观察脚本
- `storage`：保存配置和用户输入
- `debugger`：CDP 截图、真实鼠标键盘、网络录制
- `host_permissions: ["<all_urls>"]`：允许 fetch AI 端点

### 9.2 Service Worker

理解 Background 的职责：
- 点击扩展图标时打开 Side Panel
- Tab 关闭时清理 CDP debugger
- Side Panel 断开时清理 debugger

### 9.3 Side Panel

理解 Side Panel 作为唯一编排入口的职责：
- 读取配置（API URL、Key、Model）
- 上传源码
- 调用架构分析
- 生成测试用例
- 运行 Agent Loop
- 展示日志和结果
- 管理运行中人工插话

**建议 AI 对话问题**：
- "Manifest V3 的 sidePanel 权限是做什么的？和 popup 有什么区别？"
- "Service Worker 在这个项目里只做了两件事，为什么这么少？"
- "Side Panel 为什么是唯一编排入口？为什么不让 Content Script 也调 AI？"
- "debugger 权限会让 Chrome 显示什么提示？为什么这是正常的？"

---

## 第 10 阶段：企业级 Agent 进阶

**学习目标**：理解当前项目缺少的、企业级 Agent 需要补的能力。

### 10.1 当前项目已具备的 Agent 能力

| 能力 | 对应实现 | 成熟度 |
|------|---------|--------|
| Agent Loop（ReAct 模式） | `agent-loop.js` | ✅ 完整 |
| Function Calling | `prompt-builder.js` + `ai-client.js` | ✅ 完整 |
| 流式输出 | `ai-client.js` chatStream | ✅ 完整 |
| 死循环检测（3 种） | doom loop + oscillation + area loop | ✅ 完整 |
| 流内死循环检测 | `ai-client.js` 精确+模糊重复检测 | ✅ 完整 |
| 步数上限 + 熔断 | MAX_STEPS + progress-guard | ✅ 完整 |
| 模型能力探测与降级 | function calling + thinking 级联降级 | ✅ 完整 |
| 上下文窗口管理 | 源码按需召回 + DOM 裁剪 + 摘要缓存 | ✅ 完整 |
| 多模态（视觉） | 截图 + 标注 + verify_ui | ✅ 完整 |
| 安全边界 | 元素引用校验 + 脱敏 + 只读 eval | ✅ 完整 |
| 人机协作 | 运行中人工插话 | ✅ 完整 |
| 错误诊断 | diagnostic-store + 轨迹导出 | ✅ 完整 |

### 10.2 企业级 Agent 还需要补的

| 能力 | 说明 | 学习方向 |
|------|------|---------|
| **多 Agent 协作** | 当前是单 Agent；企业级常需要 Planner + Executor + Reviewer | 研究 LangGraph、CrewAI、AutoGen |
| **持久化记忆** | 当前只有 run-history 和 summary-cache；需要跨会话记忆 | 研究 Mem0、Letta、Zep |
| **工具权限控制** | 当前所有工具全开放；需要按角色/场景限制 | 研究 RBAC + 工具白名单 |
| **可观测性 / Tracing** | 当前有 console.warn 日志；需要结构化 trace | 研究 LangSmith、Langfuse、OpenTelemetry |
| **成本控制** | 当前无 token 用量监控；需要预算上限和告警 | 研究 token 计数 + 预算熔断 |
| **评估体系** | 当前无 Agent 质量量化；需要 eval 框架 | 研究 DeepEval、Promptfoo |
| **RAG** | 当前源码检索是关键词匹配；可升级为向量检索 | 研究 Embedding + 向量数据库 |
| **多轮规划** | 当前是单步 ReAct；可升级为 Plan-and-Execute | 研究 Plan-and-Execute、ReWOO |
| **并发执行** | 当前串行执行用例；可并行独立用例 | 研究 Promise.all + 状态隔离 |
| **部署形态** | 当前是浏览器扩展；可迁移为服务端 Agent | 研究 FastAPI + WebSocket + Sandbox |

**建议 AI 对话问题**：
- "单 Agent 和多 Agent 协作有什么区别？什么场景需要多 Agent？"
- "Agent 的持久化记忆怎么做？和当前的 summary-cache 有什么区别？"
- "LangSmith 和 Langfuse 是做什么的？为什么 Agent 需要 Tracing？"
- "Plan-and-Execute 和 ReAct 有什么区别？各自适合什么场景？"
- "如果要把这个浏览器扩展改造成服务端 Agent，需要改什么？"
- "Agent 的评估体系怎么做？怎么量化 Agent 的质量？"

---

## 学习节奏建议

| 阶段 | 预计时间 | 方式 |
|------|---------|------|
| 第 0 阶段 | 1 天 | 读文档，建立全局认知 |
| 第 1 阶段 | 3-5 天 | 逐段读 `agent-loop.js`，每段用 AI 对话深入理解 |
| 第 2 阶段 | 2-3 天 | 读 `prompt-builder.js`，理解 prompt 工程和工具定义 |
| 第 3 阶段 | 2-3 天 | 读 `visual-controller.js` 和 `action-templates.js` |
| 第 4 阶段 | 3-5 天 | 读 `ai-client.js`，这是第二难的文件，重点理解降级策略 |
| 第 5 阶段 | 2-3 天 | 读观察层和源码分析模块 |
| 第 6 阶段 | 1-2 天 | 读护栏和安全模块 |
| 第 7 阶段 | 1-2 天 | 读编排和存储模块 |
| 第 8 阶段 | 1 天 | 读报告模块 |
| 第 9 阶段 | 1 天 | 读扩展骨架 |
| 第 10 阶段 | 持续 | 按兴趣深入各方向 |

**总计约 3-4 周可以完整理解整个项目。**

---

## 学习方法论

1. **先读文件头注释**：每个文件第 1-5 行的注释说明了它的职责和运行上下文
2. **先理解"为什么"再理解"怎么做"**：每个设计决策都有原因，先搞清楚动机
3. **用 AI 对话深入**：遇到不懂的代码段，直接贴给 AI 问"这段代码在做什么？为什么这样写？"
4. **尝试手写最小版本**：学完第 1-4 阶段后，尝试不靠 AI 生成，手写一个 2 个工具、50 行的 Agent
5. **对比理解**：手写完最小版本后，回来对比项目里的实现，理解差异和改进点
6. **修改实验**：在理解某个模块后，尝试修改一个参数（比如 `DOOM_LOOP_THRESHOLD`），观察行为变化
