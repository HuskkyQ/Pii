/**
 * 归档 + 压缩钩子。
 *
 * 两件事要分清，它们解决的不是同一个问题：
 *
 *   归档（本文件的 archiveEntries）
 *     把对话**原文**写成 markdown 落盘，**只增不改**。
 *     目的是「历史不丢」：数据库里的上下文会被压缩掉，但文件里永远能翻到原话。
 *
 *   压缩（pi-durable 自带的 compaction）
 *     上下文快撑满模型窗口时，把较早的部分换成一段摘要，让对话能继续。
 *     目的是「上下文不爆」：不然一长就只能新开会话。
 *
 * 两者串起来的方式：`beforeCompact` 钩子在**摘要生成之前**拿到「即将被替换掉的那些条目」，
 * 先归档成文件，再让 pi-durable 照常压缩。这样被压掉的内容不会凭空消失。
 *
 * 归档目录默认 `<数据目录>/archive/<会话id>/`，可用 PII_ARCHIVE_DIR 指到项目里的某个文件夹。
 * 文件名带序号和时间戳，同一份内容不会被覆盖第二次。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 归档用到的条目形状（只依赖我们真正读的字段）。 */
export interface ArchiveEntry {
  id: number;
  kind: string;
  at?: number;
  blocks: {
    type: string;
    text?: string;
    name?: string;
    input?: unknown;
    url?: string;
    mimeType?: string;
  }[];
}

function stamp(at?: number): string {
  const date = at !== undefined ? new Date(at) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fileStamp(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 一条 entry → markdown。思考用折叠块，工具调用用代码块，正文原样。 */
function renderEntry(entry: ArchiveEntry): string {
  const lines: string[] = [];
  const who =
    entry.kind === "pi.user" ? "用户" : entry.kind === "pi.assistant" ? "助手" : entry.kind;
  lines.push(`### ${who} · ${stamp(entry.at)} · #${entry.id}`);
  lines.push("");

  for (const block of entry.blocks) {
    if (block.type === "thinking" && block.text) {
      lines.push("<details><summary>思考</summary>");
      lines.push("");
      lines.push(block.text);
      lines.push("");
      lines.push("</details>");
      lines.push("");
    } else if (block.type === "text" && block.text) {
      lines.push(block.text);
      lines.push("");
    } else if (block.type === "toolCall") {
      lines.push(`**工具调用** \`${block.name ?? "?"}\``);
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(block.input ?? null, null, 2));
      lines.push("```");
      lines.push("");
    } else if (block.type === "toolResult" && block.text) {
      lines.push("**工具结果**");
      lines.push("");
      lines.push("```");
      lines.push(block.text.slice(0, 4000));
      lines.push("```");
      lines.push("");
    } else if (block.type === "image") {
      lines.push(`（图片：${block.url ?? block.mimeType ?? "image"}）`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export interface ArchiveResult {
  path: string;
  entries: number;
  bytes: number;
}

export interface ArchiveOptions {
  archiveDir: string;
  conversationId: number;
  entries: readonly ArchiveEntry[];
  /** 这批条目是因为什么被归档的：compaction（被压缩替换）/ manual（手动导出）/ auto（超阈值） */
  reason: "compaction" | "manual" | "auto";
  title?: string;
}

/**
 * 写一个归档文件。**只增不改**：目录里已有同名就换下一个序号。
 * 返回文件路径，方便在界面/日志里显示。
 */
export function archiveEntries(options: ArchiveOptions): ArchiveResult | null {
  const { archiveDir, conversationId, entries } = options;
  if (entries.length === 0) return null;

  const dir = join(archiveDir, String(conversationId));
  mkdirSync(dir, { recursive: true });

  // 序号 = 目录里已有的最大序号 + 1
  let seq = 1;
  try {
    for (const name of readdirSync(dir)) {
      const match = /^(\d+)-/.exec(name);
      if (match) seq = Math.max(seq, Number(match[1]) + 1);
    }
  } catch {
    /* 目录刚建，从 1 开始 */
  }

  const header = [
    `# 会话 ${conversationId}${options.title ? ` · ${options.title}` : ""}`,
    "",
    `- 归档时间：${stamp()}`,
    `- 原因：${options.reason}`,
    `- 条目范围：#${entries[0]!.id} → #${entries[entries.length - 1]!.id}（共 ${entries.length} 条）`,
    "",
    "> 这是**原文快照**，只增不改。数据库里的上下文可能已被压缩，但这里永远是当时的样子。",
    "",
    "---",
    "",
  ].join("\n");

  const body = entries.map(renderEntry).join("\n");
  const content = `${header}${body}`;

  const path = join(dir, `${String(seq).padStart(4, "0")}-${fileStamp()}-${options.reason}.md`);
  writeFileSync(path, content, "utf8");
  return { path, entries: entries.length, bytes: Buffer.byteLength(content) };
}

export interface ArchiveFileInfo {
  name: string;
  path: string;
  bytes: number;
  at: number;
}

/** 列出某个会话的归档文件（新的在前）。 */
export function listArchives(archiveDir: string, conversationId: number): ArchiveFileInfo[] {
  const dir = join(archiveDir, String(conversationId));
  if (!existsSync(dir)) return [];
  const files: ArchiveFileInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    files.push({ name, path, bytes: stat.size, at: stat.mtimeMs });
  }
  return files.sort((a, b) => b.at - a.at);
}

export function readArchive(path: string): string {
  return readFileSync(path, "utf8");
}
