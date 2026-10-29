import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

import { Markdown } from "./Markdown";

const PREVIEW_CHARS = 220;

/**
 * 思考块：**默认折叠**，hover 看摘要，点击展开/收起。
 *
 * 这正是 pi 终端里做不到、而在 Web 里天然成立的那件事 ——
 * 因为浏览器有 hover 事件，而 pi 的 TUI 组件接口只有 handleInput（键盘）。
 */
export function ThinkingBlock({ text, durationMs }: { text: string; durationMs?: number }) {
  const [open, setOpen] = useState(false);
  const compact = text.replace(/\s+/g, " ").trim();
  const preview = compact.length > PREVIEW_CHARS ? `${compact.slice(0, PREVIEW_CHARS)}…` : compact;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <CollapsibleTrigger
            className={cn(
              "group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left",
              "text-[12px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
            )}
          >
            <ChevronRight
              className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
              aria-hidden
            />
            <span className="italic">思考</span>
            <span className="text-muted-foreground/70">
              {compact.length > 0 ? `· ${compact.length} 字` : ""}
            </span>
            {durationMs !== undefined && (
              <span className="text-muted-foreground/60">· 用时 {formatDuration(durationMs)}</span>
            )}
            <span className="ml-auto text-[11px] text-muted-foreground/60">
              {open ? "点击收起" : "点击展开"}
            </span>
          </CollapsibleTrigger>
        </TooltipTrigger>
        {!open && preview && (
          <TooltipContent side="right" className="max-w-sm whitespace-pre-wrap text-[12px] leading-relaxed">
            {preview}
          </TooltipContent>
        )}
      </Tooltip>
      <CollapsibleContent>
        <div className="mt-1 border-l-2 border-border/70 pl-3 text-muted-foreground italic">
          <Markdown text={text} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
