/**
 * 前后端共享的数据形状（服务端投影出来 → 浏览器直接渲染）。
 *
 * 为什么要放在根目录 `shared/`：
 * 这些类型以前在 `src/server/project.ts` 和 `web/src/lib/types.ts` 各抄了一份，
 * 改一边忘另一边就会「类型对不上但编译过」。现在只有一份，谁都不能私改。
 *
 * 引用规则：
 *  - 服务端：相对路径 + 显式 `.ts`（跑在裸 node/tsx 上，没有打包器解析别名）
 *  - 前端：`@shared/types`（Vite 的 alias + tsconfig 的 paths 一起配好）
 */

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
  /** 生成这条消息的 task id（服务端用来查生成耗时；前端暂未读取） */
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

export interface Usage {
  input?: number;
  output?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export interface Snapshot {
  conversationId: number;
  entries: Entry[];
  /** 窗口化：还有更早的条目（前端据此显示「加载更早」） */
  hasMore?: boolean;
  /** 窗口里最老的那条 id（往前翻页的游标） */
  oldestEntryId?: number | null;
  /**
   * 最近一次失败的运行（模型不可达、key 失效、被限流…）。
   * 失败时对话里不会写入任何东西，所以必须单独带出来，否则用户只看到「没回复」。
   */
  runError?: { taskId: number; message: string; reason?: string; at?: number } | null;
  /** pi.live 的结构化投影：正在跑的生成（含流式半截）和工具调用 */
  live: LiveView | null;
  /**
   * pi.usage：token / 花费累计。
   * 注意：pi-durable 文档里这里是 `unknown`，UI 依赖下面这个收窄形状
   * （StatusBar.tsx），所以服务端投影时要断言一下。
   */
  usage: { models?: Record<string, Usage>; tools?: Record<string, Usage> } | null;
  /** pi.agent：本会话选定的模型、工作目录等（同上，UI 依赖收窄形状） */
  agent: { model?: { provider?: string; modelId?: string }; cwd?: string } | null;
  /** pi.inbox：排队的输入 */
  inbox: { items?: unknown[] } | null;
}

export interface ApprovalRequest {
  id: string;
  /** 这个审批属于哪个会话。前端只显示当前会话的审批，避免串台。 */
  conversationId: number;
  /** 模型给的 tool call id */
  callId: string;
  tool: string;
  input: unknown;
  createdAt: number;
  /** 超时时刻（毫秒时间戳），前端可用来倒计时 */
  expiresAt: number;
}

/**
 * 全局共享记忆的一条。
 *
 * 和 `Entry` 的区别：Entry 是「发生过什么」，只增不改、会被压缩；
 * MemoryEntry 是「一直成立的事实」，可编辑，每轮请求前注入系统提示。
 */
export interface MemoryEntry {
  id: number;
  content: string;
  tags: string[];
  pinned: boolean;
  /** 谁写的：人（manual）还是 agent（agent，写入要审批） */
  source: "manual" | "agent";
  /** agent 写入时来自哪个会话（审计用；会话删了也不影响这条记忆） */
  conversationId?: number;
  createdAt: number;
  updatedAt: number;
}

/** `GET /api/memory` 的响应：全部条目 + 实际注入的条数（受预算限制）。 */
export interface MemorySnapshot {
  entries: MemoryEntry[];
  injected: number;
  budgetChars: number;
}

/** `listConversations()` 的投影。标题来自第一条用户消息，不是落库字段。 */
export interface ConversationSummary {
  id: number;
  title: string;
  /** 有排队或正在跑的输入 —— 列表上那个小圆点 */
  busy: boolean;
}
