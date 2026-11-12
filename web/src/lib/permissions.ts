/**
 * 权限相关的常量与元数据。
 *
 * 形状和 4 个预设在 `shared/policies.ts`（后端也读同一份，不用再手动同步）。
 * 这个文件只剩「界面文案」：预设叫什么、每个工具中文说明、危险标记。
 */
import type { KnownTool, PresetId } from "@shared/policies";
import { PRESETS, presetOf } from "@shared/policies";

export { PRESETS, presetOf };

/** 预设档位的展示信息（顺序即 UI 顺序）。 */
export const PRESET_LIST: {
  id: Exclude<PresetId, "custom">;
  label: string;
  hint: string;
  danger?: boolean;
}[] = [
  { id: "ask-all", label: "逐个确认", hint: "4 个工具每次都问我" },
  { id: "read-only", label: "只读自动", hint: "read 免问，其余问我" },
  { id: "write-allowed", label: "改文件自动", hint: "read/write/edit 免问，仅 bash 问我" },
  { id: "all", label: "全部放行", hint: "都不问（危险，仅建议临时用）", danger: true },
];

/** chip / 标题上显示的短标签。 */
export const PRESET_LABEL: Record<PresetId, string> = {
  "ask-all": "逐个确认",
  "read-only": "只读自动",
  "write-allowed": "改文件自动",
  all: "全部放行",
  custom: "自定义",
};

/** 每个工具的中文名与风险说明（高级面板用）。 */
export const TOOL_META: Record<KnownTool, { label: string; hint: string; danger?: boolean }> = {
  read: { label: "read", hint: "读取文件" },
  write: { label: "write", hint: "新建 / 覆盖文件" },
  edit: { label: "edit", hint: "修改文件" },
  bash: { label: "bash", hint: "执行任意命令（最危险）", danger: true },
};
