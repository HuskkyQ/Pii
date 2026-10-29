/**
 * 多会话：列出 / 新建 / 打开。
 *
 * pi-durable 里一个 conversation 只有 id、parent、owner —— **没有标题**。
 * 所以标题不落库，改成「从第一条用户消息推出来」：
 * 少一份要维护、要同步、会写错的状态。
 *
 * 所有权一律 `ownerless`：这些会话是用户手动开的顶层对话，
 * 不属于某个后台任务（任务视图 owns 的会话会在任务结束时长出来，不在这里）。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";

import type { Agent } from "../agent.ts";

export interface ConversationSummary {
  id: number;
  title: string;
  /** 有排队或正在跑的输入 —— 列表上那个小圆点 */
  busy: boolean;
}

const TITLE_LIMIT = 42;
const TITLE_PROBE_ENTRIES = 8;

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_LIMIT ? `${flat.slice(0, TITLE_LIMIT)}…` : flat;
}

/** 从一条 entry 的 model 里挖出第一段文字（content 可能是字符串，也可能是 block 数组）。 */
function textOf(model: readonly unknown[] | undefined): string | undefined {
  for (const message of model ?? []) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string" && content.trim()) return content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; text?: unknown };
      if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) return p.text;
    }
  }
  return undefined;
}

/** 第一条用户消息当标题；没有就退回「新对话」。 */
export async function titleOf(conversation: Conversation): Promise<string> {
  const page = await conversation.entries(
    { order: "ascending" },
    TITLE_PROBE_ENTRIES,
    undefined,
    BACKGROUND_CONTEXT,
  );
  for (const entry of page.items) {
    if (!entry.kind.startsWith("pi.user")) continue;
    const text = textOf(entry.model as readonly unknown[] | undefined);
    if (text) return truncate(text);
  }
  return "新对话";
}

/**
 * 最新在前的会话列表。
 *
 * `busy` 从 `harness.inspect()` 的「未结算提交」推出来：
 * 有排队/正在跑的输入就是 busy。比自己per会话去读 viewState 便宜得多。
 */
export async function listConversations(
  agent: Agent,
  limit = 50,
  hidden: (id: number) => boolean = () => false,
  /** 自定义标题（用户改过名的）。命中就用它，否则回退到从内容推。 */
  customTitle: (id: number) => string | undefined = () => undefined,
): Promise<ConversationSummary[]> {
  const page = await agent.storage.scanConversations(
    { order: "descending" },
    limit,
    undefined,
    BACKGROUND_CONTEXT,
  );
  const inspection = await agent.harness.inspect(BACKGROUND_CONTEXT);
  const busy = new Set(inspection.submissions.map((s) => Number(s.conversationId)));

  const summaries: ConversationSummary[] = [];
  for (const record of page.items) {
    const id = Number(record.id);
    // 被删掉的会话不列出来
    if (hidden(id)) continue;
    const conversation = await agent.harness.conversation(record.id, BACKGROUND_CONTEXT);
    if (!conversation) continue;
    summaries.push({ id, title: customTitle(id) ?? (await titleOf(conversation)), busy: busy.has(id) });
  }
  return summaries;
}

/** 打开一个会话；不传 id 就回 root（root 不存在时顺手建出来）。 */
export async function openConversation(
  agent: Agent,
  id: number | undefined,
): Promise<Conversation | undefined> {
  if (id === undefined) return agent.root;
  return agent.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
}

/** 新建一个顶层会话，继承 root 的模型与 cwd。 */
export async function createConversation(agent: Agent): Promise<Conversation> {
  const rootAgent = await agent.root.agent(BACKGROUND_CONTEXT);
  return agent.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: rootAgent.model ?? null, cwd: rootAgent.cwd ?? process.cwd() },
    },
    BACKGROUND_CONTEXT,
  );
}

/** 把 `?c=<id>` 解析成会话 id；非法就当没传（走 root）。 */
export function parseConversationId(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}
