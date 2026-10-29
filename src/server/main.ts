/**
 * 阶段 1：HTTP + SSE 服务端。
 *
 *    GET  /                丑测试页
 *    GET  /api/state       权威快照
 *    GET  /api/stream      SSE 增量（每来一次提交就推一份完整视图）
 *    POST /api/prompt      发消息
 *    POST /api/abort       中断
 *
 * 纪律：客户端永远用快照覆盖本地状态。SSE 只是"叫号声"，丢了不影响正确性。
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { streamSSE } from "hono/streaming";

import { homedir, hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { openAgent, resolveCwd, resolveDataDir } from "../agent.ts";
import { ApprovalBroker, type ApprovalRequest } from "./approvals.ts";
import { archiveEntries, listArchives, readArchive } from "./archive.ts";
import { createAuth } from "./auth.ts";
import { keepAwake } from "./awake.ts";
import { createConversation, listConversations, openConversation, parseConversationId, titleOf } from "./conversations.ts";
import { LastConversation } from "./last-conversation.ts";
import { PAGE } from "./page.ts";
import { Policies, defaultPolicy, normalizePolicy, presetOf } from "./policies.ts";
import { projectView, type Snapshot } from "./project.ts";
import { PushHub } from "./push.ts";
import { TITLE_MAX, Titles } from "./titles.ts";
import { Trash, purgeConversations } from "./trash.ts";

const port = Number(process.env.PII_PORT ?? 8787);
const host = process.env.PII_HOST ?? "127.0.0.1";
/** web/dist 的位置；相对路径从一个固定基准算，不依赖 cwd。 */
const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

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

const startedAt = Date.now();

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
  `  鉴权      ${auth.enabled ? `开（令牌：cat ${join(dataDir, "auth-token")}）` : "关（PII_AUTH=1 可开）"}`,
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
interface RunFailure {
  taskId: number;
  message: string;
  reason?: string;
  at?: number;
}

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

const app = new Hono();

/*
 * gzip 压缩。为什么这条最值：快照是 JSON + 大量中文，
 * 压缩率能到 10 倍左右（2.4MB → 200～300KB），手机走公网时差别非常明显。
 * hono 的 compress 会自动跳过 text/event-stream，不会把 SSE 憋住。
 */
app.use(compress());

/**
 * 鉴权（PII_AUTH=1 或 PII_TOKEN=... 时生效；默认关）。
 *
 * 放行清单只包含「装上主屏幕 + 收推送」必需的东西：
 * manifest / service worker / 图标 / 带指纹的静态资源。
 * 这些不含任何数据，泄露了也没关系；真正的数据和操作都在 /api/* 后面。
 */
if (auth.enabled) {
  const PUBLIC = [
    "/login",
    "/manifest.webmanifest",
    "/sw.js",
    "/favicon.ico",
    "/favicon.svg",
    "/favicon-32.png",
    "/icon.svg",
    "/apple-touch-icon.png",
  ];
  const isPublic = (path: string) =>
    PUBLIC.includes(path) || path.startsWith("/icons/") || path.startsWith("/assets/");

  app.get("/login", (c) => {
    const token = c.req.query("token");
    if (auth.matches(token)) {
      // 带 token 的链接：种 cookie 后回首页
      c.header("Set-Cookie", auth.cookieFor(c));
      return c.redirect("/");
    }
    return c.html(auth.loginPage("/", false));
  });

  app.post("/login", async (c) => {
    const body = (await c.req.parseBody().catch(() => ({}))) as { token?: string; next?: string };
    const next = typeof body.next === "string" && body.next.startsWith("/") ? body.next : "/";
    if (auth.matches(typeof body.token === "string" ? body.token.trim() : undefined)) {
      c.header("Set-Cookie", auth.cookieFor(c));
      return c.redirect(next);
    }
    // 失败越多等越久（最多 3 秒）
    await new Promise((resolve) => setTimeout(resolve, Math.min(3000, 500 * 3)));
    return c.html(auth.loginPage(next, true), 401);
  });

  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (isPublic(path) || auth.allowed(c)) return next();

    // API / SSE 一律 401 JSON，前端能识别并提示登录
    if (path.startsWith("/api/")) {
      return c.json({ error: "未登录，先访问 /login 输入令牌" }, 401);
    }
    // 页面请求：直接给登录页（独立窗口里也能用，不需要地址栏）
    return c.html(auth.loginPage(path, false), 401);
  });
}

