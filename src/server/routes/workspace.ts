/**
 * 工作目录（cwd）、目录浏览、导入外部对话。
 *
 * 「导入」放在这里而不是 session.ts：它写的是会话内容，但用户的心智是
 * 「把文件搬进来」，和选目录同一类操作；session.ts 只管会话本身的 JSON 增删改。
 *
 * 纯搬迁：路由行为保持原样，依赖通过 AppContext 显式传入。
 */
import type { Hono } from "hono";
import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { resolveCwd } from "../../agent.ts";
import { createConversation, parseConversationId } from "../conversations.ts";
import { TITLE_MAX } from "../titles.ts";
import type { AppContext } from "../context.ts";

export function registerWorkspace(app: Hono, ctx: AppContext): void {
  const { agent, customTitles, resolveConversation } = ctx;

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

/* ---------------- 变更审阅（git） ---------------- */

const runFile = promisify(execFile);

/**
 * 在会话的工作目录里跑一条 git。
 *
 * 用 execFile + 参数数组，不经过 shell：路径里的空格、引号、`$(...)`
 * 都只是普通字符，不会被展开 —— 这些路径最终来自模型改过的文件。
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await runFile("git", ["-C", cwd, ...args], {
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** 失败就当空串（仓库不存在、没有改动、不是 git 仓库……都不该是 500）。 */
async function gitOk(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (error) {
    /*
     * 有些命令「失败」是正常的：`git diff --no-index` 只要两边有差异就以 1 退出，
     * 而 stdout 里正是我们要的 diff。所以失败时也要把已经产出的内容交出来。
     */
    return (error as { stdout?: string }).stdout ?? "";
  }
}

/** 会话的 cwd + 它是不是一个 git 工作区。 */
async function repoFor(conversationId: number | undefined) {
  const conversation = await resolveConversation(conversationId);
  if (!conversation) return null;
  const resolved = await conversation.agent(BACKGROUND_CONTEXT);
  const cwd = resolved.cwd ?? resolveCwd();
  const inside = (await gitOk(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
  return { cwd, repo: inside === "true" };
}

/** 改动的文件清单：状态码 + 增删行数（未跟踪的文件没有行数）。 */
app.get("/api/git/status", async (c) => {
  const found = await repoFor(parseConversationId(c.req.query("c")));
  if (!found) return c.json({ error: "会话不存在" }, 404);
  const { cwd, repo } = found;
  if (!repo) return c.json({ repo: false, cwd, files: [] });

  const branch = (await gitOk(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const porcelain = await gitOk(cwd, ["status", "--porcelain"]);

  // 暂存区和未暂存区分开取，同一个文件两处都有改动时相加
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const args of [
    ["diff", "--numstat"],
    ["diff", "--numstat", "--cached"],
  ]) {
    for (const line of (await gitOk(cwd, args)).split("\n")) {
      if (!line.trim()) continue;
      const [added, deleted, ...rest] = line.split("\t");
      const path = rest.join("\t");
      if (!path) continue;
      const prev = counts.get(path) ?? { additions: 0, deletions: 0 };
      counts.set(path, {
        additions: prev.additions + (Number(added) || 0),
        deletions: prev.deletions + (Number(deleted) || 0),
      });
    }
  }

  const files = porcelain
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const index = line[0];
      const worktree = line[1];
      const raw = line.slice(3);
      const path = raw.includes(" -> ") ? raw.split(" -> ").pop()! : raw;
      const stat = counts.get(path);
      return {
        path,
        status: index === "?" ? "?" : worktree !== " " ? worktree : index,
        staged: index !== " " && index !== "?",
        additions: stat?.additions ?? null,
        deletions: stat?.deletions ?? null,
      };
    });

  return c.json({ repo: true, cwd, branch, files });
});

/** 单个文件的 unified diff。 */
app.get("/api/git/diff", async (c) => {
  const found = await repoFor(parseConversationId(c.req.query("c")));
  if (!found) return c.json({ error: "会话不存在" }, 404);
  const { cwd, repo } = found;
  if (!repo) return c.json({ error: "这里不是 git 仓库" }, 400);

  const path = (c.req.query("path") ?? "").trim();
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    return c.json({ error: "路径不合法" }, 400);
  }

  // 未跟踪的文件没有 HEAD 版本：跟 /dev/null 比（git 会以退出码 1 结束，属正常）
  const tracked = (await gitOk(cwd, ["ls-files", "--error-unmatch", "--", path])).length > 0;
  const diff = tracked
    ? await gitOk(cwd, ["diff", "HEAD", "--", path])
    : await gitOk(cwd, ["diff", "--no-index", "--", "/dev/null", path]);

  const LIMIT = 200_000;
  return c.json({ path, diff: diff.slice(0, LIMIT), truncated: diff.length > LIMIT });
});

/** 丢弃一个文件的改动（回到 HEAD）。新增未提交的文件不动 —— 删文件太危险。 */
app.post("/api/git/revert", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; conversationId?: number };
  const found = await repoFor(body.conversationId ?? parseConversationId(c.req.query("c")));
  if (!found) return c.json({ error: "会话不存在" }, 404);
  const { cwd, repo } = found;
  if (!repo) return c.json({ error: "这里不是 git 仓库" }, 400);

  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    return c.json({ error: "路径不合法" }, 400);
  }

  const status = await gitOk(cwd, ["status", "--porcelain", "--", path]);
  if (!status.trim()) return c.json({ error: "这个文件没有改动" }, 400);
  if (status.startsWith("??")) return c.json({ error: "未跟踪的新文件不支持一键丢弃" }, 400);
  if (status[0] === "A") return c.json({ error: "已暂存的新增文件不支持一键丢弃" }, 400);

  try {
    await git(cwd, ["checkout", "HEAD", "--", path]);
  } catch (error) {
    return c.json({ error: `丢弃失败：${(error as Error).message.slice(0, 200)}` }, 500);
  }
  return c.json({ ok: true });
});

/** 提交全部改动（git add -A + commit）。推送不在这里做：凭据不该由网页代持。 */
app.post("/api/git/commit", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { message?: unknown; conversationId?: number };
  const found = await repoFor(body.conversationId ?? parseConversationId(c.req.query("c")));
  if (!found) return c.json({ error: "会话不存在" }, 404);
  const { cwd, repo } = found;
  if (!repo) return c.json({ error: "这里不是 git 仓库" }, 400);

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return c.json({ error: "提交信息不能为空" }, 400);
  if (message.length > 200) return c.json({ error: "提交信息太长（上限 200 字）" }, 400);

  if (!(await gitOk(cwd, ["status", "--porcelain"])).trim()) {
    return c.json({ error: "没有可提交的改动" }, 400);
  }

  try {
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-m", message]);
  } catch (error) {
    return c.json({ error: `提交失败：${(error as Error).message.slice(0, 300)}` }, 500);
  }
  const commit = (await gitOk(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  return c.json({ ok: true, commit });
});

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
}
