/** 桌面浮层定位常量，与 spec 第 4.1 节一致。 */
export const PICKER_WIDTH = 360;
export const PICKER_GAP = 8;
export const PICKER_EDGE = 12;
export const PICKER_MAX_HEIGHT = 520;
export const PICKER_DVH_RATIO = 0.7;

export type PickerAlign = "start" | "end";

export function desiredPickerLeft(
  rect: { left: number; right: number },
  align: PickerAlign,
  width: number = PICKER_WIDTH,
): number {
  return align === "end" ? rect.right - width : rect.left;
}

export function clampPickerLeft(
  desired: number,
  viewportWidth: number,
  width: number = PICKER_WIDTH,
  edge: number = PICKER_EDGE,
): number {
  const maxLeft = Math.max(edge, viewportWidth - width - edge);
  return Math.max(edge, Math.min(desired, maxLeft));
}

export function resolvePickerLeft(
  rect: { left: number; right: number },
  align: PickerAlign,
  viewportWidth: number,
  width: number = PICKER_WIDTH,
  edge: number = PICKER_EDGE,
): number {
  return clampPickerLeft(desiredPickerLeft(rect, align, width), viewportWidth, width, edge);
}

export function pickerBottom(
  anchorTop: number,
  viewportHeight: number,
  gap: number = PICKER_GAP,
): number {
  return viewportHeight - anchorTop + gap;
}

export function pickerMaxHeight(viewportHeight: number): number {
  return Math.min(viewportHeight * PICKER_DVH_RATIO, PICKER_MAX_HEIGHT);
}

export type PickerVerticalPlacement = { bottom: number } | { top: number };

/**
 * 触发按钮靠近视口底部时向上弹（Composer 三个 chip）；
 * 靠近顶部时向下弹（会话侧栏「📁+」），否则面板会整块跑到视口上方。
 */
export function pickerVerticalPlacement(
  rect: { top: number; bottom: number },
  viewportHeight: number,
  gap: number = PICKER_GAP,
): PickerVerticalPlacement {
  const maxHeight = pickerMaxHeight(viewportHeight);
  if (rect.top >= maxHeight + gap) {
    return { bottom: pickerBottom(rect.top, viewportHeight, gap) };
  }
  const maxTop = Math.max(gap, viewportHeight - maxHeight - gap);
  return { top: Math.min(rect.bottom + gap, maxTop) };
}
