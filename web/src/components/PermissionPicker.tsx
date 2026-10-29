import { Check, ChevronDown, Loader2, Shield, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PRESETS, PRESET_LIST, TOOL_META, presetOf } from "@/lib/permissions";
import { KNOWN_TOOLS, type KnownTool, type PresetId, type ToolPolicy } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PermissionPickerProps {
  open: boolean;
  /** 当前会话策略；null = 还在加载 */
  policy: ToolPolicy | null;
  preset: PresetId | null;
  onApply: (policy: ToolPolicy) => Promise<void>;
  onClose: () => void;
}

/**
 * 工具审批策略选择器（底部抽屉）。
 *
 * 上半部分是 4 个预设档位（点一下整体套用）；
 * 「高级」展开后是 4 个逐工具开关，可单独调（调完就不再等于任何预设，显示“自定义”）。
 *
 * 每次改动都立即落库（调 onApply → POST /api/policy），没有“保存”按钮。
 */
export function PermissionPicker({ open, policy, preset, onApply, onClose }: PermissionPickerProps) {
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  // 按当前 policy 推断预设（以本地 policy 为准，比服务端 preset 更实时）
  const currentPreset: PresetId = policy ? presetOf(policy) : (preset ?? "read-only");
  const danger = currentPreset === "all";

  async function apply(next: ToolPolicy) {
    if (busy) return;
    setBusy(true);
    try {
      await onApply(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新权限失败");
    } finally {
      setBusy(false);
    }
  }

  function toggleTool(tool: KnownTool) {
    if (!policy) return;
    // 手动逐工具时不再保留 allowUnknown（更安全：未知工具仍问）
    void apply({ auto: { ...policy.auto, [tool]: !policy.auto[tool] }, allowUnknown: false });
  }

  return (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[82dvh] flex-col rounded-t-2xl border-t bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-3">
          {danger ? (
            <ShieldAlert className="size-4 shrink-0 text-destructive" aria-hidden />
          ) : (
            <Shield className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="text-[13px] font-medium">工具执行权限</span>
          <span className="text-[11px] text-muted-foreground">只影响当前会话</span>
          <Button size="icon" variant="ghost" className="ml-auto size-8" onClick={onClose} aria-label="关闭">
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
          {!policy ? (
            <div className="flex items-center gap-2 px-2 py-6 text-[12.5px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> 读取当前权限…
            </div>
          ) : (
            <>
              <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wider text-muted-foreground/70">
                预设
              </div>
              {PRESET_LIST.map((item) => {
                const active = currentPreset === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void apply(PRESETS[item.id])}
                    disabled={busy}
                    className={cn(
                      "mt-0.5 flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors disabled:opacity-60",
                      active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                    )}
                  >
                    <span className="mt-0.5 shrink-0">
                      {active ? (
                        <Check className="size-4" aria-hidden />
                      ) : item.danger ? (
                        <ShieldAlert className="size-4 text-destructive/70" aria-hidden />
                      ) : (
                        <ShieldCheck className="size-4 text-muted-foreground/40" aria-hidden />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block text-[13px]", item.danger && "text-destructive")}>{item.label}</span>
                      <span className="block text-[11px] text-muted-foreground">{item.hint}</span>
                    </span>
                  </button>
                );
              })}

              {currentPreset === "custom" && (
                <div className="mx-2 mt-2 rounded-md bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
                  当前是「自定义」，不对应任何预设
                </div>
              )}

              {/* 高级：逐工具开关 */}
              <button
                type="button"
                onClick={() => setAdvanced((value) => !value)}
                className="mt-3 flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-accent/40"
              >
                <ChevronDown className={cn("size-3.5 transition-transform", advanced && "rotate-180")} aria-hidden />
                高级（逐工具）
              </button>

              {advanced && (
                <div className="mt-1 space-y-1 px-1">
                  {KNOWN_TOOLS.map((tool) => {
                    const auto = policy.auto[tool];
                    const meta = TOOL_META[tool];
                    return (
                      <div key={tool} className="flex items-center gap-2 rounded-md px-1.5 py-1.5">
                        <span className="min-w-0 flex-1">
                          <span className={cn("block font-mono text-[12.5px]", meta.danger && "text-destructive/90")}>
                            {meta.label}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">{meta.hint}</span>
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={auto}
                          aria-label={`${meta.label} 自动放行`}
                          onClick={() => toggleTool(tool)}
                          disabled={busy}
                          className={cn(
                            "relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-60",
                            auto ? "border-emerald-500/40 bg-emerald-500/80" : "border-border bg-muted",
                          )}
                        >
                          <span
                            className={cn(
                              "absolute top-0.5 size-[18px] rounded-full bg-white shadow transition-all",
                              auto ? "left-[24px]" : "left-0.5",
                            )}
                          />
                        </button>
                        <span className="w-8 shrink-0 text-right text-[11px] text-muted-foreground">
                          {auto ? "自动" : "询问"}
                        </span>
                      </div>
                    );
                  })}
                  <p className="px-1.5 pt-1 text-[10.5px] text-muted-foreground/70">
                    bash 自动 = 把 shell 交给它：能删文件、联网、写任意路径，务必谨慎。
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="shrink-0 border-t px-3 py-2.5">
          <Button className="w-full" onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    </div>
  );
}
