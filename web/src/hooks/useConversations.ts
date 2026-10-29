import { useCallback, useEffect, useState } from "react";

import { createConversation, listConversations } from "@/lib/api";
import type { ConversationSummary } from "@/lib/types";

export interface ConversationsStore {
  items: ConversationSummary[];
  refresh: () => Promise<void>;
  create: () => Promise<number>;
  creating: boolean;
}

/**
 * 会话列表。
 *
 * 之所以不做「本地追加」：标题是**从第一条用户消息推出来的**，
 * 新建会话时标题还是「新对话」，等你发了第一句才变成真正的内容。
 * 与其在前端猜标题，不如直接跟服务端要一份真的。
 */
export function useConversations(): ConversationsStore {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setItems(await listConversations());
    } catch {
      /* 服务刚起或网断了，保留上一份列表，下次再刷 */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async () => {
    setCreating(true);
    try {
      const { id } = await createConversation();
      await refresh();
      return id;
    } finally {
      setCreating(false);
    }
  }, [refresh]);

  return { items, refresh, create, creating };
}
