/**
 * 压缩、归档、图片本体。
 *
 * 归档的**实现**不在 server/ 里：`src/archive.ts`（agent 层，纯 fs）。
 * 这里只负责 HTTP：参数校验、把快照投影成 markdown、防路径穿越。
 */
import type { Hono } from "hono";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { archiveEntries, listArchives, readArchive } from "../../archive.ts";
import { parseConversationId } from "../conversations.ts";
import { projectView } from "../project.ts";
import type { AppContext } from "../context.ts";

export function registerArchive(app: Hono, ctx: AppContext): void {
  const { agent, titles, taskDuration, archiveDir, resolveConversation, viewWindow: VIEW_WINDOW } = ctx;

/* 归档目录由 config.ts 解析（`PII_ARCHIVE_DIR` → `<数据目录>/archive`），这里直接用。 */

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

/** 某个会话的归档文件列表（新的在前）。 */
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

/**
 * 图片本体。
 *
 * 为什么要单独一个端点而不是把 base64 塞进快照：
 *   快照每次状态变化都整份推；一张图 base64 200KB 起步，滚一次就重传一次。
 *   拆出来之后：快照里只有一个 URL，图片本身由浏览器缓存
 *   （entry 不可变 → immutable，一年不再请求）。
 */
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