app.get("/", (c) => {
  // 构建过就托管 React；否则退回阶段 2 的测试页。
  // 必须 no-cache：index.html 里引用的是带指纹的 assets，
  // 一旦它被浏览器缓存，PWA 会一直加载上一版 JS（改了永远看不到效果）。
  c.header("Cache-Control", "no-cache, must-revalidate");
  const indexPath = join(WEB_DIST, "index.html");
  if (existsSync(indexPath)) return c.html(readFileSync(indexPath, "utf8"));
  return c.html(PAGE);
});

/*
 * 静态资源（web/dist/assets）。文件名带内容指纹，可以放心 immutable 长缓存。
 *
 * 之前这里没有 cache-control：每次冷启动浏览器都要重新验证那个 600KB 的 JS 包，
 * 走 Funnel（境外入口，RTT 几百毫秒）时，这就是「白屏三四秒」的主要来源。
 */
app.use("/assets/*", async (c, next) => {
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  return next();
});
app.use("/assets/*", serveStatic({ root: WEB_DIST, rewriteRequestPath: (path) => path }));
app.get("/index.html", serveStatic({ root: WEB_DIST }));

// PWA 文件：不让浏览器缓存，否则改了不生效
app.use("/icons/*", async (c, next) => {
  c.header("Cache-Control", "public, max-age=604800");
  return next();
});

for (const file of ["/sw.js", "/manifest.webmanifest"]) {
  app.get(file, (c, next) => {
    c.header("Cache-Control", "no-cache");
    if (file === "/sw.js") c.header("Service-Worker-Allowed", "/");
    return next();
  });
}


/**
 * 客户端自报尺寸。真机布局问题（安全区、视口高度）在 headless 里量不到，
 * 所以让页面自己把数字发过来：`GET /api/client-metrics` 就能看到。
 * 只保留最近 20 条，纯内存，不落库。
 */
const clientMetrics: unknown[] = [];

app.post("/api/client-metrics", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const entry = { ...body, at: new Date().toISOString() };
  clientMetrics.push(entry);
  if (clientMetrics.length > 20) clientMetrics.shift();
  console.log("  [client]", JSON.stringify(entry));
  return c.json({ ok: true });
});

app.get("/api/client-metrics", (c) => c.json({ metrics: clientMetrics }));

/**
 * 工作目录：agent 跑 bash / 读写文件时的根。
 *
 * 存在会话里（`pi.agent.cwd`），所以「会话 A 在项目 1、会话 B 在项目 2」
 * 是天然支持的 —— 这也是多会话真正有用的地方。
 */
app.get("/api/cwd", async (c) => {
  const conversation = await resolveConversation(parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);
  const resolved = await conversation.agent(BACKGROUND_CONTEXT);
  return c.json({
    cwd: resolved.cwd ?? resolveCwd(),
    home: homedir(),
    conversationId: Number(conversation.id),
  });
});

app.post("/api/cwd", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; conversationId?: number };
  const raw = typeof body.path === "string" ? body.path.trim() : "";
  if (!raw) return c.json({ error: "path 必填" }, 400);

  // 支持 ~ 开头；展开后必须是个真实存在的目录
  const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  const target = resolve(expanded);
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return c.json({ error: `目录不存在：${target}` }, 400);
  }
  if (!stat.isDirectory()) return c.json({ error: `不是目录：${target}` }, 400);

  const conversation = await resolveConversation(body.conversationId ?? parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  await conversation.configure({ cwd: target }, BACKGROUND_CONTEXT);
  return c.json({ ok: true, cwd: target });
});

/**
 * 目录浏览（给「选目录」的抽屉用）。
 *
 * 只列子目录、不列文件：这里的目的只是选一个工作目录，
 * 把几千个文件列出来既慢又没用。顺带报一下当前目录里有几个文件。
 */
