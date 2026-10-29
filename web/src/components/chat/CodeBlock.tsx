import { Check, Copy } from "lucide-react";
import { useState, type ComponentPropsWithoutRef } from "react";

import { Button } from "@/components/ui/button";

/** 带复制按钮的代码块。故意不用第三方高亮：先保证正确，再谈好看。 */
export function CodeBlock({ children, ...rest }: ComponentPropsWithoutRef<"pre">) {
  const [copied, setCopied] = useState(false);
  const code = typeof children === "object" && children !== null && "props" in (children as never)
    ? String(((children as { props?: { children?: unknown } }).props?.children ?? ""))
    : String(children ?? "");

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默失败 */
    }
  }

  return (
    <div className="group relative my-3">
      <Button
        type="button"
        size="icon"
        variant="secondary"
        onClick={() => void copy()}
        aria-label="复制代码"
        className="absolute right-2 top-2 size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      <pre
        {...rest}
        className="overflow-x-auto rounded-md border bg-muted/40 p-3 pr-10 text-[12.5px] leading-relaxed"
      >
        {children}
      </pre>
    </div>
  );
}
