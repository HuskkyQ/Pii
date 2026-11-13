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
import { createContext, type AppContext } from "./context.ts";
import { registerAuth } from "./auth-routes.ts";
import { registerStatic } from "./static.ts";
import { registerArchive } from "./routes/archive.ts";
import { registerMemory } from "./routes/memory.ts";
import { registerModels } from "./routes/models.ts";
import { registerOps } from "./routes/ops.ts";
import { registerPush } from "./routes/push.ts";
import { registerRun } from "./routes/run.ts";
import { registerSession } from "./routes/session.ts";
import { registerWorkspace } from "./routes/workspace.ts";

const config = loadConfig();
const port = config.port;
const host = config.host;

/**
 * 兜底：没人 await 的 Promise 拒绝，以及漏网的同步异常。
 *
 * 必须**在 createContext 之前**注册：启动期最容易出事（模型清单缺了、数据目录不可写），
 * 而那时候后面的处理器还没挂上 —— 只能看 Node 默认反应（打一行日志 / 直接崩），
 * 进程可能正握着 SQLite 和进程锁，崩完留下「锁还在、库半开」的现场。
 * `waitForIdleMs: 0`：已经抛未捕获异常了，不该再为等任务拖时间；退出码 1 表示「不是我要退的」。
 */
let ctxRef: AppContext | null = null;
function fatal(kind: string, error: unknown): void {
  console.error(`\n[${kind}]`, error);
  if (!ctxRef) {
    // 启动期失败：锁可能建了一半，acquireLock 自带「pid 已死就覆盖」的兜底，直接非 0 退出即可
    process.exit(1);
  }
  void ctxRef.shutdown(kind, { waitForIdleMs: 0, exitCode: 1 });
}
process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason));
process.on("uncaughtException", (error) => fatal("uncaughtException", error));

const ctx = await createContext();
ctxRef = ctx;
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
registerMemory(app, ctx);
registerSession(app, ctx);
registerRun(app, ctx);

// 其他静态文件（图标、favicon…）兜底。
app.use("*", serveStatic({ root: ctx.webDist }));

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`\n  打开 http://${host}:${info.port}\n`);
});
ctx.attachServer(server);

/*
 * 关停：`docker stop` 默认就发 SIGTERM，这里走的是和 /api/restart 完全相同的
 * 那条路径（先等空闲、再给已有连接收尾、最后关库删锁），不再是「收到信号就 exit」。
 * 三个数字要对齐编排：config.shutdownIdleMs + shutdownGraceMs 必须小于
 * compose 里的 stop_grace_period，否则 docker 会在我们收尾时直接 SIGKILL。
 *
 * 再按一次 Ctrl+C = 立刻退出。等空闲最多 PII_SHUTDOWN_IDLE_MS，但人总有急着走的时候。
 */
let signalCount = 0;
function handleSignal(signal: "SIGINT" | "SIGTERM"): void {
  signalCount += 1;
  if (signalCount > 1) {
    console.log(`\n再收到 ${signal}，立刻退出`);
    process.exit(130);
  }
  if (signal === "SIGINT") console.log("  （再按一次 Ctrl+C 立刻退出）");
  void ctx.shutdown(signal);
}
process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

