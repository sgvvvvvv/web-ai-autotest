// content script：DOM 快照采集 + 元素选择器生成 + 消息监听
// 注意：这里不模拟用户操作。点击、输入、滚动等写操作统一由 Side Panel 通过 CDP 执行。
(function () {
  if (window.__AIFT_INJECTED__) return;
  window.__AIFT_INJECTED__ = true;

  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type=hidden])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=textbox]",
    "[role=combobox]",
    "[role=menuitem]",
    "[role=tab]",
    "[role=option]",
    "[role=treeitem]",
    "canvas",
    "svg",
    "video",
    "[role=img]",
    "[contenteditable=true]",
    "[onclick]",
    "[tabindex]",
    // 下拉框选项（框架无关）— 让 AI 能在快照中看到可选项
    ".el-select-dropdown__item",
    ".el-cascader",
    ".el-cascader-node",
    ".ant-select-item",
    ".ant-select-item-option",
    ".v-list-item",
    ".q-item",
    ".dropdown-item",
    ".MuiMenuItem-root",
    ".MuiAutocomplete-option",
  ].join(",");

  // 很多组件将选项挂到 body 下的浮层中，且没有 button/role 等语义。
  // 仅在浮层容器内采集这些常见候选，避免将页面中的普通布局节点误报为可点击元素。
  const FLOATING_ITEM_SELECTOR = [
    "[class*='option']",
    "[class*='item']",
    "[class*='menu']",
    "[class*='node']",
    "[class*='checkbox']",
    "[class*='radio']",
    "li",
    "label",
  ].join(",");

  function isVisible(el) {
    if (!el) return false;
    for (var current = el; current && current !== document.documentElement; current = current.parentElement) {
      var style = getComputedStyle(current);
      if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
      if (style.display === "none" || style.visibility === "hidden" || style.contentVisibility === "hidden") return false;
      if (parseFloat(style.opacity) === 0) return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }

  function truncate(str, n) {
    if (!str) return "";
    str = String(str).replace(/\s+/g, " ").trim();
    return str.length > n ? str.slice(0, n) + "…" : str;
  }

  function getControlLabel(el) {
    if (!el) return "";
    var text = "";
    try {
      if (el.id) {
        var explicit = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (explicit) text += " " + (explicit.innerText || explicit.textContent || "");
      }
    } catch (e) {}
    var wrapped = el.closest("label,.el-form-item,.ant-form-item,.form-item,.field,.MuiFormControl-root,.v-input,.q-field");
    if (wrapped) text += " " + (wrapped.innerText || wrapped.textContent || "");
    text += " " + (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.name || el.placeholder || "");
    return truncate(text, 80);
  }

  function cssAttr(name, value) {
    return "[" + name + "=\"" + String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"]";
  }

  function captureVisibleText(maxChars) {
    var body = document.body;
    if (!body) return "";
    var txt = body.innerText || body.textContent || "";
    txt = txt.replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (txt.length > maxChars) txt = txt.slice(0, maxChars) + "…（已截断）";
    return txt;
  }

  /**
   * 为元素生成一个可用的 CSS 选择器
   * 优先级：id > [data-testid] > [data-qa] > class组合 > tag+nth-child
   */
  function buildSelector(el) {
    if (!el) return "";
    // 1. id
    var id = el.getAttribute("id");
    if (id && !/^\d+$/.test(id)) return "#" + CSS.escape(id);
    // 2. data-testid / data-test / data-qa
    var testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa");
    if (testId) return cssAttr(el.getAttribute("data-testid") ? "data-testid" : (el.getAttribute("data-test") ? "data-test" : "data-qa"), testId);
    // 3. class 组合（取有意义的 class）
    var cls = el.className;
    if (cls && typeof cls === "string") {
      var classes = cls.split(/\s+/).filter(function (c) {
        return c && !/^(el-|ant-|ivu-|v-|is-|has-)/.test(c) && c.length > 1;
      });
      if (classes.length > 0) {
        var tag = el.tagName.toLowerCase();
        var selector = tag + "." + classes.map(function (c) { return CSS.escape(c); }).join(".");
        // 验证唯一性
        try {
          if (document.querySelectorAll(selector).length === 1) return selector;
        } catch (e) {}
      }
    }
    // 4. tag + 文本内容定位（通过 contains）
    var text = (el.innerText || el.textContent || "").trim();
    if (text && text.length < 30) {
      // 用属性组合定位
      var tag2 = el.tagName.toLowerCase();
      var attrs = [];
      if (el.getAttribute("role")) attrs.push(cssAttr("role", el.getAttribute("role")));
      if (el.getAttribute("type")) attrs.push(cssAttr("type", el.getAttribute("type")));
      if (el.getAttribute("name")) attrs.push(cssAttr("name", el.getAttribute("name")));
      if (el.getAttribute("placeholder")) attrs.push(cssAttr("placeholder", el.getAttribute("placeholder")));
      if (el.getAttribute("href")) attrs.push(cssAttr("href", el.getAttribute("href")));
      if (attrs.length > 0) {
        var attrSelector = tag2 + attrs.join("");
        try {
          if (document.querySelectorAll(attrSelector).length === 1) return attrSelector;
        } catch (e) {}
      }
    }
    // 5. 回退：tag + nth-child 路径
    var path = [];
    var current = el;
    while (current && current !== document.body) {
      var siblings = Array.prototype.slice.call(current.parentElement ? current.parentElement.children : []);
      var index = siblings.indexOf(current) + 1;
      var t = current.tagName.toLowerCase();
      path.unshift(t + ":nth-child(" + index + ")");
      current = current.parentElement;
    }
    return path.join(" > ");
  }

  function isInFloatingLayer(el) {
    var current = el;
    for (var depth = 0; current && current !== document.body && depth < 12; depth++, current = current.parentElement) {
      var cls = typeof current.className === "string" ? current.className.toLowerCase() : "";
      var role = current.getAttribute("role") || "";
      if (role === "menu" || role === "listbox" || role === "dialog" || role === "tree") return true;
      if (/popper|popover|dropdown|overlay|popup|menu|listbox|tooltip/.test(cls)) return true;
    }
    return false;
  }

  function captureSnapshot() {
    const nodes = [];
    var elements = [];
    var floatingCandidates = document.querySelectorAll(FLOATING_ITEM_SELECTOR);
    floatingCandidates.forEach(function (el) {
      if (isInFloatingLayer(el)) elements.push(el);
    });
    // 浮层候选优先放入快照，避免长页面的常规控件耗尽模型上下文窗口。
    elements = elements.concat(Array.prototype.slice.call(document.querySelectorAll(INTERACTIVE_SELECTOR)));
    var seen = new Set();
    elements.forEach(function (el) {
      if (seen.has(el)) return;
      seen.add(el);
      if (!isVisible(el)) return;
      const rect = el.getBoundingClientRect();
      var selector = buildSelector(el);
      nodes.push({
        ref: "e" + (nodes.length + 1),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.getAttribute("id") || "",
        className: (typeof el.className === "string") ? el.className.substring(0, 80) : "",
        text: truncate(el.innerText || el.textContent || "", 60),
        value: truncate(el.value || "", 60),
        label: getControlLabel(el),
        checked: !!el.checked,
        selected: el.getAttribute("aria-selected") === "true" || !!el.selected,
        ariaChecked: el.getAttribute("aria-checked") || "",
        placeholder: el.getAttribute("placeholder") || "",
        href: el.getAttribute("href") || "",
        inFloatingLayer: isInFloatingLayer(el),
        selector: selector,
        visible: true,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
    });

    return {
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      interactiveCount: nodes.length,
      nodes: nodes,
      pageText: captureVisibleText(5000),
    };
  }

  // ---- 运行时导航菜单提取 ----

  /**
   * 从已渲染的 DOM 中提取导航菜单结构
   * 针对动态路由项目：路由通过 API 获取后渲染到菜单，源码中找不到
   * 这里直接从 DOM 提取实际渲染的菜单项
   */
  function captureNavigation() {
    var navItems = [];
    var seen = {};

    function addNav(text, path, parent) {
      if (!text || !path) return;
      text = text.replace(/\s+/g, " ").trim();
      if (text.length === 0 || text.length > 60) return;
      var key = text + "|" + path;
      if (seen[key]) return;
      seen[key] = true;
      navItems.push({ text: text, path: path, parent: parent || "" });
    }

    // 1. <a href="/path">文本</a> — 最通用
    var links = document.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (!isVisible(a)) continue;
      var href = a.getAttribute("href") || "";
      // 过滤外部链接和锚点
      if (href.indexOf("http") === 0 && href.indexOf(location.host) === -1) continue;
      if (href === "#" || href.indexOf("javascript:") === 0 || href === "") continue;
      var text = a.innerText || a.textContent || "";
      if (text) addNav(text, href, "");
    }

    // 2. el-menu / el-submenu (Element UI/Plus)
    var submenus = document.querySelectorAll(".el-submenu, .el-menu-item, .el-menu-submenu");
    for (var j = 0; j < submenus.length; j++) {
      var el = submenus[j];
      if (!isVisible(el)) continue;
      var elText = "";
      var titleEl = el.querySelector(".el-menu-item__text, .el-submenu__title");
      if (titleEl) elText = titleEl.innerText || titleEl.textContent || "";
      else elText = el.innerText || el.textContent || "";
      // 尝试找子级 <a>
      var innerA = el.querySelector("a[href]");
      var elPath = innerA ? innerA.getAttribute("href") : "";
      // 尝试从 data 属性获取路径
      if (!elPath) elPath = el.getAttribute("data-path") || el.getAttribute("index") || "";
      if (elText && elPath) {
        // 查找父级 submenu 标题
        var parentEl = el.closest(".el-submenu");
        var parentText = "";
        if (parentEl) {
          var parentTitle = parentEl.querySelector(".el-submenu__title");
          if (parentTitle) parentText = (parentTitle.innerText || parentTitle.textContent || "").trim();
        }
        addNav(elText, elPath, parentText);
      }
    }

    // 3. antd Menu (Ant Design)
    var antdItems = document.querySelectorAll(".ant-menu-item, .ant-menu-submenu-title");
    for (var k = 0; k < antdItems.length; k++) {
      var antdEl = antdItems[k];
      if (!isVisible(antdEl)) continue;
      var antdText = (antdEl.innerText || antdEl.textContent || "").trim();
      var antdA = antdEl.querySelector("a[href]") || (antdEl.tagName === "A" ? antdEl : null);
      var antdPath = antdA ? antdA.getAttribute("href") : "";
      if (antdText && antdPath) {
        var antdParent = antdEl.closest(".ant-menu-submenu");
        var antdParentText = "";
        if (antdParent) {
          var antdParentTitle = antdParent.querySelector(".ant-menu-submenu-title");
          if (antdParentTitle) antdParentText = (antdParentTitle.innerText || antdParentTitle.textContent || "").trim();
        }
        addNav(antdText, antdPath, antdParentText);
      }
    }

    // 4. 通用：[role="menuitem"] 和 [role="menu"]
    var roleItems = document.querySelectorAll('[role="menuitem"]');
    for (var l = 0; l < roleItems.length; l++) {
      var ri = roleItems[l];
      if (!isVisible(ri)) continue;
      var riText = (ri.innerText || ri.textContent || "").trim();
      var riA = ri.querySelector("a[href]") || (ri.tagName === "A" ? ri : null);
      var riPath = riA ? riA.getAttribute("href") : "";
      if (!riPath) riPath = ri.getAttribute("data-path") || "";
      if (riText && riPath) addNav(riText, riPath, "");
    }

    // 5. sidebar/nav 容器内的链接（兜底）
    var navContainers = document.querySelectorAll("nav, aside, .sidebar, .side-menu, .navigation, [class*='menu'], [class*='nav']");
    for (var c = 0; c < navContainers.length; c++) {
      var container = navContainers[c];
      var containerLinks = container.querySelectorAll("a[href]");
      for (var cl = 0; cl < containerLinks.length; cl++) {
        var cLink = containerLinks[cl];
        if (!isVisible(cLink)) continue;
        var cHref = cLink.getAttribute("href") || "";
        if (cHref.indexOf("http") === 0 && cHref.indexOf(location.host) === -1) continue;
        if (cHref === "#" || cHref.indexOf("javascript:") === 0 || cHref === "") continue;
        var cText = (cLink.innerText || cLink.textContent || "").trim();
        if (cText) addNav(cText, cHref, "");
      }
    }

    return navItems.slice(0, 80);
  }

  // 统一暴露所有函数，避免多次赋值覆盖
  window.__AIFT__ = {
    captureSnapshot: captureSnapshot,
    captureNavigation: captureNavigation,
  };

  // ---- 消息监听 ----
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === "AIFT_CAPTURE_SNAPSHOT") {
      try {
        const snapshot = captureSnapshot();
        sendResponse({ ok: true, snapshot: snapshot });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) ? e.message : e) });
      }
      return true;
    }
    if (msg.type === "AIFT_PING") {
      sendResponse({ ok: true, pong: true, url: location.href });
      return true;
    }
    if (msg.type === "AIFT_CAPTURE_NAVIGATION") {
      try {
        var nav = captureNavigation();
        sendResponse({ ok: true, navigation: nav });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) ? e.message : e) });
      }
      return true;
    }
  });
})();
