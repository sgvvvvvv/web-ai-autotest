// prompt-builder.js
// 构建 system prompt + tools schema + 每轮消息
// 在 Side Panel 上下文中运行

(function (global) {
  "use strict";

  var MAX_SOURCE_PER_MSG = 5;
  var MAX_SOURCE_CHARS = 6000;
  var MAX_SNAPSHOT_NODES = 60;

  /**
   * 构建基础系统提示词（根据视觉能力动态调整）
   * 当模型不支持视觉时，移除所有视觉相关工具和指令引用
   */
  function buildSystemPromptBase(visionSupported) {
    var lines = [
      "# 角色",
      visionSupported
        ? "你是一个前端自动化测试 Agent。通过工具操作浏览器、截图验证页面、检查 API 数据，完成测试用例。"
        : "你是一个前端自动化测试 Agent。通过工具操作浏览器、检查 API 数据，完成测试用例。",
      "",
      "# 核心原则",
      "1. 每轮返回一个工具调用，不要只分析不行动",
      "2. 操作优先使用预设模板（select_option/select_multi/fill_input/click_button 等），简单直接；下拉或级联选择都使用 select_option，不要拆成多轮点击",
      "3. 若上下文给出「源码交互契约」，必须按契约使用对应模板；截图标注编号只能传给 smart_click(label)，绝不能拼成 click 的 CSS selector。",
      "4. 当前目标默认是测试环境。测试用例明确要求的新增、编辑、保存、提交、删除、确认删除、上传、下载和状态切换均已获授权，必须通过真实 UI/CDP 执行；严禁以“避免修改后端数据”或“担心数据影响”为由跳过。",
      "5. 不得用源码配置、静态 DOM 或推断替代要求的运行时 CRUD 验证。写操作后必须观察成功反馈、列表/详情刷新或对应网络响应；删除操作必须执行二次确认。",
      visionSupported
        ? "6. 找不到元素时用 find_element 或 screenshot 标注获取准确坐标/selector"
        : "6. 找不到元素时用 find_element 获取准确坐标和 selector，不要请求或依赖截图",
    ];
    if (visionSupported) {
      lines.push("7. 需要验证页面展示时用 verify_ui 截图");
      lines.push("8. 需要验证 API 数据时用 get_network_responses");
      lines.push("9. 断言描述以 TC 编号开头并带状态图标；失败必须说明具体证据。");
      lines.push("10. 当前场景还有待测关联用例时，必须保留页面、弹窗、筛选和输入状态；严禁执行恢复、清空或返回原页。仅在场景最后一个用例结束且后续场景不兼容时才清理。");
      lines.push("11. 连续 3 次相同操作未成功，换策略或标记失败");
      lines.push("12. 所有文本使用简体中文");
    } else {
      lines.push("7. 当前模型不支持图片：严禁调用或建议 screenshot、verify_ui、visual_click、smart_click 等视觉工具");
      lines.push("8. 需要验证 API 数据时用 get_network_responses");
      lines.push("9. 用 eval_in_page 检查元素文本、属性、class、可见性和尺寸，验证 UI 状态");
      lines.push("10. 断言描述以 TC 编号开头并带状态图标；失败必须说明具体证据。");
      lines.push("11. 当前场景还有待测关联用例时，必须保留页面、弹窗、筛选和输入状态；严禁执行恢复、清空或返回原页。仅在场景最后一个用例结束且后续场景不兼容时才清理。");
      lines.push("12. 连续 3 次相同操作未成功，换策略或标记失败");
      lines.push("13. 所有文本使用简体中文");
    }
    lines.push(
      "",
      "# 工具使用",
      "- 预设模板：select_option（含普通下拉与级联选择）/select_multi/fill_input/click_button/fill_form/table_action/switch_tab/close_dialog/confirm_dialog/toggle_switch",
      "- 基础操作：click(selector)/type(selector,text)/press(key)/scroll(selector?)/hover(selector) — 默认通过 CDP 真实鼠标/键盘执行。弹框内关闭下拉浮层时不要主动使用 Escape，应点击浮层外的弹框安全区域。",
      "- 查找元素：find_element(findBy,value) — 找不到元素时用这个获取准确坐标和 selector",
      "- 页面 JS：eval_in_page(code) — 读取页面状态（不要用来模拟操作）",
      "- iframe：快照中的 [ref:f<frameId>:e<编号>] 表示该元素位于对应 iframe。跨域 iframe 必须使用这个 elementRef，并使用 click/type/scroll/hover 基础操作；不要用预设模板或尝试从父页面读取它的 DOM。",
    );
    if (visionSupported) {
      lines.push("- 截图验证：verify_ui() — 截图检查页面展示是否正确");
    }
    lines.push(
      "- API 数据：get_network_responses(urlPattern) — 获取网络响应",
      "- 源码检索：read_source(filePattern) — 查看项目源码",
      "- 断言：assert(description, outcome, fieldMappings?)；表格/列表与 API 一致性通过时 fieldMappings 必填",
      "- 完成：finish(result, summary)",
      "",
      "# 断言标准",
      "FAILED 条件（任一）：已直接观察到 API 字段为空/null/缺失、页面展示不一致、功能异常或 UI 异常。",
      "PASSED 条件（全部）：当前 TC 的每项预期均已通过真实页面、网络响应、截图或源码与运行时证据交叉直接验证。",
      "数据展示类 PASSED 额外条件：用例预期必须定义「字段映射：页面列头 <- API字段」；assert 必须提交至少 2 条 fieldMappings，每条包含 uiLabel、apiField、pageValue、apiValue，且页面列头和网络响应字段均已观察到。没有映射或映射语义不明确时只能 inconclusive。",
      "INCONCLUSIVE 条件：因权限、浏览器限制、缺少可控测试数据、原生文件选择器等原因，至少一项预期未能直接验证。此时绝不能写 passed；调用 assert(outcome='inconclusive') 并明确列出未验证项。",
      "",
      "# 表格数据提取",
      "按行提取，不要扁平化：",
      "  Array.from(document.querySelectorAll('tbody tr')).map(function(tr){return Array.from(tr.querySelectorAll('td')).map(function(td){return td.textContent.trim()}).join(',')}).join('\\n')",
      "",
      "# 完成规则",
      "- 每个用例断言后开始下一个",
      "- 全部完成后调用 finish",
    );
    return lines.join("\n");
  }

  var SYSTEM_PROMPT_VISION = [
    "",
    "# 视觉能力",
    "你具备视觉能力，可以使用 verify_ui 截图验证页面展示效果。",
    "系统会在初始状态和动作失败时提供标注截图；常规 UI 验证请主动调用 verify_ui。",
    "",
    "## verify_ui 使用场景",
    "- 打开下拉框后 → 验证下拉选项展示正确",
    "- 切换 Tab 后 → 验证内容渲染正确",
    "- 打开弹窗后 → 验证弹窗布局",
    "- 数据加载后 → 验证表格/列表渲染",
    "",
    "## 坐标操作（仅限特殊场景）",
    "visual_click(x,y) 仅用于 Canvas/SVG/Shadow DOM、普通定位失败或需要按截图坐标操作的场景。",
    "同一位置 visual_click 失败 2 次后，换用预设模板、find_element 或 smart_click(label)。",
  ].join("\n");
  /**
   * 借鉴 OpenCode 的 SystemPrompt.environment（system.ts 行 60-95）
   * 将环境信息与指令分离，环境信息包含运行时上下文
   */
  function buildEnvironmentContext(visionSupported) {
    return [
      "# 环境信息",
      "<env>",
      "  运行环境: Chrome Side Panel 扩展",
      "  操作方式: CDP 真实鼠标/键盘执行写操作；Content Script 仅用于观察",
      "  源码读取: 用户上传项目源码文件",
      "  网络监听: 通过 CDP Network 域自动捕获页面所有 API 请求和响应",
      "  数据写入授权: 默认测试环境。执行测试用例要求的 CRUD、保存、提交、删除及确认删除，无需因数据影响顾虑而跳过。",
      "  视觉能力: " + (visionSupported ? "支持（可截图分析）" : "不支持"),
      "</env>",
    ].join("\n");
  }

  /**
   * 构建 system prompt（借鉴 OpenCode 的分层结构：environment + instructions + vision）
   */
  function buildSystemPrompt(visionSupported) {
    // 借鉴 OpenCode 的 system.ts：system = [env, instructions, ...skills/mcp]
    var parts = [buildEnvironmentContext(visionSupported), buildSystemPromptBase(visionSupported)];
    if (visionSupported) {
      parts.push(SYSTEM_PROMPT_VISION);
    }
    return parts.join("\n\n");
  }

  /**
   * 构建 system + 每轮消息
   * @param {Object} params
   *   - requirement: string 原始需求
   *   - testCases: string 测试用例
   *   - sourceFiles: Array<{path, content}>
   *   - snapshot: Object DOM 快照
   *   - screenshot: Object 截图数据 {dataUrl, width, height}（视觉模式）
   *   - history: Array<{action, result}>
   *   - conversationHistory: Array 历史对话
   *   - visionSupported: boolean 模型是否支持图片（默认 true）
   *   - architecture: Object 项目架构分析结果
   * @returns {Array} OpenAI 消息数组
   */
  function buildMessages(params) {
    var messages = [];
    var visionSupported = params.visionSupported !== false;
    messages.push({ role: "system", content: buildSystemPrompt(visionSupported) });

    var hasHistory = params.conversationHistory && params.conversationHistory.length > 0;

    if (!hasHistory) {
      // 首轮：构建初始用户消息（需求 + 用例 + 架构 + 源码 + 初始快照 + 初始截图）
      var initialContent = buildInitialUserMessage(params);
      if (visionSupported && params.screenshot && params.screenshot.dataUrl) {
        // 视觉模式：多模态初始消息（文本 + 截图）
        messages.push({
          role: "user",
          content: global.AIFT_AIClient.buildVisionContent(initialContent, params.screenshot.dataUrl),
        });
      } else {
        messages.push({ role: "user", content: initialContent });
      }
    } else {
      // 后续轮次：重放对话历史
      // 视觉模式上下文管理：清除历史消息中的旧截图（只保留最新截图）
      for (var i = 0; i < params.conversationHistory.length; i++) {
        var m = params.conversationHistory[i];
        var msg = { role: m.role };
        // 清除历史消息中的图片（节省上下文 token）
        if (m.content && Array.isArray(m.content)) {
          // 多模态消息：只保留文本部分，移除 image_url
          var textParts = [];
          for (var j = 0; j < m.content.length; j++) {
            if (m.content[j].type === "text") {
              textParts.push(m.content[j].text);
            }
          }
          msg.content = textParts.join("\n") || "";
        } else if (m.role === "assistant" && m.tool_calls) {
          msg.content = (m.content && m.content.length > 0) ? m.content : null;
        } else if (m.content !== undefined) {
          msg.content = m.content || "";
        }
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.name) msg.name = m.name;
        messages.push(msg);
      }
      // 当前观察：最新快照 + 测试进度 + 历史
      var observationText = buildObservationMessage({
        snapshot: params.snapshot,
        screenshot: params.screenshot,
        testCases: params.testCasesState,
        networkSummary: params.networkSummary,
        history: params.history,
        currentTcId: params.currentTcId,
        currentTcRounds: params.currentTcRounds,
        maxTcRounds: params.maxTcRounds,
        recoveryReserveRounds: params.recoveryReserveRounds,
      });
      if (visionSupported && params.screenshot && params.screenshot.dataUrl) {
        // 视觉模式：多模态观察消息（文本 + 截图）
        messages.push({
          role: "user",
          content: global.AIFT_AIClient.buildVisionContent(observationText, params.screenshot.dataUrl),
        });
      } else {
        messages.push({ role: "user", content: observationText });
      }
    }

    return messages;
  }

  function buildInitialUserMessage(params) {
    var parts = [];
    // 注入上下文摘要（来自之前用例的执行状态）
    if (params.summary && global.AIFT_SummaryCache) {
      var summaryText = global.AIFT_SummaryCache.formatForPrompt(params.summary);
      if (summaryText) {
        parts.push(summaryText);
      }
    }
    // 注入方案分析结果（已移除方案分析阶段，直接执行）
    parts.push("## 测试需求");
    parts.push(params.requirement || "（未提供）");
    parts.push("");
    parts.push("## 测试用例");
    parts.push(params.testCases || "（未提供）");
    parts.push("");

    // 注入项目架构概览
    if (params.architecture && global.AIFT_ProjectAnalyzer) {
      var archText = global.AIFT_ProjectAnalyzer.formatForPrompt(params.architecture);
      if (archText) {
        parts.push(archText);
        parts.push("");
      }
    }

    if (params.sourceInteractions && params.sourceInteractions.length > 0) {
      parts.push("## 源码交互契约（优先执行）");
      for (var si = 0; si < params.sourceInteractions.length; si++) {
        var interaction = params.sourceInteractions[si];
        parts.push("- " + interaction.kind + ": trigger=" + interaction.triggerSelector +
          "; reveal=" + (interaction.reveal || "click") +
          "; activation=" + interaction.activationSelector +
          (interaction.applySelector ? "; apply=" + interaction.applySelector : "") +
          "。使用 select_multi/select_option，不要直接点击文字。");
      }
      parts.push("");
    }

    if (params.scenarioPlan && params.scenarioPlan.length > 0) {
      parts.push("## 执行场景计划");
      params.scenarioPlan.forEach(function (scenario) {
        parts.push("- " + scenario.id + "（" + scenario.title + "）：" + scenario.cases.join(" -> ") + "。共享 setup 的用例保留页面状态，但每个 TC 必须分别 assert；状态变更用例已独立隔离。" + (scenario.rationale ? " 分组依据：" + scenario.rationale : ""));
      });
      parts.push("");
    }

    var srcText = formatSourceFiles(params.sourceFiles);
    if (srcText) {
      parts.push(srcText);
      parts.push("");
      // 注入源码组件分析（结构化的选择器、选项、绑定信息）
      if (global.AIFT_SourceAnalyzer && params.sourceFiles) {
        var compAnalysis = global.AIFT_SourceAnalyzer.analyzeFiles(
          params.sourceFiles.reduce(function(obj, sf) { obj[sf.path] = sf.content; return obj; }, {})
        );
        if (compAnalysis) {
          parts.push(compAnalysis);
          parts.push("");
        }
      }
    }

    parts.push("## 初始 DOM 快照");
    parts.push(formatSnapshot(params.snapshot));

    // 视觉模式：提示截图已附在消息中
    if (params.visionSupported !== false && params.screenshot && params.screenshot.dataUrl) {
      parts.push("");
      parts.push("## 初始页面标注截图");
      parts.push("截图已附在消息中（" + params.screenshot.width + "x" + params.screenshot.height + " 像素）。");
      parts.push("截图中每个可交互元素上有红色编号标签，可参考编号位置。优先使用预设模板；基础 click/type 会通过 CDP 执行；找不到稳定 selector 时可用 smart_click(label)。");
    }

    if (params.extraPrompt) {
      parts.push("");
      parts.push("## 用户额外提示词");
      parts.push(params.extraPrompt);
    }

    parts.push("");
    if (params.visionSupported !== false) {
      parts.push("请根据标注截图和以上信息开始测试。优先使用预设模板和 click/type 等 CDP 真实操作，需要验证页面展示时调用 verify_ui 截图。完成后调用 finish（将暂停对话等待用户确认）。");
    } else {
      parts.push("请根据以上信息开始测试。先观察页面，然后逐步执行动作并断言，完成后调用 finish（将暂停对话等待用户确认）。");
    }
    return parts.join("\n");
  }

  function buildObservationMessage(params) {
    var parts = [];
    function stepsForCurrentScenario(steps, deferRecovery) {
      var text = String(steps || "");
      if (!deferRecovery) return text;
      return text.replace(/\s*(?:→|\-|;|；)?\s*恢复[：:][\s\S]*$/, "").trim();
    }
    // 视觉模式：截图已附在消息中，提示 AI 优先看截图
    if (params.screenshot && params.screenshot.dataUrl) {
      parts.push("## 操作后的标注截图");
      parts.push("截图已附在消息中（" + params.screenshot.width + "x" + params.screenshot.height + " 像素）。");
      parts.push("截图中每个可交互元素上有红色编号标签，可参考编号位置。优先使用预设模板；基础 click/type 会通过 CDP 执行；找不到稳定 selector 时可用 smart_click(label)。");
      parts.push("");
    }
    parts.push("## DOM 快照（辅助参考）");
    parts.push(formatSnapshot(params.snapshot));

    // 注入当前页面提醒
    var currentUrl = (params.snapshot && params.snapshot.url) ? params.snapshot.url : "";
    var currentTitle = (params.snapshot && params.snapshot.title) ? params.snapshot.title : "";
    if (currentUrl || currentTitle) {
      parts.push("");
      parts.push("## 当前页面上下文");
      parts.push("URL: " + currentUrl);
      parts.push("标题: " + currentTitle);
    }

    // 注入测试用例进度
    if (params.testCases && params.testCases.length > 0) {
      parts.push("");
      parts.push("## 测试用例进度");
      var currentTC = null;
      var nextTC = null;
      var currentScenarioPending = 0;
      for (var i = 0; i < params.testCases.length; i++) {
        var tc = params.testCases[i];
        var statusIcon = tc.status === "passed" ? "✓" : (tc.status === "failed" ? "✗" : (tc.status === "inconclusive" ? "?" : (tc.status === "testing" ? "→" : (tc.status === "skipped" ? "⊘" : "○"))));
        var line = statusIcon + " " + (tc.id || ("TC" + (i + 1))) + " | " + (tc.title || tc.text);
        if (tc.page) line += " | 页面: " + tc.page;
        if (tc.status === "testing") {
          line = "▶ " + line + "（当前正在测试）";
          currentTC = tc;
        }
        parts.push(line);
        if (!nextTC && tc.status === "pending") {
          nextTC = tc;
        }
      }
      parts.push("");
      if (currentTC) {
        parts.push("当前用例：" + (currentTC.id || "") + " - " + (currentTC.title || currentTC.text));
        if (currentTC.scenarioId) {
          for (var spi = 0; spi < params.testCases.length; spi++) {
            var peer = params.testCases[spi];
            if (peer.scenarioId === currentTC.scenarioId && peer.status === "pending") currentScenarioPending++;
          }
          if (currentScenarioPending > 0) {
            parts.push("共享执行场景：" + (currentTC.scenarioTitle || currentTC.scenarioId) + "。本场景还有 " + currentScenarioPending + " 个待执行用例；保留当前页面/弹框/模块状态，不要重复打开或导航。恢复步骤延后到场景最后一个用例。");
          }
        }
        var currentTcRounds = params.currentTcRounds || 0;
        var maxTcRounds = params.maxTcRounds || 30;
        var reserveRounds = params.recoveryReserveRounds || 2;
        var roundsLeft = Math.max(0, maxTcRounds - currentTcRounds);
        if (roundsLeft <= reserveRounds + 1) {
          parts.push("🚨 收尾预算：当前用例已执行 " + currentTcRounds + "/" + maxTcRounds + " 轮，剩余 " + roundsLeft + " 轮。");
          if (roundsLeft > reserveRounds) {
            parts.push(currentScenarioPending > 0
              ? "本场景仍有待测关联用例：本轮不得执行恢复、清空或返回原页；仅完成当前用例断言后继续下一个关联用例。"
              : "本轮仅用于完成必要的场景切换清理；不得继续探索、重试或收集非必要数据。下一轮必须 assert。");
          } else {
            parts.push("立即停止所有测试操作。基于已获得证据调用 assert；即使恢复未完成，也要在断言中如实说明。不得开始下一个 TC，也不得再尝试页面交互。");
          }
        }
        if (currentTC.page) parts.push("测试页面：" + currentTC.page);
        if (currentTC.preconditions) parts.push("前置条件：" + currentTC.preconditions);
        if (currentTC.steps) {
          parts.push("操作步骤（请严格按步骤执行，使用步骤中标注的工具和参数）：");
          parts.push(stepsForCurrentScenario(currentTC.steps, currentScenarioPending > 0));
        }
        if (currentTC.expected) parts.push("预期结果：" + currentTC.expected);
        // 断言 TC 编号提醒 + 内容相关性提醒
        parts.push("⚠️ 断言要求（极其重要）：");
        parts.push("  1. 断言描述必须以「" + (currentTC.id || "") + ":」开头，不要使用其他 TC 编号");
        parts.push("  2. 断言内容必须针对当前用例的实际测试目标，严禁复制其他用例的断言文本");
        parts.push("  3. 当前用例标题：" + (currentTC.title || "（无）"));
        if (currentTC.expected) {
          parts.push("  4. 当前用例预期结果：" + currentTC.expected);
          parts.push("  5. 断言必须验证以下内容：" + currentTC.expected);
        }
        parts.push("  6. 断言中必须体现对操作步骤结果的验证，而非页面导航/菜单层级等无关内容");
        // 页面一致性检查
        if (currentTC.page && currentTitle) {
          var pageLower = currentTC.page.toLowerCase();
          var titleLower = currentTitle.toLowerCase();
          var urlLower = (currentUrl || "").toLowerCase();
          var pageKey = pageLower.replace(/页面$/, "");
          if (pageKey && titleLower.indexOf(pageKey) === -1 && urlLower.indexOf(pageKey) === -1) {
            parts.push("⚠️ 页面不一致：当前(" + currentTitle + ") ≠ 目标(" + currentTC.page + ")，请先导航。");
          }
        }
        // UI 交互验证提醒
        var tcFullText = ((currentTC.title || "") + " " + (currentTC.steps || "") + " " + (currentTC.expected || "")).toLowerCase();
        var uiHints = [];
        if (/loading|加载|加载中/.test(tcFullText)) uiHints.push("loading");
        if (/防抖|节流|连续点击|重复提交|禁用/.test(tcFullText)) uiHints.push("防抖/禁用");
        if (/刷新|更新|创建|编辑|删除|新增|保存/.test(tcFullText)) uiHints.push("数据刷新");
        if (/hover|tooltip|悬浮|省略|截断|溢出/.test(tcFullText)) uiHints.push("tooltip");
        if (/校验|必填|错误提示/.test(tcFullText)) uiHints.push("表单校验");
        if (/弹窗|对话框|抽屉|modal|drawer|遮罩/.test(tcFullText)) uiHints.push("弹窗交互");
        if (/空状态|暂无数据|empty|无数据/.test(tcFullText)) uiHints.push("空状态");
        if (/提示|toast|message|通知|反馈/.test(tcFullText)) uiHints.push("操作反馈");
        if (uiHints.length > 0) {
          parts.push("UI 交互关注点：" + uiHints.join("、") + "（用 eval_in_page 检查）");
        }
        if (/新增|创建|编辑|保存|提交|删除|确认删除|上传|下载|更新/.test(tcFullText)) {
          parts.push("🚨 写操作执行授权：当前为测试环境。必须执行本用例要求的真实 CRUD/提交/删除与确认步骤；不得因担心修改后端数据而跳过。完成后用 get_network_responses 验证对应接口和页面刷新；本场景仍有关联用例时必须保留当前状态。 ");
        }
        // 数据验证提醒
        if (/数据|指标|列表|表格|数值|展示|显示|查询|搜索|详情/.test(tcFullText)) {
          parts.push("⚠️ 严格数据验证：调用 get_network_responses 逐字段检查 API 响应，字段为空/null/缺失或页面展示不一致则 FAIL。");
        }
      } else if (nextTC) {
        parts.push("建议下一个用例：" + (nextTC.id || "") + " - " + (nextTC.title || nextTC.text) + "（也可选择其他待执行用例）");
        if (nextTC.scenarioId) {
          var scenarioAlreadyPrepared = params.testCases.some(function(tc) {
            return tc.scenarioId === nextTC.scenarioId && (tc.status === "passed" || tc.status === "failed" || tc.status === "inconclusive");
          });
          if (scenarioAlreadyPrepared) {
            parts.push("共享执行场景仍有效：复用当前页面/弹框/模块状态；不要重复执行打开弹框、导航等已完成 setup，只验证本用例并单独 assert。");
          }
        }
        if (nextTC.page) parts.push("测试页面：" + nextTC.page);
        if (nextTC.preconditions) parts.push("前置条件：" + nextTC.preconditions);
        if (nextTC.steps) parts.push("操作步骤：" + nextTC.steps);
        if (nextTC.expected) parts.push("预期结果：" + nextTC.expected);
        if (nextTC.page && currentTitle) {
          var nextPageLower = nextTC.page.toLowerCase();
          var nextTitleLower = currentTitle.toLowerCase();
          var nextUrlLower = (currentUrl || "").toLowerCase();
          var nextPageKey = nextPageLower.replace(/页面$/, "");
          if (nextPageKey && nextTitleLower.indexOf(nextPageKey) === -1 && nextUrlLower.indexOf(nextPageKey) === -1) {
            parts.push("⚠️ 需先导航到「" + nextTC.page + "」");
          }
        }
      }
    }

    if (params.networkSummary !== undefined) {
      parts.push("");
      parts.push("## 已捕获的网络请求");
      if (params.networkSummary && params.networkSummary.length > 0) {
        parts.push("共 " + params.networkSummary.length + " 条（调用 get_network_responses 查看响应体）：");
        for (var i = 0; i < Math.min(params.networkSummary.length, 15); i++) {
          var n = params.networkSummary[i];
          parts.push("  [" + n.id + "] " + n.method + " " + n.status + " " + n.url);
        }
        if (params.networkSummary.length > 15) {
          parts.push("  …（还有 " + (params.networkSummary.length - 15) + " 条）");
        }
      } else {
        parts.push("（暂无 API 请求）");
      }
    }

    if (params.history && params.history.length > 0) {
      parts.push("");
      parts.push("## 已执行动作历史");
      parts.push(formatHistory(params.history));
    }

    parts.push("");
    // 根据当前状态给出明确的下一步指令
    if (currentTC && currentTC.status === "testing" && !currentTC.assertionDesc) {
      // 检查当前用例是否还有恢复步骤未执行
      var hasRecoveryStep = currentTC.steps && currentTC.steps.indexOf("恢复：") !== -1;
      var recentActions = (params.history || []).slice(-3).map(function(h) { return h.action; }).join(" ");
      var hasAsserted = recentActions.indexOf("assert") !== -1;
      var currentRounds = params.currentTcRounds || 0;
      var maxRounds = params.maxTcRounds || 30;
      var reserve = params.recoveryReserveRounds || 2;
      if (maxRounds - currentRounds <= reserve) {
        parts.push("→ 收尾轮次已到：现在必须调用 assert，不再执行恢复或其他页面操作。");
      } else if (hasRecoveryStep && currentScenarioPending > 0) {
        parts.push("→ 当前场景还有共享用例待执行：先 assert 当前用例，保留状态；不要执行恢复步骤。");
      } else if (hasRecoveryStep && !hasAsserted) {
        parts.push("→ 当前用例文本包含旧版「恢复：」步骤。先完成业务验证并 assert；恢复动作由场景边界统一决定，不要在此用例中执行。");
      } else {
        parts.push("→ 请继续执行当前用例操作或调用 assert 断言。");
      }
    } else if (!currentTC && nextTC) {
      parts.push("→ 请选择一个待执行的用例开始测试。");
    } else if (!currentTC && !nextTC) {
      parts.push("→ 所有用例已完成，请调用 finish（将暂停对话等待用户确认）。");
    } else {
      parts.push("→ 请根据当前页面状态执行下一步操作。");
    }
    return parts.join("\n");
  }

  /**
   * 格式化源码片段
   */
  function formatSourceFiles(sourceFiles) {
    if (!sourceFiles || sourceFiles.length === 0) return "";
    var parts = ["## 相关源码"];
    var count = Math.min(MAX_SOURCE_PER_MSG, sourceFiles.length);
    for (var i = 0; i < count; i++) {
      var f = sourceFiles[i];
      var content = f.content || "";
      if (content.length > MAX_SOURCE_CHARS) {
        content = content.slice(0, MAX_SOURCE_CHARS) + "\n…（已截断）";
      }
      parts.push("### " + f.path);
      parts.push("```");
      parts.push(content);
      parts.push("```");
    }
    return parts.join("\n");
  }

  /**
   * 格式化 DOM 快照为紧凑文本
   * 格式：<tag attr="value"> 文本  [selector: ...]
   */
  function formatSnapshot(snapshot) {
    if (!snapshot) return "（无快照）";
    var parts = [];
    parts.push("URL: " + (snapshot.url || ""));
    parts.push("Title: " + (snapshot.title || ""));
    parts.push("可交互元素: " + (snapshot.interactiveCount || 0) + " 个");
    if (snapshot.frames && snapshot.frames.length > 1) {
      parts.push("Frame: " + snapshot.frames.map(function(frame) {
        return "iframe-" + frame.frameId + "(" + (frame.title || frame.url || "无标题") + ", " + frame.interactiveCount + " 个元素)";
      }).join("; "));
      parts.push("跨域 iframe 元素必须使用带 frameId 的 elementRef，例如 [ref:f12:e3]。");
    }
    parts.push("");

    // 长顶层页面不能挤掉 iframe 内的可操作元素；frame 节点优先进入模型上下文。
    var nodes = (snapshot.nodes || []).slice().sort(function(a, b) {
      return (a.frameId === 0 ? 1 : 0) - (b.frameId === 0 ? 1 : 0);
    });
    var count = Math.min(MAX_SNAPSHOT_NODES, nodes.length);
    // 检测 UI 交互状态元素
    var uiStateElements = [];
    for (var i = 0; i < count; i++) {
      var n = nodes[i];
      var line = "<" + n.tag;
      var attrs = [];
      if (n.type) attrs.push('type="' + n.type + '"');
      if (n.role) attrs.push('role="' + n.role + '"');
      if (n.id) attrs.push('id="' + n.id + '"');
      if (n.name) attrs.push('name="' + n.name + '"');
      if (n.placeholder) attrs.push('placeholder="' + n.placeholder + '"');
      if (n.href) attrs.push('href="' + n.href + '"');
      if (n.className) attrs.push('class="' + n.className + '"');
      if (attrs.length > 0) line += " " + attrs.join(" ");
      line += ">";
      if (n.ref) line += "  [ref:" + n.ref + "]";
      if (n.frameId !== undefined && n.frameId !== 0) line += "  [iframe:" + n.frameId + "]";
      if (n.text) line += " " + n.text;
      if (n.value) line += ' value="' + n.value + '"';
      if (n.inFloatingLayer) line += "  [浮层元素]";
      // 展示坐标信息（让 AI 无需截图即可获得精确坐标）
      if (n.x !== undefined && n.y !== undefined) {
        line += '  [xy:' + n.x + ',' + n.y;
        if (n.w && n.h) line += ' ' + n.w + 'x' + n.h;
        line += ']';
      }
      // 展示建议的 selector
      if (n.selector) line += '  [sel: ' + n.selector + ']';
      parts.push(line);

      // 检测 UI 交互相关元素
      var cls = (n.className || "").toLowerCase();
      var tag = (n.tag || "").toLowerCase();
      // loading 相关
      if (/loading|spinner|skeleton|spin/.test(cls)) {
        uiStateElements.push("loading: <" + tag + ' class="' + n.className + '"> ' + (n.text || ""));
      }
      // disabled 按钮
      if (tag === "button" && /disabled/.test(cls)) {
        uiStateElements.push("disabled-btn: <button class=\"" + n.className + '"> ' + (n.text || ""));
      }
      // tooltip / popover
      if (/tooltip|popover|popper/.test(cls)) {
        uiStateElements.push("tooltip: <" + tag + ' class="' + n.className + '"> ' + (n.text || ""));
      }
      // 空状态
      if (/empty|no-data|no_data|暂无/.test(cls) || /暂无数据|暂无记录|no data|empty/i.test(n.text || "")) {
        uiStateElements.push("empty-state: <" + tag + ' class="' + n.className + '"> ' + (n.text || ""));
      }
      // 消息提示
      if (/message|notification|toast|alert/.test(cls)) {
        uiStateElements.push("message: <" + tag + ' class="' + n.className + '"> ' + (n.text || ""));
      }
      // 遮罩层
      if (/mask|overlay|modal-backdrop/.test(cls)) {
        uiStateElements.push("mask: <" + tag + ' class="' + n.className + '">');
      }
      // 表单校验错误
      if (/error|invalid|is-error|form-item-error/.test(cls)) {
        uiStateElements.push("form-error: <" + tag + ' class="' + n.className + '"> ' + (n.text || ""));
      }
    }

    if (nodes.length > count) {
      parts.push("…（还有 " + (nodes.length - count) + " 个元素未显示）");
    }

    // 输出检测到的 UI 交互状态元素
    if (uiStateElements.length > 0) {
      parts.push("");
      parts.push("## 检测到的 UI 交互状态元素");
      for (var ui = 0; ui < uiStateElements.length; ui++) {
        parts.push("  " + uiStateElements[ui]);
      }
    }

    if (snapshot.pageText) {
      parts.push("");
      parts.push("## 页面可见文本（标题/指标/数据）");
      parts.push(snapshot.pageText);
    }
    return parts.join("\n");
  }

  /**
   * 格式化动作历史
   */
  function formatHistory(history) {
    if (!history || history.length === 0) return "（无）";
    var parts = [];
    var len = Math.min(history.length, 20);
    for (var i = 0; i < len; i++) {
      var h = history[i];
      parts.push((i + 1) + ". " + h.action + " → " + (h.result || "ok"));
    }
    if (history.length > len) {
      parts.push("…（还有 " + (history.length - len) + " 条更早记录）");
    }
    return parts.join("\n");
  }

  /**
   * 构建 OpenAI function calling 工具集
   * 对应 agent-loop.js executeAction 支持的动作
   * @param {Object} options - { visionSupported: boolean } 是否包含视觉工具
   */
  function buildTools(options) {
    options = options || {};
    var tools = [
      {
        type: "function",
        function: {
          name: "click",
          description: "点击最新 DOM 快照中的 elementRef（优先）或已观察到的 CSS selector。通过 CDP 真实鼠标移动/按下/释放执行。不得猜测 selector；未观察到时先调用 find_element。",
          parameters: {
            type: "object",
            properties: {
              elementRef: { type: "string", description: "最新 DOM 快照中元素的引用，如 e12。优先使用。" },
              selector: { type: "string", description: "仅限最新快照、find_element 结果或源码交互契约中出现过的 CSS selector。" },
            },
            anyOf: [{ required: ["elementRef"] }, { required: ["selector"] }],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "type",
          description: "在指定输入框中输入文本：通过 CDP 真实点击聚焦、全选删除、键盘输入，并验证输入结果。",
          parameters: {
            type: "object",
            properties: {
              elementRef: { type: "string", description: "最新 DOM 快照中输入元素的引用，如 e12。优先使用。" },
              selector: { type: "string", description: "已观察到的 CSS 选择器。" },
              text: { type: "string", description: "要输入的文本" },
            },
            required: ["text"],
            anyOf: [{ required: ["elementRef"] }, { required: ["selector"] }],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "press",
          description: "模拟键盘按键，如 Enter / Tab / Escape。弹框内存在浮层时，Escape 会被安全拦截以避免关闭父弹框。",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string", description: "按键名，如 Enter、Tab、Escape、ArrowDown" },
            },
            required: ["key"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "scroll",
          description: "滚动到指定 CSS 选择器匹配的元素，或省略 selector 滚动页面。默认通过 CDP 真实滚轮执行。",
          parameters: {
            type: "object",
            properties: {
              elementRef: { type: "string", description: "最新 DOM 快照中要滚动到的元素引用（可选）。" },
              selector: { type: "string", description: "已观察到的 CSS 选择器（可选）。" },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "hover",
          description: "模拟鼠标悬停到指定元素。默认通过 CDP 真实 mouseMoved 执行，用于触发 tooltip、hover 菜单等效果。",
          parameters: {
            type: "object",
            properties: {
              elementRef: { type: "string", description: "最新 DOM 快照中元素的引用，如 e12。优先使用。" },
              selector: { type: "string", description: "已观察到的 CSS 选择器。" },
            },
            anyOf: [{ required: ["elementRef"] }, { required: ["selector"] }],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "surface_interact",
          description: "对 Canvas、SVG、视频画面或其他自绘交互面执行真实 CDP 点击/拖拽。目标必须使用最新快照的 elementRef（优先）或已观察 selector；坐标为目标内部 0 到 1 的相对比例，因此页面滚动、缩放或布局变化后仍可靠。操作后必须用 DOM、截图或网络响应验证结果。",
          parameters: {
            type: "object",
            properties: {
              elementRef: { type: "string", description: "最新 DOM 快照中交互面的引用，如 e12。优先使用。" },
              selector: { type: "string", description: "已观察到的交互面 CSS selector。" },
              action: { type: "string", enum: ["click", "drag"], description: "点击或拖拽。" },
              start: {
                type: "object",
                description: "起点在目标内部的相对坐标，x/y 均在 0 到 1 之间。",
                properties: { x: { type: "number" }, y: { type: "number" } },
                required: ["x", "y"],
              },
              end: {
                type: "object",
                description: "drag 的终点相对坐标，x/y 均在 0 到 1 之间。",
                properties: { x: { type: "number" }, y: { type: "number" } },
                required: ["x", "y"],
              },
            },
            required: ["action", "start"],
            anyOf: [{ required: ["elementRef"] }, { required: ["selector"] }],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "eval_in_page",
          description: "在页面上下文中执行 JavaScript 表达式并返回结果。必须显式返回值，不要只写 console.log；多语句请写 (()=>{ ...; return value; })()。仅用于读取页面状态（如获取元素文本、检查 class、获取属性值、检查 iframe 列表），严禁用于模拟用户操作。用户操作必须使用 click/type/press/hover/scroll 等专用工具。",
          parameters: {
            type: "object",
          properties: {
            code: { type: "string", description: "要执行的 JavaScript 代码。必须返回可序列化结果；例如 document.body.innerText.slice(0,1000)。" },
            frameId: { type: "integer", description: "可选。快照中 iframe 元素所属 frameId；不传则在顶层页面执行。" },
            },
            required: ["code"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "find_element",
          description: "通过 JS 精确定位页面元素，返回准确坐标和 selector。支持按 label、文本内容、placeholder、CSS选择器、class名、属性查找。返回每个匹配元素的精确坐标(x,y)、尺寸、可见性、建议selector。找到后用 click(selector) 操作，仅在 Canvas/SVG 等场景才用 visual_click(x,y)。",
          parameters: {
            type: "object",
            properties: {
              findBy: { type: "string", enum: ["text", "text_contains", "label", "placeholder", "selector", "class", "attr"], description: "查找方式：label=按表单标签/aria-label/表单项容器查找, text=按文本内容查找, text_contains=按文本包含查找, placeholder=按input的placeholder查找, selector=按CSS选择器查找, class=按class名查找, attr=按属性查找(格式: name=value)" },
              value: { type: "string", description: "查找值。如 findBy=text value='操作人', findBy=placeholder value='请输入脚本名称', findBy=selector value='.el-select', findBy=class value='el-select__caret', findBy=attr value='data-type=select'" },
            },
            required: ["findBy", "value"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "wait",
          description: "等待一段时间（毫秒），用于等待异步加载。",
          parameters: {
            type: "object",
            properties: {
              ms: { type: "integer", description: "等待毫秒数，默认 1000" },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "read_source",
          description: "按文件名/路径关键词检索项目源码，获取相关文件内容。用于理解页面组件结构、查找元素 class/id/data 属性。",
          parameters: {
            type: "object",
            properties: {
              filePattern: { type: "string", description: "文件路径或关键词，空格或逗号分隔" },
            },
            required: ["filePattern"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_network_responses",
          description: "检索页面发出的网络请求及其响应数据。可按 URL 子串、响应体关键词、HTTP 方法、状态码过滤。用于对比 API 响应数据与页面展示数据是否一致。",
          parameters: {
            type: "object",
            properties: {
              urlPattern: { type: "string", description: "URL 子串匹配，如 /api/user 或 /api/list" },
              keyword: { type: "string", description: "在响应体中搜索的关键词" },
              method: { type: "string", description: "HTTP 方法过滤，如 GET、POST" },
              status: { type: "integer", description: "HTTP 状态码过滤，如 200" },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "assert",
          description: "记录当前正在执行用例的一条断言结果。description 必须以当前 TC 编号开头。outcome=passed 只允许在当前 TC 的全部预期均有直接证据时使用；任何未验证项、环境限制或待人工确认都必须使用 outcome=inconclusive；已证实产品异常使用 outcome=failed。编号不一致会被拒绝，绝不切换或覆盖其他用例。",
          parameters: {
            type: "object",
            properties: {
              description: { type: "string", description: "断言描述，如「TC5: ❌ 失败 - API 返回 username 为空」或「TC5: ⚠️ 未完成验证 - 无法触发原生文件选择器」" },
              fieldMappings: {
                type: "array",
                description: "数据展示/API 一致性用例通过时必填。每项记录已验证的页面列头与 API 字段映射；无明确映射时不得判定通过。",
                items: {
                  type: "object",
                  properties: {
                    uiLabel: { type: "string", description: "页面实际列头，如 任务名称" },
                    apiField: { type: "string", description: "已确认对应的 API 字段，如 taskName" },
                    pageValue: { type: "string", description: "页面中读取到的实际值" },
                    apiValue: { type: "string", description: "API 响应中读取到的实际值" },
                  },
                  required: ["uiLabel", "apiField", "pageValue", "apiValue"],
                },
              },
              outcome: { type: "string", enum: ["passed", "failed", "inconclusive"], description: "passed=全部预期有直接证据；failed=已证实异常；inconclusive=至少一项未验证。" },
              passed: { type: "boolean", description: "兼容字段。新调用应使用 outcome；passed:true 仍会在描述含未验证证据时自动降级为 inconclusive。" },
            },
            required: ["description", "outcome"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "finish",
          description: "暂停当前测试对话，等待用户指令。用户可输入消息继续测试，或点击中止结束测试。仅在所有用例完成或确认无法继续时调用。result 取值：pass / fail / unknown。",
          parameters: {
            type: "object",
            properties: {
              result: { type: "string", enum: ["pass", "fail", "unknown"], description: "最终测试结果" },
              summary: { type: "string", description: "测试总结" },
            },
            required: ["result"],
          },
        },
      },
    ];

    // ===== 预设操作模板 =====
    var findByDesc = { type: "string", enum: ["text", "text_contains", "label", "placeholder", "selector", "class", "attr"], description: "查找方式: label=按表单标签/aria-label/表单项容器查找(推荐表单控件), text=按文本精确查找, text_contains=按文本包含查找, placeholder=按placeholder查找, selector=按CSS选择器查找, class=按class名查找, attr=按属性查找(格式:name=value)" };
    tools.push({
      type: "function",
      function: {
        name: "select_option",
          description: "【预设模板】下拉框或级联控件选择单个选项。自动完成：按 label/ARIA/可见浮层定位触发器和选项坐标→CDP 真实点击展开→CDP 真实点击选项→验证；不需要识别 UI 框架。表单控件优先用 trigger.findBy='label'。",
        parameters: {
          type: "object",
          properties: {
            trigger: { type: "object", description: "下拉框触发元素的定位", properties: { findBy: findByDesc, value: { type: "string", description: "查找值" } }, required: ["findBy", "value"] },
            option: { type: "object", description: "要选择的选项的定位", properties: { findBy: findByDesc, value: { type: "string", description: "选项文本或定位值" } }, required: ["findBy", "value"] },
          },
          required: ["trigger", "option"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "select_multi",
        description: "【预设模板】多选。若上传源码已提供交互契约，模板会按契约 hover/展开并点击真实激活控件，避免点击文字。applyAfterSelection=true 时会执行源码声明的提交动作。",
        parameters: {
          type: "object",
          properties: {
            trigger: { type: "object", description: "下拉框触发元素定位", properties: { findBy: findByDesc, value: { type: "string" } }, required: ["findBy", "value"] },
            options: { type: "array", description: "要选择的选项列表", items: { type: "object", properties: { findBy: findByDesc, value: { type: "string" } }, required: ["findBy", "value"] } },
            closeOnDone: { type: "boolean", description: "选完后是否关闭下拉，默认 true" },
            applyAfterSelection: { type: "boolean", description: "按源码交互契约执行提交/搜索动作，默认 false" },
          },
          required: ["trigger", "options"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "fill_input",
        description: "【预设模板】输入框输入值。自动完成：定位输入框→点击聚焦→清空→输入文本→验证。优先使用此模板而非逐步 click+type。",
        parameters: {
          type: "object",
          properties: {
            input: { type: "object", description: "输入框定位", properties: { findBy: findByDesc, value: { type: "string" } }, required: ["findBy", "value"] },
            text: { type: "string", description: "要输入的文本" },
            clearFirst: { type: "boolean", description: "是否先清空已有内容，默认 true" },
          },
          required: ["input", "text"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "click_button",
        description: "【预设模板】点击按钮。自动完成：定位按钮→检查禁用状态→点击→等待结果(loading/弹窗/消息)。优先使用此模板而非直接 click。",
        parameters: {
          type: "object",
          properties: {
            button: { type: "object", description: "按钮定位", properties: { findBy: findByDesc, value: { type: "string" }, tag: { type: "string", description: "限定标签，默认 button" } }, required: ["findBy", "value"] },
            waitFor: { type: "string", enum: ["loading", "dialog", "message", "none"], description: "点击后等待什么: loading=等待加载完成, dialog=等待弹窗出现, message=等待消息提示, none=不等待" },
          },
          required: ["button"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "close_dialog",
        description: "【预设模板】关闭弹框/弹窗。自动尝试：关闭按钮→关闭图标→Escape键。适用于 el-dialog / ant-modal / el-drawer / el-message-box。",
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["auto", "button", "escape"], description: "关闭方式，默认 auto（依次尝试按钮、图标、Escape）" },
            closeButtonText: { type: "string", description: "自定义关闭按钮文本（默认匹配 关闭/取消/Close/Cancel/x）" },
          },
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "fill_form",
        description: "【预设模板】批量填写表单。逐个字段定位→清空→输入，一次调用完成整个表单填写。",
        parameters: {
          type: "object",
          properties: {
            fields: { type: "array", description: "表单字段列表", items: { type: "object", properties: { input: { type: "object", description: "输入框定位", properties: { findBy: findByDesc, value: { type: "string" } }, required: ["findBy", "value"] }, text: { type: "string", description: "要输入的文本" } }, required: ["input", "text"] } },
          },
          required: ["fields"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "table_action",
        description: "【预设模板】在表格中找到某行并点击行内操作按钮（如编辑/删除）。自动定位行→在行内找按钮→点击→等待结果。",
        parameters: {
          type: "object",
          properties: {
            rowIdentifier: { type: "object", description: "行标识（通常是某列的文本）", properties: { findBy: findByDesc, value: { type: "string" } }, required: ["findBy", "value"] },
            actionButton: { type: "object", description: "操作按钮定位", properties: { findBy: findByDesc, value: { type: "string", description: "按钮文本如 编辑/删除" } }, required: ["findBy", "value"] },
            tableSelector: { type: "string", description: "表格 CSS 选择器（可选，默认自动检测 .el-table / .ant-table / table）" },
          },
          required: ["rowIdentifier", "actionButton"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "switch_tab",
        description: "【预设模板】切换 Tab 标签页。定位 Tab→点击→等待加载。",
        parameters: {
          type: "object",
          properties: {
            tab: { type: "object", description: "Tab 定位", properties: { findBy: findByDesc, value: { type: "string" }, tag: { type: "string" } }, required: ["findBy", "value"] },
            waitFor: { type: "string", enum: ["loading", "none"], description: "点击后等待什么，默认 none" },
          },
          required: ["tab"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "confirm_dialog",
        description: "【预设模板】确认或取消弹窗。自动查找确认/取消按钮并点击。适用于 el-message-box / ant-modal-confirm 等确认对话框。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["confirm", "cancel"], description: "确认还是取消" },
            buttonText: { type: "string", description: "自定义按钮文本（可选，默认自动匹配 确定/确认/取消 等）" },
          },
          required: ["action"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "toggle_switch",
        description: "【预设模板】切换开关状态。自动检查当前状态，仅在需要时切换。适用于 el-switch / ant-switch。",
        parameters: {
          type: "object",
          properties: {
            toggle: { type: "object", description: "开关定位", properties: { findBy: findByDesc, value: { type: "string" } }, required: ["findBy", "value"] },
            targetState: { type: "string", enum: ["on", "off", "toggle"], description: "目标状态（可选，不传或传 toggle 则切换当前状态）" },
          },
          required: ["toggle"],
        },
      },
    });

    // 视觉工具（仅在模型支持图片时加入）
    if (options.visionSupported) {
      tools.push({
        type: "function",
        function: {
          name: "verify_ui",
          description: "UI 视觉验证：截取当前页面截图（不带标注），发送给 AI 检查页面展示是否正确。用于验证布局、CSS 样式、数据展示、交互状态等视觉效果。与 screenshot 不同：verify_ui 专注于「验证」而非「操作」，截图不带标注框，避免干扰视觉判断。",
          parameters: {
            type: "object",
            properties: {
              clip: {
                type: "object",
                description: "可选：指定截图区域。不传则截取整个视口。",
                properties: {
                  x: { type: "number", description: "截图区域左上角 X 坐标" },
                  y: { type: "number", description: "截图区域左上角 Y 坐标" },
                  width: { type: "number", description: "截图区域宽度" },
                  height: { type: "number", description: "截图区域高度" },
                },
              },
            },
          },
        },
      });
      tools.push({
        type: "function",
        function: {
          name: "screenshot",
          description: "截取标注截图：每个可交互元素会被画上红色编号框。用于定位元素位置参考。如需验证页面展示效果请使用 verify_ui（不带标注，纯净截图）。",
          parameters: {
            type: "object",
            properties: {
              clip: {
                type: "object",
                description: "可选：指定截图区域。不传则截取整个视口。",
                properties: {
                  x: { type: "number", description: "截图区域左上角 X 坐标" },
                  y: { type: "number", description: "截图区域左上角 Y 坐标" },
                  width: { type: "number", description: "截图区域宽度" },
                  height: { type: "number", description: "截图区域高度" },
                },
              },
            },
          },
        },
      });
      tools.push({
        type: "function",
        function: {
          name: "visual_click",
          description: "通过坐标点击页面元素。底层是 CDP 真实鼠标事件，适合 Canvas/SVG/Shadow DOM、普通定位失败或截图坐标更可靠的场景。",
          parameters: {
            type: "object",
            properties: {
              x: { type: "number", description: "点击位置的 X 坐标（CSS 像素）" },
              y: { type: "number", description: "点击位置的 Y 坐标（CSS 像素）" },
              button: { type: "string", enum: ["left", "right", "middle"], description: "鼠标按键，默认 left" },
              clickCount: { type: "integer", description: "点击次数，1=单击（默认），2=双击" },
            },
            required: ["x", "y"],
          },
        },
      });
      tools.push({
        type: "function",
        function: {
          name: "visual_type",
          description: "通过坐标点击输入框并输入文本。底层是 CDP 真实鼠标和键盘事件，会先聚焦、清空、输入并验证当前焦点值。",
          parameters: {
            type: "object",
            properties: {
              x: { type: "number", description: "输入框位置的 X 坐标" },
              y: { type: "number", description: "输入框位置的 Y 坐标" },
              text: { type: "string", description: "要输入的文本" },
            },
            required: ["x", "y", "text"],
          },
        },
      });
      tools.push({
        type: "function",
        function: {
          name: "visual_scroll",
          description: "在指定坐标位置滚动页面。**仅用于 Canvas/SVG 等场景**。",
          parameters: {
            type: "object",
            properties: {
              x: { type: "number", description: "滚动位置 X 坐标" },
              y: { type: "number", description: "滚动位置 Y 坐标" },
              deltaX: { type: "number", description: "水平滚动量（正数向右，负数向左），默认 0" },
              deltaY: { type: "number", description: "垂直滚动量（正数向下，负数向上），默认 300" },
            },
            required: ["x", "y"],
          },
        },
      });
      tools.push({
        type: "function",
        function: {
          name: "visual_drag",
          description: "从坐标 A 拖拽到坐标 B。适用于拖拽排序、滑块验证等场景。",
          parameters: {
            type: "object",
            properties: {
              fromX: { type: "number", description: "起始位置 X 坐标" },
              fromY: { type: "number", description: "起始位置 Y 坐标" },
              toX: { type: "number", description: "目标位置 X 坐标" },
              toY: { type: "number", description: "目标位置 Y 坐标" },
            },
            required: ["fromX", "fromY", "toX", "toY"],
          },
        },
      });
      tools.push({
        type: "function",
        function: {
          name: "visual_press",
          description: "键盘按键。适用于 Enter、Tab、Escape 等按键，以及组合键（如 Ctrl+A）。",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string", description: "按键名，如 Enter、Tab、Escape、ArrowDown、Backspace 等" },
              combo: {
                type: "array",
                items: { type: "string" },
                description: "组合键序列，如 [\"Control\", \"a\"] 表示 Ctrl+A。不传则只按单个键。",
              },
            },
            required: ["key"],
          },
        },
      });
    }

    return tools;
  }

  global.AIFT_PromptBuilder = {
    buildMessages: buildMessages,
    buildTools: buildTools,
    formatSnapshot: formatSnapshot,
  };
})(window);
