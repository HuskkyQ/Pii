import { Check, Copy, Quote } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

/**
 * 用户的提问。滚动时钉在顶部 —— 读长回答时不用回头找「我问了什么」。
 *
 * 只靠 CSS sticky：粘性范围是它所在的那一轮，滚到下一轮就自然被顶出去，
 * 接管的是下一个提问；回答比屏幕短时根本滚不过它，也就不会钉。
 *
 * 「钉住了没有」必须用哨兵 + IntersectionObserver 判断（纯 CSS 做不到）。
 * 因为只有钉住时才该铺那层渐变底 —— 否则每个提问上方都会多一条常驻色带。
 */
function UserBubble({ entry, onQuote }: { entry: Entry; onQuote?: (text: string) => void }) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);
  /** 图片平时只显示小缩略图，点一下才展开到原尺寸 —— 整条提问不再被一张图占满 */
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const marker = sentinel.current;
    if (!marker) return;
    const root = marker.closest<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (!root) return;

    /*
     * 直接比较「哨兵有没有跑到视口上方」。
     *
     * 为什么不用 IntersectionObserver：它只在比例跨过阈值时回调，
     * 屏幕下方那些「从来没进过视野」的提问会一直保持上一次的状态，
     * 结果每个提问都提前铺上了渐变底。这里每次滚动都算一次，
     * 一屏也就十来个气泡，代价可以忽略。
     */
    const update = () => {
      const rootTop = root.getBoundingClientRect().top;
      setStuck(marker.getBoundingClientRect().top < rootTop);
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      root.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <>
      {/* 哨兵：它滚出视口顶部，就说明提问已经被钉住了 */}
      <div ref={sentinel} aria-hidden className="h-px" />
      {/*
       * 钉住时**不铺底色**：气泡本身就是不透明的，够用了；
       * 加一条通栏底色反而会在一片流动的光晕里贴出一块死板的矩形。
       * 只给气泡加一点投影，让它像是浮在滚动的正文之上。
       */}
      {/* pb-1：下面还有轮次容器的 space-y-4 和轨道自己的间距，
          这里再留 12px 会叠成一条比正文行距还宽的空白带 */}
      <div data-entry-id={entry.id} className="sticky top-0 z-10 flex flex-col items-end gap-1 pb-1 pt-1">
        <div
          className={cn(
            "max-w-[min(680px,88%)] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-[13.5px] text-primary-foreground",
            stuck && "shadow-lg shadow-black/25",
          )}
        >
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
                  onClick={() => setExpanded((value) => !value)}
                  className={cn(
                    "mb-1.5 w-auto cursor-pointer rounded-xl border object-contain",
                    expanded ? "max-h-72 max-w-full" : "max-h-[72px] max-w-[96px]",
                  )}
                />
              );
            }
            return null;
          })}
        </div>
        {/* 钉住时收起时间戳/复制：它们会浮在滚动的正文上，读起来很脏。
            用 opacity 而不是卸载 —— 卸载会改变高度，整块内容会往上跳一下。 */}
        <div className={cn("transition-opacity", stuck && "pointer-events-none opacity-0")}>
          <EntryActions entry={entry} onQuote={onQuote} align="end" />
        </div>
      </div>
    </>
  );
}

/** 一条 entry → 一组 block。角色决定气泡样式。 */
export function EntryRow({ entry, onQuote, turnDurationMs }: EntryRowProps) {
  const role = entry.kind === "pi.user" ? "user" : entry.kind === "pi.assistant" ? "assistant" : "meta";

  if (role === "user") {
    return <UserBubble entry={entry} onQuote={onQuote} />;
  }

  if (role === "meta") {
    // 没有 user / assistant 身份的条目（工具结果之类）：照样走过程轨道，
    // 不再有第二套「工具结果」样式。
    return <ProcessRail steps={stepsFromEntries([entry])} />;
  }

  return (
    <div data-entry-id={entry.id} className="group text-foreground">
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
