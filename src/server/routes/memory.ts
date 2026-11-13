/**
 * 全局共享记忆的 HTTP 端点。
 *
 * 实现（表、预算、渲染）在 `src/memory/store.ts`；
 * 这里只做「请求 → 方法」的翻译。
 *
 * P0 只有读：写入留到 P1（memory 工具 + 审批）。现在想加一条可以先进 SQL，
 * 或者等 P1 的 `POST /api/memory`。
 */
import type { Hono } from "hono";

import type { AppContext } from "../context.ts";

export function registerMemory(app: Hono, ctx: AppContext): void {
  const { memory } = ctx;

  /**
   * 全部记忆 + 注入统计。
   *
   * 返回 `injected` 而不是让前端自己算：预算裁剪的规则（置顶优先、至少一条）
   * 只应该存在服务端，前端复制一份迟早会和真实注入对不上。
   */
  app.get("/api/memory", (c) => c.json(memory.snapshot()));
}
