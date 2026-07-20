const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function context() {
  const window = {};
  return { window, console, setTimeout, clearTimeout, URL };
}

function load(name, ctx) {
  const text = fs.readFileSync(path.join(__dirname, "..", "core", name), "utf8");
  vm.runInNewContext(text, ctx, { filename: name });
}

const ctx = context();
load("test-scheduler.js", ctx);
load("coverage-tracker.js", ctx);
load("tab-eligibility.js", ctx);
load("config-validator.js", ctx);
load("prompt-builder.js", ctx);

const scheduler = ctx.window.AIFT_TestScheduler;
const grouped = scheduler.buildPlan([
  { id: "TC1", title: "查看列表", page: "订单", preconditions: "已登录", steps: "查看", expected: "展示" },
  { id: "TC2", title: "查看详情", page: "订单", preconditions: "已登录", steps: "打开详情", expected: "展示" },
]);
assert.strictEqual(grouped.length, 1);

const coverage = ctx.window.AIFT_CoverageTracker.create();
const snapshot = { url: "https://test.example.com/orders", title: "订单", nodes: [{ ref: "e1", selector: "#create", tag: "button", text: "新增订单" }] };
coverage.observeSnapshot(snapshot);
coverage.recordAction("click", { elementRef: "e1" }, snapshot, true);
coverage.recordAssertion({ passed: true }, "TC1");
const coverageSummary = coverage.summary([{ id: "TC1", status: "passed" }, { id: "TC2", status: "pending" }]);
assert.strictEqual(coverageSummary.observedPageCount, 1);
assert.strictEqual(coverageSummary.exercisedControlCount, 1);
assert.strictEqual(coverageSummary.completedTestCaseCount, 1);

const eligibility = ctx.window.AIFT_TabEligibility;
assert.strictEqual(eligibility.evaluate("https://example.com").ok, true);
assert.strictEqual(eligibility.evaluate("chrome://settings").ok, false);

const validator = ctx.window.AIFT_ConfigValidator;
assert.strictEqual(validator.validateAiConfig({ apiUrl: "https://api.example.com/v1", apiKey: "k", model: "m" }, true).ok, true);
assert.strictEqual(validator.validateAiConfig({ apiUrl: "", apiKey: "", model: "" }, true).ok, false);

const tools = ctx.window.AIFT_PromptBuilder.buildTools({ visionSupported: false });
assert.strictEqual(tools.some((tool) => tool.function.name === "read_source"), false);
const messages = ctx.window.AIFT_PromptBuilder.buildMessages({ visionSupported: false, snapshot: { nodes: [] } });
assert.strictEqual(messages[0].content.includes("read_source"), false);

const visualController = fs.readFileSync(path.join(__dirname, "..", "core", "visual-controller.js"), "utf8");
assert.ok(visualController.includes("focusTerms"));
assert.ok(visualController.includes("autoCrop"));
assert.ok(visualController.includes("elements = elements.filter"));

console.log("All black-box regression tests passed.");
