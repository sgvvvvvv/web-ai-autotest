const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadModule(name, context) {
  const source = fs.readFileSync(path.join(__dirname, "..", "core", name), "utf8");
  vm.runInContext(source, context, { filename: name });
}

function assertSidePanelDomContract() {
  const html = fs.readFileSync(path.join(__dirname, "..", "sidepanel", "sidepanel.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "sidepanel", "sidepanel.js"), "utf8");
  const ids = new Set();
  const idPattern = /document\.getElementById\("([^"]+)"\)/g;
  let match;
  while ((match = idPattern.exec(script)) !== null) ids.add(match[1]);
  ids.forEach(function(id) {
    assert.ok(html.indexOf('id="' + id + '"') !== -1, "Side Panel 缺少元素: " + id);
  });
}

async function run() {
  assertSidePanelDomContract();
  const context = vm.createContext({ window: {}, URL: URL });
  loadModule("source-reader.js", context);
  loadModule("interaction-contract.js", context);
  loadModule("test-scheduler.js", context);
  loadModule("redaction.js", context);
  loadModule("diagnostic-store.js", context);
  loadModule("test-report.js", context);
  loadModule("run-history.js", context);
  loadModule("tab-eligibility.js", context);
  loadModule("progress-guard.js", context);
  loadModule("agent-guard.js", context);
  loadModule("config-validator.js", context);
  loadModule("source-analyzer.js", context);
  loadModule("prompt-builder.js", context);
  loadModule("visual-controller.js", context);

  const reader = context.window.AIFT_SourceReader;
  const contracts = context.window.AIFT_InteractionContract;
  const scheduler = context.window.AIFT_TestScheduler;
  const redaction = context.window.AIFT_Redaction;
  const diagnosticStore = context.window.AIFT_DiagnosticStore;
  const testReport = context.window.AIFT_TestReport;
  const runHistory = context.window.AIFT_RunHistory;
  const tabEligibility = context.window.AIFT_TabEligibility;
  const progressGuard = context.window.AIFT_ProgressGuard;
  const agentGuard = context.window.AIFT_AgentGuard;
  const validator = context.window.AIFT_ConfigValidator;
  const analyzer = context.window.AIFT_SourceAnalyzer;
  const promptBuilder = context.window.AIFT_PromptBuilder;
  const visualController = context.window.AIFT_VisualController;

  const files = {
    "views/dashboard/Overview.vue": "<template><h1>Overview</h1></template>",
    "views/host/statistical/components/FailureDetailDialog.vue": "<template><input placeholder=\"用户标签筛选\"></template><TagPicker /></template><script>import TagPicker from '@/components/TagPicker.vue'</script>",
    "components/TagPicker.vue": '<SmartPicker v-model="tags" multiple :options="tagOptions" placeholder="选择标签" />',
    "api/host/statistical.js": "export const GetFailureDetail = () => request('/api/failure-detail')",
  };
  const ranked = reader.rankRelevantFiles(files, {
    url: "http://localhost/#/host/statistical",
    title: "操作统计",
    testCase: "失败详情弹窗 用户标签筛选",
    domText: "失败详情 用户标签筛选",
  }, 2);
  assert.strictEqual(ranked[0].path, "views/host/statistical/components/FailureDetailDialog.vue");
  assert.ok(ranked.some(function(file) { return file.path === "components/TagPicker.vue"; }));

  const contract = {
    kind: "hierarchical-multi-select",
    triggerSelector: 'input[placeholder="用户标签筛选"]',
  };
  assert.strictEqual(contracts.match([contract], { findBy: "placeholder", value: "用户标签筛选" }), contract);
  assert.strictEqual(contracts.match([contract], { findBy: "selector", value: ".unknown" }), null);
  assert.strictEqual(contracts.match([contract, Object.assign({}, contract, { path: "other/FailureDetailDialog.vue" })], { findBy: "placeholder", value: "用户标签筛选" }), null);

  const cases = scheduler.assignScenarios([
    { id: "TC1", title: "失败详情弹窗-默认展示", page: "操作统计", preconditions: "已打开失败详情弹窗", steps: "检查表格" },
    { id: "TC2", title: "失败详情弹窗-提示信息", page: "操作统计", preconditions: "已打开失败详情弹窗", steps: "检查提示" },
    { id: "TC3", title: "失败详情弹窗-标签筛选", page: "操作统计", preconditions: "已打开失败详情弹窗", steps: "选择标签并筛选" },
  ]);
  assert.strictEqual(cases[0].scenarioId, cases[1].scenarioId);
  assert.notStrictEqual(cases[1].scenarioId, cases[2].scenarioId);
  assert.strictEqual(scheduler.isStateChanging(cases[2]), true);
  const plan = JSON.parse(JSON.stringify(scheduler.buildPlan(cases)));
  assert.deepStrictEqual(plan.map(function (item) { return item.cases; }), [["TC1", "TC2"], ["TC3"]]);

  const genericContracts = analyzer.getInteractionContracts({
    "components/TagPicker.vue": '<SmartPicker v-model="tags" multiple :options="tagOptions" placeholder="选择标签" />',
  });
  assert.strictEqual(genericContracts.length, 1);
  assert.strictEqual(genericContracts[0].activationSelector, 'input[type="checkbox"],[role="checkbox"]');
  const ariaContracts = analyzer.getInteractionContracts({
    "components/ReactTagPicker.tsx": '<TagPicker value={selectedTags} multiple options={tagOptions} aria-label="用户标签" />',
  });
  assert.strictEqual(ariaContracts[0].triggerSelector, '[aria-label="用户标签"]');
  assert.strictEqual(contracts.match(ariaContracts, { findBy: "selector", value: '[aria-label="用户标签"]' }), ariaContracts[0]);

  const initialMessages = promptBuilder.buildMessages({
    requirement: "验证失败详情弹窗",
    testCases: "TC1,失败详情弹窗-默认展示,操作统计,已打开弹窗,检查表格,表格显示",
    sourceFiles: [],
    sourceInteractions: [],
    scenarioPlan: plan,
    snapshot: { url: "http://localhost", title: "操作统计", elements: [] },
    visionSupported: false,
  });
  assert.ok(initialMessages[1].content.indexOf("执行场景计划") !== -1);
  assert.ok(initialMessages[1].content.indexOf("TC1 -> TC2") !== -1);

  const safe = redaction.redact({ password: "secret", message: "Bearer abcdefghijklmnopqrstuvwxyz", apiKey: "sk-abcdefghijklmnop" });
  assert.strictEqual(safe.password, "[REDACTED]");
  assert.strictEqual(safe.apiKey, "[REDACTED]");
  assert.ok(safe.message.indexOf("[REDACTED]") !== -1);
  assert.strictEqual(redaction.redactText("Cookie: sid=abc123\nhttps://api.example.com?access_token=secret"), "Cookie: [REDACTED]\nhttps://api.example.com?access_token=[REDACTED]");
  const retainedDiagnostics = diagnosticStore.trimForStorage([
    { id: "old", reasoning: "old" },
    { id: "recent", reasoning: "x".repeat(5000), recentTrace: Array(20).fill({ result: "y".repeat(500) }) },
  ], { maxRecords: 1, maxBytes: 1000 });
  assert.strictEqual(retainedDiagnostics.length, 1);
  assert.strictEqual(retainedDiagnostics[0].id, "recent");
  assert.strictEqual(retainedDiagnostics[0].diagnosticTruncated, true);
  assert.ok(JSON.stringify(retainedDiagnostics).length * 2 <= 1000);

  const report = testReport.buildReport({
    result: "fail",
    summary: "存在一个筛选失败",
    target: "操作统计",
    testCases: [
      { id: "TC1", title: "默认展示", status: "passed", assertionDesc: "✅ 默认展示正确" },
      { id: "TC2", title: "标签筛选", status: "failed", assertionDesc: "❌ checkbox 未勾选" },
    ],
    assertions: [{ description: "❌ checkbox 未勾选", passed: false }],
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(report.stats)), { total: 2, passed: 1, failed: 1, inconclusive: 0, skipped: 0, pending: 0, testing: 0, tested: 2, conclusive: 2, passRate: 50 });
  assert.ok(testReport.buildMarkdown(report).indexOf("❌ checkbox 未勾选") !== -1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(runHistory.trim([{ runId: "old" }, { runId: "new" }], { maxReports: 1 }))), [{ runId: "new" }]);
  assert.strictEqual(tabEligibility.evaluate("https://example.com").ok, true);
  assert.ok(tabEligibility.evaluate("file:///tmp/demo.html").warning);
  assert.strictEqual(tabEligibility.evaluate("chrome://settings").ok, false);
  const stalledAttempts = [];
  for (let index = 0; index < 3; index++) {
    const attempt = progressGuard.createFailureAttempt("select_multi", { trigger: { findBy: "placeholder", value: "用户标签" } }, { url: "http://localhost", pageText: "失败详情" });
    attempt.tcId = "TC8";
    stalledAttempts.push(attempt);
  }
  assert.strictEqual(progressGuard.detectStall(stalledAttempts, "TC8").kind, "same_action");
  const changedPageAttempt = progressGuard.createFailureAttempt("select_multi", { trigger: { findBy: "placeholder", value: "用户标签" } }, { url: "http://localhost", pageText: "筛选结果已更新" });
  changedPageAttempt.tcId = "TC8";
  stalledAttempts.push(changedPageAttempt);
  assert.strictEqual(progressGuard.detectStall(stalledAttempts, "TC8"), null);

  const observedSnapshot = {
    nodes: [
      { ref: "e1", selector: '[data-testid="save"]' },
      { ref: "e2", selector: '[role="tab"]:nth-child(2)' },
    ],
  };
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(agentGuard.resolveObservedTarget(observedSnapshot, [], [], { elementRef: "e1" }))),
    { ok: true, selector: '[data-testid="save"]', source: "snapshot-ref" }
  );
  assert.strictEqual(
    agentGuard.resolveObservedTarget(observedSnapshot, [], [], { selector: ".made-up-selector" }).ok,
    false
  );
  assert.strictEqual(
    agentGuard.resolveObservedTarget(observedSnapshot, [".found-after-search"], [], { selector: ".found-after-search" }).ok,
    true
  );
  assert.strictEqual(agentGuard.validateAssertionForCurrent("TC12: ✅ 通过 - 已验证", "TC12").ok, true);
  assert.strictEqual(agentGuard.validateAssertionForCurrent("TC11: ✅ 通过 - 已验证", "TC12").ok, false);
  assert.strictEqual(agentGuard.validateAssertionForCurrent("✅ 通过 - 已验证", "TC12").ok, false);
  const incompleteOutcome = agentGuard.resolveAssertionOutcome({ passed: true }, "TC5: ⚠️ 部分通过 - 无法在自动化环境中触发真实文件校验，未能完整验证");
  assert.strictEqual(incompleteOutcome.outcome, "inconclusive");
  assert.strictEqual(incompleteOutcome.downgraded, true);
  assert.strictEqual(agentGuard.resolveAssertionOutcome({ outcome: "failed" }, "TC5: ❌ 已观察到错误提示不一致").outcome, "failed");
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(agentGuard.reconcileRunResult("pass", [{ status: "passed" }, { status: "inconclusive" }]))),
    { result: "unknown", adjusted: true, reason: "至少一个测试用例未完成验证或未执行" }
  );

  const inconclusiveReport = testReport.buildReport({
    testCases: [{ id: "TC3", title: "原生文件选择", status: "inconclusive", assertionDesc: "⚠️ 未完成验证" }],
    assertions: [{ description: "TC3: ⚠️ 未完成验证", outcome: "inconclusive", passed: false }],
  });
  assert.strictEqual(inconclusiveReport.stats.inconclusive, 1);
  assert.strictEqual(inconclusiveReport.stats.passRate, 0);
  assert.ok(testReport.buildMarkdown(inconclusiveReport).indexOf("未完成验证") !== -1);

  assert.strictEqual(validator.validateApiEndpoint("ftp://example.com").ok, false);
  assert.strictEqual(validator.validateApiEndpoint("https://api.example.com/v1").ok, true);
  assert.ok(validator.validateApiEndpoint("http://api.example.com/v1").warning);
  assert.strictEqual(validator.validateApiEndpoint("http://localhost:11434/v1").warning, undefined);

  let clickProbe = "";
  await visualController.clickAtPoint(async function (code) {
    clickProbe = code;
    return { ok: false, error: "probe" };
  }, 12, 34, {
    nodeSelector: '[role="option"]',
    activationSelector: 'input[type="checkbox"],[role="checkbox"]',
  });
  assert.doesNotThrow(function () { new Function("return " + clickProbe); });

  const observedMessages = promptBuilder.buildMessages({
    requirement: "保存设置",
    testCases: "TC1,保存设置,设置页,已打开设置,点击保存,保存成功",
    sourceFiles: [],
    sourceInteractions: [],
    snapshot: { url: "http://localhost", title: "设置", nodes: [{ ref: "e7", tag: "button", text: "保存", selector: '[data-testid="save"]' }] },
    visionSupported: false,
  });
  assert.ok(observedMessages[1].content.indexOf("[ref:e7]") !== -1);
  assert.ok(promptBuilder.buildTools({ visionSupported: false }).some(function(tool) { return tool.function.name === "surface_interact"; }));
  const systemPrompt = promptBuilder.buildMessages({ requirement: "编辑并删除测试脚本", testCases: "TC1,编辑脚本,脚本管理,列表有数据,编辑保存并删除,接口成功", sourceFiles: [], snapshot: { nodes: [] }, visionSupported: false })[0].content;
  assert.ok(systemPrompt.indexOf("避免修改后端数据") !== -1);
  assert.ok(systemPrompt.indexOf("默认测试环境") !== -1);

  console.log("All tests passed.");
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
