// source-reader.js
// 源码读取模块：仅支持用户手动上传的源码文件
// 在 Side Panel 上下文中运行（sidepanel.js 通过 <script> 引入）

(function (global) {
  "use strict";

  var MAX_FILE_CONTENT = 8000; // 单文件最大字符数（截断）
  var SOURCE_EXTENSIONS = [".vue", ".tsx", ".jsx", ".ts", ".js", ".mjs", ".cjs", ".json"];

  // 用户上传的源码文件 { path: content }
  var sourceFiles = {};

  /**
   * 设置用户上传的源码文件
   * @param {Object} files - { path: content }
   */
  function setSourceFiles(files) {
    sourceFiles = files || {};
  }

  /**
   * 获取当前已上传的源码文件
   * @returns {Object} { path: content }
   */
  function getSourceFiles() {
    return sourceFiles;
  }

  /**
   * 获取已上传文件数量
   * @returns {number}
   */
  function getFileCount() {
    return Object.keys(sourceFiles).length;
  }

  /**
   * 按关键词检索相关源码文件
   * @param {Object} files - 源码文件 { path: content }
   * @param {string[]} keywords
   * @param {number} maxFiles - 最多返回文件数
   * @returns {Array<{path: string, content: string}>}
   */
  function searchByKeywords(files, keywords, maxFiles) {
    maxFiles = maxFiles || 10;
    var results = [];

    for (var path in files) {
      if (!files.hasOwnProperty(path)) continue;
      var score = 0;
      var lowerPath = path.toLowerCase();
      for (var i = 0; i < keywords.length; i++) {
        var kw = keywords[i].toLowerCase();
        if (lowerPath.indexOf(kw) !== -1) score += 3; // 路径匹配权重高
        // 内容匹配权重低
        var content = files[path];
        if (content && content.toLowerCase().indexOf(kw) !== -1) score += 1;
      }
      if (score > 0) {
        results.push({ path: path, content: files[path], score: score });
      }
    }

    results.sort(function (a, b) { return b.score - a.score; });
    return results.slice(0, maxFiles);
  }

  function contextKeywords(context) {
    context = context || {};
    var text = [context.url, context.title, context.testCase, context.domText]
      .filter(Boolean).join(" ").toLowerCase();
    var words = {};
    text.split(/[^a-z0-9_\-\u4e00-\u9fa5]+/i).forEach(function (part) {
      if (part.length >= 2) words[part] = true;
      if (/^[\u4e00-\u9fa5]+$/.test(part)) {
        for (var i = 0; i <= part.length - 2; i++) words[part.substring(i, i + 2)] = true;
      }
    });
    var url = String(context.url || "").split(/[?#]/)[0];
    url.split("/").forEach(function (segment) {
      if (segment.length >= 2) words[segment.toLowerCase()] = true;
    });
    return Object.keys(words).slice(0, 80);
  }

  function normalizePath(value) {
    var parts = String(value || "").replace(/\\/g, "/").split("/");
    var normalized = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part || part === ".") continue;
      if (part === "..") normalized.pop();
      else normalized.push(part);
    }
    return normalized.join("/");
  }

  function buildPathIndex(files) {
    var index = {};
    Object.keys(files || {}).forEach(function(path) {
      index[normalizePath(path)] = path;
    });
    return index;
  }

  function withSourceExtensions(base) {
    var clean = String(base || "").split(/[?#]/)[0];
    var candidates = [clean];
    var hasExtension = /\.[a-z0-9]+$/i.test(clean);
    if (!hasExtension) {
      SOURCE_EXTENSIONS.forEach(function(extension) {
        candidates.push(clean + extension);
        candidates.push(clean + "/index" + extension);
      });
    }
    return candidates;
  }

  function extractImportSpecifiers(content) {
    var imports = {};
    var text = String(content || "");
    var patterns = [
      /\bfrom\s*["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
      /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
      /\bimport\s*["']([^"']+)["']/g,
    ];
    patterns.forEach(function(pattern) {
      var match;
      while ((match = pattern.exec(text)) !== null) imports[match[1]] = true;
    });
    return Object.keys(imports);
  }

  function resolveImportedPath(fromPath, specifier, pathIndex) {
    var raw = String(specifier || "");
    if (!raw || /^(?:https?:|data:|node:)/i.test(raw)) return "";
    var baseCandidates = [];
    if (raw.indexOf("./") === 0 || raw.indexOf("../") === 0) {
      var parent = normalizePath(fromPath).split("/");
      parent.pop();
      baseCandidates.push(normalizePath(parent.join("/") + "/" + raw));
    } else if (raw.indexOf("@/") === 0 || raw.indexOf("~/") === 0) {
      var aliasPath = raw.substring(2);
      baseCandidates.push(normalizePath("src/" + aliasPath));
      baseCandidates.push(normalizePath(aliasPath));
    } else if (raw.indexOf("/") !== -1) {
      baseCandidates.push(normalizePath(raw.replace(/^\//, "")));
    } else {
      return "";
    }

    for (var i = 0; i < baseCandidates.length; i++) {
      var candidates = withSourceExtensions(baseCandidates[i]);
      for (var j = 0; j < candidates.length; j++) {
        if (pathIndex[candidates[j]]) return pathIndex[candidates[j]];
      }
    }

    // 上传目录可能带项目根路径。仅在候选后缀唯一时解析，避免把同名组件误关联。
    var suffixMatches = [];
    Object.keys(pathIndex).forEach(function(normalizedPath) {
      for (var i = 0; i < baseCandidates.length; i++) {
        var candidates = withSourceExtensions(baseCandidates[i]);
        for (var j = 0; j < candidates.length; j++) {
          if (normalizedPath === candidates[j] || normalizedPath.slice(-(candidates[j].length + 1)) === "/" + candidates[j]) {
            suffixMatches.push(pathIndex[normalizedPath]);
            return;
          }
        }
      }
    });
    return suffixMatches.length === 1 ? suffixMatches[0] : "";
  }

  function boostImportedDependencies(results, files, primary) {
    var pathIndex = buildPathIndex(files);
    var byPath = {};
    results.forEach(function(item) { byPath[item.path] = item; });
    var direct = {};
    var secondHop = {};
    primary.forEach(function(item) {
      extractImportSpecifiers(item.content).forEach(function(specifier) {
        var dependency = resolveImportedPath(item.path, specifier, pathIndex);
        if (dependency && dependency !== item.path) direct[dependency] = true;
      });
    });
    Object.keys(direct).forEach(function(path) {
      var item = byPath[path];
      if (!item) return;
      item.score += 24;
      extractImportSpecifiers(item.content).forEach(function(specifier) {
        var dependency = resolveImportedPath(path, specifier, pathIndex);
        if (dependency && !direct[dependency]) secondHop[dependency] = true;
      });
    });
    Object.keys(secondHop).forEach(function(path) {
      if (byPath[path]) byPath[path].score += 8;
    });
  }

  // 针对当前页面和测试用例召回源码。先以路径/内容评分，再沿 import 关系扩展相关组件。
  function rankRelevantFiles(files, context, maxFiles) {
    maxFiles = maxFiles || 5;
    var keywords = contextKeywords(context);
    var results = [];
    for (var path in files) {
      if (!files.hasOwnProperty(path)) continue;
      var content = files[path] || "";
      var lowerPath = path.toLowerCase();
      var lowerContent = content.toLowerCase();
      var score = 0;
      for (var i = 0; i < keywords.length; i++) {
        var keyword = keywords[i];
        if (lowerPath.indexOf(keyword) !== -1) score += 8;
        if (lowerContent.indexOf(keyword) !== -1) score += 2;
      }
      if (/\.(vue|tsx|jsx)$/.test(lowerPath)) score += 1;
      results.push({ path: path, content: content, score: score });
    }
    results.sort(function (a, b) { return b.score - a.score || a.path.localeCompare(b.path); });
    var primary = results.slice(0, Math.min(maxFiles * 2, results.length));
    var primaryNames = primary.map(function (item) {
      return item.path.split("/").pop().replace(/\.[^.]+$/, "").toLowerCase();
    });
    results.forEach(function (item) {
      var lower = item.content.toLowerCase();
      for (var j = 0; j < primaryNames.length; j++) {
        if (primaryNames[j].length > 2 && lower.indexOf(primaryNames[j]) !== -1) item.score += 3;
      }
    });
    boostImportedDependencies(results, files, primary);
    results.sort(function (a, b) { return b.score - a.score || a.path.localeCompare(b.path); });
    return results.slice(0, maxFiles);
  }

  global.AIFT_SourceReader = {
    setSourceFiles: setSourceFiles,
    getSourceFiles: getSourceFiles,
    getFileCount: getFileCount,
    searchByKeywords: searchByKeywords,
    rankRelevantFiles: rankRelevantFiles,
  };
})(window);
