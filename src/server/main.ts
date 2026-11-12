/**
 * pii 服务端入口：HTTP + SSE。
 *
 * 这个文件只负责「开机」：创建共享状态、按固定顺序装配路由、监听端口、优雅退出。
 * 具体路由在 routes/ 下，共享状态在 context.ts 里。
 *
 * 注册顺序是本文件唯一的、也是最重要的职责 —— 见
 * docs/superpowers/specs/2026-11-11-server-main-refactor-design.md 第 4 节。
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { compress } from "hono/compress";

import { loadConfig } from "../config.ts";
import { createContext } from "./context.ts";
import { registerAuth } from "./auth-routes.ts";
import { registerStatic } from "./static.ts";
import { registerArchive } from "./routes/archive.ts";
import { registerModels } from "./routes/models.ts";
import { registerOps } from "./routes/ops.ts";
import { registerPush } from "./routes/push.ts";
import { registerRun } from "./routes/run.ts";
import { registerSession } from "./routes/session.ts";
import { registerWorkspace } from "./routes/workspace.ts";

const config = loadConfig();
const port = config.port;
const host = config.host;

const ctx = await createContext();
const app = new Hono();

/*
 * gzip 压缩。为什么这条最值：快照是 JSON + 大量中文，
 * 压缩率能到 10 倍左右（2.4MB → 200～300KB），手机走公网时差别非常明显。
 * hono 的 compress 会自动跳过 text/event-stream，不会把 SSE 憋住。
 */
app.use(compress());

/**
 * 注册顺序（三条铁律）：
 *   ① compress 最前；② 鉴权中间件必须在所有业务路由之前；
 *   ③ 业务路由顺序无关（路径不重叠）；④ 页面与静态资源；
 *   ⑤ app.use("*") 兜底必须最后，否则 /api/* 会被它先吃掉。
 * 静态兜底只能在本文件注册；鉴权中间件是唯一例外，随 registerAuth 注册、
 * 位置固定在前。routes/ 下不得自行 listen 或注册兜底。
 */
if (ctx.auth.enabled) registerAuth(app, ctx);
registerStatic(app, ctx);
// 业务路由：顺序无关（路径不重叠），位置固定在其余位置 —— 见上面的铁律 ③
registerOps(app, ctx);
registerModels(app, ctx);
registerPush(app, ctx);
registerWorkspace(app, ctx);
registerArchive(app, ctx);
registerSession(app, ctx);
registerRun(app, ctx);

// 其他静态文件（图标、favicon…）兜底。
app.use("*", serveStatic({ root: ctx.webDist }));

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`\n  打开 http://${host}:${info.port}\n`);
});
ctx.attachServer(server);

// /api/restart 走的是同一个 ctx.shutdown，保证「等空闲再退」和信号处理行为一致。
process.on("SIGINT", () => void ctx.shutdown("SIGINT"));
process.on("SIGTERM", () => void ctx.shutdown("SIGTERM"));
