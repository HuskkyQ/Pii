import { Brain, Cog } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Block, LiveView } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Markdown } from "./Markdown";

/**
 * 正在发生的那一行。
 *
 *  - **正文**：流式展示（持续重渲染，末尾带光标）。
 *  - **思考**：不展示思考内容，显示「Thinking… + 用时」——紫色 + 脉冲的大脑图标。
 *  - **工具执行**：显示「Working… + 用时」——琥珀色 + 旋转的齿轮图标。
 *
 * 两类用不同图标/动画/颜色区分，并在后面显示以秒（s）计的用时。
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
  const textBlocks = blocks.filter((block) => block.type === "text" && block.text.trim().length > 0);
  const hasText = textBlocks.length > 0;
  const hasToolCall = blocks.some((block) => block.type === "toolCall");

  const kind: StatusKind | null = hasText
    ? null
    : live.phase === "tools" || hasToolCall
      ? "working"
      : "thinking";

  const seconds = useElapsedSeconds(kind !== null, kind ?? "none");

  return (
    <div className="flex items-start gap-1 text-foreground">
      <div className="min-w-0 flex-1 space-y-1">
        {kind ? (
          <StatusLine kind={kind} seconds={seconds} />
        ) : (
          <>
            {textBlocks.map((block, index) =>
              block.type === "text" ? <Markdown key={index} text={block.text} /> : null,
            )}
            {/* 流式正文末尾的小光标：让它看起来“还在写” */}
            <span
              className="inline-block h-3.5 w-[2px] animate-pulse rounded-full bg-foreground/60 align-middle"
              aria-hidden
            />
          </>
        )}
      </div>
    </div>
  );
}
