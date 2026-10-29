/** 与服务端 `src/server/project.ts` 对应的前端类型。 */

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "toolCall";
      id?: string;
      name: string;
      input: unknown;
      /** 与之配对的工具结果（服务端按 call id 并进来） */
      result?: string;
      isError?: boolean;
      durationMs?: number;
    }
  | { type: "toolResult"; id?: string; name?: string; text: string; isError?: boolean; durationMs?: number }
  /** 用户上传的图片：只带地址，图片本体由 /api/image 提供并可被浏览器长期缓存 */
  | { type: "image"; mimeType: string; url: string };

export interface Entry {
  id: number;
  kind: string;
  blocks: Block[];
  /** 毫秒时间戳（来自消息自带的 timestamp；纯展示条目可能没有） */
  at?: number;
  /** 服务端补充的生成耗时（ms），用作思考块用时的历史兵底 */
  thinkingMs?: number;
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
  /** 还有更早的条目（服务端窗口化） */
  hasMore?: boolean;
  /** 窗口里最老的 id，往前翻页的游标 */
  oldestEntryId?: number | null;
  live: LiveView | null;
  usage: { models?: Record<string, Usage>; tools?: Record<string, Usage> } | null;
  agent: { model?: { provider?: string; modelId?: string }; cwd?: string } | null;
  inbox: { items?: unknown[] } | null;
}

/** 正在进行的阶段：generating = 模型在生成（含思考/正文流式），tools = 在跑工具 */
export type LivePhase = "generating" | "tools";

export interface LiveView {
  phase?: LivePhase;
  /** 正在流式生成的助手消息（半截） */
  message?: { blocks: Block[] };
  /** 正在跑的工具 */
  tools?: { name: string; status: "pending" | "running" | "done" }[];
  /** 思考字数（thinking 块字符总数） */
  thinkingChars?: number;
  /** 工具输出字数（累积） */
  outputChars?: number;
}

export interface ApprovalRequest {
  id: string;
  /** 属于哪个会话；只显示当前会话的审批 */
  conversationId: number;
  callId: string;
  tool: string;
  input: unknown;
  createdAt: number;
  expiresAt: number;
}

/** 服务端 `listConversations()` 的投影。标题来自第一条用户消息，不是落库字段。 */
export interface ConversationSummary {
  id: number;
  title: string;
  busy: boolean;
}

/** 工具审批策略：与服务端 `src/server/policies.ts` 对应。 */
export const KNOWN_TOOLS = ["read", "write", "edit", "bash"] as const;
export type KnownTool = (typeof KNOWN_TOOLS)[number];

export interface ToolPolicy {
  /** 每个已知工具是否「自动放行」（false = 每次问） */
  auto: Record<KnownTool, boolean>;
  /** 未知/新工具是否也自动（仅「全部放行」为 true） */
  allowUnknown: boolean;
}

export type PresetId = "ask-all" | "read-only" | "write-allowed" | "all" | "custom";

export type ConnectionState = "connecting" | "open" | "closed";

/** `/api/models` 返回的一项。 */
export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  /** 能不能看图（决定要不要禁用上传） */
  image: boolean;
  reasoning: boolean;
  contextWindow?: number;
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  fileCount: number;
}

export interface ModelList {
  models: ModelOption[];
  current: { provider?: string; modelId?: string } | null;
}
