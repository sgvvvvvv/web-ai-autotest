// agent-guard.js
// Keep model-provided targets and assertions bound to the observations made in this run.
(function (global) {
  "use strict";

  function normalize(value) {
    return String(value || "").trim();
  }

  function resolveObservedTarget(snapshot, observedSelectors, unusedInteractions, args) {
    args = args || {};
    var nodes = (snapshot && snapshot.nodes) || [];
    var selector = normalize(args.selector);
    var reference = normalize(args.elementRef);

    if (reference) {
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].ref === reference) {
          return { ok: !!nodes[i].selector, selector: nodes[i].selector || "", source: "snapshot-ref" };
        }
      }
      return { ok: false, error: "当前页面快照中不存在元素引用 " + reference + "；请先重新观察或使用 find_element。" };
    }

    if (!selector) return { ok: false, error: "缺少 elementRef 或 selector。请使用最新快照中的元素引用，或先调用 find_element。" };
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].selector === selector) return { ok: true, selector: selector, source: "snapshot-selector" };
    }
    for (var k = 0; k < (observedSelectors || []).length; k++) {
      if (observedSelectors[k] === selector) return { ok: true, selector: selector, source: "find-element" };
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

  global.AIFT_AgentGuard = {
    resolveObservedTarget: resolveObservedTarget,
    validateAssertionForCurrent: validateAssertionForCurrent,
  };
})(window);
