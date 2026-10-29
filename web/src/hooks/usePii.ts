import { useCallback, useEffect, useRef, useState } from "react";

import { approve as apiApprove, fetchOlderEntries, markFirstState, subscribe } from "@/lib/api";
import type { ApprovalRequest, ConnectionState, Entry, Snapshot } from "@/lib/types";


/**
 * 上次看到的快照，存在 localStorage 里。
 *
 * 为什么要它：链路慢的时候（Funnel 入口在境外，单程几百毫秒到一两秒），
 * 打开 App 要等首帧快照，用户盯的就是 5 秒骨架。
 * 把上一份快照先画出来（内容旧几秒，聊天场景完全可接受），
 * 真快照到了再整体替换（**快照是账单**，替换不是合并，不会出现半新半旧）。
 *
 * 只存「最近 N 条」的那一份，图片是 URL 不是 base64，所以一份通常几十 KB。
 */
const CACHE_PREFIX = "pii:snapshot:";
const CACHE_MAX_BYTES = 400_000;

function readCachedSnapshot(conversationId: number | undefined): Snapshot | null {
  if (conversationId === undefined) return null;
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${conversationId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Snapshot;
    return parsed?.conversationId === conversationId ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedSnapshot(snapshot: Snapshot): void {
  try {
    const raw = JSON.stringify(snapshot);
    if (raw.length > CACHE_MAX_BYTES) return; // 太大就不存，别把 localStorage 塞满
    localStorage.setItem(`${CACHE_PREFIX}${snapshot.conversationId}`, raw);
  } catch {
    /* 隐私模式 / 配额满，忽略 */
  }
}

export interface PiiStore {
  connection: ConnectionState;
  snapshot: Snapshot | null;
  approvals: ApprovalRequest[];
  approve: (id: string, allow: boolean) => Promise<void>;
  /** 往前往上翻出来的历史（和服务端窗口拼接） */
  older: Entry[];
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
}

/**
 * 唯一的状态来源，**绑定一个会话**。
 *
 * 纪律：
 *  - **快照是账单** —— 收到 state 就整体替换，不做乐观合并。
 *  - **换会话 = 换一条流** —— 上一条流的事件一律丢掉，否则会出现
 *    「A 会话的回答闪现在 B 会话里」这种串台。
 */
export function usePii(conversationId?: number): PiiStore {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [older, setOlder] = useState<Entry[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    // 切会话先清场：标题、transcript、审批都换人
    setConnection("connecting");
    // 先放上「上次的画面」——链路慢时这一下就能把骨架消掉
    setSnapshot(readCachedSnapshot(conversationId));
    setApprovals([]);
    setOlder([]);
    setOlderHasMore(null);
    seen.current = new Set();

    const stop = subscribe(
      {
        onState: (value) => {
          const next = value as Snapshot;
          // 迟到的旧流事件直接丢（服务端也可能在我们切走后还发一帧）
          if (conversationId !== undefined && next.conversationId !== conversationId) return;
          markFirstState();
          setSnapshot(next);
          writeCachedSnapshot(next);
        },
        onApproval: (value) => {
          const request = value as ApprovalRequest;
          if (conversationId !== undefined && request.conversationId !== conversationId) return;
          if (seen.current.has(request.id)) return;
          seen.current.add(request.id);
          setApprovals((prev) => [...prev, request]);
        },
        onApprovalResolved: (outcome) => {
          seen.current.delete(outcome.id);
          setApprovals((prev) => prev.filter((item) => item.id !== outcome.id));
        },
        onOpen: () => setConnection("open"),
        onError: () => setConnection("closed"),
      },
      conversationId,
    );
    return stop;
  }, [conversationId]);

  const approve = useCallback(async (id: string, allow: boolean) => {
    // 先本地移除，避免连点；失败也不影响（服务端会推 resolved 事件兜底）
    seen.current.delete(id);
    setApprovals((prev) => prev.filter((item) => item.id !== id));
    await apiApprove(id, allow).catch(() => {
      /* 超时或已答过，服务端返回 409，不需要打扰用户 */
    });
  }, []);

  /**
   * 往前翻一页。
   *
   * 游标用「当前最老的那条 id」：没翻过时用快照的 oldestEntryId，
   * 翻过一次之后就变成 older[0].id —— 这样连续翻不会重复或跳过。
   */
  const loadOlder = useCallback(async () => {
    const cursor = older[0]?.id ?? snapshot?.oldestEntryId ?? undefined;
    if (cursor === undefined || cursor === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await fetchOlderEntries(conversationId, cursor);
      const rows = (page.entries ?? []) as Entry[];
      setOlder((prev) => {
        const seenIds = new Set(rows.map((row) => row.id));
        return [...rows, ...prev.filter((row) => !seenIds.has(row.id))];
      });
      setOlderHasMore(Boolean(page.hasMore));
    } catch {
      /* 翻页失败不打扰用户，按钮还能再点 */
    } finally {
      setLoadingOlder(false);
    }
  }, [conversationId, loadingOlder, older, snapshot?.oldestEntryId]);

  const hasMore = older.length > 0 ? (olderHasMore ?? false) : (snapshot?.hasMore ?? false);

  return { connection, snapshot, approvals, approve, older, hasMore, loadingOlder, loadOlder };
}
