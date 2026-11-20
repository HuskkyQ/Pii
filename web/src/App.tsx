import { useCallback, useEffect, useRef, useState } from "react";

import { ApprovalCards } from "@/components/ApprovalCards";
import { ConversationsPanel } from "@/components/ConversationsPanel";
import { CwdPicker } from "@/components/CwdPicker";
import { DebugHud } from "@/components/DebugHud";
import { InstallHint } from "@/components/InstallHint";
import { MemoryPanel } from "@/components/MemoryPanel";
import { ModelPicker } from "@/components/ModelPicker";
import { PermissionPicker } from "@/components/PermissionPicker";
import { StatusBar } from "@/components/StatusBar";
import { Composer } from "@/components/chat/Composer";
import { Transcript } from "@/components/chat/Transcript";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { deleteConversation, getLastConversation, prompt, renameConversation, setLastConversation } from "@/lib/api";
import { useConversations } from "@/hooks/useConversations";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { usePii } from "@/hooks/usePii";
import { usePolicy } from "@/hooks/usePolicy";
import { imageSrc, type ImagePart } from "@/lib/image";
import type { Block } from "@/lib/types";
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

/** PC 侧栏收起状态：刷新 / 下次打开还保持，和「记住最后会话」一个套路。 */
const SIDEBAR_COLLAPSED_KEY = "pii:sidebar-collapsed";

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** 落在头部下方：安全区 + 头部高度(≈48) + 一点缝。 */
const TOAST_OFFSET = { top: "calc(env(safe-area-inset-top) + 56px)" };

type PickerKind = "model" | "cwd" | "permissions";
type OpenPicker = { kind: PickerKind; anchor: HTMLElement } | null;

