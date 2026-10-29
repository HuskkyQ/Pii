/**
 * 把图片从上下文里「外置」出去，只留文件路径。
 *
 * 为什么需要：
 *   用户发一张截图 → base64 存进 entry → 每轮请求都原样重发一遍。
 *   40 张截图 ≈ 20MB 请求体 + 每轮重复计费，长会话必然爆窗口。
 *
 * 做法（学 Codex 的 `ImageReference::File`）：
 *   entry 里的图片（SQLite 里那份，永不改动）
 *     └─ 第一次请求前落盘成 <数据目录>/images/<sha256>.png
 *     └─ 请求里替换成文本标记 [image: /data/images/xxx.png]
 *   模型真要看内容时，用现成的 read 工具打开那个路径 —— read 本来就支持读图。
 *
 * 关键约束：这里改的只是「这一次请求的 messages」，entry 本身不动，
 * 所以网页端照样能显示原图，历史也不会丢。
 */
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GenerationTask, defineExtension, hook } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";

export interface ImageRefOptions {
	/** 图片落盘目录，通常是 `<数据目录>/images` */
	imageDir: string;
	/** 关掉就把原图放回去（调试用） */
	enabled?: boolean;
	/** 落盘失败时是否放行原图。默认 true：宁可多花 token，也不要让用户看不见图 */
	passThroughOnError?: boolean;
	/** 通知（日志/界面），可选 */
	onExternalized?: (info: { files: number; bytes: number }) => void;
}

type ImageBlock = { type: "image"; data: string; mimeType: string };

/** 第一次出现时带上解释，之后只留路径（省 token，又不至于让模型看不懂） */
const FIRST_HINT =
	"（图片已移出上下文以省 token。需要看内容时用 read 打开上面的路径；" +
	"只凭文字能回答就不要读。）";

function isImageBlock(part: unknown): part is ImageBlock {
	if (!part || typeof part !== "object") return false;
	const p = part as Record<string, unknown>;
	return p.type === "image" && typeof p.data === "string" && p.data.length > 0;
}

function extensionFor(mimeType: string): string {
	const m = /^image\/([a-z0-9.+-]+)$/i.exec(mimeType ?? "");
	if (!m) return "png";
	const sub = m[1].toLowerCase();
	if (sub === "jpeg" || sub === "jpg") return "jpg";
	if (sub === "svg+xml") return "svg";
	return sub.replace(/[^a-z0-9]/g, "") || "png";
}

/**
 * 纯函数：把 messages 里的图片换成路径标记。
 *
 * `persist` 决定图片写到哪 —— 抽出来是为了能单测（不碰磁盘、不碰数据库）。
 */
export async function externalizeImages(
	messages: readonly Message[],
	persist: (block: ImageBlock) => Promise<string>,
): Promise<{ messages: Message[]; replaced: number; bytes: number }> {
	let replaced = 0;
	let bytes = 0;
	let hinted = false;
	const out: Message[] = [];

	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content) || !content.some(isImageBlock)) {
			out.push(message);
			continue;
		}

		const next: unknown[] = [];
		for (const part of content) {
			if (!isImageBlock(part)) {
				next.push(part);
				continue;
			}
			const file = await persist(part);
			replaced++;
			bytes += part.data.length;
			const mark = `[image: ${file}]`;
			next.push({ type: "text", text: hinted ? mark : `${mark}\n${FIRST_HINT}` });
			hinted = true;
		}
		out.push({ ...message, content: next } as Message);
	}

	return { messages: out, replaced, bytes };
}

export function imageRefExtension(options: ImageRefOptions) {
	const imageDir = options.imageDir;
	const passThrough = options.passThroughOnError ?? true;

	/** 便宜的去重键（不拿整串 base64 当 key，避免内存翻倍） */
	const pathByKey = new Map<string, string>();
	/** 已经确认存在于磁盘的路径 */
	const onDisk = new Set<string>();

	async function persist(block: ImageBlock): Promise<string> {
		const key = `${block.mimeType}:${block.data.length}:${block.data.slice(0, 64)}:${block.data.slice(-64)}`;
		const cached = pathByKey.get(key);
		if (cached && onDisk.has(cached)) return cached;

		const bytes = Buffer.from(block.data, "base64");
		const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
		const file = join(imageDir, `${hash}.${extensionFor(block.mimeType)}`);

		if (!onDisk.has(file)) {
			await mkdir(imageDir, { recursive: true });
			try {
				await access(file);
			} catch {
				await writeFile(file, bytes);
			}
			onDisk.add(file);
		}

		pathByKey.set(key, file);
		return file;
	}

	return defineExtension({
		name: "pii-image-ref",
		hooks: [
			hook(GenerationTask, {
				async beforeRequest(request) {
					if (options.enabled === false) return undefined;

					let result;
					try {
						result = await externalizeImages(request.messages, persist);
					} catch (error) {
						if (passThrough) {
							console.warn(`  图片外置失败，本轮放行原图：${(error as Error).message}`);
							return undefined;
						}
						throw error;
					}

					if (result.replaced === 0) return undefined;
					options.onExternalized?.({ files: result.replaced, bytes: result.bytes });
					return { messages: result.messages };
				},
			}),
		],
	});
}
