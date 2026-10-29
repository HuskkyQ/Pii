import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const PREVIEW_LINES = 4;

/** 工具结果：默认折叠成几行预览；错误结果标红并默认展开。 */
export function ToolResultBlock({ text }: { text: string }) {
  const isError = /\[error\]|Tool call blocked/i.test(text);
  const [open, setOpen] = useState(isError);
  const lines = text.split("\n");
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const rest = lines.length - PREVIEW_LINES;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-1.5">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11.5px] transition-colors",
          isError ? "text-destructive hover:bg-destructive/10" : "text-muted-foreground hover:bg-muted/40",
        )}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <span>{isError ? "工具被拒绝 / 出错" : "工具结果"}</span>
        <span className="ml-auto text-[11px] text-muted-foreground/60">
          {lines.length} 行 · {open ? "收起" : "展开"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre
          className={cn(
            "mt-1 overflow-x-auto rounded-md border p-2.5 font-mono text-[12px] leading-relaxed",
            isError
              ? "border-destructive/40 bg-destructive/10 text-destructive-foreground/90"
              : "border-border/60 bg-muted/30",
          )}
        >
          {text}
        </pre>
      </CollapsibleContent>
      {!open && !isError && rest > 0 && (
        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground/50">{preview.split("\n")[0]}</div>
      )}
    </Collapsible>
  );
}
