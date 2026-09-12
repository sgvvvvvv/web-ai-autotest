// skill-manager.js
// 自迭代 Skill 的存储、检索、匹配和格式化。
// Skill 保存在 chrome.storage.local 中，支持按当前页面上下文自动匹配。
// 借鉴 CodeBuddy skill-creator 的 SKILL.md 格式：name + description + instructions + bundled resources。

(function (global) {
  "use strict";

  var STORAGE_KEY = "aift_skills";
  var MAX_SKILLS = 200;

  function safeGetStorage() {
    return new Promise(function (resolve) {
      try {
        if (global.chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(STORAGE_KEY, function (result) {
            resolve(result[STORAGE_KEY] || []);
          });
        } else {
          resolve(global.__aift_skill_cache__ || []);
        }
      } catch (e) {
        resolve([]);
      }
    });
  }

  function safeSetStorage(skills) {
    return new Promise(function (resolve) {
      try {
        if (global.chrome && chrome.storage && chrome.storage.local) {
          var obj = {};
          obj[STORAGE_KEY] = skills;
          chrome.storage.local.set(obj, function () { resolve(true); });
        } else {
          global.__aift_skill_cache__ = skills;
          resolve(true);
        }
      } catch (e) {
        resolve(false);
      }
    });
  }

  function generateId() {
    return "skill-" + Date.now() + "-" + Math.floor(Math.random() * 10000);
  }

  function normalizeText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function urlMatch(url, pattern) {
    if (!pattern) return true;
    if (!url) return false;
    var p = normalizeText(pattern);
    var u = normalizeText(url);
    if (p.indexOf("*") === -1) return u.indexOf(p) !== -1;
    var parts = p.split("*");
    var pos = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "") continue;
      var idx = u.indexOf(parts[i], pos);
      if (idx === -1) return false;
      pos = idx + parts[i].length;
    }
    return true;
  }

  function classMatch(snapshotClasses, pattern) {
    if (!pattern) return true;
    var classes = normalizeText(snapshotClasses);
    var patterns = normalizeText(pattern).split(/[\s,]+/).filter(Boolean);
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i] && classes.indexOf(patterns[i]) === -1) return false;
    }
    return true;
  }

  function actionTypeMatch(skillActionType, currentActionType) {
    if (!skillActionType) return true;
    if (!currentActionType) return false;
    return skillActionType === currentActionType;
  }

  function extractPageClasses(snapshot) {
    if (!snapshot || !snapshot.nodes) return "";
    var classes = {};
    for (var i = 0; i < snapshot.nodes.length; i++) {
      var node = snapshot.nodes[i] || {};
      var cls = node.className || "";
      if (cls) {
        var parts = cls.split(/\s+/);
        for (var j = 0; j < parts.length; j++) {
          if (parts[j]) classes[parts[j]] = true;
        }
      }
    }
    return Object.keys(classes).join(" ");
  }

  /**
   * 保存一个 skill。如果 id 存在则更新，否则新建。
   * @param {Object} skill - skill 数据
   * @returns {Promise<Object>} 保存后的 skill（含 id）
   */
  async function saveSkill(skill) {
    skill = skill || {};
    var skills = await safeGetStorage();
    var now = new Date().toISOString();
    if (!skill.id) skill.id = generateId();
    skill.createdAt = skill.createdAt || now;
    skill.updatedAt = now;
    skill.usageCount = skill.usageCount || 0;
    skill.successCount = skill.successCount || 0;
    skill.failureCount = skill.failureCount || 0;

    var existingIdx = -1;
    for (var i = 0; i < skills.length; i++) {
      if (skills[i].id === skill.id) { existingIdx = i; break; }
      // 也按 name 去重
      if (skill.name && skills[i].name === skill.name) { existingIdx = i; skill.id = skills[i].id; break; }
    }
    if (existingIdx >= 0) {
      skill.createdAt = skills[existingIdx].createdAt || skill.createdAt;
      skill.usageCount = (skills[existingIdx].usageCount || 0) + (skill.usageCount || 0);
      skill.successCount = (skills[existingIdx].successCount || 0) + (skill.successCount || 0);
      skills[existingIdx] = skill;
    } else {
      skills.push(skill);
    }

    // 容量控制：保留最近 MAX_SKILLS 个
    if (skills.length > MAX_SKILLS) {
      skills = skills.slice(-MAX_SKILLS);
    }

    await safeSetStorage(skills);
    return skill;
  }

  /**
   * 获取所有 skill。
   * @returns {Promise<Array>}
   */
  async function getAllSkills() {
    return await safeGetStorage();
  }

  /**
   * 按 ID 删除 skill。
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async function deleteSkill(id) {
    var skills = await safeGetStorage();
    var filtered = skills.filter(function (s) { return s.id !== id; });
    if (filtered.length === skills.length) return false;
    await safeSetStorage(filtered);
    return true;
  }

  /**
   * 清空所有 skill。
   * @returns {Promise<boolean>}
   */
  async function clearAllSkills() {
    await safeSetStorage([]);
    return true;
  }

  /**
   * 按当前测试上下文匹配 skill。
   * @param {Object} context - { url, actionType, snapshot, testCase }
   * @returns {Promise<Array>} 匹配的 skill 列表（按匹配度排序）
   */
  async function matchSkills(context) {
    context = context || {};
    var skills = await safeGetStorage();
    if (!skills || skills.length === 0) return [];

    var url = context.url || (context.snapshot && context.snapshot.url) || "";
    var actionType = context.actionType || "";
    var pageClasses = extractPageClasses(context.snapshot);
    var tcText = normalizeText((context.testCase || "").substring(0, 200));

    var matched = [];
    for (var i = 0; i < skills.length; i++) {
      var skill = skills[i];
      var patterns = skill.matchPatterns || {};
      var score = 0;
      var ok = true;

      if (patterns.urlPattern) {
        if (urlMatch(url, patterns.urlPattern)) { score += 3; }
        else { ok = false; }
      }
      if (patterns.elementClasses) {
        if (classMatch(pageClasses, patterns.elementClasses)) { score += 2; }
        else { ok = false; }
      }
      if (patterns.actionType) {
        if (actionTypeMatch(patterns.actionType, actionType)) { score += 2; }
        else { ok = false; }
      }
      if (patterns.testCaseKeywords) {
        var keywords = normalizeText(patterns.testCaseKeywords).split(/[\s,]+/).filter(Boolean);
        var kwMatch = 0;
        for (var k = 0; k < keywords.length; k++) {
          if (keywords[k] && tcText.indexOf(keywords[k]) !== -1) kwMatch++;
        }
        if (kwMatch > 0) { score += kwMatch; }
        else if (keywords.length > 0) { ok = false; }
      }

      if (ok && score > 0) {
        matched.push({ skill: skill, score: score });
      }
    }

    matched.sort(function (a, b) { return b.score - a.score; });
    return matched.map(function (m) { return m.skill; });
  }

  /**
   * 将 skill 格式化为注入 prompt 的文本。
   * 借鉴 CodeBuddy skill-creator 的 progressive disclosure：只注入 name + description + 精简指令。
   * @param {Array} skills - skill 列表
   * @returns {string} 格式化的文本
   */
  function formatSkillsForPrompt(skills) {
    if (!skills || skills.length === 0) return "";
    var lines = ["", "## 已有操作经验 Skill（遇到类似场景可直接参考）"];
    for (var i = 0; i < skills.length; i++) {
      var skill = skills[i] || {};
      lines.push("### Skill: " + (skill.name || "未命名"));
      if (skill.description) lines.push("- 适用场景: " + skill.description);
      if (skill.strategy && skill.strategy.approach) {
        lines.push("- 成功策略: " + skill.strategy.approach);
      }
      if (skill.strategy && skill.strategy.selectors && skill.strategy.selectors.length > 0) {
        lines.push("- 关键选择器: " + skill.strategy.selectors.join(", "));
      }
      if (skill.skillContent) {
        var content = skill.skillContent;
        if (content.length > 800) content = content.substring(0, 800) + "…（已截断）";
        lines.push("- 操作指令: " + content);
      }
      if (skill.failureCount > 0) {
        lines.push("- 历史失败次数: " + skill.failureCount + "，成功复用次数: " + (skill.successCount || 0));
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  /**
   * 记录 skill 使用（成功或失败）。
   * @param {string} skillId
   * @param {boolean} success
   */
  async function recordUsage(skillId, success) {
    if (!skillId) return;
    var skills = await safeGetStorage();
    for (var i = 0; i < skills.length; i++) {
      if (skills[i].id === skillId) {
        skills[i].usageCount = (skills[i].usageCount || 0) + 1;
        if (success) skills[i].successCount = (skills[i].successCount || 0) + 1;
        skills[i].lastUsedAt = new Date().toISOString();
        break;
      }
    }
    await safeSetStorage(skills);
  }

  /**
   * 按 ID 获取 skill。
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async function getSkill(id) {
    var skills = await safeGetStorage();
    for (var i = 0; i < skills.length; i++) {
      if (skills[i].id === id) return skills[i];
    }
    return null;
  }

  global.AIFT_SkillManager = {
    saveSkill: saveSkill,
    getAllSkills: getAllSkills,
    getSkill: getSkill,
    deleteSkill: deleteSkill,
    clearAllSkills: clearAllSkills,
    matchSkills: matchSkills,
    formatSkillsForPrompt: formatSkillsForPrompt,
    recordUsage: recordUsage,
  };
})(window);
