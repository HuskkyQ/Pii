/**
 * 发消息、中断、SSE 流与工具审批。
 *
 * 纯搬迁：路由行为保持原样，依赖通过 AppContext 显式传入。
 */
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { streamSSE } from "hono/streaming";
import { parseConversationId } from "../conversations.ts";
import { projectView, type Snapshot } from "../project.ts";
import type { ApprovalRequest } from "../approvals.ts";
import type { AppContext } from "../context.ts";

export function registerRun(app: Hono, ctx: AppContext): void {
  const { approvals, watch, windowOptions, resolveConversation, viewWindow: VIEW_WINDOW } = ctx;

/** SSE：完整视图 + 审批事件。同样用 `?c=<id>` 选会话。 */
app.get("/api/stream", async (c) => {
  const conversationId = parseConversationId(c.req.query("c"));
  const conversation = await resolveConversation(conversationId);
  if (!conversation) return c.json({ error: "会话不存在" }, 404);
  const scope = Number(conversation.id);

  return streamSSE(c, async (stream) => {
    const view = await conversation.watch(BACKGROUND_CONTEXT, VIEW_WINDOW);
    let closed = false;
    watch(scope, 1);

    const emit = (event: string, data: unknown) => {
      if (closed) return;
      void Promise.resolve()
        .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
        .catch(() => {
          closed = true;
        });
    };

    /*
     * 快照推送要节流。
     *
     * pi-durable 的纪律是「快照是账单」——每次状态变化都推一份完整视图，
     * 生成过程中 progress commit 很密（每个新字都可能提交一次），
     * 于是 2MB 的快照一秒能推好几次，手机上就是一直转圈。
     *
     * 做法：最多每 100ms 推一帧，中间的合并成最后一帧（trailing edge）。
     * 丢中间的帧不会丢信息 —— 因为下一帧是完整快照，不是增量。
     */
    let pending: Snapshot | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      timer = undefined;
      if (!pending) return;
      const next = pending;
      pending = null;
      emit("state", next);
    };

    const pushSnapshot = (snapshot: Snapshot) => {
      const waiting = timer !== undefined;
      pending = snapshot;
      if (waiting) return; // 已经在队列里了，等它到点一起发
      timer = setTimeout(flush, 100);
      timer.unref?.();
    };

    {
      // `value` 在 start 之前就是「挂载那一刻的视图」，正好当首帧。
      const options = windowOptions({ turns: c.req.query("turns") });
      pushSnapshot(projectView(view.value, options));
    }

    // 重连时把仍挂起的审批补发一次，否则新开的标签页看不到它们；
    // 只补发本会话的 —— 别的会话的审批不该弹在你脸上。
    for (const request of approvals.list(scope)) emit("approval", request);

    const streamOptions = windowOptions({ turns: c.req.query("turns") });
    // 1.5.x 的 watch：start 之后每次视图变化推一次 `{ kind: "value", value }`；
    // 视图自身出错推 `{ kind: "failed", error }` —— 这里不动，等下一次提交或客户端重连恢复。
    view.start(async (call) => {
      if (call.kind === "failed") return;
      pushSnapshot(projectView(call.value, streamOptions));
    });
    const offRequest = approvals.onRequest((request: ApprovalRequest) => {
      if (request.conversationId === scope) emit("approval", request);
    });
    const offOutcome = approvals.onOutcome((outcome) => emit("approval-resolved", outcome));

    // 心跳，防代理超时断开
    const heartbeat = setInterval(() => emit("ping", Date.now()), 15_000);
    heartbeat.unref?.();

    // 关键：handler 不能提前 return，否则 Hono 会关掉这条流。
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        closed = true;
        watch(scope, -1);
        if (timer) clearTimeout(timer);
        clearInterval(heartbeat);
        void view.stop();
        offRequest();
        offOutcome();
        resolve();
      });
    });
  });
});

/** 当前挂起的审批。`?c=<id>` 只看那个会话的。 */
app.get("/api/approvals", (c) =>
  c.json({ approvals: approvals.list(parseConversationId(c.req.query("c"))) }),
);

/** 回答一个审批。 */
app.post("/api/approve", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: string; allow?: boolean };
  if (typeof body.id !== "string") return c.json({ error: "id 必填" }, 400);
  const ok = approvals.settle(body.id, body.allow === true);
  if (!ok) return c.json({ error: "该审批已失效（超时、已答过或服务重启）" }, 409);
  return c.json({ ok: true });
});

/** 发消息。requestId 让重试变成幂等（崩溃后重发不会问两遍）。 */
app.post("/api/prompt", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    text?: string;
    requestId?: string;
    conversationId?: number;
    images?: { mimeType?: unknown; data?: unknown }[];
    /** 忙时如何入队：followUp=排队等下一轮（默认）；steer=插队/引导当前回合 */
    mode?: "steer" | "followUp";
  };
  const text = typeof body.text === "string" ? body.text.trim() : "";

  // 图片走 base64（<img> 里能直接显示，模型也能直接吃）。
  // 上限压得比较紧：单张 6MB、最多 4 张 —— base64 会膨胀 4/3，再大就把请求撑爆了。
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter(
      (image): image is { mimeType: string; data: string } =>
        typeof image?.mimeType === "string" &&
        image.mimeType.startsWith("image/") &&
        typeof image?.data === "string" &&
        image.data.length > 0 &&
        image.data.length < 6_000_000,
    )
    .slice(0, 4);

  if (!text && images.length === 0) return c.json({ error: "text 和 images 至少给一个" }, 400);

  const id = body.conversationId ?? parseConversationId(c.req.query("c"));
  const conversation = await resolveConversation(id);
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  const requestId = body.requestId ?? randomUUID();
  const whenBusy = body.mode === "steer" || body.mode === "followUp" ? body.mode : undefined;
  // 只有图片没文字时也要有一段 text，否则有些模型会拒（空 content）
  const content =
    images.length === 0
      ? text
      : [
          { type: "text" as const, text: text || "(图片)" },
          ...images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ];

  const submission = await conversation.submit(
    { type: "input", content, requestId, ...(whenBusy ? { whenBusy } : {}) } as never,
    BACKGROUND_CONTEXT,
  );

  return c.json({ requestId, submissionId: submission.id, conversationId: Number(conversation.id), mode: whenBusy });
});

/** 中断当前会话的运行。 */
app.post("/api/abort", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { conversationId?: number };
  const id = body.conversationId ?? parseConversationId(c.req.query("c"));
  const conversation = await resolveConversation(id);
  if (!conversation) return c.json({ error: "会话不存在" }, 404);
  await conversation.abort(BACKGROUND_CONTEXT);
  return c.json({ ok: true, conversationId: Number(conversation.id) });
});
}
