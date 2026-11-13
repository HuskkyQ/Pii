/**
 * 服务端共享状态的「插线板」。
 *
 * 以前 main.ts 把启动初始化、进程锁、agent、推送、审批、各种缓存全放在模块顶层，
 * 路由函数直接抓全局变量 —— 于是 1292 行挤在一个文件里，谁依赖谁看不出来。
 * 这里把它们收进一个显式创建、显式传递的 AppContext：
 *   - main.ts 只负责启动、注册顺序、listen / shutdown
 *   - routes/*.ts 通过 registerX(app, ctx) 拿依赖，函数签名就是依赖清单
 *
 * 纪律：这一段是**纯搬迁**。初始化顺序、启动日志、副作用一律保持原样。
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";

import type { Agent } from "../agent.ts";
import { openAgent } from "../agent.ts";
import { loadConfig, resolveArchiveDir, resolveDataDir } from "../config.ts";
import { MemoryStore } from "../memory/store.ts";
import { ApprovalBroker, type ApprovalRequest } from "./approvals.ts";
import { openConversation } from "./conversations.ts";
import { createAuth, type Auth } from "./auth.ts";
import { keepAwake, type AwakeHandle } from "./awake.ts";
import { openTaskQueries, type RunFailure } from "./db/tasks.ts";
import { acquireLock } from "./db/lock.ts";
import { LastConversation } from "./last-conversation.ts";
import { Policies, defaultPolicy, presetOf } from "./policies.ts";
import { PushHub } from "./push.ts";
import { Titles } from "./titles.ts";
import { Trash, purgeConversations } from "./trash.ts";

/** web/dist 的位置；相对路径从一个固定基准算，不依赖 cwd。 */
const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

const startedAt = Date.now();

/**
 * src/ 根目录：/api/build 扫全部 .ts 判断「要不要重启」。
 *
 * 不能只扫 `server/`：改 `agent.ts`、`tools/`、`config.ts` 同样需要重启，
 * 以前只扫 `src/server` 会让这些改动被误判成「不用重启」。
 */
const SOURCE_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * 快照窗口参数。durationOf 由调用方注入，避免这里反向依赖 createContext 内部状态。
 */
function windowOptions(
  input: { turns?: string; limit?: string; before?: string },
  durationOf: (taskId: number) => number | undefined,
  /** 默认窗口轮数（`PII_SNAPSHOT_TURNS`，一屏大概 5 轮）。 */
  defaultTurns: number,
) {
  const turns = input.turns === undefined ? defaultTurns : Number(input.turns);
  const limit = input.limit === undefined ? undefined : Number(input.limit);
  const before = input.before === undefined ? undefined : Number(input.before);
  return {
    durationOf,
    ...(Number.isFinite(turns) && turns > 0 ? { turns } : {}),
    ...(limit !== undefined && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    ...(before !== undefined && Number.isFinite(before) ? { before } : {}),
  };
}

export type { RunFailure };

/**
 * 路由与中间件能用到的全部共享状态。
 *
 * 按迁移批次逐步扩展：目前只包含启动初始化相关的部分，
 * 后续批次会把 archiveDir / clientMetrics / resolveConversation / isIdle / flags 加进来。
 */
export interface AppContext {
  dataDir: string;
  releaseLock: () => void;
  policies: Policies;
  /** 全局共享记忆（跨会话）。表在 agent.sqlite 里，与 pi-durable 共存。 */
  memory: MemoryStore;
  lastConversation: LastConversation;
  approvals: ApprovalBroker;
  watching: Map<number, number>;
  watch: (conversationId: number, delta: 1 | -1) => void;
  titles: Map<number, string>;
  customTitles: Titles;
  trash: Trash;
  auth: Auth;
  push: PushHub;
  agent: Agent;
  awake: AwakeHandle;
  startedAt: number;
  webDist: string;
  newestMtime: (dir: string) => number;
  taskDuration: (taskId: number) => number | undefined;
  latestFailure: (conversationId: number) => RunFailure | null;
  /** /api/build 扫源码的基准目录（`src/`，含 agent/tools/config 等全部源码）。 */
  sourceDir: string;
  archiveDir: string;
  clientMetrics: unknown[];
  /** 值类型的共享标记必须包成对象：解构成副本会让 /api/restart 的去重判断失效。 */
  flags: { restartPending: boolean };
  viewWindow: { min: number; max: number };
  windowOptions: (
    input: { turns?: string; limit?: string; before?: string },
  ) => ReturnType<typeof windowOptions>;
  /** 打开会话的统一入口：被删掉的一律当不存在。多个路由模块共用。 */
  resolveConversation: (id: number | undefined) => Promise<Conversation | undefined>;
  isIdle: () => Promise<boolean>;
  /** main.ts 创建 HTTP server 后交进来（ctx 创建时它还不存在）。 */
  attachServer: (server: ClosableServer) => void;
  /**
   * 优雅退出：/api/restart 与 SIGINT/SIGTERM 共用同一条路径。
   * `waitForIdleMs` 不传则用 config.shutdownIdleMs；传 0 = 不等，立刻退。
   */
  shutdown: (reason: string, options?: { waitForIdleMs?: number; exitCode?: number }) => Promise<void>;
}

/**
 * 我们只用到 node http server 的这三个方法，所以按结构类型收窄，
 * 不把 `@hono/node-server` 的具体类型拖进 ctx。
 */
export interface ClosableServer {
  close: (callback?: (error?: Error) => void) => unknown;
  /** keep-alive 的空闲连接，先收掉，省得白占满整个收尾窗口。 */
  closeIdleConnections?: () => void;
  /** 收尾窗口到期后的硬断（SSE 是长连接，不硬断的话 close() 永远不返回）。 */
  closeAllConnections?: () => void;
}


/** 递归找目录里最新的文件修改时间（只看 .ts，跳过 node_modules）。 */
function newestMtime(dir: string): number {
  let newest = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
      else if (entry.name.endsWith(".ts")) newest = Math.max(newest, statSync(full).mtimeMs);
    }
  } catch {
    /* 读不到就算了 */
  }
  return newest;
}

