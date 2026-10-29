/**
 * image-ref 的自检脚本（不联网、不碰数据库、不启动服务）
 *
 * 跑：npx tsx scripts/test-image-ref.ts
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { externalizeImages, imageRefExtension } from "../src/tools/image-ref.ts";

// 1x1 PNG
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG2 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (cond) {
		pass++;
		console.log(`  ✅ ${name}`);
	} else {
		fail++;
		console.log(`  ❌ ${name}`, extra ?? "");
	}
}

const img = (data: string) => ({ type: "image", data, mimeType: "image/png" });

// ─────────────────────────────────────────────────────────── 纯函数
console.log("\n[1] externalizeImages 纯逻辑");
{
	const msgs = [{ role: "user", content: "纯文字", timestamp: 1 }] as never;
	const r = await externalizeImages(msgs, async () => "/x.png");
	check("无图片时 replaced=0", r.replaced === 0);
	check("无图片时消息不变", r.messages[0] === msgs[0]);
}
{
	const msgs = [
		{
			role: "user",
			content: [{ type: "text", text: "看看这个" }, img(PNG)],
			timestamp: 1,
		},
	] as never;
	const r = await externalizeImages(msgs, async () => "/data/images/a.png");
	check("图片被替换", r.replaced === 1);
	const content = (r.messages[0] as never as { content: { type: string; text: string }[] }).content;
	check("原文本保留", content.some((c) => c.text === "看看这个"));
	check("生成了 [image: ] 标记", content.some((c) => c.text.startsWith("[image: /data/images/a.png]")));
	check("第一张带解释", content.some((c) => c.text.includes("图片已移出上下文")));
	check("content 里已无 image block", !content.some((c) => (c as never as { type: string }).type === "image"));
	check("原消息对象没被改", (msgs[0] as never as { content: unknown[] }).content.length === 2);
}
{
	const msgs = [
		{ role: "user", content: [img(PNG), img(PNG2)], timestamp: 1 },
		{ role: "user", content: [img(PNG)], timestamp: 2 },
	] as never;
	const r = await externalizeImages(msgs, async (b) => `/img/${b.data.slice(0, 4)}.png`);
	check("三张图都替换", r.replaced === 3);
	const all = r.messages.flatMap((m) => (m as never as { content: { text?: string }[] }).content);
	const hinted = all.filter((c) => (c.text ?? "").includes("图片已移出上下文"));
	check("只有第一张带解释", hinted.length === 1, hinted.length);
}
{
	const msgs = [
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "文件内容" }, img(PNG)],
			isError: false,
			timestamp: 1,
		},
	] as never;
	const r = await externalizeImages(msgs, async () => "/t.png");
	check("toolResult 里的图片也替换", r.replaced === 1);
	check("toolResult 的元信息保留", (r.messages[0] as never as { toolName: string }).toolName === "read");
}
{
	const msgs = [{ role: "user", content: [{ type: "text", text: "x" }], timestamp: 1 }] as never;
	const r = await externalizeImages(msgs, async () => "/x.png");
	check("没有 image block 时不改动", r.messages[0] === msgs[0]);
}

// ─────────────────────────────────────────────────────────── 扩展
console.log("\n[2] imageRefExtension 实际落盘");
const dir = await mkdtemp(join(tmpdir(), "pii-imgref-"));
try {
	const ext = imageRefExtension({ imageDir: dir });
	const handlers = ext.hooks?.[0]?.handlers as unknown as {
		beforeRequest: (req: { messages: unknown[] }) => Promise<{ messages: unknown[] } | undefined>;
	};
	check("注册了 beforeRequest", typeof handlers?.beforeRequest === "function");

	const msgs = [{ role: "user", content: [{ type: "text", text: "看图" }, img(PNG)], timestamp: 1 }];
	const r1 = await handlers.beforeRequest({ messages: msgs });
	check("第一次有返回值", !!r1);
	const text1 = JSON.stringify(r1?.messages);
	check("标记里有绝对路径", /\[image: \/[^\]"]+\.png\]/.test(text1), text1.slice(0, 200));

	const files1 = await readdir(dir);
	check("文件落盘", files1.length === 1, files1);
	const raw = await readFile(join(dir, files1[0]));
	check("落盘内容 = 原图字节", raw.equals(Buffer.from(PNG, "base64")));

	// 再跑一次：应命中缓存，不重复写
	const r2 = await handlers.beforeRequest({ messages: msgs });
	const files2 = await readdir(dir);
	check("第二次不重复写文件", files2.length === 1, files2.length);
	check("第二次结果一致", JSON.stringify(r1?.messages) === JSON.stringify(r2?.messages));

	// 关掉
	const off = imageRefExtension({ imageDir: dir, enabled: false });
	const offH = off.hooks?.[0]?.handlers as unknown as {
		beforeRequest: (r: { messages: unknown[] }) => Promise<unknown>;
	};
	check("enabled=false 时不动", (await offH.beforeRequest({ messages: msgs })) === undefined);

	// 落盘失败时放行原图
	const broken = imageRefExtension({ imageDir: "/dev/null/nope" });
	const brokenH = broken.hooks?.[0]?.handlers as unknown as {
		beforeRequest: (r: { messages: unknown[] }) => Promise<unknown>;
	};
	check("落盘失败时放行原图", (await brokenH.beforeRequest({ messages: msgs })) === undefined);

	// 没有图片的请求不该有开销
	check(
		"无图片时返回 undefined",
		(await handlers.beforeRequest({ messages: [{ role: "user", content: "hi", timestamp: 1 }] })) === undefined,
	);
} finally {
	await rm(dir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
