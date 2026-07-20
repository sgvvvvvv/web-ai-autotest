// Black-box test orchestrator. It observes the deployed page and performs all writes through CDP.
var tabId = null;
var currentAgent = null;
var siteInventory = null;
var testCasesState = [];
var latestCoverage = null;

var els = {
  tabSelector: document.getElementById("tabSelector"),
  refreshTabBtn: document.getElementById("refreshTabBtn"),
  tabInfo: document.getElementById("tabInfo"),
  apiUrl: document.getElementById("apiUrl"),
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  visionSupported: document.getElementById("visionSupported"),
  saveConfig: document.getElementById("saveConfig"),
  requirement: document.getElementById("requirement"),
  discoverBtn: document.getElementById("discoverBtn"),
  genTestCasesBtn: document.getElementById("genTestCasesBtn"),
  inventory: document.getElementById("inventory"),
  coverage: document.getElementById("coverage"),
  testCases: document.getElementById("testCases"),
  runAgentBtn: document.getElementById("runAgentBtn"),
  abortBtn: document.getElementById("abortBtn"),
  status: document.getElementById("status"),
  log: document.getElementById("log"),
  testProgress: document.getElementById("testProgress"),
  resultArea: document.getElementById("resultArea"),
};

function log(message) {
  els.log.textContent = "[" + new Date().toLocaleTimeString() + "] " + message + "\n" + els.log.textContent;
}

function setStatus(message) { els.status.textContent = message; }

function escapeHtml(value) {
  var div = document.createElement("div");
  div.textContent = String(value || "");
  return div.innerHTML;
}

function config() {
  return {
    apiUrl: els.apiUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    visionSupported: els.visionSupported.checked,
    enableThinking: false,
  };
}

function validConfig(requireComplete) {
  var result = window.AIFT_ConfigValidator
    ? AIFT_ConfigValidator.validateAiConfig(config(), requireComplete)
    : { ok: !requireComplete || (!!config().apiUrl && !!config().apiKey && !!config().model) };
  if (!result.ok) {
    log(result.error || "AI 配置不完整");
    setStatus("AI 配置无效");
  }
  return result.ok;
}

async function saveConfig() {
  await chrome.storage.local.set({ aift_blackbox_config: Object.assign(config(), {
    requirement: els.requirement.value,
    testCases: els.testCases.value,
  }) });
  setStatus("配置已保存");
}

async function loadConfig() {
  var saved = await chrome.storage.local.get("aift_blackbox_config");
  var value = saved.aift_blackbox_config || {};
  els.apiUrl.value = value.apiUrl || "";
  els.apiKey.value = value.apiKey || "";
  els.model.value = value.model || "gpt-4o";
  els.visionSupported.checked = value.visionSupported === true;
  els.requirement.value = value.requirement || "";
  els.testCases.value = value.testCases || "";
}

function eligible(tab) {
  return window.AIFT_TabEligibility && AIFT_TabEligibility.evaluate
    ? AIFT_TabEligibility.evaluate(tab && tab.url)
    : { ok: !!(tab && /^https?:\/\//.test(tab.url || "")) };
}

async function refreshTabs() {
  var tabs = await chrome.tabs.query({});
  els.tabSelector.innerHTML = "";
  tabs.forEach(function(tab) {
    if (!eligible(tab).ok) return;
    var option = document.createElement("option");
    option.value = tab.id;
    option.textContent = (tab.title || tab.url || "Tab " + tab.id).slice(0, 70);
    els.tabSelector.appendChild(option);
  });
  var active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (active && eligible(active).ok && els.tabSelector.querySelector('option[value="' + active.id + '"]')) {
    els.tabSelector.value = active.id;
    selectTab(active.id);
  } else {
    tabId = null;
    els.tabInfo.textContent = "请选择可测试的 http(s) 页面";
  }
}

async function selectTab(id) {
  tabId = Number(id);
  var tab = await chrome.tabs.get(tabId);
  els.tabInfo.textContent = "目标: " + (tab.title || tab.url || "").slice(0, 80);
  siteInventory = null;
  els.inventory.textContent = "目标页面已切换，请重新勘探。";
}

async function ensureContentScript() {
  await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["content/content.js"] });
}

function sendToContent(target, message) { return chrome.tabs.sendMessage(target, message); }

async function preflight() {
  if (!tabId) { setStatus("未选择目标页面"); return false; }
  try {
    var tab = await chrome.tabs.get(tabId);
    var state = eligible(tab);
    if (!state.ok) throw new Error(state.error || "目标页面不可测试");
    await ensureContentScript();
    var ping = await sendToContent(tabId, { type: "AIFT_PING" });
    if (!ping || !ping.ok) throw new Error("页面观察器未响应");
    return true;
  } catch (error) {
    log("页面预检失败: " + (error.message || error));
    setStatus("目标页面不可访问");
    return false;
  }
}

