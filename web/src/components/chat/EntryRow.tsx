import { Check, Copy, Quote } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Markdown } from "./Markdown";
import { ProcessRail } from "./ProcessRail";
import type { Entry } from "@/lib/types";
import { blocksToQuote, formatDuration, formatStamp } from "@/lib/time";
import { stepsFromEntries } from "@/lib/process-steps";
import { cn, copyText } from "@/lib/utils";

interface EntryRowProps {
  entry: Entry;
  /** 引用某条消息：把它的文字带回输入框 */
  onQuote?: (text: string) => void;
  /** 这一轮任务的总时长（毫秒）；只在最终回答上给，显示在时间戳后面 */
  turnDurationMs?: number;
}

/** 整条 entry 的纯文本（用于「复制」，不截断）。 */
function blocksToText(blocks: Entry["blocks"]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text) parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/**
 * 「引用」按钮：把消息文字带回输入框。
 * 手机上不能靠 hover，所以做成「平时很淡、点一下就引用」——不抢视线但总在手边。
 */
function QuoteButton({ entry, onQuote }: { entry: Entry; onQuote?: (text: string) => void }) {
  if (!onQuote) return null;
  const text = blocksToQuote(entry.blocks);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={() => onQuote(text)}
      aria-label="引用这条"
      title="引用"
      className={cn(
        "shrink-0 rounded-md p-1 text-muted-foreground/40 transition-colors",
        "hover:bg-accent hover:text-accent-foreground active:bg-accent",
      )}
    >
      <Quote className="size-3.5" />
    </button>
  );
}

/** 「复制」按钮：复制整条消息的文字，成功后短暂显示对勾。 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;

  async function copy() {
    const ok = await copyText(text);
    if (ok) {
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
      aria-label="复制内容"
      title="复制"
      className={cn(
        "shrink-0 rounded-md p-1 text-muted-foreground/40 transition-colors",
        "hover:bg-accent hover:text-accent-foreground active:bg-accent",
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/**
 * 消息底部的一行：「时间戳 · 引用 · 复制」。
 * 引用与复制以不同 icon 并排，时间戳在最前；用户消息靠右，助手消息靠左。
 */
function EntryActions({
  entry,
  onQuote,
  align,
  durationMs,
}: {
  entry: Entry;
  onQuote?: (text: string) => void;
  align: "start" | "end";
  durationMs?: number;
}) {
  const text = blocksToText(entry.blocks);
  return (
    <div className={cn("flex items-center gap-1", align === "end" ? "justify-end" : "justify-start")}>
      {entry.at !== undefined && (
        <span className="font-mono text-[10px] text-muted-foreground/50">
          {formatStamp(entry.at)}
          {durationMs !== undefined && (
            <span className="text-muted-foreground/55"> · 用时 {formatDuration(durationMs)}</span>
          )}
        </span>
      )}
      <QuoteButton entry={entry} onQuote={onQuote} />
      <CopyButton text={text} />
    </div>
  );
}

/** 一条 entry → 一组 block。角色决定气泡样式。 */
export function EntryRow({ entry, onQuote, turnDurationMs }: EntryRowProps) {
  const role = entry.kind === "pi.user" ? "user" : entry.kind === "pi.assistant" ? "assistant" : "meta";

  if (role === "user") {
    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="max-w-[min(680px,88%)] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-[13.5px] text-primary-foreground">
          {entry.blocks.map((block, index) => {
            if (block.type === "text") {
              return (
                <p key={index} className="whitespace-pre-wrap">
                  {block.text}
                </p>
              );
            }
            if (block.type === "image") {
              return (
                <img
                  key={index}
                  src={block.url}
                  alt="上传的图片"
                  loading="lazy"
                  className="mb-1.5 max-h-72 w-auto max-w-full rounded-xl border object-contain"
                />
              );
            }
            return null;
          })}
        </div>
        <EntryActions entry={entry} onQuote={onQuote} align="end" />
      </div>
    );
  }

  if (role === "meta") {
    // 没有 user / assistant 身份的条目（工具结果之类）：照样走过程轨道，
    // 不再有第二套「工具结果」样式。
    return <ProcessRail steps={stepsFromEntries([entry])} />;
  }

  return (
    <div className="group text-foreground">
      <div className="min-w-0 space-y-1">
        {/* 这里只留正文与图片：过程（思考 / 工具）统一由 TurnRow 的轨道渲染 */}
        {entry.blocks.map((block, index) =>
          block.type === "text" ? <Markdown key={index} text={block.text} /> : null,
        )}
        <EntryActions entry={entry} onQuote={onQuote} align="start" durationMs={turnDurationMs} />
      </div>
    </div>
  );
}
