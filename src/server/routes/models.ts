/**
 * 模型清单与切换（都按会话：会话 A 用强模型，会话 B 用快模型）。
 *
 * 纯搬迁：路由行为保持原样，依赖通过 AppContext 显式传入。
 */
import type { Hono } from "hono";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { parseConversationId } from "../conversations.ts";
import type { AppContext } from "../context.ts";

export function registerModels(app: Hono, ctx: AppContext): void {
  const { agent, resolveConversation } = ctx;

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
}
