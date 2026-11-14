import { Brain, Loader2, Pencil, Pin, PinOff, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useMemory } from "@/hooks/useMemory";
import type { MemoryEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 标签在界面上用逗号分隔，和服务端的 `tags: string[]` 互转。 */
function splitTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RowProps {
  entry: MemoryEntry;
  onUpdate: (id: number, patch: { content?: string; tags?: string[]; pinned?: boolean }) => Promise<void>;
  onRemove: (id: number) => Promise<void>;
}

/**
 * 一条记忆。
 *
 * 删除用两段式（和会话列表一致）：第一下变成「删除？」，第二下才真删。
 * 编辑是就地展开，不弹二次窗口 —— 记忆都很短，就地改最省事。
 */
function MemoryRow({ entry, onUpdate, onRemove }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);
  const [draftTags, setDraftTags] = useState(entry.tags.join(", "));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
      return true;
    } catch (error) {
      toast.error(reason(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const content = draft.trim();
    if (!content) {
      toast.error("内容不能为空");
      return;
    }
    const ok = await run(() => onUpdate(entry.id, { content, tags: splitTags(draftTags) }));
    if (ok) setEditing(false);
  };

  if (editing) {
    return (
      <div className="space-y-2 rounded-lg border border-border/70 bg-background/40 p-2.5">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          maxLength={1000}
          aria-label="记忆内容"
        />
        <Input
          value={draftTags}
          onChange={(event) => setDraftTags(event.target.value)}
          placeholder="标签（可选，逗号分隔）"
          className="h-8"
          aria-label="记忆标签"
        />
        <div className="flex justify-end gap-2">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setDraft(entry.content);
              setDraftTags(entry.tags.join(", "));
            }}
            disabled={busy}
          >
            取消
          </Button>
          <Button size="xs" onClick={() => void save()} disabled={busy}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            保存
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 transition-colors",
        entry.pinned ? "border-amber-500/35 bg-amber-500/5" : "border-border/60",
        confirming && "border-destructive/50 bg-destructive/5",
      )}
    >
      <div className="flex items-start gap-2">
        {entry.pinned && <Pin className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-label="已置顶" />}
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{entry.content}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/80">
            <span className="font-mono">#{entry.id}</span>
            <span>
              {entry.source === "agent"
                ? `agent${entry.conversationId === undefined ? "" : ` · 会话 ${entry.conversationId}`}`
                : "手动"}
            </span>
            {entry.tags.map((tag) => (
              <span key={tag} className="rounded bg-accent px-1.5 py-0.5 text-accent-foreground/80">
                {tag}
              </span>
            ))}
          </div>
        </div>

        {confirming ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="xs"
              variant="destructive"
              onClick={() => void run(() => onRemove(entry.id))}
              disabled={busy}
            >
              删除
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              取消
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={entry.pinned ? "取消置顶" : "置顶"}
              title={entry.pinned ? "取消置顶" : "置顶"}
              disabled={busy}
              onClick={() => void run(() => onUpdate(entry.id, { pinned: !entry.pinned }))}
            >
              {entry.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="编辑"
              title="编辑"
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="删除"
              title="删除"
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 全局记忆面板。
 *
 * 手机：从底部升起的大抽屉（记忆列表 + 底部固定输入区）。
 * 桌面：居中的卡片。和会话抽屉一样，没有路由 —— 关掉就回到对话。
 */
export function MemoryPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { entries, injected, budgetChars, loading, refresh, add: addEntry, update, remove } = useMemory();
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const add = async () => {
    const text = content.trim();
    if (!text) return;
    setBusy(true);
    try {
      await addEntry({ content: text, tags: splitTags(tags), pinned });
      setContent("");
      setTags("");
      setPinned(false);
      toast.success("已添加，下一轮对话生效");
    } catch (error) {
      toast.error(reason(error));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] md:flex md:items-center md:justify-center">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="全局记忆"
        className="glass-strong absolute inset-x-0 bottom-0 top-[6%] flex flex-col rounded-t-2xl border border-border/60 md:static md:max-h-[82vh] md:w-[min(680px,92vw)] md:rounded-2xl"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-3">
          <Brain className="size-4 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-medium">全局记忆</h2>
            <p className="text-[11px] text-muted-foreground">
              {loading
                ? "加载中…"
                : `注入 ${injected} / ${entries.length} 条 · 预算 ${budgetChars} 字`}
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            title="刷新"
            onClick={() => void refresh()}
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="关闭" title="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
          {entries.length === 0 && !loading && (
            <p className="px-2 py-8 text-center text-[12px] text-muted-foreground">
              还没有记忆。下面加一条，或在对话里让 agent 记住某件事。
            </p>
          )}
          {entries.map((entry) => (
            <MemoryRow key={entry.id} entry={entry} onUpdate={update} onRemove={remove} />
          ))}
        </div>

        <div className="shrink-0 border-t border-border/50 px-3 py-2.5">
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              // Ctrl/Cmd + Enter 提交；单独 Enter 留给换行（记忆里可能有列表）
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void add();
              }
            }}
            placeholder="记一条长期事实，例如「用户用 pnpm，不要用 npm」"
            rows={2}
            maxLength={1000}
            aria-label="新记忆内容"
          />
          <div className="mt-2 flex items-center gap-2">
            <Input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="标签（可选，逗号分隔）"
              className="h-8 flex-1"
              aria-label="新记忆标签"
            />
            <Button
              size="sm"
              variant={pinned ? "default" : "outline"}
              onClick={() => setPinned((value) => !value)}
              title={pinned ? "取消置顶" : "置顶"}
            >
              <Pin className="size-3" />
              置顶
            </Button>
            <Button size="sm" onClick={() => void add()} disabled={busy || content.trim().length === 0}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : null}
              添加
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
