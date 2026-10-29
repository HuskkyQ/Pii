/**
 * 阶段 0：证明 pi-durable 能在这台机器上、用当前这套 magpie 模型跑通。
 *
 * 只做一件事：问一个问题，把流式输出打到终端。
 * 跑通了，才值得往上搭 HTTP / SSE / 前端。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";

import { loadModels } from "./provider.ts";

const PROVIDER = process.env.PII_PROVIDER ?? "magpie";
const MODEL = process.env.PII_MODEL ?? "workbuddy/deepseek-v4.1-flash";
const PROMPT = process.argv.slice(2).join(" ") || "用一句话介绍你自己。";

const models = await loadModels();
const model = models.getModel(PROVIDER, MODEL);
if (!model) {
  console.error(`找不到模型 ${PROVIDER}/${MODEL}`);
  console.error("可用：", models.getModels(PROVIDER).slice(0, 10).map((m) => m.id));
  process.exit(1);
}
console.log(`模型：${PROVIDER}/${MODEL}  (context ${model.contextWindow})`);

// 阶段 0 先用内存存储；阶段 1 换成 SQLite
const harness = await Harness.open(
  new MemoryStorage(),
  { models, registry: createRegistry() },
  BACKGROUND_CONTEXT,
);

const root = await harness.root(BACKGROUND_CONTEXT, {
  agent: { model: { provider: PROVIDER, modelId: MODEL }, cwd: process.cwd() },
});

console.log(`\n> ${PROMPT}\n`);

const submission = await root.submit({ type: "input", content: PROMPT }, BACKGROUND_CONTEXT);
const settled = await submission.wait(BACKGROUND_CONTEXT);

if (settled.status !== "done" || settled.answer === undefined) {
  console.error("未完成：", JSON.stringify(settled, null, 2));
  await harness.close(BACKGROUND_CONTEXT);
  process.exit(1);
}

// 把模型这一轮的回复提交进 transcript（和官方 Quick Start 一致）
const answerId = settled.answer;
const entry = await root.commit((tx) => tx.entry(AssistantEntry, answerId), BACKGROUND_CONTEXT);

const message = entry?.model?.[0];
const text =
  typeof message === "object" && message !== null && "content" in message && Array.isArray(message.content)
    ? message.content
        .filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
        .map((block) => block.text)
        .join("")
    : "";
console.log(text || "(没有文本)");

const usage = await harness.usage(BACKGROUND_CONTEXT);
console.log("\n用量：", JSON.stringify(usage));

await harness.close(BACKGROUND_CONTEXT);
