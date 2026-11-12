import assert from "node:assert/strict";
import test from "node:test";

import {
  stepsFromEntries,
  stepsFromLive,
  summarizeSteps,
  type RailStep,
} from "../src/lib/process-steps.ts";
import type { Entry, LiveView } from "../src/lib/types.ts";

function entry(id: number, kind: string, blocks: Entry["blocks"], at?: number): Entry {
  return { id, kind, blocks, ...(at === undefined ? {} : { at }) };
}

test("把一条 entry 里的思考 / 正文 / 工具拍平成按顺序的步骤", () => {
  const steps = stepsFromEntries([
    entry(7, "pi.assistant", [
      { type: "thinking", text: "先看看代码" },
      { type: "text", text: "我看一下" },
      { type: "toolCall", name: "bash", input: { command: "ls" }, result: "a\nb" },
    ]),
  ]);

  assert.deepEqual(
    steps.map((step) => step.kind),
    ["thinking", "text", "tool"],
  );
  // key 必须唯一，否则 React 复用错行
  assert.equal(new Set(steps.map((step) => step.key)).size, 3);
});

test("空白思考不进轨道（流式刚开始时 thinking 常常是空串）", () => {
  const steps = stepsFromEntries([
    entry(1, "pi.assistant", [
      { type: "thinking", text: "   \n " },
      { type: "text", text: "有正文" },
    ]),
  ]);

  assert.deepEqual(steps.map((step) => step.kind), ["text"]);
});

test("配好对的工具调用带结果是 done；没配对的工具结果也降级成一步工具", () => {
  const steps = stepsFromEntries([
    entry(2, "pi.assistant", [
      { type: "toolCall", name: "read", input: { path: "a.ts" }, result: "内容", durationMs: 80 },
    ]),
    entry(3, "pi.tool-result", [
      { type: "toolResult", name: "grep", text: "没有任何匹配", isError: true },
    ]),
  ]);

  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.kind === "tool" && steps[0]!.status, "done");
  assert.equal(steps[1]!.kind === "tool" && steps[1]!.isError, true);
});

test("思考用时：逐个 entry 取 thinkingMs，外部测量值只覆盖它自己那条 entry", () => {
  const steps = stepsFromEntries(
    [
      entry(10, "pi.assistant", [{ type: "thinking", text: "第一段" }]),
      { ...entry(11, "pi.assistant", [{ type: "thinking", text: "第二段" }]), thinkingMs: 999 },
    ],
    { entryId: 11, ms: 5000 },
  );

  const thinking = steps.filter((step) => step.kind === "thinking");
  assert.equal(thinking[0]!.kind === "thinking" && thinking[0]!.durationMs, undefined);
  assert.equal(thinking[1]!.kind === "thinking" && thinking[1]!.durationMs, 5000);
});

test("实时视图：带工具调用的正文算过程性正文，纯正文留给 LiveRow", () => {
  const preamble: LiveView = {
    phase: "generating",
    message: { blocks: [{ type: "text", text: "我先跑个测试" }, { type: "toolCall", name: "bash", input: {} }] },
  };
  const answer: LiveView = {
    phase: "generating",
    message: { blocks: [{ type: "text", text: "答案在这里" }] },
  };

  assert.deepEqual(
    stepsFromLive(preamble).map((step) => step.kind),
    ["text"],
  );
  assert.deepEqual(stepsFromLive(answer), []);
});

test("实时视图只补还没落库的工具：done 跳过，排队/运行中的保留", () => {
  const live: LiveView = {
    phase: "tools",
    tools: [
      { name: "bash", status: "done" },
      { name: "read", status: "running" },
      { name: "edit", status: "pending" },
    ],
  };

  const steps = stepsFromLive(live);
  assert.deepEqual(
    steps.map((step) => (step.kind === "tool" ? `${step.name}:${step.status}` : step.kind)),
    ["read:running", "edit:pending"],
  );
});

test("历史 + 实时拼起来不会重复同一行", () => {
  const committed = stepsFromEntries([
    entry(20, "pi.assistant", [
      { type: "toolCall", name: "bash", input: { command: "ls" }, result: "ok" },
    ]),
  ]);
  const live: LiveView = {
    phase: "tools",
    tools: [
      { name: "bash", status: "done" },
      { name: "read", status: "running" },
    ],
  };
  const merged = [...committed, ...stepsFromLive(live)];

  assert.equal(summarizeSteps(merged).tools, 2);
  assert.equal(new Set(merged.map((step) => step.key)).size, merged.length);
});

test("折叠行小结：步数、工具聚合顺序、出错数、思考字数（不计空白）", () => {
  const steps: RailStep[] = [
    { kind: "thinking", key: "a", text: "一二三 四" },
    { kind: "tool", key: "b", name: "bash", input: null, status: "done" },
    { kind: "tool", key: "c", name: "read", input: null, status: "done", isError: true },
    { kind: "tool", key: "d", name: "bash", input: null, status: "done" },
    { kind: "text", key: "e", text: "过程正文" },
  ];

  const summary = summarizeSteps(steps);
  assert.equal(summary.steps, 5);
  assert.equal(summary.tools, 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.thinkingChars, 4);
  assert.deepEqual(summary.byTool, [
    { name: "bash", count: 2 },
    { name: "read", count: 1 },
  ]);
});