app.get("/api/fs", (c) => {
  const raw = c.req.query("path");
  const expanded = raw ? raw.replace(/^~/, homedir()) : homedir();
  const target = resolve(expanded);

  let stat;
  try {
    stat = statSync(target);
  } catch {
    return c.json({ error: `目录不存在：${target}` }, 400);
  }
  if (!stat.isDirectory()) return c.json({ error: `不是目录：${target}` }, 400);

  const dirs: { name: string; path: string }[] = [];
  let fileCount = 0;
  try {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        dirs.push({ name: entry.name, path: join(target, entry.name) });
      } else if (entry.isFile()) {
        fileCount += 1;
      }
    }
  } catch {
    return c.json({ error: `没有权限读取：${target}` }, 400);
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(target);
  return c.json({
    path: target,
    parent: parent === target ? null : parent,
    dirs: dirs.slice(0, 300),
    fileCount,
  });
});

/**
 * 图片本体。
 *
 * 为什么要单独一个端点而不是把 base64 塞进快照：
 *   快照每次状态变化都整份推；一张图 base64 200KB 起步，滚一次就重传一次。
 *   拆出来之后：快照里只有一个 URL，图片本身由浏览器缓存
 *   （entry 不可变 → immutable，一年不再请求）。
 */
/**
 * 导入一段外部对话（只做展示，不进入模型上下文）。
 *
 * 用途：把别的工具里的对话（Claude Code、ChatGPT、导出的 markdown）搬进来，
 * 在手机上翻着看。技术上用的是 pi-durable 的 `type: "write"` 被动写入 ——
 * 没有 `model` 字段的 entry 不会被算进上下文，所以**不会消耗 token、不会影响对话**。
 *
 * 前端不用改：投影时把 `pii.import.user/assistant` 映射回 `pi.user/pi.assistant`，
 * 分轮、气泡、折叠全都复用现成的。
 */
app.post("/api/import", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    items?: { role?: string; text?: string; at?: number }[];
  };
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return c.json({ error: "items 不能为空" }, 400);

  const conversation = await createConversation(agent);
  let written = 0;

  for (const item of items) {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    const role = item.role === "assistant" ? "assistant" : "user";

    await conversation.submit(
      {
        type: "write",
        entry: {
          kind: `pii.import.${role}`,
          data: {
            blocks: [{ type: "text", text }],
            ...(typeof item.at === "number" ? { at: item.at } : {}),
          },
        } as never,
      },
      BACKGROUND_CONTEXT,
    );
    written += 1;
  }

  const id = Number(conversation.id);
  if (typeof body.title === "string" && body.title.trim()) {
    customTitles.set(id, body.title.trim().slice(0, TITLE_MAX));
  }

  return c.json({ ok: true, conversationId: id, written, title: body.title ?? null });
});

/** 归档目录：默认 <数据目录>/archive，可用 PII_ARCHIVE_DIR 指到项目里。 */
const archiveDir = process.env.PII_ARCHIVE_DIR ?? join(dataDir, "archive");

/** 某个会话的归档文件列表（新的在前）。 */
/**
 * 手动压缩上下文（把较早的部分换成摘要）。
 *
 * 平时是自动的：上下文到「模型窗口 - reserveTokens」时 pi-durable 自己压。
 * 这个端点用于主动腾地方（比如换到小窗口模型之前）。
 * 压缩前会把被替换的原文归档（见 tools/archive-hook.ts）。
 */
app.post("/api/compact", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { instructions?: string };
  const conversation = await resolveConversation(parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  const taskId = await conversation.compact(body.instructions, BACKGROUND_CONTEXT);
  return c.json({ ok: true, taskId: Number(taskId) });
});

app.get("/api/archive", (c) => {
  const conversationId = parseConversationId(c.req.query("c"));
  if (conversationId === undefined) return c.json({ error: "需要 ?c=<会话id>" }, 400);
  return c.json({
    dir: join(archiveDir, String(conversationId)),
    files: listArchives(archiveDir, conversationId).map((file) => ({
      name: file.name,
      bytes: file.bytes,
      at: file.at,
    })),
  });
});

/** 读一个归档文件（预览用）。只允许归档目录里的 .md，防路径穿越。 */
app.get("/api/archive/file", (c) => {
  const name = c.req.query("name");
  const conversationId = parseConversationId(c.req.query("c"));
  if (!name || conversationId === undefined) return c.json({ error: "参数不全" }, 400);
  if (!/^[\w.-]+\.md$/.test(name)) return c.json({ error: "文件名不合法" }, 400);
  try {
    return c.text(readArchive(join(archiveDir, String(conversationId), name)));
  } catch {
    return c.json({ error: "文件不存在" }, 404);
  }
});

