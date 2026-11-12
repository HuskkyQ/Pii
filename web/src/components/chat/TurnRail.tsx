import { cn } from "@/lib/utils";

/**
 * 左侧时间轴的竖线。
 *
 * 它是**整列**一条（由内容高度撑开），不是每轮一段 —— 段与段之间的缝会让
 * 时间轴看起来像断掉的虚线，反而更难看出「一共聊了多久」。
 */
export function TurnRailLine() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-3 left-[7.5px] hidden w-px bg-border/60 md:block"
    />
  );
}

/**
 * 一轮对话的左侧标记（时间轴上的一个点）。
 *
 * PC 才有：手机 390px 宽，让出 28px 给时间轴会让气泡明显变窄，得不偿失。
 * hover 时浮出这一轮的提问首行，点一下滚到那一轮 —— 就是「长会话里的目录」。
 */
export function TurnMarker({
  label,
  active,
  onJump,
}: {
  /** 这一轮的提问（截断后的一行）；空则不出点 */
  label: string;
  active: boolean;
  onJump: () => void;
}) {
  if (!label) return null;

  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={`跳到：${label}`}
      aria-current={active ? "true" : undefined}
      className="group absolute -left-7 top-2 hidden size-4 items-center justify-center md:flex"
    >
      <span
        className={cn(
          "size-2 rounded-full ring-2 ring-background transition-all",
          active
            ? "scale-125 bg-primary"
            : "bg-border group-hover:bg-muted-foreground group-hover:scale-110",
        )}
      />
      {/* hover 浮层：用 CSS 而不是 JS，鼠标扫过几十个点也不会触发 setState */}
      <span className="glass-strong pointer-events-none absolute left-5 top-1/2 hidden max-w-[220px] -translate-y-1/2 truncate rounded-md border px-2 py-1 text-[11px] whitespace-nowrap text-popover-foreground group-hover:block">
        {label}
      </span>
    </button>
  );
}
