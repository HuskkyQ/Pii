import { useCallback, useEffect, useState } from "react";

import { ApprovalCards } from "@/components/ApprovalCards";
import { ConversationsPanel } from "@/components/ConversationsPanel";
import { CwdPicker } from "@/components/CwdPicker";
import { DebugHud } from "@/components/DebugHud";
import { InstallHint } from "@/components/InstallHint";
import { ModelPicker } from "@/components/ModelPicker";
import { PermissionPicker } from "@/components/PermissionPicker";
import { StatusBar } from "@/components/StatusBar";
import { Composer } from "@/components/chat/Composer";
import { Transcript } from "@/components/chat/Transcript";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { deleteConversation, getLastConversation, prompt, renameConversation, setLastConversation } from "@/lib/api";
import { useConversations } from "@/hooks/useConversations";
import { usePii } from "@/hooks/usePii";
import { usePolicy } from "@/hooks/usePolicy";
import { toast } from "sonner";

/** URL 里的 `?c=<id>` 是唯一的路由状态：刷新、分享、主屏幕重启都靠它。 */
function readConversationFromUrl(): number | undefined {
  const raw = new URLSearchParams(window.location.search).get("c");
  if (!raw) return undefined;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function writeConversationToUrl(id: number | undefined): void {
  const url = new URL(window.location.href);
  if (id === undefined) url.searchParams.delete("c");
  else url.searchParams.set("c", String(id));
  window.history.replaceState(null, "", url);
}

/**
 * PWA 冷启动会落在 manifest 的 `start_url`（`/`，不带 `?c=`），
 * 所以「关闭时是哪个、打开还是哪个」不能只靠 URL —— 把最后会话存进 localStorage，
 * 启动时 URL 没带 `?c=` 就用它恢复。
 */
const LAST_CONVERSATION_KEY = "pii:last-conversation";

function readStoredConversation(): number | undefined {
  try {
    const raw = localStorage.getItem(LAST_CONVERSATION_KEY);
    if (!raw) return undefined;
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredConversation(id: number | undefined): void {
  try {
    if (id === undefined) localStorage.removeItem(LAST_CONVERSATION_KEY);
    else localStorage.setItem(LAST_CONVERSATION_KEY, String(id));
  } catch {
    /* 隐私模式 / 无存储权限时忽略，退化成原来的行为 */
  }
}

/** URL 优先（分享链接、刷新），否则恢复上次看的会话（PWA 冷启动）。 */
function readInitialConversation(): number | undefined {
  return readConversationFromUrl() ?? readStoredConversation();
}

/** 落在头部下方：安全区 + 头部高度(≈48) + 一点缝。 */
const TOAST_OFFSET = { top: "calc(env(safe-area-inset-top) + 56px)" };

export default function App() {
  const [activeId, setActiveId] = useState<number | undefined>(readInitialConversation);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [cwdOpen, setCwdOpen] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  const [quote, setQuote] = useState<string | null>(null);

  const { items, refresh, create, creating } = useConversations();
  const { connection, snapshot, approvals, approve, older, hasMore, loadingOlder, loadOlder } =
    usePii(activeId);

  // activeId 为空时（首屏 / 从主屏幕冷启动）root 的 id 只有快照知道
  const currentId = activeId ?? snapshot?.conversationId;
  const title = items.find((item) => item.id === currentId)?.title ?? "pii";
  const running = snapshot?.live?.phase === "generating" || snapshot?.live?.phase === "tools";

  // 当前会话的审批策略（按会话存；切会话会重新拉）
  const { policy, preset: permissionPreset, update: updatePolicy } = usePolicy(currentId);

  const select = useCallback((id: number) => {
    setActiveId(id);
  }, []);

  // 当前会话一变，就同步到 URL（刷新/分享）和 localStorage（PWA 冷启动恢复），并上报服务端兜底
  useEffect(() => {
    writeConversationToUrl(activeId);
    writeStoredConversation(activeId);
    if (activeId !== undefined) void setLastConversation(activeId).catch(() => {});
  }, [activeId]);

  // 兜底：localStorage 不可靠时（如 iOS 独立 PWA），URL 和本地都没有就问服务端要上次会话
  useEffect(() => {
    if (readConversationFromUrl() !== undefined) return;
    if (readStoredConversation() !== undefined) return;
    let cancelled = false;
    getLastConversation()
      .then(({ conversationId }) => {
        if (cancelled || conversationId == null) return;
        setActiveId((prev) => prev ?? conversationId);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 恢复出来的会话可能已经被删了：等会话列表加载完，如果找不到就退回 root。
  // 注意列表上限 50：已满 50 条时可能被截断，不能据此断定“不存在”（否则老会话会被误清）。
  useEffect(() => {
    if (activeId === undefined || items.length === 0) return;
    if (items.length >= 50) return;
    if (items.some((item) => item.id === activeId)) return;
    setActiveId(undefined);
  }, [activeId, items]);

  const createNew = useCallback(async () => {
    const id = await create();
    select(id);
  }, [create, select]);

  /**
   * 重命名当前会话。空串表示恢复自动标题（从第一条用户消息推）。
   * 失败时 toast 并抛出，让 StatusBar 保留编辑态、方便重试。
   */
  const rename = useCallback(
    async (next: string) => {
      if (currentId === undefined) return;
      try {
        await renameConversation(currentId, next);
        await refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "重命名失败");
        throw error;
      }
    },
    [currentId, refresh],
  );

  /**
   * 删除会话。
   *
   * 顺序很重要：**先切走，再删**。
   * 服务端会拒绝删除「还有人开着 SSE」的会话（怕 Harness 往已删的会话里写），
   * 所以先 select 到别的会话、等旧连接断开，再发 DELETE。
   */
  const remove = useCallback(
    async (id: number) => {
      const fallback = items.find((item) => item.id !== id);
      if (id === currentId) {
        if (fallback) select(fallback.id);
        else {
          const created = await create();
          select(created);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await deleteConversation(id);
      await refresh();
    },
    [create, currentId, items, refresh, select],
  );

  // 会话标题来自第一条用户消息 —— 发了第一句、或切了会话之后要重新问一遍服务端
  const entryCount = snapshot?.entries.length ?? 0;
  useEffect(() => {
    void refresh();
  }, [activeId, entryCount, refresh]);

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-dvh bg-background text-foreground">
        <ConversationsPanel
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          items={items}
          activeId={currentId}
          onSelect={select}
          onCreate={() => void createNew()}
          creating={creating}
          onDelete={remove}
        />

        {/*
         * --app-pt 由 lib/viewport.ts 实测后写入：
         * 视口已经在状态栏下方 → 0；视口盖住状态栏 → env(safe-area-inset-top)。
         * 直接用 env() 会在「视口已被扣掉状态栏」的机型上顶部多留一条空白。
         */}
        <div className="flex min-w-0 flex-1 flex-col pt-[var(--app-pt,env(safe-area-inset-top))]">
          <StatusBar
            connection={connection}
            snapshot={snapshot}
            title={title}
            onOpenMenu={() => setMenuOpen(true)}
            onRename={currentId === undefined ? undefined : rename}
            conversationId={currentId}
          />
          <main className="min-h-0 flex-1">
            <Transcript
              snapshot={snapshot}
              older={older}
              hasMore={hasMore}
              loadingOlder={loadingOlder}
              onLoadOlder={() => void loadOlder()}
              onQuote={(text) => setQuote(text)}
              runError={snapshot?.runError ?? null}
              onRetry={() => {
                const last = [...(snapshot?.entries ?? [])].reverse().find((entry) => entry.kind === "pi.user");
                const text = last?.blocks.map((block) => (block.type === "text" ? block.text : "")).join("").trim();
                if (text) void prompt(text, currentId);
              }}
            />
          </main>
          <div className="relative">
            <InstallHint />
            <ApprovalCards approvals={approvals} onDecide={(id, allow) => void approve(id, allow)} />
            <Composer
              running={running}
              disabled={connection !== "open"}
              conversationId={currentId}
              model={snapshot?.agent?.model}
              cwd={snapshot?.agent?.cwd}
              onOpenModels={() => setModelOpen(true)}
              onOpenCwd={() => setCwdOpen(true)}
              onOpenPermissions={() => setPermOpen(true)}
              permissionPreset={permissionPreset}
              quote={quote}
              onClearQuote={() => setQuote(null)}
            />
          </div>
        </div>

        {/*
         * toast 必须避让刘海/状态栏：standalone 里页面顶到屏幕最上方，
         * 默认的 top 位置会被状态栏和头部盖住（实测：点铃铛后提示看不见）。
         * 52px ≈ 头部高度，env() 在浏览器里是 0，不影响桌面。
         */}
        <ModelPicker
          open={modelOpen}
          conversationId={currentId}
          current={snapshot?.agent?.model}
          onClose={() => setModelOpen(false)}
          onPicked={() => void refresh()}
        />

        <CwdPicker
          open={cwdOpen}
          conversationId={currentId}
          onClose={() => setCwdOpen(false)}
          onPicked={() => void refresh()}
        />

        <PermissionPicker
          open={permOpen}
          policy={policy}
          preset={permissionPreset}
          onApply={updatePolicy}
          onClose={() => setPermOpen(false)}
        />

        <DebugHud />

        <Toaster
          position="top-center"
          /* 桌面读 offset，手机读 mobileOffset —— sonner 用两套 CSS 变量，两个都得给。 */
          offset={TOAST_OFFSET}
          mobileOffset={TOAST_OFFSET}
          /* 只留一条：sonner 会把多条 toast 向上堆叠，栈顶那条会盖住头部 */
          visibleToasts={1}
        />
      </div>
    </TooltipProvider>
  );
}