/**
 * 手动归档：把当前会话的全部条目导出成一份 markdown。
 * 自动归档只在「压缩发生时」触发；这个端点用来随时留一份原文快照。
 */
app.post("/api/archive", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { conversationId?: number };
  const conversation = await resolveConversation(
    body.conversationId ?? parseConversationId(c.req.query("c")),
  );
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  const state = await conversation.viewState(BACKGROUND_CONTEXT);
  const value = state.value;
  state.dispose();
  if (!value) return c.json({ error: "视图尚未就绪" }, 503);

  const snapshot = projectView(value, { durationOf: taskDuration });
  const result = archiveEntries({
    archiveDir,
    conversationId: Number(conversation.id),
    entries: snapshot.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      ...(entry.at === undefined ? {} : { at: entry.at }),
      blocks: entry.blocks,
    })),
    reason: "manual",
    title: titles.get(Number(conversation.id)),
  });

  if (!result) return c.json({ error: "没有可归档的内容" }, 400);
  return c.json({ ok: true, path: result.path, entries: result.entries, bytes: result.bytes });
});

app.get("/api/image", async (c) => {
  const conversationId = parseConversationId(c.req.query("c"));
  const entryId = Number(c.req.query("e"));
  const index = Number(c.req.query("i") ?? 0);
  if (conversationId === undefined || !Number.isInteger(entryId) || !Number.isInteger(index)) {
    return c.json({ error: "参数不全" }, 400);
  }

  const found = await agent.storage.entry(
    conversationId as never,
    entryId as never,
    BACKGROUND_CONTEXT,
  );
  if (!found) return c.json({ error: "条目不存在" }, 404);

  const images: { data: string; mimeType: string }[] = [];
  for (const message of found.entry.model ?? []) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; data?: unknown; mimeType?: unknown };
      if (p?.type === "image" && typeof p.data === "string") {
        images.push({ data: p.data, mimeType: typeof p.mimeType === "string" ? p.mimeType : "image/png" });
      }
    }
  }

  const image = images[index];
  if (!image) return c.json({ error: "图片不存在" }, 404);

  return new Response(Buffer.from(image.data, "base64"), {
    headers: {
      "content-type": image.mimeType,
      // entry 内容不可变 → 可以放心让浏览器长期缓存
      "cache-control": "private, max-age=31536000, immutable",
      // 别手算 content-length：base64 有 padding，算错会让客户端一直等剩下的字节
      // （表现是“图片能出来，但要等 5 秒”——其实是等一个不会来的尾巴）。
    },
  });
});

/** 可选模型清单（来自 ~/.pi/agent/models.json）+ 当前会话用的那个。 */
app.get("/api/models", async (c) => {
  const conversation = await resolveConversation(parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  const resolved = await conversation.agent(BACKGROUND_CONTEXT);
  const models = agent.models.getModels().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    // 能不能看图，决定前端要不要禁用“上传图片”
    image: model.input?.includes("image") ?? false,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
  }));

  return c.json({
    models,
    current: resolved.model ?? null,
    // 这个会话最后一次跑用了多少上下文，前端可以拿来和 contextWindow 比
    conversationId: Number(conversation.id),
  });
});

/** 切换当前会话的模型。只影响这一个会话，不碰别的。 */
app.post("/api/model", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    provider?: string;
    modelId?: string;
    conversationId?: number;
  };
  if (typeof body.provider !== "string" || typeof body.modelId !== "string") {
    return c.json({ error: "provider 和 modelId 必填" }, 400);
  }
  if (!agent.models.getModel(body.provider, body.modelId)) {
    return c.json({ error: `找不到模型 ${body.provider}/${body.modelId}` }, 404);
  }

  const conversation = await resolveConversation(body.conversationId ?? parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  await conversation.configure(
    { model: { provider: body.provider, modelId: body.modelId } },
    BACKGROUND_CONTEXT,
  );
  return c.json({ ok: true, provider: body.provider, modelId: body.modelId });
});

/**
 * 打开会话的统一入口：被删掉的一律当不存在。
 * 直接改 openConversation 的调用点太散，这里做一层拦截更不容易漏。
 */
async function resolveConversation(id: number | undefined) {
  if (id !== undefined && trash.has(id)) return undefined;
  return openConversation(agent, id);
}