/**
 * 创建全部共享状态。等价于原来 main.ts 顶层的初始化段，顺序保持一致。
 *
 * 注意：这里会打开 SQLite、申请进程锁、启动 agent（含 resume）、清理已标记会话、
 * 打印启动日志 —— 都是启动期副作用，调用方只应调用一次。
 */
export async function createContext(): Promise<AppContext> {
  const config = loadConfig();
  const dataDir = resolveDataDir();
  const releaseLock = acquireLock(dataDir);
  /**
   * 全局记忆：自己开一条连接（和 Trash / taskQueries 一样），在 agent 打开前建表。
   * 先建表再 openAgent 是有意的：Harness 的 migrations 只认自己的表，多一张 `pii_` 表不影响它。
   */
  const memory = new MemoryStore({ dbPath: join(dataDir, "agent.sqlite") });
  /** 每个会话的工具审批策略（哪些工具免问）。 */
  const policies = new Policies(dataDir);
  /** 上次在看的会话（前端 localStorage 的兜底）。 */
  const lastConversation = new LastConversation(dataDir);
  const approvals = new ApprovalBroker({
    timeoutMs: config.approvalTimeoutMs,
    shouldAutoAllow: (conversationId, tool) => policies.shouldAutoAllow(conversationId, tool),
  });

  /**
   * 有人在看着哪个会话：`?c=` 的 SSE 连接计数。
   * 推送前先问一句 —— 你正盯着屏幕时不该再被手机震一下。
   */
  const watching = new Map<number, number>();
  function watch(conversationId: number, delta: 1 | -1): void {
    const next = (watching.get(conversationId) ?? 0) + delta;
    if (next <= 0) watching.delete(conversationId);
    else watching.set(conversationId, next);
  }

  /** 会话标题缓存：推送通知要一个人类能认的标题，但不想为每条通知扫一遍 entries。 */
  const titles = new Map<number, string>();

  /** 用户手动改过的标题（落文件）。列表/改名/推送都优先用它。 */
  const customTitles = new Titles(dataDir);

  const trash = new Trash(dataDir);

  /** 鉴权（PII_AUTH=1 或 PII_TOKEN=... 时生效）。提前创建，启动日志要用它。 */
  const auth = createAuth(dataDir);
  {
    const pending = trash.list();
    if (pending.length > 0) {
      const result = purgeConversations({ dbPath: join(dataDir, "agent.sqlite"), ids: pending });
      if (result.deleted.length > 0) {
        trash.forget(result.deleted);
        for (const id of result.deleted) {
          policies.forget(id);
          lastConversation.forget(id);
        }
        console.log(`  清理      删除 ${result.deleted.length} 个已标记的会话`);
      }
      if (result.failed) console.warn(`  清理失败  ${result.failed}（下次启动再试）`);
    }
  }

  const push = new PushHub({
    dataDir,
    isWatched: (conversationId) => conversationId !== undefined && (watching.get(conversationId) ?? 0) > 0,
  });

  // 审批要人在场才能继续，所以“有人要点头了”比“跑完了”更该推。
  approvals.onRequest((request: ApprovalRequest) => {
    void push.notify({
      title: titles.get(request.conversationId) ?? "pii · 需要你点头",
      body: `${request.tool}: ${JSON.stringify(request.input).slice(0, 100)}`,
      conversationId: request.conversationId,
      tag: `approval-${request.conversationId}`,
    });
  });

  const agent = await openAgent({
    dataDir,
    approvals,
    push,
    memory,
    titleOf: (conversationId) => titles.get(conversationId),
  });
  console.log(`pii 启动中…`);
  console.log(`  数据目录  ${dirname(agent.dbPath)}`);
  console.log(`  模型      ${agent.provider}/${agent.modelId}`);
  console.log(
    `  工具      ${config.toolsEnabled ? `开（默认策略：${presetOf(defaultPolicy())}，可在界面按会话调整）` : "关"}`,
  );
  console.log(`  推送      ${push.enabled ? `开（订阅 ${push.list().length} 个）` : "关"}`);
  const awake = keepAwake();
  console.log(`  睡眠      ${awake.active ? "阻止省电睡眠（锁屏照跑；合盖仍会睡）" : "照系统设置"}`);
  console.log(
    `  鉴权      ${
      auth.enabled
        ? `开（令牌：cat ${join(dataDir, "auth-token")}${auth.passwordEnabled ? "；账号密码：开，7 天免登录" : "；账号密码：未配"}）`
        : "关（PII_AUTH=1 可开）"
    }`,
  );

  /* 生成耗时 / 最近一次失败：都在 db/tasks.ts（惰性只读连接 + duration 缓存）。 */
  const { taskDuration, latestFailure, close: closeTaskQueries } = openTaskQueries(agent.dbPath);

  /** 以下定义原本散落在 main.ts 的路由之间，现收进 ctx 供多个模块共用。 */
  /** 归档目录：`PII_ARCHIVE_DIR` → `<数据目录>/archive`（解析在 config.ts）。 */
  const archiveDir = resolveArchiveDir(dataDir);
  const clientMetrics: unknown[] = [];
  const flags = { restartPending: false };

  async function resolveConversation(id: number | undefined): Promise<Conversation | undefined> {
    if (id !== undefined && trash.has(id)) return undefined;
    try {
      return await openConversation(agent, id);
    } catch (error) {
      /*
       * 第二道网（第一道在 conversations.ts 的 openConversation：先查存储行是否还在）。
       * 剩下能漏过第一道的只有一种情况：查证之后、真正读之前，另一次删除把它 purge 了。
       * 这时 pi-durable 抛 `StorageRequestError: Unknown conversation: N`，对外同样是「不存在」。
       * 只认这一种错误，其它故障（库读不了、权限、磁盘）照旧抛出去成 500，不吞。
       */
      const message = (error as Error)?.message ?? "";
      if (/Unknown conversation/i.test(message)) return undefined;
      throw error;
    }
  }

  async function isIdle(): Promise<boolean> {
    const inspection = await agent.harness.inspect(BACKGROUND_CONTEXT);
    return inspection.tasks.length === 0 && inspection.submissions.length === 0;
  }

  // 优雅退出原本是 main.ts 的局部函数，但 /api/restart 也要调它，
  // 所以收进 ctx；server 由 main.ts 在 listen 之后通过 attachServer 交进来。
  let server: ClosableServer | null = null;
  function attachServer(s: ClosableServer): void {
    server = s;
  }

  /**
   * 等所有会话空闲，最多 `timeoutMs`。返回 true = 真的空了。
   *
   * 为什么不能省这一步：正在生成的回答被腰斩后，重启时 pi-durable 会从 checkpoint
   * 续跑，而 checkpoint 里可能正躺着「执行 restart」这条命令 —— 于是重启完又把
   * 自己重启一遍，变成重启环。`/api/restart` 一直守着这条，信号处理也得守。
   */
  async function waitForIdle(timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    let announced = false;
    while (Date.now() < until) {
      try {
        if (await isIdle()) return true;
      } catch {
        /* 读失败就当还在忙 */
      }
      if (!announced) {
        console.log(`  还有任务在跑，等它结束再退（最多 ${Math.round(timeoutMs / 1000)} 秒）`);
        announced = true;
      }
      // 500ms 一轮：既能及时退，又不会把事件循环占满
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  /**
   * 停止接受新连接，并给已有连接一个收尾窗口。
   *
   * 直接 `server.close()` 然后 exit 会把所有 SSE 一刀切断；只 `close()` 不 exit
   * 又会永远等下去（EventSource 的长连接不会自己结束）。所以两头都要：
   * 先 close（不再接新连接）+ 收掉空闲连接，再在窗口到期后硬断剩下的。
   */
  async function closeServer(graceMs: number): Promise<void> {
    const s = server;
    if (!s) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          s.closeAllConnections?.();
        } catch {
          /* 断不掉也只能作罢，后面还有 process.exit */
        }
        finish();
      }, graceMs);
      try {
        s.close(() => finish());
        s.closeIdleConnections?.();
      } catch {
        finish();
      }
    });
  }

  /**
   * 真正的关停流程。顺序不能乱：
   *   ① 等空闲（可选）→ ② 停接新连接、给老连接收尾 → ③ 处置审批、停防休眠
   *   → ④ 关 harness → ⑤ 关辅助 SQLite 连接（只读查询 / 记忆）→ ⑥ 删进程锁 → exit
   *
   * ⑤ 在 ⑥ 之前：锁没了别的进程就能进来，这时还攥着库句柄就是脏读的来源。
   */
  async function doShutdown(
    reason: string,
    options: { waitForIdleMs?: number; exitCode?: number },
  ): Promise<void> {
    const idleMs = options.waitForIdleMs ?? config.shutdownIdleMs;
    console.log(`\n收到 ${reason}，开始关闭…`);

    if (idleMs > 0 && !(await waitForIdle(idleMs))) {
      console.log("  等空闲超时，仍然退出（进度留在 checkpoint 里）");
    }

    await closeServer(config.shutdownGraceMs);

    approvals.dispose();
    awake.stop();
    try {
      await agent.harness.close(BACKGROUND_CONTEXT);
    } catch (error) {
      // 关不掉也要继续走完：锁不释放、只读句柄不关，下次启动更麻烦
      console.error("  关闭 harness 失败（继续退出）:", error);
    }
    closeTaskQueries();
    memory.close();
    releaseLock();
    console.log(`  已退出（${reason}）`);
    // 正常关停 = 0；因未捕获异常而关停 = 非 0，让编排/日志能区分「我要求它退」和「它自己崩了」
    process.exit(options.exitCode ?? 0);
  }

  /**
   * 幂等：`/api/restart` 排队的关停和随后到达的 SIGTERM 可能前后脚触发，
   * 只应该跑一次（第二次调用拿到的是同一个 Promise）。
   */
  let shuttingDown: Promise<void> | null = null;
  function shutdown(
    reason: string,
    options: { waitForIdleMs?: number; exitCode?: number } = {},
  ): Promise<void> {
    shuttingDown ??= doShutdown(reason, options);
    return shuttingDown;
  }

  return {
    sourceDir: SOURCE_DIR,
    archiveDir,
    clientMetrics,
    flags,
    /*
     * `Conversation.watch()` 的视图窗口大小（pi-durable 1.5 起 `viewState()` 被它取代）。
     * 开到比任何真实会话都大，翻页游标 `?before=` 才不会让历史凭空消失。
     */
    viewWindow: { min: config.viewEntries, max: config.viewEntries },
    windowOptions: (input) => windowOptions(input, taskDuration, config.snapshotTurns),
    resolveConversation,
    isIdle,
    attachServer,
    shutdown,
    dataDir,
    releaseLock,
    policies,
    memory,
    lastConversation,
    approvals,
    watching,
    watch,
    titles,
    customTitles,
    trash,
    auth,
    push,
    agent,
    awake,
    startedAt,
    webDist: WEB_DIST,
    newestMtime,
    taskDuration,
    latestFailure,
  };
}
