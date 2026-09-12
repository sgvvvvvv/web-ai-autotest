// interaction-contract.js
// 源码分析与动作执行之间的通用交互契约工具。

(function (global) {
  "use strict";

  function match(contracts, trigger) {
    contracts = contracts || [];
    trigger = trigger || {};
    var value = String(trigger.value || "");
    var matches = [];
    for (var i = 0; i < contracts.length; i++) {
      var contract = contracts[i] || {};
      var selector = String(contract.triggerSelector || "");
      var score = 0;
      if (selector === value) score = 100;
      else if (trigger.findBy === "placeholder" && selector === 'input[placeholder="' + value + '"]') score = 90;
      else if (trigger.findBy === "placeholder" && selector.indexOf(value) !== -1) score = 60;
      if (score > 0) matches.push({ contract: contract, score: score });
    }
    if (matches.length === 0) return null;
    matches.sort(function(a, b) { return b.score - a.score; });
    // 同等匹配意味着当前上下文不足。回退到运行时语义解析，不能武断套用错误组件契约。
    if (matches.length > 1 && matches[0].score === matches[1].score) return null;
    return matches[0].contract;
  }

  function summarize(contracts, limit) {
    var items = (contracts || []).slice(0, limit || 20);
    return items.map(function (item) {
      return {
        kind: item.kind || "interaction",
        triggerSelector: item.triggerSelector || "",
        reveal: item.reveal || "click",
        activationSelector: item.activationSelector || "",
        applySelector: item.applySelector || "",
        source: item.source || "",
        path: item.path || "",
      };
    });
  }

  global.AIFT_InteractionContract = {
    match: match,
    summarize: summarize,
  };
})(window);