/** 删除会话：先藏起来（立刻生效），再尽量当场把行删干净。 */
app.delete("/api/conversations/:id", async (c) => {
  const id = parseConversationId(c.req.param("id"));
  if (id === undefined) return c.json({ error: "id 不合法" }, 400);
  if (id === Number(agent.root.id)) return c.json({ error: "root 会话不能删" }, 400);
  if (watching.get(id)) return c.json({ error: "先切到别的会话再删（这个还开着）" }, 409);

  // 有活没干完就别删，否则任务会往一个不存在的会话里写
  const inspection = await agent.harness.inspect(BACKGROUND_CONTEXT);
  if (inspection.submissions.some((item) => Number(item.conversationId) === id)) {
    return c.json({ error: "这个会话还有没跑完的任务，等它结束再删" }, 409);
  }

  trash.hide(id);
  const result = purgeConversations({
    dbPath: join(dataDir, "agent.sqlite"),
    ids: [id],
  });
  if (result.deleted.length > 0) trash.forget(result.deleted);
  titles.delete(id);
  customTitles.forget(id);
  policies.forget(id);
  lastConversation.forget(id);

  return c.json({ ok: true, deletedRows: result.deleted.length > 0 });
});

/**
 * 重启服务（改完服务端代码后用）。
 *
 * 为什么不当场 exit：
 *   你现在这条对话就跑在这个进程里。立刻退出 = 把正在生成的回答腰斩，
 *   重启后 pi-durable 会从 checkpoint 续跑，可能把「重启」这条命令再执行一遍 —— 变成重启环。
 *
 * 所以：先挂个标记，等**所有会话都空闲**了再退。回答写完了、没有排队提交了，才真正重启。
 * 退出码 0 也会被 launchd 的 KeepAlive 拉起来（我们配的就是无条件重启）。
 */
let restartPending = false;

async function isIdle(): Promise<boolean> {
  const inspection = await agent.harness.inspect(BACKGROUND_CONTEXT);
  return inspection.tasks.length === 0 && inspection.submissions.length === 0;
}

app.post("/api/restart", async (c) => {
  const force = new URL(c.req.url).searchParams.get("force") === "1";

  if (restartPending) return c.json({ ok: true, state: "already-pending" });

  if (force) {
    console.log("\n收到重启请求（force），立刻重启…");
    setTimeout(() => void shutdown("restart"), 200);
    return c.json({ ok: true, state: "restarting-now" });
  }

  restartPending = true;
  console.log("\n收到重启请求，等空闲后重启…");

  void (async () => {
    // 最多等 10 分钟，超时也重启（否则一个卡住的任务能把这个标记带一辈子）
    for (let i = 0; i < 600; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        if (await isIdle()) {
          console.log("已空闲，重启中…");
          await shutdown("restart");
          return;
        }
      } catch {
        /* 读失败就当还在忙 */
      }
    }
    console.log("等空闲超时，强制重启…");
    await shutdown("restart");
  })();

  return c.json({ ok: true, state: "waiting-for-idle" });
});

/** 运行中的这版代码是什么时候改的（用来判断“要不要重启才生效”）。 */
app.get("/api/build", (c) => {
  const stamp = newestMtime(join(dirname(fileURLToPath(import.meta.url))));

  // 前端资源指纹 + service worker 版本：排查「手机上是不是旧版」时一眼能看出来
  let assets: string[] = [];
  try {
    assets = readdirSync(join(WEB_DIST, "assets")).sort();
  } catch {
    /* 还没构建 */
  }
  let swVersion = "";
  try {
    swVersion = /VERSION = "([^"]+)"/.exec(readFileSync(join(WEB_DIST, "sw.js"), "utf8"))?.[1] ?? "";
  } catch {
    /* 同上 */
  }

  return c.json({
    runningSince: startedAt,
    newestSourceMtime: stamp,
    behind: stamp > startedAt,
    assets,
    swVersion,
  });
});

/**
 * 快照窗口：默认只发最近 20 条（够填满一屏，滑到顶自动取下一页）。
 *
 * 为什么：会话能长到 300+ 条 / 2MB，而快照是每次状态变化整份推的。
 * 窗口化后一帧几十 KB；更早的历史用 `?before=<id>` 往前翻。
 * 想一次全要：`?limit=0`。
 */
