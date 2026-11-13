/**
 * 全局共享记忆的 HTTP 端点。
 *
 * 实现（表、预算、渲染）在 `src/memory/store.ts`；
 * 这里只做「请求 → 方法」的翻译，以及把 store 的拒绝原因翻成状态码。
 */
import type { Context, Hono } from "hono";

import type { MemoryReject } from "../../memory/store.ts";
import type { AppContext } from "../context.ts";

/** 拒绝原因 → HTTP 状态码。400 = 内容有问题，409 = 和现有状态冲突，404 = 没有这条。 */
const STATUS: Record<MemoryReject, number> = {
  empty: 400,
  "too-long": 400,
  full: 409,
  duplicate: 409,
  "not-found": 404,
};

const MESSAGE: Record<MemoryReject, string> = {
  empty: "内容不能为空",
  "too-long": "单条记忆最长 1000 字",
  full: "记忆已满（上限 500 条），先删几条",
  duplicate: "已有内容相同的记忆",
  "not-found": "记忆不存在",
};

function reject(c: Context, reason: MemoryReject) {
  return c.json({ error: MESSAGE[reason] }, STATUS[reason] as 400 | 404 | 409);
}

/** `:id` → 正整数；非法返回 undefined（调用方回 400）。 */
function parseId(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return id > 0 ? id : undefined;
}

/** 标签既接受数组也接受逗号分隔的字符串（curl 手敲时后者省事）。 */
function parseTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.split(",");
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === "string");
  return undefined;
}

export function registerMemory(app: Hono, ctx: AppContext): void {
  const { memory } = ctx;

  /**
   * 全部记忆 + 注入统计。
   *
   * 返回 `injected` 而不是让前端自己算：预算裁剪的规则（置顶优先、至少一条）
   * 只应该存在服务端，前端复制一份迟早会和真实注入对不上。
   */
  app.get("/api/memory", (c) => c.json(memory.snapshot()));

  app.post("/api/memory", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      content?: unknown;
      tags?: unknown;
      pinned?: unknown;
    };
    if (typeof body.content !== "string") return c.json({ error: "content 必填" }, 400);

    const result = memory.add({
      content: body.content,
      tags: parseTags(body.tags) ?? [],
      pinned: body.pinned === true,
      source: "manual",
    });
    if (!result.ok) return reject(c, result.reason);
    return c.json({ entry: result.entry, created: result.created }, result.created ? 201 : 200);
  });

  app.patch("/api/memory/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === undefined) return c.json({ error: "id 不合法" }, 400);

    const body = (await c.req.json().catch(() => ({}))) as {
      content?: unknown;
      tags?: unknown;
      pinned?: unknown;
    };
    if (body.content !== undefined && typeof body.content !== "string") {
      return c.json({ error: "content 必须是字符串" }, 400);
    }
    if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
      return c.json({ error: "pinned 必须是布尔值" }, 400);
    }
    const tags = parseTags(body.tags);
    if (body.tags !== undefined && tags === undefined) {
      return c.json({ error: "tags 必须是数组或逗号分隔的字符串" }, 400);
    }

    const result = memory.update(id, {
      ...(body.content === undefined ? {} : { content: body.content }),
      ...(tags === undefined ? {} : { tags }),
      ...(body.pinned === undefined ? {} : { pinned: body.pinned }),
    });
    if (!result.ok) return reject(c, result.reason);
    return c.json({ entry: result.entry });
  });

  app.delete("/api/memory/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === undefined) return c.json({ error: "id 不合法" }, 400);
    return memory.remove(id) ? c.json({ ok: true }) : reject(c, "not-found");
  });
}
