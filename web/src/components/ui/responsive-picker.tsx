import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  pickerVerticalPlacement,
  resolvePickerLeft,
  type PickerAlign,
  type PickerVerticalPlacement,
} from "@/lib/picker-position";
import { cn } from "@/lib/utils";

const DESKTOP_QUERY = "(min-width: 768px)";
/** 手机抽屉进/出时长，和会话列表的侧滑抽屉保持一致 */
const DRAWER_ANIM_MS = 260;
/** 桌面浮层小、离手近，动画要比抽屉快一截，不然会觉得「黏」 */
const POPOVER_ANIM_MS = 160;
/** 卸载留的余量：等动画真正播完再拆 DOM */
const UNMOUNT_SLACK_MS = 40;
/**
 * 三个手机抽屉的**统一高度**，只在这里定义一次。
 * 三个面板各传 82dvh / 78dvh / 78dvh 会让它们打开一下高一下矮，
 * 现在由外壳规定为固定 height（不是 max-height），内容区自己滚动，
 * 业务面板不再有「调高度」的权力，也就不会再跑偏。
 *
 * 取 40dvh：约为满屏四成 —— 手指从底边上滑就能摸到标题，
 * 上半屏还能看到对话上下文（弹框是为了选一个选项，不是读一篇长文）。
 */
const PICKER_SHEET_HEIGHT = "40dvh";

interface ResponsivePickerProps {
  open: boolean;
  anchor?: HTMLElement | null;
  align?: PickerAlign;
  label: string;
  onClose: () => void;
  children: (ctx: { isDesktop: boolean }) => ReactNode;
}

interface Viewport {
  width: number;
  height: number;
}

interface PanelLayout {
  left: number;
  vertical: PickerVerticalPlacement;
}

/**
 * 三个选择器共用的双端外壳 —— 目录 / 模型 / 权限**只提供内容**，
 * 定位、高度、遮罩、动画、Esc、焦点全在这里，一处改三个都生效。
 * 桌面：贴 anchor 的 360px 浮层；手机：统一高度的底部抽屉。
 */
