import { AlertTriangle, RotateCw } from "lucide-react";

/**
 * 「上一轮跑失败了」的提示条。
 *
 * 为什么必须有：模型不可达时（隧道断了 / key 失效 / 被限流），服务端不会往对话里写任何东西，
 * 用户看到的就是「消息发出去，永远没有回复」。这条横幅把真实原因摆出来，
 * 并且把「大概是哪类问题」翻译成人话。
 */
export function RunErrorBanner({
  error,
  onRetry,
}: {
  error: { taskId: number; message: string; reason?: string; at?: number } | null;
  onRetry?: () => void;
}) {
  if (!error) return null;

  const hint =
    error.reason === "model_error"
      ? "模型没有响应。常见原因：模型服务不可达（隧道断了 / Mac 睡了）、API key 失效、被限流。"
      : error.reason === "no_model"
        ? "这个会话选的模型不存在了，去底部切一个可用的模型。"
        : "这一轮没有跑完。";

  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-destructive">上一轮失败了</p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-destructive/80">{hint}</p>
          <p className="mt-1 break-words font-mono text-[10.5px] text-destructive/60">{error.message}</p>
        </div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-[11.5px] text-destructive transition-colors hover:bg-destructive/15"
          >
            <RotateCw className="size-3" aria-hidden />
            重试
          </button>
        )}
      </div>
    </div>
  );
}
