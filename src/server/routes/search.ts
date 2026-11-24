/**
 * 会话全文搜索。跨会话查正文（用户提问 + 模型回答），不查工具输出。
 *
 * 只读、无副作用，所以不需要审批；代价是全表扫一遍 entries，
 * 个人实例（几千条）在毫秒级，等哪天真的慢了再上 FTS5。
 */
import type { Hono } from "hono";
import type { AppContext } from "../context.ts";

export function registerSearch(app: Hono, ctx: AppContext): void {
  const { searchMessages } = ctx;

  app.get("/api/search", (c) => {
    const query = (c.req.query("q") ?? "").trim();
    const raw = Number(c.req.query("limit") ?? 40);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 100) : 40;

    if (query.length < 2) return c.json({ query, hits: [] });
    return c.json({ query, hits: searchMessages(query, limit) });
  });
}
