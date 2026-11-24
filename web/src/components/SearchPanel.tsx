import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { searchMessages, type SearchHit } from "@/lib/api";
import type { ConversationSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 输入停下多久才发请求：打字过程中每个字都查一次，后端会把整张表扫很多遍。 */
const DEBOUNCE_MS = 250;

/**
 * 全文搜索：跨会话找正文（提问 + 回答）。
 *
 * 结果按会话分组：同一条提问和它的回答往往都会命中，混在一起看很乱。
 * 点一条 → 切到那个会话，并尽量滚到那一轮（条目不在当前窗口里就只切会话）。
 */
export function SearchPanel({
  open,
  onClose,
  items,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** 用来把 conversationId 换成标题；查不到就显示 #id */
  items: ConversationSummary[];
  onPick: (conversationId: number, entryId: number) => void;
}) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setText("");
    setHits(null);
    // 等挂载动画/布局稳定再聚焦，否则手机键盘会把面板顶歪
    const timer = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const query = text.trim();
    if (query.length < 2) {
      setHits(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMessages(query)
        .then((data) => {
          if (!cancelled) setHits(data.hits);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, open]);

  if (!open) return null;

  const titles = new Map(items.map((item) => [item.id, item.title]));
  const groups = new Map<number, SearchHit[]>();
  for (const hit of hits ?? []) {
    const list = groups.get(hit.conversationId) ?? [];
    list.push(hit);
    groups.set(hit.conversationId, list);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} aria-hidden />

      <div className="relative z-10 flex h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border bg-background shadow-2xl sm:h-[80dvh] sm:max-w-[720px] sm:rounded-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="搜索所有会话…"
            className="h-8 flex-1 border-0 bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-0"
            aria-label="搜索所有会话"
          />
          <Button size="icon" variant="ghost" className="size-8" onClick={onClose} aria-label="关闭">
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {text.trim().length < 2 ? (
            <p className="p-6 text-center text-[12.5px] text-muted-foreground">至少输入两个字</p>
          ) : loading && !hits ? (
            <p className="p-6 text-center text-[12.5px] text-muted-foreground">搜索中…</p>
          ) : (hits?.length ?? 0) === 0 ? (
            <p className="p-6 text-center text-[12.5px] text-muted-foreground">没有找到「{text.trim()}」</p>
          ) : (
            [...groups].map(([conversationId, list]) => (
              <section key={conversationId} className="border-b last:border-b-0">
                <h3 className="sticky top-0 z-10 bg-background/95 px-3 py-1.5 text-[11px] font-medium text-muted-foreground backdrop-blur">
                  {titles.get(conversationId) ?? `#${conversationId}`}
                </h3>
                <ul>
                  {list.map((hit) => (
                    <li key={hit.entryId}>
                      <button
                        type="button"
                        onClick={() => onPick(hit.conversationId, hit.entryId)}
                        className="flex w-full cursor-pointer flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-accent/60"
                      >
                        <span
                          className={cn(
                            "text-[10.5px] font-medium",
                            hit.role === "user" ? "text-sky-500" : "text-emerald-500",
                          )}
                        >
                          {hit.role === "user" ? "你" : "回答"}
                        </span>
                        <span className="text-[12.5px] leading-snug text-foreground/85">
                          <Highlight text={hit.snippet} query={text.trim()} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** 把命中的那一段标出来。 */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.toLowerCase();
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded bg-amber-500/25 px-0.5 text-foreground">{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}
