// visual-controller.js
// 视觉控制系统：通过 Chrome CDP (chrome.debugger) 实现截图、鼠标点击、键盘输入
// 结合 AI 视觉能力，处理难以通过 CSS 选择器定位的测试场景
// 在 Side Panel 上下文中运行

(function (global) {
  "use strict";

  var CDP_VERSION = "1.3";
  var attached = false;
  var currentTabId = null;
  var attachPromise = null;

  /**
   * 附加 debugger 到目标 tab
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function attach(tabId) {
    if (attached && currentTabId === tabId) return;
    // 如果已附加到其他 tab，先分离
    if (attached && currentTabId !== tabId) {
      await detach();
    }
    currentTabId = tabId;
    // 避免重复 attach
    if (attachPromise) return attachPromise;

    attachPromise = new Promise(function (resolve, reject) {
      chrome.debugger.attach({ tabId: tabId }, CDP_VERSION, function () {
        if (chrome.runtime.lastError) {
          var err = chrome.runtime.lastError.message || "";
          attachPromise = null;
          reject(new Error("无法附加 debugger: " + err));
          return;
        }
        attached = true;
        attachPromise = null;
        console.log("[AIFT-Visual] debugger 已附加到 tab " + tabId);
        resolve();
      });
    });
    return attachPromise;
  }

  /**
   * 分离 debugger
   */
  function detach() {
    return new Promise(function (resolve) {
      if (!attached || !currentTabId) {
        attached = false;
        resolve();
        return;
      }
      chrome.debugger.detach({ tabId: currentTabId }, function () {
        if (chrome.runtime.lastError) {
          console.warn("[AIFT-Visual] detach 时出错: " + chrome.runtime.lastError.message);
        }
        attached = false;
        currentTabId = null;
        resolve();
      });
    });
  }

  /**
   * 发送 CDP 命令
   * @param {string} method - CDP 方法名
   * @param {Object} params - 参数
   * @returns {Promise<any>}
   */
  function sendCommand(method, params) {
    return new Promise(function (resolve, reject) {
      if (!attached || !currentTabId) {
        reject(new Error("debugger 未附加"));
        return;
      }
      chrome.debugger.sendCommand({ tabId: currentTabId }, method, params || {}, function (result) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result);
      });
    });
  }

  /**
   * 截取当前页面截图
   * @param {Object} options - { format, quality, clip, captureBeyondViewport, fromSurface }
   * @returns {Promise<string>} base64 格式的图片数据（不含 data:image/png;base64, 前缀）
   */
  async function captureScreenshot(options) {
    options = options || {};
    var params = {
      format: options.format || "png",
      captureBeyondViewport: options.captureBeyondViewport === true,
      fromSurface: true,
    };
    if (options.quality !== undefined) params.quality = options.quality;
    if (options.clip) params.clip = options.clip;

    var result = await sendCommand("Page.captureScreenshot", params);
    if (!result || !result.data) {
      throw new Error("截图失败：无返回数据");
    }
    return result.data;
  }

  /**
   * 获取页面视口信息
   * @returns {Promise<Object>} { width, height, deviceScaleFactor }
   */
  async function getLayoutMetrics() {
    var result = await sendCommand("Page.getLayoutMetrics", {});
    if (!result || !result.cssLayoutViewport) {
      // 回退到 visualViewport
      if (result && result.visualViewport) {
        return {
          width: result.visualViewport.clientWidth || 0,
          height: result.visualViewport.clientHeight || 0,
          deviceScaleFactor: result.visualViewport.scale || 1,
          pageX: result.visualViewport.pageX || 0,
          pageY: result.visualViewport.pageY || 0,
        };
      }
      throw new Error("无法获取页面布局信息");
    }
    var vp = result.cssLayoutViewport;
    return {
      width: vp.clientWidth || 0,
      height: vp.clientHeight || 0,
      deviceScaleFactor: (result.visualViewport && result.visualViewport.scale) || 1,
      pageX: vp.pageX || 0,
      pageY: vp.pageY || 0,
    };
  }

  /**
   * 通过 CDP 在指定坐标处点击鼠标
   * 模拟真实的鼠标移动 → 按下 → 释放序列
   * @param {number} x - CSS 坐标 X
   * @param {number} y - CSS 坐标 Y
   * @param {Object} options - { button, clickCount, delay }
   * @returns {Promise<void>}
   */
  async function mouseClick(x, y, options) {
    options = options || {};
    var button = options.button || "left";
    var clickCount = options.clickCount || 1;
    var delay = options.delay || 50;
    var modifiers = options.modifiers || 0;

    // 鼠标移动到目标位置
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: x,
      y: y,
      button: button,
      modifiers: modifiers,
    });

    // 短暂延迟，让页面响应 mousemove
    if (delay > 0) {
      await new Promise(function (r) { setTimeout(r, delay); });
    }

    // 多次点击
    for (var i = 0; i < clickCount; i++) {
      // 鼠标按下
      await sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: x,
        y: y,
        button: button,
        clickCount: 1,
        modifiers: modifiers,
      });

      // 短暂延迟
      await new Promise(function (r) { setTimeout(r, 30); });

      // 鼠标释放
      await sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: x,
        y: y,
        button: button,
        clickCount: 1,
        modifiers: modifiers,
      });

      // 多次点击间隔
      if (i < clickCount - 1) {
        await new Promise(function (r) { setTimeout(r, 80); });
      }
    }
  }

  async function mouseHover(x, y) {
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: x,
      y: y,
      button: "none",
    });
  }

  /**
   * 通过 CDP 在指定坐标处双击鼠标
   * @param {number} x
   * @param {number} y
   * @returns {Promise<void>}
   */
  async function mouseDoubleClick(x, y) {
    await mouseClick(x, y, { clickCount: 2, delay: 0 });
  }

  /**
   * 通过 CDP 在指定坐标处右键点击
   * @param {number} x
   * @param {number} y
   * @returns {Promise<void>}
   */
  async function mouseRightClick(x, y) {
    await mouseClick(x, y, { button: "right" });
  }

  /**
   * 通过 CDP 拖拽元素
   * @param {number} fromX
   * @param {number} fromY
   * @param {number} toX
   * @param {number} toY
   * @returns {Promise<void>}
   */
  async function mouseDrag(fromX, fromY, toX, toY) {
    // 移动到起点
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: fromX,
      y: fromY,
      button: "left",
    });
    await new Promise(function (r) { setTimeout(r, 50); });

    // 按下
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: fromX,
      y: fromY,
      button: "left",
      clickCount: 1,
    });
    await new Promise(function (r) { setTimeout(r, 50); });

    // 分步移动到终点（模拟真实拖拽轨迹）
    var steps = 10;
    for (var i = 1; i <= steps; i++) {
      var stepX = fromX + (toX - fromX) * (i / steps);
      var stepY = fromY + (toY - fromY) * (i / steps);
      await sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: stepX,
        y: stepY,
        button: "left",
      });
      await new Promise(function (r) { setTimeout(r, 16); });
    }

    // 释放
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: toX,
      y: toY,
      button: "left",
      clickCount: 1,
    });
  }

  /**
   * 通过 CDP 滚动鼠标滚轮
   * @param {number} x - 滚动位置 X
   * @param {number} y - 滚动位置 Y
   * @param {number} deltaX - 水平滚动量（正数向右，负数向左）
   * @param {number} deltaY - 垂直滚动量（正数向下，负数向上）
   * @returns {Promise<void>}
   */
  async function mouseScroll(x, y, deltaX, deltaY) {
    // 先移动到目标位置
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: x,
      y: y,
      button: "none",
    });
    await new Promise(function (r) { setTimeout(r, 30); });

    // 滚动
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: x,
      y: y,
      deltaX: deltaX || 0,
      deltaY: deltaY || 0,
    });
  }

  /**
   * 获取字符对应的 KeyboardEvent.code 值
   * 字母 → KeyA/KeyB...，数字 → Digit1/Digit2...
   */
  function getKeyCode(char) {
    if (char >= 'a' && char <= 'z') return "Key" + char.toUpperCase();
    if (char >= 'A' && char <= 'Z') return "Key" + char;
    if (char >= '0' && char <= '9') return "Digit" + char;
    // 常见符号
    var symbolMap = {
      " ": "Space", "!": "Digit1", "@": "Digit2", "#": "Digit3",
      "$": "Digit4", "%": "Digit5", "^": "Digit6", "&": "Digit7",
      "*": "Digit8", "(": "Digit9", ")": "Digit0",
      "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight",
      "\\": "Backslash", ";": "Semicolon", "'": "Quote",
      ",": "Comma", ".": "Period", "/": "Slash", "`": "Backquote",
    };
    return symbolMap[char] || "";
  }

  function keyDescriptor(key) {
    var lower = String(key || "").toLowerCase();
    var named = {
      "enter": { key: "Enter", code: "Enter", keyCode: 13 },
      "tab": { key: "Tab", code: "Tab", keyCode: 9 },
      "escape": { key: "Escape", code: "Escape", keyCode: 27 },
      "esc": { key: "Escape", code: "Escape", keyCode: 27 },
      "backspace": { key: "Backspace", code: "Backspace", keyCode: 8 },
      "delete": { key: "Delete", code: "Delete", keyCode: 46 },
      "arrowup": { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      "arrowdown": { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      "arrowleft": { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      "arrowright": { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
      "home": { key: "Home", code: "Home", keyCode: 36 },
      "end": { key: "End", code: "End", keyCode: 35 },
      "pageup": { key: "PageUp", code: "PageUp", keyCode: 33 },
      "pagedown": { key: "PageDown", code: "PageDown", keyCode: 34 },
      "space": { key: " ", code: "Space", keyCode: 32 },
      "control": { key: "Control", code: "ControlLeft", keyCode: 17, modifier: 2 },
      "ctrl": { key: "Control", code: "ControlLeft", keyCode: 17, modifier: 2 },
      "shift": { key: "Shift", code: "ShiftLeft", keyCode: 16, modifier: 8 },
      "alt": { key: "Alt", code: "AltLeft", keyCode: 18, modifier: 1 },
      "option": { key: "Alt", code: "AltLeft", keyCode: 18, modifier: 1 },
      "meta": { key: "Meta", code: "MetaLeft", keyCode: 91, modifier: 4 },
      "cmd": { key: "Meta", code: "MetaLeft", keyCode: 91, modifier: 4 },
      "command": { key: "Meta", code: "MetaLeft", keyCode: 91, modifier: 4 },
    };
    if (named[lower]) return named[lower];
    if (String(key || "").length === 1) {
      var ch = String(key);
      var upper = ch.toUpperCase();
      if (/^[a-z]$/i.test(ch)) return { key: ch, code: "Key" + upper, keyCode: upper.charCodeAt(0), text: ch };
      if (/^[0-9]$/.test(ch)) return { key: ch, code: "Digit" + ch, keyCode: ch.charCodeAt(0), text: ch };
      return { key: ch, code: getKeyCode(ch), keyCode: ch.charCodeAt(0), text: ch };
    }
    return { key: key, code: key, keyCode: 0 };
  }

  function modifierMask(keys) {
    var mask = 0;
    for (var i = 0; i < (keys || []).length; i++) {
      var d = keyDescriptor(keys[i]);
      if (d.modifier) mask |= d.modifier;
    }
    return mask;
  }

  async function dispatchKey(type, key, modifiers, includeText) {
    var d = keyDescriptor(key);
    var params = {
      type: type,
      key: d.key,
      code: d.code,
      windowsVirtualKeyCode: d.keyCode || 0,
      nativeVirtualKeyCode: d.keyCode || 0,
      modifiers: modifiers || 0,
    };
    if (includeText && type === "keyDown" && d.text) {
      params.text = d.text;
      params.unmodifiedText = d.text;
    }
    await sendCommand("Input.dispatchKeyEvent", params);
  }

  /**
   * 通过 CDP 输入文本（逐字符输入）
   * 使用 Input.insertText 批量输入，再逐字符 dispatchKeyEvent 作为备选
   * @param {string} text - 要输入的文本
   * @returns {Promise<void>}
   */
  async function keyboardType(text) {
    if (!text) return;

    // 方式 1：使用 Input.insertText（一次性输入整段文本，不触发按键事件）
    // 适用于大多数场景，但对某些需要逐字符触发事件的组件可能不生效
    try {
      await sendCommand("Input.insertText", { text: text });
      return;
    } catch (e) {
      console.warn("[AIFT-Visual] insertText 失败，回退到逐字符输入: " + e.message);
    }

    // 方式 2：逐字符 dispatchKeyEvent
    for (var i = 0; i < text.length; i++) {
      var char = text[i];
      var code = char.charCodeAt(0);
      var key = char;
      var keyCode = 0;

      // 常见按键映射
      if (char === "\n") { key = "Enter"; keyCode = 13; }
      else if (char === "\t") { key = "Tab"; keyCode = 9; }
      else if (char === " ") { key = " "; keyCode = 32; }

      // keyDown
      await sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: key,
        code: code > 255 ? "" : getKeyCode(char),
        windowsVirtualKeyCode: keyCode || code,
        text: keyCode === 0 ? char : undefined,
        unmodifiedText: keyCode === 0 ? char : undefined,
      });

      // keyUp
      await sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: key,
        code: code > 255 ? "" : getKeyCode(char),
        windowsVirtualKeyCode: keyCode || code,
      });
    }
  }

  /**
   * 通过 CDP 按下单个按键
   * @param {string} key - 按键名，如 "Enter", "Tab", "Escape", "ArrowDown"
   * @returns {Promise<void>}
   */
  async function keyboardPress(key) {
    await dispatchKey("keyDown", key, 0, true);
    await new Promise(function (r) { setTimeout(r, 30); });
    await dispatchKey("keyUp", key, 0, false);
  }

  /**
   * 通过 CDP 组合按键（如 Ctrl+A, Shift+Tab）
   * @param {Array<string>} keys - 按键序列，如 ["Control", "a"] 表示 Ctrl+A
   * @returns {Promise<void>}
   */
  async function keyboardCombo(keys) {
    if (!keys || keys.length === 0) return;
    var mods = keys.slice(0, -1);
    var lastKey = keys[keys.length - 1];
    var activeMask = 0;

    // 按下所有键（除了最后一个）
    for (var i = 0; i < mods.length; i++) {
      var k = mods[i];
      activeMask |= modifierMask([k]);
      await dispatchKey("keyDown", k, activeMask, false);
      await new Promise(function (r) { setTimeout(r, 20); });
    }

    // 按下并释放最后一个键
    await dispatchKey("keyDown", lastKey, activeMask, false);
    await new Promise(function (r) { setTimeout(r, 30); });
    await dispatchKey("keyUp", lastKey, activeMask, false);

    // 释放所有修饰键（逆序）
    for (var j = mods.length - 1; j >= 0; j--) {
      var mk = mods[j];
      await dispatchKey("keyUp", mk, activeMask, false);
      activeMask &= ~modifierMask([mk]);
      await new Promise(function (r) { setTimeout(r, 20); });
    }
  }

  async function readFocusedTextLength(evalInPage) {
    if (!evalInPage) return 0;
    var resp = await evalInPage("(function(){var el=document.activeElement;if(!el)return '0';var v=el.isContentEditable?(el.textContent||''):(el.value!==undefined?el.value:(el.textContent||''));return String((v||'').length);})()");
    if (!resp || !resp.ok) return 0;
    var n = parseInt(resp.result || "0", 10);
    return isNaN(n) ? 0 : n;
  }

  async function readActiveValue(evalInPage) {
    if (!evalInPage) return { ok: false, error: "缺少 evalInPage" };
    var code = "(function(){var el=document.activeElement;if(!el)return JSON.stringify({ok:false,error:'无焦点元素'});" +
      "var v=el.isContentEditable?(el.textContent||''):(el.value!==undefined?el.value:(el.textContent||''));" +
      "var r=el.getBoundingClientRect();" +
      "return JSON.stringify({ok:true,value:String(v||''),tag:el.tagName,type:el.type||'',id:el.id||'',className:(typeof el.className==='string'?el.className:'').substring(0,80),rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}});})()";
    var resp = await evalInPage(code);
    if (!resp || !resp.ok) return { ok: false, error: (resp && resp.error) || "读取焦点失败" };
    try { return JSON.parse(resp.result || "{}"); } catch (e) { return { ok: false, error: "解析焦点值失败: " + (e.message || e) }; }
  }

  async function readElementValue(evalInPage, selector) {
    if (!evalInPage || !selector) return { ok: false, error: "缺少 evalInPage 或 selector" };
    var code = "(function(){var el=document.querySelector(" + JSON.stringify(selector) + ");" +
      "if(!el)return JSON.stringify({ok:false,error:'元素不存在'});" +
      "var v=el.isContentEditable?(el.textContent||''):(el.value!==undefined?el.value:(el.textContent||''));" +
      "return JSON.stringify({ok:true,value:v,tag:el.tagName,type:el.type||'',active:el===document.activeElement});})()";
    var resp = await evalInPage(code);
    if (!resp || !resp.ok) return { ok: false, error: (resp && resp.error) || "读取失败" };
    try { return JSON.parse(resp.result || "{}"); } catch (e) { return { ok: false, error: "解析失败: " + (e.message || e) }; }
  }

  async function clearFocusedText(evalInPage) {
    async function tryCombo(modKey) {
      await keyboardCombo([modKey, "a"]);
      await new Promise(function (r) { setTimeout(r, 40); });
      await keyboardPress("Delete");
      await new Promise(function (r) { setTimeout(r, 40); });
      return (await readFocusedTextLength(evalInPage)) === 0;
    }

    if (!evalInPage) {
      await keyboardCombo(["Control", "a"]);
      await keyboardPress("Delete");
      await keyboardCombo(["Meta", "a"]);
      await keyboardPress("Delete");
      return true;
    }

    if (await tryCombo("Control")) return true;
    if (await tryCombo("Meta")) return true;

    var len = await readFocusedTextLength(evalInPage);
    var limit = Math.min(len, 200);
    for (var i = 0; i < limit; i++) {
      await keyboardPress("Backspace");
      if (i % 20 === 19 && (await readFocusedTextLength(evalInPage)) === 0) return true;
    }
    return (await readFocusedTextLength(evalInPage)) === 0;
  }

  /**
   * 通过 CDP 在指定坐标处点击并输入文本
   * @param {number} x
   * @param {number} y
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function typeAtPoint(evalInPage, x, y, text) {
    await mouseClick(x, y);
    await new Promise(function (r) { setTimeout(r, 100); });
    await clearFocusedText(evalInPage);
    await keyboardType(text);
    if (!evalInPage) return { ok: true };

    var verify = await readActiveValue(evalInPage);
    if (verify.ok && String(verify.value) === String(text || "")) return { ok: true, value: verify.value };

    await clearFocusedText(evalInPage);
    await keyboardType(text || "");
    verify = await readActiveValue(evalInPage);
    if (verify.ok && String(verify.value) === String(text || "")) return { ok: true, value: verify.value };

    return {
      ok: false,
      error: "输入验证失败，当前焦点值为: " + String((verify && verify.value) || "").substring(0, 80),
      active: verify,
    };
  }

  async function clickAndType(x, y, text, evalInPage) {
    var typed = await typeAtPoint(evalInPage, x, y, text);
    if (!typed.ok) throw new Error(typed.error || "输入验证失败");
    return typed;
  }

  /**
   * 通过 evalInPage 获取元素坐标；仅在元素不在视口内时滚动。
   * 对浮层、菜单等已可见元素滚动会触发失焦并销毁目标，因此不能无条件滚动。
   * @param {function} evalInPage - 在页面执行 JS 的函数 (code) => Promise<{ok, result}>
   * @param {string} selector - CSS 选择器
   * @returns {Promise<{ok, x, y, width, height, error?}>}
   */
  async function locateElement(evalInPage, selector) {
    if (!selector) return { ok: false, error: "缺少 selector 参数" };
    var code = "(function() {" +
      "var el = document.querySelector(" + JSON.stringify(selector) + ");" +
      "if (!el) return { found: false };" +
      "var r = el.getBoundingClientRect();" +
      "var inView=r.width>0&&r.height>0&&r.x+r.width/2>=0&&r.x+r.width/2<=window.innerWidth&&r.y+r.height/2>=0&&r.y+r.height/2<=window.innerHeight;" +
      "if(!inView){el.scrollIntoView({behavior:'instant',block:'center'});r=el.getBoundingClientRect();}" +
      "var st=getComputedStyle(el);" +
      "return { found: true, x: r.x + r.width/2, y: r.y + r.height/2, width: r.width, height: r.height, visible: st.display!=='none'&&st.visibility!=='hidden'&&r.width>0&&r.height>0, disabled: !!el.disabled||el.getAttribute('aria-disabled')==='true' };" +
      "})()";
    var resp = await evalInPage(code);
    if (!resp || !resp.ok) return { ok: false, error: (resp && resp.error) || "执行失败" };
    try {
      var parsed = JSON.parse(resp.result);
      if (parsed && parsed.found && typeof parsed.x === "number") {
        if (!parsed.visible) return { ok: false, error: "元素不可见: " + selector };
        if (parsed.disabled) return { ok: false, error: "元素被禁用: " + selector };
        return { ok: true, x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
      }
      return { ok: false, error: "找不到元素: " + selector };
    } catch (e) {
      return { ok: false, error: "解析坐标失败: " + (e.message || e) };
    }
  }

  // 读取可观察的点击状态，并确认坐标没有被遮罩或重渲染后的元素占用。
  async function inspectClickState(evalInPage, selector, x, y) {
    var code = "(function(){" +
      "var el=document.querySelector(" + JSON.stringify(selector) + ");" +
      "if(!el)return {found:false};" +
      "var hit=document.elementFromPoint(" + Number(x) + "," + Number(y) + ");" +
      "var hitTarget=!!hit&&(el===hit||el.contains(hit));" +
      "var fields=Array.prototype.slice.call(el.querySelectorAll('input,button,select,textarea,[role=checkbox],[role=radio],[role=option],[role=menuitem],[contenteditable=true]')).slice(0,8);" +
      "var states=fields.map(function(n){return [n.tagName,n.type||'',n.checked,n.value||'',n.getAttribute('aria-checked')||'',n.getAttribute('aria-selected')||'',n.getAttribute('aria-expanded')||'',n.className||''].join('|');});" +
      "var retry=el.querySelector('input:not([type=hidden]):not([disabled]),button:not([disabled]),[role=checkbox],[role=radio],[role=option],[role=menuitem],.el-checkbox,[contenteditable=true],label');" +
      "var rr=retry&&retry.getBoundingClientRect();" +
      "var focused=document.activeElement===el||el.contains(document.activeElement);" +
      "var text=(document.body.innerText||'').slice(0,12000),hash=0;for(var i=0;i<text.length;i++)hash=(hash*31+text.charCodeAt(i))|0;" +
      "return {found:true,hitTarget:hitTarget,signature:[location.href,document.body.getElementsByTagName('*').length,hash,focused,el.getAttribute('aria-checked')||'',el.getAttribute('aria-selected')||'',el.getAttribute('aria-expanded')||'',el.value||'',el.className||'',states.join('~')].join('^'),retry:rr&&rr.width>0&&rr.height>0?{x:rr.x+rr.width/2,y:rr.y+rr.height/2}:null};" +
      "})()";
    var resp = await evalInPage(code);
    if (!resp || !resp.ok) return { ok: false, error: (resp && resp.error) || "无法读取点击状态" };
    try { return { ok: true, state: JSON.parse(resp.result) }; }
    catch (e) { return { ok: false, error: "解析点击状态失败: " + (e.message || e) }; }
  }

  /**
   * 通过 CSS 选择器点击元素（CDP 真实鼠标操作）
   * 流程：定位元素 → 确认命中 → CDP 鼠标点击 → 校验可观察状态。
   * @param {function} evalInPage - 在页面执行 JS 的函数
   * @param {string} selector - CSS 选择器
   * @returns {Promise<{ok, error?}>}
   */
  async function clickBySelector(evalInPage, selector) {
    // 当 selector 指向文本 label 时，直接点击标签不一定会改变状态（自定义复选框常见）。
    // 先解析关联或内部的真实控件，再执行后续命中和状态校验。
    var resolveCode = "(function(){var el=document.querySelector(" + JSON.stringify(selector) + ");if(!el)return 'null';" +
      "var target=el;if(el.tagName==='LABEL'){target=(el.htmlFor&&document.getElementById(el.htmlFor))||el.querySelector('input[type=checkbox],input[type=radio],[role=checkbox],[role=radio],[role=switch],button')||el;}" +
      "if(target===el)return 'null';if(target.id)return '#'+CSS.escape(target.id);var p=[],c=target;while(c&&c!==document.body){var s=Array.prototype.slice.call(c.parentElement.children),i=s.indexOf(c)+1;p.unshift(c.tagName.toLowerCase()+':nth-child('+i+')');var q=p.join(' > ');try{if(document.querySelectorAll(q).length===1)return q;}catch(e){}c=c.parentElement;}return 'null';})()";
    var resolvedResp = await evalInPage(resolveCode);
    if (resolvedResp && resolvedResp.ok && resolvedResp.result && resolvedResp.result !== "null") selector = resolvedResp.result;
    var loc = await locateElement(evalInPage, selector);
    if (!loc.ok) return { ok: false, error: loc.error };
    var before = await inspectClickState(evalInPage, selector, loc.x, loc.y);
    if (!before.ok) return { ok: false, error: before.error };
    if (!before.state.hitTarget) return { ok: false, error: "点击位置被其他元素遮挡: " + selector };
    await mouseClick(loc.x, loc.y);
    await new Promise(function (r) { setTimeout(r, 120); });
    var after = await inspectClickState(evalInPage, selector, loc.x, loc.y);
    if (!after.ok || !after.state.found || after.state.signature !== before.state.signature) {
      return { ok: true, verified: true };
    }

    // 对容器节点，优先尝试一次内部标准交互控件；适用于复选框、单选项和菜单项。
    if (before.state.retry) {
      await mouseClick(before.state.retry.x, before.state.retry.y);
      await new Promise(function (r) { setTimeout(r, 120); });
      after = await inspectClickState(evalInPage, selector, loc.x, loc.y);
      if (!after.ok || !after.state.found || after.state.signature !== before.state.signature) {
        return { ok: true, verified: true, retriedChild: true };
      }
    }
    return { ok: false, error: "点击事件已发送，但页面状态未变化: " + selector };
  }

  // 将坐标点击绑定到点击瞬间实际命中的元素，避免浮层重渲染后复用旧截图坐标。
  async function clickAtPoint(evalInPage, x, y, interaction) {
    interaction = interaction || {};
    var code = "(function(){" +
      "var el=document.elementFromPoint(" + Number(x) + "," + Number(y) + ");if(!el)return {found:false};" +
      "var nodeSelector=" + JSON.stringify(interaction.nodeSelector || "") + ",activationSelector=" + JSON.stringify(interaction.activationSelector || "") + ";" +
      "function esc(v){return CSS.escape(String(v));}" +
      "function path(n){if(n.id)return '#'+esc(n.id);var a=n.getAttribute('data-testid')||n.getAttribute('data-test')||n.getAttribute('data-qa');if(a){var k=n.getAttribute('data-testid')?'data-testid':(n.getAttribute('data-test')?'data-test':'data-qa');return '['+k+'=\"'+String(a).replace(/\\\\/g,'\\\\\\\\').replace(/\"/g,'\\\\\"')+'\"]';}var p=[],c=n;while(c&&c!==document.body){var s=Array.prototype.slice.call(c.parentElement.children),i=s.indexOf(c)+1;p.unshift(c.tagName.toLowerCase()+':nth-child('+i+')');var q=p.join(' > ');try{if(document.querySelectorAll(q).length===1)return q;}catch(e){}c=c.parentElement;}return n.tagName.toLowerCase();}" +
      // 文本节点/label 往往只是展示层。优先解析真正承载状态变化的控件，尤其是 checkbox/radio。
      "function usable(n){if(!n)return false;var r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!n.disabled&&n.getAttribute('aria-disabled')!=='true';}" +
      // 有些组件会隐藏原生 input，并把实际命中区放在相邻 span/div。这个探测只按语义和可见性选择代理元素。
      "function visualProxy(control){if(!control)return null;var roots=[control.parentElement,control.parentElement&&control.parentElement.parentElement];for(var ri=0;ri<roots.length;ri++){var root=roots[ri];if(!root)continue;var all=[root].concat(Array.prototype.slice.call(root.querySelectorAll('button,span,div,label,[role=checkbox],[role=radio],[role=switch],[aria-checked]')));var best=null,bestScore=-1;for(var ai=0;ai<all.length;ai++){var c=all[ai];if(c===control||!usable(c))continue;var r=c.getBoundingClientRect();if(r.width>180||r.height>80)continue;var hint=((c.className||'')+' '+(c.getAttribute('role')||'')+' '+(c.getAttribute('aria-checked')||'')).toLowerCase();var score=(c===control.nextElementSibling?100:0)+(c.tagName==='BUTTON'?30:0)+(/check|radio|switch|toggle|select|control|indicator|inner|mark/.test(hint)?50:0)+(r.width*r.height<2500?10:0);if(score>bestScore){best=c;bestScore=score;}}if(best)return best;}return null;}" +
      "function usableControl(root,selector){if(!root)return null;var all=[];try{if(root.matches&&root.matches(selector))all.push(root);all=all.concat(Array.prototype.slice.call(root.querySelectorAll(selector)));}catch(e){return null;}for(var i=0;i<all.length;i++){if(usable(all[i]))return all[i];var proxy=visualProxy(all[i]);if(proxy)return proxy;}return null;}" +
      "function control(n){if(!n)return null;var node=nodeSelector?n.closest(nodeSelector):null;if(node&&activationSelector){var resolved=usableControl(node,activationSelector);if(resolved)return resolved;}if(node){var nested=usableControl(node,'input[type=checkbox],input[type=radio],[role=checkbox],[role=radio],[role=switch],[aria-checked]');if(nested)return nested;}var direct=n.closest('input[type=checkbox],input[type=radio],button,[role=checkbox],[role=radio],[role=switch],[role=option],[role=menuitem],[role=treeitem]');if(usable(direct))return direct;var directProxy=visualProxy(direct);if(directProxy)return directProxy;var label=n.closest('label');if(label){var linked=label.htmlFor?document.getElementById(label.htmlFor):null;if(usable(linked))return linked;var linkedProxy=visualProxy(linked);if(linkedProxy)return linkedProxy;var inside=usableControl(label,'input[type=checkbox],input[type=radio],[role=checkbox],[role=radio],[role=switch],button');if(inside)return inside;}var parent=n.closest('[role=checkbox],[role=radio],[role=switch],[role=option],[role=menuitem],[role=treeitem]');if(usable(parent))return parent;return n;}" +
      "var target=control(el);return {found:true,selector:path(target),resolved:target!==el,tag:target.tagName,type:target.type||'',role:target.getAttribute('role')||''};" +
      "})()";
    var resp = await evalInPage(code);
    if (!resp || !resp.ok) return { ok: false, error: (resp && resp.error) || "无法识别点击位置" };
    try {
      var parsed = JSON.parse(resp.result);
      if (!parsed || !parsed.found || !parsed.selector) return { ok: false, error: "点击位置没有可操作元素" };
      return await clickBySelector(evalInPage, parsed.selector);
    } catch (e) {
      return { ok: false, error: "解析点击位置失败: " + (e.message || e) };
    }
  }

  // 关闭浮层时避免直接发送 Escape：在模态框内，Escape 往往会连同父弹框一起关闭。
  async function dismissFloatingLayer(evalInPage) {
    var code = "(function(){" +
      "function visible(n){if(!n)return false;var s=getComputedStyle(n),r=n.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&s.pointerEvents!=='none'&&r.width>0&&r.height>0;}" +
      "var fs='[role=menu],[role=listbox],[role=tree],[class*=popper],[class*=popover],[class*=dropdown],[class*=popup],[class*=listbox]';" +
      "var dialogs=Array.prototype.slice.call(document.querySelectorAll('[role=dialog],[aria-modal=true],[class*=dialog],[class*=modal],[class*=drawer]')).filter(visible);" +
      "var floating=Array.prototype.slice.call(document.querySelectorAll(fs)).filter(function(n){return visible(n)&&!/(dialog|modal|drawer)/i.test(typeof n.className==='string'?n.className:'');});" +
      "if(!floating.length)return {hasFloating:false,hasDialog:dialogs.length>0};" +
      "var dialog=dialogs.sort(function(a,b){return Number(getComputedStyle(b).zIndex||0)-Number(getComputedStyle(a).zIndex||0);})[0];" +
      "if(!dialog)return {hasFloating:true,hasDialog:false};" +
      "var safe=dialog.querySelector('header,[class*=header],[class*=title]');" +
      "if(!safe||floating.some(function(f){return f.contains(safe);})||!visible(safe))return {hasFloating:true,hasDialog:true,error:'未找到弹框内安全空白区'};" +
      "var sr=safe.getBoundingClientRect(),x=sr.left+Math.min(16,sr.width/2),y=sr.top+sr.height/2,hit=document.elementFromPoint(x,y);" +
      "if(!hit||hit.closest('button,a,input,select,textarea,[role=button],[onclick]'))return {hasFloating:true,hasDialog:true,error:'弹框标题区不是安全空白区'};" +
      "return {hasFloating:true,hasDialog:true,x:x,y:y};" +
      "})()";
    var resp = await evalInPage(code);
    if (!resp || !resp.ok) return { ok: false, error: (resp && resp.error) || "无法识别浮层状态" };
    var state;
    try { state = JSON.parse(resp.result); }
    catch (e) { return { ok: false, error: "解析浮层状态失败: " + (e.message || e) }; }
    if (!state.hasFloating) return { ok: false, hasFloating: false, hasDialog: !!state.hasDialog, error: state.hasDialog ? "弹框打开时已阻止 Escape" : "当前无可关闭浮层" };
    if (!state.hasDialog) return { ok: false, hasFloating: true };
    if (typeof state.x !== "number" || typeof state.y !== "number") {
      return { ok: false, hasFloating: true, hasDialog: true, error: state.error || "未找到安全关闭位置，已阻止 Escape" };
    }
    await mouseClick(state.x, state.y);
    await new Promise(function (r) { setTimeout(r, 120); });
    var check = await evalInPage("(function(){var s='[role=menu],[role=listbox],[role=tree],[class*=popper],[class*=popover],[class*=dropdown],[class*=popup],[class*=listbox]';var a=Array.prototype.slice.call(document.querySelectorAll(s));for(var i=0;i<a.length;i++){var n=a[i],c=typeof n.className==='string'?n.className:'';var st=getComputedStyle(n),r=n.getBoundingClientRect();if(!/(dialog|modal|drawer)/i.test(c)&&st.display!=='none'&&st.visibility!=='hidden'&&r.width>0&&r.height>0)return 'open';}return 'closed';})()");
    if (check && check.ok && check.result === "closed") return { ok: true, verified: true };
    return { ok: false, hasFloating: true, error: "浮层未关闭，已阻止 Escape 关闭父弹框" };
  }

  /**
   * 通过 CSS 选择器定位输入框并输入文本（CDP 真实操作）
   * 流程：定位元素 → 滚动到可视区 → CDP 点击聚焦 → Ctrl+A 全选删除 → CDP 输入文本
   * @param {function} evalInPage
   * @param {string} selector
   * @param {string} text
   * @returns {Promise<{ok, error?}>}
   */
  async function typeBySelector(evalInPage, selector, text) {
    var loc = await locateElement(evalInPage, selector);
    if (!loc.ok) return { ok: false, error: loc.error };
    var typed = await typeAtPoint(evalInPage, loc.x, loc.y, text || "");
    if (!typed.ok) return typed;
    var verify = await readElementValue(evalInPage, selector);
    if (verify.ok && String(verify.value) !== String(text || "")) {
      typed = await typeAtPoint(evalInPage, loc.x, loc.y, text || "");
      if (!typed.ok) return typed;
      verify = await readElementValue(evalInPage, selector);
      if (verify.ok && String(verify.value) !== String(text || "")) {
        return { ok: false, error: "输入验证失败，当前值为: " + String(verify.value).substring(0, 80) };
      }
    }
    return { ok: true };
  }

  /**
   * 通过 CSS 选择器滚动到元素位置（CDP 操作）
   * @param {function} evalInPage
   * @param {string} selector
   * @returns {Promise<{ok, error?}>}
   */
  async function scrollToElement(evalInPage, selector) {
    var loc = await locateElement(evalInPage, selector);
    if (!loc.ok) return { ok: false, error: loc.error };
    // 元素已在视口中（locateElement 已滚动），再微调滚轮确保完全可见
    await mouseScroll(loc.x, loc.y, 0, 0);
    return { ok: true };
  }

  /**
   * 通过 CSS 选择器 hover 元素（CDP mouseMoved，模拟真实鼠标悬停）
   * @param {function} evalInPage
   * @param {string} selector
   * @returns {Promise<{ok, error?}>}
   */
  async function hoverBySelector(evalInPage, selector) {
    var loc = await locateElement(evalInPage, selector);
    if (!loc.ok) return { ok: false, error: loc.error };
    // CDP 鼠标移动到元素中心（触发 mousemove → mouseenter → mouseover）
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: loc.x,
      y: loc.y,
      button: "none",
    });
    return { ok: true };
  }

  // Operate on any rendered surface using coordinates relative to its live bounds.
  // This intentionally has no dependency on a charting, canvas, or component library.
  async function interactWithSurface(evalInPage, selector, action, start, end) {
    if (!evalInPage || !selector) return { ok: false, error: "缺少 evalInPage 或交互面 selector" };
    start = start || {};
    end = end || null;
    var validPoint = function(point) {
      return point && typeof point.x === "number" && typeof point.y === "number" &&
        point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
    };
    if (!validPoint(start) || (action === "drag" && !validPoint(end))) {
      return { ok: false, error: "交互面的相对坐标必须在 0 到 1 之间" };
    }
    if (action !== "click" && action !== "drag") return { ok: false, error: "不支持的交互面操作: " + action };

    var inspectCode = "(function(){var el=document.querySelector(" + JSON.stringify(selector) + ");" +
      "if(!el)return JSON.stringify({ok:false,error:'元素不存在'});" +
      "function visible(n){for(var p=n;p&&p!==document.documentElement;p=p.parentElement){var s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.contentVisibility==='hidden'||p.hidden||p.getAttribute('aria-hidden')==='true')return false;}var r=n.getBoundingClientRect();return r.width>0&&r.height>0;}" +
      "var r=el.getBoundingClientRect();if(!visible(el))return JSON.stringify({ok:false,error:'交互面不可见'});" +
      "return JSON.stringify({ok:true,rect:{x:r.left,y:r.top,w:r.width,h:r.height},tag:el.tagName});})()";
    var resp = await evalInPage(inspectCode);
    if (!resp || !resp.ok) return { ok: false, error: (resp && resp.error) || "无法读取交互面位置" };
    var meta;
    try { meta = JSON.parse(resp.result || "{}"); } catch (e) { return { ok: false, error: "交互面信息解析失败" }; }
    if (!meta.ok || !meta.rect) return { ok: false, error: meta.error || "交互面不可用" };

    var point = function(relative) {
      return {
        x: meta.rect.x + meta.rect.w * relative.x,
        y: meta.rect.y + meta.rect.h * relative.y,
      };
    };
    var from = point(start);
    var to = end ? point(end) : null;
    var hitCode = "(function(){var root=document.querySelector(" + JSON.stringify(selector) + ");var hit=document.elementFromPoint(" + from.x + "," + from.y + ");return String(!!root&&!!hit&&(root===hit||root.contains(hit)));})()";
    var hit = await evalInPage(hitCode);
    if (!hit || !hit.ok || hit.result !== "true") return { ok: false, error: "交互起点被其他元素遮挡或不在目标内: " + selector };

    if (action === "drag") await mouseDrag(from.x, from.y, to.x, to.y);
    else await mouseClick(from.x, from.y);
    return { ok: true, action: action, from: from, to: to, tag: meta.tag };
  }

  /**
   * 截图并发送给 AI 视觉分析
   * 返回 base64 图片数据，供 prompt-builder 构建多模态消息
   * @param {Object} options - { clip: {x, y, width, height} } 可选截图区域
   * @returns {Promise<{dataUrl: string, base64: string, width: number, height: number}>}
   */
  async function captureForAI(options) {
    options = options || {};

    // 先获取 CSS 视口尺寸
    var metrics = await getLayoutMetrics();
    var vpWidth = metrics.width || 1280;
    var vpHeight = metrics.height || 800;

    // 使用 clip + scale=1 确保截图尺寸 = CSS 像素尺寸（不受 DPR 影响）
    // 这样 AI 在截图中看到的坐标直接对应 CDP 鼠标坐标
    var clip;
    if (options.clip) {
      clip = {
        x: options.clip.x || 0,
        y: options.clip.y || 0,
        width: options.clip.width || vpWidth,
        height: options.clip.height || vpHeight,
        scale: 1,
      };
    } else {
      // 截取整个视口，scale=1 确保 1:1 CSS 像素
      clip = {
        x: 0,
        y: 0,
        width: vpWidth,
        height: vpHeight,
        scale: 1,
      };
    }

    // 使用 JPEG 格式减小图片体积（PNG 在 Retina 下可达数 MB）
    var base64 = await captureScreenshot({
      format: "jpeg",
      quality: 80,
      clip: clip,
    });

    return {
      dataUrl: "data:image/jpeg;base64," + base64,
      base64: base64,
      width: clip.width,
      height: clip.height,
    };
  }

  /**
   * 标注截图：优先标注当前测试用例关联的控件；无匹配时才使用受上限约束的全局候选。
   * 命中控件集中在一个区域时，自动裁剪截图以降低视觉上下文并保留周边语境。
   * @param {function} evalInPage - 在页面执行 JS 的函数
   * @param {Object} options - { clip?, focusTerms?, maxElements?, autoCrop?, drawOverlay? }
   * @returns {Promise<{dataUrl, base64, width, height, elements: Array}>}
   *   elements: [{label, tag, text, x, y, w, h, selector, placeholder}]
   */
  async function captureAnnotatedForAI(evalInPage, options) {
    options = options || {};
    var metrics = await getLayoutMetrics();
    var vpWidth = metrics.width || 1280;
    var vpHeight = metrics.height || 800;
    var focusTerms = Array.isArray(options.focusTerms) ? options.focusTerms.slice(0, 32) : [];
    var maxElements = Math.max(1, Math.min(Number(options.maxElements) || (focusTerms.length ? 14 : 18), 24));
    var drawOverlay = options.drawOverlay !== false;

    // 1. 注入标注 overlay，获取元素列表
    var annotateCode = "(function() {" +
      "  var existing = document.getElementById('__aift_anno__');" +
      "  if (existing) existing.remove();" +
      "  var focusTerms = " + JSON.stringify(focusTerms) + ";" +
      "  var maxElements = " + maxElements + ";" +
      "  var drawOverlay = " + (drawOverlay ? "true" : "false") + ";" +
      "  var autoCrop = " + (options.autoCrop !== false ? "true" : "false") + ";" +
      "  var STANDARD = [" +
      "    'a[href]','button:not([disabled])','input:not([disabled]):not([type=hidden])'," +
      "    'select:not([disabled])','textarea:not([disabled])'," +
      "    '[role=button]','[role=link]','[role=checkbox]','[role=radio]','[role=textbox]'," +
      "    '[role=combobox]','[role=menuitem]','[role=menuitemradio]','[role=menuitemcheckbox]'," +
      "    '[role=tab]','[role=option]','[role=switch]','[role=treeitem]'," +
      "    '[contenteditable=true]','[onclick]','[tabindex]'" +
      "  ].join(',');" +
      "  var rawEls = document.querySelectorAll(STANDARD);" +
      "  var seen = {};" +
      "  var els = [];" +
      "  function tryAdd(el) {" +
      "    if (!el || !el.tagName) return;" +
      "    var st = getComputedStyle(el);" +
      "    if (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none') return;" +
      "    var r = el.getBoundingClientRect();" +
      "    if (r.width < 6 || r.height < 6) return;" +
      "    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return;" +
      "    var key = Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + ',' + Math.round(r.height);" +
      "    if (seen[key]) return;" +
      "    seen[key] = true;" +
      "    els.push(el);" +
      "  }" +
      "  for (var ri = 0; ri < rawEls.length; ri++) tryAdd(rawEls[ri]);" +
      "  /* 通用识别：扫描所有元素，根据以下特征判断是否可交互 */" +
      "  var allEls = document.querySelectorAll('*');" +
      "  for (var ci = 0; ci < allEls.length; ci++) {" +
      "    var cel = allEls[ci];" +
      "    var tag = cel.tagName.toLowerCase();" +
      "    if (['html','head','meta','link','script','style','br','hr','img','input','textarea','select','button','a'].indexOf(tag) !== -1) continue;" +
      "    var cst = getComputedStyle(cel);" +
      "    if (cst.display === 'none' || cst.visibility === 'hidden' || cst.pointerEvents === 'none') continue;" +
      "    var r2 = cel.getBoundingClientRect();" +
      "    if (r2.width < 8 || r2.height < 8) continue;" +
      "    if (r2.bottom < 0 || r2.top > window.innerHeight || r2.right < 0 || r2.left > window.innerWidth) continue;" +
      "    var isInteractive = false;" +
      "    if (cst.cursor === 'pointer') isInteractive = true;" +
      "    else if (cel.hasAttribute('onclick') || cel.hasAttribute('onmousedown') || cel.hasAttribute('onmouseup')) isInteractive = true;" +
      "    else {" +
      "      try {" +
      "        if (window.getEventListeners && window.getEventListeners(cel).click) isInteractive = true;" +
      "      } catch(e) {}" +
      "    }" +
      "    if (isInteractive) tryAdd(cel);" +
      "  }" +
      "  var elements = [];" +
      "  var label = 0;" +
      "  function buildSel(el) {" +
      "    if (el.id && !/^\\d+$/.test(el.id)) return '#' + el.id;" +
      "    var tid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');" +
      "    if (tid) return '[data-testid=\"' + tid + '\"]';" +
      "    if (el.className && typeof el.className === 'string') {" +
      "      var cs = el.className.trim().split(/\\s+/).filter(function(c){return c && !/^(el-|ant-|ivu-|v-|is-|has-)/.test(c) && c.length > 1;});" +
      "      if (cs.length) { var s = el.tagName.toLowerCase() + '.' + cs.join('.'); try { if (document.querySelectorAll(s).length === 1) return s; } catch(e){} }" +
      "    }" +
      "    return el.tagName.toLowerCase();" +
      "  }" +
      "  for (var i = 0; i < els.length; i++) {" +
      "    var el = els[i];" +
      "    var st = getComputedStyle(el);" +
      "    if (parseFloat(st.opacity) === 0) continue;" +
      "    var r = el.getBoundingClientRect();" +
      "    var tag = el.tagName.toLowerCase();" +
      "    if ((tag === 'span' || tag === 'p' || tag === 'label') && st.cursor !== 'pointer' && !el.hasAttribute('onclick') && !el.hasAttribute('role') && el.children.length === 0) continue;" +
      "    label++;" +
      "    elements.push({" +
      "      label: label, tag: tag," +
      "      text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().substring(0, 80)," +
      "      placeholder: el.getAttribute('placeholder') || ''," +
      "      ariaLabel: el.getAttribute('aria-label') || ''," +
      "      name: el.getAttribute('name') || ''," +
      "      id: el.id || ''," +
      "      context: (function(n){return String(n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim().substring(0, 180);})(el.closest('form,[role=dialog],[role=region],section,article,li,tr,.modal,.dialog,.drawer') || el.parentElement || el)," +
      "      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)," +
      "      w: Math.round(r.width), h: Math.round(r.height)," +
      "      rx: Math.round(r.x), ry: Math.round(r.y)," +
      "      rw: Math.round(r.width), rh: Math.round(r.height)," +
      "      selector: buildSel(el)" +
      "    });" +
      "  }" +
      "  if (elements.length === 0) return JSON.stringify({elements: [], error: 'no elements'});" +
      "  function score(e) { var hay=(e.text+' '+e.placeholder+' '+e.ariaLabel+' '+e.name+' '+e.id+' '+e.context).toLowerCase(); var total=0; for(var ti=0;ti<focusTerms.length;ti++){var term=String(focusTerms[ti]||'').toLowerCase();if(!term)continue;if(hay.indexOf(term)!==-1)total+=term.length>=3?4:2;} return total; }" +
      "  for (var si = 0; si < elements.length; si++) elements[si].score = score(elements[si]);" +
      "  var focused = focusTerms.length > 0 && elements.some(function(e){ return e.score > 0; });" +
      "  if (focused) elements = elements.filter(function(e){ return e.score > 0; }).sort(function(a,b){ return b.score-a.score; }).slice(0,maxElements); else elements = elements.slice(0,maxElements);" +
      "  for (var li = 0; li < elements.length; li++) elements[li].label = li + 1;" +
      "  var crop = null;" +
      "  if (focused && autoCrop && elements.length) { var minX=window.innerWidth,minY=window.innerHeight,maxX=0,maxY=0; for(var bi=0;bi<elements.length;bi++){var be=elements[bi];minX=Math.min(minX,be.rx);minY=Math.min(minY,be.ry);maxX=Math.max(maxX,be.rx+be.rw);maxY=Math.max(maxY,be.ry+be.rh);} var pad=72;minX=Math.max(0,minX-pad);minY=Math.max(0,minY-pad);maxX=Math.min(window.innerWidth,maxX+pad);maxY=Math.min(window.innerHeight,maxY+pad);var width=Math.max(260,maxX-minX),height=Math.max(180,maxY-minY);width=Math.min(window.innerWidth,width);height=Math.min(window.innerHeight,height);minX=Math.min(minX,window.innerWidth-width);minY=Math.min(minY,window.innerHeight-height);if(width*height < window.innerWidth*window.innerHeight*0.78)crop={x:Math.round(minX),y:Math.round(minY),width:Math.round(width),height:Math.round(height)}; }" +
      "  if (drawOverlay) { var canvas = document.createElement('canvas');" +
      "  canvas.id = '__aift_anno__';" +
      "  canvas.style.cssText = 'position:fixed;top:0;left:0;width:' + window.innerWidth + 'px;height:' + window.innerHeight + 'px;z-index:999999;pointer-events:none;';" +
      "  canvas.width = window.innerWidth;" +
      "  canvas.height = window.innerHeight;" +
      "  var ctx = canvas.getContext('2d');" +
      "  ctx.font = 'bold 13px Arial';" +
      "  for (var j = 0; j < elements.length; j++) {" +
      "    var e = elements[j];" +
      "    ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = 2;" +
      "    ctx.strokeRect(e.rx, e.ry, e.rw, e.rh);" +
      "    var lt = String(e.label);" +
      "    var tw = ctx.measureText(lt).width;" +
      "    ctx.fillStyle = '#e74c3c';" +
      "    ctx.fillRect(e.rx, e.ry, tw + 10, 18);" +
      "    ctx.fillStyle = '#ffffff';" +
      "    ctx.fillText(lt, e.rx + 5, e.ry + 13);" +
      "  }" +
      "  document.body.appendChild(canvas); }" +
      "  var clean = elements.map(function(e) { return {label:e.label, tag:e.tag, text:e.text, placeholder:e.placeholder, x:e.x, y:e.y, w:e.w, h:e.h, selector:e.selector, score:e.score}; });" +
      "  return JSON.stringify({elements: clean, focused: focused, crop: crop, focusTerms: focusTerms});" +
      "})()";

    var annoResult = await evalInPage(annotateCode);
    var elements = [];
    var annotationMeta = { focused: false, crop: null, focusTerms: [] };
    if (annoResult && annoResult.ok && annoResult.result) {
      try {
        var parsed = JSON.parse(annoResult.result);
        elements = parsed.elements || [];
        annotationMeta.focused = !!parsed.focused;
        annotationMeta.crop = parsed.crop || null;
        annotationMeta.focusTerms = parsed.focusTerms || [];
      } catch(e) {
        console.warn("[AIFT-Visual] 解析标注结果失败: " + (e.message || e));
      }
    }

    // 2. 截图（此时 overlay 已在页面上，会被截到截图中）
    var clip;
    if (options.clip) {
      clip = {
        x: options.clip.x || 0, y: options.clip.y || 0,
        width: options.clip.width || vpWidth, height: options.clip.height || vpHeight,
        scale: 1,
      };
    } else if (annotationMeta.crop) {
      clip = {
        x: (metrics.pageX || 0) + annotationMeta.crop.x,
        y: (metrics.pageY || 0) + annotationMeta.crop.y,
        width: annotationMeta.crop.width,
        height: annotationMeta.crop.height,
        scale: 1,
      };
    } else {
      clip = { x: 0, y: 0, width: vpWidth, height: vpHeight, scale: 1 };
    }
    var base64;
    try {
      base64 = await captureScreenshot({ format: "jpeg", quality: 80, clip: clip });
    } finally {
      try {
        await evalInPage("(function(){ var e = document.getElementById('__aift_anno__'); if (e) e.remove(); })()");
      } catch(e) {}
    }

    return {
      dataUrl: "data:image/jpeg;base64," + base64,
      base64: base64,
      width: clip.width,
      height: clip.height,
      elements: elements,
      focused: annotationMeta.focused,
      cropped: !!annotationMeta.crop,
      focusTerms: annotationMeta.focusTerms,
      drawOverlay: drawOverlay,
    };
  }

  /**
   * 检查 debugger 是否已附加
   */
  function isAttached() {
    return attached;
  }

  /**
   * 确保 debugger 已附加到指定 tab
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function ensureAttached(tabId) {
    if (attached && currentTabId === tabId) return;
    await attach(tabId);
  }

  global.AIFT_VisualController = {
    attach: attach,
    detach: detach,
    isAttached: isAttached,
    ensureAttached: ensureAttached,
    sendCommand: sendCommand,
    captureScreenshot: captureScreenshot,
    captureForAI: captureForAI,
    captureAnnotatedForAI: captureAnnotatedForAI,
    getLayoutMetrics: getLayoutMetrics,
    mouseClick: mouseClick,
    mouseHover: mouseHover,
    mouseDoubleClick: mouseDoubleClick,
    mouseRightClick: mouseRightClick,
    mouseDrag: mouseDrag,
    mouseScroll: mouseScroll,
    keyboardType: keyboardType,
    keyboardPress: keyboardPress,
    keyboardCombo: keyboardCombo,
    clearFocusedText: clearFocusedText,
    readElementValue: readElementValue,
    readActiveValue: readActiveValue,
    typeAtPoint: typeAtPoint,
    clickAndType: clickAndType,
    // 基于 CSS 选择器的 CDP 动作（模拟真实用户操作）
    locateElement: locateElement,
    clickBySelector: clickBySelector,
    clickAtPoint: clickAtPoint,
    dismissFloatingLayer: dismissFloatingLayer,
    typeBySelector: typeBySelector,
    scrollToElement: scrollToElement,
    hoverBySelector: hoverBySelector,
    interactWithSurface: interactWithSurface,
  };
})(window);