export default function App() {
  const [activeId, setActiveId] = useState<number | undefined>(readInitialConversation);
  const [menuOpen, setMenuOpen] = useState(false);
  /** PC 左侧会话栏是否收起；手机只有抽屉，这个值在手机端不参与渲染 */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [picker, setPicker] = useState<OpenPicker>(null);
  /** 刚新建的会话 id：目录选择器要作用于它（而不是还未来得及切过去的 currentId） */
  const [cwdTarget, setCwdTarget] = useState<number | undefined>(undefined);
  const closePicker = useCallback(() => setPicker(null), []);

  /*
   * 头部左上那一个按钮，两端做两件事：
   *   PC  → 收起 / 展开左侧会话栏
   *   H5  → 拉出会话抽屉（手机没有常驻侧栏）
   * 位置不变，用户不用重新找按钮。
   */
  const handleMenuClick = useCallback(() => {
    if (isDesktop) setSidebarCollapsed((value) => !value);
    else setMenuOpen(true);
  }, [isDesktop]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      /* 隐私模式 / 无存储权限时忽略，只是下次不记得而已 */
    }
  }, [sidebarCollapsed]);

  const [quote, setQuote] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);

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
   * 新建会话 + 立刻选目录。
   *
   * 为什么不把「选目录」套在每个新建上：大部分时候你就在同一个项目里连续开几个会话，
   * 每建一个都要选一次目录很烦。所以「+」沿用当前目录，「📁+」才弹选择器。
   */
  const createNewWithCwd = useCallback(
    async (anchor: HTMLElement) => {
      const id = await create();
      select(id);
      setCwdTarget(id);
      setPicker({ kind: "cwd", anchor });
    },
    [create, select],
  );

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
      try {
        const fallback = items.find((item) => item.id !== id);
        if (id === currentId) {
          if (fallback) select(fallback.id);
          else {
            const created = await create();
            select(created);
          }
        }

        /*
         * 服务端在旧 SSE 还没断开时会 409（「先切到别的会话再删」）。
         * 不要用固定 500ms 赌它断开：重试几次，每次只等 250ms。
         * 「还有没跑完的任务」也是 409，但重试没用，直接提示。
         */
        for (let attempt = 0; ; attempt += 1) {
          try {
            await deleteConversation(id);
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const stillWatched = message.startsWith("409") && message.includes("还开着");
            if (!stillWatched || attempt >= 6) {
              toast.error(message.replace(/^409\s*/, "") || "删除失败");
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        await refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "删除失败");
      }
    },
    [create, currentId, items, refresh, select],
  );

  // 会话标题来自第一条用户消息 —— 切会话立刻刷新；条目数变化（生成中）防抖后再刷
  const entryCount = snapshot?.entries.length ?? 0;
  useEffect(() => {
    void refresh();
  }, [activeId, refresh]);

  useEffect(() => {
    if (entryCount === 0) return;
    const timer = setTimeout(() => void refresh(), 400);
    return () => clearTimeout(timer);
  }, [entryCount, refresh]);

  /*
   * 乐观回显（local echo）。
   *
   * 为什么需要：客户端按纪律不做乐观合并（快照是账单），而快照是整份推的 ——
   * 这条会话一帧 260KB 左右，手机上要一两秒才下载完。于是点发送之后，
   * 输入框清空了、列表里却什么都没有，看起来像没发出去。
   *
   * 做法：发送前先在本地插一条「回声」，它只是**界面上的临时气泡**，
   * 一旦快照里出现比它更新的 pi.user 条目就撤掉 —— 权威数据始终是快照。
   * 发送失败（onEcho 返回的 undo 被调用）也撤掉。
   */
  const echoSeq = useRef(0);
  const [echo, setEcho] = useState<{
    seq: number;
    blocks: Block[];
    afterId: number;
    queued: boolean;
    /** sending = 还没进快照；thinking = 进快照了，但模型还没开始输出 */
    phase: "sending" | "thinking";
  } | null>(null);

  const onEcho = useCallback(
    (text: string, images: ImagePart[] = []) => {
      const blocks: Block[] = [];
      if (text) blocks.push({ type: "text", text });
      for (const image of images) {
        blocks.push({ type: "image", mimeType: image.mimeType, url: imageSrc(image) });
      }
      if (blocks.length === 0) return () => {};

      const seq = ++echoSeq.current;
      // 记下当前最新条目 id：之后出现更大的 pi.user 条目，说明这条真的落库了
      const afterId = Math.max(0, ...(snapshot?.entries ?? []).map((entry) => entry.id));
      setEcho({ seq, blocks, afterId, queued: Boolean(snapshot?.live), phase: "sending" });
      return () => setEcho((current) => (current?.seq === seq ? null : current));
    },
    [snapshot],
  );

  /*
   * 回声的两段生命周期：
   *   sending  → 快照确认这条消息进库（出现 id 更大的 pi.user 条目）
   *   thinking → 模型还没开口（没有 pi.live、也没有新的 pi.assistant 条目）
   * 一旦 live 或回答出现，就交给真正的渲染，回声退场。
   */
  useEffect(() => {
    if (!echo) return;
    const entries = snapshot?.entries ?? [];
    const live = Boolean(snapshot?.live);
    const answered = entries.some((entry) => entry.kind === "pi.assistant" && entry.id > echo.afterId);
    if (live || answered || snapshot?.runError) {
      setEcho(null);
      return;
    }
    const landed = entries.some((entry) => entry.kind === "pi.user" && entry.id > echo.afterId);
    if (landed && echo.phase === "sending") setEcho((current) => (current ? { ...current, phase: "thinking" } : current));
  }, [snapshot, echo]);

  // 换会话时不能把上一条会话的回声带过去
  useEffect(() => {
    setEcho(null);
  }, [activeId]);

  return (
    <TooltipProvider delayDuration={250}>
      {/*
       * 顶部/底部的白色渐隐画在**整窗**上，而不是头栏、输入框各自画一条。
       *
       * 以前各画各的：那两条光的左边界正好落在侧栏右边缘，于是侧栏那侧没有光、
       * 主区那侧有光 —— 屏幕上方出现一条只有几十像素高的竖硬边，
       * 也就是肉眼看到的「割裂」。光的边界不该和布局的边界重合。
       */}
      <div
        aria-hidden
        className="edge-fade-down pointer-events-none fixed inset-x-0 top-0 z-0 h-[52px]"
      />
      <div
        aria-hidden
        className="edge-fade-up pointer-events-none fixed inset-x-0 bottom-0 z-0 h-[126px]"
      />

      <div className="relative z-10 flex h-dvh text-foreground">
        <ConversationsPanel
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          collapsed={sidebarCollapsed}
          items={items}
          activeId={currentId}
          onSelect={select}
          onCreate={() => void createNew()}
          onCreateWithCwd={(anchor) => void createNewWithCwd(anchor)}
          creating={creating}
          onDelete={remove}
          onOpenMemory={() => {
            // 手机上记忆面板是独立的底层弹层：先收抽屉，避免两层遮罩叠着
            setMenuOpen(false);
            setMemoryOpen(true);
          }}
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
            onMenuClick={handleMenuClick}
            sidebarCollapsed={sidebarCollapsed}
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
              pending={echo ? { blocks: echo.blocks, queued: echo.queued, phase: echo.phase } : null}
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
              onOpenModels={(anchor) => setPicker({ kind: "model", anchor })}
              onOpenCwd={(anchor) => {
                setCwdTarget(undefined);
                setPicker({ kind: "cwd", anchor });
              }}
              onOpenPermissions={(anchor) => setPicker({ kind: "permissions", anchor })}
              permissionPreset={permissionPreset}
              quote={quote}
              onClearQuote={() => setQuote(null)}
              onEcho={onEcho}
            />
          </div>
        </div>

        {/*
         * toast 必须避让刘海/状态栏：standalone 里页面顶到屏幕最上方，
         * 默认的 top 位置会被状态栏和头部盖住（实测：点铃铛后提示看不见）。
         * 52px ≈ 头部高度，env() 在浏览器里是 0，不影响桌面。
         */}
        <ModelPicker
          open={picker?.kind === "model"}
          anchor={picker?.kind === "model" ? picker.anchor : null}
          conversationId={currentId}
          current={snapshot?.agent?.model}
          onClose={closePicker}
          onPicked={() => void refresh()}
        />

        <CwdPicker
          open={picker?.kind === "cwd"}
          anchor={picker?.kind === "cwd" ? picker.anchor : null}
          conversationId={cwdTarget ?? currentId}
          onClose={() => {
            closePicker();
            setCwdTarget(undefined);
          }}
          onPicked={() => {
            setCwdTarget(undefined);
            void refresh();
          }}
        />

        <PermissionPicker
          open={picker?.kind === "permissions"}
          anchor={picker?.kind === "permissions" ? picker.anchor : null}
          policy={policy}
          preset={permissionPreset}
          onApply={updatePolicy}
          onClose={closePicker}
        />

        <MemoryPanel open={memoryOpen} onClose={() => setMemoryOpen(false)} />

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
