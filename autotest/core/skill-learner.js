// skill-learner.js
// 自迭代学习器：每条用例 assert 完成后自动反思，提取操作级 Skill。
// 无阈值判断——每条用例都触发反思，由 AI 决定是否值得沉淀 skill。
// 产出物：操作级 Skill（每个 Skill 只描述一种通用操作，可跨用例复用）。
// 在 Side Panel 上下文中运行。

(function (global) {
  "use strict";

  var MAX_ATTEMPT_RECORDS = 500;

  // 复盘队列：用例完成后逐条反思，避免并发 AI 调用且不丢失任何用例
  var pendingReview = false;
  var reviewQueue = [];
  var processingReviewQueue = false;

  // ===== 辅助函数 =====

  function classifyAction(actionName, args) {
    args = args || {};
    if (actionName === "select_option" || actionName === "select_multi") return "dropdown";
    if (actionName === "fill_input" || actionName === "fill_form" || actionName === "type" || actionName === "visual_type") return "input";
    if (actionName === "click_button" || actionName === "click") return "button";
    if (actionName === "table_action") return "table";
    if (actionName === "switch_tab") return "tab";
    if (actionName === "toggle_switch") return "switch";
    if (actionName === "confirm_dialog" || actionName === "close_dialog") return "dialog";
    if (actionName === "upload_file") return "upload";
    return actionName || "unknown";
  }

  // 非交互型操作：不参与困难操作分析
  var NON_INTERACTIVE_ACTIONS = {
    assert: true, finish: true, wait: true, screenshot: true,
    verify_ui: true, eval_in_page: true, read_source: true,
    get_network_responses: true, find_element: true, use_skill: true,
  };

  function extractUrlPattern(url) {
    if (!url) return "";
    try {
      var parsed = new URL(url);
      var host = parsed.hostname || "";
      var pathParts = (parsed.pathname || "").split("/").filter(Boolean);
      if (pathParts.length > 0) return host + "/" + pathParts[0];
      return host;
    } catch (e) {
      return "";
    }
  }

  function parseAIResponse(content) {
    if (!content) return null;
    var text = String(content).trim();
    var jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) text = jsonMatch[1].trim();
    // 尝试 JSON 数组
    var arrStart = text.indexOf("[");
    var arrEnd = text.lastIndexOf("]");
    if (arrStart >= 0 && arrEnd > arrStart) {
      try { return JSON.parse(text.substring(arrStart, arrEnd + 1)); } catch (e) {}
    }
    // 尝试 JSON 对象
    var objStart = text.indexOf("{");
    var objEnd = text.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) {
      text = text.substring(objStart, objEnd + 1);
    }
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // ===== 操作尝试记录 =====

  function recordAttempt(record) {
    if (!record || !record.action) return;
    var attempts = global.__aift_learner_attempts__ || [];
    attempts.push({
      tcId: record.tcId || "",
      round: record.round || 0,
      action: record.action,
      args: record.args || {},
      ok: !!record.ok,
      result: String(record.result || "").substring(0, 300),
      reasoning: String(record.reasoning || "").substring(0, 300),
      category: classifyAction(record.action, record.args),
      isInteractive: !NON_INTERACTIVE_ACTIONS[record.action],
      timestamp: Date.now(),
    });
    if (attempts.length > MAX_ATTEMPT_RECORDS) {
      attempts = attempts.slice(-MAX_ATTEMPT_RECORDS);
    }
    global.__aift_learner_attempts__ = attempts;
  }

  function getAttemptsForTc(tcId) {
    var attempts = global.__aift_learner_attempts__ || [];
    return attempts.filter(function (a) { return a.tcId === tcId; });
  }

  // ===== 反思 prompt 构建 =====

  function buildReflectionPrompt(tcData) {
    var tc = tcData.testCase || {};
    var attempts = tcData.attempts || [];
    var parts = [];

    parts.push("# 任务：反思用例执行过程，提取操作级 Skill");
    parts.push("");
    parts.push("你是前端自动化测试的经验复盘助手。以下测试用例刚刚执行完成（耗时 " + tcData.roundCount + " 轮）。");
    parts.push("请反思执行过程中是否存在难以完成的操作——某个操作多次失败、需要换策略才成功、或一直没成功。");
    parts.push("如果存在困难操作，为每个困难操作生成一个独立的操作级 Skill，供后续同类操作直接复用。");
    parts.push("如果所有操作都顺利完成，输出空数组 []。");
    parts.push("");

    parts.push("## 用例信息");
    parts.push("- 编号: " + (tc.id || ""));
    parts.push("- 标题: " + (tc.title || ""));
    if (tc.steps) parts.push("- 操作步骤: " + tc.steps);
    if (tcData.url) parts.push("- 页面 URL: " + tcData.url);
    if (tcData.pageTitle) parts.push("- 页面标题: " + tcData.pageTitle);
    if (tcData.elementClasses) parts.push("- 页面元素特征: " + tcData.elementClasses);
    parts.push("- 断言结果: " + (tcData.outcome || "未知"));
    parts.push("- 执行轮次: " + tcData.roundCount);
    parts.push("");

    // 只分析交互型操作
    var interactive = attempts.filter(function (a) { return a.isInteractive; });
    var failures = interactive.filter(function (a) { return !a.ok; });
    var successes = interactive.filter(function (a) { return a.ok; });

    if (interactive.length === 0) {
      parts.push("## 交互操作");
      parts.push("（该用例没有交互操作）");
      parts.push("");
      parts.push("输出空数组 []");
      return parts.join("\n");
    }

    parts.push("## 交互操作统计");
    parts.push("- 总计: " + interactive.length + " 次，失败: " + failures.length + " 次，成功: " + successes.length + " 次");
    parts.push("");

    // 按操作类别分组
    var groups = {};
    for (var i = 0; i < interactive.length; i++) {
      var a = interactive[i];
      var cat = a.category || classifyAction(a.action, a.args);
      if (!groups[cat]) groups[cat] = { category: cat, failures: [], successes: [] };
      if (a.ok) groups[cat].successes.push(a);
      else groups[cat].failures.push(a);
    }

    var groupKeys = Object.keys(groups);
    var difficultGroups = groupKeys.filter(function (gk) {
      return groups[gk].failures.length > 0;
    });

    if (difficultGroups.length === 0) {
      parts.push("所有操作均一次成功，无困难操作。输出空数组 []。");
      return parts.join("\n");
    }

    for (var gi = 0; gi < difficultGroups.length; gi++) {
      var g = groups[difficultGroups[gi]];
      parts.push("### 操作类别: " + g.category + "（失败 " + g.failures.length + " 次，成功 " + g.successes.length + " 次）");

      if (g.failures.length > 0) {
        parts.push("**失败尝试：**");
        for (var fi = 0; fi < Math.min(g.failures.length, 5); fi++) {
          var fa = g.failures[fi];
          parts.push("- 第" + fa.round + "轮: " + fa.action + " " + JSON.stringify(fa.args).substring(0, 120) + " → " + (fa.result || "失败").substring(0, 150));
        }
        if (g.failures.length > 5) {
          parts.push("  …（还有 " + (g.failures.length - 5) + " 次失败）");
        }
      }

      if (g.successes.length > 0) {
        var sa = g.successes[g.successes.length - 1];
        parts.push("**最终成功：**");
        parts.push("- 第" + sa.round + "轮: " + sa.action + " " + JSON.stringify(sa.args).substring(0, 120) + " → " + (sa.result || "成功").substring(0, 150));
      } else {
        parts.push("**该类操作一直未成功**（尝试 " + g.failures.length + " 次均失败）");
      }
      parts.push("");
    }

    parts.push("## 输出格式（只输出 JSON 数组，不要其他文本）");
    parts.push("为每个困难操作生成一个操作级 Skill。如果没有任何困难操作，输出 []。");
    parts.push("```json");
    parts.push("[" + JSON.stringify({
      name: "skill-简短英文标识（如 el-select-dropdown）",
      description: "简体中文描述：什么操作场景下使用这个 skill",
      category: "dropdown/input/button/table/tab/switch/dialog/upload",
      matchPatterns: {
        urlPattern: "URL 子串或通配符，留空表示不限页面",
        elementClasses: "页面元素 class 特征（如 el-select）",
        actionType: "对应的操作类型（如 select_option）",
      },
      strategy: {
        tool: "推荐使用的工具",
        approach: "简体中文描述成功策略",
        selectors: ["推荐的选择器列表"],
        keySteps: ["关键步骤1", "关键步骤2"],
      },
      skillContent: "给 AI 的操作指令（markdown 格式，简体中文）",
    }, null, 2) + "]");
    parts.push("```");
    parts.push("");
    parts.push("原则：");
    parts.push("1. 每个 Skill 只描述一种通用操作，不绑定特定用例");
    parts.push("2. matchPatterns 只用操作特征，不用 testCaseKeywords");
    parts.push('3. 即使操作最终没成功，也要生成 Skill 记录"什么策略尝试过但失败了"');
    parts.push("4. 所有操作都顺利完成时输出空数组 []");
    parts.push("5. 只输出 JSON，不要其他文本");

    return parts.join("\n");
  }

  // ===== 核心：用例完成后反思 =====

  /**
   * 执行一条用例反思任务。反思任务由队列串行执行，保证每条已完成用例都不会丢失。
   */
  async function processReviewTask(task) {
    var config = task.config;
    var tcData = task.tcData;
    var onLog = task.onLog;
    var attempts = tcData.attempts || [];
    var interactive = attempts.filter(function (a) { return a.isInteractive; });
    var failures = interactive.filter(function (a) { return !a.ok; });
    var tcId = (tcData.testCase && tcData.testCase.id) || "";

    try {
      var prompt = buildReflectionPrompt(tcData);
      var messages = [
        { role: "system", content: "你是前端自动化测试经验复盘助手。请分析用例执行中是否存在困难操作，如有则生成操作级 Skill。只输出 JSON 数组。" },
        { role: "user", content: prompt },
      ];
      if (onLog) onLog("🔄 用例 " + tcId + " 执行完成（" + tcData.roundCount + " 轮，" + failures.length + " 次操作失败），正在反思...");

      var aiResult = await global.AIFT_AIClient.chat(config, messages, null, {
        timeout: 60000,
        maxRetries: 2,
      });
      var content = aiResult && aiResult.content ? aiResult.content : "";
      var skillData = parseAIResponse(content);
      var skillList = Array.isArray(skillData) ? skillData : (skillData ? [skillData] : []);
      if (skillList.length === 0) {
        if (onLog) onLog("ℹ️ 用例 " + tcId + " 反思完成，无需沉淀 Skill");
        return null;
      }

      var savedSkills = [];
      for (var i = 0; i < skillList.length; i++) {
        var sd = skillList[i];
        if (!sd || !sd.name) continue;
        sd.source = "self-iteration";
        sd.failureCount = failures.length;
        sd.matchPatterns = sd.matchPatterns || {};
        if (!sd.matchPatterns.urlPattern && tcData.url) {
          sd.matchPatterns.urlPattern = extractUrlPattern(tcData.url);
        }
        if (!sd.matchPatterns.elementClasses && tcData.elementClasses) {
          sd.matchPatterns.elementClasses = tcData.elementClasses;
        }
        sd.category = sd.category || classifyAction(sd.matchPatterns.actionType || "", {});
        var saved = await global.AIFT_SkillManager.saveSkill(sd);
        savedSkills.push(saved);
      }

      if (onLog && savedSkills.length > 0) {
        var names = savedSkills.map(function (s) { return s.name; }).join(", ");
        onLog("✅ 操作级 Skill 已生成: " + names + "（共 " + savedSkills.length + " 个）");
      } else if (onLog) {
        onLog("ℹ️ AI 返回了 " + skillList.length + " 个 Skill 但均无效（缺少 name 字段）");
      }
      return savedSkills.length > 0 ? savedSkills : null;
    } catch (e) {
      if (onLog) onLog("反思 AI 调用失败: " + (e.message || e));
      return null;
    }
  }

  async function processReviewQueue() {
    if (processingReviewQueue) return;
    processingReviewQueue = true;
    try {
      while (reviewQueue.length > 0) {
        var task = reviewQueue.shift();
        pendingReview = true;
        var savedSkills = null;
        try {
          savedSkills = await processReviewTask(task);
        } finally {
          pendingReview = false;
        }
        if (task.resolve) task.resolve(savedSkills);
      }
    } finally {
      pendingReview = false;
      processingReviewQueue = false;
    }
  }

  /**
   * 用例完成后加入反思队列。每条用例都会调用一次 AI，AI 返回 [] 时不保存 Skill。
   * @returns {Promise<Array|null>} 生成的操作级 skill 列表
   */
  function reviewTestCaseAndGenerateSkill(config, tcData, onLog) {
    if (!global.AIFT_AIClient || !global.AIFT_SkillManager) {
      if (onLog) onLog("Skill 学习器: AI 客户端或 Skill 管理器不可用");
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      reviewQueue.push({ config: config, tcData: tcData, onLog: onLog, resolve: resolve });
      processReviewQueue();
    });
  }

  // ===== 清理与调试 =====

  function resetAttempts() {
    global.__aift_learner_attempts__ = [];
  }

  function getAttempts() {
    return global.__aift_learner_attempts__ || [];
  }

  function isPending() {
    return pendingReview;
  }

  global.AIFT_SkillLearner = {
    recordAttempt: recordAttempt,
    reviewTestCaseAndGenerateSkill: reviewTestCaseAndGenerateSkill,
    getAttemptsForTc: getAttemptsForTc,
    resetAttempts: resetAttempts,
    getAttempts: getAttempts,
    isPending: isPending,
    classifyAction: classifyAction,
  };
})(window);
