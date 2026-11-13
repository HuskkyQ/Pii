/**
 * `memory` 工具：让 agent 自己维护全局共享记忆。
 *
 * 三条纪律：
 *  1. **写入走审批**：`memory` 不在 KNOWN_TOOLS 里，策略表对未知工具默认「问」
 *     （见 `policies.shouldAutoAllow`），所以这里不用额外做什么 —— 默认就是每次点头。
 *  2. **只记长期事实**：描述里明确写「不要记一次性的任务细节」，否则模型会把每轮总结都塞进来。
 *  3. **返回人话**：结果会显示在界面上，用中文；错误也用中文，方便直接看懂为什么被拒。
 */
import { defineTool } from "@earendil-works/pi-durable";
import { bool, lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";

import type { MemoryReject, MemoryStore } from "../memory/store.ts";

const schema = obj({
  action: union([lit("add"), lit("update"), lit("remove"), lit("list")]),
  content: opt(str({ description: "The fact to remember, one sentence. Required for add/update." })),
  id: opt(num({ description: "Memory id from the list, shown as [#12]. Required for update/remove." })),
  tags: opt(str({ description: "Comma-separated tags, e.g. 'preference,deploy'. Optional." })),
  pinned: opt(bool({ description: "Pin it so it is always injected first. Optional." })),
  query: opt(str({ description: "For list: only show memories containing this text. Optional." })),
});

/** 拒绝原因 → 给模型看的一句话。 */
function rejectText(reason: MemoryReject): string {
  switch (reason) {
    case "empty":
      return "内容不能为空。";
    case "too-long":
      return "单条记忆最长 1000 字，请压缩成一句话。";
    case "full":
      return "记忆已达上限（500 条），请先删掉几条不再成立的。";
    case "duplicate":
      return "已有内容相同的记忆，请用 update 改那一条。";
    case "not-found":
      return "找不到这条记忆，可能已经被删了。";
  }
}

export function memoryTool(store: MemoryStore) {
  return defineTool({
    name: "memory",
    description:
      "Read or write the user's global long-term memory, shared across all conversations. " +
      "Use it for durable facts (preferences, environment, conventions, standing decisions), " +
      "not for task details or anything that is only true right now. " +
      "Every write asks the user for approval. Actions: add, update, remove, list.",
    parameters: schema,
    async execute(args, api) {
      switch (args.action) {
        case "add": {
          if (args.content === undefined) {
            return { output: [{ type: "text", text: "add 需要 content。" }], isError: true };
          }
          const result = store.add({
            content: args.content,
            ...(args.tags === undefined ? {} : { tags: args.tags.split(",") }),
            ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
            source: "agent",
            conversationId: Number(api.conversationId),
          });
          if (!result.ok) {
            return { output: [{ type: "text", text: rejectText(result.reason) }], isError: true };
          }
          return {
            output: [
              {
                type: "text",
                text: result.created
                  ? `已记住 #${result.entry.id}：${result.entry.content}`
                  : `#${result.entry.id} 已有相同内容，只更新了时间。`,
              },
            ],
          };
        }

        case "update": {
          if (args.id === undefined) {
            return { output: [{ type: "text", text: "update 需要 id。" }], isError: true };
          }
          const result = store.update(args.id, {
            ...(args.content === undefined ? {} : { content: args.content }),
            ...(args.tags === undefined ? {} : { tags: args.tags.split(",") }),
            ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
          });
          if (!result.ok) {
            return { output: [{ type: "text", text: rejectText(result.reason) }], isError: true };
          }
          return {
            output: [{ type: "text", text: `已更新 #${result.entry.id}：${result.entry.content}` }],
          };
        }

        case "remove": {
          if (args.id === undefined) {
            return { output: [{ type: "text", text: "remove 需要 id。" }], isError: true };
          }
          return store.remove(args.id)
            ? { output: [{ type: "text", text: `已删除 #${args.id}。` }] }
            : { output: [{ type: "text", text: rejectText("not-found") }], isError: true };
        }

        case "list": {
          const query = args.query?.trim().toLowerCase();
          const entries = store
            .list()
            .filter((entry) => query === undefined || entry.content.toLowerCase().includes(query));
          if (entries.length === 0) {
            return { output: [{ type: "text", text: "还没有记忆。" }] };
          }
          const lines = entries.map((entry) => {
            const tags = [entry.pinned ? "置顶" : "", ...entry.tags].filter(Boolean);
            const suffix = tags.length > 0 ? `[${tags.join("][")}]` : "";
            return `[#${entry.id}]${suffix} ${entry.content}`;
          });
          return { output: [{ type: "text", text: lines.join("\n") }] };
        }
      }
    },
  });
}
