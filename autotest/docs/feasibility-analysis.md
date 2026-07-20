# 可行性分析

## 结论

可行，而且产品方向应当是 **源码理解 + 视觉观察 + CDP 真实用户行为**。

Content Script 适合做观察，不适合作为测试动作执行层。真正的前端自动化测试应尽量经过浏览器输入管线：鼠标移动、按下、释放、键盘事件、滚轮、截图和网络监听都由 CDP 完成。这样才能暴露真实用户会遇到的问题，例如焦点错误、遮挡、禁用态、动画未完成、原生控件行为、快捷键差异等。

## 当前技术路线

| 能力 | 方案 |
|---|---|
| 源码读取 | 用户上传源码目录，Side Panel 本地索引和检索 |
| 页面观察 | Content Script DOM 快照 + `chrome.scripting.executeScript` 只读检查 |
| 用户动作 | `chrome.debugger` / CDP `Input.*` |
| 截图和视觉验证 | CDP `Page.captureScreenshot` |
| 网络录制 | CDP Network 域 |
| AI 调用 | Side Panel 直接 fetch OpenAI 兼容接口 |

## 为什么不用 Content Script 执行动作

Content Script 直接调用 `el.click()`、设置 `value`、派发 `dispatchEvent()`，可以绕过很多真实用户路径：

- 不一定触发浏览器实际焦点、鼠标、键盘顺序。
- 容易绕过遮挡、禁用态、pointer-events、滚动容器等真实问题。
- 原生 select、日期选择、输入法、快捷键、多选等控件行为经常和真实操作不同。
- 成功返回不代表用户真的能完成操作。

所以当前产品边界是：Content Script 只观察，CDP 执行动作。CDP 失败就是测试失败或环境不可用，不做脚本动作兜底。

## 核心难点和处理

### 1. CDP debugger 冲突

Chrome 同一 tab 同时只能有一个 debugger 连接。如果用户打开 DevTools 或其他自动化工具占用 debugger，本扩展无法保证真实用户行为测试。

处理方式：启动测试时强制附加 CDP。附加失败直接报错，不降级。

### 2. 元素定位

AI 只看截图容易坐标偏移，只看 DOM 容易点错同类元素。当前采用组合策略：

- DOM 快照和 label/ARIA 先给 AI 结构化观察。
- 截图标注可交互元素，提供视觉锚点。
- 预设模板用只读 DOM 找坐标，再用 CDP 点击。
- 操作后重新读取状态验证。

### 3. 原生控件

原生 `<select>` 的下拉弹层不是页面 DOM，不能靠查找 option 坐标完成。

处理方式：定位 select 后，用 CDP 点击聚焦，再用键盘 Home/ArrowDown/Enter 选择，并读取 selectedOptions 验证。原生多选使用 Control+方向键/Space 路径，并验证 selectedOptions。

### 4. 输入可靠性

不同平台全选快捷键可能是 Ctrl+A 或 Meta+A。输入框也可能有遮挡、未聚焦、格式化、受控组件回写等问题。

处理方式：CDP 点击聚焦后先尝试 Ctrl+A/Delete，再尝试 Meta+A/Delete，必要时退格清空；输入后读取真实 value/textContent 验证，不一致则失败。

### 5. 异步和动画

下拉、弹窗、loading、message 都有渲染延迟。

处理方式：模板内部有短等待和状态轮询；`click_button` 可等待 loading/dialog/message/dropdown；失败时返回页面状态和命中元素诊断。

## 差异化

| 方案 | 源码理解 | 真实用户行为 | 视觉验证 | 网络对比 |
|---|---:|---:|---:|---:|
| 普通 LLM + Playwright | 弱 | 强 | 中 | 强 |
| 纯 Content Script 自动化 | 中 | 弱 | 弱 | 弱 |
| AI 编程助手 | 强 | 无 | 无 | 无 |
| 本扩展 | 强 | 强 | 强 | 强 |

本项目的价值不是“能点页面”，而是让 AI 同时理解源码、观察页面、通过真实浏览器输入执行操作，并把 API 响应和 UI 展示对齐验证。

## 剩余风险

- 封闭 Shadow DOM、Canvas/WebGL 内部对象仍依赖视觉坐标和源码辅助。
- CDP 被占用时无法测试，必须让用户关闭 DevTools 或换目标 tab。
- 视觉模型质量影响复杂页面定位，需要模板和 DOM 诊断兜底。
- 页面如果强依赖真实硬件输入、系统文件选择器或跨域 iframe，仍需要额外能力。

这些限制不会阻断产品成立，但需要在 UI 和工具结果中清晰提示。
