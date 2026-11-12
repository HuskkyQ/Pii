/**
 * 过程轨道的纯逻辑：把 entry / 实时视图拍平成「一步一行」的步骤。
 *
 * 单独放在 lib 里而不是组件文件里，是为了能直接用 `node:test` 跑
 * （见 `web/tests/process-steps.test.ts`）—— 折叠小结错一个数字，
 * 界面上是「已完成 0 步」这种没人看得懂的鬼话。
 */
import type { Block, Entry, LiveView } from "./types.ts";

/** 过程轨道里的一步：思考 / 过程性正文 / 一次工具调用。 */
export type RailStep =
  | {
      kind: "thinking";
      key: string;
      text: string;
      /** 这一段思考花了多久 */
      durationMs?: number;
      /** 正在流式生成（实时轨道用） */
      streaming?: boolean;
    }
  | {
      kind: "text";
      key: string;
      /** 动手前说的「我先看一下…」这类过程性正文 */
      text: string;
      streaming?: boolean;
    }
  | {
      kind: "tool";
      key: string;
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      durationMs?: number;
      status: "pending" | "running" | "done";
    };

/**
 * 历史条目 → 步骤列表。
 *
 * 一个 entry 里可能同时有思考、正文、多个工具调用，所以这里把 blocks 拍平成
 * 「一步一行」，而不是按 entry 分块 —— 时间线要的是执行顺序，不是存储结构。
 */
export function stepsFromEntries(
  entries: Entry[],
  thinkingOverride?: { entryId: number; ms: number },
): RailStep[] {
  const steps: RailStep[] = [];

  for (const entry of entries) {
    entry.blocks.forEach((block, index) => {
      const key = `${entry.id}:${index}`;
      switch (block.type) {
        case "thinking":
          if (block.text.trim()) {
            const durationMs =
              thinkingOverride?.entryId === entry.id ? thinkingOverride.ms : entry.thinkingMs;
            steps.push({ kind: "thinking", key, text: block.text, durationMs });
          }
          break;
        case "text":
          if (block.text.trim()) steps.push({ kind: "text", key, text: block.text });
          break;
        case "toolCall":
          steps.push({
            kind: "tool",
            key,
            name: block.name,
            input: block.input,
            result: block.result,
            isError: block.isError,
            durationMs: block.durationMs,
            status: "done",
          });
          break;
        case "toolResult":
          // 未配对的结果（极少见）：仍然按「一步工具」显示，不引入第三种样式
          steps.push({
            kind: "tool",
            key,
            name: block.name ?? "tool",
            input: null,
            result: block.text,
            isError: block.isError,
            durationMs: block.durationMs,
            status: "done",
          });
          break;
        default:
          break;
      }
    });
  }

  return steps;
}

/**
 * 实时视图 → 步骤列表。
 *
 * 只取「还没落库」的部分：已经提交的工具调用会出现在 entries 里（Transcript
 * 把 turn.process 也拼进来），所以这里跳过 `done` 的工具，避免同一行出现两次。
 */
export function stepsFromLive(live: LiveView): RailStep[] {
  const steps: RailStep[] = [];
  const blocks: Block[] = live.message?.blocks ?? [];
  const hasToolCall = blocks.some((block) => block.type === "toolCall");

  blocks.forEach((block, index) => {
    const key = `live:${index}`;
    if (block.type === "thinking" && block.text.trim()) {
      steps.push({ kind: "thinking", key, text: block.text, streaming: true });
    }
    // 有正文又伴随工具调用 = 过程性正文；纯正文是正在流式输出的答案，交给 LiveRow
    if (block.type === "text" && block.text.trim() && hasToolCall) {
      steps.push({ kind: "text", key, text: block.text, streaming: true });
    }
  });

  (live.tools ?? []).forEach((tool, index) => {
    if (tool.status === "done") return;
    steps.push({
      kind: "tool",
      key: `live-tool:${index}`,
      name: tool.name,
      input: null,
      status: tool.status,
    });
  });

  return steps;
}

export interface RailSummary {
  steps: number;
  tools: number;
  errors: number;
  thinkingChars: number;
  /** 按出现顺序聚合的工具调用次数 */
  byTool: { name: string; count: number }[];
}

/** 折叠行上的小结：几步、几个工具、哪几种、思考多少字。 */
export function summarizeSteps(steps: RailStep[]): RailSummary {
  const byTool: { name: string; count: number }[] = [];
  let tools = 0;
  let errors = 0;
  let thinkingChars = 0;

  for (const step of steps) {
    if (step.kind === "thinking") thinkingChars += step.text.replace(/\s+/g, "").length;
    if (step.kind === "tool") {
      tools += 1;
      if (step.isError) errors += 1;
      const found = byTool.find((item) => item.name === step.name);
      if (found) found.count += 1;
      else byTool.push({ name: step.name, count: 1 });
    }
  }

  return { steps: steps.length, tools, errors, thinkingChars, byTool };
}
