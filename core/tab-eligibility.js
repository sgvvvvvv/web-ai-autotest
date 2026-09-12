// tab-eligibility.js
// 判断目标标签页是否属于扩展可观察和可测试的网页上下文。

(function (global) {
  "use strict";

  function evaluate(url) {
    var value = String(url || "");
    if (/^https?:\/\//i.test(value)) return { ok: true };
    if (/^file:\/\//i.test(value)) {
      return { ok: true, warning: "file 页面需要在扩展详情中启用“允许访问文件网址”" };
    }
    return { ok: false, error: "仅支持 http(s) 网页；Chrome 内部页、扩展页和空白页不能注入测试观察器" };
  }

  global.AIFT_TabEligibility = { evaluate: evaluate };
})(window);
