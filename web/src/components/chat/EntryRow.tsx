import { Quote } from "lucide-react";

import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import { ToolResultBlock } from "./ToolResultBlock";
import type { Entry } from "@/lib/types";
import { blocksToQuote, formatDuration, formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";

interface EntryRowProps {
  entry: Entry;
  /** 引用某条消息：把它的文字带回输入框 */
  onQuote?: (text: string) => void;
  /** 这一轮任务的总时长（毫秒）；只在最终回答上给，显示在时间戳后面 */
  turnDurationMs?: number;
  /** 这一轮思考的总用时（毫秒）；仅本次运行测得到，历史消息可能没有 */
  thinkingDurationMs?: number;
}

/**
 * 「引用」按钮。
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
      title="引用这条"
      className={cn(
        "shrink-0 self-start rounded-md p-1 text-muted-foreground/40 transition-colors",
        "hover:bg-accent hover:text-accent-foreground active:bg-accent",
        "sm:opacity-0 sm:group-hover:opacity-100",
      )}
    >
      <Quote className="size-3.5" />
    </button>
  );
}

/** 一条 entry → 一组 block。角色决定气泡样式。 */
export function EntryRow({ entry, onQuote, turnDurationMs, thinkingDurationMs }: EntryRowProps) {
  const role = entry.kind === "pi.user" ? "user" : entry.kind === "pi.assistant" ? "assistant" : "meta";

  if (role === "user") {
    return (
      <div className="group flex items-start justify-end gap-1">
        <QuoteButton entry={entry} onQuote={onQuote} />
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
          {entry.at !== undefined && (
            <p className="mt-1 text-right font-mono text-[10px] text-primary-foreground/50">
              {formatStamp(entry.at)}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (role === "meta") {
    return (
      <div className="space-y-1">
        {entry.blocks.map((block, index) =>
          block.type === "toolResult" ? (
            <ToolResultBlock key={index} text={block.text} />
          ) : block.type === "toolCall" ? (
            <ToolCallCard
              key={index}
              name={block.name}
              input={block.input}
              result={block.result}
              isError={block.isError}
              durationMs={block.durationMs}
            />
          ) : null,
        )}
      </div>
    );
  }

  return (
    <div className={cn("group flex items-start gap-1", "text-foreground")}>
      <div className="min-w-0 flex-1 space-y-1">
        {entry.blocks.map((block, index) => {
        switch (block.type) {
          case "thinking":
            return <ThinkingBlock key={index} text={block.text} durationMs={thinkingDurationMs} />;
          case "text":
            return <Markdown key={index} text={block.text} />;
          case "toolCall":
            return (
              <ToolCallCard
                key={index}
                name={block.name}
                input={block.input}
                result={block.result}
                isError={block.isError}
                durationMs={block.durationMs}
              />
            );
          case "toolResult":
            return <ToolResultBlock key={index} text={block.text} />;
          default:
            return null;
        }
      })}
        {entry.at !== undefined && (
          <p className="pt-0.5 font-mono text-[10px] text-muted-foreground/45">
            {formatStamp(entry.at)}
            {turnDurationMs !== undefined && (
              <span className="text-muted-foreground/55"> · 用时 {formatDuration(turnDurationMs)}</span>
            )}
          </p>
        )}
      </div>
      {/* 固定宽度的引用槽：无论这条有没有正文，都占同样的右边距，
          这样同一条消息里的工具卡片宽度恒定、各行也等宽 */}
      <div className="flex w-6 shrink-0 justify-end">
        <QuoteButton entry={entry} onQuote={onQuote} />
      </div>
    </div>
  );
}
