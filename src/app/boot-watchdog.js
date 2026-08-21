var BOOT_TIMEOUT_MS = 15_000;
var app = document.querySelector("#app");

function isPending() {
  return app && app.querySelector(".boot-screen[aria-busy='true']");
}

function renderBootFailure() {
  if (!isPending()) return;
  document.title = "Ecolab · 启动失败 / Startup failed";
  app.innerHTML = [
    '<main class="fatal-screen" id="main-content">',
    '<div class="boot-mark" aria-hidden="true">E</div>',
    '<p class="eyebrow">Ecolab</p>',
    '<h1>启动时间过长 / Startup is taking too long</h1>',
    '<p>请重新加载页面。如果问题持续，请关闭其他 Ecolab 标签页、清除此网站的缓存和站点数据，并使用最新版 Safari、Chrome、Edge 或 Firefox。</p>',
    '<p>Please reload. If the problem continues, close other Ecolab tabs, clear this site\'s cache and site data, and use a current Safari, Chrome, Edge, or Firefox release.</p>',
    '<button class="primary-button" type="button" data-boot-reload>重新加载 / Reload</button>',
    '</main>',
  ].join("");
  var reloadButton = app.querySelector("[data-boot-reload]");
  if (reloadButton) reloadButton.addEventListener("click", function reload() { location.reload(); });
}

setTimeout(renderBootFailure, BOOT_TIMEOUT_MS);
