// Side Panel 编排器入口（Side Panel + CDP 架构）
// tabId 由用户从下拉列表选择目标标签页

var tabId = null;

// ---- 标签页选择 ----
var tabSelector = document.getElementById("tabSelector");
var refreshTabBtn = document.getElementById("refreshTabBtn");
var tabInfo = document.getElementById("tabInfo");

function getTabEligibility(tab) {
  if (window.AIFT_TabEligibility && AIFT_TabEligibility.evaluate) return AIFT_TabEligibility.evaluate(tab && tab.url);
  return tab && /^https?:\/\//i.test(tab.url || "") ? { ok: true } : { ok: false, error: "目标页面不可测试" };
}

async function refreshTabList() {
  try {
    var tabs = await chrome.tabs.query({});
    tabSelector.innerHTML = "";
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (!getTabEligibility(t).ok) continue;
      var opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = (t.title || t.url || "Tab " + t.id).substring(0, 60);
      opt.dataset.tabId = t.id;
      tabSelector.appendChild(opt);
    }
    // 尝试选中当前活跃标签
    var active = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && active[0] && getTabEligibility(active[0]).ok && tabSelector.querySelector('option[value="' + active[0].id + '"]')) {
      tabSelector.value = active[0].id;
      tabId = active[0].id;
      tabInfo.textContent = "目标: " + (active[0].title || active[0].url || "").substring(0, 40);
      tabInfo.style.color = "#0a7c3e";
    } else {
      tabId = null;
      tabInfo.textContent = "请选择可测试的 http(s) 页面";
      tabInfo.style.color = "#d97706";
    }
  } catch (e) {
    tabInfo.textContent = "获取标签页失败: " + (e.message || e);
    tabInfo.style.color = "#e74c3c";
  }
}

tabSelector.addEventListener("change", function () {
  tabId = parseInt(tabSelector.value);
  if (tabId) {
    var opt = tabSelector.options[tabSelector.selectedIndex];
    tabInfo.textContent = "目标: " + opt.textContent.substring(0, 40);
    tabInfo.style.color = "#0a7c3e";
  }
});

refreshTabBtn.addEventListener("click", refreshTabList);
refreshTabList();

const els = {
  apiUrl: document.getElementById("apiUrl"),
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  contextSize: document.getElementById("contextSize"),
  visionSupported: document.getElementById("visionSupported"),
  enableThinking: document.getElementById("enableThinking"),
  requirement: document.getElementById("requirement"),
  testCases: document.getElementById("testCases"),
  saveConfig: document.getElementById("saveConfig"),
  runAgentBtn: document.getElementById("runAgentBtn"),
  planBtn: document.getElementById("planBtn"),
  abortBtn: document.getElementById("abortBtn"),
  continueBtn: document.getElementById("continueBtn"),
  status: document.getElementById("status"),
  log: document.getElementById("log"),
  resultArea: document.getElementById("resultArea"),
  genTestCasesBtn: document.getElementById("genTestCasesBtn"),
  streamLog: document.getElementById("streamLog"),
  contextMeter: document.getElementById("contextMeter"),
  contextMeterLabel: document.getElementById("contextMeterLabel"),
  contextMeterBar: document.getElementById("contextMeterBar"),
  sourceUpload: document.getElementById("sourceUpload"),
  sourceUploadInfo: document.getElementById("sourceUploadInfo"),
  testProgress: document.getElementById("testProgress"),
  errorRecordCount: document.getElementById("errorRecordCount"),
  errorRecordList: document.getElementById("errorRecordList"),
  exportErrorsBtn: document.getElementById("exportErrorsBtn"),
  clearErrorsBtn: document.getElementById("clearErrorsBtn"),
  errorDetailModal: document.getElementById("errorDetailModal"),
  errorDetailTitle: document.getElementById("errorDetailTitle"),
  errorDetailMeta: document.getElementById("errorDetailMeta"),
  errorDetailContent: document.getElementById("errorDetailContent"),
  errorDetailClose: document.getElementById("errorDetailClose"),
  chatInputRow: document.getElementById("chatInputRow"),
  chatInput: document.getElementById("chatInput"),
  chatSendBtn: document.getElementById("chatSendBtn"),
  // 截图展示
  screenshotCard: document.getElementById("screenshotCard"),
  screenshotContainer: document.getElementById("screenshotContainer"),
  screenshotInfo: document.getElementById("screenshotInfo"),
  screenshotToggleBtn: document.getElementById("screenshotToggleBtn"),
  // 架构分析
  analyzeBtn: document.getElementById("analyzeBtn"),
  importArchBtn: document.getElementById("importArchBtn"),
  archFileInput: document.getElementById("archFileInput"),
  clearCacheBtn: document.getElementById("clearCacheBtn"),
  archCacheInfo: document.getElementById("archCacheInfo"),
  archResult: document.getElementById("archResult"),
  archSectionToggle: document.getElementById("archSectionToggle"),
  exportArchBtn: document.getElementById("exportArchBtn"),
  // 测试用例导出
  exportTestCasesBtn: document.getElementById("exportTestCasesBtn"),
  testCasesContent: document.getElementById("testCasesContent"),
  testCasesSectionToggle: document.getElementById("testCasesSectionToggle"),
  exportTestReportBtn: document.getElementById("exportTestReportBtn"),
  runHistoryCount: document.getElementById("runHistoryCount"),
  runHistoryList: document.getElementById("runHistoryList"),
  clearRunHistoryBtn: document.getElementById("clearRunHistoryBtn"),
  // 导出弹框
  exportModal: document.getElementById("exportModal"),
  exportModalTitle: document.getElementById("exportModalTitle"),
  exportFormatList: document.getElementById("exportFormatList"),
  exportModalCancel: document.getElementById("exportModalCancel"),
  // 按钮 tooltip 提示
  analyzeBtnTooltip: document.querySelector("#analyzeBtn").parentElement.querySelector(".btn-tooltip"),
  genTestCasesBtnTooltip: document.querySelector("#genTestCasesBtn").parentElement.querySelector(".btn-tooltip"),
  runAgentBtnTooltip: document.querySelector("#runAgentBtn").parentElement.querySelector(".btn-tooltip"),
  planBtnTooltip: document.querySelector("#planBtn").parentElement.querySelector(".btn-tooltip"),
};

loadErrorRecords().catch(function () {});

var PAGE_EVAL_TIMEOUT_MS = 12000;
var CONTENT_MESSAGE_TIMEOUT_MS = 12000;

