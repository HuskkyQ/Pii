import { ArrowUp, FolderOpen, ImagePlus, Loader2, Pause, Shield, ShieldAlert, X, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { abort, listModels, prompt } from "@/lib/api";
import { fileToImagePart, imageSrc, type ImagePart } from "@/lib/image";
import { PRESET_LABEL } from "@/lib/permissions";
import type { ModelOption, PresetId } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ComposerProps {
  running: boolean;
  disabled?: boolean;
  /** 当前会话；没解析出来（首屏还没拿到快照）时先发到 root */
  conversationId?: number;
  /** 快照里的模型（会话切换后会变） */
  model?: { provider?: string; modelId?: string } | null;
  /** 当前会话的工作目录 */
  cwd?: string;
  onSent?: () => void;
  onOpenModels: () => void;
  onOpenCwd: () => void;
  /** 打开权限面板 */
  onOpenPermissions: () => void;
  /** 当前会话的权限预设（决定 chip 文案/颜色）；null = 未加载 */
  permissionPreset?: PresetId | null;
  /** 被引用的原文（点了某条消息的引用按钮） */
  quote?: string | null;
  onClearQuote?: () => void;
}

const MAX_IMAGES = 4;

/** 输入框。Enter 发送，Shift+Enter 换行；运行中显示「停止」。 */
export function Composer({
  running,
  disabled,
  conversationId,
  model,
  cwd,
  onSent,
  onOpenModels,
  onOpenCwd,
  onOpenPermissions,
  permissionPreset,
  quote,
  onClearQuote,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImagePart[]>([]);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capability, setCapability] = useState<ModelOption | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 只为了两件事：显示模型名、判断它能不能看图
  useEffect(() => {
    let cancelled = false;
    listModels(conversationId)
      .then((data) => {
        if (cancelled) return;
        const { provider, modelId } = data.current ?? {};
        next: {
          const found = data.models.find((m) => m.provider === provider && m.id === modelId);
          if (found) {
            setCapability(found);
            break next;
          }
          setCapability(null);
        }
      })
      .catch(() => {
        /* 拿不到就按未知处理，不影响发消息 */
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, model?.provider, model?.modelId]);

  const supportsImages = capability?.image ?? true;

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      toast.error(`最多 ${MAX_IMAGES} 张图`);
      return;
    }
    setPreparing(true);
    try {
      const picked = [...files].filter((file) => file.type.startsWith("image/")).slice(0, room);
      const parts = await Promise.all(picked.map((file) => fileToImagePart(file)));
      setImages((prev) => [...prev, ...parts]);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "图片处理失败");
    } finally {
      setPreparing(false);
    }
  }

  const send = useCallback(
    async (mode: "followUp" | "steer" = "followUp") => {
      const value = text.trim();
      if ((!value && images.length === 0) || busy) return;
      setBusy(true);
      setError(null);
      try {
        // 引用做成 markdown 引用块：模型看得见、历史里也读得懂，还不用改存储结构
        const quoted = quote ? `${quote.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : "";
        await prompt(quoted + value, conversationId, undefined, images, mode);
        setText("");
        setImages([]);
        onClearQuote?.();
        onSent?.();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy, conversationId, images, onClearQuote, onSent, quote, text],
  );

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      // 运行中回车 = 排队（followUp）；空闲时也走 followUp（等价普通发送）
      void send("followUp");
    }
  }

  const hasInput = text.trim().length > 0 || images.length > 0;
  const canSend = hasInput && !busy && !disabled;
  // 运行中且输入框为空 → 显示“暂停”按钮；有文本 → 显示发送/插队
  const showPause = !!running && !hasInput;
  const dangerPreset = permissionPreset === "all";

  return (
    <div className="border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div className="mx-auto w-full max-w-[860px] px-3 py-2.5 sm:px-4">
        {images.length > 0 && (
          <div className="allow-x-pan mb-2 flex gap-2 overflow-x-auto pb-0.5">
            {images.map((image, index) => (
              <div key={index} className="relative shrink-0">
                <img
                  src={imageSrc(image)}
                  alt={`待发送图片 ${index + 1}`}
                  className="size-16 rounded-lg border object-cover"
                />
                <button
                  type="button"
                  onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                  aria-label="移除这张图"
                  className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border bg-background text-foreground shadow-sm"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {preparing && (
              <div className="grid size-16 shrink-0 place-items-center rounded-lg border text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
              </div>
            )}
          </div>
        )}

        {quote && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-primary/60 bg-muted/40 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="text-[10.5px] text-muted-foreground">引用</div>
              <p className="line-clamp-2 whitespace-pre-wrap text-[12px] text-foreground/80">{quote}</p>
            </div>
            <button
              type="button"
              onClick={onClearQuote}
              aria-label="取消引用"
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {/* 文件夹位置：放在输入框左上方 */}
        <div className="mb-1 flex items-center">
          <button
            type="button"
            onClick={onOpenCwd}
            title={cwd ?? "选择工作目录"}
            className="flex min-w-0 items-center gap-1 rounded-full px-1 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-accent-foreground"
          >
            <FolderOpen className="size-3 shrink-0" aria-hidden />
            <span className="max-w-[240px] truncate">{cwd ?? "选择工作目录"}</span>
          </button>
        </div>

        {/* 输入区：一个可见的框（border + 稍亮的底），聚焦时描边高亮 */}
        <div
          className={cn(
            "flex items-end gap-1.5 rounded-2xl border border-border bg-card/60 px-1.5 py-1.5",
            "transition-colors focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/15",
          )}
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = ""; // 同一张图连选两次也要能触发
            }}
          />
          <Button
            size="icon"
            variant="ghost"
            className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            onClick={() => fileRef.current?.click()}
            disabled={disabled || preparing || !supportsImages}
            aria-label={supportsImages ? "上传图片" : "当前模型不支持图片"}
            title={supportsImages ? "上传图片" : "当前模型不支持图片"}
          >
            <ImagePlus className="size-[18px]" />
          </Button>

          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              disabled
                ? "正在连接…（连上才能发送）"
                : running
                  ? "它正在跑：回车排队，⚡ 可插队…"
                  : "说点什么…"
            }
            rows={1}
            disabled={disabled}
            /* 自增高：最多 5 行，再多就内部滚动 */
            className="max-h-[132px] min-h-[36px] min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] leading-snug outline-none placeholder:text-muted-foreground disabled:opacity-60"
            style={{ fieldSizing: "content" } as React.CSSProperties}
          />

          {showPause ? (
            <Button
              size="icon"
              onClick={() => void abort(conversationId)}
              aria-label="暂停"
              title="暂停（中止当前生成）"
              className="size-9 shrink-0 rounded-full bg-destructive text-white shadow-sm transition-transform active:scale-95"
            >
              <Pause className="size-4 fill-current" />
            </Button>
          ) : (
            <>
              {running && hasInput && (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => void send("steer")}
                  disabled={!canSend}
                  aria-label="插队"
                  title="插队：打断当前回合，立即处理这条"
                  className="size-9 shrink-0 rounded-full text-amber-500 hover:text-amber-400"
                >
                  <Zap className="size-4" />
                </Button>
              )}
              <Button
                size="icon"
                onClick={() => void send("followUp")}
                disabled={!canSend}
                aria-label="发送"
                title={running ? "发送到队列（排队）" : "发送"}
                className={cn(
                  "size-9 shrink-0 rounded-full shadow-sm transition-all active:scale-95",
                  canSend
                    ? "bg-foreground text-background hover:bg-foreground/90"
                    : "bg-muted text-muted-foreground/50 shadow-none",
                )}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" strokeWidth={2.5} />}
              </Button>
            </>
          )}
        </div>

        {/* 底栏：权限在最左，模型在最右（文件夹已挪到输入框上方） */}
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenPermissions}
            title="工具执行权限（按会话）"
            className={cn(
              "flex min-w-0 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] transition-colors hover:bg-accent/60 hover:text-accent-foreground",
              dangerPreset ? "border-destructive/40 text-destructive" : "border-border/70 text-muted-foreground",
            )}
          >
            {dangerPreset ? (
              <ShieldAlert className="size-3 shrink-0" aria-hidden />
            ) : (
              <Shield className="size-3 shrink-0" aria-hidden />
            )}
            <span className="max-w-[120px] truncate">
              {permissionPreset ? PRESET_LABEL[permissionPreset] : "权限"}
            </span>
          </button>

          {disabled ? (
            <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-[11px] text-amber-400/90">
              <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
              连接中，暂时发不出去
            </span>
          ) : error ? (
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-destructive">{error}</span>
          ) : (
            <div className="flex-1" />
          )}

          <span className="hidden shrink-0 text-[11px] text-muted-foreground/50 sm:block">
            Enter 发送 · Shift+Enter 换行
          </span>

          <button
            type="button"
            onClick={onOpenModels}
            className="flex min-w-0 shrink-0 items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-accent-foreground"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-emerald-500/80" aria-hidden />
            <span className="max-w-[160px] truncate">
              {capability?.name ?? model?.modelId ?? "选择模型"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
