import { Brain, Cog } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Block, LiveView } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Markdown } from "./Markdown";

/**
 * 正在发生的那一行。
 *
 *  - **最终正文**：流式展示（持续重渲染，末尾带光标）。
 *  - **思考 / 工具**：只显示「Thinking… / Working… + 用时」——紫色大脑 / 琥珀齿轮。
 *  - **过程性正文（preamble）**：模型在动手前说的「我先看一下…」这类文字，
 *    不再闪现即消失，而是作为「当前思考结果」贴在状态行下方，持续显示，
 *    直到出现下一个思考结果或整轮结束（结束随状态行一起消失）。
 *
 * 结束后的历史里，这些过程性正文会被 TurnRow 折叠进过程——展开即可看到其准确位置。
 */
type StatusKind = "thinking" | "working";

/** 某一状态持续了多少秒；状态切换或重新开始会归零。 */
function useElapsedSeconds(active: boolean, resetKey: string): number {
  const [seconds, setSeconds] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!active) return;
    startedAt.current = Date.now();
    setSeconds(0);
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, [active, resetKey]);

  return seconds;
}

function StatusLine({ kind, seconds }: { kind: StatusKind; seconds: number }) {
  const thinking = kind === "thinking";
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-[12.5px]",
        thinking ? "text-violet-400" : "text-amber-400",
      )}
    >
      {thinking ? (
        // 思考的动画：大脑做脉冲
        <Brain className="size-3.5 shrink-0 animate-pulse" aria-hidden />
      ) : (
        // 工具的动画：齿轮在转
        <Cog className="size-3.5 shrink-0 animate-spin [animation-duration:2.5s]" aria-hidden />
      )}
      <span className="italic">{thinking ? "Thinking…" : "Working…"}</span>
      {/* 进行中只显示用时（字数留到结束后再显示） */}
      <span className="tabular-nums text-muted-foreground/60">{seconds}s</span>
    </div>
  );
}

export function LiveRow({ live }: { live: LiveView }) {
  const blocks: Block[] = live.message?.blocks ?? [];
  const text = blocks
    .filter((block) => block.type === "text" && block.text.trim().length > 0)
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
  const hasText = text.length > 0;
  const hasToolCall = blocks.some((block) => block.type === "toolCall");

  // 正式答案：有正文、且这条消息里没有工具调用 → 当作最终答案流式展示。
  const isAnswer = hasText && !hasToolCall;
  // 过程性正文（preamble）：有正文且伴随工具调用 → 当作「当前思考结果」。
  const isPreamble = hasText && hasToolCall;

  // 记住「当前思考结果」，在出现下一个或整轮结束前一直显示。
  const [thought, setThought] = useState("");
  useEffect(() => {
    if (isPreamble) setThought(text);
  }, [isPreamble, text]);

  const kind: StatusKind = live.phase === "tools" ? "working" : "thinking";
  const showStatus = !isAnswer;
  const seconds = useElapsedSeconds(showStatus, kind);

  return (
    <div className="flex items-start gap-1 text-foreground">
      <div className="min-w-0 flex-1 space-y-1">
        {isAnswer ? (
          <>
            <Markdown text={text} />
            {/* 流式正文末尾的小光标：让它看起来“还在写” */}
            <span
              className="inline-block h-3.5 w-[2px] animate-pulse rounded-full bg-foreground/60 align-middle"
              aria-hidden
            />
          </>
        ) : (
          <>
            <StatusLine kind={kind} seconds={seconds} />
            {thought && (
              <p className="line-clamp-3 whitespace-pre-wrap pl-5 text-[12px] leading-relaxed text-muted-foreground/70">
                {thought}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
