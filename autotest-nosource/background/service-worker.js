// 后台 Service Worker
// 职责：Side Panel 管理、CDP debugger 清理、tab 关闭时的资源回收

// Side Panel：点击扩展图标时打开侧边栏
chrome.runtime.onInstalled.addListener(function () {
  console.log("[AIFT] 扩展已安装");
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// 当 tab 关闭时，清理可能残留的 CDP debugger 附加
chrome.tabs.onRemoved.addListener(function (tabId) {
  chrome.debugger.detach({ tabId: tabId }, function () {
    if (chrome.runtime.lastError) return;
    console.log("[AIFT] Tab " + tabId + " 关闭，已清理 CDP debugger");
  });
});

// Side Panel 连接断开时，清理可能残留的 debugger
chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === "sidepanel") {
    port.onDisconnect.addListener(function () {
      chrome.tabs.query({}, function (tabs) {
        for (var i = 0; i < tabs.length; i++) {
          (function (tabId) {
            chrome.debugger.detach({ tabId: tabId }, function () {
              if (chrome.runtime.lastError) return;
              console.log("[AIFT] Side Panel 关闭，已清理 tab " + tabId + " 的 debugger");
            });
          })(tabs[i].id);
        }
      });
    });
  }
});
