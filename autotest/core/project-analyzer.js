// project-analyzer.js
// 项目架构分析模块：路由地图 + 导航结构 + API 映射 + 组件归属
// 在 Side Panel 上下文中运行（sidepanel.js 通过 <script> 引入）

(function (global) {
  "use strict";

  var CACHE_KEY = "aift_arch_cache";
  var MAX_API_CALLS = 80;
  var MAX_ROUTES = 60;
  var MAX_NAV_ITEMS = 50;

  // ============================================================
  // 1. 启发式分析（正则扫描源码，提取原始结构）
  // ============================================================

  /**
   * 分析路由配置
   * 支持：React Router (JSX + config)、Vue Router、Next.js 约定式路由
   */
  function analyzeRoutes(sourceFiles) {
    var routes = [];
    var seen = {};

    for (var path in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(path)) continue;
      var content = sourceFiles[path];
      var lowerPath = path.toLowerCase();

      // --- React Router JSX: <Route path="/x" component={X} /> ---
      var re1 = /<Route\s+[^>]*path=["']([^"']+)["'][^>]*(?:component|element)\s*=\s*\{?\s*(?:<)?(\w+)/g;
      var m;
      while ((m = re1.exec(content)) !== null) {
        var rp = m[1];
        var comp = m[2];
        if (!seen[rp]) {
          seen[rp] = true;
          routes.push({ path: rp, component: comp, source: path, framework: "react" });
        }
      }

      // --- React Router config: { path: "/x", element: <X /> } 或 { path: "/x", component: X } ---
      var re2 = /path:\s*["']([^"']+)["']\s*,\s*(?:element|component)\s*:\s*(?:<)?(\w+)/g;
      while ((m = re2.exec(content)) !== null) {
        if (!seen[m[1]]) {
          seen[m[1]] = true;
          routes.push({ path: m[1], component: m[2], source: path, framework: "react" });
        }
      }

      // --- Vue Router: { path: '/x', name: 'x', component: ... } ---
      var re3 = /path:\s*['"]([^'"]+)['"]\s*,\s*(?:name:\s*['"]([^'"]*)['"]\s*,\s*)?component/g;
      while ((m = re3.exec(content)) !== null) {
        if (!seen[m[1]]) {
          seen[m[1]] = true;
          routes.push({ path: m[1], component: m[2] || "", name: m[2] || "", source: path, framework: "vue" });
        }
      }

      // --- Vue Router 动态导入: component: () => import('@/views/X.vue') ---
      var re4 = /path:\s*['"]([^'"]+)['"][^}]*?import\(['"]([^'"]+\.vue)['"]\)/g;
      while ((m = re4.exec(content)) !== null) {
        if (!seen[m[1]]) {
          seen[m[1]] = true;
          var importPath = m[2].replace(/^@\/?/, "");
          routes.push({ path: m[1], component: importPath, source: path, framework: "vue" });
        }
      }

      // --- Next.js 约定式路由: pages/xxx/yyy.tsx 或 app/xxx/yyy/page.tsx ---
      if (lowerPath.indexOf("pages/") === 0 || /pages\//.test(lowerPath)) {
        var pageMatch = path.match(/pages\/(.+)\.(?:tsx|jsx|ts|js|vue)$/);
        if (pageMatch) {
          var routePath = "/" + pageMatch[1].replace(/\/index$/, "").replace(/^index$/, "");
          if (!routePath) routePath = "/";
          if (!seen[routePath]) {
            seen[routePath] = true;
            routes.push({ path: routePath, component: pageMatch[1], source: path, framework: "next" });
          }
        }
      }
      if (/app\/.*\/page\.(?:tsx|jsx)$/.test(lowerPath)) {
        var appMatch = path.match(/app\/(.+)\/page\.(?:tsx|jsx)$/);
        if (appMatch) {
          var appRoute = "/" + appMatch[1];
          if (!seen[appRoute]) {
            seen[appRoute] = true;
            routes.push({ path: appRoute, component: appMatch[1], source: path, framework: "next" });
          }
        }
      }
    }

    return routes.slice(0, MAX_ROUTES);
  }

  /**
   * 分析导航/菜单结构
   * 扫描 menu/sidebar/nav/layout 组件，提取菜单项与路由的对应关系
   */
  function analyzeNavigation(sourceFiles) {
    var navItems = [];
    var navFileKeywords = ["menu", "sidebar", "nav", "layout", "router", "route"];

    for (var path in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(path)) continue;
      var lowerPath = path.toLowerCase();
      var isNavFile = false;
      for (var i = 0; i < navFileKeywords.length; i++) {
        if (lowerPath.indexOf(navFileKeywords[i]) !== -1) {
          isNavFile = true;
          break;
        }
      }
      if (!isNavFile) continue;

      var content = sourceFiles[path];

      // { text: '运营概览', path: '/overview' }
      var re1 = /(?:text|label|title|name)\s*:\s*['"]([^'"]+)['"]\s*,\s*(?:path|route|to|index)\s*:\s*['"]([^'"]+)['"]/g;
      var m;
      while ((m = re1.exec(content)) !== null) {
        navItems.push({ text: m[1], path: m[2], source: path });
      }

      // { path: '/overview', text: '运营概览' } (reversed order)
      var re2 = /(?:path|route|to|index)\s*:\s*['"]([^'"]+)['"]\s*,\s*(?:text|label|title|name)\s*:\s*['"]([^'"]+)['"]/g;
      while ((m = re2.exec(content)) !== null) {
        navItems.push({ text: m[2], path: m[1], source: path });
      }

      // <el-menu-item index="/overview">运营概览</el-menu-item>
      var re3 = /<(?:el-)?menu-item\s+[^>]*(?:index|to|path)=["']([^"']+)["'][^>]*>([^<]+)</g;
      while ((m = re3.exec(content)) !== null) {
        navItems.push({ text: m[2].trim(), path: m[1], source: path });
      }

      // <MenuItem to="/overview">运营概览</MenuItem>
      var re4 = /<MenuItem\s+[^>]*to=["']([^"']+)["'][^>]*>([^<]+)</g;
      while ((m = re4.exec(content)) !== null) {
        navItems.push({ text: m[2].trim(), path: m[1], source: path });
      }

      // <Link to="/overview">运营概览</Link>
      var re5 = /<Link\s+[^>]*to=["']([^"']+)["'][^>]*>([^<]+)</g;
      while ((m = re5.exec(content)) !== null) {
        navItems.push({ text: m[2].trim(), path: m[1], source: path });
      }
    }

    // 去重
    var seen = {};
    var unique = [];
    for (var j = 0; j < navItems.length; j++) {
      var key = navItems[j].text + "|" + navItems[j].path;
      if (!seen[key]) {
        seen[key] = true;
        unique.push(navItems[j]);
      }
    }
    return unique.slice(0, MAX_NAV_ITEMS);
  }

  /**
   * 分析 API 调用
   * 扫描 fetch/axios/request 调用，关联到所在文件
   */
  function analyzeApiCalls(sourceFiles) {
    var apis = [];

    for (var path in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(path)) continue;
      var content = sourceFiles[path];

      // fetch('url') / fetch(`url`)
      var re1 = /fetch\s*\(\s*['"`]([^'"`]+)['"`]/g;
      var m;
      while ((m = re1.exec(content)) !== null) {
        apis.push({ url: m[1], method: "GET", source: path });
      }

      // axios.get('url') / axios.post('url') etc.
      var re2 = /axios\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
      while ((m = re2.exec(content)) !== null) {
        apis.push({ url: m[2], method: m[1].toUpperCase(), source: path });
      }

      // request.get('url') / request.post('url') etc.
      var re3 = /request\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
      while ((m = re3.exec(content)) !== null) {
        apis.push({ url: m[2], method: m[1].toUpperCase(), source: path });
      }

      // this.$http.get('url') etc.
      var re4 = /\$http\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
      while ((m = re4.exec(content)) !== null) {
        apis.push({ url: m[2], method: m[1].toUpperCase(), source: path });
      }

      // request({ url: '/api/...', method: 'POST' })
      var re5 = /url\s*:\s*['"`]([^'"`]+)['"`]/g;
      while ((m = re5.exec(content)) !== null) {
        if (m[1].indexOf("/api/") !== -1 || m[1].indexOf("http") === 0) {
          apis.push({ url: m[1], method: "GET", source: path });
        }
      }
    }

    // 去重
    var seen = {};
    var unique = [];
    for (var j = 0; j < apis.length; j++) {
      var key = apis[j].url + "|" + apis[j].method;
      if (!seen[key]) {
        seen[key] = true;
        unique.push(apis[j]);
      }
    }
    return unique.slice(0, MAX_API_CALLS);
  }

  /**
   * 分析组件-文件映射
   * 建立页面 → 组件列表的映射关系
   */
  function analyzeComponents(sourceFiles, routes) {
    var componentMap = {}; // { routePath: [componentNames] }

    // 从路由配置中提取的组件
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      var path = r.path;
      if (!componentMap[path]) componentMap[path] = [];
      if (r.component) componentMap[path].push(r.component);
    }

    // 扫描 import 语句，建立组件 → 文件路径映射
    var componentFiles = {}; // { componentName: filePath }
    for (var filePath in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(filePath)) continue;
      var content = sourceFiles[filePath];
      // import X from './path' / import { X } from './path'
      var re = /import\s+(?:\{?\s*(\w+)\s*\}?\s+from\s+|import\s+(\w+)\s+from\s+)/g;
      var m;
      while ((m = re.exec(content)) !== null) {
        var comp = m[1] || m[2];
        if (comp && comp.length > 1 && comp.length < 50) {
          if (!componentFiles[comp]) componentFiles[comp] = filePath;
        }
      }
    }

    return { componentMap: componentMap, componentFiles: componentFiles };
  }

  /**
   * 分析动态路由
   * 识别运行时动态注册的路由模式：
   * - router.addRoute() / router.addRoutes()
   * - 菜单/路由 API 调用（/api/menu, /api/routes, /api/permission 等）
   * - asyncRoutes / dynamicRoutes 变量
   * - router.beforeEach 中的路由拉取逻辑
   */
  function analyzeDynamicRoutes(sourceFiles) {
    var dynamicRoutes = [];
    var menuApis = [];
    var seen = {};

    for (var path in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(path)) continue;
      var content = sourceFiles[path];
      var m;

      // --- router.addRoute({ path: '/x', ... }) ---
      var re1 = /router\.addRoute\s*\(\s*\{[^}]*path\s*:\s*['"]([^'"]+)['"]/g;
      while ((m = re1.exec(content)) !== null) {
        if (!seen[m[1]]) {
          seen[m[1]] = true;
          dynamicRoutes.push({ path: m[1], source: path, type: "addRoute" });
        }
      }

      // --- router.addRoutes([{ path: '/x', ... }]) ---
      var re2 = /router\.addRoutes\s*\(/g;
      if (re2.exec(content)) {
        // addRoutes 通常传入变量，提取同文件中的 path 定义
        var re2b = /path\s*:\s*['"]([^'"]+)['"]/g;
        while ((m = re2b.exec(content)) !== null) {
          if (!seen[m[1]]) {
            seen[m[1]] = true;
            dynamicRoutes.push({ path: m[1], source: path, type: "addRoutes" });
          }
        }
      }

      // --- asyncRoutes / dynamicRoutes 变量中的 path ---
      var re3 = /(?:asyncRoutes|dynamicRoutes|constantRoutes|permissionRoutes)\s*[:=]\s*\[/g;
      if (re3.exec(content)) {
        var re3b = /path\s*:\s*['"]([^'"]+)['"]/g;
        while ((m = re3b.exec(content)) !== null) {
          if (!seen[m[1]]) {
            seen[m[1]] = true;
            dynamicRoutes.push({ path: m[1], source: path, type: "dynamicVar" });
          }
        }
      }

      // --- 菜单/路由 API: GET /api/menu, /api/routes, /api/permission, /api/user/menu 等 ---
      var menuApiPatterns = [
        /(?:get|post|request)\s*\(\s*['"`]([^'"`]*(?:menu|route|permission|nav|sidebar)[^'"`]*)['"`]/gi,
        /url\s*:\s*['"`]([^'"`]*(?:menu|route|permission|nav|sidebar)[^'"`]*)['"`]/gi,
        /fetch\s*\(\s*['"`]([^'"`]*(?:menu|route|permission|nav|sidebar)[^'"`]*)['"`]/gi,
      ];
      for (var pi = 0; pi < menuApiPatterns.length; pi++) {
        while ((m = menuApiPatterns[pi].exec(content)) !== null) {
          var apiUrl = m[1];
          if (apiUrl.indexOf("/api/") !== -1 || apiUrl.indexOf("http") === 0 || apiUrl.indexOf("/") === 0) {
            var key = "api:" + apiUrl;
            if (!seen[key]) {
              seen[key] = true;
              menuApis.push({ url: apiUrl, source: path, type: "menuApi" });
            }
          }
        }
      }

      // --- router.beforeEach 中调用 API 获取路由 ---
      var re4 = /router\.beforeEach\s*\(.*?[\s\S]*?(?:get|post|request|fetch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
      while ((m = re4.exec(content)) !== null) {
        var guardApi = m[1];
        var gkey = "guard:" + guardApi;
        if (!seen[gkey]) {
          seen[gkey] = true;
          menuApis.push({ url: guardApi, source: path, type: "routeGuard" });
        }
      }
    }

    return {
      dynamicRoutes: dynamicRoutes,
      menuApis: menuApis,
      isDynamic: dynamicRoutes.length > 0 || menuApis.length > 0,
    };
  }

  /**
   * 分析技术栈
   * 扫描 package.json 提取依赖框架和版本
   */
  function analyzeTechStack(sourceFiles) {
    var techStack = { frameworks: [], devTools: [], keyDeps: [] };
    var pkgContent = null;

    for (var path in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(path)) continue;
      if (path === "package.json" || path.endsWith("/package.json")) {
        pkgContent = sourceFiles[path];
        break;
      }
    }

    if (!pkgContent) return techStack;

    try {
      var pkg = JSON.parse(pkgContent);
      var allDeps = {};
      var dep;
      for (dep in (pkg.dependencies || {})) allDeps[dep] = pkg.dependencies[dep];
      for (dep in (pkg.devDependencies || {})) allDeps[dep] = pkg.devDependencies[dep];

      var frameworkMap = {
        "vue": "Vue", "react": "React", "angular": "Angular", "svelte": "Svelte",
        "vue-router": "Vue Router", "react-router-dom": "React Router", "react-router": "React Router",
        "vuex": "Vuex", "pinia": "Pinia", "@reduxjs/toolkit": "Redux Toolkit", "redux": "Redux", "mobx": "MobX",
        "element-ui": "Element UI", "element-plus": "Element Plus", "ant-design-vue": "Ant Design Vue",
        "antd": "Ant Design", "iview": "iView", "view-design": "View Design",
        "vant": "Vant", "naive-ui": "Naive UI", "arco-design": "Arco Design",
        "axios": "Axios", "echarts": "ECharts", "chart.js": "Chart.js",
        "xterm": "xterm", "codemirror": "CodeMirror", "monaco-editor": "Monaco Editor",
        "crypto-js": "crypto-js", "jsencrypt": "jsencrypt", "node-forge": "node-forge",
        "dom-to-image": "dom-to-image", "html2canvas": "html2canvas",
        "vuedraggable": "vuedraggable", "vue-clipboard2": "vue-clipboard2",
        "moment": "moment", "dayjs": "dayjs", "lodash": "lodash",
        "typescript": "TypeScript",
      };
      var devToolMap = {
        "webpack": "Webpack", "vite": "Vite", "@vue/cli-service": "Vue CLI",
        "next": "Next.js", "nuxt": "Nuxt.js", "rollup": "Rollup",
        "babel": "Babel", "eslint": "ESLint", "prettier": "Prettier",
        "jest": "Jest", "vitest": "Vitest", "cypress": "Cypress", "playwright": "Playwright",
        "sass": "Sass", "less": "Less", "tailwindcss": "Tailwind CSS",
        "docker": "Docker",
      };

      for (var depName in allDeps) {
        if (frameworkMap[depName]) {
          techStack.frameworks.push({ name: frameworkMap[depName], version: allDeps[depName], package: depName });
        } else if (devToolMap[depName]) {
          techStack.devTools.push({ name: devToolMap[depName], version: allDeps[depName], package: depName });
        } else {
          // 其他重要依赖
          var lowerDep = depName.toLowerCase();
          if (lowerDep.indexOf("ui") !== -1 || lowerDep.indexOf("chart") !== -1 ||
              lowerDep.indexOf("table") !== -1 || lowerDep.indexOf("form") !== -1 ||
              lowerDep.indexOf("upload") !== -1 || lowerDep.indexOf("editor") !== -1 ||
              lowerDep.indexOf("select") !== -1 || lowerDep.indexOf("tree") !== -1) {
            techStack.keyDeps.push({ name: depName, version: allDeps[depName] });
          }
        }
      }
    } catch (e) {
      // package.json 解析失败
    }

    return techStack;
  }

  /**
   * 分析目录结构
   * 提取关键目录及其职责
   */
  function analyzeDirectoryStructure(sourceFiles) {
    var dirs = {};
    var topLevelDirs = {};

    for (var path in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(path)) continue;
      var parts = path.split("/");
      if (parts.length < 2) continue;

      // 顶层目录
      var topDir = parts[0];
      if (!topLevelDirs[topDir]) topLevelDirs[topDir] = { fileCount: 0, subDirs: {} };
      topLevelDirs[topDir].fileCount++;

      // src/ 下的二级目录
      if (parts[0] === "src" && parts.length >= 3) {
        var secondDir = parts[1];
        if (!dirs[secondDir]) dirs[secondDir] = { fileCount: 0, sampleFiles: [] };
        dirs[secondDir].fileCount++;
        if (dirs[secondDir].sampleFiles.length < 3) {
          dirs[secondDir].sampleFiles.push(parts.slice(2).join("/"));
        }
      }
    }

    // 构建目录摘要
    var dirSummary = [];
    for (var d in dirs) {
      if (dirs.hasOwnProperty(d)) {
        dirSummary.push({
          name: d,
          fileCount: dirs[d].fileCount,
          sampleFiles: dirs[d].sampleFiles,
        });
      }
    }
    dirSummary.sort(function (a, b) { return b.fileCount - a.fileCount; });

    var topSummary = [];
    for (var td in topLevelDirs) {
      if (topLevelDirs.hasOwnProperty(td)) {
        topSummary.push({ name: td, fileCount: topLevelDirs[td].fileCount });
      }
    }
    topSummary.sort(function (a, b) { return b.fileCount - a.fileCount; });

    return { topDirs: topSummary, srcDirs: dirSummary };
  }

  /**
   * 分析组件清单
   * 扫描组件注册和定义，提取全局/局部组件
   */
  function analyzeComponentInventory(sourceFiles) {
    var components = [];
    var seen = {};

    for (var path in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(path)) continue;
      var content = sourceFiles[path];
      var lowerPath = path.toLowerCase();

      // Vue.component('name', ...)
      var re1 = /Vue\.component\s*\(\s*['"]([^'"]+)['"]/g;
      var m;
      while ((m = re1.exec(content)) !== null) {
        if (!seen[m[1]]) {
          seen[m[1]] = true;
          components.push({ name: m[1], source: path, type: "global" });
        }
      }

      // components: { Name } 注册
      var re2 = /components\s*:\s*\{([^}]+)\}/g;
      while ((m = re2.exec(content)) !== null) {
        var inner = m[1];
        var re2b = /(\w+)\s*[,}]/g;
        var m2;
        while ((m2 = re2b.exec(inner)) !== null) {
          var compName = m2[1];
          if (compName.length > 2 && compName.length < 40 && !seen[compName] &&
              compName !== "components" && compName !== "data" && compName !== "methods" &&
              compName !== "computed" && compName !== "watch" && compName !== "props" &&
              compName !== "mounted" && compName !== "created" && compName !== "name") {
            seen[compName] = true;
            components.push({ name: compName, source: path, type: "local" });
          }
        }
      }

      // React: export default function ComponentName
      var re3 = /export\s+default\s+function\s+(\w+)/g;
      while ((m = re3.exec(content)) !== null) {
        if (!seen[m[1]] && m[1].length > 2) {
          seen[m[1]] = true;
          components.push({ name: m[1], source: path, type: "react" });
        }
      }

      // 扫描 components/ 目录下的文件名作为组件
      if (lowerPath.indexOf("components/") !== -1 && path.match(/\/(\w+)\.(vue|jsx|tsx)$/)) {
        var fileName = path.match(/\/(\w+)\.(vue|jsx|tsx)$/)[1];
        if (!seen[fileName] && fileName.length > 2 && fileName !== "index") {
          seen[fileName] = true;
          components.push({ name: fileName, source: path, type: "file" });
        }
      }
    }

    return components.slice(0, 80);
  }

  /**
   * 分析安全机制
   * 扫描认证、加密、权限相关模式
   */
  function analyzeSecurityPatterns(sourceFiles) {
    var patterns = [];

    for (var path in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(path)) continue;
      var content = sourceFiles[path];
      var lowerPath = path.toLowerCase();

      // Token 管理
      if (/localStorage\.(get|set)Item\s*\(\s*['"]?(?:token|auth|access_token|Authorization)/i.test(content)) {
        patterns.push({ type: "token-storage", detail: "localStorage 存储 Token", source: path });
      }
      if (/sessionStorage\.(get|set)Item\s*\(\s*['"]?(?:token|auth|access_token)/i.test(content)) {
        patterns.push({ type: "token-storage", detail: "sessionStorage 存储 Token", source: path });
      }

      // RSA/AES/DES 加密
      if (/RSA|rsa-oaep|node-forge|jsencrypt/i.test(content)) {
        patterns.push({ type: "encryption", detail: "RSA 加密", source: path });
      }
      if (/AES|crypto-js|CryptoJS/i.test(content)) {
        patterns.push({ type: "encryption", detail: "AES 加密 (crypto-js)", source: path });
      }
      if (/DES|des\.encrypt|des\.decrypt/i.test(content)) {
        patterns.push({ type: "encryption", detail: "DES 加密", source: path });
      }

      // 权限指令
      if (/v-permission|v-auth|v-has-perm|checkPermission|hasPermission/i.test(content)) {
        patterns.push({ type: "permission", detail: "权限指令/函数", source: path });
      }

      // 路由守卫
      if (/beforeEach|beforeResolve|afterEach|navigationGuard/i.test(content) && lowerPath.indexOf("route") !== -1) {
        patterns.push({ type: "route-guard", detail: "路由守卫", source: path });
      }

      // 水印
      if (/watermark|水印/i.test(content)) {
        patterns.push({ type: "watermark", detail: "水印功能", source: path });
      }

      // CSRF
      if (/csrf|Csrf_token|x-csrf/i.test(content)) {
        patterns.push({ type: "csrf", detail: "CSRF 防护", source: path });
      }

      // 请求追踪
      if (/request_id|traceId|x-gw-traceId|x-request-id/i.test(content)) {
        patterns.push({ type: "request-tracing", detail: "请求追踪 ID", source: path });
      }
    }

    // 去重（同类型只保留一个）
    var seen = {};
    var unique = [];
    for (var i = 0; i < patterns.length; i++) {
      var key = patterns[i].type + "|" + patterns[i].detail;
      if (!seen[key]) {
        seen[key] = true;
        unique.push(patterns[i]);
      }
    }
    return unique;
  }

  /**
   * 分析构建配置
   * 扫描构建工具配置文件
   */
  function analyzeBuildConfig(sourceFiles) {
    var config = { buildTool: null, devServer: null, proxy: null, aliases: null, deployInfo: null };

    for (var path in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(path)) continue;
      var content = sourceFiles[path];
      var lowerPath = path.toLowerCase();

      // vue.config.js
      if (lowerPath === "vue.config.js" || lowerPath.endsWith("/vue.config.js")) {
        config.buildTool = "Vue CLI";
        var portMatch = content.match(/port\s*:\s*(\d+)/);
        if (portMatch) config.devServer = { port: parseInt(portMatch[1]) };
        var proxyMatch = content.match(/proxy\s*:\s*\{[^}]*target\s*:\s*['"]([^'"]+)['"]/);
        if (proxyMatch) config.proxy = proxyMatch[1];
        var aliasMatch = content.match(/alias\s*:\s*\{([^}]+)\}/);
        if (aliasMatch) config.aliases = aliasMatch[1].trim();
      }

      // vite.config.js/ts
      if (lowerPath === "vite.config.js" || lowerPath === "vite.config.ts" || lowerPath.endsWith("/vite.config.js") || lowerPath.endsWith("/vite.config.ts")) {
        config.buildTool = "Vite";
        var vPort = content.match(/port\s*:\s*(\d+)/);
        if (vPort) config.devServer = { port: parseInt(vPort[1]) };
        var vProxy = content.match(/proxy\s*:\s*\{[^}]*target\s*:\s*['"]([^'"]+)['"]/);
        if (vProxy) config.proxy = vProxy[1];
        var vAlias = content.match(/alias\s*:\s*\{([^}]+)\}/);
        if (vAlias) config.aliases = vAlias[1].trim();
      }

      // webpack.config.js
      if (lowerPath === "webpack.config.js" || lowerPath.endsWith("/webpack.config.js")) {
        config.buildTool = "Webpack";
      }

      // next.config.js
      if (lowerPath === "next.config.js" || lowerPath.endsWith("/next.config.js")) {
        config.buildTool = "Next.js";
      }

      // Dockerfile
      if (lowerPath === "dockerfile" || lowerPath.endsWith("/dockerfile")) {
        var fromMatch = content.match(/FROM\s+(\S+)/i);
        config.deployInfo = { docker: true, baseImage: fromMatch ? fromMatch[1] : null };
      }

      // nginx.conf
      if (lowerPath.indexOf("nginx") !== -1 && lowerPath.indexOf(".conf") !== -1) {
        if (!config.deployInfo) config.deployInfo = {};
        config.deployInfo.nginx = true;
      }
    }

    return config;
  }

  /**
   * 分析业务模块
   * 扫描 views/pages 目录，提取业务模块清单
   */
  function analyzeBusinessModules(sourceFiles) {
    var modules = {};
    var viewDirPatterns = ["views/", "pages/", "src/views/", "src/pages/"];

    for (var path in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(path)) continue;
      var matched = false;
      for (var pi = 0; pi < viewDirPatterns.length; pi++) {
        if (path.indexOf(viewDirPatterns[pi]) !== -1) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;

      // 提取 views/ 下的第一级目录作为业务模块
      var parts = path.split("/");
      var viewIdx = -1;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i] === "views" || parts[i] === "pages") {
          viewIdx = i;
          break;
        }
      }
      if (viewIdx === -1 || viewIdx + 1 >= parts.length) continue;

      var moduleName = parts[viewIdx + 1];
      if (!moduleName || moduleName === "index") continue;
      if (!modules[moduleName]) {
        modules[moduleName] = { name: moduleName, fileCount: 0, sampleFiles: [] };
      }
      modules[moduleName].fileCount++;
      if (modules[moduleName].sampleFiles.length < 3) {
        modules[moduleName].sampleFiles.push(parts.slice(viewIdx + 1).join("/"));
      }
    }

    var moduleList = [];
    for (var mod in modules) {
      if (modules.hasOwnProperty(mod)) {
        moduleList.push(modules[mod]);
      }
    }
    moduleList.sort(function (a, b) { return b.fileCount - a.fileCount; });
    return moduleList.slice(0, 50);
  }

  /**
   * 逐文件分析：对每个源码文件进行分类和用途推断
   * 输出: [{ path, category, purpose, keyExports, keyImports, lineCount }]
   */
  function analyzeFileInventory(sourceFiles) {
    var inventory = [];

    for (var path in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(path)) continue;
      var content = sourceFiles[path];
      var info = categorizeFile(path, content);
      inventory.push(info);
    }

    // 按路径排序
    inventory.sort(function (a, b) {
      return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0);
    });
    return inventory;
  }

  /**
   * 对单个文件进行分类和用途推断
   */
  function categorizeFile(path, content) {
    var lowerPath = path.toLowerCase();
    var fileName = path.split("/").pop();
    var dirParts = path.split("/").slice(0, -1);
    var parentDir = dirParts[dirParts.length - 1] || "";
    var ext = fileName.split(".").pop().toLowerCase();
    var lineCount = content ? content.split("\n").length : 0;

    var info = {
      path: path,
      category: "other",
      purpose: "",
      keyExports: [],
      keyImports: [],
      lineCount: lineCount,
    };

    // ---- 1. 按路径和文件名分类 ----

    // 入口文件
    if (/^(src\/)?(main|index|app)\.(js|ts|jsx|tsx)$/i.test(path)) {
      info.category = "entry";
      info.purpose = "应用入口文件，创建应用实例并挂载";
    }
    // 路由
    else if (lowerPath.indexOf("router") !== -1 || lowerPath.indexOf("routes") !== -1 ||
             fileName === "router.js" || fileName === "router.ts" || fileName === "routes.js" || fileName === "routes.ts") {
      info.category = "router";
      info.purpose = "路由配置，定义页面路径与组件的映射关系";
    }
    // 状态管理
    else if (lowerPath.indexOf("store") !== -1 || lowerPath.indexOf("/vuex") !== -1 ||
             lowerPath.indexOf("/pinia") !== -1 || lowerPath.indexOf("/redux") !== -1) {
      info.category = "store";
      info.purpose = "状态管理模块，管理全局或模块级状态";
    }
    // API 层
    else if (lowerPath.indexOf("/api/") !== -1 || lowerPath.indexOf("/services/") !== -1 ||
             lowerPath.indexOf("/request") !== -1 || lowerPath.indexOf("/http") !== -1 ||
             fileName === "request.js" || fileName === "request.ts" ||
             fileName === "http.js" || fileName === "http.ts" ||
             fileName === "axios.js" || fileName === "axios.ts") {
      info.category = "api";
      info.purpose = "API 请求层，封装 HTTP 调用和接口定义";
    }
    // 权限
    else if (lowerPath.indexOf("permission") !== -1 || lowerPath.indexOf("auth") !== -1 ||
             lowerPath.indexOf("guard") !== -1) {
      info.category = "permission";
      info.purpose = "权限控制模块，处理登录态校验和权限判断";
    }
    // 工具函数
    else if (lowerPath.indexOf("/utils/") !== -1 || lowerPath.indexOf("/util/") !== -1 ||
             lowerPath.indexOf("/helpers/") !== -1 || lowerPath.indexOf("/lib/") !== -1) {
      info.category = "util";
      info.purpose = "工具函数库，提供通用辅助方法";
    }
    // 过滤器/指令
    else if (lowerPath.indexOf("/filters/") !== -1 || lowerPath.indexOf("/directives/") !== -1) {
      info.category = "filter-directive";
      info.purpose = lowerPath.indexOf("filter") !== -1 ? "过滤器定义" : "自定义指令";
    }
    // 混入/插件
    else if (lowerPath.indexOf("/mixins/") !== -1) {
      info.category = "mixin";
      info.purpose = "混入逻辑，提供可复用的组件逻辑";
    }
    else if (lowerPath.indexOf("/plugins/") !== -1) {
      info.category = "plugin";
      info.purpose = "插件定义，注册全局功能";
    }
    // 组件
    else if (lowerPath.indexOf("/components/") !== -1 || lowerPath.indexOf("/component/") !== -1) {
      info.category = "component";
      info.purpose = "公共组件";
    }
    // 布局
    else if (lowerPath.indexOf("/layout") !== -1 || lowerPath.indexOf("/layouts") !== -1) {
      info.category = "layout";
      info.purpose = "布局组件，定义页面整体结构";
    }
    // 页面/视图
    else if (lowerPath.indexOf("/views/") !== -1 || lowerPath.indexOf("/pages/") !== -1) {
      info.category = "view";
      info.purpose = "页面视图组件";
    }
    // 样式
    else if (ext === "css" || ext === "scss" || ext === "less" || ext === "styl") {
      info.category = "style";
      info.purpose = "样式文件";
    }
    // 配置
    else if (fileName === "package.json") {
      info.category = "config";
      info.purpose = "项目依赖与脚本配置";
    }
    else if (fileName === "vue.config.js" || fileName === "vite.config.js" || fileName === "vite.config.ts" ||
             fileName === "webpack.config.js" || fileName === "next.config.js" || fileName === "nuxt.config.js") {
      info.category = "config";
      info.purpose = "构建工具配置";
    }
    else if (fileName === ".env" || fileName.startsWith(".env.")) {
      info.category = "config";
      info.purpose = "环境变量配置";
    }
    else if (fileName === "dockerfile" || lowerPath.indexOf("dockerfile") !== -1) {
      info.category = "config";
      info.purpose = "Docker 容器构建配置";
    }
    else if (lowerPath.indexOf("nginx") !== -1 && lowerPath.indexOf(".conf") !== -1) {
      info.category = "config";
      info.purpose = "Nginx 部署配置";
    }
    // 类型定义
    else if (ext === "d.ts") {
      info.category = "types";
      info.purpose = "TypeScript 类型定义文件";
    }
    // 测试
    else if (lowerPath.indexOf("/test/") !== -1 || lowerPath.indexOf("/tests/") !== -1 ||
             lowerPath.indexOf(".test.") !== -1 || lowerPath.indexOf(".spec.") !== -1) {
      info.category = "test";
      info.purpose = "测试文件";
    }
    // store modules (deeper check)
    else if (parentDir === "store" || parentDir === "stores" || parentDir === "modules" && dirParts.indexOf("store") !== -1) {
      info.category = "store";
      info.purpose = "状态管理模块";
    }

    // ---- 2. 从内容提取更精确的用途 ----
    if (content) {
      // 提取 export 名称
      var exportNames = [];
      var reExport = /export\s+(?:default\s+)?(?:function|class|const|var|let)\s+(\w+)/g;
      var m;
      while ((m = reExport.exec(content)) !== null) {
        exportNames.push(m[1]);
        if (exportNames.length >= 10) break;
      }
      // Vue.component 注册
      var reVC = /Vue\.component\s*\(\s*['"]([^'"]+)['"]/g;
      while ((m = reVC.exec(content)) !== null) {
        exportNames.push(m[1]);
        if (exportNames.length >= 10) break;
      }
      info.keyExports = exportNames;

      // 提取关键 import（只保留有意义的）
      var importPaths = [];
      var reImport = /import\s+[^'"]*from\s+['"]([^'"]+)['"]/g;
      while ((m = reImport.exec(content)) !== null) {
        var imp = m[1];
        // 过滤掉 node_modules 依赖，只保留相对路径和 @/ 别名
        if (imp.indexOf(".") === 0 || imp.indexOf("@/") === 0) {
          importPaths.push(imp);
        }
      }
      info.keyImports = importPaths.slice(0, 15);

      // 如果 purpose 还为空，尝试从内容推断
      if (!info.purpose) {
        if (/createApp|new\s+Vue\(|ReactDOM\.render/.test(content)) {
          info.category = "entry";
          info.purpose = "应用入口文件";
        } else if (/defineStore|createStore|useStore|new\s+Vuex\.Store/.test(content)) {
          info.category = info.category === "other" ? "store" : info.category;
          info.purpose = info.purpose || "状态管理";
        } else if (/createRouter|new\s+VueRouter|new\s+Router|BrowserRouter|Routes/.test(content)) {
          info.category = info.category === "other" ? "router" : info.category;
          info.purpose = info.purpose || "路由配置";
        } else if (/\.vue$/.test(path) || /\.jsx$/.test(path) || /\.tsx$/.test(path)) {
          if (info.category === "other") {
            info.category = "component";
            info.purpose = "组件文件";
          }
        }
      }

      // 对组件/视图文件，尝试从内容提取更具体的用途
      if (info.category === "component" || info.category === "view") {
        // 尝试从注释或 name 属性提取用途
        var nameMatch = content.match(/name\s*:\s*['"]([^'"]+)['"]/);
        if (nameMatch) {
          info.purpose = (info.category === "view" ? "页面: " : "组件: ") + nameMatch[1];
        }
        // 从文件名推断
        if (info.purpose === "公共组件" || info.purpose === "页面视图组件") {
          var baseName = fileName.replace(/\.(vue|jsx|tsx|js|ts)$/, "");
          info.purpose += " (" + baseName + ")";
        }
      }

      // 对 API 文件，提取接口路径
      if (info.category === "api") {
        var apiUrls = [];
        var reUrl = /(?:url|path)\s*:\s*['"`]([^'"`]+)['"`]/g;
        while ((m = reUrl.exec(content)) !== null) {
          apiUrls.push(m[1]);
          if (apiUrls.length >= 5) break;
        }
        if (apiUrls.length > 0) {
          info.purpose += "，接口: " + apiUrls.join(", ");
        }
      }
    }

    return info;
  }

  /**
   * 构建带注释的目录树
   * 输出: [{ name, type, fileCount, purpose, children }]
   */
  function buildAnnotatedDirectoryTree(sourceFiles, fileInventory) {
    var inventory = fileInventory || analyzeFileInventory(sourceFiles);
    var root = { name: "", type: "dir", children: {}, fileCount: 0 };

    // 将每个文件插入树
    for (var i = 0; i < inventory.length; i++) {
      var info = inventory[i];
      var parts = info.path.split("/");
      var node = root;
      for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        var isFile = (j === parts.length - 1);
        if (!node.children[part]) {
          node.children[part] = {
            name: part,
            type: isFile ? "file" : "dir",
            children: {},
            fileCount: 0,
            category: isFile ? info.category : null,
            purpose: isFile ? info.purpose : "",
            lineCount: isFile ? info.lineCount : 0,
          };
        }
        node = node.children[part];
        node.fileCount++;
      }
    }

    // 递归推断目录用途
    function inferDirPurpose(node) {
      if (node.type === "file") return;

      // 收集子节点
      var childArr = [];
      for (var key in node.children) {
        if (node.children.hasOwnProperty(key)) {
          childArr.push(node.children[key]);
          inferDirPurpose(node.children[key]);
        }
      }

      // 根据子文件分类推断目录用途
      var categories = {};
      for (var i = 0; i < childArr.length; i++) {
        if (childArr[i].type === "file" && childArr[i].category) {
          categories[childArr[i].category] = (categories[childArr[i].category] || 0) + 1;
        }
      }
      var dominantCategory = null;
      var maxCount = 0;
      for (var cat in categories) {
        if (categories[cat] > maxCount) {
          maxCount = categories[cat];
          dominantCategory = cat;
        }
      }

      var dirPurposeMap = {
        "router": "路由配置目录",
        "store": "状态管理目录",
        "api": "API 请求层目录",
        "permission": "权限控制目录",
        "util": "工具函数目录",
        "component": "公共组件目录",
        "view": "页面视图目录",
        "config": "配置文件目录",
        "style": "样式文件目录",
        "filter-directive": "过滤器/指令目录",
        "mixin": "混入逻辑目录",
        "plugin": "插件目录",
        "layout": "布局组件目录",
        "types": "类型定义目录",
        "test": "测试文件目录",
        "entry": "入口文件",
      };

      if (dominantCategory && dirPurposeMap[dominantCategory]) {
        node.purpose = dirPurposeMap[dominantCategory];
        node.category = dominantCategory;
      }

      // 特殊目录名识别
      var dirName = node.name.toLowerCase();
      if (dirName === "src") node.purpose = "源码根目录";
      else if (dirName === "views" || dirName === "pages") node.purpose = "页面视图目录";
      else if (dirName === "components") node.purpose = "公共组件目录";
      else if (dirName === "api" || dirName === "services") node.purpose = "API 请求层目录";
      else if (dirName === "store") node.purpose = "状态管理目录";
      else if (dirName === "router" || dirName === "routes") node.purpose = "路由配置目录";
      else if (dirName === "utils" || dirName === "util" || dirName === "helpers") node.purpose = "工具函数目录";
      else if (dirName === "assets") node.purpose = "静态资源目录";
      else if (dirName === "styles" || dirName === "css") node.purpose = "样式文件目录";
      else if (dirName === "mixins") node.purpose = "混入逻辑目录";
      else if (dirName === "directives") node.purpose = "自定义指令目录";
      else if (dirName === "filters") node.purpose = "过滤器目录";
      else if (dirName === "plugins") node.purpose = "插件目录";
      else if (dirName === "layout" || dirName === "layouts") node.purpose = "布局组件目录";
      else if (dirName === "permission" || dirName === "auth") node.purpose = "权限控制目录";
      else if (dirName === "config" || dirName === "configs") node.purpose = "配置文件目录";
      else if (dirName === "types" || dirName === "typings") node.purpose = "类型定义目录";
      else if (dirName === "public" || dirName === "static") node.purpose = "公共静态资源目录";
    }

    inferDirPurpose(root);

    // 转为数组结构（只输出目录，不输出文件，减少上下文）
    function treeToArray(node, depth) {
      if (depth > 8) return [];
      var arr = [];
      var childArr = [];
      for (var key in node.children) {
        if (node.children.hasOwnProperty(key)) {
          childArr.push(node.children[key]);
        }
      }
      childArr.sort(function (a, b) {
        // 目录优先，然后按名称
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
      });
      for (var i = 0; i < childArr.length; i++) {
        var child = childArr[i];
        // 只输出目录节点，跳过文件
        if (child.type !== "dir") continue;
        arr.push({
          name: child.name,
          type: "dir",
          category: child.category,
          purpose: child.purpose,
          fileCount: child.fileCount,
          depth: depth,
        });
        arr = arr.concat(treeToArray(child, depth + 1));
      }
      return arr;
    }

    return treeToArray(root, 0);
  }

  /**
   * 执行完整的启发式分析
   */
  function analyze(sourceFiles) {
    var routes = analyzeRoutes(sourceFiles);
    var navigation = analyzeNavigation(sourceFiles);
    var apiCalls = analyzeApiCalls(sourceFiles);
    var components = analyzeComponents(sourceFiles, routes);
    var dynamic = analyzeDynamicRoutes(sourceFiles);
    var techStack = analyzeTechStack(sourceFiles);
    var dirStructure = analyzeDirectoryStructure(sourceFiles);
    var componentInventory = analyzeComponentInventory(sourceFiles);
    var securityPatterns = analyzeSecurityPatterns(sourceFiles);
    var buildConfig = analyzeBuildConfig(sourceFiles);
    var businessModules = analyzeBusinessModules(sourceFiles);
    var fileInventory = analyzeFileInventory(sourceFiles);
    var directoryTree = buildAnnotatedDirectoryTree(sourceFiles, fileInventory);

    // 合并动态路由到路由列表
    var allRoutes = routes.slice();
    var seenPaths = {};
    for (var i = 0; i < allRoutes.length; i++) seenPaths[allRoutes[i].path] = true;
    for (var j = 0; j < dynamic.dynamicRoutes.length; j++) {
      if (!seenPaths[dynamic.dynamicRoutes[j].path]) {
        seenPaths[dynamic.dynamicRoutes[j].path] = true;
        allRoutes.push(dynamic.dynamicRoutes[j]);
      }
    }

    return {
      routes: allRoutes,
      navigation: navigation,
      apiCalls: apiCalls,
      componentMap: components.componentMap,
      componentFiles: components.componentFiles,
      dynamicRoutes: dynamic.dynamicRoutes,
      menuApis: dynamic.menuApis,
      isDynamicRouting: dynamic.isDynamic,
      techStack: techStack,
      dirStructure: dirStructure,
      componentInventory: componentInventory,
      securityPatterns: securityPatterns,
      buildConfig: buildConfig,
      businessModules: businessModules,
      fileInventory: fileInventory,
      directoryTree: directoryTree,
      fileCount: Object.keys(sourceFiles).length,
      timestamp: Date.now(),
    };
  }

  // ============================================================
  // 2. AI 深度架构分析（多轮追踪，从入口文件开始逐步深入）
  // ============================================================

  /**
   * 调用 AI 进行深度架构分析
   * 从入口文件开始，多轮追踪路由构建方式、store 结构、菜单/路由 API 端点，
   * 最终输出准确的结构化架构概览。
   *
   * 追踪流程：
   *   Round 1: 读入口文件(main.js) → 分析应用初始化、路由/store 挂载方式
   *   Round 2+: 按 AI 指引读取 router/store/permission 等文件
   *   最终: AI 输出完整架构概览，包括 menuApis（如果存在动态路由）
   *
   * @param {Object} config - { apiUrl, apiKey, model }
   * @param {Object} rawAnalysis - analyze() 的返回值（启发式结果，作为辅助参考）
   * @param {Object} sourceFiles - 原始源码 { path: content }
   * @param {function} onLog - 日志回调
   * @param {function} onStream - 流式回调
   * @param {Object} [options] - 额外选项
   * @param {AbortSignal} [options.signal] - 用于中止 AI 请求
   * @returns {Promise<Object>} 深度分析后的架构概览
   */
  async function analyzeWithAI(config, rawAnalysis, sourceFiles, onLog, onStream, options) {
    options = options || {};
    var pauseState = options.pauseState;
    var extraPrompt = options.extraPrompt || "";
    function log(msg) { if (onLog) onLog(msg); }
    function stream(type, content) { if (onStream) onStream(type, content); }

    // 获取当前 signal（每次调用都会创建新的 AbortController）
    function getSignal() {
      if (pauseState) return pauseState.getSignal();
      return undefined;
    }
    // 检查是否已中止
    function isAborted() {
      return pauseState && pauseState.aborted;
    }
    // 检查是否暂停并等待恢复
    async function checkPausedAndResume() {
      if (pauseState && pauseState.paused && !pauseState.aborted) {
        stream("info", "⏸️ 已暂停，点击「继续」恢复执行");
        await pauseState.waitForResume();
        if (pauseState.aborted) return false;
        stream("info", "▶️ 继续执行");
      }
      return true;
    }

    var MAX_ROUNDS = 8;
    var MAX_FILES_PER_ROUND = 8;
    var MAX_REASONING_LOOPS = 2; // 连续推理死循环次数上限，超过后强制收尾
    var MAX_NO_PROGRESS_ROUNDS = 3; // 连续无进展轮数上限
    var MAX_CONSECUTIVE_UNRESOLVED = 2; // 连续无法解析文件轮数上限
    var visitedFiles = {};
    var conversation = [];
    var reasoningLoopCount = 0;
    var noProgressRounds = 0;
    var lastCoveredDimensions = [];
    var lastRequestedFiles = {}; // 上一轮请求的文件路径集合，用于无进展检测
    var consecutiveUnresolvedRounds = 0; // 连续无法解析任何文件的轮数
    var lastRequestedBaseNames = []; // 上一轮请求的文件基础名（用于检测变体模式）
    var forcedFinish = false;

    // 1. 查找入口文件
    var entryFiles = findEntryFiles(sourceFiles);
    if (entryFiles.length === 0) {
      log("未找到入口文件，回退到单轮 AI 分析");
      return await analyzeWithAISingleRound(config, rawAnalysis, sourceFiles, onLog, onStream, options);
    }
    log("找到入口文件: " + entryFiles.join(", "));

    // 列出所有文件路径供 AI 参考
    var allFilePaths = Object.keys(sourceFiles);

    // 构建启发式分析摘要（作为参考信息给 AI）
    var heuristicSummary = buildHeuristicSummary(rawAnalysis);

    // 2. Round 1: 发送入口文件给 AI，开始追踪
    var entryContents = [];
    for (var ei = 0; ei < entryFiles.length; ei++) {
      var ep = entryFiles[ei];
      visitedFiles[ep] = true;
      var ec = sourceFiles[ep];
      if (ec.length > 8000) ec = ec.substring(0, 8000) + "\n// ... [已截断]";
      entryContents.push("### " + ep + "\n```\n" + ec + "\n```");
    }

    var round1Prompt = [
      "你是一个资深前端架构分析师。请从项目入口文件开始，深入分析项目架构。",
      "你需要输出一份**结构化、详细**的架构分析报告，包含表格、目录树、架构图等。",
      "",
      "## 必须分析的维度",
      "",
      "### 1. 项目概述与技术栈",
      "- 项目类型、定位、规模（Vue文件数/JS文件数/总文件数/模块数）",
      "- 技术栈表格：类别 | 名称(含版本) | 用途",
      "",
      "### 2. 目录结构",
      "- 输出带注释的目录树（用 ``` 包裹），展示关键目录和文件，每个目录标注用途",
      "- 说明分层架构设计",
      "",
      "### 3. 架构图",
      "- 用 ASCII 字符画绘制系统整体架构图，展示各层关系（浏览器→入口→路由/Store/插件→权限框架→业务视图→API层→后端网关）",
      "",
      "### 4. 启动流程",
      "- 用编号步骤详细描述应用启动流程（1. xxx 2. xxx ...）",
      "- 包括入口文件初始化、插件注册、路由守卫、动态路由加载等",
      "",
      "### 5. 路由系统",
      "- 静态路由/动态路由如何配置",
      "- 路由守卫逻辑（登录态判断、权限校验等）",
      "- 动态路由加载方式（如后端返回菜单数据，前端递归构建）",
      "",
      "### 6. 状态管理",
      "- 使用什么状态管理方案",
      "- 输出 Vuex/Redux module 表格：模块名 | 职责",
      "- 权限/用户信息如何存储",
      "",
      "### 7. API 层设计",
      "- HTTP 封装方式、baseURL",
      "- 请求拦截器做了什么（Token注入、请求头等）",
      "- 响应拦截器做了什么（错误处理、401跳转等）",
      "- API 文件组织方式",
      "",
      "### 8. 组件体系",
      "- 内部组件库（如有）、全局公共组件、权限组件、图表组件等",
      "",
      "### 9. 权限与安全机制",
      "- 权限控制方案（路由级/按钮级）",
      "- 登录方式",
      "- 输出安全机制表格：机制 | 实现方式",
      "",
      "### 10. 业务模块分析",
      "- 按业务分类分组（如监控大屏/运营管理/运维管理/资源管理/统计分析/系统管理等）",
      "- 每组列出模块表格：模块名 | 路由 | 说明",
      "",
      "### 11. 构建与部署",
      "- 构建工具及配置（端口、代理、别名等）",
      "- Docker/Nginx 部署方式",
      "- 运行时配置（如有）",
      "",
      "### 12. 架构特点与设计模式",
      "- 列出项目的技术亮点和设计模式（每个用编号说明）",
      "",
      "### 13. 潜在问题与优化建议",
      "- 从架构/代码/性能/安全/工程化等维度分析潜在问题",
      "- 输出表格：维度 | 问题 | 建议",
      "",
      "### 14. 总结",
      "- 优势（列出项目做得好的方面）",
      "- 待改进（列出需要优化的方面）",
      "",
      "## 追踪策略",
      "- 从入口文件开始，按依赖关系逐步深入",
      "- 每轮读取 1-8 个文件，优先读取核心配置文件（router/store/api/permission/main.js）",
      "- 不需要逐文件分析，重点关注架构层面的信息",
      "",
      "## 当前已读取的文件（入口）",
      entryContents.join("\n\n"),
      "",
      "## 项目中所有文件路径（你可以要求读取其中的文件）",
      allFilePaths.slice(0, 200).join("\n"),
      allFilePaths.length > 200 ? "\n... (共 " + allFilePaths.length + " 个文件)" : "",
      "",
      "## 启发式扫描结果（仅供参考，可能不准确，需要你验证和纠正）",
      heuristicSummary,
      "",
      "## 输出格式",
      "请以 JSON 格式输出：",
      '```json',
      "{",
      '  "status": "tracing" | "done",',
      '  "analysis": "当前轮次的分析发现",',
      '  "nextFiles": ["下一步需要读取的文件路径"],',
      '  "dimensionsCovered": ["已充分分析的维度"],',
      '  "architecture": null',
      "}",
      "```",
      "",
      "- status 为 \"tracing\" 时，列出 nextFiles",
      "- status 为 \"done\" 时，在 architecture 字段输出完整的架构概览",
      "- dimensionsCovered 帮助你追踪已分析充分的维度",
      "",
      "architecture 字段格式（status 为 done 时输出，尽量详细）：",
      '```json',
      "{",
      '  "projectOverview": {',
      '    "type": "项目类型",',
      '    "description": "项目定位和用途",',
      '    "techStack": [{ "category": "类别", "name": "名称 版本", "purpose": "用途" }],',
      '    "scale": { "vueFiles": 0, "jsFiles": 0, "totalFiles": 0, "description": "规模描述" }',
      "  },",
      '  "directoryStructure": "带注释的目录树（用```包裹），展示关键目录和文件，每个目录标注用途",',
      '  "architectureDiagram": "ASCII 架构图（用```包裹），展示系统各层关系",',
      '  "startupFlow": "编号步骤描述的启动流程",',
      '  "routeConfig": "路由系统描述（静态/动态、守卫逻辑、动态加载方式）",',
      '  "storeInfo": "状态管理描述（框架、module 结构、权限存储）",',
      '  "vuexModules": [{ "name": "模块名", "scope": "业务/权限", "description": "职责" }],',
      '  "apiLayer": "API 层设计描述（封装、baseURL、拦截器、文件组织）",',
      '  "componentSystem": "组件体系描述（内部组件库、全局组件、权限组件等）",',
      '  "securityMechanisms": "安全机制描述",',
      '  "securityDetails": [{ "mechanism": "机制名", "implementation": "实现方式" }],',
      '  "businessModules": [{ "name": "模块名", "description": "职责", "routePath": "/xxx", "category": "监控大屏/运营管理/运维管理/资源管理/统计分析/系统管理/其他" }],',
      '  "buildAndDeploy": "构建与部署描述",',
      '  "designPatterns": "架构特点与设计模式（编号列出）",',
      '  "potentialIssues": [{ "category": "架构/代码/性能/安全/工程化", "issue": "问题描述", "suggestion": "改进建议" }],',
      '  "strengths": ["优势1", "优势2"],',
      '  "improvements": ["待改进1", "待改进2"],',
      '  "routes": [{ "path": "/路径", "name": "中文名", "component": "组件", "description": "简述" }],',
      '  "navigation": [{ "text": "菜单文本", "path": "/路径", "parent": "父级" }],',
      '  "pageApiMap": { "/路径": ["GET /api/xxx"] },',
      '  "menuApis": [{ "url": "/api/menu", "method": "GET", "body": null, "headers": {}, "description": "获取菜单" }],',
      '  "summary": "3-5句话概述项目架构"',
      "}",
      "```",
      "",
      "## 重要规则",
      "1. 只输出你**确定**的信息，不确定的留空或标注未知",
      "2. 必须覆盖所有维度，不要只关注路由",
      "3. menuApis 只在确认追踪到菜单/路由 API 调用时才输出",
      "4. 注意动态拼接的 URL，需要还原完整路径",
      "5. 不要猜测，基于源码实际内容分析",
      "6. businessModules 要按业务分类分组，尽量覆盖所有主要模块",
      "7. techStack 要包含版本号和用途说明",
      "8. **directoryStructure 要输出带注释的目录树**，不是一段文字描述",
      "9. **architectureDiagram 要输出 ASCII 架构图**",
      "10. **startupFlow 要用编号步骤描述**，不是一段话",
      "11. **vuexModules 和 securityDetails 要用数组输出**，不是一段话",
      "12. **potentialIssues 要从多个维度分析**（架构/代码/性能/安全/工程化）",
      "13. **nextFiles 中的文件路径必须从上方文件列表中选取**",
      "14. 每轮最多请求 8 个文件，优先读取尚未分析的核心配置文件",
    ].join("\n");

    if (extraPrompt) {
      round1Prompt += "\n\n## 用户额外提示词\n" + extraPrompt;
    }

    conversation.push({ role: "user", content: round1Prompt });
    stream("info", "## AI 深度架构分析\n\n");
    stream("info", "**第 1 轮**: 读取入口文件 " + entryFiles.join(", ") + "\n\n");

    var result;
    try {
      result = await global.AIFT_AIClient.chatStream(
        config,
        conversation,
        [],
        {
          timeout: 90000,
          maxRetries: 2,
          signal: getSignal(),
          onDelta: function (type, content) {
            if (type === "content") stream("content", content);
            else if (type === "reasoning") stream("reasoning", content);
          },
        }
      );
    } catch (e) {
      // 用户注入消息 → 中止当前请求，注入用户消息后重试（最高优先级）
      if (e.name === "UserAbortError" && pauseState && pauseState.userInjecting && !pauseState.aborted) {
        var injectedMsg = pauseState.consumeUserMessage();
        if (injectedMsg) {
          if (result && result.message) {
            conversation.push({ role: "assistant", content: result.message.content || "" });
          }
          conversation.push({ role: "user", content: "📋 用户补充指令：" + injectedMsg + "\n请立即根据以上指令调整你的分析。" });
        }
        stream("info", "💡 用户消息已注入（最高优先级），重新发起请求...\n");
        // 重新发起请求
        result = await global.AIFT_AIClient.chatStream(
          config, conversation, [],
          { timeout: 90000, maxRetries: 2, signal: getSignal(),
            onDelta: function (type, content) {
              if (type === "content") stream("content", content);
              else if (type === "reasoning") stream("reasoning", content);
            }
          }
        );
      } else if (e.name === "UserAbortError" && pauseState && pauseState.paused && !pauseState.aborted) {
        var resumed = await checkPausedAndResume();
        if (!resumed) throw e;
        // 重新发起请求
        result = await global.AIFT_AIClient.chatStream(
          config, conversation, [],
          { timeout: 90000, maxRetries: 2, signal: getSignal(),
            onDelta: function (type, content) {
              if (type === "content") stream("content", content);
              else if (type === "reasoning") stream("reasoning", content);
            }
          }
        );
      } else if (e.name === "ReasoningLoopError") {
        reasoningLoopCount++;
        stream("warning", "⚠️ 第 1 轮检测到推理死循环，注入干预提示词重试...");
        log("第 1 轮: 推理死循环（第 " + reasoningLoopCount + " 次），注入干预后重试");
        conversation.push({
          role: "user",
          content: "🚨 推理重复循环！请立即停止反复分析，直接输出当前已知信息。\n" +
            "基于已读取的入口文件，输出 status: \"tracing\" 或 status: \"done\" 的 JSON 结果。\n" +
            "不要在思考中反复推导，直接给出结论！",
        });
        // 重试一次
        result = await global.AIFT_AIClient.chatStream(
          config, conversation, [],
          { timeout: 90000, maxRetries: 1, signal: getSignal(),
            onDelta: function (type, content) {
              if (type === "content") stream("content", content);
              else if (type === "reasoning") stream("reasoning", content);
            }
          }
        );
      } else {
        throw e;
      }
    }

    var aiText = (result.message.content || "").trim();
    conversation.push({ role: "assistant", content: aiText });

    var parsed = parseAIJsonResponse(aiText);
    if (!parsed) {
      log("AI 响应解析失败，回退到单轮分析");
      return await analyzeWithAISingleRound(config, rawAnalysis, sourceFiles, onLog, onStream, options);
    }

    if (parsed.analysis) log("  AI: " + parsed.analysis);
    if (parsed.dimensionsCovered) lastCoveredDimensions = parsed.dimensionsCovered.slice();

    // 3. 多轮追踪
    var allDimensions = ["techStack", "dirStructure", "startupFlow", "routes", "store", "api", "components", "security", "businessModules", "buildConfig", "designPatterns"];
    for (var round = 2; round <= MAX_ROUNDS; round++) {
      if (parsed.status === "done" && parsed.architecture) {
        log("第 " + (round - 1) + " 轮: AI 完成架构分析");
        break;
      }

      // ===== 防死循环检查 =====
      // 检查 1: 连续推理死循环超过上限 → 强制收尾
      if (reasoningLoopCount >= MAX_REASONING_LOOPS) {
        log("⛔ 连续 " + reasoningLoopCount + " 次推理死循环，强制收尾");
        stream("warning", "⛔ 推理死循环次数过多，强制输出最终结果");
        forcedFinish = true;
      }

      // 检查 2: 连续无进展轮数超过上限 → 强制收尾
      if (noProgressRounds >= MAX_NO_PROGRESS_ROUNDS) {
        log("⛔ 连续 " + noProgressRounds + " 轮无新进展，强制收尾");
        stream("warning", "⛔ 连续无进展轮数过多，强制输出最终结果");
        forcedFinish = true;
      }

      // 检查 3: 达到最大轮次 → 强制收尾
      if (round === MAX_ROUNDS) {
        log("第 " + round + " 轮: 达到最大轮次 " + MAX_ROUNDS + "，强制收尾");
        forcedFinish = true;
      }

      var nextFiles = parsed.nextFiles || [];
      var covered = parsed.dimensionsCovered || [];
      var uncovered = [];
      for (var ud = 0; ud < allDimensions.length; ud++) {
        if (covered.indexOf(allDimensions[ud]) === -1) {
          uncovered.push(allDimensions[ud]);
        }
      }

      // 检查 4: 无进展检测 — 综合判断维度变化 + 文件请求变化
      // 只有"维度没变 AND 请求的文件也没变/没新文件"才算无进展
      var dimensionsChanged = false;
      if (covered.length !== lastCoveredDimensions.length) {
        dimensionsChanged = true;
      } else {
        for (var dc = 0; dc < covered.length; dc++) {
          if (lastCoveredDimensions.indexOf(covered[dc]) === -1) {
            dimensionsChanged = true;
            break;
          }
        }
      }

      // 检查是否请求了新文件（之前没请求过的）
      var requestedNewFiles = false;
      if (nextFiles.length > 0) {
        for (var nfi = 0; nfi < nextFiles.length; nfi++) {
          if (!lastRequestedFiles[nextFiles[nfi]]) {
            requestedNewFiles = true;
            break;
          }
        }
      }

      // 综合判断：维度有变化 OR 请求了新文件 → 有进展
      var hasProgress = dimensionsChanged || requestedNewFiles;
      if (!hasProgress && !forcedFinish) {
        noProgressRounds++;
        if (noProgressRounds >= 2) {
          log("第 " + round + " 轮: 无新进展（维度和文件请求均无变化，连续 " + noProgressRounds + " 轮）");
        }
      } else {
        noProgressRounds = 0;
      }
      lastCoveredDimensions = covered.slice();
      // 记录本轮请求的文件，供下一轮比较
      lastRequestedFiles = {};
      for (var lrf = 0; lrf < nextFiles.length; lrf++) {
        lastRequestedFiles[nextFiles[lrf]] = true;
      }

      // 检查 5: 连续无法解析文件 + 文件名变体模式检测
      if (nextFiles.length > 0 && !forcedFinish) {
        // 提取本轮请求的文件基础名（去掉路径和扩展名）
        var currentBaseNames = [];
        var allUnresolved = true;
        for (var ufi = 0; ufi < nextFiles.length; ufi++) {
          var reqPath = nextFiles[ufi];
          var testMatched = resolveSourceFile(reqPath, entryFiles[0], sourceFiles, visitedFiles);
          // 提取基础名：取文件名部分，去掉扩展名
          var baseName = reqPath.split("/").pop().replace(/\.(js|ts|jsx|tsx|vue)$/i, "");
          currentBaseNames.push(baseName);
          if (testMatched) allUnresolved = false;
        }

        if (allUnresolved) {
          consecutiveUnresolvedRounds++;
          // 检测文件名变体模式：AI 是否在请求相似但不同的文件名
          // 例如 Login4ANewNew.vue → Login4ANewNewNew.vue → Login4ANewNewNewNew.vue
          if (lastRequestedBaseNames.length > 0) {
            var variantDetected = false;
            for (var vbi = 0; vbi < currentBaseNames.length; vbi++) {
              var curBase = currentBaseNames[vbi];
              for (var vbi2 = 0; vbi2 < lastRequestedBaseNames.length; vbi2++) {
                var prevBase = lastRequestedBaseNames[vbi2];
                // 检查是否是前一轮文件名的变体（前缀相同，或一方包含另一方）
                if (curBase !== prevBase && (
                  curBase.indexOf(prevBase) === 0 ||  // 当前名以上一轮开头
                  prevBase.indexOf(curBase) === 0     // 上一轮以当前开头
                )) {
                  variantDetected = true;
                  break;
                }
              }
              if (variantDetected) break;
            }
            if (variantDetected) {
              log("第 " + round + " 轮: 检测到文件名变体循环模式（如 " + lastRequestedBaseNames.join(", ") + " → " + currentBaseNames.join(", ") + "），强制收尾");
              stream("warning", "⚠️ 检测到 AI 在生成文件名变体（如不断追加 'New'），强制收尾");
              forcedFinish = true;
            }
          }
          // 连续 N 轮无法解析任何文件 → 强制收尾
          if (consecutiveUnresolvedRounds >= MAX_CONSECUTIVE_UNRESOLVED && !forcedFinish) {
            log("第 " + round + " 轮: 连续 " + consecutiveUnresolvedRounds + " 轮无法解析任何文件，强制收尾");
            stream("warning", "⚠️ 连续 " + consecutiveUnresolvedRounds + " 轮无法找到 AI 请求的文件，强制收尾");
            forcedFinish = true;
          }
        } else {
          consecutiveUnresolvedRounds = 0;
        }
        lastRequestedBaseNames = currentBaseNames.slice();
      }

      // 强制收尾：要求 AI 输出最终结果（注入已分析摘要作为记忆）
      if (forcedFinish) {
        // 构建已分析维度的摘要
        var analyzedSummary = "## 已完成的分析\n";
        analyzedSummary += "- 已读取文件: " + Object.keys(visitedFiles).length + " 个\n";
        if (covered.length > 0) {
          analyzedSummary += "- 已分析维度: " + covered.join(", ") + "\n";
        }
        if (uncovered.length > 0) {
          analyzedSummary += "- 未充分分析维度: " + uncovered.join(", ") + "\n";
        }
        analyzedSummary += "\n请基于以上已读取的文件和分析结果，输出最终的架构概览。";

        var forcePrompt = "⚠️ 分析已达到强制收尾条件。请立即输出最终的架构概览（status: \"done\"）。\n\n" +
          analyzedSummary + "\n\n";
        if (uncovered.length > 0) {
          forcePrompt += "对于未充分分析的维度，如果已读取的文件中有相关信息，请在 architecture 中补充；如果确实无法获取，可以留空。\n";
        }
        forcePrompt += "## 重要要求\n";
        forcePrompt += "1. 不要继续请求读取文件\n";
        forcePrompt += "2. 只输出你确定的信息，不确定的留空\n";
        forcePrompt += "3. 不要猜测或编造信息\n";
        forcePrompt += "4. 直接输出 JSON 结果";
        conversation.push({ role: "user", content: forcePrompt });
      } else if (nextFiles.length === 0) {
        // 没有下一步文件但也没完成，让 AI 输出最终结果
        log("第 " + (round - 1) + " 轮: AI 未指定下一步文件，请求输出最终结果");
        var promptSuffix = "";
        if (uncovered.length > 0) {
          promptSuffix = " 注意：以下维度尚未充分分析：" + uncovered.join(", ") + "。如果已读取的文件中有相关信息，请在 architecture 中补充；如果确实无法获取，可以留空。";
        }
        conversation.push({
          role: "user",
          content: "请基于已读取的所有文件，输出最终的架构概览（status: \"done\"）。只输出你确定的信息。" + promptSuffix,
        });
      } else {
        // 读取 AI 要求的文件
        var fileContents = [];
        var resolvedFiles = [];
        for (var fi = 0; fi < nextFiles.length && fi < MAX_FILES_PER_ROUND; fi++) {
          var reqPath = nextFiles[fi];
          var matched = resolveSourceFile(reqPath, entryFiles[0], sourceFiles, visitedFiles);
          if (matched) {
            visitedFiles[matched] = true;
            var fc = sourceFiles[matched];
            if (fc.length > 8000) fc = fc.substring(0, 8000) + "\n// ... [已截断]";
            fileContents.push("### " + matched + "\n```\n" + fc + "\n```");
            resolvedFiles.push(matched);
          }
        }

        if (fileContents.length === 0) {
          log("第 " + round + " 轮: 无法找到 AI 要求的文件 (" + nextFiles.join(", ") + ")，请求输出最终结果");
          // 列出项目中实际存在的相关文件，帮助 AI 找到正确路径
          var availableHints = [];
          var allPaths = Object.keys(sourceFiles);
          // 从 AI 请求的文件名中提取关键词
          for (var ahi = 0; ahi < nextFiles.length && availableHints.length < 10; ahi++) {
            var reqBase = nextFiles[ahi].split("/").pop().replace(/\.(js|ts|jsx|tsx|vue)$/i, "");
            // 提取有意义的部分（如 Login, 4A, auth 等）
            var keywords = reqBase.split(/(?=[A-Z])/).filter(function(k) { return k.length > 2; });
            for (var akw = 0; akw < keywords.length && availableHints.length < 10; akw++) {
              for (var ap = 0; ap < allPaths.length; ap++) {
                if (allPaths[ap].toLowerCase().indexOf(keywords[akw].toLowerCase()) !== -1) {
                  if (availableHints.indexOf(allPaths[ap]) === -1) {
                    availableHints.push(allPaths[ap]);
                  }
                }
              }
            }
          }
          var hintStr = availableHints.length > 0
            ? "\n\n项目中实际存在的相关文件路径（请使用这些路径）：\n" + availableHints.join("\n")
            : "\n\n项目中不存在与请求匹配的文件。";
          conversation.push({
            role: "user",
            content: "无法找到你要求的文件：" + nextFiles.join(", ") + hintStr +
              "\n\n请不要再请求不存在的文件。基于已读取的文件输出最终架构概览（status: \"done\"）。" +
              "如果需要读取上述列出的文件，请使用精确路径。",
          });
        } else {
          stream("info", "**第 " + round + " 轮**: 读取 " + resolvedFiles.join(", ") + "\n\n");
          var continuePrompt = "以下是你要读取的文件：\n\n" + fileContents.join("\n\n") + "\n\n请继续分析。如果已经追踪完整，输出 status: \"done\" 和完整架构概览。如果还需要更多文件，输出 status: \"tracing\" 和 nextFiles。";
          if (uncovered.length > 0 && round < MAX_ROUNDS - 1) {
            continuePrompt += "\n\n⚠️ 提醒：以下维度尚未充分分析：" + uncovered.join(", ") + "。请优先读取相关文件来补充这些维度的信息。";
          }
          conversation.push({
            role: "user",
            content: continuePrompt,
          });
        }
      }

      // 调用 AI（带暂停/恢复 + ReasoningLoopError 处理）
      try {
        result = await global.AIFT_AIClient.chatStream(
          config,
          conversation,
          [],
          {
            timeout: 90000,
            maxRetries: 2,
            signal: getSignal(),
            onDelta: function (type, content) {
              if (type === "content") stream("content", content);
              else if (type === "reasoning") stream("reasoning", content);
            },
          }
        );
      } catch (e) {
        // 用户注入消息 → 中止当前请求，注入用户消息后重试本轮（最高优先级）
        if (e.name === "UserAbortError" && pauseState && pauseState.userInjecting && !pauseState.aborted) {
          var injectedMsg2 = pauseState.consumeUserMessage();
          if (injectedMsg2) {
            if (result && result.message) {
              conversation.push({ role: "assistant", content: result.message.content || "" });
            }
            conversation.push({ role: "user", content: "📋 用户补充指令：" + injectedMsg2 + "\n请立即根据以上指令调整你的分析。" });
          }
          stream("info", "💡 用户消息已注入（最高优先级），重新发起请求...\n");
          // 重新发起请求
          result = await global.AIFT_AIClient.chatStream(
            config, conversation, [],
            { timeout: 90000, maxRetries: 2, signal: getSignal(),
              onDelta: function (type, content) {
                if (type === "content") stream("content", content);
                else if (type === "reasoning") stream("reasoning", content);
              }
            }
          );
        } else if (e.name === "UserAbortError" && pauseState && pauseState.paused && !pauseState.aborted) {
          var resumed2 = await checkPausedAndResume();
          if (!resumed2) throw e;
          // 重新发起请求
          result = await global.AIFT_AIClient.chatStream(
            config, conversation, [],
            { timeout: 90000, maxRetries: 2, signal: getSignal(),
              onDelta: function (type, content) {
                if (type === "content") stream("content", content);
                else if (type === "reasoning") stream("reasoning", content);
              }
            }
          );
        } else if (e.name === "ReasoningLoopError") {
          reasoningLoopCount++;
          stream("warning", "⚠️ 第 " + round + " 轮检测到推理死循环（第 " + reasoningLoopCount + " 次），注入干预后重试...");
          log("第 " + round + " 轮: 推理死循环（第 " + reasoningLoopCount + " 次）");
          conversation.push({
            role: "user",
            content: "🚨 推理重复循环！请立即停止反复分析，直接输出当前已知信息的 JSON 结果（status: \"done\" 或 \"tracing\"）。\n不要在思考中反复推导，直接给出结论！",
          });
          // 重试一次
          result = await global.AIFT_AIClient.chatStream(
            config, conversation, [],
            { timeout: 90000, maxRetries: 1, signal: getSignal(),
              onDelta: function (type, content) {
                if (type === "content") stream("content", content);
                else if (type === "reasoning") stream("reasoning", content);
              }
            }
          );
        } else {
          throw e;
        }
      }

      aiText = (result.message.content || "").trim();
      conversation.push({ role: "assistant", content: aiText });

      parsed = parseAIJsonResponse(aiText);
      if (!parsed) {
        log("第 " + round + " 轮: AI 响应解析失败，结束追踪");
        break;
      }
      if (parsed.analysis) log("  AI: " + parsed.analysis);

      // 重置强制收尾标志（如果 AI 这次正常输出了 done）
      if (parsed.status === "done" && parsed.architecture) {
        forcedFinish = false;
      }
    }

    stream("info", "\n");

    // 4. 解析最终结果
    if (!parsed || !parsed.architecture) {
      log("AI 追踪未输出最终架构概览，回退到单轮分析");
      return await analyzeWithAISingleRound(config, rawAnalysis, sourceFiles, onLog, onStream, options);
    }

    var arch = parsed.architecture;
    arch.rawAnalysis = rawAnalysis;
    arch.timestamp = Date.now();
    arch.fileCount = rawAnalysis.fileCount;
    arch.refined = true;
    arch.traced = true;

    // 规范化输出格式，确保字段完整、类型正确
    arch = normalizeArchitecture(arch);

    log("AI 架构分析完成: " + arch.routes.length + " 路由, " + arch.navigation.length + " 导航项");
    if (arch.businessModules && arch.businessModules.length > 0) {
      log("识别到 " + arch.businessModules.length + " 个业务模块");
    }
    if (arch.menuApis && arch.menuApis.length > 0) {
      log("识别到 " + arch.menuApis.length + " 个菜单/路由 API:");
      for (var mi = 0; mi < arch.menuApis.length; mi++) {
        log("  → " + (arch.menuApis[mi].method || "GET") + " " + arch.menuApis[mi].url);
      }
    } else {
      log("未识别到菜单/路由 API（项目可能不使用动态路由）");
    }

    return arch;
  }

  /**
   * 规范化架构分析输出，确保字段完整、类型正确
   * 无论 AI 输出质量如何，经过此函数后输出格式统一
   * @param {Object} arch - AI 返回的架构对象
   * @returns {Object} 规范化后的架构对象
   */
  function normalizeArchitecture(arch) {
    if (!arch || typeof arch !== "object") arch = {};

    // ---- 字符串字段：确保为 string 类型 ----
    var stringFields = [
      "summary", "directoryStructure", "architectureDiagram", "startupFlow", "routeConfig",
      "storeInfo", "apiLayer", "componentSystem", "securityMechanisms",
      "buildAndDeploy", "designPatterns",
    ];
    for (var si = 0; si < stringFields.length; si++) {
      var field = stringFields[si];
      if (!arch[field] || typeof arch[field] !== "string") {
        arch[field] = "";
      }
    }

    // ---- 数组字段：确保为 Array ----
    if (!Array.isArray(arch.routes)) arch.routes = [];
    if (!Array.isArray(arch.navigation)) arch.navigation = [];
    if (!Array.isArray(arch.menuApis)) arch.menuApis = [];
    if (!Array.isArray(arch.businessModules)) arch.businessModules = [];
    if (!Array.isArray(arch.fileInventory)) arch.fileInventory = [];
    if (!Array.isArray(arch.directoryTree)) arch.directoryTree = [];
    if (!Array.isArray(arch.vuexModules)) arch.vuexModules = [];
    if (!Array.isArray(arch.securityDetails)) arch.securityDetails = [];
    if (!Array.isArray(arch.potentialIssues)) arch.potentialIssues = [];
    if (!Array.isArray(arch.strengths)) arch.strengths = [];
    if (!Array.isArray(arch.improvements)) arch.improvements = [];

    // ---- 对象字段：确保为 Object ----
    if (!arch.pageApiMap || typeof arch.pageApiMap !== "object" || Array.isArray(arch.pageApiMap)) {
      arch.pageApiMap = {};
    }
    if (!arch.projectOverview || typeof arch.projectOverview !== "object") {
      arch.projectOverview = null;
    }

    // ---- 规范化 routes 数组项 ----
    for (var ri = 0; ri < arch.routes.length; ri++) {
      var r = arch.routes[ri];
      if (!r || typeof r !== "object") {
        arch.routes.splice(ri, 1);
        ri--;
        continue;
      }
      if (typeof r.path !== "string") r.path = "";
      if (typeof r.name !== "string") r.name = "";
      if (typeof r.component !== "string") r.component = "";
      if (typeof r.description !== "string") r.description = "";
    }

    // ---- 规范化 navigation 数组项 ----
    for (var ni = 0; ni < arch.navigation.length; ni++) {
      var n = arch.navigation[ni];
      if (!n || typeof n !== "object") {
        arch.navigation.splice(ni, 1);
        ni--;
        continue;
      }
      if (typeof n.text !== "string") n.text = "";
      if (typeof n.path !== "string") n.path = "";
      if (typeof n.parent !== "string") n.parent = "";
    }

    // ---- 规范化 menuApis 数组项 ----
    for (var mi = 0; mi < arch.menuApis.length; mi++) {
      var api = arch.menuApis[mi];
      if (!api || typeof api !== "object") {
        arch.menuApis.splice(mi, 1);
        mi--;
        continue;
      }
      if (typeof api.url !== "string") api.url = "";
      if (typeof api.method !== "string") api.method = "GET";
      if (api.body !== null && typeof api.body !== "string") api.body = null;
      if (!api.headers || typeof api.headers !== "object") api.headers = {};
      if (typeof api.description !== "string") api.description = "";
    }

    // ---- 规范化 businessModules 数组项 ----
    for (var bi = 0; bi < arch.businessModules.length; bi++) {
      var bm = arch.businessModules[bi];
      if (!bm || typeof bm !== "object") {
        arch.businessModules.splice(bi, 1);
        bi--;
        continue;
      }
      if (typeof bm.name !== "string") bm.name = "";
      if (typeof bm.description !== "string") bm.description = "";
      if (typeof bm.routePath !== "string") bm.routePath = "";
    }

    // ---- 规范化 fileInventory 数组项 ----
    for (var fii = 0; fii < arch.fileInventory.length; fii++) {
      var fi = arch.fileInventory[fii];
      if (!fi || typeof fi !== "object") {
        arch.fileInventory.splice(fii, 1);
        fii--;
        continue;
      }
      if (typeof fi.path !== "string") fi.path = "";
      if (typeof fi.category !== "string") fi.category = "other";
      if (typeof fi.purpose !== "string") fi.purpose = "";
      if (!Array.isArray(fi.keyExports)) fi.keyExports = [];
      if (!Array.isArray(fi.keyImports)) fi.keyImports = [];
      if (typeof fi.lineCount !== "number") fi.lineCount = 0;
    }

    // ---- 规范化 directoryTree 数组项 ----
    for (var dti = 0; dti < arch.directoryTree.length; dti++) {
      var dt = arch.directoryTree[dti];
      if (!dt || typeof dt !== "object") {
        arch.directoryTree.splice(dti, 1);
        dti--;
        continue;
      }
      if (typeof dt.name !== "string") dt.name = "";
      if (typeof dt.type !== "string") dt.type = "file";
      if (typeof dt.category !== "string") dt.category = "";
      if (typeof dt.purpose !== "string") dt.purpose = "";
      if (typeof dt.fileCount !== "number") dt.fileCount = 0;
      if (typeof dt.lineCount !== "number") dt.lineCount = 0;
      if (typeof dt.depth !== "number") dt.depth = 0;
    }

    // ---- 规范化 vuexModules ----
    for (var vmi = 0; vmi < arch.vuexModules.length; vmi++) {
      var vm = arch.vuexModules[vmi];
      if (!vm || typeof vm !== "object") { arch.vuexModules.splice(vmi, 1); vmi--; continue; }
      if (typeof vm.name !== "string") vm.name = "";
      if (typeof vm.scope !== "string") vm.scope = "";
      if (typeof vm.description !== "string") vm.description = "";
    }

    // ---- 规范化 securityDetails ----
    for (var sdi = 0; sdi < arch.securityDetails.length; sdi++) {
      var sd = arch.securityDetails[sdi];
      if (!sd || typeof sd !== "object") { arch.securityDetails.splice(sdi, 1); sdi--; continue; }
      if (typeof sd.mechanism !== "string") sd.mechanism = "";
      if (typeof sd.implementation !== "string") sd.implementation = "";
    }

    // ---- 规范化 potentialIssues ----
    for (var pii = 0; pii < arch.potentialIssues.length; pii++) {
      var pi = arch.potentialIssues[pii];
      if (!pi || typeof pi !== "object") { arch.potentialIssues.splice(pii, 1); pii--; continue; }
      if (typeof pi.category !== "string") pi.category = "";
      if (typeof pi.issue !== "string") pi.issue = "";
      if (typeof pi.suggestion !== "string") pi.suggestion = "";
    }

    // ---- 规范化 strengths/improvements（字符串数组）----
    arch.strengths = arch.strengths.filter(function (s) { return typeof s === "string" && s.trim(); });
    arch.improvements = arch.improvements.filter(function (s) { return typeof s === "string" && s.trim(); });

    // ---- 规范化 businessModules 增加 category 字段 ----
    for (var bmi = 0; bmi < arch.businessModules.length; bmi++) {
      var bm = arch.businessModules[bmi];
      if (!bm || typeof bm !== "object") { arch.businessModules.splice(bmi, 1); bmi--; continue; }
      if (typeof bm.name !== "string") bm.name = "";
      if (typeof bm.description !== "string") bm.description = "";
      if (typeof bm.routePath !== "string") bm.routePath = "";
      if (typeof bm.category !== "string") bm.category = "";
    }

    // ---- 规范化 pageApiMap ----
    for (var pageKey in arch.pageApiMap) {
      if (!arch.pageApiMap.hasOwnProperty(pageKey)) continue;
      if (!Array.isArray(arch.pageApiMap[pageKey])) {
        arch.pageApiMap[pageKey] = [];
      } else {
        // 确保每项为字符串
        for (var pai = 0; pai < arch.pageApiMap[pageKey].length; pai++) {
          if (typeof arch.pageApiMap[pageKey][pai] !== "string") {
            arch.pageApiMap[pageKey][pai] = String(arch.pageApiMap[pageKey][pai] || "");
          }
        }
      }
    }

    // ---- 规范化 projectOverview ----
    if (arch.projectOverview) {
      var po = arch.projectOverview;
      if (typeof po.type !== "string") po.type = "";
      if (typeof po.description !== "string") po.description = "";
      if (!po.techStack || !Array.isArray(po.techStack)) po.techStack = [];
      for (var tsi = 0; tsi < po.techStack.length; tsi++) {
        var ts = po.techStack[tsi];
        if (!ts || typeof ts !== "object") {
          po.techStack.splice(tsi, 1);
          tsi--;
          continue;
        }
        if (typeof ts.category !== "string") ts.category = "";
        if (typeof ts.name !== "string") ts.name = "";
        if (typeof ts.purpose !== "string") ts.purpose = "";
      }
      if (!po.scale || typeof po.scale !== "object") po.scale = {};
      if (typeof po.scale.totalFiles !== "number") po.scale.totalFiles = 0;
      if (typeof po.scale.description !== "string") po.scale.description = "";
    }

    return arch;
  }

  /**
   * 单轮 AI 分析（降级方案：当无法找到入口文件或追踪失败时使用）
   */
  async function analyzeWithAISingleRound(config, rawAnalysis, sourceFiles, onLog, onStream, options) {
    options = options || {};
    var pauseState = options.pauseState;
    var extraPrompt = options.extraPrompt || "";
    function log(msg) { if (onLog) onLog(msg); }
    function stream(type, content) { if (onStream) onStream(type, content); }
    function getSignal() {
      if (pauseState) return pauseState.getSignal();
      return undefined;
    }

    var heuristicSummary = buildHeuristicSummary(rawAnalysis);
    var fileInventorySummary = buildFileInventorySummary(rawAnalysis.fileInventory || []);

    // 收集关键源码片段（覆盖多个维度，不只关注路由）
    var keySnippets = [];
    var snippetKeywords = [
      "main.js", "main.ts", "index.js", "index.ts", "app.js", "app.ts",
      "router", "route", "menu", "store", "permission", "auth",
      "api", "request", "http", "axios",
      "config", "vue.config", "vite.config", "webpack.config",
      "utils", "filter", "directive", "plugin", "mixin",
      "package.json", "dockerfile", "nginx",
    ];
    for (var p in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(p)) continue;
      var lowerP = p.toLowerCase();
      var matched = false;
      for (var ski = 0; ski < snippetKeywords.length; ski++) {
        if (lowerP.indexOf(snippetKeywords[ski]) !== -1) {
          matched = true;
          break;
        }
      }
      if (matched) {
        var content = sourceFiles[p];
        if (content.length > 4000) content = content.substring(0, 4000) + "\n// ... [已截断]";
        keySnippets.push("### " + p + "\n```\n" + content + "\n```");
        if (keySnippets.length >= 8) break;
      }
    }

    var prompt = [
      "你是一个资深前端架构分析师。请根据以下启发式扫描结果和源码片段，全面分析项目架构。",
      "重点关注：项目框架、技术栈、目录结构、主体业务内容。不需要逐文件分析。",
      "",
      "## 启发式扫描的文件分类（仅供参考，需要你验证和纠正）",
      "",
      fileInventorySummary,
      "",
      "1. **项目概述与技术栈**：项目类型、核心框架及版本、UI 框架、状态管理、HTTP 客户端、图表库等",
      "2. **目录结构与分层架构**：关键目录及职责、分层是否清晰",
      "3. **应用初始化与启动流程**：入口文件如何创建应用、挂载了什么",
      "4. **路由系统**：静态/动态路由、路由守卫、动态路由加载方式",
      "5. **状态管理**：框架、module 结构、权限存储",
      "6. **API 层设计**：HTTP 封装、baseURL、拦截器逻辑、API 文件组织",
      "7. **组件体系**：内部组件库、全局组件、权限组件、图表组件",
      "8. **权限与安全机制**：权限方案、登录方式、加密机制、水印/CSRF/追踪",
      "9. **业务模块分析**：核心业务模块及职责",
      "10. **构建与部署**：构建工具、开发配置、Docker/Nginx、运行时配置",
      "11. **架构特点与设计模式**：技术亮点、设计模式",
      "",
      "只输出你确定的信息，不确定的留空。",
      "",
      "## 启发式扫描结果",
      heuristicSummary,
      "",
      "## 关键源码片段",
      keySnippets.join("\n\n"),
      "",
      "## 输出格式",
      '```json',
      "{",
      '  "projectOverview": {',
      '    "type": "项目类型描述",',
      '    "description": "项目定位和用途说明",',
      '    "techStack": [',
      '      { "category": "核心框架/UI/状态管理/HTTP/图表/...", "name": "Vue 2.7", "purpose": "用途说明" }',
      '    ],',
      '    "scale": { "totalFiles": 0, "description": "规模描述" }',
      "  },",
      '  "directoryStructure": "带注释的目录树（用```包裹）",',
      '  "architectureDiagram": "ASCII 架构图（用```包裹）",',
      '  "startupFlow": "编号步骤描述的启动流程",',
      '  "routeConfig": "路由构建方式描述",',
      '  "storeInfo": "状态管理描述",',
      '  "vuexModules": [{ "name": "模块名", "scope": "业务/权限", "description": "职责" }],',
      '  "apiLayer": "API 层设计描述",',
      '  "componentSystem": "组件体系描述",',
      '  "securityMechanisms": "安全机制描述",',
      '  "securityDetails": [{ "mechanism": "机制名", "implementation": "实现方式" }],',
      '  "businessModules": [',
      '    { "name": "模块名", "description": "模块职责", "routePath": "/xxx", "category": "监控大屏/运营管理/运维管理/资源管理/统计分析/系统管理/其他" }',
      "  ],",
      '  "buildAndDeploy": "构建与部署描述",',
      '  "designPatterns": "架构特点与设计模式描述（编号列出）",',
      '  "potentialIssues": [{ "category": "架构/代码/性能/安全/工程化", "issue": "问题", "suggestion": "建议" }],',
      '  "strengths": ["优势1", "优势2"],',
      '  "improvements": ["待改进1", "待改进2"],',
      '  "routes": [',
      '    { "path": "/路由路径", "name": "页面中文名称", "component": "组件名", "description": "页面功能简述" }',
      "  ],",
      '  "navigation": [',
      '    { "text": "菜单项文本", "path": "/路由路径", "parent": "父级菜单（如有）" }',
      "  ],",
      '  "pageApiMap": {',
      '    "/路由路径": ["GET /api/xxx"]',
      "  },",
      '  "menuApis": [',
      '    { "url": "/api/menu", "method": "GET", "body": null, "headers": {}, "description": "获取菜单数据" }',
      "  ],",
      '  "summary": "项目架构概述（3-5句话，包括项目类型、技术栈、核心特点、业务覆盖范围）"',
      "}",
      "```",
      "只输出 JSON，不要输出其他内容。不确定的字段留空。必须覆盖所有维度。directoryStructure 要输出带注释的目录树，architectureDiagram 要输出 ASCII 架构图，startupFlow 要用编号步骤，vuexModules/securityDetails/potentialIssues 要用数组输出。",
    ].join("\n");

    if (extraPrompt) {
      prompt += "\n\n## 用户额外提示词\n" + extraPrompt;
    }

    log("调用 AI 单轮分析...");
    stream("info", "## AI 架构分析（单轮）\n\n");

    var result = await global.AIFT_AIClient.chatStream(
      config,
      [{ role: "user", content: prompt }],
      [],
      {
        timeout: 120000,
        maxRetries: 3,
        signal: getSignal(),
        onDelta: function (type, content) {
          if (type === "content") stream("content", content);
          else if (type === "reasoning") stream("reasoning", content);
        },
      }
    );

    var text = (result.message.content || "").trim();
    var jsonStart = text.indexOf("{");
    var jsonEnd = text.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1) {
      text = text.substring(jsonStart, jsonEnd + 1);
    }

    var aiAnalysis;
    try {
      aiAnalysis = JSON.parse(text);
    } catch (e) {
      log("AI 分析结果解析失败，使用原始启发式结果");
      rawAnalysis.refined = false;
      return rawAnalysis;
    }

    aiAnalysis.rawAnalysis = rawAnalysis;
    aiAnalysis.timestamp = Date.now();
    aiAnalysis.fileCount = rawAnalysis.fileCount;
    aiAnalysis.refined = true;
    // 规范化输出格式
    aiAnalysis = normalizeArchitecture(aiAnalysis);
    return aiAnalysis;
  }

  /**
   * 构建文件清单摘要（给 AI 作为参考，让 AI 看到所有文件的分类和用途推断）
   */
  function buildFileInventorySummary(fileInventory) {
    if (!fileInventory || fileInventory.length === 0) return "无文件清单";

    var categoryLabels = {
      "entry": "入口文件", "router": "路由", "store": "状态管理", "api": "API 层",
      "permission": "权限", "util": "工具函数", "component": "组件", "view": "页面视图",
      "layout": "布局", "config": "配置", "style": "样式", "filter-directive": "过滤器/指令",
      "mixin": "混入", "plugin": "插件", "types": "类型定义", "test": "测试", "other": "其他",
    };

    // 关键类别：需要列出具体文件
    var keyCategories = { "entry": true, "router": true, "store": true, "api": true, "permission": true, "config": true };
    // 非关键类别：只统计数量
    var groups = {};
    for (var i = 0; i < fileInventory.length; i++) {
      var cat = fileInventory[i].category || "other";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(fileInventory[i]);
    }

    var parts = ["### 文件分类概览（共 " + fileInventory.length + " 个文件）"];

    // 关键类别：列出文件
    for (var catKey in groups) {
      if (!groups.hasOwnProperty(catKey)) continue;
      var files = groups[catKey];
      if (keyCategories[catKey]) {
        parts.push("\n**" + (categoryLabels[catKey] || catKey) + "** (" + files.length + " 个):");
        for (var fi = 0; fi < files.length; fi++) {
          var f = files[fi];
          var line = "- `" + f.path + "`";
          if (f.purpose) line += " — " + f.purpose;
          parts.push(line);
        }
      } else {
        // 非关键类别：只统计数量
        parts.push("- " + (categoryLabels[catKey] || catKey) + ": " + files.length + " 个");
      }
    }

    return parts.join("\n");
  }

  /**
   * 构建启发式分析摘要（给 AI 作为参考）
   */
  function buildHeuristicSummary(rawAnalysis) {
    var parts = [];

    // 技术栈
    if (rawAnalysis.techStack) {
      var ts = rawAnalysis.techStack;
      if (ts.frameworks && ts.frameworks.length > 0) {
        parts.push("### 技术栈（package.json 提取）");
        parts.push("**框架/库**：");
        for (var fi = 0; fi < ts.frameworks.length; fi++) {
          parts.push("- " + ts.frameworks[fi].name + " " + (ts.frameworks[fi].version || ""));
        }
      }
      if (ts.devTools && ts.devTools.length > 0) {
        parts.push("**开发工具**：");
        for (var di2 = 0; di2 < ts.devTools.length; di2++) {
          parts.push("- " + ts.devTools[di2].name + " " + (ts.devTools[di2].version || ""));
        }
      }
      if (ts.keyDeps && ts.keyDeps.length > 0) {
        parts.push("**其他关键依赖**：");
        for (var ki = 0; ki < Math.min(ts.keyDeps.length, 15); ki++) {
          parts.push("- " + ts.keyDeps[ki].name + " " + (ts.keyDeps[ki].version || ""));
        }
      }
    }

    // 目录结构
    if (rawAnalysis.dirStructure) {
      var ds = rawAnalysis.dirStructure;
      if (ds.topDirs && ds.topDirs.length > 0) {
        parts.push("\n### 顶层目录结构");
        for (var ti = 0; ti < Math.min(ds.topDirs.length, 10); ti++) {
          parts.push("- " + ds.topDirs[ti].name + "/ (" + ds.topDirs[ti].fileCount + " 文件)");
        }
      }
      if (ds.srcDirs && ds.srcDirs.length > 0) {
        parts.push("\n### src/ 下目录");
        for (var si = 0; si < Math.min(ds.srcDirs.length, 15); si++) {
          var dir = ds.srcDirs[si];
          var line = "- " + dir.name + "/ (" + dir.fileCount + " 文件)";
          if (dir.sampleFiles && dir.sampleFiles.length > 0) {
            line += " → 示例: " + dir.sampleFiles.join(", ");
          }
          parts.push(line);
        }
      }
    }

    // 业务模块
    if (rawAnalysis.businessModules && rawAnalysis.businessModules.length > 0) {
      parts.push("\n### 业务模块（views/pages 目录提取）");
      for (var bi = 0; bi < Math.min(rawAnalysis.businessModules.length, 30); bi++) {
        var bm = rawAnalysis.businessModules[bi];
        parts.push("- " + bm.name + " (" + bm.fileCount + " 文件)");
      }
    }

    // 组件清单
    if (rawAnalysis.componentInventory && rawAnalysis.componentInventory.length > 0) {
      parts.push("\n### 组件清单（正则提取）");
      var globalComps = [];
      var localComps = [];
      for (var ci = 0; ci < rawAnalysis.componentInventory.length; ci++) {
        var comp = rawAnalysis.componentInventory[ci];
        if (comp.type === "global") globalComps.push(comp.name);
        else localComps.push(comp.name);
      }
      if (globalComps.length > 0) parts.push("**全局组件**：" + globalComps.join(", "));
      if (localComps.length > 0) {
        parts.push("**局部/文件组件**：" + localComps.slice(0, 30).join(", "));
        if (localComps.length > 30) parts.push("…（还有 " + (localComps.length - 30) + " 个）");
      }
    }

    // 安全机制
    if (rawAnalysis.securityPatterns && rawAnalysis.securityPatterns.length > 0) {
      parts.push("\n### 安全机制检测");
      for (var spi = 0; spi < rawAnalysis.securityPatterns.length; spi++) {
        var sp = rawAnalysis.securityPatterns[spi];
        parts.push("- " + sp.detail + " (" + sp.source + ")");
      }
    }

    // 构建配置
    if (rawAnalysis.buildConfig && rawAnalysis.buildConfig.buildTool) {
      parts.push("\n### 构建配置");
      parts.push("- 构建工具: " + rawAnalysis.buildConfig.buildTool);
      if (rawAnalysis.buildConfig.devServer) parts.push("- 开发端口: " + rawAnalysis.buildConfig.devServer.port);
      if (rawAnalysis.buildConfig.proxy) parts.push("- 代理: " + rawAnalysis.buildConfig.proxy);
      if (rawAnalysis.buildConfig.aliases) parts.push("- 路径别名: " + rawAnalysis.buildConfig.aliases);
      if (rawAnalysis.buildConfig.deployInfo) {
        var di3 = rawAnalysis.buildConfig.deployInfo;
        if (di3.docker) parts.push("- 部署: Docker" + (di3.baseImage ? " (基础镜像: " + di3.baseImage + ")" : ""));
        if (di3.nginx) parts.push("- 部署: Nginx");
      }
    }

    // 路由信息
    if (rawAnalysis.routes && rawAnalysis.routes.length > 0) {
      parts.push("\n### 路由（正则提取，可能不完整）");
      for (var ri2 = 0; ri2 < Math.min(rawAnalysis.routes.length, 30); ri2++) {
        var r = rawAnalysis.routes[ri2];
        parts.push("- " + r.path + " → " + (r.component || r.name || "") + " (" + r.source + ")");
      }
    }

    if (rawAnalysis.isDynamicRouting) {
      parts.push("\n### 动态路由检测");
      parts.push("正则检测到动态路由模式");
      if (rawAnalysis.dynamicRoutes && rawAnalysis.dynamicRoutes.length > 0) {
        parts.push("动态注册的路由：");
        for (var di4 = 0; di4 < rawAnalysis.dynamicRoutes.length; di4++) {
          parts.push("- " + rawAnalysis.dynamicRoutes[di4].path + " (" + rawAnalysis.dynamicRoutes[di4].type + ")");
        }
      }
      if (rawAnalysis.menuApis && rawAnalysis.menuApis.length > 0) {
        parts.push("候选菜单 API（可能不准确）：");
        for (var mi2 = 0; mi2 < rawAnalysis.menuApis.length; mi2++) {
          parts.push("- " + rawAnalysis.menuApis[mi2].url + " (" + rawAnalysis.menuApis[mi2].type + ")");
        }
      }
    }

    if (rawAnalysis.navigation && rawAnalysis.navigation.length > 0) {
      parts.push("\n### 导航项（正则提取）");
      for (var ni2 = 0; ni2 < Math.min(rawAnalysis.navigation.length, 20); ni2++) {
        var n = rawAnalysis.navigation[ni2];
        parts.push("- " + n.text + " → " + n.path);
      }
    }

    if (rawAnalysis.apiCalls && rawAnalysis.apiCalls.length > 0) {
      parts.push("\n### API 调用（正则提取，可能不完整）");
      for (var ai2 = 0; ai2 < Math.min(rawAnalysis.apiCalls.length, 20); ai2++) {
        var a = rawAnalysis.apiCalls[ai2];
        parts.push("- " + a.method + " " + a.url + " (" + a.source + ")");
      }
    }

    // 文件分类概览（精简：关键文件列出，其他只统计）
    if (rawAnalysis.fileInventory && rawAnalysis.fileInventory.length > 0) {
      parts.push("\n### 文件分类概览（共 " + rawAnalysis.fileInventory.length + " 个文件）");
      var keyCats = { "entry": true, "router": true, "store": true, "api": true, "permission": true, "config": true };
      var catGroups = {};
      for (var fi2 = 0; fi2 < rawAnalysis.fileInventory.length; fi2++) {
        var cat = rawAnalysis.fileInventory[fi2].category || "other";
        if (!catGroups[cat]) catGroups[cat] = [];
        catGroups[cat].push(rawAnalysis.fileInventory[fi2]);
      }
      var catLabels = {
        "entry": "入口文件", "router": "路由", "store": "状态管理", "api": "API 层",
        "permission": "权限", "util": "工具函数", "component": "组件", "view": "页面视图",
        "layout": "布局", "config": "配置", "style": "样式", "filter-directive": "过滤器/指令",
        "mixin": "混入", "plugin": "插件", "types": "类型定义", "test": "测试", "other": "其他",
      };
      for (var ck in catGroups) {
        if (!catGroups.hasOwnProperty(ck)) continue;
        var cfiles = catGroups[ck];
        if (keyCats[ck]) {
          parts.push("\n**" + (catLabels[ck] || ck) + "** (" + cfiles.length + " 个):");
          for (var fi3 = 0; fi3 < cfiles.length; fi3++) {
            parts.push("- " + cfiles[fi3].path + (cfiles[fi3].purpose ? " — " + cfiles[fi3].purpose : ""));
          }
        } else {
          parts.push("- " + (catLabels[ck] || ck) + ": " + cfiles.length + " 个");
        }
      }
    }

    // 目录树（只显示目录，不显示文件）
    if (rawAnalysis.directoryTree && rawAnalysis.directoryTree.length > 0) {
      parts.push("\n### 目录结构");
      parts.push("```");
      for (var dti = 0; dti < rawAnalysis.directoryTree.length; dti++) {
        var dt = rawAnalysis.directoryTree[dti];
        var indent = "";
        for (var dtj = 0; dtj < dt.depth; dtj++) indent += "  ";
        var line = indent + dt.name + "/ (" + dt.fileCount + " 文件)";
        if (dt.purpose) line += " — " + dt.purpose;
        parts.push(line);
      }
      parts.push("```");
    }

    parts.push("\n### 文件统计");
    parts.push("共扫描 " + rawAnalysis.fileCount + " 个源码文件");

    return parts.length > 0 ? parts.join("\n") : "无可用信息";
  }

  /**
   * 解析源码文件路径（支持精确匹配、相对路径解析、模糊匹配）
   * @returns {string|null}
   */
  function resolveSourceFile(reqPath, fromFile, sourceFiles, visitedFiles) {
    // 精确匹配
    if (sourceFiles.hasOwnProperty(reqPath) && !visitedFiles[reqPath]) {
      return reqPath;
    }

    // 相对路径解析
    var resolved = resolveImportPath(reqPath, fromFile, sourceFiles);
    if (resolved && !visitedFiles[resolved]) {
      return resolved;
    }

    // 模糊匹配：文件名包含
    var reqBase = reqPath.split("/").pop().replace(/\.(js|ts|jsx|tsx|vue)$/, "");
    if (reqBase.length < 3) return null; // 太短不做模糊匹配
    for (var sp in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(sp)) continue;
      if (visitedFiles[sp]) continue;
      var spBase = sp.split("/").pop().replace(/\.(js|ts|jsx|tsx|vue)$/, "");
      if (spBase === reqBase) return sp;
    }

    return null;
  }

  // ============================================================
  // 3. 格式化（将架构概览格式化为 prompt 可用的文本）
  // ============================================================

  function formatForPrompt(analysis) {
    if (!analysis) return "";

    // 导入的架构文档，直接返回文档内容
    if (analysis.importedDocument) {
      return analysis.importedDocument;
    }

    var parts = [];

    if (analysis.refined && analysis.summary) {
      parts.push("## 项目架构概览");
      parts.push(analysis.summary);
    } else {
      parts.push("## 项目架构概览（启发式扫描）");
      parts.push("共扫描 " + (analysis.fileCount || 0) + " 个源码文件");
    }

    // 项目概述与技术栈
    if (analysis.projectOverview) {
      var po = analysis.projectOverview;
      parts.push("");
      parts.push("### 项目概述");
      if (po.type) parts.push("- 项目类型: " + po.type);
      if (po.description) parts.push("- 项目定位: " + po.description);
      if (po.techStack && po.techStack.length > 0) {
        parts.push("");
        parts.push("**技术栈**：");
        for (var tsi = 0; tsi < po.techStack.length; tsi++) {
          var ts = po.techStack[tsi];
          var tsLine = "- " + (ts.category || "") + ": " + ts.name;
          if (ts.purpose) tsLine += "（" + ts.purpose + "）";
          parts.push(tsLine);
        }
      }
      if (po.scale && po.scale.description) {
        parts.push("- 项目规模: " + po.scale.description);
      }
    }

    // 目录结构
    if (analysis.directoryStructure) {
      parts.push("");
      parts.push("### 目录结构");
      parts.push(analysis.directoryStructure);
    }

    // 架构图
    if (analysis.architectureDiagram) {
      parts.push("");
      parts.push("### 架构图");
      parts.push(analysis.architectureDiagram);
    }

    // 应用启动流程
    if (analysis.startupFlow) {
      parts.push("");
      parts.push("### 启动流程");
      parts.push(analysis.startupFlow);
    }

    // 路由构建方式
    if (analysis.routeConfig) {
      parts.push("");
      parts.push("### 路由系统");
      parts.push(analysis.routeConfig);
    }

    // 状态管理
    if (analysis.storeInfo) {
      parts.push("");
      parts.push("### 状态管理");
      parts.push(analysis.storeInfo);
    }

    // Vuex 模块表格
    if (analysis.vuexModules && analysis.vuexModules.length > 0) {
      parts.push("");
      parts.push("### 状态管理模块");
      parts.push("| 模块 | 范围 | 职责 |");
      parts.push("|------|------|------|");
      for (var vmi = 0; vmi < analysis.vuexModules.length; vmi++) {
        var vm = analysis.vuexModules[vmi];
        parts.push("| " + (vm.name || "") + " | " + (vm.scope || "") + " | " + (vm.description || "") + " |");
      }
    }

    // API 层设计
    if (analysis.apiLayer) {
      parts.push("");
      parts.push("### API 层设计");
      parts.push(analysis.apiLayer);
    }

    // 组件体系
    if (analysis.componentSystem) {
      parts.push("");
      parts.push("### 组件体系");
      parts.push(analysis.componentSystem);
    }

    // 安全机制
    if (analysis.securityMechanisms) {
      parts.push("");
      parts.push("### 权限与安全机制");
      parts.push(analysis.securityMechanisms);
    }

    // 安全机制表格
    if (analysis.securityDetails && analysis.securityDetails.length > 0) {
      parts.push("");
      parts.push("### 安全机制详情");
      parts.push("| 机制 | 实现 |");
      parts.push("|------|------|");
      for (var sdi = 0; sdi < analysis.securityDetails.length; sdi++) {
        var sd = analysis.securityDetails[sdi];
        parts.push("| " + (sd.mechanism || "") + " | " + (sd.implementation || "") + " |");
      }
    }

    // 业务模块（按分类分组）
    if (analysis.businessModules && analysis.businessModules.length > 0) {
      if (Array.isArray(analysis.businessModules)) {
        // 按 category 分组
        var bmGroups = {};
        for (var bmi2 = 0; bmi2 < analysis.businessModules.length; bmi2++) {
          var bm2 = analysis.businessModules[bmi2];
          var bmCat = bm2.category || "其他";
          if (!bmGroups[bmCat]) bmGroups[bmCat] = [];
          bmGroups[bmCat].push(bm2);
        }
        parts.push("");
        parts.push("### 业务模块");
        for (var bmCatKey in bmGroups) {
          if (!bmGroups.hasOwnProperty(bmCatKey)) continue;
          var bmList = bmGroups[bmCatKey];
          parts.push("");
          parts.push("**" + bmCatKey + "** (" + bmList.length + " 个):");
          for (var bli = 0; bli < bmList.length; bli++) {
            var bliItem = bmList[bli];
            var bliLine = "- " + (bliItem.name || "");
            if (bliItem.routePath) bliLine += " (" + bliItem.routePath + ")";
            if (bliItem.description) bliLine += ": " + bliItem.description;
            parts.push(bliLine);
          }
        }
      } else if (typeof analysis.businessModules === "string") {
        parts.push("");
        parts.push("### 业务模块");
        parts.push(analysis.businessModules);
      }
    }

    // 构建与部署
    if (analysis.buildAndDeploy) {
      parts.push("");
      parts.push("### 构建与部署");
      parts.push(analysis.buildAndDeploy);
    }

    // 架构特点与设计模式
    if (analysis.designPatterns) {
      parts.push("");
      parts.push("### 架构特点与设计模式");
      parts.push(analysis.designPatterns);
    }

    // 潜在问题与优化建议
    if (analysis.potentialIssues && analysis.potentialIssues.length > 0) {
      parts.push("");
      parts.push("### 潜在问题与优化建议");
      parts.push("| 维度 | 问题 | 建议 |");
      parts.push("|------|------|------|");
      for (var pii = 0; pii < analysis.potentialIssues.length; pii++) {
        var pi = analysis.potentialIssues[pii];
        parts.push("| " + (pi.category || "") + " | " + (pi.issue || "") + " | " + (pi.suggestion || "") + " |");
      }
    }

    // 优势与待改进
    if (analysis.strengths && analysis.strengths.length > 0) {
      parts.push("");
      parts.push("### 优势");
      for (var si = 0; si < analysis.strengths.length; si++) {
        parts.push("- " + analysis.strengths[si]);
      }
    }
    if (analysis.improvements && analysis.improvements.length > 0) {
      parts.push("");
      parts.push("### 待改进");
      for (var ii = 0; ii < analysis.improvements.length; ii++) {
        parts.push("- " + analysis.improvements[ii]);
      }
    }

    // 路由地图
    if (analysis.routes && analysis.routes.length > 0) {
      parts.push("");
      parts.push("### 路由地图");
      for (var i = 0; i < analysis.routes.length; i++) {
        var r = analysis.routes[i];
        var line = "- " + r.path;
        if (r.name) line += " → " + r.name;
        else if (r.component) line += " → " + r.component;
        if (r.description) line += "（" + r.description + "）";
        parts.push(line);
      }
    }

    // 动态路由信息
    if (analysis.menuApis && analysis.menuApis.length > 0) {
      parts.push("");
      parts.push("### 菜单/路由 API");
      for (var mi = 0; mi < analysis.menuApis.length; mi++) {
        var api = analysis.menuApis[mi];
        var apiLine = "- " + (api.method || "GET") + " " + api.url;
        if (api.description) apiLine += "（" + api.description + "）";
        parts.push(apiLine);
      }
    }
    if (analysis.apiFetchedRoutes && analysis.apiFetchedRoutes.length > 0) {
      parts.push("");
      parts.push("通过重放菜单 API 获取的动态路由（" + analysis.apiFetchedRoutes.length + " 条）：");
      for (var fr = 0; fr < analysis.apiFetchedRoutes.length; fr++) {
        var frItem = analysis.apiFetchedRoutes[fr];
        var frLine = "- " + frItem.path;
        if (frItem.name) frLine += " → " + frItem.name;
        if (frItem.description) frLine += "（" + frItem.description + "）";
        parts.push(frLine);
      }
    }
    if (analysis.runtimeNavigation && analysis.runtimeNavigation.length > 0) {
      parts.push("");
      parts.push("运行时已渲染的导航菜单（从 DOM 提取）：");
      for (var ri = 0; ri < analysis.runtimeNavigation.length; ri++) {
        var rn = analysis.runtimeNavigation[ri];
        var rline = "- ";
        if (rn.parent) rline += rn.parent + " › ";
        rline += rn.text + " → " + rn.path;
        parts.push(rline);
      }
    }

    // 导航结构
    if (analysis.navigation && analysis.navigation.length > 0) {
      parts.push("");
      parts.push("### 导航结构");
      // 按父级分组
      var grouped = {};
      var noParent = [];
      for (var j = 0; j < analysis.navigation.length; j++) {
        var nav = analysis.navigation[j];
        if (nav.parent) {
          if (!grouped[nav.parent]) grouped[nav.parent] = [];
          grouped[nav.parent].push(nav);
        } else {
          noParent.push(nav);
        }
      }
      // 输出有层级的
      for (var parent in grouped) {
        if (grouped.hasOwnProperty(parent)) {
          parts.push("- " + parent);
          for (var k = 0; k < grouped[parent].length; k++) {
            parts.push("  - " + grouped[parent][k].text + " → " + grouped[parent][k].path);
          }
        }
      }
      // 输出无层级的
      for (var l = 0; l < noParent.length; l++) {
        parts.push("- " + noParent[l].text + " → " + noParent[l].path);
      }
    }

    // API 映射
    if (analysis.pageApiMap) {
      var apiCount = 0;
      for (var k2 in analysis.pageApiMap) { if (analysis.pageApiMap.hasOwnProperty(k2)) apiCount++; }
      if (apiCount > 0) {
        parts.push("");
        parts.push("### 页面-API 映射");
        for (var page in analysis.pageApiMap) {
          if (analysis.pageApiMap.hasOwnProperty(page)) {
            parts.push("- " + page + ": " + analysis.pageApiMap[page].join(", "));
          }
        }
      }
    } else if (analysis.apiCalls && analysis.apiCalls.length > 0) {
      parts.push("");
      parts.push("### API 调用列表");
      for (var ai = 0; ai < Math.min(analysis.apiCalls.length, 30); ai++) {
        var a = analysis.apiCalls[ai];
        parts.push("- " + a.method + " " + a.url + " (" + a.source + ")");
      }
    }

    return parts.join("\n");
  }

  // ============================================================
  // 4. 缓存管理
  // ============================================================

  async function saveCache(analysis) {
    await chrome.storage.local.set({ aift_arch_cache: analysis });
  }

  async function loadCache() {
    var data = await chrome.storage.local.get(CACHE_KEY);
    return data[CACHE_KEY] || null;
  }

  async function clearCache() {
    await chrome.storage.local.remove(CACHE_KEY);
  }

  async function getCacheInfo() {
    var data = await chrome.storage.local.get(CACHE_KEY);
    var cache = data[CACHE_KEY];
    if (!cache) return null;
    return {
      timestamp: cache.timestamp,
      fileCount: cache.fileCount,
      refined: cache.refined || false,
      routeCount: cache.routes ? cache.routes.length : 0,
      navCount: cache.navigation ? cache.navigation.length : 0,
      businessModuleCount: cache.businessModules ? cache.businessModules.length : 0,
      hasProjectOverview: !!cache.projectOverview,
      hasDirectoryStructure: !!cache.directoryStructure,
      hasSecurityMechanisms: !!cache.securityMechanisms,
      hasDesignPatterns: !!cache.designPatterns,
      fileInventoryCount: cache.fileInventory ? cache.fileInventory.length : 0,
      directoryTreeCount: cache.directoryTree ? cache.directoryTree.length : 0,
    };
  }

  // ============================================================
  // 5. 运行时导航捕获（从已渲染的 DOM 提取导航菜单）
  // ============================================================

  /**
   * 从运行时 DOM 提取导航菜单结构
   * @param {function} ensureContentScript - 注入 content script
   * @param {function} sendMessage - 发消息给 content script
   * @param {number} tabId
   * @returns {Promise<Array<{text, path, parent}>>}
   */
  async function captureRuntimeNavigation(ensureContentScript, sendMessage, tabId) {
    try {
      await ensureContentScript();
      var resp = await sendMessage(tabId, { type: "AIFT_CAPTURE_NAVIGATION" });
      if (!resp || !resp.ok) return [];
      return resp.navigation || [];
    } catch (e) {
      return [];
    }
  }

  // ============================================================
  // 6. 菜单 API 请求重放（在页面上下文中重新请求菜单接口，拿到完整路由数据）
  // ============================================================

  /**
   * 在页面上下文中发起 fetch 请求（自动携带 cookie/auth）
   * 使用 evalInPage（chrome.scripting.executeScript MAIN world）替代 inspectedWindow.eval
   * @param {function} evalInPage - (code: string) => Promise<{ok, result}>
   * @param {string} url - 请求 URL（相对路径会基于页面 origin 拼接）
   * @param {string} method - HTTP 方法
   * @param {Object} [options] - 额外选项
   * @param {string} [options.body] - 请求体（POST/PUT 时使用）
   * @param {Object} [options.headers] - 额外的请求头
   * @returns {Promise<{ok, status, body}>}
   */
  async function fetchInPageContext(evalInPage, url, method, options) {
    method = method || "GET";
    options = options || {};

    var fetchOptions = {
      method: method,
      credentials: "include",
      headers: Object.assign({ Accept: "application/json" }, options.headers || {}),
    };
    if (options.body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      fetchOptions.body = options.body;
    }

    var code = [
      "(async function() {",
      "  try {",
      "    var resp = await fetch(" + JSON.stringify(url) + ", " + JSON.stringify(fetchOptions) + ");",
      "    var status = resp.status;",
      "    var text = await resp.text();",
      "    return JSON.stringify({ ok: true, status: status, body: text });",
      "  } catch(e) {",
      "    return JSON.stringify({ ok: false, error: String(e) });",
      "  }",
      "})()",
    ].join("\n");

    var resp = await evalInPage(code);
    if (!resp || !resp.ok) {
      return { ok: false, error: (resp && resp.error) || "evalInPage 执行失败" };
    }
    try {
      var parsed = JSON.parse(resp.result);
      return parsed;
    } catch (e) {
      return { ok: false, error: "解析 fetch 结果失败: " + (e.message || String(e)) };
    }
  }

  /**
   * 启发式解析菜单 API 响应，提取路由和导航结构
   * 兼容常见响应格式：
   *   - { data: [{ path, name, component, children }] }
   *   - { data: [{ url, name, children }] }
   *   - { menu: [{ path, title, ... }] }
   *   - { routes: [...] }
   *   - 直接数组 [{ path, name, ... }]
   */
  function parseMenuApiResponse(body) {
    var routes = [];
    var navItems = [];

    var data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      return { routes: routes, navItems: navItems, parseError: "JSON 解析失败" };
    }

    // 找到包含路由数据的数组
    var routeArray = null;
    if (Array.isArray(data)) {
      routeArray = data;
    } else if (data.data && Array.isArray(data.data)) {
      routeArray = data.data;
    } else if (data.data && Array.isArray(data.data.routes)) {
      routeArray = data.data.routes;
    } else if (data.data && Array.isArray(data.data.menu)) {
      routeArray = data.data.menu;
    } else if (data.data && Array.isArray(data.data.menus)) {
      routeArray = data.data.menus;
    } else if (data.data && Array.isArray(data.data.permissions)) {
      routeArray = data.data.permissions;
    } else if (data.routes) {
      routeArray = Array.isArray(data.routes) ? data.routes : null;
    } else if (data.menu) {
      routeArray = Array.isArray(data.menu) ? data.menu : null;
    } else if (data.menus) {
      routeArray = Array.isArray(data.menus) ? data.menus : null;
    } else if (data.permissions) {
      routeArray = Array.isArray(data.permissions) ? data.permissions : null;
    } else if (data.list) {
      routeArray = Array.isArray(data.list) ? data.list : null;
    } else if (data.items) {
      routeArray = Array.isArray(data.items) ? data.items : null;
    }

    if (!routeArray) {
      // 尝试遍历一层属性找数组
      for (var key in data) {
        if (data.hasOwnProperty(key) && Array.isArray(data[key]) && data[key].length > 0) {
          routeArray = data[key];
          break;
        }
      }
    }

    if (!routeArray) {
      return { routes: routes, navItems: navItems, parseError: "未找到路由数组" };
    }

    // 递归解析路由项
    function parseItem(item, parent) {
      if (!item || typeof item !== "object") return;

      // 提取路径（兼容 path / url / route / link）
      var path = item.path || item.url || item.route || item.link || "";
      // 提取名称（兼容 name / title / label / text / meta.title / meta.name）
      var name = item.name || item.title || item.label || item.text || "";
      if (!name && item.meta) name = item.meta.title || item.meta.name || "";
      // 提取组件
      var component = item.component || "";
      if (typeof component === "object" && component.name) component = component.name;
      // 提取图标（用于导航描述）
      var icon = item.icon || (item.meta ? item.meta.icon : "") || "";

      if (path && path !== "/" && path.indexOf("http") !== 0) {
        routes.push({
          path: path,
          name: name,
          component: typeof component === "string" ? component : "",
          description: icon ? "图标: " + icon : "",
          source: "menu-api",
          framework: "dynamic",
        });
      }

      if (name && path) {
        navItems.push({
          text: name,
          path: path,
          parent: parent || "",
        });
      }

      // 递归子节点
      var children = item.children || item.subMenus || item.submenus || item.child || item.items;
      if (Array.isArray(children)) {
        for (var ci = 0; ci < children.length; ci++) {
          parseItem(children[ci], name);
        }
      }
    }

    for (var i = 0; i < routeArray.length; i++) {
      parseItem(routeArray[i], "");
    }

    return { routes: routes, navItems: navItems, parseError: null };
  }

  /**
   * 使用 AI 解析复杂的菜单 API 响应
   * 当启发式解析结果为空或失败时，用 AI 从响应中提取路由信息
   */
  async function parseMenuResponseWithAI(config, url, body, onLog, onStream, signal) {
    function log(msg) { if (onLog) onLog(msg); }
    function stream(type, content) { if (onStream) onStream(type, content); }

    // 截断过长的响应体
    var truncatedBody = body;
    if (truncatedBody.length > 6000) {
      truncatedBody = truncatedBody.substring(0, 6000) + "\n... [已截断，原始长度 " + body.length + "]";
    }

    var prompt = [
      "你是一个前端架构分析师。以下是一个菜单/路由 API 的响应数据，请从中提取路由信息。",
      "",
      "API URL: " + url,
      "",
      "## 响应数据",
      "```json",
      truncatedBody,
      "```",
      "",
      "## 输出要求",
      "请以 JSON 格式输出，包含以下字段：",
      '```json',
      "{",
      '  "routes": [',
      '    { "path": "/路由路径", "name": "页面中文名称", "component": "组件名（如有）", "description": "页面功能简述" }',
      "  ],",
      '  "navigation": [',
      '    { "text": "菜单项文本", "path": "/路由路径", "parent": "父级菜单名称（如有）" }',
      "  ]",
      "}",
      "```",
      "",
      "## 规则",
      "1. 从响应数据中提取所有路由项，递归处理 children/subMenus 等嵌套结构",
      "2. 根据路径和名称推断页面的中文名称",
      "3. 导航结构要反映菜单的层级关系（parent 字段）",
      "4. 只输出 JSON，不要输出任何其他内容",
    ].join("\n");

    log("调用 AI 解析菜单 API 响应: " + url);
    stream("info", "AI 解析菜单响应: " + url + "\n");

    var result = await global.AIFT_AIClient.chatStream(
      config,
      [{ role: "user", content: prompt }],
      [],
      {
        timeout: 90000,
        maxRetries: 2,
        signal: signal,
        onDelta: function (type, content) {
          if (type === "content") stream("content", content);
          else if (type === "reasoning") stream("reasoning", content);
        },
      }
    );

    var text = (result.message.content || "").trim();
    var jsonStart = text.indexOf("{");
    var jsonEnd = text.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1) {
      text = text.substring(jsonStart, jsonEnd + 1);
    }

    try {
      var parsed = JSON.parse(text);
      return {
        routes: parsed.routes || [],
        navItems: parsed.navigation || [],
        parseError: null,
      };
    } catch (e) {
      log("AI 解析菜单响应失败");
      return { routes: [], navItems: [], parseError: "AI 解析失败" };
    }
  }

  /**
   * 查找项目入口文件
   * 常见入口：main.js/ts/jsx/tsx, index.js/ts/jsx/tsx, app.js/ts/jsx/tsx
   * @param {Object} sourceFiles - { path: content }
   * @returns {Array<string>} 入口文件路径列表
   */
  function findEntryFiles(sourceFiles) {
    var entryPatterns = [
      /^main\.(js|ts|jsx|tsx)$/i,
      /^src\/main\.(js|ts|jsx|tsx)$/i,
      /^index\.(js|ts|jsx|tsx)$/i,
      /^src\/index\.(js|ts|jsx|tsx)$/i,
      /^app\.(js|ts|jsx|tsx)$/i,
      /^src\/app\.(js|ts|jsx|tsx)$/i,
      /^src\/App\.(js|ts|jsx|tsx)$/i,
    ];
    var entries = [];
    for (var p in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(p)) continue;
      // 去掉 ./ 前缀
      var cleanP = p.replace(/^\.\//, "");
      for (var i = 0; i < entryPatterns.length; i++) {
        if (entryPatterns[i].test(cleanP)) {
          entries.push(p);
          break;
        }
      }
    }
    return entries;
  }

  /**
   * 根据导入路径在 sourceFiles 中查找匹配的文件
   * 处理 ./xxx, ../xxx, @/xxx, @/xxx/index 等常见路径别名
   * @param {string} importPath - import 语句中的路径
   * @param {string} fromFile - 当前文件路径
   * @param {Object} sourceFiles - { path: content }
   * @returns {string|null} 匹配的文件路径
   */
  function resolveImportPath(importPath, fromFile, sourceFiles) {
    if (!importPath) return null;

    // 标准化路径
    var candidates = [];

    // 1. 处理 @/ 别名 → src/
    if (importPath.indexOf("@/") === 0) {
      candidates.push("src/" + importPath.substring(2));
      candidates.push(importPath.substring(2));
    }
    // 2. 处理相对路径
    else if (importPath.indexOf("./") === 0 || importPath.indexOf("../") === 0) {
      var dir = fromFile.substring(0, fromFile.lastIndexOf("/"));
      var resolved = dir + "/" + importPath;
      // 规范化 ../
      while (resolved.indexOf("../") !== -1) {
        var idx = resolved.indexOf("../");
        var before = resolved.substring(0, idx - 1);
        var lastSlash = before.lastIndexOf("/");
        if (lastSlash === -1) break;
        resolved = before.substring(0, lastSlash) + "/" + resolved.substring(idx + 3);
      }
      candidates.push(resolved.replace(/^\.\//, ""));
    }
    // 3. 直接路径
    else if (importPath.indexOf("/") === 0) {
      candidates.push(importPath.substring(1));
    } else {
      candidates.push(importPath);
    }

    // 尝试匹配，补全扩展名
    var exts = ["", ".js", ".ts", ".jsx", ".tsx", ".vue", "/index.js", "/index.ts", "/index.jsx", "/index.tsx", "/index.vue"];

    for (var ci = 0; ci < candidates.length; ci++) {
      var cand = candidates[ci];
      for (var ei = 0; ei < exts.length; ei++) {
        var tryPath = cand + exts[ei];
        if (sourceFiles.hasOwnProperty(tryPath)) {
          return tryPath;
        }
        // 也尝试去掉 src/ 前缀
        if (tryPath.indexOf("src/") === 0) {
          var noSrc = tryPath.substring(4);
          if (sourceFiles.hasOwnProperty(noSrc)) return noSrc;
        }
        // 也尝试加上 src/ 前缀
        if (tryPath.indexOf("src/") !== 0) {
          var withSrc = "src/" + tryPath;
          if (sourceFiles.hasOwnProperty(withSrc)) return withSrc;
        }
      }
    }

    // 模糊匹配：文件名包含
    var importBaseName = importPath.split("/").pop();
    for (var p in sourceFiles) {
      if (!sourceFiles.hasOwnProperty(p)) continue;
      if (p.indexOf(importBaseName) !== -1 && p.indexOf(importBaseName) === p.length - importBaseName.length - exts[0].length) {
        // 检查是否以 importBaseName + 扩展名结尾
        for (var ei2 = 1; ei2 < exts.length; ei2++) {
          if (p.endsWith(importBaseName + exts[ei2])) return p;
        }
      }
    }

    return null;
  }


  /**
   * 解析 AI 返回的 JSON 响应
   * @param {string} text - AI 返回的文本
   * @returns {Object|null} 解析后的对象
   */
  function parseAIJsonResponse(text) {
    if (!text) return null;
    var jsonStart = text.indexOf("{");
    var jsonEnd = text.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) return null;
    var jsonStr = text.substring(jsonStart, jsonEnd + 1);
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // 尝试修复常见 JSON 问题（尾逗号）
      try {
        jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1");
        return JSON.parse(jsonStr);
      } catch (e2) {
        return null;
      }
    }
  }

  /**
   * 重放菜单 API 请求，获取完整路由数据
   * menuApis 应来自 analyzeWithAI 的深度分析结果（AI 追踪识别的准确 API）。
   * 如果没有 AI 分析结果，使用启发式提取的 menuApis 作为 fallback。
   * @param {number} tabId - 目标标签页 ID
   * @param {function} evalInPage - (code: string) => Promise<{ok, result}>
   * @param {Array} menuApis - 菜单 API 列表（来自 AI 分析或启发式提取）
   * @param {Object} config - AI 配置（可选，用于解析 API 响应）
   * @param {function} onLog
   * @param {function} onStream
   * @param {AbortSignal} [signal] - 用于中止 AI 请求
   * @returns {Promise<{routes, navItems, apiResponses}>}
   */
  async function fetchDynamicRoutes(tabId, evalInPage, menuApis, config, onLog, onStream, signal) {
    function log(msg) { if (onLog) onLog(msg); }
    function stream(type, content) { if (onStream) onStream(type, content); }

    if (!menuApis || menuApis.length === 0) {
      log("没有菜单 API 需要请求");
      return { routes: [], navItems: [], apiResponses: [] };
    }

    var hasAIConfig = config && config.apiUrl && config.apiKey && config.model;
    var allRoutes = [];
    var allNavItems = [];
    var apiResponses = [];

    log("请求 " + menuApis.length + " 个菜单 API...");

    for (var i = 0; i < menuApis.length; i++) {
      var apiUrl = menuApis[i].url;
      var apiMethod = menuApis[i].method || "GET";
      var apiBody = menuApis[i].body || null;
      var apiHeaders = menuApis[i].headers || {};

      log("重放菜单 API 请求: " + apiMethod + " " + apiUrl);
      stream("info", "请求菜单 API: " + apiUrl + "\n");

      var fetchOpts = {};
      if (apiBody) fetchOpts.body = apiBody;
      if (apiHeaders && Object.keys(apiHeaders).length > 0) fetchOpts.headers = apiHeaders;

      var resp = await fetchInPageContext(evalInPage, apiUrl, apiMethod, fetchOpts);
      if (!resp.ok) {
        log("  请求失败: " + (resp.error || "未知错误"));
        apiResponses.push({ url: apiUrl, ok: false, error: resp.error });
        continue;
      }

      if (resp.status >= 400) {
        log("  请求返回错误状态: " + resp.status);
        apiResponses.push({ url: apiUrl, ok: false, status: resp.status });
        continue;
      }

      var body = resp.body || "";
      if (body.length === 0) {
        log("  响应体为空");
        apiResponses.push({ url: apiUrl, ok: false, error: "空响应" });
        continue;
      }

      log("  响应体: " + body.length + " 字符");
      apiResponses.push({ url: apiUrl, ok: true, status: resp.status, bodyLength: body.length });

      // 先尝试启发式解析
      var parsed = parseMenuApiResponse(body);
      if (parsed.routes.length > 0) {
        log("  启发式解析成功: " + parsed.routes.length + " 路由, " + parsed.navItems.length + " 导航项");
        allRoutes = allRoutes.concat(parsed.routes);
        allNavItems = allNavItems.concat(parsed.navItems);
      } else if (hasAIConfig) {
        // 启发式解析失败，用 AI 解析
        log("  启发式解析未提取到路由，使用 AI 解析...");
        var aiParsed = await parseMenuResponseWithAI(config, apiUrl, body, onLog, onStream, signal);
        if (aiParsed.routes.length > 0) {
          log("  AI 解析成功: " + aiParsed.routes.length + " 路由, " + aiParsed.navItems.length + " 导航项");
          allRoutes = allRoutes.concat(aiParsed.routes);
          allNavItems = allNavItems.concat(aiParsed.navItems);
        } else {
          log("  AI 解析也未提取到路由，跳过此 API");
        }
      } else {
        log("  启发式解析未提取到路由，未配置 AI 无法进一步解析");
      }
    }

    // 去重
    var seenRoutes = {};
    var uniqueRoutes = [];
    for (var r = 0; r < allRoutes.length; r++) {
      if (!seenRoutes[allRoutes[r].path]) {
        seenRoutes[allRoutes[r].path] = true;
        uniqueRoutes.push(allRoutes[r]);
      }
    }
    var seenNav = {};
    var uniqueNav = [];
    for (var n = 0; n < allNavItems.length; n++) {
      var key = allNavItems[n].text + "|" + allNavItems[n].path;
      if (!seenNav[key]) {
        seenNav[key] = true;
        uniqueNav.push(allNavItems[n]);
      }
    }

    return { routes: uniqueRoutes, navItems: uniqueNav, apiResponses: apiResponses };
  }

  /**
   * 将运行时导航数据合并到分析结果中
   */
  function mergeRuntimeNavigation(analysis, runtimeNav) {
    if (!runtimeNav || runtimeNav.length === 0) return analysis;

    analysis.runtimeNavigation = runtimeNav;

    // 合并到 navigation（去重）
    if (!analysis.navigation) analysis.navigation = [];
    var seen = {};
    for (var i = 0; i < analysis.navigation.length; i++) {
      seen[analysis.navigation[i].text + "|" + analysis.navigation[i].path] = true;
    }
    for (var j = 0; j < runtimeNav.length; j++) {
      var key = runtimeNav[j].text + "|" + runtimeNav[j].path;
      if (!seen[key]) {
        seen[key] = true;
        analysis.navigation.push(runtimeNav[j]);
      }
    }

    // 从运行时导航中提取路由
    if (!analysis.routes) analysis.routes = [];
    var seenPaths = {};
    for (var k = 0; k < analysis.routes.length; k++) {
      seenPaths[analysis.routes[k].path] = true;
    }
    for (var l = 0; l < runtimeNav.length; l++) {
      var navPath = runtimeNav[l].path;
      if (navPath && !seenPaths[navPath]) {
        seenPaths[navPath] = true;
        analysis.routes.push({
          path: navPath,
          name: runtimeNav[l].text,
          component: "",
          description: "运行时导航提取",
          source: "runtime-dom",
          framework: "dynamic",
        });
      }
    }

    return analysis;
  }

  // ============================================================
  // 导出
  // ============================================================

  global.AIFT_ProjectAnalyzer = {
    analyze: analyze,
    analyzeWithAI: analyzeWithAI,
    formatForPrompt: formatForPrompt,
    saveCache: saveCache,
    loadCache: loadCache,
    clearCache: clearCache,
    getCacheInfo: getCacheInfo,
    captureRuntimeNavigation: captureRuntimeNavigation,
    mergeRuntimeNavigation: mergeRuntimeNavigation,
    fetchDynamicRoutes: fetchDynamicRoutes,
    parseMenuApiResponse: parseMenuApiResponse,
    normalizeArchitecture: normalizeArchitecture,
  };
})(window);
