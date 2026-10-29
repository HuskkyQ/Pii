/**
 * 权限相关的常量与元数据。
 *
 * PRESETS 必须与服务端 `src/server/policies.ts` 保持一致 —— 改那边记得同步这里。
 * 后端才是执行时的唯一真相，这里只用于渲染和把用户选择转成 policy。
 */
import type { KnownTool, PresetId, ToolPolicy } from "@/lib/types";

export const PRESETS: Record<Exclude<PresetId, "custom">, ToolPolicy> = {
  "ask-all": { auto: { read: false, write: false, edit: false, bash: false }, allowUnknown: false },
  "read-only": { auto: { read: true, write: false, edit: false, bash: false }, allowUnknown: false },
  "write-allowed": { auto: { read: true, write: true, edit: true, bash: false }, allowUnknown: false },
  all: { auto: { read: true, write: true, edit: true, bash: true }, allowUnknown: true },
};

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

/** 判断一个 policy 等价于哪个预设；都不等则 "custom"。与后端逻辑一致。 */
export function presetOf(policy: ToolPolicy): PresetId {
  for (const id of Object.keys(PRESETS) as Exclude<PresetId, "custom">[]) {
    const preset = PRESETS[id];
    if (preset.allowUnknown !== policy.allowUnknown) continue;
    if ((Object.keys(preset.auto) as KnownTool[]).every((tool) => preset.auto[tool] === policy.auto[tool])) {
      return id;
    }
  }
  return "custom";
}
