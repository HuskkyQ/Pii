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
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";

import type { Agent } from "../agent.ts";
import { openAgent, resolveDataDir } from "../agent.ts";
import { ApprovalBroker, type ApprovalRequest } from "./approvals.ts";
import { openConversation } from "./conversations.ts";
import { createAuth, type Auth } from "./auth.ts";
import { keepAwake, type AwakeHandle } from "./awake.ts";
import { LastConversation } from "./last-conversation.ts";
import { Policies, defaultPolicy, presetOf } from "./policies.ts";
import { PushHub } from "./push.ts";
import { Titles } from "./titles.ts";
import { Trash, purgeConversations } from "./trash.ts";

/** web/dist 的位置；相对路径从一个固定基准算，不依赖 cwd。 */
const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

const startedAt = Date.now();

/** 本文件所在目录 = 原 main.ts 所在目录，供 /api/build 扫 .ts 判断「要不要重启」。 */
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/** 一屏大概 5 轮对话（用户消息 + 最终回答 = 2 条 → 10 条）。 */
const SNAPSHOT_TURNS = Number(process.env.PII_SNAPSHOT_TURNS ?? 5);

/**
 * `Conversation.watch()` 的视图窗口大小（pi-durable 1.5 起 `viewState()` 被它取代）。
 * 开到比任何真实会话都大，翻页游标 `?before=` 才不会让历史凭空消失。
 */
const VIEW_WINDOW = {
  min: Number(process.env.PII_VIEW_ENTRIES ?? 2000),
  max: Number(process.env.PII_VIEW_ENTRIES ?? 2000),
};

/** 快照窗口参数。durationOf 由调用方注入，避免这里反向依赖 createContext 内部状态。 */
function windowOptions(
  input: { turns?: string; limit?: string; before?: string },
  durationOf: (taskId: number) => number | undefined,
) {
  const turns = input.turns === undefined ? SNAPSHOT_TURNS : Number(input.turns);
  const limit = input.limit === undefined ? undefined : Number(input.limit);
  const before = input.before === undefined ? undefined : Number(input.before);
  return {
    durationOf,
    ...(Number.isFinite(turns) && turns > 0 ? { turns } : {}),
    ...(limit !== undefined && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    ...(before !== undefined && Number.isFinite(before) ? { before } : {}),
  };
}

/** 最近一次失败的运行，随快照一起发给前端画红条。 */
export interface RunFailure {
  taskId: number;
  message: string;
  reason?: string;
  at?: number;
}

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
  /** /api/build 扫源码的基准目录（搬走路由后不能再用 import.meta.url，否则只扫到 routes/）。 */
  serverDir: string;
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
  attachServer: (server: { close: () => void }) => void;
  /** 优雅退出：/api/restart 与 SIGINT/SIGTERM 共用同一条路径。 */
  shutdown: (reason: string) => Promise<void>;
}

/**
 * 一个 storage 只能被一个进程持有；用一个锁文件兜住。
 *
 * 锁文件里存 `主机名:pid`，不只是一个 pid。为什么：
 *   容器被 `docker rm -f` 杀掉时不会走优雅退出，锁文件留在数据目录里。
 *   下次启动如果只看 pid，就可能撞上「新容器里恰好也有个同号进程」，
 *   于是永远启动不了（crash loop）。加上主机名之后：
 *     - 主机名不同 → 上一代容器的残留，直接覆盖
 *     - 主机名相同且进程还在 → 真的重复启动，拒绝
 */
function acquireLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, "server.lock");
  const identity = `${hostname()}:${process.pid}`;

  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    // 兼容老格式（纯 pid）
    const [maybeHost, maybePid] = raw.includes(":") ? raw.split(":") : [undefined, raw];
    const existingHost = maybeHost;
    const existingPid = Number(maybePid);

    const sameHost = existingHost === undefined ? true : existingHost === hostname();
    if (sameHost && existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0);
        throw new Error(`已经有 pii 在跑（pid ${existingPid}），数据目录 ${dir}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  writeFileSync(lockPath, identity);
  return () => rmSync(lockPath, { force: true });
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
  const dataDir = resolveDataDir();
  const releaseLock = acquireLock(dataDir);
  /** 每个会话的工具审批策略（哪些工具免问）。 */
  const policies = new Policies(dataDir);
  /** 上次在看的会话（前端 localStorage 的兜底）。 */
  const lastConversation = new LastConversation(dataDir);
  const approvals = new ApprovalBroker({
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
    titleOf: (conversationId) => titles.get(conversationId),
  });
  console.log(`pii 启动中…`);
  console.log(`  数据目录  ${dirname(agent.dbPath)}`);
  console.log(`  模型      ${agent.provider}/${agent.modelId}`);
  console.log(
    `  工具      ${process.env.PII_TOOLS === "0" ? "关" : `开（默认策略：${presetOf(defaultPolicy())}，可在界面按会话调整）`}`,
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

  /**
   * 生成耗时（思考用时的兵底）：每条 assistant entry 的 `byTaskId` 对应 tasks 表里一次生成，
   * 记录有 startedAt/endedAt。用一个**只读连接 + 缓存**按 taskId 取（已落定不变，永久缓存）。
   * 前端实时计时（精确）会优先覆盖它；这里只给历史消息一个可复现的近似值。
   */
  let durationDb: DatabaseSync | null = null;
  const durationCache = new Map<number, number | undefined>();
  function taskDuration(taskId: number): number | undefined {
    if (durationCache.has(taskId)) return durationCache.get(taskId);
    let value: number | undefined;
    try {
      if (!durationDb) {
        durationDb = new DatabaseSync(agent.dbPath, { readOnly: true });
        durationDb.exec("PRAGMA busy_timeout = 1000");
      }
      const row = durationDb.prepare("SELECT record FROM tasks WHERE id = ?").get(taskId) as
        | { record?: string }
        | undefined;
      if (row?.record) {
        const record = JSON.parse(row.record) as { startedAt?: unknown; endedAt?: unknown };
        if (typeof record.startedAt === "number" && typeof record.endedAt === "number") {
          value = Math.max(0, record.endedAt - record.startedAt);
        }
      }
    } catch {
      /* 读不到就当没有，不影响主流程 */
    }
    durationCache.set(taskId, value);
    return value;
  }

  /**
   * 最近一次失败的运行。
   *
   * 为什么需要：模型不可达（隧道断了、API key 失效、被限流）时，pi-durable 只把任务标成
   * `failed`，**不会往对话里写任何东西** —— 用户看到的就是「消息发出去，永远没有回复」。
   * 实测过：隧道断了之后界面完全没提示，只能靠猜。
   *
   * 这里从 tasks 表里捞最近一条失败记录，随快照一起发出去，前端画一条红色提示。
   */
  function latestFailure(conversationId: number): RunFailure | null {
    try {
      if (!durationDb) {
        durationDb = new DatabaseSync(agent.dbPath, { readOnly: true });
        durationDb.exec("PRAGMA busy_timeout = 1000");
      }
      const row = durationDb
        .prepare(
          "SELECT id, record FROM tasks WHERE conversation_id = ? AND status = 'terminal' ORDER BY id DESC LIMIT 1",
        )
        .get(conversationId) as { id?: number; record?: string } | undefined;
      if (!row?.record) return null;

      const record = JSON.parse(row.record) as {
        endedAt?: unknown;
        state?: { outcome?: { status?: string; error?: { message?: string; detail?: { reason?: string } } } };
      };
      const outcome = record.state?.outcome;
      if (outcome?.status !== "failed") return null;

      return {
        taskId: Number(row.id),
        message: outcome.error?.message ?? "运行失败",
        ...(outcome.error?.detail?.reason ? { reason: outcome.error.detail.reason } : {}),
        ...(typeof record.endedAt === "number" ? { at: record.endedAt } : {}),
      };
    } catch {
      return null;
    }
  }

  /** 以下定义原本散落在 main.ts 的路由之间，现收进 ctx 供多个模块共用。 */
  const archiveDir = process.env.PII_ARCHIVE_DIR ?? join(dataDir, "archive");
  const clientMetrics: unknown[] = [];
  const flags = { restartPending: false };

  async function resolveConversation(id: number | undefined): Promise<Conversation | undefined> {
    if (id !== undefined && trash.has(id)) return undefined;
    return openConversation(agent, id);
  }

  async function isIdle(): Promise<boolean> {
    const inspection = await agent.harness.inspect(BACKGROUND_CONTEXT);
    return inspection.tasks.length === 0 && inspection.submissions.length === 0;
  }

  // 优雅退出原本是 main.ts 的局部函数，但 /api/restart 也要调它，
  // 所以收进 ctx；server 由 main.ts 在 listen 之后通过 attachServer 交进来。
  let server: { close: () => void } | null = null;
  function attachServer(s: { close: () => void }): void {
    server = s;
  }
  async function shutdown(reason: string): Promise<void> {
    console.log(`\n收到 ${reason}，关闭中…`);
    server?.close();
    approvals.dispose();
    awake.stop();
    await agent.harness.close(BACKGROUND_CONTEXT);
    releaseLock();
    process.exit(0);
  }

  return {
    serverDir: SERVER_DIR,
    archiveDir,
    clientMetrics,
    flags,
    viewWindow: VIEW_WINDOW,
    windowOptions: (input) => windowOptions(input, taskDuration),
    resolveConversation,
    isIdle,
    attachServer,
    shutdown,
    dataDir,
    releaseLock,
    policies,
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
