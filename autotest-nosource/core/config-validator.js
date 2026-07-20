// config-validator.js
// API 端点与模型配置的纯校验，供 Side Panel 在保存和执行前复用。

(function (global) {
  "use strict";

  function isLocalHost(hostname) {
    var host = String(hostname || "").toLowerCase();
    return host === "localhost" || host === "::1" || host === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(host) || /^0\.0\.0\.0$/.test(host);
  }

  function validateApiEndpoint(value) {
    var raw = String(value || "").trim();
    if (!raw) return { ok: false, error: "请填写 API URL" };
    var url;
    try {
      url = new URL(raw);
    } catch (e) {
      return { ok: false, error: "API URL 格式无效，需包含 http:// 或 https://" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, error: "API URL 仅支持 http:// 或 https://" };
    }
    if (url.username || url.password) {
      return { ok: false, error: "API URL 不应包含用户名或密码，请使用 API Key 字段" };
    }
    if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
      return {
        ok: true,
        warning: "当前 API URL 使用非加密 HTTP，API Key 可能在传输中泄露；生产服务建议改用 HTTPS",
      };
    }
    return { ok: true };
  }

  function validateAiConfig(config, requireComplete) {
    config = config || {};
    if (requireComplete && (!config.apiUrl || !config.apiKey || !config.model)) {
      return { ok: false, error: "请先填写 AI 配置（API URL / Key / 模型）" };
    }
    if (!config.apiUrl) return { ok: true };
    return validateApiEndpoint(config.apiUrl);
  }

  global.AIFT_ConfigValidator = {
    validateApiEndpoint: validateApiEndpoint,
    validateAiConfig: validateAiConfig,
  };
})(window);
