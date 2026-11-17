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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

import { PAGE } from "./page.ts";
import type { AppContext } from "./context.ts";

/** 预览路径的结局：给出真实文件路径，或者给出该回的状态码。 */
export type PreviewTarget =
  | { ok: true; file: string; directory: boolean }
  | { ok: false; status: 400 | 404 };

/**
 * `/preview/<项目>/<rest>` → `<root>/<项目>/public/<rest>`。
 *
 * 这是静态预览**唯一的一道权限闸**，三件事：
 *  1. 项目名只允许 `[A-Za-z0-9][A-Za-z0-9._-]*`，且每一段路径都不能以 `.` 开头
 *     —— `.env`、`.git/config` 这类文件一律不服务；
 *  2. 任何一段带 `..` 都拒绝（URL 解码之后再看，`%2e%2e` 也挡）；
 *  3. realpath 之后必须仍在 `<root>/<项目>/public` 里 —— 挡符号链接逃逸。
 *
 * 为什么根目录缩到项目里的 `public/`：项目根还躺着 `.env`、`.git`、数据库，
 * 没必要为了让页面能访问就把整棵树的读权限交出去。
 */
export function previewTarget(root: string, requestPath: string): PreviewTarget {
  if (!requestPath.startsWith("/preview/")) return { ok: false, status: 400 };

  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return { ok: false, status: 400 };
  }
  if (decoded.includes("\0")) return { ok: false, status: 400 };

  const parts = decoded.slice("/preview/".length).split("/").filter(Boolean);
  const project = parts[0];
  if (project === undefined) return { ok: false, status: 404 };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) return { ok: false, status: 404 };

  const rest = parts.slice(1);
  if (rest.some((part) => part.startsWith(".") || part.includes(".."))) {
    return { ok: false, status: 404 };
  }

  const base = join(root, project, "public");
  const file = join(base, ...rest);

  let realBase = base;
  let real = file;
  try {
    if (existsSync(base)) realBase = realpathSync(base);
    if (existsSync(file)) real = realpathSync(file);
  } catch {
    return { ok: false, status: 404 };
  }
  if (real !== realBase && !real.startsWith(realBase + sep)) return { ok: false, status: 404 };

  return { ok: true, file, directory: rest.length === 0 };
}

export function registerStatic(app: Hono, ctx: AppContext): void {
  const { webDist: WEB_DIST } = ctx;

  /*
   * 静态预览：`/preview/<项目>/...` 只读暴露 `<previewRoot>/<项目>/public/`。
   *
   * 为什么放在应用里而不是 Caddy：鉴权中间件在所有业务路由之前注册，
   * 这条路由自动继承登录；Caddy 的 file_server 反而会绕过 pii 的登录。
   */
  const previewRoot = ctx.previewRoot;
  app.use("/preview/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("只读", 405);
    const target = previewTarget(previewRoot, new URL(c.req.url).pathname);
    if (!target.ok) return c.text(target.status === 400 ? "bad path" : "not found", target.status);
    c.header("Cache-Control", "no-cache"); // 产物随时会变，别让浏览器记住旧版
    return next();
  });
  app.use(
    "/preview/*",
    serveStatic({
      root: previewRoot,
      /* serveStatic 要的是「相对 root 的路径」：demo/public/index.html */
      rewriteRequestPath: (path) => {
        const target = previewTarget(previewRoot, path);
        if (!target.ok) return path;
        const rel = relative(previewRoot, target.file).split(sep).join("/");
        return `/${rel}${target.directory ? "/" : ""}`;
      },
    }),
  );

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
