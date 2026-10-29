/**
 * 「正在加载更早的消息」的动效。
 *
 * 之前只有一个静态文字，加载时页面高度会突然跳一下，看起来生硬。
 * 这里做两件事：
 *   1. 占位块**和即将插入的内容同高**（几个骨架行），高度变化平滑
 *   2. 骨架块本身有呼吸动画，明确「在干活」
 */
export function LoadingOlder({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="space-y-3 pb-2" aria-busy="true" aria-label="正在加载更早的消息">
      <div className="flex justify-center">
        <span className="flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-[11.5px] text-muted-foreground">
          <span className="size-1.5 animate-ping rounded-full bg-muted-foreground/60" />
          正在加载更早的消息
        </span>
      </div>
      {[0, 1, 2].map((index) => (
        <div key={index} className="space-y-2 opacity-60">
          <div
            className="h-3 animate-pulse rounded bg-muted/50"
            style={{ width: `${88 - index * 12}%`, animationDelay: `${index * 120}ms` }}
          />
          <div
            className="h-3 animate-pulse rounded bg-muted/40"
            style={{ width: `${70 - index * 8}%`, animationDelay: `${index * 120 + 60}ms` }}
          />
        </div>
      ))}
    </div>
  );
}
