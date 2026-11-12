/**
 * 工作目录（cwd）、目录浏览、导入外部对话。
 *
 * 「导入」放在这里而不是 session.ts：它写的是会话内容，但用户的心智是
 * 「把文件搬进来」，和选目录同一类操作；session.ts 只管会话本身的 JSON 增删改。
 *
 * 纯搬迁：路由行为保持原样，依赖通过 AppContext 显式传入。
 */
import type { Hono } from "hono";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
