/**
 * 运维端点：客户端指标上报、优雅重启、构建信息。
 *
 * `/api/restart` 的灵魂是 `ctx.flags.restartPending` —— 它是**对象字段**，
 * 必须走 `flags.xxx` 读写。解构成 boolean 再赋值会让去重判断失效（会重复排 600 轮）。
 */
import type { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../context.ts";

export function registerOps(app: Hono, ctx: AppContext): void {
  const { clientMetrics, flags, shutdown, newestMtime, serverDir, startedAt, webDist: WEB_DIST } = ctx;

/**
 * 客户端自报尺寸。真机布局问题（安全区、视口高度）在 headless 里量不到，
 * 所以让页面自己把数字发过来：`GET /api/client-metrics` 就能看到。
 * 只保留最近 20 条，纯内存，不落库。
 */

app.post("/api/client-metrics", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const entry = { ...body, at: new Date().toISOString() };
  clientMetrics.push(entry);
  if (clientMetrics.length > 20) clientMetrics.shift();
  console.log("  [client]", JSON.stringify(entry));
  return c.json({ ok: true });
});

app.get("/api/client-metrics", (c) => c.json({ metrics: clientMetrics }));

/**
 * 重启服务（改完服务端代码后用）。
 *
 * 为什么不当场 exit：
 *   你现在这条对话就跑在这个进程里。立刻退出 = 把正在生成的回答腰斩，
 *   重启后 pi-durable 会从 checkpoint 续跑，可能把「重启」这条命令再执行一遍 —— 变成重启环。
 *
 * 所以：先挂个标记，等**所有会话都空闲**了再退。回答写完了、没有排队提交了，才真正重启。
 * 退出码 0 也会被 launchd 的 KeepAlive 拉起来（我们配的就是无条件重启）。
 */

app.post("/api/restart", async (c) => {
  const force = new URL(c.req.url).searchParams.get("force") === "1";

  if (flags.restartPending) return c.json({ ok: true, state: "already-pending" });

  if (force) {
    // 等 200ms 是为了让这个响应先写出去，否则浏览器拿到的是连接被重置
    setTimeout(() => void shutdown("restart", { waitForIdleMs: 0 }), 200);
    return c.json({ ok: true, state: "restarting-now" });
  }

  flags.restartPending = true;
  console.log("\n收到重启请求，等空闲后重启…");

  // 等空闲的逻辑在 ctx.shutdown 里，和 SIGTERM 共用一份（以前这里是另一份手写循环）。
  // 最多等 10 分钟，超时也重启 —— 否则一个卡住的任务能把这个标记带一辈子。
  void shutdown("restart", { waitForIdleMs: 10 * 60_000 });

  return c.json({ ok: true, state: "waiting-for-idle" });
});

/** 运行中的这版代码是什么时候改的（用来判断“要不要重启才生效”）。 */
app.get("/api/build", (c) => {
  const stamp = newestMtime(serverDir);

  // 前端资源指纹 + service worker 版本：排查「手机上是不是旧版」时一眼能看出来
  let assets: string[] = [];
  try {
    assets = readdirSync(join(WEB_DIST, "assets")).sort();
  } catch {
    /* 还没构建 */
  }
  let swVersion = "";
  try {
    swVersion = /VERSION = "([^"]+)"/.exec(readFileSync(join(WEB_DIST, "sw.js"), "utf8"))?.[1] ?? "";
  } catch {
    /* 同上 */
  }

  return c.json({
    runningSince: startedAt,
    newestSourceMtime: stamp,
    behind: stamp > startedAt,
    assets,
    swVersion,
  });
});
}
