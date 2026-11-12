import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useMediaQuery } from "@/hooks/useMediaQuery";
import { pickerBottom, resolvePickerLeft, type PickerAlign } from "@/lib/picker-position";

const DESKTOP_QUERY = "(min-width: 768px)";

interface ResponsivePickerProps {
  open: boolean;
  anchor?: HTMLElement | null;
  align?: PickerAlign;
  label: string;
  mobileMaxHeight?: string;
  onClose: () => void;
  children: (ctx: { isDesktop: boolean }) => ReactNode;
}

interface Viewport {
  width: number;
  height: number;
}

interface PanelLayout {
  left: number;
  bottom: number;
}

/**
 * 三个选择器共用的双端外壳。
 * 桌面：贴 anchor 的 360px 浮层 + 透明点击层；手机：原样底部抽屉。
 */
export function ResponsivePicker({
  open,
  anchor,
  align = "start",
  label,
  mobileMaxHeight = "82dvh",
  onClose,
  children,
}: ResponsivePickerProps) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const [viewport, setViewport] = useState<Viewport>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

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

  useEffect(() => {
    if (wasOpen.current && !open) anchor?.focus();
    wasOpen.current = open;
  }, [open, anchor]);

  const layout = useMemo<PanelLayout | null>(() => {
    if (!open || !isDesktop) return null;
    const rect = anchor?.getBoundingClientRect();
    const valid =
      rect !== undefined &&
      (rect.width > 0 || rect.height > 0 || rect.left !== 0 || rect.top !== 0);
    if (!rect || !valid) return null;
    return {
      left: resolvePickerLeft(rect, align, viewport.width),
      bottom: pickerBottom(rect.top, viewport.height),
    };
  }, [open, isDesktop, anchor, align, viewport.width, viewport.height]);

  const content = children({ isDesktop });

  if (!open) return null;

  const inner = <div className="flex min-h-0 flex-1 flex-col">{content}</div>;
  const panelClass =
    "flex max-h-[min(70dvh,520px)] w-[360px] max-w-[calc(100vw-24px)] flex-col rounded-xl border bg-background shadow-2xl";

  if (isDesktop) {
    return (
      <div className="fixed inset-0 z-[70]">
        <div className="absolute inset-0 z-[69] bg-transparent" onClick={onClose} aria-hidden />
        {layout ? (
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            style={{ left: layout.left, bottom: layout.bottom }}
            className={`fixed z-[70] ${panelClass}`}
          >
            {inner}
          </div>
        ) : (
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className={`fixed left-1/2 top-1/2 z-[70] -translate-x-1/2 -translate-y-1/2 ${panelClass}`}
          >
            {inner}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={{ maxHeight: mobileMaxHeight }}
        className="absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl border-t bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl"
      >
        {inner}
      </div>
    </div>
  );
}
