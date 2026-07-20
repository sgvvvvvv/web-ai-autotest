// progress-guard.js
// 基于失败目标与可观察页面进展的通用交互停滞检测。

(function (global) {
  "use strict";

  var NON_INTERACTION_ACTIONS = {
    assert: true, finish: true, wait: true, screenshot: true, verify_ui: true,
    eval_in_page: true, get_network_responses: true, find_element: true,
  };

  function textHash(value) {
    var text = String(value || "");
    var hash = 0;
    for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    return hash;
  }

  function snapshotSignature(snapshot) {
    snapshot = snapshot || {};
    return [
      snapshot.url || "",
      snapshot.title || "",
      snapshot.interactiveCount || 0,
      textHash(snapshot.pageText || snapshot.text || ""),
    ].join("|");
  }

  function targetKey(args) {
    args = args || {};
    if (args.selector) return "selector:" + args.selector;
    if (args.trigger) return "trigger:" + (args.trigger.findBy || "") + ":" + (args.trigger.value || "");
    if (args.input) return "input:" + (args.input.findBy || "") + ":" + (args.input.value || "");
    if (args.findBy || args.value) return "find:" + (args.findBy || "") + ":" + (args.value || "");
    if (args.label !== undefined) return "label:" + args.label;
    if (typeof args.x === "number" && typeof args.y === "number") {
      return "point:" + (Math.round(args.x / 80) * 80) + ":" + (Math.round(args.y / 80) * 80);
    }
    return "";
  }

  function createFailureAttempt(action, args, snapshot) {
    if (NON_INTERACTION_ACTIONS[action]) return null;
    var target = targetKey(args);
    if (!target) return null;
    return {
      action: action || "unknown",
      target: target,
      fingerprint: (action || "unknown") + "|" + target,
      pageSignature: snapshotSignature(snapshot),
    };
  }

  function countTrailing(attempts, tcId, predicate) {
    var count = 0;
    for (var i = attempts.length - 1; i >= 0; i--) {
      var attempt = attempts[i];
      if (!attempt || attempt.tcId !== tcId || !predicate(attempt)) break;
      count++;
    }
    return count;
  }

  function detectStall(attempts, tcId) {
    var current = attempts && attempts.length ? attempts[attempts.length - 1] : null;
    if (!current || !tcId || current.tcId !== tcId) return null;
    var fingerprintCount = countTrailing(attempts, tcId, function(attempt) {
      return attempt.fingerprint === current.fingerprint && attempt.pageSignature === current.pageSignature;
    });
    var targetCount = countTrailing(attempts, tcId, function(attempt) {
      return attempt.target === current.target && attempt.pageSignature === current.pageSignature;
    });
    if (fingerprintCount >= 3) {
      return { count: fingerprintCount, kind: "same_action", target: current.target, action: current.action };
    }
    if (targetCount >= 4) {
      return { count: targetCount, kind: "same_target", target: current.target, action: current.action };
    }
    if (fingerprintCount >= 2 || targetCount >= 3) {
      return { count: Math.max(fingerprintCount, targetCount), kind: "warning", target: current.target, action: current.action };
    }
    return null;
  }

  global.AIFT_ProgressGuard = {
    snapshotSignature: snapshotSignature,
    createFailureAttempt: createFailureAttempt,
    detectStall: detectStall,
  };
})(window);
