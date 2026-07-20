// test-report.js
// 测试完成后的可交付报告构建与 Markdown 导出。

(function (global) {
  "use strict";

  function calculateStats(testCases) {
    var stats = { total: 0, passed: 0, failed: 0, inconclusive: 0, skipped: 0, pending: 0, testing: 0 };
    (testCases || []).forEach(function(testCase) {
      stats.total++;
      var status = testCase.status || "pending";
      if (stats.hasOwnProperty(status)) stats[status]++;
      else stats.pending++;
    });
    stats.tested = stats.passed + stats.failed + stats.inconclusive;
    stats.conclusive = stats.passed + stats.failed;
    stats.passRate = stats.conclusive > 0 ? Math.round(stats.passed / stats.conclusive * 100) : 0;
    return stats;
  }

  function normalizeCase(testCase) {
    return {
      id: testCase.id || "",
      title: testCase.title || testCase.text || "",
      page: testCase.page || "",
      preconditions: testCase.preconditions || "",
      steps: testCase.steps || "",
      expected: testCase.expected || "",
      status: testCase.status || "pending",
      assertion: testCase.assertionDesc || "",
      scenarioId: testCase.scenarioId || "",
    };
  }

  function normalizeErrorRecord(record) {
    record = record || {};
    return {
      id: record.id || "",
      category: record.category || "",
      timestamp: record.timestamp || "",
      round: record.round || 0,
      testCaseId: record.testCaseId || "",
      message: record.message || record.description || record.reason || "",
    };
  }

  function buildReport(input) {
    input = input || {};
    var testCases = (input.testCases || []).map(normalizeCase);
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runId: input.runId || "",
      result: input.result || "unknown",
      summary: input.summary || "",
      requirement: input.requirement || "",
      target: input.target || "",
      stats: calculateStats(testCases),
      testCases: testCases,
      assertions: (input.assertions || []).map(function(assertion) {
        return { description: assertion.description || "", passed: !!assertion.passed, outcome: assertion.outcome || (assertion.passed ? "passed" : "failed") };
      }),
      errorRecords: (input.errorRecords || []).map(normalizeErrorRecord),
    };
  }

  function markdownCell(value) {
    return String(value == null ? "" : value).replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
  }

  function buildMarkdown(report) {
    var lines = [];
    var stats = report.stats || calculateStats(report.testCases || []);
    lines.push("# AI 前端自动化测试报告");
    lines.push("");
    lines.push("> 生成时间: " + new Date(report.generatedAt || Date.now()).toLocaleString());
    if (report.target) lines.push("> 目标页面: " + report.target);
    lines.push("");
    lines.push("## 结论");
    lines.push("");
    lines.push("- 执行结果: " + (report.result || "unknown"));
    lines.push("- 用例总数: " + stats.total + "；通过: " + stats.passed + "；失败: " + stats.failed + "；未完成验证: " + stats.inconclusive + "；跳过: " + stats.skipped + "；未开始: " + (stats.pending + stats.testing));
    lines.push("- 已完成验证通过率: " + stats.passRate + "%（不将未完成验证计入分母）");
    lines.push("");
    if (report.summary) {
      lines.push("## AI 总结");
      lines.push("");
      lines.push(report.summary);
      lines.push("");
    }
    lines.push("## 用例结果");
    lines.push("");
    lines.push("| 用例 | 页面 | 状态 | 断言 |");
    lines.push("|---|---|---|---|");
    (report.testCases || []).forEach(function(testCase) {
      lines.push("| " + markdownCell(testCase.id + " " + testCase.title) + " | " + markdownCell(testCase.page) + " | " + markdownCell(testCase.status) + " | " + markdownCell(testCase.assertion) + " |");
    });
    if ((report.assertions || []).length > 0) {
      lines.push("");
      lines.push("## 断言记录");
      lines.push("");
      report.assertions.forEach(function(assertion) {
        lines.push("- " + (assertion.outcome === "inconclusive" ? "⚠️" : (assertion.passed ? "✅" : "❌")) + " " + assertion.description);
      });
    }
    if ((report.errorRecords || []).length > 0) {
      lines.push("");
      lines.push("## 相关错误诊断");
      lines.push("");
      report.errorRecords.forEach(function(record) {
        var detail = record.message || record.description || record.reason || "未知错误";
        lines.push("- " + markdownCell(record.testCaseId || "未关联 TC") + "：" + markdownCell(detail));
      });
    }
    return lines.join("\n") + "\n";
  }

  global.AIFT_TestReport = {
    buildReport: buildReport,
    buildMarkdown: buildMarkdown,
    calculateStats: calculateStats,
  };
})(window);
