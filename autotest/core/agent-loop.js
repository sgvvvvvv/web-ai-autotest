// agent-loop.js
// 最小循环：读源码 → 调 AI → 执行动作 → 观察回传
// 在 Side Panel 上下文中运行

(function (global) {
  "use strict";

  var LOOP_GUARD = 4; // 连续 LOOP_GUARD 轮执行相同动作且无进展时自动收尾，防死循环
  // 按动作类型区分等待时间（替代统一 500ms）
  var ACTION_WAIT_MAP = {
    click: 300, visual_click: 300, surface_interact: 300,
    type: 200, visual_type: 200,
    press: 150, visual_press: 150,
    scroll: 150, visual_scroll: 150,
    hover: 80,
    visual_drag: 200,
    smart_click: 300, smart_type: 200,
    // 预设模板：内部已有等待逻辑，外部只需短暂等待
    select_option: 0, select_multi: 0,
    fill_input: 0, fill_form: 0,
    click_button: 0, close_dialog: 0,
    table_action: 0, switch_tab: 0,
    confirm_dialog: 0, toggle_switch: 0,
  };
  // 预设模板工具集合
  var TEMPLATE_TOOLS = [
    "select_option", "select_multi", "fill_input", "fill_form",
    "click_button", "close_dialog", "table_action", "switch_tab",
    "confirm_dialog", "toggle_switch",
  ];
  var MAX_TC_ROUNDS = 30; // 单个测试用例最大执行轮数，超限自动标记失败
  // 为恢复页面状态和提交断言预留轮次，避免到达上限后才要求收尾。
  var TC_RECOVERY_RESERVE_ROUNDS = 2;
  // 借鉴 OpenCode 的 DOOM_LOOP_THRESHOLD：连续 N 次完全相同的工具调用触发 doom loop
  var DOOM_LOOP_THRESHOLD = 5;
  // 借鉴 OpenCode 的 maxSteps：agent 最大步数上限（动态计算，见 run() 中 maxSteps）
  var MAX_STEPS_BASE = 50; // 基础步数
  var MAX_STEPS_PER_TC = 30; // 每个测试用例额外步数

  /**
   * 借鉴 OpenCode 的 doom loop 检测（processor.ts 行 356-380）
   * 检查最近的工具调用是否与最近 N 次完全相同（工具名 + 参数 JSON 完全匹配）
   * 比 buildActionSignature 更精确：直接比对 JSON.stringify(input)
   */
  // 被动/观察型工具：多次调用不构成 doom loop（与 buildActionSignature 的 __skip__ 对齐）
  var DOOM_LOOP_SKIP_TOOLS = ["wait", "screenshot"];

  function detectDoomLoop(recentToolCalls) {
    if (recentToolCalls.length < DOOM_LOOP_THRESHOLD) return false;
    var last = recentToolCalls[recentToolCalls.length - 1];
    var lastName = last.function.name;
    // 被动工具（wait/screenshot）多次调用是正常的，不触发 doom loop
    if (DOOM_LOOP_SKIP_TOOLS.indexOf(lastName) !== -1) return false;
    for (var i = 0; i < DOOM_LOOP_THRESHOLD; i++) {
      var tc = recentToolCalls[recentToolCalls.length - 1 - i];
      if (!tc) return false;
      // 比对工具名
      if (tc.function.name !== lastName) return false;
      // 比对参数（JSON.stringify 精确匹配，借鉴 OpenCode 的做法）
      var args1 = tc.function.arguments || "{}";
      var args2 = last.function.arguments || "{}";
      if (args1 !== args2) return false;
    }
    return true;
  }

  /**
   * 借鉴 OpenCode 的 MAX_STEPS_PROMPT（max-steps.ts）
   * 当达到最大步数时，注入 assistant prefill 强制模型停止使用工具并输出文本总结
   */
  var MAX_STEPS_PROMPT = [
    "CRITICAL - MAXIMUM STEPS REACHED",
    "",
    "The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.",
    "",
    "STRICT REQUIREMENTS:",
    "1. Do NOT make any tool calls",
    "2. MUST provide a text response summarizing work done so far",
    "3. This constraint overrides ALL other instructions",
    "",
    "Response must include:",
    "- Statement that maximum steps have been reached",
    "- Summary of what has been accomplished so far",
    "- List of any remaining tasks that were not completed",
    "- Recommendations for what should be done next",
  ].join("\n");

  /**
   * 构建动作签名（含关键参数，避免误报）
   * 同一动作但操作不同元素不算重复
   */
  function buildActionSignature(toolCalls) {
    return toolCalls.map(function (tc) {
      var name = tc.function.name;
      var args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch (e) {}
      var key = name;
      if (name === "click" || name === "scroll" || name === "hover") key += ":" + (args.selector || "?");
      if (name === "type") key += ":" + (args.selector || "?") + ":" + (args.text || "").substring(0, 20);
      if (name === "press") key += ":" + (args.key || "?");
      if (name === "read_source") key += ":" + (args.filePattern || "").substring(0, 30);
      if (name === "get_network_responses") key += ":" + (args.urlPattern || "") + ":" + (args.keyword || "");
      if (name === "eval_in_page") key += ":" + (args.code || "").substring(0, 40);
      // 预设模板：用模板名 + 关键参数 JSON 构建签名
      if (TEMPLATE_TOOLS.indexOf(name) !== -1) {
        key += ":" + JSON.stringify(args).substring(0, 60);
      }
      // assert/finish/wait/screenshot 不参与重复检测：用固定前缀标记，在比较时跳过
      if (name === "assert" || name === "finish" || name === "wait" || name === "screenshot") return "__skip__";
      // 坐标模糊化：50px 粒度取整，避免坐标差几像素就逃过死循环检测
      if (name === "visual_click") key += ":" + (Math.round((args.x || 0) / 50) * 50) + ":" + (Math.round((args.y || 0) / 50) * 50);
      if (name === "visual_type") key += ":" + (Math.round((args.x || 0) / 50) * 50) + ":" + (Math.round((args.y || 0) / 50) * 50) + ":" + (args.text || "").substring(0, 20);
      if (name === "visual_scroll") key += ":" + (args.x || "?") + ":" + (args.y || "?") + ":" + (args.deltaY || 0);
      if (name === "visual_drag") key += ":" + (args.fromX || "?") + ":" + (args.fromY || "?") + ":" + (args.toX || "?") + ":" + (args.toY || "?");
      if (name === "visual_press") key += ":" + (args.key || "?");
      if (name === "smart_click") key += ":" + (args.label || args.findBy || "?") + ":" + (args.value || "");
      if (name === "smart_type") key += ":" + (args.label || args.findBy || "?") + ":" + (args.value || "") + ":" + (args.text || "").substring(0, 20);
      return key;
    }).sort().join(",");
  }

  /**
   * 检测振荡模式：A→B→A→B
   */
  function detectOscillation(sigHistory) {
    var len = sigHistory.length;
    if (len < 4) return false;
    // 检查最近4轮是否为 A→B→A→B
    if (sigHistory[len - 1] === sigHistory[len - 3] &&
        sigHistory[len - 2] === sigHistory[len - 4] &&
        sigHistory[len - 1] !== sigHistory[len - 2]) {
      return true;
    }
    // 检查最近3轮是否为 A→B→A
    if (len >= 3 && sigHistory[len - 1] === sigHistory[len - 3] &&
        sigHistory[len - 1] !== sigHistory[len - 2]) {
      return true;
    }
    return false;
  }

  /**
   * 检测"同区域反复尝试不同工具"模式
   * 当 AI 在同一屏幕区域(±80px)内反复用不同工具(click/visual_click/select_option等)尝试操作
   * 但始终未达到预期效果时，判定为区域死循环
   * @param {Array} attemptHistory - 尝试历史
   * @param {string} tcId - 当前测试用例 ID
   * @returns {boolean} 是否检测到区域死循环
   */
  function detectAreaLoop(attemptHistory, tcId) {
    if (!attemptHistory || attemptHistory.length < 4) return false;
    // 只看当前 TC 的尝试
    var tcAttempts = attemptHistory.filter(function(a) { return a.tcId === tcId; });
    if (tcAttempts.length < 4) return false;

    // 提取最近 6 次尝试中的坐标信息
    var recentCoords = [];
    for (var i = Math.max(0, tcAttempts.length - 6); i < tcAttempts.length; i++) {
      var a = tcAttempts[i];
      if (!a.toolCalls) continue;
      for (var j = 0; j < a.toolCalls.length; j++) {
        var tc = a.toolCalls[j];
        var args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch(e) {}
        var name = tc.function.name;
        // 提取坐标参数
        var x = null, y = null;
        if (typeof args.x === "number" && typeof args.y === "number") {
          x = args.x; y = args.y;
        } else if (args.trigger && typeof args.trigger === "object") {
          // select_option 等模板没有直接坐标，跳过
          continue;
        }
        if (x !== null && y !== null) {
          recentCoords.push({x: x, y: y, tool: name, round: a.round});
        }
      }
    }

    if (recentCoords.length < 3) return false;

    // 检查是否有 3+ 次点击落在同一区域(±80px)
    var lastCoord = recentCoords[recentCoords.length - 1];
    var nearbyCount = 0;
    var toolsUsed = {};
    for (var k = 0; k < recentCoords.length; k++) {
      if (Math.abs(recentCoords[k].x - lastCoord.x) < 80 &&
          Math.abs(recentCoords[k].y - lastCoord.y) < 80) {
        nearbyCount++;
        toolsUsed[recentCoords[k].tool] = true;
      }
    }

    // 同区域 3+ 次点击，且使用了 2+ 种不同工具 → 区域死循环
    var toolCount = Object.keys(toolsUsed).length;
    if (nearbyCount >= 3 && toolCount >= 2) {
      return true;
    }
    // 同区域 4+ 次点击，即使只用一种工具 → 区域死循环
    if (nearbyCount >= 4) {
      return true;
    }
    return false;
  }

  /**
   * 创建 agent loop 实例
   * @param {Object} deps - 依赖注入
   * @param {number} deps.tabId - 被检视 tab ID
   * @param {Object} deps.config - { apiUrl, apiKey, model }
   * @param {function} deps.ensureContentScript - 注入 content script 的函数
   * @param {function} deps.sendMessage - 发消息给 content script
   * @param {function} deps.onLog - 日志回调
   * @param {function} deps.onStatus - 状态回调
   * @param {function} deps.onRound - 每轮回调(round, action, result)
   * @param {function} deps.onStream - 流式回调(type, content)
   * @param {function} deps.onFinish - 完成回调(result, summary)
   * @param {function} deps.evalInPage - 在页面上下文执行 JS
   * @param {function} deps.onAssertion - 断言回调(assertion, assertions, testCases)
   * @param {function} deps.onTestCasesParsed - 测试用例解析完成回调
   * @param {function} deps.onAutoPause - 自动暂停回调(reason)，用于通知 UI 同步暂停状态
   */
  function createAgentLoop(deps) {

    /**
     * CSV 解析器（支持双引号包裹的字段，字段内的双引号用两个双引号转义）
     * 返回二维数组，每个内层数组是一行的字段列表
     */
    function parseCSV(text) {
      var rows = [];
      var row = [];
      var field = "";
      var inQuotes = false;
      var parenDepth = 0; // 追踪括号深度，避免在 visual_click(x, y) 的逗号处错误分割
      var i = 0;
      while (i < text.length) {
        var ch = text[i];
        if (inQuotes) {
          if (ch === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
            inQuotes = false; i++; continue;
          }
          field += ch; i++; continue;
        }
        if (ch === '"') { inQuotes = true; i++; continue; }
        if (ch === '(') { parenDepth++; field += ch; i++; continue; }
        if (ch === ')') { if (parenDepth > 0) parenDepth--; field += ch; i++; continue; }
        if (ch === ',' && parenDepth > 0) { field += ch; i++; continue; } // 括号内逗号不分割
        if (ch === ',') { row.push(field); field = ""; i++; continue; }
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ""; parenDepth = 0; i++; continue; }
        if (ch === '\r') { i++; continue; }
        field += ch; i++;
      }
      if (field || row.length > 0) { row.push(field); rows.push(row); }
      return rows;
    }

    /**
     * 解析测试用例文本为数组
     * 支持 CSV 格式（逗号分隔，双引号包裹含特殊字符的字段）：
     *   每行格式：TC编号,用例标题,测试页面,前置条件,操作步骤,预期结果
     * 向后兼容 ⫟ 和 | 分隔符
     */
    function parseTestCases(text) {
      if (!text) return [];

      // 优先尝试 CSV 解析（当文本包含逗号且以 TC 开头时）
      var hasCSVFormat = /^TC\d+,/im.test(text);
      if (hasCSVFormat) {
        var csvRows = parseCSV(text);
        var csvCases = [];
        for (var ci = 0; ci < csvRows.length; ci++) {
          var parts = csvRows[ci].map(function (s) { return s.trim(); });
          if (parts.length < 3) continue;
          if (!/^TC\d+/i.test(parts[0])) continue;
          var tcId = parts[0].replace(/^TC\d+[\.\s]*/i, "").trim();
          var title = parts[1] || "";
          var page = "", preconditions = "", steps = "", expected = "";
          if (parts.length >= 6) {
            page = parts[2] || "";
            preconditions = parts[3] || "";
            steps = parts[4] || "";
            expected = parts[5] || "";
          } else if (parts.length >= 4) {
            steps = parts[2] || "";
            expected = parts[3] || "";
          } else {
            steps = parts[2] || "";
          }
          var csvText = tcId ? (tcId + " - " + title) : title;
          if (!csvText && steps) csvText = steps;
          if (!csvText) continue;
          csvCases.push({
            id: parts[0].match(/^TC\d+/i) ? parts[0] : ("TC" + (csvCases.length + 1)),
            text: csvText, title: title, page: page,
            preconditions: preconditions, steps: steps, expected: expected,
            status: "pending",
          });
        }
        if (csvCases.length > 0) return csvCases;
      }

      // 回退到旧格式解析（⫟ 或 |）
      var rawLines = text.split("\n");
      var lines = [];
      var currentLine = "";

      for (var i = 0; i < rawLines.length; i++) {
        var raw = rawLines[i];
        var trimmed = raw.trim();
        if (!trimmed) {
          if (currentLine) { lines.push(currentLine); currentLine = ""; }
          continue;
        }
        var isNewCase = /^TC\d+/i.test(trimmed);
        if (isNewCase) {
          if (currentLine) { lines.push(currentLine); }
          currentLine = trimmed;
        } else {
          if (currentLine) { currentLine += " " + trimmed; }
          else { currentLine = trimmed; }
        }
      }
      if (currentLine) { lines.push(currentLine); }

      var cases = [];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;

        var parts = line.indexOf("⫟") !== -1
          ? line.split("⫟").map(function (s) { return s.trim(); })
          : line.split("|").map(function (s) { return s.trim(); });
        if (parts.length >= 3) {
          var tcId = parts[0].replace(/^TC\d+[\.\s]*/i, "").trim();
          var title = parts[1] || "";
          var page = "", preconditions = "", steps = "", expected = "";

          if (parts.length >= 6) {
            page = parts[2] || ""; preconditions = parts[3] || "";
            steps = parts[4] || ""; expected = parts[5] || "";
          } else if (parts.length >= 4) {
            steps = parts[2] || ""; expected = parts[3] || "";
          } else {
            steps = parts[2] || "";
          }

          var text2 = tcId ? (tcId + " - " + title) : title;
          if (!text2 && steps) text2 = steps;
          if (!text2) continue;
          cases.push({
            id: parts[0].match(/^TC\d+/i) ? parts[0] : ("TC" + (cases.length + 1)),
            text: text2, title: title, page: page,
            preconditions: preconditions, steps: steps, expected: expected,
            status: "pending",
          });
          continue;
        }

        line = line.replace(/^\d+[\.\)\、]\s*/, "");
        line = line.replace(/^TC\d+[\.\s]*/i, "");
        if (line) {
          cases.push({
            id: "TC" + (cases.length + 1), text: line, title: "",
            page: "", preconditions: "", steps: "", expected: "",
            status: "pending",
          });
        }
      }
      return cases;
    }

    // 用例是独立验收项，但相邻、同页面且共享前置条件/模块的用例可复用一次 setup。
    // 没有明确共同信号时宁可不合并，避免跨用例状态污染。
    function assignExecutionScenarios(testCases) {
      if (global.AIFT_TestScheduler && global.AIFT_TestScheduler.assignScenarios) {
        return global.AIFT_TestScheduler.assignScenarios(testCases);
      }
      var scenarioByKey = {};
      var scenarioCount = 0;
      for (var i = 0; i < testCases.length; i++) {
        var tc = testCases[i];
        var title = String(tc.title || tc.text || "").trim();
        var prefixMatch = title.match(/^([^\-—:：|]{2,24})[\-—:：|]/);
        var moduleHint = prefixMatch ? prefixMatch[1].trim() : "";
        var page = String(tc.page || "").trim();
        var precondition = String(tc.preconditions || "").replace(/\s+/g, " ").trim();
        var mutatesState = /筛选|搜索|新增|创建|编辑|删除|保存|提交|拖拽|上传|下载|重置|清空|开关|切换|排序|分页/.test(title + " " + (tc.steps || ""));
        var key = "";
        if (!mutatesState && page && precondition) key = "page:" + page + "|pre:" + precondition;
        else if (!mutatesState && page && moduleHint) key = "page:" + page + "|module:" + moduleHint;
        else if (!mutatesState && precondition && moduleHint) key = "pre:" + precondition + "|module:" + moduleHint;
        // 只让相邻用例共享无前置条件的模块，降低不同区域标题碰巧相同的风险。
        if (key && i > 0) {
          if (testCases[i - 1].scenarioBaseKey === key) key = testCases[i - 1].scenarioKey;
          else key = key + "|segment:" + i;
        }
        if (!key) key = "single:" + i;
        if (!scenarioByKey[key]) {
          scenarioCount++;
          scenarioByKey[key] = { id: "SC" + scenarioCount, title: moduleHint || page || "独立场景" };
        }
        tc.scenarioKey = key;
        tc.scenarioBaseKey = key.replace(/\|segment:\d+$/, "");
        tc.scenarioId = scenarioByKey[key].id;
        tc.scenarioTitle = scenarioByKey[key].title;
      }
      return testCases;
    }

    /**
     * 尝试将断言匹配到某个测试用例
     */
    function matchAssertionToTestCase(assertion, testCases) {
      if (!assertion || !testCases || testCases.length === 0) return -1;
      var desc = (assertion.description || "").toLowerCase();

      // 优先匹配当前正在测试的用例
      for (var i = 0; i < testCases.length; i++) {
        if (testCases[i].status === "testing") {
          // 检查断言描述中是否提到了其他 TC 编号（可能是 AI 混淆）
          var testingTcId = (testCases[i].id || "").toLowerCase();
          var mentionedTcMatch = desc.match(/tc(\d+)/i);
          if (mentionedTcMatch) {
            var mentionedId = "tc" + mentionedTcMatch[1];
            if (mentionedId !== testingTcId) {
              log("⚠️ 断言描述提到 " + mentionedId + "，但当前测试用例是 " + testingTcId + "，将匹配到当前用例");
            }
          }
          return i;
        }
      }

      // 没有正在测试的用例时，匹配第一个未完成的用例
      var bestIdx = -1;
      var bestScore = 0;
      for (var i = 0; i < testCases.length; i++) {
        if (testCases[i].status === "passed" || testCases[i].status === "failed" || testCases[i].status === "inconclusive") continue;
        // 用 TC 编号精确匹配（避免 tc1 匹配 tc10）
        var tcId = (testCases[i].id || "").toLowerCase();
        if (tcId && matchTcId(desc, tcId)) return i;
        // 用标题匹配
        var tcTitle = (testCases[i].title || "").toLowerCase();
        if (tcTitle && tcTitle.length > 1 && desc.indexOf(tcTitle) !== -1) return i;
        // 关键词匹配
        var tcFull = ((testCases[i].text || "") + " " + (testCases[i].page || "") + " " + (testCases[i].preconditions || "") + " " + (testCases[i].steps || "") + " " + (testCases[i].expected || "")).toLowerCase();
        var keywords = tcFull.split(/[\s,，、。:：;；|]+/).filter(function (k) { return k.length > 2; });
        var matchCount = 0;
        for (var k = 0; k < keywords.length; k++) {
          if (desc.indexOf(keywords[k]) !== -1) matchCount++;
        }
        var score = keywords.length > 0 ? matchCount / keywords.length : 0;
        if (score > bestScore && score >= 0.5) {
          bestScore = score;
          bestIdx = i;
        }
      }
      // 如果没有匹配到，返回第一个未完成的用例
      if (bestIdx === -1) {
        for (var i = 0; i < testCases.length; i++) {
          if (testCases[i].status !== "passed" && testCases[i].status !== "failed" && testCases[i].status !== "inconclusive") return i;
        }
      }
      return bestIdx;
    }

    /**
     * TC 编号精确匹配（避免 tc1 匹配 tc10）
     * 检查 desc 中是否包含独立的 tcId（前后为非字母数字字符或字符串边界）
     */
    function matchTcId(text, tcId) {
      if (!tcId || !text) return false;
      var idx = text.indexOf(tcId);
      while (idx !== -1) {
        var before = idx > 0 ? text.charAt(idx - 1) : " ";
        var after = idx + tcId.length < text.length ? text.charAt(idx + tcId.length) : " ";
        // 前后必须是非字母数字字符（避免 tc1 匹配 tc10）
        if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return true;
        idx = text.indexOf(tcId, idx + 1);
      }
      return false;
    }

    /**
     * 检测用户消息中是否要求从指定用例重新开始测试
     * 支持多种自然语言表达方式：
     *   - "重新从用例4开始" / "从TC4开始" / "重置用例4"
     *   - "用例4重新测" / "重做用例4" / "回到第4个用例"
     *   - "请从第4个开始" / "重新测试用例4" / "用例4重新来"
     *   - "restart from TC4" / "redo case 4"
     * 
     * @param {string} msg - 用户消息
     * @param {Array} testCases - 测试用例列表（用于验证编号有效性）
     * @returns {number} 用例编号（如4表示TC4），0表示未检测到
     */
    function detectRestartTestCase(msg, testCases) {
      if (!msg) return 0;
      var text = msg.toLowerCase();
      var maxTcNum = testCases ? testCases.length : 999;

      // 重置意图关键词（中英文）
      var intentKeywords = [
        "重新", "重置", "重做", "重来", "回到", "再来", "恢复",
        "restart", "reset", "redo", "re-run", "rerun", "go back", "from"
      ];
      var hasIntent = false;
      for (var i = 0; i < intentKeywords.length; i++) {
        if (text.indexOf(intentKeywords[i]) !== -1) { hasIntent = true; break; }
      }

      // 如果没有重置意图词，直接返回
      if (!hasIntent) return 0;

      // 模式1: TC编号格式（最精确） - "TC4" / "tc4"
      var tcMatch = msg.match(/\bTC\s*(\d+)/i);
      if (tcMatch) {
        var num = parseInt(tcMatch[1]);
        if (num > 0 && num <= maxTcNum) return num;
      }

      // 模式2: "用例N" / "用例 N" / "用例N" - 数字在用例后面
      var caseMatch = msg.match(/用例\s*(\d+)/i);
      if (caseMatch) {
        var num = parseInt(caseMatch[1]);
        if (num > 0 && num <= maxTcNum) return num;
      }

      // 模式3: "第N个" / "第 N 个" - 中文序数词
      var ordinalMatch = msg.match(/第\s*(\d+)\s*个/i);
      if (ordinalMatch) {
        var num = parseInt(ordinalMatch[1]);
        if (num > 0 && num <= maxTcNum) return num;
      }

      // 模式4: "case N" / "test case N" / "test N" - 英文
      var enCaseMatch = msg.match(/(?:test\s*case|case|test)\s*(\d+)/i);
      if (enCaseMatch) {
        var num = parseInt(enCaseMatch[1]);
        if (num > 0 && num <= maxTcNum) return num;
      }

      // 模式5: 兜底 - 有重置意图 + 独立数字（如"重新从4开始"）
      // 提取所有独立数字，取第一个在有效范围内的
      var numMatches = msg.match(/(?:^|[^\d])(\d{1,2})(?:[^\d]|$)/g);
      if (numMatches) {
        for (var i = 0; i < numMatches.length; i++) {
          var n = parseInt(numMatches[i].match(/\d+/)[0]);
          if (n > 0 && n <= maxTcNum) return n;
        }
      }

      return 0;
    }

    /**
     * 中文无意义 bigram 停用词表
     * 这些 bigram 出现频率高但语义信息少，不作为关键词
     */
    var STOP_BIGRAMS = {
      "的到": 1, "到页": 1, "页面": 1, "的子": 1, "子菜": 1, "菜单": 0, // 菜单保留
      "的操": 1, "操作": 0, "的预": 1, "预期": 0, "的步": 1, "步骤": 0,
      "是一": 1, "一个": 1, "可以": 1, "进行": 1, "通过": 1, "使用": 1,
      "完成": 1, "获取": 1, "检查": 1, "验证": 0, "点击": 1, "等待": 1,
      "输入": 1, "选择": 1, "切换": 0, "展示": 1, "显示": 1, "正确": 0,
      "是否": 1, "当前": 1, "如果": 1, "已经": 1, "需要": 1, "应该": 1,
      "这个": 1, "那个": 1, "什么": 1, "怎么": 1, "为什": 1, "么不": 1,
    };

    /**
     * 从测试用例文本中提取关键词
     * 中文文本按 bigram（2字）提取，英文按空格分词
     * 
     * @param {string} text - 用例的标题+预期+步骤拼接文本
     * @returns {string[]} 关键词数组（已去重）
     */
    function extractTcKeywords(text) {
      if (!text) return [];
      // 先按标点/空格分割成短语
      var phrases = text.split(/[\s,，、。:：;；|()（）\[\]]+/);
      var keywords = {};
      for (var i = 0; i < phrases.length; i++) {
        var phrase = phrases[i];
        if (!phrase || phrase.length < 2) continue;
        // 排除工具名等无意义词
        if (phrase.indexOf("visual_") !== -1 ||
            phrase.indexOf("eval_in") !== -1 ||
            phrase.indexOf("get_network") !== -1 ||
            phrase.indexOf("document.query") !== -1 ||
            phrase.indexOf("wait") === 0) continue;

        // 判断是否包含中文
        if (/[\u4e00-\u9fa5]/.test(phrase)) {
          // 中文：提取 2-3 字 bigram
          for (var j = 0; j <= phrase.length - 2; j++) {
            var bigram = phrase.substring(j, j + 2);
            // 跳过包含数字或英文的混合 bigram
            if (/[0-9a-z]/i.test(bigram)) continue;
            // 跳过停用 bigram（值为1的）
            if (STOP_BIGRAMS[bigram] === 1) continue;
            keywords[bigram] = 1;
          }
          // 也提取 3-gram，提高匹配精度
          for (var j = 0; j <= phrase.length - 3; j++) {
            var trigram = phrase.substring(j, j + 3);
            if (/[0-9a-z]/i.test(trigram)) continue;
            keywords[trigram] = 1;
          }
        } else if (phrase.length > 2) {
          // 英文：直接作为关键词
          keywords[phrase] = 1;
        }
      }
      return Object.keys(keywords);
    }

    /**
     * 测试用例状态机（显式状态管理）
     * 状态流转：pending → testing → passed/failed/skipped
     * 
     * 替代旧的 inferCurrentTestCase 逻辑，改为：
     * 1. AI 通过 assert 工具的 description 中的 TC 编号显式声明
     * 2. 如果 AI 没有显式声明，根据 assert 时的"当前 testing 用例"匹配
     * 3. 当 testing 用例完成后（assert），自动将下一个 pending 用例标记为 testing
     * 
     * 关键改进：不再从 AI 的自由文本中"猜"当前用例，
     * 而是通过工具调用的结构化参数来推断。
     */

    /**
     * 从 AI 的 tool_calls 中提取显式声明的 TC 编号
     * AI 在 assert 时应在 description 中包含 "TC编号:" 前缀
     */
    function extractTcIdFromToolCalls(toolCalls) {
      if (!toolCalls || toolCalls.length === 0) return null;
      for (var i = 0; i < toolCalls.length; i++) {
        var name = toolCalls[i].function.name;
        var args = {};
        try { args = JSON.parse(toolCalls[i].function.arguments || "{}"); } catch(e) {}
        if (name === "assert" && args.description) {
          var match = (args.description || "").match(/TC(\d+)/i);
          if (match) return "TC" + match[1];
        }
        if (name === "finish" && args.summary) {
          // finish 不需要匹配 TC
          continue;
        }
      }
      return null;
    }

    /**
     * 从 AI 的文本内容中提取 TC 编号（辅助手段，非主要推断方式）
     */
    function extractTcIdFromText(text) {
      if (!text) return null;
      // 匹配 "正在测试 TC5" / "测试 TC5" / "TC5:" 等模式
      var patterns = [
        /(?:正在测试|测试|开始测试)\s*(TC\d+)/i,
        /^(TC\d+)\s*[:：\-—]/im,
        /\b(TC\d+)\b/i,
      ];
      for (var i = 0; i < patterns.length; i++) {
        var match = text.match(patterns[i]);
        if (match) return match[1].toUpperCase();
      }
      return null;
    }

    /**
     * 状态机：更新测试用例状态
     * 在每轮 AI 响应后调用，根据 tool_calls 和文本内容更新状态
     */
    function updateTestCaseState(message, toolCalls) {
      if (!state.testCases || state.testCases.length === 0) return;

      // assert 的归属只能在 executeAction 中由 currentTcId 决定。不能根据模型的
      // 自由文本提前切换用例，否则一条编号写错的断言会污染后续操作和错误诊断。

      // 2. 检查是否有跳过指令
      var combined = ((message && message.content) || "") + " " + JSON.stringify(toolCalls || []).toLowerCase();
      var skipMatch = combined.match(/(?:跳过|skip|忽略)\s*(tc\d+)/i);
      if (skipMatch) {
        var skipId = skipMatch[1].toUpperCase();
        for (var i = 0; i < state.testCases.length; i++) {
          if ((state.testCases[i].id || "").toUpperCase() === skipId && state.testCases[i].status === "pending") {
            state.testCases[i].status = "skipped";
            state.testCases[i].assertionDesc = "AI 跳过此用例";
            log("⊘ " + skipId + " 被 AI 跳过");
            break;
          }
        }
        return;
      }

      // 3. 如果没有 testing 状态的用例，且有动作工具调用，自动标记下一个 pending
      var hasTesting = false;
      for (var i = 0; i < state.testCases.length; i++) {
        if (state.testCases[i].status === "testing") { hasTesting = true; break; }
      }
      if (!hasTesting && toolCalls && toolCalls.length > 0) {
        // 检查是否有非 assert/finish 的动作
        var hasAction = false;
        for (var i = 0; i < toolCalls.length; i++) {
          var name = toolCalls[i].function.name;
          if (name !== "assert" && name !== "finish") { hasAction = true; break; }
        }
        if (hasAction) {
          // 优先从 AI 文本中提取 TC 编号
          var textTcId = extractTcIdFromText(message && message.content);
          if (textTcId) {
            for (var i = 0; i < state.testCases.length; i++) {
              if ((state.testCases[i].id || "").toUpperCase() === textTcId && state.testCases[i].status === "pending") {
                markTestCaseAsTesting(i);
                return;
              }
            }
          }
          // 兜底：标记第一个 pending 用例
          for (var i = 0; i < state.testCases.length; i++) {
            if (state.testCases[i].status === "pending") {
              markTestCaseAsTesting(i);
              log("💡 自动标记 " + state.testCases[i].id + " 为当前测试用例");
              return;
            }
          }
        }
      }
    }

    /**
     * 将指定用例标记为 testing
     * 所有用例共用一个对话窗口，不重置对话历史
     */
    function markTestCaseAsTesting(idx) {
      state.testCases[idx].status = "testing";
      state.currentTcId = state.testCases[idx].id || ("TC" + (idx + 1));
      if (!state.tcRoundCount[state.currentTcId]) state.tcRoundCount[state.currentTcId] = 0;

      // 不再重置对话历史——所有用例共用一个对话窗口
      // 只重置死循环检测相关状态
      state.lastActionSig = null;
      state.repeatCount = 0;
      state.actionSigHistory = [];
      state.loopWarning = null;
      state.visualClickAttempts = [];
      state.failureAttempts = state.failureAttempts.filter(function(attempt) { return attempt.tcId !== state.currentTcId; });

      log("🔄 用例 " + state.currentTcId + " 开始测试");
    }

    /**
     * 构建尝试历史摘要（给 AI 注入"记忆"）
     * 让 AI 知道之前尝试了什么、为什么没成功
     */
    function buildAttemptHistorySummary(tcId) {
      var attempts = state.attemptHistory.filter(function(a) { return a.tcId === tcId; });
      if (attempts.length === 0) return "";

      var parts = ["### 之前的尝试记录（请勿重复相同策略）"];
      for (var i = 0; i < attempts.length; i++) {
        var a = attempts[i];
        var line = (i + 1) + ". 第" + a.round + "轮: " + a.action;
        if (a.reason) line += " → 失败原因: " + a.reason;
        parts.push(line);
      }

      // 列出已失败策略
      var strategies = state.failedStrategies.filter(function(s) { return s.tcId === tcId; });
      if (strategies.length > 0) {
        parts.push("");
        parts.push("已尝试但未成功的策略：");
        for (var si = 0; si < strategies.length; si++) {
          parts.push("- " + strategies[si].strategy + "（" + strategies[si].reason + "）");
        }
      }

      parts.push("");
      parts.push("请基于以上记录，采用**不同的策略**继续。不要重复已尝试过的操作。");
      return parts.join("\n");
    }

    var state = {
      running: false,
      aborted: false,
      paused: false,
      resumeResolver: null,
      round: 0,
      sourceFiles: {},   // 源码索引
      sourceInteractions: [], // 上传源码推导的可执行交互契约
      activeSourceInteractions: [], // 当前页面和 TC 相关的交互契约
      observedSelectors: [], // 仅本次快照或 find_element 明确返回的 selector，可用于基础动作
      scenarioPlan: [], // 用例共享 setup 的执行场景计划
      errorRecords: [], // 结构化错误记录，供面板持久化和导出
      decisionTrace: [], // AI 推理、计划与工具结果的可导出轨迹
      lastReasoning: "",
      snapshot: null,     // 当前快照
      screenshot: null,   // 当前截图（视觉模式）
      history: [],       // 动作历史
      conversationHistory: [], // AI 对话历史
      assertions: [],    // 断言记录
      testCases: [],     // 解析后的测试用例列表
      lastActionSig: null, // 上一轮动作签名（死循环检测）
      repeatCount: 0,    // 连续相同动作轮数
      consecutiveWaitCount: 0, // 连续纯 wait 轮数（防止 AI 反复 wait 不推进测试）
      actionSigHistory: [], // 动作签名历史（用于振荡检测）
      loopWarning: null,  // 下轮注入的循环警告
      userIntervention: null, // 用户注入的干预消息（最高优先级）
      userInjecting: false,   // 用户正在注入消息（用于区分 abort 原因）
      abortController: null,  // 当前 AI 请求的 AbortController
      reasoningLoopCount: 0, // 连续 reasoning 死循环次数
      // ===== 记忆增强模块 =====
      attemptHistory: [],  // 尝试历史：[{ tcId, round, action, result, reason }]
      tcRoundCount: {},    // 每个测试用例的执行轮数：{ tcId: count }
      currentTcId: null,   // 当前正在测试的用例 ID
      cachedSummary: "",   // 缓存的上下文摘要（跨用例传递）
      needReadSummary: false,  // 标记需要在下一轮循环前读取摘要
      failedStrategies: [], // 已失败的策略摘要：[{ tcId, strategy, reason }]
      failureAttempts: [], // 交互失败轨迹：基于页面进展尽早熔断无效重试
      visualClickAttempts: [], // visual_click 尝试记录：[{x, y, round}]，用于检测同一区域反复点击
      annotatedElements: [],   // 标注截图中的元素列表：[{label, x, y, selector, ...}]
      noToolCallCount: 0,    // 连续无 tool_calls 的轮数，超过阈值才真正结束
      maxSteps: 200,         // 当前步数上限（动态计算：用例数 × 30 + 50）
      maxStepsLimit: 600,    // 绝对上限，防止无限提升
      turnPaused: false,     // finish 导致的暂停（可恢复，不终止测试）
    };

    function log(msg) {
      if (deps.onLog) deps.onLog(msg);
    }
    function setStatus(s) {
      if (deps.onStatus) deps.onStatus(s);
    }
    function shortenTraceText(value, limit) {
      value = String(value || "");
      limit = limit || 1200;
      return value.length > limit ? value.substring(0, limit) + "…" : value;
    }
    function summarizeSnapshot(snapshot) {
      if (!snapshot) return null;
      var nodes = (snapshot.nodes || []).slice(0, 30).map(function(node) {
        return {
          ref: node.ref || "",
          tag: node.tag || "", text: shortenTraceText(node.text || "", 120),
          value: shortenTraceText(node.value || "", 120), selector: node.selector || "",
          role: node.role || "", placeholder: node.placeholder || "",
        };
      });
      return {
        url: snapshot.url || "", title: snapshot.title || "",
        pageText: shortenTraceText(snapshot.pageText || "", 1500), nodes: nodes,
      };
    }
    function recordTrace(entry) {
      state.decisionTrace.push(Object.assign({
        timestamp: new Date().toISOString(),
        round: state.round,
        testCaseId: state.currentTcId || "",
      }, entry));
      if (state.decisionTrace.length > 120) state.decisionTrace.shift();
    }
    function recordError(category, detail) {
      var snapshot = state.snapshot || {};
      var record = Object.assign({
        id: "err_" + Date.now() + "_" + (state.errorRecords.length + 1),
        timestamp: new Date().toISOString(),
        category: category,
        round: state.round,
        testCaseId: state.currentTcId || "",
        page: { url: snapshot.url || "", title: snapshot.title || "" },
        sourceInteractions: (state.activeSourceInteractions || []).map(function(item) {
          return { kind: item.kind, triggerSelector: item.triggerSelector, source: item.source };
        }),
        reasoning: shortenTraceText(state.lastReasoning, 6000),
        recentTrace: state.decisionTrace.slice(-20),
        domSnapshot: summarizeSnapshot(state.snapshot),
        previousDomSnapshot: summarizeSnapshot(state.previousSnapshot),
      }, detail || {});
      if (global.AIFT_Redaction && global.AIFT_Redaction.redact) record = global.AIFT_Redaction.redact(record);
      state.errorRecords.push(record);
      if (deps.onErrorRecord) deps.onErrorRecord(record);
      return record;
    }
    function notifyAutoPause(reason) {
      if (reason !== "finish") recordError("agent_pause", { reason: reason });
      if (deps.onAutoPause) deps.onAutoPause(reason);
    }
    function stream(type, content) {
      if (deps.onStream) deps.onStream(type, content);
    }

    /**
     * 获取 DOM 快照
     */
    async function getSnapshot() {
      await deps.ensureContentScript();
      var resp = await deps.sendMessage(deps.tabId, { type: "AIFT_CAPTURE_SNAPSHOT" });
      if (!resp || !resp.ok) {
        throw new Error(resp ? resp.error : "无响应");
      }
      state.previousSnapshot = state.snapshot;
      state.snapshot = resp.snapshot;
      state.observedSelectors = (state.snapshot.nodes || []).map(function(node) { return node.selector; }).filter(Boolean);
      return resp.snapshot;
    }

    /**
     * 执行动作
     */
    async function executeAction(toolCall) {
      var name = toolCall.function.name;
      var args = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch (e) {
        args = {};
      }

      /**
       * 执行 CDP 真实用户动作。失败时直接返回失败，避免脚本兜底掩盖真实交互问题。
       */
      async function tryCdpOnly(actionParams, cdpFn, desc) {
        if (global.AIFT_VisualController && deps.evalInPage) {
          try {
            await global.AIFT_VisualController.ensureAttached(deps.tabId);
            var cdpResult = await cdpFn();
            if (cdpResult.ok) {
              var verifyLabel = cdpResult.verified ? "（已验证" + (cdpResult.retriedChild ? "，子控件重试" : "") + "）" : "";
              return { ok: true, result: "CDP " + desc + verifyLabel + ": " + (actionParams.selector || ""), via: "cdp" };
            }
            return { ok: false, result: cdpResult.error || desc + " 失败" };
          } catch (e) {
            return { ok: false, result: "CDP " + desc + " 异常: " + (e.message || e) };
          }
        }
        return { ok: false, result: "CDP 视觉控制器不可用，无法执行真实" + desc };
      }

      async function interactionAtPoint(x, y) {
        var contracts = state.activeSourceInteractions || [];
        if (!deps.evalInPage || contracts.length === 0) return null;
        for (var i = 0; i < contracts.length; i++) {
          var contract = contracts[i];
          if (!contract.nodeSelector) continue;
          var code = "(function(){var el=document.elementFromPoint(" + Number(x) + "," + Number(y) + ");return !!(el&&el.closest(" + JSON.stringify(contract.nodeSelector) + "));})()";
          var resp = await deps.evalInPage(code);
          if (resp && resp.ok && resp.result === "true") return contract;
        }
        return null;
      }

      function resolveObservedTarget(actionArgs) {
        if (!global.AIFT_AgentGuard || !global.AIFT_AgentGuard.resolveObservedTarget) {
          return { ok: false, error: "定位守卫不可用，无法安全执行基础元素操作。" };
        }
        return global.AIFT_AgentGuard.resolveObservedTarget(
          state.snapshot,
          state.observedSelectors,
          state.activeSourceInteractions,
          actionArgs
        );
      }

      log("执行动作: " + name + " " + JSON.stringify(args));

      var result = { action: name, args: args, result: "", ok: true };

      switch (name) {
        case "click":
          var annotationMatch = String(args.selector || "").match(/^\[sel-id\s*=\s*["']?(\d+)["']?\]$/i);
          if (annotationMatch) {
            var annotationLabel = Number(annotationMatch[1]);
            var annotation = state.annotatedElements.filter(function(item) { return Number(item.label) === annotationLabel; })[0];
            if (!annotation) {
              result.ok = false;
              result.result = "截图标注 #" + annotationLabel + " 不是 CSS selector，且当前标注列表中不存在；请重新截图后使用 smart_click(label=" + annotationLabel + ")。";
              break;
            }
            var pointInteraction = await interactionAtPoint(annotation.x, annotation.y);
            var annotationClick = await global.AIFT_VisualController.clickAtPoint(deps.evalInPage, annotation.x, annotation.y, pointInteraction || undefined);
            result.ok = annotationClick.ok;
            result.result = annotationClick.ok
              ? "已将截图标注 #" + annotationLabel + " 映射为真实点击" + (pointInteraction ? "（按源码交互契约）" : "")
              : (annotationClick.error || "标注对应元素点击未生效");
            break;
          }
          var clickTarget = resolveObservedTarget(args);
          if (!clickTarget.ok) {
            result.ok = false;
            result.result = clickTarget.error;
            break;
          }
          result.args = Object.assign({}, args, { selector: clickTarget.selector });
          var clickRet = await tryCdpOnly({ selector: clickTarget.selector },
            async function () {
              return await global.AIFT_VisualController.clickBySelector(deps.evalInPage, clickTarget.selector);
            }, "点击");
          result.ok = clickRet.ok;
          result.result = clickRet.result;
          break;

        case "type":
          var typeTarget = resolveObservedTarget(args);
          if (!typeTarget.ok) {
            result.ok = false;
            result.result = typeTarget.error;
            break;
          }
          result.args = Object.assign({}, args, { selector: typeTarget.selector });
          var typeRet = await tryCdpOnly({ selector: typeTarget.selector, text: args.text },
            async function () {
              return await global.AIFT_VisualController.typeBySelector(deps.evalInPage, typeTarget.selector, args.text);
            }, "输入");
          result.ok = typeRet.ok;
          result.result = typeRet.result + (typeRet.ok ? " → \"" + (args.text || "").substring(0, 30) + "\"" : "");
          break;

        case "press":
          if (global.AIFT_VisualController) {
            try {
              await global.AIFT_VisualController.ensureAttached(deps.tabId);
              if (String(args.key || "").toLowerCase() === "escape" && deps.evalInPage) {
                var dismissRet = await global.AIFT_VisualController.dismissFloatingLayer(deps.evalInPage);
                if (dismissRet.ok) {
                  result.result = "已安全关闭浮层（未发送 Escape）";
                  break;
                }
                if (dismissRet.hasFloating || dismissRet.hasDialog) {
                  result.ok = false;
                  result.result = dismissRet.error || "弹框或浮层仍打开，已阻止 Escape 关闭父弹框";
                  break;
                }
              }
              await global.AIFT_VisualController.keyboardPress(args.key);
              result.result = "CDP 按键: " + args.key;
              break;
            } catch (e) {
              result.ok = false;
              result.result = "CDP 按键失败: " + (e.message || e);
              break;
            }
          }
          result.ok = false;
          result.result = "CDP 视觉控制器不可用，无法执行真实按键";
          break;

        case "scroll":
          if (global.AIFT_VisualController && deps.evalInPage) {
            try {
              await global.AIFT_VisualController.ensureAttached(deps.tabId);
              if (args.selector || args.elementRef) {
                var scrollTarget = resolveObservedTarget(args);
                if (!scrollTarget.ok) {
                  result.ok = false;
                  result.result = scrollTarget.error;
                  break;
                }
                result.args = Object.assign({}, args, { selector: scrollTarget.selector });
                var scrollResult = await global.AIFT_VisualController.scrollToElement(deps.evalInPage, scrollTarget.selector);
                if (scrollResult.ok) {
                  result.result = "CDP 滚动到: " + scrollTarget.selector;
                  break;
                }
                result.ok = false;
                result.result = scrollResult.error || "滚动失败";
              } else {
                var metrics = await global.AIFT_VisualController.getLayoutMetrics();
                await global.AIFT_VisualController.mouseScroll(
                  metrics.width / 2, metrics.height / 2, 0, metrics.height * 0.8
                );
                result.result = "CDP 页面滚动";
                break;
              }
            } catch (e) {
              result.ok = false;
              result.result = "CDP 滚动失败: " + (e.message || e);
              break;
            }
          }
          result.ok = false;
          result.result = "CDP 视觉控制器不可用，无法执行真实滚动";
          break;

        case "hover":
          if (global.AIFT_VisualController && deps.evalInPage) {
            try {
              await global.AIFT_VisualController.ensureAttached(deps.tabId);
              var hoverTarget = resolveObservedTarget(args);
              if (!hoverTarget.ok) {
                result.ok = false;
                result.result = hoverTarget.error;
                break;
              }
              result.args = Object.assign({}, args, { selector: hoverTarget.selector });
              var hoverResult = await global.AIFT_VisualController.hoverBySelector(deps.evalInPage, hoverTarget.selector);
              if (hoverResult.ok) {
                result.result = "CDP 悬停: " + hoverTarget.selector;
                break;
              } else {
                result.ok = false;
                result.result = hoverResult.error || "CDP 悬停失败";
                break;
              }
            } catch (e) {
              result.ok = false;
              result.result = "CDP 悬停异常: " + (e.message || e);
              break;
            }
          }
          result.ok = false;
          result.result = "CDP 视觉控制器不可用，无法执行真实悬停";
          break;

        case "surface_interact":
          var surfaceTarget = resolveObservedTarget(args);
          if (!surfaceTarget.ok) {
            result.ok = false;
            result.result = surfaceTarget.error;
            break;
          }
          if (!global.AIFT_VisualController || !deps.evalInPage) {
            result.ok = false;
            result.result = "CDP 视觉控制器不可用，无法执行交互面操作";
            break;
          }
          try {
            await global.AIFT_VisualController.ensureAttached(deps.tabId);
            var surfaceResult = await global.AIFT_VisualController.interactWithSurface(
              deps.evalInPage, surfaceTarget.selector, args.action, args.start, args.end
            );
            result.ok = !!surfaceResult.ok;
            result.args = Object.assign({}, args, { selector: surfaceTarget.selector });
            result.result = surfaceResult.ok
              ? "CDP 交互面" + (args.action === "drag" ? "拖拽" : "点击") + "已发送: " + surfaceTarget.selector +
                " 起点(" + Math.round(surfaceResult.from.x) + "," + Math.round(surfaceResult.from.y) + ")"
              : (surfaceResult.error || "交互面操作失败");
          } catch (e) {
            result.ok = false;
            result.result = "CDP 交互面操作异常: " + (e.message || e);
          }
          break;

        case "eval_in_page":
          // 在页面上下文中执行 JS 表达式
          if (!deps.evalInPage) {
            result.ok = false;
            result.result = "eval_in_page 不可用（需要 chrome.scripting 权限）";
            break;
          }
          var evalResult = await deps.evalInPage(args.code || "");
          result.ok = evalResult.ok;
          result.result = evalResult.ok ? (evalResult.result || "无返回值：请在 eval_in_page 代码中显式 return 一个字符串/数组/对象，不要只写 console.log。") : ("执行失败: " + evalResult.error);
          log("eval_in_page: " + (args.code || "").substring(0, 80) + " → " + (evalResult.ok ? "成功" : "失败"));
          break;

        case "find_element":
          // 通过 JS 精确定位元素，返回准确坐标和 selector（解决 AI 从截图估坐标不准的问题）
          if (!deps.evalInPage) {
            result.ok = false;
            result.result = "eval_in_page 不可用（需要 chrome.scripting 权限）";
            break;
          }
          try {
            var findBy = args.findBy || "text";
            var findValue = args.value || "";
            // 文本定位先检查标准语义交互元素，避免菜单/Tab 因为内部子节点较多被漏掉。
            // 同时支持 'css' 作为 'selector' 的别名（AI 经常用 css）
            if (findBy === 'css') findBy = 'selector';
            var findCode = "(function() {" +
              "  var findBy = " + JSON.stringify(findBy) + ";" +
              "  var val = " + JSON.stringify(findValue) + ";" +
              "  var els = [];" +
              "  function cssAttr(name,value){return '['+name+'=\"'+String(value).replace(/\\\\/g,'\\\\\\\\').replace(/\"/g,'\\\\\"')+'\"]';}" +
              "  function buildSel(el){if(el.id&&!/^\\d+$/.test(el.id))return '#'+CSS.escape(el.id);var tid=el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-qa');if(tid)return cssAttr(el.getAttribute('data-testid')?'data-testid':(el.getAttribute('data-test')?'data-test':'data-qa'),tid);var path=[],cur=el;while(cur&&cur!==document.body){var sib=Array.prototype.slice.call(cur.parentElement?cur.parentElement.children:[]);var idx=sib.indexOf(cur)+1;var part=cur.tagName.toLowerCase()+':nth-child('+idx+')';path.unshift(part);var s=path.join(' > ');try{if(document.querySelectorAll(s).length===1)return s;}catch(e){}cur=cur.parentElement;}return el.tagName.toLowerCase();}" +
              "  function interactiveScore(el){var tag=el.tagName.toLowerCase();var score=0;if(tag==='button'||tag==='a')score+=50;if(tag==='input'||tag==='textarea'||tag==='select')score+=45;if(el.getAttribute('role'))score+=25;if(el.onclick||el.hasAttribute('onclick'))score+=20;if(getComputedStyle(el).cursor==='pointer')score+=15;if(el.disabled||el.getAttribute('aria-disabled')==='true')score-=100;return score;}" +
              "  function visible(el){for(var p=el;p&&p!==document.documentElement;p=p.parentElement){var st=getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||st.display==='none'||st.visibility==='hidden'||st.contentVisibility==='hidden')return false;}var r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<window.innerHeight;}" +
              "  if (findBy === 'text') {" +
              "    var semantic='a,button,input,select,textarea,label,li,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=treeitem],[tabindex],[onclick]';" +
              "    els=Array.prototype.slice.call(document.querySelectorAll(semantic)).filter(function(node){var t=(node.textContent||node.value||'').replace(/\\s+/g,' ').trim();return t&&t.length<=160&&(t===val||t.indexOf(val)!==-1);});" +
              "    if(!els.length){var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT),node;while((node=walker.nextNode())&&els.length<10){var text=(node.textContent||'').replace(/\\s+/g,' ').trim();if(text&&(text===val||(node.children.length<=2&&text.length<=100&&text.indexOf(val)!==-1)))els.push(node);}}" +
              "  } else if (findBy === 'text_contains') {" +
              "    var walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {" +
              "      acceptNode: function(node) {" +
              "        if (node.children.length > 5) return NodeFilter.FILTER_REJECT;" +
              "        var t = (node.textContent || '').trim();" +
              "        if (!t || t.indexOf(val) === -1) return NodeFilter.FILTER_REJECT;" +
              "        return NodeFilter.FILTER_ACCEPT;" +
              "      }" +
              "    });" +
              "    var node2;" +
              "    while ((node2 = walker2.nextNode()) && els.length < 10) { els.push(node2); }" +
              "  } else if (findBy === 'placeholder') {" +
              "    els = Array.from(document.querySelectorAll('input, textarea')).filter(function(el) {" +
              "      return el.placeholder && el.placeholder.indexOf(val) !== -1;" +
              "    });" +
              "  } else if (findBy === 'label') {" +
              "    els = Array.from(document.querySelectorAll('input, textarea, select, [role=\"combobox\"], [role=\"checkbox\"], [role=\"radio\"]')).filter(function(el) {" +
              "      var txt = '';" +
              "      if (el.id) { var lb = document.querySelector('label[for=\"' + CSS.escape(el.id) + '\"]'); if (lb) txt += ' ' + lb.textContent; }" +
              "      var wrap = el.closest('label,.el-form-item,.ant-form-item,.form-item,.field,.MuiFormControl-root,.v-input,.q-field');" +
              "      if (wrap) txt += ' ' + wrap.textContent;" +
              "      txt += ' ' + (el.getAttribute('aria-label') || el.name || el.placeholder || '');" +
              "      return txt.replace(/\\s+/g, ' ').trim().indexOf(val) !== -1;" +
              "    });" +
              "  } else if (findBy === 'selector') {" +
              "    els = Array.from(document.querySelectorAll(val));" +
              "  } else if (findBy === 'class') {" +
              "    els = Array.from(document.querySelectorAll('.' + val));" +
              "  } else if (findBy === 'attr') {" +
              "    var parts = val.split('=');" +
              "    var attrName = parts[0].trim();" +
              "    var attrVal = parts[1] ? parts[1].trim().replace(/^[\"']|[\"']$/g, '') : '';" +
              "    els = Array.from(document.querySelectorAll('[' + attrName + ']')).filter(function(el) {" +
              "      return !attrVal || el.getAttribute(attrName) === attrVal;" +
              "    });" +
              "  }" +
              "  els = els.filter(visible);" +
              "  els.sort(function(a,b){return interactiveScore(b)-interactiveScore(a);});" +
              "  var results = els.slice(0, 5).map(function(el) {" +
              "    var r = el.getBoundingClientRect();" +
              "    /* 保持浮层状态，不在此处滚动。 */" +
              "    var sel = buildSel(el);" +
              "    return {tag: el.tagName, id: el.id, class: (typeof el.className==='string'?el.className:'').substring(0,80)," +
              "      text: (el.textContent||'').substring(0,60).trim()," +
              "      x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)," +
              "      width: Math.round(r.width), height: Math.round(r.height)," +
              "      visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight," +
              "      selector: sel, score: interactiveScore(el)};" +
              "  });" +
              "  return JSON.stringify(results);" +
              "})()";
            var findResult = await deps.evalInPage(findCode);
            if (!findResult.ok) {
              result.ok = false;
              result.result = "查找失败: " + (findResult.error || "");
              break;
            }
            try {
              var foundEls = JSON.parse(findResult.result || "[]");
              if (foundEls.length === 0) {
                result.ok = false;
                result.result = "未找到匹配元素: findBy=" + findBy + ", value=" + findValue +
                  "\n建议：1) 检查当前 DOM 快照中的文本、label、placeholder 和 elementRef 2) 改用 text_contains 或 label 查找 3) 需要源码语义时用 read_source。";
              } else {
                foundEls.forEach(function(found) {
                  if (found.selector && state.observedSelectors.indexOf(found.selector) === -1) {
                    state.observedSelectors.push(found.selector);
                  }
                });
                var findParts = ["找到 " + foundEls.length + " 个匹配元素:"];
                for (var fi = 0; fi < foundEls.length; fi++) {
                  var fe = foundEls[fi];
                  findParts.push(
                    "[" + (fi+1) + "] <" + fe.tag +
                    (fe.class ? " class=\"" + fe.class + "\"" : "") +
                    (fe.id ? " id=\"" + fe.id + "\"" : "") + "> " + (fe.text || "(无文本)") +
                    "\n  坐标: (" + fe.x + ", " + fe.y + ") 尺寸: " + fe.width + "x" + fe.height +
                    (fe.visible ? " [可见]" : " [不可见]") +
                    "\n  selector: " + fe.selector +
                    "\n  → selector 稳定时用 click(selector)；不稳定或同类元素较多时用 smart_click(findBy=\"" + findBy + "\", value=\"" + findValue + "\")"
                  );
                }
                result.result = findParts.join("\n");
                result.ok = true;
                log("🔍 find_element: findBy=" + findBy + " value=" + findValue + " → 找到 " + foundEls.length + " 个");
              }
            } catch(e) {
              result.ok = false;
              result.result = "解析结果失败: " + (e.message || e);
            }
          } catch(e) {
            result.ok = false;
            result.result = "find_element 异常: " + (e.message || e);
          }
          break;

        // ===== 预设模板工具 =====
        // 所有模板统一委托给 AIFT_ActionTemplates.execute 处理
        case "select_option":
        case "select_multi":
        case "fill_input":
        case "fill_form":
        case "click_button":
        case "close_dialog":
        case "table_action":
        case "switch_tab":
        case "confirm_dialog":
        case "toggle_switch":
          if (!global.AIFT_ActionTemplates) {
            result.ok = false;
            result.result = "预设模板系统不可用（action-templates.js 未加载）";
            break;
          }
          if (!deps.evalInPage) {
            result.ok = false;
            result.result = "eval_in_page 不可用（需要 chrome.scripting 权限）";
            break;
          }
          var tplResult = await global.AIFT_ActionTemplates.execute(name, {
            tabId: deps.tabId,
            evalInPage: deps.evalInPage,
            sourceInteractions: state.activeSourceInteractions,
          }, args);
          result.ok = tplResult.ok;
          result.result = tplResult.result || (tplResult.ok ? "模板执行成功" : "模板执行失败");
          if (tplResult.pageState) result.pageState = tplResult.pageState;
          log("📋 模板 " + name + ": " + (tplResult.ok ? "成功" : "失败") + " - " + (tplResult.result || "").substring(0, 80));
          break;

        case "wait":
          var ms = args.ms || 1000;
          await new Promise(function (r) { setTimeout(r, ms); });
          break;

        case "read_source":
          var pattern = args.filePattern || "";
          var keywords = pattern.split(/[\s,\/]+/).filter(Boolean);
          var matched = global.AIFT_SourceReader.searchByKeywords(state.sourceFiles, keywords, 5);
          result.result = "找到 " + matched.length + " 个文件";
          if (matched.length > 0) {
            // 将匹配的源码加入下次 prompt 的源码列表
            for (var i = 0; i < matched.length; i++) {
              if (!state.sourceFiles[matched[i].path]) {
                state.sourceFiles[matched[i].path] = matched[i].content;
              }
            }
            result.sourceFiles = matched;
            // 提取结构化组件信息，附加到返回结果中
            if (global.AIFT_SourceAnalyzer) {
              var componentParts = [];
              for (var ci = 0; ci < matched.length; ci++) {
                var compInfo = global.AIFT_SourceAnalyzer.analyzeSource(matched[ci].path, matched[ci].content);
                if (compInfo) {
                  componentParts.push(global.AIFT_SourceAnalyzer.formatComponentInfo(compInfo));
                }
              }
              if (componentParts.length > 0) {
                result.componentInfo = componentParts.join("\n\n");
              }
            }
          }
          break;

        case "get_network_responses":
          if (!global.AIFT_NetworkRecorder) {
            result.ok = false;
            result.result = "网络录制器不可用";
            break;
          }
          var netResults = global.AIFT_NetworkRecorder.searchResponses({
            urlPattern: args.urlPattern || "",
            keyword: args.keyword || "",
            method: args.method || "",
            status: args.status,
            limit: 5,
          });
          result.result = "找到 " + netResults.length + " 条匹配的网络响应";
          if (netResults.length > 0) {
            var netParts = [];
            for (var ni = 0; ni < netResults.length; ni++) {
              var nr = netResults[ni];
              netParts.push("### [" + nr.id + "] " + nr.method + " " + nr.url + " → " + nr.status);
              if (nr.requestBody) {
                netParts.push("请求体: " + nr.requestBody);
              }
              netParts.push("响应体:");
              netParts.push(nr.responseBody || "（空）");
            }
            result.result = netParts.join("\n");
            result.networkResponses = netResults;
          } else {
            result.result = "未找到匹配的网络响应。可尝试不传参数获取所有已捕获的请求，或调整搜索条件。";
          }
          log("网络响应检索: " + netResults.length + " 条匹配");
          break;

        case "assert":
          var assertionDescription = String(args.description || "").trim();
          var outcomeInfo = global.AIFT_AgentGuard && global.AIFT_AgentGuard.resolveAssertionOutcome
            ? global.AIFT_AgentGuard.resolveAssertionOutcome(args, assertionDescription)
            : { outcome: args.passed ? "passed" : "failed", downgraded: false, reason: "" };
          var assertionOutcome = outcomeInfo.outcome;
          var assertionIcon = assertionOutcome === "passed" ? "✅" : (assertionOutcome === "failed" ? "❌" : "⚠️");
          if (assertionDescription.indexOf("✅") === -1 && assertionDescription.indexOf("❌") === -1 && assertionDescription.indexOf("⚠️") === -1) {
            var tcPrefix = assertionDescription.match(/^(TC\d+\s*:\s*)/i);
            assertionDescription = tcPrefix
              ? tcPrefix[1] + assertionIcon + " " + assertionDescription.substring(tcPrefix[1].length)
              : assertionIcon + " " + assertionDescription;
          }
          var assertionCheck = global.AIFT_AgentGuard && global.AIFT_AgentGuard.validateAssertionForCurrent
            ? global.AIFT_AgentGuard.validateAssertionForCurrent(assertionDescription, state.currentTcId)
            : { ok: false, error: "断言守卫不可用，无法安全提交断言。" };
          if (!assertionCheck.ok) {
            result.ok = false;
            result.result = assertionCheck.error;
            log("⚠️ 已拒绝断言: " + assertionCheck.error);
            state.loopWarning = assertionCheck.error + " 请只为当前正在执行的用例提交一次对应断言。";
            break;
          }
          var currentAssertionIdx = -1;
          for (var aci = 0; aci < state.testCases.length; aci++) {
            if ((state.testCases[aci].id || "").toUpperCase() === assertionCheck.testCaseId && state.testCases[aci].status === "testing") {
              currentAssertionIdx = aci;
              break;
            }
          }
          if (currentAssertionIdx < 0) {
            result.ok = false;
            result.result = "当前用例 " + assertionCheck.testCaseId + " 未处于 testing 状态，断言未写入。";
            log("⚠️ 已拒绝断言: " + result.result);
            break;
          }
          var assertion = {
            description: assertionDescription,
            passed: assertionOutcome === "passed",
            outcome: assertionOutcome,
          };
          state.assertions.push(assertion);
          result.result = assertionOutcome === "passed" ? "✅ PASS" : (assertionOutcome === "failed" ? "❌ FAIL" : "⚠️ INCONCLUSIVE");
          if (outcomeInfo.downgraded) result.result += "（已根据证据完整性自动降级：" + outcomeInfo.reason + "）";
          log("断言: " + assertion.description + " → " + result.result);
          var assertionAccepted = true;
          if (deps.onAssertion) {
            // 断言只会归属当前执行中的用例，绝不按模型描述重新匹配。
            var matchedIdx = currentAssertionIdx;
            if (matchedIdx >= 0) {
              var matchedTC = state.testCases[matchedIdx];
              // 保存原始状态，以便断言异常时回退
              var previousStatus = matchedTC.status;
              matchedTC.status = assertionOutcome;
              matchedTC.assertionDesc = assertion.description;

              // ===== 断言内容相关性检查 =====
              var assertDescLower = (assertion.description || "").toLowerCase();
              var tcTitleLower = (matchedTC.title || "").toLowerCase();
              var tcExpectedLower = (matchedTC.expected || "").toLowerCase();
              var tcStepsLower = (matchedTC.steps || "").toLowerCase();

              // 检查1: TC编号不匹配
              var assertTcMatch = (assertion.description || "").match(/TC(\d+)/i);
              var matchedTcIdLower = (matchedTC.id || "").toLowerCase();
              var tcMismatch = false;
              if (assertTcMatch) {
                var assertTcId = "tc" + assertTcMatch[1];
                if (assertTcId.toLowerCase() !== matchedTcIdLower) {
                  tcMismatch = true;
                }
              }

              // 检查2: 断言内容与用例预期不相关
              // 提取用例关键词（中文用 bigram 分词，英文按词分割）
              var tcFullText = tcTitleLower + " " + tcExpectedLower + " " + tcStepsLower;
              var tcKeywords = extractTcKeywords(tcFullText);
              var hasRelevantKeyword = false;
              var matchedKeywordCount = 0;
              for (var ki = 0; ki < tcKeywords.length; ki++) {
                if (assertDescLower.indexOf(tcKeywords[ki]) !== -1) {
                  matchedKeywordCount++;
                  if (matchedKeywordCount >= 2) { hasRelevantKeyword = true; break; }
                }
              }
              // 如果关键词总数很少（≤3），匹配1个即可算相关
              if (!hasRelevantKeyword && tcKeywords.length <= 3 && matchedKeywordCount >= 1) {
                hasRelevantKeyword = true;
              }

              if (tcMismatch || (!hasRelevantKeyword && tcKeywords.length > 2)) {
                var warnParts = ["⚠️ 断言内容异常！"];
                if (tcMismatch) {
                  warnParts.push("断言中的 TC 编号(" + (assertTcMatch ? ("TC" + assertTcMatch[1]) : "未知") +
                    ")与当前用例(" + matchedTC.id + ")不匹配！");
                }
                if (!hasRelevantKeyword) {
                  warnParts.push("断言内容与当前用例的测试目标不相关，疑似复制了其他用例的断言！");
                }
                warnParts.push("");
                warnParts.push("当前用例信息：");
                warnParts.push("  - 编号: " + matchedTC.id);
                warnParts.push("  - 标题: " + (matchedTC.title || "（无）"));
                warnParts.push("  - 预期结果: " + (matchedTC.expected || "（未提供）"));
                warnParts.push("  - 操作步骤: " + (matchedTC.steps || "（未提供）").substring(0, 200));
                warnParts.push("");
                warnParts.push("断言应验证：" + (matchedTC.expected || matchedTC.title || "当前用例的操作和预期结果"));
                warnParts.push("请确保断言内容针对当前用例的实际测试目标，不要复制其他用例的断言。");

                result.result += "\n\n" + warnParts.join("\n");
                log("⚠️ 断言内容异常: TC编号不匹配=" + tcMismatch + ", 内容不相关=" + !hasRelevantKeyword);

                // 关键修复：断言异常时回退用例状态，不提交 passed/failed
                // 保持原状态（testing 或 pending），让 AI 可以重新断言
                matchedTC.status = previousStatus;
                matchedTC.assertionDesc = null;
                assertionAccepted = false;
                state.assertions.pop();
                result.ok = false;
                result.result = "断言未写入。\n\n" + warnParts.join("\n");
                log("🔄 断言异常，已回退 " + matchedTC.id + " 状态为 " + previousStatus);

                // 注入下一轮警告
                state.loopWarning = warnParts.join("\n") +
                  "\n\n请重新审视当前用例的测试结果，确保断言内容正确。";
              } else if ((matchedTC.id || "").toUpperCase() === (state.currentTcId || "").toUpperCase()) {
                // 已接受的断言必须立即结束当前用例的轮次归属，避免后续 TC 的操作或
                // 收尾检查继续计入已完成用例。
                state.currentTcId = null;
              }
            }
          }
          if (assertionAccepted && deps.onAssertion) deps.onAssertion(assertion, state.assertions, state.testCases);
          if (assertionAccepted && assertionOutcome === "failed") {
            recordError("failed_assertion", {
              description: assertion.description,
              action: "assert",
              args: { passed: false },
            });
          } else if (assertionAccepted && assertionOutcome === "inconclusive") {
            recordError("inconclusive_assertion", {
              description: assertion.description,
              action: "assert",
              args: { outcome: "inconclusive" },
              message: outcomeInfo.reason || "至少一项预期未被直接验证",
            });
          }
          // 用例断言完成后，生成上下文摘要并缓存
          if (assertionAccepted && global.AIFT_SummaryCache && matchedIdx >= 0) {
            try {
              var summarySnapshot = state.snapshot;
              var summaryParts = [];
              summaryParts.push("已完成的用例：" + (matchedTC.id || "") + " - " + (matchedTC.title || ""));
              summaryParts.push("断言结果：" + assertionOutcome.toUpperCase() + " - " + (assertion.description || "").substring(0, 200));
              if (summarySnapshot) {
                summaryParts.push("当前页面 URL：" + (summarySnapshot.url || ""));
                summaryParts.push("当前页面标题：" + (summarySnapshot.title || ""));
              }
              // 记录已完成的用例列表
              var completedTCs = [];
              for (var cti = 0; cti < state.testCases.length; cti++) {
                var tc = state.testCases[cti];
                if (tc.status === "passed" || tc.status === "failed" || tc.status === "inconclusive") {
                  completedTCs.push(tc.id + "(" + tc.status + ")");
                }
              }
              if (completedTCs.length > 0) {
                summaryParts.push("已完成用例列表：" + completedTCs.join(", "));
              }
              // 记录当前页面状态（弹窗、下拉框等）
              if (summarySnapshot && summarySnapshot.nodes) {
                var stateNotes = [];
                for (var sni = 0; sni < Math.min(summarySnapshot.nodes.length, 30); sni++) {
                  var sn = summarySnapshot.nodes[sni];
                  var cls = (sn.className || "").toLowerCase();
                  if (/dialog|modal|drawer|dropdown|message|loading/.test(cls)) {
                    stateNotes.push("<" + sn.tag + ' class="' + sn.className + '"> ' + (sn.text || "").substring(0, 40));
                  }
                }
                if (stateNotes.length > 0) {
                  summaryParts.push("当前页面状态元素：" + stateNotes.join("; "));
                }
              }
              var summaryText = summaryParts.join("\n");
              await global.AIFT_SummaryCache.write(summaryText);
              log("📝 上下文摘要已缓存");
            } catch (e) {
              log("📝 摘要生成失败: " + (e.message || e));
            }
          }
          break;

        case "finish":
          // finish 只中止当前对话轮次，不终止整个测试流程
          // 暂停等待用户输入，用户可输入消息继续执行或点击中止结束测试
          state.turnPaused = true;
          state.paused = true;
          state.finishResult = args.result || "unknown";
          state.finishSummary = args.summary || "";
          // 清空摘要缓存
          if (global.AIFT_SummaryCache) {
            global.AIFT_SummaryCache.clear();
          }
          result.result = "已暂停对话。测试未终止，等待用户输入指令继续执行。";
          break;

        case "screenshot":
          // 截取标注截图：每个可交互元素画上编号框，AI 通过编号直接操作
          if (!deps.config.visionSupported) {
            result.ok = false;
            result.result = "当前模型不支持图片，视觉测试未启用。请使用 click/type/eval_in_page 等 DOM 操作工具。";
            break;
          }
          if (!global.AIFT_VisualController) {
            result.ok = false;
            result.result = "视觉控制器不可用（需要 chrome.debugger 权限）";
            break;
          }
          try {
            await global.AIFT_VisualController.ensureAttached(deps.tabId);
            var screenshotData = await global.AIFT_VisualController.captureAnnotatedForAI(deps.evalInPage, {
              clip: args.clip || null,
            });
            // 存储标注元素列表，供 smart_click(label) 查找坐标（降级方案）
            state.annotatedElements = screenshotData.elements || [];
            result.result = "标注截图成功（" + screenshotData.width + "x" + screenshotData.height + "），" +
              "共标注 " + state.annotatedElements.length + " 个可交互元素。" +
              "优先使用预设模板或 click(selector) 操作。如需验证页面展示效果请使用 verify_ui。";
            result.screenshot = screenshotData;
            log("📸 标注截图: " + screenshotData.width + "x" + screenshotData.height + ", " + state.annotatedElements.length + " 个元素");
            // 通知面板展示截图
            if (deps.onStream) deps.onStream("screenshot", JSON.stringify({
              dataUrl: screenshotData.dataUrl,
              width: screenshotData.width,
              height: screenshotData.height,
              elements: state.annotatedElements.length,
              round: state.round,
              source: "manual",
            }));
          } catch (e) {
            result.ok = false;
            result.result = "截图失败: " + (e.message || e);
            log("📸 截图失败: " + (e.message || e));
          }
          break;

        case "verify_ui":
          // UI 视觉验证：截图并发送给 AI，AI 检查页面展示是否正确
          // 与 screenshot 不同：verify_ui 专注于"验证"而非"操作"
          // 截图不带标注（避免干扰视觉判断），AI 需要检查 CSS、布局、数据展示
          if (!deps.config.visionSupported) {
            result.ok = false;
            result.result = "当前模型不支持图片，无法进行 UI 视觉验证。请使用 eval_in_page 检查元素状态和样式。";
            break;
          }
          if (!global.AIFT_VisualController) {
            result.ok = false;
            result.result = "视觉控制器不可用（需要 chrome.debugger 权限）";
            break;
          }
          try {
            await global.AIFT_VisualController.ensureAttached(deps.tabId);
            // 截取无标注截图（纯净页面，便于 AI 检查 CSS/布局）
            var verifyScreenshot = await global.AIFT_VisualController.captureForAI({
              clip: args.clip || null,
            });
            result.result = "UI 验证截图已捕获（" + verifyScreenshot.width + "x" + verifyScreenshot.height + "）。" +
              "请仔细检查截图中的页面展示：\n" +
              "1. 布局是否正常（无错位、重叠、溢出）\n" +
              "2. CSS 样式是否正确（颜色、字体、间距、对齐）\n" +
              "3. 数据是否正确展示（文本内容、数值、列表条数）\n" +
              "4. 交互状态是否正确（选中、禁用、加载中等）\n" +
              "5. 是否有明显的 UI 缺陷（空白区域、错位元素、样式丢失）";
            result.screenshot = verifyScreenshot;
            result.isVisionVerify = true; // 标记为视觉验证截图
            log("🔍 UI 验证截图: " + verifyScreenshot.width + "x" + verifyScreenshot.height);
            // 通知面板展示截图
            if (deps.onStream) deps.onStream("screenshot", JSON.stringify({
              dataUrl: verifyScreenshot.dataUrl,
              width: verifyScreenshot.width,
              height: verifyScreenshot.height,
              elements: 0,
              round: state.round,
              source: "verify_ui",
            }));
          } catch (e) {
            result.ok = false;
            result.result = "UI 验证截图失败: " + (e.message || e);
            log("🔍 UI 验证截图失败: " + (e.message || e));
          }
          break;

        case "visual_click":
          // 通过 CDP 在指定坐标点击
          if (!deps.config.visionSupported) {
            result.ok = false;
            result.result = "视觉测试未启用（模型不支持图片）";
            break;
          }
          if (!global.AIFT_VisualController) {
            result.ok = false;
            result.result = "视觉控制器不可用";
            break;
          }
          try {
            await global.AIFT_VisualController.ensureAttached(deps.tabId);
            await global.AIFT_VisualController.mouseClick(args.x, args.y, {
              button: args.button || "left",
              clickCount: args.clickCount || 1,
            });
            result.result = "视觉点击成功: (" + args.x + ", " + args.y + ")";
            log("🖱️ 视觉点击: (" + args.x + ", " + args.y + ") " + (args.button || "left"));

            // ===== 关键改进：检查实际点击到的元素 =====
            if (deps.evalInPage) {
              try {
                var elemInfo = await deps.evalInPage(
                  "(function() { var el = document.elementFromPoint(" + args.x + ", " + args.y + "); " +
                  "if (!el) return JSON.stringify({tag:'none'}); " +
                  "var r = el.getBoundingClientRect(); " +
                  "var sel = ''; " +
                  "if (el.id) sel = '#' + el.id; " +
                  "else if (el.className && typeof el.className === 'string') { var c = el.className.trim().split(/\\s+/); if (c.length) sel = '.' + c[0]; } " +
                  "if (!sel) sel = el.tagName.toLowerCase(); " +
                  "return JSON.stringify({tag:el.tagName, class:(typeof el.className==='string'?el.className:'').substring(0,80), id:el.id, " +
                  "text:(el.textContent||'').substring(0,60).trim(), " +
                  "rect:{x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height)}, " +
                  "selector:sel}); })()"
                );
                if (elemInfo.ok && elemInfo.result) {
                  try {
                    var ei = JSON.parse(elemInfo.result);
                    result.result += "\n[实际点击元素] <" + ei.tag +
                      (ei.class ? " class=\"" + ei.class + "\"" : "") +
                      (ei.id ? " id=\"" + ei.id + "\"" : "") +
                      "> " + (ei.text || "(无文本)");
                    if (ei.selector && ei.selector !== "none") {
                      result.result += "\n[建议selector] " + ei.selector;
                    }
                    // 如果点到的元素不是预期的可交互元素，给出警告
                    var tagLower = (ei.tag || "").toLowerCase();
                    if (tagLower === "div" && !ei.class && !ei.id) {
                      result.result += "\n⚠️ 点击到了无标识的 div，可能不是目标元素！建议改用 click(selector) 精确定位。";
                    }
                  } catch(e) {}
                }
              } catch(e) {}
            }

            // ===== 关键改进：同一区域反复点击检测（跨工具持久化，不清空记录） =====
            state.visualClickAttempts.push({x: args.x, y: args.y, round: state.round, elementText: (ei ? (ei.text || "").trim() : ""), elementTag: (ei ? ei.tag : "")});
            var nearbyClicks = state.visualClickAttempts.filter(function(a) {
              return Math.abs(a.x - args.x) < 60 && Math.abs(a.y - args.y) < 60;
            });
            // 如果两次点击命中的是不同的下拉选项（文本不同），说明是在选择不同选项，不应触发重复点击警告
            var isSelectingDifferentOptions = nearbyClicks.length >= 2 && nearbyClicks.every(function(a) {
              return a.elementText && a.elementText !== nearbyClicks[0].elementText;
            }) && nearbyClicks.every(function(a) {
              var tag = (a.elementTag || "").toLowerCase();
              return tag === "li" || (a.elementText && a.elementText.length > 0);
            });
            if (nearbyClicks.length >= 2 && !isSelectingDifferentOptions) {
              result.result += "\n🚨 已在此区域(±60px)点击 " + nearbyClicks.length + " 次仍未达到预期效果！" +
                "请立即切换策略：\n" +
                "1. 使用 select_option 模板（自动定位 el-select 下拉框和选项）\n" +
                "2. 使用 find_element(findBy='class', value='el-select-dropdown__item') 精确定位下拉选项\n" +
                "3. 使用 eval_in_page 查找正确的 CSS 选择器\n" +
                "4. 不要继续使用 visual_click 点击此区域！";
              // 不再清空记录，保持累计计数
              // 如果达到 3 次，强制注入 loopWarning
              if (nearbyClicks.length >= 3) {
                state.loopWarning = "🚨 同一区域已点击 " + nearbyClicks.length + " 次仍未成功！" +
                  "必须立即停止点击此区域。请选择以下策略之一：\n" +
                  "1. 调用 select_option 模板（推荐，自动处理下拉框选择）\n" +
                  "2. 调用 eval_in_page 执行 JS 查找下拉选项的精确坐标\n" +
                  "3. 基于当前可见信息直接 assert(outcome='failed') 标记失败\n" +
                  "4. 如果所有用例已处理则调用 finish\n" +
                  "严禁继续使用 visual_click 点击此区域！";
              }
            }

            // ===== 关键改进：下拉选项点击验证 =====
            // 如果当前有下拉框展开，检查点击到的元素是否是下拉选项
            if (deps.evalInPage && ei) {
              try {
                var dropdownCheck = await deps.evalInPage(
                  "(function() {" +
                  "  var dropdown = document.querySelector('.el-select-dropdown:not(.hidden):not([style*=\"display: none\"]), .el-select__popper:not([style*=\"display: none\"]), .el-popper:not([style*=\"display: none\"]), .ant-select-dropdown:not(.hidden):not([style*=\"display: none\"])');" +
                  "  if (!dropdown) return JSON.stringify({hasDropdown: false});" +
                  "  var items = dropdown.querySelectorAll('.el-select-dropdown__item, .ant-select-item');" +
                  "  var itemList = [];" +
                  "  for (var i = 0; i < items.length; i++) {" +
                  "    var r = items[i].getBoundingClientRect();" +
                  "    var vis = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;" +
                  "    if (!vis) continue;" +
                  "    itemList.push({text: items[i].textContent.trim().substring(0, 30), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});" +
                  "  }" +
                  "  return JSON.stringify({hasDropdown: true, items: itemList});" +
                  "})()"
                );
                if (dropdownCheck.ok && dropdownCheck.result) {
                  try {
                    var dd = JSON.parse(dropdownCheck.result);
                    if (dd.hasDropdown && dd.items && dd.items.length > 0) {
                      // 检查点击的元素是否是下拉选项
                      var clickedText = (ei.text || "").trim();
                      var isDropdownItem = dd.items.some(function(item) {
                        return item.text === clickedText ||
                               (item.x > args.x - 30 && item.x < args.x + 30 &&
                                item.y > args.y - 30 && item.y < args.y + 30);
                      });
                      if (!isDropdownItem) {
                        // 点击的不是下拉选项，列出所有可用选项的精确坐标
                        var itemLines = dd.items.map(function(item) {
                          return "  - \"" + item.text + "\" 在 (" + item.x + ", " + item.y + ")";
                        });
                        result.result += "\n⚠️ 下拉框已展开，但点击到的不是下拉选项！" +
                          "\n可用选项（精确坐标）：\n" + itemLines.join("\n") +
                          "\n建议使用 select_option 模板（DOM 只定位，CDP 真实点击选项）。";
                      }
                    }
                  } catch(e) {}
                }
              } catch(e) {}
            }
          } catch (e) {
            result.ok = false;
            result.result = "视觉点击失败: " + (e.message || e);
          }
          break;

        case "visual_type":
          // 通过 CDP 在指定坐标点击并输入文本
          if (!deps.config.visionSupported) {
            result.ok = false;
            result.result = "视觉测试未启用（模型不支持图片）";
            break;
          }
          if (!global.AIFT_VisualController) {
            result.ok = false;
            result.result = "视觉控制器不可用";
            break;
          }
          try {
            await global.AIFT_VisualController.ensureAttached(deps.tabId);
            await global.AIFT_VisualController.clickAndType(args.x, args.y, args.text || "", deps.evalInPage);
            result.result = "视觉输入成功: (" + args.x + ", " + args.y + ") → \"" + (args.text || "").substring(0, 30) + "\"";
            log("⌨️ 视觉输入: (" + args.x + ", " + args.y + ") → " + (args.text || "").substring(0, 30));
          } catch (e) {
            result.ok = false;
            result.result = "视觉输入失败: " + (e.message || e);
          }
          break;

        case "visual_scroll":
          // 通过 CDP 在指定位置滚动
          if (!deps.config.visionSupported) {
            result.ok = false;
            result.result = "视觉测试未启用（模型不支持图片）";
            break;
          }
          if (!global.AIFT_VisualController) {
            result.ok = false;
            result.result = "视觉控制器不可用";
            break;
          }
          try {
            await global.AIFT_VisualController.ensureAttached(deps.tabId);
            await global.AIFT_VisualController.mouseScroll(args.x, args.y, args.deltaX || 0, args.deltaY !== undefined ? args.deltaY : 300);
            result.result = "视觉滚动成功: (" + args.x + ", " + args.y + ") deltaY=" + (args.deltaY !== undefined ? args.deltaY : 300);
            log("🖱️ 视觉滚动: (" + args.x + ", " + args.y + ") deltaY=" + (args.deltaY !== undefined ? args.deltaY : 300));
          } catch (e) {
            result.ok = false;
            result.result = "视觉滚动失败: " + (e.message || e);
          }
          break;

        case "visual_drag":
          // 通过 CDP 拖拽
          if (!deps.config.visionSupported) {
            result.ok = false;
            result.result = "视觉测试未启用（模型不支持图片）";
            break;
          }
          if (!global.AIFT_VisualController) {
            result.ok = false;
            result.result = "视觉控制器不可用";
            break;
          }
          try {
            await global.AIFT_VisualController.ensureAttached(deps.tabId);
            await global.AIFT_VisualController.mouseDrag(args.fromX, args.fromY, args.toX, args.toY);
            result.result = "视觉拖拽成功: (" + args.fromX + "," + args.fromY + ") → (" + args.toX + "," + args.toY + ")";
            log("🖱️ 视觉拖拽: (" + args.fromX + "," + args.fromY + ") → (" + args.toX + "," + args.toY + ")");
          } catch (e) {
            result.ok = false;
            result.result = "视觉拖拽失败: " + (e.message || e);
          }
          break;

        case "visual_press":
          // 通过 CDP 按键
          if (!deps.config.visionSupported) {
            result.ok = false;
            result.result = "视觉测试未启用（模型不支持图片）";
            break;
          }
          if (!global.AIFT_VisualController) {
            result.ok = false;
            result.result = "视觉控制器不可用";
            break;
          }
          try {
            await global.AIFT_VisualController.ensureAttached(deps.tabId);
            if (args.combo && Array.isArray(args.combo) && args.combo.length > 0) {
              await global.AIFT_VisualController.keyboardCombo(args.combo);
              result.result = "组合键成功: " + args.combo.join("+");
              log("⌨️ 视觉组合键: " + args.combo.join("+"));
            } else {
              if (String(args.key || "").toLowerCase() === "escape" && deps.evalInPage) {
                var visualDismissRet = await global.AIFT_VisualController.dismissFloatingLayer(deps.evalInPage);
                if (visualDismissRet.ok) {
                  result.result = "已安全关闭浮层（未发送 Escape）";
                  break;
                }
                if (visualDismissRet.hasFloating || visualDismissRet.hasDialog) {
                  result.ok = false;
                  result.result = visualDismissRet.error || "弹框或浮层仍打开，已阻止 Escape 关闭父弹框";
                  break;
                }
              }
              await global.AIFT_VisualController.keyboardPress(args.key);
              result.result = "按键成功: " + args.key;
              log("⌨️ 视觉按键: " + args.key);
            }
          } catch (e) {
            result.ok = false;
            result.result = "视觉按键失败: " + (e.message || e);
          }
          break;

        case "smart_click": {
          // 智能点击：通过标注编号或 findBy 精确定位元素后 CDP 点击
          // 彻底消除 AI 从截图目测坐标的偏差
          if (!global.AIFT_VisualController) {
            result.ok = false;
            result.result = "CDP 视觉控制器不可用";
            break;
          }
          await global.AIFT_VisualController.ensureAttached(deps.tabId);
          var smartX, smartY, smartInfo = "";
          if (args.label !== undefined && args.label !== null) {
            // 通过标注编号查找元素
            var annoEl = null;
            for (var ai = 0; ai < state.annotatedElements.length; ai++) {
              if (state.annotatedElements[ai].label === args.label) { annoEl = state.annotatedElements[ai]; break; }
            }
            if (!annoEl) {
              result.ok = false;
              result.result = "标注编号 #" + args.label + " 不存在。请检查截图中的编号，或重新 screenshot 获取标注截图。";
              break;
            }
            smartX = annoEl.x; smartY = annoEl.y;
            smartInfo = "标注#" + args.label + " <" + annoEl.tag + "> " + (annoEl.text || annoEl.placeholder || "");
          } else if (args.findBy && args.value !== undefined) {
            // 通过 findBy 精确定位（内部执行 find_element 逻辑）
            if (!deps.evalInPage) {
              result.ok = false;
              result.result = "eval_in_page 不可用";
              break;
            }
            var sfFindBy = args.findBy;
            if (sfFindBy === 'css') sfFindBy = 'selector';
            var sfCode = "(function() {" +
              "  var findBy = " + JSON.stringify(sfFindBy) + ";" +
              "  var val = " + JSON.stringify(args.value) + ";" +
              "  var els = [];" +
              "  if (findBy === 'text') {" +
              "    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {" +
              "      acceptNode: function(node) {" +
              "        if (node.children.length > 2) return NodeFilter.FILTER_REJECT;" +
              "        var t = (node.textContent || '').trim();" +
              "        if (!t || t.length > 80 || t.indexOf(val) === -1) return NodeFilter.FILTER_REJECT;" +
              "        return NodeFilter.FILTER_ACCEPT;" +
              "      }" +
              "    });" +
              "    var node; while ((node = walker.nextNode()) && els.length < 10) { els.push(node); }" +
              "  } else if (findBy === 'text_contains') {" +
              "    var walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {" +
              "      acceptNode: function(node) {" +
              "        if (node.children.length > 5) return NodeFilter.FILTER_REJECT;" +
              "        var t = (node.textContent || '').trim();" +
              "        if (!t || t.indexOf(val) === -1) return NodeFilter.FILTER_REJECT;" +
              "        return NodeFilter.FILTER_ACCEPT;" +
              "      }" +
              "    });" +
              "    var node2; while ((node2 = walker2.nextNode()) && els.length < 10) { els.push(node2); }" +
              "  } else if (findBy === 'placeholder') {" +
              "    els = Array.from(document.querySelectorAll('input, textarea')).filter(function(el) {" +
              "      return el.placeholder && el.placeholder.indexOf(val) !== -1;" +
              "    });" +
              "  } else if (findBy === 'selector') {" +
              "    els = Array.from(document.querySelectorAll(val));" +
              "  } else if (findBy === 'class') {" +
              "    els = Array.from(document.querySelectorAll('.' + val));" +
              "  } else if (findBy === 'attr') {" +
              "    var parts = val.split('=');" +
              "    var attrName = parts[0].trim();" +
              "    var attrVal = parts[1] ? parts[1].trim().replace(/^[\"']|[\"']$/g, '') : '';" +
              "    els = Array.from(document.querySelectorAll('[' + attrName + ']')).filter(function(el) {" +
              "      return !attrVal || el.getAttribute(attrName) === attrVal;" +
              "    });" +
              "  }" +
              "  var visible = els.filter(function(el) {" +
              "    var st = getComputedStyle(el);" +
              "    if (st.display === 'none' || st.visibility === 'hidden') return false;" +
              "    var r = el.getBoundingClientRect();" +
              "    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;" +
              "  });" +
              "  if (visible.length === 0) return JSON.stringify({found: false});" +
              // 关键修复：当页面上有下拉框展开时，优先选择下拉框内的选项元素。
              // 之前 visible[0] 返回第一个匹配元素，可能是表格单元格中的文本，
              // 而不是下拉框选项。例如搜索"操作人"时，表格中也有"操作人"文本，
              // 导致点击了表格单元格而非下拉选项。
              "  function isInDropdown(el) {" +
              "    var p = el.parentElement;" +
              "    for (var i = 0; i < 10 && p; i++) {" +
              "      var pc = (typeof p.className === 'string') ? p.className : '';" +
              "      if (pc.indexOf('dropdown') !== -1 || pc.indexOf('popper') !== -1 || pc.indexOf('select') !== -1 || p.getAttribute('role') === 'listbox' || p.getAttribute('role') === 'option') return true;" +
              "      p = p.parentElement;" +
              "    }" +
              "    return false;" +
              "  }" +
              "  var dropdownEls = visible.filter(function(el) { return isInDropdown(el); });" +
              "  var el = dropdownEls.length > 0 ? dropdownEls[0] : visible[0];" +
              "  var r = el.getBoundingClientRect();" +
              "  var inView=r.width>0&&r.height>0&&r.x+r.width/2>=0&&r.x+r.width/2<=window.innerWidth&&r.y+r.height/2>=0&&r.y+r.height/2<=window.innerHeight;" +
              "  if(!inView){el.scrollIntoView({behavior:'instant',block:'center'});r=el.getBoundingClientRect();}" +
              "  return JSON.stringify({found: true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)," +
              "    tag: el.tagName.toLowerCase(), text: (el.textContent||'').substring(0,40).trim()," +
              "    selector: el.id ? '#'+el.id : (el.className && typeof el.className==='string' ? el.tagName.toLowerCase()+'.'+el.className.trim().split(/\\s+/)[0] : el.tagName.toLowerCase())});" +
              "})()";
            var sfResult = await deps.evalInPage(sfCode);
            if (!sfResult || !sfResult.ok) {
              result.ok = false;
              result.result = "查找元素失败: " + ((sfResult && sfResult.error) || "执行失败");
              break;
            }
            try {
              var sfParsed = JSON.parse(sfResult.result || "{}");
              if (!sfParsed.found) {
                result.ok = false;
                result.result = "未找到匹配元素: findBy=" + args.findBy + ", value=" + args.value;
                break;
              }
              smartX = sfParsed.x; smartY = sfParsed.y;
              smartInfo = "findBy=" + args.findBy + " <" + sfParsed.tag + "> " + (sfParsed.text || "");
            } catch(e) {
              result.ok = false;
              result.result = "解析查找结果失败: " + (e.message || e);
              break;
            }
          } else {
            result.ok = false;
            result.result = "需要提供 label（标注编号）或 findBy+value 参数";
            break;
          }
          try {
            var smartInteraction = await interactionAtPoint(smartX, smartY);
            var smartRet = await global.AIFT_VisualController.clickAtPoint(deps.evalInPage, smartX, smartY, smartInteraction || undefined);
            if (!smartRet.ok) {
              result.ok = false;
              result.result = smartRet.error || "智能点击未确认生效";
              break;
            }
            result.result = "智能点击已验证" + (smartRet.retriedChild ? "（子控件重试）" : "") + ": (" + smartX + ", " + smartY + ") " + smartInfo;
            log("🎯 smart_click: (" + smartX + ", " + smartY + ") " + smartInfo);
          } catch(e) {
            result.ok = false;
            result.result = "智能点击失败: " + (e.message || e);
          }
          break;
        }

        case "smart_type": {
          // 智能输入：通过标注编号或 findBy 精确定位输入框，CDP 点击+输入
          if (!global.AIFT_VisualController) {
            result.ok = false;
            result.result = "CDP 视觉控制器不可用";
            break;
          }
          await global.AIFT_VisualController.ensureAttached(deps.tabId);
          var stX, stY, stInfo = "";
          if (args.label !== undefined && args.label !== null) {
            var stAnnoEl = null;
            for (var sai = 0; sai < state.annotatedElements.length; sai++) {
              if (state.annotatedElements[sai].label === args.label) { stAnnoEl = state.annotatedElements[sai]; break; }
            }
            if (!stAnnoEl) {
              result.ok = false;
              result.result = "标注编号 #" + args.label + " 不存在";
              break;
            }
            stX = stAnnoEl.x; stY = stAnnoEl.y;
            stInfo = "标注#" + args.label + " <" + stAnnoEl.tag + "> " + (stAnnoEl.placeholder || stAnnoEl.text || "");
          } else if (args.findBy && args.value !== undefined) {
            if (!deps.evalInPage) {
              result.ok = false;
              result.result = "eval_in_page 不可用";
              break;
            }
            // 复用 smart_click 的查找逻辑
            var stFindBy = args.findBy;
            if (stFindBy === 'css') stFindBy = 'selector';
            var stCode = "(function() {" +
              "  var findBy = " + JSON.stringify(stFindBy) + ";" +
              "  var val = " + JSON.stringify(args.value) + ";" +
              "  var els = [];" +
              "  if (findBy === 'text') {" +
              "    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {" +
              "      acceptNode: function(node) {" +
              "        if (node.children.length > 2) return NodeFilter.FILTER_REJECT;" +
              "        var t = (node.textContent || '').trim();" +
              "        if (!t || t.length > 80 || t.indexOf(val) === -1) return NodeFilter.FILTER_REJECT;" +
              "        return NodeFilter.FILTER_ACCEPT;" +
              "      }" +
              "    });" +
              "    var node; while ((node = walker.nextNode()) && els.length < 10) { els.push(node); }" +
              "  } else if (findBy === 'text_contains') {" +
              "    var walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {" +
              "      acceptNode: function(node) {" +
              "        if (node.children.length > 5) return NodeFilter.FILTER_REJECT;" +
              "        var t = (node.textContent || '').trim();" +
              "        if (!t || t.indexOf(val) === -1) return NodeFilter.FILTER_REJECT;" +
              "        return NodeFilter.FILTER_ACCEPT;" +
              "      }" +
              "    });" +
              "    var node2; while ((node2 = walker2.nextNode()) && els.length < 10) { els.push(node2); }" +
              "  } else if (findBy === 'placeholder') { els = Array.from(document.querySelectorAll('input, textarea')).filter(function(el) { return el.placeholder && el.placeholder.indexOf(val) !== -1; }); }" +
              "  else if (findBy === 'selector') { els = Array.from(document.querySelectorAll(val)); }" +
              "  else if (findBy === 'class') { els = Array.from(document.querySelectorAll('.' + val)); }" +
              "  else if (findBy === 'attr') { var p = val.split('='); var an = p[0].trim(); var av = p[1] ? p[1].trim().replace(/^[\"']|[\"']$/g, '') : ''; els = Array.from(document.querySelectorAll('[' + an + ']')).filter(function(el) { return !av || el.getAttribute(an) === av; }); }" +
              "  var vis = els.filter(function(el) { var st = getComputedStyle(el); if (st.display === 'none' || st.visibility === 'hidden') return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight; });" +
              "  if (vis.length === 0) return JSON.stringify({found: false});" +
              "  var el = vis[0]; el.scrollIntoView({ behavior: 'instant', block: 'center' }); var r = el.getBoundingClientRect();" +
              "  return JSON.stringify({found: true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), tag: el.tagName.toLowerCase(), text: (el.textContent||'').substring(0,40).trim()});" +
              "})()";
            var stFindResult = await deps.evalInPage(stCode);
            if (!stFindResult || !stFindResult.ok) {
              result.ok = false;
              result.result = "查找元素失败: " + ((stFindResult && stFindResult.error) || "执行失败");
              break;
            }
            try {
              var stParsed = JSON.parse(stFindResult.result || "{}");
              if (!stParsed.found) {
                result.ok = false;
                result.result = "未找到匹配元素: findBy=" + args.findBy + ", value=" + args.value;
                break;
              }
              stX = stParsed.x; stY = stParsed.y;
              stInfo = "findBy=" + args.findBy + " <" + stParsed.tag + ">";
            } catch(e) {
              result.ok = false;
              result.result = "解析查找结果失败: " + (e.message || e);
              break;
            }
          } else {
            result.ok = false;
            result.result = "需要提供 label（标注编号）或 findBy+value 参数";
            break;
          }
          try {
            await global.AIFT_VisualController.clickAndType(stX, stY, args.text || "", deps.evalInPage);
            result.result = "智能输入成功: (" + stX + ", " + stY + ") → \"" + (args.text || "").substring(0, 30) + "\" " + stInfo;
            log("⌨️ smart_type: (" + stX + ", " + stY + ") → " + (args.text || "").substring(0, 30) + " " + stInfo);
          } catch(e) {
            result.ok = false;
            result.result = "智能输入失败: " + (e.message || e);
          }
          break;
        }

        default:
          result.ok = false;
          result.result = "未知动作: " + name;
      }

      // 动作后等待（按动作类型区分等待时间）
      var waitMs = ACTION_WAIT_MAP[name];
      if (waitMs !== undefined) {
        await new Promise(function (r) { setTimeout(r, waitMs); });
        // 仅对 click/type 类动作捕获页面状态变化（减少不必要的 CDP 开销）
        var needPageState = (name === "click" || name === "visual_click" ||
                             name === "type" || name === "visual_type" ||
                             name === "smart_click" || name === "smart_type" ||
                             TEMPLATE_TOOLS.indexOf(name) !== -1);
        if (needPageState && result.ok && deps.evalInPage && !result.pageState) {
          try {
            var pageChange = await deps.evalInPage(
              "(function() { var t = document.title, u = location.href; " +
              "var dialog = document.querySelector('.el-dialog, .ant-modal, .el-drawer'); " +
              "var msg = document.querySelector('.el-message, .ant-message'); " +
              "var loading = document.querySelector('.el-loading-mask, .ant-spin'); " +
              "var dropdown = document.querySelector('.el-select-dropdown:not(.hidden), .ant-select-dropdown:not(.hidden), .el-select__popper, .ant-select-dropdown'); " +
              "return JSON.stringify({title:t, url:u, dialog:!!dialog, message:!!msg, loading:!!loading, dropdown:!!dropdown, " +
              "dialogText: dialog?dialog.textContent.substring(0,100):'', " +
              "messageText: msg?msg.textContent.substring(0,100):'', " +
              "dropdownText: dropdown?dropdown.textContent.substring(0,100):''}); })()"
            );
            if (pageChange.ok && pageChange.result) {
              try { result.pageState = JSON.parse(pageChange.result); } catch(e) {}
            }
          } catch(e) {}
        }
      }

      return result;
    }

    /**
     * Plan 模式：只读分析，不执行任何操作
     * AI 分析源码+架构+DOM 快照，输出测试策略建议
     * 借鉴 OpenCode 的 plan agent 模式
     */
    async function plan(params) {
      state.running = true;
      state.aborted = false;
      state.round = 0;

      setStatus("Plan 模式：分析测试策略...");
      log("=== Plan 模式启动 ===");

      try {
        // 加载源码
        state.sourceFiles = global.AIFT_SourceReader.getSourceFiles();
        var srcCount = global.AIFT_SourceReader.getFileCount();
        log("已加载源码: " + srcCount + " 个文件");

        // 获取初始快照
        setStatus("捕获 DOM 快照...");
        await getSnapshot();
        log("初始快照: " + state.snapshot.interactiveCount + " 个可交互元素");

        // 构建 plan prompt
        // 借鉴 OpenCode 的 plan.txt + reminders.ts 的 plan 模式
        // OpenCode 使用 system-reminder 风格的只读约束，注入到 user 消息中
        var planMessages = [
          {
            role: "system",
            content: [
              "你是一个前端测试策略规划专家。你的任务是分析项目源码、架构和当前页面状态，",
              "为后续的自动化测试制定最优执行策略。",
              "",
              "## 输出要求",
              "请输出结构化的测试策略，包括：",
              "1. 页面结构分析：当前页面有哪些主要功能区域",
              "2. 测试用例优先级排序建议（按风险和依赖关系排序）",
              "3. 每个用例的关键操作路径（需要经过哪些元素/页面）",
              "4. 潜在风险点（可能导致测试失败的因素）",
              "5. 数据验证策略（哪些用例需要检查 API 响应）",
              "",
              "注意：这是只读分析，不要执行任何操作。只输出策略建议。",
            ].join("\n"),
          },
          {
            role: "user",
            content: (function() {
              var parts = [];
              // 借鉴 OpenCode 的 plan.txt：注入 system-reminder 风格的只读约束
              parts.push("<system-reminder>");
              parts.push("# Plan Mode - System Reminder");
              parts.push("");
              parts.push("CRITICAL: Plan mode ACTIVE - you are in READ-ONLY phase. STRICTLY FORBIDDEN:");
              parts.push("ANY file edits, modifications, or system changes. Do NOT use click, type, press,");
              parts.push("or ANY other action tool to manipulate the page. You may ONLY observe, analyze,");
              parts.push("and plan. Any modification attempt is a critical violation. ZERO exceptions.");
              parts.push("");
              parts.push("## Responsibility");
              parts.push("Your current responsibility is to think, read, search, and analyze to construct");
              parts.push("a well-formed test strategy. Your plan should be comprehensive yet concise.");
              parts.push("</system-reminder>");
              parts.push("");
              parts.push("## 测试需求");
              parts.push(params.requirement || "（未提供）");
              parts.push("");
              parts.push("## 测试用例");
              parts.push(params.testCases || "（未提供）");
              parts.push("");
              if (params.architecture && global.AIFT_ProjectAnalyzer) {
                var archText = global.AIFT_ProjectAnalyzer.formatForPrompt(params.architecture);
                if (archText) { parts.push(archText); parts.push(""); }
              }
              var srcText = formatSourceFilesForPlan(state.sourceFiles);
              if (srcText) { parts.push(srcText); parts.push(""); }
              parts.push("## 当前页面 DOM 快照");
              parts.push(global.AIFT_PromptBuilder.formatSnapshot(state.snapshot));
              parts.push("");
              parts.push("请分析以上信息，输出测试策略建议。");
              return parts.join("\n");
            })(),
          },
        ];

        setStatus("AI 分析中...");
        stream("info", "📋 Plan 模式：AI 正在分析测试策略...");

        state.abortController = new AbortController();
        var aiResult;
        try {
          aiResult = await global.AIFT_AIClient.chatStream(
            deps.config, planMessages, [],
            {
              timeout: 120000,
              maxRetries: 3,
              signal: state.abortController.signal,
              onDelta: function (type, content) {
                if (type === "reasoning") stream("reasoning", content);
                else if (type === "content") stream("content", content);
              },
            }
          );
        } catch (e) {
          if (e.name === "UserAbortError" || state.aborted) {
            log("Plan 模式被用户中止");
            if (deps.onFinish) deps.onFinish("aborted", "Plan 被中止", [], []);
            return;
          }
          log("Plan 模式 AI 调用失败: " + (e.message || e));
          if (deps.onFinish) deps.onFinish("error", "Plan 失败: " + (e.message || e), [], []);
          return;
        } finally {
          state.abortController = null;
        }

        var planResult = (aiResult.message && aiResult.message.content) || "";
        log("=== Plan 模式完成 ===");
        setStatus("Plan 完成");
        stream("info", "📋 测试策略分析完成");

        if (deps.onFinish) deps.onFinish("plan", planResult, [], []);
      } catch (e) {
        log("Plan 模式异常: " + (e.message || e));
        setStatus("Plan 异常");
        if (deps.onFinish) deps.onFinish("error", "Plan 异常: " + (e.message || e), [], []);
      } finally {
        state.running = false;
      }
    }

    /**
     * 格式化源码用于 Plan 模式（取更多文件，但每个截断更短）
     */
    function formatSourceFilesForPlan(sourceFiles) {
      if (!sourceFiles) return "";
      var allFiles = Object.keys(sourceFiles);
      if (allFiles.length === 0) return "";
      var parts = ["## 项目源码概览（" + allFiles.length + " 个文件）"];
      var maxFiles = Math.min(10, allFiles.length);
      for (var i = 0; i < maxFiles; i++) {
        var path = allFiles[i];
        var content = sourceFiles[path] || "";
        if (content.length > 2000) content = content.substring(0, 2000) + "\n…（已截断）";
        parts.push("### " + path);
        parts.push("```");
        parts.push(content);
        parts.push("```");
      }
      if (allFiles.length > maxFiles) {
        parts.push("…（还有 " + (allFiles.length - maxFiles) + " 个文件未显示）");
      }
      return parts.join("\n");
    }

    /**
     * 运行 agent loop
     * @param {Object} params - { requirement, testCases, architecture }
     */
    async function run(params) {
      state.running = true;
      state.aborted = false;
      state.paused = false;
      state.resumeResolver = null;
      state.round = 0;
      state.history = [];
      state.conversationHistory = [];
      state.assertions = [];
      state.finished = false;
      state.turnPaused = false;
      state.screenshot = null;
      state.snapshot = null;
      state.previousSnapshot = null;
      state.lastActionSig = null;
      state.repeatCount = 0;
      state.consecutiveWaitCount = 0;
      state.actionSigHistory = [];
      state.loopWarning = null;
      state.userIntervention = null;
      state.userInjecting = false;
      state.reasoningLoopCount = 0;
      state.attemptHistory = [];
      state.tcRoundCount = {};
      state.currentTcId = null;
      state.cachedSummary = "";
      state.needReadSummary = false;
      state.failedStrategies = [];
      state.visualClickAttempts = [];
      state.activeSourceInteractions = [];
      state.failureAttempts = [];

      // 解析测试用例
      state.testCases = parseTestCases(params.testCases || "");
      assignExecutionScenarios(state.testCases);
      state.scenarioPlan = global.AIFT_TestScheduler && global.AIFT_TestScheduler.buildPlan
        ? global.AIFT_TestScheduler.buildPlan(state.testCases) : [];
      if (deps.onTestCasesParsed) deps.onTestCasesParsed(state.testCases);

      // 动态计算步数上限：基础 + 每个用例额外步数
      var tcCount = state.testCases.length || 1;
      state.maxSteps = Math.min(MAX_STEPS_BASE + tcCount * MAX_STEPS_PER_TC, state.maxStepsLimit);
      log("步数上限：" + state.maxSteps + "（" + tcCount + " 个用例 × " + MAX_STEPS_PER_TC + " + " + MAX_STEPS_BASE + "）");

      // 记录架构分析状态
      if (params.architecture) {
        var archRouteCount = params.architecture.routes ? params.architecture.routes.length : 0;
        var archRefined = params.architecture.refined ? "AI 精炼" : "启发式";
        log("已加载项目架构分析: " + archRouteCount + " 路由 (" + archRefined + ")");
      } else {
        log("⚠️ 未提供架构分析，AI 将缺乏全局路由/导航上下文。建议先执行架构分析。");
      }

      try {
        // 1. 加载用户上传的源码
        state.sourceFiles = global.AIFT_SourceReader.getSourceFiles();
        var srcCount = global.AIFT_SourceReader.getFileCount();
        state.sourceInteractions = global.AIFT_SourceAnalyzer && global.AIFT_SourceAnalyzer.getInteractionContracts
          ? global.AIFT_SourceAnalyzer.getInteractionContracts(state.sourceFiles) : [];
        log("已加载用户上传源码: " + srcCount + " 个文件");
        if (state.sourceInteractions.length > 0) log("已生成源码交互契约: " + state.sourceInteractions.length + " 条");
        if (srcCount === 0) {
          log("⚠️ 未上传源码，AI 将无法使用 read_source 工具。请在面板中上传项目源码目录。");
        }

        // 1.5 启动网络录制
        if (global.AIFT_NetworkRecorder) {
          global.AIFT_NetworkRecorder.clear();
          var networkStarted = await global.AIFT_NetworkRecorder.start(deps.tabId);
          log(networkStarted ? "网络请求录制已启动" : "网络请求录制启动失败，将继续尝试 CDP 真实交互");
        }

        // 1.6 附加 CDP debugger（用于真实交互、截图和网络录制）
        if (global.AIFT_VisualController) {
          try {
            await global.AIFT_VisualController.ensureAttached(deps.tabId);
            log("CDP debugger 已附加（真实交互和截图可用）");
          } catch (e) {
            throw new Error("CDP debugger 附加失败，无法保证真实用户行为测试: " + (e.message || e));
          }
        } else {
          throw new Error("CDP 视觉控制器不可用，无法执行真实用户行为测试");
        }

        // 2. 获取初始快照
        setStatus("捕获 DOM 快照...");
        log("捕获初始 DOM 快照");
        await getSnapshot();
        log("初始快照: " + state.snapshot.interactiveCount + " 个可交互元素");
        // 视觉模式：初始截图
        if (deps.config.visionSupported && global.AIFT_VisualController) {
          try {
            state.screenshot = await global.AIFT_VisualController.captureAnnotatedForAI(deps.evalInPage);
            state.annotatedElements = state.screenshot.elements || [];
            log("📸 初始标注截图: " + state.screenshot.width + "x" + state.screenshot.height + ", " + state.annotatedElements.length + " 个元素");
            // 通知面板展示初始截图
            if (deps.onStream) deps.onStream("screenshot", JSON.stringify({
              dataUrl: state.screenshot.dataUrl,
              width: state.screenshot.width,
              height: state.screenshot.height,
              elements: state.annotatedElements.length,
              round: 0,
              source: "initial",
            }));
          } catch (e) {
            log("📸 初始截图失败: " + (e.message || e));
          }
        }

        // 3. Agent loop
        while (!state.aborted && !state.finished) {
          // 检查是否暂停（动作执行期间触发的暂停在此处生效）
          if (state.paused && !state.aborted) {
            stream("info", "⏸️ 已暂停，点击「继续」恢复执行");
            setStatus("已暂停");
            await waitForResume();
            if (state.aborted) break;
            stream("info", "▶️ 继续执行");
          }

          state.round++;

          setStatus("第 " + state.round + " 轮 AI 推理中...");
          log("--- 第 " + state.round + " 轮 ---");
          stream("round", "第 " + state.round + " 轮");

          // 上下文管理：借鉴 OpenCode 的 compaction 策略
          // 三层防线：1. 工具输出修剪(prune) 2. tail 保留 + 中间压缩 3. 溢出检测
          var contextSizeK = deps.config.contextSize || 128;
          var maxContextTokens = contextSizeK * 1000;
          // 预留 20K token 给输出（借鉴 OpenCode 的 COMPACTION_BUFFER）
          var usableTokens = Math.max(0, maxContextTokens - 20000);
          var maxContextChars = usableTokens * 3; // 1 token ≈ 3 字符

          // 第一层：工具输出修剪（prune）— 借鉴 OpenCode 的 prune 逻辑
          // 从后往前扫描，保留最近 40K 字符的工具输出，更早的工具输出截断为摘要
          var PRUNE_PROTECT = 40000;
          var PRUNE_MINIMUM = 20000;
          var TOOL_OUTPUT_MAX = 2000; // 工具输出截断上限
          var totalToolOutput = 0;
          var toPrune = [];
          for (var pi = state.conversationHistory.length - 1; pi >= 0; pi--) {
            var pm = state.conversationHistory[pi];
            if (pm.role !== "tool") continue;
            var pmContent = typeof pm.content === "string" ? pm.content : "";
            var pmLen = pmContent.length;
            totalToolOutput += pmLen;
            if (totalToolOutput <= PRUNE_PROTECT) continue;
            if (pmLen > PRUNE_MINIMUM) {
              toPrune.push({ index: pi, content: pmContent });
            }
          }
          if (toPrune.length > 0) {
            for (var pri = 0; pri < toPrune.length; pri++) {
              var item = toPrune[pri];
              // 保留开头 + 结尾，中间截断（借鉴 OpenCode 的 head+tail 截断）
              var head = item.content.substring(0, TOOL_OUTPUT_MAX);
              var tail = item.content.substring(item.content.length - 500);
              state.conversationHistory[item.index].content =
                head + "\n\n...[已修剪 " + (item.content.length - TOOL_OUTPUT_MAX - 500) + " 字符]...\n\n" + tail;
            }
            log("📋 上下文修剪：已修剪 " + toPrune.length + " 条旧工具输出（保留头尾）");
          }

          // 第二层：溢出检测 + tail 保留压缩（借鉴 OpenCode 的 compaction.process）
          var historyChars = 0;
          for (var hi = 0; hi < state.conversationHistory.length; hi++) {
            var hc = state.conversationHistory[hi].content;
            if (typeof hc === "string") historyChars += hc.length;
            else if (Array.isArray(hc)) {
              for (var hj = 0; hj < hc.length; hj++) {
                if (hc[hj].text) historyChars += hc[hj].text.length;
              }
            }
            if (state.conversationHistory[hi].tool_calls) {
              historyChars += JSON.stringify(state.conversationHistory[hi].tool_calls).length;
            }
          }
          if (historyChars > maxContextChars) {
            // 借鉴 OpenCode 的 select() 逻辑：保留首条 user + tail turns + 中间摘要
            var firstMsg = state.conversationHistory[0];
            // tail 保留：最近 2 个完整 turn（借鉴 OpenCode 的 DEFAULT_TAIL_TURNS = 2）
            var keepRecent = 8;
            var recentMsgs = state.conversationHistory.slice(-keepRecent);
            var middleMsgs = state.conversationHistory.slice(1, -keepRecent);
            // 将中间消息压缩为结构化摘要（借鉴 OpenCode 的 compaction prompt 风格）
            var summaryParts = [
              "📋 [上下文摘要] 以下为之前 " + middleMsgs.length + " 条对话的压缩摘要。",
              "请基于此摘要继续执行，不要重复已完成的操作。",
              "",
            ];
            for (var mi = 0; mi < middleMsgs.length; mi++) {
              var mm = middleMsgs[mi];
              if (mm.role === "assistant") {
                if (mm.tool_calls) {
                  var tcSummary = mm.tool_calls.map(function(tc) {
                    return tc.function.name + "(" + (tc.function.arguments || "").substring(0, 60) + ")";
                  }).join(", ");
                  summaryParts.push("- [动作] " + tcSummary);
                }
                if (mm.content && typeof mm.content === "string" && mm.content.length > 0) {
                  summaryParts.push("- [思考] " + mm.content.substring(0, 120));
                }
              } else if (mm.role === "tool") {
                var tc2 = (mm.content || "");
                // 错误信息和模板结果保留更多内容，避免丢失关键诊断信息
                if (tc2.length > 300) tc2 = tc2.substring(0, 300) + "…";
                summaryParts.push("- [结果] " + mm.name + ": " + tc2);
              } else if (mm.role === "user") {
                var uc = typeof mm.content === "string" ? mm.content : "";
                if (uc.length > 0 && uc.indexOf("[上下文摘要]") === -1) {
                  summaryParts.push("- [用户] " + uc.substring(0, 120));
                }
              }
            }
            var summaryMsg = { role: "user", content: summaryParts.join("\n") };
            state.conversationHistory = [firstMsg, summaryMsg].concat(recentMsgs);
            log("📋 上下文压缩：历史过长（" + Math.round(historyChars / 1000) + "K 字符 > " + Math.round(maxContextChars / 1000) + "K 上限），已压缩 " + middleMsgs.length + " 条中间消息");
          }

          // 按当前页面、DOM 和测试用例召回源码，不能依赖上传目录的文件顺序。
          var sourceFilesArr = [];
          var currentCase = null;
          for (var sci = 0; sci < state.testCases.length; sci++) {
            if ((state.testCases[sci].id || "") === state.currentTcId) { currentCase = state.testCases[sci]; break; }
          }
          var sourceContext = {
            url: state.snapshot && state.snapshot.url || "",
            title: state.snapshot && state.snapshot.title || "",
            domText: state.snapshot && state.snapshot.pageText || "",
            testCase: currentCase ? [currentCase.title, currentCase.page, currentCase.preconditions, currentCase.steps, currentCase.expected].join(" ") : params.testCases || "",
          };
          if (global.AIFT_SourceReader && global.AIFT_SourceReader.rankRelevantFiles) {
            sourceFilesArr = global.AIFT_SourceReader.rankRelevantFiles(state.sourceFiles, sourceContext, 5);
          } else {
            var allFiles = Object.keys(state.sourceFiles);
            for (var i = 0; i < Math.min(5, allFiles.length); i++) {
              sourceFilesArr.push({ path: allFiles[i], content: state.sourceFiles[allFiles[i]] });
            }
          }
          var relevantPaths = {};
          sourceFilesArr.forEach(function(file) { relevantPaths[file.path] = true; });
          state.activeSourceInteractions = (state.sourceInteractions || []).filter(function(interaction) {
            return !interaction.path || relevantPaths[interaction.path];
          });

          // 如果需要读取摘要（用例切换时标记），在构建消息前异步读取
          if (state.needReadSummary) {
            state.needReadSummary = false;
            if (global.AIFT_SummaryCache) {
              try {
                state.cachedSummary = await global.AIFT_SummaryCache.read() || "";
                if (state.cachedSummary) {
                  log("📝 已加载上下文摘要（来自之前用例）");
                }
              } catch (e) {
                log("📝 读取摘要失败: " + (e.message || e));
              }
            }
          }

          // 构建消息
          var messages = global.AIFT_PromptBuilder.buildMessages({
            requirement: params.requirement,
            testCases: params.testCases,
            testCasesState: state.testCases,
            sourceFiles: sourceFilesArr,
            sourceInteractions: state.activeSourceInteractions,
            scenarioPlan: state.scenarioPlan,
            snapshot: state.snapshot,
            screenshot: state.screenshot,
            history: state.history,
            conversationHistory: state.conversationHistory,
            networkSummary: global.AIFT_NetworkRecorder ? global.AIFT_NetworkRecorder.getSummary() : [],
            architecture: params.architecture || null,
            extraPrompt: params.extraPrompt || "",
            visionSupported: deps.config.visionSupported,
            summary: state.cachedSummary || "",
            currentTcId: state.currentTcId,
            currentTcRounds: state.currentTcId ? (state.tcRoundCount[state.currentTcId] || 0) : 0,
            maxTcRounds: MAX_TC_ROUNDS,
            recoveryReserveRounds: TC_RECOVERY_RESERVE_ROUNDS,
          });
         // 注入干预消息（用户干预优先于自动警告）
         if (state.userIntervention) {
           messages.push({ role: "user", content: state.userIntervention });
           state.userIntervention = null;
           state.userInjecting = false;
         } else if (state.loopWarning) {
           messages.push({ role: "user", content: state.loopWarning });
           state.loopWarning = null;
         }

         // 借鉴 OpenCode 的 maxSteps + assistant prefill（prompt.ts 行 1178-1281）
         // 当达到最大步数时，注入 assistant prefill 强制模型停止使用工具
         var isLastStep = state.round >= state.maxSteps;
         if (isLastStep) {
           messages.push({ role: "assistant", content: MAX_STEPS_PROMPT });
           log("⚠️ 已达到步数上限 " + state.maxSteps + "（第 " + state.round + " 轮），注入 assistant prefill 强制收尾");
           stream("warning", "⚠️ 已达到步数上限 " + state.maxSteps + "，本轮将强制输出文本总结");
         }

          // 首轮：把初始 user 消息存入对话历史，保证后续轮次重放时 user 在 system 之后、assistant 之前，
          // 否则会出现 system 直接连 assistant 的非法序列，导致 AI 网关返回 400。
          if (state.conversationHistory.length === 0) {
            for (var mi = 1; mi < messages.length; mi++) {
              if (messages[mi].role === "user") {
                state.conversationHistory.push({
                  role: "user",
                  content: messages[mi].content,
                });
                break;
              }
            }
          }

          // 流式调用 AI
          state.abortController = new AbortController();
          var aiResult;
          try {
            aiResult = await global.AIFT_AIClient.chatStream(
              deps.config,
              messages,
              global.AIFT_PromptBuilder.buildTools({ visionSupported: deps.config.visionSupported }),
              {
                timeout: 120000,
                maxRetries: 3,
                signal: state.abortController.signal,
                onDelta: function (type, content) {
                  if (type === "reasoning") {
                    stream("reasoning", content);
                  } else if (type === "content") {
                    stream("content", content);
                  } else if (type === "tool_call") {
                    stream("action", content);
                  }
                },
              }
            );
          } catch (e) {
            // 用户注入消息 → 中止当前请求，下轮注入用户消息（最高优先级，先于暂停检查）
            if (e.name === "UserAbortError" && state.userInjecting && !state.aborted) {
              state.userInjecting = false;
              state.paused = false;
              stream("info", "💡 用户消息已注入（最高优先级），重新发起请求...");
              setStatus("第 " + state.round + " 轮 AI 推理中...");
              continue;
            }
            // 用户暂停 → 等待恢复后继续本轮
            if (e.name === "UserAbortError" && state.paused && !state.aborted) {
              stream("info", "⏸️ 已暂停，点击「继续」恢复执行");
              setStatus("已暂停");
              await waitForResume();
              if (state.aborted) break;
              stream("info", "▶️ 继续执行");
              setStatus("第 " + state.round + " 轮 AI 推理中...");
              continue; // 重新开始本轮
            }
            // 用户中止 → 直接退出循环，不报错
            if (e.name === "UserAbortError" || state.aborted) {
              stream("info", "用户中止，AI 请求已中断");
              state.aborted = true;
              break;
            }
            // 推理重复循环 → 中止当前请求，保留上下文，注入提示后继续下一轮
            if (e.name === "ReasoningLoopError") {
              state.reasoningLoopCount++;
              stream("warning", "⚠️ 检测到 AI 推理内容重复循环，已自动中断（第 " + state.reasoningLoopCount + " 次）");

              // 连续 3 次推理死循环 → 暂停等待用户介入
              if (state.reasoningLoopCount >= 3) {
                log("⛔ 连续 " + state.reasoningLoopCount + " 次推理死循环，暂停等待用户介入");
                stream("warning", "⛔ 连续推理死循环 " + state.reasoningLoopCount + " 次，已暂停");
                state.paused = true;
                notifyAutoPause("reasoning_loop");
                state.loopWarning = "⛔ AI 推理连续陷入重复循环（" + state.reasoningLoopCount + " 次），已暂停。\n" +
                  "测试已暂停，请检查当前页面状态。你可以：\n" +
                  "1. 输入指令引导 AI 换一种思路\n" +
                  "2. 点击「继续」重试\n" +
                  "3. 点击「中止」结束测试";
                state.reasoningLoopCount = 0; // 重置计数，避免恢复后立即再次触发
                continue; // 跳过本轮剩余处理，下一轮顶部暂停检查会触发等待
              }

              // ===== 保留上下文 =====
              // 将部分内容作为 assistant 消息加入对话历史（不包含 tool_calls，避免缺少 tool 结果导致 API 400）
              if (e.partialContent) {
                state.conversationHistory.push({
                  role: "assistant",
                  content: e.partialContent,
                });
                log("💡 已保留部分 AI 输出内容（" + e.partialContent.length + " 字符）到对话历史");
              }

              // 注入 user 消息：告知 AI 检测到重复，引导其跳出
              var repeatNotice =
                "⚠️ [系统] 检测到推理内容重复循环（" + (e.breakReason || "原因未知") + "），已自动中断当前请求。\n" +
                "请基于已有上下文，采用不同的策略继续执行任务，不要重复之前的推理过程。\n" +
                "1. 不再重复分析页面结构，基于已有理解直接调用工具\n" +
                "2. 能断言则立即 assert，所有用例已处理则 finish\n" +
                "记住：不要在思考中反复推导，直接行动！";
              state.conversationHistory.push({
                role: "user",
                content: repeatNotice,
              });

              // 清除 loopWarning，避免与已注入的 user 消息重复
              state.loopWarning = null;
              log("💡 已注入推理循环干预提示并保留上下文，继续下一轮");
              continue;
            }
            // AI 调用失败（网络/超时等），暂停等待用户介入而非直接终止
            var aiFailMsg = e.message || String(e);
            if (e.partialReasoning) state.lastReasoning = e.partialReasoning;
            recordError("ai_call_error", {
              message: aiFailMsg,
              partialReasoning: shortenTraceText(e.partialReasoning || "", 6000),
            });
            log("AI 调用失败: " + aiFailMsg + "，暂停等待用户介入");
            stream("error", "⚠️ AI 调用失败: " + aiFailMsg + "，已暂停");
            setStatus("AI 调用失败（已暂停）");
            state.paused = true;
            notifyAutoPause("ai_call_error");
            state.loopWarning = "⚠️ AI 调用失败：" + aiFailMsg + "\n" +
              "可能是网络问题或 API 超时。测试已暂停。你可以：\n" +
              "1. 检查网络连接后点击「继续」重试\n" +
              "2. 输入指令调整策略\n" +
              "3. 点击「中止」结束测试";
            continue; // 下一轮顶部暂停检查会触发等待
          } finally {
            state.abortController = null;
          }

          var message = aiResult.message;

          // AI 调用成功，重置推理循环计数器
          state.reasoningLoopCount = 0;

          // 如果有文本内容，记录
          if (message.content) {
            log("AI: " + message.content.substring(0, 200));
          }

          // 从 tool_calls 推断当前测试用例
          var toolCalls = global.AIFT_AIClient.extractToolCalls(message);
          state.lastReasoning = message.reasoning_content || message.content || "";
          recordTrace({
            type: "ai_decision",
            reasoning: shortenTraceText(state.lastReasoning, 3000),
            plannedTools: toolCalls.map(function(call) {
              return { name: call.function.name, arguments: shortenTraceText(call.function.arguments || "{}", 1000) };
            }),
          });

          // 使用状态机更新测试用例状态
          updateTestCaseState(message, toolCalls);

          // 流结束后换行
          stream("round_end", "");

          if (toolCalls.length === 0) {
            // AI 没有返回动作，可能是纯文本回复
            state.noToolCallCount++;

            // 将 AI 的纯文本回复加入对话历史，保留上下文
            state.conversationHistory.push({
              role: "assistant",
              content: message.content || null,
            });

            // MAX_STEPS 达到后 AI 被强制要求不使用工具，此时直接暂停让用户决定
            if (isLastStep) {
              log("已达到步数上限 " + state.maxSteps + "，AI 输出了文本总结，暂停等待用户介入");
              stream("warning", "⚠️ 已达到步数上限 " + state.maxSteps + "，已暂停");
              state.paused = true;
              notifyAutoPause("max_steps");
              // 用户恢复后提升上限，避免永久卡死
              var oldLimit = state.maxSteps;
              state.maxSteps = Math.min(state.maxSteps + 50, state.maxStepsLimit);
              state.loopWarning = "⚠️ 已达到步数上限（" + oldLimit + " 轮），AI 输出了以下总结：\n" +
                (message.content || "（无内容）").substring(0, 500) + "\n\n" +
                "测试已暂停。恢复后步数上限提升至 " + state.maxSteps + "。你可以：\n" +
                "1. 输入指令引导 AI 继续执行剩余用例\n" +
                "2. 点击「继续」让 AI 自行决定下一步\n" +
                "3. 点击「中止」结束测试";
              state.noToolCallCount = 0;
              continue;
            }

            if (state.noToolCallCount >= 2) {
              // 连续 2 次无 tool_calls，暂停等待用户介入
              log("AI 连续 " + state.noToolCallCount + " 轮未返回动作，暂停等待用户介入");
              stream("warning", "⚠️ AI 连续 " + state.noToolCallCount + " 轮未返回动作，已暂停");
              state.paused = true;
              notifyAutoPause("no_tool_calls");
              state.loopWarning = "⚠️ AI 连续 " + state.noToolCallCount + " 轮未调用任何工具，可能已放弃执行。\n" +
                "AI 最后的回复：" + (message.content || "（无内容）").substring(0, 200) + "\n\n" +
                "测试已暂停。你可以：\n" +
                "1. 输入指令明确要求 AI 继续执行哪个步骤\n" +
                "2. 点击「继续」让 AI 重试\n" +
                "3. 点击「中止」结束测试";
              state.noToolCallCount = 0; // 重置计数，避免恢复后立即再次触发
              continue; // 跳过本轮剩余处理，下一轮顶部暂停检查会触发等待
            }

            // 首次无 tool_calls：注入提示，要求 AI 继续执行或显式 finish
            log("AI 未返回动作（第 " + state.noToolCallCount + " 次），注入提示要求继续");
            stream("warning", "⚠️ AI 未返回工具调用，已注入提示要求继续执行");
            state.conversationHistory.push({
              role: "user",
              content: "你刚才没有调用任何工具。请继续执行测试任务：\n" +
                "1. 如果测试用例尚未全部完成，请继续调用工具执行下一步操作\n" +
                "2. 如果所有用例已处理完毕，请显式调用 finish 工具结束测试\n" +
                "3. 不要只输出文本分析，必须通过工具调用来执行操作\n" +
                "请立即调用工具继续。",
            });
            continue;
          }

          // AI 返回了 tool_calls，重置计数器
          state.noToolCallCount = 0;

          // 将 assistant 消息加入对话历史
         state.conversationHistory.push({
           role: "assistant",
           content: message.content || null,
           tool_calls: message.tool_calls || undefined,
         });

          // 逐个执行 tool_calls
          var needDiagnosticScreenshot = false; // 动作失败时补一张标注截图，避免每步截图拖慢执行
          var roundFailureReasons = [];
          for (var t = 0; t < toolCalls.length; t++) {
            var tc = toolCalls[t];
            stream("action", "执行: " + tc.function.name);
            var execResult = await executeAction(tc);

            // 记录历史
            state.history.push({
              action: execResult.action + " " + JSON.stringify(execResult.args),
              result: execResult.result || (execResult.ok ? "ok" : "error"),
            });
            recordTrace({
              type: "tool_result",
              action: execResult.action,
              args: execResult.args,
              ok: !!execResult.ok,
              result: shortenTraceText(execResult.result || (execResult.ok ? "ok" : "error"), 2000),
            });
            if (!execResult.ok) {
              roundFailureReasons.push(execResult.action + ": " + shortenTraceText(execResult.result || "工具执行失败", 180));
              if (global.AIFT_ProgressGuard && global.AIFT_ProgressGuard.createFailureAttempt && state.currentTcId) {
                var failureAttempt = global.AIFT_ProgressGuard.createFailureAttempt(execResult.action, execResult.args, state.snapshot);
                if (failureAttempt) {
                  failureAttempt.tcId = state.currentTcId;
                  failureAttempt.round = state.round;
                  state.failureAttempts.push(failureAttempt);
                  if (state.failureAttempts.length > 40) state.failureAttempts.shift();
                }
              }
              recordError("tool_failure", {
                action: execResult.action,
                args: execResult.args,
                message: execResult.result || "工具执行失败",
                pageState: execResult.pageState || null,
              });
            } else if (global.AIFT_ProgressGuard && global.AIFT_ProgressGuard.createFailureAttempt && state.currentTcId) {
              // 成功交互已验证或返回了有效状态，旧失败不能继续触发熔断。
              var successfulInteraction = global.AIFT_ProgressGuard.createFailureAttempt(execResult.action, execResult.args, state.snapshot);
              if (successfulInteraction) {
                state.failureAttempts = state.failureAttempts.filter(function(attempt) { return attempt.tcId !== state.currentTcId; });
              }
            }
            if (!execResult.ok && ACTION_WAIT_MAP[tc.function.name] !== undefined) {
              needDiagnosticScreenshot = true;
            }

            stream("action_result", execResult.action + " → " + (execResult.result || (execResult.ok ? "ok" : "error")));

            // 将 tool 结果加入对话历史
            var toolResultContent = execResult.result || "ok";

            // 借鉴 OpenCode 的 Truncate.output（truncate.ts）
            // 工具输出超过限制时截断，保留头尾，中间用提示替代
            var TOOL_MAX_CHARS = 8000;
            if (toolResultContent.length > TOOL_MAX_CHARS) {
              var headPart = toolResultContent.substring(0, TOOL_MAX_CHARS / 2);
              var tailPart = toolResultContent.substring(toolResultContent.length - TOOL_MAX_CHARS / 2);
              var removedChars = toolResultContent.length - TOOL_MAX_CHARS;
              toolResultContent =
                headPart +
                "\n\n...[工具输出已截断 " + removedChars + " 字符，保留头尾]...\n\n" +
                tailPart;
              log("📋 工具输出截断：" + execResult.action + " 输出 " + toolResultContent.length + " 字符 → 截断为 " + TOOL_MAX_CHARS + " 字符");
            }

            // 附加页面状态变化信息（如果有）
            if (execResult.pageState) {
              var ps = execResult.pageState;
              var psParts = ["\n[页面状态]"];
              if (ps.title) psParts.push("标题: " + ps.title);
              if (ps.url) psParts.push("URL: " + ps.url);
              if (ps.dialog) psParts.push("⚠️ 弹窗出现: " + (ps.dialogText || ""));
              if (ps.message) psParts.push("💬 消息提示: " + (ps.messageText || ""));
              if (ps.loading) psParts.push("⏳ 加载中");
              if (ps.dropdown) psParts.push("🔽 下拉框已展开: " + (ps.dropdownText || ""));
              toolResultContent += psParts.join("\n");
            }
            if (execResult.action === "read_source" && execResult.sourceFiles) {
              var srcContent = [];
              for (var s = 0; s < execResult.sourceFiles.length; s++) {
                srcContent.push("### " + execResult.sourceFiles[s].path + "\n```\n" + execResult.sourceFiles[s].content + "\n```");
              }
              // 附加结构化组件信息
              if (execResult.componentInfo) {
                srcContent.push("\n" + execResult.componentInfo);
              }
              toolResultContent = srcContent.join("\n\n");
            }

            // 截图结果：构建多模态消息（文本 + 图片）
            if ((execResult.action === "screenshot" || execResult.action === "verify_ui") && execResult.screenshot) {
              // 构建标注元素列表文本（仅 screenshot 有标注，verify_ui 无标注）
              var annoListText = "";
              var visionPrefix = "";
              if (execResult.action === "screenshot" && state.annotatedElements.length > 0) {
                var annoLines = ["标注元素列表（优先用预设模板；基础 click/type 走 CDP；selector 不稳定时用 smart_click(label=编号)）："];
                for (var ae = 0; ae < Math.min(state.annotatedElements.length, 40); ae++) {
                  var ael = state.annotatedElements[ae];
                  annoLines.push("  [" + ael.label + "] <" + ael.tag + "> " +
                    (ael.placeholder ? 'placeholder="' + ael.placeholder + '" ' : '') +
                    (ael.text || "(无文本)") +
                    " 坐标:(" + ael.x + "," + ael.y + ") " +
                    ael.w + "x" + ael.h +
                    " selector:" + ael.selector);
                }
                annoListText = annoLines.join("\n");
                visionPrefix = "标注截图完成。页面尺寸: " + execResult.screenshot.width + "x" + execResult.screenshot.height + "。\n" +
                  "优先使用预设模板；基础 click/type 会通过 CDP 执行。\n" +
                  "selector 不稳定或视觉坐标更可靠时，使用 smart_click(label=编号)。\n" +
                  "如需验证页面展示效果请使用 verify_ui。\n\n";
              } else if (execResult.action === "verify_ui") {
                visionPrefix = "UI 验证截图已捕获。页面尺寸: " + execResult.screenshot.width + "x" + execResult.screenshot.height + "。\n" +
                  "请仔细检查截图中的页面展示是否正确（布局、CSS、数据展示、交互状态）。\n\n";
              }
              var visionContent = global.AIFT_AIClient.buildVisionContent(
                visionPrefix + annoListText,
                execResult.screenshot.dataUrl
              );
              state.conversationHistory.push({
                role: "tool",
                tool_call_id: tc.id || ("call_" + t),
                name: tc.function.name,
                content: JSON.stringify({
                  text: toolResultContent,
                  image: true,
                  width: execResult.screenshot.width,
                  height: execResult.screenshot.height,
                }),
              });
              // 额外注入一条 user 消息携带图片，因为 tool 消息不支持 image_url
              state.conversationHistory.push({
                role: "user",
                content: visionContent,
              });
            } else {
              state.conversationHistory.push({
                role: "tool",
                tool_call_id: tc.id || ("call_" + t),
                name: tc.function.name,
                content: toolResultContent,
              });
            }

            if (deps.onRound) deps.onRound(state.round, execResult.action, execResult);
            // 每个动作后刷新测试用例状态（可能有 testing 状态更新）
            if (deps.onAssertion) deps.onAssertion(null, state.assertions, state.testCases);

            if (state.finished || state.turnPaused) break;
          }

          // finish 导致暂停：跳过后续处理，直接到 while 循环顶部暂停检查
          if (state.turnPaused) {
            notifyAutoPause("finish");
            stream("info", "⏸️ AI 调用了 finish，对话已暂停。请输入指令继续测试，或点击「继续」让 AI 自行调整。");
            continue;
          }

          var stalledFailure = global.AIFT_ProgressGuard && global.AIFT_ProgressGuard.detectStall
            ? global.AIFT_ProgressGuard.detectStall(state.failureAttempts, state.currentTcId) : null;
          if (stalledFailure && state.currentTcId) {
            var stalledReason = stalledFailure.kind === "same_action"
              ? "相同交互动作在未变化页面上连续失败 " + stalledFailure.count + " 次"
              : (stalledFailure.kind === "same_target"
                ? "不同操作在同一交互目标上连续失败 " + stalledFailure.count + " 次"
                : "交互失败正在重复");
            if (stalledFailure.kind === "warning") {
              state.loopWarning = "⚠️ 当前用例的交互未产生页面变化：" + stalledReason + "（" + stalledFailure.target + "）。请先读取源码或定位真实状态控件，禁止继续重复点击。";
              log("⚠️ " + stalledReason + "，已注入策略切换提示");
            } else {
              var stalledTcId = state.currentTcId;
              var stalledDetail = stalledReason + "，已自动标记失败以避免无效循环";
              log("⛔ " + stalledTcId + " " + stalledDetail);
              stream("warning", "⛔ " + stalledTcId + " " + stalledDetail);
              recordError("interaction_stall", {
                reason: stalledDetail,
                action: stalledFailure.action,
                target: stalledFailure.target,
                failureCount: stalledFailure.count,
              });
              for (var stci = 0; stci < state.testCases.length; stci++) {
                if (state.testCases[stci].status === "testing") {
                  state.testCases[stci].status = "failed";
                  state.testCases[stci].assertionDesc = stalledDetail;
                  break;
                }
              }
              if (deps.onAssertion) deps.onAssertion(null, state.assertions, state.testCases);
              state.loopWarning = "⛔ " + stalledTcId + " 已因重复交互失败自动标记失败。请立即开始下一个未完成用例；不要继续操作当前用例。";
              state.currentTcId = null;
              state.repeatCount = 0;
              state.consecutiveWaitCount = 0;
              state.lastActionSig = null;
            }
          }

          // ===== 记忆增强 + 死循环检测 =====
          // 借鉴 OpenCode 的 doom loop 检测（processor.ts 行 356-380）
          // 检查最近 N 次工具调用是否完全相同（工具名 + 参数 JSON 精确匹配）
          var allRecentToolCalls = [];
          for (var di = state.attemptHistory.length - 1; di >= 0 && allRecentToolCalls.length < DOOM_LOOP_THRESHOLD; di--) {
            var ah = state.attemptHistory[di];
            if (!ah || !ah.toolCalls) break;
            for (var dj = ah.toolCalls.length - 1; dj >= 0; dj--) {
              allRecentToolCalls.unshift(ah.toolCalls[dj]);
              if (allRecentToolCalls.length >= DOOM_LOOP_THRESHOLD) break;
            }
          }
          if (detectDoomLoop(allRecentToolCalls)) {
            var doomTool = allRecentToolCalls[allRecentToolCalls.length - 1].function.name;
            log("🚨 Doom Loop 检测：连续 " + DOOM_LOOP_THRESHOLD + " 次完全相同的工具调用 (" + doomTool + ")，暂停等待用户介入");
            stream("warning", "🚨 检测到 Doom Loop：连续 " + DOOM_LOOP_THRESHOLD + " 次相同调用 " + doomTool + "，已暂停");
            state.paused = true;
            notifyAutoPause("doom_loop");
            state.loopWarning = "🚨 检测到 Doom Loop：连续 " + DOOM_LOOP_THRESHOLD + " 次完全相同的工具调用 (" + doomTool + ")。\n" +
              "测试已暂停，请检查当前页面状态。你可以：\n" +
              "1. 输入指令引导 AI 换一种策略继续执行\n" +
              "2. 点击「继续」让 AI 自行调整\n" +
              "3. 点击「中止」结束测试";
            // 不 break，让循环继续到快照更新，下一轮顶部暂停检查会触发等待
          }

          // 记录本轮尝试到历史
          var roundActionsSummary = toolCalls.map(function(tc) {
            return tc.function.name + "(" + (tc.function.arguments || "").substring(0, 50) + ")";
          }).join(", ");
          state.attemptHistory.push({
            tcId: state.currentTcId || "unknown",
            round: state.round,
            action: roundActionsSummary,
            reason: roundFailureReasons.join("；"),
            toolCalls: toolCalls, // 保存原始 toolCalls 用于 doom loop 检测
          });
          if (state.attemptHistory.length > 30) state.attemptHistory.shift();

          // 记录当前用例的轮数
          if (state.currentTcId) {
            state.tcRoundCount[state.currentTcId] = (state.tcRoundCount[state.currentTcId] || 0) + 1;
          }

          // 检查 0: 单个测试用例超过最大轮数 → 自动标记失败
          if (state.currentTcId && state.tcRoundCount[state.currentTcId] >= MAX_TC_ROUNDS) {
            var tcId = state.currentTcId;
            var tcOverReason = tcId + " 已执行 " + state.tcRoundCount[tcId] + " 轮，超过上限 " + MAX_TC_ROUNDS + "，自动标记失败";
            log("⛔ " + tcOverReason);
            stream("warning", "⛔ " + tcOverReason);
            recordError("agent_limit", { reason: tcOverReason, action: "round_limit" });

            // 标记当前用例为失败
            for (var tci = 0; tci < state.testCases.length; tci++) {
              if (state.testCases[tci].status === "testing") {
                state.testCases[tci].status = "failed";
                state.testCases[tci].assertionDesc = "执行轮数超限（" + state.tcRoundCount[tcId] + "轮），自动标记失败";
                break;
              }
            }
            if (deps.onAssertion) deps.onAssertion(null, state.assertions, state.testCases);

            // 注入提示：要求 AI 继续下一个用例
            state.loopWarning = "⛔ " + tcId + " 已超过最大执行轮数，已自动标记为失败。\n" +
              "请立即开始下一个未完成的用例，或如果所有用例已处理则调用 finish。\n" +
              "不要继续操作当前用例！";
            state.currentTcId = null;
            // 重置重复检测
            state.repeatCount = 0;
            state.consecutiveWaitCount = 0;
            state.lastActionSig = null;
            // 不 break，继续下一轮让 AI 处理
          } else {
            // 正常死循环检测
            var roundActionSig = buildActionSignature(toolCalls);
            state.actionSigHistory.push(roundActionSig);
            if (state.actionSigHistory.length > 10) state.actionSigHistory.shift();

            // 1. 连续相同动作检测（跳过 __skip__ 标记的动作）
            if (roundActionSig === "__skip__") {
              // assert/finish/wait/screenshot 不参与重复检测，重置计数
              state.lastActionSig = null;
              state.repeatCount = 0;

              // 跟踪连续纯 wait 调用：如果本轮只有 wait 则累加，否则重置
              var allWait = toolCalls.every(function(tc) { return tc.function.name === "wait"; });
              if (allWait) {
                state.consecutiveWaitCount = (state.consecutiveWaitCount || 0) + 1;
                if (state.consecutiveWaitCount >= 2) {
                  state.loopWarning = "💡 你已连续 " + state.consecutiveWaitCount + " 轮只调用了 wait，没有推进测试步骤。\n" +
                    "请立即执行实际的测试操作（如 eval_in_page 获取数据、get_network_responses 检查接口、assert 断言结果），不要继续空等。\n" +
                    "如果页面已加载完成，请直接执行测试步骤；如果遇到已证实的问题，请 assert(outcome='failed') 标记失败；若无法完成验证，请 assert(outcome='inconclusive') 并继续下一个用例。";
                  log("💡 连续 wait 提示：已连续 " + state.consecutiveWaitCount + " 轮纯 wait");
                }
              } else {
                state.consecutiveWaitCount = 0;
              }
            } else if (roundActionSig === state.lastActionSig) {
              state.repeatCount++;
              state.consecutiveWaitCount = 0; // 有实际动作，重置 wait 计数
            } else {
              state.lastActionSig = roundActionSig;
              state.repeatCount = 1;
              state.consecutiveWaitCount = 0; // 有实际动作，重置 wait 计数
            }

            // 2. 振荡检测：A→B→A→B 或 A→B→A
            var oscillating = detectOscillation(state.actionSigHistory);

            // 2.5 区域死循环检测：同区域反复尝试不同工具
            var areaLoop = detectAreaLoop(state.attemptHistory, state.currentTcId || "unknown");

            // 3. 渐进式干预（注入记忆增强）
            var loopLevel = Math.max(state.repeatCount, oscillating ? 3 : 0, areaLoop ? 3 : 0);

            if (loopLevel >= 2 && loopLevel < 3) {
              // Level 2: 温和提示 + 尝试历史
              var histSummary = buildAttemptHistorySummary(state.currentTcId || "unknown");
              state.loopWarning = "你已连续执行相似动作。如果未达到预期效果，请：换一种方式（scroll/eval_in_page），或基于当前可见信息直接 assert。\n" +
                (histSummary ? "\n" + histSummary : "");
              log("💡 循环提示：连续 " + state.repeatCount + " 轮相似动作");
            }

            if (loopLevel >= 3) {
              // Level 3: 强警告 + 记忆 + 反思要求
              var reasons = [];
              if (state.repeatCount >= 3) reasons.push("连续 " + state.repeatCount + " 轮相同动作");
              if (oscillating) reasons.push("动作振荡");
              if (areaLoop) reasons.push("同区域反复尝试不同工具");
              var reasonStr = reasons.join("；");

              var histSummary3 = buildAttemptHistorySummary(state.currentTcId || "unknown");
              state.loopWarning = "⚠️ 检测到死循环！" + reasonStr + "。\n" +
                (histSummary3 ? histSummary3 + "\n\n" : "") +
                "## 请先反思再行动\n" +
                "在执行下一步之前，请先简要回答：\n" +
                "1. 之前的操作为什么没有达到预期？\n" +
                "2. 你接下来要采用什么**不同的策略**？\n" +
                "然后执行以下之一：\n" +
                "- 使用 select_option 模板（自动定位下拉框和选项，推荐）\n" +
                "- 使用 find_element(findBy='class', value='el-select-dropdown__item') 获取下拉选项精确坐标\n" +
                "- assert(outcome='failed') 标记当前用例失败，继续下一个\n" +
                "- 所有用例已处理则调用 finish\n" +
                "不要继续重复相同操作！";
              log("⚠️ 死循环警告：" + reasonStr);
              stream("warning", "⚠️ 死循环警告：" + reasonStr);
            }

            if (loopLevel >= 4) {
              // Level 4: 严重 + 强制要求改变策略
              state.loopWarning = "🚨 严重死循环！必须立即停止当前操作路径。\n" +
                "你已经多次尝试相同策略且未成功。请选择：\n" +
                "→ assert(outcome='inconclusive', description:'TC编号: 多次尝试后仍无法完成验证') 然后继续下一个用例\n" +
                "→ 或直接调用 finish 结束测试\n" +
                "不要再尝试相同的操作！";
              log("🚨 严重死循环警告");
              stream("warning", "🚨 严重死循环！请立即改变策略");
            }

            if (state.repeatCount >= LOOP_GUARD) {
              var guardReason = "连续 " + state.repeatCount + " 轮执行相同动作（" + roundActionSig + "）";
              log("⛔ " + guardReason + "，暂停等待用户介入");
              stream("warning", "⛔ 已暂停：" + guardReason);
              state.paused = true;
              notifyAutoPause("loop_guard");
              state.loopWarning = "⛔ " + guardReason + "，可能陷入死循环。\n" +
                "测试已暂停，请检查当前页面状态。你可以：\n" +
                "1. 输入指令引导 AI 换一种策略继续执行\n" +
                "2. 点击「继续」让 AI 自行调整\n" +
                "3. 点击「中止」结束测试";
              state.repeatCount = 0; // 重置计数，避免恢复后立即再次触发
              // 不 break，让循环继续到快照更新，下一轮顶部暂停检查会触发等待
            }
          }

          // 如果还没结束，获取新快照 + 按需截图
          if (!state.finished && !state.aborted) {
            setStatus("捕获新快照...");
            try {
              await getSnapshot();
              log("新快照: " + state.snapshot.interactiveCount + " 个可交互元素");
            } catch (e) {
              log("获取快照失败: " + (e.message || e));
            }
            // 视觉模式：仅在动作失败时自动补诊断截图。常规 UI 验证由 verify_ui 显式触发，避免每步截图拖慢执行。
            if (needDiagnosticScreenshot && deps.config.visionSupported && global.AIFT_VisualController) {
              try {
                state.screenshot = await global.AIFT_VisualController.captureAnnotatedForAI(deps.evalInPage);
                state.annotatedElements = state.screenshot.elements || [];
                log("📸 失败诊断标注截图: " + state.screenshot.width + "x" + state.screenshot.height + ", " + state.annotatedElements.length + " 个元素");
                // 通知面板展示截图
                if (deps.onStream) deps.onStream("screenshot", JSON.stringify({
                  dataUrl: state.screenshot.dataUrl,
                  width: state.screenshot.width,
                  height: state.screenshot.height,
                  elements: state.annotatedElements.length,
                  round: state.round,
                  source: "diagnostic",
                }));
              } catch (e) {
                log("📸 自动截图失败: " + (e.message || e));
                state.screenshot = null;
              }
            }
          }
        }

        // 结束
        if (state.aborted) {
          // 如果 AI 之前调用过 finish，使用其结果和摘要
          var abortResult = state.finishResult || "aborted";
          var abortSummary = state.finishSummary || "用户手动中止";
          log("用户中止" + (state.finishResult ? "（AI 之前调用了 finish: " + state.finishResult + "）" : ""));
          setStatus("已中止");
          if (deps.onFinish) deps.onFinish(abortResult, abortSummary, state.assertions, state.testCases);
        } else {
          var requestedResult = state.finishResult || "unknown";
          var reconciledResult = global.AIFT_AgentGuard && global.AIFT_AgentGuard.reconcileRunResult
            ? global.AIFT_AgentGuard.reconcileRunResult(requestedResult, state.testCases)
            : { result: requestedResult, adjusted: false, reason: "" };
          var finalResult = reconciledResult.result;
          var finalSummary = state.finishSummary || "";
          if (reconciledResult.adjusted) {
            finalSummary = (finalSummary ? finalSummary + "\n\n" : "") + "系统已校正整体结论：" + reconciledResult.reason + "。";
          }
          log("测试完成: " + finalResult + " - " + finalSummary);
          setStatus("完成: " + finalResult);
          if (deps.onFinish) deps.onFinish(finalResult, finalSummary, state.assertions, state.testCases);
        }

      } catch (e) {
        log("Agent loop 异常: " + (e.message || e));
        setStatus("异常终止");
        if (deps.onFinish) deps.onFinish("error", "异常: " + (e.message || e), state.assertions, state.testCases);
      } finally {
        state.running = false;
        // 停止网络录制
        if (global.AIFT_NetworkRecorder) {
          global.AIFT_NetworkRecorder.stop();
          log("网络请求录制已停止");
        }
        // 分离 CDP debugger
        if (global.AIFT_VisualController && global.AIFT_VisualController.isAttached()) {
          try {
            await global.AIFT_VisualController.detach();
            log("CDP debugger 已分离");
          } catch (e) {
            console.warn("[AIFT] debugger 分离失败: " + (e.message || e));
          }
        }
      }
    }

    function abort() {
      state.aborted = true;
      state.paused = false;
      // 如果正在等待恢复（暂停状态），立即解除阻塞
      if (state.resumeResolver) {
        state.resumeResolver();
        state.resumeResolver = null;
      }
      // 立即中断正在进行的 AI 请求
      if (state.abortController) {
        state.abortController.abort();
        log("已中断 AI 请求");
      } else {
        log("正在中止...");
      }
    }

    /**
     * 暂停当前 AI 请求，但保留对话状态，可通过 resume() 恢复
     */
    function pause() {
      state.paused = true;
      if (state.abortController) {
        state.abortController.abort();
        log("已暂停 AI 请求");
      } else {
        log("已暂停");
      }
    }

    /**
     * 恢复暂停的对话，继续本轮执行
     */
    function resume() {
      state.paused = false;
      if (state.turnPaused) {
        state.turnPaused = false;
        // 用户点击"继续"恢复 finish 暂停，注入提示让 AI 继续测试
        state.loopWarning = "用户点击了「继续」。请继续执行未完成的测试用例，不要再次调用 finish。";
      }
      if (state.resumeResolver) {
        state.resumeResolver();
        state.resumeResolver = null;
      }
      log("继续执行");
    }

    /**
     * 等待用户点击「继续」恢复执行
     */
    function waitForResume() {
      return new Promise(function (resolve) {
        state.resumeResolver = resolve;
      });
    }

    /**
     * 用户中途注入消息，最高优先级
     * - 中止当前正在进行的 AI 请求（如果有）
     * - 如果处于暂停状态，自动恢复
     * - 用户消息在下一轮注入，优先级高于 loopWarning
     */
    function injectMessage(msg) {
      if (!state.running || state.finished || state.aborted) {
        log("无法注入：测试未在运行中");
        return false;
      }

      // 检测用户是否要求从指定用例重新开始测试
      // 使用多模式匹配，覆盖各种自然语言表达
      var restartTcNum = detectRestartTestCase(msg, state.testCases);
      if (restartTcNum > 0) {
        var tcId = "TC" + restartTcNum;
        var foundIdx = -1;
        for (var i = 0; i < state.testCases.length; i++) {
          if ((state.testCases[i].id || "").toUpperCase() === tcId) {
            foundIdx = i;
            break;
          }
        }
        if (foundIdx >= 0) {
          // 重置该用例及之后所有用例的状态
          for (var i = foundIdx; i < state.testCases.length; i++) {
            state.testCases[i].status = (i === foundIdx) ? "testing" : "pending";
            state.testCases[i].assertionDesc = null;
          }
          state.currentTcId = tcId;
          if (!state.tcRoundCount[tcId]) state.tcRoundCount[tcId] = 0;
          // 重置循环检测
          state.repeatCount = 0;
          state.consecutiveWaitCount = 0;
          state.lastActionSig = null;
          log("🔄 用户要求从 " + tcId + " 重新开始测试，已重置用例状态");
        }
      }

      state.userIntervention = "📋 用户补充指令：" + msg + "\n请立即根据以上指令调整你的测试策略。";
      state.userInjecting = true;
      log("用户注入消息（最高优先级）: " + msg);

      // 中止当前正在进行的 AI 请求（如果有）
      if (state.abortController) {
        state.abortController.abort();
        log("已中止当前 AI 请求，注入用户消息");
      }

      // 如果处于暂停状态，自动恢复执行
      if (state.paused && state.resumeResolver) {
        state.paused = false;
        state.turnPaused = false;
        state.resumeResolver();
        state.resumeResolver = null;
        log("已从暂停状态自动恢复，注入用户消息");
      }

      return true;
    }

    return {
      run: run,
      plan: plan,
      abort: abort,
      pause: pause,
      resume: resume,
      injectMessage: injectMessage,
      getState: function () { return state; },
    };
  }

  global.AIFT_AgentLoop = { create: createAgentLoop };
})(window);