function summarizeInventory(snapshot, navigation) {
  var controls = (snapshot.nodes || []).slice(0, 80).map(function(node) {
    return (node.role || node.tag) + " " + (node.label || node.text || node.placeholder || node.name || "");
  }).filter(Boolean);
  var lines = [
    "页面: " + (snapshot.title || "未命名"),
    "地址: " + (snapshot.url || ""),
    "可交互元素: " + (snapshot.interactiveCount || 0),
    "导航入口: " + (navigation || []).slice(0, 12).map(function(item) { return item.text; }).join("、") || "未发现",
    "控件样本: " + controls.slice(0, 18).join("；") || "未发现",
  ];
  return lines.join("\n");
}

async function discover() {
  if (!await preflight()) return null;
  setStatus("正在勘探运行时页面");
  els.discoverBtn.disabled = true;
  try {
    var responses = await Promise.all([
      sendToContent(tabId, { type: "AIFT_CAPTURE_SNAPSHOT" }),
      sendToContent(tabId, { type: "AIFT_CAPTURE_NAVIGATION" }),
    ]);
    if (!responses[0] || !responses[0].ok) throw new Error(responses[0] && responses[0].error || "无法读取页面快照");
    siteInventory = { snapshot: responses[0].snapshot, navigation: responses[1] && responses[1].navigation || [], capturedAt: Date.now() };
    els.inventory.textContent = summarizeInventory(siteInventory.snapshot, siteInventory.navigation);
    log("运行时勘探完成：" + siteInventory.snapshot.interactiveCount + " 个可交互元素");
    setStatus("勘探完成");
    return siteInventory;
  } catch (error) {
    log("勘探失败: " + (error.message || error));
    setStatus("勘探失败");
    return null;
  } finally {
    els.discoverBtn.disabled = false;
  }
}

function generationPrompt(inventory) {
  var snapshot = inventory.snapshot || {};
  var controls = (snapshot.nodes || []).slice(0, 100).map(function(node) {
    return "- " + (node.role || node.tag) + " | " + (node.label || node.text || node.placeholder || node.name || "无文本") + " | ref=" + node.ref;
  }).join("\n");
  var navigation = (inventory.navigation || []).slice(0, 80).map(function(item) { return "- " + item.text + " -> " + item.path; }).join("\n");
  return [
    "你是黑盒 Web 测试工程师。只能根据已部署页面的运行时观察生成测试用例，不能假设或要求源码、接口实现、隐藏路由或未观察到的功能。",
    "输出 CSV，每行严格六列：TC编号,用例标题,测试页面,前置条件,操作步骤,预期结果。不要输出 Markdown 或说明。",
    "测试用例需覆盖已发现的导航、表单、按钮、Tab、列表/表格、弹窗和边界状态。当前为测试环境：允许真实执行创建、编辑、删除、提交和数据清理等 CRUD 流程；支付、外部发送和第三方不可逆行为只验证入口。",
    "业务需求：\n" + (els.requirement.value.trim() || "未提供，按可见功能探索测试"),
    "当前页面：" + (snapshot.title || "") + " " + (snapshot.url || ""),
    "运行时导航：\n" + (navigation || "未发现"),
    "运行时控件：\n" + (controls || "未发现"),
  ].join("\n\n");
}

async function generateTestCases() {
  if (!validConfig(true)) return;
  var inventory = siteInventory || await discover();
  if (!inventory) return;
  els.genTestCasesBtn.disabled = true;
  setStatus("正在生成黑盒用例");
  try {
    var response = await AIFT_AIClient.chat(config(), [
      { role: "system", content: "所有回答使用简体中文。" },
      { role: "user", content: generationPrompt(inventory) },
    ], [], {});
    var text = String(response.message.content || "").replace(/```(?:csv)?\n?/gi, "").replace(/```/g, "").trim();
    if (!/^TC\d+/im.test(text)) throw new Error("模型未返回可执行的 CSV 用例");
    els.testCases.value = text;
    setStatus("已生成测试用例");
    log("已根据运行时页面生成测试用例");
  } catch (error) {
    log("生成用例失败: " + (error.message || error));
    setStatus("生成失败");
  } finally {
    els.genTestCasesBtn.disabled = false;
  }
}

