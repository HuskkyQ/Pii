/**
 * 会话快照、列表、新建、删除、审批策略、改名、上次会话。
 *
 * 纯搬迁：路由行为保持原样，依赖通过 AppContext 显式传入。
 */
import type { Hono } from "hono";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createConversation, listConversations, parseConversationId, titleOf } from "../conversations.ts";
import { normalizePolicy, presetOf } from "../policies.ts";
import { projectView } from "../project.ts";
import { TITLE_MAX } from "../titles.ts";
import { purgeConversations } from "../trash.ts";
import type { AppContext } from "../context.ts";

export function registerSession(app: Hono, ctx: AppContext): void {
  const { dataDir, policies, lastConversation, watch, watching, titles, customTitles, trash, agent, latestFailure, windowOptions, resolveConversation, viewWindow: VIEW_WINDOW } = ctx;

/** 权威快照。`?c=<id>` 选会话，不传就是 root；`?before=&limit=` 往前翻页。 */
app.get("/api/state", async (c) => {
  const conversation = await resolveConversation(parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);
  const watch_ = await conversation.watch(BACKGROUND_CONTEXT, VIEW_WINDOW);
  const value = watch_.value;
  await watch_.stop();
  const snapshot = projectView(
    value,
    windowOptions({
      turns: c.req.query("turns"),
      limit: c.req.query("limit"),
      before: c.req.query("before"),
    }),
  );
  // 只有在「没在跑」的时候才报失败，否则生成中也会看到上一条旧错误
  const live = (snapshot.live as { phase?: string } | null) ?? null;
  if (!live?.phase) {
    const failure = latestFailure(snapshot.conversationId);
    if (failure) snapshot.runError = failure;
  }
  return c.json(snapshot);
});

/** 会话列表：最新在前，标题优先用自定义，否则来自第一条用户消息。 */
app.get("/api/conversations", async (c) => {
  const conversations = await listConversations(
    agent,
    50,
    (id) => trash.has(id),
    (id) => customTitles.get(id),
  );
  // 顺手把标题记下来：审批推送需要标题，但它不能为了标题再扫一次 entries
  for (const item of conversations) titles.set(item.id, item.title);
  return c.json({ conversations });
});

/** 新建一个会话，返回它的 id 和标题。 */
app.post("/api/conversations", async (c) => {
  const conversation = await createConversation(agent);
  titles.set(Number(conversation.id), "新对话");
  return c.json({ id: Number(conversation.id), title: "新对话" });
});

/**
 * 当前会话的工具审批策略。
 * 返回该会话的有效策略（存过就用存的，否则用默认）及其对应的预设档位。
 */
app.get("/api/policy", async (c) => {
  const conversation = await resolveConversation(parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);
  const id = Number(conversation.id);
  const policy = policies.effective(id);
  return c.json({ conversationId: id, policy, preset: presetOf(policy) });
});

/**
 * 改当前会话的工具审批策略。
 * body.policy = { auto: { read, write, edit, bash }, allowUnknown }。
 * 只影响这一个会话，不碰别的。
 */
app.post("/api/policy", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { policy?: unknown; conversationId?: number };
  const conversation = await resolveConversation(body.conversationId ?? parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  const policy = normalizePolicy(body.policy);
  if (!policy) return c.json({ error: "policy 格式不对" }, 400);

  const id = Number(conversation.id);
  policies.set(id, policy);
  return c.json({ ok: true, conversationId: id, policy, preset: presetOf(policy) });
});

/** 上次在看的会话（前端 localStorage 的兜底）。 */
app.get("/api/last-conversation", (c) => c.json({ conversationId: lastConversation.get() }));

/** 记下当前在看的会话。先校验存在（被删的一律当不存在）。 */
app.post("/api/last-conversation", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { conversationId?: unknown };
  const id = typeof body.conversationId === "number" ? body.conversationId : undefined;
  if (id === undefined) return c.json({ error: "conversationId 必填" }, 400);
  const conversation = await resolveConversation(id);
  if (!conversation) return c.json({ error: "会话不存在" }, 404);
  const realId = Number(conversation.id);
  lastConversation.set(realId);
  return c.json({ ok: true, conversationId: realId });
});

/**
 * 重命名会话。
 * body.title 为字符串；传空串（或全空白）表示「恢复自动标题」（清掉自定义值）。
 * root 会话也允许改名 —— 它本来就有标题，改个名无副作用。
 */
app.patch("/api/conversations/:id", async (c) => {
  const id = parseConversationId(c.req.param("id"));
  if (id === undefined) return c.json({ error: "id 不合法" }, 400);

  const conversation = await resolveConversation(id);
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
  if (typeof body.title !== "string") return c.json({ error: "title 必填" }, 400);

  const title = body.title.replace(/\s+/g, " ").trim();
  if (title.length > TITLE_MAX) return c.json({ error: `标题太长（最多 ${TITLE_MAX} 字）` }, 400);

  // 空 → 恢复自动；非空 → 存自定义。set 内部会自己规范化并落盘。
  customTitles.set(id, title);
  // 重新算一次有效标题（清空时要回退到从内容推），顺手更新推送缓存
  const effective = title || (await titleOf(conversation));
  titles.set(id, effective);

  return c.json({ ok: true, id, title: effective, custom: Boolean(title) });
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
}
