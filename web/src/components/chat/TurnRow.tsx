import type { Entry } from "@/lib/types";
import { stepsFromEntries } from "@/lib/process-steps";

import { EntryRow } from "./EntryRow";
import { ProcessRail } from "./ProcessRail";

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

/** 这一轮从提问到回答的总时长。 */
function turnDuration(turn: Turn): number | undefined {
  return turn.startAt !== undefined && turn.final?.at !== undefined
    ? Math.max(0, (turn.final.at as number) - turn.startAt)
    : undefined;
}

/**
 * 已完成的一轮：你的话 → （过程轨道）→ 最终回答。
 *
 * 过程默认收起，但**用户展开过的一轮不会自己收回去** —— 展开状态由上层
 * （Transcript）按轮 key 记住，运行中看着它长出来的那一轮，结束后还摊在那里。
 */
export function TurnRow({
  turn,
  onQuote,
  thinkingDurationMs,
  railOpen,
  onRailOpenChange,
}: {
  turn: Turn;
  onQuote?: (text: string) => void;
  thinkingDurationMs?: number;
  railOpen?: boolean;
  onRailOpenChange?: (open: boolean) => void;
}) {
  const durationMs = turnDuration(turn);
  const thinkingOverride =
    turn.final && thinkingDurationMs !== undefined
      ? { entryId: turn.final.id, ms: thinkingDurationMs }
      : undefined;
  const steps = stepsFromEntries(turn.process, thinkingOverride);

  return (
    <div className="space-y-4">
      {turn.user && <EntryRow entry={turn.user} onQuote={onQuote} />}

      {/* 空步骤时 rail 自己返回 null（思考被拆干净、只剩正文的情况） */}
      <ProcessRail
        steps={steps}
        durationMs={durationMs}
        open={railOpen}
        onOpenChange={onRailOpenChange}
      />

      {turn.final && (
        <EntryRow entry={turn.final} onQuote={onQuote} turnDurationMs={durationMs} />
      )}
    </div>
  );
}
