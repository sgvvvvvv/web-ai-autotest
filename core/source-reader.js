// source-reader.js
// 源码读取模块：仅支持用户手动上传的源码文件
// 在 Side Panel 上下文中运行（sidepanel.js 通过 <script> 引入）

(function (global) {
  "use strict";

  var MAX_FILE_CONTENT = 8000; // 单文件最大字符数（截断）

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

  global.AIFT_SourceReader = {
    setSourceFiles: setSourceFiles,
    getSourceFiles: getSourceFiles,
    getFileCount: getFileCount,
    searchByKeywords: searchByKeywords,
  };
})(window);
