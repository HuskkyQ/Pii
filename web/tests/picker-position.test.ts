import assert from "node:assert/strict";
import test from "node:test";

import {
  PICKER_EDGE,
  PICKER_GAP,
  PICKER_WIDTH,
  clampPickerLeft,
  desiredPickerLeft,
  pickerBottom,
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
