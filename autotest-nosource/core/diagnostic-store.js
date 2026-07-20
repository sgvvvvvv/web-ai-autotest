// diagnostic-store.js
// 错误诊断在本地持久化前的容量控制；保留最近记录的可调查性。

(function (global) {
  "use strict";

  function shorten(value, limit) {
    var text = String(value == null ? "" : value);
    return text.length > limit ? text.substring(0, limit) + "...[已截断]" : text;
  }

  function compactSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return snapshot || null;
    var copy = Object.assign({}, snapshot);
    copy.pageText = shorten(copy.pageText, 500);
    if (Array.isArray(copy.nodes)) copy.nodes = copy.nodes.slice(0, 10);
    return copy;
  }

  function compactTrace(trace) {
    return (trace || []).slice(-8).map(function(entry) {
      if (!entry || typeof entry !== "object") return shorten(entry, 400);
      var copy = Object.assign({}, entry);
      if (copy.reasoning) copy.reasoning = shorten(copy.reasoning, 800);
      if (copy.result) copy.result = shorten(copy.result, 800);
      if (copy.error) copy.error = shorten(copy.error, 800);
      if (copy.toolCalls && Array.isArray(copy.toolCalls)) copy.toolCalls = copy.toolCalls.slice(0, 3);
      return copy;
    });
  }

  function compactRecord(record) {
    var copy = Object.assign({}, record || {});
    copy.reasoning = shorten(copy.reasoning, 1600);
    copy.recentTrace = compactTrace(copy.recentTrace);
    copy.domSnapshot = compactSnapshot(copy.domSnapshot);
    copy.previousDomSnapshot = compactSnapshot(copy.previousDomSnapshot);
    copy.diagnosticTruncated = true;
    return copy;
  }

  function minimalRecord(record) {
    record = record || {};
    return {
      id: record.id || "",
      timestamp: record.timestamp || "",
      category: record.category || "",
      round: record.round || 0,
      testCaseId: record.testCaseId || "",
      message: shorten(record.message || record.description || record.reason, 160),
      reasoning: shorten(record.reasoning, 160),
      sourceInteractions: (record.sourceInteractions || []).slice(0, 5).map(function(item) {
        return {
          kind: shorten(item && item.kind, 80),
          triggerSelector: shorten(item && item.triggerSelector, 120),
          source: shorten(item && item.source, 80),
        };
      }),
      diagnosticTruncated: true,
    };
  }

  function serializedBytes(value) {
    var text;
    try {
      text = JSON.stringify(value);
    } catch (e) {
      return Infinity;
    }
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
    return text.length * 2;
  }

  function trimForStorage(records, options) {
    options = options || {};
    var maxRecords = options.maxRecords || 100;
    var maxBytes = options.maxBytes || 2 * 1024 * 1024;
    var retained = (records || []).slice(-maxRecords);
    while (retained.length > 1 && serializedBytes(retained) > maxBytes) retained.shift();
    if (retained.length === 1 && serializedBytes(retained) > maxBytes) retained[0] = compactRecord(retained[0]);
    if (retained.length === 1 && serializedBytes(retained) > maxBytes) retained[0] = minimalRecord(retained[0]);
    return retained;
  }

  global.AIFT_DiagnosticStore = {
    trimForStorage: trimForStorage,
    compactRecord: compactRecord,
  };
})(window);