function withTimeout(promise, timeoutMs, label) {
  return new Promise(function(resolve, reject) {
    var settled = false;
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      reject(new Error((label || "操作") + "超时（" + timeoutMs + "ms）"));
    }, timeoutMs);
    Promise.resolve(promise).then(function(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, function(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

// ---- 在页面主世界执行 JS（替代 inspectedWindow.eval）----
// 注意：chrome.scripting.executeScript 使用结构化克隆传输返回值，
// DOM 对象、Window 对象等无法被克隆，因此必须在页面内序列化为字符串后再返回。
async function evalInPage(code, frameId) {
  if (!tabId) return { ok: false, error: "未选择目标标签页" };
  try {
    var target = { tabId: tabId };
    if (frameId !== undefined && frameId !== null) target.frameIds = [Number(frameId)];
    var results = await withTimeout(chrome.scripting.executeScript({
      target: target,
      world: "MAIN",
      func: async function (code) {
        // 在页面内将结果序列化为字符串，避免结构化克隆失败
        function serialize(val) {
          if (val === undefined) return "";
          if (val === null) return "null";
          if (typeof val === "object") {
            try { return JSON.stringify(val, null, 2); }
            catch (e) {
              // 可能是循环引用或包含 DOM 对象
              try { return String(val); }
              catch (e2) { return "[unserializable]"; }
            }
          }
          return String(val);
        }
        function frameSummary() {
          var frames = Array.from(document.querySelectorAll("iframe, frame")).map(function (f, i) {
            var rect = f.getBoundingClientRect();
            var info = {
              index: i,
              tag: f.tagName.toLowerCase(),
              id: f.id || "",
              name: f.name || "",
              src: f.src || f.getAttribute("src") || "",
              visible: rect.width > 0 && rect.height > 0,
              size: Math.round(rect.width) + "x" + Math.round(rect.height),
              sameOrigin: false,
              title: "",
              text: "",
            };
            try {
              var doc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
              if (doc) {
                info.sameOrigin = true;
                info.title = doc.title || "";
                info.text = (doc.body ? (doc.body.innerText || doc.body.textContent || "") : "").replace(/\s+/g, " ").trim().substring(0, 300);
              }
            } catch (e) {
              info.error = "cross-origin";
            }
            return info;
          });
          return "表达式/语句没有返回值。请让代码显式返回结果，例如 Array.from(...).map(...), document.body.innerText.slice(0,1000), 或 (()=>{ ...; return value; })()。当前页面 iframe 概览: " + JSON.stringify(frames, null, 2);
        }
        var logs = [];
        var originalLog = console.log, originalWarn = console.warn, originalError = console.error;
        function captureConsole(level, args) {
          logs.push("[" + level + "] " + Array.from(args).map(function (v) { return serialize(v); }).join(" "));
        }
        console.log = function () { captureConsole("log", arguments); return originalLog.apply(console, arguments); };
        console.warn = function () { captureConsole("warn", arguments); return originalWarn.apply(console, arguments); };
        console.error = function () { captureConsole("error", arguments); return originalError.apply(console, arguments); };
        function finish(value) {
          console.log = originalLog;
          console.warn = originalWarn;
          console.error = originalError;
          var result = serialize(value);
          if (!result && logs.length > 0) result = "console output:\n" + logs.join("\n");
          if (!result) result = frameSummary();
          return { __aift_ok: true, __aift_result: result };
        }
        try {
          var fn = new Function("return (" + code + ")");
          var result = fn.call(window);
          // 如果返回 Promise，await 它
          if (result && typeof result.then === "function") {
            result = await result;
          }
          return finish(result);
        } catch (e) {
          // 表达式方式失败，尝试语句方式
          try {
            var fn2 = new Function(code);
            var result2 = fn2.call(window);
            if (result2 && typeof result2.then === "function") {
              result2 = await result2;
            }
            return finish(result2);
          } catch (e2) {
            console.log = originalLog;
            console.warn = originalWarn;
            console.error = originalError;
            return { __aift_ok: false, __aift_error: e2.message || String(e2) };
          }
        }
      },
      args: [code],
    }), PAGE_EVAL_TIMEOUT_MS, "页面状态读取");
    if (!results || results.length === 0) {
      return { ok: false, error: "无返回值" };
    }
    var ret = results[0].result;
    if (!ret) return { ok: false, error: "执行器无返回对象" };
    if (ret.__aift_ok) {
      return { ok: true, result: ret.__aift_result };
    }
    return { ok: false, error: ret.__aift_error || "执行失败" };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Injects only generated test data into a file input. This is deliberately separate
// from evalInPage so arbitrary page JavaScript remains observation-only.
async function injectTestFile(options) {
  if (!tabId) return { ok: false, error: "未选择目标标签页" };
  options = options || {};
  var target = { tabId: tabId };
  if (options.frameId !== undefined && options.frameId !== null) target.frameIds = [Number(options.frameId)];
  try {
    var results = await withTimeout(chrome.scripting.executeScript({
      target: target,
      world: "MAIN",
      func: function (selector, fileName, sizeBytes, content, mimeType) {
        var input = document.querySelector(selector);
        if (!(input instanceof HTMLInputElement) || input.type.toLowerCase() !== "file") {
          return { ok: false, error: "目标不是 input[type=file]: " + selector };
        }
        var encoder = new TextEncoder();
        var textBytes = encoder.encode(content || "");
        var finalSize = sizeBytes === undefined || sizeBytes === null ? textBytes.length : sizeBytes;
        if (!Number.isInteger(finalSize) || finalSize < 0 || finalSize > 52428800) {
          return { ok: false, error: "文件大小必须是 0 到 52428800 字节之间的整数" };
        }
        var bytes = new Uint8Array(finalSize);
        bytes.set(textBytes.subarray(0, finalSize));
        var file = new File([bytes], fileName, { type: mimeType || "application/octet-stream" });
        var transfer = new DataTransfer();
        transfer.items.add(file);
        try {
          input.files = transfer.files;
        } catch (error) {
          return { ok: false, error: "浏览器拒绝设置文件列表: " + (error.message || error) };
        }
        input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        return { ok: true, fileName: input.files[0].name, sizeBytes: input.files[0].size, fileCount: input.files.length };
      },
      args: [options.selector, options.fileName, options.sizeBytes, options.content, options.mimeType],
    }), PAGE_EVAL_TIMEOUT_MS, "测试文件注入");
    var value = results && results[0] && results[0].result;
    return value || { ok: false, error: "文件注入没有返回结果" };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

// ---- 按钮状态管理（条件禁用 + tooltip 提示）----
function updateButtonStates() {
  var hasSource = Object.keys(uploadedSourceFiles).length > 0;
  var hasArch = !!archAnalysis;
  var hasTestCases = els.testCases.value.trim().length > 0;
  var isBusy = !!currentPhase;

  // 分析架构按钮：需要已上传源码
  if (!hasSource) {
    els.analyzeBtn.disabled = true;
    els.analyzeBtnTooltip.textContent = "请先上传项目源码";
  } else if (isBusy) {
    els.analyzeBtn.disabled = true;
    els.analyzeBtnTooltip.textContent = "操作进行中，请稍候...";
  } else {
    els.analyzeBtn.disabled = false;
    els.analyzeBtnTooltip.textContent = "";
  }

  // 生成测试用例按钮：需要已上传源码 + 已完成架构分析
  if (!hasSource) {
    els.genTestCasesBtn.disabled = true;
    els.genTestCasesBtnTooltip.textContent = "请先上传项目源码并完成架构分析";
  } else if (!hasArch) {
    els.genTestCasesBtn.disabled = true;
    els.genTestCasesBtnTooltip.textContent = "请先完成项目架构分析";
  } else if (isBusy) {
    els.genTestCasesBtn.disabled = true;
    els.genTestCasesBtnTooltip.textContent = "操作进行中，请稍候...";
  } else {
    els.genTestCasesBtn.disabled = false;
    els.genTestCasesBtnTooltip.textContent = "";
  }

  // 运行测试按钮：需要有测试用例
  if (!hasTestCases) {
    els.runAgentBtn.disabled = true;
    els.runAgentBtnTooltip.textContent = "请先生成或输入测试用例";
  } else if (isBusy) {
    els.runAgentBtn.disabled = true;
    els.runAgentBtnTooltip.textContent = "操作进行中，请稍候...";
  } else {
    els.runAgentBtn.disabled = false;
    els.runAgentBtnTooltip.textContent = "";
  }

  // 测试策略分析按钮：需要已上传源码（不需要测试用例）
  if (!hasSource) {
    els.planBtn.disabled = true;
    els.planBtnTooltip.textContent = "请先上传项目源码";
  } else if (isBusy) {
    els.planBtn.disabled = true;
    els.planBtnTooltip.textContent = "操作进行中，请稍候...";
  } else {
    els.planBtn.disabled = false;
    els.planBtnTooltip.textContent = "";
  }
}

// ---- 流式日志 ----
var streamState = { currentBlock: null, currentType: null, cursor: null, userScrolled: false, textNode: null, textAccum: "" };

function formatContextTokens(tokens) {
  if (!tokens) return "0";
  return tokens >= 1000 ? (tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1).replace(/\.0$/, "") + "K" : String(tokens);
}

function resetContextUsage(config) {
  var totalTokens = config && config.contextSize ? config.contextSize * 1000 : 0;
  els.contextMeterLabel.textContent = totalTokens ? "上下文 0 / " + formatContextTokens(totalTokens) : "上下文 --";
  els.contextMeterBar.style.width = "0%";
  els.contextMeterBar.parentElement.setAttribute("aria-valuenow", "0");
  els.contextMeter.classList.remove("is-warning", "is-danger");
  els.contextMeter.title = "根据本次请求中的文本消息和工具定义估算；图片 token 由模型服务端计算，未计入。";
}

function updateContextUsage(payload) {
  if (!payload || !payload.contextTokens) return;
  var percent = Math.max(0, Math.min(100, Number(payload.percent) || 0));
  var used = Math.max(0, Number(payload.inputTokens) || 0);
  var total = Math.max(0, Number(payload.contextTokens) || 0);
  var reserved = Math.max(0, Number(payload.reservedOutputTokens) || 0);
  els.contextMeterLabel.textContent = "上下文 " + formatContextTokens(used) + " / " + formatContextTokens(total) + " · " + Math.round(percent) + "%";
  els.contextMeterBar.style.width = percent + "%";
  els.contextMeterBar.parentElement.setAttribute("aria-valuenow", String(Math.round(percent)));
  els.contextMeter.classList.toggle("is-warning", percent >= 75 && percent < 90);
  els.contextMeter.classList.toggle("is-danger", percent >= 90);
  els.contextMeter.title = "第 " + (payload.round || 0) + " 轮请求的文本上下文估算。已为模型输出预留 " + formatContextTokens(reserved) + "；图片 token 由模型服务端计算，未计入。";
}

// 监听用户手动滚动：如果用户往上滚了，停止自动滚动；滚回底部则恢复
els.streamLog.addEventListener("scroll", function () {
  var atBottom = els.streamLog.scrollHeight - els.streamLog.scrollTop - els.streamLog.clientHeight < 30;
  streamState.userScrolled = !atBottom;
});

function streamClear() {
  els.streamLog.innerHTML = "";
  streamState.currentBlock = null;
  streamState.currentType = null;
  streamState.cursor = null;
  streamState.userScrolled = false;
  streamState.textNode = null;
  streamState.textAccum = "";
  resetContextUsage();
  // 清空截图
  screenshotState.history = [];
  if (els.screenshotContainer) els.screenshotContainer.innerHTML = '<div class="screenshot-empty">测试启动后，AI 每次接收到的截图会在此展示</div>';
  if (els.screenshotCard) els.screenshotCard.style.display = "none";
}

function streamEndBlock() {
  if (streamState.cursor) {
    streamState.cursor.remove();
    streamState.cursor = null;
  }
  streamState.currentBlock = null;
  streamState.currentType = null;
  streamState.textNode = null;
  streamState.textAccum = "";
}

function streamAppend(type, content) {
  if (type === "context_usage") {
    try {
      updateContextUsage(JSON.parse(content));
    } catch (e) {
      console.warn("[AIFT] 上下文占用数据解析失败:", e);
    }
    return;
  }
  if (!content && type !== "round" && type !== "round_end") return;

  // 截图类型：渲染到截图展示区域
  if (type === "screenshot") {
    try {
      var shotData = JSON.parse(content);
      renderScreenshot(shotData);
    } catch(e) {
      console.warn("[AIFT] 截图数据解析失败:", e);
    }
    return;
  }

  // 轮次结束 / 新轮次开始 → 结束当前块
  if (type === "round" || type === "round_end") {
    streamEndBlock();
    if (type === "round_end") return;
  }

  // 如果类型变了，结束当前块，开新块
  if (streamState.currentType !== type) {
    streamEndBlock();
    var cls = "stream-block stream-" + type;
    var block = document.createElement("div");
    block.className = cls;
    els.streamLog.appendChild(block);
    streamState.currentBlock = block;
    streamState.currentType = type;
    streamState.textAccum = "";
    streamState.textNode = block.appendChild(document.createTextNode(""));

    // round 类型直接写入内容就结束
    if (type === "round") {
      streamState.textNode.nodeValue = content;
      streamEndBlock();
      return;
    }

    // reasoning 类型：默认折叠，点击展开/折叠
    if (type === "reasoning") {
      block.addEventListener("click", function () {
        block.classList.toggle("expanded");
      });
    }
  }

  // 追加内容到当前块（复用单个文本节点，避免 DOM 节点爆炸）
  if (streamState.currentBlock && content) {
    // 移除光标
    if (streamState.cursor) {
      streamState.cursor.remove();
      streamState.cursor = null;
    }
    // action_result 带 pass/fail 标记
    if (type === "action_result") {
      var lower = content.toLowerCase();
      if (lower.indexOf("pass") !== -1 || lower.indexOf("ok") !== -1) {
        streamState.currentBlock.className = "stream-block stream-action-result pass";
      } else if (lower.indexOf("fail") !== -1 || lower.indexOf("error") !== -1) {
        streamState.currentBlock.className = "stream-block stream-action-result fail";
      }
    }
    streamState.textAccum += content;
    streamState.textNode.nodeValue = streamState.textAccum;

    // 添加光标
    var cursor = document.createElement("span");
    cursor.className = "stream-cursor";
    streamState.currentBlock.appendChild(cursor);
    streamState.cursor = cursor;
  }

  // 自动滚动到底部（仅在用户未手动上滚时）
  if (!streamState.userScrolled) {
    els.streamLog.scrollTop = els.streamLog.scrollHeight;
  }
}

// ---- 截图展示 ----
var screenshotState = { collapsed: false, history: [] };

function renderScreenshot(data) {
  if (!data || !data.dataUrl) return;

  // 显示截图卡片
  els.screenshotCard.style.display = "";

  // 记录历史
  screenshotState.history.push(data);
  if (screenshotState.history.length > 20) screenshotState.history.shift();

  // 更新信息标签
  var sourceLabel = data.source === "initial" ? "初始截图" :
                    data.source === "manual" ? "AI 主动截图" : "自动截图";
  els.screenshotInfo.textContent = "第" + data.round + "轮 · " + sourceLabel +
    " · " + data.width + "x" + data.height + " · " + (data.elements || 0) + " 个标注元素";

  // 渲染截图
  var html = '';
  // 最新截图（大图）
  html += '<div class="screenshot-current">';
  html += '<div class="screenshot-label">最新截图（AI 当前看到的画面）</div>';
  html += '<img src="' + data.dataUrl + '" class="screenshot-img" />';
  html += '</div>';

  // 历史缩略图
  if (screenshotState.history.length > 1) {
    html += '<div class="screenshot-history">';
    html += '<div class="screenshot-label">历史截图（点击查看大图）</div>';
    html += '<div class="screenshot-thumbs">';
    for (var i = screenshotState.history.length - 1; i >= 0; i--) {
      var h = screenshotState.history[i];
      var hSource = h.source === "initial" ? "初始" : (h.source === "manual" ? "主动" : "自动");
      var active = (i === screenshotState.history.length - 1) ? " active" : "";
      html += '<div class="screenshot-thumb' + active + '" data-idx="' + i + '">';
      html += '<img src="' + h.dataUrl + '" />';
      html += '<span class="thumb-label">R' + h.round + ' ' + hSource + '</span>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
  }

  els.screenshotContainer.innerHTML = html;

  // 绑定缩略图点击
  var thumbs = els.screenshotContainer.querySelectorAll('.screenshot-thumb');
  thumbs.forEach(function(thumb) {
    thumb.addEventListener('click', function() {
      var idx = parseInt(this.getAttribute('data-idx'));
      var h = screenshotState.history[idx];
      if (!h) return;
      // 更新大图
      var mainImg = els.screenshotContainer.querySelector('.screenshot-current img');
      if (mainImg) mainImg.src = h.dataUrl;
      var mainLabel = els.screenshotContainer.querySelector('.screenshot-current .screenshot-label');
      if (mainLabel) {
        var hSource = h.source === "initial" ? "初始截图" : (h.source === "manual" ? "AI 主动截图" : "自动截图");
        mainLabel.textContent = "第" + h.round + "轮 · " + hSource + " · " + h.width + "x" + h.height;
      }
      // 更新缩略图选中状态
      thumbs.forEach(function(t) { t.classList.remove('active'); });
      this.classList.add('active');
    });
  });
}

// 收起/展开截图
if (els.screenshotToggleBtn) {
  els.screenshotToggleBtn.addEventListener('click', function() {
    screenshotState.collapsed = !screenshotState.collapsed;
    els.screenshotContainer.style.display = screenshotState.collapsed ? 'none' : '';
    els.screenshotToggleBtn.textContent = screenshotState.collapsed ? '展开' : '收起';
  });
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  els.log.textContent = `[${ts}] ${msg}\n` + els.log.textContent;
}

function setStatus(s) {
  els.status.textContent = s;
}

function setContentExpanded(content, trigger, expanded) {
  content.hidden = !expanded;
  trigger.setAttribute("aria-expanded", String(expanded));
}

function bindSectionToggle(trigger, content) {
  function toggle() {
    setContentExpanded(content, trigger, content.hidden);
  }
  trigger.addEventListener("click", toggle);
  trigger.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  });
}

// ---- 提示词输入弹框 ----
var promptModalResolve = null;

function showPromptDialog(title, desc, placeholder) {
  return new Promise(function (resolve) {
    var modal = document.getElementById("promptModal");
    var titleEl = document.getElementById("promptModalTitle");
    var descEl = document.getElementById("promptModalDesc");
    var inputEl = document.getElementById("promptModalInput");

    titleEl.textContent = title || "额外提示词";
    descEl.textContent = desc || "可输入额外的提示词来引导 AI（可选）：";
    inputEl.value = "";
    inputEl.placeholder = placeholder || "输入额外提示词（可选，留空则直接执行）...";

    modal.style.display = "flex";
    promptModalResolve = resolve;

    setTimeout(function () { inputEl.focus(); }, 50);
  });
}

function confirmPromptDialog() {
  var modal = document.getElementById("promptModal");
  var inputEl = document.getElementById("promptModalInput");
  var value = inputEl.value.trim();
  modal.style.display = "none";
  if (promptModalResolve) {
    promptModalResolve(value);
    promptModalResolve = null;
  }
}

function cancelPromptDialog() {
  var modal = document.getElementById("promptModal");
  modal.style.display = "none";
  if (promptModalResolve) {
    promptModalResolve(null);
    promptModalResolve = null;
  }
}

// ---- 配置存取 ----
async function loadConfig() {
  const cfg = await chrome.storage.local.get("aift_config");
  const c = cfg.aift_config || {};
  els.apiUrl.value = c.apiUrl || "";
  els.apiKey.value = c.apiKey || "";
  els.model.value = c.model || "gpt-4o";
  els.contextSize.value = c.contextSize || 128;
  // 能力未知时按文本模型处理，避免把图片传给不支持多模态的模型。
  els.visionSupported.checked = c.visionSupported === true;
  els.enableThinking.checked = c.enableThinking || false; // 默认 false
  els.requirement.value = c.requirement || "";
  els.testCases.value = c.testCases || "";
  els.exportTestCasesBtn.disabled = !els.testCases.value.trim();
  log("配置已加载");
  // 加载架构分析缓存
  loadArchCache();
  updateButtonStates();
}

function getAiConfig() {
  return {
    apiUrl: els.apiUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    contextSize: parseInt(els.contextSize.value) || 128,
    visionSupported: els.visionSupported.checked,
    enableThinking: els.enableThinking.checked,
  };
}

function validateAiConfig(config, requireComplete) {
  if (window.AIFT_ConfigValidator && AIFT_ConfigValidator.validateAiConfig) {
    return AIFT_ConfigValidator.validateAiConfig(config, requireComplete);
  }
  if (requireComplete && (!config.apiUrl || !config.apiKey || !config.model)) {
    return { ok: false, error: "请先填写 AI 配置（API URL / Key / 模型）" };
  }
  return { ok: true };
}

function reportConfigValidation(config, requireComplete) {
  var validation = validateAiConfig(config, requireComplete);
  if (!validation.ok) {
    log(validation.error);
    setStatus("AI 配置无效");
    return false;
  }
  return true;
}

async function saveConfig() {
  const config = Object.assign(getAiConfig(), {
    requirement: els.requirement.value,
    testCases: els.testCases.value,
  });
  var validation = validateAiConfig(config, false);
  await chrome.storage.local.set({ aift_config: config });
  log("配置已保存");
  if (!validation.ok) {
    log("⚠️ " + validation.error);
    setStatus("配置已保存（尚未有效）");
  } else {
    setStatus("配置已保存");
  }
}

// 文本模型无法消费截图。即使模型忽略了提示词，最终用例也不能留下不可执行的视觉断言。
function normalizeTestCasesForCapabilities(text, visionSupported) {
  if (visionSupported || !text) return text;
  return text.replace(
    /verify_ui\s*\(\s*\)|截图|视觉(?:验证|检查|分析)?|图片(?:验证|检查|分析)?/gi,
    "检查页面元素状态、文本和属性"
  );
}

// ---- content script 按需注入 ----
var observedFrameIds = new Set([0]);

async function ensureContentScript() {
  var results = await withTimeout(chrome.scripting.executeScript({
    target: { tabId: tabId, allFrames: true },
    files: ["content/content.js"],
  }), PAGE_EVAL_TIMEOUT_MS, "注入页面观察器");
  observedFrameIds = new Set([0]);
  (results || []).forEach(function(item) {
    if (item && typeof item.frameId === "number") observedFrameIds.add(item.frameId);
  });
  return Array.from(observedFrameIds);
}

async function captureAllFrameSnapshots(tabId) {
  var frameIds = await ensureContentScript();
  var snapshots = [];
  var unavailable = [];
  await Promise.all(frameIds.map(async function(frameId) {
    try {
      var response = await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: "AIFT_CAPTURE_SNAPSHOT" }, { frameId: frameId }),
        CONTENT_MESSAGE_TIMEOUT_MS,
        "iframe 观察器通信"
      );
      if (!response || !response.ok || !response.snapshot) throw new Error((response && response.error) || "无快照响应");
      var snapshot = response.snapshot;
      snapshot.frameId = frameId;
      snapshot.frameLabel = frameId === 0 ? "top" : "iframe-" + frameId;
      snapshot.nodes = (snapshot.nodes || []).map(function(node) {
        return Object.assign({}, node, { ref: "f" + frameId + ":" + node.ref, frameId: frameId });
      });
      snapshots.push(snapshot);
    } catch (error) {
      unavailable.push({ frameId: frameId, error: error.message || String(error) });
    }
  }));
  snapshots.sort(function(a, b) { return a.frameId - b.frameId; });
  var top = snapshots.filter(function(snapshot) { return snapshot.frameId === 0; })[0] || snapshots[0] || {};
  var pageText = snapshots.map(function(snapshot) {
    return "[" + snapshot.frameLabel + " " + (snapshot.url || "") + "]\n" + (snapshot.pageText || "");
  }).join("\n\n");
  return {
    ok: true,
    snapshot: {
      url: top.url || "",
      title: top.title || "",
      timestamp: Date.now(),
      interactiveCount: snapshots.reduce(function(total, snapshot) { return total + (snapshot.interactiveCount || 0); }, 0),
      nodes: snapshots.reduce(function(nodes, snapshot) { return nodes.concat(snapshot.nodes || []); }, []),
      pageText: pageText.substring(0, 12000),
      frames: snapshots.map(function(snapshot) {
        return { frameId: snapshot.frameId, label: snapshot.frameLabel, url: snapshot.url || "", title: snapshot.title || "", interactiveCount: snapshot.interactiveCount || 0 };
      }),
      unavailableFrames: unavailable,
    },
  };
}

async function preflightTargetTab() {
  if (!tabId) {
    log("请先选择目标标签页");
    setStatus("未选择标签页");
    return false;
  }
  var tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    log("目标标签页不可用: " + (error.message || error));
    setStatus("目标标签页已关闭");
    return false;
  }
  var eligibility = getTabEligibility(tab);
  if (!eligibility.ok) {
    log(eligibility.error);
    setStatus("目标页面不可测试");
    return false;
  }
  try {
    await ensureContentScript();
    var ping = await sendToContent(tabId, { type: "AIFT_PING" });
    if (!ping || !ping.ok || !ping.pong) throw new Error("观察器未响应");
    if (eligibility.warning) log("⚠️ " + eligibility.warning);
    return true;
  } catch (error) {
    var message = error.message || String(error);
    if (/file:|file URL|文件网址/i.test(tab.url || "") || /file:|file URL|文件网址/i.test(message)) {
      message = "无法访问本地文件页面，请在扩展详情中启用“允许访问文件网址”";
    }
    log("目标页面预检失败: " + message);
    setStatus("目标页面不可注入");
    return false;
  }
}

// ---- 发消息给 content script ----
function sendToContent(tabId, message) {
  if (message && message.type === "AIFT_CAPTURE_SNAPSHOT" && message.allFrames !== false) {
    return captureAllFrameSnapshots(tabId);
  }
  var frameId = message && message.frameId;
  var request = frameId !== undefined && frameId !== null
    ? chrome.tabs.sendMessage(tabId, message, { frameId: Number(frameId) })
    : chrome.tabs.sendMessage(tabId, message);
  return withTimeout(request, CONTENT_MESSAGE_TIMEOUT_MS, "页面观察器通信");
}

// ---- 实时测试结果展示 ----
var testCasesState = [];
var expandedCases = new Set(); // 实时结果中已展开的用例 key
var expandedReportCases = new Set(); // 测试报告中已展开的用例 key
var reportExtraExpanded = false; // 历史/完成报告中的额外断言默认折叠
var currentAssertions = []; // 当前断言列表（供折叠/展开重渲染时使用）
var lastReportResult = null; // 上次测试报告结果
var lastReportSummary = ""; // 上次测试报告总结
var lastTestReport = null;
var runHistory = [];
var RUN_HISTORY_KEY = "aift_run_history_v1";
var errorRecords = [];
var ERROR_RECORDS_KEY = "aift_error_records_v1";
var activeErrorRunId = "";

function getErrorRecordLabel(record) {
  return record.category === "failed_assertion" ? "❌ 断言失败" :
    (record.category === "agent_pause" || record.category === "agent_limit" ? "⚠️ Agent 陷入停滞" : "⚠️ 工具失败");
}

function redactDiagnostic(value) {
  return window.AIFT_Redaction && AIFT_Redaction.redact ? AIFT_Redaction.redact(value) : value;
}

function trimErrorRecords() {
  if (window.AIFT_DiagnosticStore && AIFT_DiagnosticStore.trimForStorage) {
    errorRecords = AIFT_DiagnosticStore.trimForStorage(errorRecords, { maxRecords: 100, maxBytes: 2 * 1024 * 1024 });
  } else {
    errorRecords = errorRecords.slice(-100);
  }
}

function renderErrorRecords() {
  var total = errorRecords.length;
  els.errorRecordCount.textContent = total > 0 ? total + " 条" : "";
  els.exportErrorsBtn.disabled = total === 0;
  els.clearErrorsBtn.disabled = total === 0;
  if (total === 0) {
    els.errorRecordList.textContent = "暂无已保存的错误记录";
    return;
  }
  var recent = errorRecords.slice(-5).reverse();
  var html = recent.map(function(record, index) {
    var recordIndex = errorRecords.length - 1 - index;
    var label = getErrorRecordLabel(record);
    var detail = record.message || record.description || record.reason || "未知错误";
    var traceHint = record.recentTrace && record.recentTrace.length ? " · 已保存 " + record.recentTrace.length + " 步轨迹" : "";
    return '<div class="error-record-item"><div class="error-record-copy"><span class="error-record-title">' + label +
      (record.testCaseId ? " · " + escapeHtml(record.testCaseId) : "") +
      '</span><span class="error-record-detail">第 ' + (record.round || 0) + " 轮 · " + escapeHtml(detail) + escapeHtml(traceHint) +
      '</span></div><button class="btn btn-secondary btn-sm error-detail-btn" data-error-index="' + recordIndex + '">查看</button></div>';
  }).join("");
  if (total > recent.length) html += '<div class="error-record-more">另有 ' + (total - recent.length) + ' 条较早记录已保留，可导出或按新错误继续查看</div>';
  els.errorRecordList.innerHTML = html;
}

function persistErrorRecords() {
  chrome.storage.local.set({ [ERROR_RECORDS_KEY]: errorRecords }).catch(function(error) {
    log("错误记录保存失败: " + (error.message || error));
  });
}

function addErrorRecord(record) {
  errorRecords.push(redactDiagnostic(record));
  trimErrorRecords();
  persistErrorRecords();
  renderErrorRecords();
}

async function loadErrorRecords() {
  try {
    var stored = await chrome.storage.local.get(ERROR_RECORDS_KEY);
    errorRecords = Array.isArray(stored[ERROR_RECORDS_KEY]) ? stored[ERROR_RECORDS_KEY] : [];
    trimErrorRecords();
  } catch (error) {
    errorRecords = [];
    log("错误记录读取失败: " + (error.message || error));
  }
  renderErrorRecords();
}

function showErrorDetail(index) {
  var record = errorRecords[index];
  if (!record) return;
  var safe = redactDiagnostic(record);
  var detail = safe.message || safe.description || safe.reason || "未知错误";
  els.errorDetailTitle.textContent = getErrorRecordLabel(safe);
  els.errorDetailMeta.textContent = [
    safe.testCaseId || "未关联 TC",
    "第 " + (safe.round || 0) + " 轮",
    safe.timestamp || "",
    safe.diagnosticTruncated ? "旧记录已压缩" : "",
  ].filter(Boolean).join(" · ");
  els.errorDetailContent.textContent = [
    "错误信息",
    detail,
    "",
    "AI 推理",
    safe.reasoning || "（模型未返回可记录的推理内容）",
    "",
    "最近执行轨迹",
    JSON.stringify(safe.recentTrace || [], null, 2),
    "",
    "当前 DOM 摘要",
    JSON.stringify(safe.domSnapshot || null, null, 2),
    "",
    "前一份 DOM 摘要",
    JSON.stringify(safe.previousDomSnapshot || null, null, 2),
    "",
    "相关源码交互契约",
    JSON.stringify(safe.sourceInteractions || [], null, 2),
  ].join("\n");
  els.errorDetailModal.style.display = "flex";
}

function closeErrorDetail() {
  els.errorDetailModal.style.display = "none";
}

function createTestReport(result, summary, assertions) {
  if (!window.AIFT_TestReport) return null;
  var currentRunErrors = errorRecords.filter(function(record) { return record.runId === activeErrorRunId; });
  return AIFT_TestReport.buildReport({
    runId: activeErrorRunId,
    result: result,
    summary: summary,
    requirement: els.requirement.value.trim(),
    target: document.getElementById("tabInfo").textContent || "",
    testCases: testCasesState,
    assertions: assertions || currentAssertions,
    errorRecords: redactDiagnostic(currentRunErrors),
  });
}

function trimRunHistory() {
  if (window.AIFT_RunHistory && AIFT_RunHistory.trim) {
    runHistory = AIFT_RunHistory.trim(runHistory, { maxReports: 20, maxBytes: 1024 * 1024 });
  } else {
    runHistory = runHistory.slice(-20);
  }
}

function renderRunHistory() {
  var total = runHistory.length;
  els.runHistoryCount.textContent = total > 0 ? total + " 次" : "";
  els.clearRunHistoryBtn.disabled = total === 0;
  if (total === 0) {
    els.runHistoryList.textContent = "暂无已保存的测试报告";
    return;
  }
  var recent = runHistory.slice(-5).reverse();
  els.runHistoryList.innerHTML = recent.map(function(report, index) {
    var reportIndex = runHistory.length - 1 - index;
    var stats = report.stats || {};
    var resultClass = report.result === "pass" ? "run-history-pass" : (report.result === "fail" ? "run-history-fail" : "run-history-unknown");
    var resultLabel = report.result === "pass" ? "✅ 通过" : (report.result === "fail" ? "❌ 失败" : "⚠️ 未完成");
    var generatedAt = report.generatedAt ? new Date(report.generatedAt).toLocaleString() : "未知时间";
    return '<div class="run-history-item"><div class="run-history-copy"><span class="run-history-title ' + resultClass + '">' + resultLabel +
      '</span><span class="run-history-meta">' + escapeHtml(generatedAt) + " · " + (stats.passed || 0) + "/" + (stats.total || 0) + " 通过" + ((stats.inconclusive || 0) ? " · " + stats.inconclusive + " 未完成验证" : "") +
      '</span></div><button class="btn btn-secondary btn-sm" data-report-view="' + reportIndex + '">查看</button><button class="btn btn-secondary btn-sm" data-report-export="' + reportIndex + '">导出</button></div>';
  }).join("");
}

function persistRunHistory() {
  chrome.storage.local.set({ [RUN_HISTORY_KEY]: runHistory }).catch(function(error) {
    log("测试报告历史保存失败: " + (error.message || error));
  });
}

function rememberTestReport(report) {
  if (!report) return;
  runHistory = runHistory.filter(function(item) { return item.runId !== report.runId; });
  runHistory.push(report);
  trimRunHistory();
  persistRunHistory();
  renderRunHistory();
}

async function loadRunHistory() {
  try {
    var stored = await chrome.storage.local.get(RUN_HISTORY_KEY);
    runHistory = Array.isArray(stored[RUN_HISTORY_KEY]) ? stored[RUN_HISTORY_KEY] : [];
    trimRunHistory();
  } catch (error) {
    runHistory = [];
    log("测试报告历史读取失败: " + (error.message || error));
  }
  renderRunHistory();
}

function showStoredReport(index) {
  if (currentPhase) {
    setStatus("运行中不能切换历史报告");
    return;
  }
  var report = runHistory[index];
  if (!report) return;
  lastTestReport = report;
  lastReportResult = report.result;
  lastReportSummary = report.summary || "";
  testCasesState = report.testCases || [];
  currentAssertions = report.assertions || [];
  expandedCases.clear();
  expandedReportCases.clear();
  reportExtraExpanded = false;
  els.exportTestReportBtn.disabled = false;
  els.resultArea.innerHTML = renderTestReport(lastReportResult, lastReportSummary, testCasesState, currentAssertions);
  setStatus("正在查看历史报告");
}

function getTestCaseAssertion(testCase) {
  return testCase && (testCase.assertionDesc || testCase.assertion) || "";
}

function clearRunHistory() {
  runHistory = [];
  chrome.storage.local.remove(RUN_HISTORY_KEY).catch(function(error) {
    log("测试报告历史清除失败: " + (error.message || error));
  });
  renderRunHistory();
  setStatus("测试报告历史已清除");
}

function renderTestResults(testCases, assertions) {
  testCases = testCases || testCasesState;
  assertions = assertions || [];

  if (testCases.length === 0 && assertions.length === 0) {
    els.resultArea.innerHTML = "尚未运行";
    els.testProgress.textContent = "";
    return;
  }

  var passed = 0, failed = 0, inconclusive = 0, pending = 0, testing = 0;
  for (var i = 0; i < testCases.length; i++) {
    if (testCases[i].status === "passed") passed++;
    else if (testCases[i].status === "failed") failed++;
    else if (testCases[i].status === "inconclusive") inconclusive++;
    else if (testCases[i].status === "testing") testing++;
    else pending++;
  }

  var total = testCases.length;
  var tested = passed + failed + inconclusive;
  var progressParts = [];
  if (total > 0) {
    progressParts.push(tested + "/" + total + " 已测");
    if (passed > 0) progressParts.push(passed + " 通过");
    if (failed > 0) progressParts.push(failed + " 失败");
    if (inconclusive > 0) progressParts.push(inconclusive + " 未完成验证");
    if (testing > 0) progressParts.push(testing + " 测试中");
    if (pending > 0) progressParts.push(pending + " 待测");
  }
  els.testProgress.textContent = progressParts.join(" · ");

  var html = "";

  // 测试用例列表
  if (testCases.length > 0) {
    var allExpanded = testCases.every(function (tc) {
      return expandedCases.has(tc.id || tc.title || tc.text);
    });
    var toggleLabel = allExpanded ? "全部折叠" : "全部展开";
    html += '<div class="test-case-list">';
    html += '<div class="test-case-toolbar"><button class="toggle-all-btn" data-action="toggle-all-rt">' + toggleLabel + '</button></div>';
    for (var i = 0; i < testCases.length; i++) {
      var tc = testCases[i];
      var tcKey = tc.id || tc.title || tc.text;
      var isExpanded = expandedCases.has(tcKey);
      var cls = "test-case test-" + tc.status + (isExpanded ? "" : " collapsed");
      var icon = tc.status === "passed" ? "✅" : (tc.status === "failed" ? "❌" : (tc.status === "inconclusive" ? "⚠️" : (tc.status === "testing" ? "⟳" : (tc.status === "skipped" ? "⊘" : "○"))));
      html += '<div class="' + cls + '" data-tc-key="' + escapeHtml(tcKey) + '">';
      html += '<div class="test-case-header">';
      html += '<span class="test-toggle">' + (isExpanded ? "▼" : "▶") + '</span>';
      html += '<span class="test-icon">' + icon + '</span>';
      html += '<span class="test-id">' + escapeHtml(tc.id || ("TC" + (i + 1))) + '</span> ';
      html += '<span class="test-text">' + escapeHtml(tc.title || tc.text) + '</span>';
      html += '</div>';
      html += '<div class="test-case-body">';
      if (tc.page) {
        html += '<span class="test-detail">页面: ' + escapeHtml(tc.page) + '</span>';
      }
      if (tc.preconditions) {
        html += '<span class="test-detail">前置: ' + escapeHtml(tc.preconditions) + '</span>';
      }
      if (tc.steps) {
        html += '<span class="test-detail">操作:</span>' + formatStepsHtml(tc.steps);
      }
      if (tc.expected) {
        html += '<span class="test-detail">预期:</span>' + formatExpectedHtml(tc.expected);
      }
      var assertionDesc = getTestCaseAssertion(tc);
      if (assertionDesc && assertionDesc !== tc.text && assertionDesc !== tc.title) {
        html += '<span class="test-detail">断言: ' + escapeHtml(assertionDesc) + '</span>';
      }
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
  }

  // 未匹配到测试用例的额外断言
  if (assertions.length > 0) {
    var matchedDescs = {};
    for (var i = 0; i < testCases.length; i++) {
      var caseAssertion = getTestCaseAssertion(testCases[i]);
      if (caseAssertion) matchedDescs[caseAssertion] = true;
    }
    var unmatched = [];
    for (var i = 0; i < assertions.length; i++) {
      if (!matchedDescs[assertions[i].description]) {
        unmatched.push(assertions[i]);
      }
    }
    if (unmatched.length > 0) {
      html += '<div class="test-extra-list"><div class="test-extra-title">额外断言:</div>';
      for (var i = 0; i < unmatched.length; i++) {
        var u = unmatched[i];
        var ucls = u.outcome === "inconclusive" ? "test-case test-case-simple test-inconclusive" : (u.passed ? "test-case test-case-simple test-passed" : "test-case test-case-simple test-failed");
        var uicon = u.outcome === "inconclusive" ? "⚠️" : (u.passed ? "✅" : "❌");
        html += '<div class="' + ucls + '">';
        html += '<span class="test-icon">' + uicon + '</span>';
        html += '<span class="test-text">' + escapeHtml(u.description) + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }
  }

  els.resultArea.innerHTML = html;
}

function escapeHtml(text) {
  if (!text) return "";
  var div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 格式化操作步骤为纯文本 HTML（不拆分，避免错位）
 */
function formatStepsHtml(stepsText) {
  if (!stepsText) return "";
  return '<span class="step-plain">' + escapeHtml(stepsText.trim()) + '</span>';
}

/**
 * 格式化预期结果为纯文本 HTML（不拆分，避免错位）
 */
function formatExpectedHtml(expectedText) {
  if (!expectedText) return "";
  return '<span class="expected-plain">' + escapeHtml(expectedText.trim()) + '</span>';
}

// ---- 测试报告 HTML 渲染 ----
function renderTestReport(result, summary, testCases, assertions) {
  testCases = testCases || testCasesState;
  assertions = assertions || [];

  var passed = 0, failed = 0, inconclusive = 0, skipped = 0, pending = 0, testing = 0;
  for (var i = 0; i < testCases.length; i++) {
    var s = testCases[i].status;
    if (s === "passed") passed++;
    else if (s === "failed") failed++;
    else if (s === "inconclusive") inconclusive++;
    else if (s === "skipped") skipped++;
    else if (s === "testing") testing++;
    else pending++;
  }
  var total = testCases.length;
  var tested = passed + failed + inconclusive;
  var conclusive = passed + failed;
  var passRate = conclusive > 0 ? Math.round(passed / conclusive * 100) : 0;

  // 整体结果样式
  var resultClass = result === "pass" ? "report-result-pass" : (result === "fail" ? "report-result-fail" : "report-result-unknown");
  var resultLabel = result === "pass" ? "通过" : (result === "fail" ? "失败" : "未知");
  var resultIcon = result === "pass" ? "✓" : (result === "fail" ? "✗" : "?");

  var html = '';
  html += '<div class="test-report">';

  // 报告头部
  html += '<div class="report-header ' + resultClass + '">';
  html += '<div class="report-header-left">';
  html += '<span class="report-result-icon">' + resultIcon + '</span>';
  html += '<div>';
  html += '<div class="report-result-label">测试' + resultLabel + '</div>';
  html += '<div class="report-result-stats">' + tested + '/' + total + ' 用例已测</div>';
  html += '</div>';
  html += '</div>';
  html += '<div class="report-pass-rate">';
  html += '<div class="pass-rate-value">' + passRate + '%</div>';
  html += '<div class="pass-rate-label">通过率</div>';
  html += '</div>';
  html += '</div>';

  // 统计概览
  html += '<div class="report-stats">';
  html += '<div class="stat-item stat-passed"><span class="stat-num">' + passed + '</span><span class="stat-label">通过</span></div>';
  html += '<div class="stat-item stat-failed"><span class="stat-num">' + failed + '</span><span class="stat-label">失败</span></div>';
  if (inconclusive > 0) html += '<div class="stat-item stat-inconclusive"><span class="stat-num">' + inconclusive + '</span><span class="stat-label">未完成验证</span></div>';
  if (skipped > 0) html += '<div class="stat-item stat-skipped"><span class="stat-num">' + skipped + '</span><span class="stat-label">跳过</span></div>';
  if (testing > 0) html += '<div class="stat-item stat-testing"><span class="stat-num">' + testing + '</span><span class="stat-label">测试中</span></div>';
  if (pending > 0) html += '<div class="stat-item stat-pending"><span class="stat-num">' + pending + '</span><span class="stat-label">未测</span></div>';
  html += '</div>';

  // 进度条
  if (total > 0) {
    html += '<div class="report-progress-bar">';
    var passPct = (passed / total * 100);
    var failPct = (failed / total * 100);
    var inconclusivePct = (inconclusive / total * 100);
    var skipPct = (skipped / total * 100);
    html += '<div class="progress-segment progress-passed" style="width:' + passPct + '%"></div>';
    html += '<div class="progress-segment progress-failed" style="width:' + failPct + '%"></div>';
    html += '<div class="progress-segment progress-inconclusive" style="width:' + inconclusivePct + '%"></div>';
    html += '<div class="progress-segment progress-skipped" style="width:' + skipPct + '%"></div>';
    html += '</div>';
  }

  // AI 总结
  if (summary) {
    html += '<div class="report-summary">';
    html += '<div class="report-summary-title">AI 总结</div>';
    html += '<div class="report-summary-text">' + escapeHtml(summary) + '</div>';
    html += '</div>';
  }

  // 用例详情列表
  if (testCases.length > 0) {
    var allReportExpanded = testCases.every(function (tc) {
      return expandedReportCases.has(tc.id || tc.title || tc.text);
    });
    var reportToggleLabel = allReportExpanded ? "全部折叠" : "全部展开";
    html += '<div class="report-cases">';
    html += '<div class="report-cases-header">';
    html += '<div class="report-cases-title">用例详情</div>';
    html += '<button class="toggle-all-btn" data-action="toggle-all-report">' + reportToggleLabel + '</button>';
    html += '</div>';
    for (var i = 0; i < testCases.length; i++) {
      var tc = testCases[i];
      var tcKey = tc.id || tc.title || tc.text;
      var isExpanded = expandedReportCases.has(tcKey);
      var tcClass = "report-case report-case-" + tc.status + (isExpanded ? "" : " collapsed");
      var tcIcon = tc.status === "passed" ? "✅" : (tc.status === "failed" ? "❌" : (tc.status === "inconclusive" ? "⚠️" : (tc.status === "testing" ? "⟳" : (tc.status === "skipped" ? "⊘" : "○"))));

      html += '<div class="' + tcClass + '" data-tc-key="' + escapeHtml(tcKey) + '">';
      html += '<div class="case-header">';
      html += '<span class="case-toggle">' + (isExpanded ? "▼" : "▶") + '</span>';
      html += '<span class="case-icon">' + tcIcon + '</span>';
      html += '<span class="case-id">' + escapeHtml(tc.id || ("TC" + (i + 1))) + '</span>';
      html += '<span class="case-title">' + escapeHtml(tc.title || tc.text) + '</span>';
      if (tc.page) html += '<span class="case-page">' + escapeHtml(tc.page) + '</span>';
      html += '</div>';
      html += '<div class="case-body">';
      if (tc.preconditions) html += '<div class="case-row"><span class="case-label">前置</span><span class="case-value">' + escapeHtml(tc.preconditions) + '</span></div>';
      if (tc.steps) html += '<div class="case-row"><span class="case-label">操作</span><div class="case-value">' + formatStepsHtml(tc.steps) + '</div></div>';
      if (tc.expected) html += '<div class="case-row"><span class="case-label">预期</span><div class="case-value">' + formatExpectedHtml(tc.expected) + '</div></div>';
      var assertionDesc = getTestCaseAssertion(tc);
      if (assertionDesc && assertionDesc !== tc.text && assertionDesc !== tc.title) {
        html += '<div class="case-row"><span class="case-label">断言</span><span class="case-value">' + escapeHtml(assertionDesc) + '</span></div>';
      }
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
  }

  // 额外断言
  if (assertions.length > 0) {
    var matchedDescs = {};
    for (var i = 0; i < testCases.length; i++) {
      var caseAssertion = getTestCaseAssertion(testCases[i]);
      if (caseAssertion) matchedDescs[caseAssertion] = true;
    }
    var unmatched = [];
    for (var i = 0; i < assertions.length; i++) {
      if (!matchedDescs[assertions[i].description]) unmatched.push(assertions[i]);
    }
    if (unmatched.length > 0) {
      html += '<div class="report-extra">';
      html += '<button class="report-extra-toggle" data-action="toggle-report-extra" aria-expanded="' + (reportExtraExpanded ? "true" : "false") + '">';
      html += '<span class="report-extra-arrow">' + (reportExtraExpanded ? "▼" : "▶") + '</span>额外断言 (' + unmatched.length + ')</button>';
      html += '<div class="report-extra-content' + (reportExtraExpanded ? "" : " collapsed") + '">';
      for (var i = 0; i < unmatched.length; i++) {
        var u = unmatched[i];
        var uIcon = u.outcome === "inconclusive" ? "⚠️" : (u.passed ? "✅" : "❌");
        var uClass = u.outcome === "inconclusive" ? "extra-inconclusive" : (u.passed ? "extra-passed" : "extra-failed");
        html += '<div class="report-extra-item ' + uClass + '"><span>' + uIcon + '</span> ' + escapeHtml(u.description) + '</div>';
      }
      html += '</div>';
      html += '</div>';
    }
  }

  html += '</div>';
  return html;
}

// ---- Agent Loop ----
var currentAgent = null;

// ---- 全局暂停/中止控制器（架构分析、用例生成、测试共用）----
var currentPhase = null; // "architecture" | "testcases" | "testing" | null

var pauseState = {
  paused: false,
  aborted: false,
  userInjecting: false,     // 用户正在注入消息（用于区分 abort 原因）
  pendingUserMessage: null, // 待注入的用户消息
  _resolver: null,
  _abortController: null,

  // 为每次 AI 请求创建新的 AbortController，返回其 signal
  getSignal: function () {
    this._abortController = new AbortController();
    return this._abortController.signal;
  },

  // 暂停：中断当前 AI 请求，但保留对话状态
  pause: function () {
    this.paused = true;
    if (this._abortController) this._abortController.abort();
  },

  // 继续：恢复执行
  resume: function () {
    this.paused = false;
    if (this._resolver) { this._resolver(); this._resolver = null; }
  },

  // 完全中止：结束当前阶段
  abort: function () {
    this.aborted = true;
    this.paused = false;
    if (this._resolver) { this._resolver(); this._resolver = null; }
    if (this._abortController) this._abortController.abort();
  },

  // 用户注入消息（最高优先级）：中止当前 AI 请求，自动恢复暂停
  injectMessage: function (msg) {
    this.userInjecting = true;
    this.pendingUserMessage = msg;
    // 中止当前 AI 请求
    if (this._abortController) this._abortController.abort();
    // 如果处于暂停状态，自动恢复
    if (this.paused && this._resolver) {
      this.paused = false;
      this._resolver();
      this._resolver = null;
    }
  },

  // 消费待注入的用户消息（调用后清除）
  consumeUserMessage: function () {
    if (this.pendingUserMessage) {
      var msg = this.pendingUserMessage;
      this.pendingUserMessage = null;
      this.userInjecting = false;
      return msg;
    }
    return null;
  },

  // 等待用户点击「继续」
  waitForResume: function () {
    var self = this;
    return new Promise(function (resolve) { self._resolver = resolve; });
  },

  // 重置状态
  reset: function () {
    this.paused = false;
    this.aborted = false;
    this.userInjecting = false;
    this.pendingUserMessage = null;
    this._resolver = null;
    this._abortController = null;
  },
};

function startPhase(phase) {
  currentPhase = phase;
  pauseState.reset();
  els.abortBtn.disabled = false;
  els.abortBtn.textContent = "中止";
  els.continueBtn.style.display = "";
  els.continueBtn.disabled = true;
  updateButtonStates();
}

function endPhase() {
  currentPhase = null;
  pauseState.reset();
  els.abortBtn.disabled = true;
  els.abortBtn.textContent = "中止";
  els.continueBtn.disabled = true;
  els.continueBtn.style.display = "none";
  updateButtonStates();
}

function isPhaseAborted() {
  return pauseState.aborted;
}

async function runPlan() {
  // 校验配置
  var config = getAiConfig();
  if (!reportConfigValidation(config, true)) return;
  if (!tabId) {
    log("请先选择目标标签页");
    setStatus("未选择标签页");
    return;
  }
  if (!await preflightTargetTab()) return;

  // 检查是否已上传源码
  if (Object.keys(uploadedSourceFiles).length === 0) {
    log("请先上传项目源码（选择项目根目录）");
    setStatus("请先上传源码");
    return;
  }

  var requirement = els.requirement.value.trim();
  var testCases = els.testCases.value.trim();

  // 禁用按钮
  els.planBtn.disabled = true;
  startPhase("planning");
  els.resultArea.innerHTML = "分析中...";
  els.log.textContent = "";
  streamClear();
  resetContextUsage(config);

  log("启动 Plan 模式（测试策略分析）");
  setStatus("Plan 模式启动中...");

  currentAgent = AIFT_AgentLoop.create({
    tabId: tabId,
    config: config,
    ensureContentScript: ensureContentScript,
    sendMessage: sendToContent,
    evalInPage: evalInPage,
    injectFile: injectTestFile,
    onLog: function (msg) { log(msg); },
    onStatus: function (s) { setStatus(s); },
    onStream: function (type, content) {
      streamAppend(type, content);
    },
    onFinish: function (result, summary, assertions, testCases) {
      streamEndBlock();
      if (result === "plan") {
        els.resultArea.innerHTML = "<div class='plan-result'>" +
          "<h3>📋 测试策略分析报告</h3>" +
          "<div class='plan-content'>" + (summary || "").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>") + "</div>" +
          "</div>";
        setStatus("Plan 完成");
        log("=== Plan 模式完成 ===");
      } else {
        els.resultArea.innerHTML = renderTestReport(result, summary, testCasesState, []);
        setStatus("Plan: " + result);
        log("=== Plan 结束: " + result + " ===");
      }
      els.planBtn.disabled = false;
      endPhase();
      updateButtonStates();
      if (window.AIFT_VisualController && AIFT_VisualController.isAttached()) {
        AIFT_VisualController.detach().then(function () {
          log("视觉控制器已分离");
        });
      }
    },
  });

  await currentAgent.plan({
    requirement: requirement,
    testCases: testCases,
    architecture: archAnalysis,
  });

  currentAgent = null;
}

async function runAgent() {
  // 弹框让用户输入额外提示词
  var extraPrompt = await showPromptDialog(
    "运行 AI 测试 - 额外提示词",
    "可输入额外提示词来引导 AI 测试执行（可选）：",
    "如：优先测试登录功能、跳过网络请求验证..."
  );
  if (extraPrompt === null) return;

  // 校验配置
  var config = getAiConfig();
  if (!reportConfigValidation(config, true)) return;
  if (!tabId) {
    log("请先选择目标标签页");
    setStatus("未选择标签页");
    return;
  }
  if (!await preflightTargetTab()) return;

  var requirement = els.requirement.value.trim();
  var testCases = els.testCases.value.trim();
  if (!requirement && !testCases) {
    log("请填写测试需求或测试用例");
    setStatus("缺少测试需求");
    return;
  }

  // 检查是否已上传源码
  if (Object.keys(uploadedSourceFiles).length === 0) {
    log("请先上传项目源码（选择项目根目录）");
    setStatus("请先上传源码");
    return;
  }

  // 禁用按钮
  els.runAgentBtn.disabled = true;
  startPhase("testing");
  els.resultArea.innerHTML = "运行中...";
  els.log.textContent = "";
  streamClear();
  resetContextUsage(config);
  activeErrorRunId = "run_" + Date.now();

  log("启动 AI Agent Loop");
  setStatus("启动中...");

  currentAgent = AIFT_AgentLoop.create({
    tabId: tabId,
    config: config,
    ensureContentScript: ensureContentScript,
    sendMessage: sendToContent,
    evalInPage: evalInPage,
    injectFile: injectTestFile,
    onLog: function (msg) { log(msg); },
    onStatus: function (s) { setStatus(s); },
    onStream: function (type, content) {
      streamAppend(type, content);
    },
    onErrorRecord: function (record) {
      record.runId = activeErrorRunId;
      addErrorRecord(record);
    },
    onTestCasesParsed: function (testCases) {
      testCasesState = testCases;
      currentAssertions = [];
      lastTestReport = null;
      els.exportTestReportBtn.disabled = true;
      expandedCases.clear();
      expandedReportCases.clear();
      reportExtraExpanded = false;
      renderTestResults(testCases, []);
    },
    onAssertion: function (assertion, allAssertions, testCases) {
      testCasesState = testCases;
      currentAssertions = allAssertions;
      renderTestResults(testCases, allAssertions);
    },
    onRound: function (round, action, result) {
      log("第 " + round + " 轮: " + action + " → " + (result.result || "ok"));
    },
    onAutoPause: function (reason) {
      // Agent loop 内部自动暂停时，同步 panel 侧的暂停状态和 UI 按钮
      pauseState.paused = true;
      els.abortBtn.textContent = "停止";
      els.continueBtn.disabled = false;
      log("Agent 自动暂停（" + reason + "），等待用户介入");
    },
    onFinish: function (result, summary, assertions, testCases) {
      streamEndBlock();
      testCasesState = testCases || testCasesState;

      // 更新进度文本
      var passed = 0, failed = 0, inconclusive = 0, pending = 0, testing = 0;
      for (var i = 0; i < testCasesState.length; i++) {
        var s = testCasesState[i].status;
        if (s === "passed") passed++;
        else if (s === "failed") failed++;
        else if (s === "inconclusive") inconclusive++;
        else if (s === "testing") testing++;
        else pending++;
      }
      var total = testCasesState.length;
      var tested = passed + failed + inconclusive;
      var progressParts = [];
      if (total > 0) {
        progressParts.push(tested + "/" + total + " 已测");
        if (passed > 0) progressParts.push(passed + " 通过");
        if (failed > 0) progressParts.push(failed + " 失败");
        if (inconclusive > 0) progressParts.push(inconclusive + " 未完成验证");
        if (testing > 0) progressParts.push(testing + " 测试中");
        if (pending > 0) progressParts.push(pending + " 待测");
      }
      els.testProgress.textContent = progressParts.join(" · ");

      // 渲染 HTML 测试报告
      lastReportResult = result;
      lastReportSummary = summary;
      currentAssertions = assertions;
      lastTestReport = createTestReport(result, summary, assertions);
      rememberTestReport(lastTestReport);
      els.exportTestReportBtn.disabled = !lastTestReport;
      els.resultArea.innerHTML = renderTestReport(result, summary, testCasesState, assertions);

      els.runAgentBtn.disabled = false;
      endPhase();
      setStatus("完成: " + result);
      log("=== 测试结束: " + result + " ===");
      if (summary) log("总结: " + summary);
      updateButtonStates();
      // 测试结束后分离 debugger
      if (window.AIFT_VisualController && AIFT_VisualController.isAttached()) {
        AIFT_VisualController.detach().then(function () {
          log("视觉控制器已分离");
        });
      }
    },
  });

  await currentAgent.run({
    requirement: requirement,
    testCases: testCases,
    architecture: archAnalysis,
    extraPrompt: extraPrompt,
  });

  currentAgent = null;
}

function abortAgent() {
  // 测试阶段：通过 agent loop 暂停/停止
  if (currentAgent) {
    var agentPaused = currentAgent.getState().paused;
    if (agentPaused || pauseState.paused) {
      // 已暂停 → 完全中止
      currentAgent.abort();
      pauseState.abort();
      log("用户请求完全中止测试");
      els.abortBtn.disabled = true;
      els.continueBtn.disabled = true;
      // 中止时分离 debugger
      if (window.AIFT_VisualController && AIFT_VisualController.isAttached()) {
        AIFT_VisualController.detach().then(function () {
          log("视觉控制器已分离");
        });
      }
    } else {
      // 运行中 → 暂停（可继续）
      currentAgent.pause();
      pauseState.paused = true; // 同步状态
      log("用户请求暂停测试");
      els.abortBtn.textContent = "停止";
      els.continueBtn.disabled = false;
    }
    return;
  }
  // 架构分析 / 用例生成阶段：通过 pauseState 暂停/停止
  if (currentPhase && !pauseState.aborted) {
    if (pauseState.paused) {
      // 已暂停 → 完全中止
      pauseState.abort();
      var phaseLabel = currentPhase === "architecture" ? "架构分析" : (currentPhase === "testcases" ? "测试用例生成" : "当前操作");
      log("用户请求完全中止" + phaseLabel);
      els.abortBtn.disabled = true;
      els.continueBtn.disabled = true;
    } else {
      // 运行中 → 暂停（可继续）
      pauseState.pause();
      var phaseLabel2 = currentPhase === "architecture" ? "架构分析" : (currentPhase === "testcases" ? "测试用例生成" : "当前操作");
      log("用户请求暂停" + phaseLabel2);
      streamAppend("warning", "⏸️ 已暂停" + phaseLabel2 + "，点击「继续」恢复");
      els.abortBtn.textContent = "停止";
      els.continueBtn.disabled = false;
      // 更新对应模块按钮文案
      if (currentPhase === "architecture") {
        els.analyzeBtn.textContent = "已暂停";
      } else if (currentPhase === "testcases") {
        els.genTestCasesBtn.textContent = "已暂停";
      }
    }
    return;
  }
  log("没有正在运行的操作可中止");
}

function continueAgent() {
  // 检查 panel 侧暂停状态，或 agent 内部自动暂停状态
  var agentAutoPaused = currentAgent && currentAgent.getState().paused;
  if ((!pauseState.paused && !agentAutoPaused) || pauseState.aborted) {
    log("无法继续：当前未暂停");
    return;
  }
  // 测试阶段
  if (currentAgent) {
    currentAgent.resume();
    pauseState.paused = false; // 同步状态
    log("用户继续测试");
    els.abortBtn.textContent = "中止";
    els.continueBtn.disabled = true;
    return;
  }
  // 架构分析 / 用例生成阶段
  if (currentPhase) {
    pauseState.resume();
    var phaseLabel = currentPhase === "architecture" ? "架构分析" : (currentPhase === "testcases" ? "测试用例生成" : "当前操作");
    log("用户继续" + phaseLabel);
    streamAppend("info", "▶️ 继续" + phaseLabel);
    els.abortBtn.textContent = "中止";
    els.continueBtn.disabled = true;
    if (currentPhase === "architecture") {
      els.analyzeBtn.textContent = "分析中...";
    } else if (currentPhase === "testcases") {
      els.genTestCasesBtn.textContent = "生成中...";
    }
    return;
  }
  log("无法继续：当前未暂停");
}

// ---- 用户干预：接续当前对话上下文（最高优先级，全阶段可用） ----
function sendChatMessage() {
  var msg = els.chatInput.value.trim();
  if (!msg) {
    setStatus("请输入内容");
    els.chatInput.focus();
    return;
  }

  // 测试阶段：通过 agent loop 注入
  if (currentAgent) {
    var agentState = currentAgent.getState();
    var wasPaused = agentState.paused;
    var ok = currentAgent.injectMessage(msg);
    if (ok) {
      log("已发送用户消息（最高优先级）: " + msg);
      streamAppend("warning", "📋 用户消息: " + msg);
      els.chatInput.value = "";
      if (wasPaused) {
        pauseState.paused = false;
        els.abortBtn.textContent = "中止";
        els.continueBtn.disabled = true;
        streamAppend("info", "▶️ 已自动恢复执行");
      }
      setStatus("用户消息已注入（最高优先级），重新发起请求...");
    } else {
      log("发送失败：测试可能已结束");
      setStatus("发送失败");
    }
    return;
  }

  // 架构分析 / 用例生成阶段：通过 pauseState 注入
  if (currentPhase && !pauseState.aborted) {
    var wasPhasePaused = pauseState.paused;
    pauseState.injectMessage(msg);
    log("已发送用户消息（最高优先级）: " + msg);
    streamAppend("warning", "📋 用户消息: " + msg);
    els.chatInput.value = "";
    // 如果之前是暂停状态，恢复 UI
    if (wasPhasePaused) {
      els.abortBtn.textContent = "中止";
      els.continueBtn.disabled = true;
      if (currentPhase === "architecture") {
        els.analyzeBtn.textContent = "分析中...";
      } else if (currentPhase === "testcases") {
        els.genTestCasesBtn.textContent = "生成中...";
      }
      streamAppend("info", "▶️ 已自动恢复执行");
    }
    setStatus("用户消息已注入（最高优先级），重新发起请求...");
    return;
  }

  log("无法发送：当前没有正在运行的 AI 任务");
  setStatus("请先启动一个 AI 任务");
  els.chatInput.focus();
}

// ---- 架构分析 ----
var archAnalysis = null;

async function loadArchCache() {
  try {
    var info = await AIFT_ProjectAnalyzer.getCacheInfo();
    if (info) {
      var date = new Date(info.timestamp);
      var dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString();
      var refinedLabel = info.refined ? "AI 精炼" : "启发式";
      var cacheParts = ["缓存: " + info.routeCount + " 路由", info.navCount + " 导航项"];
      if (info.businessModuleCount > 0) cacheParts.push(info.businessModuleCount + " 业务模块");
      if (info.fileInventoryCount > 0) cacheParts.push(info.fileInventoryCount + " 文件清单");
      cacheParts.push(refinedLabel);
      cacheParts.push(dateStr);
      els.archCacheInfo.textContent = cacheParts.join(", ");
      els.archCacheInfo.style.color = "#0a7c3e";
      archAnalysis = await AIFT_ProjectAnalyzer.loadCache();
      if (archAnalysis) {
        renderArchResult(archAnalysis);
      }
    }
  } catch (e) { /* ignore */ }
  updateButtonStates();
}

async function analyzeArchitecture() {
  if (Object.keys(uploadedSourceFiles).length === 0) {
    log("请先上传项目源码");
    setStatus("请先上传源码");
    return;
  }
  if (!tabId) {
    log("请先选择目标标签页");
    setStatus("未选择标签页");
    return;
  }
  if (!await preflightTargetTab()) return;

  // 架构分析应在点击后立即启动；额外提示词不能阻塞主操作。
  var extraPrompt = "";

  var config = getAiConfig();
  var hasAIConfig = config.apiUrl && config.apiKey && config.model && reportConfigValidation(config, true);

  els.analyzeBtn.disabled = true;
  els.analyzeBtn.textContent = "分析中...";
  startPhase("architecture");
  setStatus("架构分析中...");
  log("开始项目架构分析");
  els.archResult.innerHTML = '<div class="arch-loading">正在分析项目架构...</div>';
  streamClear();

  try {
    log("执行启发式分析（路由/导航/API/组件）...");
    var raw = AIFT_ProjectAnalyzer.analyze(uploadedSourceFiles);
    log("启发式分析完成: " + raw.routes.length + " 路由, " + raw.navigation.length + " 导航项, " + raw.apiCalls.length + " API 调用");

    if (hasAIConfig) {
      // 1. AI 深度架构分析（多轮追踪，从入口文件开始）
      //    输出包含 routes, navigation, menuApis, routeConfig, storeInfo 等
      archAnalysis = await AIFT_ProjectAnalyzer.analyzeWithAI(
        config, raw, uploadedSourceFiles,
        function (msg) { log(msg); },
        function (type, content) { streamAppend(type, content); },
        { pauseState: pauseState, extraPrompt: extraPrompt }
      );
      streamEndBlock();
      log("AI 架构分析完成");

      // 检查是否被中止
      if (isPhaseAborted()) {
        log("架构分析已被用户中止");
        setStatus("已中止");
        streamAppend("warning", "⚠️ 架构分析已被用户中止");
        renderArchResult(archAnalysis);
        return;
      }

      // 2. 如果 AI 识别到菜单 API，重放请求获取动态路由数据
      if (archAnalysis.menuApis && archAnalysis.menuApis.length > 0) {
        log("使用 AI 识别的 " + archAnalysis.menuApis.length + " 个菜单 API 获取动态路由...");
        try {
          var apiResult = await AIFT_ProjectAnalyzer.fetchDynamicRoutes(
            tabId,
            evalInPage,
            archAnalysis.menuApis,
            config,
            function (msg) { log(msg); },
            function (type, content) { streamAppend(type, content); },
            pauseState.getSignal()
          );
          streamEndBlock();

          if (isPhaseAborted()) {
            log("架构分析已被用户中止");
            setStatus("已中止");
            streamAppend("warning", "⚠️ 架构分析已被用户中止");
            renderArchResult(archAnalysis);
            return;
          }

          if (apiResult.routes.length > 0) {
            log("动态路由获取成功: " + apiResult.routes.length + " 路由, " + apiResult.navItems.length + " 导航项");
            archAnalysis.apiFetchedRoutes = apiResult.routes;
            // 合并到路由列表
            var seenPaths = {};
            for (var pi = 0; pi < archAnalysis.routes.length; pi++) seenPaths[archAnalysis.routes[pi].path] = true;
            for (var pj = 0; pj < apiResult.routes.length; pj++) {
              if (!seenPaths[apiResult.routes[pj].path]) {
                seenPaths[apiResult.routes[pj].path] = true;
                archAnalysis.routes.push(apiResult.routes[pj]);
              }
            }
            // 合并到导航列表
            var seenNavs = {};
            for (var ni = 0; ni < archAnalysis.navigation.length; ni++) seenNavs[archAnalysis.navigation[ni].text + "|" + archAnalysis.navigation[ni].path] = true;
            for (var nj = 0; nj < apiResult.navItems.length; nj++) {
              var navKey = apiResult.navItems[nj].text + "|" + apiResult.navItems[nj].path;
              if (!seenNavs[navKey]) {
                seenNavs[navKey] = true;
                archAnalysis.navigation.push(apiResult.navItems[nj]);
              }
            }
          } else {
            log("菜单 API 未获取到路由数据");
          }
        } catch (e) {
          streamEndBlock();
          log("菜单 API 请求失败: " + (e.message || e));
        }
        // 检查是否被暂停/中止（fetchDynamicRoutes 的内层 catch 可能吞掉了暂停信号）
        if (pauseState.paused || pauseState.aborted) {
          if (pauseState.aborted) {
            log("架构分析已被用户中止");
            setStatus("已中止");
            streamAppend("warning", "⚠️ 架构分析已被用户中止");
            renderArchResult(archAnalysis);
          } else {
            log("架构分析已被用户暂停");
            setStatus("已暂停");
            streamAppend("warning", "⏸️ 架构分析已暂停，点击「继续」重新执行");
          }
          return;
        }
      } else if (archAnalysis.menuApis && archAnalysis.menuApis.length === 0) {
        log("AI 分析确认项目不使用动态路由 API");
      }
    } else {
      log("未配置 AI，使用启发式分析结果");
      archAnalysis = raw;

      // 无 AI 时，如果启发式检测到动态路由，尝试用启发式提取的 menuApis 请求
      if (raw.isDynamicRouting && raw.menuApis && raw.menuApis.length > 0) {
        log("⚠️ 检测到动态路由模式，尝试用启发式提取的 API 获取路由...");
        try {
          var apiResult = await AIFT_ProjectAnalyzer.fetchDynamicRoutes(
            tabId,
            evalInPage,
            raw.menuApis,
            null,
            function (msg) { log(msg); },
            function (type, content) { streamAppend(type, content); },
            pauseState.getSignal()
          );
          streamEndBlock();

          if (apiResult.routes.length > 0) {
            log("动态路由获取成功: " + apiResult.routes.length + " 路由");
            archAnalysis.apiFetchedRoutes = apiResult.routes;
            var seenPaths = {};
            for (var pi = 0; pi < archAnalysis.routes.length; pi++) seenPaths[archAnalysis.routes[pi].path] = true;
            for (var pj = 0; pj < apiResult.routes.length; pj++) {
              if (!seenPaths[apiResult.routes[pj].path]) {
                seenPaths[apiResult.routes[pj].path] = true;
                archAnalysis.routes.push(apiResult.routes[pj]);
              }
            }
            var seenNavs = {};
            for (var ni = 0; ni < archAnalysis.navigation.length; ni++) seenNavs[archAnalysis.navigation[ni].text + "|" + archAnalysis.navigation[ni].path] = true;
            for (var nj = 0; nj < apiResult.navItems.length; nj++) {
              var navKey = apiResult.navItems[nj].text + "|" + apiResult.navItems[nj].path;
              if (!seenNavs[navKey]) {
                seenNavs[navKey] = true;
                archAnalysis.navigation.push(apiResult.navItems[nj]);
              }
            }
          }
        } catch (e) {
          streamEndBlock();
          log("菜单 API 请求失败: " + (e.message || e));
        }

        // 检查是否被暂停/中止
        if (pauseState.paused || pauseState.aborted) {
          if (pauseState.aborted) {
            log("架构分析已被用户中止");
            setStatus("已中止");
            streamAppend("warning", "⚠️ 架构分析已被用户中止");
            renderArchResult(archAnalysis);
          } else {
            log("架构分析已被用户暂停");
            setStatus("已暂停");
            streamAppend("warning", "⏸️ 架构分析已暂停，点击「继续」重新执行");
          }
          return;
        }
      }
    }

    // 3. 从运行时 DOM 捕获导航菜单（补充）
    log("从运行时 DOM 捕获导航菜单...");
    try {
      var runtimeNav = await AIFT_ProjectAnalyzer.captureRuntimeNavigation(
        ensureContentScript, sendToContent, tabId
      );
      if (runtimeNav.length > 0) {
        log("运行时导航捕获成功: " + runtimeNav.length + " 个菜单项");
        archAnalysis = AIFT_ProjectAnalyzer.mergeRuntimeNavigation(archAnalysis, runtimeNav);
        log("合并后: " + archAnalysis.routes.length + " 路由, " + archAnalysis.navigation.length + " 导航项");
      } else {
        log("运行时导航未捕获到菜单项，可能页面未加载完整或不在有菜单的页面");
      }
    } catch (e) {
      log("运行时导航捕获失败: " + (e.message || e));
    }

    renderArchResult(archAnalysis);
    await AIFT_ProjectAnalyzer.saveCache(archAnalysis);
    log("架构分析已缓存");

    var info = await AIFT_ProjectAnalyzer.getCacheInfo();
    if (info) {
      var date = new Date(info.timestamp);
      var dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString();
      var refinedLabel = info.refined ? "AI 精炼" : "启发式";
      var cacheParts = ["缓存: " + info.routeCount + " 路由", info.navCount + " 导航项"];
      if (info.businessModuleCount > 0) cacheParts.push(info.businessModuleCount + " 业务模块");
      if (info.fileInventoryCount > 0) cacheParts.push(info.fileInventoryCount + " 文件清单");
      cacheParts.push(refinedLabel);
      cacheParts.push(dateStr);
      els.archCacheInfo.textContent = cacheParts.join(", ");
      els.archCacheInfo.style.color = "#0a7c3e";
    }
    setStatus("架构分析完成");
  } catch (e) {
    if (e.name === "UserAbortError" || isPhaseAborted()) {
      log("架构分析已被用户中止");
      setStatus("已中止");
      streamAppend("warning", "⚠️ 架构分析已被用户中止");
      // 清除 loading 状态，显示已中止提示
      if (archAnalysis) {
        renderArchResult(archAnalysis);
      } else {
        els.archResult.innerHTML = '<div class="arch-empty">架构分析已中止，可重新点击「分析架构」。</div>';
      }
    } else {
      log("架构分析失败: " + (e.message || e));
      setStatus("架构分析失败");
      els.archResult.innerHTML = '<div class="arch-empty">分析失败: ' + escapeHtml(e.message || String(e)) + '</div>';
    }
  } finally {
    streamEndBlock();
    els.analyzeBtn.disabled = false;
    els.analyzeBtn.textContent = "分析架构";
    endPhase();
  }
}

async function clearArchCache() {
  await AIFT_ProjectAnalyzer.clearCache();
  archAnalysis = null;
  els.archCacheInfo.textContent = "未分析";
  els.archCacheInfo.style.color = "";
  els.archResult.innerHTML = '<div class="arch-empty">上传源码后点击「分析架构」，或点击「导入架构文档」导入已有的分析结果。</div>';
  els.exportArchBtn.disabled = true;
  log("架构分析缓存已清除");
  setStatus("缓存已清除");
  updateButtonStates();
}

// ---- 导出格式选择弹框 ----
var exportModalResolve = null;

function showExportDialog(title, formats, onConfirm) {
  els.exportModalTitle.textContent = title || "导出";
  els.exportFormatList.innerHTML = "";
  for (var i = 0; i < formats.length; i++) {
    (function (fmt) {
      var btn = document.createElement("button");
      btn.className = "btn btn-secondary export-format-btn";
      btn.textContent = fmt.label;
      btn.addEventListener("click", function () {
        els.exportModal.style.display = "none";
        if (exportModalResolve) { exportModalResolve = null; }
        onConfirm(fmt.value);
      });
      els.exportFormatList.appendChild(btn);
    })(formats[i]);
  }
  els.exportModal.style.display = "flex";
  exportModalResolve = onConfirm;
}

function cancelExportDialog() {
  els.exportModal.style.display = "none";
  exportModalResolve = null;
}

// ---- 导出架构分析结果 ----
function downloadFile(filename, content, mimeType) {
  var blob = new Blob([content], { type: mimeType + ";charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function formatTimestamp(ts) {
  var d = new Date(ts || Date.now());
  var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "_" + pad(d.getHours()) + pad(d.getMinutes());
}

function exportErrorRecords() {
  if (errorRecords.length === 0) {
    setStatus("无错误记录可导出");
    return;
  }
  var filename = "ai_test_error_records_" + formatTimestamp() + ".json";
  var safeRecords = window.AIFT_Redaction && AIFT_Redaction.redact
    ? AIFT_Redaction.redact(errorRecords) : errorRecords;
  var content = JSON.stringify({
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    recordCount: errorRecords.length,
    records: safeRecords,
  }, null, 2);
  downloadFile(filename, content, "application/json");
  log("错误记录已导出: " + filename);
  setStatus("已导出错误记录");
}

function exportTestReport(reportOverride) {
  // DOM click handler 会传入 MouseEvent；它不是报告，不能覆盖当前完整报告。
  var isReport = reportOverride && typeof reportOverride === "object" &&
    (Array.isArray(reportOverride.testCases) || typeof reportOverride.result === "string" || typeof reportOverride.generatedAt === "string");
  var reportToExport = isReport ? reportOverride : lastTestReport;
  if (!reportToExport) {
    setStatus("暂无可导出的测试报告");
    return;
  }
  showExportDialog("导出测试报告", [
    { label: "JSON 格式", value: "json" },
    { label: "Markdown 格式", value: "md" },
  ], function(format) {
    var report = redactDiagnostic(reportToExport);
    var suffix = format === "md" ? "md" : "json";
    var filename = "ai_test_report_" + formatTimestamp(report.generatedAt) + "." + suffix;
    var content = format === "md" && window.AIFT_TestReport
      ? AIFT_TestReport.buildMarkdown(report)
      : JSON.stringify(report, null, 2);
    downloadFile(filename, content, format === "md" ? "text/markdown" : "application/json");
    log("测试报告已导出: " + filename);
    setStatus("已导出测试报告");
  });
}

function clearErrorRecords() {
  errorRecords = [];
  chrome.storage.local.remove(ERROR_RECORDS_KEY).catch(function(error) {
    log("错误记录清除失败: " + (error.message || error));
  });
  renderErrorRecords();
  setStatus("错误记录已清除");
}

function exportArchitecture() {
  if (!archAnalysis) {
    log("无架构分析结果可导出");
    setStatus("无架构分析结果");
    return;
  }
  showExportDialog("导出架构分析", [
    { label: "JSON 格式", value: "json" },
    { label: "Markdown 格式", value: "md" },
  ], function (format) {
    var ts = formatTimestamp(archAnalysis.timestamp);
    var filename, content, mime;

    if (format === "json") {
      filename = "architecture_" + ts + ".json";
      content = JSON.stringify(archAnalysis, null, 2);
      mime = "application/json";
    } else {
      filename = "architecture_" + ts + ".md";
      content = buildArchMarkdown(archAnalysis);
      mime = "text/markdown";
    }

    downloadFile(filename, content, mime);
    log("架构分析已导出: " + filename);
    setStatus("已导出: " + filename);
  });
}

function buildArchMarkdown(analysis) {
  var lines = [];
  lines.push("# 项目架构分析报告");
  lines.push("");
  lines.push("> 生成时间: " + new Date(analysis.timestamp || Date.now()).toLocaleString());
  lines.push("");

  if (analysis.summary) {
    lines.push("## 概述");
    lines.push("");
    lines.push(analysis.summary);
    lines.push("");
  }

  if (analysis.projectOverview) {
    var po = analysis.projectOverview;
    lines.push("## 项目概述");
    lines.push("");
    if (po.type) lines.push("- **类型**: " + po.type);
    if (po.description) lines.push("- **定位**: " + po.description);
    if (po.scale && po.scale.description) lines.push("- **规模**: " + po.scale.description);
    if (po.techStack && po.techStack.length > 0) {
      lines.push("");
      lines.push("### 技术栈");
      lines.push("");
      lines.push("| 类别 | 名称 | 用途 |");
      lines.push("|------|------|------|");
      for (var i = 0; i < po.techStack.length; i++) {
        var ts = po.techStack[i];
        lines.push("| " + (ts.category || "") + " | " + (ts.name || "") + " | " + (ts.purpose || "") + " |");
      }
    }
    lines.push("");
  }

  if (analysis.directoryStructure) {
    lines.push("## 目录结构");
    lines.push("");
    lines.push("```");
    lines.push(analysis.directoryStructure);
    lines.push("```");
    lines.push("");
  }

  if (analysis.architectureDiagram) {
    lines.push("## 架构图");
    lines.push("");
    lines.push("```");
    lines.push(analysis.architectureDiagram);
    lines.push("```");
    lines.push("");
  }

  if (analysis.startupFlow) {
    lines.push("## 启动流程");
    lines.push("");
    lines.push(analysis.startupFlow);
    lines.push("");
  }

  if (analysis.routeConfig) {
    lines.push("## 路由系统");
    lines.push("");
    lines.push(analysis.routeConfig);
    lines.push("");
  }

  if (analysis.storeInfo) {
    lines.push("## 状态管理");
    lines.push("");
    lines.push(analysis.storeInfo);
    lines.push("");
  }

  if (analysis.vuexModules && analysis.vuexModules.length > 0) {
    lines.push("### 状态管理模块");
    lines.push("");
    lines.push("| 模块 | 范围 | 职责 |");
    lines.push("|------|------|------|");
    for (var vmi = 0; vmi < analysis.vuexModules.length; vmi++) {
      var vm = analysis.vuexModules[vmi];
      lines.push("| " + (vm.name || "") + " | " + (vm.scope || "") + " | " + (vm.description || "") + " |");
    }
    lines.push("");
  }

  if (analysis.apiLayer) {
    lines.push("## API 层设计");
    lines.push("");
    lines.push(analysis.apiLayer);
    lines.push("");
  }

  if (analysis.componentSystem) {
    lines.push("## 组件体系");
    lines.push("");
    lines.push(analysis.componentSystem);
    lines.push("");
  }

  if (analysis.securityMechanisms) {
    lines.push("## 权限与安全");
    lines.push("");
    lines.push(analysis.securityMechanisms);
    lines.push("");
  }

  if (analysis.securityDetails && analysis.securityDetails.length > 0) {
    lines.push("### 安全机制详情");
    lines.push("");
    lines.push("| 机制 | 实现 |");
    lines.push("|------|------|");
    for (var sdi = 0; sdi < analysis.securityDetails.length; sdi++) {
      var sd = analysis.securityDetails[sdi];
      lines.push("| " + (sd.mechanism || "") + " | " + (sd.implementation || "") + " |");
    }
    lines.push("");
  }

  if (analysis.businessModules && analysis.businessModules.length > 0) {
    if (Array.isArray(analysis.businessModules)) {
      // 按 category 分组
      var bmGroupsMd = {};
      for (var bmiMd = 0; bmiMd < analysis.businessModules.length; bmiMd++) {
        var bmMd = analysis.businessModules[bmiMd];
        var bmCatMd = bmMd.category || "其他";
        if (!bmGroupsMd[bmCatMd]) bmGroupsMd[bmCatMd] = [];
        bmGroupsMd[bmCatMd].push(bmMd);
      }
      lines.push("## 业务模块 (" + analysis.businessModules.length + ")");
      lines.push("");
      for (var bmCatMdKey in bmGroupsMd) {
        if (!bmGroupsMd.hasOwnProperty(bmCatMdKey)) continue;
        var bmListMd = bmGroupsMd[bmCatMdKey];
        lines.push("### " + bmCatMdKey + " (" + bmListMd.length + " 个)");
        lines.push("");
        lines.push("| 模块 | 路由 | 说明 |");
        lines.push("|------|------|------|");
        for (var bliMd = 0; bliMd < bmListMd.length; bliMd++) {
          var bliItemMd = bmListMd[bliMd];
          lines.push("| " + (bliItemMd.name || "") + " | " + (bliItemMd.routePath || "") + " | " + (bliItemMd.description || "") + " |");
        }
        lines.push("");
      }
    } else if (typeof analysis.businessModules === "string") {
      lines.push("## 业务模块");
      lines.push("");
      lines.push(analysis.businessModules);
      lines.push("");
    }
  }

  if (analysis.buildAndDeploy) {
    lines.push("## 构建与部署");
    lines.push("");
    lines.push(analysis.buildAndDeploy);
    lines.push("");
  }

  if (analysis.designPatterns) {
    lines.push("## 架构特点与设计模式");
    lines.push("");
    lines.push(analysis.designPatterns);
    lines.push("");
  }

  if (analysis.potentialIssues && analysis.potentialIssues.length > 0) {
    lines.push("## 潜在问题与优化建议");
    lines.push("");
    lines.push("| 维度 | 问题 | 建议 |");
    lines.push("|------|------|------|");
    for (var piiMd = 0; piiMd < analysis.potentialIssues.length; piiMd++) {
      var piMd = analysis.potentialIssues[piiMd];
      lines.push("| " + (piMd.category || "") + " | " + (piMd.issue || "") + " | " + (piMd.suggestion || "") + " |");
    }
    lines.push("");
  }

  if (analysis.strengths && analysis.strengths.length > 0) {
    lines.push("## 优势");
    lines.push("");
    for (var siMd = 0; siMd < analysis.strengths.length; siMd++) {
      lines.push("- " + analysis.strengths[siMd]);
    }
    lines.push("");
  }

  if (analysis.improvements && analysis.improvements.length > 0) {
    lines.push("## 待改进");
    lines.push("");
    for (var iiMd = 0; iiMd < analysis.improvements.length; iiMd++) {
      lines.push("- " + analysis.improvements[iiMd]);
    }
    lines.push("");
  }

  if (analysis.routes && analysis.routes.length > 0) {
    lines.push("## 路由地图 (" + analysis.routes.length + ")");
    lines.push("");
    lines.push("| 路径 | 名称 | 描述 | 来源 |");
    lines.push("|------|------|------|------|");
    for (var i = 0; i < analysis.routes.length; i++) {
      var r = analysis.routes[i];
      var source = r.source === "menu-api" ? "API获取" : (r.source === "runtime-dom" ? "DOM提取" : "源码");
      lines.push("| " + (r.path || "") + " | " + (r.name || r.component || "") + " | " + (r.description || "") + " | " + source + " |");
    }
    lines.push("");
  }

  if (analysis.isDynamicRouting) {
    lines.push("## 动态路由");
    lines.push("");
    lines.push("该项目使用动态路由。");
    if (analysis.menuApis && analysis.menuApis.length > 0) {
      lines.push("");
      lines.push("### 菜单 API");
      lines.push("");
      for (var i = 0; i < analysis.menuApis.length; i++) {
        lines.push("- " + analysis.menuApis[i].url);
      }
    }
    if (analysis.apiFetchedRoutes && analysis.apiFetchedRoutes.length > 0) {
      lines.push("");
      lines.push("成功获取 " + analysis.apiFetchedRoutes.length + " 条动态路由。");
    }
    lines.push("");
  }

  if (analysis.navigation && analysis.navigation.length > 0) {
    lines.push("## 导航结构 (" + analysis.navigation.length + ")");
    lines.push("");
    lines.push("| 父级 | 文本 | 路径 |");
    lines.push("|------|------|------|");
    for (var i = 0; i < analysis.navigation.length; i++) {
      var n = analysis.navigation[i];
      lines.push("| " + (n.parent || "") + " | " + (n.text || "") + " | " + (n.path || "") + " |");
    }
    lines.push("");
  }

  if (analysis.pageApiMap) {
    var apiCount = 0;
    for (var k in analysis.pageApiMap) { if (analysis.pageApiMap.hasOwnProperty(k)) apiCount++; }
    if (apiCount > 0) {
      lines.push("## 页面-API 映射");
      lines.push("");
      for (var page in analysis.pageApiMap) {
        if (analysis.pageApiMap.hasOwnProperty(page)) {
          lines.push("- **" + page + "**: " + analysis.pageApiMap[page].join(", "));
        }
      }
      lines.push("");
    }
  } else if (analysis.apiCalls && analysis.apiCalls.length > 0) {
    lines.push("## API 调用列表 (" + analysis.apiCalls.length + ")");
    lines.push("");
    lines.push("| 方法 | URL | 来源 |");
    lines.push("|------|-----|------|");
    for (var i = 0; i < analysis.apiCalls.length; i++) {
      var a = analysis.apiCalls[i];
      lines.push("| " + (a.method || "GET") + " | " + (a.url || "") + " | " + (a.source || "") + " |");
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---- 导出测试用例 ----
function exportTestCases() {
  var text = els.testCases.value.trim();
  if (!text) {
    log("无测试用例可导出");
    setStatus("无测试用例");
    return;
  }
  showExportDialog("导出测试用例", [
    { label: "CSV 格式", value: "csv" },
    { label: "Markdown 格式", value: "md" },
    { label: "纯文本格式", value: "txt" },
    { label: "JSON 格式", value: "json" },
  ], function (format) {
    var ts = formatTimestamp();
    var filename, content, mime;

    if (format === "json") {
      var cases = [];
      var lines = text.split("\n");
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.indexOf("TC") !== 0) continue;
        var parts;
        if (line.indexOf(",") !== -1 && line.indexOf("⫟") === -1 && line.indexOf("|") === -1) {
          // CSV format
          parts = parseCSVLine(line);
        } else if (line.indexOf("⫟") !== -1) {
          parts = line.split("⫟").map(function (p) { return p.trim(); });
        } else {
          parts = line.split("|").map(function (p) { return p.trim(); });
        }
        if (parts.length >= 6) {
          cases.push({
            id: parts[0].trim(),
            title: parts[1].trim(),
            page: parts[2].trim(),
            preconditions: parts[3].trim(),
            steps: parts[4].trim(),
            expected: parts[5].trim(),
          });
        }
      }
      filename = "test_cases_" + ts + ".json";
      content = JSON.stringify({
        requirement: els.requirement.value.trim(),
        testCases: cases.length > 0 ? cases : text,
        exportedAt: new Date().toISOString(),
      }, null, 2);
      mime = "application/json";
    } else if (format === "csv") {
      var csvLines = ["编号,用例标题,测试页面,前置条件,操作步骤,预期结果"];
      var csvTextLines = text.split("\n");
      for (var ci = 0; ci < csvTextLines.length; ci++) {
        var csvLine = csvTextLines[ci].trim();
        if (!csvLine || csvLine.indexOf("TC") !== 0) continue;
        var csvParts;
        if (csvLine.indexOf("⫟") !== -1) {
          csvParts = csvLine.split("⫟").map(function (p) { return p.trim(); });
        } else if (csvLine.indexOf("|") !== -1 && csvLine.indexOf(",") === -1) {
          csvParts = csvLine.split("|").map(function (p) { return p.trim(); });
        } else {
          csvParts = parseCSVLine(csvLine).map(function (p) { return p.trim(); });
        }
        if (csvParts.length >= 6) {
          csvLines.push(csvParts.slice(0, 6).map(escapeCSVField).join(","));
        }
      }
      filename = "test_cases_" + ts + ".csv";
      content = "\uFEFF" + csvLines.join("\n");
      mime = "text/csv";
    } else if (format === "md") {
      filename = "test_cases_" + ts + ".md";
      content = buildTestCasesMarkdown(text);
      mime = "text/markdown";
    } else {
      filename = "test_cases_" + ts + ".txt";
      content = text;
      mime = "text/plain";
    }

    downloadFile(filename, content, mime);
    log("测试用例已导出: " + filename);
    setStatus("已导出: " + filename);
  });
}

/** CSV 单行解析（支持双引号包裹和转义，括号内逗号不分割） */
function parseCSVLine(line) {
  var fields = [];
  var field = "";
  var inQuotes = false;
  var parenDepth = 0; // 追踪括号深度，避免 visual_click(x, y) 中的逗号被误判为字段分隔符
  var i = 0;
  while (i < line.length) {
    var ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === '(') { parenDepth++; field += ch; i++; continue; }
    if (ch === ')') { if (parenDepth > 0) parenDepth--; field += ch; i++; continue; }
    if (ch === ',' && parenDepth > 0) { field += ch; i++; continue; } // 括号内逗号不分割
    if (ch === ',') { fields.push(field); field = ""; i++; continue; }
    field += ch; i++;
  }
  fields.push(field);
  return fields;
}

/** CSV 字段转义（含逗号/引号/换行时用双引号包裹） */
function escapeCSVField(value) {
  if (!value) return "";
  var s = String(value);
  if (s.indexOf(",") !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildTestCasesMarkdown(rawText) {
  var lines = [];
  lines.push("# 测试用例");
  lines.push("");
  var req = els.requirement.value.trim();
  if (req) {
    lines.push("## 需求描述");
    lines.push("");
    lines.push(req);
    lines.push("");
  }
  lines.push("## 用例列表");
  lines.push("");

  // 尝试解析测试用例（支持 CSV、⫟、| 三种格式）
  var textLines = rawText.split("\n");
  var parsed = false;
  for (var i = 0; i < textLines.length; i++) {
    var line = textLines[i].trim();
    if (!line) continue;
    if (line.indexOf("TC") === 0) {
      var parts;
      if (line.indexOf("⫟") !== -1) {
        parts = line.split("⫟").map(function (p) { return p.trim(); });
      } else if (line.indexOf("|") !== -1 && line.indexOf(",") === -1) {
        parts = line.split("|").map(function (p) { return p.trim(); });
      } else {
        parts = parseCSVLine(line).map(function (p) { return p.trim(); });
      }
      if (parts.length >= 6) {
        if (!parsed) {
          lines.push("| 编号 | 用例标题 | 测试页面 | 前置条件 | 操作步骤 | 预期结果 |");
          lines.push("|------|----------|----------|----------|----------|----------|");
          parsed = true;
        }
        lines.push("| " + parts.slice(0, 6).join(" | ") + " |");
        continue;
      }
    }
    // 非结构化格式的行，直接输出
    if (!parsed) {
      lines.push(line);
    }
  }

  if (!parsed) {
    lines.push("```");
    lines.push(rawText);
    lines.push("```");
  }

  lines.push("");
  lines.push("> 导出时间: " + new Date().toLocaleString());
  return lines.join("\n");
}

// ---- 导入架构文档 ----

function handleArchFileImport(event) {
  var file = event.target.files[0];
  if (!file) return;
  // 重置 input 以便重复选择同一文件
  event.target.value = "";

  var reader = new FileReader();
  reader.onload = function (e) {
    var content = e.target.result;
    var fileName = file.name;
    var ext = fileName.split(".").pop().toLowerCase();

    log("导入架构文档: " + fileName);

    var analysis = null;

    if (ext === "json") {
      // JSON 格式，直接解析
      try {
        analysis = JSON.parse(content);
        log("  JSON 格式，解析成功");
      } catch (err) {
        log("  JSON 解析失败: " + err.message);
        setStatus("导入失败：JSON 格式错误");
        return;
      }
    } else {
      // MD/TXT 格式，作为架构文档存储
      analysis = {
        summary: "导入的架构文档（" + fileName + "）",
        importedDocument: content,
        imported: true,
        routes: [],
        navigation: [],
        pageApiMap: {},
        menuApis: [],
        timestamp: Date.now(),
        refined: true,
      };
      log("  文档格式: " + ext.toUpperCase() + "，已作为架构文档导入");
    }

    // 补全字段
    if (!analysis.routes) analysis.routes = [];
    if (!analysis.navigation) analysis.navigation = [];
    if (!analysis.pageApiMap) analysis.pageApiMap = {};
    if (!analysis.menuApis) analysis.menuApis = [];
    analysis.timestamp = analysis.timestamp || Date.now();
    analysis.fileCount = analysis.fileCount || 0;
    analysis.refined = true;
    analysis.imported = true;

    archAnalysis = analysis;

    // 渲染
    renderArchResult(archAnalysis);

    // 缓存
    AIFT_ProjectAnalyzer.saveCache(archAnalysis).then(function () {
      log("架构文档已导入并缓存");
    });

    els.archCacheInfo.textContent = "已导入: " + fileName;
    els.archCacheInfo.style.color = "#0a7c3e";
    setStatus("架构文档已导入");
    updateButtonStates();
  };

  reader.onerror = function () {
    log("文件读取失败");
    setStatus("导入失败：文件读取错误");
  };

  reader.readAsText(file);
}

function renderArchResult(analysis) {
  if (!analysis) {
    els.archResult.innerHTML = '<div class="arch-empty">无分析结果</div>';
    els.exportArchBtn.disabled = true;
    return;
  }
  els.exportArchBtn.disabled = false;
  var html = "";

  // 导入的文档（MD/TXT）
  if (analysis.importedDocument) {
    html += '<div class="arch-summary">📄 导入的架构文档</div>';
    html += '<div class="arch-imported-doc">' + escapeHtml(analysis.importedDocument) + '</div>';
    els.archResult.innerHTML = html;
    return;
  }

  if (analysis.summary) {
    html += '<div class="arch-summary">' + escapeHtml(analysis.summary) + '</div>';
  } else {
    html += '<div class="arch-summary">共扫描 ' + (analysis.fileCount || 0) + ' 个源码文件</div>';
  }

  // 项目概述与技术栈
  if (analysis.projectOverview) {
    var po = analysis.projectOverview;
    html += '<div class="arch-section"><div class="arch-section-title">📋 项目概述</div>';
    if (po.type) html += '<div style="padding:2px 6px"><b>类型:</b> ' + escapeHtml(po.type) + '</div>';
    if (po.description) html += '<div style="padding:2px 6px"><b>定位:</b> ' + escapeHtml(po.description) + '</div>';
    if (po.scale && po.scale.description) html += '<div style="padding:2px 6px"><b>规模:</b> ' + escapeHtml(po.scale.description) + '</div>';
    if (po.techStack && po.techStack.length > 0) {
      html += '<div style="padding:4px 6px"><b>技术栈:</b></div>';
      for (var tsi = 0; tsi < po.techStack.length; tsi++) {
        var ts = po.techStack[tsi];
        var tsLine = '<div style="padding:1px 12px;font-size:11px">';
        if (ts.category) tsLine += '<span style="color:#86909c">[' + escapeHtml(ts.category) + '] </span>';
        tsLine += escapeHtml(ts.name);
        if (ts.purpose) tsLine += ' <span style="color:#86909c">(' + escapeHtml(ts.purpose) + ')</span>';
        tsLine += '</div>';
        html += tsLine;
      }
    }
    html += '</div>';
  }

  // 目录结构
  if (analysis.directoryStructure) {
    html += '<div class="arch-section"><div class="arch-section-title">📁 目录结构</div>';
    html += '<div style="padding:4px 6px;font-size:11px;white-space:pre-wrap;font-family:SF Mono,Menlo,Consolas,monospace;line-height:1.8">' + escapeHtml(analysis.directoryStructure) + '</div>';
    html += '</div>';
  }

  // 架构图
  if (analysis.architectureDiagram) {
    html += '<div class="arch-section"><div class="arch-section-title">🏗️ 架构图</div>';
    html += '<div style="padding:4px 6px;font-size:11px;white-space:pre-wrap;font-family:SF Mono,Menlo,Consolas,monospace;line-height:1.5;overflow-x:auto">' + escapeHtml(analysis.architectureDiagram) + '</div>';
    html += '</div>';
  }

  // 启动流程
  if (analysis.startupFlow) {
    html += '<div class="arch-section"><div class="arch-section-title">🚀 启动流程</div>';
    html += '<div style="padding:4px 6px;font-size:11px;white-space:pre-wrap">' + escapeHtml(analysis.startupFlow) + '</div>';
    html += '</div>';
  }

  // 路由系统描述
  if (analysis.routeConfig) {
    html += '<div class="arch-section"><div class="arch-section-title">🔀 路由系统</div>';
    html += '<div style="padding:4px 6px;font-size:11px;white-space:pre-wrap">' + escapeHtml(analysis.routeConfig) + '</div>';
    html += '</div>';
  }

  // 状态管理
  if (analysis.storeInfo) {
    html += '<div class="arch-section"><div class="arch-section-title">📦 状态管理</div>';
    html += '<div style="padding:4px 6px;font-size:11px;white-space:pre-wrap">' + escapeHtml(analysis.storeInfo) + '</div>';
    html += '</div>';
  }

  // Vuex 模块表格
  if (analysis.vuexModules && analysis.vuexModules.length > 0) {
    html += '<div class="arch-section"><div class="arch-section-title">📦 状态管理模块 (' + analysis.vuexModules.length + ')</div>';
    html += '<table class="arch-table"><thead><tr><th>模块</th><th>范围</th><th>职责</th></tr></thead><tbody>';
    for (var vmi = 0; vmi < analysis.vuexModules.length; vmi++) {
      var vm = analysis.vuexModules[vmi];
      html += '<tr><td>' + escapeHtml(vm.name || "") + '</td><td>' + escapeHtml(vm.scope || "") + '</td><td>' + escapeHtml(vm.description || "") + '</td></tr>';
    }
    html += '</tbody></table>';
    html += '</div>';
  }

  // API 层设计
  if (analysis.apiLayer) {
    html += '<div class="arch-section"><div class="arch-section-title">🌐 API 层设计</div>';
    html += '<div style="padding:4px 6px;font-size:11px;white-space:pre-wrap">' + escapeHtml(analysis.apiLayer) + '</div>';
    html += '</div>';
  }

  // 组件体系
  if (analysis.componentSystem) {
    html += '<div class="arch-section"><div class="arch-section-title">🧩 组件体系</div>';
    html += '<div style="padding:4px 6px;font-size:11px;white-space:pre-wrap">' + escapeHtml(analysis.componentSystem) + '</div>';
    html += '</div>';
  }

  // 安全机制
  if (analysis.securityMechanisms) {
    html += '<div class="arch-section"><div class="arch-section-title">🔒 权限与安全</div>';
    html += '<div style="padding:4px 6px;font-size:11px;white-space:pre-wrap">' + escapeHtml(analysis.securityMechanisms) + '</div>';
    html += '</div>';
  }

  // 安全机制表格
  if (analysis.securityDetails && analysis.securityDetails.length > 0) {
    html += '<div class="arch-section"><div class="arch-section-title">🔒 安全机制详情 (' + analysis.securityDetails.length + ')</div>';
    html += '<table class="arch-table"><thead><tr><th>机制</th><th>实现</th></tr></thead><tbody>';
    for (var sdi = 0; sdi < analysis.securityDetails.length; sdi++) {
      var sd = analysis.securityDetails[sdi];
      html += '<tr><td>' + escapeHtml(sd.mechanism || "") + '</td><td>' + escapeHtml(sd.implementation || "") + '</td></tr>';
    }
    html += '</tbody></table>';
    html += '</div>';
  }

  // 业务模块（按分类分组）
  if (analysis.businessModules && analysis.businessModules.length > 0) {
    if (Array.isArray(analysis.businessModules)) {
      // 按 category 分组
      var bmGroups = {};
      for (var bmi3 = 0; bmi3 < analysis.businessModules.length; bmi3++) {
        var bm3 = analysis.businessModules[bmi3];
        var bmCat = bm3.category || "其他";
        if (!bmGroups[bmCat]) bmGroups[bmCat] = [];
        bmGroups[bmCat].push(bm3);
      }
      html += '<div class="arch-section"><div class="arch-section-title">📊 业务模块 (' + analysis.businessModules.length + ')</div>';
      for (var bmCatKey in bmGroups) {
        if (!bmGroups.hasOwnProperty(bmCatKey)) continue;
        var bmList = bmGroups[bmCatKey];
        html += '<div style="padding:6px 6px 2px;font-size:12px;font-weight:600;color:#3b47c7">' + escapeHtml(bmCatKey) + ' (' + bmList.length + ')</div>';
        for (var bli = 0; bli < bmList.length; bli++) {
          var bliItem = bmList[bli];
          html += '<div class="arch-route-item">';
          if (bliItem.routePath) html += '<span class="arch-route-path">' + escapeHtml(bliItem.routePath) + '</span>';
          if (bliItem.name) html += ' → <span class="arch-route-name">' + escapeHtml(bliItem.name) + '</span>';
          if (bliItem.description) html += ' <span style="color:#86909c">(' + escapeHtml(bliItem.description) + ')</span>';
          html += '</div>';
        }
      }
      html += '</div>';
    } else if (typeof analysis.businessModules === "string") {
      html += '<div class="arch-section"><div class="arch-section-title">📊 业务模块</div>';
      html += '<div style="padding:4px 6px;font-size:11px;white-space:pre-wrap">' + escapeHtml(analysis.businessModules) + '</div>';
      html += '</div>';
    }
  }

  // 构建与部署
  if (analysis.buildAndDeploy) {
    html += '<div class="arch-section"><div class="arch-section-title">⚙️ 构建与部署</div>';
    html += '<div style="padding:4px 6px;font-size:11px;white-space:pre-wrap">' + escapeHtml(analysis.buildAndDeploy) + '</div>';
    html += '</div>';
  }

  // 架构特点与设计模式
  if (analysis.designPatterns) {
    html += '<div class="arch-section"><div class="arch-section-title">💡 架构特点与设计模式</div>';
    html += '<div style="padding:4px 6px;font-size:11px;white-space:pre-wrap">' + escapeHtml(analysis.designPatterns) + '</div>';
    html += '</div>';
  }

  // 潜在问题与优化建议
  if (analysis.potentialIssues && analysis.potentialIssues.length > 0) {
    html += '<div class="arch-section"><div class="arch-section-title">⚠️ 潜在问题与优化建议 (' + analysis.potentialIssues.length + ')</div>';
    html += '<table class="arch-table"><thead><tr><th>维度</th><th>问题</th><th>建议</th></tr></thead><tbody>';
    for (var pii = 0; pii < analysis.potentialIssues.length; pii++) {
      var pi = analysis.potentialIssues[pii];
      html += '<tr><td>' + escapeHtml(pi.category || "") + '</td><td>' + escapeHtml(pi.issue || "") + '</td><td>' + escapeHtml(pi.suggestion || "") + '</td></tr>';
    }
    html += '</tbody></table>';
    html += '</div>';
  }

  // 优势
  if (analysis.strengths && analysis.strengths.length > 0) {
    html += '<div class="arch-section"><div class="arch-section-title">✅ 优势</div>';
    for (var si = 0; si < analysis.strengths.length; si++) {
      html += '<div style="padding:2px 6px;font-size:11px;color:#0a7c3e">✓ ' + escapeHtml(analysis.strengths[si]) + '</div>';
    }
    html += '</div>';
  }

  // 待改进
  if (analysis.improvements && analysis.improvements.length > 0) {
    html += '<div class="arch-section"><div class="arch-section-title">🔧 待改进</div>';
    for (var ii = 0; ii < analysis.improvements.length; ii++) {
      html += '<div style="padding:2px 6px;font-size:11px;color:#d97706">→ ' + escapeHtml(analysis.improvements[ii]) + '</div>';
    }
    html += '</div>';
  }

  if (analysis.routes && analysis.routes.length > 0) {
    html += '<div class="arch-section"><div class="arch-section-title">路由地图 (' + analysis.routes.length + ')</div>';
    for (var i = 0; i < analysis.routes.length; i++) {
      var r = analysis.routes[i];
      html += '<div class="arch-route-item">';
      html += '<span class="arch-route-path">' + escapeHtml(r.path) + '</span>';
      if (r.name) html += ' → <span class="arch-route-name">' + escapeHtml(r.name) + '</span>';
      else if (r.component) html += ' → <span class="arch-route-name">' + escapeHtml(r.component) + '</span>';
      if (r.description) html += ' <span style="color:#86909c">(' + escapeHtml(r.description) + ')</span>';
      if (r.source === "menu-api") html += ' <span style="color:#d97706;font-size:10px">[API获取]</span>';
      if (r.source === "runtime-dom") html += ' <span style="color:#3b47c7;font-size:10px">[DOM提取]</span>';
      html += '</div>';
    }
    html += '</div>';
  }
  // 动态路由信息
  if (analysis.isDynamicRouting) {
    html += '<div class="arch-section"><div class="arch-section-title">⚠️ 动态路由</div>';
    html += '<div style="padding:4px 6px;color:#d97706;font-size:11px">该项目使用动态路由，以下路由通过重放菜单 API 获取：</div>';
    if (analysis.menuApis && analysis.menuApis.length > 0) {
      for (var mi = 0; mi < analysis.menuApis.length; mi++) {
        html += '<div class="arch-api-item"><span class="arch-api-method net-method-get">API</span> <span class="arch-api-url">' + escapeHtml(analysis.menuApis[mi].url) + '</span></div>';
      }
    }
    if (analysis.apiFetchedRoutes && analysis.apiFetchedRoutes.length > 0) {
      html += '<div style="padding:4px 6px;color:#0a7c3e;font-size:11px">成功获取 ' + analysis.apiFetchedRoutes.length + ' 条动态路由</div>';
    }
    if (analysis.runtimeNavigation && analysis.runtimeNavigation.length > 0) {
      html += '<div style="padding:4px 6px;color:#3b47c7;font-size:11px">从 DOM 补充提取 ' + analysis.runtimeNavigation.length + ' 个导航项</div>';
    }
    html += '</div>';
  }
  if (analysis.navigation && analysis.navigation.length > 0) {
    html += '<div class="arch-section"><div class="arch-section-title">导航结构 (' + analysis.navigation.length + ')</div>';
    for (var j = 0; j < analysis.navigation.length; j++) {
      var n = analysis.navigation[j];
      html += '<div class="arch-nav-item">';
      if (n.parent) html += '<span class="arch-nav-parent">' + escapeHtml(n.parent) + ' › </span>';
      html += '<span class="arch-nav-text">' + escapeHtml(n.text) + '</span>';
      html += ' <span class="arch-nav-path">' + escapeHtml(n.path) + '</span>';
      html += '</div>';
    }
    html += '</div>';
  }
  if (analysis.pageApiMap) {
    var apiCount = 0;
    for (var k in analysis.pageApiMap) { if (analysis.pageApiMap.hasOwnProperty(k)) apiCount++; }
    if (apiCount > 0) {
      html += '<div class="arch-section"><div class="arch-section-title">页面-API 映射</div>';
      for (var page in analysis.pageApiMap) {
        if (analysis.pageApiMap.hasOwnProperty(page)) {
          html += '<div class="arch-api-item">';
          html += '<span class="arch-route-path">' + escapeHtml(page) + '</span>: ';
          var apis = analysis.pageApiMap[page];
          for (var ai = 0; ai < apis.length; ai++) {
            html += '<span class="arch-api-url">' + escapeHtml(apis[ai]) + '</span>';
            if (ai < apis.length - 1) html += ', ';
          }
          html += '</div>';
        }
      }
      html += '</div>';
    }
  } else if (analysis.apiCalls && analysis.apiCalls.length > 0) {
    html += '<div class="arch-section"><div class="arch-section-title">API 调用列表 (' + analysis.apiCalls.length + ')</div>';
    for (var bi = 0; bi < Math.min(analysis.apiCalls.length, 30); bi++) {
      var a = analysis.apiCalls[bi];
      html += '<div class="arch-api-item">';
      html += '<span class="arch-api-method net-method-' + (a.method || "GET").toLowerCase() + '">' + escapeHtml(a.method) + '</span>';
      html += ' <span class="arch-api-url">' + escapeHtml(a.url) + '</span>';
      html += ' <span style="color:#86909c;font-size:10px">(' + escapeHtml(a.source) + ')</span>';
      html += '</div>';
    }
    html += '</div>';
  }
  els.archResult.innerHTML = html || '<div class="arch-empty">未识别到架构信息</div>';
}

// ---- AI 生成测试用例 ----
async function generateTestCases() {
  var requirement = els.requirement.value.trim();
  if (!requirement) {
    log("请先填写原始需求");
    setStatus("请先填写原始需求");
    return;
  }

  var extraPrompt = await showPromptDialog(
    "生成测试用例 - 额外提示词",
    "可输入额外提示词来引导 AI 生成测试用例（可选）：",
    "如：重点关注登录流程、数据校验、边界条件..."
  );
  if (extraPrompt === null) return;

  var config = getAiConfig();
  if (!reportConfigValidation(config, true)) return;

  els.genTestCasesBtn.disabled = true;
  els.genTestCasesBtn.textContent = "生成中...";
  startPhase("testcases");
  setStatus("AI 生成测试用例中...");
  log("开始生成测试用例");

  try {
    var promptParts = [
      "你是一个资深测试工程师。根据以下前端页面需求，生成结构化、适度的自动化测试用例。",
      "",
      "## 第一步：需求结构化分析（内部思考，不输出）",
      "在生成用例前，你必须先完成以下分析：",
      "1. 识别需求中涉及的所有页面/路由",
      "2. 识别每个页面包含的模块/区域",
      "3. 识别每个模块下的功能点、数据展示项和交互行为",
      "4. 识别每个模块对应的数据来源（哪些字段由同一个接口返回）",
      "5. 识别页面间的跳转关系和每个功能点的前置条件",
      "6. 【关键】逐个枚举页面上的所有 UI 交互元素：",
      "   - 有哪些下拉框/选择器？每个的选项来源是什么？",
      "   - 有哪些搜索框/输入框？搜索逻辑是什么？",
      "   - 有哪些按钮？每个按钮的功能和权限是什么？",
      "   - 有哪些 Tab？切换后行为是什么？",
      "   - 有没有分页器、排序、导出、刷新等操作？",
      "   - 有没有弹窗/抽屉/表单？表单字段和校验规则是什么？",
      "   - 有没有图表？图表的交互方式是什么？",
      "   - 有没有日期选择器、开关、复选框等控件？",
      "7. 识别需要覆盖的 UI 交互场景（loading、防抖、数据刷新、tooltip、空状态等）",
      "8. 识别筛选项的排列组合情况，判断哪些需要逐个测试、哪些只需取典型值",
      "9. 【关键】识别哪些用例可共享页面导航、弹窗、筛选条件或列表定位，",
      "   并标记只有在切换到不兼容场景或全部相关用例完成后才需要清理的状态",
      "10. 【关键】需求符合性分析（必须完成）：",
      "   a. 逐条对照需求，列出需求中明确要求的所有功能（如创建、编辑、删除、搜索、分页等）",
      "   b. 对每个功能，判断页面上应该存在哪些对应的 UI 入口（按钮、链接、输入框等）",
      "   c. 列出需求中未提及但页面上可能存在的功能按钮（如导出、批量操作、打印等）",
      "   d. 标记「需求要求但可能缺失的功能」和「需求未要求但可能多余的功能」",
      "   e. 为每个页面/模块生成需求符合性检查用例，验证功能完整性",
      "",
      "## 第二步：生成测试用例",
      "",
      "### 用例粒度原则（核心）",
      "- 数据验证用例：以「模块 + 接口」为粒度，同一接口返回的多个字段合并到一个用例中验证。",
      "- 【字段映射强制】凡是验证表格/列表与 API 数据一致的用例，预期结果必须明确写「字段映射：页面列头「任务名称」← API字段 taskName；页面列头「状态」← API字段 status」；映射必须来自需求、源码或 API 字段语义，严禁把名称相近但业务语义不同的字段强行对应。",
      "- 若无法从需求、源码或 API 响应确定列头与字段的业务语义，生成「字段映射待确认」用例并要求结果为未完成验证，禁止写成数据一致性通过。",
      "- UI 交互用例：必须细化到每个独立的 UI 元素，每个下拉框、搜索框、按钮、Tab 切换、",
      "  分页器、排序按钮等都应有独立用例或明确覆盖。",
      "- 不同模块或不同接口的数据验证，分别用独立用例。",
      "- UI 交互用例与功能用例混合编号。",
      "- 目标：用例数量通常 20-40 条，确保覆盖所有 UI 场景。",
      "",
      "### 操作步骤格式（高层描述，严禁使用工具名）",
      "",
      "【严禁】操作步骤中严禁出现以下格式：",
      "- ❌ [click]('.xxx') — 禁止使用方括号工具名",
      "- ❌ [eval_in_page]('document.querySelector(...)') — 禁止使用方括号工具名",
      "- ❌ [get_network_responses]('/api/xxx') — 禁止使用方括号工具名",
      "- ❌ [wait](500) — 禁止使用方括号工具名",
      "- ❌ 任何 [工具名](参数) 格式 — 一律禁止",
      "",
      "【必须】操作步骤只能用自然语言描述动作和验证内容：",
      "- ✅ 1.点击「新增脚本」按钮 → 验证弹出新增弹窗",
      "- ✅ 2.获取 /api/script/list 接口响应 → 验证返回数据完整",
      config.visionSupported
        ? "- ✅ 3.截图验证页面展示 → 检查表格渲染、CSS 无异常"
        : "- ✅ 3.检查页面元素状态、文本和属性 → 验证表格数据和交互状态正确",
      "- ✅ 4.检查页面上所有按钮文本 → 验证存在「新增脚本」按钮",
      "- ✅ 5.检查搜索框是否存在 → 验证搜索功能可用",
      "",
      "步骤格式：序号.动作描述 → 验证内容",
      "多个步骤用 → 连接。不要在单条用例中写「恢复：」步骤；执行器会在相关用例组完成后统一处理场景切换。",
      "",
      "### 操作准确性原则",
      "1. 【源码验证】步骤描述应基于源码中确认存在的交互行为",
      "2. 【不确定则省略】无法从源码确认的交互行为不要写入步骤",
      "3. 【避免猜测事件】常见错误：",
      "   - 输入框没有回车事件 → 不要写「按回车触发搜索」",
      "   - 没有防抖/loading/空状态 → 不要写对应的检查步骤",
      "4. 【验证方式标注】在步骤中标注验证方式：",
      "   - 需要验证 API 数据 → 写「获取 /api/xxx 接口响应」",
      config.visionSupported
        ? "   - 需要验证 UI 展示 → 写「截图验证页面展示」"
        : "   - 需要验证 UI 展示 → 写「检查 xxx 元素的文本、属性、class/样式」",
      "   - 需要检查元素状态 → 写「检查 xxx 元素的 class/属性」",
      "",

      "### 用例完整性原则",
      "每条测试用例必须包含清晰的前置条件、业务操作和可观察的验证结果。",
      "相关用例会被执行器编排到同一场景连续执行，不要求每条用例都回到初始状态。",
      "",
      "具体要求：",
      "1. 每条用例的操作步骤必须包含三个阶段：",
      "   - 操作阶段：描述要执行的动作（如「点击查询按钮」「选择下拉选项」）",
      "   - 数据验证阶段：描述要验证的数据（如「获取 /api/list 接口响应，验证字段完整性」）",
      config.visionSupported
        ? "   - UI 检查阶段：描述要验证的 UI 状态（如「截图验证列表渲染」「检查按钮禁用状态」）"
        : "   - UI 检查阶段：描述要验证的 UI 状态（如「检查列表文本和行数」「检查按钮禁用状态」）",
      "2. 不要添加「恢复：」或「清空并回到默认状态」等步骤。执行前会先分析用例相关性，",
      "   相关用例会连续复用当前状态；只有执行器在切换到不兼容场景时才决定是否清理。",
      "3. 若后续验证依赖当前筛选、弹窗或编辑结果，应在前置条件中写明该状态，而不是要求恢复。",
      "",
      "### UI 检查要求（必须包含）",
      "每条涉及用户操作的用例，在操作后必须包含 UI 检查步骤，验证页面 UI 状态正常。",
      "Agent 每次操作后自动获取 DOM 快照（含元素标签、文本、class、位置、可见性），",
      "能从快照中观察到大部分 UI 变化。以下场景需要额外检查：",
      "",
      "1. 【交互状态检查】操作后检查元素的交互状态 class：",
      "   - 选中状态：.is-active / .is-selected / .active",
      "   - 禁用状态：[disabled] / .is-disabled / .disabled",
      "   - 加载状态：.is-loading / .el-loading-mask / .ant-spin",
      "   - 错误状态：.is-error / .el-form-item__error / .ant-form-item-explain-error",
      "   - 展开/折叠：.is-expanded / .is-open / .el-collapse-item__wrap",
      "   方法：eval_in_page('document.querySelector(\".xxx\").classList.contains(\"is-active\")')",
      "",
      "2. 【可见性检查】操作后元素应出现/消失：",
      "   - 弹窗打开：检查 .el-dialog / .ant-modal 是否存在且可见",
      "   - 下拉展开：检查 .el-select-dropdown / .ant-select-dropdown 是否存在",
      "   - 抽屉打开：检查 .el-drawer / .ant-drawer 是否存在",
      "   - 消息提示：检查 .el-message / .ant-message 是否出现",
      "   方法：eval_in_page('document.querySelector(\".el-dialog\") !== null')",
      "",
      "3. 【样式检查】关键样式值是否正确（使用 getComputedStyle）：",
      "   - 隐藏元素：getComputedStyle(el).display === 'none'",
      "   - 文字溢出：getComputedStyle(el).textOverflow === 'ellipsis'",
      "   - 按钮禁用样式：getComputedStyle(el).cursor === 'not-allowed'",
      "   - 高亮颜色：getComputedStyle(el).color / backgroundColor",
      "   方法：eval_in_page('getComputedStyle(document.querySelector(\".xxx\")).display')",
      "",
      "4. 【布局检查】元素位置和尺寸是否正常：",
      "   - 弹窗居中：getBoundingClientRect() 居中显示",
      "   - 表格列宽：列宽合理，无挤压",
      "   - 元素不重叠：两个元素的 rect 不交叉",
      "   方法：eval_in_page('JSON.stringify(document.querySelector(\".xxx\").getBoundingClientRect())')",
      "",
      config.visionSupported
        ? "5. 【视觉检查】（模型支持图片时）：操作后截图验证整体页面是否正常"
        : "5. 【DOM 检查】：使用元素文本、属性、class、可见性和尺寸验证页面状态",
      config.visionSupported
        ? "   - 方法：截图后 AI 视觉分析布局、颜色、对齐等"
        : "   - 适用于：下拉展开、弹窗出现、选中/禁用/加载状态、表格数据和错误提示",
      "",
      "UI 检查步骤数量：每条用例 1-3 个 UI 检查步骤，根据操作类型选择最相关的检查项。",
      "不要每条用例都检查所有项，只检查与当前操作直接相关的 UI 变化。",
      "",
      "### 输出格式（严格遵守）",
      "每行一个测试用例，使用 CSV 格式输出（逗号分隔，含特殊字符的字段用双引号包裹）。",
      "字段顺序：TC编号,用例标题,测试页面,前置条件,操作步骤,预期结果",
      "CSV 转义规则：",
      "- 字段中如果包含逗号、双引号、换行符，必须用双引号包裹整个字段",
      "- 字段内的双引号用两个双引号转义（如 \"\" 表示一个双引号）",
      "- eval_in_page 的 JS 代码中经常包含逗号和引号，必须用双引号包裹该字段",
      "示例格式：",
      "TC1,菜单显示及顺序,运维排障-可观测性菜单,已登录系统,\"1.展开侧边栏菜单 → 2.检查菜单项数量 → 3.获取 /api/menu 接口响应，验证菜单数据完整\",菜单项数量≥1；API返回菜单数据完整",
      "",
      "### 可用工具说明",
      "执行 Agent 会根据步骤描述自行选择合适的工具，无需在步骤中指定工具名。",
      "Agent 拥有的工具能力包括：",
      "- 预设模板操作（下拉框选择、输入框输入、按钮点击、表单填写、表格操作、Tab切换等）",
      "- 基础操作（点击、输入、按键、滚动、悬停）",
      "- 页面 JS 执行（读取元素状态、检查 class/属性/样式）",
      "- 网络请求捕获（获取 API 响应数据）",
      config.visionSupported
        ? "- 截图验证（截图检查页面展示）"
        : "- DOM 状态验证（检查元素文本、属性、class、可见性和尺寸）",
      "- 源码检索（按关键词搜索项目源码）",
      "- 断言（记录测试结果）",
      "",
      "步骤中只需描述动作和验证内容，Agent 会自动选择最佳工具执行。",
      "",
    ];

    if (!config.visionSupported) {
      promptParts.push(
        "### 非视觉模型限制（必须遵守）",
        "当前模型不具备图片理解能力。操作步骤、预期结果和示例中严禁出现截图、视觉验证、图片、verify_ui 等字样。",
        "页面展示只能通过检查元素文本、属性、class、可见性、尺寸、DOM 结构或 API 数据验证。",
        "不要提出需要人工看图、检查布局颜色或截图确认的断言。",
        ""
      );
    }

    // 视觉优先模式（模型支持图片时）
    if (config.visionSupported) {
      promptParts.push(
        "### 视觉验证流程（verify_ui）",
        "模型支持图片，Agent 可使用 verify_ui 截图验证页面展示效果。",
        "",
        "【操作与验证分离原则】",
        "- 操作步骤使用真实交互工具（select_option/click_button/click/type 等，底层优先 CDP 鼠标键盘）",
        "- 验证步骤使用 verify_ui 截图让 AI 视觉检查页面展示",
        "- 不再使用 visual_click/visual_type 等坐标操作作为主要操作方式",
        "- 坐标操作用于 Canvas/SVG/Shadow DOM、普通定位失败或视觉坐标更可靠的场景",
        "",
        "【verify_ui 使用场景】",
        "在以下步骤后应添加 verify_ui 截图验证：",
        "1. 打开下拉框后 → 验证下拉选项展示正确、CSS 无异常",
        "2. 切换 Tab 后 → 验证 Tab 内容渲染正确",
        "3. 打开弹窗后 → 验证弹窗布局、表单展示",
        "4. 数据加载后 → 验证表格/列表渲染正确",
        "5. 表单提交后 → 验证成功/错误提示展示",
        "",
        "【verify_ui 步骤格式】",
        "在操作步骤中添加：序号.[verify_ui]() 检查XXX展示是否正确",
        "示例：2.[verify_ui]() 检查下拉选项展示是否正确，CSS 无异常",
        "",
        "【视觉验证用例示例】",
        "TC1,下拉筛选搜索功能,XX页面,已进入XX页面,\"1.点击筛选下拉框，选择「选项A」 → 2.截图验证下拉选项展示是否正确，CSS 无异常 → 3.点击查询按钮 → 4.获取 /api/list 接口响应，验证查询结果 → 5.截图验证列表数据展示是否正确\",下拉框展开正常，选项展示正确；筛选后列表数据刷新；API返回数据完整",
        "",
      );
    }

    promptParts.push(
      "### 字段说明",
      "- TC编号：TC1, TC2, TC3... 递增",
      "- 用例标题：简明扼要（15字以内），概括测试目的",
      "- 测试页面：该用例在哪个页面上执行",
      "- 前置条件：执行前需要满足的条件",
      "- 操作步骤：必须按步骤编号，每步明确描述动作和验证内容，用 → 连接",
      "- 预期结果：可验证的结果，多个验证点用分号分隔",
      "",
      "### 操作步骤格式（核心要求）",
      "每个步骤格式：序号.动作描述 → 验证内容",
      "多个步骤用 → 连接，形成完整的操作链。",
      "步骤只需描述「做什么」和「验证什么」，用自然语言描述即可。",
      "执行 Agent 会根据步骤描述自行分析页面 DOM、选择最佳工具和操作方式。",
      "",
      "【严禁】步骤中出现 [工具名](参数) 格式，如 [click]('.xxx') 或 [eval_in_page]('...') 等。",
      "【严禁】步骤中出现 CSS 选择器（如 .el-button、#xxx）。",
      "",
      "步骤中的验证方式标注：",
      "- 需要验证 API 数据 → 写「获取 /api/xxx 接口响应，验证 xxx」",
      config.visionSupported
        ? "- 需要验证 UI 展示 → 写「截图验证页面展示，检查 xxx」"
        : "- 需要验证 UI 展示 → 写「检查 xxx 元素的文本、属性、class/样式」",
      "- 需要检查元素状态 → 写「检查 xxx 元素的 class/属性/样式」",
      "- 需要等待异步 → 写「等待 xxx 加载完成」",
      "所有用户交互必须使用 click/type/press/hover/scroll 等专用工具。",
      "",
      "### 【极其重要】单行约束",
      "每条测试用例必须输出在单独的一行中，使用 CSV 格式（逗号分隔字段）。",
      "eval_in_page 的 JS 代码中严禁出现真实换行符！",
      "- 含逗号/引号/特殊字符的字段必须用双引号包裹（CSV 标准）",
      "- 错误：join(\"\\n\") — \\n 会被输出为真实换行，破坏用例格式",
      "- 正确：join(\",\") 或 join(\";\") 或 join(\" | \")",
      "- 错误：多行 JS 代码直接换行",
      "- 正确：将多行 JS 合并为单行，用分号 ; 连接",
      "如果 JS 代码较长，使用简短的表达式而非完整语句。",
      "",
      "### 【极其重要】CSV 逗号问题",
      "操作步骤中如果包含逗号（如「获取 /api/list 接口响应，验证字段完整性」），",
      "这些逗号会被 CSV 解析器误判为字段分隔符，导致用例字段错位！",
      "因此，操作步骤字段必须始终用双引号包裹。",
      "- 错误：TC1,测试标题,页面,前置,1.点击按钮 → 2.获取 /api/list 接口响应，验证数据,预期结果",
      "  ↑ 步骤中的逗号导致 CSV 解析为 7 个字段而非 6 个，字段错位！",
      "- 正确：TC1,测试标题,页面,前置,\"1.点击按钮 → 2.获取 /api/list 接口响应，验证数据\",预期结果",
      "  ↑ 双引号包裹操作步骤字段，CSV 解析器正确识别为 6 个字段",
      "规则：操作步骤字段始终用双引号包裹，避免逗号导致字段错位。",
      "",
      "### 示例",
      "TC1,菜单显示及顺序,运维排障-可观测性菜单,已登录系统,\"1.展开侧边栏运维部署菜单 → 2.等待子菜单展开 → 3.点击可观测性菜单 → 4.等待页面加载 → 5.获取 /api/menu/list 接口响应，验证菜单数据完整\",菜单项数量≥1；API返回菜单数据完整；页面展示菜单文本与API一致",
      "TC2,实例-资源模块数据展示,运营概览页面,已进入运营概览页面,\"1.滚动到实例-资源模块 → 2.等待渲染完成 → 3.获取 /api/resource/overview 接口响应，验证各字段数据有效且页面展示一致\",API各字段（总数/已用/剩余/使用率）须有有效值且页面展示一致；使用率数值=已用/总数×100%",
      "TC3,漏斗按钮交互与跳转,运营概览页面,已进入运营概览页面,\"1.鼠标悬停漏斗按钮 → 2.等待tooltip出现 → 3.检查tooltip是否出现 → 4.点击漏斗按钮 → 5.等待页面跳转 → 6.获取 /api/resource/stat 接口响应，验证跳转后页面数据\",hover显示tooltip「下钻分析」；tooltip元素存在；点击后跳转至资源运营统计页面；按钮有权限时可点击",
      "TC4,资源下钻筛选与数据加载,资源运营统计页面,已从运营概览下钻至资源运营统计页面,\"1.选择筛选下拉框的第二个选项 → 2.等待数据刷新 → 3.检查当前选中项有高亮 → 4.获取 /api/resource/list 接口响应，验证刷新后列表数据\",下拉框默认全部；选中项有.is-active高亮；切换筛选后列表数据刷新；API返回数据完整",
      "TC5,趋势分析图表展示,运营概览页面,已进入运营概览页面,\"1.滚动到趋势分析模块 → 2.等待图表渲染 → 3.获取 /api/trend/data 接口响应，验证趋势数据 → 4.鼠标悬停图表触发tooltip → 5.等待tooltip出现\",API返回趋势数据各时间点字段须有有效值；图表正确渲染；hover节点显示对应数值tooltip",
      "TC6,资源类型下拉框筛选,资源运营统计页面,已进入资源运营统计页面,\"1.选择资源类型下拉框的第二个选项 → 2.等待数据刷新 → 3.获取 /api/resource/stat 接口响应，验证刷新后数据\",下拉框可展开；选项数量≥2；切换后列表数据刷新；API返回数据完整",
      "TC7,关键词搜索功能,资源运营统计页面,已选择资源类型筛选条件,\"1.在搜索框输入「测试主机」 → 2.点击搜索按钮 → 3.等待搜索结果 → 4.获取 /api/resource/stat 接口响应，验证搜索结果\",搜索后返回匹配结果；API请求参数包含关键词",
      "TC8,分页器翻页功能,资源运营统计页面,当前筛选结果数据>1页,\"1.滚动到分页器 → 2.点击第2页 → 3.等待数据加载 → 4.获取 /api/resource/stat 接口响应，验证第2页数据 → 5.点击每页条数选择 → 6.选择50条/页 → 7.等待刷新 → 8.获取 /api/resource/stat 接口响应，验证刷新后数据\",总条数显示正确；翻页后API参数含pageNum=2；切换条数后API参数含pageSize=50；loading状态正确",
      "TC9,表格排序功能,资源运营统计页面,当前列表已加载,\"1.点击第3列表头排序 → 2.等待排序完成 → 3.获取排序后第3列数据验证排序 → 4.再次点击切换排序方向 → 5.等待排序 → 6.获取 /api/resource/stat 接口响应，验证排序API参数\",第一次点击升序排列；第二次点击降序排列；API请求参数含sortField和sortOrder",
      "TC10,日期范围选择器,资源运营统计页面,当前列表已加载,\"1.点击日期选择器 → 2.等待面板展开 → 3.选择开始日期 → 4.选择结束日期 → 5.等待数据刷新 → 6.获取 /api/resource/stat 接口响应，验证日期筛选参数 → 7.点击快捷选项「最近7天」 → 8.等待刷新 → 9.获取 /api/resource/stat 接口响应，验证刷新后数据\",日期面板可展开；选择后API参数含startDate/endDate；快捷选项正确切换日期范围；页面展示日期与选择一致",
      "TC11,导出按钮功能,资源运营统计页面,已进入资源运营统计页面,\"1.点击导出按钮 → 2.等待操作完成 → 3.检查是否出现操作提示消息 → 4.获取 /api/resource/export 接口响应，验证导出请求\",按钮可点击；点击后显示loading；导出成功后显示提示消息；API请求参数正确",
      "TC12,空数据状态展示,资源运营统计页面,当前筛选结果已加载,\"1.在搜索框输入「ZZZZZ不存在的数据」 → 2.点击搜索按钮 → 3.等待结果 → 4.检查空状态组件是否显示 → 5.获取 /api/resource/stat 接口响应，验证返回空列表\",搜索无结果时显示空状态；空状态组件.el-empty存在；API返回空数组",
      "TC13,需求符合性-功能完整性检查,资源运营统计页面,已进入资源运营统计页面,\"1.获取页面上所有按钮文本列表 → 2.检查搜索框是否存在 → 3.检查分页器是否存在 → 4.检查表格是否存在 → 5.获取表格行内操作按钮列表\",需求要求的「搜索」「分页」「表格展示」功能均存在；表格行内操作按钮包含需求要求的「编辑」「删除」；无功能缺失",
      "TC14,需求符合性-多余功能检查,资源运营统计页面,已进入资源运营统计页面,\"1.检查是否存在导出按钮 → 2.检查是否存在批量操作按钮 → 3.检查是否存在打印按钮 → 4.获取所有按钮文本用于对比\",需求未要求的导出按钮不存在；需求未要求的批量操作按钮不存在；需求未要求的打印按钮不存在；页面上所有功能按钮均在需求范围内",
      "",
      "### 生成规则（必须遵守）",
      "0. 【操作准确性（最高优先级）】每条用例的操作步骤必须基于源码中确认存在的交互行为：",
      "   a. 编写步骤前，先检查相关源码中是否存在对应的事件绑定（@click、@keyup.enter、@change 等）",
      "   b. 如果源码中输入框没有 @keyup.enter / @keydown.enter 事件，严禁在步骤中写 press('Enter')",
      "   c. 如果输入框有对应的搜索/查询按钮，优先写点击按钮触发搜索，而非回车",
      "   d. 如果无法确认某个交互行为是否存在，不要在步骤中编写该操作",
      "   e. 优先使用预设模板（select_option/fill_input/click_button 等），模板比手动 click/type 更可靠",
      "   f. 不要在测试用例步骤中写 CSS 选择器；如需引用页面元素，用业务名称、标签文本、占位文本或按钮文案描述",
      "1. 每条用例必须包含全部6个字段，用 CSV 格式输出（逗号分隔，含特殊字符的字段用双引号包裹）",
      "2. 【用例粒度】数据验证用例以「模块+接口」为粒度合并字段；",
      "   UI 交互用例必须细化到每个独立 UI 元素（见下方 UI 覆盖要求）。",
      "3. 【页面上下文连续性】如果某个用例的操作会导致页面跳转，",
      "   则下一个用例的「前置条件」必须明确写出「从XX页面返回到YY页面」",
      "4. 【前置条件完整性】前置条件必须包含当前页面和必要的前置状态",
      "5. 【操作步骤完整且可执行】操作步骤必须满足以下要求：",
      "   a. 每一步必须明确描述动作和验证内容",
      "   b. 操作描述清晰，执行 Agent 能理解要做什么",
      config.visionSupported
        ? "   c. 验证方式标注（API 验证 / 截图验证 / 元素状态检查）"
        : "   c. 验证方式标注（API 验证 / 元素状态检查）",
      "   c. eval_in_page 仅用于读取页面状态（获取文本、检查 class、获取属性值等），",
      "      严禁用于模拟用户操作（dispatchEvent、修改 value、调用 .click() 等）",
      "   d. 文件上传使用 upload_file 向已观察到的 input[type=file] 注入受控测试文件；不要点击 input 唤起原生文件选择器；",
      "   e. get_network_responses 必须给出 URL 匹配模式",
      "   f. 涉及异步操作后必须加 wait 步骤",
      "   g. 数据验证主要通过 get_network_responses 获取 API 响应，",
      "      Agent 会自动从 DOM 快照中观察页面展示值进行对比，",
      "      仅当需要获取快照中无法直接观察的特定值时才使用 eval_in_page（每条用例≤2次）",
      "   g. 【UI 检查强制】涉及用户操作的用例必须包含 1-3 个 UI 检查步骤",
      "      （交互状态/可见性/样式/布局检查，见上方「UI 检查要求」）",
      "   h. 多个步骤用 → 连接，形成完整操作链",
      "   i. 步骤数量适中（4-15步），含 UI 检查步骤，不要过少也不要过多",
      "   j. 【连续执行】严禁在步骤中添加恢复、清空、重置默认值或返回原页等清理动作；",
      "      除非该动作本身就是当前用例要验证的业务功能。",
      "6. 【预期结果可验证】预期结果必须包含具体的可观察现象：",
      "   a. 页面显示什么文本/数值/图表",
      "   b. 涉及数据的用例，列出需验证的 API 字段名，注明字段值不能为空且页面展示须一致",
      "   c. UI 交互行为的具体表现（如「显示loading」「tooltip出现」「按钮禁用」）",
      "   d. UI 检查验证点（如「选中项有.is-active class」「弹窗居中显示」「隐藏元素display=none」）",
      "   e. 多个验证点用分号分隔",
      "7. 【UI 元素覆盖要求】（极其重要，必须逐项检查）：",
      "   对页面上的每个 UI 交互元素，必须生成对应的测试用例：",
      "   a. 【下拉框/选择器】每个下拉框都要测试：展开、选项数量、默认值、",
      "      切换选项后数据刷新、关闭下拉。不同下拉框分别建用例。",
      "   b. 【搜索框/输入框】每个搜索框都要测试：输入关键词搜索、清空搜索、",
      "      搜索结果为空的提示、特殊字符输入。不同搜索框分别建用例。",
      "   c. 【按钮】每个功能按钮都要测试：点击效果、loading 状态、",
      "      防抖/禁用状态、权限控制（无权限时是否隐藏/禁用）。",
      "   d. 【Tab 切换】每个 Tab 都要测试：切换后内容刷新、默认 Tab、",
      "      切换后 URL/状态变化。",
      "   e. 【分页器】测试：翻页、每页条数切换、总条数显示、跳转指定页。",
      "   f. 【排序】测试：点击排序、升序/降序切换、排序后数据顺序验证。",
      "   g. 【表格】测试：表头固定、列宽调整、行 hover 效果、",
      "      单元格内容溢出 tooltip、空数据占位。",
      "   h. 【弹窗/抽屉】测试：打开、内容加载、关闭（X按钮/遮罩/ESC）、",
      "      表单校验、提交后关闭+刷新。",
      "   i. 【图表】测试：渲染、hover tooltip、图例切换、数据为空时占位。",
      "   j. 【日期选择器】测试：选择日期范围、快捷选项、清空、",
      "      默认值（如默认最近7天）。",
      "   k. 【开关/复选框/单选框】测试：切换状态、切换后数据刷新、默认状态。",
      "   l. 【面包屑/导航】测试：点击返回、层级显示正确。",
      "   m. 【导出/下载按钮】测试：点击后触发下载、loading 状态、权限控制。",
      "   n. 【刷新按钮】测试：点击后数据重新加载、loading 状态。",
      "   ",
      "   【排列组合处理原则】如果一个筛选项有大量选项（如省份列表有30+个），",
      "   不需要逐个测试，挑 2-3 个典型值即可（如第一个、最后一个、中间一个）。",
      "   但每个独立的筛选项（不同字段）都必须被覆盖到。",
      "   如果多个筛选项存在联动关系，测试联动场景（如选省份→选城市）。",
      "8. 【场景覆盖完整】除上述 UI 元素覆盖外，还必须覆盖以下场景：",
      "   a. 每个模块的数据展示正确性（API 字段完整性 + 页面展示一致性）",
      "   b. CRUD 操作后的数据刷新反馈（创建/编辑/删除后列表是否更新）",
      "   c. 表单校验与提交防抖（必填校验、格式校验、重复提交防护）",
      "   d. 边界情况（空数据、无权限、异常状态、网络错误）",
      "   e. 页面间跳转与导航返回",
      "   f. loading 状态（首次加载、操作后刷新）",
      "   g. 空状态展示（无数据时的占位图/文案）",
      "9. 【需求符合性检查用例】（必须生成，极其重要）",
      "   对照需求逐条检查页面功能是否完整实现，是否有多余功能。每个页面/模块至少生成 1 条。",
      "   a. 【缺失功能检查】需求中明确要求的功能，页面上是否都有对应入口/按钮：",
      "      - 如需求要求「创建、编辑、删除」，检查页面上是否有「新增」按钮、行内「编辑」按钮、行内「删除」按钮",
      "      - 如需求要求「搜索」，检查页面上是否有搜索框",
      "      - 如需求要求「分页」，检查页面上是否有分页器",
      "      - 如需求要求「导出」，检查页面上是否有导出按钮",
      "      - 缺失任何一个需求要求的功能，标记为 FAIL",
      "   b. 【多余功能检查】页面上是否存在需求未要求的功能按钮：",
      "      - 如需求未提及「导出」，但页面上有导出按钮 → 标记为异常",
      "      - 如需求未提及「批量操作」，但页面上有批量操作按钮 → 标记为异常",
      "      - 如需求未提及「打印」，但页面上有打印按钮 → 标记为异常",
      "      - 多余功能按钮意味着可能超出需求范围开发，标记为 FAIL",
      "   c. 操作步骤：通过 eval_in_page 检查页面上是否存在对应的功能按钮/入口，",
      "      可用 document.querySelectorAll 获取所有按钮文本列表进行逐一对比",
      "   d. 预期结果：明确列出需求要求的功能清单，以及页面上不应存在的功能清单，逐一对比",
      "   e. 这类用例通常是只读检查，不需要额外场景清理",
      "10. 【UI 交互用例占比】UI 交互相关验证应占总用例的 50%-60%，",
      "   确保每个 UI 元素都有对应测试覆盖",
      "11. 【严格数据验证】涉及数据展示的用例，预期结果中必须明确：",
      "   a. 需要验证的 API 字段名称",
      "   b. 字段值不能为空/null/undefined（除非业务上确实允许为空）",
      "   c. 页面展示值必须与 API 返回值完全一致",
      "   d. 如有字段缺失或数据不一致，视为测试不通过",
      "12. 不要输出任何解释、前言、总结，只输出用例列表",
    );

    // 注入架构分析上下文
    if (archAnalysis) {
      var archText = AIFT_ProjectAnalyzer.formatForPrompt(archAnalysis);
      if (archText) {
        promptParts.push("");
        promptParts.push("## 项目架构信息（用于辅助生成更精准的测试用例）");
        promptParts.push(archText);
        promptParts.push("");
        promptParts.push("请结合以上架构信息，确保测试用例的「测试页面」与路由地图中的页面名称一致，");
        promptParts.push("操作步骤中涉及的导航路径与导航结构一致。");
      }
    } else {
      log("⚠️ 未进行架构分析，测试用例可能不够精准。建议先执行架构分析。");
    }

    // 注入相关源码文件，让 AI 基于实际代码判断交互行为
    var sourceKeys = Object.keys(uploadedSourceFiles);
    if (sourceKeys.length > 0) {
      // 筛选与页面交互相关的源码文件（Vue/React组件、页面文件等）
      var relevantFiles = [];
      var maxFiles = 15;
      var maxCharsPerFile = 4000;
      var totalChars = 0;
      var maxTotalChars = 50000;
      for (var si = 0; si < sourceKeys.length && relevantFiles.length < maxFiles; si++) {
        var path = sourceKeys[si];
        // 优先选择组件/页面文件
        if (/\.(vue|jsx|tsx)$/i.test(path) ||
            (/\.(js|ts)$/i.test(path) && /(view|page|component|widget|form|table|list|search|modal|dialog|drawer)/i.test(path))) {
          var content = uploadedSourceFiles[path];
          if (content && content.length > 0) {
            if (totalChars + content.length > maxTotalChars) {
              content = content.substring(0, Math.min(maxCharsPerFile, maxTotalChars - totalChars));
              if (content.length < 200) break;
              content += "\n…（已截断）";
            }
            relevantFiles.push({ path: path, content: content });
            totalChars += content.length;
          }
        }
      }
      if (relevantFiles.length > 0) {
        promptParts.push("");
        promptParts.push("## 相关源码文件（用于验证操作步骤的准确性）");
        promptParts.push("以下源码文件用于帮助你确认页面上的实际交互行为。");
        promptParts.push("在编写操作步骤时，必须先检查源码中是否存在对应的交互事件（如 @click、@keyup.enter、@change 等），");
        promptParts.push("只有源码中确认存在的交互行为才能写入操作步骤。");
        promptParts.push("");
        for (var ri = 0; ri < relevantFiles.length; ri++) {
          var rf = relevantFiles[ri];
          promptParts.push("### " + rf.path);
          promptParts.push("```");
          promptParts.push(rf.content);
          promptParts.push("```");
          promptParts.push("");
        }
      }
    }

    promptParts.push("");
    promptParts.push("需求：");
    promptParts.push(requirement);

    if (extraPrompt) {
      promptParts.push("");
      promptParts.push("## 用户额外提示词");
      promptParts.push(extraPrompt);
    }

    var prompt = promptParts.join("\n");

    streamClear();
    streamAppend("info", "正在生成测试用例...\n");

    var MAX_TC_RETRY = 2; // 推理死循环最多重试次数
    var tcRetryCount = 0;
    var result = null;
    var tcMessages = [{ role: "user", content: prompt }];
    var tcOutputParts = [];

    while (tcRetryCount <= MAX_TC_RETRY) {
      try {
        result = await AIFT_AIClient.chatStream(
          config,
          tcMessages,
          [],
          {
            timeout: 120000,
            maxRetries: 3,
            signal: pauseState.getSignal(),
            onDelta: function (type, content) {
              if (type === "content") {
                streamAppend("content", content);
              } else if (type === "reasoning") {
                streamAppend("reasoning", content);
              }
            },
          }
        );
        if (result && result.message && result.message.content) {
          tcOutputParts.push(result.message.content);
        }
        break; // 成功则退出重试循环
      } catch (e) {
        // 用户注入消息 → 中止当前请求，注入用户消息后重试（最高优先级）
        if (e.name === "UserAbortError" && pauseState.userInjecting && !pauseState.aborted) {
          var injectedMsg = pauseState.consumeUserMessage();
          if (injectedMsg) {
            tcMessages.push({ role: "assistant", content: result ? (result.message.content || "") : "" });
            tcMessages.push({ role: "user", content: "📋 用户补充指令：" + injectedMsg + "\n请立即根据以上指令调整你的输出。" });
          }
          streamAppend("info", "💡 用户消息已注入（最高优先级），重新发起请求...\n");
          setStatus("AI 生成测试用例中...");
          continue;
        }
        // 用户暂停 → 等待恢复后重试本轮
        if (e.name === "UserAbortError" && pauseState.paused && !pauseState.aborted) {
          streamAppend("info", "⏸️ 已暂停，点击「继续」恢复执行");
          setStatus("已暂停");
          await pauseState.waitForResume();
          if (pauseState.aborted) throw e;
          streamAppend("info", "▶️ 继续执行");
          setStatus("AI 生成测试用例中...");
          continue; // 重新发起请求
        }
        // 推理时间过长：保留已生成内容并暂停，等待继续按钮或用户补充指令。
        // 不能把截断响应当作最终结果，否则 finally 会结束 testcases 阶段，
        // 后续输入无法再找到活动的 currentPhase。
        if (e.name === "ReasoningTimeoutError" && !pauseState.aborted) {
          var partialContent = e.partialContent || "";
          if (partialContent) {
            tcOutputParts.push(partialContent);
            tcMessages.push({ role: "assistant", content: partialContent });
          }
          tcMessages.push({
            role: "user",
            content: "上一次响应因推理时间过长被截断。请从已完成的位置继续生成剩余测试用例，" +
              "不要重复已经输出的用例；只输出尚未完成的 CSV 用例行。",
          });
          pauseState.paused = true;
          els.abortBtn.textContent = "停止";
          els.continueBtn.disabled = false;
          streamAppend("warning", "⏸️ AI 推理时间过长，已暂停测试用例生成，点击「继续」或输入消息恢复");
          setStatus("已暂停，等待继续生成测试用例");
          await pauseState.waitForResume();
          if (pauseState.aborted) throw e;
          var timeoutInjectedMsg = pauseState.consumeUserMessage();
          if (timeoutInjectedMsg) {
            tcMessages.push({
              role: "user",
              content: "📋 用户补充指令：" + timeoutInjectedMsg + "\n请结合当前已生成内容继续输出剩余测试用例。",
            });
          }
          pauseState.paused = false;
          streamAppend("info", "▶️ 继续生成测试用例");
          setStatus("AI 生成测试用例中...");
          continue;
        }
        if (e.name === "ReasoningLoopError" && tcRetryCount < MAX_TC_RETRY) {
          tcRetryCount++;
          streamAppend("warning", "⚠️ 检测到推理死循环，注入干预后重试（第 " + tcRetryCount + "/" + MAX_TC_RETRY + " 次）...\n");
          log("测试用例生成: 推理死循环（第 " + tcRetryCount + " 次），注入干预后重试");
          streamEndBlock();
          // 注入干预提示词，引导 AI 直接输出
          tcMessages.push({
            role: "user",
            content: "🚨 推理重复循环！请立即停止反复分析，直接输出测试用例列表。\n" +
              "不要在思考中反复推导，直接按照 CSV 格式输出用例：\n" +
              "TC编号,用例标题,测试页面,前置条件,操作步骤,预期结果\n" +
              "含逗号/引号的字段用双引号包裹，字段内双引号用两个双引号转义。\n" +
              "只输出用例列表，不要输出其他内容！",
          });
          streamAppend("info", "重试中...\n");
          continue;
        }
        throw e; // 其他错误或超过重试次数则抛出
      }
    }

    streamEndBlock();

    var rawText = tcOutputParts.join("\n").trim();
    var text = normalizeTestCasesForCapabilities(rawText, config.visionSupported);
    if (text !== rawText) {
      log("已将非视觉模型输出中的视觉验证步骤改为 DOM 状态验证");
      streamAppend("info", "已自动替换不支持的视觉验证步骤为 DOM 状态验证。\n");
    }
    els.testCases.value = text;
    els.exportTestCasesBtn.disabled = !text.trim();
    log("测试用例已生成");
    setStatus("测试用例已生成");

    await saveConfig();

  } catch (e) {
    if (e.name === "UserAbortError" || isPhaseAborted()) {
      log("测试用例生成已被用户中止");
      setStatus("已中止");
      streamAppend("warning", "⚠️ 测试用例生成已被用户中止");
    } else if (e.name === "ReasoningLoopError") {
      log("测试用例生成失败：AI 推理连续陷入死循环");
      setStatus("生成失败：推理死循环");
      streamAppend("warning", "⛔ AI 推理连续陷入死循环，已停止。建议简化需求或检查模型配置后重试。");
    } else {
      log("生成测试用例失败: " + (e.message || e));
      setStatus("生成失败");
    }
  } finally {
    streamEndBlock();
    els.genTestCasesBtn.disabled = false;
    els.genTestCasesBtn.textContent = "AI 生成（基于需求+架构）";
    endPhase();
  }
}

// ---- 上传源码 ----
var uploadedSourceFiles = {};
var SUPPORTED_SOURCE_FILE = /\.(?:js|vue|ts|jsx|tsx|css|json)$/i;
var MAX_SOURCE_FILE_BYTES = 512 * 1024;

function readSourceFile(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    var blob = file.size > MAX_SOURCE_FILE_BYTES ? file.slice(0, MAX_SOURCE_FILE_BYTES) : file;
    reader.onload = function(event) {
      var content = String(event.target.result || "");
      if (content.length > 8000) content = content.substring(0, 8000) + "\n// ... [内容已截断]";
      if (file.size > MAX_SOURCE_FILE_BYTES) content += "\n// ... [文件超过 " + MAX_SOURCE_FILE_BYTES + " 字节，仅读取开头]";
      resolve(content);
    };
    reader.onerror = function() { reject(reader.error || new Error("文件读取失败")); };
    reader.readAsText(blob);
  });
}

async function resetArchitectureForSourceChange() {
  archAnalysis = null;
  els.archCacheInfo.textContent = "源码已更新，等待重新分析";
  els.archCacheInfo.style.color = "#d97706";
  els.archResult.innerHTML = '<div class="arch-empty">源码已更新。请重新执行架构分析，避免使用旧项目的上下文。</div>';
  els.exportArchBtn.disabled = true;
  try {
    await AIFT_ProjectAnalyzer.clearCache();
  } catch (error) {
    log("旧架构缓存清除失败: " + (error.message || error));
  }
}

async function handleSourceUpload(event) {
  var files = event.target.files;
  if (!files || files.length === 0) return;
  if (currentPhase) {
    log("当前任务运行中，已阻止替换源码上下文");
    setStatus("运行中不能更换源码");
    event.target.value = "";
    return;
  }

  var nextSourceFiles = {};
  var candidates = [];
  var skipped = 0;

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    // 使用相对路径（webkitRelativePath）作为 key，去掉顶层目录名
    var relPath = file.webkitRelativePath || file.name;
    var firstSlash = relPath.indexOf("/");
    if (firstSlash !== -1) {
      relPath = relPath.substring(firstSlash + 1);
    }
    // 目录选择器会返回图片、锁文件等所有子文件；只接收可分析的文本源码。
    if (relPath.indexOf("node_modules/") !== -1 || !SUPPORTED_SOURCE_FILE.test(relPath)) {
      skipped++;
      continue;
    }
    candidates.push({ path: relPath, file: file });
  }

  if (candidates.length === 0) {
    els.sourceUploadInfo.textContent = "未找到可分析的源码文件，保留当前源码";
    els.sourceUploadInfo.style.color = "#e74c3c";
    event.target.value = "";
    return;
  }

  els.sourceUploadInfo.style.color = "#4e5969";
  var failed = 0;
  for (var ci = 0; ci < candidates.length; ci++) {
    els.sourceUploadInfo.textContent = "正在读取源码 " + (ci + 1) + "/" + candidates.length;
    try {
      nextSourceFiles[candidates[ci].path] = await readSourceFile(candidates[ci].file);
    } catch (error) {
      failed++;
      log("源码读取失败: " + candidates[ci].path + " - " + (error.message || error));
    }
  }

  var count = Object.keys(nextSourceFiles).length;
  if (count === 0) {
    els.sourceUploadInfo.textContent = "源码读取失败，保留当前源码";
    els.sourceUploadInfo.style.color = "#e74c3c";
    event.target.value = "";
    return;
  }

  uploadedSourceFiles = nextSourceFiles;
  await resetArchitectureForSourceChange();
  if (window.AIFT_SourceReader) AIFT_SourceReader.setSourceFiles(uploadedSourceFiles);
  var detail = "已加载 " + count + " 个文件";
  if (skipped > 0) detail += "，跳过 " + skipped + " 个非源码文件";
  if (failed > 0) detail += "，" + failed + " 个读取失败";
  els.sourceUploadInfo.textContent = detail;
  els.sourceUploadInfo.style.color = "#0a7c3e";
  log("源码上传完成: " + detail + "；旧架构分析已失效");
  event.target.value = "";
  updateButtonStates();
}

// ---- 事件绑定 ----
els.saveConfig.addEventListener("click", saveConfig);
els.runAgentBtn.addEventListener("click", runAgent);
els.planBtn.addEventListener("click", runPlan);
els.abortBtn.addEventListener("click", abortAgent);
els.continueBtn.addEventListener("click", continueAgent);
els.chatSendBtn.addEventListener("click", sendChatMessage);
els.chatInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") sendChatMessage();
});
els.genTestCasesBtn.addEventListener("click", generateTestCases);
els.sourceUpload.addEventListener("change", handleSourceUpload);
els.analyzeBtn.addEventListener("click", analyzeArchitecture);
bindSectionToggle(els.archSectionToggle, els.archResult);
bindSectionToggle(els.testCasesSectionToggle, els.testCasesContent);
els.importArchBtn.addEventListener("click", function () { els.archFileInput.click(); });
els.archFileInput.addEventListener("change", handleArchFileImport);
els.clearCacheBtn.addEventListener("click", clearArchCache);
els.exportArchBtn.addEventListener("click", exportArchitecture);
els.exportTestCasesBtn.addEventListener("click", exportTestCases);
els.exportTestReportBtn.addEventListener("click", function () { exportTestReport(); });
els.clearRunHistoryBtn.addEventListener("click", clearRunHistory);
els.runHistoryList.addEventListener("click", function(event) {
  var viewButton = event.target.closest("[data-report-view]");
  if (viewButton) {
    showStoredReport(Number(viewButton.getAttribute("data-report-view")));
    return;
  }
  var exportButton = event.target.closest("[data-report-export]");
  if (exportButton) exportTestReport(runHistory[Number(exportButton.getAttribute("data-report-export"))]);
});
els.exportErrorsBtn.addEventListener("click", exportErrorRecords);
els.clearErrorsBtn.addEventListener("click", clearErrorRecords);
els.errorRecordList.addEventListener("click", function(event) {
  var button = event.target.closest("[data-error-index]");
  if (!button) return;
  showErrorDetail(Number(button.getAttribute("data-error-index")));
});
els.errorDetailClose.addEventListener("click", closeErrorDetail);
els.errorDetailModal.addEventListener("click", function(event) {
  if (event.target === els.errorDetailModal) closeErrorDetail();
});
els.testCases.addEventListener("input", function () {
  els.exportTestCasesBtn.disabled = !els.testCases.value.trim();
  updateButtonStates();
});
document.getElementById("promptModalConfirm").addEventListener("click", confirmPromptDialog);
document.getElementById("promptModalCancel").addEventListener("click", cancelPromptDialog);
document.getElementById("promptModalInput").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) confirmPromptDialog();
  if (e.key === "Escape") cancelPromptDialog();
});
els.exportModalCancel.addEventListener("click", cancelExportDialog);

// ---- 测试结果折叠/展开事件委托 ----
els.resultArea.addEventListener("click", function (e) {
  // 一键折叠/展开（实时结果）
  var toggleAllBtn = e.target.closest("[data-action='toggle-all-rt']");
  if (toggleAllBtn) {
    var cases = testCasesState;
    var allExpanded = cases.every(function (tc) {
      return expandedCases.has(tc.id || tc.title || tc.text);
    });
    if (allExpanded) {
      expandedCases.clear();
    } else {
      cases.forEach(function (tc) {
        expandedCases.add(tc.id || tc.title || tc.text);
      });
    }
    renderTestResults(testCasesState, currentAssertions);
    return;
  }

  // 一键折叠/展开（测试报告）
  var toggleAllReportBtn = e.target.closest("[data-action='toggle-all-report']");
  if (toggleAllReportBtn) {
    var reportCases = testCasesState;
    var allReportExpanded = reportCases.every(function (tc) {
      return expandedReportCases.has(tc.id || tc.title || tc.text);
    });
    if (allReportExpanded) {
      expandedReportCases.clear();
    } else {
      reportCases.forEach(function (tc) {
        expandedReportCases.add(tc.id || tc.title || tc.text);
      });
    }
    els.resultArea.innerHTML = renderTestReport(lastReportResult, lastReportSummary, testCasesState, currentAssertions);
    return;
  }

  var toggleReportExtraBtn = e.target.closest("[data-action='toggle-report-extra']");
  if (toggleReportExtraBtn) {
    reportExtraExpanded = !reportExtraExpanded;
    els.resultArea.innerHTML = renderTestReport(lastReportResult, lastReportSummary, testCasesState, currentAssertions);
    return;
  }

  // 单条用例折叠/展开
  var caseEl = e.target.closest("[data-tc-key]");
  if (caseEl) {
    var key = caseEl.getAttribute("data-tc-key");
    // 判断是实时结果还是报告
    var isReport = caseEl.classList.contains("report-case");
    var set = isReport ? expandedReportCases : expandedCases;
    if (set.has(key)) {
      set.delete(key);
    } else {
      set.add(key);
    }
    if (isReport) {
      els.resultArea.innerHTML = renderTestReport(lastReportResult, lastReportSummary, testCasesState, currentAssertions);
    } else {
      renderTestResults(testCasesState, currentAssertions);
    }
    return;
  }
});

loadConfig();
loadRunHistory().catch(function () {});
log("Side Panel 已就绪（Side Panel + CDP 架构），请选择目标标签页");

// 建立 port 连接，Service Worker 在断开时清理 debugger
var _cleanupPort = chrome.runtime.connect({ name: "sidepanel" });
window.addEventListener("beforeunload", function () {
  if (window.AIFT_VisualController && AIFT_VisualController.isAttached()) {
    AIFT_VisualController.detach();
  }
  if (window.AIFT_NetworkRecorder) {
    AIFT_NetworkRecorder.stop();
  }
  try { _cleanupPort.disconnect(); } catch (e) {}
});
