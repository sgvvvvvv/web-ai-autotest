// ai-client.js
// OpenAI 兼容 fetch 封装：base_url / key / model / 超时 / 重试
// 在 Side Panel 上下文中运行（扩展页面，无 CORS 限制）

(function (global) {
  "use strict";

  var DEFAULT_TIMEOUT = 600000; // 600s
  var DEFAULT_MAX_RETRIES = 3;
  var RETRY_DELAY_BASE = 2000; // 基础延迟 2s，指数退避

  // === 流内重复检测配置 ===
  var REASONING_CHECK_INTERVAL = 800; // 每累积 800 字符检查一次
  var REASONING_MIN_BLOCK_LEN = 80;   // 参与精确检测的段落最短长度（提高：短段落易合理重复）
  var REASONING_REPEAT_THRESHOLD = 4; // 同一段落精确重复出现 N 次即判定为死循环（3→4 降低误报）
  var CONTENT_REPEAT_THRESHOLD = 5;   // content 重复阈值（略高，因为短回复可能合理重复）
  var REPEAT_WINDOW_SIZE = 4000;       // 滑动窗口大小：只统计最近 N 字符内的重复，避免长文本中合理引用被误判

  // === 模糊重复检测配置（更保守，避免误报） ===
  var FUZZY_MIN_BLOCK_LEN = 120;      // 模糊检测要求段落更长（短段落结构相似是正常的）
  var FUZZY_REPEAT_THRESHOLD = 4;     // 模糊重复阈值更高
  var FUZZY_SIG_LEN = 100;            // 特征签名长度（更长 = 更严格）

  // 执行 Agent 已具备工具时，极长时间没有动作可能是空转。
  // reasoning 很长本身并非错误，因此采用宽松预算；触发后由上层注入扰动并自动续跑。
  // 具体重复仍由精确/模糊段落检测优先处理。
  var MAX_NO_ACTION_RESPONSE_CHARS = 12000;

  // === 流内总量上限配置 ===
  var MAX_REASONING_TIME_MS = 600000; // reasoning 阶段最大持续时间 600 秒，超过后优雅截断

  /**
   * 部分 OpenAI 兼容服务不接受工具参数根层仅用于“字段二选一”的 anyOf。
   * 展平这类约束，保留字段和已有 required；真正的联合类型保持原样。
   */
  function normalizeToolParameters(parameters) {
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return parameters;

    var variants = parameters.anyOf;
    if (!Array.isArray(variants) || variants.length === 0) return parameters;

    for (var i = 0; i < variants.length; i++) {
      var variant = variants[i];
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) return parameters;
      var keys = Object.keys(variant);
      if (keys.length !== 1 || keys[0] !== "required" || !Array.isArray(variant.required)) return parameters;
    }

    var normalized = {};
    Object.keys(parameters).forEach(function (key) {
      if (key !== "anyOf") normalized[key] = parameters[key];
    });
    if (normalized.additionalProperties === undefined) normalized.additionalProperties = false;
    return normalized;
  }

  function normalizeToolsForCompatibility(tools) {
    if (!Array.isArray(tools)) return tools;
    return tools.map(function (tool) {
      if (!tool || !tool.function || !tool.function.parameters) return tool;
      var parameters = normalizeToolParameters(tool.function.parameters);
      if (parameters === tool.function.parameters) return tool;
      return Object.assign({}, tool, {
        function: Object.assign({}, tool.function, { parameters: parameters }),
      });
    });
  }

  // === 模型 function calling 能力处理（借鉴 OpenCode 按模型能力决定是否发送 tools）===
  // 用户可填写任意模型，无法静态维护能力表，因此运行时探测：
  // 网关返回“模型不支持函数调用”类 400 时缓存该能力结论，降级为文本协议：
  // 不再发送 tools/tool_choice，改为要求模型在正文输出 JSON 动作数组（由 extractToolCalls 解析）。
  var modelToolSupport = {}; // key: apiUrl::model → false 表示该模型不支持 function calling

  function modelCapabilityKey(config) {
    return (config.apiUrl || "") + "::" + (config.model || "");
  }

  /**
   * 判断 4xx 错误是否为“模型不支持函数调用/工具调用”
   * 兼容中英文网关报错，如：当前模型不支持函数调用 / does not support function calling / tools is not supported
   */
  function isToolCallUnsupportedError(errText) {
    var t = String(errText || "").toLowerCase();
    if (!t) return false;
    if (t.indexOf("不支持函数调用") !== -1 || t.indexOf("不支持工具调用") !== -1) return true;
    var hasToolWord = t.indexOf("function call") !== -1 || t.indexOf("function_call") !== -1 ||
                      t.indexOf("tool call") !== -1 || t.indexOf("tool_call") !== -1 ||
                      t.indexOf("tool_choice") !== -1 || t.indexOf("tools") !== -1;
    if (!hasToolWord) return false;
    return t.indexOf("not support") !== -1 || t.indexOf("unsupported") !== -1 ||
           t.indexOf("doesn't support") !== -1 || t.indexOf("not allowed") !== -1 ||
           t.indexOf("not enabled") !== -1 || t.indexOf("unavailable") !== -1;
  }

  /**
   * 文本协议降级：把工具 schema 转为文本说明注入消息末尾，
   * 要求模型在正文直接输出 JSON 动作数组，格式与 extractToolCalls 的解析对应。
   */
  function buildTextProtocolMessage(tools) {
    var lines = [
      "⚠️ 当前模型不支持 function calling，你必须直接在回复正文中输出 JSON 来表达动作，严格遵守：",
      "1. 整个回复只是一个 JSON 数组，不要输出任何解释、分析或 Markdown 代码块标记",
      "2. 格式：[{\"action\": \"工具名\", \"参数名\": \"参数值\"}]，每轮数组中只放一个动作对象",
      "3. 可用工具及参数如下（参数名带 ? 表示可选）：",
    ];
    for (var i = 0; i < tools.length; i++) {
      var fn = tools[i] && tools[i].function;
      if (!fn || !fn.name) continue;
      var properties = (fn.parameters && fn.parameters.properties) || {};
      var required = (fn.parameters && fn.parameters.required) || [];
      var paramStr = Object.keys(properties).map(function (p) {
        return required.indexOf(p) === -1 ? p + "?" : p;
      }).join(", ");
      lines.push("- " + fn.name + "(" + paramStr + "): " + (fn.description || ""));
    }
    return lines.join("\n");
  }

  /**
   * 为请求应用 tools 或文本协议降级。
   * @returns {Array} 实际发送的 messages（降级时会在末尾追加文本协议 system 消息）
   */
  function applyToolsToBody(body, config, messages, tools) {
    if (!tools || tools.length === 0) return messages;
    var key = modelCapabilityKey(config);
    // 静态能力表门控（借鉴 OpenCode capabilities.toolcall）：明确不支持时直接走文本协议，避免白挨一个 400
    var caps = lookupStaticCaps(config.model);
    if (caps && caps.toolcall === false) modelToolSupport[key] = false;
    if (modelToolSupport[key] === false) {
      // 已知该模型不支持 function calling：直接走文本协议
      return messages.concat([{ role: "system", content: buildTextProtocolMessage(tools) }]);
    }
    body.tools = normalizeToolsForCompatibility(tools);
    // 借鉴 OpenCode（prompt.ts：正常流程不发送 tool_choice，等效 auto）：
    // DashScope 系网关仅支持 auto/none，发送 "required" 会被模板错误误报为“模型不支持函数调用”
    body.tool_choice = "auto";
    return messages;
  }

  // 标记“thinking + tools 组合被网关拒绝”的模型：后续带 tools 的请求不再携带 thinking 参数
  var modelThinkingWithTools = {}; // key → false 表示组合被拒

  /**
   * 4xx 错误降级处理：识别“模型不支持函数调用”类错误，分两段降级。
   * 第一段：body 同时带 thinking 参数时，先剥离 thinking 保留 tools 重试——
   *         部分网关不接受“深度思考 + 函数调用”组合，却统一报“模型不支持函数调用”。
   * 第二段：仍失败才确认模型不支持函数调用，缓存能力结论并切换为文本协议。
   * @returns {Array|null} 降级后的 messages；不可降级返回 null
   */
  function downgradeFunctionCallError(body, config, messages, tools, status, errText) {
    if (!body.tools) return null; // 未发送 tools，与函数调用无关
    if (!(status >= 400 && status < 500) || status === 429) return null;
    if (!isToolCallUnsupportedError(errText)) return null;
    if (body.thinking !== undefined || body.enable_thinking !== undefined) {
      console.warn("[AIFT] 疑似“深度思考 + 函数调用”组合被拒（" + status + "），移除 thinking 参数保留 tools 重试");
      body.thinking = undefined;
      body.enable_thinking = undefined;
      modelThinkingWithTools[modelCapabilityKey(config)] = false;
      return messages;
    }
    console.warn("[AIFT] 模型不支持函数调用（" + status + ": " + errText + "），降级为文本协议");
    modelToolSupport[modelCapabilityKey(config)] = false;
    body.tools = undefined;
    body.tool_choice = undefined;
    return messages.concat([{ role: "system", content: buildTextProtocolMessage(tools) }]);
  }

  // === thinking（深度思考）参数能力处理 ===
  // 不同厂商的 thinking 参数格式不同：GLM 系用 thinking: {type:"enabled"}，
  // qwen/DashScope 系用 enable_thinking: true。运行时按 glm → qwen → none 级联探测并缓存结论。
  // 原则：用户勾选深度思考后，任何请求都不得携带 temperature。
  var modelThinkingMode = {}; // key → "glm" | "qwen" | "none"

  /**
   * 判断 4xx 错误是否与 thinking 参数相关（避免无关 400 误关深度思考）
   */
  function isThinkingRelatedError(errText) {
    var t = String(errText || "").toLowerCase();
    if (!t) return false;
    return t.indexOf("thinking") !== -1 || t.indexOf("enable_thinking") !== -1 ||
           t.indexOf("思考") !== -1 || t.indexOf("reasoning") !== -1;
  }

  /**
   * 按能力为请求应用 thinking 参数。
   * 勾选深度思考时不发送 temperature；未勾选时按 OpenCode 规则应用采样参数。
   * @param {boolean} willSendTools 本次请求是否携带 tools（组合被拒的模型需跳过 thinking 参数）
   * @returns {string} 本次使用的模式 "glm" | "qwen" | "none" | "none-skip" | "off"
   */
  function applyThinkingToBody(body, config, willSendTools) {
    if (!config.enableThinking) {
      applySamplingParams(body, config);
      return "off";
    }
    var mode = resolveInitialThinkingMode(config);
    // 已知该模型“thinking + tools”组合被拒：带 tools 时跳过 thinking 参数（不污染模型级 thinking 结论）
    if (willSendTools && mode !== "none" && modelThinkingWithTools[modelCapabilityKey(config)] === false) {
      return "none-skip";
    }
    if (mode === "glm") {
      body.thinking = { type: "enabled" };
    } else if (mode === "qwen") {
      body.enable_thinking = true;
    }
    // "none"：已知模型不支持深度思考，不带任何 thinking 参数，也不补 temperature
    return mode;
  }

  /**
   * 4xx 时的 thinking 降级：glm → qwen → none 级联切换，缓存探测结论。
   * 与 thinking 无关的 4xx：保底移除 thinking 参数重试一次（不缓存，避免误关深度思考）。
   * 任何情况下都不添加 temperature。
   * @returns {string|null} 降级后的新模式；不可降级返回 null
   */
  function downgradeThinking(body, config, status, errText, currentMode) {
    if (!config.enableThinking) return null;
    if (currentMode !== "glm" && currentMode !== "qwen") return null;
    if (!(status >= 400 && status < 500) || status === 429) return null;
    if (isThinkingRelatedError(errText)) {
      if (currentMode === "glm") {
        console.warn("[AIFT] thinking(GLM 格式) 不被接受（" + status + "），改用 enable_thinking 格式重试");
        body.thinking = undefined;
        body.enable_thinking = true;
        modelThinkingMode[modelCapabilityKey(config)] = "qwen";
        return "qwen";
      }
      console.warn("[AIFT] 模型不支持深度思考（" + status + "），后续请求不再发送 thinking 参数");
      body.thinking = undefined;
      body.enable_thinking = undefined;
      modelThinkingMode[modelCapabilityKey(config)] = "none";
      return "none";
    }
    // 与 thinking 无关的 4xx：body 中还有 thinking 参数时才值得重试，否则交给上层抛错
    if (body.thinking === undefined && body.enable_thinking === undefined) return null;
    console.warn("[AIFT] 4xx（" + status + "），移除 thinking 参数后重试");
    body.thinking = undefined;
    body.enable_thinking = undefined;
    return "none";
  }

  // === 模型静态能力表（借鉴 OpenCode：models.dev capabilities + ProviderTransform 家族默认）===
  // OpenCode 的做法（provider.ts / transform.ts / request.ts）：
  //   1. 每个模型有静态 capabilities（temperature/reasoning/tool_call/modalities），来自 models.dev；
  //   2. temperature 默认不发送（capabilities.temperature ?? false），支持时也按模型家族给调优值；
  //   3. reasoning 为 false 时不发送任何 thinking 参数；DashScope 系用 enable_thinking: true。
  // 这里做轻量化移植：运行时拉取 models.dev 扁平化为能力表，拉取失败则用家族规则 + 运行时探测兜底。
  var MODELS_DEV_URL = "https://models.dev/api.json";
  var MODELS_DEV_CACHE_KEY = "aift_models_dev_caps";
  var MODELS_DEV_TTL = 24 * 3600 * 1000; // 缓存 24 小时
  var MODELS_DEV_RETRY_COOLDOWN = 30 * 60 * 1000; // 失败后 30 分钟冷却，避免内网环境反复打不可达请求
  var modelsDevById = null;   // { [modelIdLower]: { temperature, reasoning, toolcall, vision } }
  var modelsDevPromise = null;
  var modelsDevFailedAt = 0;

  function flattenModelsDev(json) {
    var byId = {};
    Object.keys(json || {}).forEach(function (providerId) {
      var models = json[providerId] && json[providerId].models;
      if (!models) return;
      Object.keys(models).forEach(function (modelId) {
        var m = models[modelId] || {};
        var key = modelId.toLowerCase();
        var caps = {
          temperature: m.temperature === true,
          reasoning: m.reasoning === true,
          toolcall: m.tool_call !== false, // 与 OpenCode 一致：缺省视为支持
          vision: !!(m.modalities && Array.isArray(m.modalities.input) && m.modalities.input.indexOf("image") !== -1),
        };
        var existing = byId[key];
        if (!existing) {
          byId[key] = caps;
        } else {
          // 同一模型多个 provider 都有记录时合并：能力取并集，toolcall 取交集（宁可少走 tools 也不多踩 400）
          byId[key] = {
            temperature: existing.temperature || caps.temperature,
            reasoning: existing.reasoning || caps.reasoning,
            toolcall: existing.toolcall && caps.toolcall,
            vision: existing.vision || caps.vision,
          };
        }
      });
    });
    return byId;
  }

  function readModelsDevCache() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return Promise.resolve(null);
    return chrome.storage.local.get(MODELS_DEV_CACHE_KEY).then(function (cached) {
      var entry = cached && cached[MODELS_DEV_CACHE_KEY];
      if (entry && entry.byId && Date.now() - entry.fetchedAt < MODELS_DEV_TTL) return entry.byId;
      return null;
    }).catch(function () { return null; });
  }

  function writeModelsDevCache(byId) {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
    var entry = {};
    entry[MODELS_DEV_CACHE_KEY] = { fetchedAt: Date.now(), byId: byId };
    chrome.storage.local.set(entry).catch(function () {});
  }

  /**
   * 加载 models.dev 能力表（每次会话只拉取一次，失败静默降级为内置规则）
   * 内网等不可达环境下失败是预期行为：冷却后重试，日志降级为 info 避免误解为故障。
   */
  function loadModelsDevCaps() {
    if (modelsDevPromise) return modelsDevPromise;
    // 失败冷却期内直接跳过，不再发起请求
    if (modelsDevFailedAt && Date.now() - modelsDevFailedAt < MODELS_DEV_RETRY_COOLDOWN) {
      return Promise.resolve(modelsDevById || {});
    }
    modelsDevPromise = readModelsDevCache().then(function (cached) {
      if (cached) {
        modelsDevById = cached;
        return modelsDevById;
      }
      return fetch(MODELS_DEV_URL).then(function (resp) {
        if (!resp.ok) throw new Error("models.dev " + resp.status);
        return resp.json();
      }).then(function (json) {
        modelsDevById = flattenModelsDev(json);
        writeModelsDevCache(modelsDevById);
        return modelsDevById;
      });
    }).catch(function (e) {
      console.info("[AIFT] models.dev 能力表暂不可用（不影响使用，将以内置规则 + 运行时探测兜底）：" + (e && e.message || e));
      modelsDevById = {};
      modelsDevFailedAt = Date.now();
      modelsDevPromise = null; // 冷却后允许重试
      return modelsDevById;
    });
    return modelsDevPromise;
  }

  /**
   * 查询模型的静态能力。网关常在模型名上加前缀（如 openai/qwen-plus），取最后一段兜底匹配。
   * @returns {Object|null} { temperature, reasoning, toolcall, vision }
   */
  function lookupStaticCaps(model) {
    if (!modelsDevById || !model) return null;
    var id = String(model).toLowerCase();
    if (modelsDevById[id]) return modelsDevById[id];
    var lastSegment = id.split("/").pop();
    if (modelsDevById[lastSegment]) return modelsDevById[lastSegment];
    return null;
  }

  /**
   * 家族采样参数默认值（移植自 OpenCode ProviderTransform.temperature/topP）。
   * 仅对已知模型家族给出调优值；未知家族返回空对象（调用方决定兜底）。
   */
  function familySamplingParams(model) {
    var id = String(model || "").toLowerCase();
    var result = {};
    if (id.indexOf("qwen") !== -1) {
      result.temperature = 0.55;
      result.top_p = 1;
    } else if (id.indexOf("glm-4.6") !== -1 || id.indexOf("glm-4.7") !== -1) {
      result.temperature = 1.0;
    } else if (id.indexOf("kimi-k2") !== -1) {
      if (id.indexOf("thinking") !== -1 || id.indexOf("k2.") !== -1 || id.indexOf("k2p") !== -1 || id.indexOf("k2-5") !== -1) {
        result.temperature = 1.0;
      } else {
        result.temperature = 0.6;
      }
    } else if (id.indexOf("minimax-m2") !== -1) {
      result.temperature = 1.0;
      result.top_p = 0.95;
    }
    return result;
  }

  /**
   * 为请求应用采样参数（借鉴 OpenCode request.ts：capabilities.temperature 为 false 时不发送）。
   * 能力表明确不支持 temperature 时不带该参数；已知家族用调优值；其余保持 0.5 默认。
   */
  function applySamplingParams(body, config) {
    var caps = lookupStaticCaps(config.model);
    var family = familySamplingParams(config.model);
    if (caps && caps.temperature === false) {
      // 能力表明确不支持 temperature：不发送
    } else if (family.temperature !== undefined) {
      body.temperature = family.temperature;
    } else {
      body.temperature = 0.5;
    }
    if (family.top_p !== undefined) body.top_p = family.top_p;
  }

  /**
   * 决定 thinking 参数的初始格式（运行时缓存 > 静态能力表 > 启发式）。
   * qwen/DashScope 系直接用 enable_thinking，避免每次都先挨一个 400 再降级。
   */
  function resolveInitialThinkingMode(config) {
    var key = modelCapabilityKey(config);
    if (modelThinkingMode[key]) return modelThinkingMode[key];
    var caps = lookupStaticCaps(config.model);
    if (caps && caps.reasoning === false) {
      // 能力表明确不支持推理：不发送 thinking 参数（与 OpenCode 的 capabilities.reasoning 门控一致）
      modelThinkingMode[key] = "none";
      return "none";
    }
    var hint = (String(config.apiUrl || "") + " " + String(config.model || "")).toLowerCase();
    if (hint.indexOf("dashscope") !== -1 || hint.indexOf("alibaba") !== -1 ||
        hint.indexOf("qwen") !== -1 || hint.indexOf("qwq") !== -1) {
      return "qwen";
    }
    return "glm";
  }

  /**
   * 检测文本中是否存在重复段落（精确匹配，带滑动窗口）
   * 
   * 优化点（减少误报）：
   * 1. 滑动窗口：只统计最近 REPEAT_WINDOW_SIZE 字符内的段落重复，而非全量文本
   *    → 长文本分析中早期引用的数据在后期再次出现是合理的，不应算死循环
   * 2. 跳过数字密集段落：数据分析中反复引用相同数字是正常的
   * 3. 更高的最短长度要求（由调用方传入，已从 40 提升到 80）
   * 
   * @param {string} text - 累积的文本
   * @param {number} minBlockLen - 参与检测的段落最短长度
   * @param {number} threshold - 重复阈值
   * @returns {string|null} - 返回重复的段落文本，无重复返回 null
   */
  function detectRepeatedBlock(text, minBlockLen, threshold) {
    if (!text || text.length < minBlockLen * threshold) return null;
    // 滑动窗口：只检查最近 REPEAT_WINDOW_SIZE 字符
    var windowText = text.length > REPEAT_WINDOW_SIZE
      ? text.substring(text.length - REPEAT_WINDOW_SIZE)
      : text;
    // 按换行分段
    var paragraphs = windowText.split(/\n/);
    var counts = {};
    for (var i = 0; i < paragraphs.length; i++) {
      var p = paragraphs[i].trim();
      if (p.length < minBlockLen) continue;
      // 跳过数字密集段落：去掉数字和运算符后如果剩余内容太短，说明是计算/数据引用，不参与检测
      var nonNumeric = p.replace(/[0-9.,%+\-*/=<>（）()\s]/g, "");
      if (nonNumeric.length < minBlockLen * 0.4) continue;
      if (!counts[p]) counts[p] = 0;
      counts[p]++;
      if (counts[p] >= threshold) return p;
    }
    return null;
  }

  /**
   * 模糊重复检测：检测 AI 是否在反复输出"几乎相同"的长段落
   * 
   * 设计原则（避免误报）：
   * 1. 只检测长段落（>= FUZZY_MIN_BLOCK_LEN），短段落结构相似是正常的
   * 2. 使用完整段落做签名（不是前 30/60 字符），避免同前缀不同内容的误报
   * 3. 阈值更高（FUZZY_REPEAT_THRESHOLD = 4），需要 4 次高度相似才算死循环
   * 4. 签名提取：去掉标点/空格/数字序号后，取完整内容做比对
   * 
   * @param {string} text - 累积的文本
   * @returns {string|null} - 返回重复的段落文本，无重复返回 null
   */
  function detectFuzzyRepeatedBlock(text) {
    if (!text || text.length < FUZZY_MIN_BLOCK_LEN * FUZZY_REPEAT_THRESHOLD) return null;
    var paragraphs = text.split(/\n/);
    var sigCounts = {};
    for (var i = 0; i < paragraphs.length; i++) {
      var p = paragraphs[i].trim();
      if (p.length < FUZZY_MIN_BLOCK_LEN) continue;
      // 提取特征签名：去掉空格、标点、数字序号，保留完整内容
      var sig = p.replace(/[\s\u3000，。、；：！？""''（）()【】\[\]{}.,;:!?'"\-—…·0-9]/g, "");
      if (sig.length < FUZZY_SIG_LEN) continue; // 过滤后太短的不参与（说明原文主要是符号/数字）
      // 使用完整签名做比对（不截断）
      if (!sigCounts[sig]) sigCounts[sig] = { count: 0, raw: p };
      sigCounts[sig].count++;
      if (sigCounts[sig].count >= FUZZY_REPEAT_THRESHOLD) return sigCounts[sig].raw;
    }
    return null;
  }

  /**
   * 调用 OpenAI 兼容的 chat/completions 接口
   * @param {Object} config - { apiUrl, apiKey, model }
   * @param {Array} messages - [{ role, content }]
   * @param {Array} tools - function calling tools schema
   * @param {Object} options - { timeout, maxRetries, signal, onThinking }
   * @returns {Promise<{message: Object, raw: Object}>}
   */
  async function chat(config, messages, tools, options) {
    options = options || {};
    // 后台加载 models.dev 能力表（不阻塞当前请求，加载成功后对后续请求生效）
    try { loadModelsDevCaps(); } catch (e) {}
    // 调用方的旧短超时不能提前中断模型推理；统一保留 600 秒上限。
    var timeout = Math.max(options.timeout || DEFAULT_TIMEOUT, MAX_REASONING_TIME_MS);
    var maxRetries = options.maxRetries !== undefined ? options.maxRetries : DEFAULT_MAX_RETRIES;

    var url = config.apiUrl.replace(/\/+$/, "") + "/chat/completions";

    var body = {
      model: config.model,
      messages: messages,
    };

    // thinking 参数按模型能力缓存选择格式；勾选深度思考时不发送 temperature
    var thinkingMode = applyThinkingToBody(body, config, !!(tools && tools.length));

    // 按模型能力决定发送 tools 还是走文本协议（能力结论在运行时探测并缓存）
    body.messages = applyToolsToBody(body, config, messages, tools);

    // 标记不可重试的错误，避免对 4xx（非 429）做无意义重试
    var NonRetryableError = function (msg) { this.name = "NonRetryableError"; this.message = msg; };
    NonRetryableError.prototype = Object.create(Error.prototype);

    var lastError;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeout);

        // 合并外部 signal（用户中止）与内部 timeout signal
        var externalSignal = options.signal;
        var onExternalAbort = function () { controller.abort(); };
        if (externalSignal) {
          if (externalSignal.aborted) {
            controller.abort();
          } else {
            externalSignal.addEventListener("abort", onExternalAbort, { once: true });
          }
        }

        var resp;
        try {
          resp = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + config.apiKey,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!resp.ok) {
          var errText = "";
          try {
            var errJson = await resp.json();
            errText = (errJson.error && errJson.error.message) ? errJson.error.message : JSON.stringify(errJson);
          } catch (e) {
            errText = resp.statusText;
          }
          // 模型不支持函数调用：缓存能力结论，降级为文本协议重试（不计入重试次数）
          var downgradedMessages = downgradeFunctionCallError(body, config, messages, tools, resp.status, errText);
          if (downgradedMessages) {
            body.messages = downgradedMessages;
            attempt--; // 降级重试不消耗重试次数
            continue;
          }
          // thinking 参数不被接受：级联降级（不添加 temperature，不计入重试次数）
          var downgradedThinkingMode = downgradeThinking(body, config, resp.status, errText, thinkingMode);
          if (downgradedThinkingMode) {
            thinkingMode = downgradedThinkingMode;
            attempt--; // 降级重试不消耗重试次数
            continue;
          }
          var apiErr = new Error("API 错误 " + resp.status + ": " + errText);
          // 4xx 不重试（除 429）
          if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
            var nrErr = new NonRetryableError("API 错误 " + resp.status + ": " + errText);
            throw nrErr;
          }
          throw apiErr;
        }

        var data = await resp.json();
        var message = data.choices && data.choices[0] && data.choices[0].message;
        if (!message) {
          throw new Error("AI 返回格式异常：无 choices[0].message");
        }

        if (attempt > 0) {
          console.warn("[AIFT] 第 " + (attempt + 1) + " 次尝试成功（前 " + attempt + " 次失败）");
        }
        if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
        return { message: message, raw: data };

      } catch (e) {
        if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
        // 不可重试的错误直接抛出
        if (e.name === "NonRetryableError") {
          throw new Error(e.message);
        }

        lastError = e;
        // abort 超时或用户中止
        if (e.name === "AbortError") {
          // 用户主动中止 → 立即抛出，不重试
          if (externalSignal && externalSignal.aborted) {
            var abortErr = new Error("用户中止");
            abortErr.name = "UserAbortError";
            throw abortErr;
          }
          lastError = new Error("AI 请求超时 (" + timeout + "ms)");
        }

        console.warn("[AIFT] chat 第 " + (attempt + 1) + "/" + (maxRetries + 1) + " 次失败: " + (e.message || e));

        // 最后一次不等待
        if (attempt < maxRetries) {
          var delay = RETRY_DELAY_BASE * Math.pow(2, attempt); // 指数退避: 2s, 4s, 8s...
          console.warn("[AIFT] " + delay + "ms 后重试...");
          await new Promise(function (r) { setTimeout(r, delay); });
        }
      }
    }

    throw lastError || new Error("AI 调用失败");
  }

  /**
   * 从正文中提取内嵌的 JSON 动作（文本协议模式下模型可能在 JSON 前后夹杂说明文字）
   * 取第一个 [/{ 到最后一个 ]/} 的子串尝试解析，要求包含 "action"/"name" 字段避免误判
   */
  function extractEmbeddedActionJson(content) {
    var bracketIdx = content.indexOf("[");
    var braceIdx = content.indexOf("{");
    var startIdx;
    if (bracketIdx === -1) startIdx = braceIdx;
    else if (braceIdx === -1) startIdx = bracketIdx;
    else startIdx = Math.min(bracketIdx, braceIdx);
    if (startIdx === -1) return null;
    var closeChar = content.charAt(startIdx) === "[" ? "]" : "}";
    var endIdx = content.lastIndexOf(closeChar);
    if (endIdx <= startIdx) return null;
    var candidate = content.substring(startIdx, endIdx + 1);
    if (candidate.indexOf('"action"') === -1 && candidate.indexOf('"name"') === -1) return null;
    try {
      return JSON.parse(candidate);
    } catch (e) {
      return null;
    }
  }

  /**
   * 从 AI message 中提取 tool_calls
   * @param {Object} message
   * @returns {Array}
   */
  function extractToolCalls(message) {
    if (!message) return [];
    if (message.tool_calls && message.tool_calls.length > 0) return message.tool_calls;
    // 有些模型不返回 tool_calls 而是直接在 content 里返回 JSON
    if (message.content) {
      var content = message.content.trim();
      // 文本协议下模型常用 Markdown 代码块包裹 JSON，先剥离
      var fence = content.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)```\s*$/);
      if (fence) content = fence[1].trim();
      // 严格解析：整个正文是 JSON
      var parsed = null;
      if (content.startsWith("[") || content.startsWith("{")) {
        try {
          parsed = JSON.parse(content);
        } catch (e) {
          parsed = null;
        }
      }
      // 宽松解析：正文中内嵌 JSON 动作
      if (!parsed) parsed = extractEmbeddedActionJson(content);
      if (Array.isArray(parsed)) {
        return parsed.map(function (action, i) {
          return {
            id: "inline_" + i,
            type: "function",
            function: { name: action.action || action.name || "unknown", arguments: JSON.stringify(action) },
          };
        });
      }
      if (parsed && typeof parsed === "object") {
        return [{
          id: "inline_0",
          type: "function",
          function: { name: parsed.action || parsed.name || "unknown", arguments: JSON.stringify(parsed) },
        }];
      }
    }
    return [];
  }

  /**
   * 流式调用 OpenAI 兼容接口
   * @param {Object} config - { apiUrl, apiKey, model }
   * @param {Array} messages
   * @param {Array} tools
   * @param {Object} options - { timeout, maxRetries, signal, onDelta }
   *   onDelta(type, content) - 每收到一个 delta 时回调
   *     type: "content" | "tool_call" | "reasoning"
   *     content: 文本片段
   * @returns {Promise<{message: Object, raw: Object}>}
   */
  async function chatStream(config, messages, tools, options) {
    options = options || {};
    // 后台加载 models.dev 能力表（不阻塞当前请求，加载成功后对后续请求生效）
    try { loadModelsDevCaps(); } catch (e) {}
    // 调用方的旧短超时不能提前中断模型推理；统一保留 600 秒上限。
    var timeout = Math.max(options.timeout || DEFAULT_TIMEOUT, MAX_REASONING_TIME_MS);
    var maxRetries = options.maxRetries !== undefined ? options.maxRetries : DEFAULT_MAX_RETRIES;
    var onDelta = options.onDelta || function () {};

    var url = config.apiUrl.replace(/\/+$/, "") + "/chat/completions";

    var body = {
      model: config.model,
      messages: messages,
      stream: true,
    };

    // thinking 参数按模型能力缓存选择格式；勾选深度思考时不发送 temperature
    var thinkingMode = applyThinkingToBody(body, config, !!(tools && tools.length));

    // 按模型能力决定发送 tools 还是走文本协议（能力结论在运行时探测并缓存）
    body.messages = applyToolsToBody(body, config, messages, tools);

    var lastError;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeout);

        // 合并外部 signal（用户中止）与内部 timeout signal
        var externalSignal = options.signal;
        var reader = null;
        var onExternalAbort = function () {
          controller.abort();
          // fetch 返回后，显式取消 SSE reader，避免服务端继续推送和计费。
          if (reader) {
            try { reader.cancel(); } catch (e) {}
          }
        };
        if (externalSignal) {
          if (externalSignal.aborted) {
            controller.abort();
          } else {
            externalSignal.addEventListener("abort", onExternalAbort, { once: true });
          }
        }

        var resp;
        try {
          resp = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + config.apiKey,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!resp.ok) {
          var errText = "";
          try {
            var errJson = await resp.json();
            errText = (errJson.error && errJson.error.message) ? errJson.error.message : JSON.stringify(errJson);
          } catch (e) {
            errText = resp.statusText;
          }
          // 模型不支持函数调用：缓存能力结论，降级为文本协议重试（不计入重试次数）
          // 放在 thinking 降级之前：该错误更具体，避免被 thinking 降级抢先消耗一次无效重试
          var downgradedMessages = downgradeFunctionCallError(body, config, messages, tools, resp.status, errText);
          if (downgradedMessages) {
            body.messages = downgradedMessages;
            attempt--; // 降级重试不消耗重试次数
            continue;
          }
          // thinking 参数不被接受：级联降级（不添加 temperature，不计入重试次数）
          var downgradedThinkingMode = downgradeThinking(body, config, resp.status, errText, thinkingMode);
          if (downgradedThinkingMode) {
            thinkingMode = downgradedThinkingMode;
            attempt--; // 降级重试不消耗重试次数
            continue;
          }
          var apiErr = new Error("API 错误 " + resp.status + ": " + errText);
          // 4xx 不重试（除 429）
          if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
            apiErr.name = "NonRetryableError";
          }
          throw apiErr;
        }

        // 解析 SSE 流
        reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";
        var contentAccum = "";
        var reasoningAccum = "";
        var toolCallsAccum = {}; // { index: { id, function: { name, arguments } } }
        var lastReasoningCheckLen = 0;
        var lastContentCheckLen = 0;
        var reasoningLoopDetected = false;
        var gracefulCutoff = false; // 超限优雅截断（不抛错，保留已有内容）
        var loopBreakReason = ""; // 中断原因
        var streamStartTime = Date.now();
        var reasoningStartTime = 0; // reasoning 开始时间

        // SSE 服务端不一定会在最后一条 data 后发送换行，统一通过该函数处理
        // 完整行，避免流结束时 buffer 中的最后一个 delta 被丢弃。
        function processSseLine(rawLine) {
          var line = rawLine.trim();
          if (!line || line.startsWith(":")) return;
          if (!line.startsWith("data:")) return;
          var dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]") return;
          try {
            var chunkData = JSON.parse(dataStr);
            var delta = chunkData.choices && chunkData.choices[0] && chunkData.choices[0].delta;
            if (!delta) return;
            if (delta.content) {
              contentAccum += delta.content;
              onDelta("content", delta.content);
            }
            if (delta.reasoning_content) {
              if (reasoningStartTime === 0) reasoningStartTime = Date.now();
              reasoningAccum += delta.reasoning_content;
              onDelta("reasoning", delta.reasoning_content);
            }
            if (delta.tool_calls) {
              for (var ti = 0; ti < delta.tool_calls.length; ti++) {
                var tc = delta.tool_calls[ti];
                var idx = tc.index !== undefined ? tc.index : 0;
                if (!toolCallsAccum[idx]) {
                  toolCallsAccum[idx] = {
                    id: tc.id || "",
                    type: "function",
                    function: { name: "", arguments: "" },
                  };
                }
                if (tc.id) toolCallsAccum[idx].id = tc.id;
                if (tc.type) toolCallsAccum[idx].type = tc.type;
                if (tc.function) {
                  if (tc.function.name) toolCallsAccum[idx].function.name += tc.function.name;
                  if (tc.function.arguments) toolCallsAccum[idx].function.arguments += tc.function.arguments;
                  if (tc.function.name) onDelta("tool_call", "→ " + tc.function.name);
                }
              }
            }
          } catch (e) {
            // JSON 解析失败，跳过当前事件
          }
        }

        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });

          // 按行处理 SSE
          var lines = buffer.split("\n");
          buffer = lines.pop(); // 保留最后不完整的行

          for (var li = 0; li < lines.length; li++) processSseLine(lines[li]);

          // ===== 流内死循环检测 =====
          // 分两类：
          //   A. 死循环（精确重复/模糊重复）→ 抛 ReasoningLoopError，上层注入干预后重试
          //   B. 超时 → 优雅截断，保留已有内容，不抛错，让上层用已有结果继续
          if (!reasoningLoopDetected && !gracefulCutoff) {

            // ---- A 类：死循环检测（抛错重试）----

            // 检测 0: 有工具可用但持续只输出推理/文本。精确和模糊段落检测
            // 无法覆盖同义改写，因此以“无动作 + 长输出”作为独立的进展守卫。
            if (tools && tools.length > 0 && Object.keys(toolCallsAccum).length === 0 &&
                reasoningAccum.length + contentAccum.length >= MAX_NO_ACTION_RESPONSE_CHARS) {
              reasoningLoopDetected = true;
              loopBreakReason = "未调用工具且未产生新证据的长篇推理";
              console.warn("[AIFT] 检测到无动作长篇推理，中断流。");
              break;
            }

            // 检测 1: 精确段落重复检测
            if (reasoningAccum.length - lastReasoningCheckLen >= REASONING_CHECK_INTERVAL) {
              lastReasoningCheckLen = reasoningAccum.length;
              var repeatedReasoning = detectRepeatedBlock(reasoningAccum, REASONING_MIN_BLOCK_LEN, REASONING_REPEAT_THRESHOLD);
              if (repeatedReasoning) {
                reasoningLoopDetected = true;
                loopBreakReason = "推理内容精确重复";
                console.warn("[AIFT] 检测到 reasoning 精确重复死循环，中断流。重复段落: " + repeatedReasoning.substring(0, 100) + "...");
                break;
              }
              // 模糊重复检测：检测"高度相似但不完全相同"的长段落循环
              var fuzzyRepeated = detectFuzzyRepeatedBlock(reasoningAccum);
              if (fuzzyRepeated) {
                reasoningLoopDetected = true;
                loopBreakReason = "推理内容模糊重复（相似长段落循环 " + FUZZY_REPEAT_THRESHOLD + " 次）";
                console.warn("[AIFT] 检测到 reasoning 模糊重复死循环，中断流。相似段落: " + fuzzyRepeated.substring(0, 100) + "...");
                break;
              }
            }

            // 检测 2: content 精确重复检测（阈值更高）
            if (contentAccum.length - lastContentCheckLen >= REASONING_CHECK_INTERVAL) {
              lastContentCheckLen = contentAccum.length;
              var repeatedContent = detectRepeatedBlock(contentAccum, REASONING_MIN_BLOCK_LEN, CONTENT_REPEAT_THRESHOLD);
              if (repeatedContent) {
                reasoningLoopDetected = true;
                loopBreakReason = "输出内容重复";
                console.warn("[AIFT] 检测到 content 重复死循环，中断流。重复段落: " + repeatedContent.substring(0, 100) + "...");
                break;
              }
            }

            // ---- B 类：超时检测（优雅截断，不抛错）----

            // 检测 3: reasoning 时间上限 — 超过后优雅截断
            if (reasoningStartTime > 0 && Date.now() - reasoningStartTime >= MAX_REASONING_TIME_MS) {
              gracefulCutoff = true;
              loopBreakReason = "推理持续时间达到 " + Math.round(MAX_REASONING_TIME_MS / 1000) + " 秒上限，保留已有结果";
              console.warn("[AIFT] reasoning 时间超限 (" + Math.round((Date.now() - reasoningStartTime) / 1000) + "s)，优雅截断");
              break;
            }
          }
        }

        // reader.cancel() 在部分浏览器中会以 done=true 结束读取而不抛异常，
        // 这里必须再次检查外部终止信号，避免把已取消的半截响应当作成功。
        if (externalSignal && externalSignal.aborted) {
          var streamAbortErr = new Error("用户中止");
          streamAbortErr.name = "UserAbortError";
          throw streamAbortErr;
        }

        // 处理没有以换行结尾的最后一条 SSE data 行。
        if (buffer) processSseLine(buffer);

        // 如果是优雅截断（超限），保留已有内容，不抛错
        if (gracefulCutoff) {
          onDelta("content", "\n\n[系统：" + loopBreakReason + "]");
          try { reader.cancel(); } catch (e) {}
          console.warn("[AIFT] 优雅截断: " + loopBreakReason + "，保留已有内容继续");
          // 超时不能被调用方当作成功响应，否则上层会结束当前阶段，
          // 用户后续输入也就没有机会触发下一次请求。携带部分结果，
          // 由上层决定等待继续/用户指令后重新发起请求。
          var timeoutToolCalls = Object.keys(toolCallsAccum).sort(function (a, b) {
            return parseInt(a) - parseInt(b);
          }).map(function (k, i) {
            var tc = toolCallsAccum[k];
            if (!tc.id) tc.id = "call_" + i;
            return tc;
          });
          var timeoutErr = new Error("AI 推理超时，已保留部分结果");
          timeoutErr.name = "ReasoningTimeoutError";
          timeoutErr.breakReason = loopBreakReason;
          timeoutErr.partialContent = contentAccum || null;
          timeoutErr.partialReasoning = reasoningAccum || null;
          timeoutErr.partialToolCalls = timeoutToolCalls;
          throw timeoutErr;
        }

        // 如果是死循环检测，中断流并抛出错误
        if (reasoningLoopDetected) {
          onDelta("content", "\n\n[系统：检测到" + loopBreakReason + "，已自动中断]");
          try { reader.cancel(); } catch (e) {}

          // 组装部分 tool_calls（可能不完整，仅供上层参考）
          var partialToolCallsArr = Object.keys(toolCallsAccum).sort(function (a, b) {
            return parseInt(a) - parseInt(b);
          }).map(function (k, i) {
            var tc = toolCallsAccum[k];
            if (!tc.id) tc.id = "call_" + i;
            return tc;
          });

          var loopErr = new Error("AI " + loopBreakReason + "，已自动中断");
          loopErr.name = "ReasoningLoopError";
          loopErr.breakReason = loopBreakReason;
          // 携带部分累积数据，供上层保留上下文
          loopErr.partialContent = contentAccum || null;
          loopErr.partialReasoning = reasoningAccum || null;
          loopErr.partialToolCalls = partialToolCallsArr;
          throw loopErr;
        }

        // 组装最终 message
        var toolCallsArr = Object.keys(toolCallsAccum).sort(function (a, b) {
          return parseInt(a) - parseInt(b);
        }).map(function (k, i) {
          var tc = toolCallsAccum[k];
          // GLM 流式常不在 delta 里发 id，导致 assistant.tool_calls[].id 为空，
          // 与后续 tool 消息的 tool_call_id 不匹配 → 网关 400。补一个稳定 id。
          if (!tc.id) tc.id = "call_" + i;
          return tc;
        });

        var message = { content: contentAccum || null };
        if (toolCallsArr.length > 0) {
          message.tool_calls = toolCallsArr;
        }
        if (reasoningAccum) {
          message.reasoning_content = reasoningAccum;
        }

        if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
        return { message: message, raw: { content: contentAccum, tool_calls: toolCallsArr } };

      } catch (e) {
        if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
        // 不可重试的错误直接抛出
        if (e.name === "NonRetryableError") {
          throw new Error(e.message);
        }
        // 推理重复循环错误不重试，直接抛出
        if (e.name === "ReasoningLoopError") {
          throw e;
        }
        // 推理超时需要由上层进入可恢复暂停态，不能自动按网络错误重试。
        if (e.name === "ReasoningTimeoutError") {
          throw e;
        }

        lastError = e;
        if (e.name === "AbortError") {
          // 用户主动中止 → 立即抛出，不重试
          if (externalSignal && externalSignal.aborted) {
            var abortErr = new Error("用户中止");
            abortErr.name = "UserAbortError";
            throw abortErr;
          }
          lastError = new Error("AI 请求超时 (" + timeout + "ms)");
        }

        console.warn("[AIFT] chatStream 第 " + (attempt + 1) + "/" + (maxRetries + 1) + " 次失败: " + (e.message || e));

        if (attempt < maxRetries) {
          var delay = RETRY_DELAY_BASE * Math.pow(2, attempt);
          console.warn("[AIFT] " + delay + "ms 后重试...");
          await new Promise(function (r) { setTimeout(r, delay); });
        }
      }
    }

    throw lastError || new Error("AI 调用失败");
  }

  /**
   * 构建视觉多模态消息内容
   * 将文本和图片组合成 OpenAI 兼容的 content 数组格式
   * @param {string} text - 文本部分
   * @param {string} imageDataUrl - data URL 格式的图片（data:image/png;base64,...）
   * @returns {Array} content 数组
   */
  function buildVisionContent(text, imageDataUrl) {
    var content = [];
    if (text) {
      content.push({ type: "text", text: text });
    }
    if (imageDataUrl) {
      content.push({
        type: "image_url",
        image_url: {
          url: imageDataUrl,
        },
      });
    }
    return content;
  }

  /**
   * 构建带截图的视觉用户消息
   * @param {string} text - 提示文本
   * @param {string} imageDataUrl - data URL 图片
   * @returns {{role: string, content: Array}}
   */
  function buildVisionMessage(text, imageDataUrl) {
    return {
      role: "user",
      content: buildVisionContent(text, imageDataUrl),
    };
  }

  global.AIFT_AIClient = {
    chat: chat,
    chatStream: chatStream,
    extractToolCalls: extractToolCalls,
    normalizeToolsForCompatibility: normalizeToolsForCompatibility,
    buildVisionContent: buildVisionContent,
    buildVisionMessage: buildVisionMessage,
    loadModelCaps: loadModelsDevCaps,
    lookupStaticCaps: lookupStaticCaps,
  };
})(window);