function renderResults(cases, assertions, summary) {
  var passed = 0;
  var failed = 0;
  (cases || []).forEach(function(item) { if (item.status === "passed") passed++; if (item.status === "failed") failed++; });
  els.testProgress.textContent = (passed + failed) + "/" + (cases || []).length + " 已测，" + passed + " 通过，" + failed + " 失败";
  var html = (cases || []).map(function(item) {
    var icon = item.status === "passed" ? "通过" : item.status === "failed" ? "失败" : "待测";
    return "<div class=\"test-case test-" + escapeHtml(item.status || "pending") + "\"><strong>" + escapeHtml(item.id) + " " + escapeHtml(icon) + "</strong><br>" + escapeHtml(item.title || item.text) + (item.assertionDesc ? "<br>" + escapeHtml(item.assertionDesc) : "") + "</div>";
  }).join("");
  if (summary) html = "<p>" + escapeHtml(summary) + "</p>" + html;
  els.resultArea.innerHTML = html || "尚未解析到测试用例";
}

function renderCoverage(coverage) {
  latestCoverage = coverage || latestCoverage;
  if (!latestCoverage) return;
  var pages = (latestCoverage.pages || []).slice(0, 8).map(function(page) { return page.title || page.url || "未命名页面"; });
  els.coverage.innerHTML =
    "<strong>页面</strong> " + latestCoverage.observedPageCount + " 个（" + escapeHtml(pages.join("、") || "尚未发现") + "）<br>" +
    "<strong>控件</strong> 已发现 " + latestCoverage.observedControlCount + "，已真实交互 " + latestCoverage.exercisedControlCount + "（" + latestCoverage.controlCoverage + "%）<br>" +
    "<strong>动作</strong> " + latestCoverage.actionCount + " 次，其中成功 " + latestCoverage.successfulActionCount + " 次<br>" +
    "<strong>用例</strong> 已完成 " + latestCoverage.completedTestCaseCount + "/" + latestCoverage.testCaseCount + "，待执行 " + latestCoverage.pendingTestCaseCount;
}

async function runTests() {
  if (!validConfig(true) || !await preflight()) return;
  var requirement = els.requirement.value.trim();
  var testCases = els.testCases.value.trim();
  if (!testCases) { setStatus("请先生成或输入测试用例"); return; }
  currentAgent = AIFT_AgentLoop.create({
    tabId: tabId,
    config: config(),
    ensureContentScript: ensureContentScript,
    sendMessage: sendToContent,
    evalInPage: evalInPage,
    onLog: log,
    onStatus: setStatus,
    onStream: function(type, content) { if (content) log("AI " + type + ": " + String(content).slice(0, 500)); },
    onTestCasesParsed: function(cases) { testCasesState = cases; renderResults(cases, [], ""); },
    onAssertion: function(assertion, assertions, cases, coverage) { testCasesState = cases; renderResults(cases, assertions, ""); renderCoverage(coverage); },
    onCoverage: renderCoverage,
    onFinish: function(result, summary, assertions, cases, artifacts) {
      testCasesState = cases || testCasesState;
      renderResults(testCasesState, assertions || [], summary || "");
      renderCoverage(artifacts && artifacts.coverage);
      setStatus("完成: " + result);
      currentAgent = null;
      els.abortBtn.disabled = true;
      els.runAgentBtn.disabled = false;
      if (AIFT_VisualController && AIFT_VisualController.isAttached()) AIFT_VisualController.detach();
    },
  });
  els.runAgentBtn.disabled = true;
  els.abortBtn.disabled = false;
  els.resultArea.textContent = "正在执行真实鼠标键盘测试...";
  await currentAgent.run({
    requirement: requirement,
    testCases: testCases,
    runtimeInventory: siteInventory,
    extraPrompt: "仅测试当前已部署站点。不得索取或使用源码。当前是测试环境，允许真实执行 CRUD、提交和数据清理流程；禁止触发外部发送、支付或第三方不可逆行为。",
  });
}

async function evalInPage(code) {
  try {
    var results = await chrome.scripting.executeScript({ target: { tabId: tabId }, world: "MAIN", func: function(source) {
      try {
        var value = Function("return (" + source + ")")();
        return { ok: true, result: typeof value === "string" ? value : JSON.stringify(value) };
      } catch (error) { return { ok: false, error: error.message || String(error) }; }
    }, args: [code] });
    return results[0] && results[0].result || { ok: false, error: "无返回值" };
  } catch (error) { return { ok: false, error: error.message || String(error) }; }
}

els.refreshTabBtn.addEventListener("click", refreshTabs);
els.tabSelector.addEventListener("change", function() { selectTab(this.value); });
els.saveConfig.addEventListener("click", saveConfig);
els.discoverBtn.addEventListener("click", discover);
els.genTestCasesBtn.addEventListener("click", generateTestCases);
els.runAgentBtn.addEventListener("click", runTests);
els.abortBtn.addEventListener("click", function() { if (currentAgent) currentAgent.abort(); });
loadConfig().then(refreshTabs).catch(function(error) { log("初始化失败: " + (error.message || error)); });
