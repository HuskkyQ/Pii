/**
 * 工作目录、文件浏览、导入、压缩与归档、图片外置。
 *
 * 纯搬迁：路由行为保持原样，依赖通过 AppContext 显式传入。
 */
import type { Hono } from "hono";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { resolveCwd } from "../../agent.ts";
import { archiveEntries, listArchives, readArchive } from "../../archive.ts";
import { createConversation, parseConversationId } from "../conversations.ts";
import { projectView } from "../project.ts";
import { TITLE_MAX } from "../titles.ts";
import type { AppContext } from "../context.ts";

export function registerFiles(app: Hono, ctx: AppContext): void {
  const { watch, titles, customTitles, push, agent, taskDuration, archiveDir, resolveConversation, viewWindow: VIEW_WINDOW } = ctx;

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

/* 归档目录由 agent 层解析（openAgent → Agent.archiveDir），这里直接用，不重复读环境变量。 */

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

  const watch_ = await conversation.watch(BACKGROUND_CONTEXT, VIEW_WINDOW);
  const value = watch_.value;
  await watch_.stop();

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
}
