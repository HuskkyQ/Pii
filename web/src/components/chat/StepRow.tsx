import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  Copy,
  FilePen,
  FileSearch,
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDuration } from "@/lib/time";
import { cn, copyText } from "@/lib/utils";

import { Markdown } from "./Markdown";
import type { RailStep } from "@/lib/process-steps";

/** 工具名 → 图标。rails 的折叠行和步骤行共用一套，避免同一个工具两种长相。 */
export function toolIcon(name: string) {
  switch (name) {
    case "bash":
    case "shell":
      return SquareTerminal;
    case "read":
      return FileText;
    case "edit":
    case "write":
      return FilePen;
    case "grep":
      return Search;
    case "glob":
    case "list":
      return FileSearch;
    case "fetch":
    case "web":
      return Globe;
    case "image":
      return ImageIcon;
    default:
      return Wrench;
  }
}

/** 一行步骤的公共外观：同一个高度（手机 44px 触控、桌面 28px 密度）。 */
const ROW = cn(
  "flex min-h-11 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] transition-colors md:min-h-7",
);

export function StepRow({ step }: { step: RailStep }) {
  if (step.kind === "thinking") return <ThinkingStep step={step} />;
  if (step.kind === "text") return <TextStep step={step} />;
  return <ToolStep step={step} />;
}

/** 思考：折叠只给「字数 + 用时 + 两行摘要」，点开才是全文。 */
function ThinkingStep({ step }: { step: Extract<RailStep, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  const compact = step.text.replace(/\s+/g, " ").trim();
  const chars = compact.replace(/\s/g, "").length;
  const preview = compact.slice(0, 480);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(ROW, "text-muted-foreground hover:bg-muted/50 hover:text-foreground")}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <Brain
          className={cn(
            "size-3.5 shrink-0",
            step.streaming ? "animate-pulse text-violet-400" : "opacity-70",
          )}
          aria-hidden
        />
        <span className="shrink-0 italic">思考</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
          {chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : chars} 字
        </span>
        {step.durationMs !== undefined && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
            · {formatDuration(step.durationMs)}
          </span>
        )}
        {step.streaming && (
          <span className="min-w-0 truncate text-[11px] text-violet-400/80">思考中…</span>
        )}
      </CollapsibleTrigger>

      {/* 摘要常驻：不再靠 hover 才能看到（手机上压根没有 hover） */}
      {!open && preview && (
        <p className="line-clamp-2 pl-6 pr-1 text-[12px] leading-relaxed text-muted-foreground/55">
          {preview}
        </p>
      )}

      <CollapsibleContent>
        <div className="mt-1 border-l-2 border-border/70 pl-3 text-[13px] text-muted-foreground italic">
          <Markdown text={step.text} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 过程性正文（动手前的「我先看一下…」）：直接显示，不再折叠。 */
function TextStep({ step }: { step: Extract<RailStep, { kind: "text" }> }) {
  return (
    <div className="border-l-2 border-border/40 py-0.5 pl-2 text-[12.5px] leading-relaxed text-muted-foreground/80">
      <Markdown text={step.text} compact />
      {step.streaming && (
        <span
          className="ml-0.5 inline-block h-3 w-[2px] animate-pulse rounded-full bg-foreground/40 align-middle"
          aria-hidden
        />
      )}
    </div>
  );
}

