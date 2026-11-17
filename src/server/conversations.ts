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
import type { Conversation, ConversationId, ConversationRecord, Cursor } from "@earendil-works/pi-durable";

import type { Agent } from "../agent.ts";

/* 形状住在 shared/types.ts（会话列表在前端也要用同一份）。 */
import type { ConversationSummary } from "../../shared/types.ts";
export type { ConversationSummary };

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
 * 有排队/正在跑的输入就是 busy。比每个会话各挂一个 `Conversation.watch()` 便宜得多。
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
    /*
     * 子 agent 的会话：`owner` 指向派它的那次工具调用。
     * 那是 agent 的内部工作区（有自己的工具调用和中间过程），不该混进用户的侧边栏。
     * 想看它的过程可以用 `details.conversationId` 直接打开。
     */
    if (record.owner) continue;
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
  /*
   * 先问存储「这一行还在不在」，再问 Harness 要句柄。
   *
   * 为什么要两道：`harness.conversation()` 会把**打开过的会话缓存在内存里**。
   * 行被删掉（DELETE /api/conversations/:id 会当场 purge）之后，它依旧返回一个句柄，
   * 真正的报错要等到第一次读（watch/entries）才抛：
   *
   *     StorageRequestError: Unknown conversation: 7
   *
   * hono 把它兑成 500 —— 用户看到的是「服务器坏了」，而我们想表达的是「这会话不在了」。
   * 所以这里直接用存储层的一次主键查询做存在性校验（O(1)，不进 Harness 缓存）。
   */
  const record = await agent.storage.conversation(id as ConversationId, BACKGROUND_CONTEXT);
  if (!record) return undefined;
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

/** 翻完全部会话（分页游标来自存储层，调用方不用关心怎么翻）。 */
async function allConversations(agent: Agent): Promise<ConversationRecord[]> {
  const records: ConversationRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await agent.storage.scanConversations(
      { order: "ascending" },
      500,
      cursor,
      BACKGROUND_CONTEXT,
    );
    records.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return records;
}

/** 某个会话派出去的子 agent 会话 id（`owner` 指向它）。删父会话时一起删。 */
export async function subagentIdsOf(agent: Agent, conversationId: number): Promise<number[]> {
  const page = await agent.storage.scanConversations(
    { ownerConversationId: conversationId as ConversationId, order: "ascending" },
    500,
    undefined,
    BACKGROUND_CONTEXT,
  );
  return page.items.map((record) => Number(record.id));
}

/**
 * 孤儿会话：`owner` 指向的父会话已经不在了。
 *
 * 以前删父会话不回删子会话（purge 只按传入的 id 删），于是库里会攒下一堆
 * 「没人认领的办公室」：不占 CPU、不进列表，但一直占着磁盘。
 * 启动时扫一遍清掉。
 */
export async function orphanSubagentIds(agent: Agent): Promise<number[]> {
  const records = await allConversations(agent);
  const ids = new Set(records.map((record) => Number(record.id)));
  return records
    .filter((record) => {
      const owner = record.owner?.conversationId;
      return owner !== undefined && !ids.has(Number(owner));
    })
    .map((record) => Number(record.id));
}

/** 把 `?c=<id>` 解析成会话 id；非法就当没传（走 root）。 */
export function parseConversationId(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}
