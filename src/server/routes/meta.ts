/**
 * 模型清单、会话删除、优雅重启、构建信息、Web Push、客户端指标。
 *
 * 纯搬迁：路由行为保持原样，依赖通过 AppContext 显式传入。
 */
import type { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { parseConversationId } from "../conversations.ts";
import { purgeConversations } from "../trash.ts";
import type { AppContext } from "../context.ts";

export function registerMeta(app: Hono, ctx: AppContext): void {
  const { dataDir, policies, lastConversation, watching, titles, customTitles, trash, push, agent, startedAt, newestMtime, serverDir, clientMetrics, flags, resolveConversation, isIdle, shutdown, webDist: WEB_DIST } = ctx;


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

/** 可选模型清单（来自 ~/.pi/agent/models.json）+ 当前会话用的那个。 */
app.get("/api/models", async (c) => {
  const conversation = await resolveConversation(parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  const resolved = await conversation.agent(BACKGROUND_CONTEXT);
  const models = agent.models.getModels().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    // 能不能看图，决定前端要不要禁用“上传图片”
    image: model.input?.includes("image") ?? false,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
  }));

  return c.json({
    models,
    current: resolved.model ?? null,
    // 这个会话最后一次跑用了多少上下文，前端可以拿来和 contextWindow 比
    conversationId: Number(conversation.id),
  });
});

/** 切换当前会话的模型。只影响这一个会话，不碰别的。 */
app.post("/api/model", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    provider?: string;
    modelId?: string;
    conversationId?: number;
  };
  if (typeof body.provider !== "string" || typeof body.modelId !== "string") {
    return c.json({ error: "provider 和 modelId 必填" }, 400);
  }
  if (!agent.models.getModel(body.provider, body.modelId)) {
    return c.json({ error: `找不到模型 ${body.provider}/${body.modelId}` }, 404);
  }

  const conversation = await resolveConversation(body.conversationId ?? parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  await conversation.configure(
    { model: { provider: body.provider, modelId: body.modelId } },
    BACKGROUND_CONTEXT,
  );
  return c.json({ ok: true, provider: body.provider, modelId: body.modelId });
});

/** 删除会话：先藏起来（立刻生效），再尽量当场把行删干净。 */
app.delete("/api/conversations/:id", async (c) => {
  const id = parseConversationId(c.req.param("id"));
  if (id === undefined) return c.json({ error: "id 不合法" }, 400);
  if (id === Number(agent.root.id)) return c.json({ error: "root 会话不能删" }, 400);
  if (watching.get(id)) return c.json({ error: "先切到别的会话再删（这个还开着）" }, 409);

  // 有活没干完就别删，否则任务会往一个不存在的会话里写
  const inspection = await agent.harness.inspect(BACKGROUND_CONTEXT);
  if (inspection.submissions.some((item) => Number(item.conversationId) === id)) {
    return c.json({ error: "这个会话还有没跑完的任务，等它结束再删" }, 409);
  }

  trash.hide(id);
  const result = purgeConversations({
    dbPath: join(dataDir, "agent.sqlite"),
    ids: [id],
  });
  if (result.deleted.length > 0) trash.forget(result.deleted);
  titles.delete(id);
  customTitles.forget(id);
  policies.forget(id);
  lastConversation.forget(id);

  return c.json({ ok: true, deletedRows: result.deleted.length > 0 });
});

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
    console.log("\n收到重启请求（force），立刻重启…");
    setTimeout(() => void shutdown("restart"), 200);
    return c.json({ ok: true, state: "restarting-now" });
  }

  flags.restartPending = true;
  console.log("\n收到重启请求，等空闲后重启…");

  void (async () => {
    // 最多等 10 分钟，超时也重启（否则一个卡住的任务能把这个标记带一辈子）
    for (let i = 0; i < 600; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        if (await isIdle()) {
          console.log("已空闲，重启中…");
          await shutdown("restart");
          return;
        }
      } catch {
        /* 读失败就当还在忙 */
      }
    }
    console.log("等空闲超时，强制重启…");
    await shutdown("restart");
  })();

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


/** 推送公钥：浏览器订阅时要把它当 `applicationServerKey`。 */
app.get("/api/push/key", (c) => c.json({ publicKey: push.publicKey, enabled: push.enabled }));

/** 订阅（同一个 endpoint 重复订阅只更新，浏览器每次加载都可能重新订阅）。 */
app.post("/api/push/subscribe", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    endpoint?: unknown;
    keys?: unknown;
    conversationId?: number;
  };
  const conversationId = body.conversationId ?? parseConversationId(c.req.query("c"));
  if (!push.subscribe(body, conversationId)) return c.json({ error: "订阅格式不对" }, 400);
  return c.json({ ok: true, subscriptions: push.list().length });
});

app.post("/api/push/unsubscribe", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
  if (typeof body.endpoint !== "string") return c.json({ error: "endpoint 必填" }, 400);
  return c.json({ ok: push.unsubscribe(body.endpoint), subscriptions: push.list().length });
});

/** 自测用：立刻推一条，不用等模型跑完。 */
app.post("/api/push/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { conversationId?: number };
  const conversationId = body.conversationId ?? parseConversationId(c.req.query("c"));
  const result = await push.notify({
    title: titles.get(conversationId ?? -1) ?? "pii · 测试通知",
    body: "这是一条测试推送。",
    conversationId,
    tag: "test",
  });
  return c.json(result);
});
}
