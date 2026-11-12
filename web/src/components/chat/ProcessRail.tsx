import { AlertTriangle, Brain, Check, ChevronRight, Cog } from "lucide-react";
import { useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { RailStep } from "@/lib/process-steps";
import { summarizeSteps } from "@/lib/process-steps";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

import { StepRow, toolIcon } from "./StepRow";

function formatChars(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars);
}

/** 桌面折叠行上的「工具种类 × 次数」小图标，最多 4 种。 */
function ToolChips({ byTool }: { byTool: { name: string; count: number }[] }) {
  const shown = byTool.slice(0, 4);
  const rest = byTool.length - shown.length;
  return (
    <span className="hidden shrink-0 items-center gap-2 text-[10.5px] text-muted-foreground/60 md:flex">
      {shown.map((item) => {
        const Icon = toolIcon(item.name);
        return (
          <span
            key={item.name}
            className="flex items-center gap-0.5"
            title={`${item.name} × ${item.count}`}
          >
            <Icon className="size-3" aria-hidden />
            <span className="tabular-nums">×{item.count}</span>
          </span>
        );
      })}
      {rest > 0 && <span>+{rest}</span>}
    </span>
  );
}

interface ProcessRailProps {
  steps: RailStep[];
  /** 这一轮从提问到回答的总用时 */
  durationMs?: number;
  /** 进行中：强制展开、不可折叠（没有「藏起来」的理由） */
  live?: boolean;
  /** 进行中头部状态；正在流式输出答案时传 null，头部让位给正文 */
  status?: "thinking" | "working" | null;
  elapsedSeconds?: number;
  /** 受控展开状态；不传则由组件自己记 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * 过程轨道：思考与工具执行的**唯一**呈现方式。
 *
 * 只有两级披露：
 *   L0 折叠行 —— 永远可见（已完成 + 用时 + 工具画像）
 *   L1 步骤行 —— 一步一行，点开才是 L2 原文
 *
 * 以前是「轮次折叠 × 单块折叠」两层嵌套，最深的输出要点三下才看得到。
 */
export function ProcessRail({
  steps,
  durationMs,
  live = false,
  status = null,
  elapsedSeconds = 0,
  open,
  onOpenChange,
}: ProcessRailProps) {
  const [internal, setInternal] = useState(false);

  const expanded = live ? true : (open ?? internal);
  const summary = summarizeSteps(steps);
  const body = (
    <div className="mt-1 space-y-1 border-l border-border/60 pl-3">
      {steps.map((step) => (
        <StepRow key={step.key} step={step} />
      ))}
    </div>
  );

  function toggle(next: boolean) {
    if (live) return;
    if (open === undefined) setInternal(next);
    onOpenChange?.(next);
  }

  // 运行中：头部只说「在干嘛 + 多久」，步骤自己往下落
  if (live) {
    return (
      <div>
        {status !== null && (
          <div className="flex min-h-11 items-center gap-1.5 px-1 text-[12px] text-muted-foreground md:min-h-7">
            {status === "working" ? (
              <Cog
                className="size-3.5 shrink-0 animate-spin text-amber-400 [animation-duration:2.5s]"
                aria-hidden
              />
            ) : (
              <Brain className="size-3.5 shrink-0 animate-pulse text-violet-400" aria-hidden />
            )}
            <span className="italic">{status === "working" ? "执行中…" : "思考中…"}</span>
            <span className="tabular-nums text-[11px] text-muted-foreground/60">
              {elapsedSeconds}s
            </span>
            {summary.steps > 0 && (
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/50">
                {summary.steps} 步
              </span>
            )}
          </div>
        )}
        {summary.steps > 0 && body}
      </div>
    );
  }

  if (summary.steps === 0) return null;

  return (
    <Collapsible open={expanded} onOpenChange={toggle}>
      <CollapsibleTrigger
        className={cn(
          "group flex min-h-11 w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left text-[12px] transition-colors md:min-h-7",
          "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
        )}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
          aria-hidden
        />
        {summary.errors > 0 ? (
          <AlertTriangle className="size-3 shrink-0 text-destructive" aria-hidden />
        ) : (
          <Check className="size-3 shrink-0 text-emerald-500/80" aria-hidden />
        )}
        <span className="shrink-0">已完成</span>
        {durationMs !== undefined && (
          <span className="shrink-0 tabular-nums text-muted-foreground/70">
            {formatDuration(durationMs)}
          </span>
        )}
        {/* 手机：只给步数，图标序列挤不下 */}
        <span className="shrink-0 text-[11px] text-muted-foreground/50 md:hidden">
          · {summary.steps} 步
        </span>
        {summary.thinkingChars > 0 && (
          <span className="hidden shrink-0 text-[11px] text-muted-foreground/50 md:inline">
            · 思考 {formatChars(summary.thinkingChars)} 字
          </span>
        )}
        {summary.errors > 0 && (
          <span className="shrink-0 text-[11px] text-destructive">· {summary.errors} 个出错</span>
        )}
        <ToolChips byTool={summary.byTool} />
      </CollapsibleTrigger>
      <CollapsibleContent>{body}</CollapsibleContent>
    </Collapsible>
  );
}
