/**
 * 把全局记忆接到 system prompt 上，并按需装 `memory` 工具。
 *
 * 为什么是 section 而不是 `beforeRequest` 改 messages：
 *   1. pi-durable 的 `planSystemEntries` 保证「重放出来的 section = 期望的 section」，
 *      不会每轮重复注入；
 *   2. 内容只在变化时追加一条 `pi.system` 条目，不写用户/助手历史；
 *   3. 压缩（compaction）估算的上下文里包含它，不会算漏。
 *
 * key 固定为 `memory`：同一个 key 只保留最新一版。
 */
import { defineExtension, section } from "@earendil-works/pi-durable";

import { memoryTool } from "../tools/memory.ts";
import type { MemoryStore } from "./store.ts";

export interface MemoryExtensionOptions {
  /** 装不装写入工具。`PII_TOOLS=0` 时不装 —— 但注入照旧（只读记忆仍然有效）。 */
  tool?: boolean;
}

export function memoryExtension(store: MemoryStore, options: MemoryExtensionOptions = {}) {
  const withTool = options.tool === true;
  return defineExtension({
    name: "pii-memory",
    // tag 默认 true → 渲染结果会被包成 <memory>…</memory>
    sections: [section("memory", () => store.renderForPrompt({ mentionTool: withTool }))],
    ...(withTool ? { tools: [memoryTool(store)] } : {}),
  });
}