/** 一屏大概 5 轮对话（用户消息 + 最终回答 = 2 条 → 10 条）。 */
const SNAPSHOT_TURNS = Number(process.env.PII_SNAPSHOT_TURNS ?? 5);

function windowOptions(input: { turns?: string; limit?: string; before?: string }) {
  const turns = input.turns === undefined ? SNAPSHOT_TURNS : Number(input.turns);
  const limit = input.limit === undefined ? undefined : Number(input.limit);
  const before = input.before === undefined ? undefined : Number(input.before);
  return {
    durationOf: taskDuration,
    ...(Number.isFinite(turns) && turns > 0 ? { turns } : {}),
    ...(limit !== undefined && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    ...(before !== undefined && Number.isFinite(before) ? { before } : {}),
  };
}

/** 权威快照。`?c=<id>` 选会话，不传就是 root；`?before=&limit=` 往前翻页。 */
app.get("/api/state", async (c) => {
  const conversation = await resolveConversation(parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);
  const state = await conversation.viewState(BACKGROUND_CONTEXT);
  const value = state.value;
  state.dispose();
  if (!value) return c.json({ error: "视图尚未就绪" }, 503);
  const snapshot = projectView(
    value,
    windowOptions({
      turns: c.req.query("turns"),
      limit: c.req.query("limit"),
      before: c.req.query("before"),
    }),
  );
  // 只有在「没在跑」的时候才报失败，否则生成中也会看到上一条旧错误
  const live = (snapshot.live as { phase?: string } | null) ?? null;
  if (!live?.phase) {
    const failure = latestFailure(snapshot.conversationId);
    if (failure) snapshot.runError = failure;
  }
  return c.json(snapshot);
});

/** 会话列表：最新在前，标题优先用自定义，否则来自第一条用户消息。 */
app.get("/api/conversations", async (c) => {
  const conversations = await listConversations(
    agent,
    50,
    (id) => trash.has(id),
    (id) => customTitles.get(id),
  );
  // 顺手把标题记下来：审批推送需要标题，但它不能为了标题再扫一次 entries
  for (const item of conversations) titles.set(item.id, item.title);
  return c.json({ conversations });
});

/** 新建一个会话，返回它的 id 和标题。 */
app.post("/api/conversations", async (c) => {
  const conversation = await createConversation(agent);
  titles.set(Number(conversation.id), "新对话");
  return c.json({ id: Number(conversation.id), title: "新对话" });
});

/**
 * 当前会话的工具审批策略。
 * 返回该会话的有效策略（存过就用存的，否则用默认）及其对应的预设档位。
 */
app.get("/api/policy", async (c) => {
  const conversation = await resolveConversation(parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);
  const id = Number(conversation.id);
  const policy = policies.effective(id);
  return c.json({ conversationId: id, policy, preset: presetOf(policy) });
});

/**
 * 改当前会话的工具审批策略。
 * body.policy = { auto: { read, write, edit, bash }, allowUnknown }。
 * 只影响这一个会话，不碰别的。
 */
app.post("/api/policy", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { policy?: unknown; conversationId?: number };
  const conversation = await resolveConversation(body.conversationId ?? parseConversationId(c.req.query("c")));
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  const policy = normalizePolicy(body.policy);
  if (!policy) return c.json({ error: "policy 格式不对" }, 400);

  const id = Number(conversation.id);
  policies.set(id, policy);
  return c.json({ ok: true, conversationId: id, policy, preset: presetOf(policy) });
});

/** 上次在看的会话（前端 localStorage 的兜底）。 */
app.get("/api/last-conversation", (c) => c.json({ conversationId: lastConversation.get() }));

/** 记下当前在看的会话。先校验存在（被删的一律当不存在）。 */
app.post("/api/last-conversation", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { conversationId?: unknown };
  const id = typeof body.conversationId === "number" ? body.conversationId : undefined;
  if (id === undefined) return c.json({ error: "conversationId 必填" }, 400);
  const conversation = await resolveConversation(id);
  if (!conversation) return c.json({ error: "会话不存在" }, 404);
  const realId = Number(conversation.id);
  lastConversation.set(realId);
  return c.json({ ok: true, conversationId: realId });
});

/**
 * 重命名会话。
 * body.title 为字符串；传空串（或全空白）表示「恢复自动标题」（清掉自定义值）。
 * root 会话也允许改名 —— 它本来就有标题，改个名无副作用。
 */
