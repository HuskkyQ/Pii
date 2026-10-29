import { AlertTriangle, Check, ChevronRight, SquareTerminal, Wrench } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface ToolCallCardProps {
  name: string;
  input: unknown;
  /** 已配对的工具结果（服务端按 call id 并进 toolCall 块） */
  result?: string;
  isError?: boolean;
  durationMs?: number;
}

/**
 * 工具调用卡：**命令 + 结果放在同一个可折叠块里**（不再是「命令一块、结果一块」）。
 * 折叠态只留一行「工具名 + 命令摘要 + 状态 + 耗时」，展开看完整命令与结果。
 */
export function ToolCallCard({ name, input, result, isError, durationMs }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);

  const Icon = name === "bash" || name === "shell" ? SquareTerminal : Wrench;
  const command = formatArgs(name, input);
  const hasResult = typeof result === "string";
  const resultChars = typeof result === "string" ? result.length : undefined;
  const time =
    durationMs === undefined
      ? null
      : durationMs < 1000
        ? `${durationMs}ms`
        : `${(durationMs / 1000).toFixed(1)}s`;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-1.5">
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[12px] transition-colors",
          isError
            ? "border-destructive/40 bg-destructive/5 hover:bg-destructive/10"
            : "border-border/60 bg-muted/20 hover:bg-muted/40",
        )}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <Icon
          className={cn("size-3.5 shrink-0", isError ? "text-destructive" : "text-amber-400/80")}
          aria-hidden
        />
        <Badge variant="secondary" className="shrink-0 font-mono text-[11px] leading-none">
          {name}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{command.split("\n")[0]}</span>
        {/* 结束后显示：结果字数 + 用时 */}
        {resultChars !== undefined && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
            {resultChars >= 1000 ? `${(resultChars / 1000).toFixed(1)}k` : resultChars} 字
          </span>
        )}
        {time && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">{time}</span>}
        {hasResult &&
          (isError ? (
            <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-label="出错" />
          ) : (
            <Check className="size-3.5 shrink-0 text-emerald-500/80" aria-label="完成" />
          ))}
      </CollapsibleTrigger>

      <CollapsibleContent>
        {/* 展开后是**一个统一的内容区**（外框只有一层）；命令与结果用一条细线分隔，不再套第二层框 */}
        <div className="mt-1 rounded-md border border-border/60 bg-muted/30 p-2.5 text-[12px]">
          <div className="mb-1 text-[10.5px] uppercase tracking-wider text-muted-foreground/60">命令</div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed">{command}</pre>
          {hasResult && (
            <>
              <div className="my-2 border-t border-border/40" />
              <div className="mb-1 flex items-center gap-1 text-[10.5px] uppercase tracking-wider text-muted-foreground/60">
                结果
                {isError && <span className="text-destructive normal-case tracking-normal">· 出错 / 被拒绝</span>}
              </div>
              <pre
                className={cn(
                  "max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed",
                  isError && "text-destructive",
                )}
              >
                {result}
              </pre>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 折叠行上显示的命令摘要：bash 取 command，其余取常见字段，最后退回 JSON。 */
function formatArgs(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if ((name === "bash" || name === "shell") && typeof record.command === "string") return record.command;
    for (const field of ["command", "file_path", "path", "pattern"]) {
      const value = record[field];
      if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").slice(0, 500);
    }
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
