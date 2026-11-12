/**
 * 前端类型入口。
 *
 * 前后端共用的形状现在住在根目录 `shared/types.ts` / `shared/policies.ts`，
 * 这里 re-export 一下：老组件继续 `@/lib/types` 就行，不用一次性全改。
 * 新代码建议直接 `@shared/...`。
 */
export type {
  Block,
  Entry,
  LivePhase,
  LiveView,
  Usage,
  Snapshot,
  ApprovalRequest,
  ConversationSummary,
} from "@shared/types";

export {
  KNOWN_TOOLS,
  type KnownTool,
  type Policy,
  type ToolPolicy,
  type PresetId,
} from "@shared/policies";

/* ---------- 下面是前端独有的，服务端不认识，留在本地 ---------- */

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
