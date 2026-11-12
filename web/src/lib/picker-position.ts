/** 桌面浮层定位常量，与 spec 第 4.1 节一致。 */
export const PICKER_WIDTH = 360;
export const PICKER_GAP = 8;
export const PICKER_EDGE = 12;

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
