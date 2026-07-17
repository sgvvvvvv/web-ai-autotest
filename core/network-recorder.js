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

  var MAX_ENTRIES = 100;
  var MAX_RESPONSE_CHARS = 20000;

  var state = {
    recording: false,
    entries: [],
    nextId: 1,
    tabId: null,
    pendingRequests: {}, // requestId -> { url, method, headers, postData }
    eventListener: null,
  };

  /**
   * 判断是否为值得捕获的 API 请求（排除静态资源）
   */
  function isApiRequest(url, method, mimeType, resourceType) {
    var skipExts = [".js", ".mjs", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".map", ".html", ".htm"];
    var pathPart = url.split("?")[0].split("#")[0];
    for (var i = 0; i < skipExts.length; i++) {
      if (pathPart.toLowerCase().endsWith(skipExts[i])) return false;
    }

    if (resourceType) {
      if (resourceType === "XHR" || resourceType === "Fetch") return true;
      if (resourceType === "Script" || resourceType === "Stylesheet" || resourceType === "Image" || resourceType === "Font" || resourceType === "Media") return false;
      if (resourceType === "Document") return false;
    }

    if (mimeType) {
      var mt = mimeType.toLowerCase();
      if (mt.indexOf("json") !== -1) return true;
      if (mt.indexOf("text") !== -1 && mt.indexOf("javascript") === -1) return true;
      if (mt.indexOf("javascript") !== -1) return false;
      if (mt.indexOf("css") !== -1) return false;
      if (mt.indexOf("image") !== -1) return false;
      if (mt.indexOf("font") !== -1) return false;
    }

    if (/\/api\/|\/graphql|\/rest\/|\/v\d+\/|gateway|service|\/backend\//i.test(url)) return true;

    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") return true;

    return false;
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

      // 资源类型过滤
      var resourceType = params.type || "";
      if (!isApiRequest(url, reqMethod, "", resourceType)) return;

      state.pendingRequests[params.requestId] = {
        url: url,
        method: reqMethod,
        postData: postData,
        requestHeaders: headers,
        timestamp: params.timestamp || Date.now() / 1000,
      };
    } else if (method === "Network.responseReceived") {
      var pending = state.pendingRequests[params.requestId];
      if (!pending) return;

      var resp = params.response || {};
      pending.status = resp.status || 0;
      pending.statusText = resp.statusText || "";
      pending.mimeType = (resp.mimeType || "");
      pending.responseHeaders = resp.headers || {};

      // 再次用 mimeType 过滤
      if (!isApiRequest(pending.url, pending.method, pending.mimeType, params.type || pending.resourceType)) {
        delete state.pendingRequests[params.requestId];
        return;
      }
    } else if (method === "Network.loadingFinished") {
      var finished = state.pendingRequests[params.requestId];
      if (!finished) return;

      // 创建记录
      var record = {
        id: state.nextId++,
        timestamp: Date.now(),
        url: finished.url,
        method: finished.method,
        status: finished.status || 0,
        statusText: finished.statusText || "",
        mimeType: finished.mimeType || "",
        requestBody: finished.postData,
        responseBody: null, // 异步获取
        responseHeaders: {},
      };

      // 提取关键响应头
      var respHeaders = finished.responseHeaders || {};
      for (var hname in respHeaders) {
        var lower = hname.toLowerCase();
        if (lower === "content-type" || lower === "content-length" || lower === "cache-control") {
          record.responseHeaders[hname] = respHeaders[hname];
        }
      }

      state.entries.push(record);
      if (state.entries.length > MAX_ENTRIES) {
        state.entries.shift();
      }

      delete state.pendingRequests[params.requestId];

      // 异步获取响应体
      fetchResponseBody(params.requestId, record);
    } else if (method === "Network.loadingFailed") {
      delete state.pendingRequests[params.requestId];
    }
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
      if (global.AIFT_VisualController && global.AIFT_VisualController.ensureAttached) {
        await global.AIFT_VisualController.ensureAttached(tabId);
        await global.AIFT_VisualController.sendCommand("Network.enable", {});
      } else {
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
      if (state.eventListener) chrome.debugger.onEvent.removeListener(state.eventListener);
      state.eventListener = function (source, method, params) {
        handleCdpEvent(source, method, params);
      };
      chrome.debugger.onEvent.addListener(state.eventListener);
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
        status: entry.status,
        statusText: entry.statusText,
        mimeType: entry.mimeType,
        requestBody: entry.requestBody,
        responseBody: entry.responseBody || "（响应体尚未获取或为空）",
        responseHeaders: entry.responseHeaders,
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
        status: entry.status,
        mimeType: entry.mimeType,
        hasBody: !!entry.responseBody,
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
