/** 与服务端通信：一个 fetch 封装 + 一个 EventSource 封装。 */
import type { ConversationSummary, DirListing, ModelList, PresetId, ToolPolicy } from "@/lib/types";

/**
 * 401 的处理：跳登录页。
 *
 * 为什么会遇到：service worker 现在「缓存优先」给页面壳 —— 万一 cookie 过期了，
 * 壳照旧打开，但所有 API 都是 401。不处理的话界面看起来像坏了。
 * /login 不在缓存里，所以跳过去一定能拿到服务端渲染的登录页。
 */
/**
 * 请求计时。排查「打开要 5 秒」到底是哪一步慢 —— 把每个请求的耗时
 * 记下来一起上报（见 lib/metrics.ts），比在 Mac 上猜靠谱。
 */
const timings: Record<string, number> = {};

function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  return run().finally(() => {
    timings[`${label}`] = Math.round(performance.now() - start);
  });
}

/** 首帧快照到达的时刻（相对页面开始导航）。这是「骨架还要多久」的答案。 */
export function markFirstState(): void {
  if (timings.firstState !== undefined) return;
  timings.firstState = Math.round(performance.now());
}

export function getApiTimings(): Record<string, number> {
  return { ...timings };
}

function handleUnauthorized(status: number): void {
  if (status !== 401) return;
  if (location.pathname.startsWith("/login")) return;
  location.href = "/login";
}

/** 会话用 query 参数传（`?c=<id>`），因为 EventSource 设不了请求头。 */
function scope(conversationId?: number): string {
  return conversationId === undefined ? "" : `?c=${conversationId}`;
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await timed(path.split("?")[0]!, () => fetch(path));
  handleUnauthorized(res.status);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  handleUnauthorized(res.status);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface ImagePart {
  mimeType: string;
  data: string;
}

export function prompt(
  text: string,
  conversationId?: number,
  requestId?: string,
  images?: ImagePart[],
  /** 忙时：followUp=排队（默认）；steer=插队/引导当前回合 */
  mode?: "steer" | "followUp",
) {
  return postJson<{ requestId: string; submissionId: number; conversationId: number; mode?: string }>(
    `/api/prompt${scope(conversationId)}`,
    { text, requestId, images, mode },
  );
}

/** 往前翻一页（窗口化的另一半）：取 id < before 的最近 limit 条。 */
export function fetchOlderEntries(conversationId: number | undefined, before: number, limit = 20) {
  const params = new URLSearchParams({ limit: String(limit), before: String(before) });
  if (conversationId !== undefined) params.set("c", String(conversationId));
  return getJson<{ entries: unknown[]; hasMore?: boolean; oldestEntryId?: number | null }>(
    `/api/state?${params.toString()}`,
  );
}

export function listModels(conversationId?: number) {
  return getJson<ModelList>(`/api/models${scope(conversationId)}`);
}

export function getCwd(conversationId?: number) {
  return getJson<{ cwd: string; home: string }>(`/api/cwd${scope(conversationId)}`);
}

export function setCwd(path: string, conversationId?: number) {
  return postJson<{ ok: boolean; cwd: string }>(`/api/cwd${scope(conversationId)}`, { path, conversationId });
}

export function browseDir(path?: string) {
  return getJson<DirListing>(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`);
}

export function setModel(provider: string, modelId: string, conversationId?: number) {
  return postJson<{ ok: boolean }>(`/api/model${scope(conversationId)}`, { provider, modelId, conversationId });
}

export function abort(conversationId?: number) {
  return postJson<{ ok: boolean }>(`/api/abort${scope(conversationId)}`, {});
}

export function approve(id: string, allow: boolean) {
  return postJson<{ ok: boolean }>("/api/approve", { id, allow });
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const data = await getJson<{ conversations: ConversationSummary[] }>("/api/conversations");
  return data.conversations;
}

export function deleteConversation(id: number) {
  return fetch(`/api/conversations/${id}`, { method: "DELETE" }).then(async (res) => {
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${res.status}`);
    }
    return (await res.json()) as { ok: boolean; deletedRows: boolean };
  });
}

export function createConversation() {
  return postJson<{ id: number; title: string }>("/api/conversations", {});
}

/** 服务端记住的“上次在看的会话”（localStorage 的兜底）。 */
export function getLastConversation() {
  return getJson<{ conversationId: number | null }>("/api/last-conversation");
}

export function setLastConversation(conversationId: number) {
  return postJson<{ ok: boolean; conversationId: number }>("/api/last-conversation", { conversationId });
}

/** 当前会话的工具审批策略。 */
export function getPolicy(conversationId?: number) {
  return getJson<{ conversationId: number; policy: ToolPolicy; preset: PresetId }>(
    `/api/policy${scope(conversationId)}`,
  );
}

/** 改当前会话的工具审批策略。 */
export function setPolicy(policy: ToolPolicy, conversationId?: number) {
  return postJson<{ ok: boolean; conversationId: number; policy: ToolPolicy; preset: PresetId }>(
    `/api/policy${scope(conversationId)}`,
    { policy, conversationId },
  );
}

/** 重命名会话。传空串表示恢复自动标题（从第一条用户消息推）。 */
export function renameConversation(id: number, title: string) {
  return fetch(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${res.status}`);
    }
    return (await res.json()) as { ok: boolean; id: number; title: string; custom: boolean };
  });
}

export interface StreamHandlers {
  onState: (snapshot: unknown) => void;
  onApproval: (request: unknown) => void;
  onApprovalResolved: (outcome: { id: string; allow: boolean; reason: string }) => void;
  onOpen?: () => void;
  onError?: () => void;
}

/**
 * 订阅**某个会话**的事件。EventSource 自带重连，但重连后要重新拿快照 ——
 * 服务端会在每次连上时先推一份完整 state，所以这里不需要额外处理。
 */
export function subscribe(handlers: StreamHandlers, conversationId?: number): () => void {
  const startedAt = performance.now();
  const es = new EventSource(`/api/stream${scope(conversationId)}`);
  es.addEventListener("open", () => {
    timings["sse-open"] = Math.round(performance.now() - startedAt);
  });

  es.addEventListener("state", (ev) => {
    handlers.onState(JSON.parse((ev as MessageEvent).data));
  });
  es.addEventListener("approval", (ev) => {
    handlers.onApproval(JSON.parse((ev as MessageEvent).data));
  });
  es.addEventListener("approval-resolved", (ev) => {
    handlers.onApprovalResolved(JSON.parse((ev as MessageEvent).data));
  });
  es.onopen = () => handlers.onOpen?.();
  es.onerror = () => handlers.onError?.();

  return () => es.close();
}
