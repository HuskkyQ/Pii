import { useCallback, useEffect, useState } from "react";

import { getPolicy, setPolicy } from "@/lib/api";
import type { PresetId, ToolPolicy } from "@/lib/types";

export interface PolicyStore {
  policy: ToolPolicy | null;
  preset: PresetId | null;
  refresh: () => Promise<void>;
  update: (policy: ToolPolicy) => Promise<void>;
}

/**
 * 当前会话的审批策略。
 *
 * 和 useConversations 一样的思路：真相在服务端（要落库、要给 broker 用），
 * 前端只缓存一份用来渲染 chip 标签和面板。切会话时重新拉。
 */
export function usePolicy(conversationId?: number): PolicyStore {
  const [policy, setLocalPolicy] = useState<ToolPolicy | null>(null);
  const [preset, setPreset] = useState<PresetId | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getPolicy(conversationId);
      setLocalPolicy(data.policy);
      setPreset(data.preset);
    } catch {
      /* 服务刚起或网断了，保留上一份，下次再刷 */
    }
  }, [conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = useCallback(
    async (next: ToolPolicy) => {
      const data = await setPolicy(next, conversationId);
      setLocalPolicy(data.policy);
      setPreset(data.preset);
    },
    [conversationId],
  );

  return { policy, preset, refresh, update };
}
