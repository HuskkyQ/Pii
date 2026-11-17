/**
 * 服务端纯函数测试。
 *
 * 这里只测「不碰网络、不碰 Harness」的部分：登录跳转、会话 id 解析、审批策略、
 * 归档落盘、快照投影。它们是最容易在重构里被悄悄改坏、又最适合用单测罩住的地方。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { archiveEntries } from "../src/archive.ts";
import { safeNext } from "../src/server/auth-routes.ts";
import { parseConversationId } from "../src/server/conversations.ts";
import { normalizePolicy, resolveUserConversation } from "../src/server/policies.ts";
import { ApprovalBroker } from "../src/server/approvals.ts";
import { SubagentGate, waitWithDeadline } from "../src/tools/subagent.ts";
import { projectEntries, projectView } from "../src/server/project.ts";

function fakeView(entries: unknown[]) {
  return { conversation: { id: 9 }, entries, docs: {} } as never;
}

test("safeNext: 只放行站内相对路径", () => {
  assert.equal(safeNext("/"), "/");
  assert.equal(safeNext("/?c=1"), "/?c=1");
  assert.equal(safeNext("/login"), "/login");
});

test("safeNext: 协议相对/反斜杠/控制字符/外站一律退回 /", () => {
  assert.equal(safeNext("//evil.example"), "/");
  assert.equal(safeNext("/\\evil.example"), "/");
  assert.equal(safeNext("https://evil.example"), "/");
  assert.equal(safeNext("/a\nb"), "/");
  assert.equal(safeNext(""), "/");
  assert.equal(safeNext(undefined), "/");
  assert.equal(safeNext(42), "/");
});

test("parseConversationId: 只接受正整数", () => {
  assert.equal(parseConversationId("1"), 1);
  assert.equal(parseConversationId("42"), 42);
  assert.equal(parseConversationId("0"), undefined);
  assert.equal(parseConversationId("-1"), undefined);
  assert.equal(parseConversationId("1.5"), undefined);
  assert.equal(parseConversationId("abc"), undefined);
  assert.equal(parseConversationId(undefined), undefined);
});

test("normalizePolicy: 四个工具必须都是布尔值", () => {
  const policy = {
    auto: { read: true, write: false, edit: false, bash: true },
    allowUnknown: false,
  };
  assert.deepEqual(normalizePolicy(policy), policy);
  assert.equal(normalizePolicy({ auto: { read: true } }), undefined);
  assert.equal(
    normalizePolicy({ auto: { read: "yes", write: false, edit: false, bash: false } }),
    undefined,
  );
  assert.deepEqual(
    normalizePolicy({
      auto: { read: false, write: false, edit: false, bash: false },
      allowUnknown: "yes",
    }),
    { auto: { read: false, write: false, edit: false, bash: false }, allowUnknown: false },
  );
  assert.equal(normalizePolicy(null), undefined);
});

test("archiveEntries: 只增不改，第二次换序号", () => {
  const dir = mkdtempSync(join(tmpdir(), "pii-archive-test-"));
  try {
    const entries = [{ id: 1, kind: "pi.user", at: 1, blocks: [{ type: "text", text: "hello" }] }];
    const first = archiveEntries({ archiveDir: dir, conversationId: 7, entries, reason: "manual" });
    const second = archiveEntries({ archiveDir: dir, conversationId: 7, entries, reason: "manual" });
    assert.ok(first);
    assert.ok(second);
    assert.match(first.path, /0001-.*-manual\.md$/);
    assert.match(second.path, /0002-.*-manual\.md$/);
    assert.match(readFileSync(first.path, "utf8"), /hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projectView: 按轮窗口，hasMore 标记还有更早的", () => {
  const view = fakeView([
    { id: 1, kind: "pi.user", conversationId: 9, model: [{ role: "user", content: "one" }] },
    {
      id: 2,
      kind: "pi.assistant",
      conversationId: 9,
      model: [{ role: "assistant", content: [{ type: "text", text: "a1" }] }],
    },
    { id: 3, kind: "pi.user", conversationId: 9, model: [{ role: "user", content: "two" }] },
    {
      id: 4,
      kind: "pi.assistant",
      conversationId: 9,
      model: [{ role: "assistant", content: [{ type: "text", text: "a2" }] }],
    },
  ]);

  const snapshot = projectView(view, { turns: 1 });
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.id),
    [3, 4],
  );
  assert.equal(snapshot.hasMore, true);
  assert.equal(snapshot.oldestEntryId, 3);
});

test("projectEntries: 工具结果按 toolCallId 并进 toolCall", () => {
  const view = fakeView([
    {
      id: 1,
      kind: "pi.assistant",
      conversationId: 9,
      model: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
        },
      ],
    },
    {
      id: 2,
      kind: "pi.tool-result",
      conversationId: 9,
      model: [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "file.txt" }],
        },
      ],
    },
  ]);

  const entries = projectEntries(view);
  assert.equal(entries.length, 1);
  const block = entries[0]!.blocks[0]!;
  assert.equal(block.type, "toolCall");
  if (block.type === "toolCall") {
    assert.equal(block.name, "bash");
    assert.equal(block.result, "file.txt");
  }
});

test("resolveUserConversation: 沿 owner 链上溯到用户会话", async () => {
  const records = new Map<number, { owner?: { conversationId: number } } | undefined>([
    [1, undefined],
    [13, { owner: { conversationId: 1 } }],
    [27, { owner: { conversationId: 13 } }],
  ]);
  const recordOf = async (id: number) => records.get(id);

  assert.equal(await resolveUserConversation(1, recordOf), 1);
  assert.equal(await resolveUserConversation(13, recordOf), 1);
  assert.equal(await resolveUserConversation(27, recordOf), 1);
  // 查不到的会话原样返回：一次读失败不该把审批挂到别人名下
  assert.equal(await resolveUserConversation(404, recordOf), 404);
});

test("ApprovalBroker: 子会话的审批按父会话策略判断，并记在父会话名下", async () => {
  const broker = new ApprovalBroker({
    timeoutMs: 50,
    shouldAutoAllow: (conversationId, tool) => conversationId === 1 && tool === "read",
    resolveConversation: async (conversationId) => (conversationId === 13 ? 1 : conversationId),
  });

  // 子会话的 read：按父会话策略 → 自动放行
  const auto = await broker.request({ conversationId: 13, callId: "c1", tool: "read", input: {} });
  assert.equal(auto.allow, true);

  // 子会话的 write：要问，而且卡片必须记在父会话名下（否则前端 SSE 收不到，120 秒后变拒绝）
  const pending = broker.request({ conversationId: 13, callId: "c2", tool: "write", input: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(broker.list(13).length, 0);
  const cards = broker.list(1);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.conversationId, 1);
  assert.equal(cards[0]!.tool, "write");

  broker.settle(cards[0]!.id, true);
  assert.equal((await pending).allow, true);
  broker.dispose();
});

test("SubagentGate: 超过上限排队，释放后按顺序放行，不同父会话互不影响", async () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const gate = new SubagentGate(2);
  const order: string[] = [];

  await gate.acquire(1);
  await gate.acquire(1);
  assert.equal(gate.running(1), 2);

  // 第三、第四个只能排队
  const third = gate.acquire(1).then(() => void order.push("third"));
  const fourth = gate.acquire(1).then(() => void order.push("fourth"));
  await tick();
  assert.deepEqual(order, []);
  assert.equal(gate.running(1), 2);

  // 释放一个：名额转交给队首，正在跑的数量不变（不会超上限）
  gate.release(1);
  await tick();
  assert.deepEqual(order, ["third"]);
  assert.equal(gate.running(1), 2);

  gate.release(1);
  await tick();
  assert.deepEqual(order, ["third", "fourth"]);

  // 另一个父会话有自己的闸
  await gate.acquire(2);
  assert.equal(gate.running(2), 1);

  gate.release(1);
  gate.release(1);
  gate.release(2);
  assert.equal(gate.running(1), 0);
  assert.equal(gate.running(2), 0);

  await Promise.all([third, fourth]);
});

test("waitWithDeadline: 超时返回 timeout，正常透传结果，迟到的 rejection 不炸进程", async () => {
  assert.equal(await waitWithDeadline(Promise.resolve("done"), 1_000), "done");
  assert.equal(await waitWithDeadline(new Promise<string>(() => {}), 10), "timeout");

  let rejectLate: (error: Error) => void = () => {};
  const late = new Promise<string>((_, reject) => {
    rejectLate = reject;
  });
  assert.equal(await waitWithDeadline(late, 5), "timeout");
  rejectLate(new Error("late")); // 超时后原 promise 才失败：必须被吞掉
  await new Promise((resolve) => setTimeout(resolve, 10));
});
