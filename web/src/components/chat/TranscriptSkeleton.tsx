/**
 * 首屏骨架。
 *
 * 为什么需要：快照到达之前（连接中 + 拉数据）以前是一片空白，
 * 手机上体验就是「白屏 → 黑屏 → 内容」三段跳。骨架让三段变成一段：
 * 一进来就是深色底 + 几个灰块，然后原地替换成真内容。
 */
export function TranscriptSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[860px] space-y-5 px-4 py-5" aria-busy="true" aria-label="加载中">
      <div className="flex justify-end">
        <div className="h-9 w-2/5 animate-pulse rounded-2xl rounded-br-sm bg-muted/60" />
      </div>
      <div className="space-y-2">
        <div className="h-3.5 w-11/12 animate-pulse rounded bg-muted/50" />
        <div className="h-3.5 w-10/12 animate-pulse rounded bg-muted/50" />
        <div className="h-3.5 w-7/12 animate-pulse rounded bg-muted/50" />
      </div>
      <div className="flex justify-end">
        <div className="h-9 w-1/3 animate-pulse rounded-2xl rounded-br-sm bg-muted/60" />
      </div>
      <div className="space-y-2">
        <div className="h-3.5 w-9/12 animate-pulse rounded bg-muted/50" />
        <div className="h-3.5 w-11/12 animate-pulse rounded bg-muted/50" />
        <div className="h-3.5 w-6/12 animate-pulse rounded bg-muted/50" />
      </div>
      <div className="flex items-center gap-2 pt-2 text-[12px] text-muted-foreground/60">
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.2s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.1s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50" />
        <span className="ml-1">正在连接…</span>
      </div>
    </div>
  );
}
