import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeBlock } from "./CodeBlock";

/**
 * 只放行能安全点击的链接协议。
 *
 * 本组件已经关掉了原始 HTML（`skipHtml`）并把远程图片换成了文字，
 * 但 `<a href>` 是原样输出的：模型输出或导入的文本里写一句
 * `[点我](javascript:alert(1))`，用户点一下就在本站页面里执行了。
 * 这里只留 http / https / mailto 和站内相对路径，其余渲染成纯文字（看得见、点不动）。
 */
function safeHref(href?: string): string | undefined {
  if (!href) return undefined;
  const url = href.trim();
  if (!url) return undefined;
  // 浏览器解析 URL 时会**丢掉**所有 ASCII 空白/控制字符，所以 `java\tscript:x`
  // 实际就是 `javascript:x`。检测协议前先按同样的规则归一化，别让制表符绕过白名单。
  // 匹配控制字符是故意的，不是笔误：
  // eslint-disable-next-line no-control-regex
  const probe = url.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe)?.[1];
  // 没有协议 → 站内相对路径 / #anchor，点不出执行，放行
  if (!scheme) return url;
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return url;
  return undefined;
}

/**
 * Markdown 渲染。
 * 安全取向：不执行原始 HTML、不加载远程图片（和 sakura-pi 的取舍一致）。
 */
export const Markdown = memo(function Markdown({
  text,
  /** 过程性正文用：比答案小一号，字号由调用方决定层级 */
  compact = false,
}: {
  text: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "prose-pii text-[12.5px] leading-relaxed" : "prose-pii text-[13.5px] leading-relaxed"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          img: ({ alt }) => <span className="text-muted-foreground">[{alt ?? "图片"}]</span>,
          a: ({ children, href }) => {
            const safe = safeHref(href);
            // 协议不在白名单（javascript: / data: / vbscript: ...）：不渲染成链接
            if (!safe) return <span className="text-foreground/70">{children}</span>;
            return (
              <a
                href={safe}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary underline underline-offset-2"
              >
                {children}
              </a>
            );
          },
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b px-2 py-1 text-left font-medium text-muted-foreground">{children}</th>
          ),
          td: ({ children }) => <td className="border-b px-2 py-1 align-top">{children}</td>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          h1: ({ children }) => <h1 className="mt-4 mb-2 text-lg font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-4 mb-2 text-base font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold">{children}</h3>,
          p: ({ children }) => <p className="my-1.5 whitespace-pre-wrap">{children}</p>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
