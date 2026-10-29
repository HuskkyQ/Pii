import { ChevronLeft, FolderOpen, Home, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { browseDir, getCwd, setCwd } from "@/lib/api";
import type { DirListing } from "@/lib/types";

interface CwdPickerProps {
  open: boolean;
  conversationId?: number;
  onClose: () => void;
  onPicked: (cwd: string) => void;
}

/**
 * 选工作目录。
 *
 * 为什么是「浏览 + 路径输入」两条路：
 *   - 浏览：手机上不用敲长路径，点几下就到
 *   - 输入：桌面/开发时直接粘一个绝对路径最快
 *
 * 选中的目录会写进这个会话的 `pi.agent.cwd`——
 * 也就是说**不同会话可以同时在不同项目里干活**。
 */
export function CwdPicker({ open, conversationId, onClose, onPicked }: CwdPickerProps) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [current, setCurrent] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async (path?: string) => {
    setBusy(true);
    try {
      const next = await browseDir(path);
      setListing(next);
      setCurrent(next.path);
      setDraft(next.path);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    getCwd(conversationId)
      .then((data) => load(data.cwd))
      .catch(() => load());
  }, [open, conversationId]);

  async function confirm(path: string) {
    setBusy(true);
    try {
      const result = await setCwd(path, conversationId);
      toast.success(`工作目录 → ${result.cwd.split("/").slice(-1)[0] || result.cwd}`);
      onPicked(result.cwd);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[78dvh] flex-col rounded-t-2xl border-t bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-3">
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-[13px] font-medium">选择工作目录</span>
          <span className="text-[11px] text-muted-foreground">agent 只在这个目录里读写</span>
          <Button size="icon" variant="ghost" className="ml-auto size-8" onClick={onClose} aria-label="关闭">
            <X className="size-4" />
          </Button>
        </div>

        {/* 路径输入：桌面端可以直接粘绝对路径 */}
        <div className="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-lg border bg-muted/40 px-2">
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void load(draft);
              }
            }}
            spellCheck={false}
            placeholder="/Users/you/projects/foo"
            className="h-9 min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground/60"
          />
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => void load(draft)}>
            前往
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {listing && (
            <>
              <div className="flex items-center gap-1 px-1 py-1">
                {listing.parent && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 px-2 text-[12px]"
                    onClick={() => void load(listing.parent ?? undefined)}
                  >
                    <ChevronLeft className="size-3.5" />
                    上一级
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-[12px]"
                  onClick={() => void load("~")}
                >
                  <Home className="size-3.5" />
                  家目录
                </Button>
                <span className="ml-auto shrink-0 pr-1 text-[11px] text-muted-foreground">
                  {listing.fileCount} 个文件
                </span>
              </div>

              {listing.dirs.map((dir) => (
                <button
                  key={dir.path}
                  type="button"
                  onClick={() => void load(dir.path)}
                  className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/60"
                >
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{dir.name}</span>
                  <ChevronLeft className="size-3.5 shrink-0 rotate-180 opacity-40" aria-hidden />
                </button>
              ))}

              {listing.dirs.length === 0 && (
                <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">这个目录下没有子目录</p>
              )}
            </>
          )}
        </div>

        <div className="shrink-0 border-t px-3 py-2.5">
          <div className="mb-2 truncate font-mono text-[11px] text-muted-foreground">{current}</div>
          <Button
            className="w-full"
            disabled={busy || !current}
            onClick={() => void confirm(current)}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : "用这个目录"}
          </Button>
        </div>
      </div>
    </div>
  );
}