app.patch("/api/conversations/:id", async (c) => {
  const id = parseConversationId(c.req.param("id"));
  if (id === undefined) return c.json({ error: "id 不合法" }, 400);

  const conversation = await resolveConversation(id);
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
  if (typeof body.title !== "string") return c.json({ error: "title 必填" }, 400);

  const title = body.title.replace(/\s+/g, " ").trim();
  if (title.length > TITLE_MAX) return c.json({ error: `标题太长（最多 ${TITLE_MAX} 字）` }, 400);

  // 空 → 恢复自动；非空 → 存自定义。set 内部会自己规范化并落盘。
  customTitles.set(id, title);
  // 重新算一次有效标题（清空时要回退到从内容推），顺手更新推送缓存
  const effective = title || (await titleOf(conversation));
  titles.set(id, effective);

  return c.json({ ok: true, id, title: effective, custom: Boolean(title) });
});

/** 推送公钥：浏览器订阅时要把它当 `applicationServerKey`。 */
app.get("/api/push/key", (c) => c.json({ publicKey: push.publicKey, enabled: push.enabled }));

/** 订阅（同一个 endpoint 重复订阅只更新，浏览器每次加载都可能重新订阅）。 */
app.post("/api/push/subscribe", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    endpoint?: unknown;
    keys?: unknown;
    conversationId?: number;
  };
  const conversationId = body.conversationId ?? parseConversationId(c.req.query("c"));
  if (!push.subscribe(body, conversationId)) return c.json({ error: "订阅格式不对" }, 400);
  return c.json({ ok: true, subscriptions: push.list().length });
});

app.post("/api/push/unsubscribe", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
  if (typeof body.endpoint !== "string") return c.json({ error: "endpoint 必填" }, 400);
  return c.json({ ok: push.unsubscribe(body.endpoint), subscriptions: push.list().length });
});

/** 自测用：立刻推一条，不用等模型跑完。 */
app.post("/api/push/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { conversationId?: number };
  const conversationId = body.conversationId ?? parseConversationId(c.req.query("c"));
  const result = await push.notify({
    title: titles.get(conversationId ?? -1) ?? "pii · 测试通知",
    body: "这是一条测试推送。",
    conversationId,
    tag: "test",
  });
  return c.json(result);
});

/** SSE：完整视图 + 审批事件。同样用 `?c=<id>` 选会话。 */
app.get("/api/stream", async (c) => {
  const conversationId = parseConversationId(c.req.query("c"));
  const conversation = await resolveConversation(conversationId);
  if (!conversation) return c.json({ error: "会话不存在" }, 404);
  const scope = Number(conversation.id);

  return streamSSE(c, async (stream) => {
    const state = await conversation.viewState(BACKGROUND_CONTEXT);
    let closed = false;
    watch(scope, 1);

    const emit = (event: string, data: unknown) => {
      if (closed) return;
      void Promise.resolve()
        .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
        .catch(() => {
          closed = true;
        });
    };

    /*
     * 快照推送要节流。
     *
     * pi-durable 的纪律是「快照是账单」——每次状态变化都推一份完整视图，
     * 生成过程中 progress commit 很密（每个新字都可能提交一次），
     * 于是 2MB 的快照一秒能推好几次，手机上就是一直转圈。
     *
     * 做法：最多每 100ms 推一帧，中间的合并成最后一帧（trailing edge）。
     * 丢中间的帧不会丢信息 —— 因为下一帧是完整快照，不是增量。
     */
    let pending: Snapshot | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      timer = undefined;
      if (!pending) return;
      const next = pending;
      pending = null;
      emit("state", next);
    };

    const pushSnapshot = (snapshot: Snapshot) => {
      const waiting = timer !== undefined;
      pending = snapshot;
      if (waiting) return; // 已经在队列里了，等它到点一起发
      timer = setTimeout(flush, 100);
      timer.unref?.();
    };

    const initial = state.value;
    {
      const options = windowOptions({ turns: c.req.query("turns") });
      if (initial) pushSnapshot(projectView(initial, options));
    }

    // 重连时把仍挂起的审批补发一次，否则新开的标签页看不到它们；
    // 只补发本会话的 —— 别的会话的审批不该弹在你脸上。
    for (const request of approvals.list(scope)) emit("approval", request);

    const streamOptions = windowOptions({ turns: c.req.query("turns") });
    const unsubscribe = state.subscribe((value) => pushSnapshot(projectView(value, streamOptions)));
    const offRequest = approvals.onRequest((request: ApprovalRequest) => {
      if (request.conversationId === scope) emit("approval", request);
    });
    const offOutcome = approvals.onOutcome((outcome) => emit("approval-resolved", outcome));

    // 心跳，防代理超时断开
    const heartbeat = setInterval(() => emit("ping", Date.now()), 15_000);
    heartbeat.unref?.();

    // 关键：handler 不能提前 return，否则 Hono 会关掉这条流。
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        closed = true;
        watch(scope, -1);
        if (timer) clearTimeout(timer);
        clearInterval(heartbeat);
        unsubscribe();
        offRequest();
        offOutcome();
        state.dispose();
        resolve();
      });
    });
  });
});

