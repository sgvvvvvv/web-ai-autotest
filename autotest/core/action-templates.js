// action-templates.js
// 经典前端测试场景的预设操作模板
// 通过确定性的 JS + CDP 序列完成常见操作，避免 AI 在简单交互上反复试错卡壳
// 在 Side Panel 上下文中运行

(function (global) {
  "use strict";

  var STEP_DELAY = 80;
  var FIND_RETRY = 3;
  var FIND_RETRY_DELAY = 150;

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function dismissFloatingOrEscape(evalInPage, vc) {
    if (vc.dismissFloatingLayer) {
      var dismissed = await vc.dismissFloatingLayer(evalInPage);
      // 关闭下拉的调用方绝不能以 Escape 作为兜底：在许多弹框库中它会冒泡到父弹框。
      // 找不到可安全关闭的位置时返回失败，让 Agent 保留当前页面状态并换策略。
      return dismissed;
    }
    return { ok: false, error: "浮层安全关闭能力不可用，已阻止 Escape 关闭父弹框" };
  }

  async function readJson(evalInPage, code, fallback) {
    var resp = await evalInPage(code);
    if (!resp || !resp.ok || !resp.result || resp.result === "undefined") return fallback || null;
    try { return JSON.parse(resp.result); } catch (e) { return fallback || null; }
  }

  function findSourceInteraction(deps, trigger) {
    if (global.AIFT_InteractionContract && global.AIFT_InteractionContract.match) {
      return global.AIFT_InteractionContract.match(deps.sourceInteractions, trigger);
    }
    var contracts = deps.sourceInteractions || [];
    var value = trigger && trigger.value || "";
    for (var i = 0; i < contracts.length; i++) {
      if (contracts[i].triggerSelector === value ||
          (trigger && trigger.findBy === "placeholder" && contracts[i].triggerSelector.indexOf(value) !== -1)) {
        return contracts[i];
      }
    }
    return null;
  }

  async function getPointDiagnostics(evalInPage, x, y) {
    var code = "(function(){var el=document.elementFromPoint(" + Number(x || 0) + "," + Number(y || 0) + ");" +
      "if(!el)return JSON.stringify({found:false});" +
      "var r=el.getBoundingClientRect();var active=document.activeElement;" +
      "function brief(n){if(!n)return null;return {tag:n.tagName,id:n.id||'',class:(typeof n.className==='string'?n.className:'').substring(0,80),text:(n.textContent||'').replace(/\\s+/g,' ').trim().substring(0,80),value:n.value||'',role:n.getAttribute('role')||'',aria:n.getAttribute('aria-label')||''};}" +
      "return JSON.stringify({found:true,hit:brief(el),active:brief(active),rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}});})()";
    return await readJson(evalInPage, code, {});
  }

  async function readNativeSelectValue(evalInPage, selector, nativeIndex, multipleOnly) {
    var code = "(function(){var selector=" + JSON.stringify(selector || "") + ";var nativeIndex=" + (nativeIndex == null || isNaN(Number(nativeIndex)) ? "null" : String(Number(nativeIndex))) + ";var multipleOnly=" + (multipleOnly ? "true" : "false") + ";" +
      "var list=multipleOnly?document.querySelectorAll('select[multiple]'):document.querySelectorAll('select');" +
      "var el=null;if(nativeIndex!==null)el=list[nativeIndex];if(!el&&selector)el=document.querySelector(selector);" +
      "if(!el)return JSON.stringify({ok:false,error:'not found',selected:[]});" +
      "var selected=Array.from(el.selectedOptions||[]).map(function(o){return (o.textContent||'').trim()||o.value;});" +
      "return JSON.stringify({ok:true,value:selected.join(','),selected:selected,selectedIndex:el.selectedIndex});})()";
    return await readJson(evalInPage, code, null);
  }

  function optionOrdinal(value) {
    var text = String(value || "").trim().toLowerCase();
    if (!text) return null;
    var direct = text.match(/第\s*(\d+)\s*个/) || text.match(/^(\d+)(st|nd|rd|th)?\s*(option|item)$/);
    if (direct) return Math.max(0, parseInt(direct[1], 10) - 1);
    var zh = { "第一个": 0, "第二个": 1, "第三个": 2, "第四个": 3, "第五个": 4, "第六个": 5, "第七个": 6, "第八个": 7, "第九个": 8, "第十个": 9 };
    for (var k in zh) { if (zh.hasOwnProperty(k) && text.indexOf(k) !== -1) return zh[k]; }
    var en = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5, seventh: 6, eighth: 7, ninth: 8, tenth: 9 };
    for (var e in en) { if (en.hasOwnProperty(e) && text.indexOf(e) !== -1) return en[e]; }
    return null;
  }

  async function selectNativeOption(evalInPage, vc, trigger, optionValue, optionFindBy) {
    var selector = trigger.selector || "";
    var ordinal = optionOrdinal(optionValue);
    var nativeIndex = trigger.nativeIndex == null ? null : Number(trigger.nativeIndex);
    var metaCode = "(function(){var selector=" + JSON.stringify(selector) + ";var nativeIndex=" + (nativeIndex === null || isNaN(nativeIndex) ? "null" : String(nativeIndex)) + ";var val=" + JSON.stringify(optionValue) + ";var findBy=" + JSON.stringify(optionFindBy || "text") + ";var ordinal=" + (ordinal === null ? "null" : String(ordinal)) + ";" +
      "var el=null;if(nativeIndex!==null)el=document.querySelectorAll('select')[nativeIndex];if(!el&&selector)el=document.querySelector(selector);if(!el||el.tagName!=='SELECT')return JSON.stringify({ok:false,error:'native select not found'});if(el.disabled)return JSON.stringify({ok:false,error:'select disabled'});" +
      "el.scrollIntoView({behavior:'instant',block:'center'});var r=el.getBoundingClientRect();" +
      "var opts=Array.from(el.options).map(function(o,i){return {index:i,text:(o.textContent||'').trim(),value:o.value,disabled:!!o.disabled,selected:!!o.selected};});" +
      "function mt(o){var t=o.text||'',v=o.value||'';if(findBy==='text')return t===val||v===val;if(findBy==='text_contains')return t.indexOf(val)!==-1||v.indexOf(val)!==-1;return t===val||v===val||t.indexOf(val)!==-1||v.indexOf(val)!==-1;}" +
      "var enabled=opts.filter(function(o){return !o.disabled;});" +
      "var target=null;if(ordinal!==null&&enabled[ordinal])target=enabled[ordinal];" +
      "if(!target){for(var i=0;i<opts.length;i++){if(mt(opts[i])){target=opts[i];break;}}}" +
      "return JSON.stringify({ok:!!target,error:target?'':'option not found',selector:selector,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),selectedIndex:el.selectedIndex,multiple:!!el.multiple,target:target,options:opts.slice(0,40)});})()";
    var meta = await readJson(evalInPage, metaCode, null);
    if (!meta || !meta.ok || !meta.target) {
      var optionTexts = meta && meta.options ? meta.options.map(function(o){ return o.text || o.value; }).join(", ") : "";
      return { ok: false, result: "原生 select 未找到选项: " + optionValue + (optionTexts ? "。可用选项: " + optionTexts : "") };
    }
    if (meta.target.disabled) return { ok: false, result: "目标选项被禁用: " + optionValue };

    await vc.mouseClick(meta.x, meta.y);
    await sleep(80);
    await vc.keyboardPress("Home");
    await sleep(40);
    for (var i = 0; i < meta.target.index; i++) {
      await vc.keyboardPress("ArrowDown");
      await sleep(20);
    }
    await vc.keyboardPress("Enter");
    await sleep(STEP_DELAY);

    var verify = await readNativeSelectValue(evalInPage, selector, nativeIndex, false);
    if (!verify || !verify.ok || String(verify.value).indexOf(meta.target.text || optionValue) === -1) {
      return {
        ok: false,
        result: "原生 select 选择未生效：期望 \"" + (meta.target.text || optionValue) + "\"，当前值 \"" + (verify && verify.value || "") + "\"",
        diagnostics: await getPointDiagnostics(evalInPage, meta.x, meta.y),
      };
    }
    return { ok: true, result: "原生 select 已选择: " + verify.value };
  }

  async function selectNativeMultiOptions(evalInPage, vc, trigger, wantedValues) {
    var selector = trigger.selector || "";
    var ordinals = (wantedValues || []).map(optionOrdinal);
    var nativeIndex = trigger.nativeIndex == null ? null : Number(trigger.nativeIndex);
    var metaCode = "(function(){var selector=" + JSON.stringify(selector) + ";var nativeIndex=" + (nativeIndex === null || isNaN(nativeIndex) ? "null" : String(nativeIndex)) + ";var wanted=" + JSON.stringify(wantedValues || []) + ";var ordinals=" + JSON.stringify(ordinals) + ";" +
      "var el=null;if(nativeIndex!==null)el=document.querySelectorAll('select[multiple]')[nativeIndex];if(!el&&selector)el=document.querySelector(selector);if(!el||el.tagName!=='SELECT'||!el.multiple)return JSON.stringify({ok:false,error:'native multi select not found'});if(el.disabled)return JSON.stringify({ok:false,error:'select disabled'});" +
      "el.scrollIntoView({behavior:'instant',block:'center'});var r=el.getBoundingClientRect();" +
      "var opts=Array.from(el.options).map(function(o,i){return {index:i,text:(o.textContent||'').trim(),value:o.value,disabled:!!o.disabled,selected:!!o.selected};});" +
      "function has(o,v){return o.text===v||o.value===v||o.text.indexOf(v)!==-1||o.value.indexOf(v)!==-1;}" +
      "var enabled=opts.filter(function(o){return !o.disabled;});" +
      "var targets=[];for(var w=0;w<wanted.length;w++){var found=null;if(ordinals[w]!==null&&enabled[ordinals[w]])found=enabled[ordinals[w]];if(!found){for(var i=0;i<opts.length;i++){if(has(opts[i],wanted[w])){found=opts[i];break;}}}targets.push({wanted:wanted[w],option:found});}" +
      "return JSON.stringify({ok:true,selector:selector,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),targets:targets,options:opts.slice(0,60)});})()";
    var meta = await readJson(evalInPage, metaCode, null);
    if (!meta || !meta.ok) return { ok: false, result: "原生多选框不可用: " + (meta && meta.error || "") };

    var missing = meta.targets.filter(function(t){ return !t.option; }).map(function(t){ return t.wanted; });
    if (missing.length > 0) {
      return { ok: false, result: "原生多选未找到选项: " + missing.join(", ") };
    }

    await vc.mouseClick(meta.x, meta.y);
    await sleep(80);
    await vc.keyboardCombo(["Control", "Home"]);
    await sleep(50);
    var current = 0;
    var targets = meta.targets.map(function(t){ return t.option; }).sort(function(a,b){ return a.index - b.index; });
    for (var i = 0; i < targets.length; i++) {
      var target = targets[i];
      if (target.disabled) return { ok: false, result: "目标选项被禁用: " + (target.text || target.value) };
      while (current < target.index) {
        await vc.keyboardCombo(["Control", "ArrowDown"]);
        await sleep(20);
        current++;
      }
      await vc.keyboardCombo(["Control", "Space"]);
      await sleep(60);
    }

    var verify = await readNativeSelectValue(evalInPage, selector, nativeIndex, true) || {};
    var selectedText = (verify.selected || []).join(" | ");
    var failed = wantedValues.filter(function(v){ return selectedText.indexOf(v) === -1; });
    if (failed.length > 0) {
      return { ok: false, result: "原生多选验证失败，未选中: " + failed.join(", ") + "；当前选中: " + selectedText };
    }
    return { ok: true, result: "原生多选完成: " + selectedText };
  }

  async function verifyMultiSelection(evalInPage, trigger, wantedValues) {
    var code = "(function(){var wanted=" + JSON.stringify(wantedValues || []) + ";var tx=" + Number(trigger.x || 0) + ",ty=" + Number(trigger.y || 0) + ";" +
      "function norm(s){return String(s||'').replace(/\\s+/g,' ').trim();}" +
      "var texts=[];" +
      "Array.from(document.querySelectorAll('.el-select .el-tag,.ant-select-selection-item,.ant-select-selection-overflow-item,.v-chip,.q-chip,[aria-selected=\"true\"],.is-selected,.selected')).forEach(function(el){var r=el.getBoundingClientRect();if(r.width>0&&r.height>0)texts.push(norm(el.textContent||el.value||''));});" +
      "var near=document.elementFromPoint(tx,ty);for(var p=0;p<6&&near;p++,near=near.parentElement){texts.push(norm(near.textContent||near.value||''));}" +
      "var joined=texts.filter(Boolean).join(' | ');" +
      "var missing=wanted.filter(function(v){return joined.indexOf(v)===-1;});" +
      "return JSON.stringify({ok:missing.length===0,missing:missing,text:joined.substring(0,500)});})()";
    return await readJson(evalInPage, code, { ok: false, missing: wantedValues, text: "" });
  }

  /**
   * 在页面中查找元素，返回匹配列表
   */
  async function findElements(evalInPage, findBy, value, opts) {
    opts = opts || {};
    var code = "(function() {" +
      "  var findBy = " + JSON.stringify(findBy) + ";" +
      "  var val = " + JSON.stringify(value) + ";" +
      "  var tagFilter = " + JSON.stringify(opts.tag || "") + ";" +
      "  var visibleOnly = " + (opts.visibleOnly !== false) + ";" +
      "  var els = [];" +
      "  function visible(el){for(var p=el;p&&p!==document.documentElement;p=p.parentElement){var st=getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||st.display==='none'||st.visibility==='hidden'||st.contentVisibility==='hidden')return false;}var r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<window.innerHeight&&r.right>0;}" +
      "  if (findBy === 'text') {" +
      "    var semantic='a,button,input,select,textarea,label,li,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=treeitem],[tabindex],[onclick]';" +
      "    els=Array.prototype.slice.call(document.querySelectorAll(semantic)).filter(function(node){var t=(node.textContent||node.value||'').replace(/\\s+/g,' ').trim();return t&&t.length<=160&&(t===val||t.indexOf(val)!==-1);});" +
      "    if(!els.length){var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT),node,scanned=0;while((node=walker.nextNode())&&els.length<10&&scanned++<8000){var text=(node.textContent||'').replace(/\\s+/g,' ').trim();if(text&&(text===val||(node.children.length<=5&&text.length<=100&&text.indexOf(val)!==-1)))els.push(node);}}" +
      "  } else if (findBy === 'text_contains') {" +
      "    els = Array.from(document.querySelectorAll(tagFilter || '*')).filter(function(el) {" +
      "      if (el.children.length > 5) return false;" +
      "      var t = (el.textContent || '').trim();" +
      "      return t && t.indexOf(val) !== -1;" +
      "    });" +
      "  } else if (findBy === 'placeholder') {" +
      "    els = Array.from(document.querySelectorAll('input, textarea')).filter(function(el) {" +
      "      return el.placeholder && el.placeholder.indexOf(val) !== -1;" +
      "    });" +
      "  } else if (findBy === 'selector') {" +
      "    els = Array.from(document.querySelectorAll(val));" +
      "  } else if (findBy === 'class') {" +
      "    els = Array.from(document.querySelectorAll('.' + val));" +
      "  } else if (findBy === 'attr') {" +
      "    var parts = val.split('=');" +
      "    var attrName = parts[0].trim();" +
      "    var attrVal = parts[1] ? parts[1].trim().replace(/^[\"']|[\"']$/g, '') : '';" +
      "    els = Array.from(document.querySelectorAll('[' + attrName + ']')).filter(function(el) {" +
      "      return !attrVal || el.getAttribute(attrName) === attrVal;" +
      "    });" +
      "  } else if (findBy === 'label') {" +
      "    els = Array.from(document.querySelectorAll('input, textarea, select, [role=\"combobox\"], [role=\"checkbox\"], [role=\"radio\"]')).filter(function(el) {" +
      "      var txt = '';" +
      "      if (el.id) { var lb = document.querySelector('label[for=\"' + CSS.escape(el.id) + '\"]'); if (lb) txt += ' ' + lb.textContent; }" +
      "      var wrap = el.closest('label,.el-form-item,.ant-form-item,.form-item,.MuiFormControl-root,.v-input,.q-field');" +
      "      if (wrap) txt += ' ' + wrap.textContent;" +
      "      txt += ' ' + (el.getAttribute('aria-label') || el.name || el.placeholder || '');" +
      "      return txt.replace(/\\s+/g, ' ').trim().indexOf(val) !== -1;" +
      "    });" +
      "  }" +
      "  var results = els.slice(0, 10).map(function(el) {" +
      "    var r = el.getBoundingClientRect();" +
      "    var sel = '';" +
      "    if (el.id) sel = '#' + el.id;" +
      "    else if (el.className && typeof el.className === 'string') {" +
      "      var c = el.className.trim().split(/\\s+/);" +
      "      if (c.length) sel = '.' + c.join('.');" +
      "    }" +
      "    if (!sel) sel = el.tagName.toLowerCase();" +
      "    var vis = visible(el);" +
      "    return {tag: el.tagName, id: el.id, " +
      "      class: (typeof el.className==='string'?el.className:'').substring(0,100)," +
      "      text: (el.textContent||'').substring(0,80).trim()," +
      "      x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)," +
      "      width: Math.round(r.width), height: Math.round(r.height)," +
      "      visible: vis, selector: sel, disabled: el.disabled || false};" +
      "  });" +
      "  if (visibleOnly) results = results.filter(function(r) { return r.visible; });" +
      "  return JSON.stringify(results);" +
      "})()";
    var resp = await evalInPage(code);
    if (!resp || !resp.ok) return [];
    try { return JSON.parse(resp.result || "[]"); } catch (e) { return []; }
  }

  async function waitForElement(evalInPage, findBy, value, opts) {
    for (var i = 0; i < FIND_RETRY; i++) {
      var els = await findElements(evalInPage, findBy, value, opts);
      if (els.length > 0) return els[0];
      await sleep(FIND_RETRY_DELAY);
    }
    return null;
  }

  // 框架无关的下拉框/浮层选择器集合
  var DROPDOWN_SELECTORS = [
    // ARIA 标准（所有无障碍组件库通用）
    '[role="listbox"]:not([hidden])',
    '[role="combobox"]:not([hidden])',
    '[role="menu"]:not([hidden])',
    '[role="tree"]:not([hidden])',
    '[aria-modal="false"][class*="overlay"]:not([hidden])',
    '[class*="menu"]:not([style*="display: none"]):not(.hidden)',
    '[class*="listbox"]:not([style*="display: none"]):not(.hidden)',
    // Element UI
    '.el-select-dropdown:not(.hidden):not([style*="display: none"])',
    '.el-select__popper:not([style*="display: none"])',
    '.el-popper:not([style*="display: none"])',
    // Element UI cascader（浮层通常挂在 body，不属于触发器 DOM 子树）
    '.el-cascader__dropdown:not([style*="display: none"])',
    '.el-cascader__panel:not([style*="display: none"])',
    // Ant Design
    '.ant-select-dropdown:not(.hidden):not([style*="display: none"])',
    // Vuetify
    '.v-list[role="listbox"]',
    '.v-select__list',
    // Quasar
    '.q-menu:not(.q-menu--dark)',
    // Bootstrap
    '.dropdown-menu.show',
    // Material-UI
    '.MuiMenu-list',
    '.MuiAutocomplete-listbox',
    // 通用浮层（z-index 高且可见的绝对/固定定位元素）
    '[class*="dropdown"]:not([style*="display: none"]):not(.hidden)',
    '[class*="popup"]:not([style*="display: none"]):not(.hidden)',
    '[class*="popover"]:not([style*="display: none"]):not(.hidden)'
  ];

  var OPTION_SELECTORS = [
    // ARIA 标准
    '[role="option"]',
    '[role="menuitem"]',
    '[role="treeitem"]',
    // Element UI
    '.el-select-dropdown__item',
    '.el-cascader-node',
    // Ant Design
    '.ant-select-item',
    '.ant-select-item-option',
    // Vuetify
    '.v-list-item',
    // Quasar
    '.q-item',
    // Bootstrap
    '.dropdown-item',
    // Material-UI
    '.MuiMenuItem-root',
    '.MuiAutocomplete-option',
    // 通用
    'li[class*="option"]',
    'li[class*="item"]'
  ];

  var TRIGGER_SELECTORS = [
    // ARIA
    '[role="combobox"]',
    '[role="listbox"]',
    '[aria-haspopup="listbox"]',
    '[aria-haspopup="menu"]',
    '[aria-haspopup="tree"]',
    // Element UI
    '.el-select',
    '.el-select .el-input__inner',
    '.el-cascader',
    '.el-cascader .el-input__inner',
    // Ant Design
    '.ant-select',
    '.ant-select-selection',
    // Vuetify
    '.v-select',
    '.v-select__slot',
    // Quasar
    '.q-select',
    '.q-field__native',
    // Bootstrap
    '.dropdown-toggle',
    // Material-UI
    '.MuiSelect-select',
    '.MuiAutocomplete-inputRoot',
    // 通用
    'input[readonly]',
    'input[role="combobox"]',
    '[data-state][aria-expanded]',
    '[class*="select"]:not([class*="selected"])'
  ];

  async function getPageState(evalInPage) {
    var code = "(function() {" +
      "  function visible(el){if(!el)return false;for(var p=el;p&&p!==document.documentElement;p=p.parentElement){var s=getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden'||s.contentVisibility==='hidden'||parseFloat(s.opacity)===0)return false;}var r=el.getBoundingClientRect();return r.width>0&&r.height>0;}" +
      "  function firstVisible(selector){var all=document.querySelectorAll(selector);for(var i=0;i<all.length;i++){if(visible(all[i]))return all[i];}return null;}" +
      "  var dialog = firstVisible('[role=\"dialog\"],[aria-modal=\"true\"],dialog[open],[class*=\"dialog\"],[class*=\"modal\"],[class*=\"drawer\"]');" +
      "  var ddSels = " + JSON.stringify(DROPDOWN_SELECTORS) + ";" +
      "  var dropdown = null;" +
      "  for (var i = 0; i < ddSels.length; i++) {" +
      "    dropdown = firstVisible(ddSels[i]);" +
      "    if (dropdown) break;" +
      "  }" +
      "  var msg = firstVisible('[role=\"alert\"],[aria-live=\"assertive\"],[class*=\"message\"],[class*=\"toast\"],[class*=\"notification\"]');" +
      "  var mask = firstVisible('[role=\"progressbar\"],[aria-busy=\"true\"],[class*=\"loading\"],[class*=\"spinner\"],[class*=\"skeleton\"]');" +
      "  return JSON.stringify({" +
      "    dialog: !!dialog, dialogText: dialog ? dialog.textContent.substring(0, 150).trim() : ''," +
      "    dropdown: !!dropdown, dropdownText: dropdown ? dropdown.textContent.substring(0, 150).trim() : ''," +
      "    message: !!msg, messageText: msg ? msg.textContent.substring(0, 100).trim() : ''," +
      "    loading: !!mask" +
      "  });" +
      "})()";
    var resp = await evalInPage(code);
    if (!resp || !resp.ok) return {};
    try { return JSON.parse(resp.result || "{}"); } catch (e) { return {}; }
  }

  async function waitForLoading(evalInPage, timeout) {
    timeout = timeout || 5000;
    var start = Date.now();
    var sawLoading = false;
    var quietPolls = 0;
    while (Date.now() - start < timeout) {
      var state = await getPageState(evalInPage);
      if (state.loading) {
        sawLoading = true;
        quietPolls = 0;
      } else {
        quietPolls++;
        // 请求可能没有 loading UI；至少观察两个稳定轮次，避免点击后立即误判完成。
        if ((sawLoading && quietPolls >= 1) || (!sawLoading && quietPolls >= 3)) return true;
      }
      await sleep(120);
    }
    return false;
  }

  async function waitForSettledPage(evalInPage, timeout) {
    timeout = timeout || 2500;
    var start = Date.now();
    var lastSignature = "";
    var stablePolls = 0;
    while (Date.now() - start < timeout) {
      var state = await getPageState(evalInPage);
      var signature = [state.dialog, state.dropdown, state.loading, state.message, state.dialogText, state.dropdownText].join("|");
      if (!state.loading && signature === lastSignature) stablePolls++;
      else stablePolls = 0;
      if (stablePolls >= 2) return state;
      lastSignature = signature;
      await sleep(100);
    }
    return await getPageState(evalInPage);
  }

  var templates = {};

  // 模板 1: select_option — 下拉框选择单个选项（框架无关）
  templates.select_option = async function (deps, params) {
    var evalInPage = deps.evalInPage;
    var vc = global.AIFT_VisualController;
    if (!evalInPage || !vc) return { ok: false, result: "依赖不可用" };

    var triggerFindBy = params.trigger && params.trigger.findBy;
    var triggerValue = params.trigger && params.trigger.value;
    var optionFindBy = (params.option && params.option.findBy) || "text";
    var optionValue = params.option && params.option.value;
    var sourceInteraction = findSourceInteraction(deps, params.trigger);
    var trigger = null;

    // ===== 步骤1: 定位下拉框触发器 =====
    // 策略A: 原生 <select> 元素
    var nativeSelectCode = "(function() {" +
      "  var val = " + JSON.stringify(triggerValue) + ";" +
      "  var selects = document.querySelectorAll('select');" +
      "  for (var i = 0; i < selects.length; i++) {" +
      "    var r = selects[i].getBoundingClientRect();" +
      "    if (r.width === 0 || r.height === 0) continue;" +
      "    // 匹配：select 的 id/name/aria-label/相邻 label 文本" +
      "    var label = selects[i].id || selects[i].name || selects[i].getAttribute('aria-label') || '';" +
      "    var sib = selects[i].previousElementSibling;" +
      "    if (sib) label += ' ' + (sib.textContent || '').trim();" +
      "    if (label.indexOf(val) !== -1) {" +
      "      return JSON.stringify({tag:'select', nativeSelect:true, nativeIndex:i, x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), selector:selects[i].id ? ('#' + CSS.escape(selects[i].id)) : 'select'});" +
      "    }" +
      "  }" +
      "  return 'null';" +
      "})()";
    var nativeResp = await evalInPage(nativeSelectCode);
    if (nativeResp && nativeResp.ok && nativeResp.result && nativeResp.result !== "null") {
      try { trigger = JSON.parse(nativeResp.result); } catch(e) {}
    }

    // 策略B: 已知 UI 框架的 select 组件容器内查找
    // 关键修复：优先匹配 input 元素（el.value 精确匹配），而非容器（textContent 模糊匹配）。
    // 之前的逻辑遍历 TRIGGER_SELECTORS，'.el-select' 容器排在 '.el-select .el-input__inner' 前面，
    // 导致容器的 textContent（包含所有子元素文本）先匹配，返回容器中心坐标而非 input 坐标。
    // 当页面上有多个 el-select 时，容器的 textContent 可能包含其他下拉框的文本，导致误匹配。
    if (!trigger && (triggerFindBy === 'text' || triggerFindBy === 'text_contains')) {
      var fwTriggerCode = "(function() {" +
        "  var val = " + JSON.stringify(triggerValue) + ";" +
        "  var trigs = " + JSON.stringify(TRIGGER_SELECTORS) + ";" +
        "  // 第一轮：优先匹配 input 元素的 value 属性（精确度高）" +
        "  var inputTrigs = trigs.filter(function(s) { return s.indexOf('input') !== -1 || s.indexOf('selection') !== -1; });" +
        "  for (var t = 0; t < inputTrigs.length; t++) {" +
        "    var els = document.querySelectorAll(inputTrigs[t]);" +
        "    for (var i = 0; i < els.length; i++) {" +
        "      var el = els[i];" +
        "      var text = (el.value || '').trim();" +
        "      var ph = (el.placeholder || el.getAttribute('aria-label') || '').trim();" +
        "      if (text === val || ph === val || text.indexOf(val) !== -1 || ph.indexOf(val) !== -1) {" +
        "        var r = el.getBoundingClientRect();" +
        "        if (r.width === 0 || r.height === 0) continue;" +
        "        return JSON.stringify({tag:el.tagName, x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), text:text.substring(0,80)});" +
        "      }" +
        "    }" +
        "  }" +
        "  // 第二轮：回退到容器元素（textContent 模糊匹配）" +
        "  for (var t2 = 0; t2 < trigs.length; t2++) {" +
        "    var els2 = document.querySelectorAll(trigs[t2]);" +
        "    for (var i2 = 0; i2 < els2.length; i2++) {" +
        "      var el2 = els2[i2];" +
        "      var text2 = (el2.value || el2.textContent || '').trim();" +
        "      var ph2 = (el2.placeholder || el2.getAttribute('aria-label') || '').trim();" +
        "      if (text2.indexOf(val) !== -1 || ph2.indexOf(val) !== -1) {" +
        "        var r2 = el2.getBoundingClientRect();" +
        "        if (r2.width === 0 || r2.height === 0) continue;" +
        "        return JSON.stringify({tag:el2.tagName, x:Math.round(r2.x+r2.width/2), y:Math.round(r2.y+r2.height/2), text:text2.substring(0,80)});" +
        "      }" +
        "    }" +
        "  }" +
        "  return 'null';" +
        "})()";
      var fwResp = await evalInPage(fwTriggerCode);
      if (fwResp && fwResp.ok && fwResp.result && fwResp.result !== "null") {
        try { trigger = JSON.parse(fwResp.result); } catch(e) {}
      }
    }

    // 策略C: 通用查找（findBy + value）
    if (!trigger) {
      trigger = await waitForElement(evalInPage, triggerFindBy, triggerValue, { visibleOnly: true });
    }
    if (!trigger) return { ok: false, result: "未找到下拉框: " + triggerFindBy + "=" + triggerValue };

    await vc.ensureAttached(deps.tabId);
    if (trigger.nativeSelect) {
      var nativeResult = await selectNativeOption(evalInPage, vc, trigger, optionValue, optionFindBy);
      nativeResult.pageState = await getPageState(evalInPage);
      return nativeResult;
    }

    // ===== 步骤3: 关闭已有下拉框，重新点击触发器 =====
    // 关键修复：always close existing dropdowns first, then click trigger.
    // 之前的 alreadyOpen 优化有缺陷：它检测到任意下拉框已展开就跳过点击触发器，
    // 但那个已展开的下拉框可能属于另一个 el-select 组件（页面上有多个下拉框），
    // 导致在错误的下拉框中搜索选项，永远找不到目标选项。
    await dismissFloatingOrEscape(evalInPage, vc);
    await sleep(150);

    // 点击触发器打开正确的下拉框
    await vc.mouseClick(trigger.x, trigger.y);
    await sleep(STEP_DELAY + 300);

    // ===== 步骤4: 在浮层内查找并点击选项（带重试） =====
    var optionEl = null;

    // 通用查找代码：在所有已知 dropdown 容器内搜索匹配选项，只返回坐标，实际点击由 CDP 完成。
    var findAndClickOption = "(function() {" +
      "  var val = " + JSON.stringify(optionValue) + ";" +
      "  var findBy = " + JSON.stringify(optionFindBy) + ";" +
      "  var ordinal = " + (optionOrdinal(optionValue) === null ? "null" : String(optionOrdinal(optionValue))) + ";" +
      "  var ddSels = " + JSON.stringify(DROPDOWN_SELECTORS) + ";" +
      "  var optSels = " + JSON.stringify(OPTION_SELECTORS) + ";" +
      "  function isVisible(el) {" +
      "    var r = el.getBoundingClientRect();" +
      "    var st = getComputedStyle(el);" +
      "    return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity) !== 0 && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;" +
      "  }" +
      "  function score(el, text) {" +
      "    var s = 0, cls = (typeof el.className === 'string') ? el.className : '';" +
      "    if (text === val) s += 100;" +
      "    if (el.getAttribute('role') === 'option') s += 20;" +
      "    if (/option|item|menu/i.test(cls)) s += 10;" +
      "    if (el.getAttribute('aria-selected') === 'true' || cls.indexOf('selected') !== -1 || cls.indexOf('is-selected') !== -1) s -= 5;" +
      "    return s;" +
      "  }" +
      "  function matchText(t, val, findBy) {" +
      "    if (findBy === 'text') return t === val;" +
      "    if (findBy === 'text_contains') return t.indexOf(val) !== -1;" +
      "    return t === val || t.indexOf(val) !== -1;" +
      "  }" +
      "  // 收集所有匹配的选项" +
      "  var matches = [];" +
      "  for (var d = 0; d < ddSels.length; d++) {" +
      "    var dds = document.querySelectorAll(ddSels[d]);" +
      "    for (var di = 0; di < dds.length; di++) {" +
      "      if (!isVisible(dds[di])) continue;" +
      "      for (var o = 0; o < optSels.length; o++) {" +
      "        var items = dds[di].querySelectorAll(optSels[o]);" +
      "        for (var k = 0; k < items.length; k++) {" +
      "          var t = (items[k].textContent || '').trim();" +
      "          if (matchText(t, val, findBy) && isVisible(items[k])) {" +
      "            var r = items[k].getBoundingClientRect();" +
      "            matches.push({el: items[k], text: t, score: score(items[k], t), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});" +
      "          }" +
      "        }" +
      "      }" +
      "      // 容器内没有匹配的 option 元素，尝试所有子元素" +
      "      var all = dds[di].querySelectorAll('li, div, span, a');" +
      "      for (var j = 0; j < all.length; j++) {" +
      "        var at = (all[j].textContent || '').trim();" +
      "        if (matchText(at, val, findBy) && isVisible(all[j]) && all[j].children.length <= 2) {" +
      "          var r2 = all[j].getBoundingClientRect();" +
      "          matches.push({el: all[j], text: at, score: score(all[j], at), x: Math.round(r2.x + r2.width/2), y: Math.round(r2.y + r2.height/2)});" +
      "        }" +
      "      }" +
      "    }" +
      "  }" +
      "  if (matches.length === 0) return 'null';" +
      "  matches.sort(function(a,b){ return b.score - a.score; });" +
      "  var best = matches[0];" +
      "  return JSON.stringify({tag: best.el.tagName, text: best.text.substring(0, 80), x: best.x, y: best.y, jsClicked: false});" +
      "})()";

    var findOrdinalOption = "(function() {" +
      "  var ordinal = " + (optionOrdinal(optionValue) === null ? "null" : String(optionOrdinal(optionValue))) + ";" +
      "  if (ordinal === null) return 'null';" +
      "  var ddSels = " + JSON.stringify(DROPDOWN_SELECTORS) + ";" +
      "  var optSels = " + JSON.stringify(OPTION_SELECTORS) + ";" +
      "  function isVisible(el){var r=el.getBoundingClientRect();var st=getComputedStyle(el);return st.display!=='none'&&st.visibility!=='hidden'&&parseFloat(st.opacity)!==0&&r.width>0&&r.height>0&&r.bottom>0&&r.top<window.innerHeight;}" +
      "  var items=[];" +
      "  for(var d=0;d<ddSels.length;d++){var dds=document.querySelectorAll(ddSels[d]);for(var di=0;di<dds.length;di++){if(!isVisible(dds[di]))continue;for(var o=0;o<optSels.length;o++){var its=dds[di].querySelectorAll(optSels[o]);for(var k=0;k<its.length;k++){if(isVisible(its[k])&&its[k].getAttribute('aria-disabled')!=='true'&&!its[k].classList.contains('disabled'))items.push(its[k]);}}}}" +
      "  if(!items[ordinal])return 'null';" +
      "  var el=items[ordinal],r=el.getBoundingClientRect();" +
      "  return JSON.stringify({tag:el.tagName,text:(el.textContent||'').trim().substring(0,80),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),ordinal:true});" +
      "})()";

    // 层级选项可能需要父节点 hover 后才渲染子节点。选择器来自源码契约，
    // 这里不依赖任何组件库的实现 class。
    var findExpandableParents = sourceInteraction ? "(function(){var nodeSel=" + JSON.stringify(sourceInteraction.nodeSelector) + ",expandSel=" + JSON.stringify(sourceInteraction.expandableSelector) + ";function v(el){var r=el.getBoundingClientRect(),s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;}var a=Array.from(document.querySelectorAll(nodeSel)).filter(function(n){return v(n)&&(n.matches(expandSel)||n.querySelector(expandSel));}).map(function(n){var r=n.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:(n.textContent||'').trim().substring(0,80)};});return JSON.stringify(a.slice(0,20));})()" : null;

    // 策略B: 通用查找（排除表格/表头等非浮层元素），只返回坐标。
    var genericCode = "(function() {" +
      "  var val = " + JSON.stringify(optionValue) + ";" +
      "  var findBy = " + JSON.stringify(optionFindBy) + ";" +
      "  // 查找所有可见的、文本匹配的叶子元素，排除表格相关元素" +
      "  var els = Array.from(document.querySelectorAll('[role=\"option\"], li, a, span, div')).filter(function(el) {" +
      "    if (el.children.length > 2) return false;" +
      "    var t = (el.textContent || '').trim();" +
      "    if (!t || t.length > 80) return false;" +
      "    var matched = (findBy === 'text') ? t === val : t.indexOf(val) !== -1;" +
      "    if (!matched) return false;" +
      "    var r = el.getBoundingClientRect();" +
      "    if (r.width === 0 || r.height === 0) return false;" +
      "    // 排除表格单元格、表头" +
      "    var tag = el.tagName.toLowerCase();" +
      "    if (tag === 'td' || tag === 'th') return false;" +
      "    var cls = (typeof el.className === 'string') ? el.className : '';" +
      "    if (cls.indexOf('el-table') !== -1 || cls.indexOf('cell') !== -1) return false;" +
      "    // 检查是否在浮层/下拉容器内" +
      "    var parent = el.parentElement;" +
      "    var inDropdown = false;" +
      "    for (var p = 0; p < 10 && parent; p++) {" +
      "      var pc = (typeof parent.className === 'string') ? parent.className : '';" +
      "      if (pc.indexOf('dropdown') !== -1 || pc.indexOf('popper') !== -1 || pc.indexOf('popup') !== -1 || pc.indexOf('menu') !== -1 || pc.indexOf('listbox') !== -1 || parent.getAttribute('role') === 'listbox') { inDropdown = true; break; }" +
      "      parent = parent.parentElement;" +
      "    }" +
      "    return inDropdown;" +
      "  });" +
      "  if (els.length > 0) {" +
      "    var r = els[0].getBoundingClientRect();" +
      "    return JSON.stringify({tag:els[0].tagName, text:(els[0].textContent||'').trim().substring(0,80), x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), jsClicked:false});" +
      "  }" +
      "  return 'null';" +
      "})()";

    // 重试循环：下拉框可能需要时间渲染，尝试 3 次
    // P3 修复：每次重试引入不同策略，避免重复相同的失败路径
    for (var retry = 0; retry < 3 && !optionEl; retry++) {
      if (retry > 0) {
        // 重试前重新点击触发器（下拉框可能已关闭）
        await dismissFloatingOrEscape(evalInPage, vc);
        await sleep(100);
        // P3: 第2次重试时先滚动到触发器，确保不在视口外
        if (retry === 1) {
          var scrollCode = "(function(){" +
            "  var el = document.elementFromPoint(" + trigger.x + ", " + trigger.y + ");" +
            "  if (el) el.scrollIntoView({block:'center', behavior:'instant'});" +
            "  return 'ok';" +
            "})()";
          await evalInPage(scrollCode);
          await sleep(100);
        }
        await vc.mouseClick(trigger.x, trigger.y);
        await sleep(STEP_DELAY + 200);
      }

      // 策略A: 在 dropdown 容器内查找
      var optResp = await evalInPage(findAndClickOption);
      if (optResp && optResp.ok && optResp.result && optResp.result !== "null") {
        try { optionEl = JSON.parse(optResp.result); } catch(e) {}
      }

      if (!optionEl && sourceInteraction && sourceInteraction.reveal === "hover" && vc.mouseHover) {
        var parentResp = await evalInPage(findExpandableParents);
        var parents = [];
        if (parentResp && parentResp.ok && parentResp.result) { try { parents = JSON.parse(parentResp.result) || []; } catch(e) {} }
        for (var pi = 0; pi < parents.length && !optionEl; pi++) {
          await vc.mouseHover(parents[pi].x, parents[pi].y);
          await sleep(120);
          var revealedResp = await evalInPage(findAndClickOption);
          if (revealedResp && revealedResp.ok && revealedResp.result && revealedResp.result !== "null") {
            try { optionEl = JSON.parse(revealedResp.result); } catch(e) {}
          }
        }
      }

      // 策略A2: “第二个选项”等自然语言索引
      if (!optionEl) {
        var ordResp = await evalInPage(findOrdinalOption);
        if (ordResp && ordResp.ok && ordResp.result && ordResp.result !== "null") {
          try { optionEl = JSON.parse(ordResp.result); } catch(e) {}
        }
      }

      // 策略B: 通用查找
      if (!optionEl) {
        var genResp = await evalInPage(genericCode);
        if (genResp && genResp.ok && genResp.result && genResp.result !== "null") {
          try { optionEl = JSON.parse(genResp.result); } catch(e) {}
        }
      }

      if (!optionEl) await sleep(200);
    }

    if (!optionEl) {
      // 诊断信息：列出所有可见 dropdown 容器及其选项文本
      var diagCode = "(function() {" +
        "  var ddSels = " + JSON.stringify(DROPDOWN_SELECTORS) + ";" +
        "  var optSels = " + JSON.stringify(OPTION_SELECTORS) + ";" +
        "  var diags = [];" +
        "  for (var d = 0; d < ddSels.length; d++) {" +
        "    var dds = document.querySelectorAll(ddSels[d]);" +
        "    for (var di = 0; di < dds.length; di++) {" +
        "      var r = dds[di].getBoundingClientRect();" +
        "      if (r.width === 0 || r.height === 0) continue;" +
        "      var texts = [];" +
        "      for (var o = 0; o < optSels.length; o++) {" +
        "        var items = dds[di].querySelectorAll(optSels[o]);" +
        "        for (var k = 0; k < items.length; k++) {" +
        "          var ir = items[k].getBoundingClientRect();" +
        "          if (ir.width > 0 && ir.height > 0) texts.push(items[k].textContent.trim());" +
        "        }" +
        "      }" +
        "      if (texts.length > 0) diags.push(ddSels[d] + ': [' + texts.join(', ') + ']');" +
        "    }" +
        "  }" +
        "  return diags.length > 0 ? diags.join(' | ') : '无可见 dropdown 容器';" +
        "})()";
      var diagResp = await evalInPage(diagCode);
      var diagInfo = (diagResp && diagResp.ok && diagResp.result) ? diagResp.result : '诊断失败';
      await dismissFloatingOrEscape(evalInPage, vc);
      return { ok: false, result: "下拉已展开但未找到选项: " + optionValue + "（重试3次）。可见下拉框内容: " + diagInfo };
    }

    // 页面内只负责定位，实际选择用 CDP 真实鼠标点击。
    if (optionEl.x && optionEl.y) {
      var optionClick = await vc.clickAtPoint(evalInPage, optionEl.x, optionEl.y, sourceInteraction || undefined);
      if (!optionClick.ok) {
        return { ok: false, result: "选项点击未生效: " + (optionClick.error || "未命中可操作控件"), pageState: await getPageState(evalInPage) };
      }
    }
    await waitForSettledPage(evalInPage);
    var expectedOptionText = (optionOrdinal(optionValue) !== null && optionEl && optionEl.text) ? optionEl.text : optionValue;

    // ===== 步骤5: 验证选择是否生效 =====
    var verifyCode = "(function() {" +
      "  var tx = " + trigger.x + ", ty = " + trigger.y + ";" +
      "  // 检查原生 select" +
      "  var selects = document.querySelectorAll('select');" +
      "  for (var i = 0; i < selects.length; i++) {" +
      "    var r = selects[i].getBoundingClientRect();" +
      "    if (Math.abs(r.x + r.width/2 - tx) < 100 && Math.abs(r.y + r.height/2 - ty) < 100) {" +
      "      return JSON.stringify({value: (selects[i].options[selects[i].selectedIndex] || {}).text || '', type:'native'});" +
      "    }" +
      "  }" +
      "  // 检查 ARIA combobox" +
      "  var combos = document.querySelectorAll('[role=\"combobox\"], [role=\"textbox\"]');" +
      "  for (var j = 0; j < combos.length; j++) {" +
      "    var cr = combos[j].getBoundingClientRect();" +
      "    if (Math.abs(cr.x + cr.width/2 - tx) < 100 && Math.abs(cr.y + cr.height/2 - ty) < 100) {" +
      "      return JSON.stringify({value: (combos[j].value || combos[j].textContent || '').trim(), type:'aria'});" +
      "    }" +
      "  }" +
      "  // 检查已知框架 select 组件" +
      "  var fwSels = document.querySelectorAll('.el-select, .el-cascader, .ant-select, .v-select, .q-select, .MuiSelect-root');" +
      "  for (var k = 0; k < fwSels.length; k++) {" +
      "    var fr = fwSels[k].getBoundingClientRect();" +
      "    if (Math.abs(fr.x + fr.width/2 - tx) < 100 && Math.abs(fr.y + fr.height/2 - ty) < 100) {" +
      "      var input = fwSels[k].querySelector('input, .ant-select-selection-item, .v-select__selection, .q-field__native');" +
      "      var tags = Array.from(fwSels[k].querySelectorAll('.el-cascader__tags .el-tag, .el-cascader__tags .el-tag__content')).map(function(n){return (n.textContent||'').trim();}).filter(Boolean);" +
      "      return JSON.stringify({value: tags.length ? tags.join(' / ') : (input ? (input.value || input.textContent || '').trim() : ''), type:'framework'});" +
      "    }" +
      "  }" +
      "  return 'null';" +
      "})()";
    var verifyResp = await evalInPage(verifyCode);
    var verifyValue = null;
    if (verifyResp && verifyResp.ok && verifyResp.result && verifyResp.result !== "null") {
      try { verifyValue = JSON.parse(verifyResp.result); } catch(e) {}
    }

    var state = await getPageState(evalInPage);
    if (state.dropdown) { await sleep(200); state = await getPageState(evalInPage); }

    // 如果验证发现值未改变，用 CDP 坐标重新点击选项
    if (verifyValue && verifyValue.value && verifyValue.value.indexOf(expectedOptionText) === -1) {
      if (optionEl.x && optionEl.y) {
        // 重新打开下拉框
        await dismissFloatingOrEscape(evalInPage, vc);
        await sleep(100);
        await vc.mouseClick(trigger.x, trigger.y);
        await sleep(STEP_DELAY + 200);
        // 用 CDP 真实鼠标点击选项坐标
        var retryOptionClick = await vc.clickAtPoint(evalInPage, optionEl.x, optionEl.y, sourceInteraction || undefined);
        if (!retryOptionClick.ok) {
          return { ok: false, result: "选项重试点击未生效: " + (retryOptionClick.error || "未命中可操作控件"), pageState: await getPageState(evalInPage) };
        }
        await waitForSettledPage(evalInPage);
        // 重新验证
        var verifyResp2 = await evalInPage(verifyCode);
        if (verifyResp2 && verifyResp2.ok && verifyResp2.result && verifyResp2.result !== "null") {
          try { verifyValue = JSON.parse(verifyResp2.result); } catch(e) {}
        }
        state = await getPageState(evalInPage);
        if (state.dropdown) { await sleep(200); state = await getPageState(evalInPage); }
      }
      // 如果仍然未生效，返回警告
      if (verifyValue && verifyValue.value && verifyValue.value.indexOf(expectedOptionText) === -1) {
        return { ok: false, result: "下拉选择可能未生效：期望选择\"" + expectedOptionText + "\"，但当前值为\"" + verifyValue.value + "\"", pageState: state };
      }
    }

    return { ok: true, result: "下拉选择成功: " + expectedOptionText, pageState: state };
  };

  // 模板 2: select_multi — 多选下拉框选择多个选项（框架无关）
  templates.select_multi = async function (deps, params) {
    var evalInPage = deps.evalInPage;
    var vc = global.AIFT_VisualController;
    if (!evalInPage || !vc) return { ok: false, result: "依赖不可用" };

    var triggerValue = params.trigger && params.trigger.value;
    var wantedValues = (params.options || []).map(function(o){ return o.value; });
    var sourceInteraction = findSourceInteraction(deps, params.trigger);
    var trigger = null;

    // 定位触发器
    var nativeTrigCode = "(function(){" +
      "var v=" + JSON.stringify(triggerValue) + ";" +
      "var s=document.querySelectorAll('select[multiple]');" +
      "for(var i=0;i<s.length;i++){var lbl=s[i].id||s[i].name||s[i].getAttribute('aria-label')||'';" +
      "var sib=s[i].previousElementSibling;if(sib)lbl+=' '+(sib.textContent||'').trim();" +
      "if(lbl.indexOf(v)!==-1){var r=s[i].getBoundingClientRect();return JSON.stringify({nativeSelect:true,nativeIndex:i,tag:'select',selector:s[i].id?('#'+CSS.escape(s[i].id)):'select[multiple]',x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}" +
      "return 'null';})()";
    var ntResp = await evalInPage(nativeTrigCode);
    if (ntResp && ntResp.ok && ntResp.result && ntResp.result !== "null") {
      try { trigger = JSON.parse(ntResp.result); } catch(e) {}
    }
    if (!trigger) {
      // 尝试在已知框架的 select 容器内查找
      var fwTrigCode = "(function(){var v=" + JSON.stringify(triggerValue) + ";" +
        "var trigs=" + JSON.stringify(TRIGGER_SELECTORS) + ";" +
        "for(var t=0;t<trigs.length;t++){var els=document.querySelectorAll(trigs[t]);" +
        "for(var i=0;i<els.length;i++){var el=els[i];var text=(el.value||el.textContent||'').trim();" +
        "var ph=(el.placeholder||el.getAttribute('aria-label')||'').trim();" +
        "if(text.indexOf(v)!==-1||ph.indexOf(v)!==-1){var r=el.getBoundingClientRect();" +
        "if(r.width===0||r.height===0)continue;" +
        "return JSON.stringify({tag:el.tagName,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}}" +
        "return 'null';})()";
      var fwResp = await evalInPage(fwTrigCode);
      if (fwResp && fwResp.ok && fwResp.result && fwResp.result !== "null") {
        try { trigger = JSON.parse(fwResp.result); } catch(e) {}
      }
    }
    if (!trigger) trigger = await waitForElement(evalInPage, params.trigger.findBy, triggerValue, { visibleOnly: true });
    if (!trigger) return { ok: false, result: "未找到下拉框: " + triggerValue };

    await vc.ensureAttached(deps.tabId);
    if (trigger.nativeSelect) {
      var nativeMultiResult = await selectNativeMultiOptions(evalInPage, vc, trigger, wantedValues);
      nativeMultiResult.pageState = await getPageState(evalInPage);
      return nativeMultiResult;
    }

    // 关键修复：always close existing dropdowns first, then click trigger.
    // 与 select_option 相同的修复：不检查 alreadyOpen，直接关闭已有下拉再重新点击触发器。
    await dismissFloatingOrEscape(evalInPage, vc);
    await sleep(150);

    await vc.mouseClick(trigger.x, trigger.y);
    await sleep(STEP_DELAY + 200);

    // 在浮层内逐个点击选项
    var selected = [], failed = [], selectedLabels = [];
    var findExpandableParentsForMulti = sourceInteraction ? "(function(){var nodeSel=" + JSON.stringify(sourceInteraction.nodeSelector) + ",expandSel=" + JSON.stringify(sourceInteraction.expandableSelector) + ";function v(el){var r=el.getBoundingClientRect(),s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;}var a=Array.from(document.querySelectorAll(nodeSel)).filter(function(n){return v(n)&&(n.matches(expandSel)||n.querySelector(expandSel));}).map(function(n){var r=n.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};});return JSON.stringify(a.slice(0,20));})()" : null;
    for (var i = 0; i < params.options.length; i++) {
      var opt = params.options[i];
      var findCode = "(function(){var val=" + JSON.stringify(opt.value) + ";" +
        "var findBy=" + JSON.stringify(opt.findBy) + ";" +
        "var ordinal=" + (optionOrdinal(opt.value) === null ? "null" : String(optionOrdinal(opt.value))) + ";" +
        "var ddSels=" + JSON.stringify(DROPDOWN_SELECTORS) + ";" +
        "var optSels=" + JSON.stringify(OPTION_SELECTORS) + ";" +
        "function isV(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0;}" +
        "function mt(t,v,f){if(f==='text')return t===v;return t.indexOf(v)!==-1;}" +
        "var ordinalItems=[];" +
        "for(var d=0;d<ddSels.length;d++){var dds=document.querySelectorAll(ddSels[d]);" +
        "for(var di=0;di<dds.length;di++){if(!isV(dds[di]))continue;" +
        "for(var o=0;o<optSels.length;o++){var its=dds[di].querySelectorAll(optSels[o]);" +
        "for(var k=0;k<its.length;k++){var t=(its[k].textContent||'').trim();" +
        "if(isV(its[k])&&its[k].getAttribute('aria-disabled')!=='true'&&!its[k].classList.contains('disabled'))ordinalItems.push(its[k]);" +
        "if(mt(t,val,findBy)&&isV(its[k])){var r=its[k].getBoundingClientRect();return JSON.stringify({ok:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}}" +
        "var all=dds[di].querySelectorAll('li,div,span,a');" +
        "for(var j=0;j<all.length;j++){var at=(all[j].textContent||'').trim();" +
        "if(mt(at,val,findBy)&&isV(all[j])&&all[j].children.length<=2){var r2=all[j].getBoundingClientRect();return JSON.stringify({ok:true,x:Math.round(r2.x+r2.width/2),y:Math.round(r2.y+r2.height/2)});}}}}" +
        "if(ordinal!==null&&ordinalItems[ordinal]){var oe=ordinalItems[ordinal],or=oe.getBoundingClientRect();return JSON.stringify({ok:true,x:Math.round(or.x+or.width/2),y:Math.round(or.y+or.height/2),text:(oe.textContent||'').trim().substring(0,80)});}" +
        "return JSON.stringify({ok:false});})()";
      var fr = await evalInPage(findCode);
      var ok = false, foundOpt = null;
      if (fr && fr.ok && fr.result) { try { foundOpt = JSON.parse(fr.result); ok = !!foundOpt.ok; } catch(e) {} }
      if (!ok && sourceInteraction && sourceInteraction.reveal === "hover" && vc.mouseHover) {
        var multiParentsResp = await evalInPage(findExpandableParentsForMulti);
        var multiParents = [];
        if (multiParentsResp && multiParentsResp.ok && multiParentsResp.result) { try { multiParents = JSON.parse(multiParentsResp.result) || []; } catch(e) {} }
        for (var mpi = 0; mpi < multiParents.length && !ok; mpi++) {
          await vc.mouseHover(multiParents[mpi].x, multiParents[mpi].y);
          await sleep(120);
          var revealedMultiResp = await evalInPage(findCode);
          if (revealedMultiResp && revealedMultiResp.ok && revealedMultiResp.result) {
            try { foundOpt = JSON.parse(revealedMultiResp.result); ok = !!foundOpt.ok; } catch(e) {}
          }
        }
      }
      if (ok && foundOpt && typeof foundOpt.x === "number" && typeof foundOpt.y === "number") {
        var multiOptionClick = await vc.clickAtPoint(evalInPage, foundOpt.x, foundOpt.y, sourceInteraction || undefined);
        if (!multiOptionClick.ok) {
          ok = false;
        }
      }
      if (ok) {
        selected.push(opt.value);
        selectedLabels.push(foundOpt && foundOpt.text ? foundOpt.text : opt.value);
      } else {
        failed.push(opt.value);
      }
      await waitForSettledPage(evalInPage);
    }

    if (params.closeOnDone !== false) {
      await dismissFloatingOrEscape(evalInPage, vc);
      await waitForSettledPage(evalInPage);
    }

    if (params.applyAfterSelection) {
      if (!sourceInteraction || !sourceInteraction.applySelector) {
        return { ok: false, result: "源码交互契约未声明提交动作，不能自动提交筛选", pageState: await getPageState(evalInPage) };
      }
      var applyResult = await vc.clickBySelector(evalInPage, sourceInteraction.applySelector);
      if (!applyResult.ok) {
        return { ok: false, result: "已选择标签，但提交筛选失败: " + (applyResult.error || sourceInteraction.applySelector), pageState: await getPageState(evalInPage) };
      }
      await waitForLoading(evalInPage);
    }

    var state = await getPageState(evalInPage);
    var verifyMulti = await verifyMultiSelection(evalInPage, trigger, selectedLabels);
    if (failed.length === 0 && selectedLabels.length > 0 && verifyMulti && !verifyMulti.ok) {
      failed = verifyMulti.missing || selectedLabels;
    }
    var result = "多选完成: 成功 " + selected.length + " 个" + (params.applyAfterSelection ? "，已提交筛选" : "");
    if (failed.length > 0) result += "，失败: " + failed.join(", ");
    if (verifyMulti && verifyMulti.text) result += "；当前选中/控件文本: " + verifyMulti.text.substring(0, 160);
    return { ok: failed.length === 0, result: result, pageState: state };
  };

  // 模板 3: fill_input — 输入框输入值
  templates.fill_input = async function (deps, params) {
    var evalInPage = deps.evalInPage;
    var vc = global.AIFT_VisualController;
    if (!evalInPage || !vc) return { ok: false, result: "依赖不可用" };

    var input = await waitForElement(evalInPage, params.input.findBy, params.input.value, { visibleOnly: true });
    if (!input) return { ok: false, result: "未找到输入框: " + params.input.value };
    if (input.disabled) return { ok: false, result: "输入框被禁用: " + params.input.value };

    await vc.ensureAttached(deps.tabId);
    var typeResult = await vc.typeAtPoint(evalInPage, input.x, input.y, params.text || "");
    if (!typeResult.ok) {
      return { ok: false, result: "输入失败: " + (typeResult.error || "验证未通过"), pageState: await getPageState(evalInPage) };
    }
    await sleep(STEP_DELAY);

    var state = await getPageState(evalInPage);
    var current = await vc.readActiveValue(evalInPage);
    var result = "输入完成: " + params.input.value + " -> \"" + (params.text || "").substring(0, 30) + "\"";
    if (current && current.ok) result += "；当前值=\"" + String(current.value).substring(0, 80) + "\"";
    return { ok: true, result: result, pageState: state };
  };

  // 模板 4: click_button — 点击按钮
  templates.click_button = async function (deps, params) {
    var evalInPage = deps.evalInPage;
    var vc = global.AIFT_VisualController;
    if (!evalInPage || !vc) return { ok: false, result: "依赖不可用" };

    var btn = await waitForElement(evalInPage, params.button.findBy, params.button.value, {
      visibleOnly: true, tag: params.button.tag || "button",
    });
    if (!btn) {
      btn = await waitForElement(evalInPage, params.button.findBy, params.button.value, { visibleOnly: true });
    }
    if (!btn) return { ok: false, result: "未找到按钮: " + params.button.value };
    if (btn.disabled) return { ok: false, result: "按钮被禁用: " + params.button.value };

    await vc.ensureAttached(deps.tabId);
    await vc.mouseClick(btn.x, btn.y);
    await sleep(STEP_DELAY);

    var state = await getPageState(evalInPage);
    var waitSatisfied = true;
    if (params.waitFor === "loading") {
      await waitForLoading(evalInPage);
      state = await getPageState(evalInPage);
    } else if (params.waitFor === "dialog") {
      for (var i = 0; i < 5; i++) {
        if (state.dialog) break;
        await sleep(300);
        state = await getPageState(evalInPage);
      }
      waitSatisfied = !!state.dialog;
    } else if (params.waitFor === "message") {
      for (var i = 0; i < 5; i++) {
        if (state.message) break;
        await sleep(300);
        state = await getPageState(evalInPage);
      }
      waitSatisfied = !!state.message;
    } else if (params.waitFor === "dropdown") {
      for (var di = 0; di < 5; di++) {
        if (state.dropdown) break;
        await sleep(200);
        state = await getPageState(evalInPage);
      }
      waitSatisfied = !!state.dropdown;
    }

    if (!waitSatisfied) {
      var diag = await getPointDiagnostics(evalInPage, btn.x, btn.y);
      return {
        ok: false,
        result: "点击后未达到预期状态 waitFor=" + params.waitFor + "；实际页面状态: " + JSON.stringify(state).substring(0, 300),
        pageState: state,
        diagnostics: diag,
      };
    }

    var result = "点击成功: " + params.button.value;
    result += "；命中坐标=(" + btn.x + "," + btn.y + ")";
    if (state.dialog) result += " (弹窗: " + state.dialogText.substring(0, 50) + ")";
    if (state.message) result += " (消息: " + state.messageText.substring(0, 50) + ")";
    return { ok: true, result: result, pageState: state };
  };

  // 模板 5: close_dialog — 关闭弹框
  templates.close_dialog = async function (deps, params) {
    var evalInPage = deps.evalInPage;
    var vc = global.AIFT_VisualController;
    if (!evalInPage || !vc) return { ok: false, result: "依赖不可用" };

    var method = params.method || "auto";
    var state = await getPageState(evalInPage);
    if (!state.dialog && !state.dropdown) {
      return { ok: true, result: "当前无弹窗需要关闭", pageState: state };
    }

    await vc.ensureAttached(deps.tabId);
    var closed = false;

    if (method === "button" || method === "auto") {
      var closeTexts = params.closeButtonText ? [params.closeButtonText] : ["关闭", "取消", "Close", "Cancel", "x"];
      for (var i = 0; i < closeTexts.length && !closed; i++) {
        var btn = await waitForElement(evalInPage, "text", closeTexts[i], { visibleOnly: true });
        if (btn) {
          await vc.mouseClick(btn.x, btn.y);
          await sleep(STEP_DELAY + 100);
          var ns = await getPageState(evalInPage);
          if (!ns.dialog) { closed = true; state = ns; }
        }
      }
      // 尝试关闭图标（框架无关）
      if (!closed) {
        var iconCode = "(function(){" +
          // 框架无关的关闭图标选择器
          "var s=[" +
            "'[aria-label=\"Close\"]','[aria-label=\"close\"]','[aria-label=\"关闭\"]'," + // ARIA 标准
            "'[role=\"button\"][class*=\"close\"]'," + // 通用
            "'.el-dialog__close','.el-drawer__close','.el-icon-close'," + // Element UI
            "'.ant-modal-close','.anticon-close'," + // Ant Design
            "'.MuiDialog-root button[aria-label],.MuiIconButton-root[class*=\"close\"]'," + // MUI
            "'.q-dialog__inner > button,.q-btn--flat'," + // Quasar
            "'.v-dialog .v-btn--icon,.v-overlay__scrim'," + // Vuetify
            "'.modal-header .close,.btn-close'" + // Bootstrap
          "];" +
          "for(var i=0;i<s.length;i++){var els=document.querySelectorAll(s[i]);" +
          "for(var j=0;j<els.length;j++){var r=els[j].getBoundingClientRect();" +
          "if(r.width>0&&r.height>0)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}}" +
          "return 'null';" +
          "})()";
        var iconResp = await evalInPage(iconCode);
        if (iconResp && iconResp.ok && iconResp.result && iconResp.result !== "null") {
          try {
            var icon = JSON.parse(iconResp.result);
            await vc.mouseClick(icon.x, icon.y);
            await sleep(STEP_DELAY + 100);
            var ns2 = await getPageState(evalInPage);
            if (!ns2.dialog) { closed = true; state = ns2; }
          } catch (e) {}
        }
      }
    }

    if (!closed && (method === "escape" || method === "auto")) {
      await vc.keyboardPress("Escape");
      await sleep(STEP_DELAY + 100);
      var ns3 = await getPageState(evalInPage);
      if (!ns3.dialog && !ns3.dropdown) { closed = true; state = ns3; }
    }

    return { ok: closed, result: closed ? "弹窗已关闭" : "未能关闭弹窗", pageState: state };
  };

  // 模板 6: fill_form — 批量填写表单
  templates.fill_form = async function (deps, params) {
    var evalInPage = deps.evalInPage;
    var vc = global.AIFT_VisualController;
    if (!evalInPage || !vc) return { ok: false, result: "依赖不可用" };

    await vc.ensureAttached(deps.tabId);
    var results = [], successCount = 0;

    for (var i = 0; i < params.fields.length; i++) {
      var field = params.fields[i];
      var input = await waitForElement(evalInPage, field.input.findBy, field.input.value, { visibleOnly: true });
      if (!input) { results.push("X " + field.input.value + " (未找到)"); continue; }
      if (input.disabled) { results.push("X " + field.input.value + " (禁用)"); continue; }

      var fieldType = await vc.typeAtPoint(evalInPage, input.x, input.y, field.text || "");
      await sleep(STEP_DELAY);
      if (!fieldType.ok) {
        results.push("X " + field.input.value + " (" + (fieldType.error || "输入验证失败") + ")");
        continue;
      }

      results.push("V " + field.input.value + " -> \"" + (field.text || "").substring(0, 20) + "\"");
      successCount++;
    }

    var state = await getPageState(evalInPage);
    var result = "表单填写: " + successCount + "/" + params.fields.length + " 成功\n" + results.join("\n");
    return { ok: successCount === params.fields.length, result: result, pageState: state };
  };

  // 模板 7: table_action — 表格行内操作（框架无关）
  templates.table_action = async function (deps, params) {
    var evalInPage = deps.evalInPage;
    var vc = global.AIFT_VisualController;
    if (!evalInPage || !vc) return { ok: false, result: "依赖不可用" };

    var code = "(function(){" +
      "  var rowVal=" + JSON.stringify(params.rowIdentifier.value) + ";" +
      "  var btnVal=" + JSON.stringify(params.actionButton.value) + ";" +
      "  var tableSel=" + JSON.stringify(params.tableSelector || "") + ";" +
      // 框架无关的表格选择器：原生 table、Element UI、Ant Design、Vuetify、Material-UI、Bootstrap 等
      "  var tableSels = ['table', '[role=\"grid\"]', '.el-table', '.ant-table', '.v-data-table', '.MuiTable-root', '.q-table', '.table'];" +
      "  var table = null;" +
      "  if (tableSel) { table = document.querySelector(tableSel); }" +
      "  if (!table) {" +
      "    for (var t = 0; t < tableSels.length; t++) {" +
      "      var ts = document.querySelectorAll(tableSels[t]);" +
      "      for (var ti = 0; ti < ts.length; ti++) {" +
      "        var r = ts[ti].getBoundingClientRect();" +
      "        if (r.width > 0 && r.height > 0) { table = ts[ti]; break; }" +
      "      }" +
      "      if (table) break;" +
      "    }" +
      "  }" +
      "  if(!table) return JSON.stringify({ok:false,error:'未找到表格'});" +
      // 框架无关的行选择器
      "  var rowSels = ['tbody tr', '[role=\"row\"]', '.el-table__row', '.ant-table-row', '.v-data-table__tr', '.MuiTableRow-root', 'tr'];" +
      "  var rows = [];" +
      "  for (var rs = 0; rs < rowSels.length; rs++) {" +
      "    var found = table.querySelectorAll(rowSels[rs]);" +
      "    for (var fi = 0; fi < found.length; fi++) rows.push(found[fi]);" +
      "  }" +
      // 框架无关的按钮选择器
      "  var btnSels = ['button', 'a', '[role=\"button\"]', '.el-button', '.ant-btn', '.v-btn', '.MuiButton-root', '.q-btn', '.btn'];" +
      "  for(var i=0;i<rows.length;i++){" +
      "    var rt=(rows[i].textContent||'').trim();" +
      "    if(rt.indexOf(rowVal)===-1)continue;" +
      "    for (var bs = 0; bs < btnSels.length; bs++) {" +
      "      var btns = rows[i].querySelectorAll(btnSels[bs]);" +
      "      for(var j=0;j<btns.length;j++){" +
      "        var t=(btns[j].textContent||'').trim();" +
      "        if(t.indexOf(btnVal)!==-1&&!btns[j].disabled&&!btns[j].classList.contains('disabled')){" +
      "          btns[j].scrollIntoView({behavior:'instant',block:'center'});" +
      "          var r=btns[j].getBoundingClientRect();" +
      "          if (r.width === 0 || r.height === 0) continue;" +
      "          return JSON.stringify({ok:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),rowText:rt.substring(0,100)});" +
      "        }" +
      "      }" +
      "    }" +
      "    return JSON.stringify({ok:false,error:'行中未找到按钮:'+btnVal});" +
      "  }" +
      "  return JSON.stringify({ok:false,error:'未找到包含 '+rowVal+' 的行'});" +
      "})()";

    var resp = await evalInPage(code);
    if (!resp || !resp.ok) return { ok: false, result: "执行查找失败" };
    var fr;
    try { fr = JSON.parse(resp.result || "{}"); } catch (e) { fr = {}; }
    if (!fr.ok) return { ok: false, result: fr.error || "未找到目标行或按钮" };

    await vc.ensureAttached(deps.tabId);
    await vc.mouseClick(fr.x, fr.y);
    await sleep(STEP_DELAY);

    var state = await getPageState(evalInPage);
    var result = "表格行操作: 行[" + (fr.rowText || "").substring(0, 30) + "] 按钮[" + params.actionButton.value + "]";
    if (state.dialog) result += " (弹窗: " + state.dialogText.substring(0, 50) + ")";
    if (state.message) result += " (消息: " + state.messageText.substring(0, 50) + ")";
    return { ok: true, result: result, pageState: state };
  };

  // 模板 8: switch_tab — 切换 Tab
  templates.switch_tab = async function (deps, params) {
    var evalInPage = deps.evalInPage;
    var vc = global.AIFT_VisualController;
    if (!evalInPage || !vc) return { ok: false, result: "依赖不可用" };

    var tab = await waitForElement(evalInPage, params.tab.findBy, params.tab.value, {
      visibleOnly: true, tag: params.tab.tag || "",
    });
    if (!tab) return { ok: false, result: "未找到 Tab: " + params.tab.value };

    await vc.ensureAttached(deps.tabId);
    await vc.mouseClick(tab.x, tab.y);
    await sleep(STEP_DELAY);

    if (params.waitFor === "loading") await waitForLoading(evalInPage);

    var state = await getPageState(evalInPage);
    var activeCode = "(function(){var x=" + Number(tab.x || 0) + ",y=" + Number(tab.y || 0) + ";var el=document.elementFromPoint(x,y);" +
      "for(var i=0;i<6&&el;i++,el=el.parentElement){var cls=(typeof el.className==='string'?el.className:'');var selected=el.getAttribute('aria-selected')==='true'||el.getAttribute('aria-current')==='page'||/active|is-active|selected|checked/.test(cls);if(selected)return JSON.stringify({known:true,active:true,className:cls});}" +
      "return JSON.stringify({known:false,active:false});})()";
    var active = await readJson(evalInPage, activeCode, { known: false });
    if (active && active.known && !active.active) {
      return { ok: false, result: "Tab 点击后未进入激活状态: " + params.tab.value, pageState: state };
    }
    return { ok: true, result: "Tab 切换: " + params.tab.value, pageState: state };
  };

  // 模板 9: confirm_dialog — 确认/取消弹窗
  templates.confirm_dialog = async function (deps, params) {
    var evalInPage = deps.evalInPage;
    var vc = global.AIFT_VisualController;
    if (!evalInPage || !vc) return { ok: false, result: "依赖不可用" };

    var state = await getPageState(evalInPage);
    if (!state.dialog) return { ok: false, result: "当前无弹窗", pageState: state };

    var btnTexts;
    if (params.buttonText) btnTexts = [params.buttonText];
    else if (params.action === "cancel") btnTexts = ["取消", "Cancel", "否", "No", "返回"];
    else btnTexts = ["确定", "确认", "OK", "Confirm", "是", "Yes", "保存"];

    await vc.ensureAttached(deps.tabId);
    for (var i = 0; i < btnTexts.length; i++) {
      var btn = await waitForElement(evalInPage, "text", btnTexts[i], { visibleOnly: true });
      if (btn) {
        await vc.mouseClick(btn.x, btn.y);
        await sleep(STEP_DELAY + 200);
        var ns = await getPageState(evalInPage);
        if (!ns.dialog) {
          var result = params.action === "cancel" ? "取消弹窗" : "确认弹窗";
          if (ns.message) result += " (消息: " + ns.messageText.substring(0, 50) + ")";
          return { ok: true, result: result, pageState: ns };
        }
      }
    }

    if (params.action === "cancel") {
      await vc.keyboardPress("Escape");
      await sleep(STEP_DELAY);
      var es = await getPageState(evalInPage);
      if (!es.dialog) return { ok: true, result: "Escape 取消弹窗", pageState: es };
    }

    return { ok: false, result: "未找到确认/取消按钮", pageState: state };
  };

  // 模板 10: toggle_switch — 切换开关
  templates.toggle_switch = async function (deps, params) {
    var evalInPage = deps.evalInPage;
    var vc = global.AIFT_VisualController;
    if (!evalInPage || !vc) return { ok: false, result: "依赖不可用" };

    var toggle = await waitForElement(evalInPage, params.toggle.findBy, params.toggle.value, { visibleOnly: true });
    if (!toggle) return { ok: false, result: "未找到开关: " + params.toggle.value };

    var stateCode = "(function(){" +
      "  var el=document.querySelector(" + JSON.stringify(toggle.selector) + ");" +
      "  if(!el)return JSON.stringify({found:false});" +
      "  if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) { var r0 = el.getBoundingClientRect(); return JSON.stringify({found:true,isOn:el.checked,nativeInput:true,x:Math.round(r0.x+r0.width/2),y:Math.round(r0.y+r0.height/2)}); }" +
      "  var ariaChecked = el.getAttribute('aria-checked'); var ariaPressed = el.getAttribute('aria-pressed'); var cls = (typeof el.className === 'string') ? el.className : '';" +
      "  var isOn = ariaChecked === 'true' || ariaPressed === 'true' || cls.indexOf('is-checked') !== -1 || cls.indexOf('ant-switch-checked') !== -1 || cls.indexOf('v-switch--inset') !== -1 || cls.indexOf('Mui-checked') !== -1 || cls.indexOf('active') !== -1;" +
      "  var core = el.querySelector('.el-switch__core, .ant-switch-handle, .v-switch__thumb, .MuiSwitch-thumb, .switch-handle, .toggle-slider'); if (core) el = core;" +
      "  var ct=el;" +
      "  if(el.classList.contains('el-switch'))ct=el.querySelector('.el-switch__core')||el;" +
      "  var r=ct.getBoundingClientRect();" +
      "  return JSON.stringify({found:true,isOn:isOn,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});" +
      "})()";

    var sr = await evalInPage(stateCode);
    var ts = {};
    if (sr && sr.ok) { try { ts = JSON.parse(sr.result || "{}"); } catch (e) {} }
    if (!ts.found) return { ok: false, result: "开关元素消失" };

    var needClick = true;
    if (params.targetState === "on" && ts.isOn) needClick = false;
    if (params.targetState === "off" && !ts.isOn) needClick = false;

    if (needClick) {
      await vc.ensureAttached(deps.tabId);
      await vc.mouseClick(ts.x, ts.y);
      await sleep(STEP_DELAY);
    }

    var sr2 = await evalInPage(stateCode);
    var ts2 = ts;
    if (sr2 && sr2.ok) { try { ts2 = JSON.parse(sr2.result || "{}"); } catch (e) {} }
    if (params.targetState === "on" && !ts2.isOn) {
      return { ok: false, result: "开关切换后未达到 ON，当前仍为 OFF", pageState: await getPageState(evalInPage), diagnostics: await getPointDiagnostics(evalInPage, ts.x, ts.y) };
    }
    if (params.targetState === "off" && ts2.isOn) {
      return { ok: false, result: "开关切换后未达到 OFF，当前仍为 ON", pageState: await getPageState(evalInPage), diagnostics: await getPointDiagnostics(evalInPage, ts.x, ts.y) };
    }

    var state = await getPageState(evalInPage);
    var result = "开关状态: " + (ts.isOn ? "ON" : "OFF") + (needClick ? " -> " + (ts2.isOn ? "ON" : "OFF") : " -> 无需切换");
    return { ok: true, result: result, pageState: state };
  };

  // ===== 执行入口 =====

  /**
   * 执行指定模板
   * @param {string} name - 模板名称
   * @param {Object} deps - { tabId, evalInPage }
   * @param {Object} params - 模板参数
   * @returns {Promise<{ok, result, pageState?}>}
   */
  async function execute(name, deps, params) {
    var fn = templates[name];
    if (!fn) return { ok: false, result: "未知模板: " + name };
    try {
      return await fn(deps, params || {});
    } catch (e) {
      return { ok: false, result: "模板执行异常: " + name + " - " + (e.message || e) };
    }
  }

  /**
   * 获取所有模板名称
   */
  function listTemplates() {
    return Object.keys(templates);
  }

  global.AIFT_ActionTemplates = {
    execute: execute,
    listTemplates: listTemplates,
    findElements: findElements,
    waitForElement: waitForElement,
    getPageState: getPageState,
    waitForLoading: waitForLoading,
  };
})(window);
