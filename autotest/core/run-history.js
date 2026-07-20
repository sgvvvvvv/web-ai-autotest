// run-history.js
// 已完成测试报告的有限本地历史，防止报告无限增长。

(function (global) {
  "use strict";

  function byteSize(value) {
    var text;
    try {
      text = JSON.stringify(value);
    } catch (e) {
      return Infinity;
    }
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
    return text.length * 2;
  }

  function trim(reports, options) {
    options = options || {};
    var maxReports = options.maxReports || 20;
    var maxBytes = options.maxBytes || 1024 * 1024;
    var retained = (reports || []).slice(-maxReports);
    while (retained.length > 1 && byteSize(retained) > maxBytes) retained.shift();
    return retained;
  }

  global.AIFT_RunHistory = { trim: trim };
})(window);
