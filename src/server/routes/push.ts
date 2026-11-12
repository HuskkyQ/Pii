/**
 * Web Push 的 HTTP 端点：公钥 / 订阅 / 退订 / 自测。
 *
 * 实现（VAPID 密钥、订阅表、发送与剪枝）在 `src/server/push.ts`；
 * 这里只做「请求 → 方法」的翻译，不碰推送细节。
 */
import type { Hono } from "hono";
import { parseConversationId } from "../conversations.ts";
import type { AppContext } from "../context.ts";

export function registerPush(app: Hono, ctx: AppContext): void {
  const { titles, push } = ctx;

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
