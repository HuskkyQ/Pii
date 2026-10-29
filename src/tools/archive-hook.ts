/**
 * 把「上下文压缩」接到归档上。
 *
 * pi-durable 自带 compaction（默认已开启）：上下文快到模型窗口时，
 * 把较早的部分换成一段摘要，`keepRecentTokens` 那么多最近的原文保留。
 *
 * 我们的 `beforeCompact` 钩子跑在**摘要生成之前**，能拿到「即将被替换掉的条目」，
 * 先落盘成 markdown，再让压缩照常进行。于是：
 *
 *   数据库 / 上下文：被压缩（省 token，对话能一直继续）
 *   归档目录：      原文还在（历史不丢，随时能翻）
 *
 * 钩子返回 undefined = 不改写 pi-durable 的决策（摘要仍由它生成）。
 */
import { CompactionTask, defineExtension, hook } from "@earendil-works/pi-durable";

import { archiveEntries } from "../server/archive.ts";

export interface ArchiveHookOptions {
  archiveDir: string;
  titleOf?: (conversationId: number) => string | undefined;
  /** 归档后回调（用来在日志/界面上提示） */
  onArchived?: (info: { conversationId: number; path: string; entries: number }) => void;
}

export function archiveExtension(options: ArchiveHookOptions) {
  return defineExtension({
    name: "pii-archive",
    hooks: [
      hook(CompactionTask, {
        async beforeCompact(compaction, api) {
          const conversationId = Number(api.conversationId);

          // entries 是「被摘要替换掉」的那些，正是会从上下文里消失的部分
          const entries = compaction.entries.map((entry) => {
            const blocks: {
              type: string;
              text?: string;
              name?: string;
              input?: unknown;
            }[] = [];

            for (const message of entry.model ?? []) {
              const content = (message as { content?: unknown }).content;
              if (typeof content === "string") {
                blocks.push({ type: "text", text: content });
                continue;
              }
              if (!Array.isArray(content)) continue;
              for (const part of content) {
                const p = part as {
                  type?: string;
                  text?: string;
                  thinking?: string;
                  name?: string;
                  arguments?: unknown;
                };
                if (p?.type === "text" && typeof p.text === "string") {
                  blocks.push({ type: "text", text: p.text });
                } else if (p?.type === "thinking" && typeof p.thinking === "string") {
                  blocks.push({ type: "thinking", text: p.thinking });
                } else if (p?.type === "toolCall") {
                  blocks.push({ type: "toolCall", name: p.name, input: p.arguments });
                }
              }
            }

            const first = (entry.model ?? [])[0] as { timestamp?: number } | undefined;
            return {
              id: Number(entry.id),
              kind: entry.kind,
              ...(first?.timestamp === undefined ? {} : { at: first.timestamp }),
              blocks,
            };
          });

          try {
            const result = archiveEntries({
              archiveDir: options.archiveDir,
              conversationId,
              entries,
              reason: "compaction",
              title: options.titleOf?.(conversationId),
            });
            if (result) {
              console.log(`  归档      ${result.entries} 条 → ${result.path}`);
              options.onArchived?.({ conversationId, path: result.path, entries: result.entries });
            }
          } catch (error) {
            // 归档失败不能挡住压缩（否则上下文会一直涨到爆）
            console.warn(`  归档失败  ${(error as Error).message}`);
          }

          return undefined;
        },
      }),
    ],
  });
}
