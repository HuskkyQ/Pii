/**
 * 把 pi 自己的 `~/.pi/agent/models.json` 翻译成 pi-durable 能用的 `Models`。
 *
 * 为什么需要这一层：
 *   pi-coding-agent 内部有个 ModelRuntime 会读 models.json；
 *   pi-durable 是独立包，只认 pi-ai 的 `Models` 接口，所以要自己拼。
 *
 * 做法：
 *   models.json 的每个 provider → createProvider()
 *   + 对应 api 模块的 { stream, streamSimple }
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";

/** models.json 里的 api 名字 → pi-ai 的 api 模块（每个模块都导出 stream / streamSimple）。 */
const API_MODULES = {
  "openai-completions": "@earendil-works/pi-ai/api/openai-completions",
  "openai-responses": "@earendil-works/pi-ai/api/openai-responses",
  "anthropic-messages": "@earendil-works/pi-ai/api/anthropic-messages",
  "google-generative-ai": "@earendil-works/pi-ai/api/google-generative-ai",
  "mistral-conversations": "@earendil-works/pi-ai/api/mistral-conversations",
} as const;

type ApiId = keyof typeof API_MODULES;

interface RawModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
  cost?: Record<string, number>;
  thinkingLevelMap?: Record<string, string | null>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface RawProvider {
  api?: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  models?: RawModel[];
}

export interface ModelsFile {
  providers?: Record<string, RawProvider>;
}

/** models.json 的 apiKey 支持三种写法：字面量、"$ENV_VAR"、"!command"。 */
function resolveKey(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  if (spec.startsWith("$")) return process.env[spec.slice(1)];
  if (spec.startsWith("!")) return execSync(spec.slice(1), { encoding: "utf8" }).trim();
  return spec;
}

function agentModelsPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(dir, "models.json");
}

/** 读 models.json，把所有"自带 api + baseUrl"的 provider 注册进一个 Models。 */
export async function loadModels(path = agentModelsPath()): Promise<Models> {
  const file = JSON.parse(readFileSync(path, "utf8")) as ModelsFile;
  const models = createModels();

  for (const [providerId, raw] of Object.entries(file.providers ?? {})) {
    const providerApi = raw.api;
    if (!providerApi || !(providerApi in API_MODULES)) {
      // 没有 api 的 provider 需要逐个模型声明 api，这里先跳过（保持简单）
      process.stderr.write(`[provider] 跳过 ${providerId}：缺少可用的 api 字段\n`);
      continue;
    }
    if (!raw.baseUrl) {
      process.stderr.write(`[provider] 跳过 ${providerId}：缺少 baseUrl\n`);
      continue;
    }

    const apiModule = (await import(API_MODULES[providerApi as ApiId])) as {
      stream: unknown;
      streamSimple: unknown;
    };
    const apiKey = resolveKey(raw.apiKey);

    const provider = createProvider({
      id: providerId,
      name: providerId,
      baseUrl: raw.baseUrl,
      headers: raw.headers as never,
      auth: {
        apiKey: {
          name: `${providerId} API key`,
          async resolve() {
            return apiKey ? { auth: { apiKey } } : undefined;
          },
        },
      },
      api: {
        [providerApi]: { stream: apiModule.stream, streamSimple: apiModule.streamSimple },
      } as never,
      models: (raw.models ?? []).map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        api: (m.api ?? providerApi) as never,
        provider: providerId,
        baseUrl: m.baseUrl ?? raw.baseUrl!,
        input: (m.input ?? ["text"]) as never,
        reasoning: m.reasoning ?? false,
        contextWindow: m.contextWindow ?? 128_000,
        maxTokens: m.maxTokens ?? 8_192,
        cost: {
          input: m.cost?.input ?? 0,
          output: m.cost?.output ?? 0,
          cacheRead: m.cost?.cacheRead ?? 0,
          cacheWrite: m.cost?.cacheWrite ?? 0,
        },
        thinkingLevelMap: m.thinkingLevelMap as never,
        headers: m.headers as never,
        compat: m.compat as never,
      })) as never,
    });

    models.setProvider(provider);
  }

  return models;
}
