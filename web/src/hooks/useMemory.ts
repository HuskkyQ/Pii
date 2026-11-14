import { useCallback, useRef, useState } from "react";

import { addMemory, deleteMemory, getMemory, updateMemory } from "@/lib/api";
import type { MemoryEntry } from "@/lib/types";

export interface MemoryStoreState {
  entries: MemoryEntry[];
  /** 服务端算好的「实际会注入几条」——前端不复制预算规则 */
  injected: number;
  budgetChars: number;
  loading: boolean;
  refresh: () => Promise<void>;
  add: (input: { content: string; tags?: string[]; pinned?: boolean }) => Promise<void>;
  update: (id: number, patch: { content?: string; tags?: string[]; pinned?: boolean }) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

/**
 * 全局记忆的前端缓存。
 *
 * 和 usePolicy 一个思路：真相在服务端（它要注入给模型），前端只缓存一份用于渲染。
 * 每次写完整份重拉 —— 记忆最多几百条，比在本地做增量合并稳得多。
 */
export function useMemory(): MemoryStoreState {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [injected, setInjected] = useState(0);
  const [budgetChars, setBudgetChars] = useState(1200);
  const [loading, setLoading] = useState(false);
  /** 请求序号：连续刷新时只让最新一次响应落地 */
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const data = await getMemory();
      if (mine !== seq.current) return;
      setEntries(data.entries);
      setInjected(data.injected);
      setBudgetChars(data.budgetChars);
    } catch {
      /* 服务刚起或网断了：保留上一份，下次再刷 */
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  const add = useCallback(
    async (input: { content: string; tags?: string[]; pinned?: boolean }) => {
      await addMemory(input);
      await refresh();
    },
    [refresh],
  );

  const update = useCallback(
    async (id: number, patch: { content?: string; tags?: string[]; pinned?: boolean }) => {
      await updateMemory(id, patch);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: number) => {
      await deleteMemory(id);
      await refresh();
    },
    [refresh],
  );

  return { entries, injected, budgetChars, loading, refresh, add, update, remove };
}
