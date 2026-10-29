/**
 * 把「跑完了」这件事接到推送中心。
 *
 * 为什么用 `onYield`：它是 pi-durable 对「这一轮给了最终回答」的官方钩子，
 * 比在服务端盯着快照变化判断「有没有新 assistant 条目」稳得多 ——
 * 钩子只在该触发的时候触发一次，不用自己定义什么叫「跑完了」。
 */
import { GenerationTask, defineExtension, hook } from "@earendil-works/pi-durable";

import type { PushHub } from "../server/push.ts";

/** AssistantMessage → 纯文本摘要（去掉 thinking 和 toolCall，那两个不适合进通知）。 */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join(" ").trim();
}

export interface NotifyOptions {
  /** 会话标题（缓存里拿；拿不到就退回 pii） */
  titleOf: (conversationId: number) => string | undefined;
}

export function notifyExtension(push: PushHub, options: NotifyOptions) {
  return defineExtension({
    name: "pii-push",
    hooks: [
      hook(GenerationTask, {
        async onYield(answer, api) {
          const conversationId = Number(api.conversationId);
          const text = textOf(answer);
          const title = options.titleOf(conversationId) ?? "pii";
          void push.notify({
            title,
            body: text.slice(0, 120) || "回答完成",
            conversationId,
            tag: `answer-${conversationId}`,
          });
          // 返回 undefined = 不改写这次 yield（不动 pi-durable 的流程）
          return undefined;
        },
      }),
    ],
  });
}
