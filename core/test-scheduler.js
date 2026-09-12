// test-scheduler.js
// 将独立验收用例组织为可复用 setup 的保守执行场景。

(function (global) {
  "use strict";

  function isStateChanging(tc) {
    var text = String((tc && tc.title) || (tc && tc.text) || "") + " " + String((tc && tc.steps) || "");
    return /筛选|搜索|新增|创建|编辑|删除|保存|提交|拖拽|上传|下载|重置|清空|开关|切换|排序|分页/.test(text);
  }

  function moduleHint(tc) {
    var title = String((tc && tc.title) || (tc && tc.text) || "").trim();
    var match = title.match(/^([^\-—:：|]{2,24})[\-—:：|]/);
    return match ? match[1].trim() : "";
  }

  function assignScenarios(testCases) {
    var cases = testCases || [];
    var scenarioByKey = {};
    var scenarioCount = 0;
    for (var i = 0; i < cases.length; i++) {
      var tc = cases[i];
      var hint = moduleHint(tc);
      var page = String(tc.page || "").trim();
      var precondition = String(tc.preconditions || "").replace(/\s+/g, " ").trim();
      var key = "";
      if (!isStateChanging(tc) && page && precondition) key = "page:" + page + "|pre:" + precondition;
      else if (!isStateChanging(tc) && page && hint) key = "page:" + page + "|module:" + hint;
      else if (!isStateChanging(tc) && precondition && hint) key = "pre:" + precondition + "|module:" + hint;
      if (key && i > 0) {
        key = cases[i - 1].scenarioBaseKey === key ? cases[i - 1].scenarioKey : key + "|segment:" + i;
      }
      if (!key) key = "single:" + i;
      if (!scenarioByKey[key]) {
        scenarioCount++;
        scenarioByKey[key] = { id: "SC" + scenarioCount, title: hint || page || "独立场景" };
      }
      tc.scenarioKey = key;
      tc.scenarioBaseKey = key.replace(/\|segment:\d+$/, "");
      tc.scenarioId = scenarioByKey[key].id;
      tc.scenarioTitle = scenarioByKey[key].title;
    }
    return cases;
  }

  function buildPlan(testCases) {
    var cases = assignScenarios(testCases || []);
    var groups = {};
    cases.forEach(function (tc) {
      if (!groups[tc.scenarioId]) groups[tc.scenarioId] = { id: tc.scenarioId, title: tc.scenarioTitle, cases: [] };
      groups[tc.scenarioId].cases.push(tc.id);
    });
    return Object.keys(groups).map(function (id) { return groups[id]; });
  }

  // 只接受每个 TC 恰好出现一次的 AI 计划，避免模型输出导致漏测或重复执行。
  function applyAiPlan(testCases, plan) {
    var cases = testCases || [];
    var groups = plan && plan.groups;
    if (!Array.isArray(groups) || groups.length === 0 || cases.length === 0) return null;
    var byId = {};
    cases.forEach(function(testCase) { byId[testCase.id] = testCase; });
    var seen = {};
    var ordered = [];
    var normalizedPlan = [];
    for (var gi = 0; gi < groups.length; gi++) {
      var group = groups[gi] || {};
      var caseIds = Array.isArray(group.caseIds) ? group.caseIds : group.cases;
      if (!Array.isArray(caseIds) || caseIds.length === 0) return null;
      var scenarioId = "SC" + (gi + 1);
      var title = String(group.title || group.name || "相关用例组 " + (gi + 1)).trim();
      var normalizedIds = [];
      for (var ci = 0; ci < caseIds.length; ci++) {
        var id = String(caseIds[ci] || "").trim();
        if (!id || !byId[id] || seen[id]) return null;
        seen[id] = true;
        var testCase = byId[id];
        ordered.push(testCase);
        normalizedIds.push(id);
      }
      normalizedPlan.push({ id: scenarioId, title: title, cases: normalizedIds, rationale: String(group.rationale || "").trim() });
    }
    if (ordered.length !== cases.length) return null;
    // 所有编号已校验完成后才写入，确保无效计划不会污染本地兜底分组。
    normalizedPlan.forEach(function(group) {
      group.cases.forEach(function(id) {
        var testCase = byId[id];
        testCase.scenarioId = group.id;
        testCase.scenarioTitle = group.title;
        testCase.scenarioKey = "ai:" + group.id;
        testCase.scenarioBaseKey = testCase.scenarioKey;
      });
    });
    cases.splice.apply(cases, [0, cases.length].concat(ordered));
    return normalizedPlan;
  }

  global.AIFT_TestScheduler = {
    assignScenarios: assignScenarios,
    buildPlan: buildPlan,
    applyAiPlan: applyAiPlan,
    isStateChanging: isStateChanging,
  };
})(window);
