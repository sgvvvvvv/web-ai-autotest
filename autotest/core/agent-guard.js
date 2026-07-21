// agent-guard.js
// Keep model-provided targets and assertions bound to the observations made in this run.
(function (global) {
  "use strict";

  function normalize(value) {
    return String(value || "").trim();
  }

  function resolveObservedTarget(snapshot, observedSelectors, interactions, args) {
    args = args || {};
    var nodes = (snapshot && snapshot.nodes) || [];
    var selector = normalize(args.selector);
    var reference = normalize(args.elementRef);

    if (reference) {
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].ref === reference) {
          var byRef = { ok: !!nodes[i].selector, selector: nodes[i].selector || "", source: "snapshot-ref" };
          if (nodes[i].frameId !== undefined) byRef.frameId = nodes[i].frameId;
          return byRef;
        }
      }
      return { ok: false, error: "当前页面快照中不存在元素引用 " + reference + "；请先重新观察或使用 find_element。" };
    }

    if (!selector) return { ok: false, error: "缺少 elementRef 或 selector。请使用最新快照中的元素引用，或先调用 find_element。" };
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].selector === selector) {
        var bySelector = { ok: true, selector: selector, source: "snapshot-selector" };
        if (nodes[j].frameId !== undefined) bySelector.frameId = nodes[j].frameId;
        return bySelector;
      }
    }
    for (var k = 0; k < (observedSelectors || []).length; k++) {
      var observed = observedSelectors[k];
      if (observed === selector) return { ok: true, selector: selector, source: "find-element" };
      if (observed && typeof observed === "object" && observed.selector === selector) {
        var byFind = { ok: true, selector: selector, source: "find-element" };
        if (observed.frameId !== undefined) byFind.frameId = observed.frameId;
        return byFind;
      }
    }
    for (var m = 0; m < (interactions || []).length; m++) {
      var item = interactions[m] || {};
      if (selector === item.triggerSelector || selector === item.activationSelector || selector === item.applySelector) {
        return { ok: true, selector: selector, source: "source-contract" };
      }
    }
    return { ok: false, error: "该 selector 未由当前页面观察确认: " + selector + "。请先使用快照 elementRef 或 find_element，避免猜测 selector。" };
  }

  function validateAssertionForCurrent(description, currentTcId) {
    var current = normalize(currentTcId).toUpperCase();
    if (!current) return { ok: false, error: "当前没有正在执行的测试用例，不能提交断言。请先执行该用例的操作。" };
    var match = normalize(description).match(/\b(TC\d+)\s*[:：]/i);
    if (!match) return { ok: false, error: "断言描述必须以 " + current + ": 开头，确保结果归属明确。" };
    if (match[1].toUpperCase() !== current) {
      return { ok: false, error: "断言编号 " + match[1].toUpperCase() + " 与当前用例 " + current + " 不一致；不会改变任何用例状态。" };
    }
    return { ok: true, testCaseId: current };
  }

  function resolveAssertionOutcome(args, description) {
    args = args || {};
    var requested = normalize(args.outcome).toLowerCase();
    if (["passed", "failed", "inconclusive"].indexOf(requested) === -1) {
      requested = args.passed ? "passed" : "failed";
    }
    // A pass requires direct evidence for every required expectation. These phrases express
    // an explicit evidence gap across Chinese and English model outputs, not a UI-library rule.
    var incomplete = /部分通过|部分验证|无法(?:直接)?验证|未能(?:完整)?验证|未(?:完成|捕获|验证)|自动化环境限制|需要人工(?:确认|验证)|证据不足|待(?:人工)?验证|inconclusive|partially?\s+(?:pass|verified)|not\s+verified|unable\s+to\s+(?:verify|trigger)|cannot\s+(?:verify|trigger)|blocked/i.test(normalize(description));
    if (requested === "passed" && incomplete) {
      return {
        outcome: "inconclusive",
        downgraded: true,
        reason: "断言描述表明至少一项预期未被直接验证",
      };
    }
    return { outcome: requested, downgraded: false, reason: "" };
  }

  function requiresFieldMapping(testCase) {
    // 字段语义审查只适用于用例明确声明的页面列头/API 字段映射。
    // 普通 UI、接口状态和业务流程用例不应被映射规则降级。
    return String((testCase && testCase.expected) || "").indexOf("字段映射") !== -1;
  }

  // 数据展示通过必须有已定义的“页面列头 <- API 字段”映射和网络字段证据。
  function validateFieldMappings(testCase, mappings, snapshot, networkEvidence) {
    if (!requiresFieldMapping(testCase)) return { ok: true, required: false };
    var expected = String((testCase && testCase.expected) || "");
    if (expected.indexOf("字段映射") === -1) {
      return { ok: false, required: true, reason: "当前数据展示用例的预期结果未定义「字段映射」，不能仅凭字段同时存在就判定页面与 API 一致" };
    }
    if (!Array.isArray(mappings) || mappings.length < 2) {
      return { ok: false, required: true, reason: "数据展示通过至少需要 2 条字段映射（页面列头、API 字段、页面值、API 值）" };
    }
    var pageText = String((snapshot && snapshot.pageText) || "");
    var networkText = String(networkEvidence || "");
    for (var i = 0; i < mappings.length; i++) {
      var mapping = mappings[i] || {};
      var uiLabel = normalize(mapping.uiLabel);
      var apiField = normalize(mapping.apiField);
      var pageValue = normalize(mapping.pageValue);
      var apiValue = normalize(mapping.apiValue);
      if (!uiLabel || !apiField || !pageValue || !apiValue) {
        return { ok: false, required: true, reason: "第 " + (i + 1) + " 条字段映射缺少页面列头、API 字段、页面值或 API 值" };
      }
      if (expected.indexOf(uiLabel) === -1 || expected.indexOf(apiField) === -1) {
        return { ok: false, required: true, reason: "第 " + (i + 1) + " 条映射「" + uiLabel + " <- " + apiField + "」未在用例预期的字段映射中定义" };
      }
      if (pageText.indexOf(uiLabel) === -1) {
        return { ok: false, required: true, reason: "当前页面快照未观察到列头「" + uiLabel + "」，不能确认其与 API 字段「" + apiField + "」的映射" };
      }
      if (networkText.indexOf(apiField) === -1) {
        return { ok: false, required: true, reason: "当前用例未获取包含 API 字段「" + apiField + "」的网络响应证据" };
      }
      if (pageValue !== apiValue) {
        return { ok: false, required: true, reason: "字段映射「" + uiLabel + " <- " + apiField + "」的页面值与 API 值不一致" };
      }
    }
    return { ok: true, required: true };
  }

  function reconcileRunResult(requestedResult, testCases) {
    var requested = normalize(requestedResult).toLowerCase() || "unknown";
    var cases = testCases || [];
    var hasFailed = cases.some(function(testCase) { return testCase.status === "failed"; });
    var hasIncomplete = cases.some(function(testCase) {
      return testCase.status === "inconclusive" || testCase.status === "pending" || testCase.status === "testing";
    });
    if (hasFailed && requested !== "error" && requested !== "aborted") {
      return { result: "fail", adjusted: requested !== "fail", reason: "至少一个测试用例已失败" };
    }
    if (hasIncomplete && requested === "pass") {
      return { result: "unknown", adjusted: true, reason: "至少一个测试用例未完成验证或未执行" };
    }
    return { result: requested, adjusted: false, reason: "" };
  }

  global.AIFT_AgentGuard = {
    resolveObservedTarget: resolveObservedTarget,
    validateAssertionForCurrent: validateAssertionForCurrent,
    resolveAssertionOutcome: resolveAssertionOutcome,
    requiresFieldMapping: requiresFieldMapping,
    validateFieldMappings: validateFieldMappings,
    reconcileRunResult: reconcileRunResult,
  };
})(window);
