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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "../atomic-file.ts";

import { loadConfig } from "../config.ts";

/*
 * 形状和预设住在 shared/policies.ts（前端也要用同一份）。
 * 这里 re-export 保持 `./policies.ts` 的旧 import 继续可用；
 * 下面只留真正依赖 fs / 环境变量的部分。
 */
import { KNOWN_TOOLS, PRESETS, DEFAULT_PRESET, type KnownTool, type Policy } from "../../shared/policies.ts";
export {
  KNOWN_TOOLS,
  PRESETS,
  DEFAULT_PRESET,
  presetOf,
  type KnownTool,
  type Policy,
  type PresetId,
  type ToolPolicy,
} from "../../shared/policies.ts";

/** 存策略的文件名。老名字叫 TITLES_FILE（复制来的），其实是 policy —— 顺手改名。 */
const POLICIES_FILE = "conversation-policies.json";

function clonePolicy(policy: Policy): Policy {
  return { auto: { ...policy.auto }, allowUnknown: policy.allowUnknown };
}

/**
 * 从 `PII_AUTO_ALLOW` 造默认策略，兼容老配置：
 *  - 未设置 → 只读自动（read-only）
 *  - 逗号分隔工具名（如 "read,edit"）；含 `*` 视为全部放行
 *  - 设为空串 → 全问（ask-all）
 *
 * 注意：这里的「未设置」走 `DEFAULT_PRESET`；而 `ApprovalBroker` 构造函数里
 * 对同一个变量的「未设置」走 `?? "read"` —— 两处语义不同，不要合并成一个默认值。
 */
export function defaultPolicy(env: string | undefined = loadConfig().autoAllowEnv): Policy {
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
  const path = join(dataDir, POLICIES_FILE);
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
  writeJsonAtomic(join(dataDir, POLICIES_FILE), sorted);
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
