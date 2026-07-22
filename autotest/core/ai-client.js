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

  // === 流内总量上限配置 ===
  var MAX_REASONING_TIME_MS = 600000; // reasoning 阶段最大持续时间 600 秒，超过后优雅截断

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
    // 调用方的旧短超时不能提前中断模型推理；统一保留 600 秒上限。
    var timeout = Math.max(options.timeout || DEFAULT_TIMEOUT, MAX_REASONING_TIME_MS);
    var maxRetries = options.maxRetries !== undefined ? options.maxRetries : DEFAULT_MAX_RETRIES;

    var url = config.apiUrl.replace(/\/+$/, "") + "/chat/completions";

    var body = {
      model: config.model,
      messages: messages,
    };

    if (config.enableThinking) {
      body.thinking = { type: "enabled" };
    } else {
      body.temperature = 0.5;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

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
      // 尝试解析 JSON 数组
      if (content.startsWith("[")) {
        try {
          var parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            return parsed.map(function (action, i) {
              return {
                id: "inline_" + i,
               type: "function",
               function: { name: action.action || action.name || "unknown", arguments: JSON.stringify(action) },
              };
            });
          }
        } catch (e) {
          // 不是 JSON，忽略
        }
      }
      // 尝试解析单个 JSON 对象
      if (content.startsWith("{")) {
        try {
          var obj = JSON.parse(content);
          return [{
           id: "inline_0",
           type: "function",
           function: { name: obj.action || obj.name || "unknown", arguments: JSON.stringify(obj) },
         }];
        } catch (e) {
          // 不是 JSON，忽略
        }
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

    // thinking 模式：GLM 等模型需要显式开启深度思考
    // 开启时 temperature 由模型自行管理（部分模型要求不设或设特定值）
    if (config.enableThinking) {
      body.thinking = { type: "enabled" };
    } else {
      body.temperature = 0.5;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

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
          // 如果 thinking 参数导致报错，自动降级重试（去掉 thinking）
          if (config.enableThinking && resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
            console.warn("[AIFT] thinking 模式可能不被支持（" + resp.status + "），降级重试");
            body.thinking = undefined;
            body.temperature = 0.5;
            continue; // 不计入重试次数
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
    buildVisionContent: buildVisionContent,
    buildVisionMessage: buildVisionMessage,
  };
})(window);
