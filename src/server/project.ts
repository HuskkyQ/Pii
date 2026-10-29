/**
 * 把 pi-durable 的 ConversationView 投影成前端能直接渲染的 JSON。
 *
 * 设计原则（来自 pi-durable 文档）：
 *   **快照是账单，事件是叫号声。**
 * 所以这里每次都输出「完整视图」，前端收到就整体替换；
 * 阶段 3 再换成增量 ops，但语义不变。
 */
import type { ConversationView } from "@earendil-works/pi-durable";

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  /** 工具调用；`result` 是它配对的结果（由 projectEntries 按 call id 合并进来） */
  | {
      type: "toolCall";
      id?: string;
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      durationMs?: number;
    }
  | { type: "toolResult"; id?: string; name?: string; text: string; isError?: boolean; durationMs?: number }
  /**
   * 用户上传的图片。
   *
   * **不把 base64 塞进快照**：一张图 base64 后 200KB 起步，而快照是每次状态变化都整份推的。
   * 改成 URL 后：快照变小、浏览器自带缓存（图片内容按 entry 不变 → immutable），
   * 滚回去再看一眼也不会重新下载。
   */
  | { type: "image"; mimeType: string; url: string };

export interface Entry {
  id: number;
  kind: string;
  blocks: Block[];
  /**
   * 时间戳（毫秒）。
   * 注意：**entry 本身没有时间字段**，时间在消息里（`message.timestamp`）。
   * 所以取该 entry 里第一条带 timestamp 的消息；纯展示类 entry 可能没有。
   */
  at?: number;
  /** 生成这条消息的 task id（用来查生成耗时） */
  byTaskId?: number;
  /** 服务端补充的生成耗时（毫秒）——用作思考块用时的兵底（历史消息） */
  thinkingMs?: number;
}

/** 正在进行的阶段。`generating` = 模型在生成（含思考/正文流式），`tools` = 在跑工具。 */
export type LivePhase = "generating" | "tools";

export interface LiveView {
  phase?: LivePhase;
  /** 正在流式生成的助手消息（半截）。每 ~100ms 追一次 */
  message?: { blocks: Block[] };
  /** 正在跑的工具（名字 + 状态），仅用于展示 */
  tools?: { name: string; status: "pending" | "running" | "done" }[];
  /** 思考字数（thinking 块的字符总数），给实时状态显示用 */
  thinkingChars?: number;
  /** 工具输出字数（正在跑的工具累积输出字符数） */
  outputChars?: number;
}

export interface Snapshot {
  conversationId: number;
  entries: Entry[];
  /** 窗口化：还有更早的条目（前端据此显示「加载更早」） */
  hasMore?: boolean;
  /** 窗口里最老的那条 id（往前翻页的游标） */
  oldestEntryId?: number | null;
  /** pi.live 的结构化投影：正在跑的生成（含流式半截）和工具调用 */
  live: LiveView | null;
  /** pi.usage：token / 花费累计 */
  usage: unknown;
  /** pi.agent：本会话选定的模型、思考等级等 */
  agent: unknown;
  /** pi.inbox：排队的输入 */
  inbox: unknown;
}

interface RawMessage {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  durationMs?: number;
  timestamp?: number;
}

function asBlocks(message: RawMessage, conversationId = 0, entryId = 0): Block[] {
  const blocks: Block[] = [];
  const content = message.content;

  if (typeof content === "string") {
    if (content.trim()) blocks.push({ type: "text", text: content });
    return blocks;
  }

  if (!Array.isArray(content)) return blocks;

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const type = typeof p.type === "string" ? p.type : "";

    if (type === "text" && typeof p.text === "string") {
      if (message.role === "toolResult") {
        blocks.push({
          type: "toolResult",
          text: p.text,
          id: message.toolCallId,
          name: message.toolName,
          isError: message.isError,
          durationMs: message.durationMs,
        });
      } else {
        blocks.push({ type: "text", text: p.text });
      }
    } else if (type === "thinking" && typeof p.thinking === "string") {
      blocks.push({ type: "thinking", text: p.thinking });
    } else if (type === "image" && typeof p.data === "string" && entryId > 0) {
      // 只有在读历史 entry 时才给地址；流式中的临时消息没有 entryId，跳过
      // 同一条 entry 里的第几张图 → 稳定的图片地址（内容不可变，可长期缓存）
      const index = blocks.filter((block) => block.type === "image").length;
      blocks.push({
        type: "image",
        mimeType: typeof p.mimeType === "string" ? p.mimeType : "image/png",
        url: `/api/image?c=${conversationId}&e=${entryId}&i=${index}`,
      });
    } else if (type === "toolCall") {
      blocks.push({
        type: "toolCall",
        id: typeof p.id === "string" ? p.id : undefined,
        name: typeof p.name === "string" ? p.name : "unknown",
        input: p.arguments ?? p.input ?? null,
      });
    }
  }

  return blocks;
}

