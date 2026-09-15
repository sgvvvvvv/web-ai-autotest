// skill-manager.js
// 自迭代 Skill 的存储、检索、匹配和格式化。
// Skill 保存在 chrome.storage.local 中，支持按当前页面上下文自动匹配。
// 借鉴 CodeBuddy skill-creator 的 SKILL.md 格式：name + description + instructions + bundled resources。

(function (global) {
  "use strict";

  var STORAGE_KEY = "aift_skills";
  var STORAGE_SCHEMA_VERSION = 1;
  var MAX_SKILLS = 200;
  var MAX_IMPORT_BYTES = 2 * 1024 * 1024;

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

  function cloneValue(value) {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeSkill(skill, keepStats) {
    skill = skill && typeof skill === "object" ? skill : {};
    var normalized = {
      id: skill.id || generateId(),
      name: String(skill.name || "").trim().substring(0, 120),
      description: String(skill.description || "").trim().substring(0, 1000),
      category: String(skill.category || "").trim().substring(0, 80),
      matchPatterns: skill.matchPatterns && typeof skill.matchPatterns === "object" ? cloneValue(skill.matchPatterns) : {},
      strategy: skill.strategy && typeof skill.strategy === "object" ? cloneValue(skill.strategy) : {},
      skillContent: String(skill.skillContent || "").trim().substring(0, 5000),
      source: String(skill.source || "import").trim().substring(0, 40),
      createdAt: skill.createdAt || new Date().toISOString(),
      updatedAt: skill.updatedAt || new Date().toISOString(),
      usageCount: keepStats ? Number(skill.usageCount) || 0 : 0,
      successCount: keepStats ? Number(skill.successCount) || 0 : 0,
      failureCount: keepStats ? Number(skill.failureCount) || 0 : 0,
      lastUsedAt: keepStats ? (skill.lastUsedAt || "") : "",
    };
    if (!Array.isArray(normalized.strategy.selectors)) normalized.strategy.selectors = [];
    if (!Array.isArray(normalized.strategy.keySteps)) normalized.strategy.keySteps = [];
    return normalized;
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
    var skills = await safeGetStorage();
    var normalized = normalizeSkill(skill, true);
    var existingIdx = -1;
    for (var i = 0; i < skills.length; i++) {
      if (skills[i].id === normalized.id) { existingIdx = i; break; }
      if (normalized.name && skills[i].name === normalized.name) {
        existingIdx = i;
        normalized.id = skills[i].id;
        break;
      }
    }
    if (existingIdx >= 0) {
      normalized.createdAt = skills[existingIdx].createdAt || normalized.createdAt;
      normalized.usageCount = (skills[existingIdx].usageCount || 0) + normalized.usageCount;
      normalized.successCount = (skills[existingIdx].successCount || 0) + normalized.successCount;
      normalized.failureCount = (skills[existingIdx].failureCount || 0) + normalized.failureCount;
      skills[existingIdx] = normalized;
    } else {
      skills.push(normalized);
    }
    if (skills.length > MAX_SKILLS) skills = skills.slice(-MAX_SKILLS);
    if (!await safeSetStorage(skills)) throw new Error("Skill 本地存储写入失败");
    return normalized;
  }

  async function exportSkills() {
    return {
      type: "aift-skills",
      schemaVersion: STORAGE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      skills: (await safeGetStorage()).map(function (skill) { return cloneValue(skill); }),
    };
  }

  async function importSkills(payload) {
    if (!payload || payload.type !== "aift-skills" || !Array.isArray(payload.skills)) {
      throw new Error("Skill 文件格式无效，必须是 aift-skills JSON 文件");
    }
    var serialized = JSON.stringify(payload);
    if (serialized.length > MAX_IMPORT_BYTES) throw new Error("Skill 文件超过 2MB 限制");
    var imported = [];
    for (var i = 0; i < payload.skills.length; i++) {
      var normalized = normalizeSkill(payload.skills[i], true);
      if (!normalized.name) continue;
      imported.push(normalized);
    }
    if (imported.length === 0) throw new Error("Skill 文件中没有有效 Skill");
    var skills = await safeGetStorage();
    var added = 0;
    var updated = 0;
    for (var j = 0; j < imported.length; j++) {
      var item = imported[j];
      var existingIdx = -1;
      for (var k = 0; k < skills.length; k++) {
        if (skills[k].name === item.name || skills[k].id === item.id) {
          existingIdx = k;
          break;
        }
      }
      if (existingIdx >= 0) {
        item.id = skills[existingIdx].id;
        item.createdAt = skills[existingIdx].createdAt || item.createdAt;
        skills[existingIdx] = item;
        updated++;
      } else {
        skills.push(item);
        added++;
      }
    }
    if (skills.length > MAX_SKILLS) skills = skills.slice(-MAX_SKILLS);
    if (!await safeSetStorage(skills)) throw new Error("Skill 导入写入本地存储失败");
    return { added: added, updated: updated, total: imported.length };
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
    if (!await safeSetStorage(filtered)) throw new Error("Skill 删除写入本地存储失败");
    return true;
  }

  /**
   * 清空所有 skill。
   * @returns {Promise<boolean>}
   */
  async function clearAllSkills() {
    if (!await safeSetStorage([])) throw new Error("Skill 清空写入本地存储失败");
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
      if (patterns.actionType && actionType) {
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
    var lines = ["", "## 已有操作经验 Skill（遇到类似操作必须优先使用）", "如果当前任务与某个 Skill 的适用场景或操作类型相符，必须先调用 use_skill 获取完整规范，再执行 click/type/select 等实际操作；不要跳过 Skill 直接试错。"];
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
        if (success) {
          skills[i].successCount = (skills[i].successCount || 0) + 1;
        } else {
          skills[i].failureCount = (skills[i].failureCount || 0) + 1;
        }
        skills[i].lastUsedAt = new Date().toISOString();
        break;
      }
    }
    if (!await safeSetStorage(skills)) throw new Error("Skill 使用统计写入本地存储失败");
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
    exportSkills: exportSkills,
    importSkills: importSkills,
    getAllSkills: getAllSkills,
    getSkill: getSkill,
    deleteSkill: deleteSkill,
    clearAllSkills: clearAllSkills,
    matchSkills: matchSkills,
    formatSkillsForPrompt: formatSkillsForPrompt,
    recordUsage: recordUsage,
  };
})(window);
