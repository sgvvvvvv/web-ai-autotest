const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadModule(name, context) {
  const source = fs.readFileSync(path.join(__dirname, "..", "core", name), "utf8");
  vm.runInContext(source, context, { filename: name });
}

function assertSidePanelDomContract() {
  const html = fs.readFileSync(path.join(__dirname, "..", "sidepanel", "sidepanel.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "sidepanel", "sidepanel.js"), "utf8");
  const ids = new Set();
  const idPattern = /document\.getElementById\("([^"]+)"\)/g;
  let match;
  while ((match = idPattern.exec(script)) !== null) ids.add(match[1]);
  ids.forEach(function(id) {
    assert.ok(html.indexOf('id="' + id + '"') !== -1, "Side Panel 缺少元素: " + id);
  });
  assert.ok(/id="archResult"[^>]*hidden/.test(html), "架构分析内容应默认折叠");
  assert.ok(/id="testCasesContent"[^>]*hidden/.test(html), "测试用例内容应默认折叠");
  assert.ok(/archSectionToggle[\s\S]*aria-controls="archResult"/.test(html), "架构分析标题应可展开内容");
  assert.ok(/testCasesSectionToggle[\s\S]*aria-controls="testCasesContent"/.test(html), "测试用例标题应可展开内容");
}

async function run() {
  assertSidePanelDomContract();
  const agentLoopSource = fs.readFileSync(path.join(__dirname, "..", "core", "agent-loop.js"), "utf8");
  const aiClientSource = fs.readFileSync(path.join(__dirname, "..", "core", "ai-client.js"), "utf8");
  const sidePanelSource = fs.readFileSync(path.join(__dirname, "..", "sidepanel", "sidepanel.js"), "utf8");
  assert.strictEqual(/AIFT_AIClient\.chat\(/.test(agentLoopSource), false, "Agent Loop 的 AI 请求必须使用流式 chatStream");
  assert.ok(/MAX_NO_ACTION_RESPONSE_CHARS = 12000/.test(aiClientSource), "流式执行应以宽松预算限制未产生动作的长篇推理");
  assert.ok(/未调用工具且未产生新证据的长篇推理/.test(aiClientSource), "无动作长篇推理必须以明确原因中断");
  assert.ok(/if \(state\.noToolCallCount >= 2\)/.test(agentLoopSource), "执行 Agent 应在首次纯文本回复后先注入扰动再暂停");
  assert.ok(/系统扰动/.test(agentLoopSource), "无动作长篇推理必须注入扰动后自动续跑");
  assert.ok(/case "finish":\s*[\s\S]*?state\.finished = true;/.test(agentLoopSource), "AI 调用 finish 后必须立即结束测试");
  assert.strictEqual(/AI 调用了 finish，对话已暂停/.test(agentLoopSource), false, "finish 不应暂停等待用户手动停止");
  assert.ok(/MAX_REASONING_TIME_MS = 600000/.test(aiClientSource), "推理时间上限应为 600 秒");
  assert.ok(/Math\.max\(options\.timeout \|\| DEFAULT_TIMEOUT, MAX_REASONING_TIME_MS\)/.test(aiClientSource), "短请求超时不能早于推理时间上限");
  const projectAnalyzerSource = fs.readFileSync(path.join(__dirname, "..", "core", "project-analyzer.js"), "utf8");
  assert.ok(/var conversation = \[\{ role: "user", content: prompt \}\];[\s\S]*?while \(true\)/.test(projectAnalyzerSource), "单轮架构分析必须在用户输入后保留上下文并重新请求");
  assert.ok(/state\.userInjecting[\s\S]*?planMessages\.push\(\{ role: "user", content: injectedMsg \}\)/.test(agentLoopSource), "Plan 模式必须在用户输入后保留上下文并重新请求");
  const analyzeArchitectureSource = sidePanelSource.match(/async function analyzeArchitecture\(\) \{([\s\S]*?)\n\}\n\nasync function clearArchCache/);
  assert.ok(analyzeArchitectureSource, "应保留架构分析入口");
  assert.strictEqual(/await showPromptDialog\(/.test(analyzeArchitectureSource[1]), false, "分析架构不能等待可选提示词确认");
  assert.strictEqual(/当前阶段不支持接续对话/.test(analyzeArchitectureSource[1]), false, "架构分析必须支持用户消息接续上下文");
  const context = vm.createContext({ window: {}, URL: URL });
  loadModule("source-reader.js", context);
  loadModule("interaction-contract.js", context);
  loadModule("test-scheduler.js", context);
  loadModule("redaction.js", context);
  loadModule("diagnostic-store.js", context);
  loadModule("test-report.js", context);
  loadModule("run-history.js", context);
  loadModule("tab-eligibility.js", context);
  loadModule("progress-guard.js", context);
  loadModule("agent-guard.js", context);
  loadModule("config-validator.js", context);
  loadModule("source-analyzer.js", context);
  loadModule("prompt-builder.js", context);
  loadModule("visual-controller.js", context);

  const reader = context.window.AIFT_SourceReader;
  const contracts = context.window.AIFT_InteractionContract;
  const scheduler = context.window.AIFT_TestScheduler;
  const redaction = context.window.AIFT_Redaction;
  const diagnosticStore = context.window.AIFT_DiagnosticStore;
  const testReport = context.window.AIFT_TestReport;
  const runHistory = context.window.AIFT_RunHistory;
  const tabEligibility = context.window.AIFT_TabEligibility;
  const progressGuard = context.window.AIFT_ProgressGuard;
  const agentGuard = context.window.AIFT_AgentGuard;
  const validator = context.window.AIFT_ConfigValidator;
  const analyzer = context.window.AIFT_SourceAnalyzer;
  const promptBuilder = context.window.AIFT_PromptBuilder;
  const visualController = context.window.AIFT_VisualController;

  // 流式响应可能没有结尾换行；最后一个 delta 仍必须被解析。
  const aiCalls = [];
  const aiContext = vm.createContext({
    window: {},
    AbortController,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console,
    fetch: async function (url, options) {
      aiCalls.push(JSON.parse(options.body));
      if (aiCalls.length === 1) {
        return { ok: false, status: 400, statusText: "Bad Request", json: async function () { return { error: { message: "thinking unsupported" } }; } };
      }
      const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "click", arguments: JSON.stringify({ x: 1 }) } }] } }] });
      const bytes = new TextEncoder().encode(payload);
      return {
        ok: true,
        body: { getReader: function () {
          let sent = false;
          return { read: async function () { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } };
        } },
      };
    },
  });
  loadModule("ai-client.js", aiContext);
  const aiConfig = { apiUrl: "https://example.com/v1", apiKey: "key", model: "demo", enableThinking: true };
  const streamResult = await aiContext.window.AIFT_AIClient.chatStream(aiConfig, [{ role: "user", content: "go" }], [], { maxRetries: 1 });
  assert.strictEqual(streamResult.message.tool_calls[0].function.arguments, '{"x":1}');
  assert.strictEqual(aiConfig.enableThinking, true, "thinking 降级不能改写调用方配置");
  assert.strictEqual(aiCalls[1].thinking, undefined, "GLM 格式失败后应移除 thinking 参数");
  assert.strictEqual(aiCalls[1].enable_thinking, true, "GLM 格式失败后应改用 enable_thinking 格式重试");
  assert.strictEqual(aiCalls[1].temperature, undefined, "深度思考模式下任何请求都不应携带 temperature");

  // 深度思考：两种 thinking 格式均被拒绝时禁用并缓存结论，全程不得发送 temperature
  const thCalls = [];
  const thContext = vm.createContext({
    window: {},
    AbortController,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console,
    fetch: async function (url, options) {
      thCalls.push(JSON.parse(options.body));
      if (thCalls.length === 1) {
        return { ok: false, status: 400, statusText: "Bad Request", json: async function () { return { error: { message: "Unrecognized request argument supplied: thinking" } }; } };
      }
      if (thCalls.length === 2) {
        return { ok: false, status: 400, statusText: "Bad Request", json: async function () { return { error: { message: "enable_thinking is not supported for this model" } }; } };
      }
      const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: "ok" } }] });
      const bytes = new TextEncoder().encode(payload);
      return {
        ok: true,
        body: { getReader: function () {
          let sent = false;
          return { read: async function () { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } };
        } },
      };
    },
  });
  loadModule("ai-client.js", thContext);
  const thConfig = { apiUrl: "https://example.com/v1", apiKey: "key", model: "no-think-model", enableThinking: true };
  await thContext.window.AIFT_AIClient.chatStream(thConfig, [{ role: "user", content: "go" }], [], { maxRetries: 1 });
  assert.strictEqual(thCalls.length, 3, "两种 thinking 格式各尝试一次后应降级为不带 thinking 参数");
  assert.deepStrictEqual(thCalls[0].thinking, { type: "enabled" }, "首次应使用 GLM 格式");
  assert.strictEqual(thCalls[1].enable_thinking, true, "第二次应改用 enable_thinking 格式");
  assert.strictEqual(thCalls[2].thinking, undefined, "两种格式均被拒后不应再发送 thinking");
  assert.strictEqual(thCalls[2].enable_thinking, undefined, "两种格式均被拒后不应再发送 enable_thinking");
  thCalls.forEach(function (call, i) {
    assert.strictEqual(call.temperature, undefined, "第 " + (i + 1) + " 次请求不应携带 temperature（已勾选深度思考）");
  });
  // 能力缓存：后续调用直接不带 thinking 参数，不再重复探测
  await thContext.window.AIFT_AIClient.chatStream(thConfig, [{ role: "user", content: "go" }], [], { maxRetries: 1 });
  assert.strictEqual(thCalls.length, 4, "缓存命中后不应再触发降级重试");
  assert.strictEqual(thCalls[3].thinking, undefined, "缓存命中后不应发送 thinking");
  assert.strictEqual(thCalls[3].enable_thinking, undefined, "缓存命中后不应发送 enable_thinking");
  assert.strictEqual(thCalls[3].temperature, undefined, "缓存命中后也不应补发 temperature");

  const toolsForCompatibility = [
    {
      type: "function",
      function: {
        name: "click",
        parameters: {
          type: "object",
          properties: { elementRef: { type: "string" }, selector: { type: "string" } },
          anyOf: [{ required: ["elementRef"] }, { required: ["selector"] }],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "union",
        parameters: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    },
  ];
  const compatibleTools = aiContext.window.AIFT_AIClient.normalizeToolsForCompatibility(toolsForCompatibility);
  assert.strictEqual(toolsForCompatibility[0].function.parameters.anyOf.length, 2, "转换不能改写原始工具定义");
  assert.strictEqual(compatibleTools[0].function.parameters.anyOf, undefined, "字段二选一 anyOf 应在出站前展平");
  assert.strictEqual(compatibleTools[0].function.parameters.additionalProperties, false);
  assert.deepStrictEqual(compatibleTools[0].function.parameters.properties, toolsForCompatibility[0].function.parameters.properties);
  assert.deepStrictEqual(compatibleTools[1], toolsForCompatibility[1], "真正的联合类型不能被展平");

  // models.dev 静态能力表（借鉴 OpenCode）：temperature/reasoning/toolcall 门控 + 家族采样调优
  const mdCalls = [];
  const mdContext = vm.createContext({
    window: {},
    AbortController,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console,
    fetch: async function (url, options) {
      if (!options) {
        // models.dev 能力表请求（无 body）
        return { ok: true, json: async function () { return {
          "alibaba-cn": { models: {
            "caps-model": { temperature: false, reasoning: false, tool_call: false, modalities: { input: ["text"] } },
            "temp-model": { temperature: true, reasoning: true, tool_call: true, modalities: { input: ["text"] } },
          } },
        }; } };
      }
      mdCalls.push(JSON.parse(options.body));
      const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: "ok" } }] });
      const bytes = new TextEncoder().encode(payload);
      return {
        ok: true,
        body: { getReader: function () {
          let sent = false;
          return { read: async function () { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } };
        } },
      };
    },
  });
  loadModule("ai-client.js", mdContext);
  await mdContext.window.AIFT_AIClient.loadModelCaps();
  const mdTools = [{ type: "function", function: { name: "click", description: "点击", parameters: { type: "object", properties: {} } } }];
  // 能力表不支持 temperature/reasoning/toolcall：对应参数都不应出现在请求里
  await mdContext.window.AIFT_AIClient.chatStream(
    { apiUrl: "https://example.com/v1", apiKey: "key", model: "caps-model", enableThinking: true },
    [{ role: "user", content: "go" }], mdTools, { maxRetries: 0 });
  const capsBody = mdCalls[0];
  assert.strictEqual(capsBody.temperature, undefined, "能力表不支持 temperature 时不应发送");
  assert.strictEqual(capsBody.thinking, undefined, "能力表不支持 reasoning 时不应发送 thinking");
  assert.strictEqual(capsBody.enable_thinking, undefined, "能力表不支持 reasoning 时不应发送 enable_thinking");
  assert.strictEqual(capsBody.tools, undefined, "能力表不支持 toolcall 时不应发送 tools");
  assert.strictEqual(capsBody.messages[capsBody.messages.length - 1].role, "system", "toolcall 不支持时应注入文本协议");
  // qwen 家族：勾选深度思考应直接使用 enable_thinking 格式（避免先挨 400 再降级）
  await mdContext.window.AIFT_AIClient.chatStream(
    { apiUrl: "https://example.com/v1", apiKey: "key", model: "qwen-plus", enableThinking: true },
    [{ role: "user", content: "go" }], [], { maxRetries: 0 });
  assert.strictEqual(mdCalls[1].enable_thinking, true, "qwen 系应直接使用 enable_thinking 格式");
  assert.strictEqual(mdCalls[1].thinking, undefined, "qwen 系不应发送 GLM 格式 thinking");
  // qwen 家族未勾选深度思考：使用家族调优采样值
  await mdContext.window.AIFT_AIClient.chatStream(
    { apiUrl: "https://example.com/v1", apiKey: "key", model: "qwen-plus", enableThinking: false },
    [{ role: "user", content: "go" }], [], { maxRetries: 0 });
  assert.strictEqual(mdCalls[2].temperature, 0.55, "qwen 家族应使用调优 temperature 0.55");
  assert.strictEqual(mdCalls[2].top_p, 1, "qwen 家族应使用调优 top_p 1");
  // 能力表支持 temperature 但无家族调优值：保持 0.5 默认
  await mdContext.window.AIFT_AIClient.chatStream(
    { apiUrl: "https://example.com/v1", apiKey: "key", model: "temp-model", enableThinking: false },
    [{ role: "user", content: "go" }], [], { maxRetries: 0 });
  assert.strictEqual(mdCalls[3].temperature, 0.5, "能力表支持且无家族调优时应保持 0.5");

  // 模型不支持 function calling（如 qwen3.7-plus 网关 400）：自动降级为文本协议，并缓存能力结论
  const fcCalls = [];
  const fcContext = vm.createContext({
    window: {},
    AbortController,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console,
    fetch: async function (url, options) {
      fcCalls.push(JSON.parse(options.body));
      if (fcCalls.length === 1) {
        return { ok: false, status: 400, statusText: "Bad Request", json: async function () { return { error: { message: "当前模型不支持函数调用", type: "None", param: "None", code: "400" } }; } };
      }
      const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '[{"action":"click","elementRef":"e1"}]' } }] });
      const bytes = new TextEncoder().encode(payload);
      return {
        ok: true,
        body: { getReader: function () {
          let sent = false;
          return { read: async function () { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } };
        } },
      };
    },
  });
  loadModule("ai-client.js", fcContext);
  const fcConfig = { apiUrl: "https://example.com/v1", apiKey: "key", model: "qwen3.7-plus" };
  const fcTools = [{ type: "function", function: { name: "click", description: "点击元素", parameters: { type: "object", properties: { elementRef: { type: "string" } }, required: ["elementRef"] } } }];
  const fcResult = await fcContext.window.AIFT_AIClient.chatStream(fcConfig, [{ role: "user", content: "go" }], fcTools, { maxRetries: 1 });
  assert.strictEqual(fcCalls.length, 2, "函数调用不支持时应自动降级重试且不消耗重试次数");
  assert.ok(fcCalls[0].tools, "首次请求应携带 tools");
  assert.strictEqual(fcCalls[0].tool_choice, "auto", "tool_choice 应为 auto（DashScope 系不支持 required）");
  assert.strictEqual(fcCalls[1].tools, undefined, "降级重试应移除 tools");
  assert.strictEqual(fcCalls[1].tool_choice, undefined, "降级重试应移除 tool_choice");
  const protocolMsg = fcCalls[1].messages[fcCalls[1].messages.length - 1];
  assert.strictEqual(protocolMsg.role, "system", "降级后应注入文本协议 system 消息");
  assert.ok(protocolMsg.content.indexOf("click(elementRef)") !== -1, "文本协议应包含工具签名说明");
  const fcToolCalls = fcContext.window.AIFT_AIClient.extractToolCalls(fcResult.message);
  assert.strictEqual(fcToolCalls[0].function.name, "click", "文本协议响应应解析出工具动作");
  assert.strictEqual(JSON.parse(fcToolCalls[0].function.arguments).elementRef, "e1");

  // 工具可用时，模型若只持续输出 reasoning 而没有动作，必须在单次响应内熔断。
  const noActionContext = vm.createContext({
    window: {},
    AbortController,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console,
    fetch: async function () {
      const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: "r".repeat(12000) } }] }) + "\n\n";
      const bytes = new TextEncoder().encode(payload);
      return {
        ok: true,
        body: { getReader: function () {
          let sent = false;
          return { read: async function () { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; }, cancel: function () {} };
        } },
      };
    },
  });
  loadModule("ai-client.js", noActionContext);
  await assert.rejects(
    noActionContext.window.AIFT_AIClient.chatStream(
      { apiUrl: "https://example.com/v1", apiKey: "key", model: "demo" },
      [{ role: "user", content: "go" }], fcTools, { maxRetries: 0 }
    ),
    function (error) {
      return error && error.name === "ReasoningLoopError" &&
        error.breakReason === "未调用工具且未产生新证据的长篇推理";
    },
    "长篇无动作 reasoning 必须在流内中断"
  );
  // 能力缓存：后续请求直接走文本协议，不再发送 tools
  await fcContext.window.AIFT_AIClient.chatStream(fcConfig, [{ role: "user", content: "go" }], fcTools, { maxRetries: 1 });
  assert.strictEqual(fcCalls.length, 3);
  assert.strictEqual(fcCalls[2].tools, undefined, "已缓存不支持结论的模型不应再发送 tools");
  assert.strictEqual(fcCalls[2].messages[fcCalls[2].messages.length - 1].role, "system", "缓存命中时也应注入文本协议");
  // extractToolCalls：兼容 Markdown 代码块包裹与正文内嵌 JSON
  const fenced = fcContext.window.AIFT_AIClient.extractToolCalls({ content: "```json\n[{\"action\":\"press\",\"key\":\"Enter\"}]\n```" });
  assert.strictEqual(fenced[0].function.name, "press", "应解析 Markdown 代码块包裹的 JSON 动作");
  const embedded = fcContext.window.AIFT_AIClient.extractToolCalls({ content: "好的，执行点击：\n[{\"action\":\"click\",\"elementRef\":\"e2\"}]" });
  assert.strictEqual(embedded[0].function.name, "click", "应解析正文中内嵌的 JSON 动作");

  // “深度思考 + 函数调用”组合被网关拒绝（报“当前模型不支持函数调用”）：
  // 应先剥离 thinking 参数保留 tools 重试，并缓存结论；后续带 tools 的请求不再携带 thinking 参数
  const cbCalls = [];
  const cbContext = vm.createContext({
    window: {},
    AbortController,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console,
    fetch: async function (url, options) {
      cbCalls.push(JSON.parse(options.body));
      if (cbCalls.length === 1) {
        return { ok: false, status: 400, statusText: "Bad Request", json: async function () { return { error: { message: "当前模型不支持函数调用", type: "None", param: "None", code: "400" } }; } };
      }
      const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "click", arguments: "{\"elementRef\":\"e1\"}" } }] } }] });
      const bytes = new TextEncoder().encode(payload);
      return {
        ok: true,
        body: { getReader: function () {
          let sent = false;
          return { read: async function () { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } };
        } },
      };
    },
  });
  loadModule("ai-client.js", cbContext);
  const cbConfig = { apiUrl: "https://example.com/v1", apiKey: "key", model: "zhanlu/qwen3.7-plus", enableThinking: true };
  const cbTools = [{ type: "function", function: { name: "click", description: "点击", parameters: { type: "object", properties: {} } } }];
  const cbResult = await cbContext.window.AIFT_AIClient.chatStream(cbConfig, [{ role: "user", content: "go" }], cbTools, { maxRetries: 1 });
  assert.strictEqual(cbCalls.length, 2, "组合拒绝后应重试一次即成功");
  assert.strictEqual(cbCalls[0].enable_thinking, true, "首次请求应携带 enable_thinking");
  assert.ok(cbCalls[0].tools, "首次请求应携带 tools");
  assert.strictEqual(cbCalls[1].enable_thinking, undefined, "重试应移除 enable_thinking");
  assert.strictEqual(cbCalls[1].thinking, undefined, "重试不应携带 thinking");
  assert.ok(cbCalls[1].tools, "重试应保留 tools（组合拒绝不等于模型不支持函数调用）");
  assert.strictEqual(cbCalls[1].messages.length, 1, "组合拒绝重试不应注入文本协议消息");
  assert.strictEqual(cbCalls[1].temperature, undefined, "深度思考模式下任何请求都不应携带 temperature");
  assert.strictEqual(cbResult.message.tool_calls[0].function.name, "click", "保留 tools 后应正常返回原生 tool_calls");
  // 组合结论缓存：后续带 tools 的请求直接跳过 thinking 参数
  await cbContext.window.AIFT_AIClient.chatStream(cbConfig, [{ role: "user", content: "go" }], cbTools, { maxRetries: 1 });
  assert.strictEqual(cbCalls.length, 3, "缓存命中后不应再触发组合降级重试");
  assert.strictEqual(cbCalls[2].enable_thinking, undefined, "缓存命中后带 tools 的请求不应携带 enable_thinking");
  assert.ok(cbCalls[2].tools, "缓存命中后应继续携带 tools");

  const files = {
    "views/dashboard/Overview.vue": "<template><h1>Overview</h1></template>",
    "views/host/statistical/components/FailureDetailDialog.vue": "<template><input placeholder=\"用户标签筛选\"></template><TagPicker /></template><script>import TagPicker from '@/components/TagPicker.vue'</script>",
    "components/TagPicker.vue": '<SmartPicker v-model="tags" multiple :options="tagOptions" placeholder="选择标签" />',
    "api/host/statistical.js": "export const GetFailureDetail = () => request('/api/failure-detail')",
  };
  const ranked = reader.rankRelevantFiles(files, {
    url: "http://localhost/#/host/statistical",
    title: "操作统计",
    testCase: "失败详情弹窗 用户标签筛选",
    domText: "失败详情 用户标签筛选",
  }, 2);
  assert.strictEqual(ranked[0].path, "views/host/statistical/components/FailureDetailDialog.vue");
  assert.ok(ranked.some(function(file) { return file.path === "components/TagPicker.vue"; }));

  const contract = {
    kind: "hierarchical-multi-select",
    triggerSelector: 'input[placeholder="用户标签筛选"]',
  };
  assert.strictEqual(contracts.match([contract], { findBy: "placeholder", value: "用户标签筛选" }), contract);
  assert.strictEqual(contracts.match([contract], { findBy: "selector", value: ".unknown" }), null);
  assert.strictEqual(contracts.match([contract, Object.assign({}, contract, { path: "other/FailureDetailDialog.vue" })], { findBy: "placeholder", value: "用户标签筛选" }), null);

  const cases = scheduler.assignScenarios([
    { id: "TC1", title: "失败详情弹窗-默认展示", page: "操作统计", preconditions: "已打开失败详情弹窗", steps: "检查表格" },
    { id: "TC2", title: "失败详情弹窗-提示信息", page: "操作统计", preconditions: "已打开失败详情弹窗", steps: "检查提示" },
    { id: "TC3", title: "失败详情弹窗-标签筛选", page: "操作统计", preconditions: "已打开失败详情弹窗", steps: "选择标签并筛选" },
  ]);
  assert.strictEqual(cases[0].scenarioId, cases[1].scenarioId);
  assert.notStrictEqual(cases[1].scenarioId, cases[2].scenarioId);
  assert.strictEqual(scheduler.isStateChanging(cases[2]), true);
  const plan = JSON.parse(JSON.stringify(scheduler.buildPlan(cases)));
  assert.deepStrictEqual(plan.map(function (item) { return item.cases; }), [["TC1", "TC2"], ["TC3"]]);
  const aiScheduled = [
    { id: "TC1", title: "列表默认展示" },
    { id: "TC2", title: "列表筛选" },
    { id: "TC3", title: "用户编辑" },
  ];
  const aiPlan = scheduler.applyAiPlan(aiScheduled, {
    groups: [
      { title: "用户编辑", caseIds: ["TC3"] },
      { title: "列表操作", caseIds: ["TC1", "TC2"] },
    ],
  });
  assert.deepStrictEqual(aiScheduled.map(function(testCase) { return testCase.id; }), ["TC3", "TC1", "TC2"]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(aiPlan.map(function(group) { return group.cases; }))), [["TC3"], ["TC1", "TC2"]]);
  assert.strictEqual(scheduler.applyAiPlan(aiScheduled, { groups: [{ caseIds: ["TC1"] }] }), null);
  assert.deepStrictEqual(aiScheduled.map(function(testCase) { return testCase.id; }), ["TC3", "TC1", "TC2"]);
  assert.strictEqual(aiScheduled[1].scenarioTitle, "列表操作");

  const genericContracts = analyzer.getInteractionContracts({
    "components/TagPicker.vue": '<SmartPicker v-model="tags" multiple :options="tagOptions" placeholder="选择标签" />',
  });
  assert.strictEqual(genericContracts.length, 1);
  assert.strictEqual(genericContracts[0].activationSelector, 'input[type="checkbox"],[role="checkbox"]');
  const ariaContracts = analyzer.getInteractionContracts({
    "components/ReactTagPicker.tsx": '<TagPicker value={selectedTags} multiple options={tagOptions} aria-label="用户标签" />',
  });
  assert.strictEqual(ariaContracts[0].triggerSelector, '[aria-label="用户标签"]');
  assert.strictEqual(contracts.match(ariaContracts, { findBy: "selector", value: '[aria-label="用户标签"]' }), ariaContracts[0]);

  const initialMessages = promptBuilder.buildMessages({
    requirement: "验证失败详情弹窗",
    testCases: "TC1,失败详情弹窗-默认展示,操作统计,已打开弹窗,检查表格,表格显示",
    sourceFiles: [],
    sourceInteractions: [],
    scenarioPlan: plan,
    snapshot: { url: "http://localhost", title: "操作统计", elements: [] },
    visionSupported: false,
  });
  assert.ok(initialMessages[1].content.indexOf("执行场景计划") !== -1);
  assert.ok(initialMessages[1].content.indexOf("TC1 -> TC2") !== -1);
  const iframeMessages = promptBuilder.buildMessages({
    requirement: "提交嵌入表单",
    testCases: "TC1,提交表单,嵌入页,已打开,点击提交,提交成功",
    sourceFiles: [],
    snapshot: {
      url: "http://host.example", title: "宿主页面", nodes: [
        { ref: "e1", tag: "button", text: "顶层按钮", selector: "#top", frameId: 0 },
        { ref: "f12:e3", tag: "button", text: "提交", selector: "#submit", frameId: 12 },
      ],
      frames: [{ frameId: 0, interactiveCount: 1 }, { frameId: 12, title: "跨域表单", interactiveCount: 1 }],
    },
    visionSupported: false,
  });
  assert.ok(iframeMessages[1].content.indexOf("f12:e3") !== -1);
  assert.ok(iframeMessages[1].content.indexOf("iframe:12") !== -1);
  const continuousScenarioMessages = promptBuilder.buildMessages({
    requirement: "连续筛选验证",
    testCases: "TC1,筛选,列表页,已进入,选择筛选,列表更新",
    sourceFiles: [],
    snapshot: { url: "http://localhost", title: "列表页", nodes: [] },
    conversationHistory: [{ role: "user", content: "开始执行" }],
    testCasesState: [
      { id: "TC1", title: "筛选", status: "testing", scenarioId: "SC1", scenarioTitle: "列表筛选", steps: "选择筛选条件 → 恢复：清空筛选" },
      { id: "TC2", title: "搜索", status: "pending", scenarioId: "SC1", steps: "输入关键词" },
    ],
    visionSupported: false,
  });
  const continuousObservation = continuousScenarioMessages[continuousScenarioMessages.length - 1].content;
  assert.ok(continuousObservation.indexOf("选择筛选条件") !== -1);
  assert.strictEqual(continuousObservation.indexOf("恢复："), -1);

  const safe = redaction.redact({ password: "secret", message: "Bearer abcdefghijklmnopqrstuvwxyz", apiKey: "sk-abcdefghijklmnop" });
  assert.strictEqual(safe.password, "[REDACTED]");
  assert.strictEqual(safe.apiKey, "[REDACTED]");
  assert.ok(safe.message.indexOf("[REDACTED]") !== -1);
  assert.strictEqual(redaction.redactText("Cookie: sid=abc123\nhttps://api.example.com?access_token=secret"), "Cookie: [REDACTED]\nhttps://api.example.com?access_token=[REDACTED]");
  const retainedDiagnostics = diagnosticStore.trimForStorage([
    { id: "old", reasoning: "old" },
    { id: "recent", reasoning: "x".repeat(5000), recentTrace: Array(20).fill({ result: "y".repeat(500) }) },
  ], { maxRecords: 1, maxBytes: 1000 });
  assert.strictEqual(retainedDiagnostics.length, 1);
  assert.strictEqual(retainedDiagnostics[0].id, "recent");
  assert.strictEqual(retainedDiagnostics[0].diagnosticTruncated, true);
  assert.ok(JSON.stringify(retainedDiagnostics).length * 2 <= 1000);

  const report = testReport.buildReport({
    result: "fail",
    summary: "存在一个筛选失败",
    target: "操作统计",
    testCases: [
      { id: "TC1", title: "默认展示", status: "passed", assertionDesc: "✅ 默认展示正确" },
      { id: "TC2", title: "标签筛选", status: "failed", assertionDesc: "❌ checkbox 未勾选" },
    ],
    assertions: [{ description: "❌ checkbox 未勾选", passed: false }],
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(report.stats)), { total: 2, passed: 1, failed: 1, inconclusive: 0, skipped: 0, pending: 0, testing: 0, tested: 2, conclusive: 2, passRate: 50 });
  assert.strictEqual(report.testCases[0].assertionDesc, "✅ 默认展示正确");
  assert.strictEqual(report.testCases[1].assertion, "❌ checkbox 未勾选");
  const legacyAssertionReport = testReport.buildReport({
    testCases: [{ id: "TC0", assertion: "旧报告断言" }],
  });
  assert.strictEqual(legacyAssertionReport.testCases[0].assertionDesc, "旧报告断言");
  assert.ok(testReport.buildMarkdown(report).indexOf("❌ checkbox 未勾选") !== -1);
  assert.ok(testReport.buildMarkdown(report).indexOf("TC1 默认展示") !== -1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(runHistory.trim([{ runId: "old" }, { runId: "new" }], { maxReports: 1 }))), [{ runId: "new" }]);
  assert.strictEqual(tabEligibility.evaluate("https://example.com").ok, true);
  assert.ok(tabEligibility.evaluate("file:///tmp/demo.html").warning);
  assert.strictEqual(tabEligibility.evaluate("chrome://settings").ok, false);
  const stalledAttempts = [];
  for (let index = 0; index < 3; index++) {
    const attempt = progressGuard.createFailureAttempt("select_multi", { trigger: { findBy: "placeholder", value: "用户标签" } }, { url: "http://localhost", pageText: "失败详情" });
    attempt.tcId = "TC8";
    stalledAttempts.push(attempt);
  }
  assert.strictEqual(progressGuard.detectStall(stalledAttempts, "TC8").kind, "same_action");
  const changedPageAttempt = progressGuard.createFailureAttempt("select_multi", { trigger: { findBy: "placeholder", value: "用户标签" } }, { url: "http://localhost", pageText: "筛选结果已更新" });
  changedPageAttempt.tcId = "TC8";
  stalledAttempts.push(changedPageAttempt);
  assert.strictEqual(progressGuard.detectStall(stalledAttempts, "TC8"), null);

  const observedSnapshot = {
    nodes: [
      { ref: "e1", selector: '[data-testid="save"]' },
      { ref: "e2", selector: '[role="tab"]:nth-child(2)' },
    ],
  };
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(agentGuard.resolveObservedTarget(observedSnapshot, [], [], { elementRef: "e1" }))),
    { ok: true, selector: '[data-testid="save"]', source: "snapshot-ref" }
  );
  assert.strictEqual(
    agentGuard.resolveObservedTarget(observedSnapshot, [], [], { selector: ".made-up-selector" }).ok,
    false
  );
  assert.strictEqual(
    agentGuard.resolveObservedTarget(observedSnapshot, [".found-after-search"], [], { selector: ".found-after-search" }).ok,
    true
  );
  const iframeSnapshot = {
    nodes: [{ ref: "f12:e3", selector: "#submit", frameId: 12 }],
  };
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(agentGuard.resolveObservedTarget(iframeSnapshot, [], [], { elementRef: "f12:e3" }))),
    { ok: true, selector: "#submit", source: "snapshot-ref", frameId: 12 }
  );
  assert.strictEqual(agentGuard.validateAssertionForCurrent("TC12: ✅ 通过 - 已验证", "TC12").ok, true);
  assert.strictEqual(agentGuard.validateAssertionForCurrent("TC11: ✅ 通过 - 已验证", "TC12").ok, false);
  assert.strictEqual(agentGuard.validateAssertionForCurrent("✅ 通过 - 已验证", "TC12").ok, false);
  const mappedDataCase = {
    title: "任务列表数据一致性",
    steps: "获取接口响应并检查表格",
    expected: "字段映射：任务名称 <- taskName；状态 <- status；页面与 API 一致",
  };
  assert.strictEqual(agentGuard.validateFieldMappings(mappedDataCase, [
    { uiLabel: "任务名称", apiField: "taskName", pageValue: "任务A", apiValue: "任务A" },
    { uiLabel: "状态", apiField: "status", pageValue: "下发中", apiValue: "下发中" },
  ], { pageText: "任务名称 状态 任务A 下发中" }, '{"taskName":"任务A","status":"下发中"}').required, true);
  const nonMappingDataCase = agentGuard.validateFieldMappings({
    title: "任务列表数据一致性", steps: "获取接口响应并检查表格", expected: "页面与 API 一致",
  }, [], { pageText: "任务名称 状态" }, '{"taskName":"任务A"}');
  assert.strictEqual(nonMappingDataCase.ok, true);
  assert.strictEqual(nonMappingDataCase.required, false);
  assert.strictEqual(agentGuard.validateFieldMappings(mappedDataCase, [
    { uiLabel: "下发时间", apiField: "createdTime", pageValue: "2026-01-01", apiValue: "2026-01-01" },
    { uiLabel: "状态", apiField: "status", pageValue: "下发中", apiValue: "下发中" },
  ], { pageText: "下发时间 状态" }, '{"createdTime":"2026-01-01","status":"下发中"}').ok, false);
  const incompleteOutcome = agentGuard.resolveAssertionOutcome({ passed: true }, "TC5: ⚠️ 部分通过 - 无法在自动化环境中触发真实文件校验，未能完整验证");
  assert.strictEqual(incompleteOutcome.outcome, "inconclusive");
  assert.strictEqual(incompleteOutcome.downgraded, true);
  assert.strictEqual(agentGuard.resolveAssertionOutcome({ outcome: "failed" }, "TC5: ❌ 已观察到错误提示不一致").outcome, "failed");
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(agentGuard.reconcileRunResult("pass", [{ status: "passed" }, { status: "inconclusive" }]))),
    { result: "unknown", adjusted: true, reason: "至少一个测试用例未完成验证或未执行" }
  );

  const inconclusiveReport = testReport.buildReport({
    testCases: [{ id: "TC3", title: "原生文件选择", status: "inconclusive", assertionDesc: "⚠️ 未完成验证" }],
    assertions: [{ description: "TC3: ⚠️ 未完成验证", outcome: "inconclusive", passed: false }],
  });
  assert.strictEqual(inconclusiveReport.stats.inconclusive, 1);
  assert.strictEqual(inconclusiveReport.stats.passRate, 0);
  assert.ok(testReport.buildMarkdown(inconclusiveReport).indexOf("未完成验证") !== -1);

  assert.strictEqual(validator.validateApiEndpoint("ftp://example.com").ok, false);
  assert.strictEqual(validator.validateApiEndpoint("https://api.example.com/v1").ok, true);
  const remoteHttpEndpoint = validator.validateApiEndpoint("http://api.example.com/v1");
  assert.strictEqual(remoteHttpEndpoint.ok, true);
  assert.strictEqual(remoteHttpEndpoint.warning, undefined);
  const localHttpEndpoint = validator.validateApiEndpoint("http://localhost:11434/v1");
  assert.strictEqual(localHttpEndpoint.ok, true);
  assert.strictEqual(localHttpEndpoint.warning, undefined);

  let clickProbe = "";
  await visualController.clickAtPoint(async function (code) {
    clickProbe = code;
    return { ok: false, error: "probe" };
  }, 12, 34, {
    nodeSelector: '[role="option"]',
    activationSelector: 'input[type="checkbox"],[role="checkbox"]',
  });
  assert.doesNotThrow(function () { new Function("return " + clickProbe); });

  const observedMessages = promptBuilder.buildMessages({
    requirement: "保存设置",
    testCases: "TC1,保存设置,设置页,已打开设置,点击保存,保存成功",
    sourceFiles: [],
    sourceInteractions: [],
    snapshot: { url: "http://localhost", title: "设置", nodes: [{ ref: "e7", tag: "button", text: "保存", selector: '[data-testid="save"]' }] },
    visionSupported: false,
  });
  assert.ok(observedMessages[1].content.indexOf("[ref:e7]") !== -1);
  assert.ok(promptBuilder.buildTools({ visionSupported: false }).some(function(tool) { return tool.function.name === "surface_interact"; }));
  const uploadTool = promptBuilder.buildTools({ visionSupported: false }).filter(function(tool) { return tool.function.name === "upload_file"; })[0];
  assert.ok(uploadTool, "应向 Agent 暴露受控文件注入工具");
  assert.ok(uploadTool.function.description.indexOf("10485761") !== -1, "文件工具应说明 10MiB 边界测试方式");
  assert.ok(/case "upload_file":/.test(agentLoopSource), "Agent Loop 必须执行文件注入工具");
  assert.ok(/async function injectTestFile\(options\)/.test(sidePanelSource), "Side Panel 必须实现受控文件注入");
  assert.strictEqual((sidePanelSource.match(/injectFile: injectTestFile/g) || []).length, 2, "规划和执行入口都必须提供文件注入能力");
  assert.ok(/new File\(\[bytes\], fileName/.test(sidePanelSource), "文件注入必须创建真实 File 对象");
  assert.ok(/input\.dispatchEvent\(new Event\("change"/.test(sidePanelSource), "文件注入必须触发 change 事件");
  const systemPrompt = promptBuilder.buildMessages({ requirement: "编辑并删除测试脚本", testCases: "TC1,编辑脚本,脚本管理,列表有数据,编辑保存并删除,接口成功", sourceFiles: [], snapshot: { nodes: [] }, visionSupported: false })[0].content;
  assert.ok(systemPrompt.indexOf("避免修改后端数据") !== -1);
  assert.ok(systemPrompt.indexOf("默认测试环境") !== -1);

  console.log("All tests passed.");
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
