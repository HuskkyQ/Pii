import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { Entry, LiveView, Snapshot } from "@/lib/types";
import { DIVIDER_GAP, formatDivider } from "@/lib/time";

import { EntryRow } from "./EntryRow";
import { LiveRow } from "./LiveRow";
import { TranscriptSkeleton } from "./TranscriptSkeleton";
import { TurnRow, groupTurns } from "./TurnRow";

/** 当前处于哪种实时状态（与 LiveRow 的判定一致）。 */
function liveKind(live: LiveView | null): "thinking" | "working" | "text" | null {
  if (!live) return null;
  const blocks = live.message?.blocks ?? [];
  const hasText = blocks.some((block) => block.type === "text" && block.text.trim().length > 0);
  if (hasText) return "text";
  const hasToolCall = blocks.some((block) => block.type === "toolCall");
  return live.phase === "tools" || hasToolCall ? "working" : "thinking";
}

/** 离顶部多近就开始抓下一页（px） */
const LOAD_AHEAD = 320;

/**
 * 消息区。
 *
 * 三个性能相关的设计：
 *  1. **骨架**：快照没到之前不显示空白，直接上骨架（避免白屏跳变）
 *  2. **虚拟窗口**：服务端只发最近 N 条，往上滑到接近顶部就自动取下一页
 *  3. **按轮折叠**：已经结束的回合只留「你的话 + 最终回答」，过程（思考/工具）折起来
 *
 * 只在「用户已经在底部」时自动跟随，向上翻历史时不打断阅读。
 */
export function Transcript({
  snapshot,
  older = [],
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  onQuote,
}: {
  snapshot: Snapshot | null;
  /** 往前翻出来的历史（拼在快照窗口前面） */
  older?: Entry[];
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  onQuote?: (text: string) => void;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLElement | null>(null);
  const stick = useRef(true);
  /** 翻页插入后要补的滚动量（保持视觉位置不跳） */
  const adjust = useRef<number | null>(null);
  const [atTop, setAtTop] = useState(false);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [snapshot]);

  // Radix 的滚动发生在内部的 viewport 上，拿不到就直接操作它
  useEffect(() => {
    viewport.current =
      container.current?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]") ?? null;
  }, []);

  // 服务端只发最近 N 条；更早的按需拼接。用 id 去重，来回翻不会重复
  const seen = new Set<number>();
  const entries = [...older, ...(snapshot?.entries ?? [])].filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });

  // 更早的内容插到上面之后，把滚动位置往下补「新增的高度」—— 否则视野会跳到新内容上
  useLayoutEffect(() => {
    const view = viewport.current;
    if (!view || adjust.current === null) return;
    const delta = view.scrollHeight - adjust.current;
    if (delta > 0) view.scrollTop += delta;
    adjust.current = null;
  }, [older.length]);

  const live = snapshot?.live ?? null;
  const busy = live?.phase !== undefined;
  const loading = snapshot === null;

  // 实时测量「思考用时」：从进入 thinking 到离开 thinking 的累计毫秒。
  const timing = useRef<{ kind: "thinking" | "working" | "text" | null; start: number }>({ kind: null, start: 0 });
  const thinkingAccum = useRef(0);
  const prevLen = useRef(0);
  const [turnThinking, setTurnThinking] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    const now = Date.now();
    const ents = snapshot?.entries ?? [];
    const kind = liveKind(snapshot?.live ?? null);
    const prev = timing.current;

    if (kind !== prev.kind) {
      if (prev.kind === "thinking") thinkingAccum.current += now - prev.start;
      timing.current = { kind, start: now };
    }

    if (ents.length > prevLen.current) {
      const appended = ents.slice(prevLen.current);
      const newAssistant = [...appended].reverse().find((entry) => entry.kind === "pi.assistant");
      if (newAssistant && thinkingAccum.current > 0) {
        const value = thinkingAccum.current;
        setTurnThinking((m) => new Map(m).set(newAssistant.id, value));
      }
      thinkingAccum.current = 0;
    }
    prevLen.current = ents.length;
  }, [snapshot]);

  const turns = groupTurns(entries);

  return (
    <ScrollArea
      className="h-full"
      onScrollCapture={(event) => {
        const target = event.currentTarget.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
        if (!target) return;
        viewport.current = target;
        stick.current = target.scrollHeight - target.scrollTop - target.clientHeight < 64;

        const nearTop = target.scrollTop < LOAD_AHEAD;
        setAtTop(nearTop);
        if (nearTop && hasMore && !loadingOlder && onLoadOlder) {
          // 记下插入前的滚动高度；新内容进来后按差值补 scrollTop
          adjust.current = target.scrollHeight;
          onLoadOlder();
        }
      }}
    >
      <div ref={container} className="mx-auto w-full max-w-[860px] space-y-4 px-4 py-5">
        {loading && <TranscriptSkeleton />}

        {!loading && (hasMore || loadingOlder) && (
          <div className="flex justify-center py-1 text-[11.5px] text-muted-foreground/60">
            {loadingOlder ? "正在加载更早的消息…" : atTop ? "往下滑会继续加载" : ""}
          </div>
        )}

        {!loading && entries.length === 0 && !busy && (
          <p className="pt-16 text-center text-[13px] text-muted-foreground">
            还没有消息。试着问一句，或者让它跑个命令。
          </p>
        )}

        {turns.map((turn, index) => {
          const isLast = index === turns.length - 1;
          const previous = index > 0 ? turns[index - 1] : undefined;
          const lastOfPrevious = previous?.entries[previous.entries.length - 1];
          const previousAt = previous?.final?.at ?? lastOfPrevious?.at;
          const showDivider =
            turn.startAt !== undefined &&
            (previousAt === undefined || turn.startAt - previousAt > DIVIDER_GAP);

          return (
            <div key={turn.key} className="space-y-4">
              {showDivider && (
                <div className="flex justify-center">
                  <span className="rounded-full bg-muted/60 px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                    {formatDivider(turn.startAt as number)}
                  </span>
                </div>
              )}

              {isLast && busy ? (
                // 只有「正在跑的这一轮」才把过程摊开（你想看它此刻在干什么）。
                // 已经跑完的，哪怕是最后一轮也折叠 —— 你只要最终正文。
                turn.entries.map((entry) => (
                  <div key={entry.id} className="space-y-4">
                    <EntryRow
                      entry={entry}
                      onQuote={onQuote}
                      thinkingDurationMs={turnThinking.get(entry.id) ?? entry.thinkingMs}
                    />
                  </div>
                ))
              ) : (
                <TurnRow
                  turn={turn}
                  onQuote={onQuote}
                  thinkingDurationMs={
                    turn.final ? (turnThinking.get(turn.final.id) ?? turn.final.thinkingMs) : undefined
                  }
                />
              )}
            </div>
          );
        })}

        {live && <LiveRow live={live} />}
        <div ref={bottom} />
      </div>
    </ScrollArea>
  );
}
