/**
 * 会话全文搜索。
 *
 * 和 db/tasks.ts 同一个路数：pi-durable 持有写连接，这里**惰性**开一个
 * `readOnly` 连接，带 `busy_timeout`，查坏了就当没有结果 —— 搜索是辅助功能，
 * 不能让它把主流程带崩。
 *
 * 为什么先 SQL 粗筛、再在 JS 里判断：
 * `entries.record` 是一整块 JSON，直接 `LIKE '%词%'` 会命中字段名
 * （搜 "text" 每一行都中）。所以 SQL 只负责把候选缩小，
 * 真正的匹配在**解析出来的正文**上做。
 */
import { DatabaseSync } from "node:sqlite";

export interface SearchHit {
  conversationId: number;
  entryId: number;
  role: "user" | "assistant";
  /** 命中位置前后各截一段，给前端直接显示 */
  snippet: string;
  at?: number;
}

export interface SearchQueries {
  search: (query: string, limit?: number) => SearchHit[];
  close: () => void;
}

/** SQL 粗筛的上限：再多也没人翻。 */
const MAX_CANDIDATES = 400;
/** 同一个会话最多回几条，避免一个会话把结果刷满。 */
const PER_CONVERSATION = 3;

interface Record_ {
  id?: number;
  conversationId?: number;
  kind?: string;
  model?: unknown[];
}

function textOf(model: readonly unknown[] | undefined): string {
  const parts: string[] = [];
  for (const message of model ?? []) {
    const content = (message as { content?: unknown } | null)?.content;
    if (typeof content === "string") {
      if (content.trim()) parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const block = part as { type?: string; text?: unknown };
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        parts.push(block.text);
      }
    }
  }
  return parts.join("\n");
}

function timestampOf(model: readonly unknown[] | undefined): number | undefined {
  for (const message of model ?? []) {
    const at = (message as { timestamp?: unknown } | null)?.timestamp;
    if (typeof at === "number") return at;
  }
  return undefined;
}

/** 取命中位置前后各一段，压成一行。 */
function snippetAround(text: string, index: number, length: number): string {
  const before = 28;
  const after = 60;
  const start = Math.max(0, index - before);
  const end = Math.min(text.length, index + length + after);
  const flat = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${flat}${end < text.length ? "…" : ""}`;
}

export function openSearch(dbPath: string): SearchQueries {
  let db: DatabaseSync | null = null;

  function handle(): DatabaseSync {
    if (!db) {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 1000");
    }
    return db;
  }

  return {
    search(query, limit = 40) {
      const q = query.trim();
      // 一个字也能搜，但 CJK 单字命中率太低，噪声大于价值
      if (q.length < 2) return [];

      // LIKE 的通配符要转义，否则用户搜 "100%" 会变成任意匹配
      const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      let rows: { id: number; conversation_id: number; record: string }[];
      try {
        rows = handle()
          .prepare(
            `SELECT id, conversation_id, record FROM entries
              WHERE record LIKE ? ESCAPE '\\'
                AND (record LIKE '%"kind":"pi.user"%' OR record LIKE '%"kind":"pi.assistant"%')
              ORDER BY id DESC
              LIMIT ${MAX_CANDIDATES}`,
          )
          .all(`%${escaped}%`) as unknown as typeof rows;
      } catch {
        return [];
      }

      const needle = q.toLowerCase();
      const hits: SearchHit[] = [];
      const perConversation = new Map<number, number>();

      for (const row of rows) {
        let record: Record_;
        try {
          record = JSON.parse(row.record) as Record_;
        } catch {
          continue;
        }
        const kind = record.kind ?? "";
        if (kind !== "pi.user" && kind !== "pi.assistant") continue;

        const text = textOf(record.model);
        if (!text) continue;
        const index = text.toLowerCase().indexOf(needle);
        if (index < 0) continue;

        const used = perConversation.get(row.conversation_id) ?? 0;
        if (used >= PER_CONVERSATION) continue;
        perConversation.set(row.conversation_id, used + 1);

        hits.push({
          conversationId: row.conversation_id,
          entryId: row.id,
          role: kind === "pi.user" ? "user" : "assistant",
          snippet: snippetAround(text, index, q.length),
          at: timestampOf(record.model),
        });
        if (hits.length >= limit) break;
      }

      return hits;
    },

    close() {
      db?.close();
      db = null;
    },
  };
}
