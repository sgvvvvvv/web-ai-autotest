// network-recorder.js
// 通过 chrome.debugger + CDP Network 域捕获网络请求与响应
// 在 Side Panel 上下文中运行（sidepanel.js 通过 <script> 引入）
//
// 核心能力：
// 1. 通过 CDP Network 域监听页面发出的 XHR/fetch 请求
// 2. 记录 URL、method、status、请求体、响应体
// 3. 提供 searchResponses() 供 AI 按关键词检索已捕获的响应
// 4. 支持 start/stop/clear 控制
//
// 注意：需要先 chrome.debugger.attach 后才能使用 CDP 命令
// 与 VisualController 共享 debugger 连接

(function (global) {
  "use strict";

  var MAX_RESPONSE_CHARS = 20000;
  var HEARTBEAT_INTERVAL_MS = 5000;

  var state = {
    recording: false,
    entries: [],
    nextId: 1,
    tabId: null,
    pendingRequests: {}, // requestId -> 已按请求发起顺序写入的记录
    eventListener: null,
    heartbeatTimer: null,
    lastHeartbeatAt: 0,
    heartbeatFailures: 0,
    recovering: false,
  };

  function isFetchOrXhr(resourceType) {
    return resourceType === "XHR" || resourceType === "Fetch";
  }

  function addEntry(record) {
    state.entries.push(record);
  }

  /**
   * 处理 CDP 事件
   */
  function handleCdpEvent(source, method, params) {
    if (!state.recording) return;
    if (state.tabId && source && source.tabId !== state.tabId) return;

    if (method === "Network.requestWillBeSent") {
      var req = params.request || {};
      var url = req.url || "";
      var reqMethod = req.method || "GET";
      var postData = req.postData || null;
      var headers = req.headers || {};
      var resourceType = params.type || "";
      if (!isFetchOrXhr(resourceType)) return;

      // 在 requestWillBeSent 时即写入。响应延迟、失败或一直 pending 的请求也不会丢失。
      var record = {
        id: state.nextId++,
        timestamp: Date.now(),
        url: url,
        method: reqMethod,
        resourceType: resourceType,
        status: 0,
        statusText: "",
        mimeType: "",
        postData: postData,
        requestHeaders: headers,
        requestBody: postData,
        responseBody: null,
        responseHeaders: {},
        completed: false,
        failed: false,
      };
      addEntry(record);
      state.pendingRequests[params.requestId] = record;
    } else if (method === "Network.responseReceived") {
      var pending = state.pendingRequests[params.requestId];
      if (!pending) return;

      var resp = params.response || {};
      pending.status = resp.status || 0;
      pending.statusText = resp.statusText || "";
      pending.mimeType = (resp.mimeType || "");
      pending.rawResponseHeaders = resp.headers || {};
    } else if (method === "Network.loadingFinished") {
      var finished = state.pendingRequests[params.requestId];
      if (!finished) return;
      finished.completed = true;
      finished.completedAt = Date.now();

      // 提取关键响应头
      var respHeaders = finished.rawResponseHeaders || {};
      for (var hname in respHeaders) {
        var lower = hname.toLowerCase();
        if (lower === "content-type" || lower === "content-length" || lower === "cache-control") {
          finished.responseHeaders[hname] = respHeaders[hname];
        }
      }

      delete state.pendingRequests[params.requestId];

      // 异步获取响应体
      fetchResponseBody(params.requestId, finished);
    } else if (method === "Network.loadingFailed") {
      var failed = state.pendingRequests[params.requestId];
      if (failed) {
        failed.failed = true;
        failed.completed = true;
        failed.completedAt = Date.now();
        failed.errorText = params.errorText || "网络请求失败";
      }
      delete state.pendingRequests[params.requestId];
    }
  }

  function installEventListener() {
    if (state.eventListener) chrome.debugger.onEvent.removeListener(state.eventListener);
    state.eventListener = function (source, method, params) {
      handleCdpEvent(source, method, params);
    };
    chrome.debugger.onEvent.addListener(state.eventListener);
  }

  async function enableNetwork(tabId) {
    if (global.AIFT_VisualController && global.AIFT_VisualController.ensureAttached) {
      await global.AIFT_VisualController.ensureAttached(tabId);
      await global.AIFT_VisualController.sendCommand("Network.enable", {});
      await global.AIFT_VisualController.sendCommand("Network.setCacheDisabled", { cacheDisabled: true });
      return;
    }
    await new Promise(function (resolve, reject) {
      chrome.debugger.attach({ tabId: tabId }, "1.3", function () {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "debugger attach 失败"));
          return;
        }
        chrome.debugger.sendCommand({ tabId: tabId }, "Network.enable", {}, function () {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
    });
  }

  async function heartbeat() {
    if (!state.recording || !state.tabId || state.recovering) return;
    state.lastHeartbeatAt = Date.now();
    try {
      if (global.AIFT_VisualController && global.AIFT_VisualController.sendCommand) {
        await global.AIFT_VisualController.sendCommand("Network.getCookies", {});
      }
      state.heartbeatFailures = 0;
    } catch (e) {
      state.heartbeatFailures++;
      state.recovering = true;
      try {
        if (global.AIFT_VisualController && global.AIFT_VisualController.detach) {
          await global.AIFT_VisualController.detach();
        }
        installEventListener();
        await enableNetwork(state.tabId);
        state.heartbeatFailures = 0;
      } catch (recoverError) {
        console.warn("[AIFT-Network] 心跳重连失败:", recoverError.message || recoverError);
      } finally {
        state.recovering = false;
      }
    }
  }

  function startHeartbeat() {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = setInterval(function() { heartbeat(); }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 通过 CDP 获取响应体
   */
  function fetchResponseBody(requestId, record) {
    if (!state.tabId) return;
    var onResult = function (result) {
      if (result && result.body) {
        if (result.body.length > MAX_RESPONSE_CHARS) {
          record.responseBody = result.body.substring(0, MAX_RESPONSE_CHARS) + "\n…（已截断，原始长度 " + result.body.length + "）";
        } else {
          record.responseBody = result.body;
        }
      } else {
        record.responseBody = "";
      }
    };
    if (global.AIFT_VisualController && global.AIFT_VisualController.sendCommand) {
      global.AIFT_VisualController.sendCommand("Network.getResponseBody", { requestId: requestId })
        .then(onResult)
        .catch(function () { record.responseBody = ""; });
      return;
    }
    try {
      chrome.debugger.sendCommand({ tabId: state.tabId }, "Network.getResponseBody", { requestId: requestId }, function (result) {
        if (chrome.runtime.lastError) {
          record.responseBody = "";
          return;
        }
        onResult(result);
      });
    } catch (e) {
      record.responseBody = "";
    }
  }

  /**
   * 开始录制网络请求
   * @param {number} tabId - 目标标签页 ID
   */
  async function start(tabId) {
    if (state.recording) {
      if (state.tabId === tabId) return true;
      // 切换到新 tab，先停止
      stop();
    }
    state.tabId = tabId;
    state.recording = true;

    try {
      // 先订阅再启用 Network 域，避免 Network.enable 与订阅之间漏掉首个请求。
      installEventListener();
      await enableNetwork(tabId);
      startHeartbeat();
      return true;
    } catch (e) {
      console.warn("[AIFT-Network] debugger/Network.enable 失败:", e.message || e);
      state.recording = false;
      return false;
    }
  }

  /**
   * 停止录制
   * 禁用 Network 域，并在 VisualController 未使用时分离 debugger
   */
  function stop() {
    state.recording = false;
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
    state.recovering = false;
    if (state.eventListener) {
      chrome.debugger.onEvent.removeListener(state.eventListener);
      state.eventListener = null;
    }
    if (state.tabId) {
      // 禁用 Network 域
      var tabId = state.tabId;
      if (global.AIFT_VisualController && global.AIFT_VisualController.sendCommand) {
        global.AIFT_VisualController.sendCommand("Network.disable", {}).catch(function () {});
      } else {
        chrome.debugger.sendCommand({ tabId: tabId }, "Network.disable", {}, function () {
          chrome.debugger.detach({ tabId: tabId }, function () {});
        });
      }
    }
    state.pendingRequests = {};
  }

  /**
   * 清空已捕获的记录
   */
  function clear() {
    state.entries = [];
    state.nextId = 1;
    state.pendingRequests = {};
  }

  /**
   * 按关键词检索网络响应
   */
  function searchResponses(options) {
    options = options || {};
    var limit = options.limit || 10;
    var urlPattern = (options.urlPattern || "").toLowerCase();
    var keyword = (options.keyword || "").toLowerCase();
    var method = (options.method || "").toUpperCase();
    var status = options.status;

    var results = [];
    for (var i = state.entries.length - 1; i >= 0; i--) {
      var entry = state.entries[i];

      if (urlPattern && entry.url.toLowerCase().indexOf(urlPattern) === -1) continue;
      if (method && entry.method.toUpperCase() !== method) continue;
      if (status && entry.status !== status) continue;
      if (keyword) {
        var body = (entry.responseBody || "").toLowerCase();
        if (body.indexOf(keyword) === -1) continue;
      }

      results.push({
        id: entry.id,
        timestamp: entry.timestamp,
        url: entry.url,
        method: entry.method,
        resourceType: entry.resourceType,
        status: entry.status,
        statusText: entry.statusText,
        mimeType: entry.mimeType,
        requestBody: entry.requestBody,
        responseBody: entry.responseBody || "（响应体尚未获取或为空）",
        responseHeaders: entry.responseHeaders,
        completed: entry.completed,
        failed: entry.failed,
        errorText: entry.errorText || "",
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * 获取所有已捕获的记录摘要（不含响应体，减少体积）
   */
  function getSummary() {
    var results = [];
    for (var i = state.entries.length - 1; i >= 0; i--) {
      var entry = state.entries[i];
      results.push({
        id: entry.id,
        timestamp: entry.timestamp,
        url: entry.url,
        method: entry.method,
        resourceType: entry.resourceType,
        status: entry.status,
        mimeType: entry.mimeType,
        hasBody: !!entry.responseBody,
        completed: entry.completed,
        failed: entry.failed,
      });
    }
    return results;
  }

  /**
   * 获取单条记录的完整响应体
   */
  function getResponseById(id) {
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].id === id) {
        var e = state.entries[i];
        return {
          id: e.id,
          url: e.url,
          method: e.method,
          status: e.status,
          requestBody: e.requestBody,
          responseBody: e.responseBody || "（响应体尚未获取或为空）",
        };
      }
    }
    return null;
  }

  /**
   * 获取当前状态
   */
  function getStatus() {
    return {
      recording: state.recording,
      totalEntries: state.entries.length,
      pendingRequests: Object.keys(state.pendingRequests).length,
      lastHeartbeatAt: state.lastHeartbeatAt,
      heartbeatFailures: state.heartbeatFailures,
    };
  }

  global.AIFT_NetworkRecorder = {
    start: start,
    stop: stop,
    clear: clear,
    searchResponses: searchResponses,
    getSummary: getSummary,
    getResponseById: getResponseById,
    getStatus: getStatus,
  };
})(window);
