import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** 构建指纹：客户端会把它一起上报，用来区分「改了没生效」和「跑的是上一版」。 */
const BUILD = new Date().toISOString().slice(0, 19);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    /*
     * 让 service worker 的缓存版本跟着构建走。
     *
     * 为什么必须这样：SW 的导航是「缓存优先」，装过一次的手机永远先拿缓存里的旧壳。
     * 旧壳引用旧 assets，于是你部署十次，手机上跑的还是第一次那个版本。
     * 版本号一变，浏览器才会装新 SW → 新版 skipWaiting + clients.claim →
     * 页面收到 controllerchange 自动 reload（见 main.tsx），一次打开就切过去。
     *
     * 注意 public/ 是构建结束后被原样拷进 dist 的，generateBundle 里看不到它，
     * 只能在 closeBundle 里改。
     */
    {
      name: "stamp-sw-version",
      apply: "build",
      closeBundle() {
        const file = path.resolve(__dirname, "dist/sw.js");
        const source = readFileSync(file, "utf8");
        const next = source.replace(/const VERSION = "[^"]*"/, `const VERSION = "pii-${BUILD}"`);
        if (next === source) this.warn("sw.js 里没找到 VERSION 常量，缓存不会随构建失效");
        writeFileSync(file, next);
      },
    },
  ],
  define: {
    __BUILD__: JSON.stringify(BUILD),
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
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // 前后端共享的类型/策略：真实目录在仓库根 shared/（Vite 不读 tsconfig 的 paths，必须在这也配一遍）
      "@shared": path.resolve(__dirname, "../shared"),
    },
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