/** 一次工具调用：折叠行 = 工具名 + 命令首行 + 状态；点开 = 命令 + 结果。 */
function ToolStep({ step }: { step: Extract<RailStep, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(step.name);
  const command = formatArgs(step.name, step.input);
  const hasResult = typeof step.result === "string";
  const resultChars = step.result?.length ?? 0;
  const resultLines = step.result ? step.result.split("\n").length : 0;
  // 还没跑完的工具没有内容可展，别做成“点开一个空盒子”
  const interactive = step.status === "done";

  const row = (
    <>
      {interactive ? (
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
      ) : (
        <span className="size-3.5 shrink-0" aria-hidden />
      )}
      <Icon
        className={cn("size-3.5 shrink-0", step.isError ? "text-destructive" : "text-amber-400/80")}
        aria-hidden
      />
      <span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[10.5px] leading-none text-muted-foreground">
        {step.name}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono">
        {command ? command.split("\n")[0] : "…"}
      </span>
      {/* 结果字数只在桌面显示：手机上每个像素都贵 */}
      {hasResult && (
        <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground/50 md:inline">
          {resultChars >= 1000 ? `${(resultChars / 1000).toFixed(1)}k 字` : `${resultChars} 字`}
        </span>
      )}
      {step.durationMs !== undefined && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
          {step.durationMs < 1000
            ? `${step.durationMs}ms`
            : `${(step.durationMs / 1000).toFixed(1)}s`}
        </span>
      )}
      <StatusGlyph status={step.status} isError={step.isError} />
    </>
  );

  const tone = cn(
    ROW,
    step.isError
      ? "text-destructive hover:bg-destructive/10"
      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
  );

  if (!interactive) return <div className={tone}>{row}</div>;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={tone}>{row}</CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-1 overflow-hidden rounded-md border border-border/50 bg-foreground/[3%]">
          <SectionLabel label="命令" text={command} />
          <pre className="max-h-40 overflow-auto overscroll-contain whitespace-pre-wrap break-words px-2.5 pb-2 font-mono text-[12px] leading-relaxed">
            {command}
          </pre>

          {hasResult && (
            <>
              <div className="border-t border-border/40" />
              <SectionLabel
                label="结果"
                text={step.result}
                note={step.isError ? "出错 / 被拒绝" : undefined}
                meta={`${resultLines} 行`}
              />
              <pre
                className={cn(
                  // 手机限 45dvh：展开长输出时别把输入框顶到屏幕外
                  "max-h-[45dvh] overflow-auto overscroll-contain whitespace-pre-wrap break-words px-2.5 pb-2 font-mono text-[12px] leading-relaxed md:max-h-[420px]",
                  step.isError && "text-destructive",
                )}
              >
                {step.result}
              </pre>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StatusGlyph({
  status,
  isError,
}: {
  status: "pending" | "running" | "done";
  isError?: boolean;
}) {
  if (status === "pending") {
    return <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-label="排队中" />;
  }
  if (status === "running") {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-amber-400" aria-label="运行中" />;
  }
  if (isError) {
    return <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-label="出错" />;
  }
  return <Check className="size-3.5 shrink-0 text-emerald-500/80" aria-label="完成" />;
}

/** 小节标题条：左标签，右侧一个复制按钮（命令和结果各一个）。 */
function SectionLabel({
  label,
  text,
  note,
  meta,
}: {
  label: string;
  text?: string;
  note?: string;
  meta?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-0.5">
      <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground/60">{label}</span>
      {meta && <span className="text-[10.5px] tabular-nums text-muted-foreground/40">{meta}</span>}
      {note && <span className="text-[10.5px] text-destructive">{note}</span>}
      {text && <CopyMini text={text} />}
    </div>
  );
}

function CopyMini({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (await copyText(text)) {
      setCopied(true);
      toast.success("已复制");
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("复制失败");
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label="复制"
      title="复制"
      className="ml-auto shrink-0 rounded p-1.5 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-accent-foreground active:bg-accent md:p-1"
    >
      {copied ? <Check className="size-3.5 md:size-3" /> : <Copy className="size-3.5 md:size-3" />}
    </button>
  );
}

/** 折叠行上显示的命令摘要：bash 取 command，其余取常见字段，最后退回 JSON。 */
function formatArgs(name: string, input: unknown): string {
  // 实时轨道上的工具只有名字（还没拿到参数），这时给空串，不要给“null”
  if (input === null || input === undefined) return "";
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if ((name === "bash" || name === "shell") && typeof record.command === "string") {
      return record.command;
    }
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