export function ResponsivePicker({
  open,
  anchor,
  align = "start",
  label,
  onClose,
  children,
}: ResponsivePickerProps) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const lastAnchor = useRef<HTMLElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  /*
   * 进出场状态机（PC 浮层 / H5 抽屉共用）。
   *
   * 只要两个状态：mounted（还在不在 DOM 里）、closing（是不是在播退出）。
   * 动画本身交给 CSS @keyframes —— 元素一插入 DOM 就自动开播，
   * 不需要 JS 连等两帧去「先画收起态再切展开」，所以首次打开也不会被吞。
   * 关闭时先打上 closing 标记播 out 动画，播完再卸载。
   */
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  /** 与 mounted 同步的 ref：effect 里要立刻读到「面板是否还在 DOM 里」 */
  const mountedRef = useRef(false);

  const animMs = isDesktop ? POPOVER_ANIM_MS : DRAWER_ANIM_MS;

  useEffect(() => {
    // 系统要求减少动画：立刻同步，不播动画、不延迟卸载
    if (reduceMotion) {
      mountedRef.current = open;
      setMounted(open);
      setClosing(false);
      return;
    }
    if (open) {
      mountedRef.current = true;
      setMounted(true);
      // 关到一半又打开 / 跨断点切换：去掉 closing，animation-name 换回 in 重新播
      setClosing(false);
      return;
    }
    if (!mountedRef.current) return; // 本来就没挂载，没必要播退出
    setClosing(true);
    const timer = window.setTimeout(() => {
      mountedRef.current = false;
      setMounted(false);
      setClosing(false);
    }, animMs + UNMOUNT_SLACK_MS);
    return () => window.clearTimeout(timer);
  }, [open, reduceMotion, animMs]);

  // 减少动画时 open=false 立即卸载；否则两种形态都等退出动画播完
  const visible = reduceMotion ? open : mounted;

  useEffect(() => {
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const target = panelRef.current?.querySelector<HTMLElement>(
        'input, button, [tabindex]:not([tabindex="-1"])',
      );
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, isDesktop]);

  /*
   * App 关闭时会把 anchor 也清空。焦点归还用 ref（只在 effect 里读，没问题），
   * 但「退出动画这 160ms 里浮层该待在哪」是**渲染要用的值**，得放 state：
   * 读 ref 不会触发重渲染，位置可能停在旧值上不同步。
   */
  const [layoutAnchor, setLayoutAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (open && anchor) {
      lastAnchor.current = anchor;
      setLayoutAnchor(anchor);
    }
  }, [open, anchor]);

  useEffect(() => {
    // App 关闭时会把 anchor 也清空，所以要用上一次记下来的按钮归还焦点。
    // 放到下一帧：等浏览器处理完 Esc / 点击的默认行为，再抢回焦点。
    if (wasOpen.current && !open) {
      const target = lastAnchor.current;
      requestAnimationFrame(() => target?.focus());
    }
    wasOpen.current = open;
  }, [open]);

  const layout = useMemo<PanelLayout | null>(() => {
    if (!visible || !isDesktop) return null;
    // 关闭时 anchor 已变 null，用上一次记下的按钮继续定位，
    // 否则会突然掉到「居中兜底」那个分支，浮层会在消失前跳一下。
    const rect = (anchor ?? layoutAnchor)?.getBoundingClientRect();
    const valid =
      rect !== undefined &&
      (rect.width > 0 || rect.height > 0 || rect.left !== 0 || rect.top !== 0);
    if (!rect || !valid) return null;
    return {
      left: resolvePickerLeft(rect, align, viewport.width),
      vertical: pickerVerticalPlacement(rect, viewport.height),
    };
  }, [visible, isDesktop, anchor, layoutAnchor, align, viewport.width, viewport.height]);

  const content = children({ isDesktop });

  if (!visible) return null;

  const inner = <div className="flex min-h-0 flex-1 flex-col">{content}</div>;
  const panelClass =
    "glass-strong flex max-h-[min(70dvh,520px)] w-[360px] max-w-[calc(100vw-24px)] flex-col rounded-xl border";

  /*
   * 整层只挂两个东西：动画时长（CSS 变量）和 closing 标记。
   * 三个弹框因此天然「同一套动画、同一个高度」，业务组件什么都管不着。
   */
  const shellProps = {
    "data-picker-closing": closing ? "true" : undefined,
    style: { "--picker-dur": `${animMs}ms` } as CSSProperties,
  };
  // 缩放锚点选「靠着触发按钮的那一角」：浮层在按钮上方就从下缘长，
  // 在按钮下方就从上缘长；左右跟着 align 走。
  const originY = layout && "bottom" in layout.vertical ? "bottom" : "top";
  const originX = align === "end" ? "right" : "left";

  if (isDesktop) {
    return (
      <div {...shellProps} className={cn("fixed inset-0 z-[70]", closing && "pointer-events-none")}>
        <div className="absolute inset-0 z-[69] bg-transparent" onClick={onClose} aria-hidden />
        {layout ? (
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            style={{ left: layout.left, ...layout.vertical, transformOrigin: `${originY} ${originX}` }}
            className={cn(`fixed z-[70] ${panelClass}`, "picker-pop")}
          >
            {inner}
          </div>
        ) : (
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className={cn(
              `fixed left-1/2 top-1/2 z-[70] -translate-x-1/2 -translate-y-1/2 ${panelClass}`,
              "picker-pop",
            )}
          >
            {inner}
          </div>
        )}
      </div>
    );
  }

  return (
    <div {...shellProps} className={cn("fixed inset-0 z-[70]", closing && "pointer-events-none")}>
      {/* 遮罩：和抽屉同一个 --picker-dur，谁也不先走 */}
      <div className="picker-mask absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={{ height: PICKER_SHEET_HEIGHT }}
        className="picker-sheet glass-strong absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl border-t pb-[env(safe-area-inset-bottom)]"
      >
        {inner}
      </div>
    </div>
  );
}