/** 一条 entry 的消息（`entry.model`）→ 前端 blocks。 */
export function projectEntries(view: ConversationView): Entry[] {
  const entries: Entry[] = [];

  for (const entry of view.entries) {
    const blocks: Block[] = [];

    const conversationId = Number(entry.conversationId);
    const entryId = Number(entry.id);
    for (const message of (entry.model ?? []) as unknown as RawMessage[]) {
      blocks.push(...asBlocks(message, conversationId, entryId));
    }

    // 工具结果 entry 没有 text block 也要保留（前端要显示「跑完了」）
    if (blocks.length === 0) continue;

    const messages = (entry.model ?? []) as unknown as RawMessage[];
    const at = messages.find((message) => typeof message.timestamp === "number")?.timestamp;

    entries.push({
      id: entry.id as unknown as number,
      kind: entry.kind,
      blocks,
      ...(at === undefined ? {} : { at }),
      ...(entry.byTaskId === undefined ? {} : { byTaskId: entry.byTaskId as unknown as number }),
    });
  }

  return mergeToolResults(entries);
}

/**
 * 把工具结果并进它对应的 toolCall 块，让「命令 + 结果」在一个块里展示。
 *
 * 在 pi-durable 里，工具调用在 assistant entry（toolCall 块），结果是后面单独一条
 * `pi.tool-result` entry，按 `toolCallId` 对得上。这里就按 id 合并：
 *   - toolResult 的文字/是否出错/耗时填进对应 toolCall 的 result/isError/durationMs；
 *   - 被消费掉的 toolResult 块删掉；整条被消费空的 entry 也去掉。
 *
 * 对不上 id 的残块（极少）保留原样，由前端旧路径兼底。
 */
function mergeToolResults(entries: Entry[]): Entry[] {
  const resultById = new Map<string, { text: string; isError?: boolean; durationMs?: number }>();
  for (const entry of entries) {
    for (const block of entry.blocks) {
      if (block.type !== "toolResult" || !block.id) continue;
      const prev = resultById.get(block.id);
      if (prev) {
        prev.text += block.text;
        if (block.isError) prev.isError = true;
        if (block.durationMs !== undefined) prev.durationMs = block.durationMs;
      } else {
        resultById.set(block.id, { text: block.text, isError: block.isError, durationMs: block.durationMs });
      }
    }
  }

  const consumed = new Set<string>();
  for (const entry of entries) {
    for (const block of entry.blocks) {
      if (block.type !== "toolCall" || !block.id) continue;
      const result = resultById.get(block.id);
      if (!result) continue;
      block.result = result.text;
      block.isError = result.isError;
      block.durationMs = result.durationMs;
      consumed.add(block.id);
    }
  }

  const merged: Entry[] = [];
  for (const entry of entries) {
    const blocks = entry.blocks.filter(
      (block) => !(block.type === "toolResult" && block.id && consumed.has(block.id)),
    );
    if (blocks.length === 0) continue; // 整条就是被消费的结果 entry
    merged.push(blocks.length === entry.blocks.length ? entry : { ...entry, blocks });
  }
  return merged;
}

/**
 * `pi.live` → 前端能直接渲染的「正在发生」视图：
 *  - phase：generating（在生成）/ tools（在跑工具）
 *  - message.blocks：模型回复的半截内容（text / thinking / toolCall）
 *  - tools：正在跑的工具名与状态
 */
