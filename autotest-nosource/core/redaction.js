// redaction.js
// 导出诊断与错误轨迹时的最小敏感信息脱敏工具。

(function (global) {
  "use strict";

  var SENSITIVE_KEY = /password|passwd|token|secret|authorization|cookie|api[_-]?key|access[_-]?key/i;

  function redactText(value) {
    return String(value == null ? "" : value)
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
      .replace(/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]")
      .replace(/([?&](?:password|passwd|token|secret|api[_-]?key|access[_-]?key|access[_-]?token|signature)=)[^&#\s]+/gi, "$1[REDACTED]")
      .replace(/(password|passwd|token|secret|api[_-]?key|access[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;"']+/gi, "$1=[REDACTED]");
  }

  function redact(value, keyHint, depth) {
    depth = depth || 0;
    if (depth > 8) return "[TRUNCATED]";
    if (SENSITIVE_KEY.test(String(keyHint || ""))) return "[REDACTED]";
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(function(item) { return redact(item, "", depth + 1); });
    if (value && typeof value === "object") {
      var result = {};
      Object.keys(value).forEach(function(key) { result[key] = redact(value[key], key, depth + 1); });
      return result;
    }
    return value;
  }

  global.AIFT_Redaction = { redact: redact, redactText: redactText };
})(window);
