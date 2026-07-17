// source-analyzer.js
// 源码组件信息提取器：从 Vue/React 源码中提取结构化的选择器、选项、绑定信息
// 让 AI 不需要从原始源码文本中推理，直接拿到可用的操作信息
// 在 Side Panel 上下文中运行（sidepanel.js 通过 <script> 引入）

(function (global) {
  "use strict";

  /**
   * 从源码中提取组件信息
   * @param {string} path - 文件路径
   * @param {string} content - 源码内容
   * @returns {Object|null} 组件信息 { selectors, options, bindings, forms, tables }
   */
  function analyzeSource(path, content) {
    if (!content) return null;

    var info = {
      path: path,
      framework: detectFramework(content),
      selectors: [],   // [{ selector, type, label, options, currentValue }]
      options: [],     // [{ name, values, source }]
      bindings: [],   // [{ element, prop, variable }]
      forms: [],       // [{ fields, submitButton }]
      tables: [],      // [{ columns, actions }]
    };

    // 提取 el-select / a-select / 通用 select 组件
    extractSelects(content, info);

    // 提取 el-table / a-table 表格列和操作
    extractTables(content, info);

    // 提取表单字段
    extractForms(content, info);

    // 提取按钮
    extractButtons(content, info);

    // 提取 tabs
    extractTabs(content, info);

    // 如果没有提取到任何信息，返回 null
    if (info.selectors.length === 0 && info.options.length === 0 &&
        info.forms.length === 0 && info.tables.length === 0) {
      return null;
    }

    return info;
  }

  function detectFramework(content) {
    if (/<el-|ElSelect|ElTable|ElForm|el-select|el-table|el-form/.test(content)) return "element-ui";
    if (/<a-select|<a-table|<a-form|AntSelect|AntDesign/.test(content)) return "ant-design";
    if (/<v-select|<v-data-table|<v-form|Vuetify/.test(content)) return "vuetify";
    if (/<q-select|<q-table|<q-form|Quasar/.test(content)) return "quasar";
    if (/useState|useEffect|jsx|React\.createElement/.test(content)) return "react";
    return "unknown";
  }

  // ===== 下拉框提取 =====
  function extractSelects(content, info) {
    // Element UI: <el-select v-model="xxx"> ... <el-option v-for="item in options" :label="item.label" :value="item.value">
    // 提取 el-select 的 v-model 和关联的 options 数组

    // 策略1: 从模板中提取 <el-select> 标签及其 v-model
    var selectRegex = /<el-select[^>]*v-model="([^"]+)"[^>]*>/g;
    var match;
    while ((match = selectRegex.exec(content)) !== null) {
      var vModel = match[1];
      // 在 el-select 标签后查找 el-option 的数据源
      var afterSelect = content.substring(match.index, match.index + 2000);
      var optionMatch = afterSelect.match(/v-for="(?:item|opt|option)\s+in\s+([\w.]+)"/);
      var dataSource = optionMatch ? optionMatch[1] : null;

      // 从 data() 或 setup 中提取数据源的值
      var optionValues = [];
      if (dataSource) {
        optionValues = extractDataArray(content, dataSource);
      }

      // 构造选择器
      var selector = {
        selector: '.el-select .el-input__inner',
        type: 'el-select',
        vModel: vModel,
        dataSource: dataSource,
        options: optionValues,
        optionSelector: '.el-select-dropdown__item',
      };

      // 尝试从 v-model 推断当前值
      var currentValueMatch = content.match(new RegExp(vModel.replace(/\./g, '\\.') + '\\s*[:=]\\s*["\']([^"\']+)["\']'));
      if (currentValueMatch) optionValues.currentValue = currentValueMatch[1];

      info.selectors.push(selector);
      if (optionValues.length > 0) {
        info.options.push({ name: dataSource || vModel, values: optionValues, source: 'el-select' });
      }
    }

    // 策略2: 从 data()/setup() 中提取 options 数组定义
    // 匹配: searchTypeOptions: [{ label: "脚本名称", value: "scriptName" }, ...]
    var arrayDefRegex = /(\w+Options)\s*:\s*\[([\s\S]*?)\]/g;
    while ((match = arrayDefRegex.exec(content)) !== null) {
      var arrayName = match[1];
      var arrayBody = match[2];
      var values = extractOptionValues(arrayBody);
      if (values.length > 0) {
        // 检查是否已经通过 el-select 提取过
        var exists = info.options.some(function(o) { return o.name === arrayName; });
        if (!exists) {
          info.options.push({ name: arrayName, values: values, source: 'data' });
        }
      }
    }

    // 策略3: Ant Design <a-select>
    var antSelectRegex = /<a-select[^>]*(?:v-model|value)="([^"]+)"[^>]*>/g;
    while ((match = antSelectRegex.exec(content)) !== null) {
      info.selectors.push({
        selector: '.ant-select-selection',
        type: 'a-select',
        vModel: match[1],
        optionSelector: '.ant-select-item-option',
      });
    }

    // 策略4: 原生 <select>
    var nativeSelectRegex = /<select[^>]*(?:v-model|value)="([^"]+)"[^>]*>/g;
    while ((match = nativeSelectRegex.exec(content)) !== null) {
      info.selectors.push({
        selector: 'select',
        type: 'native-select',
        vModel: match[1],
        optionSelector: 'option',
      });
    }
  }

  // 从源码中提取数组定义的值
  // 输入: 数组体字符串，如: { label: "脚本名称", value: "scriptName" }, { label: "操作人", value: "operator" }
  function extractOptionValues(arrayBody) {
    var values = [];
    // 匹配 label: "xxx" 或 label: 'xxx'
    var labelRegex = /label\s*:\s*["']([^"']+)["']/g;
    var match;
    while ((match = labelRegex.exec(arrayBody)) !== null) {
      values.push(match[1]);
    }
    // 如果没有 label，尝试匹配 value: "xxx"
    if (values.length === 0) {
      var valueRegex = /value\s*:\s*["']([^"']+)["']/g;
      while ((match = valueRegex.exec(arrayBody)) !== null) {
        values.push(match[1]);
      }
    }
    return values;
  }

  // 从 data() 或 setup() 中提取数组变量的值
  function extractDataArray(content, varName) {
    // varName 可能是 "searchTypeOptions" 或 "this.searchTypeOptions" 或 "form.options"
    var cleanName = varName.replace(/^this\./, '').replace(/^form\./, '');

    // 匹配: cleanName: [ ... ] 或 cleanName = [ ... ] 或 const cleanName = [ ... ]
    var patterns = [
      new RegExp(cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:=]\\s*\\[([\\s\\S]*?)\\]'),
    ];

    for (var i = 0; i < patterns.length; i++) {
      var match = content.match(patterns[i]);
      if (match) {
        return extractOptionValues(match[1]);
      }
    }
    return [];
  }

  // ===== 表格提取 =====
  function extractTables(content, info) {
    // Element UI: <el-table-column prop="xxx" label="xxx">
    var colRegex = /<el-table-column[^>]*prop="([^"]*)"[^>]*label="([^"]*)"[^>]*>/g;
    var match;
    var columns = [];
    while ((match = colRegex.exec(content)) !== null) {
      columns.push({ prop: match[1], label: match[2] });
    }
    // 也匹配 label 在前的情况
    var colRegex2 = /<el-table-column[^>]*label="([^"]*)"[^>]*prop="([^"]*)"[^>]*>/g;
    while ((match = colRegex2.exec(content)) !== null) {
      if (!columns.some(function(c) { return c.prop === match[2]; })) {
        columns.push({ prop: match[2], label: match[1] });
      }
    }

    // 提取表格中的操作按钮
    var actionRegex = /<el-button[^>]*>([^<]+)<\/el-button>/g;
    var actions = [];
    while ((match = actionRegex.exec(content)) !== null) {
      var btnText = match[1].trim();
      if (btnText && actions.indexOf(btnText) === -1) actions.push(btnText);
    }

    if (columns.length > 0 || actions.length > 0) {
      info.tables.push({
        selector: '.el-table',
        type: 'el-table',
        columns: columns,
        actions: actions,
      });
    }

    // Ant Design: <a-table :columns="xxx">
    var antTableMatch = content.match(/<a-table[^>]*:columns="([^"]+)"/);
    if (antTableMatch) {
      info.tables.push({
        selector: '.ant-table',
        type: 'a-table',
        columnsSource: antTableMatch[1],
      });
    }
  }

  // ===== 表单提取 =====
  function extractForms(content, info) {
    // Element UI: <el-form-item label="xxx"> <el-input v-model="yyy" placeholder="zzz">
    var formItemRegex = /<el-form-item[^>]*label="([^"]*)"[^>]*>([\s\S]*?)<\/el-form-item>/g;
    var match;
    var fields = [];
    while ((match = formItemRegex.exec(content)) !== null) {
      var label = match[1];
      var body = match[2];
      var inputMatch = body.match(/<(?:el-input|el-select|el-date-picker|el-input-number)[^>]*(?:v-model|value)="([^"]+)"[^>]*(?:placeholder="([^"]*)")?/);
      if (inputMatch) {
        fields.push({
          label: label,
          vModel: inputMatch[1],
          placeholder: inputMatch[2] || '',
        });
      }
    }

    // 提交按钮
    var submitMatch = content.match(/<el-button[^>]*type="primary"[^>]*>([^<]+)<\/el-button>/);
    var submitButton = submitMatch ? submitMatch[1].trim() : null;

    if (fields.length > 0) {
      info.forms.push({
        selector: '.el-form',
        fields: fields,
        submitButton: submitButton,
      });
    }
  }

  // ===== 按钮提取 =====
  function extractButtons(content, info) {
    // Element UI 按钮
    var btnRegex = /<el-button[^>]*>([^<]{1,30})<\/el-button>/g;
    var match;
    while ((match = btnRegex.exec(content)) !== null) {
      var text = match[1].trim();
      if (text) {
        info.selectors.push({
          selector: '.el-button:contains("' + text + '")',
          type: 'button',
          label: text,
        });
      }
    }

    // 原生 button
    var nativeBtnRegex = /<button[^>]*>([^<]{1,30})<\/button>/g;
    while ((match = nativeBtnRegex.exec(content)) !== null) {
      var text2 = match[1].trim();
      if (text2) {
        info.selectors.push({
          selector: 'button:contains("' + text2 + '")',
          type: 'button',
          label: text2,
        });
      }
    }
  }

  // ===== Tab 提取 =====
  function extractTabs(content, info) {
    // Element UI: <el-tab-pane label="xxx" name="yyy">
    var tabRegex = /<el-tab-pane[^>]*label="([^"]*)"[^>]*name="([^"]*)"[^>]*>/g;
    var match;
    var tabs = [];
    while ((match = tabRegex.exec(content)) !== null) {
      tabs.push({ label: match[1], name: match[2] });
    }
    // 也匹配 name 在前的情况
    var tabRegex2 = /<el-tab-pane[^>]*name="([^"]*)"[^>]*label="([^"]*)"[^>]*>/g;
    while ((match = tabRegex2.exec(content)) !== null) {
      if (!tabs.some(function(t) { return t.name === match[1]; })) {
        tabs.push({ label: match[2], name: match[1] });
      }
    }
    if (tabs.length > 0) {
      info.selectors.push({
        selector: '.el-tabs__item',
        type: 'tabs',
        tabs: tabs,
      });
    }
  }

  /**
   * 将组件信息格式化为 AI 可读的文本
   * @param {Object} info - analyzeSource 返回的组件信息
   * @returns {string} 格式化的文本
   */
  function formatComponentInfo(info) {
    if (!info) return "";
    var lines = [];
    lines.push("## 源码组件分析（" + info.path + "）");
    lines.push("框架: " + (info.framework || "unknown"));

    // 下拉框
    if (info.selectors.length > 0) {
      lines.push("");
      lines.push("### 下拉框/选择器");
      for (var i = 0; i < info.selectors.length; i++) {
        var s = info.selectors[i];
        if (s.type === 'el-select' || s.type === 'a-select' || s.type === 'native-select') {
          lines.push("  选择器: " + s.selector);
          lines.push("    类型: " + s.type + ", v-model: " + s.vModel);
          if (s.dataSource) lines.push("    数据源: " + s.dataSource);
          if (s.options && s.options.length > 0) {
            lines.push("    可选项: [" + s.options.join(", ") + "]");
          }
          lines.push("    选项选择器: " + s.optionSelector);
          lines.push("    → 使用 select_option(trigger:{findBy:'selector', value:'" + s.selector + "'}, option:{findBy:'text', value:'选项文本'})");
        }
      }
    }

    // 选项数组
    if (info.options.length > 0) {
      lines.push("");
      lines.push("### 选项数据");
      for (var j = 0; j < info.options.length; j++) {
        var o = info.options[j];
        lines.push("  " + o.name + ": [" + o.values.join(", ") + "] (来源: " + o.source + ")");
      }
    }

    // 表格
    if (info.tables.length > 0) {
      lines.push("");
      lines.push("### 表格");
      for (var k = 0; k < info.tables.length; k++) {
        var t = info.tables[k];
        lines.push("  选择器: " + t.selector + " (类型: " + t.type + ")");
        if (t.columns && t.columns.length > 0) {
          lines.push("    列: " + t.columns.map(function(c) { return c.label + "(" + c.prop + ")"; }).join(", "));
        }
        if (t.actions && t.actions.length > 0) {
          lines.push("    操作按钮: [" + t.actions.join(", ") + "]");
        }
      }
    }

    // 表单
    if (info.forms.length > 0) {
      lines.push("");
      lines.push("### 表单");
      for (var f = 0; f < info.forms.length; f++) {
        var form = info.forms[f];
        lines.push("  选择器: " + form.selector);
        if (form.fields && form.fields.length > 0) {
          for (var fi = 0; fi < form.fields.length; fi++) {
            var field = form.fields[fi];
            lines.push("    字段: " + field.label + " (v-model: " + field.vModel + (field.placeholder ? ", placeholder: " + field.placeholder : "") + ")");
          }
        }
        if (form.submitButton) {
          lines.push("    提交按钮: " + form.submitButton);
        }
      }
    }

    // 按钮
    var buttons = info.selectors.filter(function(s) { return s.type === 'button'; });
    if (buttons.length > 0) {
      lines.push("");
      lines.push("### 按钮");
      for (var bi = 0; bi < buttons.length; bi++) {
        lines.push("  " + buttons[bi].label + " → click(\"" + buttons[bi].selector + "\")");
      }
    }

    // Tabs
    var tabsList = info.selectors.filter(function(s) { return s.type === 'tabs'; });
    if (tabsList.length > 0) {
      lines.push("");
      lines.push("### 标签页");
      for (var ti = 0; ti < tabsList.length; ti++) {
        var tabs = tabsList[ti].tabs;
        for (var tj = 0; tj < tabs.length; tj++) {
          lines.push("  " + tabs[tj].label + " (name: " + tabs[tj].name + ")");
        }
      }
    }

    return lines.join("\n");
  }

  /**
   * 批量分析源码文件
   * @param {Object} files - { path: content }
   * @returns {string} 格式化的组件信息文本
   */
  function analyzeFiles(files) {
    var parts = [];
    for (var path in files) {
      if (!files.hasOwnProperty(path)) continue;
      var info = analyzeSource(path, files[path]);
      if (info) {
        parts.push(formatComponentInfo(info));
      }
    }
    return parts.join("\n\n");
  }

  global.AIFT_SourceAnalyzer = {
    analyzeSource: analyzeSource,
    formatComponentInfo: formatComponentInfo,
    analyzeFiles: analyzeFiles,
  };
})(window);
