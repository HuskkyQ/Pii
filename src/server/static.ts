/**
 * 页面与静态资源托管。
 *
 * 这些路径原本散在 main.ts 里（Hono 顺手兼的「发菜单」活）：
 *   /                index.html（no-cache，否则 PWA 一直加载旧版 JS）
 *   /assets/*        带内容指纹，可 immutable 长缓存
 *   /icons/*         一周
 *   /sw.js、/manifest  no-cache + Service-Worker-Allowed
 *
 * 末尾的 app.use("*", serveStatic) 兜底**不在这里**：它必须最后注册，
 * 由 main.ts 统一控制顺序（见设计文档第 4 节）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

import { PAGE } from "./page.ts";
import type { AppContext } from "./context.ts";

export function registerStatic(app: Hono, ctx: AppContext): void {
  const { webDist: WEB_DIST } = ctx;

app.get("/", (c) => {
  // 构建过就托管 React；否则退回阶段 2 的测试页。
  // 必须 no-cache：index.html 里引用的是带指纹的 assets，
  // 一旦它被浏览器缓存，PWA 会一直加载上一版 JS（改了永远看不到效果）。
  c.header("Cache-Control", "no-cache, must-revalidate");
  const indexPath = join(WEB_DIST, "index.html");
  if (existsSync(indexPath)) return c.html(readFileSync(indexPath, "utf8"));
  return c.html(PAGE);
});

/*
 * 静态资源（web/dist/assets）。文件名带内容指纹，可以放心 immutable 长缓存。
 *
 * 之前这里没有 cache-control：每次冷启动浏览器都要重新验证那个 600KB 的 JS 包，
 * 走 Funnel（境外入口，RTT 几百毫秒）时，这就是「白屏三四秒」的主要来源。
 */
app.use("/assets/*", async (c, next) => {
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  return next();
});
app.use("/assets/*", serveStatic({ root: WEB_DIST, rewriteRequestPath: (path) => path }));
app.get("/index.html", serveStatic({ root: WEB_DIST }));

// PWA 文件：不让浏览器缓存，否则改了不生效
app.use("/icons/*", async (c, next) => {
  c.header("Cache-Control", "public, max-age=604800");
  return next();
});

for (const file of ["/sw.js", "/manifest.webmanifest"]) {
  app.get(file, (c, next) => {
    c.header("Cache-Control", "no-cache");
    if (file === "/sw.js") c.header("Service-Worker-Allowed", "/");
    return next();
  });
}
}