/** 当前挂起的审批。`?c=<id>` 只看那个会话的。 */
app.get("/api/approvals", (c) =>
  c.json({ approvals: approvals.list(parseConversationId(c.req.query("c"))) }),
);

/** 回答一个审批。 */
app.post("/api/approve", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: string; allow?: boolean };
  if (typeof body.id !== "string") return c.json({ error: "id 必填" }, 400);
  const ok = approvals.settle(body.id, body.allow === true);
  if (!ok) return c.json({ error: "该审批已失效（超时、已答过或服务重启）" }, 409);
  return c.json({ ok: true });
});

/** 发消息。requestId 让重试变成幂等（崩溃后重发不会问两遍）。 */
app.post("/api/prompt", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    text?: string;
    requestId?: string;
    conversationId?: number;
    images?: { mimeType?: unknown; data?: unknown }[];
    /** 忙时如何入队：followUp=排队等下一轮（默认）；steer=插队/引导当前回合 */
    mode?: "steer" | "followUp";
  };
  const text = typeof body.text === "string" ? body.text.trim() : "";

  // 图片走 base64（<img> 里能直接显示，模型也能直接吃）。
  // 上限压得比较紧：单张 6MB、最多 4 张 —— base64 会膨胀 4/3，再大就把请求撑爆了。
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter(
      (image): image is { mimeType: string; data: string } =>
        typeof image?.mimeType === "string" &&
        image.mimeType.startsWith("image/") &&
        typeof image?.data === "string" &&
        image.data.length > 0 &&
        image.data.length < 6_000_000,
    )
    .slice(0, 4);

  if (!text && images.length === 0) return c.json({ error: "text 和 images 至少给一个" }, 400);

  const id = body.conversationId ?? parseConversationId(c.req.query("c"));
  const conversation = await resolveConversation(id);
  if (!conversation) return c.json({ error: "会话不存在" }, 404);

  const requestId = body.requestId ?? randomUUID();
  const whenBusy = body.mode === "steer" || body.mode === "followUp" ? body.mode : undefined;
  // 只有图片没文字时也要有一段 text，否则有些模型会拒（空 content）
  const content =
    images.length === 0
      ? text
      : [
          { type: "text" as const, text: text || "(图片)" },
          ...images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ];

  const submission = await conversation.submit(
    { type: "input", content, requestId, ...(whenBusy ? { whenBusy } : {}) } as never,
    BACKGROUND_CONTEXT,
  );

  return c.json({ requestId, submissionId: submission.id, conversationId: Number(conversation.id), mode: whenBusy });
});

/** 中断当前会话的运行。 */
app.post("/api/abort", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { conversationId?: number };
  const id = body.conversationId ?? parseConversationId(c.req.query("c"));
  const conversation = await resolveConversation(id);
  if (!conversation) return c.json({ error: "会话不存在" }, 404);
  await conversation.abort(BACKGROUND_CONTEXT);
  return c.json({ ok: true, conversationId: Number(conversation.id) });
});

// 其他静态文件（图标、favicon…）兜底。必须放在所有 /api 路由之后，
// 否则 /api/* 会被它先吃掉。
app.use("*", serveStatic({ root: WEB_DIST }));

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`\n  打开 http://${host}:${info.port}\n`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n收到 ${signal}，关闭中…`);
  server.close();
  approvals.dispose();
  awake.stop();
  await agent.harness.close(BACKGROUND_CONTEXT);
  releaseLock();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
