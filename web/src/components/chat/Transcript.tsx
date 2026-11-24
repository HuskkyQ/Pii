import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { stepsFromEntries, stepsFromLive } from "@/lib/process-steps";
import type { Entry, LiveView, Snapshot } from "@/lib/types";
import { DIVIDER_GAP, formatDivider } from "@/lib/time";

import { EntryRow } from "./EntryRow";
import { LiveRow, liveAnswerText } from "./LiveRow";
import { LoadingOlder } from "./LoadingOlder";
import { ProcessRail } from "./ProcessRail";
import { RunErrorBanner } from "./RunErrorBanner";
import { TranscriptSkeleton } from "./TranscriptSkeleton";
import { TurnRow, groupTurns } from "./TurnRow";
import type { Turn } from "./TurnRow";

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

/** 运行中的过程轨道：已落库的步骤 + 还没落库的（排队/运行中的工具、流式思考）。 */
function LiveProcess({
  live,
  turn,
  seconds,
  streamingAnswer,
  onQuote,
}: {
  live: LiveView;
  turn: Turn;
  seconds: number;
  streamingAnswer: boolean;
  onQuote?: (text: string) => void;
}) {
  /*
   * 运行中 groupTurns 已经把“带正文的 assistant”挑成 turn.final 了，
   * 所以这一轮的过程要把它一起算进去，否则那段过程性正文会在
   * 「生成结束、工具开始」到「整轮结束」之间凭空消失又冒出来。
   * 它真已经是最终答案（没带工具调用）时就不进轨道，单独按答案渲染。
   */
  const answered = turn.final && !turn.final.blocks.some((block) => block.type === "toolCall");
  const processEntries = answered
    ? turn.process
    : [...turn.process, ...(turn.final ? [turn.final] : [])];

  const steps = [...stepsFromEntries(processEntries), ...stepsFromLive(live)];
  const status = streamingAnswer ? null : live.phase === "tools" ? "working" : "thinking";

  return (
    <>
      {steps.length > 0 && (
        <ProcessRail steps={steps} live status={status} elapsedSeconds={seconds} />
      )}
      {answered && turn.final && <EntryRow entry={turn.final} onQuote={onQuote} />}
    </>
  );
}

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
  runError,
  onRetry,
  pending,
  focusEntryId,
  onFocused,
}: {
  snapshot: Snapshot | null;
  /** 往前翻出来的历史（拼在快照窗口前面） */
  older?: Entry[];
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  onQuote?: (text: string) => void;
  /** 上一轮失败的原因（模型不可达等） */
  runError?: { taskId: number; message: string; reason?: string; at?: number } | null;
  onRetry?: () => void;
  /**
   * 刚发出去、还没进快照的那条消息（乐观回显）。
   * 它只是一个临时气泡：快照里有更新的 pi.user 条目就由上层撤掉。
   */
  pending?: { blocks: Entry["blocks"]; queued?: boolean; phase?: "sending" | "thinking" } | null;
  /** 从搜索结果跳过来时要定位的条目 id（不在当前窗口里就只切会话） */
  focusEntryId?: number | null;
  onFocused?: () => void;
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
  }, [snapshot, pending]);

  /*
   * 从搜索结果跳过来：滚到那条消息。
   *
   * 快照只带最近若干轮，目标很可能不在窗口里 —— 那就只切会话，不硬等。
   * 试几次还找不到就放弃（清掉 focusEntryId），否则用户以后手动往上翻时
   * 它会突然跳一下。
   */
  const focusRef = useRef<{ id: number | null; tries: number }>({ id: null, tries: 0 });
  useEffect(() => {
    if (focusEntryId == null) return;
    // 换了目标就重新计数：切会话时会有好几次渲染拿不到新快照
    if (focusRef.current.id !== focusEntryId) focusRef.current = { id: focusEntryId, tries: 0 };

    const el = container.current?.querySelector<HTMLElement>(`[data-entry-id="${focusEntryId}"]`);
    if (!el) {
      focusRef.current.tries += 1;
      if (focusRef.current.tries >= 12) {
        focusRef.current = { id: null, tries: 0 };
        onFocused?.();
      }
      return;
    }
    focusRef.current = { id: null, tries: 0 };
    stick.current = false; // 别让"新快照自动滚到底"把视野抢回去

    /*
     * 不用 scrollIntoView：目标消息常常比视口还高，block:"center" 会把它的
     * 开头推到屏幕上方看不见（实测 605px 的消息落在 -156px）。
     * 这里自己算：让它贴着顶部往下 64px —— 给钉住的提问留出位置。
     */
    const view = viewport.current;
    if (view) {
      const offset = el.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop - 64;
      view.scrollTo({ top: Math.max(0, offset) });
    } else {
      el.scrollIntoView({ block: "start" });
    }
    onFocused?.();
  }, [focusEntryId, snapshot, onFocused]);

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

  // 运行中的「思考中/执行中 + 秒数」：从进入某个阶段开始算，换阶段归零。
  const liveSeconds = useElapsedSeconds(busy, liveKind(live) ?? "idle");
  // 正在流式输出答案时，过程头部的状态行让位给正文（以前是靠 LiveRow 里的判定）
  const answerStreaming = live ? liveAnswerText(live) !== null : false;

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

  /*
   * 分组是纯计算，但条目多的时候（几百条）每次快照都重算会掉帧。
   * 用「条目 id 拼成的 key」做 memo：只有真的新增/替换条目才重算。
   */
  const entriesKey = entries.length === 0 ? "0" : `${entries.length}:${entries[0]!.id}:${entries[entries.length - 1]!.id}`;
  const turns = useMemo(() => groupTurns(entries), [entriesKey]);

  /*
   * 过程轨道的展开状态按「轮」记住，放在这里而不是组件里：
   * 运行中那条轨道是强制展开的，结束后如果状态只活在 ProcessRail 内部，
   * 组件一换分支就重置成收起 —— 正看着的人会觉得内容「啪」一下被收走了。
   */
  const [railOpen, setRailOpen] = useState<Record<number, boolean>>({});
  const lastTurnKey = turns.length > 0 ? turns[turns.length - 1]!.key : undefined;
  useEffect(() => {
    if (!busy || lastTurnKey === undefined) return;
    setRailOpen((map) => (map[lastTurnKey] ? map : { ...map, [lastTurnKey]: true }));
  }, [busy, lastTurnKey]);

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
      <div ref={container} className="mx-auto w-full max-w-[860px] px-4 py-5">
        <div className="relative">
          <div className="space-y-4">
            {loading && <TranscriptSkeleton />}

            {!loading && <LoadingOlder visible={loadingOlder} />}

            {!loading && !loadingOlder && hasMore && atTop && (
              <div className="flex justify-center py-1 text-[11px] text-muted-foreground/50">继续上滑加载更早</div>
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
                <div key={turn.key} className="relative space-y-4">
                  {showDivider && (
                    <div className="flex justify-center">
                      <span className="rounded-full bg-muted/60 px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                        {formatDivider(turn.startAt as number)}
                      </span>
                    </div>
                  )}

                  <div className="relative">
                    {isLast && busy ? (
                    // 进行中：过程**照样显示**，只是换成实时轨道（思考中/执行中 + 逐条落下的步骤）；
                    // 最终正文的流式展示交给 LiveRow。以前这里把过程整个藏起来，
                    // 结果最想知道进度的时刻反而什么都看不到。
                    <>
                      {turn.user ? (
                        <EntryRow entry={turn.user} onQuote={onQuote} hideStamp={showDivider} />
                      ) : null}
                      {live && (
                        <LiveProcess
                          live={live}
                          turn={turn}
                          seconds={liveSeconds}
                          streamingAnswer={answerStreaming}
                          onQuote={onQuote}
                        />
                      )}
                    </>
                  ) : (
                    <TurnRow
                      turn={turn}
                      onQuote={onQuote}
                      hideUserStamp={showDivider}
                      thinkingDurationMs={
                        turn.final
                          ? (turnThinking.get(turn.final.id) ?? turn.final.thinkingMs)
                          : undefined
                      }
                      railOpen={railOpen[turn.key]}
                      onRailOpenChange={(open) =>
                        setRailOpen((map) => ({ ...map, [turn.key]: open }))
                      }
                    />
                  )}
                  </div>
                </div>
              );
            })}

            {pending && (
              <div className="flex flex-col items-end gap-1">
                {/* 气泡只在「还没进快照」时出现；进库后真消息自己会显示，别画两份 */}
                {pending.phase !== "thinking" && (
                  <div className="w-full opacity-55">
                    <EntryRow entry={{ id: -1, kind: "pi.user", blocks: pending.blocks }} />
                  </div>
                )}
                <span className="flex items-center gap-1.5 pr-1 text-[11px] text-muted-foreground">
                  {pending.phase === "thinking" && <Loader2 className="size-3 animate-spin" />}
                  {pending.phase === "thinking"
                    ? "模型思考中…"
                    : pending.queued
                      ? "已排队，等当前回合跑完"
                      : "发送中…"}
                </span>
              </div>
            )}

            {live && <LiveRow live={live} />}
            {!live && <RunErrorBanner error={runError ?? null} onRetry={onRetry} />}
            <div ref={bottom} />
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
