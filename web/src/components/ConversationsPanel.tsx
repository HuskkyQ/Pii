import { FolderPlus, Loader2, MessageSquare, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ConversationSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ListProps {
  items: ConversationSummary[];
  activeId?: number;
  onSelect: (id: number) => void;
  onCreate: () => void;
  /** 新建会话后立刻弹出目录选择（选在哪个项目里干活） */
  onCreateWithCwd?: (anchor: HTMLElement) => void;
  creating: boolean;
  onDelete?: (id: number) => Promise<void>;
}

interface PanelProps extends ListProps {
  open: boolean;
  onClose: () => void;
}

/** 会话列表本体：桌面侧栏和手机抽屉共用同一份。 */
function ConversationList({ items, activeId, onSelect, onCreate, onCreateWithCwd, creating, onDelete }: ListProps) {
  // 两段式确认：第一下只把这一行变成「确认删除？」，第二下才真删。
  // 比 window.confirm 好在：不用弹窗、手指不用来回移动、误触也能退出。
  const [pending, setPending] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 py-2 pl-3 pr-2">
        <span className="flex-1 text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground/70">
          会话
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={(event) => onCreateWithCwd?.(event.currentTarget)}
          disabled={creating || !onCreateWithCwd}
          aria-label="新建会话并选目录"
          title="新建会话并选项目目录"
        >
          <FolderPlus className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={onCreate}
          disabled={creating}
          aria-label="新建会话"
          title="新建会话（沿用当前目录）"
        >
          {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-4" />}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
        {items.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">还没有会话</p>
        )}
        {items.map((item) => {
          const active = item.id === activeId;
          const canDelete = Boolean(onDelete);

          if (pending === item.id) {
            return (
              <div
                key={item.id}
                className="mt-0.5 flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-destructive">删除「{item.title}」？</span>
                <button
                  type="button"
                  onClick={() => {
                    setPending(null);
                    if (!onDelete) return;
                    setDeleting(item.id);
                    void onDelete(item.id).finally(() => setDeleting(null));
                  }}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[12px] font-medium text-destructive hover:bg-destructive/15"
                >
                  删除
                </button>
                <button
                  type="button"
                  onClick={() => setPending(null)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-accent"
                >
                  取消
                </button>
              </div>
            );
          }

          return (
            <div key={item.id} className="group/row relative">
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "mt-0.5 flex w-full items-center gap-2 rounded-md py-2 pl-2 text-left text-[13px] transition-colors",
                  // 给右侧的垃圾桶留 32px：不留的话长标题会被图标压住最后两个字。
                  // 所有行都留（而不是只给选中行），这样每行截断位置一致，切换会话时
                  // 标题不会左右跳一下。
                  canDelete ? "pr-8" : "pr-2",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground/80 hover:bg-accent/60 hover:text-accent-foreground",
                )}
              >
                <MessageSquare className="size-3.5 shrink-0 opacity-55" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.busy && (
                  <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-label="运行中" />
                )}
              </button>

              {/*
               * 不能用普通按钮兄弟节点：一行只有一个 <button> 才不会嵌套按钮，
               * 所以删除按钮绝对定位盖在行右侧 —— 上面那个 pr-8 就是给它留的位。
               *
               * 选中行常显（手机上点一下就选中，接着就能删）；其他行只在鼠标悬停时
               * 现身 —— 平时藏着不抢戏，也避免误点到一行右下角就弹出删除确认。
               */}
              {canDelete && (
                <button
                  type="button"
                  onClick={() => setPending(item.id)}
                  disabled={deleting === item.id}
                  aria-label="删除这个会话"
                  title="删除这个会话"
                  className={cn(
                    "absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/50 transition-opacity hover:bg-destructive/15 hover:text-destructive",
                    active
                      ? "opacity-100"
                      : "pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
                  )}
                >
                  {deleting === item.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/*
       * 版本戳。排查「手机上是不是旧版」时不用再跑去查接口：
       * __BUILD__ 是 vite 构建时注入的 UTC 时间，换算成本地时间看一眼就知道。
       */}
      <div className="shrink-0 border-t border-border/40 px-3 py-2 font-mono text-[11px] text-muted-foreground/70">
        {typeof __BUILD__ === "string" ? new Date(`${__BUILD__}Z`).toLocaleString("zh-CN", { hour12: false }) : "dev"}
      </div>
    </div>
  );
}

/** 抽屉进出场时长（毫秒）。位移和遮罩淡入淡出共用，改这里两边一起变。 */
const DRAWER_ANIM_MS = 260;

/**
 * 桌面：左侧固定栏。手机：从左边滑出的抽屉（点遮罩关闭）。
 *
 * 不做路由：一个 `?c=<id>` 就够表达「我在看哪个会话」，
 * 刷新页面也不会丢，还省掉一个 router 依赖。
 */
export function ConversationsPanel({ open, onClose, ...list }: PanelProps) {
  // 进出场动画：open 变 true 先挂载、下一帧再切到「展开」触发过渡；
  // 变 false 先切回「收起」，等动画播完再卸载，避免生硬地一闪就没。
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // 连等两帧：第一帧把「收起」样式真正画出来，第二帧再切到「展开」，
      // 否则 React 可能把两步合到一次绘制里，transition 不触发。
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), DRAWER_ANIM_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <>
      <aside className="hidden w-60 shrink-0 border-r md:block">
        <ConversationList {...list} />
      </aside>

      {mounted && (
        <div className={cn("fixed inset-0 z-50 md:hidden", !shown && "pointer-events-none")}>
          <div
            className={cn(
              "absolute inset-0 bg-black/45 transition-opacity ease-out motion-reduce:transition-none",
              shown ? "opacity-100" : "opacity-0",
            )}
            style={{ transitionDuration: `${DRAWER_ANIM_MS}ms` }}
            onClick={onClose}
            aria-hidden
          />
          <div
            className={cn(
              "absolute inset-y-0 left-0 flex w-[78%] max-w-[300px] flex-col border-r bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-xl transition-transform ease-out will-change-transform motion-reduce:transition-none",
              shown ? "translate-x-0" : "-translate-x-full",
            )}
            style={{ transitionDuration: `${DRAWER_ANIM_MS}ms` }}
          >
            <div className="flex shrink-0 justify-end px-2 pt-2">
              <Button size="icon" variant="ghost" className="size-8" onClick={onClose} aria-label="关闭">
                <X className="size-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <ConversationList
                {...list}
                onSelect={(id) => {
                  list.onSelect(id);
                  onClose();
                }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
