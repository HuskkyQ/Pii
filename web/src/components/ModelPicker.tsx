import { Check, ImageOff, Loader2, Search, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { listModels, setModel } from "@/lib/api";
import type { ModelOption } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ModelPickerProps {
  open: boolean;
  conversationId?: number;
  current?: { provider?: string; modelId?: string } | null;
  onClose: () => void;
  onPicked: () => void;
}

/**
 * 模型选择器：底部抽屉 + 搜索。
 *
 * 为什么是抽屉而不是下拉菜单：手机上 70 个模型的下拉列表根本点不准，
 * 抽屉能带搜索、能滚动、能用整块屏幕点。
 */
export function ModelPicker({ open, conversationId, current, onClose, onPicked }: ModelPickerProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listModels(conversationId)
      .then((data) => setModels(data.models))
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false));
    // 打开时聚焦搜索框：手机上少点一下
    setTimeout(() => inputRef.current?.focus(), 250);
  }, [open, conversationId]);

  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const filtered = keyword
      ? models.filter(
          (model) =>
            model.name.toLowerCase().includes(keyword) ||
            model.id.toLowerCase().includes(keyword) ||
            model.provider.toLowerCase().includes(keyword),
        )
      : models;

    const byProvider = new Map<string, ModelOption[]>();
    for (const model of filtered) {
      const list = byProvider.get(model.provider) ?? [];
      list.push(model);
      byProvider.set(model.provider, list);
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models, query]);

  async function pick(model: ModelOption) {
    const key = `${model.provider}/${model.id}`;
    const isCurrent = current?.provider === model.provider && current?.modelId === model.id;
    if (isCurrent) return onClose();

    setBusyKey(key);
    try {
      await setModel(model.provider, model.id, conversationId);
      toast.success(`已切到 ${model.name}`);
      onPicked();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[78dvh] flex-col rounded-t-2xl border-t bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-3">
          <span className="text-[13px] font-medium">切换模型</span>
          <span className="text-[11px] text-muted-foreground">{models.length} 个可用</span>
          <Button size="icon" variant="ghost" className="ml-auto size-8" onClick={onClose} aria-label="关闭">
            <X className="size-4" />
          </Button>
        </div>

        <div className="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-lg border bg-muted/40 px-2.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜模型名 / provider"
            className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
          {loading && (
            <div className="flex items-center gap-2 px-2 py-6 text-[12.5px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> 读取模型列表…
            </div>
          )}

          {!loading &&
            groups.map(([provider, list]) => (
              <div key={provider} className="mt-2">
                <div className="sticky top-0 z-10 bg-background/95 px-2 py-1 text-[11px] uppercase tracking-wider text-muted-foreground/70 backdrop-blur">
                  {provider}
                </div>
                {list.map((model) => {
                  const active = current?.provider === model.provider && current?.modelId === model.id;
                  const pending = busyKey === `${model.provider}/${model.id}`;
                  return (
                    <button
                      key={`${model.provider}/${model.id}`}
                      type="button"
                      onClick={() => void pick(model)}
                      className={cn(
                        "mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors",
                        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13px]">{model.name}</span>
                          {model.reasoning && (
                            <Sparkles className="size-3 shrink-0 text-amber-400/80" aria-label="支持思考" />
                          )}
                          {!model.image && (
                            <ImageOff className="size-3 shrink-0 text-muted-foreground/50" aria-label="不支持图片" />
                          )}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {model.id}
                          {model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k` : ""}
                        </span>
                      </span>
                      {pending ? (
                        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                      ) : (
                        active && <Check className="size-4 shrink-0" aria-hidden />
                      )}
                    </button>
                  );
                })}
              </div>
            ))}

          {!loading && groups.length === 0 && (
            <p className="px-2 py-8 text-center text-[12.5px] text-muted-foreground">没有匹配的模型</p>
          )}
        </div>
      </div>
    </div>
  );
}
