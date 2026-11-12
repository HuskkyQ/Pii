import assert from "node:assert/strict";
import test from "node:test";

import {
  PICKER_EDGE,
  PICKER_GAP,
  PICKER_MAX_HEIGHT,
  PICKER_WIDTH,
  clampPickerLeft,
  desiredPickerLeft,
  pickerBottom,
  pickerMaxHeight,
  pickerVerticalPlacement,
  resolvePickerLeft,
} from "../src/lib/picker-position.ts";

test("常量是设计里约定的 360 / 8 / 12", () => {
  assert.equal(PICKER_WIDTH, 360);
  assert.equal(PICKER_GAP, 8);
  assert.equal(PICKER_EDGE, 12);
});

test("desiredPickerLeft：start 用 left，end 用 right - width", () => {
  const rect = { left: 100, right: 180 };
  assert.equal(desiredPickerLeft(rect, "start"), 100);
  assert.equal(desiredPickerLeft(rect, "end"), -180);
});

test("clampPickerLeft：普通视口不夹", () => {
  assert.equal(clampPickerLeft(100, 1280), 100);
});

test("clampPickerLeft：靠右时不溢出右边界", () => {
  assert.equal(clampPickerLeft(1200, 1280), 908);
});

test("clampPickerLeft：窄视口退回 EDGE", () => {
  assert.equal(clampPickerLeft(100, 320), 12);
});

test("pickerBottom：面板底边在按钮上方 8px", () => {
  assert.equal(pickerBottom(700, 800), 108);
});

test("resolvePickerLeft：组合 start / end", () => {
  const rect = { left: 100, right: 180 };
  assert.equal(resolvePickerLeft(rect, "start", 1280), 100);
  assert.equal(resolvePickerLeft(rect, "end", 1280), 12);
});

test("pickerMaxHeight：取 70dvh 与 520px 的较小值", () => {
  assert.equal(PICKER_MAX_HEIGHT, 520);
  assert.equal(pickerMaxHeight(800), 520);
  assert.equal(pickerMaxHeight(600), 420);
});

test("pickerVerticalPlacement：底部 chip 上方空间够，向上弹", () => {
  assert.deepEqual(pickerVerticalPlacement({ top: 767, bottom: 790 }, 800), { bottom: 41 });
});

test("pickerVerticalPlacement：侧栏顶部按钮上方不够，改向下弹", () => {
  assert.deepEqual(pickerVerticalPlacement({ top: 8, bottom: 36 }, 800), { top: 44 });
});

test("pickerVerticalPlacement：向下也放不下时夹在视口内", () => {
  const result = pickerVerticalPlacement({ top: 160, bottom: 188 }, 600);
  assert.deepEqual(result, { top: 172 });
});
