import { ChevronRight, Wrench } from "lucide-react";
import { useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Entry } from "@/lib/types";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

import { EntryRow } from "./EntryRow";

export interface Turn {
  /** 这一轮的 key（用第一条 entry 的 id） */
  key: number;
  /** 用户的那条消息 */
  user?: Entry;
  /** 过程中的 entry：思考、工具调用、工具结果、中间步骤的话 */
  process: Entry[];
  /** 最终回答（带正文、且是一轮里最后一条 assistant） */
  final?: Entry;
  startAt?: number;
  /** 这一轮的 entry 按原顺序（展开时照原样渲染） */
  entries: Entry[];
}

/**
 * 把线性的 entries 切成「一轮一轮」。
 *
 * 为什么需要：历史里一半以上是「思考 + 工具执行」，翻的时候满屏都是过程，
 * 真正的答案被埋掉了。按轮折叠之后，历史里只剩两行：你说的 → 它的回答，
 * 想看过程点开。
 */
export function groupTurns(entries: Entry[]): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    const isUser = entry.kind === "pi.user";
    if (isUser || turns.length === 0) {
      turns.push({
        key: entry.id,
        ...(isUser ? { user: entry } : {}),
        process: [],
        entries: [entry],
        startAt: entry.at,
      });
      continue;
    }
    turns[turns.length - 1]!.process.push(entry);
    turns[turns.length - 1]!.entries.push(entry);
  }

  // 每一轮里挑出「最终回答」：带正文的 assistant，且是该轮最后一条带正文的
  for (const turn of turns) {
    const candidates = turn.process.filter(
      (entry) =>
        entry.kind === "pi.assistant" &&
        entry.blocks.some((block) => block.type === "text" && block.text.trim().length > 0),
    );
    const final = candidates[candidates.length - 1];
    if (!final) continue;

    /*
     * 最终回答那条 entry 里通常也带 thinking。
     * 如果不拆开，界面上会同时出现「已完成 5m16s」和「思考 · 2439 字」两行，
     * 而用户要的是：**只留一个「已完成」，展开才看思考和工具**。
     *
     * 所以把 final 的 thinking 挪进 process，final 自己只留正文（和图片）。
     */
    const thinking = final.blocks.filter((block) => block.type === "thinking");
    const rest = final.blocks.filter((block) => block.type !== "thinking");
    if (thinking.length > 0) {
      turn.process = turn.process
        .filter((entry) => entry.id !== final.id)
        .concat({ ...final, blocks: thinking });
    } else {
      turn.process = turn.process.filter((entry) => entry.id !== final.id);
    }

    turn.final = { ...final, blocks: rest };
    turn.entries = turn.entries.filter((entry) => entry.id !== final.id).concat(turn.final);
  }

  return turns;
}

/** 折叠摘要：只要这一轮花了多久。 */
function summarize(turn: Turn): { chars: number; tools: number; durationMs?: number } {
  let chars = 0;
  let tools = 0;
  for (const entry of turn.process) {
    for (const block of entry.blocks) {
      if (block.type === "thinking") chars += block.text.length;
      if (block.type === "toolCall") tools += 1;
    }
  }
  const durationMs =
    turn.startAt !== undefined && turn.final?.at !== undefined
      ? Math.max(0, (turn.final.at as number) - turn.startAt)
      : undefined;
  return { chars, tools, durationMs };
}

/**
 * 已完成的一轮：你的话 → （折叠的过程）→ 最终回答。
 *
 * 折叠的判定很保守：只有「这一轮已经结束（后面还有别的轮）」才折。
 * 最后一轮永远展开 —— 那通常是你正在看的东西。
 */
export function TurnRow({
  turn,
  onQuote,
  thinkingDurationMs,
}: {
  turn: Turn;
  onQuote?: (text: string) => void;
  thinkingDurationMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const { durationMs } = summarize(turn);
  const hasProcess = turn.process.length > 0;

  return (
    <div className="space-y-4">
      {turn.user && <EntryRow entry={turn.user} onQuote={onQuote} />}

      {hasProcess && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className={cn(
                "group/process flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left",
                "text-[12px] text-muted-foreground transition-colors hover:text-foreground",
              )}
            >
              <ChevronRight
                className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
                aria-hidden
              />
              <Wrench className="size-3 shrink-0 opacity-60" aria-hidden />
              {/* 折叠时只说「已完成 + 用时」，细节点开再看 */}
              <span className="min-w-0 truncate">
                {durationMs !== undefined
                  ? `已完成 ${formatDuration(durationMs)}`
                  : `已完成 · ${turn.process.length} 步`}
              </span>
              <span className="ml-auto shrink-0 text-[11px] opacity-60">
                {open ? "收起" : "展开"}
              </span>
            </button>
          </CollapsibleTrigger>

          <CollapsibleContent className="mt-1 space-y-2 border-l border-border/60 pl-3">
            {turn.process
              // 展开后只留「思考 / 工具」：过程里夹着的中间正文（“我先看一下…”）
              // 对回看没有价值，翻起来还吵，直接剔掉。
              // thinking 必须留 —— 它就是“展开能看到的思考”。
              .map((entry) => {
                const blocks = entry.blocks.filter((block) => block.type !== "text");
                return blocks.length > 0 ? { ...entry, blocks } : null;
              })
              .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
              .map((entry) => (
                <EntryRow key={entry.id} entry={entry} onQuote={onQuote} />
              ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {turn.final && (
        <EntryRow
          entry={turn.final}
          onQuote={onQuote}
          turnDurationMs={durationMs}
          thinkingDurationMs={thinkingDurationMs}
        />
      )}
    </div>
  );
}
