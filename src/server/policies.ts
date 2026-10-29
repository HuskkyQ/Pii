/**
 * 每个会话的工具审批策略。
 *
 * 背景：pi-durable 的 `beforeTool` hook 会让工具停在原地等用户点头（见 approvals.ts）。
 * 「每次都问」太烦，所以按会话配置一张「哪些工具自动放行」的表。
 *
 * 已知工具就 4 个：read / write / edit / bash。
 * 另留一个 allowUnknown：只有「全部放行」才会置 true，让以后新增的工具也自动；
 * 其它模式下未知工具一律走询问（fail-safe，宁可多问一句）。
 *
 * 持久化到 `conversation-policies.json` —— 和 titles / hidden 一样是纯文件：
 * 不改库表、不动 Harness，删掉文件就退回默认策略。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const KNOWN_TOOLS = ["read", "write", "edit", "bash"] as const;
export type KnownTool = (typeof KNOWN_TOOLS)[number];

export interface Policy {
  /** 每个已知工具是否「自动放行」（false = 每次询问） */
  auto: Record<KnownTool, boolean>;
  /** 未知/新工具是否也自动（仅「全部放行」为 true） */
  allowUnknown: boolean;
}

export type PresetId = "ask-all" | "read-only" | "write-allowed" | "all";

/** 4 个预设档位。前端有一份等价的副本（web/src/lib/permissions.ts），改这里记得同步。 */
export const PRESETS: Record<PresetId, Policy> = {
  "ask-all": { auto: { read: false, write: false, edit: false, bash: false }, allowUnknown: false },
  "read-only": { auto: { read: true, write: false, edit: false, bash: false }, allowUnknown: false },
  "write-allowed": { auto: { read: true, write: true, edit: true, bash: false }, allowUnknown: false },
  all: { auto: { read: true, write: true, edit: true, bash: true }, allowUnknown: true },
};

/** 没配过策略时的默认档：只读自动（read 免问，其余问）。与旧的 PII_AUTO_ALLOW=read 一致。 */
export const DEFAULT_PRESET: PresetId = "read-only";

const TITLES_FILE = "conversation-policies.json";

function clonePolicy(policy: Policy): Policy {
  return { auto: { ...policy.auto }, allowUnknown: policy.allowUnknown };
}

function samePolicy(a: Policy, b: Policy): boolean {
  if (a.allowUnknown !== b.allowUnknown) return false;
  return KNOWN_TOOLS.every((tool) => a.auto[tool] === b.auto[tool]);
}

/** 一个 policy 等价于哪个预设；都不等则 "custom"。 */
export function presetOf(policy: Policy): PresetId | "custom" {
  for (const id of Object.keys(PRESETS) as PresetId[]) {
    if (samePolicy(policy, PRESETS[id])) return id;
  }
  return "custom";
}

/**
 * 从 `PII_AUTO_ALLOW` 造默认策略，兼容老配置：
 *  - 未设置 → 只读自动（read-only）
 *  - 逗号分隔工具名（如 "read,edit"）；含 `*` 视为全部放行
 *  - 设为空串 → 全问（ask-all）
 */
export function defaultPolicy(env: string | undefined = process.env.PII_AUTO_ALLOW): Policy {
  if (env === undefined) return clonePolicy(PRESETS[DEFAULT_PRESET]);
  const names = env.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.includes("*")) return clonePolicy(PRESETS.all);
  const auto = { read: false, write: false, edit: false, bash: false } as Record<KnownTool, boolean>;
  for (const name of names) {
    if ((KNOWN_TOOLS as readonly string[]).includes(name)) auto[name as KnownTool] = true;
  }
  return { auto, allowUnknown: false };
}

/** 校验并归一化前端传来的 policy；格式不对返回 undefined。 */
export function normalizePolicy(raw: unknown): Policy | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as { auto?: unknown; allowUnknown?: unknown };
  if (!obj.auto || typeof obj.auto !== "object") return undefined;
  const autoRaw = obj.auto as Record<string, unknown>;
  const auto = { read: false, write: false, edit: false, bash: false } as Record<KnownTool, boolean>;
  for (const tool of KNOWN_TOOLS) {
    if (typeof autoRaw[tool] !== "boolean") return undefined;
    auto[tool] = autoRaw[tool] as boolean;
  }
  return { auto, allowUnknown: obj.allowUnknown === true };
}

function readAll(dataDir: string): Record<string, Policy> {
  const path = join(dataDir, TITLES_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, Policy> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const policy = normalizePolicy(value);
      if (policy) result[key] = policy;
    }
    return result;
  } catch {
    return {};
  }
}

function writeAll(dataDir: string, map: Record<string, Policy>): void {
  const sorted: Record<string, Policy> = {};
  for (const key of Object.keys(map).sort((a, b) => Number(a) - Number(b))) sorted[key] = map[key];
  writeFileSync(join(dataDir, TITLES_FILE), JSON.stringify(sorted, null, 2));
}

/** 会话策略表。启动时读一次，之后一直在内存里。 */
export class Policies {
  #dataDir: string;
  #map: Record<string, Policy>;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
    this.#map = readAll(dataDir);
  }

  /** 存过的策略；没存过返回 undefined（调用方用 effective 拿默认）。 */
  get(id: number): Policy | undefined {
    return this.#map[String(id)];
  }

  /** 该会话的有效策略：存过就用存的，否则用默认。 */
  effective(id: number): Policy {
    return this.#map[String(id)] ?? defaultPolicy();
  }

  set(id: number, policy: Policy): void {
    this.#map[String(id)] = clonePolicy(policy);
    writeAll(this.#dataDir, this.#map);
  }

  /** 会话被真删掉了，顺手把它的策略也划掉。 */
  forget(id: number): void {
    if (!(String(id) in this.#map)) return;
    delete this.#map[String(id)];
    writeAll(this.#dataDir, this.#map);
  }

  /** 给 broker 用：这个会话的这个工具是否自动放行。 */
  shouldAutoAllow(conversationId: number, tool: string): boolean {
    const policy = this.effective(conversationId);
    if ((KNOWN_TOOLS as readonly string[]).includes(tool)) return policy.auto[tool as KnownTool];
    return policy.allowUnknown;
  }
}
