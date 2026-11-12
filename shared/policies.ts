/**
 * 工具审批策略的**纯数据部分**（前后端共用）。
 *
 * 为什么单独拆出来：以前服务端 `src/server/policies.ts` 和前端
 * `web/src/lib/permissions.ts` 各写了一份 PRESETS / presetOf，
 * 「改一边记得同步」这种注释一忘就出事。现在形状和预设只有这一份。
 *
 * 留在服务端的（依赖 fs / 环境变量，前端用不上也不该知道）：
 *   clonePolicy / defaultPolicy / normalizePolicy / Policies 类 / conversation-policies.json 读写
 */

/** 已知工具就 4 个：read / write / edit / bash。 */
export const KNOWN_TOOLS = ["read", "write", "edit", "bash"] as const;
export type KnownTool = (typeof KNOWN_TOOLS)[number];

export interface Policy {
  /** 每个已知工具是否「自动放行」（false = 每次询问） */
  auto: Record<KnownTool, boolean>;
  /** 未知/新工具是否也自动（仅「全部放行」为 true，fail-safe） */
  allowUnknown: boolean;
}

/** 兼容前端旧名；新代码用 Policy。 */
export type ToolPolicy = Policy;

/**
 * 5 个档位里 `custom` 不是真实预设，而是「用户手动调过、哪档都不等于」的占位值
 * —— 界面上要显示「自定义」chip，所以它也算一种 PresetId。
 */
export type PresetId = "ask-all" | "read-only" | "write-allowed" | "all" | "custom";

/** 4 个真实预设。 */
export const PRESETS: Record<Exclude<PresetId, "custom">, Policy> = {
  "ask-all": { auto: { read: false, write: false, edit: false, bash: false }, allowUnknown: false },
  "read-only": { auto: { read: true, write: false, edit: false, bash: false }, allowUnknown: false },
  "write-allowed": { auto: { read: true, write: true, edit: true, bash: false }, allowUnknown: false },
  all: { auto: { read: true, write: true, edit: true, bash: true }, allowUnknown: true },
};

/** 没配过策略时的默认档：只读自动（read 免问，其余问）。与旧的 PII_AUTO_ALLOW=read 一致。 */
export const DEFAULT_PRESET: Exclude<PresetId, "custom"> = "read-only";

function samePolicy(a: Policy, b: Policy): boolean {
  if (a.allowUnknown !== b.allowUnknown) return false;
  return KNOWN_TOOLS.every((tool) => a.auto[tool] === b.auto[tool]);
}

/** 一个 policy 等价于哪个预设；都不等则 "custom"。 */
export function presetOf(policy: Policy): PresetId {
  for (const id of Object.keys(PRESETS) as Exclude<PresetId, "custom">[]) {
    if (samePolicy(policy, PRESETS[id])) return id;
  }
  return "custom";
}
