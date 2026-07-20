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

  global.AIFT_TestScheduler = {
    assignScenarios: assignScenarios,
    buildPlan: buildPlan,
    isStateChanging: isStateChanging,
  };
})(window);
