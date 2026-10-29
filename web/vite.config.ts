import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  /*
   * 构建指纹：客户端会把 BUILD 一起上报。
   * 为什么需要它：PWA 有 service worker + HTTP 缓存，我经常分不清
   * 「改了没生效」和「手机跑的还是上一版」——有了这个一眼就能判断。
   */
  define: {
    __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 19)),
  },
  build: {
    /*
     * 不要清空 dist。
     *
     * 原因：service worker 的导航是「缓存优先」，它可能还拿着上一版 index.html，
     * 里面引用的是上一版的 /assets/index-OLD.js。如果每次构建都把 dist 清空，
     * 那个文件就 404 了 —— 页面白给。
     * 留着旧资源，旧壳就还能从缓存里拼出完整页面（代价只是磁盘上多几份 600KB）。
     */
    emptyOutDir: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    // 开发时把 /api 转发给 pii 服务端；生产由服务端直接托管 dist。
    proxy: {
      "/api": {
        target: process.env.PII_SERVER ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        // SSE 必须关掉缓冲
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cache-control"] = "no-cache, no-transform";
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
    },
  },
});
