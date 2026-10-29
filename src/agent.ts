/**
 * 打开 pii 的 agent：一个常驻的 pi-durable Harness + 一个 root conversation。
 *
 * 关键点：
 *  - 存储用 SQLite，落在 `~/.pii/agent.sqlite`（可用 PII_DATA_DIR 覆盖）
 *  - root conversation 是"第一次调用创建，重启后还是同一个"
 *  - 同一个 storage 只能被一个进程持有，所以 server 必须单实例
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { type Conversation, Harness, type Storage, createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { loadModels } from "./provider.ts";
import type { ApprovalBroker } from "./server/approvals.ts";
import type { PushHub } from "./server/push.ts";
import { approvalExtension } from "./tools/approval.ts";
import { notifyExtension } from "./tools/notify.ts";

export interface AgentOptions {
  /** 数据目录；默认 ~/.pii */
  dataDir?: string;
  provider?: string;
  modelId?: string;
  /** 阶段 2 默认开启工具；PII_TOOLS=0 关闭。 */
  tools?: boolean;
  /** 工作目录（bash/read/write 的根）；默认 PII_CWD 或启动目录 */
  cwd?: string;
  /** 工具审批中转站。传了就装上审批扩展；不传则工具裸跑。 */
  approvals?: ApprovalBroker;
  /** Web Push 推送中心。传了就在「回答完成」时推一条。 */
  push?: PushHub;
  /** 会话标题查询（推送通知的标题用） */
  titleOf?: (conversationId: number) => string | undefined;
  /** 思考等级；不传沿用会话里已存的值。 */
  thinkingLevel?: string;
}

export interface Agent {
  harness: Harness;
  root: Conversation;
  /** 模型目录（来自 models.json）。切模型要先能列出来。 */
  models: Models;
  /** 原始存储句柄：会话列表要 scanConversations，那是 Storage 层的能力，Harness 不暴露。 */
  storage: Storage;
  provider: string;
  modelId: string;
  dbPath: string;
  /** 默认工作目录（新建会话会继承） */
  cwd: string;
}

/**
 * agent 干活用的工作目录 —— bash / read / write 的根。
 *
 * 默认是「启动 npm start 时所处的目录」，可以用 PII_CWD 指定；
 * 每个会话还能单独改（`POST /api/cwd`），改完只影响那一个会话。
 */
export function resolveCwd(override?: string): string {
  return override ?? process.env.PII_CWD ?? process.cwd();
}

export function resolveDataDir(override?: string): string {
  return override ?? process.env.PII_DATA_DIR ?? join(homedir(), ".pii");
}

export async function openAgent(options: AgentOptions = {}): Promise<Agent> {
  const provider = options.provider ?? process.env.PII_PROVIDER ?? "magpie";
  const modelId = options.modelId ?? process.env.PII_MODEL ?? "workbuddy/deepseek-v4.1-flash";
  const withTools = options.tools ?? process.env.PII_TOOLS !== "0";
  const cwd = resolveCwd(options.cwd);
  const dbPath = join(resolveDataDir(options.dataDir), "agent.sqlite");

  const models = await loadModels();
  if (!models.getModel(provider, modelId)) {
    throw new Error(`找不到模型 ${provider}/${modelId}，检查 ~/.pi/agent/models.json`);
  }

  const registry = createRegistry();
  if (withTools) registry.install(CodingTools);
  if (withTools && options.approvals) registry.install(approvalExtension(options.approvals));
  if (options.push) {
    registry.install(notifyExtension(options.push, { titleOf: options.titleOf ?? (() => undefined) }));
  }

  const storage = await openNodeSqliteStorage(dbPath);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      ...(withTools
        ? { env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) }
        : {}),
    },
    BACKGROUND_CONTEXT,
  );

  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider, modelId }, cwd },
  });

  // 思考等级可以在会话中途改；改了才会出现 thinking 块。
  const thinkingLevel = options.thinkingLevel ?? process.env.PII_THINKING;
  if (thinkingLevel) {
    await root.configure({ thinkingLevel: thinkingLevel as never }, BACKGROUND_CONTEXT);
  }

  // 关键：不调 resume() 的话，重启后未完成的任务不会继续。
  // pi-durable 的 "durable" 只有在调度器打开后才真正生效。
  harness.resume();

  return { harness, root, models, storage, provider, modelId, dbPath, cwd };
}
