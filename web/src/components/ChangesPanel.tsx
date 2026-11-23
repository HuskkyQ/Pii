import { ArrowLeft, FileDiff, RefreshCw, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { gitCommit, gitDiff, gitRevert, gitStatus, type GitFile, type GitStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * 变更审阅：agent 改了什么，在这里看。
 *
 * 为什么需要：工具卡上只有一行文本，看不到实际改了哪几行。
 * 手机上尤其致命 —— 你没法确认它到底动了什么，只能盲信。
 *
 * 只做三件事：看 diff、丢弃一个文件、提交全部。推送不在这里 ——
 * 凭据不该由网页代持，交给 agent 或你手动 git push。
 */
export function ChangesPanel({
  open,
  onClose,
  conversationId,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  conversationId?: number;
  /** 丢弃/提交之后通知外面刷新角标 */
  onChanged?: () => void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await gitStatus(conversationId));
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (!open) return;
    setActive(null);
    setDiff(null);
    setConfirming(null);
    void load();
  }, [open, load]);

  async function openFile(file: GitFile) {
    setActive(file.path);
    setDiff(null);
    try {
      const result = await gitDiff(file.path, conversationId);
      setDiff({ text: result.diff, truncated: result.truncated });
    } catch (error) {
      toast.error(errorText(error));
      setActive(null);
    }
  }

  async function revert(file: GitFile) {
    if (confirming !== file.path) {
      setConfirming(file.path);
      // 3 秒内没有再点就取消这份「确认」
      setTimeout(() => setConfirming((current) => (current === file.path ? null : current)), 3000);
      return;
    }
    setConfirming(null);
    setBusy(true);
    try {
      await gitRevert(file.path, conversationId);
      await load();
      onChanged?.();
      toast.success(`已丢弃 ${file.path}`);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    try {
      const result = await gitCommit(message, conversationId);
      setMessage("");
      await load();
      onChanged?.();
      toast.success(`已提交 ${result.commit}`);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  const files = status?.files ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} aria-hidden />

      <div className="relative z-10 flex h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border bg-background shadow-2xl sm:h-[80dvh] sm:max-w-[900px] sm:rounded-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          {active ? (
            <Button size="icon" variant="ghost" className="size-8" onClick={() => setActive(null)} aria-label="返回列表">
              <ArrowLeft className="size-4" />
            </Button>
          ) : (
            <FileDiff className="size-4 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{active ?? "文件改动"}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {status?.repo === false
                ? "当前目录不是 git 仓库"
                : `${status?.branch ?? ""} · ${files.length} 个文件`}
            </div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => void load()}
            disabled={loading}
            aria-label="刷新"
            title="刷新"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <Button size="icon" variant="ghost" className="size-8" onClick={onClose} aria-label="关闭">
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {active ? (
            diff ? (
              <DiffView text={diff.text} truncated={diff.truncated} />
            ) : (
              <p className="p-4 text-[12px] text-muted-foreground">读取中…</p>
            )
          ) : files.length === 0 ? (
            <p className="p-6 text-center text-[12.5px] text-muted-foreground">
              {status?.repo === false ? "这个会话的工作目录还不是 git 仓库" : "没有未提交的改动"}
            </p>
          ) : (
            <ul className="divide-y">
              {files.map((file) => (
                <li key={file.path} className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => void openFile(file)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span
                      className={cn(
                        "grid size-5 shrink-0 place-items-center rounded text-[10.5px] font-medium",
                        STATUS_STYLE[file.status] ?? "bg-muted text-muted-foreground",
                      )}
                      aria-label={STATUS_LABEL[file.status] ?? file.status}
                    >
                      {file.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.path}</span>
                    {(file.additions !== null || file.deletions !== null) && (
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        <span className="text-emerald-500">+{file.additions ?? 0}</span>{" "}
                        <span className="text-rose-500">-{file.deletions ?? 0}</span>
                      </span>
                    )}
                  </button>
                  {file.status !== "?" && file.status !== "A" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className={cn(
                        "size-7 shrink-0",
                        confirming === file.path ? "text-destructive" : "text-muted-foreground/60",
                      )}
                      onClick={() => void revert(file)}
                      disabled={busy}
                      aria-label={confirming === file.path ? "确认丢弃" : "丢弃这个文件的改动"}
                      title={confirming === file.path ? "再点一次确认丢弃" : "丢弃改动"}
                    >
                      <Undo2 className="size-3.5" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {!active && files.length > 0 && (
          <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2">
            <Input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="提交信息"
              maxLength={200}
              className="h-8 flex-1 text-[12.5px]"
              onKeyDown={(event) => {
                if (event.key === "Enter" && message.trim() && !busy) void commit();
              }}
            />
            <Button
              size="sm"
              className="h-8 shrink-0"
              onClick={() => void commit()}
              disabled={busy || !message.trim()}
            >
              提交
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  M: "修改",
  A: "新增",
  D: "删除",
  R: "重命名",
  "?": "未跟踪",
};

const STATUS_STYLE: Record<string, string> = {
  M: "bg-amber-500/15 text-amber-500",
  A: "bg-emerald-500/15 text-emerald-500",
  D: "bg-rose-500/15 text-rose-500",
  R: "bg-sky-500/15 text-sky-500",
  "?": "bg-emerald-500/15 text-emerald-500",
};

/** unified diff：一行一个 div，按前缀上色。 */
function DiffView({ text, truncated }: { text: string; truncated: boolean }) {
  if (!text.trim()) {
    return <p className="p-4 text-[12px] text-muted-foreground">这个文件没有可显示的差异</p>;
  }
  return (
    <div className="pb-4">
      <pre className="min-w-full font-mono text-[11.5px] leading-[1.55]">
        {text.split("\n").map((line, index) => (
          <div key={index} className={cn("whitespace-pre-wrap break-all px-3", lineClass(line))}>
            {line || " "}
          </div>
        ))}
      </pre>
      {truncated && (
        <p className="px-3 pt-2 text-[11px] text-muted-foreground">差异太大，只显示前 200KB</p>
      )}
    </div>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground";
  if (line.startsWith("@@")) return "bg-muted/40 text-sky-500";
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
  if (line.startsWith("-")) return "bg-rose-500/10 text-rose-600 dark:text-rose-300";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file"))
    return "text-muted-foreground";
  return "text-foreground/80";
}

/** 服务端把 `{"error": "..."}` 塞在状态码后面，拆出来给人看。 */
function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const match = /^\d+\s+(\{[\s\S]*\})$/.exec(text);
  if (match) {
    try {
      return (JSON.parse(match[1]!) as { error?: string }).error ?? text;
    } catch {
      return text;
    }
  }
  return text;
}
