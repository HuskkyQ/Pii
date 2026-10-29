import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import App from "./App.tsx";
import { installMetricsReporting } from "./lib/metrics.ts";
import { installViewportFix } from "./lib/viewport.ts";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * 禁掉 Safari 的双指缩放。
 *
 * 为什么 CSS 不够：iOS Safari 不认 user-scalable=no（2019 年起出于无障碍考虑），
 * 但它仍然派发 `gesturestart` / `gesturechange`，阻止掉就能锁住页面；
 * Chrome 那边靠 CSS 的 `touch-action: pan-y` 已经够了。
 */
for (const type of ["gesturestart", "gesturechange", "gestureend"] as const) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

// 顶部安全区自适应（要在首帧之前生效，避免闪一下）
installViewportFix();

// 真机尺寸上报（排查布局问题用；失败静默）
installMetricsReporting();

// 注册 service worker（PWA 安装前提）。开发环境交给 Vite，不注册。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  // 新 SW 接管时自动刷新一次，让页面真的切到新代码（首次安装不刷，避免多余重载）
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener("load", () => {
    void navigator.serviceWorker
      // updateViaCache:none —— 别让浏览器拿 HTTP 缓存里的旧 sw.js，每次都探一下新版
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => {
        // 回到前台就主动检查一次更新（iOS 独立 PWA 尤其需要，否则它能一直赖着旧版）
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") void registration.update().catch(() => {});
        });
        void registration.update().catch(() => {});
      })
      .catch(() => {
        /* 注册失败不影响使用，只是不能安装 */
      });
  });
}
