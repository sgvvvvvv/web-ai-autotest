// test-summary-cache.js
// 测试上下文摘要缓存：每个用例完成后生成摘要，下一个用例开始前读取
// 缓存在 chrome.storage.local，finish 时清空

(function (global) {
  "use strict";

  var STORAGE_KEY = "aift_test_summary";

  /**
   * 读取缓存的摘要
   * @returns {Promise<string>} 摘要文本，无缓存返回 ""
   */
  async function read() {
    try {
      var data = await chrome.storage.local.get(STORAGE_KEY);
      return data[STORAGE_KEY] || "";
    } catch (e) {
      console.warn("[AIFT-Summary] 读取摘要失败:", e);
      return "";
    }
  }

  /**
   * 写入摘要
   * @param {string} summary - 摘要文本
   */
  async function write(summary) {
    try {
      var obj = {};
      obj[STORAGE_KEY] = summary;
      await chrome.storage.local.set(obj);
    } catch (e) {
      console.warn("[AIFT-Summary] 写入摘要失败:", e);
    }
  }

  /**
   * 清空摘要缓存
   */
  async function clear() {
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
    } catch (e) {
      console.warn("[AIFT-Summary] 清空摘要失败:", e);
    }
  }

  /**
   * 构建摘要 prompt（注入到每个用例的初始消息中）
   * @param {string} summary - 摘要文本
   * @returns {string} 格式化后的摘要段落，无摘要返回 ""
   */
  function formatForPrompt(summary) {
    if (!summary || summary.trim().length === 0) return "";
    return [
      "## 上下文摘要（来自之前用例的执行状态）",
      "以下是之前用例执行后的页面状态和已完成的内容，请基于此状态继续当前用例的测试：",
      "",
      summary,
      "",
    ].join("\n");
  }

  global.AIFT_SummaryCache = {
    read: read,
    write: write,
    clear: clear,
    formatForPrompt: formatForPrompt,
  };
})(window);