function projectLive(raw: unknown): LiveView | null {
  if (!raw || typeof raw !== "object") return null;
  const live = raw as {
    run?: unknown;
    generation?: { message?: RawMessage };
    tools?: { name?: unknown; status?: unknown; output?: unknown }[];
  };

  const hasTools = Array.isArray(live.tools) && live.tools.length > 0;
  const phase: LivePhase | undefined = live.generation
    ? "generating"
    : hasTools
      ? "tools"
      : live.run
        ? "generating"
        : undefined;

  const out: LiveView = {};
  if (phase) out.phase = phase;

  const message = live.generation?.message;
  if (message) {
    // 丢掉还没出字的空块，否则会“有 block 但没内容”“看起来已经不在思考”
    const blocks = asBlocks(message).filter((block) =>
      block.type === "text" || block.type === "thinking" ? block.text.length > 0 : true,
    );
    if (blocks.length > 0) out.message = { blocks };
    const thinkingChars = blocks.reduce(
      (sum, block) => sum + (block.type === "thinking" ? block.text.length : 0),
      0,
    );
    if (thinkingChars > 0) out.thinkingChars = thinkingChars;
  }

  if (hasTools) {
    out.tools = (live.tools ?? []).map((tool) => ({
      name: typeof tool.name === "string" ? tool.name : "tool",
      status: tool.status === "running" || tool.status === "done" ? tool.status : "pending",
    }));
    const outputChars = (live.tools ?? []).reduce(
      (sum, tool) => sum + (typeof tool.output === "string" ? tool.output.length : 0),
      0,
    );
    if (outputChars > 0) out.outputChars = outputChars;
  }

  return Object.keys(out).length > 0 ? out : null;
}

export interface ProjectOptions {
  durationOf?: (taskId: number) => number | undefined;
  /**
   * 只投影最近 `limit` 条（从 `before` 往前数）。
   *
   * 为什么需要：会话能长到 300+ 条、2MB，而快照是**每次状态变化整份推**的。
   * 手机上（公网 + 隧道）这就意味着每帧传 500KB 压缩后内容。
   * 窗口化之后一帧只有几十 KB，更早的历史点「加载更早」再取。
   */
  limit?: number;
  /** 只取 id < before 的部分（向前翻页） */
  before?: number;
  /**
   * 只投影最近 `turns` **轮对话**（一轮 = 一条用户消息 + 它之后的全部条目）。
   *
   * 为什么按轮而不按条：一条用户消息后面跟着思考、工具调用、工具结果、最终正文，
   * 可能是 6~10 条 entry。按条切窗口会出现「切在半轮中间」——
   * 加载出来一堆没有提问的思考，或者有提问没有回答。按轮切永远完整。
   */
  turns?: number;
}

export function projectView(view: ConversationView, options: ProjectOptions = {}): Snapshot {
  const all = projectEntries(view);
  let entries = all;

  // 往前翻页：先按游标截断
  if (options.before !== undefined) {
    const before = options.before;
    entries = entries.filter((entry) => entry.id < before);
  }

  // 再按「轮」取最后 N 轮
  let dropped = all.length - entries.length;
  if (options.turns !== undefined && options.turns > 0) {
    const starts: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i]!.kind === "pi.user") starts.push(i);
    }
    if (starts.length > options.turns) {
      const start = starts[starts.length - options.turns]!;
      dropped += start;
      entries = entries.slice(start);
    }
  } else if (options.limit !== undefined && entries.length > options.limit) {
    const cut = entries.length - options.limit;
    dropped += cut;
    entries = entries.slice(cut);
  }

  const oldestEntryId = entries.length > 0 ? entries[0]!.id : null;
  if (options.durationOf) {
    for (const entry of entries) {
      if (entry.byTaskId === undefined) continue;
      const duration = options.durationOf(entry.byTaskId);
      if (duration !== undefined) entry.thinkingMs = duration;
    }
  }
  return {
    conversationId: view.conversation.id as unknown as number,
    entries,
    /** 还有更早的吗（前端据此决定要不要继续加载） */
    hasMore: dropped > 0,
    oldestEntryId,
    live: projectLive(view.docs["pi.live"]),
    usage: view.docs["pi.usage"] ?? null,
    agent: view.docs["pi.agent"] ?? null,
    inbox: view.docs["pi.inbox"] ?? null,
  };
}
