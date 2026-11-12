import type { LiveView } from "@/lib/types";

import { Markdown } from "./Markdown";

/**
 * 正在流式输出的**最终正文**。
 *
 * 思考 / 工具执行 / 过程性正文已经搬到 `ProcessRail` 的实时模式里了；
 * 这里只剩一件事：把还在写的答案显示出来，末尾带一个光标。
 *
 * 为什么拆开：以前这一行同时要管「状态行」和「正文」，一旦同时有正文和工具调用
 * 就得靠 `isAnswer` / `isPreamble` 两套判定互相让位，越改越绕。
 */
export function liveAnswerText(live: LiveView): string | null {
  const blocks = live.message?.blocks ?? [];
  const text = blocks
    .filter((block) => block.type === "text" && block.text.trim().length > 0)
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
  if (!text) return null;
  // 带工具调用的正文是「动手前说的话」，属于过程，不算答案
  const hasToolCall = blocks.some((block) => block.type === "toolCall");
  return hasToolCall ? null : text;
}

export function LiveRow({ live }: { live: LiveView }) {
  const text = liveAnswerText(live);
  if (!text) return null;

  return (
    <div className="flex items-start gap-1 text-foreground">
      <div className="min-w-0 flex-1 space-y-1">
        <Markdown text={text} />
        {/* 流式正文末尾的小光标：让它看起来“还在写” */}
        <span
          className="inline-block h-3.5 w-[2px] animate-pulse rounded-full bg-foreground/60 align-middle"
          aria-hidden
        />
      </div>
    </div>
  );
}
